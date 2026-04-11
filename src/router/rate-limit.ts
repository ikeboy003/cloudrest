// In-memory per-isolate rate limiter.
//
// STAGE 16 (critique #56):
//   - The limiter is PER ISOLATE. Cloudflare runs many isolates in
//     parallel, so the effective rate limit is N × config.rateLimitRpm
//     where N is the number of active isolates. This is documented
//     here AND in ARCHITECTURE.md.
//   - A Durable Object backed counter lands later — the interface
//     below is the contract the DO implementation will follow.
//
// INVARIANT: every hit on the limiter is ONE `checkAndIncrement`
// call. Splitting into read/write races under concurrent requests
// in the same isolate.

export interface RateLimiter {
  /**
   * Check whether the given `key` is within the budget; if so,
   * increment its counter. Returns `true` when the request should
   * proceed, `false` when it should be rejected with 429.
   */
  checkAndIncrement(key: string, now?: number): boolean;
}

export interface InMemoryRateLimiterOptions {
  /** Requests per minute. 0 = disabled. */
  readonly rpm: number;
  /** Clock injector for tests. */
  readonly now?: () => number;
}

/**
 * Build an in-memory rate limiter. The budget is a sliding 60-second
 * window with a fixed-size bucket per key; buckets are lazily
 * evicted when a new request lands in an expired window.
 */
export function createInMemoryRateLimiter(
  options: InMemoryRateLimiterOptions,
): RateLimiter {
  const { rpm } = options;
  const clock = options.now ?? (() => Date.now());
  const buckets = new Map<string, { count: number; windowStart: number }>();
  const windowMs = 60_000;

  return {
    checkAndIncrement(key: string, now?: number): boolean {
      if (rpm <= 0) return true;
      const currentMs = now ?? clock();
      const bucket = buckets.get(key);
      if (bucket === undefined || currentMs - bucket.windowStart >= windowMs) {
        buckets.set(key, { count: 1, windowStart: currentMs });
        return true;
      }
      if (bucket.count >= rpm) return false;
      bucket.count += 1;
      return true;
    },
  };
}
