// Shared builder types.
//
// INVARIANT: There is exactly ONE BuiltQuery type in the rewrite.
// CONSTITUTION §1.2. Adding a field here widens every builder at once;
// no builder may declare a local BuiltQuery interface.

/**
 * A rendered SQL query plus its bound parameters.
 *
 * INVARIANT: `params` is indexed-from-zero in TypeScript but bound as
 * `$1..$N` in SQL. The SqlBuilder owns monotonic allocation — see
 * builder/sql.ts.
 */
export interface BuiltQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  /**
   * When true, the executor must skip reading `pgrst_source.response.*`
   * GUCs from the query result — used by prequery-only queries that
   * don't have a user-level source CTE. See executor/execute.ts.
   */
  readonly skipGucRead?: boolean;
}
