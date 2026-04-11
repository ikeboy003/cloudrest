// HAVING clause rendering.

import type { CloudRestError } from '../../core/errors';
import { ok, type Result } from '../../core/result';
import type { QualifiedIdentifier } from '../../http/request';
import type { HavingClause } from '../../parser/types/having';
import type { OpExpr } from '../../parser/types/filter';
import type { SqlBuilder } from '../sql';
import { renderField } from './field';
import {
  IS_VALUES,
  QUANT_OPS,
  SIMPLE_OPS,
  buildPgArrayLiteral,
} from './operators';

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
        const rendered = renderField(target, clause.field, builder);
        if (!rendered.ok) return rendered;
        aggExpr = `COUNT(${rendered.value})`;
      }
    } else {
      if (!clause.field) continue; // sum/avg/max/min require a column (enforced at parse)
      const rendered = renderField(target, clause.field, builder);
      if (!rendered.ok) return rendered;
      aggExpr = `${clause.aggregate.toUpperCase()}(${rendered.value})`;
    }
    const rendered = renderHavingOp(aggExpr, clause.opExpr, builder);
    if (!rendered.ok) return rendered;
    if (rendered.value) parts.push(rendered.value);
  }

  return ok(parts.length > 0 ? `HAVING ${parts.join(' AND ')}` : '');
}

function renderHavingOp(
  aggExpr: string,
  opExpr: OpExpr,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  const not = opExpr.negated ? 'NOT ' : '';
  const op = opExpr.operation;

  switch (op.type) {
    case 'opQuant':
      return ok(
        `${not}${aggExpr} ${QUANT_OPS[op.operator]} ${builder.addParam(op.value)}`,
      );
    case 'op':
      return ok(
        `${not}${aggExpr} ${SIMPLE_OPS[op.operator]} ${builder.addParam(op.value)}`,
      );
    case 'in': {
      if (op.values.length === 0) return ok(`${not}${aggExpr} = ANY('{}')`);
      return ok(
        `${not}${aggExpr} = ANY(${builder.addParam(buildPgArrayLiteral(op.values))})`,
      );
    }
    case 'is':
      return ok(`${not}${aggExpr} IS ${IS_VALUES[op.value]}`);
    default:
      return ok('');
  }
}
