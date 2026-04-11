// Body formatters for each output media type.
//
// INVARIANT: Every MediaTypeId that appears in the registry as a response
// format MUST have a formatter here. Adding a new format is:
//   1. Add id to types.ts
//   2. Add formatter below
//   3. Add a unit test
//
// COMPAT: CSV, singular, stripNulls, and GeoJSON semantics match
// PostgREST. The CSV column set is the union of all row keys (not just
// the first row's keys), so sparse objects round-trip.

import type { MediaTypeId } from './types';

/**
 * Format a raw JSON-array body string for the chosen output media type.
 * Returns the formatted string.
 *
 * The input must be a JSON array (what Postgres `json_agg` produces). If
 * it is not, formatters that need array semantics pass through unchanged
 * — matching PostgREST's lenient behavior.
 */
export function formatBody(mediaId: MediaTypeId, rawJsonArrayBody: string): string {
  switch (mediaId) {
    case 'json':
    case 'any':
    case 'openapi':
    case 'array':
    case 'ndjson':
    case 'octet-stream':
    case 'plan-json':
    case 'plan-text':
      return rawJsonArrayBody;
    case 'csv':
      return jsonArrayToCsv(rawJsonArrayBody);
    case 'singular':
      return singularBody(rawJsonArrayBody);
    case 'singular-stripped':
      return singularBody(stripNulls(rawJsonArrayBody));
    case 'array-stripped':
      return stripNulls(rawJsonArrayBody);
    case 'geojson':
      return jsonArrayToGeoJson(rawJsonArrayBody);
  }
}

// ----- singular ---------------------------------------------------------

function singularBody(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return raw;
    return JSON.stringify(parsed[0] ?? null);
  } catch {
    return raw;
  }
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
