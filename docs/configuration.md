# Configuration

All configuration is done via environment variables set in `wrangler.toml` under `[vars]`, via `.dev.vars` for local development, or through the Cloudflare dashboard.

## Required

| Variable | Description | Default |
|---|---|---|
| `DB_SCHEMAS` | Comma-separated list of Postgres schemas to expose. | `public` |
| `DB_ANON_ROLE` | Postgres role used for unauthenticated requests. | `anon` |

## Database

| Variable | Description | Default |
|---|---|---|
| `DB_MAX_CONNECTIONS` | Maximum pool connections. | `10` |
| `DB_IDLE_TIMEOUT` | Idle connection timeout in seconds. | `10` |
| `DB_CONNECTION_RETRIES` | Number of retries on connect failure. | `3` |
| `DB_POOL_TIMEOUT` | Pool acquisition timeout in milliseconds. | `30000` |
| `DB_MAX_ROWS` | Hard cap on result set size. | *unset* |
| `DB_EXTRA_SEARCH_PATH` | Additional schemas appended to `search_path`. | *unset* |
| `DB_TIMEZONE_ENABLED` | Respect client timezone headers. | `true` |
| `DB_PREPARED_STATEMENTS` | Enable prepared statements. | `true` |
| `DB_TX_END` | Transaction end mode: `commit`, `rollback`, `commit-allow-override`, `rollback-allow-override`. | `commit` |
| `DB_PRE_REQUEST` | Name of a function to call before every request. | *unset* |
| `DB_AGGREGATES_ENABLED` | Allow aggregate functions in `select=`. | `true` |
| `DB_PLAN_ENABLED` | Enable `EXPLAIN` plan requests. | `false` |

## Authentication

| Variable | Description | Default |
|---|---|---|
| `JWT_SECRET` | HMAC secret, RSA/EC public key, or JWKS URL. | *unset* |
| `JWT_SECRET_IS_BASE64` | Decode the secret from base64 before use. | `false` |
| `JWT_ROLE_CLAIM` | JSON path to the role claim in the JWT. | `.role` |
| `JWT_AUDIENCE` | Expected `aud` claim value. | *unset* |
| `DB_JWT_DEFAULT_ROLE` | Role used when a valid token omits the role claim. | *unset* |

See [Authentication](auth.md) for details.

## Response & caching

| Variable | Description | Default |
|---|---|---|
| `CACHE_TTL` | Global response cache TTL in seconds. `0` disables caching. | `0` |
| `CACHE_TABLE_TTLS` | Per-table TTL overrides. Format: `products:60,orders:10`. | *unset* |
| `MAX_REQUEST_BODY_SIZE` | Maximum request body size in bytes. | `1048576` |
| `MAX_EMBED_DEPTH` | Maximum nesting depth for resource embedding. | `8` |
| `CLIENT_ERROR_VERBOSITY` | `verbose` or `minimal`. Minimal strips details and hints. | `verbose` |
| `SERVER_TIMING_ENABLED` | Emit `Server-Timing` headers. | `true` |

## Observability

| Variable | Description | Default |
|---|---|---|
| `LOG_LEVEL` | `crit`, `error`, `warn`, or `info`. | `error` |
| `LOG_QUERY` | Log every generated SQL statement. | `false` |
| `SERVER_TRACE_HEADER` | Name of a header to echo back for request correlation. | *unset* |
| `SLOW_QUERY_THRESHOLD_MS` | Log queries slower than this. | `100` |
| `SLOW_QUERY_MAX_ENTRIES` | Max slow queries retained in memory. | `20` |
| `OTEL_ENABLED` | Enable OpenTelemetry export. | `false` |
| `OTEL_ENDPOINT` | OTLP collector endpoint. | *unset* |

## Rate limiting

| Variable | Description | Default |
|---|---|---|
| `RATE_LIMIT_RPM` | Requests per minute per client IP. `0` disables. | `0` |

## Real-time

| Variable | Description | Default |
|---|---|---|
| `REALTIME_ENABLED` | Enable WebSocket subscriptions. | `false` |
| `REALTIME_POLL_INTERVAL_MS` | Change detection poll interval. | `2000` |

## OpenAPI

| Variable | Description | Default |
|---|---|---|
| `OPENAPI_MODE` | `follow-privileges`, `ignore-privileges`, or `disabled`. | `follow-privileges` |
| `DB_ROOT_SPEC` | Function name to serve at `/` instead of OpenAPI. | *unset* |

## Application context

| Variable | Description | Default |
|---|---|---|
| `APP_SETTINGS` | JSON object of Postgres GUC values to `SET LOCAL` on each request. Example: `{"app.tenant":"acme"}` | *unset* |

## Webhooks

| Variable | Description | Default |
|---|---|---|
| `WEBHOOKS` | Comma-separated webhook endpoint URLs. | *unset* |
| `WEBHOOK_SECRET` | Shared secret for webhook signature validation. | *unset* |

## Example `wrangler.toml`

```toml
name = "cloudrest"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-id"

[[kv_namespaces]]
binding = "SCHEMA_CACHE"
id = "your-kv-namespace-id"

[vars]
DB_SCHEMAS = "public"
DB_ANON_ROLE = "anon"
JWT_SECRET = "your-jwt-secret"
LOG_LEVEL = "warn"
```
