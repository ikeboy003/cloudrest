import { describe, expect, it } from 'vitest';

import { parseOpExpr } from '../../../src/parser/operators';
import { expectErr, expectOk } from '../../fixtures/assert-result';

describe('parseOpExpr — quantifiable operators', () => {
  it('parses eq', () => {
    const expr = expectOk(parseOpExpr('eq.5'));
    expect(expr).not.toBeNull();
    if (expr) {
      expect(expr.negated).toBe(false);
      expect(expr.operation).toEqual({
        type: 'opQuant',
        operator: 'eq',
        quantifier: undefined,
        value: '5',
      });
    }
  });

  it('parses gt, gte, lt, lte', () => {
    for (const op of ['gt', 'gte', 'lt', 'lte']) {
      const expr = expectOk(parseOpExpr(`${op}.10`));
      expect(expr).not.toBeNull();
      if (expr && expr.operation.type === 'opQuant') {
        expect(expr.operation.operator).toBe(op);
      }
    }
  });

  it('parses with (any) quantifier', () => {
    const expr = expectOk(parseOpExpr('eq(any).1'));
    expect(expr).not.toBeNull();
    if (expr && expr.operation.type === 'opQuant') {
      expect(expr.operation.quantifier).toBe('any');
    }
  });

  it('rejects eq.null with a helpful message', () => {
    const error = expectErr(parseOpExpr('eq.null'));
    expect(error.message).toContain('is.null');
  });
});

describe('parseOpExpr — IS', () => {
  it('parses is.null', () => {
    const expr = expectOk(parseOpExpr('is.null'));
    expect(expr).not.toBeNull();
    if (expr && expr.operation.type === 'is') {
      expect(expr.operation.value).toBe('null');
    }
  });

  it('parses is.true / is.false case-insensitively', () => {
    const expr = expectOk(parseOpExpr('is.TRUE'));
    expect(expr).not.toBeNull();
    if (expr && expr.operation.type === 'is') {
      expect(expr.operation.value).toBe('true');
    }
  });

  it('rejects unknown is.* values', () => {
    expectErr(parseOpExpr('is.banana'));
  });
});

describe('parseOpExpr — IN', () => {
  it('parses empty IN', () => {
    const expr = expectOk(parseOpExpr('in.()'));
    expect(expr).not.toBeNull();
    if (expr && expr.operation.type === 'in') {
      expect(expr.operation.values).toEqual([]);
    }
  });

  it('parses values with quoted commas', () => {
    const expr = expectOk(parseOpExpr('in.("a,b","c","d""e")'));
    expect(expr).not.toBeNull();
    if (expr && expr.operation.type === 'in') {
      expect(expr.operation.values).toEqual(['a,b', 'c', 'd"e']);
    }
  });

  it('rejects IN without parentheses', () => {
    expectErr(parseOpExpr('in.1,2,3'));
  });
});

describe('parseOpExpr — negation', () => {
  it('parses not.eq.5', () => {
    const expr = expectOk(parseOpExpr('not.eq.5'));
    expect(expr).not.toBeNull();
    if (expr) {
      expect(expr.negated).toBe(true);
      if (expr.operation.type === 'opQuant') {
        expect(expr.operation.operator).toBe('eq');
      }
    }
  });
});

// BUG FIX: parseGeoOperation used to match `\(([^)]*)\)`, which stops
// at the first close-paren. WKT geometries like
// `within(POLYGON((0 0,1 1,1 0,0 0)))` have nested parens and were
// incorrectly rejected. The rewrite tracks paren depth.
describe('parseOpExpr — geo with nested parens', () => {
  it('accepts a dwithin with numeric args', () => {
    const expr = expectOk(parseOpExpr('geo.dwithin(40.7,-74.0,500)'));
    expect(expr).not.toBeNull();
    if (expr && expr.operation.type === 'geo') {
      expect(expr.operation.operator).toBe('dwithin');
      expect(expr.operation.lat).toBe(40.7);
      expect(expr.operation.lng).toBe(-74.0);
      expect(expr.operation.distance).toBe(500);
    }
  });

  it('accepts a within with a nested-paren WKT polygon', () => {
    const expr = expectOk(
      parseOpExpr('geo.within(POLYGON((0 0,1 1,1 0,0 0)))'),
    );
    expect(expr).not.toBeNull();
    if (expr && expr.operation.type === 'geo') {
      expect(expr.operation.operator).toBe('within');
      expect(expr.operation.geojson).toBe('POLYGON((0 0,1 1,1 0,0 0))');
    }
  });

  it('rejects a geo op with trailing junk after the paren', () => {
    expectErr(parseOpExpr('geo.dwithin(1,2,3)garbage'));
  });

  it('rejects a geo op with unbalanced parens', () => {
    expectErr(parseOpExpr('geo.dwithin(1,2,3'));
  });
});

describe('parseOpExpr — FTS', () => {
  it('parses fts.word', () => {
    const expr = expectOk(parseOpExpr('fts.word'));
    expect(expr).not.toBeNull();
    if (expr && expr.operation.type === 'fts') {
      expect(expr.operation.operator).toBe('fts');
    }
  });

  it('parses plfts(english).word', () => {
    const expr = expectOk(parseOpExpr('plfts(english).word'));
    expect(expr).not.toBeNull();
    if (expr && expr.operation.type === 'fts') {
      expect(expr.operation.operator).toBe('plfts');
      expect(expr.operation.language).toBe('english');
    }
  });
});

// BUG FIX (#19): operator quantifier detection used to allow
// `fts(any)`, `neq(any)`, `in(any)`, `eq(maybe)` by silently stripping
// parens. The rewrite only accepts `(any|all)` on QUANT_OPS and
// `(language)` on FTS_OPS; anything else is an error.
describe('parseOpExpr — quantifier boundaries', () => {
  it('rejects (any) on a non-quantifiable op (neq)', () => {
    expectErr(parseOpExpr('neq(any).5'));
  });

  it('rejects (any) on IN', () => {
    expectErr(parseOpExpr('in(any).(1,2)'));
  });

  it('rejects (any) on FTS', () => {
    expectErr(parseOpExpr('fts(any).word'));
  });

  it('rejects unknown quantifier (maybe) on eq', () => {
    expectErr(parseOpExpr('eq(maybe).5'));
  });
});

// BUG FIX (#20): geo numeric parsing used Number(), which accepts
// `0x10`, empty, scientific, etc. The rewrite uses a strict regex.
describe('parseOpExpr — geo strict numerics', () => {
  it('rejects hex numeric literals in dwithin', () => {
    expectErr(parseOpExpr('geo.dwithin(0x10,0,100)'));
  });

  it('rejects scientific notation in dwithin', () => {
    expectErr(parseOpExpr('geo.dwithin(1e2,0,100)'));
  });

  it('rejects empty numeric args', () => {
    expectErr(parseOpExpr('geo.dwithin(,,)'));
  });

  it('accepts negative floats', () => {
    const expr = expectOk(parseOpExpr('geo.dwithin(-40.7,-74.0,500.5)'));
    if (expr && expr.operation.type === 'geo') {
      expect(expr.operation.lat).toBe(-40.7);
      expect(expr.operation.distance).toBe(500.5);
    }
  });
});

describe('parseOpExpr — unknown tokens', () => {
  // COMPAT: typo detection — `[a-z]{2,12}` operator-shaped tokens that
  // aren't recognized become PGRST100, not silent pass-through.
  it('rejects a typo like ltee.5', () => {
    const error = expectErr(parseOpExpr('ltee.5'));
    expect(error.code).toBe('PGRST100');
    expect(error.message).toContain('unknown operator');
  });

  // BUG FIX: parseOpExpr used to run typo detection on bare no-dot
  // tokens, so `size=big` returned "unknown operator". The rewrite
  // treats any no-dot value as a non-filter (Ok(null)) so the
  // dispatcher collects it as an RPC parameter.
  it('returns Ok(null) for a bare lowercase RPC value', () => {
    expect(expectOk(parseOpExpr('big'))).toBeNull();
    expect(expectOk(parseOpExpr('banana'))).toBeNull();
  });

  it('returns Ok(null) for values that clearly aren\'t filters', () => {
    expect(expectOk(parseOpExpr('Hello World'))).toBeNull();
  });

  it('still rejects a typo WITH a dot like ltee.5', () => {
    // The typo-detection regex runs only when there IS a dot, so this
    // stays an error.
    const error = expectErr(parseOpExpr('ltee.5'));
    expect(error.code).toBe('PGRST100');
  });
});
