// HAVING clause rendering.
//
// BUG FIX (#BB1, #BB2, #BB3): the old HAVING renderer had its own
// hand-rolled op-type switch with a `default: return ok('')` fallthrough
// that silently dropped isDistinctFrom / fts / geo ops — the filter
// disappeared and the query became broader than requested. It also
// ignored the `(any)` / `(all)` quantifier on opQuant, and skipped the
// `*` → `%` wildcard rewrite that plain like/ilike filters apply.
//
// The rewrite delegates to the shared `renderOpExprOnExpr` helper in
// filter.ts, so HAVING and WHERE use exactly the same op coverage and
// cannot drift.

import { parseErrors, type CloudRestError } from '@/core/errors';
import { err, ok, type Result } from '@/core/result';
import type { QualifiedIdentifier } from '@/http/request';
import type { HavingClause } from '@/parser/types/having';
import type { SqlBuilder } from '@/builder/sql';
import { renderField } from './field';
import { renderOpExprOnExpr } from './filter';

export function renderHaving(
  target: QualifiedIdentifier,
  having: readonly HavingClause[],
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  if (having.length === 0) return ok('');

  const parts: string[] = [];
  for (const clause of having) {
    let aggExpr: string;
    if (clause.aggregate === 'count') {
      if (!clause.field) {
        aggExpr = 'COUNT(*)';
      } else {
        // BUG FIX (#BB4/#BB5): parser already rejects `count(*).op.val`
        // (only the no-arg `count()` form produces `field: undefined`),
        // but belt-and-braces: never let a `*` field name slip into
        // `COUNT(table.*)` rendering.
        if (clause.field.name === '*') {
          return err(
            parseErrors.queryParam(
              'having',
              'wildcard "*" is only valid as the argument to count()',
            ),
          );
        }
        const rendered = renderField(target, clause.field, builder);
        if (!rendered.ok) return rendered;
        aggExpr = `COUNT(${rendered.value})`;
      }
    } else {
      if (!clause.field) {
        // Parser enforces that sum/avg/max/min require a column, so
        // this branch is defensive. Surface the violation instead of
        // silently skipping the clause.
        return err(
          parseErrors.queryParam(
            'having',
            `${clause.aggregate}() requires a column argument`,
          ),
        );
      }
      if (clause.field.name === '*') {
        return err(
          parseErrors.queryParam(
            'having',
            `${clause.aggregate}(*) is not a valid aggregate`,
          ),
        );
      }
      const rendered = renderField(target, clause.field, builder);
      if (!rendered.ok) return rendered;
      aggExpr = `${clause.aggregate.toUpperCase()}(${rendered.value})`;
    }
    const rendered = renderOpExprOnExpr(aggExpr, clause.opExpr, builder);
    if (!rendered.ok) return rendered;
    parts.push(rendered.value);
  }

  return ok(parts.length > 0 ? `HAVING ${parts.join(' AND ')}` : '');
}
