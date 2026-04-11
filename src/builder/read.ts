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

import { parseErrors, type CloudRestError } from '../core/errors';
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
  renderGroupByFromProjection,
  renderHaving,
  renderLimitOffset,
  renderLogicTree,
  renderOrderClause,
  renderSelectProjectionAndGrouping,
} from './fragments';
import { createAliasCounter, renderEmbeds } from './embed';
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
  // from search.includeRank, vector (distance), and every root embed
  // (if any). Each embed contributes a column expression (or many, for
  // aggregate embeds) plus a LATERAL-join clause spliced into FROM.
  const projectionResult = renderSelectProjectionAndGrouping(
    plan.target,
    plan.select,
    builder,
  );
  if (!projectionResult.ok) return projectionResult;
  const projection = projectionResult.value;
  const projectionParts: string[] = [projection.projectionSql];

  // BUG FIX (#BB13 / #BB14): an aggregate select (`select=count()` or
  // any mix with aggregate functions) cannot be combined with vector
  // distance or search rank. Both of those synthesize a non-aggregate
  // projection column, which would require the user's non-aggregate
  // columns to be present in GROUP BY — they are not. Postgres would
  // reject the query with "column X must appear in the GROUP BY
  // clause"; surface the incompatibility here with a clearer error.
  if (projection.hasAggregates && plan.vector) {
    return err(
      parseErrors.queryParam(
        'select',
        'aggregate select cannot be combined with vector search (distance is a non-aggregate column)',
      ),
    );
  }
  if (projection.hasAggregates && plan.search && plan.search.includeRank) {
    return err(
      parseErrors.queryParam(
        'select',
        'aggregate select cannot be combined with search rank (relevance is a non-aggregate column)',
      ),
    );
  }

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

  const aliasCounter = createAliasCounter();
  const embedResult = renderEmbeds(plan.target, plan.embeds, aliasCounter, builder);
  if (!embedResult.ok) return embedResult;
  for (const col of embedResult.value.columns) projectionParts.push(col);

  const projectionSql = projectionParts.join(', ');

  // ----- DISTINCT clause -----------------------------------------------
  const distinctSql = renderDistinct(plan);

  // ----- FROM ----------------------------------------------------------
  const fromBase = qualifiedIdentifierToSql(plan.target);
  const fromSql =
    embedResult.value.joins.length > 0
      ? `${fromBase} ${embedResult.value.joins.join(' ')}`
      : fromBase;

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
  //
  // BUG FIX (#BB6): GROUP BY reuses the same rendered field
  // expressions from the projection pass so JSON-path keys are not
  // rebound as fresh parameters.
  const groupBySql = renderGroupByFromProjection(projection);

  // BUG FIX (#BB8): a HAVING clause only makes sense in an aggregate
  // query. `having=count().gt.5` on a default `select=*` would emit
  // `SELECT t.* FROM t HAVING COUNT(*) > $1` — invalid SQL. Require
  // the projection to contain at least one aggregate before we
  // accept HAVING.
  if (plan.having.length > 0 && !projection.hasAggregates) {
    return err(
      parseErrors.queryParam(
        'having',
        'HAVING requires an aggregate in the select list',
      ),
    );
  }

  const havingSqlResult = renderHaving(plan.target, plan.having, builder);
  if (!havingSqlResult.ok) return havingSqlResult;
  const havingSql = havingSqlResult.value;

  // ----- ORDER BY ------------------------------------------------------
  //
  // Vector distance becomes either the primary order (when no user
  // order is supplied) or a tie-breaker at the end.
  //
  // BUG FIX (#CC2): pass the embed alias map so that related ORDER
  // BY terms (`?order=author(name).asc`) resolve to the LATERAL
  // alias (`"pgrst_1"."name"`) instead of a non-existent
  // `"public"."author"."name"` reference.
  const orderSqlResult = renderOrderClause(
    plan.target,
    plan.order,
    builder,
    embedResult.value.embedAliases,
  );
  if (!orderSqlResult.ok) return orderSqlResult;
  let orderSql = orderSqlResult.value;

  if (plan.vector) {
    // BUG FIX (#BB15): `DISTINCT ON (col)` requires the first
    // ORDER BY expression to match the DISTINCT ON expression(s).
    // When a vector plan is active without a user-supplied ORDER BY,
    // the vector distance would become the primary ORDER BY and
    // Postgres would reject the query with:
    //   "SELECT DISTINCT ON expressions must match initial ORDER BY
    //    expressions".
    // Reject the combination here with a clearer error instead of
    // emitting invalid SQL.
    if (plan.distinct && plan.distinct.columns.length > 0 && orderSql === '') {
      return err(
        parseErrors.queryParam(
          'order',
          'DISTINCT ON combined with vector search requires an explicit "?order=" that starts with the DISTINCT ON columns',
        ),
      );
    }
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
  // BUG FIX (#BB9, #BB10): exact count must reflect grouping /
  // HAVING / DISTINCT. Pass the shape of the inner query so the
  // count CTE can mirror it when needed.
  const { countCteSql, countSelectSql } = renderCount(plan, {
    whereParts,
    groupBySql,
    havingSql,
    distinctSql,
    projectionForDistinct: projection,
    fromSql,
  });

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

interface CountRenderInput {
  readonly whereParts: readonly string[];
  readonly groupBySql: string;
  readonly havingSql: string;
  readonly distinctSql: string;
  readonly projectionForDistinct: import('./fragments').RenderedProjection;
  readonly fromSql: string;
}

/**
 * Render the count strategy (exact / planned / estimated / none).
 *
 * Returns both the optional `WITH pgrst_source_count` CTE and the
 * expression to use in the outer SELECT for `total_result_set`.
 *
 * BUG FIX (#BB9): the old exact-count CTE was `SELECT 1 FROM t WHERE
 * ...` — it ignored GROUP BY and HAVING entirely. For a grouped
 * query (`select=category,count()&having=count().gt.5`) it would
 * count every filtered row in the base table instead of the number
 * of groups returned by the inner subquery.
 *
 * BUG FIX (#BB10): the same CTE also ignored DISTINCT / DISTINCT
 * ON, so an exact count on a distinct query counted every row
 * instead of every distinct group.
 *
 * The rewrite detects the shapes that need a wrapped count and
 * emits the correct CTE in each case. Note the WHERE/HAVING/
 * projection fragments were rendered with the outer builder, so
 * their `$N` params are already allocated — we reference the
 * already-rendered SQL instead of re-rendering.
 *
 * BUG FIX (#BB11, #BB12): `planned` and `estimated` strategies still
 * lean on `pg_class.reltuples`, which is a whole-table estimate and
 * does not reflect filters. This is inherent to the strategies
 * (PostgREST parity) and is called out in the comments below so the
 * next reader is not surprised.
 */
function renderCount(
  plan: ReadPlan,
  input: CountRenderInput,
): { countCteSql: string; countSelectSql: string } {
  if (plan.count === null) {
    return { countCteSql: '', countSelectSql: 'null::bigint' };
  }

  const { whereParts, groupBySql, havingSql, distinctSql, projectionForDistinct, fromSql } = input;
  const whereSql =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
  const tableSql = qualifiedIdentifierToSql(plan.target);
  const regclassLit = pgFmtLit(tableSql);

  // A non-trivial inner shape means the counted rows are NOT just
  // the filtered base-table rows. HAVING and GROUP BY change the
  // cardinality, and DISTINCT / DISTINCT ON collapses rows. In
  // those cases the count CTE must wrap a subquery that mirrors
  // the inner subquery's shape.
  const needsWrappedCount =
    groupBySql !== '' || havingSql !== '' || distinctSql !== '';

  if (plan.count === 'exact') {
    if (!needsWrappedCount) {
      return {
        countCteSql: `WITH pgrst_source_count AS (SELECT 1 FROM ${tableSql} ${whereSql}) `,
        countSelectSql: `(SELECT pg_catalog.count(*) FROM pgrst_source_count)`,
      };
    }
    // Wrap the inner shape. The projection we count is intentionally
    // `SELECT [DISTINCT [ON (...)]] <group-by columns | 1>` — we
    // only need the rows themselves, not their values, but DISTINCT
    // ON needs real expressions to deduplicate on.
    const innerProjection = distinctSql.startsWith('DISTINCT ON')
      ? projectionForDistinct.groupByFieldSqls.length > 0
        ? projectionForDistinct.groupByFieldSqls.join(', ')
        : '1'
      : '1';
    const wrapped = joinNonEmpty([
      `SELECT ${distinctSql}${innerProjection}`,
      `FROM ${fromSql}`,
      whereSql,
      groupBySql,
      havingSql,
    ]);
    return {
      countCteSql: `WITH pgrst_source_count AS (${wrapped}) `,
      countSelectSql: `(SELECT pg_catalog.count(*) FROM pgrst_source_count)`,
    };
  }

  if (plan.count === 'planned') {
    // NOTE (#BB11): `planned` is a whole-table estimate via
    // `pg_class.reltuples`. It deliberately does NOT reflect filters,
    // grouping, or distinct — this matches PostgREST's behavior.
    // Callers that need a filtered count should use `exact` or
    // `estimated`.
    return {
      countCteSql: '',
      countSelectSql: `(SELECT reltuples::bigint FROM pg_class WHERE oid = ${regclassLit}::regclass)`,
    };
  }

  // estimated — exact up to a ceiling, planned after that.
  //
  // NOTE (#BB12): above the ceiling the fallback is whole-table
  // `reltuples`, not a filtered plan estimate. A tighter estimate
  // would require `EXPLAIN (FORMAT JSON)`-in-a-CTE machinery that
  // is out of scope here. Documenting the limitation so the next
  // reader does not think it is a bug.
  const ceiling = plan.maxRows !== null && plan.maxRows >= 0 ? plan.maxRows + 1 : 10001;

  // For grouped / distinct queries, mirror the inner shape inside
  // the CTE so the ceiling applies to the correct row count.
  const exactCteBody = needsWrappedCount
    ? joinNonEmpty([
        `SELECT ${distinctSql}1`,
        `FROM ${fromSql}`,
        whereSql,
        groupBySql,
        havingSql,
        `LIMIT ${ceiling}`,
      ])
    : `SELECT 1 FROM ${tableSql} ${whereSql} LIMIT ${ceiling}`;

  const cte =
    `WITH pgrst_source_count AS MATERIALIZED ` +
    `(${exactCteBody}), ` +
    `pgrst_source_count_n AS (SELECT pg_catalog.count(*) AS n FROM pgrst_source_count) `;
  const select =
    `(CASE WHEN (SELECT n FROM pgrst_source_count_n) < ${ceiling} ` +
    `THEN (SELECT n FROM pgrst_source_count_n) ` +
    `ELSE (SELECT reltuples::bigint FROM pg_class WHERE oid = ${regclassLit}::regclass) END)`;
  return { countCteSql: cte, countSelectSql: select };
}

// ----- Search rendering -------------------------------------------------
//
// KNOWN INEFFICIENCY (#BB18): both `renderSearchRank` and the WHERE
// clause build their own `to_tsvector(...)` / `ts_rank(...)`
// expressions, and vector distance is computed in projection AND
// again in ORDER BY, each time going through `builder.addParam`. The
// driver therefore sees two separate `$N` parameters binding the same
// value, and Postgres compiles two structurally identical but
// distinct expressions. Correct but wasteful, and it can also trigger
// "column must appear in GROUP BY" mismatches when combined with
// DISTINCT/GROUP BY (see the hasAggregates guards in buildReadQuery).
//
// A future pass should hoist these expressions into a CTE column so
// both projection and ordering reference the same `$N`. Left as a
// documented TODO rather than silently changing the query shape.
//

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
