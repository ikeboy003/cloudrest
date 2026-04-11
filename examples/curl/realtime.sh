#!/usr/bin/env bash
# Real-time subscriptions via Server-Sent Events.
#
# Prerequisites:
#   1. Apply examples/rls/changes_triggers.sql so mutations on `reviews`
#      write to _cloudrest_changes.
#   2. CloudREST running with REALTIME_ENABLED=true (example wrangler.toml).
#
# This script opens an SSE stream in the background, posts an insert, update,
# and delete against `reviews`, waits a moment, then stops the stream and
# prints everything the server pushed back.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"
: "${CLOUDREST_JWT:?Set CLOUDREST_JWT — run auth.sh first}"

OUT=$(mktemp)
trap 'rm -f "$OUT"; kill %1 2>/dev/null || true' EXIT

echo "== Open SSE stream on /reviews =="
curl -sSN "$CLOUDREST_URL/reviews" -H "Accept: text/event-stream" > "$OUT" &
SSE_PID=$!
sleep 1.5

echo "== Trigger events =="
curl -sS -X POST "$CLOUDREST_URL/reviews" \
  -H "Authorization: Bearer $CLOUDREST_JWT" \
  -H "Content-Type: application/json" \
  -d '{"book_id":1,"rating":5,"body":"realtime curl demo"}' > /dev/null
sleep 1.2
curl -sS -X PATCH "$CLOUDREST_URL/reviews?body=eq.realtime%20curl%20demo" \
  -H "Authorization: Bearer $CLOUDREST_JWT" \
  -H "Content-Type: application/json" \
  -d '{"rating":3}' > /dev/null
sleep 1.2
curl -sS -X DELETE "$CLOUDREST_URL/reviews?body=eq.realtime%20curl%20demo" \
  -H "Authorization: Bearer $CLOUDREST_JWT" > /dev/null
sleep 1.5

# Stop the stream
kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true

echo
echo "== Captured SSE events =="
cat "$OUT"
