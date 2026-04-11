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

import { err, ok, type Result } from '@/core/result';
import { mutationErrors, type CloudRestError } from '@/core/errors';
import type { HandlerContext } from '@/core/context';
import { buildAppSettingsPrelude } from './app-settings';
import { buildAuthPrelude } from './auth-prelude';
import { closeClient, getPostgresClient } from './client';
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
  try {
    const effectiveOptions = withPrelude(context, options);
    const outcome = await runTransaction({
      client,
      main: built,
      statementTimeoutMs: context.config.database.statementTimeoutMs,
      options: effectiveOptions,
    });
    return mapOutcome(outcome);
  } finally {
    // RUNTIME: per-request client teardown. See executor/client.ts
    // for why the rewrite cannot share a client across requests.
    await closeClient(client);
  }
}

/**
 * Merge the config-level `search_path` / `appSettings` GUCs AND the
 * per-request `SET LOCAL ROLE` + `request.jwt.claim.*` auth prelude
 * into the caller's options slot.
 *
 * Composition order (all run inside the same transaction, so the
 * last write wins on any conflicting GUC):
 *   1. `SET LOCAL ROLE "<auth.role>"`   (via `roleSql`)
 *   2. `SET LOCAL search_path = ...`    (appSettings)
 *   3. `set_config('<app-setting-key>', ..., true)`
 *   4. `set_config('request.jwt.claims', '<json>', true)`
 *   5. `set_config('request.jwt.claim.<key>', '<value>', true)`
 *
 * Items 2–5 are concatenated into a single `SELECT set_config(...)`
 * batch that is executed as the transaction's `preQuerySql` step.
 *
 * BUG FIX (#GG16): always merge the config prelude into the caller's
 * value so a new composition path (auth, request.header, etc.)
 * cannot silently drop `search_path` / `APP_SETTINGS`.
 */
function withPrelude(
  context: HandlerContext,
  options: RunQueryOptions,
): RunQueryOptions {
  const appSettings = buildAppSettingsPrelude(context.config.database);
  const authPrelude = buildAuthPrelude(context.auth);

  // Assemble the set_config prelude (appSettings + auth claims).
  //
  // RUNTIME: `postgres.js` wraps `tx.unsafe(sql, params)` in a
  // prepared statement when params are supplied, and Postgres
  // rejects multi-command prepared statements (42601 "cannot insert
  // multiple commands into a prepared statement"). We therefore
  // render a SINGLE `SELECT set_config(...), set_config(...), ...`
  // statement that combines both halves into one comma-separated
  // expression list, instead of `;`-joining two SELECTs.
  let setConfigPrelude: { sql: string; params: readonly unknown[] } | null = null;
  if (appSettings !== null && authPrelude.claimsPreQuery !== null) {
    const appExprs = stripSelectPrefix(appSettings.sql);
    const offset = appSettings.params.length;
    const authExprs = renumberPlaceholders(
      stripSelectPrefix(authPrelude.claimsPreQuery.sql),
      offset,
    );
    setConfigPrelude = {
      sql: `SELECT ${appExprs}, ${authExprs}`,
      params: [...appSettings.params, ...authPrelude.claimsPreQuery.params],
    };
  } else if (appSettings !== null) {
    setConfigPrelude = appSettings;
  } else if (authPrelude.claimsPreQuery !== null) {
    setConfigPrelude = authPrelude.claimsPreQuery;
  }

  // Merge with any caller-supplied `preQuerySql`. The caller path
  // is rare today (Stage 9 doesn't pass one, neither does read), so
  // the caller may legitimately pass something that is NOT a
  // `SELECT set_config(...)` shape. In that case we cannot splice
  // — fall back to executing the caller separately. For the common
  // case where the caller shape IS another `SELECT set_config(...)`
  // we combine into a single statement for the same multi-command
  // reason explained above.
  let effectivePreQuerySql: RunQueryOptions['preQuerySql'] = setConfigPrelude;
  const caller = options.preQuerySql;
  if (caller !== undefined && caller !== null && caller !== '') {
    const callerShape =
      typeof caller === 'string'
        ? { sql: caller, params: [] as readonly unknown[] }
        : caller;
    if (setConfigPrelude === null) {
      effectivePreQuerySql = callerShape;
    } else {
      const offset = setConfigPrelude.params.length;
      const rewrittenCallerSql =
        offset === 0
          ? callerShape.sql
          : renumberPlaceholders(callerShape.sql, offset);
      const callerExprs = tryStripSelectPrefix(rewrittenCallerSql);
      if (callerExprs !== null) {
        const preludeExprs = stripSelectPrefix(setConfigPrelude.sql);
        effectivePreQuerySql = {
          sql: `SELECT ${preludeExprs}, ${callerExprs}`,
          params: [...setConfigPrelude.params, ...callerShape.params],
        };
      } else {
        // Caller is not a SELECT-shape — run it as a separate
        // statement. This path is only reachable when someone
        // passes arbitrary prelude SQL by hand; the core rewrite
        // never does.
        effectivePreQuerySql = {
          sql: `${setConfigPrelude.sql};\n${rewrittenCallerSql}`,
          params: [...setConfigPrelude.params, ...callerShape.params],
        };
      }
    }
  }

  // Resolve `roleSql` — prefer the caller's explicit value, fall
  // back to the auth prelude's rendered `SET LOCAL ROLE`. A caller
  // that passes `null` explicitly disables the role step.
  const resolvedRoleSql =
    options.roleSql !== undefined ? options.roleSql : authPrelude.roleSql;

  return {
    ...options,
    roleSql: resolvedRoleSql,
    preQuerySql: effectivePreQuerySql,
  };
}

/**
 * Strip a leading `SELECT ` from a prelude SQL string, returning
 * the expression list. Throws if the string does not start with
 * `SELECT ` — the caller is expected to know its input shape.
 */
function stripSelectPrefix(sql: string): string {
  const match = /^\s*SELECT\s+/i.exec(sql);
  if (match === null) {
    throw new Error(
      `executor prelude: expected a leading SELECT, got: ${sql.slice(0, 64)}`,
    );
  }
  return sql.slice(match[0].length);
}

/** Non-throwing variant used on caller-supplied SQL of unknown shape. */
function tryStripSelectPrefix(sql: string): string | null {
  const match = /^\s*SELECT\s+/i.exec(sql);
  if (match === null) return null;
  return sql.slice(match[0].length);
}

/**
 * Walk a SQL string and rewrite every `$N` placeholder as
 * `$(N + offset)`. Quoted literals are honored so a `$1` that
 * happens to appear inside `'$1 string'` or `"col$1"` is left
 * alone. Used only by the prelude composition path in
 * `withPrelude`.
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
