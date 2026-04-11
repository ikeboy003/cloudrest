// Embed rendering — turns an `EmbedNode` tree from the planner into
// LATERAL joins, correlated subqueries, or spreads, and splices the
// embed column expressions into the parent projection.
//
// Mirrors PostgREST's QueryBuilder.hs shape:
//
//   To-one:
//     SELECT ..., row_to_json("pgrst_1".*)::jsonb AS "author"
//     LEFT JOIN LATERAL (
//       SELECT "authors".* FROM "public"."authors"
//       WHERE "authors"."id" = "books"."author_id"
//     ) AS "pgrst_1" ON TRUE
//
//   To-many:
//     SELECT ..., COALESCE("pgrst_1"."pgrst_1", '[]') AS "reviews"
//     LEFT JOIN LATERAL (
//       SELECT json_agg("pgrst_1")::jsonb AS "pgrst_1"
//       FROM (<inner select>) AS "pgrst_1"
//     ) AS "pgrst_1" ON TRUE
//
// INVARIANT (CONSTITUTION §1.3): every user-controlled value reaches
// SQL via SqlBuilder.addParam — filter bindings inside the child plans
// go through the standard filter renderer.

import { parseErrors, type CloudRestError } from '../core/errors';
import { err, ok, type Result } from '../core/result';
import type { QualifiedIdentifier } from '../http/request';
import type { SelectItem } from '../parser/types';
import type { EmbedNode, ReadPlanSubtree } from '../planner/embed-plan';
import type { Cardinality } from '../schema/relationship';
import { escapeIdent, qualifiedIdentifierToSql } from './identifiers';
import {
  renderField,
  renderFilter,
  renderLimitOffset,
  renderLogicTree,
  renderOrderClause,
  renderSelectProjection,
} from './fragments';
import { isValidCast } from './fragments/operators';
import type { SqlBuilder } from './sql';

export interface AliasCounter {
  value: number;
}

export function createAliasCounter(): AliasCounter {
  return { value: 0 };
}

function nextAlias(counter: AliasCounter): string {
  counter.value += 1;
  return `pgrst_${counter.value}`;
}

export interface RenderedEmbeds {
  readonly columns: readonly string[];
  readonly joins: readonly string[];
  /**
   * Map from every name the planner accepts for a to-one embed
   * (the explicit alias AND the underlying child-table name) to
   * the internal LATERAL alias (`pgrst_1`). The planner resolves
   * `order=rel(col).asc` against either form, so the builder must
   * be able to find both.
   *
   * BUG FIX (#CC2): root-level `?order=rel(col).asc` used to render
   * a raw `"schema"."rel"."col"` reference in ORDER BY, even though
   * the embed was joined via `LEFT JOIN LATERAL (...) AS pgrst_1`.
   * Postgres then rejected the query with "missing FROM-clause
   * entry". Use the lateral alias instead.
   *
   * BUG FIX (#DD4): previously only the user-visible alias was
   * mapped, so `select=id,author:authors(name)&order=authors(...)`
   * passed planning (the planner accepts the child-table name) and
   * then failed at render. Both names are mapped now.
   */
  readonly embedAliases: ReadonlyMap<string, string>;
  /**
   * True when at least one rendered embed uses a join type that
   * filters parent rows (`!inner` on either to-one or to-many, or
   * an M2M junction — though M2M is currently refused outright).
   * The count renderer consults this flag so `Prefer: count=exact`
   * reflects the post-join cardinality instead of the base-table
   * row count.
   */
  readonly hasRowFilteringJoins: boolean;
}

/**
 * Render every root embed in `embeds` as a column expression and a
 * LATERAL join suffix to the FROM clause. Returns the column list to
 * splice into the parent projection, the join clauses (joined with
 * spaces) to append to the parent FROM, and a map of embed names to
 * lateral aliases for ORDER BY resolution.
 */
export function renderEmbeds(
  parent: QualifiedIdentifier,
  embeds: readonly EmbedNode[],
  counter: AliasCounter,
  builder: SqlBuilder,
): Result<RenderedEmbeds, CloudRestError> {
  const columns: string[] = [];
  const joins: string[] = [];
  const embedAliases = new Map<string, string>();
  let hasRowFilteringJoins = false;

  // BUG FIX (#FF4): the child-table-name fallback entry is only
  // safe when at most ONE embed on this request points at that
  // table. When multiple aliases reuse the same child table
  // (`select=a:authors(id),b:authors(name)`), a bare `authors`
  // reference is ambiguous — the old code set the map twice and
  // silently preferred the last insert. Count occurrences up
  // front so ambiguous child-table names are omitted from the
  // map entirely; the planner has already rejected the ambiguous
  // ORDER BY case with PGRST201.
  const childTableNameCounts = new Map<string, number>();
  for (const embed of embeds) {
    const name = embed.child.target.name;
    childTableNameCounts.set(name, (childTableNameCounts.get(name) ?? 0) + 1);
  }

  for (const embed of embeds) {
    const result = renderEmbed(parent, embed, counter, builder);
    if (!result.ok) return result;
    if (result.value.column !== '') columns.push(result.value.column);
    if (result.value.join !== '') joins.push(result.value.join);
    if (result.value.lateralAlias !== undefined) {
      // Explicit alias is always unambiguous (the parser's select
      // grammar allows one alias per select item).
      embedAliases.set(embed.alias, result.value.lateralAlias);
      // Child-table-name fallback — only safe when exactly one
      // embed points at that table AND the alias differs from it.
      const childTableName = embed.child.target.name;
      if (
        childTableName !== embed.alias &&
        (childTableNameCounts.get(childTableName) ?? 0) === 1
      ) {
        embedAliases.set(childTableName, result.value.lateralAlias);
      }
    }
    // `!inner` filters rows regardless of cardinality. A to-many
    // `!inner` is implemented via an ON condition that rejects
    // parents with no matching children; a to-one `!inner` is
    // emitted as INNER JOIN LATERAL. Either shape changes the
    // post-join cardinality relative to the base table.
    if (embed.joinType === 'inner') {
      hasRowFilteringJoins = true;
    }
  }
  return ok({ columns, joins, embedAliases, hasRowFilteringJoins });
}

interface RenderedEmbed {
  readonly column: string;
  readonly join: string;
  /**
   * The LATERAL alias that the inner subquery was bound to, when
   * this embed is a to-one (M2O / O2O) LATERAL join that ORDER BY
   * on the parent can reference. `undefined` for aggregate embeds
   * (no join) and to-many embeds (JSON array — not a valid ORDER
   * BY target anyway; the planner rejects those).
   */
  readonly lateralAlias?: string;
}

function renderEmbed(
  parent: QualifiedIdentifier,
  embed: EmbedNode,
  counter: AliasCounter,
  builder: SqlBuilder,
): Result<RenderedEmbed, CloudRestError> {
  const alias = nextAlias(counter);
  const joinWord = embed.joinType === 'inner' ? 'INNER' : 'LEFT';
  const outputAlias = escapeIdent(embed.alias);

  if (embed.isAggregate) {
    return renderAggregateEmbed(parent, embed, builder);
  }
  if (embed.isSpread) {
    return renderSpreadEmbed(parent, embed, alias, joinWord, counter, builder);
  }
  if (embed.isToOne) {
    return renderToOneEmbed(parent, embed, alias, joinWord, outputAlias, counter, builder);
  }
  return renderToManyEmbed(parent, embed, alias, joinWord, outputAlias, counter, builder);
}

// ----- To-one ----------------------------------------------------------

function renderToOneEmbed(
  parent: QualifiedIdentifier,
  embed: EmbedNode,
  alias: string,
  joinWord: string,
  outputAlias: string,
  counter: AliasCounter,
  builder: SqlBuilder,
): Result<RenderedEmbed, CloudRestError> {
  const escapedAlias = escapeIdent(alias);
  const innerResult = renderChildSelect(parent, embed, counter, builder);
  if (!innerResult.ok) return innerResult;
  const column = `row_to_json(${escapedAlias}.*)::jsonb AS ${outputAlias}`;
  const join = `${joinWord} JOIN LATERAL (${innerResult.value}) AS ${escapedAlias} ON TRUE`;
  return ok({ column, join, lateralAlias: alias });
}

// ----- To-many ---------------------------------------------------------

function renderToManyEmbed(
  parent: QualifiedIdentifier,
  embed: EmbedNode,
  alias: string,
  joinWord: string,
  outputAlias: string,
  counter: AliasCounter,
  builder: SqlBuilder,
): Result<RenderedEmbed, CloudRestError> {
  const escapedAlias = escapeIdent(alias);
  const innerResult = renderChildSelect(parent, embed, counter, builder);
  if (!innerResult.ok) return innerResult;
  const aggSql =
    `SELECT json_agg(${escapedAlias})::jsonb AS ${escapedAlias} ` +
    `FROM (${innerResult.value}) AS ${escapedAlias}`;
  // !inner to-many: json_agg is NULL when the child subquery is empty.
  // Filter those parents out via the ON condition.
  const onCondition =
    embed.joinType === 'inner' ? `${escapedAlias}.${escapedAlias} IS NOT NULL` : 'TRUE';
  const column =
    embed.joinType === 'inner'
      ? `${escapedAlias}.${escapedAlias} AS ${outputAlias}`
      : `COALESCE(${escapedAlias}.${escapedAlias}, '[]') AS ${outputAlias}`;
  const join = `${joinWord} JOIN LATERAL (${aggSql}) AS ${escapedAlias} ON ${onCondition}`;
  return ok({ column, join });
}

// ----- Spread ----------------------------------------------------------

function renderSpreadEmbed(
  parent: QualifiedIdentifier,
  embed: EmbedNode,
  alias: string,
  joinWord: string,
  counter: AliasCounter,
  builder: SqlBuilder,
): Result<RenderedEmbed, CloudRestError> {
  const escapedAlias = escapeIdent(alias);
  const innerResult = renderChildSelect(parent, embed, counter, builder);
  if (!innerResult.ok) return innerResult;
  const column = `${escapedAlias}.*`;
  const join = `${joinWord} JOIN LATERAL (${innerResult.value}) AS ${escapedAlias} ON TRUE`;
  // BUG FIX (#FF3): a to-one spread embed (`...authors(name)`) is
  // joined through the same LATERAL alias shape as a non-spread
  // to-one embed, so it is a valid target for root-level
  // `order=rel(col).asc`. The planner accepts the combination
  // because the relationship is to-one, but the builder used to
  // return no `lateralAlias` here, so the ORDER BY resolver then
  // failed to find the embed and errored. Only to-ONE spreads are
  // reported — to-many spreads aggregate columns rather than
  // project a single row, so ordering by them has no meaning.
  if (embed.isToOne) {
    return ok({ column, join, lateralAlias: alias });
  }
  return ok({ column, join });
}

// ----- Aggregate -------------------------------------------------------

function renderAggregateEmbed(
  parent: QualifiedIdentifier,
  embed: EmbedNode,
  builder: SqlBuilder,
): Result<RenderedEmbed, CloudRestError> {
  const childQi = embed.child.target;
  const joinConditionResult = renderJoinCondition(
    parent,
    childQi,
    embed.relationship.cardinality,
  );
  if (!joinConditionResult.ok) return joinConditionResult;
  const joinCondition = joinConditionResult.value;

  const filterParts: string[] = [];
  for (const f of embed.child.filters) {
    const rendered = renderFilter(childQi, f, builder);
    if (!rendered.ok) return rendered;
    filterParts.push(rendered.value);
  }
  for (const t of embed.child.logic) {
    const rendered = renderLogicTree(childQi, t, builder);
    if (!rendered.ok) return rendered;
    filterParts.push(rendered.value);
  }
  const allConditions = [joinCondition, ...filterParts].filter((p) => p !== '');
  const whereStr =
    allConditions.length > 0 ? ` WHERE ${allConditions.join(' AND ')}` : '';
  const fromClause = `FROM ${qualifiedIdentifierToSql(childQi)}`;

  const aggFields = embed.child.select.filter(
    (s): s is Extract<SelectItem, { type: 'field' }> =>
      s.type === 'field' && s.aggregateFunction !== undefined,
  );

  // BUG FIX (#CC3): the old aggregate-embed path assembled its own
  // `"schema"."table"."col"` string and skipped `renderField`, so any
  // JSON path or cast on the aggregate argument was silently dropped.
  // Route through the real field renderer and wrap the cast/alias the
  // same way renderSelectProjection does.
  const colExprs: string[] = [];
  for (const agg of aggFields) {
    const func = agg.aggregateFunction!.toUpperCase();
    let aggExpr: string;
    if (agg.aggregateFunction === 'count' && agg.field.name === '*') {
      aggExpr = 'COUNT(*)';
    } else {
      const fieldSqlResult = renderField(childQi, agg.field, builder);
      if (!fieldSqlResult.ok) return fieldSqlResult;
      aggExpr = `${func}(${fieldSqlResult.value})`;
    }
    if (agg.aggregateCast) {
      if (!isValidCast(agg.aggregateCast)) {
        return err(
          parseErrors.queryParam(
            'select',
            `unsupported cast type: "${agg.aggregateCast}"`,
          ),
        );
      }
      aggExpr = `(${aggExpr})::${agg.aggregateCast.toLowerCase().trim()}`;
    }
    const outputName =
      agg.alias ?? (aggFields.length === 1 ? embed.alias : agg.aggregateFunction!);
    const subquery = `(SELECT ${aggExpr} ${fromClause}${whereStr})`;
    colExprs.push(`${subquery} AS ${escapeIdent(outputName)}`);
  }

  return ok({ column: colExprs.join(', '), join: '' });
}

// ----- Inner child SELECT ----------------------------------------------

function renderChildSelect(
  parent: QualifiedIdentifier,
  embed: EmbedNode,
  counter: AliasCounter,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  const child = embed.child;
  const childQi = child.target;

  // BUG FIX (#CC5): reject mixed aggregate / non-aggregate child
  // selects. The child subquery path has no GROUP BY or HAVING
  // rendering, so `rel(category,count())` would build
  // `SELECT category, COUNT(*) FROM rel ...` — invalid SQL. The
  // planner already splits pure-aggregate children into the
  // correlated-subquery path (`isAggregate`); what is left here is
  // either all-plain or mixed. Reject the mixed case up front.
  const childHasAggregate = child.select.some(
    (s) => s.type === 'field' && s.aggregateFunction !== undefined,
  );
  const childHasPlain = child.select.some(
    (s) => s.type === 'field' && s.aggregateFunction === undefined,
  );
  if (childHasAggregate && childHasPlain) {
    return err(
      parseErrors.notImplemented(
        `mixed aggregate and plain columns in embed "${embed.alias}" are not supported`,
      ),
    );
  }
  // A pure-aggregate child that somehow reached this branch (instead
  // of renderAggregateEmbed) is a planner invariant break.
  if (childHasAggregate) {
    return err(
      parseErrors.notImplemented(
        `aggregate child embed "${embed.alias}" must be routed through the scalar subquery path`,
      ),
    );
  }

  // BUG FIX (#CC4): `renderSelectProjection` falls back to
  // `child.*` when `child.select` is empty — which happens for an
  // embed-only inline select like `authors(books(id))` where the
  // child select is just the nested embed. That silently projected
  // every column of the parent embed. Build the projection ourselves
  // so that an embed-only child emits only the nested embed columns.
  const nestedResult = renderEmbeds(childQi, child.embeds, counter, builder);
  if (!nestedResult.ok) return nestedResult;

  let projectionSql: string;
  if (child.select.length === 0) {
    if (nestedResult.value.columns.length > 0) {
      // Embed-only child: project ONLY the nested embed columns.
      projectionSql = nestedResult.value.columns.join(', ');
    } else {
      // No explicit select and no nested embeds — implicit `*`.
      projectionSql = `${qualifiedIdentifierToSql(childQi)}.*`;
    }
  } else {
    const projectionResult = renderSelectProjection(childQi, child.select, builder);
    if (!projectionResult.ok) return projectionResult;
    projectionSql = projectionResult.value;
    if (nestedResult.value.columns.length > 0) {
      projectionSql += ', ' + nestedResult.value.columns.join(', ');
    }
  }

  // Join condition (relationship-driven).
  const joinConditionResult = renderJoinCondition(
    parent,
    childQi,
    embed.relationship.cardinality,
  );
  if (!joinConditionResult.ok) return joinConditionResult;
  const joinCondition = joinConditionResult.value;

  // Filters + logic for the child subtree.
  const filterParts: string[] = [];
  for (const f of child.filters) {
    const rendered = renderFilter(childQi, f, builder);
    if (!rendered.ok) return rendered;
    filterParts.push(rendered.value);
  }
  for (const t of child.logic) {
    const rendered = renderLogicTree(childQi, t, builder);
    if (!rendered.ok) return rendered;
    filterParts.push(rendered.value);
  }

  const allConditions = [joinCondition, ...filterParts].filter((p) => p !== '');
  const whereStr =
    allConditions.length > 0 ? ` WHERE ${allConditions.join(' AND ')}` : '';

  // Child ORDER / LIMIT — child order terms always target the child
  // directly (they were stripped of their leading path segments at
  // planning time).
  //
  // BUG FIX (#HH8): pass the nested embeds' alias map so a nested
  // related order (`?embed.order=nested(col).asc`) resolves to the
  // nested LATERAL alias instead of bouncing off a generic "related
  // order not supported in this context" error. The planner has
  // already validated that `nested` is a to-one embed rooted inside
  // this child.
  const orderResult = renderChildOrder(
    child,
    childQi,
    builder,
    nestedResult.value.embedAliases,
  );
  if (!orderResult.ok) return orderResult;
  const orderStr = orderResult.value;

  const limitStr = renderLimitOffset(child.range.offset, child.range.limit);

  const fromClause = `FROM ${qualifiedIdentifierToSql(childQi)}`;
  const nestedJoinSuffix =
    nestedResult.value.joins.length > 0 ? ' ' + nestedResult.value.joins.join(' ') : '';

  const sql =
    `SELECT ${projectionSql} ${fromClause}${nestedJoinSuffix}` +
    `${whereStr}${orderStr ? ' ' + orderStr : ''}${limitStr ? ' ' + limitStr : ''}`;
  return ok(sql.trim());
}

function renderChildOrder(
  child: ReadPlanSubtree,
  childQi: QualifiedIdentifier,
  builder: SqlBuilder,
  nestedEmbedAliases: ReadonlyMap<string, string>,
): Result<string, CloudRestError> {
  if (child.order.length === 0) return ok('');
  return renderOrderClause(childQi, child.order, builder, nestedEmbedAliases);
}

// ----- Join conditions -------------------------------------------------

function renderJoinCondition(
  parent: QualifiedIdentifier,
  child: QualifiedIdentifier,
  card: Cardinality,
): Result<string, CloudRestError> {
  // BUG FIX (#CC1): M2M used to return an empty string, which was
  // later filtered out — a parent's embed on a many-to-many
  // relationship would silently emit an uncorrelated child subquery
  // that pulled every child row for every parent. That is a
  // severe correctness bug. Surface an explicit "not implemented"
  // error until the junction-table join path is actually wired.
  if (card.type === 'M2M') {
    return err(
      parseErrors.notImplemented(
        `many-to-many embed on "${child.name}" is not yet supported — use a spread embed or an explicit junction-table query`,
      ),
    );
  }
  const parentSql = qualifiedIdentifierToSql(parent);
  const childSql = qualifiedIdentifierToSql(child);
  const conditions = card.columns.map(
    ([parentCol, childCol]) =>
      `${childSql}.${escapeIdent(childCol)} = ${parentSql}.${escapeIdent(parentCol)}`,
  );
  return ok(conditions.join(' AND '));
}
