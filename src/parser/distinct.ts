// Distinct parser — `?distinct=col1,col2`.
//
// The planner is responsible for validating the columns against the
// schema cache and producing a `ReadPlan.distinct` field.

import { err, ok, type Result } from '@/core/result';
import { parseErrors, type CloudRestError } from '@/core/errors';
import { splitTopLevel } from './tokenize';

export type DistinctColumns = readonly string[];

export function parseDistinct(raw: string): Result<DistinctColumns, CloudRestError> {
  // A stray or whitespace-only item in `distinct=a,,b` or
  // `distinct=a, ,b` is a parse error, not silently cleaned up.
  if (raw === '') {
    return err(
      parseErrors.queryParam('distinct', 'empty column list'),
    );
  }
  const partsResult = splitTopLevel(raw, ',', { context: 'distinct' });
  if (!partsResult.ok) return partsResult;
  const trimmed = partsResult.value.map((s) => s.trim());
  for (const col of trimmed) {
    if (col === '') {
      return err(
        parseErrors.queryParam('distinct', 'empty column (stray comma)'),
      );
    }
    // Entries must be plain SQL identifiers.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
      return err(
        parseErrors.queryParam('distinct', `invalid column name "${col}"`),
      );
    }
  }
  return ok(trimmed);
}
