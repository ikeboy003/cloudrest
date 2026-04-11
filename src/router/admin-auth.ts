// Admin auth — constant-time comparison against `ADMIN_AUTH_TOKEN`.
//
// STAGE 16 (critique #83):
//   - Every `/_admin/*` route requires the `ADMIN_AUTH_TOKEN` env
//     var to be set AND for the request's `Authorization: Bearer
//     <token>` to match it with a constant-time comparison.
//   - When the env var is absent, the admin path is disabled
//     entirely (fails closed).
//
// INVARIANT: the comparison MUST be constant-time. A naive
// `expected === actual` leaks length via early exit.

/**
 * Compare `a` and `b` byte-by-byte in constant time over `max(len(a),
 * len(b))` characters. Length mismatch is detected without an early
 * exit so timing-based oracles can't distinguish "wrong length" from
 * "wrong content".
 */
export function constantTimeEquals(a: string, b: string): boolean {
  // Widen the shorter string to the length of the longer one; any
  // XOR of the padding byte against the real byte still contributes
  // to `mismatch`, so a short candidate is detected deterministically.
  const max = Math.max(a.length, b.length);
  let mismatch = a.length === b.length ? 0 : 1;
  for (let i = 0; i < max; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= ca ^ cb;
  }
  return mismatch === 0;
}

/**
 * Decide whether an admin request is authorized.
 *
 * - `expected === undefined` → admin is disabled; ALL admin paths
 *   return "not authorized" (fail closed).
 * - Bearer token missing or mismatched → "not authorized".
 */
export function isAdminAuthorized(
  expected: string | undefined,
  authHeader: string | null,
): boolean {
  if (expected === undefined || expected === '') return false;
  if (authHeader === null) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return constantTimeEquals(expected, match[1]!.trim());
}
