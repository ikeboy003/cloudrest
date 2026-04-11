// Read query builder — `ReadPlan → BuiltQuery`.
//
// INVARIANT: Every feature (filters, logic, order, range, search,
// vector, distinct, having, count strategy, media-sensitive row cap)
// is a field of ReadPlan and renders as part of this single function.
// No post-hoc `sql.replace()` surgery. CONSTITUTION §1.1, §1.6.
//
// INVARIANT: Every user-controlled value reaches SQL through
// `SqlBuilder.addParam`. The only inlined values are integers (LIMIT /
// OFFSET), operator mnemonics, cast types from the allowlist, and
// identifiers escaped via `escapeIdent`. CONSTITUTION §1.3.
//
// Shape of the rendered query:
//
//   [WITH pgrst_source_count AS (...)]
//   SELECT
//     <count-expression> AS total_result_set,
//     pg_catalog.count(t) AS page_total,
//     coalesce(json_agg(t), '[]')::text AS body
//     [, nullif(current_setting('response.headers', true), '') AS response_headers,
//        nullif(current_setting('response.status',  true), '') AS response_status]
//   FROM (
//     SELECT [DISTINCT [ON (...)]] <projection>
//     FROM   "schema"."table"
//     [WHERE <filters> [AND <search>]]
//     [GROUP BY <non-aggregates>]
//     [HAVING <aggregate filters>]
//     [ORDER BY <order terms> [, <vector distance>]]
//     [LIMIT N] [OFFSET N]
//   ) t

import type { CloudRestError } from '../core/errors';
import { err, ok, type Result } from '../core/result';
import type { ReadPlan, SearchPlan, VectorPlan } from '../planner/read-plan';
import {
  escapeIdent,
  pgFmtLit,
  qualifiedColumnToSql,
  qualifiedIdentifierToSql,
} from './identifiers';
import {
  renderFilter,
  renderGroupBy,
  renderHaving,
  renderLimitOffset,
  renderLogicTree,
  renderOrderClause,
  renderSelectProjection,
} from './fragments';
import { SqlBuilder } from './sql';
import type { BuiltQuery } from './types';

/**
 * Render a ReadPlan into a BuiltQuery. Returns an error only when the
 * plan references something the renderer refuses to emit (unknown cast
 * type, malformed JSON-path index, etc.); the planner should catch most
 * of these earlier.
 */
export function buildReadQuery(
  plan: ReadPlan,
): Result<BuiltQuery, CloudRestError> {
  const builder = new SqlBuilder();

  // ----- Effective row limit (media-type caps + DB_MAX_ROWS ceiling) --
  const effectiveLimit = computeEffectiveLimit(plan);

  // ----- Inner SELECT projection --------------------------------------
  // Start with the user's projection, then append synthetic columns
  // from search.includeRank and vector (distance) if present.
  const projectionResult = renderSelectProjection(plan.target, plan.select, builder);
  if (!projectionResult.ok) return projectionResult;
  const projectionParts: string[] = [projectionResult.value];

  if (plan.search && plan.search.includeRank) {
    const rankResult = renderSearchRank(plan.target, plan.search, builder);
    if (!rankResult.ok) return rankResult;
    projectionParts.push(rankResult.value);
  }

  if (plan.vector) {
    const distanceResult = renderVectorDistance(plan.target, plan.vector, builder);
    if (!distanceResult.ok) return distanceResult;
    projectionParts.push(`${distanceResult.value} AS "distance"`);
  }

  const projectionSql = projectionParts.join(', ');

  // ----- DISTINCT clause -----------------------------------------------
  const distinctSql = renderDistinct(plan);

  // ----- FROM ----------------------------------------------------------
  const fromSql = qualifiedIdentifierToSql(plan.target);

  // ----- WHERE (filters + logic + optional search match) --------------
  const whereParts: string[] = [];
  for (const filter of plan.filters) {
    const rendered = renderFilter(plan.target, filter, builder);
    if (!rendered.ok) return rendered;
    whereParts.push(rendered.value);
  }
  for (const tree of plan.logic) {
    const rendered = renderLogicTree(plan.target, tree, builder);
    if (!rendered.ok) return rendered;
    whereParts.push(rendered.value);
  }
  if (plan.search) {
    const rendered = renderSearchMatch(plan.target, plan.search, builder);
    if (!rendered.ok) return rendered;
    whereParts.push(rendered.value);
  }
  const whereSql =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  // ----- GROUP BY + HAVING --------------------------------------------
  const groupBySqlResult = renderGroupBy(plan.target, plan.select, builder);
  if (!groupBySqlResult.ok) return groupBySqlResult;
  const groupBySql = groupBySqlResult.value;

  const havingSqlResult = renderHaving(plan.target, plan.having, builder);
  if (!havingSqlResult.ok) return havingSqlResult;
  const havingSql = havingSqlResult.value;

  // ----- ORDER BY ------------------------------------------------------
  //
  // Vector distance becomes either the primary order (when no user
  // order is supplied) or a tie-breaker at the end.
  const orderSqlResult = renderOrderClause(plan.target, plan.order, builder);
  if (!orderSqlResult.ok) return orderSqlResult;
  let orderSql = orderSqlResult.value;

  if (plan.vector) {
    const distanceResult = renderVectorDistance(plan.target, plan.vector, builder);
    if (!distanceResult.ok) return distanceResult;
    const distanceExpr = distanceResult.value;
    if (orderSql === '') {
      orderSql = `ORDER BY ${distanceExpr}`;
    } else {
      orderSql = `${orderSql}, ${distanceExpr}`;
    }
  }

  // ----- LIMIT / OFFSET -----------------------------------------------
  const limitSql = renderLimitOffset(plan.range.offset, effectiveLimit);

  // ----- Assemble inner subquery --------------------------------------
  const innerSql = joinNonEmpty([
    `SELECT ${distinctSql}${projectionSql}`,
    `FROM ${fromSql}`,
    whereSql,
    groupBySql,
    havingSql,
    orderSql,
    limitSql,
  ]);

  // ----- Outer wrapper with count, body, optional GUCs ----------------
  const { countCteSql, countSelectSql } = renderCount(plan, whereParts);

  const bodySql = renderBodyAggregate(plan);
  const gucSelectSql = plan.hasPreRequest
    ? `, nullif(current_setting('response.headers', true), '') AS response_headers` +
      `, nullif(current_setting('response.status',  true), '') AS response_status`
    : '';

  builder.write(countCteSql);
  builder.write('SELECT ');
  builder.write(`${countSelectSql} AS total_result_set, `);
  builder.write('pg_catalog.count(t) AS page_total, ');
  builder.write(`${bodySql} AS body`);
  builder.write(gucSelectSql);
  builder.write(' FROM (');
  builder.write(innerSql);
  builder.write(') t');

  if (!plan.hasPreRequest) builder.markSkipGucRead();
  return ok(builder.toBuiltQuery());
}

// ----- Helpers ----------------------------------------------------------

function computeEffectiveLimit(plan: ReadPlan): number | null {
  let limit = plan.range.limit;
  // Singular-media enforces at most 2 rows so we can detect more-than-one.
  if (plan.mediaType === 'singular' || plan.mediaType === 'singular-stripped') {
    if (limit === null || limit > 2) limit = 2;
  }
  if (plan.maxRows !== null) {
    if (limit === null || limit > plan.maxRows) limit = plan.maxRows;
  }
  return limit;
}

function renderDistinct(plan: ReadPlan): string {
  if (!plan.distinct) return '';
  if (plan.distinct.columns.length === 0) return 'DISTINCT ';
  const cols = plan.distinct.columns
    .map((c) => qualifiedColumnToSql(plan.target, c))
    .join(', ');
  return `DISTINCT ON (${cols}) `;
}

function renderBodyAggregate(plan: ReadPlan): string {
  // `nulls=stripped` requires strip-nulls per row.
  const stripNulls = plan.mediaType === 'array-stripped';
  const aggExpr = stripNulls
    ? `json_agg(json_strip_nulls(to_json(t)))`
    : `json_agg(t)`;
  return `coalesce(${aggExpr}, '[]')::text`;
}

/**
 * Render the count strategy (exact / planned / estimated / none).
 *
 * Returns both the optional `WITH pgrst_source_count` CTE and the
 * expression to use in the outer SELECT for `total_result_set`.
 *
 * COMPAT: matches PostgREST count strategies. The `WHERE` clause used
 * in the count CTE must be the same as the inner subquery's, but we
 * cannot trivially reuse it because `SqlBuilder` would allocate fresh
 * params. Instead, the whereParts we got back are already rendered and
 * safe to reference inline — their params are shared with the outer
 * builder.
 */
function renderCount(
  plan: ReadPlan,
  whereParts: readonly string[],
): { countCteSql: string; countSelectSql: string } {
  if (plan.count === null) {
    return { countCteSql: '', countSelectSql: 'null::bigint' };
  }

  const whereSql =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
  const tableSql = qualifiedIdentifierToSql(plan.target);
  const regclassLit = pgFmtLit(tableSql);

  if (plan.count === 'exact') {
    return {
      countCteSql: `WITH pgrst_source_count AS (SELECT 1 FROM ${tableSql} ${whereSql}) `,
      countSelectSql: `(SELECT pg_catalog.count(*) FROM pgrst_source_count)`,
    };
  }

  if (plan.count === 'planned') {
    return {
      countCteSql: '',
      countSelectSql: `(SELECT reltuples::bigint FROM pg_class WHERE oid = ${regclassLit}::regclass)`,
    };
  }

  // estimated — exact up to a ceiling, planned after that.
  const ceiling = plan.maxRows !== null && plan.maxRows >= 0 ? plan.maxRows + 1 : 10001;
  const cte =
    `WITH pgrst_source_count AS MATERIALIZED ` +
    `(SELECT 1 FROM ${tableSql} ${whereSql} LIMIT ${ceiling}), ` +
    `pgrst_source_count_n AS (SELECT pg_catalog.count(*) AS n FROM pgrst_source_count) `;
  const select =
    `(CASE WHEN (SELECT n FROM pgrst_source_count_n) < ${ceiling} ` +
    `THEN (SELECT n FROM pgrst_source_count_n) ` +
    `ELSE (SELECT reltuples::bigint FROM pg_class WHERE oid = ${regclassLit}::regclass) END)`;
  return { countCteSql: cte, countSelectSql: select };
}

// ----- Search rendering -------------------------------------------------

/**
 * Render the `to_tsvector(lang, col1 || ' ' || col2 || ...) @@ websearch_to_tsquery(lang, $N)`
 * match expression. The language and the search term both go through
 * addParam. The column list is validated by the planner.
 *
 * SECURITY (#10): language is bound, not inlined.
 * SECURITY: empty column list is a builder error, not a silent "match nothing".
 */
function renderSearchMatch(
  target: { schema: string; name: string },
  search: SearchPlan,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  if (search.columns.length === 0) {
    return err({
      code: 'PGRST100',
      message: 'search requires at least one column',
      details: null,
      hint: null,
      httpStatus: 400,
    } as CloudRestError);
  }
  const tsvectorExpr = renderTsVector(target, search, builder);
  const termParam = builder.addParam(search.term);
  const langParam2 = builder.addParam(search.language);
  const tsqueryExpr = `websearch_to_tsquery(${langParam2}, ${termParam})`;
  return ok(`${tsvectorExpr} @@ ${tsqueryExpr}`);
}

function renderSearchRank(
  target: { schema: string; name: string },
  search: SearchPlan,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  if (search.columns.length === 0) {
    return err({
      code: 'PGRST100',
      message: 'search requires at least one column',
      details: null,
      hint: null,
      httpStatus: 400,
    } as CloudRestError);
  }
  const tsvectorExpr = renderTsVector(target, search, builder);
  const termParam = builder.addParam(search.term);
  const langParam2 = builder.addParam(search.language);
  return ok(
    `ts_rank(${tsvectorExpr}, websearch_to_tsquery(${langParam2}, ${termParam})) AS "relevance"`,
  );
}

function renderTsVector(
  target: { schema: string; name: string },
  search: SearchPlan,
  builder: SqlBuilder,
): string {
  const langParam = builder.addParam(search.language);
  const colRefs = search.columns.map(
    (c) => `coalesce(${qualifiedColumnToSql(target, c)}::text, '')`,
  );
  const concatenated = colRefs.join(" || ' ' || ");
  return `to_tsvector(${langParam}, ${concatenated})`;
}

// ----- Vector rendering -------------------------------------------------

const VECTOR_OP_SYMBOL: Record<VectorPlan['op'], string> = {
  l2: '<->',
  cosine: '<=>',
  inner_product: '<#>',
  l1: '<+>',
};

/**
 * Render `"schema"."table"."column" <OP> $N::vector`. Binds the vector
 * value as a Postgres text literal that the driver will cast to vector.
 *
 * SECURITY (#77, #78): the vector value is bound via addParam. There is
 * no post-render rewriting step.
 */
function renderVectorDistance(
  target: { schema: string; name: string },
  vector: VectorPlan,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  const colSql = qualifiedColumnToSql(target, vector.column);
  // Postgres `vector` literal is `'[1,2,3]'::vector`. We bind the textual
  // form as a string parameter and cast in SQL.
  const literal = `[${vector.queryVector.join(',')}]`;
  const param = builder.addParam(literal);
  return ok(`${colSql} ${VECTOR_OP_SYMBOL[vector.op]} ${param}::vector`);
}

// ----- Small SQL helpers ------------------------------------------------

function joinNonEmpty(parts: readonly string[]): string {
  return parts.filter((p) => p !== '').join(' ');
}

// Helper name kept to avoid ts-unused-import flags; escapeIdent is used
// transitively via renderDistinct/renderCount.
void escapeIdent;
