// `handleMutation` — orchestration for POST/PUT/PATCH/DELETE /{relation}.
//
// INVARIANT (CONSTITUTION §1.8): like `handleRead`, this is a thin
// sequential pipeline. Parse query → parse body → plan → build →
// execute → build response → finalize.
//
// Stage 9 scope: happy path for single-row and array INSERT, UPDATE,
// DELETE, and single-row UPSERT. Nested insert and graph-return
// forms are deferred — they wire in on top of this module without
// restructuring it.

import { err, type Result } from '@/core/result';
import { mediaErrors, parseErrors, type CloudRestError } from '@/core/errors';
import type { HandlerContext } from '@/core/context';
import type { ParsedHttpRequest } from '@/http/request';
import { parseQueryParams } from '@/parser/query-params';
import { parsePayload } from '@/parser/payload';
import { planMutation } from '@/planner/plan-mutation';
import { buildMutationQuery } from '@/builder/mutation';
import { runQuery } from '@/executor/execute';
import { buildRequestPrelude } from '@/executor/request-prelude';
import type { RawDomainResponse } from '@/response/build';
import {
  contentTypeFor,
  finalizeResponse,
  type MediaTypeId,
} from '@/response/finalize';
import { formatBody } from '@/http/media/format';
import { negotiateOutputMedia } from '@/http/media/negotiate';

const MUTATION_OFFERED_MEDIA: readonly MediaTypeId[] = [
  'json',
  'array',
  'array-stripped',
  'singular',
  'singular-stripped',
];

export async function handleMutation(
  httpRequest: ParsedHttpRequest,
  context: HandlerContext,
): Promise<Result<Response, CloudRestError>> {
  if (httpRequest.action.type !== 'relationMut') {
    return err({
      code: 'PGRST501',
      message: 'Not implemented',
      details: `handleMutation cannot serve action ${httpRequest.action.type}`,
      hint: null,
      httpStatus: 501,
    });
  }
  const action = httpRequest.action;

  // 1. Parse query parameters.
  const parsed = parseQueryParams(httpRequest.url.searchParams);
  if (!parsed.ok) return parsed;

  // 1b. BUG FIX: PUT with `?limit=` / `?offset=` must be refused at
  //     PGRST114. The range-header version is caught by `parseRange`,
  //     but at request-parse time the query-param shape is not yet
  //     known — `parseHttpRequest` calls `parseRange` with
  //     `limitOverride: ALL_ROWS`, so the check there only covers
  //     `Range:` headers. Apply the same rejection here, once we
  //     have the parsed query params.
  if (action.mutation === 'singleUpsert') {
    const rootRange = parsed.value.ranges.get('limit');
    if (
      rootRange !== undefined &&
      (rootRange.offset !== 0 || rootRange.limit !== null)
    ) {
      return err(parseErrors.putLimitNotAllowed());
    }
  }

  // 2. Negotiate output media type.
  const mediaResult = negotiateOutputMedia({
    accept: httpRequest.acceptMediaTypes,
    offered: MUTATION_OFFERED_MEDIA,
    rawAcceptHeader: httpRequest.rawAcceptHeader,
  });
  if (!mediaResult.ok) return mediaResult;
  const mediaId: MediaTypeId = mediaResult.value;

  // 3. Parse the body (#44 content-length pre-check lives here).
  const payloadResult = await parsePayload({
    request: context.originalHttpRequest,
    config: context.config,
    contentMediaTypeId: httpRequest.contentMediaType.id,
  });
  if (!payloadResult.ok) return payloadResult;

  // 4. Plan the mutation.
  const plan = planMutation({
    target: action.target,
    mutation: action.mutation,
    parsed: parsed.value,
    payload: payloadResult.value,
    preferences: httpRequest.preferences,
    schema: context.schema,
    wrap: 'result',
  });
  if (!plan.ok) return plan;

  // 5. Build SQL.
  const built = buildMutationQuery(plan.value);
  if (!built.ok) return built;

  // 6. Execute. Mutations honor `Prefer: tx=rollback` via Stage 7's
  //    `rollbackPreferred` option, and `Prefer: max-affected=N` via
  //    the `maxAffected` option which the executor enforces by
  //    rolling back and surfacing PGRST124 when exceeded.
  //
  //    BUG FIX: same as the read handler — the mutation path now
  //    threads the authenticated role, per-request claim GUCs, and
  //    the `DB_PRE_REQUEST` hook through `runQuery`. Without this
  //    RLS and per-claim policy checks were running against the
  //    connection role rather than the JWT role.
  const prelude = buildRequestPrelude({
    auth: context.auth,
    config: context.config,
    httpRequest,
  });
  const execResult = await runQuery(context, built.value, {
    roleSql: prelude.roleSql,
    preQuerySql: prelude.preQuerySql,
    preRequestSql: prelude.preRequestSql,
    rollbackPreferred:
      httpRequest.preferences.preferTransaction === 'rollback' ||
      context.config.database.txEnd === 'rollback',
    maxAffected: httpRequest.preferences.preferMaxAffected,
  });
  if (!execResult.ok) return execResult;

  // 7. Shape the domain response using the read-response builder.
  //    The mutation wrapper projects `total_result_set`, `page_total`,
  //    and `body` in the same layout, so the same helper applies.
  const rawDomain = shapeDomainResponse(execResult.value);

  // 8. Apply the negotiated output media formatter. The mutation
  //    handler only offers JSON-shaped media types today, but the
  //    singular/stripped variants still need transformation and
  //    the singular cardinality contract still applies (PGRST116
  //    when returning 0 or 2+ rows under
  //    `application/vnd.pgrst.object+json`).
  const formatted = formatBody(mediaId, rawDomain.body);
  if (formatted.kind === 'singular-cardinality') {
    return err(mediaErrors.singularityError(formatted.rowCount));
  }
  const domain: RawDomainResponse = { ...rawDomain, body: formatted.body };

  // 9. Finalize.
  const baseStatus = computeBaseStatus(action.mutation);
  return finalizeResponse({
    httpRequest,
    response: domain,
    baseStatus,
    contentType: contentTypeFor(mediaId),
    timer: context.timer,
    config: context.config,
  });
}

// ----- Helpers ----------------------------------------------------------

function computeBaseStatus(
  mutation: 'create' | 'update' | 'delete' | 'singleUpsert',
): number {
  switch (mutation) {
    case 'create':
    case 'singleUpsert':
      return 201;
    case 'update':
      return 200;
    case 'delete':
      return 204;
  }
}

/**
 * Lightweight mutation-response shaper — mirrors `buildReadResponse`
 * but without needing a `ReadPlan`. The wrapped mutation SQL projects
 * the same column names (`total_result_set`, `page_total`, `body`)
 * plus a `header` column (the Location-header key=value pairs for
 * INSERT/UPSERT) which becomes `locationQuery` on the domain
 * response.
 */
function shapeDomainResponse(result: {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly responseHeaders: string | null;
  readonly responseStatus: string | null;
}): RawDomainResponse {
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const body =
    typeof row?.['body'] === 'string' ? (row['body'] as string) : '[]';
  const pageTotalRaw = row?.['page_total'];
  const pageTotal =
    pageTotalRaw === undefined || pageTotalRaw === null
      ? 0
      : Number(pageTotalRaw) || 0;
  // Mutations don't compute a total; Content-Range is empty-or-counted.
  const contentRange = pageTotal === 0 ? '*/*' : `0-${pageTotal - 1}/*`;
  return {
    body,
    contentRange,
    totalResultSet: null,
    pageTotal,
    responseHeaders: result.responseHeaders,
    responseStatus: result.responseStatus,
    locationQuery: extractLocationQuery(row),
  };
}

/**
 * Pull the `header` column off the first row of a mutation result
 * and flatten it into a `key=value&key=value` query-string fragment.
 * The builder emits this as `text[]` (array of `"col=eq.val"`
 * entries); a missing or empty array means "no primary key" and
 * the finalizer will skip the Location header.
 */
function extractLocationQuery(
  row: Record<string, unknown> | undefined,
): string | null {
  if (row === undefined) return null;
  const header = row['header'];
  if (!Array.isArray(header) || header.length === 0) return null;
  const parts = header.filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  if (parts.length === 0) return null;
  return parts.join('&');
}
