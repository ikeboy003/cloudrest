// Stage 16 — rate limiter tests.

import { describe, expect, it } from 'vitest';

import { createInMemoryRateLimiter } from '@/router/rate-limit';

describe('createInMemoryRateLimiter', () => {
  it('allows every request when rpm is 0 (disabled)', () => {
    const limiter = createInMemoryRateLimiter({ rpm: 0 });
    for (let i = 0; i < 1000; i++) {
      expect(limiter.checkAndIncrement('ip', 0)).toBe(true);
    }
  });

  it('allows up to rpm requests then rejects', () => {
    const limiter = createInMemoryRateLimiter({ rpm: 3 });
    expect(limiter.checkAndIncrement('ip', 0)).toBe(true);
    expect(limiter.checkAndIncrement('ip', 0)).toBe(true);
    expect(limiter.checkAndIncrement('ip', 0)).toBe(true);
    expect(limiter.checkAndIncrement('ip', 0)).toBe(false);
  });

  it('resets the bucket when the window advances', () => {
    const limiter = createInMemoryRateLimiter({ rpm: 2 });
    limiter.checkAndIncrement('ip', 0);
    limiter.checkAndIncrement('ip', 0);
    expect(limiter.checkAndIncrement('ip', 0)).toBe(false);
    // 60 seconds later — new window.
    expect(limiter.checkAndIncrement('ip', 60_000)).toBe(true);
  });

  it('tracks buckets independently per key', () => {
    const limiter = createInMemoryRateLimiter({ rpm: 1 });
    expect(limiter.checkAndIncrement('a', 0)).toBe(true);
    expect(limiter.checkAndIncrement('a', 0)).toBe(false);
    // Different key, fresh bucket.
    expect(limiter.checkAndIncrement('b', 0)).toBe(true);
  });
});
