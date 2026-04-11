# Local development

How to run CloudREST against a real Postgres on your machine.

> [!NOTE]
> The rewrite is currently at Stage 0 — the worker returns `501 Not Implemented` for every request. Most of the curl examples in [examples/curl/](../examples/curl/) will return 501 until the corresponding feature lands. Getting to the "I can actually see a query work" state is Stage 8 on the roadmap in [ARCHITECTURE.md](../ARCHITECTURE.md#stage-order-summary).
>
> This document describes the harness so it's ready for each stage as it lands. You can set up the whole stack today and point it at Stage 0; individual features will start working in-place as you (or someone) ships them.

## Prerequisites

- **Node.js 18+** — check with `node --version`. This repo has a `.nvmrc` pinning 20; if you use `nvm`, run `nvm use`.
- **podman** (or Docker — the helper script respects `CONTAINER_CMD=docker`) — for the local Postgres container.
- **`wrangler`** — installed automatically via `npm install`. No global install needed.
- **`psql`** — optional, for poking at the DB directly. `brew install libpq` on macOS.

You do **not** need a Cloudflare account, a real Hyperdrive binding, or a hosted Postgres to develop locally.

## The one-command loop

After `git clone` and `npm install`:

```sh
./scripts/dev-db.sh up       # start Postgres + load examples/schema.sql
npm run dev                  # start wrangler dev on http://localhost:8787
```

That's it. `wrangler dev` reloads on every source change, so you can edit `src/` in one terminal and watch it hot-reload in the other.

When you're done:

```sh
./scripts/dev-db.sh down     # stop and remove the Postgres container
```

## What `dev-db.sh` does

The script wraps a single container so you don't have to memorize the flags. Every command is idempotent — running `up` twice does nothing wrong.

| Command | What it does |
|---|---|
| `./scripts/dev-db.sh up` | Pulls `pgvector/pgvector:pg16` if needed, runs it as `cloudrest-dev-pg`, waits for Postgres to be ready, loads `examples/schema.sql`. Prints the connection string on success. |
| `./scripts/dev-db.sh down` | Stops and removes the container. Your data is gone. |
| `./scripts/dev-db.sh reset` | `down` then `up`. Gives you a fresh DB. |
| `./scripts/dev-db.sh psql` | Opens an interactive `psql` shell against the running container. |
| `./scripts/dev-db.sh url` | Prints the connection string without doing anything else. Useful in subshells: `psql "$(./scripts/dev-db.sh url)" -c 'SELECT ...'`. |

Environment overrides:

| Variable | Default | Notes |
|---|---|---|
| `CONTAINER_CMD` | `podman` | Set to `docker` if you prefer Docker. |
| `DB_PORT` | `5433` | Host port. Change it if 5433 collides with something. |
| `DB_PASSWORD` | `cloudrest-dev` | Postgres password. |
| `DB_NAME` | `cloudrest_dev` | Database name. |

## Connecting `wrangler dev` to the DB

`wrangler.toml` configures the `HYPERDRIVE` binding for production. For local dev, `wrangler dev` uses the `localConnectionString` on the same binding. Update it to match your local container, or leave the default if you haven't changed `DB_PORT`:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<your-hyperdrive-id>"
localConnectionString = "postgres://postgres:cloudrest-dev@localhost:5433/cloudrest_dev"
```

The `id` is a placeholder because `wrangler dev` ignores it — Hyperdrive bindings only hit the real Cloudflare service on `wrangler deploy`. Locally, `wrangler` connects directly to the `localConnectionString`.

## JWT for authenticated requests

Mutations and RLS-protected reads need a JWT. Create `.dev.vars` in the project root (gitignored) with a secret:

```sh
JWT_SECRET=dev-only-secret-32-chars-min-do-not-ship
```

Then mint a token for testing — this is a one-liner using Node's built-in crypto:

```sh
node -e '
  const crypto = require("crypto");
  const secret = "dev-only-secret-32-chars-min-do-not-ship";
  const header  = Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    role: "authenticated",
    sub: "local-dev",
    exp: Math.floor(Date.now()/1000) + 3600
  })).toString("base64url");
  const data = `${header}.${payload}`;
  const sig  = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  console.log(`${data}.${sig}`);
'
```

Export it and the curl examples will pick it up:

```sh
export CLOUDREST_JWT="$(node -e '...' )"
./examples/curl/auth.sh
```

`examples/curl/auth.sh` also mints and prints a token if you don't want to write the one-liner yourself.

## Example schema

`./scripts/dev-db.sh up` loads [examples/schema.sql](../examples/schema.sql), which creates:

- `authors`, `books`, `reviews` — the shared example tables with seed data
- `top_rated_books(min_rating int)` — a sample RPC function
- `anon` and `authenticated` roles — what the curl examples expect

Every curl and JS example under [examples/](../examples/) targets this schema. If you want to play with your own data, load your own SQL with `./scripts/dev-db.sh psql` or `psql "$(./scripts/dev-db.sh url)" -f path/to/your.sql`.

## Running the test suite

The test tiers are described in [CONTRIBUTING.md](../CONTRIBUTING.md#tests). Short version:

```sh
npm run typecheck       # strict TypeScript — runs in CI on every push
npm test                # vitest — runs in CI on every push
npm run test:watch      # vitest in watch mode during development
```

Stage 0 has two smoke tests. More tiers land as features do.

Integration tests that need a running Postgres will use the same `dev-db.sh` helper — the harness can call `scripts/dev-db.sh up` before the suite runs and `down` after.

## Verifying the whole loop

Once `dev-db.sh up` and `npm run dev` are both running, a smoke check:

```sh
curl -sS http://localhost:8787/
```

At Stage 0 this returns `{"code":"PGRST000","message":"CloudREST rewrite: not yet implemented"}` with HTTP 501. That's success — it means the worker built, routed your request, and handed you back the honest status.

When the first end-to-end read slice lands (Stage 8), the same curl against `/books?limit=3` will return real rows. No change to the harness, no new setup — just more code wired up behind the same `localhost:8787`.

## Troubleshooting

### `podman: command not found`

Install podman (`brew install podman` on macOS, then `podman machine init && podman machine start`). Or set `CONTAINER_CMD=docker` if you already have Docker.

### Port 5433 is already in use

Either stop whatever's using it, or:

```sh
DB_PORT=5434 ./scripts/dev-db.sh up
```

Remember to update `localConnectionString` in `wrangler.toml` to match.

### `wrangler dev` can't reach the DB

Confirm the container is actually running:

```sh
./scripts/dev-db.sh url
psql "$(./scripts/dev-db.sh url)" -c 'SELECT 1'
```

If that works and `wrangler dev` still can't connect, double-check `localConnectionString` in `wrangler.toml` uses `localhost` (not `127.0.0.1` — Cloudflare's local dev proxy resolves `localhost` differently in some setups).

### Schema changes aren't picked up

CloudREST will cache your schema for up to `SCHEMA_REFRESH_INTERVAL` seconds (default 60). For immediate pickup after a migration, either restart `wrangler dev` or bump the internal version table:

```sh
psql "$(./scripts/dev-db.sh url)" -c 'UPDATE _cloudrest_schema_version SET version = version + 1'
```

(Stage 0 does not yet implement the schema cache — this note is for when the schema coordinator stage lands.)
