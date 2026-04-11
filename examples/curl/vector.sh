#!/usr/bin/env bash
# Vector similarity search via pgvector.
#
# The example schema stores 3-dim embeddings on each book so these queries are
# reproducible without a real language model. In production you'd generate the
# query vector from a sentence transformer and send it as a JSON array.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"

echo "== Nearest neighbours by L2 (Euclidean) distance =="
curl -sS -G "$CLOUDREST_URL/books" \
  --data-urlencode 'vector=[0.1,0.2,0.3]' \
  --data-urlencode 'vector.column=embedding' \
  --data-urlencode 'vector.op=l2' \
  --data-urlencode 'limit=3' \
  --data-urlencode 'select=title'
echo; echo

echo "== Cosine distance (common for language-model embeddings) =="
curl -sS -G "$CLOUDREST_URL/books" \
  --data-urlencode 'vector=[0.8,0.1,0.05]' \
  --data-urlencode 'vector.column=embedding' \
  --data-urlencode 'vector.op=cosine' \
  --data-urlencode 'limit=3' \
  --data-urlencode 'select=title'
echo; echo

echo "== Inner product (returns negative values — lower is more similar) =="
curl -sS -G "$CLOUDREST_URL/books" \
  --data-urlencode 'vector=[0.8,0.1,0.05]' \
  --data-urlencode 'vector.column=embedding' \
  --data-urlencode 'vector.op=inner_product' \
  --data-urlencode 'limit=3' \
  --data-urlencode 'select=title'
echo; echo

echo "== Combine vector search with a filter =="
curl -sS -G "$CLOUDREST_URL/books" \
  --data-urlencode 'vector=[0.1,0.2,0.3]' \
  --data-urlencode 'vector.op=cosine' \
  --data-urlencode 'published=is.true' \
  --data-urlencode 'limit=3' \
  --data-urlencode 'select=title,published'
echo
