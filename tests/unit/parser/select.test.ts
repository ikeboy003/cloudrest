import { describe, expect, it } from 'vitest';

import { parseSelect } from '@/parser/select';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';

describe('parseSelect — basic', () => {
  it('empty input returns an empty list', () => {
    expect(expectOk(parseSelect(''))).toEqual([]);
  });

  it('wildcard returns a single field with name *', () => {
    const items = expectOk(parseSelect('*'));
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.type).toBe('field');
    if (item.type === 'field') expect(item.field.name).toBe('*');
  });

  it('parses plain columns', () => {
    const items = expectOk(parseSelect('id,title'));
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.type === 'field')).toBe(true);
  });

  it('parses alias:col', () => {
    const items = expectOk(parseSelect('author_id:id'));
    const first = items[0]!;
    expect(first.type).toBe('field');
    if (first.type === 'field') {
      expect(first.alias).toBe('author_id');
      expect(first.field.name).toBe('id');
    }
  });

  it('parses col::cast', () => {
    const items = expectOk(parseSelect('price::float'));
    const first = items[0]!;
    expect(first.type).toBe('field');
    if (first.type === 'field') {
      expect(first.cast).toBe('float');
    }
  });

  // BUG FIX: the old alias splitter used indexOf(':'), which split at
  // colons inside quoted JSON path keys. `data->>"a:b"` was misparsed
  // as alias `data->>"a` and field `b"`.
  it('does not treat colons inside quoted JSON keys as alias separators', () => {
    const items = expectOk(parseSelect('data->>"a:b"'));
    const first = items[0]!;
    expect(first.type).toBe('field');
    if (first.type === 'field') {
      expect(first.alias).toBeUndefined();
      expect(first.field.name).toBe('data');
      expect(first.field.jsonPath).toHaveLength(1);
    }
  });

  it('does not treat :: inside quoted JSON keys as a cast', () => {
    const items = expectOk(parseSelect('data->>"a::b"'));
    const first = items[0]!;
    expect(first.type).toBe('field');
    if (first.type === 'field') {
      expect(first.cast).toBeUndefined();
    }
  });
});

describe('parseSelect — aggregates', () => {
  // REGRESSION: critique #68 — `select=book_id,avg(rating)` must parse
  // as two field items, NOT as an embed of a table called `avg`.
  // CONSTITUTION §12.5.
  it('parses canonical avg(rating) as a field aggregate, not an embed', () => {
    const items = expectOk(parseSelect('book_id,avg(rating)'));
    expect(items).toHaveLength(2);
    const second = items[1]!;
    expect(second.type).toBe('field');
    if (second.type === 'field') {
      expect(second.aggregateFunction).toBe('avg');
      expect(second.field.name).toBe('rating');
    }
  });

  it('parses canonical count() as COUNT(*)', () => {
    const items = expectOk(parseSelect('count()'));
    const first = items[0]!;
    expect(first.type).toBe('field');
    if (first.type === 'field') {
      expect(first.aggregateFunction).toBe('count');
      expect(first.field.name).toBe('*');
    }
  });

  it('parses canonical sum/max/min/avg', () => {
    for (const fn of ['sum', 'avg', 'max', 'min']) {
      const items = expectOk(parseSelect(`${fn}(total)`));
      const first = items[0]!;
      expect(first.type).toBe('field');
      if (first.type === 'field') {
        expect(first.aggregateFunction).toBe(fn);
      }
    }
  });

  // Extension form: `column.aggregate()` is accepted too, per
  // ARCHITECTURE canonical query-form policy.
  it('parses extension-form col.avg()', () => {
    const items = expectOk(parseSelect('rating.avg()'));
    const first = items[0]!;
    expect(first.type).toBe('field');
    if (first.type === 'field') {
      expect(first.aggregateFunction).toBe('avg');
      expect(first.field.name).toBe('rating');
    }
  });

  it('rejects canonical aggregates with missing column (except count)', () => {
    expectErr(parseSelect('sum()'));
  });

  // BUG FIX: canonical aggregates with casts were misparsed as plain
  // fields because the top-level aggregate branch only ran when the
  // whole token ended with `)`. The rewrite strips an optional `::cast`
  // suffix before the aggregate detection runs.
  it('parses avg(rating)::float as an aggregate with a cast', () => {
    const items = expectOk(parseSelect('avg(rating)::float'));
    expect(items).toHaveLength(1);
    const first = items[0]!;
    expect(first.type).toBe('field');
    if (first.type === 'field') {
      expect(first.aggregateFunction).toBe('avg');
      expect(first.field.name).toBe('rating');
      expect(first.aggregateCast).toBe('float');
    }
  });

  it('parses alias:avg(rating) as an aggregate with an alias', () => {
    const items = expectOk(parseSelect('mean:avg(rating)'));
    const first = items[0]!;
    expect(first.type).toBe('field');
    if (first.type === 'field') {
      expect(first.alias).toBe('mean');
      expect(first.aggregateFunction).toBe('avg');
      expect(first.field.name).toBe('rating');
    }
  });

  it('parses alias:avg(rating)::float', () => {
    const items = expectOk(parseSelect('mean:avg(rating)::float'));
    const first = items[0]!;
    expect(first.type).toBe('field');
    if (first.type === 'field') {
      expect(first.alias).toBe('mean');
      expect(first.aggregateFunction).toBe('avg');
      expect(first.aggregateCast).toBe('float');
    }
  });

  it('parses alias:count() as an aggregate with an alias', () => {
    const items = expectOk(parseSelect('total:count()'));
    const first = items[0]!;
    expect(first.type).toBe('field');
    if (first.type === 'field') {
      expect(first.alias).toBe('total');
      expect(first.aggregateFunction).toBe('count');
      expect(first.field.name).toBe('*');
    }
  });
});

// BUG FIX: select grammar tightening.
describe('parseSelect — rejects malformed input', () => {
  // Bug #13: empty items should not be silently dropped.
  it('rejects stray commas (select=a,,b)', () => {
    expectErr(parseSelect('a,,b'));
  });

  it('rejects a lone leading comma', () => {
    expectErr(parseSelect(',a'));
  });

  it('rejects a lone trailing comma', () => {
    expectErr(parseSelect('a,'));
  });

  // Bug #14: invalid field grammar is not a valid select item.
  it('rejects ::int with no field name', () => {
    expectErr(parseSelect('::int'));
  });

  it('rejects a field name starting with a digit', () => {
    expectErr(parseSelect('1abc'));
  });

  it('rejects shell-like injection in field names', () => {
    // `users;DROP TABLE` is not a valid identifier.
    expectErr(parseSelect('users;DROP TABLE'));
  });
});


describe('parseSelect — embeds', () => {
  it('parses an embedded relation', () => {
    const items = expectOk(parseSelect('author(id,name)'));
    const first = items[0]!;
    expect(first.type).toBe('relation');
    if (first.type === 'relation') {
      expect(first.relation).toBe('author');
      expect(first.innerSelect).toHaveLength(2);
    }
  });

  it('parses a spread relation', () => {
    const items = expectOk(parseSelect('...author(id,name)'));
    expect(items[0]!.type).toBe('spread');
  });

  it('parses an alias:rel(fields) embed', () => {
    const items = expectOk(parseSelect('a:author(id)'));
    const first = items[0]!;
    expect(first.type).toBe('relation');
    if (first.type === 'relation') {
      expect(first.alias).toBe('a');
    }
  });

  it('parses join type: rel!inner(*)', () => {
    const items = expectOk(parseSelect('author!inner(*)'));
    const first = items[0]!;
    expect(first.type).toBe('relation');
    if (first.type === 'relation') {
      expect(first.joinType).toBe('inner');
      expect(first.hint).toBeUndefined();
    }
  });

  it('parses FK hint: rel!fk_hint(fields)', () => {
    const items = expectOk(parseSelect('author!fk_author_id(id,name)'));
    const first = items[0]!;
    expect(first.type).toBe('relation');
    if (first.type === 'relation') {
      expect(first.hint).toBe('fk_author_id');
    }
  });

  it('parses empty-parens embed rel() = no columns', () => {
    const items = expectOk(parseSelect('author()'));
    const first = items[0]!;
    expect(first.type).toBe('relation');
    if (first.type === 'relation') {
      expect(first.innerSelect).toEqual([]);
    }
  });
});

describe('parseSelect — embed pagination', () => {
  it('extracts limit/offset/order from inner select', () => {
    const items = expectOk(
      parseSelect('comments(limit=5,offset=10,order=created_at.desc,id,body)'),
    );
    const first = items[0]!;
    expect(first.type).toBe('relation');
    if (first.type === 'relation') {
      expect(first.embedLimit).toBe(5);
      expect(first.embedOffset).toBe(10);
      expect(first.embedOrder).toHaveLength(1);
      expect(first.innerSelect).toHaveLength(2);
    }
  });

  it('rejects non-integer limit', () => {
    expectErr(parseSelect('comments(limit=abc,id)'));
  });
});
