# RPC — calling functions

Any function in a configured schema is callable as an endpoint under `/rpc/<function_name>`.

## GET vs POST

```http
POST /rpc/search_books
Content-Type: application/json

{ "query": "dune" }
```

Stable and immutable functions can also be called via GET:

```http
GET /rpc/search_books?query=dune
```

Volatile functions must use POST.

## Arguments

Named arguments are passed either as JSON body keys (POST) or query parameters (GET). If the function takes a single unnamed argument, the entire JSON body is passed as that argument.

## Return types

| Function returns | Response |
|---|---|
| Scalar (`int`, `text`, …) | JSON primitive |
| `setof` scalar | JSON array of primitives |
| Composite / table row | JSON object |
| `setof` composite | JSON array of objects |
| `void` | Empty response |

## Querying the result

Table-returning functions support all the same query parameters as regular tables:

```http
GET /rpc/top_books?limit=10&order=rating.desc&select=id,title,rating
```

Filters, embeds, ordering, pagination, and `count=` all work.

## Embedding into function results

You can embed related tables from composite return types:

```http
GET /rpc/get_author_stats?select=*,books(*)
```

## Counts

Set-returning functions support `count=exact`, `count=planned`, and `count=estimated` the same way as tables.
