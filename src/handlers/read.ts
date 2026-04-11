// `handleRead` — orchestration for `GET /{relation}`.
//
// INVARIANT (CONSTITUTION §1.8 + ARCHITECTURE lifecycle): this
// handler is a thin orchestration layer. Parse → plan → build →
// execute → build response → finalize. The eight-step pipeline is
// NOT hidden inside helpers; it is named here in a flat sequence so
// a reader can trace what a GET does in one screenful.
//
// INVARIANT (READABILITY §big-four): no positional parameter bloat.
// Every dependency comes through `context: HandlerContext`. Adding a
// new dependency means widening HandlerContext, not this signature.

import { err, type Result } from '../core/result';
import { mediaErrors, type CloudRestError } from '../core/errors';
import type { HandlerContext } from '../core/context';
import type { ParsedHttpRequest } from '../http/request';
import { parseQueryParams } from '../parser/query-params';
import { planRead } from '../planner/plan-read';
import { buildReadQuery } from '../builder/read';
import { runQuery } from '../executor/execute';
import type { ReadPlan } from '../planner/read-plan';
import { buildReadResponse, type RawDomainResponse } from '../response/build';
import {
  contentTypeFor,
  finalizeResponse,
  type MediaTypeId,
} from '../response/finalize';
import { formatBody } from '../http/media/format';
import { negotiateOutputMedia } from '../http/media/negotiate';
import { intersectRanges, type NonnegRange } from '../http/range';

const READ_OFFERED_MEDIA: readonly MediaTypeId[] = [
  'json',
  'array',
  'array-stripped',
  'singular',
  'singular-stripped',
  'csv',
  'ndjson',
  'geojson',
];

/**
 * Handle a `GET /{relation}` request. Returns a `Result<Response,
 * CloudRestError>` — callers (router/fetch.ts) format the error into
 * a final HTTP response via the error finalizer.
 */
export async function handleRead(
  httpRequest: ParsedHttpRequest,
  context: HandlerContext,
): Promise<Result<Response, CloudRestError>> {
  if (httpRequest.action.type !== 'relationRead') {
    return err({
      code: 'PGRST501',
      message: 'Not implemented',
      details: `handleRead cannot serve action ${httpRequest.action.type}`,
      hint: null,
      httpStatus: 501,
    });
  }

  // 1. Parse query parameters.
  const parsed = parseQueryParams(httpRequest.url.searchParams);
  if (!parsed.ok) return parsed;

  // 2. Negotiate output media type.
  const mediaResult = negotiateOutputMedia({
    accept: httpRequest.acceptMediaTypes,
    offered: READ_OFFERED_MEDIA,
    rawAcceptHeader: httpRequest.rawAcceptHeader,
  });
  if (!mediaResult.ok) return mediaResult;
  const mediaId: MediaTypeId = mediaResult.value;

  // 3. Plan the read.
  //
  // BUG FIX (#HH1): `parseHttpRequest` computes `topLevelRange`
  // from the `Range:` header BEFORE query params are parsed, so it
  // has no visibility into `?limit=` / `?offset=`. Intersect the
  // two here so a request like `/books?limit=10&offset=5` actually
  // produces an effective range of `{offset: 5, limit: 10}` at
  // planning time instead of `ALL_ROWS`.
  //
  // BUG FIX (#HH2): pass the configured `limits.maxEmbedDepth`
  // through so runtime config controls the depth cap instead of
  // the compiled-in default.
  const queryRange: NonnegRange =
    parsed.value.ranges.get('limit') ?? { offset: 0, limit: null };
  const effectiveTopLevelRange = intersectRanges(
    httpRequest.topLevelRange,
    queryRange,
  );
  const plan = planRead({
    target: httpRequest.action.target,
    parsed: parsed.value,
    preferences: httpRequest.preferences,
    schema: context.schema,
    mediaType: mediaId,
    topLevelRange: effectiveTopLevelRange,
    hasPreRequest: context.config.database.preRequest !== null,
    maxRows: context.config.database.maxRows,
    maxEmbedDepth: context.config.limits.maxEmbedDepth,
    // BUG FIX (#HH3): honor `DB_AGGREGATES_ENABLED`.
    aggregatesEnabled: context.config.database.aggregatesEnabled,
  });
  if (!plan.ok) return plan;

  // 4. Build SQL.
  const built = buildReadQuery(plan.value);
  if (!built.ok) return built;

  // 5. Execute.
  const execResult = await runQuery(context, built.value);
  if (!execResult.ok) return execResult;

  // 6. Build the domain response.
  const rawDomain = buildReadResponse(plan.value, execResult.value);

  // 7. Apply the negotiated output media formatter. Up until this
  //    point `rawDomain.body` is the raw JSON array Postgres
  //    produced; CSV, NDJSON, GeoJSON, singular, and stripped-null
  //    shapes all need the body transformed and can raise PGRST116
  //    for the singular cardinality contract.
  const formatted = formatBody(mediaId, rawDomain.body);
  if (formatted.kind === 'singular-cardinality') {
    return err(mediaErrors.singularityError(formatted.rowCount));
  }
  const domain: RawDomainResponse = { ...rawDomain, body: formatted.body };

  // 8. Determine base status (singular vs range vs default).
  const baseStatus = computeBaseStatus(plan.value, domain.pageTotal, domain.totalResultSet);

  // 9. Finalize.
  return finalizeResponse({
    httpRequest,
    response: domain,
    baseStatus,
    contentType: contentTypeFor(mediaId),
    timer: context.timer,
    config: context.config,
  });
}

/**
 * Decide the base HTTP status for a successful read:
 *  - 416 when the requested offset is past the end;
 *  - 206 when a partial range was requested (and satisfied);
 *  - 200 otherwise.
 *
 * Singular-media "must be exactly 1 row" enforcement lives in the
 * media-validation step inside `buildReadResponse` / handler
 * follow-ups; Stage 8 hands back 200 for the happy path.
 *
 * BUG FIX (#HH6): the old implementation only returned 200 or 206
 * — the 416 case the comment promises was missing. A ranged
 * request whose offset sat past the total returned 206 with zero
 * rows instead of the proper 416 Range Not Satisfiable. Mirror
 * `rangeStatusHeader`'s shape and surface 416 when we have a
 * known total and the offset exceeds it.
 */
function computeBaseStatus(
  plan: ReadPlan,
  pageTotal: number,
  totalResultSet: number | null,
): number {
  // Requested a non-default range?
  const requestedRange = plan.range.offset > 0 || plan.range.limit !== null;
  if (!requestedRange) return 200;

  // 416 Range Not Satisfiable — the caller asked for rows past the
  // end of the result set AND the result set was empty. A non-zero
  // `pageTotal` means the partial range was satisfied; return 206.
  if (
    pageTotal === 0 &&
    totalResultSet !== null &&
    totalResultSet >= 0 &&
    plan.range.offset > totalResultSet
  ) {
    return 416;
  }

  // A range was requested — 206 Partial Content when the server
  // returned fewer rows than the total (or the count is unknown).
  if (totalResultSet !== null && pageTotal === totalResultSet) return 200;
  return 206;
}
