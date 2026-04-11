# Resource embedding

CloudREST introspects your foreign-key relationships and lets you embed related rows in a single request.

## Basic embedding

```http
GET /books?select=id,title,author(id,name)
```

Response:

```json
[
  {
    "id": 1,
    "title": "Dune",
    "author": { "id": 7, "name": "Frank Herbert" }
  }
]
```

## Embed all columns

```http
GET /books?select=*,author(*)
```

## Rename the embedded field

```http
GET /books?select=id,creator:author(*)
```

## Nested embedding

```http
GET /authors?select=id,name,books(id,title,reviews(rating))
```

Depth is limited by [`MAX_EMBED_DEPTH`](../configuration.md) (default `8`).

## Join type

By default, embedded resources use a `LEFT JOIN`. Force an inner join to drop rows with no match:

```http
GET /books?select=id,title,author!inner(*)
```

Or explicit left:

```http
GET /books?select=id,title,author!left(*)
```

## Spread operator

Flatten embedded columns into the parent row:

```http
GET /books?select=id,title,...author(name,email)
```

Response:

```json
[
  { "id": 1, "title": "Dune", "name": "Frank Herbert", "email": "..." }
]
```

## Filtering on embedded resources

Apply filters to embedded rows using dot-prefixed keys:

```http
GET /authors?select=id,name,books(title)&books.published=is.true
```

## Ordering and paginating embedded resources

```http
GET /authors?select=id,name,books(title)&books.order=title.asc&books.limit=5
```

## Disambiguating relationships

If two tables are related through multiple foreign keys, hint the one you want with `!constraint_name`:

```http
GET /messages?select=*,sender:users!fk_sender(*),receiver:users!fk_receiver(*)
```

When a relationship is ambiguous and no hint is provided, CloudREST returns `300 Multiple Choices` listing the possible paths.
