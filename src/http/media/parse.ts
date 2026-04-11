// Media-type parsing for Accept and Content-Type headers.
//
// COMPAT: Follows RFC 7231 §5.3.1 for q-values and Accept semantics.
// Multi-value Accept headers are split on ',', each entry parsed for
// type/subtype/parameters, sorted by quality then specificity.
//
// INVARIANT: This module only parses. It never chooses which media type
// to respond with; that is `http/media/negotiate.ts`.

import { MEDIA_TYPES, type MediaType, type MediaTypeId } from './types';

/**
 * Parse an Accept header into an ordered list of canonical MediaType
 * tokens. Unknown tokens are dropped (they cannot be served, so they
 * cannot participate in negotiation).
 *
 * COMPAT: Matches PostgREST's sort order: descending by quality, then
 * more specific over less specific.
 *
 * Empty or missing Accept maps to `[{ id: 'any' }]`, matching PostgREST's
 * behavior of treating missing Accept as "client takes whatever".
 */
export function parseAcceptHeader(raw: string | null): MediaType[] {
  if (!raw || raw.trim() === '') return [acceptAny()];

  const parts = splitTopLevel(raw);
  const parsed: MediaType[] = [];

  for (const part of parts) {
    const token = parseSingleMediaType(part);
    if (!token) continue;
    if (token.quality <= 0) continue; // q=0 means "not acceptable"
    parsed.push(token);
  }

  if (parsed.length === 0) return [];

  // Sort by quality desc, then by specificity (concrete > */* > *).
  parsed.sort((left, right) => {
    if (left.quality !== right.quality) return right.quality - left.quality;
    return specificity(right) - specificity(left);
  });

  return parsed;
}

/**
 * Parse a Content-Type header into a single canonical MediaType token.
 *
 * Unknown or malformed tokens fall back to `any` (PostgREST-compatible
 * lenient fallback for writes).
 */
export function parseContentTypeHeader(raw: string | null): MediaType {
  if (!raw || raw.trim() === '') return acceptAny();
  const first = splitTopLevel(raw)[0];
  if (!first) return acceptAny();
  const token = parseSingleMediaType(first);
  return token ?? acceptAny();
}

// ----- Internal helpers -------------------------------------------------

function acceptAny(): MediaType {
  return {
    id: 'any',
    type: '*',
    subtype: '*',
    params: {},
    quality: 1,
  };
}

/**
 * Split a comma-separated list, ignoring commas inside parameter values
 * (there shouldn't be any, but be defensive).
 */
function splitTopLevel(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseSingleMediaType(raw: string): MediaType | null {
  const segments = raw.split(';').map((s) => s.trim());
  const typePart = segments[0];
  if (!typePart) return null;

  const slashIdx = typePart.indexOf('/');
  if (slashIdx < 0) return null;
  const type = typePart.slice(0, slashIdx).toLowerCase();
  const subtype = typePart.slice(slashIdx + 1).toLowerCase();
  if (!type || !subtype) return null;

  const params: Record<string, string> = {};
  let quality = 1;

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const key = seg.slice(0, eq).trim().toLowerCase();
    const rawValue = seg.slice(eq + 1).trim();
    const value = stripQuotes(rawValue);
    if (key === 'q') {
      quality = parseQuality(value);
    } else if (key) {
      params[key] = value;
    }
  }

  const match = resolveMediaTypeId(type, subtype, params);
  if (!match) return null;

  return {
    id: match,
    type,
    subtype,
    params,
    quality,
  };
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * RFC 7231 §5.3.1: q must be 0.0 to 1.0; invalid becomes 0 (unacceptable).
 */
function parseQuality(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Resolve a parsed (type, subtype, params) tuple to a canonical
 * MediaTypeId, honoring subtype aliases and required params.
 */
function resolveMediaTypeId(
  type: string,
  subtype: string,
  params: Readonly<Record<string, string>>,
): MediaTypeId | null {
  if (type === '*' && subtype === '*') return 'any';

  // Prefer entries with matching required params first (so the
  // `-stripped` variants beat the plain ones).
  const candidates = MEDIA_TYPES.filter((def) => {
    if (def.type !== type) return false;
    if (def.subtype !== subtype && !(def.aliasSubtypes?.includes(subtype))) {
      return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;

  for (const def of candidates) {
    if (def.requiredParams) {
      const ok = Object.entries(def.requiredParams).every(
        ([key, value]) => params[key] === value,
      );
      if (ok) return def.id;
    }
  }
  // Fall back to any candidate without required params.
  const plain = candidates.find((def) => !def.requiredParams);
  return plain?.id ?? null;
}

function specificity(mt: MediaType): number {
  if (mt.type === '*' && mt.subtype === '*') return 0;
  if (mt.subtype === '*') return 1;
  // Honor param count as a tiebreaker so that
  // `application/vnd.pgrst.object+json;nulls=stripped` beats the plain
  // variant.
  return 2 + Object.keys(mt.params).length;
}
