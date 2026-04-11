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
// Stage 10 shape:
//
//   SELECT
//     null::bigint AS total_result_set,
//     pg_catalog.count(t) AS page_total,
//     <body expr> AS body,
//     <guc passthrough>
//   FROM (
//     SELECT pgrst_call.*
//     FROM "public"."fn"(arg1 := $1::type, ...) pgrst_call
//     [WHERE <filters>]
//     [ORDER BY <order>]
//     [LIMIT N] [OFFSET N]
//   ) t

import { ok, type Result } from '../core/result';
import type { CloudRestError } from '../core/errors';
import type { QualifiedIdentifier } from '../http/request';
import type { RpcPlan } from '../planner/rpc-plan';
import { renderFilter, renderLogicTree, renderOrderClause, renderLimitOffset } from './fragments';
import { qualifiedIdentifierToSql } from './identifiers';
import { SqlBuilder } from './sql';
import type { BuiltQuery } from './types';

export function buildRpcQuery(
  plan: RpcPlan,
): Result<BuiltQuery, CloudRestError> {
  const builder = new SqlBuilder();
  const fnSql = qualifiedIdentifierToSql(plan.target);

  // ----- 1. Render the function call ----------------------------------
  const callExpr = renderCallExpression(plan, fnSql, builder);

  // Wrap a scalar / setof-scalar return into `AS pgrst_scalar` so the
  // outer json_agg can pick the right column name.
  const innerSelectCols =
    plan.returnsScalar || plan.returnsSetOfScalar
      ? 'pgrst_call.pgrst_scalar'
      : 'pgrst_call.*';

  const scalarWrap =
    plan.returnsScalar || plan.returnsSetOfScalar
      ? `(SELECT ${callExpr} AS pgrst_scalar) pgrst_call`
      : `${callExpr} pgrst_call`;

  // ----- 2. Filter / logic / order / limit over the result set ------
  const rpcAlias: QualifiedIdentifier = { schema: '', name: 't' };
  const whereParts: string[] = [];
  for (const f of plan.filters) {
    const rendered = renderFilter(rpcAlias, f, builder);
    if (!rendered.ok) return rendered;
    whereParts.push(rendered.value);
  }
  for (const tree of plan.logic) {
    const rendered = renderLogicTree(rpcAlias, tree, builder);
    if (!rendered.ok) return rendered;
    whereParts.push(rendered.value);
  }
  const whereSql =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const orderResult = renderOrderClause(rpcAlias, plan.order, builder);
  if (!orderResult.ok) return orderResult;
  const orderSql = orderResult.value;

  const limitSql = renderLimitOffset(plan.range.offset, plan.range.limit);

  // ----- 3. Body expression (scalar vs set vs composite) --------------
  const bodyExpr = renderBodyExpr(plan);

  // ----- 4. Assemble --------------------------------------------------
  const innerSql = [
    `SELECT ${innerSelectCols} FROM ${scalarWrap}`,
    whereSql,
    orderSql,
    limitSql,
  ]
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
