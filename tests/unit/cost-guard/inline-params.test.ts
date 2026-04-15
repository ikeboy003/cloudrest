// `inlineParams` tests.

import { describe, expect, it } from 'vitest';

import { inlineParams } from '@/cost-guard/inline-params';

describe('inlineParams', () => {
  it('returns the SQL unchanged when there are no params', () => {
    expect(inlineParams('SELECT 1', [])).toBe('SELECT 1');
  });

  it('substitutes $1 with a quoted string', () => {
    expect(inlineParams('WHERE "id" = $1', ['abc'])).toBe(
      `WHERE "id" = 'abc'`,
    );
  });

  it('escapes single quotes inside a string value', () => {
    expect(inlineParams('x = $1', ["O'Brien"])).toBe(`x = 'O''Brien'`);
  });

  it('inlines numbers as bare literals', () => {
    expect(inlineParams('x = $1', [42])).toBe('x = 42');
  });

  it('inlines booleans as TRUE/FALSE', () => {
    expect(inlineParams('x = $1 AND y = $2', [true, false])).toBe(
      'x = TRUE AND y = FALSE',
    );
  });

  it('inlines null / undefined as NULL', () => {
    expect(inlineParams('x IS $1', [null])).toBe('x IS NULL');
    expect(inlineParams('x IS $1', [undefined])).toBe('x IS NULL');
  });

  it('inlines objects and arrays via JSON.stringify', () => {
    expect(inlineParams('j = $1', [{ a: 1 }])).toBe(`j = '{"a":1}'`);
    expect(inlineParams('j = $1', [[1, 2]])).toBe(`j = '[1,2]'`);
  });

  it('does not collide $1 with $10', () => {
    const params = [
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
    ];
    const sql = 'SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10';
    expect(inlineParams(sql, params)).toBe(
      `SELECT 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'`,
    );
  });
});
