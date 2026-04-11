#!/usr/bin/env bash
# Mutations — insert, update, upsert, delete.
# Mutations require authentication. Set CLOUDREST_JWT to a valid token with
# a role that has INSERT/UPDATE/DELETE privileges on the target tables.
# See auth.sh for an example of minting one.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"
: "${CLOUDREST_JWT:?Set CLOUDREST_JWT to an authenticated token — run auth.sh first}"

AUTH=(-H "Authorization: Bearer $CLOUDREST_JWT")
JSON=(-H "Content-Type: application/json")
RETURN=(-H "Prefer: return=representation")

echo "== INSERT a single review =="
curl -sS -X POST "$CLOUDREST_URL/reviews" "${AUTH[@]}" "${JSON[@]}" "${RETURN[@]}" \
  -d '{"book_id":5,"rating":4,"body":"Example insert"}'
echo; echo

echo "== BULK INSERT two reviews =="
curl -sS -X POST "$CLOUDREST_URL/reviews" "${AUTH[@]}" "${JSON[@]}" "${RETURN[@]}" \
  -d '[{"book_id":7,"rating":5,"body":"Example bulk 1"},{"book_id":7,"rating":4,"body":"Example bulk 2"}]'
echo; echo

echo "== UPDATE by filter =="
curl -sS -X PATCH "$CLOUDREST_URL/reviews?body=eq.Example%20insert" "${AUTH[@]}" "${JSON[@]}" "${RETURN[@]}" \
  -d '{"rating":5}'
echo; echo

echo "== DELETE by filter =="
curl -sS -X DELETE "$CLOUDREST_URL/reviews?body=like.Example*" "${AUTH[@]}" "${RETURN[@]}"
echo; echo

echo "== INSERT with return=headers-only (no body, Location header) =="
curl -sS -i -X POST "$CLOUDREST_URL/reviews" "${AUTH[@]}" "${JSON[@]}" \
  -H "Prefer: return=headers-only" \
  -d '{"book_id":5,"rating":3,"body":"Temp cleanup"}' | grep -iE '^(HTTP|location)'
echo

echo "== Cleanup =="
curl -sS -X DELETE "$CLOUDREST_URL/reviews?body=eq.Temp%20cleanup" "${AUTH[@]}"
echo "done"
