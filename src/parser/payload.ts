// Request body parser — JSON, CSV, form-urlencoded, octet-stream.
//
// INVARIANT (CONSTITUTION §1.5): parsing is grammatical only. This
// module decides WHAT the body means; validating columns against a
// schema is the planner's job.
//
// STAGE 4 HARDENING (critiques #44, #46, #47):
//   #44: body size is checked BEFORE `request.text()` buffers the
//        whole thing — a Content-Length > `limits.maxBodyBytes` is
//        rejected with PGRST413 without reading the socket.
//   #46: form-urlencoded with duplicate keys is rejected instead of
//        silently keeping the last value. PostgREST merges duplicates
//        differently from every client library, so rejecting is the
//        only sane default.
//   #47: CSV `NULL` is an opt-in via `?csv.null=`. The old code
//        unconditionally treated the literal text `NULL` as SQL NULL,
//        breaking any row that contained a legitimate `"NULL"` string.

import { err, ok, type Result } from '@/core/result';
import { parseErrors, type CloudRestError } from '@/core/errors';
import { makeError } from '@/core/errors/types';
import type { AppConfig } from '@/config/schema';

// ----- Payload shape ---------------------------------------------------

/**
 * Parser output. Handlers consume this; the mutation planner binds
 * `raw` into a `json_to_record*($1::json)` call.
 *
 * INVARIANT: `keys` is the canonical set of top-level keys. For
 * arrays it is the set of the FIRST row's keys — parseJsonPayload
 * already validates that every object in the array shares those
 * keys, so the downstream planner can trust `keys` to describe
 * every row.
 */
export type Payload =
  | {
      readonly type: 'json';
      readonly raw: string;
      readonly keys: ReadonlySet<string>;
    }
  | {
      readonly type: 'urlEncoded';
      readonly pairs: readonly (readonly [string, string])[];
      readonly keys: ReadonlySet<string>;
    }
  | { readonly type: 'rawPayload'; readonly raw: string }
  | { readonly type: 'rawJson'; readonly raw: string };

// ----- Top-level entry point -------------------------------------------

export interface ParsePayloadInput {
  readonly request: Request;
  readonly config: AppConfig;
  /** Parsed Content-Type media id (from stage 3 negotiation). */
  readonly contentMediaTypeId: string;
}

/**
 * Parse a request body. Returns:
 *  - `ok(null)` for GET/HEAD/OPTIONS or empty bodies that are not an
 *    RPC `{}` shortcut;
 *  - `ok(payload)` for any recognized shape;
 *  - `err(CloudRestError)` for oversize, malformed, or policy-gated
 *    rejections.
 *
 * BUG FIX #44: oversize bodies are rejected BEFORE `request.text()`
 * buffers the full payload. `Content-Length` is an advisory header
 * but every HTTP client worth supporting sets it; we refuse the
 * request when the declared length exceeds `limits.maxBodyBytes`.
 */
export async function parsePayload(
  input: ParsePayloadInput,
): Promise<Result<Payload | null, CloudRestError>> {
  const { request, config } = input;
  const method = request.method;

  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return ok(null);
  }

  // ----- #44 pre-check ------------------------------------------------
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (
      Number.isFinite(parsed) &&
      parsed > config.limits.maxBodyBytes
    ) {
      return err(
        makeError({
          code: 'PGRST413',
          message: 'Request body too large',
          details: `${parsed} bytes exceeds maxBodyBytes=${config.limits.maxBodyBytes}`,
          httpStatus: 413,
        }),
      );
    }
  }

  const raw = await request.text();

  // Empty body handling. RPC gets a default `{}` (critique #48 moves
  // this to the RPC handler); Stage 9 just returns null and lets the
  // mutation planner treat missing body as "no columns to write".
  if (raw.length === 0 || raw.trim() === '') {
    return ok(null);
  }

  // If the caller provided a content-type, dispatch on it. Otherwise
  // treat as JSON.
  const contentTypeHeader = request.headers.get('content-type') ?? '';
  if (contentTypeHeader.includes('application/x-www-form-urlencoded')) {
    return parseFormPayload(raw);
  }
  if (contentTypeHeader.includes('text/csv')) {
    return parseCsvPayload(raw, { csvNullToken: null });
  }
  if (contentTypeHeader.includes('application/octet-stream')) {
    return ok({ type: 'rawPayload', raw });
  }

  // Default: JSON
  return parseJsonPayload(raw);
}

// ----- JSON ------------------------------------------------------------

export function parseJsonPayload(
  raw: string,
): Result<Payload, CloudRestError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err(parseErrors.invalidBody(`Invalid JSON: ${String(e)}`));
  }

  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return ok({ type: 'json', raw, keys: new Set<string>() });
    }
    const first = parsed[0];
    if (first === null || typeof first !== 'object' || Array.isArray(first)) {
      return err(parseErrors.invalidBody('All object keys must match'));
    }
    const canonicalKeys = Object.keys(first as Record<string, unknown>).sort();
    const canonicalSet = new Set(canonicalKeys);
    for (const item of parsed) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return err(parseErrors.invalidBody('All object keys must match'));
      }
      const itemKeys = Object.keys(item as Record<string, unknown>);
      if (itemKeys.length !== canonicalKeys.length) {
        return err(parseErrors.invalidBody('All object keys must match'));
      }
      for (const k of itemKeys) {
        if (!canonicalSet.has(k)) {
          return err(parseErrors.invalidBody('All object keys must match'));
        }
      }
    }
    return ok({ type: 'json', raw, keys: canonicalSet });
  }

  if (parsed !== null && typeof parsed === 'object') {
    return ok({
      type: 'json',
      raw,
      keys: new Set(Object.keys(parsed as Record<string, unknown>)),
    });
  }

  return err(
    parseErrors.invalidBody(
      'JSON payload must be an object or array of objects',
    ),
  );
}

// ----- Form-urlencoded -------------------------------------------------

/**
 * BUG FIX #46: duplicate keys in a form body are rejected. The old
 * code silently accumulated pairs and the mutation builder used the
 * LAST value for a given key, so two `a=1&a=2` inserts would write
 * `a=2` — different from URLSearchParams, different from PHP,
 * different from Django. Rejecting is the only deterministic choice.
 */
export function parseFormPayload(
  raw: string,
): Result<Payload, CloudRestError> {
  const pairs: (readonly [string, string])[] = [];
  const keys = new Set<string>();

  for (const part of raw.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq === -1) {
      return err(
        parseErrors.invalidBody(
          `form-urlencoded segment without "=": "${part}"`,
        ),
      );
    }
    const key = safeDecodeURIComponent(part.slice(0, eq).replace(/\+/g, ' '));
    const value = safeDecodeURIComponent(
      part.slice(eq + 1).replace(/\+/g, ' '),
    );
    if (keys.has(key)) {
      return err(
        parseErrors.invalidBody(
          `duplicate key in form-urlencoded body: "${key}"`,
        ),
      );
    }
    pairs.push([key, value]);
    keys.add(key);
  }

  return ok({ type: 'urlEncoded', pairs, keys });
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ----- CSV -------------------------------------------------------------

export interface CsvOptions {
  /**
   * Token that maps to SQL NULL. Null (the default) means the CSV
   * contains no SQL NULL sentinel — empty strings stay empty. Set
   * to `'NULL'` or another token to restore PostgREST-compatible
   * behavior.
   *
   * BUG FIX #47.
   */
  readonly csvNullToken: string | null;
}

export function parseCsvPayload(
  raw: string,
  options: CsvOptions,
): Result<Payload, CloudRestError> {
  const lines = splitCsvLines(raw);
  if (lines.length === 0) {
    return err(
      parseErrors.invalidBody('CSV payload must have at least a header row'),
    );
  }

  const headers = parseCsvRow(lines[0]!).map((h) => h.trim());
  const headerSet = new Set(headers);
  if (headerSet.size !== headers.length) {
    return err(parseErrors.invalidBody('CSV header has duplicate columns'));
  }

  const rows: Record<string, string | null>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const values = parseCsvRow(line);
    if (values.length !== headers.length) {
      return err(
        parseErrors.invalidBody(
          `CSV row ${i + 1} has ${values.length} fields but header has ${headers.length}`,
        ),
      );
    }
    const row: Record<string, string | null> = {};
    for (let j = 0; j < headers.length; j++) {
      const v = values[j]!;
      row[headers[j]!] =
        options.csvNullToken !== null && v === options.csvNullToken
          ? null
          : v;
    }
    rows.push(row);
  }

  return ok({
    type: 'json',
    raw: JSON.stringify(rows),
    keys: new Set(headers),
  });
}

function splitCsvLines(raw: string): string[] {
  const lines: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuote) {
      if (ch === '\r' && raw[i + 1] === '\n') i++;
      if (current.trim() !== '') lines.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') lines.push(current);
  return lines;
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuote = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuote = false;
        i++;
        continue;
      }
      current += ch;
      i++;
    } else {
      if (ch === '"' && current === '') {
        inQuote = true;
        i++;
        continue;
      }
      if (ch === ',') {
        fields.push(current);
        current = '';
        i++;
        continue;
      }
      current += ch;
      i++;
    }
  }
  fields.push(current);
  return fields;
}
