// `resolveReferences` tests.

import { describe, expect, it } from 'vitest';

import { resolveReferences } from '@/batch/refs';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';

describe('resolveReferences — whole-value references', () => {
  it('replaces "$0.id" with the typed value (number stays number)', () => {
    const r = expectOk(
      resolveReferences({ order_id: '$0.id' }, [{ id: 42 }], 1),
    );
    expect(r).toEqual({ order_id: 42 });
    expect(typeof (r as { order_id: number }).order_id).toBe('number');
  });

  it('replaces with a boolean', () => {
    const r = expectOk(
      resolveReferences({ flag: '$0.enabled' }, [{ enabled: true }], 1),
    );
    expect(r).toEqual({ flag: true });
  });

  it('replaces with a nested object', () => {
    const r = expectOk(
      resolveReferences(
        { user: '$0.user' },
        [{ user: { name: 'alice' } }],
        1,
      ),
    );
    expect(r).toEqual({ user: { name: 'alice' } });
  });
});

describe('resolveReferences — embedded references', () => {
  it('interpolates into a template string', () => {
    const r = expectOk(
      resolveReferences(
        { label: 'item-$0.id-of-$0.name' },
        [{ id: 42, name: 'widget' }],
        1,
      ),
    );
    expect(r).toEqual({ label: 'item-42-of-widget' });
  });

  it('leaves strings with no references untouched', () => {
    const r = expectOk(resolveReferences({ x: 'plain' }, [], 1));
    expect(r).toEqual({ x: 'plain' });
  });
});

describe('resolveReferences — forward-only enforcement', () => {
  it('allows a reference to an earlier operation', () => {
    expectOk(
      resolveReferences({ a: '$0.id' }, [{ id: 1 }], 1),
    );
  });

  it('rejects a reference to the same operation', () => {
    const e = expectErr(
      resolveReferences({ a: '$1.id' }, [{ id: 1 }], 1),
    );
    expect(e.code).toBe('PGRST102');
    expect(e.message).toContain('forward references');
  });

  it('rejects a reference to a future operation', () => {
    const e = expectErr(
      resolveReferences({ a: '$2.id' }, [], 1),
    );
    expect(e.code).toBe('PGRST102');
  });
});

describe('resolveReferences — array walking', () => {
  it('recurses into array elements', () => {
    const r = expectOk(
      resolveReferences(
        [{ id: '$0.id' }, { id: '$0.id' }],
        [{ id: 1 }],
        1,
      ),
    );
    expect(r).toEqual([{ id: 1 }, { id: 1 }]);
  });
});

describe('resolveReferences — edge cases', () => {
  it('preserves null / number / boolean non-string values', () => {
    const r = expectOk(
      resolveReferences(
        { a: null, b: 42, c: true, d: 'plain' },
        [],
        0,
      ),
    );
    expect(r).toEqual({ a: null, b: 42, c: true, d: 'plain' });
  });

  it('rejects a reference to a non-object target', () => {
    const e = expectErr(
      resolveReferences({ a: '$0.id' }, ['not-an-object'], 1),
    );
    expect(e.code).toBe('PGRST102');
  });
});
