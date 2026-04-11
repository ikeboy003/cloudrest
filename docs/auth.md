# Authentication

CloudREST uses JSON Web Tokens (JWTs) for authentication. Authenticated requests are executed under a Postgres role derived from a claim in the token, letting you enforce authorization with standard row-level security (RLS) policies.

## Enabling auth

Set `JWT_SECRET` to one of:

- An HMAC secret (for `HS256`, `HS384`, `HS512`)
- A PEM-encoded public key (for `RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `ES512`)
- A JWKS URL — keys are fetched and cached for 5 minutes

If the secret is base64-encoded, set `JWT_SECRET_IS_BASE64=true`.

## Sending a token

```http
GET /books
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

No token? The request runs as `DB_ANON_ROLE` (default: `anon`).

## Role mapping

CloudREST reads the role claim from the token and issues `SET LOCAL ROLE` before running your query. The claim path is configurable via `JWT_ROLE_CLAIM` (default: `.role`).

Example payload:

```json
{
  "role": "authenticated",
  "sub": "user-123",
  "exp": 1893456000
}
```

This request runs as the `authenticated` Postgres role.

If a valid token is missing the role claim, CloudREST falls back to `DB_JWT_DEFAULT_ROLE` (if set) or `DB_ANON_ROLE`.

## Audience validation

Set `JWT_AUDIENCE` to require a specific `aud` claim. Tokens without a matching audience are rejected.

## Row-level security

Since every request runs as a specific Postgres role, RLS policies apply automatically. A typical setup:

```sql
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON books TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON books TO authenticated;

ALTER TABLE books ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authors edit own books" ON books
  FOR ALL TO authenticated
  USING (author_id = current_setting('request.jwt.claims', true)::json->>'sub');
```

Claims are available inside Postgres via the `request.jwt.claims` GUC.

## Token caching

Verified tokens are cached in memory per worker isolate to avoid re-verifying the same token on every request. Cache size is bounded.
