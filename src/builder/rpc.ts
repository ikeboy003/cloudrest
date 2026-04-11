// RPC SQL builder — single renderer for `SELECT * FROM fn(...)`.
//
// INVARIANT (CONSTITUTION §1.1 + §1.3): every argument value reaches
// SQL via `SqlBuilder.addParam`. Type casts are inlined (from the
// routine's declared parameter type), but values themselves are
// never inlined.
//
// INVARIANT (critique #48): the empty-body `{}` shortcut for POST
// /rpc/fn lives in `handlers/rpc.ts`, not here. The builder always
// sees a fully-decided `RpcPlan`.
//
// Shape:
//
//   SELECT
//     null::bigint AS total_result_set,
//     pg_catalog.count(t) AS page_total,
//     <body expr> AS body,
//     <guc passthrough>
//   FROM (
//     SELECT <cols>
//     FROM "public"."fn"(arg1 := $1::type, ...)
//     [WHERE <bare-column filters>]
//     [ORDER BY <bare-column order>]
//     [LIMIT N] [OFFSET N]
//   ) t
//
// Filter/order/limit apply in ONE subquery using bare column
// references (no alias prefix) via `LOCAL_SCOPE`. The previous
// version nested two subqueries and played a `pgrst_call` vs `t`
// alias game that leaked into the filter fragment output —
// `LOCAL_SCOPE` lets the filter renderers emit `"col" > $1`
// directly so there is no alias to get wrong.

import { ok, type Result } from '@/core/result';
import type { CloudRestError } from '@/core/errors';
import type { RpcPlan } from '@/planner/rpc-plan';
import {
  renderFilter,
  renderLimitOffset,
  renderLogicTree,
  renderOrderClause,
  renderSelectProjection,
} from './fragments';
import { LOCAL_SCOPE, qualifiedIdentifierToSql } from './identifiers';
import { SqlBuilder } from './sql';
import type { BuiltQuery } from './types';

export function buildRpcQuery(
  plan: RpcPlan,
): Result<BuiltQuery, CloudRestError> {
  const builder = new SqlBuilder();
  const fnSql = qualifiedIdentifierToSql(plan.target);

  // 1. Render the function call — `"public"."fn"(arg := $1::type, ...)`.
  const callExpr = renderCallExpression(plan, fnSql, builder);

  // 2. Decide the inner SELECT shape.
  //    - scalar / setof scalar: `SELECT <callExpr> AS pgrst_scalar`
  //      — no FROM clause, the function call is the projection.
  //      `plan.select` is ignored (a scalar has no column list).
  //    - composite / setof composite: `SELECT <projection> FROM
  //      <callExpr>` — expand the function's record columns as row
  //      columns and honor `?select=col1,col2` via the shared
  //      `renderSelectProjection` helper with `LOCAL_SCOPE` so the
  //      projected columns stay unqualified.
  let innerSelectSql: string;
  if (plan.returnsScalar || plan.returnsSetOfScalar) {
    innerSelectSql = `SELECT ${callExpr} AS pgrst_scalar`;
  } else {
    const projectionResult = renderSelectProjection(
      LOCAL_SCOPE,
      plan.select,
      builder,
    );
    if (!projectionResult.ok) return projectionResult;
    innerSelectSql = `SELECT ${projectionResult.value} FROM ${callExpr}`;
  }

  // 3. Filters / logic / order / limit — ALL with LOCAL_SCOPE so
  //    the fragment renderers emit bare `"col"` refs that resolve
  //    against the function's output row.
  const whereParts: string[] = [];
  for (const f of plan.filters) {
    const rendered = renderFilter(LOCAL_SCOPE, f, builder);
    if (!rendered.ok) return rendered;
    whereParts.push(rendered.value);
  }
  for (const tree of plan.logic) {
    const rendered = renderLogicTree(LOCAL_SCOPE, tree, builder);
    if (!rendered.ok) return rendered;
    whereParts.push(rendered.value);
  }
  const whereSql =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const orderResult = renderOrderClause(LOCAL_SCOPE, plan.order, builder);
  if (!orderResult.ok) return orderResult;
  const orderSql = orderResult.value;

  const limitSql = renderLimitOffset(plan.range.offset, plan.range.limit);

  // 4. Body expression and outer wrapper.
  const bodyExpr = renderBodyExpr(plan);

  const innerSql = [innerSelectSql, whereSql, orderSql, limitSql]
    .filter((s) => s !== '')
    .join(' ');

  builder.write('SELECT ');
  builder.write('null::bigint AS total_result_set, ');
  builder.write('pg_catalog.count(t) AS page_total, ');
  builder.write(`${bodyExpr} AS body`);
  builder.write(
    ", nullif(current_setting('response.headers', true), '') AS response_headers",
  );
  builder.write(
    ", nullif(current_setting('response.status',  true), '') AS response_status",
  );
  builder.write(' FROM (');
  builder.write(innerSql);
  builder.write(') t');

  return ok(builder.toBuiltQuery());
}

// ----- Call expression helpers -----------------------------------------

function renderCallExpression(
  plan: RpcPlan,
  fnSql: string,
  builder: SqlBuilder,
): string {
  switch (plan.callShape) {
    case 'none':
      return `${fnSql}()`;
    case 'singleUnnamed': {
      const paramType = plan.routine.params[0]!.type;
      const paramRef = builder.addParam(plan.rawBody ?? '');
      return `${fnSql}(${paramRef}::${paramType})`;
    }
    case 'named': {
      const argList = plan.namedArgs.map(([name, value]) => {
        const paramDef = plan.routine.params.find((p) => p.name === name)!;
        const paramRef = builder.addParam(value);
        return `"${name.replace(/"/g, '""')}" := ${paramRef}::${paramDef.type}`;
      });
      return `${fnSql}(${argList.join(', ')})`;
    }
  }
}

function renderBodyExpr(plan: RpcPlan): string {
  if (plan.returnPreference === 'minimal') return `'[]'::text`;
  if (plan.returnsScalar) {
    // Single scalar: `json_agg(...)->0` picks the first value, with
    // `null` fallback when no rows came back.
    return `coalesce(json_agg(t.pgrst_scalar)->0, 'null')::text`;
  }
  if (plan.returnsSetOfScalar) {
    return `coalesce(json_agg(t.pgrst_scalar), '[]')::text`;
  }
  return `coalesce(json_agg(t), '[]')::text`;
}
