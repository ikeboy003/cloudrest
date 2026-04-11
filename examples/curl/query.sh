#!/usr/bin/env bash
# Read queries — filters, ordering, pagination, column selection.
# Run `psql "$DATABASE_URL" -f ../schema.sql` first, then start CloudREST.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"

echo "== All books (limit 3) =="
curl -sS "$CLOUDREST_URL/books?limit=3&select=id,title,price"
echo; echo

echo "== Filter: published books priced over \$16, cheapest first =="
curl -sS "$CLOUDREST_URL/books?published=is.true&price=gte.16&order=price.asc&select=title,price"
echo; echo

echo "== Multiple filters on the same column =="
curl -sS "$CLOUDREST_URL/books?price=gte.15&price=lte.17&select=title,price"
echo; echo

echo "== Case-insensitive text search =="
curl -sS "$CLOUDREST_URL/books?title=ilike.*dune*&select=title"
echo; echo

echo "== Full-text search on a text column =="
curl -sS "$CLOUDREST_URL/books?summary=fts.desert&select=title,summary"
echo; echo

echo "== IN filter =="
curl -sS "$CLOUDREST_URL/books?id=in.(1,4,5)&order=id.asc&select=id,title"
echo; echo

echo "== IS null / IS true =="
curl -sS "$CLOUDREST_URL/books?published=is.true&stock=gt.0&select=title"
echo; echo

echo "== Pagination: limit + offset =="
curl -sS "$CLOUDREST_URL/books?order=id.asc&limit=2&offset=2&select=id,title"
echo; echo

echo "== Request a total count via Prefer header =="
curl -sS -i "$CLOUDREST_URL/books?limit=1&select=title" \
  -H "Prefer: count=exact" | grep -iE '^(HTTP|content-range)'
echo

echo "== Single-row response (array of one → bare object) =="
curl -sS "$CLOUDREST_URL/books?id=eq.1&select=id,title" \
  -H "Accept: application/vnd.pgrst.object+json"
echo; echo

echo "== CSV output =="
curl -sS "$CLOUDREST_URL/books?order=id.asc&limit=3&select=id,title,price" \
  -H "Accept: text/csv"
echo
