// Raw environment bindings read from Cloudflare Worker vars and secrets.
//
// INVARIANT: This is the ONE place env var names are declared. Any other
// module that needs a config value reads it from AppConfig, not env. This
// means adding a new env var is a one-line change here, a field on the
// appropriate AppConfig group, and a parse step in config/load.ts — no
// more.
//
// RUNTIME: Cloudflare bindings (HYPERDRIVE, KV, DO) are declared here as
// opaque types from @cloudflare/workers-types. Scalar env vars are always
// string | undefined — Cloudflare does not coerce.

export interface Env {
  // ----- Bindings (Cloudflare runtime) -----
  HYPERDRIVE: Hyperdrive;
  SCHEMA_CACHE?: KVNamespace;
  SCHEMA_COORDINATOR?: DurableObjectNamespace;
  REALTIME_DO?: DurableObjectNamespace;

  // ----- Database -----
  DB_SCHEMAS?: string;
  DB_ANON_ROLE?: string;
  DB_JWT_DEFAULT_ROLE?: string;
  DB_PRE_REQUEST?: string;
  DB_MAX_ROWS?: string;
  DB_AGGREGATES_ENABLED?: string;
  DB_TX_END?: string;
  DB_ROOT_SPEC?: string;
  DB_EXTRA_SEARCH_PATH?: string;
  DB_MAX_CONNECTIONS?: string;
  DB_IDLE_TIMEOUT?: string;
  DB_CONNECTION_RETRIES?: string;
  DB_POOL_TIMEOUT?: string;
  DB_PREPARED_STATEMENTS?: string;
  DB_STATEMENT_TIMEOUT_MS?: string;
  DB_TIMEZONE_ENABLED?: string;
  DB_DEBUG_ENABLED?: string;
  DB_PLAN_ENABLED?: string;
  SCHEMA_REFRESH_INTERVAL?: string;

  // ----- Auth -----
  JWT_SECRET?: string;
  JWT_SECRET_IS_BASE64?: string;
  JWT_ROLE_CLAIM?: string;
  JWT_AUDIENCE?: string;

  // ----- CORS -----
  CORS_ALLOWED_ORIGINS?: string;

  // ----- Limits -----
  RATE_LIMIT_RPM?: string;
  MAX_QUERY_COST?: string;
  MAX_REQUEST_BODY_SIZE?: string;
  MAX_EMBED_DEPTH?: string;
  MAX_BATCH_OPS?: string;
  MAX_BATCH_BODY_BYTES?: string;

  // ----- OpenAPI -----
  OPENAPI_MODE?: string;

  // ----- Error verbosity -----
  CLIENT_ERROR_VERBOSITY?: string;
  LOG_LEVEL?: string;
  LOG_QUERY?: string;
  SERVER_TIMING_ENABLED?: string;
  SERVER_TRACE_HEADER?: string;
  APP_SETTINGS?: string;

  // ----- Later stages -----
  //
  // These vars are accepted at load time but not yet parsed; the stages
  // that consume them (realtime: 12, webhooks: 14, observability: 18,
  // admin auth: 16, presets: 6) will widen AppConfig.
  CACHE_TTL?: string;
  CACHE_TABLE_TTLS?: string;
  REALTIME_ENABLED?: string;
  REALTIME_POLL_INTERVAL_MS?: string;
  REALTIME_MAX_BATCH_SIZE?: string;
  WEBHOOKS?: string;
  WEBHOOK_SECRET?: string;
  QUERY_PRESETS?: string;
  SLOW_QUERY_THRESHOLD_MS?: string;
  SLOW_QUERY_MAX_ENTRIES?: string;
  OTEL_ENDPOINT?: string;
  OTEL_ENABLED?: string;
  ADMIN_AUTH_TOKEN?: string;
}
