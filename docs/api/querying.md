# Querying

CloudREST reads data from any table or view exposed in your configured schemas. The URL path is the resource name and query parameters shape the result.

```http
GET /books?select=id,title&order=created_at.desc&limit=10
```

## Selecting columns

Use `select` to choose columns:

```http
GET /books?select=id,title,author
```

Rename columns with aliases:

```http
GET /books?select=id,title:name
```

Cast columns on the fly:

```http
GET /books?select=id,created_at::text
```

### Aggregates

Apply an aggregate to a column using dot-suffix syntax `column.aggregate()`:

```http
GET /orders?select=status,amount.sum(),count()
```

Supported: `count`, `sum`, `avg`, `max`, `min`. Use an alias to control the output field name:

```http
GET /orders?select=status,total:amount.sum()
```

Combine with `having=` to filter on aggregate results. `having` uses the reversed SQL-style form `aggregate(column).operator.value`:

```http
GET /orders?select=status,amount.sum()&having=sum(amount).gte.1000
```

### Distinct

```http
GET /books?select=distinct(author)
```

## Filtering

Filters use the form `column=operator.value`:

```http
GET /books?price=gt.20&price=lt.50
```

### Comparison

| Operator | Meaning |
|---|---|
| `eq` | equals |
| `neq` | not equals |
| `gt` | greater than |
| `gte` | greater than or equal |
| `lt` | less than |
| `lte` | less than or equal |

### Text

| Operator | Meaning |
|---|---|
| `like` | SQL `LIKE` (use `*` as wildcard) |
| `ilike` | case-insensitive `LIKE` |
| `match` | POSIX regex |
| `imatch` | case-insensitive POSIX regex |

### Sets and ranges

| Operator | Meaning |
|---|---|
| `in` | value in list: `status=in.(active,pending)` |
| `cs` | contains |
| `cd` | contained by |
| `ov` | overlaps |
| `sl` | strictly left of |
| `sr` | strictly right of |
| `nxl` | does not extend left of |
| `nxr` | does not extend right of |
| `adj` | adjacent to |

### Null and boolean

```http
GET /books?deleted_at=is.null
GET /books?published=is.true
```

Supported: `is.null`, `is.not_null`, `is.true`, `is.false`, `is.unknown`.

### Is distinct from

```http
GET /books?status=isdistinct.archived
```

### Full-text search

```http
GET /books?summary=fts.database
GET /books?summary=plfts.full%20text
GET /books?summary=phfts(english).exact%20phrase
GET /books?summary=wfts.web%20search
```

- `fts` — basic tsquery match
- `plfts` — plain tsquery
- `phfts` — phrase tsquery
- `wfts` — websearch tsquery

Specify a language with `fts(english).word`.

### Negation

Prefix any operator with `not.`:

```http
GET /books?status=not.eq.archived
GET /books?price=not.in.(0,1,2)
```

### Logical operators

Combine filters with `and=` and `or=`:

```http
GET /books?or=(price.lt.10,stock.gt.0)
GET /books?and=(price.gte.10,price.lte.50,stock.gt.0)
```

Logical operators can be nested.

## Ordering

```http
GET /books?order=created_at.desc
GET /books?order=author.asc.nullsfirst,title.asc
GET /books?order=data->stats->views.desc
```

## Pagination

### Query parameters

```http
GET /books?limit=20&offset=40
```

### Range header

```http
GET /books
Range: 0-19
```

The response includes `Content-Range`:

```
Content-Range: 0-19/342
```

### Counts

Request a total count with the `Prefer` header:

```http
GET /books
Prefer: count=exact
```

Values: `exact`, `planned`, `estimated`. The response includes a `Content-Range` header such as `0-19/342`.

## Single-row responses

```http
GET /books?id=eq.42
Accept: application/vnd.pgrst.object+json
```

Returns a single object instead of an array. Strip null fields with:

```
Accept: application/vnd.pgrst.object+json;nulls=stripped
```

## CSV output

```http
GET /books
Accept: text/csv
```

Returns `Content-Type: text/csv` with a `Content-Disposition` header for browser downloads.
