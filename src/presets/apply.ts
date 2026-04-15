// Preset URL rewriter.
//
// When a request arrives with `?view=<name>` and the config has a
// matching preset, the preset's filters, order, and limit are
// merged onto the URL before the normal query-param parser runs.
// The `view` key itself is removed after expansion.
//
// INVARIANT: preset values DO NOT override a user-supplied value
// for the same key. A request like `?view=feed&limit=5` keeps
// `limit=5` even if the preset declares `limit.20`. Presets are
// defaults, not overrides.

import type { QueryPreset } from './parse';

/**
 * Return a new URL with the preset expanded, or the original URL
 * when no preset applies.
 *
 * The original URL is never mutated.
 */
export function applyPreset(
  url: URL,
  presets: ReadonlyMap<string, QueryPreset>,
): URL {
  if (presets.size === 0) return url;
  const viewName = url.searchParams.get('view');
  if (viewName === null) return url;
  const preset = presets.get(viewName);
  if (preset === undefined) return url;

  const rewritten = new URL(url.toString());
  rewritten.searchParams.delete('view');

  // Filters: only set when the user didn't already provide that
  // column as a filter key.
  for (const [col, value] of preset.filters) {
    if (!rewritten.searchParams.has(col)) {
      rewritten.searchParams.append(col, value);
    }
  }

  // Order — only set when absent.
  if (preset.order !== null && !rewritten.searchParams.has('order')) {
    rewritten.searchParams.set('order', preset.order);
  }

  // Limit — only set when absent.
  if (preset.limit !== null && !rewritten.searchParams.has('limit')) {
    rewritten.searchParams.set('limit', String(preset.limit));
  }

  return rewritten;
}
