# Real-time subscriptions

CloudREST can stream table change events to clients over Server-Sent Events (SSE) or WebSockets.

## How it works

Real-time is opt-in per table, and it's honest about what it does:

1. CloudREST auto-creates an append-only change log called `_cloudrest_changes` the first time it connects to your database.
2. You attach triggers to the tables you want to stream. Each INSERT/UPDATE/DELETE on those tables writes one row into the change log. See [examples/rls/changes_triggers.sql](../examples/rls/changes_triggers.sql) for a generic trigger you can reuse.
3. A client subscribes to `/your_table` with `Accept: text/event-stream` (for SSE) or an `Upgrade: websocket` header (for WebSocket). CloudREST polls the change log and streams matching events back.

This is a poll-based design, not logical replication. The poll interval is configurable — default is 2 seconds, the example `wrangler.toml` uses 1 second.

## Enabling

Set in your configuration:

```toml
[vars]
REALTIME_ENABLED = "true"
REALTIME_POLL_INTERVAL_MS = "1000"
```

And make sure the `REALTIME_DO` Durable Object is bound:

```toml
[durable_objects]
bindings = [
  { name = "SCHEMA_COORDINATOR", class_name = "SchemaCoordinator" },
  { name = "REALTIME_DO",        class_name = "RealtimeDO" },
]

[[migrations]]
tag = "v1"
new_classes = ["SchemaCoordinator", "RealtimeDO"]
```

## Server-Sent Events

```js
const stream = await fetch("https://cloudrest.example.com/books", {
  headers: { Accept: "text/event-stream" },
});

const reader = stream.body.getReader();
const decoder = new TextDecoder();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value));
}
```

Each event has the shape:

```
event: insert
data: {"type":"INSERT","table":"books","row":{...},"changed_at":"..."}
```

A full working example is [examples/javascript/realtime.mjs](../examples/javascript/realtime.mjs).

## WebSockets

```js
const ws = new WebSocket("wss://cloudrest.example.com/books");

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "subscribe" }));
};

ws.onmessage = (event) => {
  const change = JSON.parse(event.data);
  console.log(change);
};
```

## Poll interval

`REALTIME_POLL_INTERVAL_MS` controls how often CloudREST checks for new changes. Lower values reduce latency but increase database load. 500–2000 ms is the useful range for most apps.
