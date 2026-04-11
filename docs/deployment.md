# Deployment

CloudREST deploys as a single Cloudflare Worker.

## Prerequisites

- Cloudflare account
- PostgreSQL database reachable from Cloudflare (any provider)
- `wrangler` CLI authenticated (`wrangler login`)

## Create the Hyperdrive binding

Hyperdrive pools and accelerates your Postgres connection:

```sh
wrangler hyperdrive create cloudrest-db \
  --connection-string="postgres://user:pass@host:5432/dbname"
```

Copy the resulting ID.

## Create the schema cache KV namespace

```sh
wrangler kv namespace create SCHEMA_CACHE
```

## Configure `wrangler.toml`

```toml
name = "cloudrest"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[placement]
mode = "smart"

[[hyperdrive]]
binding = "HYPERDRIVE"
id = "<your-hyperdrive-id>"

[[kv_namespaces]]
binding = "SCHEMA_CACHE"
id = "<your-kv-namespace-id>"

[vars]
DB_SCHEMAS = "public"
DB_ANON_ROLE = "anon"
```

## Set secrets

Never put secrets in `wrangler.toml`. Use `wrangler secret`:

```sh
wrangler secret put JWT_SECRET
```

## Deploy

```sh
wrangler deploy
```

Your API is live at `https://cloudrest.<your-subdomain>.workers.dev`.

## Custom domain

Bind a route in the Cloudflare dashboard under **Workers & Pages → your-worker → Triggers**, or add to `wrangler.toml`:

```toml
routes = [
  { pattern = "api.example.com/*", zone_name = "example.com" }
]
```

## Verifying the deployment

```sh
curl https://cloudrest.<your-subdomain>.workers.dev/
```

The root path returns the OpenAPI specification for your exposed schema.
