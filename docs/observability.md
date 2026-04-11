# Observability

## Server-Timing

Every response includes a `Server-Timing` header breaking down the phases of the request:

```
Server-Timing: auth;dur=2.1, schema;dur=0.4, query;dur=14.8, total;dur=17.3
```

Disable with `SERVER_TIMING_ENABLED=false`.

## OpenTelemetry

Export traces to any OTLP collector:

```toml
[vars]
OTEL_ENABLED = "true"
OTEL_ENDPOINT = "https://otel.example.com:4318"
```

Spans cover authentication, schema introspection, and query execution.

## Slow queries

Queries exceeding `SLOW_QUERY_THRESHOLD_MS` (default `100` ms) are retained in memory for inspection:

```toml
[vars]
SLOW_QUERY_THRESHOLD_MS = "250"
SLOW_QUERY_MAX_ENTRIES = "50"
```

## Query logging

Log every generated SQL statement:

```toml
[vars]
LOG_QUERY = "true"
LOG_LEVEL = "info"
```

## Trace headers

Echo a custom header on every response for request correlation:

```toml
[vars]
SERVER_TRACE_HEADER = "X-Request-Id"
```

If the incoming request has an `X-Request-Id` header, it is returned unchanged. If not, a new ID is generated.
