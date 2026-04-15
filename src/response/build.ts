// Response builder — `QueryResult + ReadPlan → RawDomainResponse`.
//
// This is the third step in the read-path lifecycle: the executor
// returned rows and GUCs, and this module shapes them into the
// "domain response" an HTTP-level finalizer can serialize.
//
// INVARIANT: builders never mutate a built SQL
// string. Response construction only reads `QueryResult`; it never
// calls back into the builder.

import type { QueryResult } from '@/executor/types';
import type { ReadPlan } from '@/planner/read-plan';

export interface RawDomainResponse {
  /** Body string already in its final form (JSON, CSV text, etc.). */
  readonly body: string;
  /** `Content-Range` header value. */
  readonly contentRange: string;
  /** Total rows if the exact/estimated/planned count was requested. */
  readonly totalResultSet: number | null;
  /** Number of rows actually returned in `body`. */
  readonly pageTotal: number;
  /** Raw `response.headers` GUC value or null. */
  readonly responseHeaders: string | null;
  /** Raw `response.status` GUC value or null. */
  readonly responseStatus: string | null;
  /**
   * URL fragment to emit as `Location:` on 201/303 responses. The
   * mutation SQL wrapper builds this as a `pk=eq.<value>` query
   * string fragment; the finalizer prepends the request path.
   * `null` for read paths and for mutations without a primary key.
   */
  readonly locationQuery?: string | null;
}

/**
 * Build a `RawDomainResponse` from an executor `QueryResult` for a
 * `ReadPlan`. The body comes from the `body` column the read builder
 * projects; the header counts come from `total_result_set` and
 * `page_total`.
 */
export function buildReadResponse(
  plan: ReadPlan,
  result: QueryResult,
): RawDomainResponse {
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const body = typeof row?.['body'] === 'string' ? (row['body'] as string) : '[]';

  // `total_result_set` comes through either as a bigint-as-string or
  // a JS number — postgres.js's behavior varies by column type. A
  // negative value (like `reltuples = -1` for un-analyzed tables)
  // collapses to null so the `Content-Range` header doesn't leak a
  // nonsense "*/-1".
  const rawTotal = row?.['total_result_set'];
  let totalResultSet: number | null = null;
  if (rawTotal !== undefined && rawTotal !== null) {
    const parsed = Number(rawTotal);
    if (Number.isFinite(parsed) && parsed >= 0) totalResultSet = parsed;
  }

  const pageTotalRaw = row?.['page_total'];
  const pageTotal =
    pageTotalRaw === undefined || pageTotalRaw === null
      ? 0
      : Number(pageTotalRaw) || 0;

  const contentRange = buildContentRange(plan, pageTotal, totalResultSet);

  return {
    body,
    contentRange,
    totalResultSet,
    pageTotal,
    responseHeaders: result.responseHeaders,
    responseStatus: result.responseStatus,
  };
}

// Render the `Content-Range` header value for a read result.
//
// Shape:
//   - `(star)/N`  when the result is empty;
//   - `A-B/N`     when there are rows (A = offset, B = offset+pageTotal-1);
//   - `A-B/(star)` when no count was requested (null total).
//
// PostgREST compat: the "/-1" form for `reltuples = -1` is collapsed
// to "/(star)" via the null clamp in `buildReadResponse`.
function buildContentRange(
  plan: ReadPlan,
  pageTotal: number,
  totalResultSet: number | null,
): string {
  const totalLabel = totalResultSet === null ? '*' : String(totalResultSet);
  if (pageTotal === 0) {
    return `*/${totalLabel}`;
  }
  const start = plan.range.offset;
  const end = start + pageTotal - 1;
  return `${start}-${end}/${totalLabel}`;
}
