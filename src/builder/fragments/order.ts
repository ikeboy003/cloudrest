// Order clause and limit/offset rendering.

import type { CloudRestError } from '../../core/errors';
import { ok, type Result } from '../../core/result';
import type { QualifiedIdentifier } from '../../http/request';
import type { OrderTerm } from '../../parser/types/order';
import type { SqlBuilder } from '../sql';
import { renderField } from './field';

export function renderOrderTerm(
  target: QualifiedIdentifier,
  term: OrderTerm,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  const effective: QualifiedIdentifier = term.relation
    ? { schema: target.schema, name: term.relation }
    : target;
  const fieldResult = renderField(effective, term.field, builder);
  if (!fieldResult.ok) return fieldResult;
  const dir =
    term.direction === 'desc' ? ' DESC' : term.direction === 'asc' ? ' ASC' : '';
  const nulls =
    term.nullOrder === 'nullsfirst'
      ? ' NULLS FIRST'
      : term.nullOrder === 'nullslast'
        ? ' NULLS LAST'
        : '';
  return ok(`${fieldResult.value}${dir}${nulls}`);
}

export function renderOrderClause(
  target: QualifiedIdentifier,
  terms: readonly OrderTerm[],
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  if (terms.length === 0) return ok('');
  const rendered: string[] = [];
  for (const term of terms) {
    const r = renderOrderTerm(target, term, builder);
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
