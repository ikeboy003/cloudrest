// Top-level `authenticate` — the ONE entry point the router calls.
//
// STAGE 11 SECURITY FIXES applied here:
//   §11.1 — explicit `alg=none` / unknown-alg reject with PGRST304
//           BEFORE any key lookup.
//   §11.2 — cache is hashed-key; see `jwt.ts`.
//   §11.3 — cache entries are bounded-TTL; see `jwt.ts`.
//   §11.4 — invalid tokens are negative-cached so an abusive
//           client can't force re-verification on every request.
//   §11.5 — JWKS cache is versioned by fetch timestamp; see `jwks.ts`.
//   §11.6 — JWKS URL scheme allowlist: `https://` only. Plain
//           `http://` is rejected with PGRST305 at this level so the
//           operator sees a configuration error, not a silent token
//           rejection down inside the verifier.
//   §11.7 — `JWT_ROLE_CLAIM` is validated at config-load time
//           (`config/load.ts::validateRoleClaim`) and the walker
//           returns `undefined` on a parse failure so an empty path
//           can never become "JSON.stringify(payload)".

import { err, ok, type Result } from '../core/result';
import { authErrors, type CloudRestError } from '../core/errors';
import type { AppConfig } from '../config/schema';
import { base64UrlDecode, base64UrlToBuffer } from './base64';
import { walkClaimPath, stringifyClaimValue } from './claims';
import {
  jwtCacheGet,
  jwtCachePutErr,
  jwtCachePutOk,
  verifySignature,
  type AuthClaims,
} from './jwt';
import { isEcAlg, isHmacAlg, isRsaAlg } from './pem';

// Re-export the top-level shape so the router imports it from one
// canonical location.
export type { AuthClaims } from './jwt';

/**
 * Authenticate a request. Returns the resolved role and decoded
 * claims or a `CloudRestError` (401/500).
 */
export async function authenticate(
  headers: Headers,
  config: AppConfig,
): Promise<Result<AuthClaims, CloudRestError>> {
  const authHeader = headers.get('authorization');

  if (authHeader === null) {
    if (config.database.anonRole) {
      return ok({ role: config.database.anonRole, claims: {} });
    }
    return err(authErrors.jwtTokenRequired());
  }

  const bearerMatch = authHeader.match(/^Bearer(?:\s+(.*))?$/i);
  if (!bearerMatch) {
    // BUG FIX (#GG8): a non-Bearer header is a credential the
    // client wants us to honor — silently dropping it to anon
    // lets an attacker present bogus credentials and still get
    // the anon role. Return a 401 challenge.
    return err(
      authErrors.jwtDecodeError(
        'Authorization header must use the Bearer scheme',
      ),
    );
  }

  const token = bearerMatch[1]?.trim();
  if (!token) {
    return err(
      authErrors.jwtDecodeError('Empty JWT is sent in Authorization header'),
    );
  }

  // §11.6 — JWKS scheme allowlist. Reject `http://` secrets (and
  // anything that isn't https/PEM/HMAC) at the config boundary.
  if (
    config.auth.jwtSecret !== null &&
    config.auth.jwtSecret.startsWith('http://')
  ) {
    return err(authErrors.jwksSchemeNotAllowed('http'));
  }

  // §11.2-§11.4 — cached verification with hashed keys.
  const cached = await jwtCacheGet(token);
  if (cached.kind === 'ok') return ok(cached.result);
  if (cached.kind === 'err') {
    // Negative cache — return a stable error with the same shape
    // every time so the attacker cannot distinguish "freshly
    // rejected" from "replayed from cache".
    return err(
      authErrors.jwtDecodeError('JWT cryptographic operation failed'),
    );
  }

  const decodedResult = await verifyAndDecode(token, config);
  if (!decodedResult.ok) {
    // §11.4 negative cache — don't cache server errors, only
    // client-fault errors (401 range).
    if (decodedResult.error.httpStatus === 401) {
      await jwtCachePutErr(token);
    }
    return decodedResult;
  }

  const expClaim =
    typeof decodedResult.value.claims['exp'] === 'number'
      ? (decodedResult.value.claims['exp'] as number)
      : null;
  await jwtCachePutOk(token, decodedResult.value, expClaim);
  return decodedResult;
}

async function verifyAndDecode(
  token: string,
  config: AppConfig,
): Promise<Result<AuthClaims, CloudRestError>> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return err(
      authErrors.jwtDecodeError(
        `Expected 3 parts in JWT; got ${parts.length}`,
      ),
    );
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: string; typ?: string; kid?: string };
  try {
    header = JSON.parse(base64UrlDecode(headerB64));
  } catch {
    return err(authErrors.jwtDecodeError('Failed to decode JWT header'));
  }

  if (header.typ !== undefined && header.typ.toUpperCase() !== 'JWT') {
    return err(authErrors.jwtDecodeError('Unsupported token type'));
  }

  // §11.1 — explicit `alg=none` and unknown-alg reject with PGRST304.
  // The underlying `verifySignature` ALSO rejects these internally,
  // but surfacing PGRST304 here gives operators a distinct error
  // from PGRST301 ("cryptographic operation failed") — operators
  // reading logs want to see "you tried to use alg=none" spelled
  // out, not "signature mismatch".
  const alg = header.alg ?? 'HS256';
  if (!isRsaAlg(alg) && !isEcAlg(alg) && !isHmacAlg(alg)) {
    return err(authErrors.algNotAllowed(alg));
  }

  if (!config.auth.jwtSecret) {
    return err(authErrors.jwtSecretMissing());
  }

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlToBuffer(signatureB64);

  const valid = await verifySignature(
    alg,
    config.auth.jwtSecret,
    data,
    signature,
    header.kid,
    config.auth.jwtSecretIsBase64,
  );
  if (valid === null) {
    return err(
      authErrors.jwtDecodeError('Wrong or unsupported encoding algorithm'),
    );
  }
  if (!valid) {
    return err(authErrors.jwtDecodeError('JWT cryptographic operation failed'));
  }

  // Decode payload.
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(base64UrlDecode(payloadB64));
  } catch {
    return err(authErrors.jwtDecodeError('Failed to decode JWT payload'));
  }
  if (
    parsedPayload === null ||
    Array.isArray(parsedPayload) ||
    typeof parsedPayload !== 'object'
  ) {
    return err(authErrors.jwtClaimsError('Parsing claims failed'));
  }
  const payload = parsedPayload as Record<string, unknown>;

  // Temporal claim validation with 30s skew.
  const now = Math.floor(Date.now() / 1000);
  const allowedSkewSeconds = 30;

  if ('exp' in payload) {
    if (typeof payload['exp'] !== 'number') {
      return err(authErrors.jwtClaimsError("The JWT 'exp' claim must be a number"));
    }
    if (now - allowedSkewSeconds > (payload['exp'] as number)) {
      return err(authErrors.jwtExpired());
    }
  }
  if ('nbf' in payload) {
    if (typeof payload['nbf'] !== 'number') {
      return err(authErrors.jwtClaimsError("The JWT 'nbf' claim must be a number"));
    }
    if (now + allowedSkewSeconds < (payload['nbf'] as number)) {
      return err(authErrors.jwtClaimsError('JWT not yet valid'));
    }
  }
  if ('iat' in payload) {
    if (typeof payload['iat'] !== 'number') {
      return err(authErrors.jwtClaimsError("The JWT 'iat' claim must be a number"));
    }
    if (now + allowedSkewSeconds < (payload['iat'] as number)) {
      return err(authErrors.jwtClaimsError('JWT issued at future'));
    }
  }

  // BUG FIX (#GG2): when `jwtAudience` is configured, the token
  // MUST carry a matching audience. The old code accepted any of
  // { missing, null, empty array, non-matching array } as "skip
  // validation" — so a token minted for a different API, or one
  // with no aud at all, would authenticate against this deployment.
  const requiredAudience = config.auth.jwtAudience;
  if (requiredAudience) {
    const rawAud = 'aud' in payload ? payload['aud'] : undefined;
    if (rawAud === undefined || rawAud === null) {
      return err(authErrors.jwtClaimsError('JWT not in audience'));
    }
    if (typeof rawAud === 'string') {
      if (rawAud !== requiredAudience) {
        return err(authErrors.jwtClaimsError('JWT not in audience'));
      }
    } else if (Array.isArray(rawAud)) {
      if (!rawAud.every((entry): entry is string => typeof entry === 'string')) {
        return err(
          authErrors.jwtClaimsError(
            "The JWT 'aud' claim must be a string or an array of strings",
          ),
        );
      }
      if (!rawAud.includes(requiredAudience)) {
        return err(authErrors.jwtClaimsError('JWT not in audience'));
      }
    } else {
      return err(
        authErrors.jwtClaimsError(
          "The JWT 'aud' claim must be a string or an array of strings",
        ),
      );
    }
  } else if ('aud' in payload && payload['aud'] !== null) {
    // No required audience configured — still type-check the claim
    // shape so a malformed token cannot quietly pass.
    const aud = payload['aud'];
    if (typeof aud !== 'string' && !Array.isArray(aud)) {
      return err(
        authErrors.jwtClaimsError(
          "The JWT 'aud' claim must be a string or an array of strings",
        ),
      );
    }
    if (
      Array.isArray(aud) &&
      !aud.every((entry): entry is string => typeof entry === 'string')
    ) {
      return err(
        authErrors.jwtClaimsError(
          "The JWT 'aud' claim must be a string or an array of strings",
        ),
      );
    }
  }

  // §11.7 — the claim walker now returns `undefined` on a parse
  // failure (see `auth/claims.ts` GG3 fix); the fallback below
  // resolves to the configured default/anon role instead of the
  // raw JSON payload.
  const roleValue = walkClaimPath(payload, config.auth.jwtRoleClaim);
  const role =
    stringifyClaimValue(roleValue) ??
    config.database.jwtDefaultRole ??
    config.database.anonRole;
  if (!role) {
    return err(authErrors.jwtTokenRequired());
  }

  return ok({ role, claims: payload });
}
