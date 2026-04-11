// Stage 13 — cache key derivation tests.
//
// Closes critiques:
//   #31 — fingerprint includes role + claimsInKey
//   #32 — opt-in per table
//   #33 — pre-request hook disables caching

import { describe, expect, it } from 'vitest';

import { deriveCacheDecision } from '@/cache/key';
import type { AppConfig } from '@/config/schema';
import type { AuthClaims } from '@/auth/authenticate';
import { parseHttpRequest, type ParsedHttpRequest } from '@/http/request';
import { makeTestConfig } from '@tests/fixtures/config';
import { expectOk } from '@tests/fixtures/assert-result';

function httpRequest(url: string): ParsedHttpRequest {
  const request = new Request(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  return expectOk(parseHttpRequest(makeTestConfig(), request));
}

function configWithCache(
  tables: Record<string, { ttlSeconds: number; claimsInKey: readonly string[] }>,
): AppConfig {
  return makeTestConfig({
    cache: {
      defaultTtlSeconds: 60,
      tables,
    },
  });
}

const auth: AuthClaims = { role: 'viewer', claims: {} };

// ----- Opt-in gate (#32) ----------------------------------------------

describe('deriveCacheDecision — opt-in per table (#32)', () => {
  it('skips when the table is not listed', () => {
    const httpRequestValue = httpRequest('https://api.test/books');
    const d = deriveCacheDecision({
      httpRequest: httpRequestValue,
      config: configWithCache({}),
      auth,
    });
    expect(d.decision).toBe('skip');
    if (d.decision === 'skip') expect(d.reason).toContain('not opted in');
  });

  it('skips when cache config is absent entirely', () => {
    const httpRequestValue = httpRequest('https://api.test/books');
    const d = deriveCacheDecision({
      httpRequest: httpRequestValue,
      config: makeTestConfig(),
      auth,
    });
    expect(d.decision).toBe('skip');
  });

  it('caches when the table is explicitly opted in', () => {
    const httpRequestValue = httpRequest('https://api.test/books');
    const d = deriveCacheDecision({
      httpRequest: httpRequestValue,
      config: configWithCache({
        'public.books': { ttlSeconds: 60, claimsInKey: [] },
      }),
      auth,
    });
    expect(d.decision).toBe('cache');
  });
});

// ----- Pre-request guard (#33) -----------------------------------------

describe('deriveCacheDecision — pre-request hook disables caching (#33)', () => {
  it('skips when a preRequest function is configured', () => {
    const httpRequestValue = httpRequest('https://api.test/books');
    const base = configWithCache({
      'public.books': { ttlSeconds: 60, claimsInKey: [] },
    });
    const config = {
      ...base,
      database: {
        ...base.database,
        preRequest: 'public.check_request',
      },
    };
    const d = deriveCacheDecision({
      httpRequest: httpRequestValue,
      config,
      auth,
    });
    expect(d.decision).toBe('skip');
    if (d.decision === 'skip') expect(d.reason).toContain('preRequest');
  });
});

// ----- Role + claims fingerprint (#31) ---------------------------------

describe('deriveCacheDecision — fingerprint includes role + claims (#31)', () => {
  const config = configWithCache({
    'public.books': { ttlSeconds: 60, claimsInKey: ['org'] },
  });

  it('different roles yield different keys', () => {
    const httpRequestValue = httpRequest('https://api.test/books');
    const viewer = deriveCacheDecision({
      httpRequest: httpRequestValue,
      config,
      auth: { role: 'viewer', claims: { org: 'acme' } },
    });
    const editor = deriveCacheDecision({
      httpRequest: httpRequestValue,
      config,
      auth: { role: 'editor', claims: { org: 'acme' } },
    });
    if (viewer.decision !== 'cache' || editor.decision !== 'cache') {
      throw new Error('expected cache decisions');
    }
    expect(viewer.key).not.toBe(editor.key);
  });

  it('different claim values yield different keys', () => {
    const httpRequestValue = httpRequest('https://api.test/books');
    const acme = deriveCacheDecision({
      httpRequest: httpRequestValue,
      config,
      auth: { role: 'viewer', claims: { org: 'acme' } },
    });
    const evil = deriveCacheDecision({
      httpRequest: httpRequestValue,
      config,
      auth: { role: 'viewer', claims: { org: 'evil' } },
    });
    if (acme.decision !== 'cache' || evil.decision !== 'cache') {
      throw new Error('expected cache decisions');
    }
    expect(acme.key).not.toBe(evil.key);
  });

  it('missing claim encodes distinctly from present claim', () => {
    const httpRequestValue = httpRequest('https://api.test/books');
    const missing = deriveCacheDecision({
      httpRequest: httpRequestValue,
      config,
      auth: { role: 'viewer', claims: {} },
    });
    const present = deriveCacheDecision({
      httpRequest: httpRequestValue,
      config,
      auth: { role: 'viewer', claims: { org: 'acme' } },
    });
    if (missing.decision !== 'cache' || present.decision !== 'cache') {
      throw new Error('expected cache decisions');
    }
    expect(missing.key).not.toBe(present.key);
  });

  it('same role + same claims → same key (deterministic)', () => {
    const httpRequestValue = httpRequest('https://api.test/books');
    const a = deriveCacheDecision({
      httpRequest: httpRequestValue,
      config,
      auth: { role: 'viewer', claims: { org: 'acme' } },
    });
    const b = deriveCacheDecision({
      httpRequest: httpRequestValue,
      config,
      auth: { role: 'viewer', claims: { org: 'acme' } },
    });
    if (a.decision !== 'cache' || b.decision !== 'cache') {
      throw new Error('expected cache decisions');
    }
    expect(a.key).toBe(b.key);
  });
});

// ----- Non-cacheable paths --------------------------------------------

describe('deriveCacheDecision — non-cacheable paths', () => {
  it('skips mutations', () => {
    const request = new Request('https://api.test/books', { method: 'POST' });
    const parsed = expectOk(parseHttpRequest(makeTestConfig(), request));
    const d = deriveCacheDecision({
      httpRequest: parsed,
      config: configWithCache({
        'public.books': { ttlSeconds: 60, claimsInKey: [] },
      }),
      auth,
    });
    expect(d.decision).toBe('skip');
  });
});
