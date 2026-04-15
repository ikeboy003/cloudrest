// `parsePresets` tests.

import { describe, expect, it } from 'vitest';

import { parsePresets } from '@/presets/parse';

describe('parsePresets', () => {
  it('returns an empty map for undefined', () => {
    expect(parsePresets(undefined).size).toBe(0);
  });

  it('returns an empty map for the empty string', () => {
    expect(parsePresets('').size).toBe(0);
    expect(parsePresets('   ').size).toBe(0);
  });

  it('parses a single preset with filters, order, and limit', () => {
    const m = parsePresets(
      'feed:published.eq.true|order.created_at.desc|limit.20',
    );
    expect(m.size).toBe(1);
    const feed = m.get('feed')!;
    expect(feed.filters).toEqual([['published', 'eq.true']]);
    expect(feed.order).toBe('created_at.desc');
    expect(feed.limit).toBe(20);
  });

  it('parses multiple filters', () => {
    const m = parsePresets('f:price.gt.10|price.lt.100|order.price.asc');
    const f = m.get('f')!;
    expect(f.filters).toEqual([
      ['price', 'gt.10'],
      ['price', 'lt.100'],
    ]);
    expect(f.order).toBe('price.asc');
    expect(f.limit).toBeNull();
  });

  it('parses multiple presets separated by commas', () => {
    const m = parsePresets(
      'a:x.eq.1|limit.5,b:y.eq.2|order.y.desc',
    );
    expect(m.size).toBe(2);
    expect(m.get('a')!.limit).toBe(5);
    expect(m.get('b')!.order).toBe('y.desc');
  });

  it('drops entries without a colon', () => {
    const m = parsePresets('noColon,good:x.eq.1');
    expect(m.size).toBe(1);
    expect(m.has('good')).toBe(true);
  });

  it('drops non-positive limits', () => {
    const m = parsePresets('x:limit.0,y:limit.-5,z:limit.notnum');
    expect(m.get('x')!.limit).toBeNull();
    expect(m.get('y')!.limit).toBeNull();
    expect(m.get('z')!.limit).toBeNull();
  });

  it('handles whitespace in segments', () => {
    const m = parsePresets(' feed : published.eq.true | limit.10 ');
    const feed = m.get('feed')!;
    expect(feed.filters).toEqual([['published', 'eq.true']]);
    expect(feed.limit).toBe(10);
  });
});
