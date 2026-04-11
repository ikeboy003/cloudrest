# Mutations

## Insert

Single row:

```http
POST /books
Content-Type: application/json

{ "title": "Dune", "author_id": 7 }
```

Bulk insert:

```http
POST /books
Content-Type: application/json

[
  { "title": "Dune", "author_id": 7 },
  { "title": "Foundation", "author_id": 3 }
]
```

CSV input is also supported:

```http
POST /books
Content-Type: text/csv

title,author_id
Dune,7
Foundation,3
```

### Controlling the response

Use `Prefer: return=` to shape what comes back:

| Value | Response |
|---|---|
| `representation` (default) | Full inserted row(s) |
| `headers-only` | Empty body with `Location` header |
| `minimal` | Empty array |

```http
POST /books
Prefer: return=headers-only
```

### Missing columns

Control how missing JSON keys are treated:

- `Prefer: missing=default` (default) — only provided columns are included; omitted columns use table defaults
- `Prefer: missing=null` — omitted columns are explicitly set to `NULL`

## Update

```http
PATCH /books?id=eq.1
Content-Type: application/json

{ "title": "Dune (Revised)" }
```

Multi-row update with a filter:

```http
PATCH /books?status=eq.draft
Content-Type: application/json

{ "status": "published" }
```

Same `Prefer: return=` options as insert.

## Upsert

```http
PUT /books?id=eq.1
Content-Type: application/json

{ "id": 1, "title": "Dune", "author_id": 7 }
```

`PUT` requires the primary key in the body.

Resolve conflicts with `Prefer: resolution=`:

- `merge-duplicates` — `ON CONFLICT DO UPDATE`
- `ignore-duplicates` — `ON CONFLICT DO NOTHING`

For bulk upserts, specify conflict columns explicitly:

```http
POST /books?on_conflict=isbn
Prefer: resolution=merge-duplicates
Content-Type: application/json

[{ "isbn": "978-0441172719", "title": "Dune" }]
```

## Delete

```http
DELETE /books?id=eq.1
```

Multi-row delete:

```http
DELETE /books?status=eq.draft
```

Same `Prefer: return=` options as insert and update.
