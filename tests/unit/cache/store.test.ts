// Edge cache store tests.
//
// Drives `cacheLookup` / `cacheStore` against a fake `CacheLike`.
// The real Cache API is only available on Workers; the test shim
// is a Map keyed by the request URL.

import { describe, expect, it } from 'vitest';

import {
  __installCacheForTest,
  cacheLookup,
  cacheStore,
  type CacheLike,
} from '@/cache/store';
import type { CacheDecision } from '@/cache/key';

function makeFakeCache(): CacheLike & {
  readonly entries: Map<string, Response>;
} {
  const entries = new Map<string, Response>();
  return {
    entries,
    async match(request: Request): Promise<Response | undefined> {
      return entries.get(request.url)?.clone();
    },
    async put(request: Request, response: Response): Promise<void> {
      entries.set(request.url, response.clone());
    },
  };
}

function makeExecutionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>): void {
      pending.push(p);
    },
    passThroughOnException(): void {},
    pending,
  };
}

describe('cacheLookup', () => {
  it('returns undefined on a skip decision', async () => {
    const cache = makeFakeCache();
    const hit = await cacheLookup(
      { decision: 'skip', reason: 'not opted in' },
      cache,
    );
    expect(hit).toBeUndefined();
  });

  it('returns undefined on a cache miss', async () => {
    const cache = makeFakeCache();
    const decision: CacheDecision = { decision: 'cache', key: 'k1' };
    const hit = await cacheLookup(decision, cache);
    expect(hit).toBeUndefined();
  });

  it('returns the previously-stored response on a hit', async () => {
    const cache = makeFakeCache();
    const decision: CacheDecision = { decision: 'cache', key: 'k1' };
    const ctx = makeExecutionContext();

    cacheStore(
      decision,
      cache,
      ctx,
      new Response('hello', { status: 200 }),
      60,
    );
    await Promise.all(ctx.pending);

    const hit = await cacheLookup(decision, cache);
    expect(hit).toBeDefined();
    expect(await hit!.text()).toBe('hello');
  });
});

describe('cacheStore', () => {
  it('is a no-op on a skip decision', () => {
    const cache = makeFakeCache();
    const ctx = makeExecutionContext();
    cacheStore(
      { decision: 'skip', reason: 'test' },
      cache,
      ctx,
      new Response('x'),
      60,
    );
    expect(ctx.pending).toHaveLength(0);
  });

  it('hands the put to waitUntil', () => {
    const cache = makeFakeCache();
    const ctx = makeExecutionContext();
    cacheStore(
      { decision: 'cache', key: 'k1' },
      cache,
      ctx,
      new Response('x', { status: 200 }),
      60,
    );
    expect(ctx.pending).toHaveLength(1);
  });

  it('refuses to cache non-200/206 responses', () => {
    const cache = makeFakeCache();
    const ctx = makeExecutionContext();
    cacheStore(
      { decision: 'cache', key: 'k1' },
      cache,
      ctx,
      new Response('x', { status: 500 }),
      60,
    );
    expect(ctx.pending).toHaveLength(0);
  });

  it('stamps a Cache-Control header on the stored copy', async () => {
    const cache = makeFakeCache();
    const ctx = makeExecutionContext();
    cacheStore(
      { decision: 'cache', key: 'k1' },
      cache,
      ctx,
      new Response('x', { status: 200 }),
      120,
    );
    await Promise.all(ctx.pending);
    const hit = await cacheLookup(
      { decision: 'cache', key: 'k1' },
      cache,
    );
    expect(hit!.headers.get('Cache-Control')).toBe('max-age=120');
  });

  it('does not mutate the response handed to the client', () => {
    const original = new Response('hi', { status: 200 });
    const cache = makeFakeCache();
    const ctx = makeExecutionContext();
    cacheStore(
      { decision: 'cache', key: 'k1' },
      cache,
      ctx,
      original,
      60,
    );
    // Original carries no Cache-Control — only the stored copy does.
    expect(original.headers.get('Cache-Control')).toBeNull();
  });
});

describe('__installCacheForTest', () => {
  it('overrides the default cache', () => {
    const fake = makeFakeCache();
    __installCacheForTest(fake);
    __installCacheForTest(undefined);
  });
});
