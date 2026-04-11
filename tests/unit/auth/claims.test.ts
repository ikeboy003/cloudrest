// Stage 8a — claim-path walker tests (behavior-preservation).

import { describe, expect, it } from 'vitest';

import { walkClaimPath, parseClaimPath } from '../../../src/auth/claims';

describe('walkClaimPath — key access', () => {
  it('walks a simple dotted path', () => {
    const claims = { role: 'authenticated' };
    expect(walkClaimPath(claims, '.role')).toBe('authenticated');
  });

  it('walks a nested path', () => {
    const claims = { app_metadata: { role: 'admin' } };
    expect(walkClaimPath(claims, '.app_metadata.role')).toBe('admin');
  });

  it('handles quoted keys with special characters', () => {
    const claims = { 'my-key': 'value' };
    expect(walkClaimPath(claims, '."my-key"')).toBe('value');
  });

  it('returns undefined when a key is missing', () => {
    expect(walkClaimPath({ a: 1 }, '.b')).toBeUndefined();
  });

  it('returns undefined when walking into a non-object', () => {
    expect(walkClaimPath({ a: 1 }, '.a.b')).toBeUndefined();
  });
});

describe('walkClaimPath — array index', () => {
  it('reads a numeric index', () => {
    const claims = { roles: ['admin', 'user'] };
    expect(walkClaimPath(claims, '.roles[0]')).toBe('admin');
    expect(walkClaimPath(claims, '.roles[1]')).toBe('user');
  });

  it('returns undefined when indexing a non-array', () => {
    expect(walkClaimPath({ roles: 'admin' }, '.roles[0]')).toBeUndefined();
  });
});

describe('walkClaimPath — slice', () => {
  it('slices a string with [start:end]', () => {
    expect(walkClaimPath({ s: 'hello world' }, '.s[0:5]')).toBe('hello');
    expect(walkClaimPath({ s: 'hello' }, '.s[1:]')).toBe('ello');
    expect(walkClaimPath({ s: 'hello' }, '.s[:3]')).toBe('hel');
  });

  it('handles negative indices', () => {
    expect(walkClaimPath({ s: 'hello' }, '.s[-3:]')).toBe('llo');
  });
});

describe('walkClaimPath — filter', () => {
  it('finds an entry that equals the filter value', () => {
    const claims = { roles: ['admin', 'user'] };
    expect(walkClaimPath(claims, '.roles[?(@ == "admin")]')).toBe('admin');
  });

  it('returns undefined when no entry matches', () => {
    const claims = { roles: ['user'] };
    expect(
      walkClaimPath(claims, '.roles[?(@ == "admin")]'),
    ).toBeUndefined();
  });

  it('supports startsWith / endsWith / contains', () => {
    expect(
      walkClaimPath({ a: ['foo', 'bar'] }, '.a[?(@ ^== "fo")]'),
    ).toBe('foo');
    expect(
      walkClaimPath({ a: ['foo', 'bar'] }, '.a[?(@ ==^ "ar")]'),
    ).toBe('bar');
    expect(
      walkClaimPath({ a: ['foo', 'bar'] }, '.a[?(@ *== "oo")]'),
    ).toBe('foo');
  });
});

describe('parseClaimPath — bad input', () => {
  it('returns [] for an unterminated quoted key', () => {
    expect(parseClaimPath('."unterminated')).toEqual([]);
  });

  it('returns [] for an unterminated bracket', () => {
    expect(parseClaimPath('.a[')).toEqual([]);
  });

  it('returns [] for an empty dotted segment', () => {
    expect(parseClaimPath('..a')).toEqual([]);
  });
});
