// Field rendering — column reference + optional JSON path.
//
// SECURITY: JSON string keys are bound as SqlBuilder parameters; the
// old code inlined them with single-quote escaping, which fails under
// `standard_conforming_strings=off`. Critique #11.

import { parseErrors, type CloudRestError } from '../../core/errors';
import { err, ok, type Result } from '../../core/result';
import type { QualifiedIdentifier } from '../../http/request';
import type { Field, JsonPath } from '../../parser/types/field';
import {
  qualifiedColumnToSql,
  qualifiedIdentifierToSql,
} from '../identifiers';
import type { SqlBuilder } from '../sql';

/**
 * Render a `Field` as a SQL expression. Returns the qualified column
 * reference (with `.* ` for wildcard) plus any JSON-path traversal.
 *
 * Errors only on malformed JSON array indices.
 */
export function renderField(
  target: QualifiedIdentifier,
  field: Field,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  const base =
    field.name === '*'
      ? qualifiedIdentifierToSql(target) + '.*'
      : qualifiedColumnToSql(target, field.name);

  if (field.jsonPath.length === 0) return ok(base);
  return renderJsonPath(base, field.jsonPath, builder);
}

function renderJsonPath(
  base: string,
  path: JsonPath,
  builder: SqlBuilder,
): Result<string, CloudRestError> {
  let sql = base;
  for (const op of path) {
    const arrow = op.type === 'arrow' ? '->' : '->>';
    if (op.operand.type === 'idx') {
      const parsed = Number(op.operand.value);
      if (
        !Number.isInteger(parsed) ||
        String(parsed) !== op.operand.value.replace(/^\+/, '')
      ) {
        return err(
          parseErrors.queryParam(
            'jsonPath',
            `invalid JSON array index: "${op.operand.value}"`,
          ),
        );
      }
      sql += `${arrow}${parsed}`;
      continue;
    }
    // SECURITY: bind the key as a parameter. Critique #11.
    sql += `${arrow}${builder.addParam(op.operand.value)}`;
  }
  return ok(sql);
}
