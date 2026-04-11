import { describe, expect, it } from 'vitest';

import { buildReadQuery } from '../../../src/builder/read';
import type { ReadPlan } from '../../../src/planner/read-plan';
import { parseFilter } from '../../../src/parser/filter';
import { parseOrder } from '../../../src/parser/order';
import { parseSelect } from '../../../src/parser/select';
import { expectOk } from '../../fixtures/assert-result';

// ----- Plan builder helper ---------------------------------------------

function basePlan(overrides: Partial<ReadPlan> = {}): ReadPlan {
  return {
    target: { schema: 'public', name: 'books' },
    select: [],
    filters: [],
    logic: [],
    order: [],
    range: { offset: 0, limit: null },
    having: [],
    count: null,
    mediaType: 'json',
    hasPreRequest: false,
    maxRows: null,
    embeds: [],
    ...overrides,
  };
}

// ----- Basic projection + FROM -----------------------------------------

describe('buildReadQuery — basic shape', () => {
  it('produces SELECT ... FROM subquery wrapper for empty plan', () => {
    const built = expectOk(buildReadQuery(basePlan()));
    // Outer wrapper shape.
    expect(built.sql).toContain('SELECT');
    expect(built.sql).toContain('AS total_result_set');
    expect(built.sql).toContain('pg_catalog.count(t) AS page_total');
    expect(built.sql).toContain('AS body');
    expect(built.sql).toContain('FROM (');
    expect(built.sql).toContain(') t');
    // Inner projection falls back to `.* ` when select is empty.
    expect(built.sql).toContain('"public"."books".*');
    // No count by default.
    expect(built.sql).toContain('null::bigint AS total_result_set');
    expect(built.params).toEqual([]);
  });

  it('emits user-specified columns in the projection', () => {
    const select = expectOk(parseSelect('id,title'));
    const built = expectOk(buildReadQuery(basePlan({ select })));
    expect(built.sql).toContain('"public"."books"."id", "public"."books"."title"');
  });

  it('omits GUC columns when hasPreRequest=false and sets skipGucRead', () => {
    const built = expectOk(buildReadQuery(basePlan()));
    expect(built.sql).not.toContain("current_setting('response.headers'");
    expect(built.skipGucRead).toBe(true);
  });

  it('includes GUC columns when hasPreRequest=true', () => {
    const built = expectOk(buildReadQuery(basePlan({ hasPreRequest: true })));
    expect(built.sql).toContain("current_setting('response.headers'");
    expect(built.sql).toContain("current_setting('response.status'");
    expect(built.skipGucRead).toBeUndefined();
  });
});

// ----- Filters + range --------------------------------------------------

describe('buildReadQuery — filters and range', () => {
  it('renders root filters in the inner WHERE with bound params', () => {
    const filter = expectOk(parseFilter('price', 'gt.10'));
    expect(filter).not.toBeNull();
    const built = expectOk(
      buildReadQuery(basePlan({ filters: [filter!.filter] })),
    );
    expect(built.sql).toContain('"public"."books"."price" > $1');
    expect(built.params).toEqual(['10']);
  });

  it('emits LIMIT and OFFSET inlined into the inner query', () => {
    const built = expectOk(
      buildReadQuery(basePlan({ range: { offset: 10, limit: 5 } })),
    );
    expect(built.sql).toContain('LIMIT 5 OFFSET 10');
  });

  it('applies the media-type row cap for singular responses', () => {
    // No explicit limit, singular media type -> inner LIMIT 2.
    const built = expectOk(
      buildReadQuery(basePlan({ mediaType: 'singular' })),
    );
    expect(built.sql).toContain('LIMIT 2');
  });

  it('applies the DB_MAX_ROWS ceiling', () => {
    const built = expectOk(
      buildReadQuery(basePlan({ maxRows: 100, range: { offset: 0, limit: null } })),
    );
    expect(built.sql).toContain('LIMIT 100');
  });
});

// ----- Order, group-by, having -----------------------------------------

describe('buildReadQuery — order, group-by, having', () => {
  it('renders ORDER BY with direction and null order', () => {
    const order = expectOk(parseOrder('name.desc.nullslast'));
    const built = expectOk(buildReadQuery(basePlan({ order })));
    expect(built.sql).toContain('ORDER BY "public"."books"."name" DESC NULLS LAST');
  });

  it('emits GROUP BY for mixed aggregate + plain select', () => {
    const select = expectOk(parseSelect('category,count()'));
    const built = expectOk(buildReadQuery(basePlan({ select })));
    expect(built.sql).toContain('GROUP BY "public"."books"."category"');
    expect(built.sql).toContain('COUNT(*)');
  });
});

// ----- Count strategy --------------------------------------------------

describe('buildReadQuery — count strategies', () => {
  it('emits an exact-count CTE for count=exact', () => {
    const built = expectOk(buildReadQuery(basePlan({ count: 'exact' })));
    expect(built.sql).toContain('WITH pgrst_source_count AS');
    expect(built.sql).toContain('(SELECT pg_catalog.count(*) FROM pgrst_source_count)');
  });

  it('emits a pg_class reltuples lookup for count=planned', () => {
    const built = expectOk(buildReadQuery(basePlan({ count: 'planned' })));
    expect(built.sql).toContain('FROM pg_class');
    expect(built.sql).toContain('reltuples::bigint');
    // planned does NOT use the CTE.
    expect(built.sql).not.toContain('WITH pgrst_source_count');
  });

  it('emits a materialized CTE + fallback for count=estimated', () => {
    const built = expectOk(buildReadQuery(basePlan({ count: 'estimated' })));
    expect(built.sql).toContain('MATERIALIZED');
    expect(built.sql).toContain('reltuples::bigint');
  });

  it('emits null::bigint when count is null', () => {
    const built = expectOk(buildReadQuery(basePlan()));
    expect(built.sql).toContain('null::bigint AS total_result_set');
  });
});

// ----- DISTINCT ---------------------------------------------------------

describe('buildReadQuery — distinct as a first-class plan field', () => {
  it('emits DISTINCT ON (cols) for a non-empty distinct plan', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({ distinct: { columns: ['category', 'vendor'] } }),
      ),
    );
    expect(built.sql).toContain('DISTINCT ON ("public"."books"."category", "public"."books"."vendor")');
  });

  it('emits bare DISTINCT for an empty distinct column list', () => {
    const built = expectOk(
      buildReadQuery(basePlan({ distinct: { columns: [] } })),
    );
    // Avoid matching DISTINCT ON by checking for the non-ON form.
    expect(built.sql).toContain('SELECT DISTINCT "public"."books".*');
  });
});

// ----- Search as a first-class plan field -------------------------------

describe('buildReadQuery — search is a first-class plan field', () => {
  // REGRESSION (critique #10): the language token must be BOUND as a
  // parameter, not inlined. CONSTITUTION §1.3.
  it('binds the search language as an SqlBuilder parameter', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          search: {
            term: 'rocket',
            columns: ['title', 'body'],
            language: 'english',
            includeRank: false,
          },
        }),
      ),
    );
    // The language should appear in params, not inlined into the SQL.
    expect(built.params).toContain('english');
    expect(built.params).toContain('rocket');
    // The SQL should reference the bound params by number, not contain
    // the literal language string outside a param reference.
    expect(built.sql).toContain('to_tsvector($');
    expect(built.sql).toContain('websearch_to_tsquery($');
    expect(built.sql).not.toContain("'english'");
  });

  it('emits a ts_rank projection when includeRank is set', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          search: {
            term: 'rocket',
            columns: ['title'],
            language: 'simple',
            includeRank: true,
          },
        }),
      ),
    );
    expect(built.sql).toContain('ts_rank(');
    expect(built.sql).toContain('AS "relevance"');
  });

  it('combines search with an existing WHERE filter', () => {
    const filter = expectOk(parseFilter('published', 'is.true'));
    expect(filter).not.toBeNull();
    const built = expectOk(
      buildReadQuery(
        basePlan({
          filters: [filter!.filter],
          search: {
            term: 'rocket',
            columns: ['title'],
            language: 'simple',
            includeRank: false,
          },
        }),
      ),
    );
    expect(built.sql).toContain(' AND ');
    expect(built.sql).toContain('IS TRUE');
    expect(built.sql).toContain('websearch_to_tsquery');
  });
});

// ----- Vector as a first-class plan field -------------------------------

describe('buildReadQuery — vector is a first-class plan field', () => {
  // REGRESSION (critique #77, #78): the vector value is bound as a
  // parameter. The old code rewrote $N placeholders after the fact
  // (see injectVectorIntoInnerSubquery in cloudrest-public) and
  // produced `<=> LIMIT ::vector` bugs. The rewrite builds the
  // expression inline during the single render pass.
  it('binds the vector literal as an SqlBuilder parameter', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          vector: {
            queryVector: [0.1, 0.2, 0.3],
            column: 'embedding',
            op: 'cosine',
          },
        }),
      ),
    );
    expect(built.params).toContain('[0.1,0.2,0.3]');
    expect(built.sql).toContain('"public"."books"."embedding" <=>');
    expect(built.sql).toContain('::vector');
  });

  it('adds distance as a SELECT column AND an ORDER BY term', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          vector: { queryVector: [1, 2], column: 'embedding', op: 'l2' },
        }),
      ),
    );
    expect(built.sql).toContain('AS "distance"');
    expect(built.sql).toContain('ORDER BY');
  });

  it('preserves user ORDER BY and appends distance as a tiebreaker', () => {
    const order = expectOk(parseOrder('title.asc'));
    const built = expectOk(
      buildReadQuery(
        basePlan({
          order,
          vector: { queryVector: [1], column: 'embedding', op: 'cosine' },
        }),
      ),
    );
    // The user order comes first; the distance is appended.
    const orderIdx = built.sql.indexOf('ORDER BY');
    const userColIdx = built.sql.indexOf('"title" ASC', orderIdx);
    const distanceIdx = built.sql.indexOf('<=>', orderIdx);
    expect(userColIdx).toBeGreaterThan(-1);
    expect(distanceIdx).toBeGreaterThan(userColIdx);
  });

  // CONSTITUTION §1.1: no post-hoc SQL rewrites. There must be exactly
  // one render pass, and the built SQL must already contain the
  // distance expression — not be re-patched later.
  it('does not require a post-build SQL rewrite', () => {
    const built = expectOk(
      buildReadQuery(
        basePlan({
          vector: { queryVector: [1], column: 'embedding', op: 'l2' },
        }),
      ),
    );
    // A smoke test: the built SQL must be self-consistent. Count $N
    // occurrences and confirm they match params.length.
    const paramRefs = built.sql.match(/\$\d+/g) ?? [];
    const uniqueParamNums = new Set(paramRefs.map((s) => Number(s.slice(1))));
    expect(Math.max(...uniqueParamNums)).toBeLessThanOrEqual(built.params.length);
    expect(uniqueParamNums.size).toBeGreaterThan(0);
  });
});

// ----- Combined feature test -------------------------------------------

describe('buildReadQuery — combined features', () => {
  it('renders select + filters + order + limit + count + distinct + vector together', () => {
    const select = expectOk(parseSelect('id,title'));
    const filter = expectOk(parseFilter('published', 'is.true'));
    expect(filter).not.toBeNull();
    const order = expectOk(parseOrder('title.asc'));
    const built = expectOk(
      buildReadQuery(
        basePlan({
          select,
          filters: [filter!.filter],
          order,
          range: { offset: 0, limit: 10 },
          count: 'exact',
          distinct: { columns: ['category'] },
          vector: { queryVector: [1, 2], column: 'embedding', op: 'cosine' },
        }),
      ),
    );

    // Every major piece appears.
    expect(built.sql).toContain('WITH pgrst_source_count');
    expect(built.sql).toContain('DISTINCT ON ("public"."books"."category")');
    expect(built.sql).toContain('"public"."books"."id"');
    expect(built.sql).toContain('"public"."books"."title"');
    expect(built.sql).toContain('<=>');
    expect(built.sql).toContain('ORDER BY');
    expect(built.sql).toContain('LIMIT 10');

    // Single render pass — no post-hoc replacements.
    expect(built.params.length).toBeGreaterThan(0);
  });
});
