import { describe, expect, it } from 'vitest';

import {
  isValidCast,
  renderField,
  renderFilter,
  renderGroupBy,
  renderHaving,
  renderLimitOffset,
  renderLogicTree,
  renderOrderClause,
  renderOrderTerm,
  renderSelectProjection,
} from '@/builder/fragments';
import { SqlBuilder } from '@/builder/sql';
import { isOk, type Result } from '@/core/result';
import type { CloudRestError } from '@/core/errors';
import { parseSelect } from '@/parser/select';
import { parseFilter } from '@/parser/filter';
import { parseOrder } from '@/parser/order';
import { parseLogicTree } from '@/parser/logic';
import { parseHavingClauses } from '@/parser/having';

// ----- Helpers ---------------------------------------------------------

const target = { schema: 'public', name: 'books' } as const;

/**
 * Assert a Result is ok and return its value.
 * Pattern the parser test audit will enforce: never let a silent Err
 * pass through a test guard.
 */
function mustOk<T>(result: Result<T, CloudRestError>): T {
  if (!isOk(result)) {
    throw new Error(
      `expected Ok, got Err(${result.error.code}): ${result.error.message}`,
    );
  }
  return result.value;
}

// ----- Identifier/field rendering --------------------------------------

describe('renderField', () => {
  it('renders a plain column', () => {
    const b = new SqlBuilder();
    const sql = mustOk(renderField(target, { name: 'title', jsonPath: [] }, b));
    expect(sql).toBe('"public"."books"."title"');
    expect(b.paramCount).toBe(0);
  });

  it('renders a wildcard', () => {
    const b = new SqlBuilder();
    const sql = mustOk(renderField(target, { name: '*', jsonPath: [] }, b));
    expect(sql).toBe('"public"."books".*');
  });

  // SECURITY: JSON keys must be bound as params, not inlined. Critique #11.
  it('binds JSON string keys as SqlBuilder params', () => {
    const b = new SqlBuilder();
    const sql = mustOk(
      renderField(
        target,
        {
          name: 'data',
          jsonPath: [{ type: 'arrow', operand: { type: 'key', value: "O'Reilly" } }],
        },
        b,
      ),
    );
    expect(sql).toBe('"public"."books"."data"->$1');
    const built = b.toBuiltQuery();
    expect(built.params).toEqual(["O'Reilly"]);
  });

  it('inlines integer JSON indices', () => {
    const b = new SqlBuilder();
    const sql = mustOk(
      renderField(
        target,
        {
          name: 'tags',
          jsonPath: [{ type: 'arrow', operand: { type: 'idx', value: '0' } }],
        },
        b,
      ),
    );
    expect(sql).toBe('"public"."books"."tags"->0');
    expect(b.paramCount).toBe(0);
  });

  it('rejects malformed JSON index values', () => {
    const b = new SqlBuilder();
    const r = renderField(
      target,
      {
        name: 'tags',
        jsonPath: [{ type: 'arrow', operand: { type: 'idx', value: '1;DROP TABLE users' } }],
      },
      b,
    );
    expect(r.ok).toBe(false);
  });
});

// ----- Filter rendering ------------------------------------------------

describe('renderFilter', () => {
  it('renders eq as $1 binding', () => {
    const b = new SqlBuilder();
    const filter = mustOk(parseFilter('price', 'gt.10'));
    expect(filter).not.toBeNull();
    const sql = mustOk(renderFilter(target, filter!.filter, b));
    expect(sql).toBe('"public"."books"."price" > $1');
    expect(b.toBuiltQuery().params).toEqual(['10']);
  });

  it('renders is.null as inlined IS NULL', () => {
    const b = new SqlBuilder();
    const filter = mustOk(parseFilter('parent_id', 'is.null'));
    const sql = mustOk(renderFilter(target, filter!.filter, b));
    expect(sql).toBe('"public"."books"."parent_id" IS NULL');
    expect(b.paramCount).toBe(0);
  });

  it('renders IN as bound array literal', () => {
    const b = new SqlBuilder();
    const filter = mustOk(parseFilter('id', 'in.(1,2,3)'));
    const sql = mustOk(renderFilter(target, filter!.filter, b));
    expect(sql).toBe('"public"."books"."id" = ANY($1)');
    expect(b.toBuiltQuery().params).toEqual(['{"1","2","3"}']);
  });

  it('renders negated filters with NOT prefix', () => {
    const b = new SqlBuilder();
    const filter = mustOk(parseFilter('name', 'not.eq.foo'));
    const sql = mustOk(renderFilter(target, filter!.filter, b));
    expect(sql).toBe('NOT "public"."books"."name" = $1');
  });

  // SECURITY: like/ilike escaping — user wildcards `*` map to `%`, and
  // `_` and `\` are escaped so they don't become SQL wildcards.
  it('rewrites * → % and escapes _ / \\ for ilike', () => {
    const b = new SqlBuilder();
    const filter = mustOk(parseFilter('name', 'ilike.*foo_bar*'));
    const sql = mustOk(renderFilter(target, filter!.filter, b));
    expect(sql).toBe('"public"."books"."name" ilike $1');
    expect(b.toBuiltQuery().params).toEqual(['%foo\\_bar%']);
  });

  // SECURITY: FTS language token must be bound, not inlined. Critique #10.
  it('binds FTS language as a parameter', () => {
    const b = new SqlBuilder();
    const filter = mustOk(parseFilter('content', 'plfts(english).search'));
    const sql = mustOk(renderFilter(target, filter!.filter, b));
    expect(sql).toBe('"public"."books"."content" @@ plainto_tsquery($1, $2)');
    expect(b.toBuiltQuery().params).toEqual(['english', 'search']);
  });
});

// ----- Logic tree ------------------------------------------------------

describe('renderLogicTree', () => {
  it('renders flat and', () => {
    const b = new SqlBuilder();
    const tree = mustOk(parseLogicTree('and', false, '(price.gt.10,stock.gte.1)'));
    const sql = mustOk(renderLogicTree(target, tree, b));
    expect(sql).toBe(
      '("public"."books"."price" > $1 AND "public"."books"."stock" >= $2)',
    );
  });

  it('renders nested or with NOT prefix', () => {
    const b = new SqlBuilder();
    const tree = mustOk(
      parseLogicTree('or', true, '(name.ilike.*a*,name.ilike.*b*)'),
    );
    const sql = mustOk(renderLogicTree(target, tree, b));
    expect(sql.startsWith('NOT (')).toBe(true);
    expect(sql).toContain(' OR ');
  });
});

// ----- Order -----------------------------------------------------------

describe('renderOrderClause', () => {
  it('renders ORDER BY with direction and nulls', () => {
    const b = new SqlBuilder();
    const order = mustOk(parseOrder('name.desc.nullslast'));
    const sql = mustOk(renderOrderClause(target, order, b));
    expect(sql).toBe('ORDER BY "public"."books"."name" DESC NULLS LAST');
  });

  it('renders an empty list as empty string', () => {
    const b = new SqlBuilder();
    expect(mustOk(renderOrderClause(target, [], b))).toBe('');
  });

  it('renders a relation-scoped order against the embed lateral alias', () => {
    // BUG FIX (#CC2): root-level `order=author(name).asc` used to
    // render as `"public"."author"."name" ASC`, which is not a
    // valid FROM-clause reference when `author` is joined as a
    // LATERAL subquery. The renderer now takes an embed-alias map
    // from `renderEmbeds` and emits `"pgrst_1"."name"` instead.
    const b = new SqlBuilder();
    const order = mustOk(parseOrder('author(name).asc'));
    const embedAliases = new Map([['author', 'pgrst_1']]);
    const sql = mustOk(renderOrderTerm(target, order[0]!, b, embedAliases));
    expect(sql).toBe('"pgrst_1"."name" ASC');
  });

  it('errors when a relation-scoped order has no embed alias map', () => {
    // Without the alias map the old code produced invalid SQL;
    // the new code refuses and returns PGRST100 instead.
    const b = new SqlBuilder();
    const order = mustOk(parseOrder('author(name).asc'));
    const r = renderOrderTerm(target, order[0]!, b);
    expect(r.ok).toBe(false);
  });
});

describe('renderLimitOffset', () => {
  it('emits LIMIT and OFFSET when set', () => {
    expect(renderLimitOffset(5, 10)).toBe('LIMIT 10 OFFSET 5');
  });

  it('omits zero offset', () => {
    expect(renderLimitOffset(0, 10)).toBe('LIMIT 10');
  });

  it('omits null limit', () => {
    expect(renderLimitOffset(5, null)).toBe('OFFSET 5');
  });

  it('is empty when neither is set', () => {
    expect(renderLimitOffset(0, null)).toBe('');
  });
});

// ----- Select ----------------------------------------------------------

describe('renderSelectProjection', () => {
  it('renders plain columns', () => {
    const b = new SqlBuilder();
    const select = mustOk(parseSelect('id,title'));
    const sql = mustOk(renderSelectProjection(target, select, b));
    expect(sql).toBe('"public"."books"."id", "public"."books"."title"');
  });

  it('renders aliases and casts', () => {
    const b = new SqlBuilder();
    const select = mustOk(parseSelect('n:title::text'));
    const sql = mustOk(renderSelectProjection(target, select, b));
    expect(sql).toBe('CAST("public"."books"."title" AS text) AS "n"');
  });

  it('renders count(*) with a default alias', () => {
    const b = new SqlBuilder();
    const select = mustOk(parseSelect('count()'));
    const sql = mustOk(renderSelectProjection(target, select, b));
    expect(sql).toBe('COUNT(*) AS "count"');
  });

  it('renders avg(col)', () => {
    const b = new SqlBuilder();
    const select = mustOk(parseSelect('avg(rating)'));
    const sql = mustOk(renderSelectProjection(target, select, b));
    expect(sql).toBe('AVG("public"."books"."rating") AS "avg"');
  });

  it('falls back to .* for empty select', () => {
    const b = new SqlBuilder();
    const sql = mustOk(renderSelectProjection(target, [], b));
    expect(sql).toBe('"public"."books".*');
  });

  it('rejects unknown cast types', () => {
    const b = new SqlBuilder();
    const select = mustOk(parseSelect('title::malicious_type'));
    const r = renderSelectProjection(target, select, b);
    expect(r.ok).toBe(false);
  });
});

describe('renderGroupBy', () => {
  it('emits nothing when no aggregates are present', () => {
    const b = new SqlBuilder();
    const select = mustOk(parseSelect('id,title'));
    expect(mustOk(renderGroupBy(target, select, b))).toBe('');
  });

  it('emits GROUP BY for non-aggregate cols in mixed select', () => {
    const b = new SqlBuilder();
    const select = mustOk(parseSelect('category,count()'));
    const sql = mustOk(renderGroupBy(target, select, b));
    expect(sql).toBe('GROUP BY "public"."books"."category"');
  });
});

// ----- Having ----------------------------------------------------------

describe('renderHaving', () => {
  it('renders a single count clause', () => {
    const b = new SqlBuilder();
    const having = mustOk(parseHavingClauses('count().gt.5'));
    const sql = mustOk(renderHaving(target, having, b));
    expect(sql).toBe('HAVING COUNT(*) > $1');
    expect(b.toBuiltQuery().params).toEqual(['5']);
  });

  it('renders multiple clauses joined with AND', () => {
    const b = new SqlBuilder();
    const having = mustOk(parseHavingClauses('count().gt.5,sum(total).gte.1000'));
    const sql = mustOk(renderHaving(target, having, b));
    expect(sql).toContain('COUNT(*) > $1');
    expect(sql).toContain('SUM("public"."books"."total") >= $2');
    expect(sql).toContain(' AND ');
  });
});

// ----- Cast allowlist --------------------------------------------------

describe('isValidCast', () => {
  it('allows known types', () => {
    expect(isValidCast('int')).toBe(true);
    expect(isValidCast('jsonb')).toBe(true);
    expect(isValidCast('int[]')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isValidCast('INT')).toBe(true);
    expect(isValidCast('  float  ')).toBe(true);
  });

  it('rejects unknown types', () => {
    expect(isValidCast('xml; DROP')).toBe(false);
    expect(isValidCast('banana')).toBe(false);
  });
});
