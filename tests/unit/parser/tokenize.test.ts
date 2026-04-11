import { describe, expect, it } from 'vitest';

import {
  splitInValues,
  splitTopLevel,
  strictParseInt,
  strictParseNonNegInt,
} from '../../../src/parser/tokenize';
import { expectErr, expectOk } from '../../fixtures/assert-result';

describe('splitTopLevel', () => {
  it('splits on the separator at depth 0', () => {
    expect(expectOk(splitTopLevel('a,b,c', ','))).toEqual(['a', 'b', 'c']);
  });

  it('respects parentheses depth', () => {
    expect(expectOk(splitTopLevel('a,b(c,d),e', ','))).toEqual(['a', 'b(c,d)', 'e']);
  });

  it('respects nested parens', () => {
    expect(expectOk(splitTopLevel('a,f(g,h(i,j)),k', ','))).toEqual([
      'a',
      'f(g,h(i,j))',
      'k',
    ]);
  });

  it('respects double-quoted identifiers', () => {
    expect(expectOk(splitTopLevel('"a,b",c', ','))).toEqual(['"a,b"', 'c']);
  });

  it('treats doubled inner double-quotes as escape', () => {
    expect(expectOk(splitTopLevel('"a""b",c', ','))).toEqual(['"a""b"', 'c']);
  });

  // BUG FIX: the old splitter only tracked double quotes and silently
  // split inside single-quoted strings. JSON path keys use single
  // quotes: `data->'a,b'` is one token.
  it('respects single-quoted strings', () => {
    expect(expectOk(splitTopLevel("data->'a,b',id", ','))).toEqual([
      "data->'a,b'",
      'id',
    ]);
  });

  it('treats doubled inner single-quotes as escape', () => {
    expect(expectOk(splitTopLevel("a'b''c',d", ','))).toEqual(["a'b''c'", 'd']);
  });

  // BUG FIX: the old splitter silently accepted malformed input.
  // Unbalanced parens and unclosed quoted strings now produce
  // PGRST100 errors.
  it('rejects unclosed double-quoted strings', () => {
    const error = expectErr(splitTopLevel('"oops,x', ','));
    expect(error.code).toBe('PGRST100');
  });

  it('rejects unclosed single-quoted strings', () => {
    expectErr(splitTopLevel("data->'oops", ','));
  });

  it('rejects unbalanced opening parens', () => {
    expectErr(splitTopLevel('author(id,name', ','));
  });

  it('rejects unbalanced closing parens', () => {
    expectErr(splitTopLevel('author)(id', ','));
  });
});

describe('splitInValues', () => {
  it('splits simple values', () => {
    expect(expectOk(splitInValues('1,2,3'))).toEqual(['1', '2', '3']);
  });

  it('keeps commas inside quoted values', () => {
    expect(expectOk(splitInValues('"a,b","c","d""e"'))).toEqual(['a,b', 'c', 'd"e']);
  });

  // BUG FIX: the old splitter filtered every empty value, so
  // in.("") was indistinguishable from in.() and in.(a,,b)
  // silently became ['a', 'b']. The rewrite preserves empty strings.
  it('preserves a single quoted empty string', () => {
    expect(expectOk(splitInValues('""'))).toEqual(['']);
  });

  it('preserves empty values between commas', () => {
    expect(expectOk(splitInValues('a,,b'))).toEqual(['a', '', 'b']);
  });

  it('keeps a trailing empty value after a comma', () => {
    expect(expectOk(splitInValues('val,'))).toEqual(['val', '']);
  });

  it('rejects unterminated double-quoted strings', () => {
    expectErr(splitInValues('"oops'));
  });
});

describe('strictParseInt', () => {
  it('accepts plain integers', () => {
    expect(strictParseInt('0')).toBe(0);
    expect(strictParseInt('42')).toBe(42);
    expect(strictParseInt('-7')).toBe(-7);
  });

  it('rejects floats', () => {
    expect(strictParseInt('1.5')).toBeNull();
  });

  it('rejects scientific notation', () => {
    expect(strictParseInt('1e2')).toBeNull();
  });

  it('rejects trailing garbage', () => {
    expect(strictParseInt('12abc')).toBeNull();
  });

  it('rejects values beyond MAX_SAFE_INTEGER', () => {
    expect(strictParseInt('9999999999999999999')).toBeNull();
  });
});

describe('strictParseNonNegInt', () => {
  it('accepts non-negative integers', () => {
    expect(strictParseNonNegInt('0')).toBe(0);
    expect(strictParseNonNegInt('5')).toBe(5);
  });

  it('rejects negatives', () => {
    expect(strictParseNonNegInt('-5')).toBeNull();
  });

  it('rejects leading plus', () => {
    expect(strictParseNonNegInt('+5')).toBeNull();
  });
});
