#!/usr/bin/env bash
# OpenAPI — CloudREST generates an OpenAPI 3 spec from your database schema.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"

NEED_JQ=0
if ! command -v jq >/dev/null 2>&1; then
  NEED_JQ=1
  echo "(jq not installed — showing raw JSON, pipe through \`jq\` for pretty output)"
  echo
fi
pretty() { if [ "$NEED_JQ" = "0" ]; then jq "$@"; else cat; fi; }

echo "== Fetch the spec =="
curl -sS "$CLOUDREST_URL/" -H "Accept: application/openapi+json" | pretty '{openapi, info}'
echo

echo "== Enumerate paths =="
curl -sS "$CLOUDREST_URL/" -H "Accept: application/openapi+json" | pretty '.paths | keys'
echo

echo "== List operations on /books =="
curl -sS "$CLOUDREST_URL/" -H "Accept: application/openapi+json" \
  | pretty '.paths."/books" | keys'
echo

echo "== Show the GET /books response schema =="
curl -sS "$CLOUDREST_URL/" -H "Accept: application/openapi+json" \
  | pretty '.paths."/books".get.responses."200"'
echo

echo "== List all RPC function endpoints =="
curl -sS "$CLOUDREST_URL/" -H "Accept: application/openapi+json" \
  | pretty '.paths | keys | map(select(startswith("/rpc/")))'
