# PostGIS

CloudREST exposes PostGIS spatial operators as query filters.

## Operators

| Operator | Purpose |
|---|---|
| `dwithin` | Find rows within a distance from a point |
| `nearby` | Order results by distance from a point |
| `within` | Find rows inside a GeoJSON polygon |
| `intersects` | Find rows whose geometry intersects a GeoJSON shape |

## Distance search

Find every coffee shop within 500 meters of a point:

```http
GET /coffee_shops?location=dwithin(40.7128,-74.0060,500)
```

Coordinates are `(latitude, longitude)` and the distance is in meters.

## Ordering by distance

```http
GET /coffee_shops?location=nearby(40.7128,-74.0060)&limit=10
```

## Containment

```http
GET /parks?boundary=within.{"type":"Polygon","coordinates":[[...]]}
```

## Intersection

```http
GET /roads?geom=intersects.{"type":"LineString","coordinates":[[...]]}
```

## Requirements

Your database must have the `postgis` extension installed and the geometry columns must be typed as `geometry` or `geography`.
