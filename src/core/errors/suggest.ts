// "Did you mean?" helper used by schema errors to suggest close matches
// for unknown table/column/function names.
//
// Small, self-contained, dependency-free. Lives in core/errors/ because
// only error factories use it.

/**
 * Compute the Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]!;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j]! + 1, // deletion
        dp[j - 1]! + 1, // insertion
        prev + cost, // substitution
      );
      prev = temp;
    }
  }

  return dp[n]!;
}

/**
 * Return the candidate closest to `query` within `maxDistance` edit
 * distance, or null if none qualify. Case-insensitive.
 */
export function fuzzyFind(
  query: string,
  candidates: readonly string[],
  maxDistance = 2,
): string | null {
  if (candidates.length === 0) return null;
  const lower = query.toLowerCase();
  let best: string | null = null;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = levenshtein(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= maxDistance ? best : null;
}
