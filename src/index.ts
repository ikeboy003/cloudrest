// RUNTIME: Cloudflare Worker entry point.
//
// This is the production dispatch surface. It loads `AppConfig` once
// per isolate (sync, from env), then lazily loads the `SchemaCache`
// on the first request via a live `pg_catalog` introspection through
// the executor's transaction primitive.
//
// INVARIANT: config is loaded ONCE per isolate. Schema is loaded ONCE
// per isolate on the first request; concurrent requests during a
// cold start share the same in-flight promise so only one
// introspection transaction ever runs.
//
// RUNTIME: schema refresh will be driven by a Durable Object
// listening for Postgres `NOTIFY cloudrest_schema_changed`. Until
// that coordinator lands, a cold isolate re-introspects on its first
// request and then holds the result for the lifetime of the isolate.

import type { AppConfig, ConfigError } from '@/config/schema';
import { loadConfig } from '@/config/load';
import type { Env } from '@/config/env';
import type { SchemaCache } from '@/schema/cache';
import { emptySchemaCache } from '@/schema/introspect';
export { SchemaCoordinator } from '@/schema/coordinator';
import { decodeSchemaCache } from '@/schema/codec';
import { handleFetch } from '@/router/fetch';
import type { WorkerExecutionContext } from '@/core/context';

// ----- Isolate-scoped caches -------------------------------------------

interface IsolateState {
  readonly config: AppConfig;
  schema: SchemaCache;
  /**
   * In-flight promise when the schema is being read from KV. Null
   * when a snapshot is already loaded or when no load is running.
   * Concurrent cold-start requests await this same promise.
   */
  schemaLoad: Promise<SchemaCache> | null;
  /** True once the schema has been read from KV. */
  schemaLoaded: boolean;
}

let isolateState: IsolateState | null = null;
let configErrors: readonly ConfigError[] | null = null;

/**
 * Lazily load the isolate-wide config. On a config-parse failure,
 * cache the error list so subsequent requests return the same 500
 * without re-running the parser.
 */
function getIsolateConfig(env: Env): IsolateState | readonly ConfigError[] {
  if (isolateState !== null) return isolateState;
  if (configErrors !== null) return configErrors;

  const result = loadConfig(env);
  if (!result.ok) {
    configErrors = result.error;
    return configErrors;
  }
  isolateState = {
    config: result.value,
    schema: emptySchemaCache(),
    schemaLoad: null,
    schemaLoaded: false,
  };
  return isolateState;
}

/**
 * Read the schema cache from KV. The DO is responsible for
 * introspecting the database and writing to KV — Workers never
 * talk to Postgres for schema.
 *
 * Two-tier read: KV (fast, ~1ms globally) then DO fetch if KV
 * misses (first deploy before DO has written).
 *
 * On failure, the isolate stays in "empty schema" mode and retries
 * on the next request.
 */
async function ensureSchema(
  state: IsolateState,
  env: Env,
): Promise<SchemaCache> {
  if (state.schemaLoaded) return state.schema;
  if (state.schemaLoad !== null) return state.schemaLoad;

  state.schemaLoad = (async () => {
    // Tier 1: KV — fast path
    if (env.SCHEMA_CACHE) {
      try {
        const raw = await env.SCHEMA_CACHE.get('schema');
        if (raw) {
          state.schema = decodeSchemaCache(raw);
          state.schemaLoaded = true;
          state.schemaLoad = null;
          return state.schema;
        }
      } catch (e) {
        console.error('Failed to read schema from KV:', e);
      }
    }

    // Tier 2: fetch from DO — handles first deploy or KV miss
    if (env.SCHEMA_COORDINATOR) {
      try {
        const doId = env.SCHEMA_COORDINATOR.idFromName('default');
        const stub = env.SCHEMA_COORDINATOR.get(doId);
        const response = await stub.fetch(new Request('https://do/schema'));
        if (response.ok) {
          const raw = await response.text();
          state.schema = decodeSchemaCache(raw);
          state.schemaLoaded = true;
          state.schemaLoad = null;
          return state.schema;
        }
      } catch (e) {
        console.error('Failed to fetch schema from DO:', e);
      }
    }

    // Both tiers failed — return empty cache, retry next request
    state.schemaLoad = null;
    return state.schema;
  })();
  return state.schemaLoad;
}

// ----- Entry point -----------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
    executionContext: WorkerExecutionContext,
  ): Promise<Response> {
    const state = getIsolateConfig(env);
    if (Array.isArray(state)) {
      return renderConfigErrors(state);
    }
    const isolateStateValue = state as IsolateState;
    const schema = await ensureSchema(isolateStateValue, env);
    return handleFetch(request, env, executionContext, {
      config: isolateStateValue.config,
      schema,
    });
  },
};

// ----- Helpers ---------------------------------------------------------

function renderConfigErrors(errors: readonly ConfigError[]): Response {
  const body = JSON.stringify({
    code: 'PGRST000',
    message: 'Server configuration is invalid',
    details: errors.map((e) => ({
      variable: e.variable,
      value: e.value,
      reason: e.reason,
    })),
    hint: null,
  });
  return new Response(body, {
    status: 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ----- Test-only reset hook --------------------------------------------

/**
 * Reset the isolate-scoped state. Exposed ONLY for tests that need to
 * force a reload between cases; production paths never call this.
 */
export function __resetIsolateStateForTest(): void {
  isolateState = null;
  configErrors = null;
}
