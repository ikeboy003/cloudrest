#!/usr/bin/env bash
# Prefer header — every variant CloudREST understands.
#
# The Prefer header controls how CloudREST shapes the response and how
# it commits the transaction. Multiple values can be combined, comma-separated.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"
: "${CLOUDREST_JWT:?Set CLOUDREST_JWT — run auth.sh first}"

AUTH=(-H "Authorization: Bearer $CLOUDREST_JWT")
JSON=(-H "Content-Type: application/json")

echo "== count=exact: adds Content-Range with total row count =="
curl -sS -i "$CLOUDREST_URL/books?limit=1&select=title" \
  -H "Prefer: count=exact" | grep -iE '^(HTTP|content-range|preference-applied)'
echo

echo "== count=planned: fast estimate via pg_class.reltuples =="
curl -sS -i "$CLOUDREST_URL/books?limit=1&select=title" \
  -H "Prefer: count=planned" | grep -iE '^(HTTP|content-range)'
echo

echo "== count=estimated: exact for small tables, planned otherwise =="
curl -sS -i "$CLOUDREST_URL/books?limit=1&select=title" \
  -H "Prefer: count=estimated" | grep -iE '^(HTTP|content-range)'
echo

echo "== return=representation: default, returns the affected rows =="
curl -sS -X POST "$CLOUDREST_URL/reviews" "${AUTH[@]}" "${JSON[@]}" \
  -H "Prefer: return=representation" \
  -d '{"book_id":1,"rating":5,"body":"prefer rep"}'
echo; echo

echo "== return=headers-only: empty body, Location header =="
curl -sS -i -X POST "$CLOUDREST_URL/reviews" "${AUTH[@]}" "${JSON[@]}" \
  -H "Prefer: return=headers-only" \
  -d '{"book_id":1,"rating":5,"body":"prefer headers"}' | grep -iE '^(HTTP|location)'
echo

echo "== return=minimal: no body at all =="
curl -sS -i -X POST "$CLOUDREST_URL/reviews" "${AUTH[@]}" "${JSON[@]}" \
  -H "Prefer: return=minimal" \
  -d '{"book_id":1,"rating":5,"body":"prefer minimal"}' | grep -iE '^(HTTP|content-length)'
echo

echo "== missing=default: omitted payload keys use table defaults =="
curl -sS -X POST "$CLOUDREST_URL/reviews" "${AUTH[@]}" "${JSON[@]}" \
  -H "Prefer: return=representation,missing=default" \
  -d '{"book_id":1,"rating":5,"body":"missing default"}'
echo; echo

echo "== missing=null: omitted payload keys become explicit NULL =="
# (no nullable optional columns on reviews to demo a diff, but this proves
# the header is accepted and doesn't error)
curl -sS -X POST "$CLOUDREST_URL/reviews" "${AUTH[@]}" "${JSON[@]}" \
  -H "Prefer: return=representation,missing=null" \
  -d '{"book_id":1,"rating":5,"body":"missing null"}'
echo; echo

echo "== tx=rollback: execute but don't commit (preview mode) =="
curl -sS -X POST "$CLOUDREST_URL/reviews" "${AUTH[@]}" "${JSON[@]}" \
  -H "Prefer: return=representation,tx=rollback" \
  -d '{"book_id":1,"rating":5,"body":"tx rollback preview"}'
echo; echo

echo "== Confirm the tx=rollback row is NOT in the database =="
curl -sS "$CLOUDREST_URL/reviews?body=eq.tx%20rollback%20preview&select=body"
echo; echo

echo "== resolution=merge-duplicates: upsert merges (from mutations.sh) =="
curl -sS -X POST "$CLOUDREST_URL/authors?on_conflict=id" "${AUTH[@]}" "${JSON[@]}" \
  -H "Prefer: return=representation,resolution=merge-duplicates" \
  -d '[{"id":2,"name":"Isaac Asimov","bio":"Updated via merge-duplicates"}]'
echo; echo

echo "== Cleanup =="
curl -sS -X DELETE "$CLOUDREST_URL/reviews?body=like.prefer*" "${AUTH[@]}" > /dev/null
curl -sS -X DELETE "$CLOUDREST_URL/reviews?body=eq.missing%20default" "${AUTH[@]}" > /dev/null
curl -sS -X DELETE "$CLOUDREST_URL/reviews?body=eq.missing%20null" "${AUTH[@]}" > /dev/null
curl -sS -X PATCH "$CLOUDREST_URL/authors?id=eq.2" "${AUTH[@]}" "${JSON[@]}" \
  -d '{"bio":"Biochemist and prolific science-fiction writer."}' > /dev/null
echo "done"
