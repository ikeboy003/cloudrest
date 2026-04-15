// JWKS fetch + key import.
//
// STAGE 11 SECURITY FIXES:
//   §11.5 — the imported-key cache is VERSIONED by fetch timestamp
//           instead of cleared on refresh. The old code cleared the
//           map as soon as a new JWKS fetched, which raced with any
//           in-flight request that had resolved its key before the
//           refresh and then found the cache empty on second lookup.
//           The new cache keys include the fetchedAt epoch so old and
//           new entries coexist; lookups pick the current version.
//   §11.6 — enforcement lives in `authenticate.ts`, which rejects
//           `http://` secrets at the outer boundary. `getJwksKey`
//           also refuses anything that isn't `https://`.

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

interface JwksCacheEntry {
  readonly keys: readonly JwkWithKid[];
  readonly fetchedAt: number;
}

let cachedJwks: JwksCacheEntry | null = null;
let cachedJwksUri: string | null = null;

/**
 * Imported-key cache. Key shape is `<fetchedAt>\0<alg>\0<discriminator>`
 * so entries from a previous fetch stay addressable even after a
 * refresh — an in-flight request that already resolved against the
 * old JWKS won't find an empty map. Old entries age out naturally
 * when the URI is re-fetched and the new `fetchedAt` becomes the
 * lookup prefix for all subsequent calls.
 */
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
 * Returns `null` on any failure so a bad IdP response doesn't become
 * an unhandled request failure.
 */
/**
 * Fetch-or-cache the JWKS document. Returns the entry including its
 * `fetchedAt` so callers can version imported keys against it.
 *
 * §11.5: no more `jwkKeyCache.clear()` on refresh. Old imported
 * keys stay addressable under their old `fetchedAt` prefix and
 * naturally fall out once nothing references them.
 */
async function fetchJwks(
  uri: string,
  forceRefresh: boolean,
): Promise<JwksCacheEntry | null> {
  const now = Date.now();
  if (
    !forceRefresh &&
    cachedJwks &&
    cachedJwksUri === uri &&
    now - cachedJwks.fetchedAt < JWKS_TTL_MS
  ) {
    return cachedJwks;
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

  const entry: JwksCacheEntry = { keys: data.keys, fetchedAt: now };
  cachedJwks = entry;
  cachedJwksUri = uri;
  return entry;
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
  // §11.6: only `https://` JWKS URIs are permitted at this layer
  // (the authenticate boundary also rejects `http://`; this is
  // defense in depth).
  if (!uri.startsWith('https://')) return null;

  // Fail closed on any alg outside the strict JWS allowlist.
  if (!isRsaAlg(alg) && !isEcAlg(alg) && !isHmacAlg(alg)) return null;

  let entry = await fetchJwks(uri, false);
  if (entry === null) return null;

  let jwk = kid
    ? entry.keys.find((k) => k.kid === kid)
    : entry.keys.find((k) => k.alg === alg || !k.alg);

  if (!jwk && kid) {
    const refreshed = await fetchJwks(uri, true);
    if (refreshed === null) return null;
    entry = refreshed;
    jwk = entry.keys.find((k) => k.kid === kid);
  }

  if (!jwk) return null;

  // §11.5 + GG5: cache key = `<fetchedAt>\0<alg>\0<discriminator>`.
  // A later refresh gets a new `fetchedAt` and the lookup finds a
  // fresh (empty) slot, while any in-flight request holding the
  // old `entry` still resolves against its original fetchedAt.
  const discriminator = kid ?? JSON.stringify(jwk);
  const cacheKey = `${entry.fetchedAt}\0${alg}\0${discriminator}`;
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

  // WebCrypto throws on malformed JWKs. Catch and return null so the
  // caller produces a clean error instead of an uncaught DOMException.
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
