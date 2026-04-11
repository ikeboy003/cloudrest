// Stage 6b — builder integration test for the embed path.
//
// These tests drive the planner with a real relationship fixture and
// feed the resulting ReadPlan into buildReadQuery, asserting on the
// shape of the emitted SQL. They are not a complete builder
// specification — they pin the guarantees the rewrite has to uphold
// while the old test corpus is being ported.

import { describe, expect, it } from 'vitest';

import { buildReadQuery } from '@/builder/read';
import { parseQueryParams } from '@/parser/query-params';
import { planRead } from '@/planner/plan-read';
import { expectOk } from '@tests/fixtures/assert-result';
import { LIBRARY_SCHEMA } from '@tests/fixtures/schema';

function plan(query: string, target = { schema: 'public', name: 'books' }) {
  const parsed = expectOk(parseQueryParams(new URLSearchParams(query)));
  return expectOk(
    planRead({
      target,
      parsed,
      preferences: { invalidPrefs: [] },
      schema: LIBRARY_SCHEMA,
      mediaType: 'json',
      topLevelRange: { offset: 0, limit: null },
      hasPreRequest: false,
      maxRows: null,
    }),
  );
}

describe('buildReadQuery — to-one embed', () => {
  it('emits a LEFT JOIN LATERAL for a to-one embed and a row_to_json column', () => {
    const p = plan('select=id,title,authors(name)');
    const built = expectOk(buildReadQuery(p));
    expect(built.sql).toContain('LEFT JOIN LATERAL');
    expect(built.sql).toContain('row_to_json');
    expect(built.sql).toContain('AS "authors"');
    expect(built.sql).toContain('"public"."authors"."id" = "public"."books"."author_id"');
    // The inner SELECT must project real columns, not `[object Object]`.
    expect(built.sql).not.toContain('[object Object]');
    expect(built.sql).toContain('"public"."authors"."name"');
  });

  it('honors !inner to-one with INNER JOIN LATERAL', () => {
    const p = plan('select=id,authors!inner(name)');
    const built = expectOk(buildReadQuery(p));
    expect(built.sql).toContain('INNER JOIN LATERAL');
    expect(built.sql).not.toContain('[object Object]');
  });
});

describe('buildReadQuery — to-many embed', () => {
  it('emits a json_agg aggregator wrapped in a LATERAL subquery', () => {
    const p = plan('select=id,reviews(id,rating)');
    const built = expectOk(buildReadQuery(p));
    expect(built.sql).toContain('json_agg');
    expect(built.sql).toContain('LEFT JOIN LATERAL');
    expect(built.sql).toContain("COALESCE");
    expect(built.sql).toContain('AS "reviews"');
    // Inner SELECT must reference real columns.
    expect(built.sql).not.toContain('[object Object]');
    expect(built.sql).toContain('"public"."reviews"."id"');
    expect(built.sql).toContain('"public"."reviews"."rating"');
  });

  it('filters attached to an embed live inside the inner subquery', () => {
    const p = plan('select=id,reviews(id,rating)&reviews.rating=gt.3');
    const built = expectOk(buildReadQuery(p));
    // Parameter binding for the filter value
    expect(built.params).toContain('3');
    // The rating comparison must appear inside the join (not at root)
    expect(built.sql).toMatch(/"public"\."reviews"\."rating" > \$\d+/);
  });

  it('!inner to-many uses IS NOT NULL on the agg alias to filter empty children', () => {
    const p = plan('select=id,reviews!inner(id)');
    const built = expectOk(buildReadQuery(p));
    expect(built.sql).toContain('INNER JOIN LATERAL');
    expect(built.sql).toContain('IS NOT NULL');
  });
});

describe('buildReadQuery — nested embeds', () => {
  it('walks a two-level embed tree and nests the inner subquery', () => {
    const p = plan('select=name,books(id,reviews(rating))', {
      schema: 'public',
      name: 'authors',
    });
    const built = expectOk(buildReadQuery(p));
    // Two distinct pgrst_ aliases, one per embed level
    expect(built.sql).toMatch(/pgrst_1/);
    expect(built.sql).toMatch(/pgrst_2/);
    expect(built.sql).toContain('AS "books"');
    expect(built.sql).toContain('AS "reviews"');
    expect(built.sql).not.toContain('[object Object]');
    expect(built.sql).toContain('"public"."books"."id"');
    expect(built.sql).toContain('"public"."reviews"."rating"');
  });
});
