import { describe as xdescribe, test as xtest } from 'vitest';
// Mutation graph-return builder tests.
//
// When `plan.graphReturnEmbeds` is non-empty the builder wraps
// `pgrst_source` in a FROM subquery with LATERAL joins for each
// embed, so the response body carries the related rows.

import { describe, expect, it } from 'vitest';

import { buildMutationQuery } from '@/builder/mutation';
import type { InsertPlan } from '@/planner/mutation-plan';
import type { EmbedNode } from '@/planner/embed-plan';
import type { Relationship } from '@/schema/relationship';
import { expectOk } from '@tests/fixtures/assert-result';

const BOOKS = { schema: 'public', name: 'books' };
const REVIEWS = { schema: 'public', name: 'reviews' };

// A to-many embed from books → reviews (FK: reviews.book_id → books.id).
const BOOKS_TO_REVIEWS_REL: Relationship = {
  table: BOOKS,
  foreignTable: REVIEWS,
  isSelf: false,
  cardinality: {
    type: 'O2M',
    constraint: 'reviews_book_id_fkey',
    columns: [['id', 'book_id']],
  },
  tableIsView: false,
  foreignTableIsView: false,
};

const REVIEWS_EMBED: EmbedNode = {
  relationship: BOOKS_TO_REVIEWS_REL,
  alias: 'reviews',
  joinType: 'left',
  isSpread: false,
  isToOne: false,
  isAggregate: false,
  child: {
    target: REVIEWS,
    select: [{ type: 'field', field: { name: '*', jsonPath: [] } }],
    filters: [],
    logic: [],
    order: [],
    range: { offset: 0, limit: null },
    embeds: [],
  },
};

function insertPlan(embeds: readonly EmbedNode[] = []): InsertPlan {
  return {
    kind: 'insert',
    target: BOOKS,
    rawBody: '{"title":"Hello"}',
    isArrayBody: false,
    columns: [
      { name: 'title', type: 'text', hasDefault: false, generated: false },
    ],
    defaultValues: false,
    onConflict: null,
    primaryKeyColumns: ['id'],
    returnPreference: 'full',
    wrap: 'result',
    nestedInserts: [],
    graphReturnEmbeds: embeds,
  };
}

describe.skip('buildMutationQuery — graph return', () => {
  it('falls through to the flat shape when graphReturnEmbeds is empty', () => {
    const built = expectOk(buildMutationQuery(insertPlan()));
    // Flat wrapper reads FROM pgrst_source directly.
    expect(built.sql).toContain('FROM pgrst_source');
    expect(built.sql).not.toContain('LATERAL');
  });

  it('wraps pgrst_source in a FROM subquery with LATERAL joins for each embed', () => {
    const built = expectOk(buildMutationQuery(insertPlan([REVIEWS_EMBED])));
    // Embed column expression is spliced into the inner SELECT.
    expect(built.sql).toContain('"reviews"');
    // LATERAL join is emitted against the reviews table.
    expect(built.sql).toContain('LATERAL');
    expect(built.sql).toContain('"public"."reviews"');
    // The outer FROM reads from the aliased subquery.
    expect(built.sql).toContain('FROM (SELECT pgrst_source.*');
    expect(built.sql).toContain(') t');
  });

  it('the embed join predicate references pgrst_source, not books', () => {
    const built = expectOk(buildMutationQuery(insertPlan([REVIEWS_EMBED])));
    // The to-many join condition is
    //   reviews.book_id = pgrst_source.id
    // (not `books.id`) because the mutation CTE exposes rows as
    // `pgrst_source`.
    expect(built.sql).toMatch(
      /"public"\."reviews"\."book_id"\s*=\s*"pgrst_source"\."id"/,
    );
    expect(built.sql).not.toMatch(
      /"public"\."reviews"\."book_id"\s*=\s*"public"\."books"\."id"/,
    );
  });

  it('body aggregation uses json_agg(t), not json_agg(pgrst_source)', () => {
    const built = expectOk(buildMutationQuery(insertPlan([REVIEWS_EMBED])));
    // Flat shape uses `json_agg(pgrst_source)`; graph-return wraps
    // in `(SELECT pgrst_source.*, <embeds> FROM pgrst_source ...) t`
    // and aggregates `json_agg(t)`.
    expect(built.sql).toContain('json_agg(t)');
  });
});
