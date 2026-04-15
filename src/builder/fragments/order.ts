// Order clause and limit/offset rendering.

import { parseErrors, type CloudRestError } from '@/core/errors';
import { err, ok, type Result } from '@/core/result';
import type { QualifiedIdentifier } from '@/http/request';
import type { OrderTerm } from '@/parser/types/order';
import { escapeIdent } from '@/builder/identifiers';
import type { SqlBuilder } from '@/builder/sql';
import { renderField } from './field';

/**
 * Optional map from the user-visible embed alias (e.g. `authors`) to
 * the internal LATERAL alias (`pgrst_1`) for every to-one embed on
 * the current query. Used to resolve `?order=embed(col).asc` into a
 * reference the SQL engine can actually see.
 *
 * Without this map, related ORDER BY terms would render as
 * `"schema"."rel"."col"` even though the embed is only reachable
 * through a LATERAL join alias. Postgres would reject the query with
 * "missing FROM-clause entry".
 */
export type EmbedAliasMap = ReadonlyMap<string, string>;

export function renderOrderTerm(
  target: QualifiedIdentifier,
  term: OrderTerm,
  builder: SqlBuilder,
  embedAliases?: EmbedAliasMap,
): Result<string, CloudRestError> {
  // The wildcard `*` is not a legal ORDER BY target. `renderField`
  // would happily emit `"schema"."table".*` which is not valid SQL
  // in an ORDER BY. Defensive guard so a malformed plan cannot reach
  // the driver.
  if (term.field.name === '*') {
    return err(
      parseErrors.queryParam(
        'order',
        'cannot order by wildcard "*"',
      ),
    );
  }
  if (term.geoDistance !== undefined) {
    const fieldResult = renderField(target, term.field, builder);
    if (!fieldResult.ok) return fieldResult;
    const lngParam = builder.addParam(term.geoDistance.lng);
    const latParam = builder.addParam(term.geoDistance.lat);
    const fieldSql =
      `ST_Distance(${fieldResult.value}::geography, ` +
      `ST_SetSRID(ST_MakePoint(${lngParam}, ${latParam}), 4326)::geography)`;
    const dir =
      term.direction === 'desc' ? ' DESC' : term.direction === 'asc' ? ' ASC' : '';
    const nulls =
      term.nullOrder === 'nullsfirst'
        ? ' NULLS FIRST'
        : term.nullOrder === 'nullslast'
          ? ' NULLS LAST'
          : '';
    return ok(`${fieldSql}${dir}${nulls}`);
  }
  let fieldSql: string;
  if (term.relation) {
    // A related order term must reference the LATERAL alias that the
    // embed was bound to, not a fake `{schema, name: relation}`
    // qualified table. If the alias map is missing (caller is inside
    // a child subquery with no embed context), refuse rather than
    // emit invalid SQL.
    if (!embedAliases) {
      return err(
        parseErrors.queryParam(
          'order',
          `related ORDER BY "${term.relation}" is not supported in this context`,
        ),
      );
    }
    const lateralAlias = embedAliases.get(term.relation);
    if (!lateralAlias) {
      return err(
        parseErrors.queryParam(
          'order',
          `ORDER BY refers to "${term.relation}" which is not an embedded relation on this request`,
        ),
      );
    }
    if (term.field.jsonPath.length > 0) {
      // JSON-path ordering on a lateral alias is still meaningful —
      // but we need the jsonb/text operand walker from renderField.
      // Delegate by treating the lateral alias as a pseudo-table
      // name and letting renderField compose the arrows.
      const pseudo: QualifiedIdentifier = { schema: '', name: lateralAlias };
      const fieldResult = renderField(pseudo, term.field, builder);
      if (!fieldResult.ok) return fieldResult;
      fieldSql = fieldResult.value;
    } else {
      fieldSql = `${escapeIdent(lateralAlias)}.${escapeIdent(term.field.name)}`;
    }
  } else {
    const fieldResult = renderField(target, term.field, builder);
    if (!fieldResult.ok) return fieldResult;
    fieldSql = fieldResult.value;
  }
  const dir =
    term.direction === 'desc' ? ' DESC' : term.direction === 'asc' ? ' ASC' : '';
  const nulls =
    term.nullOrder === 'nullsfirst'
      ? ' NULLS FIRST'
      : term.nullOrder === 'nullslast'
        ? ' NULLS LAST'
        : '';
  return ok(`${fieldSql}${dir}${nulls}`);
}

export function renderOrderClause(
  target: QualifiedIdentifier,
  terms: readonly OrderTerm[],
  builder: SqlBuilder,
  embedAliases?: EmbedAliasMap,
): Result<string, CloudRestError> {
  if (terms.length === 0) return ok('');
  const rendered: string[] = [];
  for (const term of terms) {
    const r = renderOrderTerm(target, term, builder, embedAliases);
    if (!r.ok) return r;
    rendered.push(r.value);
  }
  return ok('ORDER BY ' + rendered.join(', '));
}

/**
 * Render `LIMIT` / `OFFSET` clauses. Both are inlined as integers —
 * these never come from user strings directly, they come from
 * `strictParseInt` in the parser and have been validated.
 */
export function renderLimitOffset(offset: number, limit: number | null): string {
  const parts: string[] = [];
  if (limit !== null) parts.push(`LIMIT ${limit}`);
  if (offset > 0) parts.push(`OFFSET ${offset}`);
  return parts.join(' ');
}
