// Body formatters for each output media type.
//
// INVARIANT: Every MediaTypeId that appears in the registry as a response
// format MUST have a formatter here. Adding a new format is:
//   1. Add id to types.ts
//   2. Add formatter below
//   3. Add a unit test
//
// CSV, singular, stripNulls, and GeoJSON semantics match
// PostgREST. The CSV column set is the union of all row keys (not just
// the first row's keys), so sparse objects round-trip.

import type { MediaTypeId } from './types';

/**
 * Result of `formatBody`. Most formatters always return a body, but
 * singular has a cardinality constraint: the inner subquery must
 * return exactly one row. Non-conforming counts surface as a typed
 * error so the caller can map them to PGRST116 (406) instead of
 * silently returning the first row.
 *
 * The old signature was `string` and `singularBody` just unwrapped
 * `parsed[0] ?? null`. A query that matched 5 rows with
 * `Accept: application/vnd.pgrst.object+json` would return whichever
 * row happened to be first — potentially leaking data the user didn't
 * ask for and hiding the "more than one" condition.
 */
export type FormatBodyResult =
  | { readonly kind: 'ok'; readonly body: string }
  | {
      readonly kind: 'singular-cardinality';
      readonly rowCount: number;
    };

/**
 * Format a raw JSON-array body string for the chosen output media
 * type. The input must be a JSON array (what Postgres `json_agg`
 * produces). Non-array inputs fall through unchanged for
 * lenient-pass-through formats, matching PostgREST's behavior.
 */
export function formatBody(
  mediaId: MediaTypeId,
  rawJsonArrayBody: string,
): FormatBodyResult {
  switch (mediaId) {
    case 'json':
    case 'any':
    case 'openapi':
    case 'array':
    case 'octet-stream':
    case 'plan-json':
    case 'plan-text':
      return { kind: 'ok', body: rawJsonArrayBody };
    case 'ndjson':
      return { kind: 'ok', body: jsonArrayToNdjson(rawJsonArrayBody) };
    case 'csv':
      return { kind: 'ok', body: jsonArrayToCsv(rawJsonArrayBody) };
    case 'singular':
      return singularBody(rawJsonArrayBody);
    case 'singular-stripped':
      return singularBody(stripNulls(rawJsonArrayBody));
    case 'array-stripped':
      return { kind: 'ok', body: stripNulls(rawJsonArrayBody) };
    case 'geojson':
      return { kind: 'ok', body: jsonArrayToGeoJson(rawJsonArrayBody) };
  }
}

// ----- singular ---------------------------------------------------------

function singularBody(raw: string): FormatBodyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Lenient pass-through — mirror the other formatters. Non-JSON
    // input means the executor emitted something unusual; let the
    // client see it rather than inventing a cardinality error.
    return { kind: 'ok', body: raw };
  }
  if (!Array.isArray(parsed)) {
    return { kind: 'ok', body: raw };
  }
  // Enforce the cardinality contract. 0 or 2+ rows is PGRST116 at the caller.
  if (parsed.length !== 1) {
    return { kind: 'singular-cardinality', rowCount: parsed.length };
  }
  return { kind: 'ok', body: JSON.stringify(parsed[0]) };
}

// ----- ndjson -----------------------------------------------------------

/**
 * Convert a JSON array of rows into newline-delimited JSON (one row
 * per line, no trailing newline on the last row).
 *
 * Converts the raw JSON array to newline-delimited rows. Without this,
 * `application/x-ndjson` responses would be syntactically JSON arrays
 * — wrong content type for the payload and not parseable by
 * ndjson-aware clients.
 */
function jsonArrayToNdjson(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!Array.isArray(parsed)) return raw;
  return parsed.map((row) => JSON.stringify(row)).join('\n');
}

// ----- stripNulls -------------------------------------------------------

function stripNulls(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return raw;
    const stripped = parsed.map((row) => {
      if (row === null || typeof row !== 'object') return row;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
        if (v !== null) out[k] = v;
      }
      return out;
    });
    return JSON.stringify(stripped);
  } catch {
    return raw;
  }
}

// ----- csv --------------------------------------------------------------

function jsonArrayToCsv(raw: string): string {
  let rows: Record<string, unknown>[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return '';
    rows = parsed.filter(
      (r): r is Record<string, unknown> => r !== null && typeof r === 'object',
    );
  } catch {
    return '';
  }

  if (rows.length === 0) return '';

  // Union of all keys across all rows — sparse rows round-trip correctly.
  const columnSet = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) columnSet.add(key);
  }
  const columns = [...columnSet];

  const lines: string[] = [];
  lines.push(columns.map(csvEscape).join(','));
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(row[c])).join(','));
  }
  return lines.join('\n');
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ----- geojson ----------------------------------------------------------

/**
 * Convert a JSON array of rows into a GeoJSON FeatureCollection.
 *
 * Auto-detects the first column whose value is an object with `type`
 * and `coordinates` — that becomes the feature geometry; every other
 * column becomes a property.
 */
function jsonArrayToGeoJson(raw: string): string {
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length === 0) {
      return JSON.stringify({ type: 'FeatureCollection', features: [] });
    }
    const first = rows[0];
    let geoCol: string | null = null;
    if (first && typeof first === 'object') {
      for (const [key, value] of Object.entries(first as Record<string, unknown>)) {
        if (
          value &&
          typeof value === 'object' &&
          'type' in (value as Record<string, unknown>) &&
          'coordinates' in (value as Record<string, unknown>)
        ) {
          geoCol = key;
          break;
        }
      }
    }

    const features = (rows as Record<string, unknown>[]).map((row) => {
      const properties: Record<string, unknown> = {};
      let geometry: unknown = null;
      for (const [key, value] of Object.entries(row)) {
        if (key === geoCol) geometry = value;
        else properties[key] = value;
      }
      return { type: 'Feature', geometry, properties };
    });

    return JSON.stringify({ type: 'FeatureCollection', features });
  } catch {
    return raw;
  }
}
