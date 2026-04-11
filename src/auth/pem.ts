// PEM → CryptoKey helpers (RSA / ECDSA).
//
// Stage 8a: file move only. Behavior-preserving port of
// `algToHash`, `algToEcCurve`, `pemToArrayBuffer`, and
// `importPemKey` from cloudrest-public/src/auth.ts.
//
// The cached key pair at module scope mirrors the old behavior — a
// refactor that replaces this with an LRU lands in stage 11.

// ----- Module-level cache ----------------------------------------------
//
// BUG FIX (#GG5): the cache used to be keyed only by the PEM text,
// but the imported WebCrypto key bakes in the hash algorithm
// (`SHA-256` vs `SHA-384` vs `SHA-512`). After an RS256 import, a
// later RS512 token with the same PEM would hit the cache and verify
// against the wrong hash — effectively downgrading the algorithm.
// The cache is now keyed by `(pem, alg)`.

const pemKeyCache = new Map<string, CryptoKey>();

function pemCacheKey(pem: string, alg: string): string {
  return `${alg}\0${pem}`;
}

/**
 * Clear the cached PEM key. Tests call this to reset state between
 * runs; production code never clears, because a PEM rotation requires
 * a worker redeploy.
 */
export function __resetPemCacheForTest(): void {
  pemKeyCache.clear();
}

// ----- Algorithm helpers -----------------------------------------------

// BUG FIX (#GG4): the old `algToHash` matched by suffix, so any
// string ending in `256`/`384`/`512` silently mapped to a SHA
// variant — `RS999256` or `ESfoo512` would verify as SHA-256/512
// instead of being rejected. Map only the exact JWS Alg names
// defined in RFC 7518 §3.
const ALG_TO_HASH: ReadonlyMap<string, string> = new Map([
  ['HS256', 'SHA-256'],
  ['HS384', 'SHA-384'],
  ['HS512', 'SHA-512'],
  ['RS256', 'SHA-256'],
  ['RS384', 'SHA-384'],
  ['RS512', 'SHA-512'],
  ['ES256', 'SHA-256'],
  ['ES384', 'SHA-384'],
  ['ES512', 'SHA-512'],
]);

/** Map a JWT `alg` to a Web Crypto hash name. Null for unknown. */
export function algToHash(alg: string): string | null {
  return ALG_TO_HASH.get(alg) ?? null;
}

const RSA_ALGS: ReadonlySet<string> = new Set(['RS256', 'RS384', 'RS512']);
const EC_ALGS: ReadonlySet<string> = new Set(['ES256', 'ES384', 'ES512']);
const HMAC_ALGS: ReadonlySet<string> = new Set(['HS256', 'HS384', 'HS512']);

export function isRsaAlg(alg: string): boolean {
  return RSA_ALGS.has(alg);
}
export function isEcAlg(alg: string): boolean {
  return EC_ALGS.has(alg);
}
export function isHmacAlg(alg: string): boolean {
  return HMAC_ALGS.has(alg);
}

/** Map an ECDSA JWT `alg` to a named curve. Null for non-EC algs. */
export function algToEcCurve(alg: string): string | null {
  switch (alg) {
    case 'ES256':
      return 'P-256';
    case 'ES384':
      return 'P-384';
    case 'ES512':
      // Note: ES512 uses P-521, not P-512.
      return 'P-521';
    default:
      return null;
  }
}

// ----- PEM parsing ------------------------------------------------------

/** Strip the PEM banner and base64-decode the body into an ArrayBuffer. */
export function pemToArrayBuffer(pem: string): ArrayBuffer {
  const lines = pem.split('\n');
  const b64 = lines.filter((l) => !l.startsWith('-----')).join('');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Import a PEM public key as a Web Crypto CryptoKey. Returns null when
 * the algorithm is unsupported or the PEM can't be parsed.
 *
 * BUG FIX (#GG4/#GG5): only strict JWS `alg` names from the RFC 7518
 * allowlist are accepted, and the cache is keyed by BOTH the PEM text
 * AND the alg so a later token with the same PEM but a different
 * alg cannot reuse a key imported with the wrong hash.
 */
export async function importPemKey(
  pem: string,
  alg: string,
): Promise<CryptoKey | null> {
  const cacheKey = pemCacheKey(pem, alg);
  const cached = pemKeyCache.get(cacheKey);
  if (cached) return cached;

  const hash = algToHash(alg);
  if (!hash) return null;

  const keyData = pemToArrayBuffer(pem);
  let key: CryptoKey;

  if (isRsaAlg(alg)) {
    key = await crypto.subtle.importKey(
      'spki',
      keyData,
      { name: 'RSASSA-PKCS1-v1_5', hash },
      false,
      ['verify'],
    );
  } else if (isEcAlg(alg)) {
    const namedCurve = algToEcCurve(alg);
    if (!namedCurve) return null;
    key = await crypto.subtle.importKey(
      'spki',
      keyData,
      { name: 'ECDSA', namedCurve },
      false,
      ['verify'],
    );
  } else {
    return null;
  }

  pemKeyCache.set(cacheKey, key);
  return key;
}
