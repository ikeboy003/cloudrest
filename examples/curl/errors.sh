#!/usr/bin/env bash
# Error shapes — what CloudREST returns when things go wrong.
#
# Every error response is JSON with this shape:
#   { "code": "PGRST000 | 42P01 | ...", "message": "...", "details": "...", "hint": "..." }
#
# HTTP status follows PostgREST / PostgreSQL conventions. This script walks
# through the common cases so you know what to pattern-match in your client.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"

show() {
  local label="$1" url="$2"; shift 2
  echo "== $label =="
  curl -sS -o /tmp/body -w "HTTP %{http_code}\n" "$url" "$@"
  cat /tmp/body; echo
  echo
}

show "404 — table does not exist" \
  "$CLOUDREST_URL/table_that_does_not_exist?limit=1"

show "400 — unknown filter operator" \
  "$CLOUDREST_URL/books?price=bogus.5"

show "400 — unknown column" \
  "$CLOUDREST_URL/books?select=not_a_column"

show "400 — malformed in() filter" \
  "$CLOUDREST_URL/books?id=in.not-a-list"

show "400 — embed target not related" \
  "$CLOUDREST_URL/books?select=*,not_a_related_table(*)"

show "403 — anon role lacks permission to mutate (42501)" \
  "$CLOUDREST_URL/reviews" \
  -X POST -H "Content-Type: application/json" -d '{"book_id":1,"rating":5,"body":"x"}'

show "401 — malformed JWT (PGRST301)" \
  "$CLOUDREST_URL/reviews" \
  -H "Authorization: Bearer not-a-real-jwt" \
  -X POST -H "Content-Type: application/json" -d '{"book_id":1,"rating":5,"body":"x"}'

show "400 — NOT NULL constraint (23502)" \
  "$CLOUDREST_URL/reviews" \
  -H "Authorization: Bearer ${CLOUDREST_JWT:-invalid}" \
  -X POST -H "Content-Type: application/json" -d '{"book_id":1}'

show "400 — CHECK constraint (23514 — rating must be 1-5)" \
  "$CLOUDREST_URL/reviews" \
  -H "Authorization: Bearer ${CLOUDREST_JWT:-invalid}" \
  -X POST -H "Content-Type: application/json" -d '{"book_id":1,"rating":99,"body":"out of range"}'
