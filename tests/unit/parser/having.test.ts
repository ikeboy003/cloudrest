import { describe, expect, it } from 'vitest';

import { parseHavingClauses } from '../../../src/parser/having';
import { expectErr, expectOk } from '../../fixtures/assert-result';

describe('parseHavingClauses', () => {
  it('parses count().gt.5', () => {
    const clauses = expectOk(parseHavingClauses('count().gt.5'));
    expect(clauses).toHaveLength(1);
    const [c] = clauses;
    expect(c!.aggregate).toBe('count');
    expect(c!.field).toBeUndefined();
  });

  it('parses multiple clauses', () => {
    const clauses = expectOk(parseHavingClauses('count().gt.5,sum(total).gte.1000'));
    expect(clauses).toHaveLength(2);
  });

  // BUG FIX (#22): the field slot is now a `Field` AST, not a raw
  // string. JSON paths inside having arguments parse consistently with
  // select/filter/order.
  it('parses avg(rating).lt.4 as a Field AST', () => {
    const clauses = expectOk(parseHavingClauses('avg(rating).lt.4'));
    const [c] = clauses;
    expect(c!.aggregate).toBe('avg');
    expect(c!.field?.name).toBe('rating');
    expect(c!.field?.jsonPath).toEqual([]);
  });

  it('supports JSON paths inside aggregate args', () => {
    const clauses = expectOk(parseHavingClauses("sum(data->>'amount').gt.100"));
    const [c] = clauses;
    expect(c!.field?.name).toBe('data');
    expect(c!.field?.jsonPath).toHaveLength(1);
  });

  it('rejects malformed clauses', () => {
    expectErr(parseHavingClauses('banana'));
  });

  // BUG FIX (#21): sum/avg/min/max require a column argument.
  // `having=sum().gt.5` used to silently parse as `field: undefined`.
  it('rejects sum() with no column argument', () => {
    expectErr(parseHavingClauses('sum().gt.5'));
  });

  it('rejects avg() with no column argument', () => {
    expectErr(parseHavingClauses('avg().lt.4'));
  });

  it('accepts count() as a special case (no argument)', () => {
    const clauses = expectOk(parseHavingClauses('count().gt.5'));
    expect(clauses[0]!.field).toBeUndefined();
  });
});
