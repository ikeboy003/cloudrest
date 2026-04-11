#!/usr/bin/env bash
# Server-Timing — the built-in per-request breakdown.
#
# Every CloudREST response includes a Server-Timing header with the duration
# of each pipeline phase. Use it to figure out where a slow request is
# actually spending its time without setting up a full tracing stack.
#
# Format:
#   Server-Timing: <mark>;dur=<ms>, <mark>;dur=<ms>, ..., total;dur=<ms>
#
# The `total` mark is always last. Disable the header with
# SERVER_TIMING_ENABLED=false in wrangler.toml.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"

echo "== Every response carries Server-Timing =="
curl -sS -i "$CLOUDREST_URL/books?limit=1&select=title" | grep -iE '^(HTTP|server-timing)'
echo

echo "== A mutation — note the extra phases compared to a read =="
if [ -n "${CLOUDREST_JWT:-}" ]; then
  curl -sS -i -X POST "$CLOUDREST_URL/reviews" \
    -H "Authorization: Bearer $CLOUDREST_JWT" \
    -H "Content-Type: application/json" \
    -H "Prefer: return=headers-only,tx=rollback" \
    -d '{"book_id":1,"rating":5,"body":"timing probe"}' \
    | grep -iE '^(HTTP|server-timing)'
else
  echo "(skipped — export CLOUDREST_JWT to include the mutation probe)"
fi
echo

echo "== Parse a single mark out of the header (db phase) =="
curl -sS -i "$CLOUDREST_URL/books?limit=1&select=title" \
  | awk -F, '/^Server-Timing:/ { for (i=1;i<=NF;i++) if ($i ~ /db;dur=/) print $i }' \
  | sed 's/^ *//'
echo

echo "== Compare cold (first request) vs warm (second request) =="
echo "cold:"
curl -sS -i "$CLOUDREST_URL/authors?limit=1&select=name" | grep -i 'server-timing' | head -1
echo "warm:"
curl -sS -i "$CLOUDREST_URL/authors?limit=1&select=name" | grep -i 'server-timing' | head -1
echo

echo "== Ship your own trace — CloudREST honors W3C traceparent =="
TRACE_ID=$(openssl rand -hex 16)
SPAN_ID=$(openssl rand -hex 8)
curl -sS -i "$CLOUDREST_URL/books?limit=1&select=title" \
  -H "traceparent: 00-$TRACE_ID-$SPAN_ID-01" \
  | grep -iE '^(HTTP|server-timing|traceparent)'
