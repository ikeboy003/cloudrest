// JWT signature verification + result cache.
//
// STAGE 11 SECURITY FIXES:
//   §11.1 — `alg=none` is refused in `verifySignature` before any
//           key lookup (mirrored by an explicit check in the
//           authenticate pipeline so both code paths reject it).
//   §11.2 — cache key is `SHA-256(token)` async-hashed on every
//           lookup / store. The raw token never enters the map.
//   §11.3 — tokens without an `exp` claim get a bounded TTL so a
//           valid-but-session-less token cannot pin a cached role
//           forever.
//   §11.4 — invalid tokens get a negative cache with a SHORTER
//           TTL than the positive path. This kills the "bad-token
//           replay" CPU-burn where an attacker re-sends a
//           malformed token on every request.
//
// The exported `jwtCacheGet` / `jwtCacheSet` helpers are async and
// handle SHA-256 hashing internally. Callers must `await` them.

import { base64ToBuffer } from './base64';
import { getJwksKey } from './jwks';
import { algToHash, importPemKey, isEcAlg, isHmacAlg, isRsaAlg } from './pem';

// ----- Public shape ----------------------------------------------------

export interface AuthClaims {
  readonly role: string;
  readonly claims: Readonly<Record<string, unknown>>;
}

// ----- Cache entries ---------------------------------------------------

interface PositiveEntry {
  readonly kind: 'ok';
  readonly result: AuthClaims;
  /** Unix seconds at which this entry expires. */
  readonly expiresAt: number;
}

interface NegativeEntry {
  readonly kind: 'err';
  /** Unix seconds at which this entry expires. */
  readonly expiresAt: number;
}

type JwtCacheEntry = PositiveEntry | NegativeEntry;

// ----- Tunables --------------------------------------------------------

/** Bounded LRU size. Beyond this, we evict oldest-insertion first. */
const JWT_CACHE_MAX = 500;

/**
 * §11.3 — tokens without an `exp` claim get this TTL (seconds).
 * Long enough that a normal session is not re-verified on every
 * request, short enough that a revoked token eventually stops
 * being recognized.
 */
const NO_EXP_TTL_SECONDS = 5 * 60;

/**
 * §11.4 — invalid tokens get a much shorter TTL so a retry storm
 * doesn't keep spinning the verifier. Keep this strictly smaller
 * than the positive TTL so the cache cannot pin an "always
 * invalid" state on a token that later becomes valid (e.g. after
 * a JWKS refresh).
 */
const NEGATIVE_TTL_SECONDS = 10;

// ----- Storage ---------------------------------------------------------

const jwtCache = new Map<string, JwtCacheEntry>();

/** Test hook: clear the cache. */
export function __resetJwtCacheForTest(): void {
  jwtCache.clear();
}

// ----- Hash helper -----------------------------------------------------

/**
 * Compute a hex `SHA-256(token)` for use as the cache key.
 * §11.2: the raw token never enters the map.
 */
async function hashTokenForCacheKey(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// ----- Cache API (async) -----------------------------------------------

/**
 * Result of a cache lookup:
 *   - `ok`: a previously-verified token; use the `result` directly.
 *   - `err`: a previously-rejected token; short-circuit with the
 *            same error without re-running verify.
 *   - `miss`: nothing cached (or the entry expired).
 */
export type JwtCacheLookup =
  | { readonly kind: 'ok'; readonly result: AuthClaims }
  | { readonly kind: 'err' }
  | { readonly kind: 'miss' };

export async function jwtCacheGet(token: string): Promise<JwtCacheLookup> {
  const key = await hashTokenForCacheKey(token);
  const entry = jwtCache.get(key);
  if (entry === undefined) return { kind: 'miss' };

  const now = Math.floor(Date.now() / 1000);
  if (now >= entry.expiresAt) {
    jwtCache.delete(key);
    return { kind: 'miss' };
  }
  return entry.kind === 'ok'
    ? { kind: 'ok', result: entry.result }
    : { kind: 'err' };
}

export async function jwtCachePutOk(
  token: string,
  result: AuthClaims,
  exp: number | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // §11.3: cap the TTL. Even if the token's exp is far in the
  // future, we re-verify after NO_EXP_TTL_SECONDS at the latest.
  const expiresAt =
    exp === null
      ? now + NO_EXP_TTL_SECONDS
      : Math.min(exp, now + NO_EXP_TTL_SECONDS);
  await putEntry(token, { kind: 'ok', result, expiresAt });
}

export async function jwtCachePutErr(token: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await putEntry(token, {
    kind: 'err',
    expiresAt: now + NEGATIVE_TTL_SECONDS,
  });
}

async function putEntry(token: string, entry: JwtCacheEntry): Promise<void> {
  const key = await hashTokenForCacheKey(token);
  if (jwtCache.size >= JWT_CACHE_MAX && !jwtCache.has(key)) {
    const firstKey = jwtCache.keys().next().value;
    if (firstKey !== undefined) jwtCache.delete(firstKey);
  }
  jwtCache.set(key, entry);
}

// ----- Signature verification ------------------------------------------

/**
 * Verify a JWT signature against a secret. Returns:
 *  - `true` for a valid signature;
 *  - `false` for a well-formed but mismatched signature;
 *  - `null` when the algorithm or key form is unsupported.
 *
 * §11.1: an explicit `alg=none` (or any non-allowlisted alg) is
 * refused BEFORE any key lookup or HMAC import work.
 */
export async function verifySignature(
  alg: string,
  secret: string,
  data: Uint8Array,
  signature: Uint8Array,
  kid: string | undefined,
  secretIsBase64: boolean,
): Promise<boolean | null> {
  // §11.1 alg=none (explicit) and every non-allowlisted value.
  if (!isRsaAlg(alg) && !isEcAlg(alg) && !isHmacAlg(alg)) {
    return null;
  }

  if (secret.startsWith('http://')) return null;

  if (secret.startsWith('https://')) {
    const key = await getJwksKey(secret, kid, alg);
    if (!key) return null;
    try {
      return await verifyWithKey(alg, key, data, signature);
    } catch {
      return null;
    }
  }

  if (secret.startsWith('-----BEGIN')) {
    if (!isRsaAlg(alg) && !isEcAlg(alg)) return null;
    let key: CryptoKey | null;
    try {
      key = await importPemKey(secret, alg);
    } catch {
      return null;
    }
    if (!key) return null;
    try {
      return await verifyWithKey(alg, key, data, signature);
    } catch {
      return null;
    }
  }

  // HMAC
  if (!isHmacAlg(alg)) return null;
  const hash = algToHash(alg)!;
  try {
    const keyData = secretIsBase64
      ? base64ToBuffer(secret)
      : new TextEncoder().encode(secret);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify('HMAC', key, signature, data);
  } catch {
    return null;
  }
}

/**
 * Run the driver-appropriate verify call given an already-imported key.
 */
export async function verifyWithKey(
  alg: string,
  key: CryptoKey,
  data: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (isRsaAlg(alg)) {
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  }
  if (isEcAlg(alg)) {
    const hash = algToHash(alg)!;
    return crypto.subtle.verify({ name: 'ECDSA', hash }, key, signature, data);
  }
  if (isHmacAlg(alg)) {
    return crypto.subtle.verify('HMAC', key, signature, data);
  }
  return false;
}
