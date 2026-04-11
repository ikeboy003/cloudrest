<div align="center">

# CloudREST

**PostgREST, reimagined for the edge.**

A PostgREST-compatible REST API that runs as a Cloudflare Worker and talks to Postgres over Hyperdrive — zero servers, global latency, your data never leaves your database.

[![CI](https://github.com/ikeboy003/cloudrest/actions/workflows/ci.yml/badge.svg)](https://github.com/ikeboy003/cloudrest/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ikeboy003/cloudrest/actions/workflows/codeql.yml/badge.svg)](https://github.com/ikeboy003/cloudrest/actions/workflows/codeql.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](.nvmrc)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Getting started](docs/getting-started.md) · [API reference](docs/api/querying.md) · [Deployment](docs/deployment.md) · [Architecture](ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

</div>

---

> [!NOTE]
> **Pre-1.0.** CloudREST is under active development and the public API may still change between minor releases. Follow [CHANGELOG.md](CHANGELOG.md) for what has shipped.

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

`npm run dev` starts the Worker locally via `wrangler dev`. Point the `HYPERDRIVE` binding at a Postgres database (see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for a local Podman recipe) and you have a REST API over your schema.

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
- [**CONTRIBUTING.md**](CONTRIBUTING.md) — how to propose changes, run tests, and ship a PR.
- [**docs/DEVELOPMENT.md**](docs/DEVELOPMENT.md) — run a local Postgres, start `wrangler dev`, mint a dev JWT.
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

CloudREST is released under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).

Commercial use, self-hosting, and hosted services are allowed under the AGPL. If you want to use CloudREST without AGPL obligations, including in proprietary products or services, see [COMMERCIAL.md](COMMERCIAL.md).

The CloudREST name and branding are not licensed for confusing or misleading use. See [TRADEMARKS.md](TRADEMARKS.md).

Copyright © 2026 Divitiae Holdings LLC.
