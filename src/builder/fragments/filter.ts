// Filter / OpExpr rendering.
//
// Turns a `Filter` (field + OpExpr) into a SQL boolean expression.
// Every value flows through SqlBuilder.addParam; geo operations are
// stubbed until stage 6.

import { parseErrors, type CloudRestError } from '../../core/errors';
import { err, ok, type Result } from '../../core/result';
import type { QualifiedIdentifier } from '../../http/request';
import type { Field, Filter, OpExpr } from '../../parser/types';
import type { SqlBuilder } from '../sql';
import { renderField } from './field';
import {
  FTS_OPS,
  IS_VALUES,
  QUANT_OPS,
  SIMPLE_OPS,
  buildPgArrayLiteral,
} from './operators';

export function renderFilter(
  target: QualifiedIdentifier,
  filter: Filter,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  return renderOpExpr(target, filter.field, filter.opExpr, builder);
}

export function renderOpExpr(
  target: QualifiedIdentifier,
  field: Field,
  opExpr: OpExpr,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  const colResult = renderField(target, field, builder);
  if (!colResult.ok) return colResult;
  const col = colResult.value;
  const not = opExpr.negated ? 'NOT ' : '';
  const op = opExpr.operation;

  switch (op.type) {
    case 'op':
      return ok(
        `${not}${col} ${SIMPLE_OPS[op.operator]} ${builder.addParam(op.value)}`,
      );

    case 'opQuant': {
      const sqlOp = QUANT_OPS[op.operator];
      let boundValue = op.value;
      // like/ilike: rewrite `*` → `%` and escape `_` and `\`. The
      // transformed value still passes through addParam — not inlining.
      if (op.operator === 'like' || op.operator === 'ilike') {
        boundValue = op.value
          .replace(/\\/g, '\\\\')
          .replace(/_/g, '\\_')
          .replace(/\*/g, '%');
      }
      const param = builder.addParam(boundValue);

      if (op.quantifier === 'any') return ok(`${not}${col} ${sqlOp} ANY(${param})`);
      if (op.quantifier === 'all') return ok(`${not}${col} ${sqlOp} ALL(${param})`);
      return ok(`${not}${col} ${sqlOp} ${param}`);
    }

    case 'in': {
      if (op.values.length === 0) return ok(`${not}${col} = ANY('{}')`);
      const literal = buildPgArrayLiteral(op.values);
      return ok(`${not}${col} = ANY(${builder.addParam(literal)})`);
    }

    case 'is':
      return ok(`${not}${col} IS ${IS_VALUES[op.value]}`);

    case 'isDistinctFrom':
      return ok(`${not}${col} IS DISTINCT FROM ${builder.addParam(op.value)}`);

    case 'fts': {
      const ftsOp = FTS_OPS[op.operator];
      // SECURITY: even the language token goes through addParam. The
      // old code inlined it after an allowlist check. Critique #10.
      const langPart = op.language ? `${builder.addParam(op.language)}, ` : '';
      return ok(
        `${not}${col} ${ftsOp}(${langPart}${builder.addParam(op.value)})`,
      );
    }

    case 'geo':
      return err(
        parseErrors.notImplemented(
          'geo operations are not yet supported in the rewrite',
        ),
      );
  }
}
