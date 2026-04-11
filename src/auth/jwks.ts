// JWKS fetch + key import.
//
// Stage 8a: file move only. Behavior-preserving port of `fetchJwks`
// and `getJwksKey` from cloudrest-public/src/auth.ts.
//
// INVARIANT: The module-level cache is keyed by URI. A refresh clears
// the imported-key cache — Stage 11's "versioned by fetch timestamp"
// fix lives in a later diff.

import { algToEcCurve, algToHash, isEcAlg, isHmacAlg, isRsaAlg } from './pem';

// ----- Types -----------------------------------------------------------

export interface JwkWithKid extends JsonWebKey {
  readonly kid?: string;
  readonly kty: string;
  readonly alg?: string;
  readonly use?: string;
}

interface JwksResponse {
  readonly keys: readonly JwkWithKid[];
}

// ----- Module-level caches --------------------------------------------

const JWKS_TTL_MS = 5 * 60 * 1000;

let cachedJwks: { keys: readonly JwkWithKid[]; fetchedAt: number } | null = null;
let cachedJwksUri: string | null = null;
const jwkKeyCache = new Map<string, CryptoKey>();

/** Reset JWKS caches. Tests only — production code never clears. */
export function __resetJwksCacheForTest(): void {
  cachedJwks = null;
  cachedJwksUri = null;
  jwkKeyCache.clear();
}

// ----- Fetch + import --------------------------------------------------

/**
 * Fetch a JWKS document. Returns `null` on ANY failure (network,
 * non-2xx, invalid JSON, missing `keys` array) instead of throwing
 * so `authenticate` can surface a clean PGRST303 / 500 error to
 * the client without an unhandled exception escaping the Worker.
 *
 * BUG FIX (#GG6): the old code threw on non-OK HTTP responses and
 * on JSON-parse failures, and `verifySignature` did not catch them,
 * so a bad IdP response became an unhandled request failure.
 */
async function fetchJwks(
  uri: string,
  forceRefresh: boolean,
): Promise<readonly JwkWithKid[] | null> {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedJwks &&
    cachedJwksUri === uri &&
    now - cachedJwks.fetchedAt < JWKS_TTL_MS
  ) {
    return cachedJwks.keys;
  }

  let response: Response;
  try {
    response = await fetch(uri);
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let data: JwksResponse;
  try {
    data = (await response.json()) as JwksResponse;
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.keys)) return null;

  cachedJwks = { keys: data.keys, fetchedAt: now };
  cachedJwksUri = uri;
  // Clear imported key cache on refresh.
  jwkKeyCache.clear();
  return data.keys;
}

/**
 * Find a JWK matching `kid` (or the first `alg` match / unlabeled
 * key if `kid` is absent), import it, and return the CryptoKey.
 * Returns null when no key matches or the algorithm is unsupported.
 *
 * When `kid` is provided and the first fetch doesn't contain it, a
 * forced refresh handles key rotation.
 */
export async function getJwksKey(
  uri: string,
  kid: string | undefined,
  alg: string,
): Promise<CryptoKey | null> {
  // BUG FIX (#GG4): fail closed on any alg outside the strict JWS
  // allowlist so the loose `startsWith('RS')`/`startsWith('ES')`/
  // `startsWith('HS')` matches below cannot pick up junk.
  if (!isRsaAlg(alg) && !isEcAlg(alg) && !isHmacAlg(alg)) return null;

  let keys = await fetchJwks(uri, false);
  if (keys === null) return null;

  let jwk = kid
    ? keys.find((k) => k.kid === kid)
    : keys.find((k) => k.alg === alg || !k.alg);

  if (!jwk && kid) {
    const refreshed = await fetchJwks(uri, true);
    if (refreshed === null) return null;
    keys = refreshed;
    jwk = keys.find((k) => k.kid === kid);
  }

  if (!jwk) return null;

  // BUG FIX (#GG5): the old cache key was `kid ?? JSON.stringify(jwk)`,
  // with NO alg component. A second token using the same kid but a
  // different alg would reuse a CryptoKey imported with the wrong
  // hash — effectively downgrading the algorithm. Key the cache
  // by `(cache discriminator, alg)`.
  const discriminator = kid ?? JSON.stringify(jwk);
  const cacheKey = `${alg}\0${discriminator}`;
  const cached = jwkKeyCache.get(cacheKey);
  if (cached) return cached;

  const hash = algToHash(alg);
  if (!hash) return null;

  let algorithm: SubtleCryptoImportKeyAlgorithm;
  if (isRsaAlg(alg)) {
    algorithm = { name: 'RSASSA-PKCS1-v1_5', hash };
  } else if (isEcAlg(alg)) {
    const namedCurve = algToEcCurve(alg);
    if (!namedCurve) return null;
    algorithm = { name: 'ECDSA', namedCurve };
  } else if (isHmacAlg(alg)) {
    algorithm = { name: 'HMAC', hash };
  } else {
    return null;
  }

  // BUG FIX (#GG6): WebCrypto throws on malformed JWKs. Catch the
  // exception and return null so the caller produces a clean
  // "cryptographic operation failed" error instead of propagating
  // an uncaught DOMException out of the Worker.
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      algorithm,
      false,
      ['verify'],
    );
  } catch {
    return null;
  }
  jwkKeyCache.set(cacheKey, key);
  return key;
}
