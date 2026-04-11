// Media-type registry.
//
// INVARIANT: Every media type CloudREST understands appears in the
// MEDIA_TYPES table exactly once. Adding a new response format means
// adding a table entry, not grep-hunting across parser, response, and
// router files. See CONSTITUTION § "Where do I add X?".
//
// COMPAT: The vendor-specific media types (application/vnd.pgrst.*) come
// from PostgREST. Their quality q-values and stripped-nulls semantics
// match PostgREST.

export type MediaTypeId =
  | 'any'
  | 'json'
  | 'csv'
  | 'openapi'
  | 'singular'
  | 'singular-stripped'
  | 'array'
  | 'array-stripped'
  | 'plan-json'
  | 'plan-text'
  | 'octet-stream'
  | 'ndjson'
  | 'geojson';

/**
 * A structured media type token. `params` carries parameters parsed from
 * the Accept or Content-Type header (e.g. `nulls=stripped`, `charset`,
 * `q`). The `id` field is CloudREST's canonical token.
 */
export interface MediaType {
  readonly id: MediaTypeId;
  readonly type: string; // e.g. "application"
  readonly subtype: string; // e.g. "vnd.pgrst.array+json"
  readonly params: Readonly<Record<string, string>>;
  /** RFC 7231 quality value, 0.0–1.0. 1.0 if not specified. */
  readonly quality: number;
}

interface MediaTypeDefinition {
  readonly id: MediaTypeId;
  readonly type: string;
  readonly subtype: string;
  /** Alternate subtype tokens accepted on input but normalized to `subtype`. */
  readonly aliasSubtypes?: readonly string[];
  /** Required parameters on input. */
  readonly requiredParams?: Readonly<Record<string, string>>;
  /** Allowed optional parameter keys (other keys are preserved as-is). */
  readonly allowedParamKeys?: readonly string[];
  /** Content-Type response header value (without charset). */
  readonly contentType: string;
  /** Should a charset=utf-8 param be appended on response? */
  readonly appendCharset: boolean;
}

/**
 * The full registry of media types CloudREST can parse and format.
 *
 * To add a new format:
 *   1. Add a new `MediaTypeId`.
 *   2. Add a row below.
 *   3. Add a formatter in `http/media/format.ts`.
 *
 * COMPAT notes:
 *   - `application/vnd.pgrst.plan` (bare) aliases to `+text` per PostgREST.
 *   - `application/vnd.pgrst.array` (bare) aliases to `+json`.
 *   - `nulls=stripped` is an optional param on singular and array variants.
 */
export const MEDIA_TYPES: readonly MediaTypeDefinition[] = [
  {
    id: 'any',
    type: '*',
    subtype: '*',
    contentType: 'application/json',
    appendCharset: true,
  },
  {
    id: 'json',
    type: 'application',
    subtype: 'json',
    contentType: 'application/json',
    appendCharset: true,
  },
  {
    id: 'csv',
    type: 'text',
    subtype: 'csv',
    contentType: 'text/csv',
    appendCharset: true,
  },
  {
    id: 'openapi',
    type: 'application',
    subtype: 'openapi+json',
    contentType: 'application/openapi+json',
    appendCharset: true,
  },
  {
    id: 'singular',
    type: 'application',
    subtype: 'vnd.pgrst.object+json',
    aliasSubtypes: ['vnd.pgrst.object'],
    allowedParamKeys: ['nulls'],
    contentType: 'application/vnd.pgrst.object+json',
    appendCharset: true,
  },
  {
    id: 'singular-stripped',
    type: 'application',
    subtype: 'vnd.pgrst.object+json',
    aliasSubtypes: ['vnd.pgrst.object'],
    requiredParams: { nulls: 'stripped' },
    allowedParamKeys: ['nulls'],
    contentType: 'application/vnd.pgrst.object+json;nulls=stripped',
    appendCharset: true,
  },
  {
    id: 'array',
    type: 'application',
    subtype: 'vnd.pgrst.array+json',
    aliasSubtypes: ['vnd.pgrst.array'],
    allowedParamKeys: ['nulls'],
    contentType: 'application/vnd.pgrst.array+json',
    appendCharset: true,
  },
  {
    id: 'array-stripped',
    type: 'application',
    subtype: 'vnd.pgrst.array+json',
    aliasSubtypes: ['vnd.pgrst.array'],
    requiredParams: { nulls: 'stripped' },
    allowedParamKeys: ['nulls'],
    contentType: 'application/vnd.pgrst.array+json;nulls=stripped',
    appendCharset: true,
  },
  {
    id: 'plan-json',
    type: 'application',
    subtype: 'vnd.pgrst.plan+json',
    contentType: 'application/vnd.pgrst.plan+json',
    appendCharset: true,
  },
  {
    id: 'plan-text',
    type: 'application',
    subtype: 'vnd.pgrst.plan+text',
    // COMPAT: bare `application/vnd.pgrst.plan` aliases to plan+text per PostgREST.
    aliasSubtypes: ['vnd.pgrst.plan'],
    contentType: 'application/vnd.pgrst.plan+text',
    appendCharset: true,
  },
  {
    id: 'octet-stream',
    type: 'application',
    subtype: 'octet-stream',
    contentType: 'application/octet-stream',
    appendCharset: false,
  },
  {
    id: 'ndjson',
    type: 'application',
    subtype: 'x-ndjson',
    contentType: 'application/x-ndjson',
    appendCharset: true,
  },
  {
    id: 'geojson',
    type: 'application',
    subtype: 'geo+json',
    contentType: 'application/geo+json',
    appendCharset: true,
  },
];

/**
 * Return the Content-Type header string for an output media id.
 */
export function contentTypeFor(id: MediaTypeId): string {
  const def = MEDIA_TYPES.find((m) => m.id === id);
  if (!def) return 'application/octet-stream';
  return def.appendCharset ? `${def.contentType}; charset=utf-8` : def.contentType;
}

/**
 * Return the registry entry for an id. Used by tests and the negotiator.
 */
export function lookupById(id: MediaTypeId): MediaTypeDefinition | undefined {
  return MEDIA_TYPES.find((m) => m.id === id);
}

export type { MediaTypeDefinition };
