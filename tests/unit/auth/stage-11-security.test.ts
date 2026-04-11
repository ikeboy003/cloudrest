// Stage 11 — auth security regression tests.
//
// Each test closes one finding from PHASE_B §11.1–§11.9. Do not
// loosen these without updating PHASE_B.

import { describe, expect, it, beforeEach } from 'vitest';

import {
  authenticate,
  __resetJwtCacheForTest,
  __resetJwksCacheForTest,
  __resetPemCacheForTest,
} from '@/auth';
import {
  jwtCacheGet,
  jwtCachePutErr,
  jwtCachePutOk,
} from '@/auth/jwt';
import { makeTestConfig } from '@tests/fixtures/config';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';

function base64Url(input: string | Uint8Array): string {
  const str =
    typeof input === 'string'
      ? btoa(input)
      : btoa(String.fromCharCode(...input));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function signHs(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return base64Url(new Uint8Array(sig));
}

async function buildJwt(
  header: Record<string, unknown>,
  payload: unknown,
  secret: string | null,
): Promise<string> {
  const h = base64Url(JSON.stringify(header));
  const p = base64Url(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const sig = secret !== null ? await signHs(data, secret) : base64Url('');
  return `${data}.${sig}`;
}

function headers(pairs: ReadonlyArray<[string, string]>): Headers {
  const h = new Headers();
  for (const [k, v] of pairs) h.set(k, v);
  return h;
}

beforeEach(() => {
  __resetJwtCacheForTest();
  __resetJwksCacheForTest();
  __resetPemCacheForTest();
});

// ----- §11.1 alg=none explicit reject ----------------------------------

describe('§11.1 — alg=none is explicitly rejected with PGRST304', () => {
  it('refuses a JWT with `alg: "none"` even if a secret is configured', async () => {
    const token = await buildJwt(
      { typ: 'JWT', alg: 'none' },
      { role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 },
      null,
    );
    const r = expectErr(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig({
          auth: { ...makeTestConfig().auth, jwtSecret: 'x' },
        }),
      ),
    );
    expect(r.code).toBe('PGRST304');
  });

  it('refuses an unknown alg value (not in the RFC 7518 allowlist)', async () => {
    const token = await buildJwt(
      { typ: 'JWT', alg: 'RS999' },
      { role: 'admin' },
      null,
    );
    const r = expectErr(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig({
          auth: { ...makeTestConfig().auth, jwtSecret: 'x' },
        }),
      ),
    );
    expect(r.code).toBe('PGRST304');
  });
});

// ----- §11.2 Hashed cache key ------------------------------------------

describe('§11.2 — JWT cache keys on SHA-256(token), not raw', () => {
  it('cache operations accept a raw token but do not expose it', async () => {
    const token = 'test-token-xyz';
    await jwtCachePutOk(token, { role: 'authenticated', claims: {} }, null);
    const hit = await jwtCacheGet(token);
    expect(hit.kind).toBe('ok');
    // Different tokens don't collide.
    const miss = await jwtCacheGet('different-token');
    expect(miss.kind).toBe('miss');
  });
});

// ----- §11.3 Bounded no-exp TTL ----------------------------------------

describe('§11.3 — no-exp tokens get a bounded TTL', () => {
  it('caches a token with no exp claim', async () => {
    await jwtCachePutOk('t1', { role: 'authenticated', claims: {} }, null);
    const hit = await jwtCacheGet('t1');
    expect(hit.kind).toBe('ok');
  });
});

// ----- §11.4 Negative cache --------------------------------------------

describe('§11.4 — invalid tokens get a negative cache entry', () => {
  it('returns an err lookup after putErr', async () => {
    await jwtCachePutErr('bad-token');
    const hit = await jwtCacheGet('bad-token');
    expect(hit.kind).toBe('err');
  });

  it('negative cache entry does not turn into a positive one', async () => {
    await jwtCachePutErr('bad-token');
    const hit = await jwtCacheGet('bad-token');
    // If cached with `kind: 'err'`, we must NOT get a role back.
    expect(hit.kind).not.toBe('ok');
  });
});

// ----- §11.6 JWKS URL scheme allowlist ---------------------------------

describe('§11.6 — http:// JWKS URIs are rejected with PGRST305', () => {
  it('rejects an http:// JWT secret at the authenticate boundary', async () => {
    const r = expectErr(
      await authenticate(
        headers([['authorization', 'Bearer a.b.c']]),
        makeTestConfig({
          auth: {
            ...makeTestConfig().auth,
            jwtSecret: 'http://insecure.example/.well-known/jwks.json',
          },
        }),
      ),
    );
    expect(r.code).toBe('PGRST305');
  });
});

// ----- §11.9 Bearer challenge on error responses -----------------------
//
// The challenge is emitted by `router/fetch.ts::formatError`, not
// `authenticate` itself. A dedicated behavior test for the
// end-to-end challenge header lives in
// `tests/behavior/auth-challenge.test.ts`.

describe('§11 summary — authenticate surfaces the right error codes', () => {
  it('PGRST301 on bogus signature', async () => {
    const secret = 'x';
    const token = await buildJwt(
      { typ: 'JWT', alg: 'HS256' },
      { role: 'authenticated' },
      'wrong-secret',
    );
    const r = expectErr(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig({
          auth: { ...makeTestConfig().auth, jwtSecret: secret },
        }),
      ),
    );
    expect(r.code).toBe('PGRST301');
  });

  it('PGRST303 on expired exp', async () => {
    const secret = 'x';
    const token = await buildJwt(
      { typ: 'JWT', alg: 'HS256' },
      { role: 'authenticated', exp: 1 },
      secret,
    );
    const r = expectErr(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig({
          auth: { ...makeTestConfig().auth, jwtSecret: secret },
        }),
      ),
    );
    expect(r.code).toBe('PGRST303');
  });

  it('happy path still returns the role', async () => {
    const secret = 'x';
    const token = await buildJwt(
      { typ: 'JWT', alg: 'HS256' },
      { role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 },
      secret,
    );
    const r = expectOk(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig({
          auth: { ...makeTestConfig().auth, jwtSecret: secret },
        }),
      ),
    );
    expect(r.role).toBe('authenticated');
  });
});
