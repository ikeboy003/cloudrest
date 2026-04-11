// Select projection and GROUP BY rendering.
//
// Only field items are projected; embed items are handled by the embed
// builder (stage 6) and do not appear in the top-level projection.

import { parseErrors, type CloudRestError } from '@/core/errors';
import { err, ok, type Result } from '@/core/result';
import type { QualifiedIdentifier } from '@/http/request';
import type { SelectItem } from '@/parser/types/select';
import { escapeIdent, qualifiedColumnToSql } from '@/builder/identifiers';
import type { SqlBuilder } from '@/builder/sql';
import { renderField } from './field';
import { isValidCast } from './operators';

type FieldItem = Extract<SelectItem, { type: 'field' }>;

/**
 * Summary of a rendered select projection. `projectionSql` is the
 * comma-joined column list; `groupByFieldSqls` is the list of raw
 * field expressions (no cast / alias wrapping) corresponding to the
 * non-aggregate, non-wildcard items in source order. GROUP BY reuses
 * those expressions directly so it never rebinds JSON-path keys as
 * fresh parameters.
 *
 * BUG FIX (#BB6): the old `renderGroupBy` called `renderField` a
 * second time, which allocated a new `$N` for every JSON-path key in
 * the grouping set. Postgres treats `$1` and `$2` as distinct
 * expressions even when both bind the same string, so the GROUP BY
 * entry did not match the projection — the query could fail with
 * "column must appear in the GROUP BY clause" despite looking
 * equivalent on the page.
 *
 * BUG FIX (#BB7): the old projection emitted `table.*` for wildcard
 * items in an aggregate select (`select=*,count()`), producing
 * `SELECT "t".*, COUNT(*) FROM t` with no GROUP BY — invalid SQL.
 * The rewrite detects the mixed wildcard + aggregate shape and
 * surfaces a PGRST100 instead.
 */
export interface RenderedProjection {
  readonly projectionSql: string;
  readonly groupByFieldSqls: readonly string[];
  /**
   * The root column names that appear in the non-aggregate grouping
   * set, in the same order as `groupByFieldSqls`. Used by
   * `buildReadQuery` to check that ORDER BY / DISTINCT ON terms on
   * an aggregate query reference a grouped column (bug #FF2).
   * Items with a JSON path are excluded because their grouping key
   * is a compound expression, not a bare name.
   */
  readonly groupByFieldNames: readonly string[];
  readonly hasAggregates: boolean;
}

/**
 * Render the list of projected columns as a SQL string. Empty
 * select or embed-only select falls back to `"schema"."table".*`.
 *
 * This is the legacy shape used by fragment tests. `buildReadQuery`
 * uses `renderSelectProjectionAndGrouping` instead so GROUP BY can
 * reuse the same rendered field expressions without re-binding
 * JSON-path keys as fresh parameters (bug #BB6).
 */
export function renderSelectProjection(
  target: QualifiedIdentifier,
  select: readonly SelectItem[],
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  const res = renderSelectProjectionAndGrouping(target, select, builder);
  if (!res.ok) return res;
  return ok(res.value.projectionSql);
}

/**
 * Render the projected columns AND track which field expressions
 * should reappear in GROUP BY. Used by the read builder; returns
 * both the projection SQL and the pre-rendered field expressions
 * for non-aggregate, non-wildcard items.
 *
 * SECURITY: cast types go through `isValidCast`; unknown casts return
 * PGRST100 instead of reaching SQL.
 */
export function renderSelectProjectionAndGrouping(
  target: QualifiedIdentifier,
  select: readonly SelectItem[],
  builder: SqlBuilder,
): Result<RenderedProjection, CloudRestError> {
  if (select.length === 0) {
    return ok({
      projectionSql: qualifiedColumnToSql(target, '*'),
      groupByFieldSqls: [],
      groupByFieldNames: [],
      hasAggregates: false,
    });
  }

  const fieldItems = select.filter(
    (s): s is FieldItem => s.type === 'field',
  );
  if (fieldItems.length === 0) {
    return ok({
      projectionSql: qualifiedColumnToSql(target, '*'),
      groupByFieldSqls: [],
      groupByFieldNames: [],
      hasAggregates: false,
    });
  }

  const hasAggregates = fieldItems.some((s) => s.aggregateFunction);
  const hasWildcard = fieldItems.some(
    (s) => !s.aggregateFunction && s.field.name === '*',
  );
  // BUG FIX (#BB7): `select=*,count()` would render `table.*, COUNT(*)`
  // with no way to emit a correct GROUP BY (every non-aggregate
  // column on the table would need to appear, and the parser has no
  // schema access). Reject the combination up front.
  if (hasAggregates && hasWildcard) {
    return err(
      parseErrors.queryParam(
        'select',
        'wildcard "*" cannot be mixed with aggregate functions in the same select',
      ),
    );
  }

  const rendered: string[] = [];
  const groupByFieldSqls: string[] = [];
  const groupByFieldNames: string[] = [];
  for (const item of fieldItems) {
    const fieldSqlResult = renderField(target, item.field, builder);
    if (!fieldSqlResult.ok) return fieldSqlResult;
    const fieldSql = fieldSqlResult.value;

    const renderedCol = renderFieldItemFromFieldSql(item, fieldSql);
    if (!renderedCol.ok) return renderedCol;
    rendered.push(renderedCol.value);

    // Track the raw (no-cast, no-alias) field expression for GROUP
    // BY. Aggregates and wildcards are skipped — the former are not
    // grouped, the latter were already rejected above.
    if (!item.aggregateFunction && item.field.name !== '*') {
      groupByFieldSqls.push(fieldSql);
      // BUG FIX (#FF2): track the bare column name alongside the
      // rendered SQL so `buildReadQuery` can check whether an ORDER
      // BY / DISTINCT ON term references a grouped column. Items
      // with a JSON path are NOT added because their grouping key
      // is a compound expression, not a name the caller can match
      // against `term.field.name`.
      if (item.field.jsonPath.length === 0) {
        groupByFieldNames.push(item.field.name);
      }
    }
  }
  return ok({
    projectionSql: rendered.join(', '),
    groupByFieldSqls,
    groupByFieldNames,
    hasAggregates,
  });
}

function renderFieldItemFromFieldSql(
  item: FieldItem,
  fieldSql: string,
): Result<string, CloudRestError> {
  if (item.aggregateFunction) {
    let col: string;
    if (item.aggregateFunction === 'count') {
      col = item.field.name === '*' ? 'COUNT(*)' : `COUNT(${fieldSql})`;
    } else {
      col = `${item.aggregateFunction.toUpperCase()}(${fieldSql})`;
    }
    if (item.aggregateCast) {
      if (!isValidCast(item.aggregateCast)) {
        return err(
          parseErrors.queryParam(
            'select',
            `unsupported cast type: "${item.aggregateCast}"`,
          ),
        );
      }
      col = `(${col})::${item.aggregateCast.toLowerCase().trim()}`;
    }
    const alias = item.alias ?? item.aggregateFunction;
    return ok(col + ` AS ${escapeIdent(alias)}`);
  }

  let col = fieldSql;
  if (item.cast) {
    if (!isValidCast(item.cast)) {
      return err(
        parseErrors.queryParam('select', `unsupported cast type: "${item.cast}"`),
      );
    }
    col = `CAST(${col} AS ${item.cast.toLowerCase().trim()})`;
  }
  if (item.alias) col += ` AS ${escapeIdent(item.alias)}`;
  return ok(col);
}

/**
 * Render `GROUP BY` from a SelectItem list. Used by fragment tests.
 *
 * `buildReadQuery` uses `renderGroupByFromProjection` instead so the
 * GROUP BY expressions are byte-identical to the projection ones
 * (bug #BB6 — re-rendering would rebind JSON-path keys as fresh
 * parameters and the query could fail with "column must appear in
 * the GROUP BY clause").
 */
export function renderGroupBy(
  target: QualifiedIdentifier,
  select: readonly SelectItem[],
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  const fieldItems = select.filter(
    (s): s is FieldItem => s.type === 'field',
  );
  const hasAggregates = fieldItems.some((s) => s.aggregateFunction);
  if (!hasAggregates) return ok('');

  const groupCols: string[] = [];
  for (const item of fieldItems) {
    if (item.aggregateFunction || item.field.name === '*') continue;
    const rendered = renderField(target, item.field, builder);
    if (!rendered.ok) return rendered;
    groupCols.push(rendered.value);
  }
  return ok(groupCols.length > 0 ? `GROUP BY ${groupCols.join(', ')}` : '');
}

/**
 * Render `GROUP BY` from the pre-rendered field expressions captured
 * during the projection pass. Used by `buildReadQuery`.
 */
export function renderGroupByFromProjection(
  projection: RenderedProjection,
): string {
  if (!projection.hasAggregates) return '';
  if (projection.groupByFieldSqls.length === 0) return '';
  return `GROUP BY ${projection.groupByFieldSqls.join(', ')}`;
}
