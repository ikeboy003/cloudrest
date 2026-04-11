// Filter parser — turns a key=value URL pair into an EmbedPath + Filter.
//
// `?posts.comments.id=eq.1` parses as:
//   path:   ['posts', 'comments']
//   filter: { field: { name: 'id' }, opExpr: { negated: false, op: eq '1' } }
//
// BUG FIX: the old parser split the key on every `.`, which broke on
// JSON-path filters whose keys contain `->` and possibly dots inside
// quoted segments (`data->>'a.b'=eq.x`). The rewrite uses a JSON-path-
// aware splitter that only treats dots OUTSIDE quoted regions AND
// before any arrow token as embed separators.

import { err, ok, type Result } from '@/core/result';
import { parseErrors, type CloudRestError } from '@/core/errors';
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
  const opResult = parseOpExpr(value);
  if (!opResult.ok) return opResult;
  if (opResult.value === null) return ok(null);

  const { embedPath, fieldToken } = splitKeyIntoEmbedAndField(key);

  // BUG FIX (#24): reject empty embed segments. The old `.split('.').filter(len > 0)`
  // approach silently collapsed `.id=eq.1` into a root filter on `id`
  // and `a..b=eq.1` into an embed path of `['a']`. Both are malformed.
  //
  // BUG FIX (#AA11): embed path segments must also be plain SQL
  // identifiers. The old check only caught empty segments, so
  // `bad-name.id=eq.1` and `bad;name.id=eq.1` parsed as valid embed
  // filters on a garbage relation name.
  for (const segment of embedPath) {
    if (segment === '') {
      return err(
        parseErrors.queryParam(
          'filter',
          `empty embed path segment in "${key}"`,
        ),
      );
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment)) {
      return err(
        parseErrors.queryParam(
          'filter',
          `invalid embed path segment "${segment}" in "${key}"`,
        ),
      );
    }
  }

  const fieldResult = parseField(fieldToken);
  if (!fieldResult.ok) return fieldResult;

  return ok({
    path: embedPath,
    filter: {
      field: fieldResult.value,
      opExpr: opResult.value,
    },
  });
}

/**
 * Split a filter key into its embed-path prefix and field token.
 *
 * Dots are embed separators only when they appear:
 *   1. BEFORE the first `->` / `->>` JSON arrow token
 *   2. OUTSIDE any single- or double-quoted string
 *
 * Everything from the last "embed-separator dot" onward (plus any
 * trailing JSON path) is the field token.
 *
 * Empty segments (`.id`, `a..b`) are preserved in the returned array
 * — the caller validates them. Silently dropping them hides malformed
 * input.
 */
function splitKeyIntoEmbedAndField(key: string): {
  embedPath: EmbedPath;
  fieldToken: string;
} {
  const firstArrowIdx = findFirstArrowOutsideQuotes(key);
  // The region in which dots are embed separators.
  const embedRegionEnd = firstArrowIdx === -1 ? key.length : firstArrowIdx;
  const embedRegion = key.slice(0, embedRegionEnd);

  // Find the last unquoted `.` in the embed region.
  const lastDot = findLastUnquotedDot(embedRegion);
  if (lastDot === -1) {
    return { embedPath: [], fieldToken: key };
  }

  // BUG FIX: the old splitter did `.split('.').filter(len > 0)`, which
  // silently collapsed `.id=eq.1` into a root filter on `id`, and
  // `a..b=eq.1` into an embed path of `['a']`. Both are malformed and
  // should become PGRST100 parse errors instead. parseFilter detects
  // the empty segment(s) here and lets the caller surface it.
  const rawSegments = embedRegion.slice(0, lastDot).split('.');
  const embedPath = rawSegments;
  const fieldToken = key.slice(lastDot + 1);
  return { embedPath, fieldToken };
}

/**
 * Return the index of the first `->` in `str` that is OUTSIDE any
 * quoted region. Returns -1 if not found.
 */
function findFirstArrowOutsideQuotes(str: string): number {
  let i = 0;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === "'") {
      i = skipQuoted(str, i, "'");
      continue;
    }
    if (ch === '"') {
      i = skipQuoted(str, i, '"');
      continue;
    }
    if (ch === '-' && str[i + 1] === '>') return i;
    i += 1;
  }
  return -1;
}

/**
 * Return the index of the last `.` in `str` that is OUTSIDE any
 * quoted region. Returns -1 if none.
 */
function findLastUnquotedDot(str: string): number {
  let last = -1;
  let i = 0;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === "'") {
      i = skipQuoted(str, i, "'");
      continue;
    }
    if (ch === '"') {
      i = skipQuoted(str, i, '"');
      continue;
    }
    if (ch === '.') last = i;
    i += 1;
  }
  return last;
}

/**
 * Given that `str[start]` is an opening quote of type `quoteChar`,
 * walk past the closing quote (honoring the doubled-quote escape form)
 * and return the index AFTER the closing quote.
 */
function skipQuoted(str: string, start: number, quoteChar: string): number {
  let i = start + 1;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === quoteChar) {
      if (str[i + 1] === quoteChar) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  // Unterminated quote — advance to end and let downstream parsing
  // report the error if the filter is ever consumed.
  return str.length;
}
