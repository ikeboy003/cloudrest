# OpenAPI

CloudREST generates an OpenAPI 3 specification describing every table, view, and function it exposes.

## Fetching the spec

```http
GET /
Accept: application/openapi+json
```

The root path (`/`) returns the spec by default. Fetch it in your browser, pipe it into [Swagger UI](https://swagger.io/tools/swagger-ui/), or feed it to a code generator.

## What's included

- Every exposed table and view as a path with `GET`, `POST`, `PATCH`, `PUT`, and `DELETE` operations
- Every exposed function under `/rpc/<function_name>`
- Request and response schemas derived from column types and function signatures
- Column defaults and nullability
- JWT `bearer` security scheme (when authentication is configured)

## Modes

Set `OPENAPI_MODE` to control what's exposed:

- `follow-privileges` (default) — only show what the current role can access
- `ignore-privileges` — show everything, regardless of role
- `disabled` — return `404` with error code `PGRST126`

## Custom root response

To serve a function result at `/` instead of the OpenAPI spec, set:

```toml
[vars]
DB_ROOT_SPEC = "welcome"
```

Requests to `/` will then call the `welcome()` function.
