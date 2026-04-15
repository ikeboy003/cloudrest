// Realtime upgrade decision tests.

import { describe, expect, it } from 'vitest';

import { decideRealtimeUpgrade } from '@/realtime/route';
import { buildSchemaCacheFromTables } from '@/schema/introspect';
import { makeTable } from '@tests/fixtures/schema';
import { makeTestConfig } from '@tests/fixtures/config';
import { expectErr, expectOk } from '@tests/fixtures/assert-result';
import type { HandlerContext, WorkerBindings } from '@/core/context';
import type { AuthClaims } from '@/auth/authenticate';
import { createRequestTimer } from '@/executor/timer';

const SCHEMA = buildSchemaCacheFromTables([
  makeTable({
    name: 'books',
    primaryKey: ['id'],
    columns: [{ name: 'id', type: 'int4', nullable: false }],
  }),
]);

function makeCtx(auth: AuthClaims): HandlerContext {
  return {
    originalHttpRequest: new Request('https://api.test/'),
    executionContext: {
      waitUntil: () => {},
      passThroughOnException: () => {},
    },
    bindings: {} as WorkerBindings,
    config: makeTestConfig(),
    schema: SCHEMA,
    auth,
    timer: createRequestTimer(() => 0),
  };
}

describe('decideRealtimeUpgrade', () => {
  it('accepts a valid subscription', () => {
    const sub = expectOk(
      decideRealtimeUpgrade(
        new URL('https://api.test/_realtime/public/books'),
        makeCtx({ role: 'authenticated', claims: {} }),
      ),
    );
    expect(sub).toEqual({
      schema: 'public',
      table: 'books',
      since: null,
    });
  });

  it('rejects an empty-role anon call when anon is disabled', () => {
    const e = expectErr(
      decideRealtimeUpgrade(
        new URL('https://api.test/_realtime/public/books'),
        makeCtx({ role: '', claims: {} }),
      ),
    );
    expect(e.code).toBe('PGRST302');
  });

  it('rejects an unknown table with PGRST205', () => {
    const e = expectErr(
      decideRealtimeUpgrade(
        new URL('https://api.test/_realtime/public/nonexistent'),
        makeCtx({ role: 'authenticated', claims: {} }),
      ),
    );
    expect(e.code).toBe('PGRST205');
  });

  it('rejects a malformed realtime URL', () => {
    const e = expectErr(
      decideRealtimeUpgrade(
        new URL('https://api.test/_realtime/bad'),
        makeCtx({ role: 'authenticated', claims: {} }),
      ),
    );
    expect(e.code).toBe('PGRST205');
  });
});
