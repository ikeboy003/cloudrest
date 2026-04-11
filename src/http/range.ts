// Range header parsing and Content-Range / status response helpers.
//
// COMPAT: Mirrors PostgREST's RangeQuery.hs. Ranges are inclusive bounds
// in the Range header but stored internally as `{ offset, limit }` where
// `limit = null` means "open-ended". Only GET honors the Range header;
// PUT with any range is rejected.
//
// REGRESSION: critique #73 — `pg_class.reltuples = -1` for tables that
// have never been analyzed used to propagate as `Content-Range: */-1`
// and trip 416. This module clamps any negative total to null here, at
// the parse/response boundary, so no downstream code sees a nonsense
// total.

import { err, ok, type Result } from '../core/result';
import { parseErrors, type CloudRestError } from '../core/errors';

/**
 * A non-negative range: an inclusive-start offset plus an optional
 * exclusive-end-at-offset-plus-limit. `limit: null` means "open".
 *
 * INVARIANT: `offset >= 0`, `limit === null || limit >= 0`.
 */
export interface NonnegRange {
  readonly offset: number;
  readonly limit: number | null;
}

export const ALL_ROWS: NonnegRange = Object.freeze({ offset: 0, limit: null });

export interface RangeStatus {
  readonly status: number;
  readonly contentRange: string;
}

export interface ParseRangeInput {
  readonly method: string;
  readonly headers: Headers;
  /**
   * Optional limit override from query params. Parser modules populate
   * this from `?limit=N`; stage 3 doesn't know about query params yet
   * and defaults to `null`.
   */
  readonly limitOverride?: NonnegRange | null;
}

/**
 * Parse and validate the effective top-level range from the Range header
 * and an optional `?limit=` query-param range. The two are intersected.
 */
export function parseRange(
  input: ParseRangeInput,
): Result<NonnegRange, CloudRestError> {
  let headerRange: NonnegRange = ALL_ROWS;

  if (input.method === 'GET') {
    const rawRange = input.headers.get('range');
    if (rawRange !== null) {
      const parsed = parseRangeHeaderValue(rawRange);
      if (!parsed.ok) return parsed;
      headerRange = parsed.value;
    }
  }

  // Reject descending ranges (already surfaced as limit = -1 inside parseRangeHeaderValue).
  if (headerRange.limit !== null && headerRange.limit < 0) {
    return err(
      parseErrors.invalidRange('Range lower bound is greater than upper bound'),
    );
  }

  const overrideRange = input.limitOverride ?? ALL_ROWS;
  if (overrideRange.limit !== null && overrideRange.limit < 0) {
    return err(parseErrors.invalidRange('Limit should be greater than or equal to zero.'));
  }

  const intersected = intersectRanges(headerRange, overrideRange);

  if (input.method === 'PUT' && (intersected.offset !== 0 || intersected.limit !== null)) {
    return err(parseErrors.putLimitNotAllowed());
  }

  return ok(intersected);
}

/**
 * Parse a `Range` header value into a NonnegRange.
 *
 * Accepted forms: `0-24` (inclusive bounds), `5-` (open end).
 * Anything else is a PGRST103.
 */
function parseRangeHeaderValue(raw: string): Result<NonnegRange, CloudRestError> {
  const match = raw.match(/^(\d+)-(\d*)$/);
  if (!match) return err(parseErrors.invalidRange('Range header is malformed'));

  const start = Number(match[1]);
  if (match[2] === '') return ok({ offset: start, limit: null });

  const end = Number(match[2]);
  if (start > end) {
    // Will be caught above and surface as PGRST103.
    return ok({ offset: start, limit: -1 });
  }
  return ok({ offset: start, limit: end - start + 1 });
}

function intersectRanges(a: NonnegRange, b: NonnegRange): NonnegRange {
  if (a.limit === null && b.limit === null) {
    return { offset: Math.max(a.offset, b.offset), limit: null };
  }

  const aStart = a.offset;
  const aEnd = a.limit === null ? Number.POSITIVE_INFINITY : a.offset + a.limit;
  const bStart = b.offset;
  const bEnd = b.limit === null ? Number.POSITIVE_INFINITY : b.offset + b.limit;

  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);

  if (start >= end) return { offset: start, limit: 0 };
  return {
    offset: start,
    limit: end === Number.POSITIVE_INFINITY ? null : end - start,
  };
}

/**
 * Compute the HTTP status and Content-Range response header from the
 * effective range, the number of rows returned, and the total row count.
 *
 * REGRESSION: critique #73 — negative totals (seen when `pg_class.reltuples`
 * is -1 for unanalyzed tables) are clamped to null here. No downstream
 * code should ever see a negative `tableTotal`.
 */
export function rangeStatusHeader(
  range: NonnegRange,
  pageTotal: number,
  tableTotal: number | null,
): RangeStatus {
  const safeTotal = tableTotal !== null && tableTotal < 0 ? null : tableTotal;
  const totalStr = safeTotal !== null ? String(safeTotal) : '*';

  if (pageTotal === 0) {
    if (safeTotal !== null && range.offset > safeTotal) {
      return { status: 416, contentRange: `*/${totalStr}` };
    }
    return { status: 200, contentRange: `*/${totalStr}` };
  }

  const start = range.offset;
  const end = start + pageTotal - 1;

  if (safeTotal !== null && start > safeTotal) {
    return { status: 416, contentRange: `*/${totalStr}` };
  }

  if (safeTotal === null) {
    return { status: 200, contentRange: `${start}-${end}/${totalStr}` };
  }

  if (start === 0 && pageTotal >= safeTotal) {
    return { status: 200, contentRange: `${start}-${end}/${totalStr}` };
  }

  return { status: 206, contentRange: `${start}-${end}/${totalStr}` };
}
