// `RequestTimer` — records per-request stage durations for the
// `Server-Timing` response header.
//
// INVARIANT (Stage 7, READABILITY §12): there is ONE timer per
// request, carried on `HandlerContext`. Handlers, the executor, and
// the response finalizer all record stage durations against the same
// instance. Stage 18 will feed this into `response/finalize.ts`.

/**
 * Typed identifier for a recorded phase. A closed set lets the
 * response finalizer emit `Server-Timing` entries without parsing or
 * validating free-form names.
 */
export type TimingPhase =
  | 'parse'
  | 'plan'
  | 'build'
  | 'execute'
  | 'serialize'
  | 'total';

export interface TimingEntry {
  readonly phase: TimingPhase;
  /** Duration in milliseconds. Fractional values are fine. */
  readonly durationMs: number;
}

/**
 * Simple mutable recorder. Not thread-safe — but neither is a
 * Cloudflare Worker isolate, which has one request per invocation.
 */
export interface RequestTimer {
  start(phase: TimingPhase): () => void;
  record(phase: TimingPhase, durationMs: number): void;
  /** Snapshot of every recorded entry in insertion order. */
  entries(): readonly TimingEntry[];
}

/**
 * Build a `RequestTimer` whose clock reads from `now`. Tests that
 * want a deterministic clock pass their own function; production
 * code uses the default `performance.now()`.
 */
export function createRequestTimer(
  now: () => number = () => performance.now(),
): RequestTimer {
  const entries: TimingEntry[] = [];
  return {
    start(phase) {
      const begin = now();
      return () => {
        entries.push({ phase, durationMs: now() - begin });
      };
    },
    record(phase, durationMs) {
      entries.push({ phase, durationMs });
    },
    entries() {
      return entries;
    },
  };
}
