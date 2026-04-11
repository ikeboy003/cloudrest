# CloudREST documentation

> **Note:** these documents describe the target API the rewrite is building toward. Many features are not yet implemented — the worker currently returns `501 Not Implemented` for every request. Individual pages will lose this banner as each feature lands. See [ARCHITECTURE.md](../ARCHITECTURE.md) for the stage order.

- [Getting started](getting-started.md) — install, connect, first request
- [Local development](DEVELOPMENT.md) — podman Postgres + wrangler dev + dev JWT
- [Configuration](configuration.md) — environment variables reference
- [Deployment](deployment.md) — deploy to Cloudflare Workers
- [Authentication](auth.md) — JWTs, roles, row-level security

## API

- [Querying](api/querying.md) — filters, ordering, pagination, CSV
- [Resource embedding](api/embedding.md) — joins over foreign keys
- [Mutations](api/mutations.md) — insert, update, upsert, delete
- [RPC](api/rpc.md) — calling stored functions

## Features

- [Real-time](realtime.md) — WebSocket subscriptions
- [PostGIS](postgis.md) — spatial queries
- [Vector search](vector.md) — pgvector similarity search
- [Observability](observability.md) — tracing, logging, Server-Timing
- [OpenAPI](openapi.md) — generated spec
