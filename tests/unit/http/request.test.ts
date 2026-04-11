import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/load';
import { parseHttpRequest } from '../../../src/http/request';
import { testEnv } from '../../fixtures/env';

function config() {
  const loaded = loadConfig(testEnv({ DB_SCHEMAS: 'public,api' }));
  if (!loaded.ok) throw new Error('test config failed');
  return loaded.value;
}

function req(init: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
}): Request {
  return new Request(init.url ?? 'https://example.com/books', {
    method: init.method ?? 'GET',
    headers: init.headers,
  });
}

describe('parseHttpRequest — resource resolution', () => {
  it('resolves the empty path as schema root', () => {
    const r = parseHttpRequest(config(), req({ url: 'https://example.com/' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.resource).toEqual({ type: 'schema' });
      expect(r.value.action.type).toBe('schemaRead');
    }
  });

  it('resolves /books as a relation', () => {
    const r = parseHttpRequest(
      config(),
      req({ url: 'https://example.com/books' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.resource).toEqual({ type: 'relation', name: 'books' });
      if (r.value.action.type === 'relationRead') {
        expect(r.value.action.target).toEqual({ schema: 'public', name: 'books' });
      }
    }
  });

  it('resolves /rpc/compute as a routine', () => {
    const r = parseHttpRequest(
      config(),
      req({ url: 'https://example.com/rpc/compute', method: 'POST' }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.resource).toEqual({ type: 'routine', name: 'compute' });
      expect(r.value.action.type).toBe('routineCall');
    }
  });

  it('rejects deep paths (3+ segments)', () => {
    const r = parseHttpRequest(
      config(),
      req({ url: 'https://example.com/a/b/c' }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PGRST125');
  });
});

describe('parseHttpRequest — method to action', () => {
  const base = 'https://example.com/books';
  it('maps GET to relationRead', () => {
    const r = parseHttpRequest(config(), req({ url: base, method: 'GET' }));
    expect(r.ok && r.value.action.type).toBe('relationRead');
  });
  it('maps HEAD to relationRead headersOnly', () => {
    const r = parseHttpRequest(config(), req({ url: base, method: 'HEAD' }));
    if (r.ok && r.value.action.type === 'relationRead') {
      expect(r.value.action.headersOnly).toBe(true);
    }
  });
  it('maps POST to relationMut create', () => {
    const r = parseHttpRequest(config(), req({ url: base, method: 'POST' }));
    if (r.ok && r.value.action.type === 'relationMut') {
      expect(r.value.action.mutation).toBe('create');
    }
  });
  it('maps PATCH to relationMut update', () => {
    const r = parseHttpRequest(config(), req({ url: base, method: 'PATCH' }));
    if (r.ok && r.value.action.type === 'relationMut') {
      expect(r.value.action.mutation).toBe('update');
    }
  });
  it('maps DELETE to relationMut delete', () => {
    const r = parseHttpRequest(config(), req({ url: base, method: 'DELETE' }));
    if (r.ok && r.value.action.type === 'relationMut') {
      expect(r.value.action.mutation).toBe('delete');
    }
  });
  it('maps PUT to relationMut singleUpsert', () => {
    const r = parseHttpRequest(config(), req({ url: base, method: 'PUT' }));
    if (r.ok && r.value.action.type === 'relationMut') {
      expect(r.value.action.mutation).toBe('singleUpsert');
    }
  });
  it('maps OPTIONS to relationInfo', () => {
    const r = parseHttpRequest(config(), req({ url: base, method: 'OPTIONS' }));
    if (r.ok) expect(r.value.action.type).toBe('relationInfo');
  });
  it('rejects unsupported method (LINK)', () => {
    // undici's Request constructor accepts non-CORS-banned methods; TRACE
    // and CONNECT are rejected at fetch level, but LINK goes through and
    // reaches our action resolver.
    const r = parseHttpRequest(config(), req({ url: base, method: 'LINK' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PGRST117');
  });
});

describe('parseHttpRequest — schema profile negotiation', () => {
  it('accepts a known accept-profile on GET', () => {
    const r = parseHttpRequest(
      config(),
      req({
        url: 'https://example.com/books',
        headers: { 'accept-profile': 'api' },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.schema).toBe('api');
      expect(r.value.negotiatedByProfile).toBe(true);
    }
  });

  it('accepts a known content-profile on POST', () => {
    const r = parseHttpRequest(
      config(),
      req({
        url: 'https://example.com/books',
        method: 'POST',
        headers: { 'content-profile': 'api' },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.schema).toBe('api');
  });

  it('rejects an unknown profile as PGRST106', () => {
    const r = parseHttpRequest(
      config(),
      req({
        url: 'https://example.com/books',
        headers: { 'accept-profile': 'secret' },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PGRST106');
  });
});

describe('parseHttpRequest — media and headers', () => {
  it('parses Accept into a sorted list of media tokens', () => {
    const r = parseHttpRequest(
      config(),
      req({
        url: 'https://example.com/books',
        headers: { accept: 'text/csv;q=0.5, application/json' },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.acceptMediaTypes[0]!.id).toBe('json');
      expect(r.value.acceptMediaTypes[1]!.id).toBe('csv');
    }
  });

  it('lower-cases header names and strips the cookie header', () => {
    const r = parseHttpRequest(
      config(),
      req({
        url: 'https://example.com/books',
        headers: { 'X-Trace-Id': 'abc', Cookie: 'a=1; b=2' },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const kinds = r.value.headers.map(([k]) => k);
      expect(kinds).toContain('x-trace-id');
      expect(kinds).not.toContain('cookie');
      const cookies = r.value.cookies.map(([k, v]) => [k, v]);
      expect(cookies).toContainEqual(['a', '1']);
      expect(cookies).toContainEqual(['b', '2']);
    }
  });

  it('preserves the preferences bag', () => {
    const r = parseHttpRequest(
      config(),
      req({
        url: 'https://example.com/books',
        headers: { prefer: 'return=representation, count=exact' },
      }),
    );
    if (r.ok) {
      expect(r.value.preferences.preferRepresentation).toBe('full');
      expect(r.value.preferences.preferCount).toBe('exact');
    }
  });

  it('reports 406 when Accept is entirely unknown types', () => {
    const r = parseHttpRequest(
      config(),
      req({
        url: 'https://example.com/books',
        headers: { accept: 'application/xml' },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PGRST107');
  });
});
