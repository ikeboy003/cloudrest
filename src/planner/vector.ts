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

import { err, ok, type Result } from '@/core/result';
import {
  fuzzyFind,
  parseErrors,
  schemaErrors,
  type CloudRestError,
} from '@/core/errors';
import type { Table } from '@/schema/table';
import { findColumn } from '@/schema/table';
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
  const columnMeta = findColumn(table, column);
  if (!columnMeta) {
    return err(
      schemaErrors.columnNotFound(
        column,
        `${table.schema}.${table.name}`,
        fuzzyFind(column, [...table.columns.keys()]),
      ),
    );
  }
  // BUG FIX (#EE6): the old planner only checked that the column
  // exists. `?vector.column=title` pointed at a text column would
  // pass planning and then fail at the DB with "operator does not
  // exist: text <-> text". The pgvector column type is `vector`
  // (or `halfvec`/`sparsevec` for the newer variants); match any
  // of those and reject everything else here.
  if (!isVectorColumnType(columnMeta.type)) {
    return err(
      parseErrors.queryParam(
        'vector.column',
        `column "${column}" is of type "${columnMeta.type}" — vector search requires a pgvector column (vector, halfvec, or sparsevec)`,
      ),
    );
  }

  // BUG FIX (#HH12): also check the literal length against the
  // declared dimension (e.g. `vector(1536)`) when it is known.
  // Wrong-dimension requests used to reach Postgres and fail with
  // a confusing `expected N dimensions, not M` error. Pulling the
  // dimension from `nominalType` catches the mismatch at plan
  // time; columns that do not carry a declared dimension
  // (`vector` with no modifier) skip the check — the DB will
  // accept anything in that case anyway.
  const declaredDim = extractVectorDimension(columnMeta.nominalType);
  if (declaredDim !== null && declaredDim !== parsed.value.length) {
    return err(
      parseErrors.queryParam(
        'vector',
        `vector dimension mismatch: column "${column}" is ${columnMeta.nominalType} (${declaredDim} dimensions), query vector has ${parsed.value.length}`,
      ),
    );
  }

  return ok({
    queryVector: parsed.value,
    column,
    op: op as VectorOp,
  });
}

/**
 * Parse the declared dimension out of a pgvector column's
 * `nominalType` string — `vector(1536)` / `halfvec(768)` /
 * `sparsevec(10000)`. Returns `null` for the dimensionless forms
 * (`vector` with no modifier) because the DB treats those as
 * "any dimension accepted".
 */
function extractVectorDimension(nominalType: string): number | null {
  const match = nominalType.match(
    /^(?:vector|halfvec|sparsevec)\((\d+)\)$/i,
  );
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const VECTOR_COLUMN_TYPES: ReadonlySet<string> = new Set([
  'vector',
  'halfvec',
  'sparsevec',
]);

function isVectorColumnType(type: string): boolean {
  // `type` is the resolved base type (e.g. `vector`). Accept any
  // of the pgvector column types. The comparison is case-sensitive
  // because Postgres returns lowercase type names from pg_type.
  return VECTOR_COLUMN_TYPES.has(type);
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
