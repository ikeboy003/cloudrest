// Postgres client factory.
//
// INVARIANT (critique #64): one long-lived `postgres.js` client per
// isolate — NOT per request. The old code created a new client on
// every fetch and called `sql.end({ timeout: 1 })` after each
// transaction, which burned connections on every request and caused
// Hyperdrive pool thrash.
//
// The rewrite memoizes the client on a module-level map keyed by the
// raw Hyperdrive connection string. A stale client (e.g. after an
// isolate recycles) is not a concern — isolate death clears the map
// along with everything else.
//
// SECURITY (CONSTITUTION §1.3): the `postgres` import is dynamic so
// the package stays a runtime-only dependency. Neither tests nor
// typecheck pull it in. A bundler that statically analyzes imports
// can still tree-shake around the dynamic form.

import type { Env } from '../config/env';
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

// ----- Isolate-scoped memoization --------------------------------------

interface ClientEntry {
  readonly client: SqlClient;
  /**
   * The connection string the client was built against. Swapping
   * Hyperdrive bindings mid-isolate should never happen, but if it
   * did, the entry would be invalidated.
   */
  readonly connectionString: string;
}

const clients = new Map<string, ClientEntry>();

/**
 * Build (or reuse) the postgres.js client for this isolate. The key
 * is the connection string — not the Env object — because Env can be
 * a fresh reference on every fetch but the underlying binding is
 * stable.
 */
export async function getPostgresClient(
  env: Env,
  settings: PostgresPoolSettings = DEFAULT_POOL_SETTINGS,
): Promise<SqlClient> {
  const connectionString = env.HYPERDRIVE.connectionString;
  const existing = clients.get(connectionString);
  if (existing) return existing.client;

  const rawClient = await loadPostgres(connectionString, {
    prepare: settings.preparedStatements,
    max: settings.max,
    idle_timeout: settings.idleTimeoutSeconds,
    connect_timeout: Math.max(1, Math.ceil(settings.connectTimeoutMs / 1000)),
  });
  const client = rawClient as unknown as SqlClient;
  clients.set(connectionString, { client, connectionString });
  return client;
}

/**
 * Dynamic import of the `postgres` package. Kept in its own function so
 * the package stays a runtime-only dependency — neither typecheck nor
 * the test harness needs it installed. The signature is intentionally
 * `unknown` because the rewrite only ever uses `SqlClient`'s two
 * methods on the returned value.
 *
 * Runtime callers must have `postgres` installed as a prod dep; tests
 * bypass this path via `__installClientForTest`.
 */
async function loadPostgres(
  connectionString: string,
  opts: Record<string, unknown>,
): Promise<unknown> {
  // The string-concat round trip keeps bundler static analysis from
  // trying to resolve `postgres` at build time. Cloudflare's bundler
  // resolves it at runtime when the Worker actually runs.
  const moduleName = 'postgres';
  const mod = (await import(/* @vite-ignore */ moduleName)) as {
    default: (url: string, opts: Record<string, unknown>) => unknown;
  };
  return mod.default(connectionString, opts);
}

// ----- Test hooks ------------------------------------------------------

/**
 * Replace or install a mock client for a given connection string.
 * Intended for unit tests that want to drive the executor without
 * touching the dynamic `postgres` import.
 */
export function __installClientForTest(
  connectionString: string,
  client: SqlClient,
): void {
  clients.set(connectionString, { client, connectionString });
}

/** Clear every memoized client. Intended for unit tests. */
export function __resetClientsForTest(): void {
  clients.clear();
}
