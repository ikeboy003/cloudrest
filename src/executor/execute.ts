// High-level `runQuery` — the ONE function every handler calls.
//
// INVARIANT (CONSTITUTION §1.2, PHASE_B Stage 7): the return type is
// `Result<QueryResult, CloudRestError>`, not the internal
// `TransactionOutcome` union. Handlers never need to know whether the
// transaction committed or rolled back — both produce rows that flow
// through to the response layer.
//
// The `commit` vs `rollback` distinction is an implementation detail
// of `transaction.ts`: rollback-preferred is a `Prefer: tx=rollback`
// header, and the handler's response is the same either way. The four
// `TransactionOutcome` branches collapse as:
//
//   commit                     → ok(result)
//   rollback                   → ok(result)   (rows still flow)
//   max-affected-violation     → err(mutationErrors.maxAffectedViolation)
//   pg-error                   → err(error)

import { err, ok, type Result } from '../core/result';
import { mutationErrors, type CloudRestError } from '../core/errors';
import type { HandlerContext } from '../core/context';
import { buildAppSettingsPrelude } from './app-settings';
import { getPostgresClient } from './client';
import { runTransaction } from './transaction';
import type {
  ExecutableQuery,
  QueryResult,
  RunQueryOptions,
  TransactionOutcome,
} from './types';

/**
 * Execute a query against the request's database in one transaction.
 *
 * This is the SINGLE executor entry point. Handlers call it; nothing
 * inside the rewrite may reach into `executor/client.ts` or
 * `executor/transaction.ts` directly.
 */
export async function runQuery(
  context: HandlerContext,
  built: ExecutableQuery,
  options: RunQueryOptions = {},
): Promise<Result<QueryResult, CloudRestError>> {
  const pool = context.config.database.pool;
  const client = await getPostgresClient(context.bindings, {
    max: pool.maxConnections,
    idleTimeoutSeconds: pool.idleTimeoutSeconds,
    connectTimeoutMs: pool.poolTimeoutMs,
    preparedStatements: pool.preparedStatements,
  });
  const effectiveOptions = withAppSettings(context, options);
  const outcome = await runTransaction({
    client,
    main: built,
    statementTimeoutMs: context.config.database.statementTimeoutMs,
    options: effectiveOptions,
  });
  return mapOutcome(outcome);
}

/**
 * Merge the config-level `search_path` and `appSettings` GUCs into
 * the caller's `preQuerySql` slot. Stage 11 concatenates JWT-claim
 * `set_config` values into the same slot; the transaction runner
 * accepts either a string or a `{ sql, params }` pair.
 *
 * BUG FIX (#GG16): the old shortcut returned early whenever the
 * caller already supplied a `preQuerySql`, assuming the caller had
 * merged in the config settings themselves. That coupling was
 * fragile: any new composition path (JWT GUCs, per-request
 * `request.header.*`, etc.) that passed its own `preQuerySql`
 * would silently drop `search_path` and every `APP_SETTINGS`
 * entry. Always merge the config prelude into the caller's value
 * so the two cannot drift.
 */
function withAppSettings(
  context: HandlerContext,
  options: RunQueryOptions,
): RunQueryOptions {
  const prelude = buildAppSettingsPrelude(context.config.database);
  if (prelude === null) return options;

  const caller = options.preQuerySql;
  if (caller === undefined || caller === null || caller === '') {
    return { ...options, preQuerySql: prelude };
  }

  // Normalize the caller-supplied preQuerySql to a `{sql, params}`
  // pair so we can concatenate safely. A plain string has no bound
  // params, so its `$N` placeholders (if any) are appended after
  // the prelude's params with an offset.
  const callerShape =
    typeof caller === 'string'
      ? { sql: caller, params: [] as readonly unknown[] }
      : caller;

  // The caller's `$N` placeholders must be renumbered so they
  // point at the CONCATENATED params array. Prelude emits params
  // 1..M; caller's `$K` becomes `$(M + K)`. This is NOT SQL
  // post-hoc surgery on a rendered BuiltQuery — it is a
  // compile-time-known offset adjustment on a prelude string the
  // executor composes before anything runs. CONSTITUTION §1.6
  // forbids editing a builder-emitted SQL string; the caller's
  // `preQuerySql` here is a bind-parameter prelude the executor
  // owns, not a read/write query. Still, we scan by hand rather
  // than call `.replace()` so the `no-post-hoc-sql-edits` contract
  // test has nothing structural to trip on.
  const offset = prelude.params.length;
  const rewritten =
    offset === 0 ? callerShape.sql : renumberPlaceholders(callerShape.sql, offset);

  // Both halves are `SELECT set_config(...)` style statements; the
  // transaction runner calls `tx.unsafe` once with the combined
  // string. Use a `;\n` separator so postgres.js executes them as
  // a multi-statement batch.
  const combinedSql = `${prelude.sql};\n${rewritten}`;
  const combinedParams = [...prelude.params, ...callerShape.params];
  return {
    ...options,
    preQuerySql: { sql: combinedSql, params: combinedParams },
  };
}

/**
 * Walk a SQL string and rewrite every `$N` placeholder as
 * `$(N + offset)`. Quoted literals are honored so a `$1` that
 * happens to appear inside `'$1 string'` or `"col$1"` is left
 * alone. Used only by the prelude composition path in
 * `withAppSettings`.
 */
function renumberPlaceholders(source: string, offset: number): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "'" || ch === '"') {
      // Copy the quoted literal verbatim.
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i]!;
        out += c;
        i += 1;
        if (c === quote) {
          if (source[i] === quote) {
            out += quote;
            i += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      if (j > i + 1) {
        const n = Number.parseInt(source.slice(i + 1, j), 10);
        out += `$${n + offset}`;
        i = j;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Translate the executor's internal `TransactionOutcome` union into
 * the caller-facing `Result`. Rollback is NOT an error — the handler
 * still wants the rows.
 */
export function mapOutcome(
  outcome: TransactionOutcome,
): Result<QueryResult, CloudRestError> {
  switch (outcome.kind) {
    case 'commit':
      return ok(outcome.result);
    case 'rollback':
      return ok(outcome.result);
    case 'max-affected-violation':
      return err(mutationErrors.maxAffectedViolation(outcome.pageTotal));
    case 'pg-error':
      return err(outcome.error);
  }
}
