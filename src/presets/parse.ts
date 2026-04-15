// `QUERY_PRESETS` env-var parser.
//
// Format (comma-separated):
//   name:filter1|filter2|order.col.dir|limit.N
//
// A filter segment is `col.op.value`. The first dot separates the
// column name from the rest, which becomes the query-param value
// when the preset is applied (so `price.gt.10` becomes
// `?price=gt.10`).
//
// `order.col.dir` segments set the `?order=` value.
// `limit.N` segments set the `?limit=` value.
//
// The parser is permissive — unrecognized segments are silently
// dropped. A malformed entry becomes an empty preset rather than a
// parse error so a single bad preset can't crash config load.

// `QueryPreset` lives on `@/config/schema` so the type reaches
// `AppConfig` without a cycle. Re-exported here for ergonomic
// `{ parsePresets, QueryPreset }` imports.
import type { QueryPreset } from '@/config/schema';
export type { QueryPreset } from '@/config/schema';

/**
 * Parse a `QUERY_PRESETS` env string into a map of name → preset.
 * Returns an empty map for the empty string or undefined input.
 */
export function parsePresets(
  envVar: string | undefined,
): ReadonlyMap<string, QueryPreset> {
  const map = new Map<string, QueryPreset>();
  if (envVar === undefined || envVar.trim() === '') return map;

  for (const entry of envVar.split(',')) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx < 1) continue;

    const name = entry.slice(0, colonIdx).trim();
    if (name === '') continue;

    const segments = entry.slice(colonIdx + 1).split('|');
    const filters: (readonly [string, string])[] = [];
    let order: string | null = null;
    let limit: number | null = null;

    for (const rawSeg of segments) {
      const seg = rawSeg.trim();
      if (seg === '') continue;

      if (seg.startsWith('order.')) {
        order = seg.slice('order.'.length);
        continue;
      }
      if (seg.startsWith('limit.')) {
        const parsed = Number.parseInt(seg.slice('limit.'.length), 10);
        if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
        continue;
      }
      // Filter: first dot separates column from `op.value`.
      const dotIdx = seg.indexOf('.');
      if (dotIdx < 1) continue;
      filters.push([seg.slice(0, dotIdx), seg.slice(dotIdx + 1)]);
    }

    map.set(name, { filters, order, limit });
  }

  return map;
}
