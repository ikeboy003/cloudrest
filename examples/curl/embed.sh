#!/usr/bin/env bash
# Resource embedding — walking foreign-key relationships in a single request.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"

echo "== Basic embed: a book and its author =="
curl -sS "$CLOUDREST_URL/books?id=eq.1&select=title,authors(name)"
echo; echo

echo "== Rename the embedded field =="
curl -sS "$CLOUDREST_URL/books?id=eq.1&select=title,creator:authors(name)"
echo; echo

echo "== Embed all columns of the related table =="
curl -sS "$CLOUDREST_URL/books?id=eq.1&select=*,authors(*)"
echo; echo

echo "== Nested embed: author → books → reviews =="
curl -sS "$CLOUDREST_URL/authors?id=eq.1&select=name,books(title,reviews(rating))"
echo; echo

echo "== Inner join: drop rows with no embedded match =="
curl -sS "$CLOUDREST_URL/books?select=title,reviews!inner(rating)&limit=3"
echo; echo

echo "== Filter on embedded resources =="
curl -sS "$CLOUDREST_URL/authors?id=eq.1&select=name,books(title,stock)&books.stock=gt.0"
echo; echo

echo "== Order and paginate inside an embed =="
curl -sS "$CLOUDREST_URL/authors?id=eq.1&select=name,books(title,price)&books.order=price.desc&books.limit=2"
echo
