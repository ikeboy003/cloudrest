#!/usr/bin/env bash
# Logical operators — AND, OR, NOT, and nested logic trees.
#
# Multiple query-string filters are combined with AND by default. Use the
# `and=(...)` / `or=(...)` syntax to build explicit logic trees.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"

echo "== Implicit AND: multiple filters on different columns =="
curl -sS "$CLOUDREST_URL/books?published=is.true&stock=gt.0&select=title,stock"
echo; echo

echo "== Explicit OR: cheap OR out of stock =="
curl -sS "$CLOUDREST_URL/books?or=(price.lt.15,stock.eq.0)&select=title,price,stock"
echo; echo

echo "== NOT: prefix any operator with not. =="
curl -sS "$CLOUDREST_URL/books?title=not.ilike.*dune*&select=title"
echo; echo

echo "== NOT IN =="
curl -sS "$CLOUDREST_URL/books?id=not.in.(1,2,3)&select=id,title&order=id.asc"
echo; echo

echo "== Nested logic: (published AND stock > 0) OR price < 15 =="
curl -sS "$CLOUDREST_URL/books?or=(and(published.is.true,stock.gt.0),price.lt.15)&select=title,price,stock,published"
echo; echo

echo "== Multiple filters on the same column (implicit AND) =="
curl -sS "$CLOUDREST_URL/books?price=gte.15&price=lte.17&select=title,price&order=price.asc"
echo
