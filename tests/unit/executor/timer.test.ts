// Stage 7 — RequestTimer tests.
//
// Pins the minimal contract that Stage 18's Server-Timing emitter
// will consume: `start(phase)` returns a stop callback; `record`
// adds a duration directly; `entries()` returns them in insertion
// order.

import { describe, expect, it } from 'vitest';

import { createRequestTimer } from '../../../src/executor/timer';

describe('createRequestTimer', () => {
  it('records a single phase via start/stop', () => {
    let clock = 0;
    const timer = createRequestTimer(() => clock);
    const stop = timer.start('parse');
    clock = 5;
    stop();
    expect(timer.entries()).toEqual([{ phase: 'parse', durationMs: 5 }]);
  });

  it('records multiple phases in insertion order', () => {
    let clock = 0;
    const timer = createRequestTimer(() => clock);
    const stopParse = timer.start('parse');
    clock = 1;
    stopParse();
    const stopPlan = timer.start('plan');
    clock = 4;
    stopPlan();
    expect(timer.entries().map((e) => e.phase)).toEqual(['parse', 'plan']);
    expect(timer.entries().map((e) => e.durationMs)).toEqual([1, 3]);
  });

  it('supports direct record() for phases whose duration is known', () => {
    const timer = createRequestTimer(() => 0);
    timer.record('execute', 12.5);
    expect(timer.entries()).toEqual([
      { phase: 'execute', durationMs: 12.5 },
    ]);
  });

  it('uses performance.now() by default', () => {
    // Sanity: the factory doesn't blow up without an explicit clock.
    const timer = createRequestTimer();
    const stop = timer.start('total');
    stop();
    expect(timer.entries()).toHaveLength(1);
    expect(timer.entries()[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});
