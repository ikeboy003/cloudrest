// Shared parser for the `response.headers` and `response.status` GUCs.
//
// BUG FIX (#6): the old codebase parsed these GUCs in TWO places —
// `executor.ts` and the inline path in `response.ts` / `index.ts`.
// Each had slightly different rules for header-list shapes and
// forbidden headers. The rewrite has ONE implementation that both the
// read and mutation paths route through.
//
// SECURITY: header names in the forbidden list cannot be set by
// user-defined DB functions. Setting `Content-Length` or CORS headers
// via GUC would break response framing / security policy. The value
// is additionally CR/LF-stripped to prevent header-injection.

import { err, ok, type Result } from '@/core/result';
import type { CloudRestError } from '@/core/errors';
import { makeError } from '@/core/errors/types';

/**
 * Parsed GUC override bundle — the shape every downstream consumer
 * sees. Both `status` and `headers` are optional: a NULL GUC means
 * "unchanged", an empty list of headers is legal and means "no
 * overrides".
 */
export interface ParsedGucOverrides {
  /** Replacement HTTP status (100-599) or null for "no override". */
  readonly status: number | null;
  /** Additional response headers from the DB function. */
  readonly headers: readonly (readonly [string, string])[];
}

/** Empty — the default everyone starts with before applying GUCs. */
export const EMPTY_GUC_OVERRIDES: ParsedGucOverrides = Object.freeze({
  status: null,
  headers: [],
});

// ----- Forbidden headers ------------------------------------------------

/**
 * Headers a DB function is NOT allowed to set via GUC overrides.
 * Protocol-level (`Content-Length`) or security-policy (`Set-Cookie`,
 * CORS) headers live under the rewrite's control, not a user SQL
 * function's.
 */
const FORBIDDEN_GUC_HEADERS: ReadonlySet<string> = new Set([
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'host',
  'connection',
  'upgrade',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'set-cookie',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
]);

function isForbiddenGucHeader(name: string): boolean {
  return FORBIDDEN_GUC_HEADERS.has(name.toLowerCase());
}

/**
 * True if `name` is a legal HTTP field-name (RFC 7230 §3.2.6
 * `token`). We use this to filter out malformed header names the
 * DB function might return — the old code only checked the
 * forbidden-list and would happily push `"X-Bad\r\nInjected"`
 * through, which later crashed `new Headers()` or split responses.
 *
 * BUG FIX (#FF5): validate the name before it reaches `Headers`.
 */
const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
function isValidHeaderName(name: string): boolean {
  return HTTP_TOKEN_RE.test(name);
}

/**
 * Strip CR/LF/NUL from a header value to prevent response-splitting.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}

// ----- Status parsing ---------------------------------------------------

function parseGucStatus(
  raw: string | null,
): Result<number | null, CloudRestError> {
  if (raw === null || raw === '') return ok(null);
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isFinite(parsed) ||
    String(parsed) !== raw.trim() ||
    parsed < 100 ||
    parsed > 599
  ) {
    return err(
      makeError({
        code: 'PGRST112',
        message: 'response.status GUC must be a valid status code (100-599)',
        details: `received: "${raw}"`,
        httpStatus: 500,
      }),
    );
  }
  return ok(parsed);
}

// ----- Header parsing ---------------------------------------------------

/**
 * Parse the `response.headers` GUC payload into a list of header
 * entries. Accepts all three shapes PostgREST emits:
 *
 *   [{"X-Foo": "bar"}, {"X-Baz": "qux"}]          // array of one-key objects
 *   [{"name": "X-Foo", "value": "bar"}]           // array of {name,value}
 *   {"X-Foo": "bar", "X-Baz": "qux"}              // object map
 */
function parseGucHeaders(
  raw: string | null,
): Result<readonly (readonly [string, string])[], CloudRestError> {
  if (raw === null || raw === '') return ok([]);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return err(
      makeError({
        code: 'PGRST111',
        message: 'response.headers GUC value is not valid JSON',
        details: null,
        httpStatus: 500,
      }),
    );
  }

  const out: (readonly [string, string])[] = [];

  // BUG FIX (#FF5): header names must be valid HTTP tokens AND
  // not on the forbidden list. Silently drop malformed names so a
  // misconfigured DB function cannot crash response construction
  // or inject headers via CR/LF in the name itself.
  const acceptName = (name: string): boolean =>
    isValidHeaderName(name) && !isForbiddenGucHeader(name);

  if (Array.isArray(decoded)) {
    for (const entry of decoded) {
      if (entry === null || typeof entry !== 'object') continue;
      const asRecord = entry as Record<string, unknown>;
      if ('name' in asRecord && 'value' in asRecord) {
        const rawName = asRecord['name'];
        const rawValue = asRecord['value'];
        if (typeof rawName === 'string' && acceptName(rawName)) {
          out.push([rawName, sanitizeHeaderValue(String(rawValue))]);
        }
        continue;
      }
      // PostgREST one-key-object form.
      const entries = Object.entries(asRecord);
      if (entries.length === 1) {
        const [k, v] = entries[0]!;
        if (acceptName(k)) {
          out.push([k, sanitizeHeaderValue(String(v))]);
        }
      }
    }
    return ok(out);
  }

  if (decoded !== null && typeof decoded === 'object') {
    for (const [k, v] of Object.entries(decoded as Record<string, unknown>)) {
      if (acceptName(k)) {
        out.push([k, sanitizeHeaderValue(String(v))]);
      }
    }
    return ok(out);
  }

  return err(
    makeError({
      code: 'PGRST111',
      message: 'response.headers GUC must be a JSON array or object',
      details: `got: ${typeof decoded}`,
      httpStatus: 500,
    }),
  );
}

// ----- Top-level entry point --------------------------------------------

/**
 * Parse both GUCs at once. Either can be NULL (the DB didn't set it);
 * the result always carries the two fields on `ParsedGucOverrides`.
 *
 * Use this function from BOTH the read path and the mutation path —
 * that is the contract that closes critique #6.
 */
export function parseResponseGucHeaders(input: {
  readonly responseHeaders: string | null;
  readonly responseStatus: string | null;
}): Result<ParsedGucOverrides, CloudRestError> {
  const statusResult = parseGucStatus(input.responseStatus);
  if (!statusResult.ok) return statusResult;
  const headersResult = parseGucHeaders(input.responseHeaders);
  if (!headersResult.ok) return headersResult;
  return ok({
    status: statusResult.value,
    headers: headersResult.value,
  });
}
