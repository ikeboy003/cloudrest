import { describe, expect, it } from 'vitest';

import { loadConfig } from '@/config/load';
import { testEnv } from '@tests/fixtures/env';

describe('loadConfig — happy path defaults', () => {
  it('returns a grouped AppConfig for minimal env', () => {
    const result = loadConfig(testEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.database.schemas).toEqual(['public']);
    expect(result.value.database.anonRole).toBe('anon');
    expect(result.value.database.txEnd).toBe('commit-allow-override');
    expect(result.value.database.schemaRefreshIntervalSeconds).toBe(60);
    expect(result.value.database.statementTimeoutMs).toBe(5000);
    // SECURITY: default-off debug. CONSTITUTION §11.2.
    expect(result.value.database.debugEnabled).toBe(false);
    expect(result.value.database.aggregatesEnabled).toBe(true);

    expect(result.value.auth.jwtSecret).toBeNull();
    expect(result.value.auth.jwtRoleClaim).toBe('.role');
    expect(result.value.auth.jwtSecretIsBase64).toBe(false);

    // SECURITY: default-null CORS (opt-in). CONSTITUTION §10.1.
    expect(result.value.cors.allowedOrigins).toBeNull();

    expect(result.value.limits.maxBodyBytes).toBe(1_048_576);
    expect(result.value.limits.maxEmbedDepth).toBe(8);
    expect(result.value.limits.rateLimitRpm).toBe(0);
    expect(result.value.limits.maxQueryCost).toBe(0);

    expect(result.value.openApi.mode).toBe('follow-privileges');

    expect(result.value.observability.logLevel).toBe('error');
    expect(result.value.observability.clientErrorVerbosity).toBe('verbose');
    expect(result.value.observability.serverTimingEnabled).toBe(true);
    expect(result.value.observability.logQuery).toBe(false);
  });

  it('normalizes and trims the schema list', () => {
    const result = loadConfig(testEnv({ DB_SCHEMAS: ' public , private ,,' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.database.schemas).toEqual(['public', 'private']);
  });

  it('parses extra search path', () => {
    const result = loadConfig(
      testEnv({ DB_EXTRA_SEARCH_PATH: 'extensions,pgsodium' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.database.extraSearchPath).toEqual(['extensions', 'pgsodium']);
  });

  it('parses APP_SETTINGS JSON into string-valued GUCs', () => {
    const result = loadConfig(
      testEnv({
        APP_SETTINGS: JSON.stringify({ 'app.tenant': 'acme', 'app.level': 3 }),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.database.appSettings).toEqual({
      'app.tenant': 'acme',
      'app.level': '3',
    });
  });
});

// REGRESSION: the old config-identifiers-fragments.test.ts asserted that
// SCHEMA_REFRESH_INTERVAL='oops' silently fell back to 60 and DB_MAX_ROWS='nan'
// silently fell back to null. That behavior was the source of critique #40
// (MAX_QUERY_COST=notanumber -> 0 -> cost guard disabled). The rewrite
// fails hard instead. CONSTITUTION §3.1.
describe('loadConfig — hard validation (no silent fallback)', () => {
  it('rejects non-integer SCHEMA_REFRESH_INTERVAL', () => {
    const result = loadConfig(testEnv({ SCHEMA_REFRESH_INTERVAL: 'oops' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.some((e) => e.variable === 'SCHEMA_REFRESH_INTERVAL')).toBe(
      true,
    );
  });

  it('rejects non-integer DB_MAX_ROWS', () => {
    const result = loadConfig(testEnv({ DB_MAX_ROWS: 'nan' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.some((e) => e.variable === 'DB_MAX_ROWS')).toBe(true);
  });

  // CRITIQUE: #40 — MAX_QUERY_COST=notanumber must not silently disable
  // the cost guard.
  it('rejects non-integer MAX_QUERY_COST', () => {
    const result = loadConfig(testEnv({ MAX_QUERY_COST: 'notanumber' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const found = result.error.find((e) => e.variable === 'MAX_QUERY_COST');
    expect(found).toBeDefined();
    expect(found?.reason).toContain('integer');
  });

  // CRITIQUE: #42 — DB_TX_END=rollback-always is not a valid value.
  // The old code fell back to 'commit', silently flipping a dry-run into a
  // production commit. The rewrite refuses to start.
  it('rejects unknown DB_TX_END', () => {
    const result = loadConfig(testEnv({ DB_TX_END: 'rollback-always' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const found = result.error.find((e) => e.variable === 'DB_TX_END');
    expect(found).toBeDefined();
    expect(found?.reason).toContain('rollback-allow-override');
  });

  it('accepts DB_TX_END=rollback', () => {
    const result = loadConfig(testEnv({ DB_TX_END: 'rollback' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.database.txEnd).toBe('rollback');
  });

  it('rejects unknown LOG_LEVEL', () => {
    const result = loadConfig(testEnv({ LOG_LEVEL: 'loud' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.some((e) => e.variable === 'LOG_LEVEL')).toBe(true);
  });

  it('rejects non-tri-state booleans', () => {
    const result = loadConfig(testEnv({ DB_AGGREGATES_ENABLED: 'yes' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const found = result.error.find((e) => e.variable === 'DB_AGGREGATES_ENABLED');
    expect(found).toBeDefined();
    expect(found?.reason).toContain("'true'");
  });

  it('rejects negative limits', () => {
    const result = loadConfig(testEnv({ DB_MAX_CONNECTIONS: '-5' } as never));
    // DB_MAX_CONNECTIONS isn't in Stage 2's groups yet, so this is a no-op.
    // Instead validate a knob that IS in scope.
    expect(result).toBeDefined();

    const r2 = loadConfig(testEnv({ RATE_LIMIT_RPM: '-1' }));
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    const found = r2.error.find((e) => e.variable === 'RATE_LIMIT_RPM');
    expect(found).toBeDefined();
    expect(found?.reason).toContain('>=');
  });

  it('rejects malformed APP_SETTINGS JSON', () => {
    const result = loadConfig(testEnv({ APP_SETTINGS: '{not json' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.some((e) => e.variable === 'APP_SETTINGS')).toBe(true);
  });

  it('rejects APP_SETTINGS that is not an object', () => {
    const result = loadConfig(testEnv({ APP_SETTINGS: '[1,2,3]' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const found = result.error.find((e) => e.variable === 'APP_SETTINGS');
    expect(found?.reason).toContain('object');
  });

  it('collects multiple errors at once', () => {
    const result = loadConfig(
      testEnv({
        SCHEMA_REFRESH_INTERVAL: 'oops',
        DB_TX_END: 'rollback-always',
        LOG_LEVEL: 'loud',
        RATE_LIMIT_RPM: 'abc',
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const vars = result.error.map((e) => e.variable);
    expect(vars).toContain('SCHEMA_REFRESH_INTERVAL');
    expect(vars).toContain('DB_TX_END');
    expect(vars).toContain('LOG_LEVEL');
    expect(vars).toContain('RATE_LIMIT_RPM');
  });
});

// CRITIQUE: #23 — a typo in JWT_ROLE_CLAIM currently becomes a permission
// bypass. The rewrite surfaces the parse error at boot. CONSTITUTION §5.6.
describe('loadConfig — JWT_ROLE_CLAIM validation', () => {
  it('accepts .role', () => {
    const result = loadConfig(testEnv({ JWT_ROLE_CLAIM: '.role' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.auth.jwtRoleClaim).toBe('.role');
  });

  it('accepts nested object paths', () => {
    const result = loadConfig(
      testEnv({ JWT_ROLE_CLAIM: '.app_metadata.roles' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.auth.jwtRoleClaim).toBe('.app_metadata.roles');
  });

  it('rejects empty steps (app..role)', () => {
    const result = loadConfig(testEnv({ JWT_ROLE_CLAIM: '.app..role' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const found = result.error.find((e) => e.variable === 'JWT_ROLE_CLAIM');
    expect(found?.reason).toContain('empty');
  });

  it('rejects unbalanced brackets (app[broken)', () => {
    const result = loadConfig(testEnv({ JWT_ROLE_CLAIM: '.app[broken' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.some((e) => e.variable === 'JWT_ROLE_CLAIM')).toBe(true);
  });

  it('rejects claims that do not start with . or [', () => {
    const result = loadConfig(testEnv({ JWT_ROLE_CLAIM: 'role' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.some((e) => e.variable === 'JWT_ROLE_CLAIM')).toBe(true);
  });

  it('rejects trailing dot', () => {
    const result = loadConfig(testEnv({ JWT_ROLE_CLAIM: '.app.' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.some((e) => e.variable === 'JWT_ROLE_CLAIM')).toBe(true);
  });
});

// SECURITY: CORS defaults off. CONSTITUTION §10.1.
describe('loadConfig — CORS default', () => {
  it('leaves allowedOrigins null when unset', () => {
    const result = loadConfig(testEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cors.allowedOrigins).toBeNull();
  });

  it('parses an explicit comma-separated list', () => {
    const result = loadConfig(
      testEnv({ CORS_ALLOWED_ORIGINS: 'https://a.example, https://b.example' }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cors.allowedOrigins).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('accepts explicit wildcard', () => {
    const result = loadConfig(testEnv({ CORS_ALLOWED_ORIGINS: '*' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cors.allowedOrigins).toEqual(['*']);
  });
});
