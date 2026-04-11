// Fake `SqlClient` for unit tests.
//
// The executor talks to its DB through a tiny two-method interface
// (`SqlClient` + `SqlTransaction`); this fixture lets tests stand up a
// driver that records every `unsafe(...)` call, replays a scripted
// result for the main query, and lets tests simulate driver errors.
//
// The goal is to exercise every `TransactionOutcome` branch without
// running Postgres. See `tests/unit/executor/transaction-outcomes.test.ts`.

import type {
  ResultRow,
  SqlClient,
  SqlTransaction,
} from '../../src/executor/types';

export interface ScriptedCall {
  readonly sql: string;
  readonly params: readonly unknown[] | undefined;
}

export interface FakeSqlClient extends SqlClient {
  /** Every SQL string that was passed to `tx.unsafe`, in order. */
  readonly calls: ReadonlyArray<ScriptedCall>;
  /** How many times `begin` was called. */
  readonly beginCount: number;
  /** How many times `end` was called. */
  readonly endCount: number;
}

export interface FakeSqlClientOptions {
  /**
   * Rows returned by the MAIN query (the last `tx.unsafe` call with
   * non-empty params, or the one that matches `mainQueryMatcher`).
   * Defaults to a single row with a `page_total` of 0.
   */
  readonly mainRows?: readonly ResultRow[];
  /**
   * Error to throw from `tx.unsafe`. Any call matching `errorOnMatch`
   * (substring match) throws the given value; used to simulate
   * Postgres errors mid-transaction.
   */
  readonly errorOnMatch?: string;
  readonly errorValue?: unknown;
  /**
   * When provided, identifies which `tx.unsafe` call is the main
   * query. Defaults to "the last non-prelude call" — anything that
   * isn't a `SET LOCAL` / `set_config` / schema-version query.
   */
  readonly isMainQuery?: (sql: string) => boolean;
}

export function makeFakeSqlClient(
  options: FakeSqlClientOptions = {},
): FakeSqlClient {
  const calls: ScriptedCall[] = [];
  let beginCount = 0;
  let endCount = 0;

  // "Main" = not a prelude step. Prelude steps start with SET LOCAL,
  // set_config(...), a schema-version SELECT, or a pre-request SELECT
  // that carries the marker `__prerequest__` in the SQL comment.
  const defaultIsMain = (sql: string): boolean => {
    const trimmed = sql.trimStart();
    if (/^SET LOCAL/i.test(trimmed)) return false;
    if (/^SELECT set_config/i.test(trimmed)) return false;
    if (trimmed.includes('__schema_version__')) return false;
    if (trimmed.includes('__prerequest__')) return false;
    return true;
  };

  const isMain = options.isMainQuery ?? defaultIsMain;

  const mainRows: readonly ResultRow[] =
    options.mainRows ?? [{ page_total: 0 } as ResultRow];

  const tx: SqlTransaction = {
    async unsafe(
      sql: string,
      params?: readonly unknown[],
    ): Promise<readonly ResultRow[]> {
      calls.push({ sql, params });
      if (
        options.errorOnMatch !== undefined &&
        sql.includes(options.errorOnMatch)
      ) {
        throw options.errorValue ?? new Error('simulated pg error');
      }
      if (isMain(sql)) return mainRows;
      return [];
    },
  };

  const client: SqlClient = {
    async begin<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      beginCount += 1;
      return fn(tx);
    },
    async end(): Promise<void> {
      endCount += 1;
    },
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'calls') return calls;
      if (prop === 'beginCount') return beginCount;
      if (prop === 'endCount') return endCount;
      return Reflect.get(target, prop, receiver);
    },
  }) as FakeSqlClient;
}
