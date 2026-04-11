// Stage 6b — search planner tests.
//
// Covers column validation (IDENTIFIER-11: no silent filtering), the
// required-columns rule, and the safe-language allowlist.

import { describe, expect, it } from 'vitest';

import { planSearch } from '@/planner/search';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';
import { BOOKS_SCHEMA } from '@tests/fixtures/schema';
import { findTable } from '@/schema/cache';

const booksTable = findTable(BOOKS_SCHEMA, { schema: 'public', name: 'books' })!;

describe('planSearch — column validation', () => {
  it('returns null when no search term is supplied', () => {
    const r = expectOk(
      planSearch({ term: null, columns: null, language: null, includeRank: false }, booksTable),
    );
    expect(r).toBeNull();
  });

  it('requires at least one column', () => {
    const r = expectErr(
      planSearch(
        { term: 'hello', columns: '', language: null, includeRank: false },
        booksTable,
      ),
    );
    expect(r.code).toBe('PGRST100');
    expect(r.message).toContain('search.columns');
  });

  it('rejects unknown columns with PGRST204 and a suggestion', () => {
    const r = expectErr(
      planSearch(
        { term: 'hello', columns: 'titel', language: null, includeRank: false },
        booksTable,
      ),
    );
    expect(r.code).toBe('PGRST204');
    expect(r.hint).toContain('title');
  });

  it('accepts a valid column list and defaults language to simple', () => {
    const r = expectOk(
      planSearch(
        { term: 'hello', columns: 'title,category', language: null, includeRank: false },
        booksTable,
      ),
    );
    expect(r!.columns).toEqual(['title', 'category']);
    expect(r!.language).toBe('simple');
    expect(r!.includeRank).toBe(false);
  });
});

describe('planSearch — language allowlist (#10)', () => {
  it('accepts english', () => {
    const r = expectOk(
      planSearch(
        { term: 'hello', columns: 'title', language: 'english', includeRank: false },
        booksTable,
      ),
    );
    expect(r!.language).toBe('english');
  });

  it('rejects a language with spaces or quote injection attempts', () => {
    const r = expectErr(
      planSearch(
        {
          term: 'hello',
          columns: 'title',
          language: "english'; DROP TABLE users--",
          includeRank: false,
        },
        booksTable,
      ),
    );
    expect(r.code).toBe('PGRST100');
    expect(r.message).toContain('search.language');
  });
});

describe('planSearch — includeRank', () => {
  it('threads includeRank through the plan', () => {
    const r = expectOk(
      planSearch(
        { term: 'hello', columns: 'title', language: null, includeRank: true },
        booksTable,
      ),
    );
    expect(r!.includeRank).toBe(true);
  });
});
