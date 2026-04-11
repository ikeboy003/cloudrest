# Getting Started

CloudREST exposes a PostgreSQL database as a REST API, running on Cloudflare Workers.

## Requirements

- A Cloudflare account with Workers enabled
- A PostgreSQL database (v12+ recommended)
- Node.js 18+ and `wrangler` CLI installed locally

## Install

CloudREST is distributed as source. Clone the repository and install dependencies:

```sh
git clone https://github.com/ikeboy003/cloudrest.git
cd cloudrest
npm install
```

## Connect your database

CloudREST connects to Postgres via [Cloudflare Hyperdrive](https://developers.cloudflare.com/hyperdrive/). Create a Hyperdrive binding for your database:

```sh
wrangler hyperdrive create cloudrest-db --connection-string="postgres://user:pass@host:5432/db"
```

Copy the resulting Hyperdrive ID into `wrangler.toml`:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "your-hyperdrive-id"
```

## Set required variables

The minimum configuration needs two variables:

```toml
[vars]
DB_SCHEMAS = "public"
DB_ANON_ROLE = "anon"
```

`DB_SCHEMAS` is a comma-separated list of schemas to expose. `DB_ANON_ROLE` is the Postgres role used for unauthenticated requests.

Create the `anon` role in your database if it doesn't exist:

```sql
CREATE ROLE anon NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
```

## Run locally

```sh
npm run dev
```

Wrangler will start a local dev server. Make a request:

```sh
curl http://localhost:8787/your_table?limit=5
```

## Deploy

```sh
npm run deploy
```

That's it. Your API is live at `https://<your-worker>.workers.dev`.

## Next steps

- [Configuration reference](configuration.md)
- [Query API](api/querying.md)
- [Authentication](auth.md)
- [Deployment guide](deployment.md)
