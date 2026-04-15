// Query cost guard — runs `EXPLAIN (FORMAT JSON)` against a built
// query and rejects the request if the planner estimates the cost
// above `limits.maxQueryCost`.
//
// INVARIANT: cost checking goes through `runTransaction` so the
// EXPLAIN runs under the SAME transaction setup as the real query —
// `SET LOCAL ROLE`, `set_config('request.jwt.claim.*', ...)`, and
// any `DB_PRE_REQUEST` hook. An RLS-aware cost estimate MUST see
// the claims; otherwise the guard's plan diverges from the actual
// execution plan.
//
// INVARIANT: the transaction is rolled back via
// `rollbackPreferred: true`, so the EXPLAIN never commits and
// never touches the user's data.
//
// INVARIANT: a disabled guard (`maxQueryCost <= 0`) is a bypass, not
// an error. The handler calls `checkQueryCost` unconditionally and
// this module short-circuits when the config is off.

import { err, ok, type Result } from '@/core/result';
import { makeError, type CloudRestError } from '@/core/errors/types';
import type { HandlerContext } from '@/core/context';
import type { BuiltQuery } from '@/builder/types';
import type { RunQueryOptions } from '@/executor/types';
import { runQuery } from '@/executor/execute';
import { extractTotalCost } from './extract-cost';
import { inlineParams } from './inline-params';

export interface CostCheckResult {
  readonly allowed: boolean;
  readonly cost: number;
}

/**
 * Check whether `built` would exceed `config.limits.maxQueryCost`.
 *
 * Returns:
 *   - `ok({ allowed: true, cost: 0 })`    when the guard is disabled
 *   - `ok({ allowed: true, cost: N })`    when the plan is under budget
 *   - `err(PGRST118)`                     when the plan exceeds budget
 *   - `ok({ allowed: true, cost: 0 })`    when EXPLAIN itself fails —
 *     we fail open so a transient planner issue doesn't block the
 *     request.
 */
export async function checkQueryCost(
  context: HandlerContext,
  built: BuiltQuery,
  preludeOptions: RunQueryOptions,
): Promise<Result<CostCheckResult, CloudRestError>> {
  const maxCost = context.config.limits.maxQueryCost;
  if (maxCost <= 0) return ok({ allowed: true, cost: 0 });

  // Inline params so EXPLAIN (which doesn't accept bind params in
  // the simple protocol) sees a plain SQL string.
  const explainSql =
    built.params.length > 0
      ? inlineParams(built.sql, built.params)
      : built.sql;

  const explainBuilt: BuiltQuery = {
    sql: `EXPLAIN (FORMAT JSON) ${explainSql}`,
    params: [],
    skipGucRead: true,
  };

  // Always roll back — EXPLAIN is read-only in theory but CloudREST
  // runs EXPLAIN on INSERT / UPDATE / DELETE statements too, which
  // WILL touch the table if the transaction commits.
  const execResult = await runQuery(context, explainBuilt, {
    ...preludeOptions,
    rollbackPreferred: true,
  });
  if (!execResult.ok) {
    // EXPLAIN failed. Fail OPEN — don't block the request on a
    // guard malfunction. Cost guard is a safety rail, not a
    // primary security gate.
    return ok({ allowed: true, cost: 0 });
  }

  const cost = extractTotalCost(execResult.value.rows);
  if (cost > maxCost) {
    return err(
      makeError({
        code: 'PGRST118',
        message: 'Query estimated cost exceeds the configured limit',
        details: `Estimated cost ${cost} > MAX_QUERY_COST ${maxCost}`,
        hint: 'Add a more selective filter or raise MAX_QUERY_COST',
        httpStatus: 413,
      }),
    );
  }
  return ok({ allowed: true, cost });
}
