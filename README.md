<div align="center">

# CloudREST

**PostgREST, reimagined for the edge.**

A PostgREST-compatible REST API that runs as a Cloudflare Worker and talks to Postgres over Hyperdrive — zero servers, global latency, your data never leaves your database.

[![CI](https://github.com/ikeboy003/cloudrest/actions/workflows/ci.yml/badge.svg)](https://github.com/ikeboy003/cloudrest/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ikeboy003/cloudrest/actions/workflows/codeql.yml/badge.svg)](https://github.com/ikeboy003/cloudrest/actions/workflows/codeql.yml)
[![License: FSL-1.1-ALv2](https://img.shields.io/badge/license-FSL--1.1--ALv2-blue.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](.nvmrc)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Getting started](docs/getting-started.md) · [API reference](docs/api/querying.md) · [Deployment](docs/deployment.md) · [Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

</div>

---

> [!NOTE]
> **Early work in progress.** This repository is a clean rewrite of an earlier CloudREST prototype. Today the worker returns `501 Not Implemented` for every request. The documentation describes the target API; individual pages will lose their "not yet implemented" banners as each stage lands. Follow [CHANGELOG.md](CHANGELOG.md) for the current state.
>
> If you want to understand the shape of the project, start with [ARCHITECTURE.md](ARCHITECTURE.md). If you want to help build it, read [CONTRIBUTING.md](CONTRIBUTING.md) and pick a stage.

## What CloudREST is

CloudREST gives you a REST API on top of any PostgreSQL database, with:

- **Drop-in PostgREST semantics** — the same query-string grammar, filter operators, `Prefer:` headers, and response shapes. If you already know PostgREST, you already know CloudREST
- **Cloudflare Workers runtime** — no containers, no always-on servers, deployed globally at the edge
- **Hyperdrive connection pooling** — Cloudflare's pooled + accelerated Postgres connections, so every Worker runs against a warm pool
- **Row-level security out of the box** — JWTs are mapped to Postgres roles, every query runs with `SET LOCAL ROLE`, your existing RLS policies enforce authorization
- **OpenAPI generation** — the spec is auto-built from your database schema, ready for Swagger UI or code generators

Plus extensions PostgREST doesn't have a good answer for on the Workers runtime:

- **Vector similarity search** via `pgvector` (`<->`, `<=>`, `<#>`, `<+>`)
- **Real-time subscriptions** via Server-Sent Events and WebSockets, polling an opt-in change log
- **Edge response caching** keyed by role + claims, using Cloudflare's built-in Cache API

## Quick start

```sh
git clone https://github.com/ikeboy003/cloudrest.git
cd cloudrest
npm install
npm run dev
```

At Stage 0 `npm run dev` starts a worker that returns 501 for everything. That changes at Stage 8, when the first end-to-end `GET /{relation}` slice lands. See [ARCHITECTURE.md § Stage order](ARCHITECTURE.md#stage-order-summary) for the rest of the roadmap.

## Documentation

### For users

- [**Getting started**](docs/getting-started.md) — install, connect, first request
- [**Querying**](docs/api/querying.md) — filters, ordering, pagination, full-text search, CSV
- [**Resource embedding**](docs/api/embedding.md) — joins over foreign keys
- [**Mutations**](docs/api/mutations.md) — INSERT, UPDATE, UPSERT, DELETE
- [**RPC**](docs/api/rpc.md) — calling Postgres functions
- [**Authentication**](docs/auth.md) — JWTs, roles, row-level security
- [**Vector search**](docs/vector.md) — pgvector similarity queries
- [**Real-time**](docs/realtime.md) — WebSocket + SSE subscriptions
- [**OpenAPI**](docs/openapi.md) — the generated spec
- [**Observability**](docs/observability.md) — Server-Timing, OpenTelemetry, slow queries
- [**Configuration**](docs/configuration.md) — every environment variable
- [**Deployment**](docs/deployment.md) — Cloudflare Workers setup

### For contributors

- [**ARCHITECTURE.md**](ARCHITECTURE.md) — the map. Read this before touching source.
- [**CONTRIBUTING.md**](CONTRIBUTING.md) — how to propose changes, run tests, and ship a stage.
- [**CODE_OF_CONDUCT.md**](CODE_OF_CONDUCT.md) — how we expect people to behave here.
- [**SECURITY.md**](SECURITY.md) — how to report a vulnerability.
- [**CHANGELOG.md**](CHANGELOG.md) — what shipped and when.

## Why another PostgREST clone?

Because PostgREST itself is fantastic but assumes a long-lived process with a connection pool. Workers don't have that. CloudREST takes the same API surface — the same query grammar, the same semantics, the same RLS model — and rebuilds it for a world where every request is served by a cold-startable function talking to a pooled connection string. You get PostgREST semantics without operating the PostgREST container.

If you're happy running the PostgREST container, keep running it. CloudREST exists for teams who've picked Workers as their application platform and want a REST layer that lives there too.

## Project status and versioning

CloudREST is pre-1.0. The public API (query grammar, response shapes, env vars) will stabilize at v1.0 and follow [semver](https://semver.org) from that point forward. Until then, every minor version can break. Pin an exact commit SHA if you depend on it.

## Community

- **Bugs and feature requests**: [GitHub Issues](https://github.com/ikeboy003/cloudrest/issues)
- **Questions and architecture discussion**: [GitHub Discussions](https://github.com/ikeboy003/cloudrest/discussions)
- **Security vulnerabilities**: private disclosure via [SECURITY.md](SECURITY.md)

## License

Released under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) (`FSL-1.1-ALv2`). You can read, modify, self-host, and contribute to the code freely for any purpose **except** offering it as a competing commercial hosted service. The license automatically converts to Apache License 2.0 two years after each release, so every version becomes fully open source on a rolling schedule.

Copyright © 2026 Divitiae Holdings LLC.
