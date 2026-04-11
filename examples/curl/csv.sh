#!/usr/bin/env bash
# CSV — use CSV as the request body on INSERT and as the response format on GET.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"
: "${CLOUDREST_JWT:?Set CLOUDREST_JWT — run auth.sh first}"

AUTH=(-H "Authorization: Bearer $CLOUDREST_JWT")

echo "== CSV response on GET =="
curl -sS "$CLOUDREST_URL/books?order=id.asc&limit=3&select=id,title,price" \
  -H "Accept: text/csv"
echo

echo "== CSV response with Content-Disposition (download) =="
curl -sS -i "$CLOUDREST_URL/books?select=id,title,price" \
  -H "Accept: text/csv" | grep -iE '^(HTTP|content-type|content-disposition)'
echo

echo "== Bulk INSERT from a CSV body =="
CSV=$(cat <<'EOF'
book_id,rating,body
1,5,"CSV load 1"
4,4,"CSV load 2"
EOF
)
curl -sS -X POST "$CLOUDREST_URL/reviews" "${AUTH[@]}" \
  -H "Content-Type: text/csv" \
  -H "Prefer: return=representation" \
  --data-binary "$CSV"
echo; echo

echo "== Cleanup =="
curl -sS -X DELETE "$CLOUDREST_URL/reviews?body=like.CSV%20load*" "${AUTH[@]}" > /dev/null
echo "done"
