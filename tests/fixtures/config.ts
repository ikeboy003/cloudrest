// Shared AppConfig fixture for tests.
//
// Any test that needs a `HandlerContext` (Stage 7 runQuery, Stage 8
// handlers, Stage 11 auth) uses `makeTestConfig()`. Overrides are
// deep-merged via the grouped structure, not a flat bag.

import type { AppConfig } from '@/config/schema';

export function makeTestConfig(
  overrides: Partial<AppConfig> = {},
): AppConfig {
  const base: AppConfig = {
    database: {
      schemas: ['public'],
      anonRole: 'anon',
      jwtDefaultRole: null,
      preRequest: null,
      maxRows: null,
      aggregatesEnabled: true,
      txEnd: 'commit-allow-override',
      statementTimeoutMs: 5000,
      rootSpec: null,
      extraSearchPath: [],
      schemaRefreshIntervalSeconds: 60,
      timezoneEnabled: true,
      debugEnabled: false,
      planEnabled: false,
      appSettings: {},
      pool: {
        maxConnections: 10,
        idleTimeoutSeconds: 10,
        poolTimeoutMs: 30_000,
        preparedStatements: false,
      },
    },
    auth: {
      jwtSecret: null,
      jwtSecretIsBase64: false,
      jwtRoleClaim: '.role',
      jwtAudience: null,
    },
    cors: {
      allowedOrigins: null,
    },
    limits: {
      maxBodyBytes: 1_048_576,
      maxBatchBodyBytes: 10_485_760,
      maxBatchOps: 100,
      maxEmbedDepth: 8,
      rateLimitRpm: 0,
      maxQueryCost: 0,
    },
    openApi: {
      mode: 'follow-privileges',
    },
    observability: {
      logLevel: 'info',
      logQuery: false,
      serverTimingEnabled: false,
      serverTraceHeader: null,
      clientErrorVerbosity: 'verbose',
    },
    presets: new Map(),
    realtime: {
      enabled: false,
      pollIntervalMs: 1000,
      maxBatchSize: 100,
    },
  };
  return { ...base, ...overrides };
}
