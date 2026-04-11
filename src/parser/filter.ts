// Filter parser — turns a key=value URL pair into an EmbedPath + Filter.
//
// `?posts.comments.id=eq.1` parses as:
//   path:   ['posts', 'comments']
//   filter: { field: { name: 'id' }, opExpr: { negated: false, op: eq '1' } }

import { ok, type Result } from '../core/result';
import type { CloudRestError } from '../core/errors';
import { parseField } from './json-path';
import { parseOpExpr } from './operators';
import type { EmbedPath } from './types/embed';
import type { Filter } from './types/filter';

export interface FilterWithPath {
  readonly path: EmbedPath;
  readonly filter: Filter;
}

/**
 * Parse a query-param key+value as a filter. Returns:
 *   - Ok(FilterWithPath) for a valid filter
 *   - Err(CloudRestError) for a malformed filter
 *   - Ok(null) when the value is not a filter at all — the caller treats
 *     such pairs as RPC params
 */
export function parseFilter(
  key: string,
  value: string,
): Result<FilterWithPath | null, CloudRestError> {
  const parts = key.split('.');

  const opResult = parseOpExpr(value);
  if (!opResult.ok) return opResult;
  if (opResult.value === null) return ok(null);

  const fieldName = parts[parts.length - 1]!;
  const path = parts.slice(0, -1);

  return ok({
    path,
    filter: {
      field: parseField(fieldName),
      opExpr: opResult.value,
    },
  });
}
