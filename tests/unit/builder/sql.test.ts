import { describe, expect, it } from 'vitest';

import { SqlBuilder } from '../../../src/builder/sql';

describe('SqlBuilder.addParam', () => {
  it('allocates $1, $2, $3 monotonically', () => {
    const b = new SqlBuilder();
    expect(b.addParam('a')).toBe('$1');
    expect(b.addParam(2)).toBe('$2');
    expect(b.addParam(null)).toBe('$3');
    expect(b.paramCount).toBe(3);
  });

  it('preserves the values in the bound array', () => {
    const b = new SqlBuilder();
    b.addParam('alpha');
    b.addParam(42);
    b.addParam({ key: 'value' });
    const built = b.toBuiltQuery();
    expect(built.params).toEqual(['alpha', 42, { key: 'value' }]);
  });
});

describe('SqlBuilder.write / writeParam', () => {
  it('builds SQL text linearly', () => {
    const b = new SqlBuilder();
    b.write('SELECT * FROM "t" WHERE "id" = ');
    b.write(b.addParam(42));
    const built = b.toBuiltQuery();
    expect(built.sql).toBe('SELECT * FROM "t" WHERE "id" = $1');
    expect(built.params).toEqual([42]);
  });

  it('writeParam is equivalent to write(addParam(v))', () => {
    const a = new SqlBuilder();
    a.write('x=').write(a.addParam(5));

    const b = new SqlBuilder();
    b.write('x=').writeParam(5);

    expect(a.toBuiltQuery().sql).toBe(b.toBuiltQuery().sql);
    expect(a.toBuiltQuery().params).toEqual(b.toBuiltQuery().params);
  });
});

describe('SqlBuilder.toBuiltQuery', () => {
  it('freezes the returned object and params array', () => {
    const b = new SqlBuilder();
    b.write('SELECT 1');
    b.addParam('x');
    const built = b.toBuiltQuery();
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.params)).toBe(true);
  });

  it('defaults skipGucRead to undefined', () => {
    const b = new SqlBuilder();
    b.write('SELECT 1');
    expect(b.toBuiltQuery().skipGucRead).toBeUndefined();
  });

  it('sets skipGucRead when markSkipGucRead was called', () => {
    const b = new SqlBuilder();
    b.write('SELECT 1');
    b.markSkipGucRead();
    expect(b.toBuiltQuery().skipGucRead).toBe(true);
  });
});
