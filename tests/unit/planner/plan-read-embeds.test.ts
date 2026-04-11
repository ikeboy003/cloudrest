// Stage 6b — embed planner tests.
//
// Covers resolution, hint/alias, join-type, nested embeds, aggregate
// embeds, per-embed filters/order/range, and the PGRST108 guard on
// to-many related-order terms.

import { describe, expect, it } from 'vitest';

import { parseQueryParams } from '@/parser/query-params';
import { planRead } from '@/planner/plan-read';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';
import { LIBRARY_SCHEMA } from '@tests/fixtures/schema';

function plan(query: string, target = { schema: 'public', name: 'books' }) {
  const parsed = expectOk(parseQueryParams(new URLSearchParams(query)));
  return planRead({
    target,
    parsed,
    preferences: { invalidPrefs: [] },
    schema: LIBRARY_SCHEMA,
    mediaType: 'json',
    topLevelRange: { offset: 0, limit: null },
    hasPreRequest: false,
    maxRows: null,
  });
}

describe('planRead embeds — basic resolution', () => {
  it('resolves a to-one embed via the FK column', () => {
    const r = expectOk(plan('select=id,title,authors(name)'));
    expect(r.embeds).toHaveLength(1);
    const embed = r.embeds[0]!;
    expect(embed.alias).toBe('authors');
    expect(embed.isToOne).toBe(true);
    expect(embed.relationship.cardinality.type).toBe('M2O');
    expect(embed.child.target).toEqual({ schema: 'public', name: 'authors' });
  });

  it('resolves a to-many embed with a nested column list', () => {
    const r = expectOk(plan('select=id,reviews(id,rating)'));
    expect(r.embeds).toHaveLength(1);
    const embed = r.embeds[0]!;
    expect(embed.isToOne).toBe(false);
    expect(embed.child.select.map((s) => (s.type === 'field' ? s.field.name : '')))
      .toEqual(['id', 'rating']);
  });

  it('allows a user alias to rename the JSON key', () => {
    const r = expectOk(plan('select=id,author:authors(name)'));
    expect(r.embeds[0]!.alias).toBe('author');
  });

  it('rejects an unknown relation with PGRST202', () => {
    const r = expectErr(plan('select=id,publisher(name)'));
    expect(r.code).toBe('PGRST202');
  });
});

describe('planRead embeds — join-type handling', () => {
  it('defaults to left join', () => {
    const r = expectOk(plan('select=id,reviews(id)'));
    expect(r.embeds[0]!.joinType).toBe('left');
  });

  it('honors !inner on an embed', () => {
    const r = expectOk(plan('select=id,reviews!inner(id)'));
    expect(r.embeds[0]!.joinType).toBe('inner');
  });
});

describe('planRead embeds — nested depth', () => {
  it('walks a two-level embed tree', () => {
    const r = expectOk(
      plan('select=name,books(id,reviews(rating))', {
        schema: 'public',
        name: 'authors',
      }),
    );
    const books = r.embeds[0]!;
    expect(books.child.target.name).toBe('books');
    expect(books.child.embeds).toHaveLength(1);
    const reviews = books.child.embeds[0]!;
    expect(reviews.child.target.name).toBe('reviews');
  });
});

describe('planRead embeds — filter/order/range attachment', () => {
  it('attaches an embedded filter to the right child subtree', () => {
    const r = expectOk(plan('select=id,reviews(id,rating)&reviews.rating=gt.3'));
    const reviews = r.embeds[0]!;
    expect(reviews.child.filters).toHaveLength(1);
    expect(reviews.child.filters[0]!.field.name).toBe('rating');
  });

  it('rejects an embedded filter that targets an unknown child column', () => {
    const r = expectErr(
      plan('select=id,reviews(id)&reviews.bogus=eq.1'),
    );
    expect(r.code).toBe('PGRST204');
  });

  it('threads per-embed limit through the child range', () => {
    const r = expectOk(plan('select=id,reviews(id)&reviews.limit=5'));
    const reviews = r.embeds[0]!;
    expect(reviews.child.range.limit).toBe(5);
  });
});

describe('planRead embeds — order validation', () => {
  it('allows ordering parent rows by a to-one embed column', () => {
    const r = expectOk(plan('select=id,authors(name)&order=authors(name).desc'));
    expect(r.order).toHaveLength(1);
    expect(r.order[0]!.relation).toBe('authors');
  });

  it('rejects ordering parent rows by a to-many embed column (PGRST108)', () => {
    const r = expectErr(plan('select=id,reviews(id)&order=reviews(rating).desc'));
    expect(r.code).toBe('PGRST108');
  });
});
