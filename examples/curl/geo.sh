#!/usr/bin/env bash
# PostGIS spatial filters and nearest-neighbor ordering.
#
# Requires the `postgis` extension and the `places` table from
# `../schema.sql`. If PostGIS isn't installed, schema.sql skips the
# spatial fixture silently — these requests will then fail with
# `PGRST205` ("table places not found"). Install PostGIS in your
# database (`CREATE EXTENSION postgis;`) and re-run schema.sql to
# enable.
#
# All four operators are exercised here:
#
#   - geo.dwithin    distance filter (meters)
#   - geo.nearby     nearest-neighbor ORDER BY (also meters, ascending)
#   - geo.within     containment by polygon (GeoJSON or WKT)
#   - geo.intersects geometric intersection (GeoJSON or WKT)
#
# The fixture seeds four NYC landmarks. All coordinates are in
# WGS 84 / SRID 4326.

set -euo pipefail

: "${CLOUDREST_URL:=http://localhost:8787}"

echo "== Plain SELECT (geometry column auto-renders as GeoJSON) =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name,location' \
  --data-urlencode 'order=id.asc'
echo; echo

echo "== geo.dwithin: places within 5 km of Times Square =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name' \
  --data-urlencode 'location=geo.dwithin(40.7580,-73.9855,5000)'
echo; echo

echo "== geo.dwithin: same point, tighter 1 km radius =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name' \
  --data-urlencode 'location=geo.dwithin(40.7580,-73.9855,1000)'
echo; echo

echo "== geo.nearby: ALL places, ordered by distance from Times Square =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name' \
  --data-urlencode 'location=geo.nearby(40.7580,-73.9855)'
echo; echo

echo "== geo.nearby: ordered from the Statue of Liberty (note the inversion) =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name' \
  --data-urlencode 'location=geo.nearby(40.6892,-74.0445)'
echo; echo

echo "== geo.nearby + explicit user order — nearby is the PRIMARY sort, name is a tie-breaker =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name' \
  --data-urlencode 'location=geo.nearby(40.7580,-73.9855)' \
  --data-urlencode 'order=name.asc'
echo; echo

echo "== geo.within (WKT): bounding box around Manhattan — all 4 places match =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name' \
  --data-urlencode 'location=geo.within(POLYGON((-74.05 40.68,-73.95 40.68,-73.95 40.79,-74.05 40.79,-74.05 40.68)))'
echo; echo

echo "== geo.within (WKT): tiny box around Times Square only =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name' \
  --data-urlencode 'location=geo.within(POLYGON((-73.99 40.75,-73.98 40.75,-73.98 40.76,-73.99 40.76,-73.99 40.75)))'
echo; echo

echo "== geo.within (GeoJSON): same Manhattan bounding box, GeoJSON form =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name' \
  --data-urlencode 'location=geo.within({"type":"Polygon","coordinates":[[[-74.05,40.68],[-73.95,40.68],[-73.95,40.79],[-74.05,40.79],[-74.05,40.68]]]})'
echo; echo

echo "== geo.intersects (WKT polygon) =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name' \
  --data-urlencode 'location=geo.intersects(POLYGON((-73.99 40.75,-73.98 40.75,-73.98 40.77,-73.99 40.77,-73.99 40.75)))'
echo; echo

echo "== Explicit geography column projection (CloudREST wraps it as GeoJSON) =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name,boundary' \
  --data-urlencode 'id=eq.1'
echo; echo

echo "== Same column under a user alias =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name,shape:boundary' \
  --data-urlencode 'id=eq.1'
echo; echo

echo "== Opt out of the geography wrap with an explicit cast (returns raw EWKB hex) =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,boundary::text' \
  --data-urlencode 'id=eq.1'
echo; echo

echo "== Composition: nearby + limit + Prefer: count=exact (Content-Range header) =="
curl -sS -i -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name,location' \
  --data-urlencode 'location=geo.nearby(40.7580,-73.9855)' \
  --data-urlencode 'limit=2' \
  -H 'Prefer: count=exact' | grep -iE '^(HTTP|content-range|preference-applied)'
echo; echo

echo "== Negation: NOT within 500 m of Times Square =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'select=id,name' \
  --data-urlencode 'location=not.geo.dwithin(40.7580,-73.9855,500)'
echo; echo

# ---------------------------------------------------------------------
# Error paths — every one of these returns PGRST100 with a clear
# message at HTTP 400. The geo plan-time validators run BEFORE any
# SQL hits the database, so a typo never makes it to Postgres.
# ---------------------------------------------------------------------

echo "== ERROR: geo.dwithin on a non-spatial column =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'id=geo.dwithin(40.7,-74.0,500)' || true
echo; echo

echo "== ERROR: latitude out of range =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'location=geo.dwithin(95,0,500)' || true
echo; echo

echo "== ERROR: negated geo.nearby (no meaningful interpretation) =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'location=not.geo.nearby(40.7,-74.0)' || true
echo; echo

echo "== ERROR: unknown geo operator =="
curl -sS -G "$CLOUDREST_URL/places" \
  --data-urlencode 'location=geo.banana(40.7,-74.0,500)' || true
echo
