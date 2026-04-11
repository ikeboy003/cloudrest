// Select projection and GROUP BY rendering.
//
// Only field items are projected; embed items are handled by the embed
// builder (stage 6) and do not appear in the top-level projection.

import { parseErrors, type CloudRestError } from '../../core/errors';
import { err, ok, type Result } from '../../core/result';
import type { QualifiedIdentifier } from '../../http/request';
import type { SelectItem } from '../../parser/types/select';
import { escapeIdent, qualifiedIdentifierToSql } from '../identifiers';
import type { SqlBuilder } from '../sql';
import { renderField } from './field';
import { isValidCast } from './operators';

type FieldItem = Extract<SelectItem, { type: 'field' }>;

/**
 * Render the list of projected columns. Empty select or
 * embed-only select falls back to `"schema"."table".*`.
 *
 * SECURITY: cast types go through `isValidCast`; unknown casts return
 * PGRST100 instead of reaching SQL.
 */
export function renderSelectProjection(
  target: QualifiedIdentifier,
  select: readonly SelectItem[],
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  if (select.length === 0) return ok(qualifiedIdentifierToSql(target) + '.*');

  const fieldItems = select.filter(
    (s): s is FieldItem => s.type === 'field',
  );
  if (fieldItems.length === 0) return ok(qualifiedIdentifierToSql(target) + '.*');

  const rendered: string[] = [];
  for (const item of fieldItems) {
    const renderedCol = renderFieldItem(target, item, builder);
    if (!renderedCol.ok) return renderedCol;
    rendered.push(renderedCol.value);
  }
  return ok(rendered.join(', '));
}

function renderFieldItem(
  target: QualifiedIdentifier,
  item: FieldItem,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  const fieldSqlResult = renderField(target, item.field, builder);
  if (!fieldSqlResult.ok) return fieldSqlResult;
  const fieldSql = fieldSqlResult.value;

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
 * Render `GROUP BY` for aggregate queries. When no aggregates are
 * present, returns empty (no GROUP BY). Non-aggregate columns in a
 * mixed select become the grouping set.
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
