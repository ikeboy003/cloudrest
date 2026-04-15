// Response finalization — `RawDomainResponse → HTTP Response`.
//
// Every response exits through THIS function. GUC overrides,
// Server-Timing, cache headers, Content-Range, ETag, and
// Content-Length all live here, in the order a correct HTTP pipeline
// requires:
//
//   1. Apply GUC status / headers (may reject with PGRST111/112).
//   2. Compute the HTTP status (singular / range / GUC).
//   3. Attach Content-Type / Content-Location.
//   4. Attach Content-Range.
//   5. Compute and attach ETag (for caching).
//   6. Emit Server-Timing from `context.timer` if enabled.
//   7. Attach Content-Length from the final body.

import { err, ok, type Result } from '@/core/result';
import { parseErrors, type CloudRestError } from '@/core/errors';
import type { AppConfig } from '@/config/schema';
import type { ParsedHttpRequest } from '@/http/request';
import { contentTypeFor, type MediaTypeId } from '@/http/media/types';
import type { RequestTimer } from '@/executor/timer';
import { preferenceAppliedHeader } from '@/http/preferences';
import { parseResponseGucHeaders } from './guc';
import type { RawDomainResponse } from './build';

// ----- Finalize input / output -----------------------------------------

export interface FinalizeInput {
  readonly httpRequest: ParsedHttpRequest;
  readonly response: RawDomainResponse;
  /** Base status code the handler wants (200, 201, 206 for partial range). */
  readonly baseStatus: number;
  /** Content-Type header value — the finalizer never picks it itself. */
  readonly contentType: string;
  /** Optional timer for Server-Timing emission. */
  readonly timer?: RequestTimer;
  readonly config: AppConfig;
}

/**
 * Finalize a domain response into an HTTP Response.
 *
 * Returns a Result because the GUC parser may reject a malformed
 * `response.headers` / `response.status` with PGRST111/PGRST112 —
 * those become a late-stage error response.
 */
export function finalizeResponse(
  input: FinalizeInput,
): Result<Response, CloudRestError> {
  const { httpRequest, response, baseStatus, contentType, timer } = input;
  const prefs = httpRequest.preferences;

  // ----- 0. Invalid-preferences guardrail -----
  //
  // `parsePrefer` records every preference token the client sent
  // but that we couldn't apply (unknown key, unknown value, or
  // server-forbidden override). Under `Prefer: handling=strict`
  // PostgREST returns 400 PGRST122 with the offending tokens;
  // under the default lenient path it adds a `Warning` header so
  // misconfigured clients don't fail hard.
  if (prefs.invalidPrefs.length > 0 && prefs.preferHandling === 'strict') {
    return err(
      parseErrors.invalidPreferences(prefs.invalidPrefs.join(', ')),
    );
  }

  // ----- 1. GUC overrides -----
  const gucResult = parseResponseGucHeaders({
    responseHeaders: response.responseHeaders,
    responseStatus: response.responseStatus,
  });
  if (!gucResult.ok) return gucResult;
  const guc = gucResult.value;

  // ----- 2. HTTP status -----
  const status = guc.status ?? baseStatus;

  // ----- 3. Core headers -----
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Content-Location', buildContentLocation(httpRequest));

  // ----- 4. Content-Range -----
  headers.set('Content-Range', response.contentRange);

  // ----- 4b. Location (INSERT/UPSERT with a primary key) -----
  //
  // The mutation SQL wrapper emits a `header` column with the
  // Location-key pairs; the handler carries it on `locationQuery`
  // and we render `<path>?<pk>=eq.<value>` here. Only emits for
  // 201 Created (and 303, if a GUC override sets it) — PostgREST
  // does not emit Location on UPDATE/DELETE even when the rows
  // have a PK.
  const locationQuery = response.locationQuery;
  if (
    typeof locationQuery === 'string' &&
    locationQuery.length > 0 &&
    (status === 201 || status === 303)
  ) {
    headers.set('Location', `${httpRequest.path}?${locationQuery}`);
  }

  // ----- 5. ETag (only for read paths) -----
  if (
    httpRequest.action.type === 'relationRead' ||
    httpRequest.action.type === 'schemaRead'
  ) {
    const etag = computeWeakEtag(response.body);
    headers.set('ETag', etag);
  }

  // ----- 6. Server-Timing -----
  if (input.config.observability.serverTimingEnabled && timer !== undefined) {
    const timingHeader = renderServerTiming(timer);
    if (timingHeader !== '') headers.set('Server-Timing', timingHeader);
  }

  // ----- 6b. Preference-Applied / Warning -----
  //
  // Emit `Preference-Applied` summarizing every preference we
  // honored, and — under lenient handling — a `Warning` header
  // naming every preference we dropped. The strict branch above
  // already short-circuits to PGRST122.
  const appliedHeader = preferenceAppliedHeader(prefs);
  if (appliedHeader !== null) headers.set('Preference-Applied', appliedHeader);
  if (prefs.invalidPrefs.length > 0) {
    headers.set(
      'Warning',
      `299 - "Unsupported preferences: ${prefs.invalidPrefs.join(', ')}"`,
    );
  }

  // ----- 7. GUC-supplied headers (DB function overrides) -----
  for (const [name, value] of guc.headers) {
    // Avoid trampling protocol-level headers — `parseResponseGucHeaders`
    // already filtered the forbidden list.
    headers.set(name, value);
  }

  // ----- 8. HEAD handling — strip body -----
  //
  // Status codes 204/205/304 are defined to have NO body in
  // RFC 9110. The Fetch spec enforces this: `new Response(body,
  // { status: 204 })` with a non-null body throws. Collapse the
  // body to `null` for any null-body status so DELETE (which
  // defaults to 204) doesn't blow up.
  const isHead =
    httpRequest.action.type === 'relationRead' &&
    httpRequest.action.headersOnly;
  const isNullBodyStatus = status === 204 || status === 205 || status === 304;
  const body = isHead || isNullBodyStatus ? null : response.body;

  // Content-Length — Headers() auto-computes for string bodies but not
  // for `null`; set it explicitly for HEAD so the value still reflects
  // the would-be body.
  if (isHead) {
    headers.set(
      'Content-Length',
      String(new TextEncoder().encode(response.body).length),
    );
  }

  return ok(new Response(body, { status, headers }));
}

// ----- Helpers ----------------------------------------------------------

function buildContentLocation(httpRequest: ParsedHttpRequest): string {
  const search = httpRequest.url.search;
  return httpRequest.path + (search.length > 0 ? search : '');
}

/**
 * Weak ETag — `W/"<hex>"` over the body. Conditional-GET works for
 * deterministic responses; a stronger hash can replace this once a
 * cache layer lands.
 */
function computeWeakEtag(body: string): string {
  // A 32-bit FNV-1a over the UTF-8 bytes — good enough for a weak ETag.
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    hash ^= body.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return `W/"${hex}"`;
}

function renderServerTiming(timer: RequestTimer): string {
  const parts: string[] = [];
  for (const entry of timer.entries()) {
    // `Server-Timing: parse;dur=1.3, plan;dur=0.4, ...`
    parts.push(`${entry.phase};dur=${entry.durationMs.toFixed(2)}`);
  }
  return parts.join(', ');
}

/** Re-export of the media-registry helper for response callers. */
export { contentTypeFor } from '@/http/media/types';
export type { MediaTypeId } from '@/http/media/types';
