// Filter / OpExpr rendering.
//
// Turns a `Filter` (field + OpExpr) into a SQL boolean expression.
// Every value flows through SqlBuilder.addParam.

import { parseErrors, type CloudRestError } from '@/core/errors';
import { err, ok, type Result } from '@/core/result';
import type { QualifiedIdentifier } from '@/http/request';
import type { Field, Filter, OpExpr } from '@/parser/types';
import type { SqlBuilder } from '@/builder/sql';
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
  // BUG FIX (#BB4/#BB5): a Field with name `*` should never reach this
  // code path. `renderField` happily emits `"schema"."table".*`, which
  // produces invalid SQL in a filter context (`table.* = $1`) and in a
  // JSON-path context (`table.*->$1`). Reject the shape here so the
  // builder fails loudly instead of emitting broken SQL.
  if (field.name === '*') {
    return err(
      parseErrors.queryParam(
        'filter',
        'wildcard "*" is not a column reference; cannot be filtered on',
      ),
    );
  }
  const colResult = renderField(target, field, builder);
  if (!colResult.ok) return colResult;
  return renderOpExprOnExpr(colResult.value, opExpr, builder);
}

/**
 * Render an OpExpr against a pre-rendered column/aggregate expression.
 *
 * Shared by `renderOpExpr` (plain filters) and `renderHaving` so that
 * HAVING clauses do not re-implement the op-type switch and therefore
 * cannot silently drop op types they did not explicitly handle.
 *
 * BUG FIX (#BB1): the old HAVING renderer had its own opaque switch
 * with a `default: return ok('')` fallthrough, which dropped
 * isDistinctFrom / fts / geo ops entirely and broadened the query.
 */
export function renderOpExprOnExpr(
  col: string,
  opExpr: OpExpr,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
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
      // like/ilike: rewrite `*` → `%` (the user-facing wildcard) and
      // escape every SQL LIKE metacharacter so that untransformed
      // user input cannot become a wildcard by accident.
      //
      // BUG FIX (#BB16): the old escape missed `%`, so `ilike.%`
      // matched every row. Escape `%` first, then the other
      // metacharacters, then rewrite `*` → `%`.
      if (op.operator === 'like' || op.operator === 'ilike') {
        boundValue = op.value
          .replace(/\\/g, '\\\\')
          .replace(/%/g, '\\%')
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
      // BUG FIX (#BB17): geo support is explicitly out of scope for
      // this builder pass. The parser accepts `geo.within(...)`,
      // `geo.dwithin(...)`, etc., but rendering them correctly needs
      // PostGIS function emission (`ST_DWithin`, `ST_GeomFromGeoJSON`,
      // `ST_GeomFromText`) plus its own test harness. Keeping the
      // error EXPLICIT ensures a filter containing geo ops never
      // silently drops — the request fails with PGRST127 instead of
      // returning a broader, unintended result set.
      return err(
        parseErrors.notImplemented(
          'geo operations are not yet implemented in the rewrite builder; use ST_* directly via RPC for now',
        ),
      );
  }
}
