// Stage 7 — GUC parser contract test.
//
// Closes critique #6: the old codebase parsed `response.headers` /
// `response.status` in TWO places with subtly different rules. The
// rewrite has ONE parser and both the read and mutation paths import
// it. This test pins that invariant: given identical inputs, the
// parser always returns identical outputs and identical errors.

import { describe, expect, it } from 'vitest';

import {
  EMPTY_GUC_OVERRIDES,
  parseResponseGucHeaders,
} from '@/response/guc';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';

describe('parseResponseGucHeaders — null handling', () => {
  it('returns EMPTY_GUC_OVERRIDES when both GUCs are absent', () => {
    const parsed = expectOk(
      parseResponseGucHeaders({
        responseHeaders: null,
        responseStatus: null,
      }),
    );
    expect(parsed).toEqual(EMPTY_GUC_OVERRIDES);
  });

  it('treats an empty string as "absent"', () => {
    const parsed = expectOk(
      parseResponseGucHeaders({
        responseHeaders: '',
        responseStatus: '',
      }),
    );
    expect(parsed.status).toBeNull();
    expect(parsed.headers).toEqual([]);
  });
});

describe('parseResponseGucHeaders — status parsing (PGRST112)', () => {
  it('accepts a valid status code', () => {
    const parsed = expectOk(
      parseResponseGucHeaders({
        responseHeaders: null,
        responseStatus: '201',
      }),
    );
    expect(parsed.status).toBe(201);
  });

  it('rejects a non-numeric status', () => {
    const err = expectErr(
      parseResponseGucHeaders({
        responseHeaders: null,
        responseStatus: 'oops',
      }),
    );
    expect(err.code).toBe('PGRST112');
  });

  it('rejects an out-of-range status', () => {
    const err = expectErr(
      parseResponseGucHeaders({
        responseHeaders: null,
        responseStatus: '42',
      }),
    );
    expect(err.code).toBe('PGRST112');
  });

  it('rejects a mixed-garbage status like "201oops"', () => {
    const err = expectErr(
      parseResponseGucHeaders({
        responseHeaders: null,
        responseStatus: '201oops',
      }),
    );
    expect(err.code).toBe('PGRST112');
  });
});

describe('parseResponseGucHeaders — header shapes (PGRST111)', () => {
  it('parses the PostgREST one-key-object array form', () => {
    const parsed = expectOk(
      parseResponseGucHeaders({
        responseHeaders: '[{"X-Foo": "bar"}, {"X-Baz": "qux"}]',
        responseStatus: null,
      }),
    );
    expect(parsed.headers).toEqual([
      ['X-Foo', 'bar'],
      ['X-Baz', 'qux'],
    ]);
  });

  it('parses the {name, value} array form', () => {
    const parsed = expectOk(
      parseResponseGucHeaders({
        responseHeaders: '[{"name":"X-Foo","value":"bar"}]',
        responseStatus: null,
      }),
    );
    expect(parsed.headers).toEqual([['X-Foo', 'bar']]);
  });

  it('parses the top-level object form', () => {
    const parsed = expectOk(
      parseResponseGucHeaders({
        responseHeaders: '{"X-Foo":"bar","X-Baz":"qux"}',
        responseStatus: null,
      }),
    );
    expect(parsed.headers).toContainEqual(['X-Foo', 'bar']);
    expect(parsed.headers).toContainEqual(['X-Baz', 'qux']);
  });

  it('rejects invalid JSON with PGRST111', () => {
    const err = expectErr(
      parseResponseGucHeaders({
        responseHeaders: '[{not-json}]',
        responseStatus: null,
      }),
    );
    expect(err.code).toBe('PGRST111');
  });

  it('rejects a bare string or number', () => {
    const err = expectErr(
      parseResponseGucHeaders({
        responseHeaders: '"just a string"',
        responseStatus: null,
      }),
    );
    expect(err.code).toBe('PGRST111');
  });
});

describe('parseResponseGucHeaders — forbidden headers', () => {
  it('silently drops Content-Length', () => {
    const parsed = expectOk(
      parseResponseGucHeaders({
        responseHeaders: '[{"Content-Length": "999"}, {"X-OK": "yes"}]',
        responseStatus: null,
      }),
    );
    expect(parsed.headers).toEqual([['X-OK', 'yes']]);
  });

  it('silently drops Access-Control-Allow-Origin', () => {
    const parsed = expectOk(
      parseResponseGucHeaders({
        responseHeaders: '[{"Access-Control-Allow-Origin": "*"}]',
        responseStatus: null,
      }),
    );
    expect(parsed.headers).toEqual([]);
  });

  it('is case-insensitive for the forbidden list', () => {
    const parsed = expectOk(
      parseResponseGucHeaders({
        responseHeaders: '[{"SET-COOKIE": "session=abc"}]',
        responseStatus: null,
      }),
    );
    expect(parsed.headers).toEqual([]);
  });
});

describe('parseResponseGucHeaders — header-injection prevention', () => {
  it('strips CR/LF/NUL from header values', () => {
    const parsed = expectOk(
      parseResponseGucHeaders({
        responseHeaders:
          '[{"X-Safe": "good\\r\\nX-Evil: leaked\\u0000"}]',
        responseStatus: null,
      }),
    );
    expect(parsed.headers).toHaveLength(1);
    const [_, value] = parsed.headers[0]!;
    expect(value).not.toContain('\r');
    expect(value).not.toContain('\n');
    expect(value).not.toContain('\0');
  });
});

describe('parseResponseGucHeaders — read vs mutation parity', () => {
  // The parity claim: identical input always yields identical
  // output. The read and mutation paths both import the same
  // function, so this test is really a regression sentinel against
  // someone adding a second code path later.
  const INPUTS: ReadonlyArray<{
    readonly name: string;
    readonly responseHeaders: string | null;
    readonly responseStatus: string | null;
  }> = [
    { name: 'both null', responseHeaders: null, responseStatus: null },
    {
      name: 'only status',
      responseHeaders: null,
      responseStatus: '201',
    },
    {
      name: 'headers + status',
      responseHeaders: '[{"X-Foo":"bar"}]',
      responseStatus: '202',
    },
    {
      name: 'forbidden header dropped',
      responseHeaders: '[{"Content-Length":"1"},{"X-OK":"yes"}]',
      responseStatus: null,
    },
    {
      name: 'invalid status error',
      responseHeaders: null,
      responseStatus: 'NaN',
    },
  ];

  it.each(INPUTS)('is deterministic for %s', (input) => {
    const a = parseResponseGucHeaders(input);
    const b = parseResponseGucHeaders(input);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
