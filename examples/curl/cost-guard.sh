#!/usr/bin/env bash
# Query cost guard — reject queries that the PostgreSQL planner estimates
# will cost more than a configured threshold.
#
# Before running any query, CloudREST calls EXPLAIN (FORMAT JSON) on it and
# reads `Total Cost` from the plan. If that number exceeds `MAX_QUERY_COST`
# the request is refused with HTTP 400 and error code CRST001.
#
# Quick primer on "cost": it's a unit-less number the planner computes from
# tunable constants — `seq_page_cost`, `random_page_cost`, `cpu_tuple_cost`,
# plus join/sort/hash overhead. A simple indexed lookup is cost ~8; a full
# scan on a big table can be 100000+. You pick a ceiling above your
# worst-reasonable query and anything more expensive is refused before it
# can hurt your database.
#
# To see this example trip, temporarily set MAX_QUERY_COST low in wrangler.toml:
#
#   [vars]
#   MAX_QUERY_COST = "14"
#
# and `wrangler dev` will hot-reload. Restore it afterwards.
set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"

echo "== Normal query — allowed =="
curl -sS -w "\nHTTP %{http_code}\n" "$CLOUDREST_URL/books?limit=3&select=title"
echo

echo "== Indexed PK lookup — always cheap =="
curl -sS -w "\nHTTP %{http_code}\n" "$CLOUDREST_URL/books?id=eq.1&select=title"
echo

echo "== See the planner's cost estimate for any query =="
echo "Run this against your DB directly to see the same number CloudREST reads:"
cat <<'PSQL'
  psql "$DATABASE_URL" -c "
    EXPLAIN (FORMAT JSON)
    SELECT null::bigint AS total_result_set,
           pg_catalog.count(t) AS page_total,
           coalesce(json_agg(t), '[]')::text AS body
    FROM (SELECT \"public\".\"books\".* FROM \"public\".\"books\") t;"
PSQL
echo

echo "== If the guard trips, the response looks like this =="
cat <<'JSON'
HTTP/1.1 400 Bad Request
X-Query-Cost: 17.5
Content-Type: application/json

{
  "code": "CRST001",
  "message": "Query cost 17.5 exceeds maximum allowed cost 14",
  "details": null,
  "hint": "Simplify the query or increase MAX_QUERY_COST"
}
JSON
