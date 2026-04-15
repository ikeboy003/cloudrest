// `handleRealtimeSse` — short-circuit tests.
//
// The polling loop is hard to unit-test cleanly (it makes real
// `runQuery` calls), so these tests focus on the decision branches
// that don't require a DB: disabled config, wrong method, invalid
// URL, unknown table.

import { describe, expect, it } from 'vitest';

import { handleRealtimeSse } from '@/realtime/sse-handler';
import type { HandlerContext } from '@/core/context';
import { makeTestConfig } from '@tests/fixtures/config';
import { makeSchema } from '@tests/fixtures/schema';

function makeContext(
  overrides: { realtimeEnabled?: boolean; role?: string | null } = {},
): HandlerContext {
  const base = makeTestConfig();
  const config = {
    ...base,
    realtime: {
      enabled: overrides.realtimeEnabled ?? true,
      pollIntervalMs: 1000,
      maxBatchSize: 100,
    },
  };
  const schema = makeSchema([
    {
      name: 'books',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'bigint', nullable: false },
        { name: 'title', type: 'text' },
      ],
    },
  ]);
  return {
    originalHttpRequest: new Request('https://example.com/'),
    executionContext: {
      waitUntil(): void {},
      passThroughOnException(): void {},
    },
    bindings: {} as HandlerContext['bindings'],
    config,
    schema,
    auth: {
      claims: {},
      role: overrides.role === undefined ? 'anon' : overrides.role,
      roleResolvedFrom: 'anon-default',
      rawToken: null,
    } as HandlerContext['auth'],
    timer: {
      start: () => () => {},
      snapshot: () => ({ events: [] }),
    } as unknown as HandlerContext['timer'],
  };
}

describe('handleRealtimeSse — short-circuits', () => {
  it('returns 404 PGRST501 when realtime is disabled', () => {
    const ctx = makeContext({ realtimeEnabled: false });
    const r = handleRealtimeSse({
      url: new URL('https://example.com/_realtime/public/books'),
      method: 'GET',
      context: ctx,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.httpStatus).toBe(404);
  });

  it('rejects non-GET methods with 405', () => {
    const ctx = makeContext();
    const r = handleRealtimeSse({
      url: new URL('https://example.com/_realtime/public/books'),
      method: 'POST',
      context: ctx,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.httpStatus).toBe(405);
  });

  it('rejects an unknown table via the upgrade decision', () => {
    const ctx = makeContext();
    const r = handleRealtimeSse({
      url: new URL('https://example.com/_realtime/public/nope'),
      method: 'GET',
      context: ctx,
    });
    expect(r.ok).toBe(false);
  });

  it('rejects an anonymous request when role is missing', () => {
    const ctx = makeContext({ role: null });
    const r = handleRealtimeSse({
      url: new URL('https://example.com/_realtime/public/books'),
      method: 'GET',
      context: ctx,
    });
    expect(r.ok).toBe(false);
  });

  it('returns a text/event-stream response on accept', () => {
    const ctx = makeContext();
    const r = handleRealtimeSse({
      url: new URL('https://example.com/_realtime/public/books'),
      method: 'GET',
      context: ctx,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value.status).toBe(200);
    expect(r.value.headers.get('Content-Type')).toBe('text/event-stream');
    expect(r.value.headers.get('Cache-Control')).toBe('no-cache');
    // Immediately cancel so the polling loop doesn't spin during
    // test teardown.
    void r.value.body?.cancel();
  });
});
