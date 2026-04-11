// Stage 8a — behavior-preservation tests for the auth file split.
//
// Every test here is ported from `cloudrest-public/tests/auth.test.ts`
// with minimal shape adjustments (rewrite uses `Headers` + `AppConfig`
// + `Result`). Stage 11 adds new assertions on top of these; nothing
// here changes.

import { describe, expect, it, beforeEach } from 'vitest';

import {
  authenticate,
  __resetJwtCacheForTest,
  __resetJwksCacheForTest,
  __resetPemCacheForTest,
} from '@/auth';
import { makeTestConfig } from '@tests/fixtures/config';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';

function base64Url(input: string | Uint8Array): string {
  const str =
    typeof input === 'string'
      ? btoa(input)
      : btoa(String.fromCharCode(...input));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function signHs(
  data: string,
  secret: string,
  alg: 'HS256' | 'HS384' | 'HS512' = 'HS256',
): Promise<string> {
  const hash =
    alg === 'HS256' ? 'SHA-256' : alg === 'HS384' ? 'SHA-384' : 'SHA-512';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(data),
  );
  return base64Url(new Uint8Array(sig));
}

async function buildJwt(
  payload: unknown,
  opts?: {
    secret?: string;
    alg?: 'HS256' | 'HS384' | 'HS512';
  },
): Promise<string> {
  const alg = opts?.alg ?? 'HS256';
  const header = { typ: 'JWT', alg };
  const h = base64Url(JSON.stringify(header));
  const p = base64Url(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const sig = opts?.secret
    ? await signHs(data, opts.secret, alg)
    : base64Url('unsigned');
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

describe('authenticate — anonymous paths', () => {
  it('returns anon role when no Authorization header is supplied', async () => {
    const r = expectOk(await authenticate(headers([]), makeTestConfig()));
    expect(r.role).toBe('anon');
    expect(r.claims).toEqual({});
  });

  it('returns PGRST302 when anon is disabled and no token is supplied', async () => {
    const r = expectErr(
      await authenticate(
        headers([]),
        makeTestConfig({
          database: {
            ...makeTestConfig().database,
            anonRole: '',
          },
        }),
      ),
    );
    expect(r.code).toBe('PGRST302');
  });

  it('rejects a non-Bearer Authorization header (GG8: no stealth fallback)', async () => {
    // The old code silently fell back to anon on `Token abc` /
    // `Basic ...`; GG8 changed that to a 401 so the client sees
    // its bogus credential was refused.
    const r = expectErr(
      await authenticate(
        headers([['authorization', 'Token abc']]),
        makeTestConfig(),
      ),
    );
    expect(r.code).toBe('PGRST301');
  });

  it('errors with PGRST301 on an empty Bearer token', async () => {
    const r = expectErr(
      await authenticate(
        headers([['authorization', 'Bearer ']]),
        makeTestConfig(),
      ),
    );
    expect(r.code).toBe('PGRST301');
    expect(r.message).toContain('Empty JWT');
  });
});

describe('authenticate — malformed tokens', () => {
  it('rejects a token with the wrong number of parts', async () => {
    const r = expectErr(
      await authenticate(
        headers([['authorization', 'Bearer a.b']]),
        makeTestConfig({
          auth: { ...makeTestConfig().auth, jwtSecret: 'test-secret' },
        }),
      ),
    );
    expect(r.code).toBe('PGRST301');
    expect(r.message).toContain('Expected 3 parts');
  });

  it('rejects unreadable base64 header', async () => {
    const r = expectErr(
      await authenticate(
        headers([['authorization', 'Bearer !!!.!!!.!!!']]),
        makeTestConfig({
          auth: { ...makeTestConfig().auth, jwtSecret: 'test-secret' },
        }),
      ),
    );
    expect(r.code).toBe('PGRST301');
  });
});

describe('authenticate — HMAC verification', () => {
  it('accepts a valid HS256 token and returns the role claim', async () => {
    const secret = 'test-secret-value';
    const token = await buildJwt({ role: 'authenticated' }, { secret });
    const r = expectOk(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig({
          auth: { ...makeTestConfig().auth, jwtSecret: secret },
        }),
      ),
    );
    expect(r.role).toBe('authenticated');
    expect(r.claims).toMatchObject({ role: 'authenticated' });
  });

  it('rejects a token with a bad signature', async () => {
    const token = await buildJwt({ role: 'authenticated' }, { secret: 'wrong' });
    const r = expectErr(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig({
          auth: { ...makeTestConfig().auth, jwtSecret: 'right' },
        }),
      ),
    );
    expect(r.code).toBe('PGRST301');
  });

  it('surfaces PGRST300 when no jwtSecret is configured but a token is sent', async () => {
    const token = await buildJwt({ role: 'authenticated' }, { secret: 'x' });
    const r = expectErr(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig(),
      ),
    );
    expect(r.code).toBe('PGRST300');
  });
});

describe('authenticate — temporal claims', () => {
  it('rejects an expired JWT (PGRST303)', async () => {
    const secret = 'x';
    const token = await buildJwt(
      { role: 'authenticated', exp: 1 },
      { secret },
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

  it('rejects a non-numeric exp claim', async () => {
    const secret = 'x';
    const token = await buildJwt(
      { role: 'authenticated', exp: 'nope' },
      { secret },
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
    expect(r.message).toContain("'exp'");
  });
});

describe('authenticate — audience validation', () => {
  it('accepts a matching string aud', async () => {
    const secret = 'x';
    const token = await buildJwt(
      { role: 'authenticated', aud: 'api.example.com' },
      { secret },
    );
    const r = expectOk(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig({
          auth: {
            ...makeTestConfig().auth,
            jwtSecret: secret,
            jwtAudience: 'api.example.com',
          },
        }),
      ),
    );
    expect(r.role).toBe('authenticated');
  });

  it('rejects a non-matching string aud', async () => {
    const secret = 'x';
    const token = await buildJwt(
      { role: 'authenticated', aud: 'other.example.com' },
      { secret },
    );
    const r = expectErr(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig({
          auth: {
            ...makeTestConfig().auth,
            jwtSecret: secret,
            jwtAudience: 'api.example.com',
          },
        }),
      ),
    );
    expect(r.code).toBe('PGRST303');
    expect(r.message).toContain('audience');
  });

  it('accepts a matching array aud entry', async () => {
    const secret = 'x';
    const token = await buildJwt(
      { role: 'authenticated', aud: ['other', 'api.example.com'] },
      { secret },
    );
    const r = expectOk(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig({
          auth: {
            ...makeTestConfig().auth,
            jwtSecret: secret,
            jwtAudience: 'api.example.com',
          },
        }),
      ),
    );
    expect(r.role).toBe('authenticated');
  });
});

describe('authenticate — role fallback', () => {
  it('falls back to anonRole when the claim is missing', async () => {
    const secret = 'x';
    const token = await buildJwt({ sub: 'alice' }, { secret });
    const r = expectOk(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig({
          auth: { ...makeTestConfig().auth, jwtSecret: secret },
        }),
      ),
    );
    expect(r.role).toBe('anon');
  });

  it('uses jwtDefaultRole when set and the claim is missing', async () => {
    const secret = 'x';
    const token = await buildJwt({ sub: 'alice' }, { secret });
    const r = expectOk(
      await authenticate(
        headers([['authorization', `Bearer ${token}`]]),
        makeTestConfig({
          auth: { ...makeTestConfig().auth, jwtSecret: secret },
          database: {
            ...makeTestConfig().database,
            jwtDefaultRole: 'authenticated',
          },
        }),
      ),
    );
    expect(r.role).toBe('authenticated');
  });
});
