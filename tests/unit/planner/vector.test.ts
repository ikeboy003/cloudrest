// Stage 6b — vector planner tests.
//
// Covers column validation, op allowlist, JSON vector decoding, and the
// no-post-hoc-rewrite contract (#77, #78): the vector value is stored
// as a plain number array and never stringified by the planner.

import { describe, expect, it } from 'vitest';

import { planVector } from '../../../src/planner/vector';
import { expectErr, expectOk } from '../../fixtures/assert-result';
import { BOOKS_SCHEMA } from '../../fixtures/schema';
import { findTable } from '../../../src/schema/cache';

const booksTable = findTable(BOOKS_SCHEMA, { schema: 'public', name: 'books' })!;

describe('planVector — presence', () => {
  it('returns null when no vector params are supplied', () => {
    const r = expectOk(planVector(null, booksTable));
    expect(r).toBeNull();
  });
});

describe('planVector — value decoding', () => {
  it('parses a JSON number array', () => {
    const r = expectOk(
      planVector(
        { value: '[0.1, 0.2, 0.3]', column: 'embedding', op: 'cosine' },
        booksTable,
      ),
    );
    expect(r!.queryVector).toEqual([0.1, 0.2, 0.3]);
    expect(r!.column).toBe('embedding');
    expect(r!.op).toBe('cosine');
  });

  it('rejects non-JSON vector values', () => {
    const r = expectErr(
      planVector(
        { value: 'not-a-json-array', column: null, op: null },
        booksTable,
      ),
    );
    expect(r.code).toBe('PGRST100');
  });

  it('rejects a JSON non-array', () => {
    const r = expectErr(
      planVector({ value: '{"x": 1}', column: null, op: null }, booksTable),
    );
    expect(r.code).toBe('PGRST100');
  });

  it('rejects non-finite numbers', () => {
    const r = expectErr(
      planVector({ value: '[1, null, 3]', column: null, op: null }, booksTable),
    );
    expect(r.code).toBe('PGRST100');
  });

  it('rejects an empty vector', () => {
    const r = expectErr(
      planVector({ value: '[]', column: null, op: null }, booksTable),
    );
    expect(r.code).toBe('PGRST100');
  });
});

describe('planVector — column validation', () => {
  it('defaults the column name to "embedding"', () => {
    const r = expectOk(
      planVector({ value: '[1, 2]', column: null, op: null }, booksTable),
    );
    expect(r!.column).toBe('embedding');
  });

  it('rejects an unknown column with PGRST204', () => {
    const r = expectErr(
      planVector({ value: '[1]', column: 'nope', op: 'l2' }, booksTable),
    );
    expect(r.code).toBe('PGRST204');
  });
});

describe('planVector — op allowlist', () => {
  it('accepts every valid operator', () => {
    for (const op of ['l2', 'cosine', 'inner_product', 'l1'] as const) {
      const r = expectOk(
        planVector({ value: '[1]', column: 'embedding', op }, booksTable),
      );
      expect(r!.op).toBe(op);
    }
  });

  it('defaults op to l2 when absent', () => {
    const r = expectOk(
      planVector({ value: '[1]', column: 'embedding', op: null }, booksTable),
    );
    expect(r!.op).toBe('l2');
  });

  it('rejects an unknown operator', () => {
    const r = expectErr(
      planVector({ value: '[1]', column: 'embedding', op: 'hamming' }, booksTable),
    );
    expect(r.code).toBe('PGRST100');
  });
});
