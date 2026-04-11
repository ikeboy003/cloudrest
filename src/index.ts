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
import {
  emptySchemaCache,
  introspectFromPostgres,
} from '@/schema/introspect';
import { handleFetch } from '@/router/fetch';
import type { WorkerExecutionContext } from '@/core/context';

// ----- Isolate-scoped caches -------------------------------------------

interface IsolateState {
  readonly config: AppConfig;
  schema: SchemaCache;
  /**
   * In-flight promise when the schema is being introspected. Null
   * when a snapshot is already loaded or when no load is running.
   * Concurrent cold-start requests await this same promise.
   */
  schemaLoad: Promise<SchemaCache> | null;
  /** True once the first real introspection has succeeded. */
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
 * Ensure the schema cache is loaded before dispatching the request.
 * First call triggers an introspection pass; subsequent calls return
 * immediately. Concurrent cold-start requests all await the same
 * in-flight promise.
 *
 * On an introspection failure, the isolate stays in "empty schema"
 * mode and retries on the next request — a transient DB hiccup
 * should not poison the isolate forever.
 */
async function ensureSchema(
  state: IsolateState,
  env: Env,
): Promise<SchemaCache> {
  if (state.schemaLoaded) return state.schema;
  if (state.schemaLoad !== null) return state.schemaLoad;

  state.schemaLoad = (async () => {
    const result = await introspectFromPostgres({
      bindings: env,
      config: state.config,
    });
    if (!result.ok) {
      // Reset so the next request retries. The current request will
      // proceed with the empty cache and surface PGRST205 / similar
      // at the handler level.
      state.schemaLoad = null;
      return state.schema;
    }
    state.schema = result.value;
    state.schemaLoaded = true;
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
