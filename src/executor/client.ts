// Postgres client factory.
//
// RUNTIME: Cloudflare Workers forbid sharing I/O objects across
// request handlers — a stream, socket, or `postgres.js` connection
// created inside request A cannot be used from request B. This
// makes a long-lived client per isolate impossible on Workers: a
// memoized client hits the runtime error
// "Cannot perform I/O on behalf of a different request" the second
// time a different request touches it.
//
// Instead we create a fresh `postgres.js` client per request and
// rely on Hyperdrive to pool the underlying TCP sessions. The
// short-lived client is handed to `runTransaction`, which issues
// its queries and returns; the request handler then calls
// `closeClient` to tear it down. `Hyperdrive` handles the actual
// connection reuse at the edge.
//
// RUNTIME: the `postgres` import is static so `wrangler` bundles
// it into the Worker. The package ships its own Node-flavored
// types that pull in Buffer and net; the ambient shim in
// `src/types/postgres.d.ts` keeps the types narrow.
//
// INVARIANT: tests never touch the real `postgres()` factory.
// `__installClientForTest` installs a fake into the test-only
// registry, and `getPostgresClient` checks that registry FIRST.

import postgres from 'postgres';
import type { Env } from '@/config/env';
import type { SqlClient } from './types';

/**
 * Pool settings for a Postgres client. Mirrors the old code's env
 * knobs but is passed as a plain record so unit tests can mock it.
 */
export interface PostgresPoolSettings {
  readonly max: number;
  readonly idleTimeoutSeconds: number;
  /** postgres.js expects seconds; we accept ms and round up. */
  readonly connectTimeoutMs: number;
  readonly preparedStatements: boolean;
}

export const DEFAULT_POOL_SETTINGS: PostgresPoolSettings = Object.freeze({
  max: 10,
  idleTimeoutSeconds: 10,
  connectTimeoutMs: 30_000,
  preparedStatements: false,
});

// ----- Test-only overrides ---------------------------------------------
//
// Tests install a fake client via `__installClientForTest` and
// `getPostgresClient` short-circuits to it. The fake is keyed on
// the connection string so one test can swap one connection out
// without touching others. The real `postgres(...)` factory never
// runs under vitest because the fake is always present before the
// first `getPostgresClient` call.

interface TestFixture {
  readonly client: SqlClient;
  readonly connectionString: string;
}

const testFixtures = new Map<string, TestFixture>();

export function __installClientForTest(
  connectionString: string,
  client: SqlClient,
): void {
  testFixtures.set(connectionString, { client, connectionString });
}

export function __resetClientsForTest(): void {
  testFixtures.clear();
}

// ----- Per-request client ----------------------------------------------

/**
 * Build a postgres.js client for the current request. Callers MUST
 * pair this with `closeClient` in a `try`/`finally` so the TCP
 * session is returned to Hyperdrive's pool when the request ends.
 *
 * RUNTIME: sharing a client across requests is forbidden on
 * Workers. Each request gets its own short-lived client; Hyperdrive
 * does the actual connection pooling at the edge so this is not
 * the per-request TCP round-trip it looks like.
 */
export async function getPostgresClient(
  env: Env,
  settings: PostgresPoolSettings = DEFAULT_POOL_SETTINGS,
): Promise<SqlClient> {
  const connectionString = env.HYPERDRIVE.connectionString;
  const fixture = testFixtures.get(connectionString);
  if (fixture) return fixture.client;

  const rawClient = postgres(connectionString, {
    prepare: settings.preparedStatements,
    max: settings.max,
    idle_timeout: settings.idleTimeoutSeconds,
    connect_timeout: Math.max(1, Math.ceil(settings.connectTimeoutMs / 1000)),
  });
  return rawClient as unknown as SqlClient;
}

/**
 * Tear down a per-request client. A short timeout lets any
 * in-flight work drain quickly. Test fixtures ignore `end` because
 * they share their mock across a test run.
 */
export async function closeClient(client: SqlClient): Promise<void> {
  // `end` is optional on the fake (tests don't implement it). Call
  // only when it exists so `closeClient(fakeClient)` is a no-op.
  const endFn = (client as unknown as { end?: (opts?: { timeout?: number }) => Promise<void> }).end;
  if (typeof endFn === 'function') {
    try {
      await endFn.call(client, { timeout: 1 });
    } catch {
      // Swallow teardown errors — the transaction already committed
      // or rolled back at this point; failing teardown must not
      // change the user-visible outcome.
    }
  }
}
