# Examples

Runnable examples for every CloudREST feature. Every example targets the shared schema in [schema.sql](schema.sql).

> [!NOTE]
> The rewrite is in Stage 0 and the worker currently returns `501 Not Implemented` for every request. The examples here describe the target API. They'll start passing stage by stage as features land — see [ARCHITECTURE.md](../ARCHITECTURE.md#stage-order-summary) for the order.

## Run this first

Load the schema into your Postgres database:

```sh
psql "$DATABASE_URL" -f schema.sql
```

This creates an example bookstore data model (`authors`, `books`, `reviews`) with seed rows, a sample RPC function, and the `anon` / `authenticated` roles CloudREST expects.

Then point CloudREST at the database (see [getting started](../docs/getting-started.md)) and export a base URL that the scripts will use:

```sh
export CLOUDREST_URL=http://localhost:8787
```

Most examples that mutate data require an authenticated JWT. Mint one and export it with [curl/auth.sh](curl/auth.sh):

```sh
./examples/curl/auth.sh
# ...then copy the line it prints:
export CLOUDREST_JWT=<token>
```

## Contents

- [schema.sql](schema.sql) — the shared example schema and seed data

### curl/

Runnable shell scripts. Each script prints what it's doing and pipes raw JSON to stdout.

- [query.sh](curl/query.sh) — filters, ordering, pagination, full-text search, count, CSV
- [embed.sh](curl/embed.sh) — resource embedding, nested embeds, inline filters/limit
- [mutations.sh](curl/mutations.sh) — INSERT, bulk INSERT, UPDATE, DELETE
- [upsert.sh](curl/upsert.sh) — `on_conflict` with merge-duplicates and ignore-duplicates
- [rpc.sh](curl/rpc.sh) — calling stored functions as GET or POST
- [vector.sh](curl/vector.sh) — pgvector similarity search (L2, cosine, inner product)
- [auth.sh](curl/auth.sh) — minting a local HS256 JWT and using it
- [logic.sh](curl/logic.sh) — AND/OR/NOT, nested logic trees
- [csv.sh](curl/csv.sh) — CSV request body (bulk insert) and CSV response format
- [realtime.sh](curl/realtime.sh) — subscribe to change events via Server-Sent Events
- [openapi.sh](curl/openapi.sh) — fetch and query the generated OpenAPI spec
- [prefer.sh](curl/prefer.sh) — every `Prefer:` header variant
- [errors.sh](curl/errors.sh) — common error shapes you can pattern-match in your client
- [server-timing.sh](curl/server-timing.sh) — per-request phase breakdown + W3C traceparent
- [cost-guard.sh](curl/cost-guard.sh) — reject queries over a planner cost ceiling

### javascript/

- [node.mjs](javascript/node.mjs) — Node.js queries via the built-in `fetch`
- [browser.html](javascript/browser.html) — single-file browser example (open directly)
- [realtime.mjs](javascript/realtime.mjs) — subscribe to INSERT/UPDATE/DELETE events via Server-Sent Events

### rls/

Row-level security patterns. Each file is self-contained — `psql -f <file>` installs the tables and policies.

- [tenant_isolation.sql](rls/tenant_isolation.sql) — multi-tenant row scoping via the `tenant_id` JWT claim
- [owner_edit.sql](rls/owner_edit.sql) — public read, only-owner-can-write
- [changes_triggers.sql](rls/changes_triggers.sql) — trigger function for realtime change tracking (required for `realtime.mjs`)
