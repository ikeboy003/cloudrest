#!/usr/bin/env bash
# Upserts — insert-or-update in one call.
#
# CloudREST supports two styles:
#   1. POST /table?on_conflict=col  with  Prefer: resolution=merge-duplicates
#      → inserts new rows, updates rows that collide on `col`
#   2. POST /table?on_conflict=col  with  Prefer: resolution=ignore-duplicates
#      → inserts new rows, skips rows that collide on `col`
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"
: "${CLOUDREST_JWT:?Set CLOUDREST_JWT — run auth.sh first}"

AUTH=(-H "Authorization: Bearer $CLOUDREST_JWT")
JSON=(-H "Content-Type: application/json")
REP=(-H "Prefer: return=representation")

echo "== Merge-duplicates: insert or update when id collides =="
curl -sS -X POST "$CLOUDREST_URL/authors?on_conflict=id" "${AUTH[@]}" "${JSON[@]}" "${REP[@]}" \
  -H "Prefer: resolution=merge-duplicates,return=representation" \
  -d '[
    {"id": 1, "name": "Frank Herbert", "bio": "Updated bio for Herbert"},
    {"id": 999, "name": "New Author", "bio": "A brand-new row"}
  ]'
echo; echo

echo "== Confirm both rows exist =="
curl -sS "$CLOUDREST_URL/authors?id=in.(1,999)&select=id,name,bio"
echo; echo

echo "== Ignore-duplicates: insert new rows, silently skip the collision =="
curl -sS -X POST "$CLOUDREST_URL/authors?on_conflict=id" "${AUTH[@]}" "${JSON[@]}" \
  -H "Prefer: resolution=ignore-duplicates,return=representation" \
  -d '[
    {"id": 1, "name": "Should be ignored", "bio": "this will not overwrite"},
    {"id": 998, "name": "Another New Author", "bio": "This should be inserted"}
  ]'
echo; echo

echo "== Confirm author 1 was NOT overwritten =="
curl -sS "$CLOUDREST_URL/authors?id=eq.1&select=id,name,bio"
echo; echo

echo "== Cleanup =="
curl -sS -X DELETE "$CLOUDREST_URL/authors?id=in.(998,999)" "${AUTH[@]}" > /dev/null
curl -sS -X PATCH "$CLOUDREST_URL/authors?id=eq.1" "${AUTH[@]}" "${JSON[@]}" \
  -d '{"bio":"Author of the Dune series."}' > /dev/null
echo "done"
