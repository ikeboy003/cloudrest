# Vector search

CloudREST supports vector similarity search on columns backed by the [`pgvector`](https://github.com/pgvector/pgvector) extension.

## Requirements

Your database must have `pgvector` installed and at least one column of type `vector`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id serial PRIMARY KEY,
  content text,
  embedding vector(1536)
);
```

For large tables, add an index:

```sql
CREATE INDEX ON documents USING hnsw (embedding vector_cosine_ops);
```

## Basic similarity search

Pass a query vector as a JSON array and CloudREST returns rows ordered by similarity:

```http
GET /documents?vector=[0.12,0.45,...]&vector.column=embedding&vector.op=cosine&limit=10
```

Each row in the response includes a `distance` field.

## Parameters

| Parameter | Description | Default |
|---|---|---|
| `vector` | JSON array of floats — the query vector. | *required* |
| `vector.column` | Name of the `vector` column to compare against. | `embedding` |
| `vector.op` | Distance operator. | `l2` |

## Distance operators

| Value | Operator | Meaning |
|---|---|---|
| `l2` | `<->` | Euclidean (L2) distance |
| `cosine` | `<=>` | Cosine distance |
| `inner_product` | `<#>` | Negative inner product |
| `l1` | `<+>` | Manhattan (L1) distance |

Choose the operator that matches your index. Cosine distance is common for normalized embeddings from language models.

## Combining with filters

Vector search composes with every other query parameter. Filter, paginate, and embed related resources as usual:

```http
GET /documents?vector=[0.12,0.45,...]&vector.op=cosine&category=eq.research&limit=5&select=id,title,distance,author(name)
```

This returns the 5 closest research documents along with their authors.
