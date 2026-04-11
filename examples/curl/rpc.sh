#!/usr/bin/env bash
# RPC — calling stored functions over HTTP.
#
# The example schema defines `top_rated_books(min_rating int)` which returns a
# setof (id, title, avg_rating).
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"

echo "== GET with args in the query string (stable functions) =="
curl -sS "$CLOUDREST_URL/rpc/top_rated_books?min_rating=4"
echo; echo

echo "== GET with no args uses the function's default =="
curl -sS "$CLOUDREST_URL/rpc/top_rated_books"
echo; echo

echo "== POST with args in the body =="
curl -sS -X POST "$CLOUDREST_URL/rpc/top_rated_books" \
  -H "Content-Type: application/json" \
  -d '{"min_rating":5}'
echo; echo

echo "== Apply table-style filters, order, and limit to the result =="
curl -sS "$CLOUDREST_URL/rpc/top_rated_books?min_rating=4&order=avg_rating.desc&limit=2&select=title,avg_rating"
echo
