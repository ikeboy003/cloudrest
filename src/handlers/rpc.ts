// `handleRpc` — orchestration for `POST /rpc/foo` and `GET /rpc/foo`.
//
// The "empty body on POST /rpc/fn means `{}`" shortcut lives HERE,
// not in the generic payload parser. Injecting a default `{}` from
// `parsePayload` would change the semantics of every other POST
// endpoint.

import { err, type Result } from '@/core/result';
import type { CloudRestError } from '@/core/errors';
import type { HandlerContext } from '@/core/context';
import type { ParsedHttpRequest } from '@/http/request';
import { parseQueryParams } from '@/parser/query-params';
import {
  parsePayload,
  parseJsonPayload,
  type Payload,
} from '@/parser/payload';
import { planRpc } from '@/planner/plan-rpc';
import { buildRpcQuery } from '@/builder/rpc';
import { runQuery } from '@/executor/execute';
import { buildRequestPrelude } from '@/executor/request-prelude';
import type { RawDomainResponse } from '@/response/build';
import {
  contentTypeFor,
  finalizeResponse,
  type MediaTypeId,
} from '@/response/finalize';
import { negotiateOutputMedia } from '@/http/media/negotiate';
import { intersectRanges, type NonnegRange } from '@/http/range';

const RPC_OFFERED_MEDIA: readonly MediaTypeId[] = [
  'json',
  'array',
  'array-stripped',
  'singular',
  'singular-stripped',
];

export async function handleRpc(
  httpRequest: ParsedHttpRequest,
  context: HandlerContext,
): Promise<Result<Response, CloudRestError>> {
  if (httpRequest.action.type !== 'routineCall') {
    return err({
      code: 'PGRST501',
      message: 'Not implemented',
      details: `handleRpc cannot serve action ${httpRequest.action.type}`,
      hint: null,
      httpStatus: 501,
    });
  }
  const action = httpRequest.action;

  // 1. Parse query parameters.
  const parsed = parseQueryParams(httpRequest.url.searchParams);
  if (!parsed.ok) return parsed;

  // 2. Negotiate output media type.
  const mediaResult = negotiateOutputMedia({
    accept: httpRequest.acceptMediaTypes,
    offered: RPC_OFFERED_MEDIA,
    rawAcceptHeader: httpRequest.rawAcceptHeader,
  });
  if (!mediaResult.ok) return mediaResult;
  const mediaId: MediaTypeId = mediaResult.value;

  // 3. Parse the body — critique #48: POST /rpc/fn with an empty
  //    body defaults to `{}`. This shortcut lives HERE so no other
  //    handler is accidentally affected.
  let payload: Payload | null;
  if (action.invocation === 'invoke') {
    const payloadResult = await parseRpcPayload(
      httpRequest,
      context,
    );
    if (!payloadResult.ok) return payloadResult;
    payload = payloadResult.value;
  } else {
    // GET /rpc/fn — no body; `rpcParams` on the query string are
    // treated as named arguments by the planner.
    payload = null;
  }

  // 4. Plan the RPC call. `parseHttpRequest` only populates
  //    `topLevelRange` from the `Range:` header; `?limit=` /
  //    `?offset=` live under `parsed.ranges` and must be
  //    intersected here (same fix as the read handler HH1).
  const queryRange: NonnegRange =
    parsed.value.ranges.get('limit') ?? { offset: 0, limit: null };
  const effectiveTopLevelRange = intersectRanges(
    httpRequest.topLevelRange,
    queryRange,
  );
  const plan = planRpc({
    target: action.target,
    parsed: parsed.value,
    payload,
    preferences: httpRequest.preferences,
    schema: context.schema,
    topLevelRange: effectiveTopLevelRange,
  });
  if (!plan.ok) return plan;

  // 5. Build SQL.
  const built = buildRpcQuery(plan.value);
  if (!built.ok) return built;

  // 6. Execute. Volatile routines honor `Prefer: tx=rollback` just
  //    like mutations; stable/immutable invocations always commit.
  //    The authenticated role and claim GUCs flow through the
  //    request prelude so routines behave under the JWT-resolved
  //    role, not the connection role.
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
      action.invocation === 'invoke' &&
      (httpRequest.preferences.preferTransaction === 'rollback' ||
        context.config.database.txEnd === 'rollback'),
  });
  if (!execResult.ok) return execResult;

  // 7. Shape the domain response.
  const domain = shapeRpcResponse(execResult.value);

  // 8. Finalize.
  return finalizeResponse({
    httpRequest,
    response: domain,
    baseStatus: 200,
    contentType: contentTypeFor(mediaId),
    timer: context.timer,
    config: context.config,
  });
}

// ----- Helpers ----------------------------------------------------------

/**
 * Parse the body for a POST /rpc/fn, or apply the critique-#48
 * `{}` shortcut when the body is empty.
 */
async function parseRpcPayload(
  httpRequest: ParsedHttpRequest,
  context: HandlerContext,
): Promise<Result<Payload | null, CloudRestError>> {
  const parsed = await parsePayload({
    request: context.originalHttpRequest,
    config: context.config,
    contentMediaTypeId: httpRequest.contentMediaType.id,
  });
  if (!parsed.ok) return parsed;
  // Empty-body fallback lives HERE, not in parsePayload.
  if (parsed.value === null) {
    return parseJsonPayload('{}');
  }
  return parsed;
}

function shapeRpcResponse(result: {
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
  const contentRange = pageTotal === 0 ? '*/*' : `0-${pageTotal - 1}/*`;
  return {
    body,
    contentRange,
    totalResultSet: null,
    pageTotal,
    responseHeaders: result.responseHeaders,
    responseStatus: result.responseStatus,
  };
}
