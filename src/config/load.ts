// Env → AppConfig loading and hard validation.
//
// INVARIANT: No silent fallback. A present but invalid env var is a
// ConfigError, not a default. An absent env var is a default.
// See CONSTITUTION §3.1.
//
// INVARIANT: loadConfig collects ALL errors, not just the first, so an
// operator sees every misconfiguration at once.

import { err, ok, type Result } from '../core/result';
import type { Env } from './env';
import type {
  AppConfig,
  AuthConfig,
  ConfigError,
  CorsConfig,
  DatabaseConfig,
  LimitsConfig,
  LogLevel,
  ObservabilityConfig,
  OpenApiConfig,
  OpenApiMode,
  TxEndMode,
} from './schema';
import type { ErrorVerbosity } from '../core/errors';

// ----- Small typed helpers ---------------------------------------------
//
// Every parser either returns a typed value or pushes a ConfigError onto
// the `errors` accumulator. Callers must pass the same accumulator
// throughout; the final Result is built at the bottom of loadConfig.

function parseIntRequired(
  name: string,
  value: string | undefined,
  defaultValue: number,
  errors: ConfigError[],
  constraint?: { min?: number; max?: number },
): number {
  if (value === undefined || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    errors.push({ variable: name, value, reason: 'expected an integer' });
    return defaultValue;
  }
  if (constraint?.min !== undefined && parsed < constraint.min) {
    errors.push({
      variable: name,
      value,
      reason: `must be >= ${constraint.min}`,
    });
    return defaultValue;
  }
  if (constraint?.max !== undefined && parsed > constraint.max) {
    errors.push({
      variable: name,
      value,
      reason: `must be <= ${constraint.max}`,
    });
    return defaultValue;
  }
  return parsed;
}

function parseOptionalInt(
  name: string,
  value: string | undefined,
  errors: ConfigError[],
  constraint?: { min?: number },
): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    errors.push({ variable: name, value, reason: 'expected an integer' });
    return null;
  }
  if (constraint?.min !== undefined && parsed < constraint.min) {
    errors.push({
      variable: name,
      value,
      reason: `must be >= ${constraint.min}`,
    });
    return null;
  }
  return parsed;
}

/**
 * Parse a strict tri-state boolean: 'true', 'false', or absent.
 * Anything else (including 'TRUE', 'yes', '1') is a ConfigError.
 *
 * INVARIANT: We do not do JavaScript-casual bool parsing, because "off"
 * silently becoming "false" is how config bugs hide.
 */
function parseBool(
  name: string,
  value: string | undefined,
  defaultValue: boolean,
  errors: ConfigError[],
): boolean {
  if (value === undefined || value === '') return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  errors.push({ variable: name, value, reason: "expected 'true' or 'false'" });
  return defaultValue;
}

function parseEnum<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  defaultValue: T,
  errors: ConfigError[],
): T {
  if (value === undefined || value === '') return defaultValue;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  errors.push({
    variable: name,
    value,
    reason: `expected one of: ${allowed.join(', ')}`,
  });
  return defaultValue;
}

function parseCommaList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseAppSettings(
  value: string | undefined,
  errors: ConfigError[],
): Record<string, string> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (e) {
    errors.push({
      variable: 'APP_SETTINGS',
      value,
      reason: `not valid JSON: ${(e as Error).message}`,
    });
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push({
      variable: 'APP_SETTINGS',
      value,
      reason: 'expected a JSON object of string-valued GUCs',
    });
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
      errors.push({
        variable: 'APP_SETTINGS',
        value,
        reason: `value for key "${key}" must be a string, number, or boolean`,
      });
      continue;
    }
    result[key] = String(rawValue);
  }
  return result;
}

/**
 * Validate a JWT role-claim path. Parser is intentionally strict:
 * steps must be `.name`, `[index]`, or `.["literal"]`. Anything else
 * is a ConfigError at boot; see CONSTITUTION §5.6.
 *
 * This Stage 2 validator is syntactic only — it rejects obvious typos
 * like `app..role`, `app[broken`, or an empty string. Full semantic
 * parsing lands with the auth stage.
 */
function validateRoleClaim(
  value: string | undefined,
  errors: ConfigError[],
): string {
  if (value === undefined || value === '') return '.role';
  if (!value.startsWith('.') && !value.startsWith('[')) {
    errors.push({
      variable: 'JWT_ROLE_CLAIM',
      value,
      reason: "must start with '.' (object step) or '[' (array index)",
    });
    return '.role';
  }
  // SECURITY: reject empty object steps like `app..role`, unterminated
  // brackets, and dangling dots.
  if (/\.\./.test(value)) {
    errors.push({
      variable: 'JWT_ROLE_CLAIM',
      value,
      reason: 'empty step (`..`) is not allowed',
    });
    return '.role';
  }
  if (value.endsWith('.') || value.endsWith('[')) {
    errors.push({
      variable: 'JWT_ROLE_CLAIM',
      value,
      reason: 'trailing `.` or `[` is not allowed',
    });
    return '.role';
  }
  // SECURITY: balanced brackets.
  let depth = 0;
  for (const ch of value) {
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) {
    errors.push({
      variable: 'JWT_ROLE_CLAIM',
      value,
      reason: 'unbalanced brackets',
    });
    return '.role';
  }
  return value;
}

// ----- Group builders ---------------------------------------------------

function buildDatabase(env: Env, errors: ConfigError[]): DatabaseConfig {
  const schemas = parseCommaList(env.DB_SCHEMAS);
  if (schemas.length === 0) schemas.push('public');

  const txEnd = parseEnum<TxEndMode>(
    'DB_TX_END',
    env.DB_TX_END,
    ['commit', 'rollback', 'commit-allow-override', 'rollback-allow-override'],
    'commit-allow-override',
    errors,
  );

  return {
    schemas,
    anonRole: env.DB_ANON_ROLE ?? 'anon',
    jwtDefaultRole: env.DB_JWT_DEFAULT_ROLE ?? null,
    preRequest: env.DB_PRE_REQUEST ?? null,
    maxRows: parseOptionalInt('DB_MAX_ROWS', env.DB_MAX_ROWS, errors, { min: 1 }),
    aggregatesEnabled: parseBool(
      'DB_AGGREGATES_ENABLED',
      env.DB_AGGREGATES_ENABLED,
      true,
      errors,
    ),
    txEnd,
    statementTimeoutMs: parseIntRequired(
      'DB_STATEMENT_TIMEOUT_MS',
      env.DB_STATEMENT_TIMEOUT_MS,
      5000,
      errors,
      { min: 1 },
    ),
    rootSpec: env.DB_ROOT_SPEC ?? null,
    extraSearchPath: parseCommaList(env.DB_EXTRA_SEARCH_PATH),
    schemaRefreshIntervalSeconds: parseIntRequired(
      'SCHEMA_REFRESH_INTERVAL',
      env.SCHEMA_REFRESH_INTERVAL,
      60,
      errors,
      { min: 1 },
    ),
    timezoneEnabled: parseBool(
      'DB_TIMEZONE_ENABLED',
      env.DB_TIMEZONE_ENABLED,
      true,
      errors,
    ),
    // SECURITY: debug mode defaults off in production. See CONSTITUTION §11.2.
    debugEnabled: parseBool('DB_DEBUG_ENABLED', env.DB_DEBUG_ENABLED, false, errors),
    planEnabled: parseBool('DB_PLAN_ENABLED', env.DB_PLAN_ENABLED, false, errors),
    appSettings: parseAppSettings(env.APP_SETTINGS, errors),
  };
}

function buildAuth(env: Env, errors: ConfigError[]): AuthConfig {
  return {
    jwtSecret: env.JWT_SECRET ?? null,
    jwtSecretIsBase64: parseBool(
      'JWT_SECRET_IS_BASE64',
      env.JWT_SECRET_IS_BASE64,
      false,
      errors,
    ),
    jwtRoleClaim: validateRoleClaim(env.JWT_ROLE_CLAIM, errors),
    jwtAudience: env.JWT_AUDIENCE ?? null,
  };
}

function buildCors(env: Env): CorsConfig {
  // SECURITY: CORS is opt-in. Unset → null → preflights return 403.
  // See CONSTITUTION §10.1.
  const origins = parseCommaList(env.CORS_ALLOWED_ORIGINS);
  return {
    allowedOrigins: origins.length > 0 ? origins : null,
  };
}

function buildLimits(env: Env, errors: ConfigError[]): LimitsConfig {
  return {
    maxBodyBytes: parseIntRequired(
      'MAX_REQUEST_BODY_SIZE',
      env.MAX_REQUEST_BODY_SIZE,
      1_048_576, // 1 MiB
      errors,
      { min: 1 },
    ),
    maxEmbedDepth: parseIntRequired(
      'MAX_EMBED_DEPTH',
      env.MAX_EMBED_DEPTH,
      8,
      errors,
      { min: 1 },
    ),
    rateLimitRpm: parseIntRequired(
      'RATE_LIMIT_RPM',
      env.RATE_LIMIT_RPM,
      0,
      errors,
      { min: 0 },
    ),
    maxQueryCost: parseIntRequired(
      'MAX_QUERY_COST',
      env.MAX_QUERY_COST,
      0,
      errors,
      { min: 0 },
    ),
  };
}

function buildOpenApi(env: Env, errors: ConfigError[]): OpenApiConfig {
  const mode = parseEnum<OpenApiMode>(
    'OPENAPI_MODE',
    env.OPENAPI_MODE,
    ['follow-privileges', 'ignore-privileges', 'disabled'],
    'follow-privileges',
    errors,
  );
  return { mode };
}

function buildObservability(env: Env, errors: ConfigError[]): ObservabilityConfig {
  const logLevel = parseEnum<LogLevel>(
    'LOG_LEVEL',
    env.LOG_LEVEL,
    ['crit', 'error', 'warn', 'info'],
    'error',
    errors,
  );
  const clientErrorVerbosity = parseEnum<ErrorVerbosity>(
    'CLIENT_ERROR_VERBOSITY',
    env.CLIENT_ERROR_VERBOSITY,
    ['verbose', 'minimal'],
    'verbose',
    errors,
  );
  return {
    logLevel,
    logQuery: parseBool('LOG_QUERY', env.LOG_QUERY, false, errors),
    serverTimingEnabled: parseBool(
      'SERVER_TIMING_ENABLED',
      env.SERVER_TIMING_ENABLED,
      true,
      errors,
    ),
    serverTraceHeader: env.SERVER_TRACE_HEADER ?? null,
    clientErrorVerbosity,
  };
}

// ----- Public API ------------------------------------------------------

/**
 * Load and validate AppConfig from the raw Cloudflare Worker bindings.
 *
 * On success: Ok(AppConfig).
 * On failure: Err with EVERY ConfigError encountered (one array, not just
 * the first).
 *
 * Use at worker boot. Do not call per-request — AppConfig is stable for
 * the life of the isolate.
 */
export function loadConfig(env: Env): Result<AppConfig, readonly ConfigError[]> {
  const errors: ConfigError[] = [];

  const config: AppConfig = {
    database: buildDatabase(env, errors),
    auth: buildAuth(env, errors),
    cors: buildCors(env),
    limits: buildLimits(env, errors),
    openApi: buildOpenApi(env, errors),
    observability: buildObservability(env, errors),
  };

  if (errors.length > 0) return err(errors);
  return ok(config);
}
