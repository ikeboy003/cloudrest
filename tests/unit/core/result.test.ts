import { describe, expect, it } from 'vitest';

import {
  andThen,
  collect,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  unwrapOr,
  type Result,
} from '@/core/result';

describe('Result<T, E>', () => {
  describe('ok / err constructors', () => {
    it('ok wraps a value', () => {
      const r = ok(42);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(42);
    });

    it('err wraps an error', () => {
      const r = err('boom');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('boom');
    });
  });

  describe('isOk / isErr narrow the union', () => {
    const sample: Result<number, string> = ok(1);

    it('isOk narrows to Ok', () => {
      expect(isOk(sample)).toBe(true);
      if (isOk(sample)) {
        // Type-level assertion: .value is accessible without ok check.
        const value: number = sample.value;
        expect(value).toBe(1);
      }
    });

    it('isErr narrows to Err', () => {
      const bad: Result<number, string> = err('x');
      expect(isErr(bad)).toBe(true);
      if (isErr(bad)) {
        const error: string = bad.error;
        expect(error).toBe('x');
      }
    });
  });

  describe('map', () => {
    it('transforms the success value', () => {
      const r = map(ok(3), (n) => n * 2);
      expect(r).toEqual({ ok: true, value: 6 });
    });

    it('passes errors through unchanged', () => {
      const r: Result<number, string> = err('e');
      const mapped = map(r, (n: number) => n * 2);
      expect(mapped).toEqual({ ok: false, error: 'e' });
    });
  });

  describe('mapErr', () => {
    it('transforms the error value', () => {
      const r: Result<number, string> = err('lower');
      const mapped = mapErr(r, (e) => e.toUpperCase());
      expect(mapped).toEqual({ ok: false, error: 'LOWER' });
    });

    it('passes ok through unchanged', () => {
      const r = ok(5);
      expect(mapErr(r, (e: string) => e.length)).toEqual({ ok: true, value: 5 });
    });
  });

  describe('andThen', () => {
    const parse = (s: string): Result<number, string> => {
      const n = Number(s);
      return Number.isFinite(n) ? ok(n) : err(`not a number: ${s}`);
    };
    const doubleIfPositive = (n: number): Result<number, string> =>
      n > 0 ? ok(n * 2) : err('not positive');

    it('chains successful computations', () => {
      expect(andThen(parse('3'), doubleIfPositive)).toEqual({ ok: true, value: 6 });
    });

    it('short-circuits on first error', () => {
      expect(andThen(parse('abc'), doubleIfPositive)).toEqual({
        ok: false,
        error: 'not a number: abc',
      });
    });

    it('propagates errors from the chained computation', () => {
      expect(andThen(parse('-1'), doubleIfPositive)).toEqual({
        ok: false,
        error: 'not positive',
      });
    });
  });

  describe('unwrapOr', () => {
    it('returns value on ok', () => {
      expect(unwrapOr(ok(9), 0)).toBe(9);
    });

    it('returns fallback on err', () => {
      expect(unwrapOr(err<string>('bad') as Result<number, string>, 0)).toBe(0);
    });
  });

  describe('collect', () => {
    it('gathers all ok values', () => {
      expect(collect([ok(1), ok(2), ok(3)])).toEqual({ ok: true, value: [1, 2, 3] });
    });

    it('returns the first error', () => {
      const r = collect<number, string>([ok(1), err('first'), err('second')]);
      expect(r).toEqual({ ok: false, error: 'first' });
    });

    it('handles the empty array as success', () => {
      expect(collect([])).toEqual({ ok: true, value: [] });
    });
  });
});
