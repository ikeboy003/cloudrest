import { describe, expect, it } from 'vitest';

import { parseQueryParams } from '../../../src/parser/query-params';
import { planRead } from '../../../src/planner/plan-read';
import { expectErr, expectOk } from '../../fixtures/assert-result';
import { BOOKS_SCHEMA } from '../../fixtures/schema';

function plan(query: string) {
  const parsed = expectOk(parseQueryParams(new URLSearchParams(query)));
  return planRead({
    target: { schema: 'public', name: 'books' },
    parsed,
    preferences: { invalidPrefs: [] },
    schema: BOOKS_SCHEMA,
    mediaType: 'json',
    topLevelRange: { offset: 0, limit: null },
    hasPreRequest: false,
    maxRows: null,
  });
}

describe('planRead — table resolution', () => {
  it('plans an empty GET on a known table', () => {
    const r = expectOk(plan(''));
    expect(r.target).toEqual({ schema: 'public', name: 'books' });
  });

  it('rejects an unknown table with PGRST205 and a fuzzy suggestion', () => {
    const parsed = expectOk(parseQueryParams(new URLSearchParams('')));
    const r = expectErr(
      planRead({
        target: { schema: 'public', name: 'boks' },
        parsed,
        preferences: { invalidPrefs: [] },
        schema: BOOKS_SCHEMA,
        mediaType: 'json',
        topLevelRange: { offset: 0, limit: null },
        hasPreRequest: false,
        maxRows: null,
      }),
    );
    expect(r.code).toBe('PGRST205');
    expect(r.hint).toContain('books');
  });
});

describe('planRead — column validation', () => {
  it('accepts a filter on a known column', () => {
    const r = expectOk(plan('price=gt.10'));
    expect(r.filters).toHaveLength(1);
  });

  it('rejects a filter on an unknown column with PGRST204', () => {
    const r = expectErr(plan('prize=gt.10'));
    expect(r.code).toBe('PGRST204');
    // Fuzzy suggestion should point at `price`.
    expect(r.hint).toContain('price');
  });

  it('accepts a select on known columns', () => {
    const r = expectOk(plan('select=id,title'));
    expect(r.select).toHaveLength(2);
  });

  it('rejects a select on an unknown column', () => {
    expectErr(plan('select=id,bogus'));
  });

  it('validates columns inside nested logic trees', () => {
    expectErr(plan('and=(price.gt.10,nonexistent.eq.1)'));
  });
});

describe('planRead — distinct validation (IDENTIFIER-5 regression)', () => {
  it('accepts distinct on known columns', () => {
    const r = expectOk(plan('distinct=category'));
    expect(r.distinct?.columns).toEqual(['category']);
  });

  it('rejects distinct on an unknown column', () => {
    expectErr(plan('distinct=nonexistent'));
  });
});

describe('planRead — range clamping', () => {
  it('clamps limit to config.maxRows when set', () => {
    const parsed = expectOk(parseQueryParams(new URLSearchParams('limit=1000')));
    const r = expectOk(
      planRead({
        target: { schema: 'public', name: 'books' },
        parsed,
        preferences: { invalidPrefs: [] },
        schema: BOOKS_SCHEMA,
        mediaType: 'json',
        topLevelRange: { offset: 0, limit: 1000 },
        hasPreRequest: false,
        maxRows: 50,
      }),
    );
    expect(r.range.limit).toBe(50);
  });

  it('leaves limit alone when below maxRows', () => {
    const parsed = expectOk(parseQueryParams(new URLSearchParams('limit=10')));
    const r = expectOk(
      planRead({
        target: { schema: 'public', name: 'books' },
        parsed,
        preferences: { invalidPrefs: [] },
        schema: BOOKS_SCHEMA,
        mediaType: 'json',
        topLevelRange: { offset: 0, limit: 10 },
        hasPreRequest: false,
        maxRows: 50,
      }),
    );
    expect(r.range.limit).toBe(10);
  });
});

describe('planRead — stage-6b deferrals', () => {
  it('rejects embedded filters with notImplemented', () => {
    const r = expectErr(plan('posts.title=eq.Hello'));
    expect(r.code).toBe('PGRST127');
  });

  it('rejects embed select items', () => {
    const r = expectErr(plan('select=title,author(id)'));
    expect(r.code).toBe('PGRST127');
  });

  it('rejects related-order terms', () => {
    const r = expectErr(plan('order=author(name).desc'));
    expect(r.code).toBe('PGRST127');
  });
});
