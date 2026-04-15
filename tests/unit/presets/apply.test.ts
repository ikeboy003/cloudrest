// `applyPreset` tests.

import { describe, expect, it } from 'vitest';

import { applyPreset } from '@/presets/apply';
import type { QueryPreset } from '@/presets/parse';

function presets(entries: Record<string, QueryPreset>): ReadonlyMap<string, QueryPreset> {
  return new Map(Object.entries(entries));
}

const FEED: QueryPreset = {
  filters: [['published', 'eq.true']],
  order: 'created_at.desc',
  limit: 20,
};

describe('applyPreset', () => {
  it('returns the original URL when presets is empty', () => {
    const url = new URL('https://api.test/books?view=feed');
    const out = applyPreset(url, new Map());
    expect(out.toString()).toBe(url.toString());
  });

  it('returns the original URL when no ?view= is present', () => {
    const url = new URL('https://api.test/books?limit=5');
    const out = applyPreset(url, presets({ feed: FEED }));
    expect(out.toString()).toBe(url.toString());
  });

  it('expands the preset and removes the view key', () => {
    const url = new URL('https://api.test/books?view=feed');
    const out = applyPreset(url, presets({ feed: FEED }));
    expect(out.searchParams.has('view')).toBe(false);
    expect(out.searchParams.get('published')).toBe('eq.true');
    expect(out.searchParams.get('order')).toBe('created_at.desc');
    expect(out.searchParams.get('limit')).toBe('20');
  });

  it('does not override an existing user-supplied filter', () => {
    const url = new URL(
      'https://api.test/books?view=feed&published=eq.false',
    );
    const out = applyPreset(url, presets({ feed: FEED }));
    expect(out.searchParams.get('published')).toBe('eq.false');
  });

  it('does not override an existing user-supplied limit', () => {
    const url = new URL('https://api.test/books?view=feed&limit=5');
    const out = applyPreset(url, presets({ feed: FEED }));
    expect(out.searchParams.get('limit')).toBe('5');
  });

  it('does not override an existing user-supplied order', () => {
    const url = new URL('https://api.test/books?view=feed&order=title.asc');
    const out = applyPreset(url, presets({ feed: FEED }));
    expect(out.searchParams.get('order')).toBe('title.asc');
  });

  it('leaves the URL alone when the view name is unknown', () => {
    const url = new URL('https://api.test/books?view=nonesuch');
    const out = applyPreset(url, presets({ feed: FEED }));
    expect(out.searchParams.get('view')).toBe('nonesuch');
  });
});
