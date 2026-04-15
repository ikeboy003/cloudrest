// Stage 9 — payload parser tests.
//
// Closes critiques #44 (body-size pre-check), #46 (form duplicate
// keys), #47 (CSV NULL sentinel), and pins the JSON "all rows must
// share keys" invariant PostgREST requires.

import { describe, expect, it } from 'vitest';

import {
  parseJsonPayload,
  parseFormPayload,
  parseCsvPayload,
  parsePayload,
} from '@/parser/payload';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';
import { makeTestConfig } from '@tests/fixtures/config';

describe('parseJsonPayload', () => {
  it('accepts a single object and records its keys', () => {
    const p = expectOk(parseJsonPayload('{"id":1,"name":"alice"}'));
    expect(p.type).toBe('json');
    if (p.type !== 'json') throw new Error('unreachable');
    expect([...p.keys]).toEqual(['id', 'name']);
  });

  it('accepts an array of homogeneous objects', () => {
    const p = expectOk(parseJsonPayload('[{"a":1},{"a":2}]'));
    if (p.type !== 'json') throw new Error('unreachable');
    expect([...p.keys]).toEqual(['a']);
  });

  it('rejects an array with mismatched keys', () => {
    const r = expectErr(parseJsonPayload('[{"a":1},{"b":2}]'));
    expect(r.code).toBe('PGRST102');
  });

  it('rejects invalid JSON', () => {
    const r = expectErr(parseJsonPayload('{not-json}'));
    expect(r.code).toBe('PGRST102');
  });

  it('rejects a scalar top-level', () => {
    const r = expectErr(parseJsonPayload('42'));
    expect(r.code).toBe('PGRST102');
  });
});

describe('parseFormPayload — #46 duplicate key rejection', () => {
  it('parses a well-formed form body', () => {
    const p = expectOk(parseFormPayload('name=alice&age=30'));
    if (p.type !== 'urlEncoded') throw new Error('unreachable');
    expect([...p.keys]).toEqual(['name', 'age']);
    expect(p.pairs).toEqual([
      ['name', 'alice'],
      ['age', '30'],
    ]);
  });

  it('decodes percent-encoded and plus-space values', () => {
    const p = expectOk(parseFormPayload('name=alice+smith&email=a%40b.com'));
    if (p.type !== 'urlEncoded') throw new Error('unreachable');
    expect(p.pairs).toEqual([
      ['name', 'alice smith'],
      ['email', 'a@b.com'],
    ]);
  });

  it('rejects a duplicate key (#46)', () => {
    const r = expectErr(parseFormPayload('a=1&a=2'));
    expect(r.code).toBe('PGRST102');
    expect(r.message).toContain('duplicate');
  });
});

describe('parseCsvPayload — #47 CSV NULL sentinel', () => {
  it('parses a CSV body with a header row', () => {
    const p = expectOk(
      parseCsvPayload('id,title\n1,hello\n2,world', { csvNullToken: null }),
    );
    if (p.type !== 'json') throw new Error('unreachable');
    const rows = JSON.parse(p.raw) as Record<string, string | null>[];
    expect(rows).toEqual([
      { id: '1', title: 'hello' },
      { id: '2', title: 'world' },
    ]);
  });

  it('does NOT treat the literal text "NULL" as SQL NULL by default (#47)', () => {
    const p = expectOk(
      parseCsvPayload('id,note\n1,NULL', { csvNullToken: null }),
    );
    if (p.type !== 'json') throw new Error('unreachable');
    const rows = JSON.parse(p.raw) as Record<string, string | null>[];
    // The client's literal "NULL" stays as a string.
    expect(rows[0]!.note).toBe('NULL');
  });

  it('treats the literal text as SQL NULL when csvNullToken is set', () => {
    const p = expectOk(
      parseCsvPayload('id,note\n1,NULL', { csvNullToken: 'NULL' }),
    );
    if (p.type !== 'json') throw new Error('unreachable');
    const rows = JSON.parse(p.raw) as Record<string, string | null>[];
    expect(rows[0]!.note).toBeNull();
  });

  it('rejects a duplicate header column', () => {
    const r = expectErr(
      parseCsvPayload('id,id\n1,2', { csvNullToken: null }),
    );
    expect(r.code).toBe('PGRST102');
  });

  it('rejects a row with the wrong field count', () => {
    const r = expectErr(
      parseCsvPayload('a,b\n1,2,3', { csvNullToken: null }),
    );
    expect(r.code).toBe('PGRST102');
  });
});

describe('parsePayload — #44 body-size pre-check', () => {
  it('rejects an oversized request based on Content-Length', async () => {
    const config = makeTestConfig({
      limits: {
        maxBodyBytes: 10,
        maxBatchBodyBytes: 10_485_760,
        maxBatchOps: 100,
        maxEmbedDepth: 8,
        rateLimitRpm: 0,
        maxQueryCost: 0,
      },
    });
    const request = new Request('https://api.test/books', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': '999',
      },
      body: '{"id":1}',
    });
    const r = expectErr(
      await parsePayload({
        request,
        config,
        contentMediaTypeId: 'json',
      }),
    );
    expect(r.code).toBe('PGRST413');
  });

  it('returns null for GET', async () => {
    const request = new Request('https://api.test/books');
    const p = expectOk(
      await parsePayload({
        request,
        config: makeTestConfig(),
        contentMediaTypeId: 'json',
      }),
    );
    expect(p).toBeNull();
  });

  it('parses a JSON POST body', async () => {
    const request = new Request('https://api.test/books', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"title":"Hello"}',
    });
    const p = expectOk(
      await parsePayload({
        request,
        config: makeTestConfig(),
        contentMediaTypeId: 'json',
      }),
    );
    expect(p).not.toBeNull();
    if (p === null || p.type !== 'json') throw new Error('unreachable');
    expect([...p.keys]).toEqual(['title']);
  });
});
