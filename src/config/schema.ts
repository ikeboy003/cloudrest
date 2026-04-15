// Grouped AppConfig.
//
// AppConfig is a struct of grouped subconfigs, not a flat bag.
// Adding a new knob means adding it to the right group, not growing a
// flat list.

import type { ErrorVerbosity } from '@/core/errors';

// ----- Group types ------------------------------------------------------

export type TxEndMode =
  | 'commit'
  | 'rollback'
  | 'commit-allow-override'
  | 'rollback-allow-override';

export type OpenApiMode = 'follow-privileges' | 'ignore-privileges' | 'disabled';

export type LogLevel = 'crit' | 'error' | 'warn' | 'info';

/**
 * Postgres connection-pool settings. The executor boundary reads this
 * to size the per-isolate `postgres.js` client.
 */
export interface PoolConfig {
  /** `DB_MAX_CONNECTIONS` — max connections held open in the isolate. */
  readonly maxConnections: number;
  /** `DB_IDLE_TIMEOUT` seconds — connection idle reaper. */
  readonly idleTimeoutSeconds: number;
  /** `DB_POOL_TIMEOUT` ms — max wait for a free connection. */
  readonly poolTimeoutMs: number;
  /** `DB_PREPARED_STATEMENTS` — whether postgres.js uses prepared statements. */
  readonly preparedStatements: boolean;
}

export interface DatabaseConfig {
  /** Schemas exposed through the API, in search-path order. */
  readonly schemas: readonly string[];
  /** Role assumed for anonymous requests. */
  readonly anonRole: string;
  /** Role assumed for authenticated requests without a role claim. */
  readonly jwtDefaultRole: string | null;
  /** Schema.function name for a pre-request hook, e.g. `public.check_request`. */
  readonly preRequest: string | null;
  /** Maximum rows returned per request. Null = unlimited. */
  readonly maxRows: number | null;
  /** Whether `avg/count/sum/min/max` are allowed in `select=`. */
  readonly aggregatesEnabled: boolean;
  /** Transaction end policy. See PostgREST Prefer: tx semantics. */
  readonly txEnd: TxEndMode;
  /** Per-statement timeout in milliseconds. */
  readonly statementTimeoutMs: number;
  /** `Content-Profile` / `Accept-Profile` override for the default schema. */
  readonly rootSpec: string | null;
  /** Extra schemas prepended to `search_path` for extensions, etc. */
  readonly extraSearchPath: readonly string[];
  /** Schema refresh interval in seconds. */
  readonly schemaRefreshIntervalSeconds: number;
  /** Allow `Prefer: timezone=...` header. */
  readonly timezoneEnabled: boolean;
  /** Debug knob — must default off in production. */
  readonly debugEnabled: boolean;
  /** Allow `application/vnd.pgrst.plan+json` media type for EXPLAIN output. */
  readonly planEnabled: boolean;
  /** GUCs injected into every transaction via `SET LOCAL`. */
  readonly appSettings: Readonly<Record<string, string>>;
  /** Connection-pool settings for the executor's `postgres.js` client. */
  readonly pool: PoolConfig;
}

export interface AuthConfig {
  /** HMAC secret, PEM public key, or `https://...` JWKS URL. Null disables. */
  readonly jwtSecret: string | null;
  /** Decode the jwtSecret as base64 before use. HMAC only. */
  readonly jwtSecretIsBase64: boolean;
  /**
   * JSON-path for the role claim, e.g. `.role` or `.app_metadata.roles[0]`.
   * SECURITY: A parse error here is a ConfigError, not a silent fallback.
   */
  readonly jwtRoleClaim: string;
  /** Required `aud` claim. Null = any audience accepted. */
  readonly jwtAudience: string | null;
}

export interface CorsConfig {
  /**
   * Null = CORS disabled (no Access-Control-Allow-Origin header, 403 on
   * preflight). Explicit `['*']` allows wildcard.
   */
  readonly allowedOrigins: readonly string[] | null;
}

export interface LimitsConfig {
  /** Max request body bytes. Checked against Content-Length before buffer. */
  readonly maxBodyBytes: number;
  /** Max batch request body bytes. */
  readonly maxBatchBodyBytes: number;
  /** Max operations in a single batch request. */
  readonly maxBatchOps: number;
  /** Max nested embed depth. */
  readonly maxEmbedDepth: number;
  /** Rate limit per IP per minute. 0 = disabled. */
  readonly rateLimitRpm: number;
  /** Max EXPLAIN cost guard. 0 = disabled. */
  readonly maxQueryCost: number;
}

export interface OpenApiConfig {
  readonly mode: OpenApiMode;
}

export interface ObservabilityConfig {
  readonly logLevel: LogLevel;
  readonly logQuery: boolean;
  readonly serverTimingEnabled: boolean;
  readonly serverTraceHeader: string | null;
  readonly clientErrorVerbosity: ErrorVerbosity;
}

// ----- Top-level --------------------------------------------------------

/**
 * AppConfig — grouped, validated application config.
 *
 * Every field is readonly. Mutation at runtime is a bug — config
 * changes at boot only.
 */
/**
 * Per-table edge-cache entry. `claimsInKey` is the explicit list of
 * JWT claim names folded into the cache key. An empty array means
 * "role only"; the RLS fingerprint still includes the resolved role.
 */
export interface CacheTableEntry {
  readonly ttlSeconds: number;
  readonly claimsInKey: readonly string[];
}

/**
 * Edge-cache config. The entire section is optional so a deployment
 * that doesn't set CACHE_TABLE_TTLS gets NO caching, not a "cache
 * everything" default.
 */
export interface CacheConfig {
  readonly defaultTtlSeconds: number;
  /** Keyed by `schema.table`. Unlisted tables are never cached. */
  readonly tables: Readonly<Record<string, CacheTableEntry>>;
}

export interface QueryPreset {
  readonly filters: readonly (readonly [string, string])[];
  readonly order: string | null;
  readonly limit: number | null;
}

export interface RealtimeConfig {
  readonly enabled: boolean;
  readonly pollIntervalMs: number;
  readonly maxBatchSize: number;
}

export interface AppConfig {
  readonly database: DatabaseConfig;
  readonly auth: AuthConfig;
  readonly cors: CorsConfig;
  readonly limits: LimitsConfig;
  readonly openApi: OpenApiConfig;
  readonly observability: ObservabilityConfig;
  /** Edge cache — opt-in per table. `undefined` = no caching. */
  readonly cache?: CacheConfig;
  /** Query presets. */
  readonly presets: ReadonlyMap<string, QueryPreset>;
  /** Realtime SSE config. */
  readonly realtime: RealtimeConfig;
}

// ----- Config errors ----------------------------------------------------

/**
 * ConfigError — surfaced when an env var fails to parse or validate.
 * Collected into an array so operators see every problem at once
 * instead of fixing them one by one.
 *
 * No silent fallback. Missing vars default; invalid vars fail.
 */
export interface ConfigError {
  readonly variable: string;
  readonly value: string | undefined;
  readonly reason: string;
}
