// Executor-facing types — the single contract between handlers and the
// database layer.
//
// INVARIANT (CONSTITUTION §1.2): `QueryResult` and `TransactionOutcome`
// are the ONLY shapes the executor hands back to handlers. No thrown
// sentinels escape the executor boundary; if the postgres.js driver
// needs `throw` internally to roll a transaction back, the throw is
// caught inside `executor/transaction.ts` and translated to the outcome
// union here.
//
// This file is intentionally tiny and has no runtime imports so it can
// be included from pure type consumers (handlers, tests) without
// dragging in `postgres`.

import type { CloudRestError } from '@/core/errors';
import type { BuiltQuery } from '@/builder/types';

/** A single row from the main query, shaped as a plain dictionary. */
export type ResultRow = Readonly<Record<string, unknown>>;

/**
 * Value returned on success by the main query. Both the row set and the
 * parsed GUC-override strings are carried through — parsing happens in
 * the response layer (`response/guc.ts`), not here.
 */
export interface QueryResult {
  /** Rows returned by `tx.unsafe(mainSql, mainParams)`. */
  readonly rows: readonly ResultRow[];
  /** Raw value of `response.headers` GUC at end-of-transaction, or null. */
  readonly responseHeaders: string | null;
  /** Raw value of `response.status` GUC at end-of-transaction, or null. */
  readonly responseStatus: string | null;
  /** Schema-cache version observed (for optimistic-concurrency clients). */
  readonly schemaVersion: number | null;
}

/**
 * The explicit outcome of a transaction. Handlers `switch` on `kind`
 * and never need to know whether the driver used `throw` to unwind.
 *
 * COMPAT note: the old code surfaced rollback-preferred and
 * max-affected violations by throwing sentinel objects. Critique #4
 * called that out; Stage 7 eliminates it from the public signature.
 */
export type TransactionOutcome =
  /** Transaction committed; rows and parsed GUCs are in `result`. */
  | { readonly kind: 'commit'; readonly result: QueryResult }
  /**
   * Transaction rolled back on purpose (Prefer: tx=rollback or a
   * page-total mismatch). The rows are still returned — the handler
   * typically formats them into a response but does NOT commit side
   * effects.
   */
  | { readonly kind: 'rollback'; readonly result: QueryResult }
  /**
   * `Prefer: max-affected=N` was exceeded. The page-total from the
   * result carries how many rows the query WOULD have touched.
   */
  | {
      readonly kind: 'max-affected-violation';
      readonly pageTotal: number;
    }
  /** Any underlying Postgres or connection failure. */
  | { readonly kind: 'pg-error'; readonly error: CloudRestError };

// ----- Call-site options -----------------------------------------------

/**
 * Options passed to `runQuery`. Every field is optional and most default
 * to "no-op" — the executor sets `statement_timeout` from config on
 * every call, so the caller never has to think about it.
 */
export interface RunQueryOptions {
  /**
   * Pre-built `SET LOCAL ROLE ...` statement. Stage 7 does not parse
   * this; stage 11 will populate it from `auth.resolvedRole`.
   */
  readonly roleSql?: string | null;
  /**
   * Pre-built `set_config('request.jwt.claim.*', ...)` block. Stage 11.
   *
   * May be either a plain SQL string (legacy; Stage 11 populates) or
   * a `BuiltQuery`-shaped `{ sql, params }` pair when values need to
   * be bound (app settings, claim values with user-controlled
   * content).
   */
  readonly preQuerySql?:
    | string
    | null
    | { readonly sql: string; readonly params: readonly unknown[] };
  /**
   * Pre-request hook — `SELECT "pre_request_fn"()`. When null, the
   * transaction skips this step.
   */
  readonly preRequestSql?: string | null;
  /**
   * Optional schema version check. The old code ran a separate
   * `SELECT version FROM <table>` statement and swallowed "table does
   * not exist" errors silently.
   */
  readonly versionSql?: string | null;
  /**
   * When true, the transaction rolls back AFTER executing the main
   * query — `Prefer: tx=rollback`. Rows are still returned.
   */
  readonly rollbackPreferred?: boolean;
  /**
   * Per-request `Prefer: max-affected=N`. If the main query's
   * `page_total` column exceeds `N`, the transaction rolls back and
   * the outcome is `max-affected-violation`.
   */
  readonly maxAffected?: number;
  /**
   * Rollback if the `page_total` returned by the main query does not
   * equal this exact value. Used by the singular `Prefer: tx=rollback`
   * path in the old code.
   */
  readonly rollbackOnPageTotalMismatch?: number;
}

// ----- Internal protocol ------------------------------------------------

/**
 * The minimum surface of the postgres.js client we actually use. Keeping
 * this as a local interface lets unit tests inject a fake client
 * without depending on `postgres` at test-compile time.
 */
export interface SqlClient {
  /**
   * Execute `fn` inside a single transaction. If `fn` throws, the
   * transaction rolls back; if it returns, the transaction commits.
   */
  begin<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T>;
  /** Close the underlying connection pool. Called from `isolate.teardown`. */
  end(options?: { readonly timeout?: number }): Promise<void>;
}

/**
 * Tiny subset of `postgres.js`'s transaction handle. The `unsafe`
 * overload handles both no-params and with-params forms so callers
 * don't have to pass an empty array.
 */
export interface SqlTransaction {
  unsafe(sql: string): Promise<readonly ResultRow[]>;
  unsafe(sql: string, params: readonly unknown[]): Promise<readonly ResultRow[]>;
}

/**
 * Pre-rendered query handed to the executor. The executor never calls
 * the builder directly — it receives a `BuiltQuery` that was already
 * validated upstream.
 */
export type ExecutableQuery = BuiltQuery;
