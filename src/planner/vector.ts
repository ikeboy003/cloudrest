// Vector-similarity planner — parses `?vector=`, `?vector.column=`,
// and `?vector.op=` into a typed `VectorPlan`.
//
// INVARIANT (CONSTITUTION §1.5): column existence is validated against
// the schema here. The rewrite refuses to emit SQL against a missing
// column; the old code would surface the error from Postgres after a
// round trip.
//
// INVARIANT (#77, #78): the query vector is threaded through the plan
// as a plain array. It reaches SQL only via SqlBuilder.addParam in the
// builder. The planner never stringifies it.

import { err, ok, type Result } from '../core/result';
import {
  fuzzyFind,
  parseErrors,
  schemaErrors,
  type CloudRestError,
} from '../core/errors';
import type { Table } from '../schema/table';
import { findColumn } from '../schema/table';
import type { VectorOp, VectorPlan } from './read-plan';

const VECTOR_OPS: readonly VectorOp[] = ['l2', 'cosine', 'inner_product', 'l1'];
const VECTOR_OP_SET: ReadonlySet<string> = new Set(VECTOR_OPS);

export interface RawVectorParams {
  readonly value: string;
  readonly column: string | null;
  readonly op: string | null;
}

/**
 * Plan a vector-similarity clause against a concrete table.
 *
 * Returns `null` (wrapped in ok) when no `?vector=` param is present.
 *
 * The raw value shape is a JSON number array (`[0.1, 0.2, ...]`); the
 * parser already stored it as a string so the planner owns validation.
 */
export function planVector(
  params: RawVectorParams | null,
  table: Table,
): Result<VectorPlan | null, CloudRestError> {
  if (params === null) return ok(null);

  const parsed = decodeVectorLiteral(params.value);
  if (!parsed.ok) return parsed;

  const op = params.op ?? 'l2';
  if (!VECTOR_OP_SET.has(op)) {
    return err(
      parseErrors.queryParam(
        'vector.op',
        `unknown vector operator: "${op}" (expected one of ${VECTOR_OPS.join(', ')})`,
      ),
    );
  }

  const column = params.column ?? 'embedding';
  if (!findColumn(table, column)) {
    return err(
      schemaErrors.columnNotFound(
        column,
        `${table.schema}.${table.name}`,
        fuzzyFind(column, [...table.columns.keys()]),
      ),
    );
  }

  return ok({
    queryVector: parsed.value,
    column,
    op: op as VectorOp,
  });
}

function decodeVectorLiteral(
  raw: string,
): Result<readonly number[], CloudRestError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return err(
      parseErrors.queryParam('vector', `vector value is not valid JSON`),
    );
  }
  if (!Array.isArray(decoded)) {
    return err(
      parseErrors.queryParam('vector', `vector must be a JSON number array`),
    );
  }
  const out: number[] = [];
  for (const entry of decoded) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return err(
        parseErrors.queryParam(
          'vector',
          `vector must contain only finite numbers`,
        ),
      );
    }
    out.push(entry);
  }
  if (out.length === 0) {
    return err(parseErrors.queryParam('vector', `vector must not be empty`));
  }
  return ok(out);
}
