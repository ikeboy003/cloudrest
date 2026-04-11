// Base64 + base64url decode helpers for JWT handling.
//
// INVARIANT: The rewrite carries TWO decoders because JWTs use
// base64url (the header/payload/signature) while raw HMAC secrets
// may use either form — PostgREST's `JWT_SECRET_IS_BASE64` uses a
// lenient decoder that accepts padded, unpadded, standard, and
// URL-safe alphabets.
//
// Stage 8a: file move only. Behavior-preserving port of the helpers
// at the bottom of cloudrest-public/src/auth.ts.

/**
 * Decode a base64url string to its binary form as a JS string.
 * Callers that need a `Uint8Array` should use `base64UrlToBuffer`.
 */
export function base64UrlDecode(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded);
}

/** Decode a base64url string into a `Uint8Array`. */
export function base64UrlToBuffer(str: string): Uint8Array {
  const binary = base64UrlDecode(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Decode a lenient base64 string — PostgREST accepts standard (+/) and
 * URL-safe (-_) alphabets, padded or unpadded. Used for
 * `JWT_SECRET_IS_BASE64=true` HMAC keys.
 */
export function base64ToBuffer(str: string): Uint8Array {
  let normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  if (pad === 2) normalized += '==';
  else if (pad === 3) normalized += '=';
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
