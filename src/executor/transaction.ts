// Transaction runner — the ONE place that wraps a postgres.js
// `sql.begin(...)` call, handles the rollback/commit/max-affected
// outcomes, and converts thrown errors into a typed `TransactionOutcome`.
//
// INVARIANT (critique #4): no thrown sentinel escapes this file.
// `postgres.js` requires `throw` inside `begin()` to force a rollback,
// so internally we still throw sentinel objects — but the only thing
// that ever leaves `runTransaction` is a `TransactionOutcome` union.
//
// INVARIANT: `SET LOCAL
// statement_timeout` is issued on every transaction without exception.
//
// INVARIANT (critique #66): the transaction body runs in a fixed
// order: role → timeout → app GUCs → prequery → schema version →
// pre-request → main. Each step is a separate call, not a
// string-concatenated batch, so a failure at any step has a precise
// SQLSTATE and error message.

import { err, ok, type Result } from '@/core/result';
import { serverErrors, type CloudRestError } from '@/core/errors';
import type {
  ExecutableQuery,
  QueryResult,
  ResultRow,
  RunQueryOptions,
  SqlClient,
  SqlTransaction,
  TransactionOutcome,
} from './types';
import { renderStatementTimeoutSql } from './statement-timeout';

// ----- Sentinel shapes (PRIVATE to this file) --------------------------
//
// These objects exist only because `postgres.js.begin()` requires a
// thrown value to roll a transaction back. They never escape this
// module; the outer `try` catches them and returns a
// `TransactionOutcome` instead.

interface RollbackSentinel {
  readonly __cloudrestSentinel: 'rollback';
  readonly result: QueryResult;
}

interface MaxAffectedSentinel {
  readonly __cloudrestSentinel: 'max-affected';
  readonly pageTotal: number;
}

function isRollbackSentinel(e: unknown): e is RollbackSentinel {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as Record<string, unknown>).__cloudrestSentinel === 'rollback'
  );
}

function isMaxAffectedSentinel(e: unknown): e is MaxAffectedSentinel {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as Record<string, unknown>).__cloudrestSentinel === 'max-affected'
  );
}

// ----- Public entry point ----------------------------------------------

export interface RunTransactionInput {
  readonly client: SqlClient;
  readonly main: ExecutableQuery;
  readonly statementTimeoutMs: number;
  readonly options: RunQueryOptions;
}

/**
 * Execute a main query inside a transaction. Every branch of the
 * outcome union is surfaced; nothing throws on the public signature.
 */
export async function runTransaction(
  input: RunTransactionInput,
): Promise<TransactionOutcome> {
  try {
    const committed = await input.client.begin<QueryResult>(async (tx) => {
      const result = await runSteps(tx, input);

      // Rollback-preferred: throw after the query has succeeded so
      // the transaction unwinds, then the outer catch turns the
      // sentinel back into a rollback outcome.
      if (input.options.rollbackPreferred === true) {
        throw makeRollbackSentinel(result);
      }

      // page-total mismatch check — mutation-shaped queries expose
      // `page_total`, and a mismatch forces rollback.
      if (input.options.rollbackOnPageTotalMismatch !== undefined) {
        const pageTotal = extractPageTotal(result.rows);
        if (pageTotal !== input.options.rollbackOnPageTotalMismatch) {
          throw makeRollbackSentinel(result);
        }
      }

      // max-affected check — if more rows were touched than the
      // caller permits, rollback and report the observed count.
      if (input.options.maxAffected !== undefined) {
        const pageTotal = extractPageTotal(result.rows);
        if (pageTotal > input.options.maxAffected) {
          throw {
            __cloudrestSentinel: 'max-affected',
            pageTotal,
          } satisfies MaxAffectedSentinel;
        }
      }

      return result;
    });
    return { kind: 'commit', result: committed };
  } catch (e: unknown) {
    if (isRollbackSentinel(e)) {
      return { kind: 'rollback', result: e.result };
    }
    if (isMaxAffectedSentinel(e)) {
      return { kind: 'max-affected-violation', pageTotal: e.pageTotal };
    }
    return { kind: 'pg-error', error: translatePgError(e) };
  }
}

// ----- Step sequencing -------------------------------------------------

async function runSteps(
  tx: SqlTransaction,
  input: RunTransactionInput,
): Promise<QueryResult> {
  const { main, options, statementTimeoutMs } = input;

  // 1. `SET LOCAL ROLE <role>`.
  if (options.roleSql !== undefined && options.roleSql !== null && options.roleSql !== '') {
    await tx.unsafe(options.roleSql);
  }

  // 2. `SET LOCAL statement_timeout` — always issued (#65).
  await tx.unsafe(renderStatementTimeoutSql(statementTimeoutMs));

  // 3. App GUCs (`set_config('request.jwt.claim.*', ...)`) — accepts
  // either a raw SQL string or a `{ sql, params }` pair so user-
  // controlled values can be bound instead of inlined.
  if (options.preQuerySql !== undefined && options.preQuerySql !== null) {
    if (typeof options.preQuerySql === 'string') {
      if (options.preQuerySql !== '') await tx.unsafe(options.preQuerySql);
    } else if (
      typeof options.preQuerySql === 'object' &&
      options.preQuerySql.sql !== ''
    ) {
      if (options.preQuerySql.params.length > 0) {
        await tx.unsafe(options.preQuerySql.sql, options.preQuerySql.params);
      } else {
        await tx.unsafe(options.preQuerySql.sql);
      }
    }
  }

  // 4. Schema-version check (best-effort; a missing table is OK).
  //
  // BUG FIX (critique subtle #66 followup): the old executor
  // swallowed EVERY exception from this step, which is dangerous —
  // Postgres aborts the rest of the transaction as soon as one
  // statement fails (25P02: in_failed_sql_transaction), so
  // swallowing the root cause here turns every downstream error
  // into an opaque 25P02. The rewrite only swallows the specific
  // "undefined_table" case (SQLSTATE 42P01), which is the legitimate
  // "the bookkeeping table does not exist yet" scenario. Anything
  // else propagates and is translated to a CloudRestError by the
  // outer catch.
  let schemaVersion: number | null = null;
  if (options.versionSql !== undefined && options.versionSql !== null && options.versionSql !== '') {
    try {
      const rows = await tx.unsafe(options.versionSql);
      if (rows.length > 0) {
        const first = rows[0] as Record<string, unknown> | undefined;
        const raw = first?.['version'];
        if (raw !== undefined && raw !== null) {
          const parsed = Number(raw);
          if (Number.isFinite(parsed)) schemaVersion = parsed;
        }
      }
    } catch (e: unknown) {
      if (!isUndefinedTableError(e)) throw e;
    }
  }

  // 5. Pre-request function — `SELECT "schema"."fn"()`.
  if (
    options.preRequestSql !== undefined &&
    options.preRequestSql !== null &&
    options.preRequestSql !== ''
  ) {
    await tx.unsafe(options.preRequestSql);
  }

  // 6. Main query.
  const rows =
    main.params.length > 0
      ? await tx.unsafe(main.sql, main.params)
      : await tx.unsafe(main.sql);

  const { responseHeaders, responseStatus } = extractGucFromRows(rows, main);

  return {
    rows: Array.isArray(rows) ? rows.slice() : [],
    responseHeaders,
    responseStatus,
    schemaVersion,
  };
}

// ----- Helpers ----------------------------------------------------------

function extractPageTotal(rows: readonly ResultRow[]): number {
  if (rows.length === 0) return 0;
  const first = rows[0] as Record<string, unknown> | undefined;
  const raw = first?.['page_total'];
  if (raw === undefined || raw === null) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Read the `response_headers` and `response_status` columns off the
 * first row of the main-query result — but only if the builder asked
 * for them. A `skipGucRead` built query means the main SQL never
 * projected those columns in the first place.
 */
function extractGucFromRows(
  rows: readonly ResultRow[],
  main: ExecutableQuery,
): { responseHeaders: string | null; responseStatus: string | null } {
  if (main.skipGucRead === true || rows.length === 0) {
    return { responseHeaders: null, responseStatus: null };
  }
  const first = rows[0] as Record<string, unknown> | undefined;
  if (first === undefined) {
    return { responseHeaders: null, responseStatus: null };
  }
  const responseHeaders =
    first['response_headers'] === undefined || first['response_headers'] === null
      ? null
      : String(first['response_headers']);
  const responseStatus =
    first['response_status'] === undefined || first['response_status'] === null
      ? null
      : String(first['response_status']);
  return { responseHeaders, responseStatus };
}

/**
 * Translate a thrown postgres-driver error into a CloudRestError.
 */
function translatePgError(e: unknown): CloudRestError {
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>;
    // Already a CloudRestError? Pass through.
    if (
      typeof obj['code'] === 'string' &&
      typeof obj['httpStatus'] === 'number'
    ) {
      return e as CloudRestError;
    }
    if (typeof obj['code'] === 'string') {
      const code = obj['code'] as string;
      const message =
        typeof obj['message'] === 'string' ? (obj['message'] as string) : '';
      const detail =
        typeof obj['detail'] === 'string' ? (obj['detail'] as string) : null;
      const hint =
        typeof obj['hint'] === 'string' ? (obj['hint'] as string) : null;
      return serverErrors.pgError(code, message, detail, hint);
    }
  }
  return serverErrors.pgError(
    '08000',
    `Connection error: ${String(e)}`,
    null,
  );
}

// ----- Sentinel builder (stays private) -------------------------------

function makeRollbackSentinel(result: QueryResult): RollbackSentinel {
  return { __cloudrestSentinel: 'rollback', result };
}

/**
 * True for a postgres.js error object whose SQLSTATE is `42P01`
 * (`undefined_table`). Used to whitelist the one case where the
 * schema-version check is allowed to swallow an exception.
 */
function isUndefinedTableError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as Record<string, unknown>)['code'];
  return code === '42P01';
}

// Re-export for runQuery wrapper
export type { TransactionOutcome } from './types';

// Utility for tests that want the raw step sequencer.
export const __runStepsForTest = runSteps;

void ok;
void err;
