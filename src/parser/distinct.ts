// Distinct parser — `?distinct=col1,col2`.
//
// Stage 4 parses the value into a typed `DistinctColumns`. The planner
// (stage 6) is responsible for validating the columns against the schema
// cache and producing a `ReadPlan.distinct` field — this is a critique
// fix for IDENTIFIER-5 (distinct columns were not schema-validated).

import { err, ok, type Result } from '../core/result';
import { parseErrors, type CloudRestError } from '../core/errors';
import { splitTopLevel } from './tokenize';

export type DistinctColumns = readonly string[];

export function parseDistinct(raw: string): Result<DistinctColumns, CloudRestError> {
  // BUG FIX (#M/#P): a stray or whitespace-only item in `distinct=a,,b`
  // or `distinct=a, ,b` used to be silently cleaned up. Check each
  // trimmed entry from the quote-aware split.
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
  }
  return ok(trimmed);
}
