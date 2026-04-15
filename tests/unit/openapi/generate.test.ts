// OpenAPI generator tests.
//
// Drives `generateOpenApiDocument` against a pre-built schema cache
// + test config and asserts on the document shape. Every test pins
// one invariant the generator must uphold: path structure, column
// required-ness rules, column-filter param enumeration, RPC path
// shape, standard error responses, and security scheme wiring.

import { describe, expect, it } from 'vitest';

import { generateOpenApiDocument } from '@/openapi/generate';
import { makeSchema } from '@tests/fixtures/schema';
import { attachRoutines, makeRoutine } from '@tests/fixtures/routines';
import { makeTestConfig } from '@tests/fixtures/config';

const SCHEMA = attachRoutines(
  makeSchema([
    {
      name: 'books',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'bigint', nullable: false },
        { name: 'title', type: 'text', nullable: false },
        { name: 'author_id', type: 'bigint', nullable: false },
        { name: 'price', type: 'numeric' },
      ],
    },
    {
      name: 'authors',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'bigint', nullable: false },
        { name: 'name', type: 'text', nullable: false },
      ],
    },
  ]),
  [
    makeRoutine({
      name: 'top_rated_books',
      params: [{ name: 'min_rating', type: 'int4' }],
      returnType: 'composite',
    }),
  ],
);

describe('generateOpenApiDocument — document shape', () => {
  it('emits the OpenAPI 3.0.3 envelope', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info.title).toBe('CloudREST API');
    expect(doc.info.version).toBeDefined();
    expect(doc.paths).toBeDefined();
    expect(doc.components).toBeDefined();
  });

  it('includes a path for every exposed table', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    expect(doc.paths['/books']).toBeDefined();
    expect(doc.paths['/authors']).toBeDefined();
  });

  it('includes a path for every exposed RPC', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    expect(doc.paths['/rpc/top_rated_books']).toBeDefined();
  });

  it('includes the root path documenting itself', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    expect(doc.paths['/']).toBeDefined();
    expect(doc.paths['/']!.get).toBeDefined();
  });
});

describe('generateOpenApiDocument — component schemas', () => {
  it('emits a typed component schema per table keyed by schema.name', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    const schemas = doc.components.schemas;
    expect(schemas['public.books']).toBeDefined();
    expect(schemas['public.authors']).toBeDefined();
  });

  it('component schemas carry column properties in the map', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    const books = doc.components.schemas['public.books']!;
    expect(books.type).toBe('object');
    expect(books.properties).toBeDefined();
    expect(books.properties!['id']).toBeDefined();
    expect(books.properties!['title']).toBeDefined();
    expect(books.properties!['price']).toBeDefined();
  });

  it('marks not-null columns without defaults as required', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    const books = doc.components.schemas['public.books']!;
    expect(books.required).toBeDefined();
    // `title` and `author_id` are NOT NULL with no default → required
    expect(books.required).toContain('title');
    expect(books.required).toContain('author_id');
    // `id` is NOT NULL but the fixture leaves defaultValue=null, so
    // it shows up as required too. (Real introspection sees the
    // serial default and excludes it — that's fine, the generator
    // just threads whatever it gets.)
    expect(books.required).toContain('id');
  });

  it('emits the shared CloudRestError schema', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    const err = doc.components.schemas['CloudRestError']!;
    expect(err.type).toBe('object');
    expect(err.required).toEqual(['code', 'message']);
  });
});

describe('generateOpenApiDocument — table operations', () => {
  it('GET has select/order/limit/offset/Range params plus one per column', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    const get = doc.paths['/books']!.get!;
    const paramNames = (get.parameters ?? []).map((p) => p.name);
    expect(paramNames).toEqual(
      expect.arrayContaining([
        'select',
        'order',
        'limit',
        'offset',
        'Range',
        'Range-Unit',
        'Prefer',
        // one per column
        'id',
        'title',
        'author_id',
        'price',
      ]),
    );
  });

  it('GET response references the component schema', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    const get = doc.paths['/books']!.get!;
    const jsonResp = get.responses['200']!.content!['application/json']!;
    expect(jsonResp.schema.type).toBe('array');
    expect(jsonResp.schema.items!.$ref).toBe(
      '#/components/schemas/public.books',
    );
  });

  it('POST accepts a single object OR an array (oneOf)', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    const post = doc.paths['/books']!.post!;
    const body = post.requestBody!.content['application/json']!.schema;
    expect(body.oneOf).toHaveLength(2);
  });

  it('PUT is present when the table has a primary key', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    expect(doc.paths['/books']!.put).toBeDefined();
  });

  it('DELETE is present for deletable tables', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    expect(doc.paths['/books']!.delete).toBeDefined();
  });
});

describe('generateOpenApiDocument — RPC paths', () => {
  it('POST is always present on an RPC path', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    const rpcPath = doc.paths['/rpc/top_rated_books']!;
    expect(rpcPath.post).toBeDefined();
  });

  it('GET is absent for volatile routines', () => {
    const volatileSchema = attachRoutines(makeSchema([]), [
      makeRoutine({
        name: 'volatile_fn',
        params: [],
        returnType: 'scalar-int',
        volatility: 'volatile',
      }),
    ]);
    const doc = generateOpenApiDocument(volatileSchema, makeTestConfig());
    const rpcPath = doc.paths['/rpc/volatile_fn']!;
    expect(rpcPath.get).toBeUndefined();
    expect(rpcPath.post).toBeDefined();
  });

  it('GET is present for stable/immutable routines with parameter params', () => {
    const stableSchema = attachRoutines(makeSchema([]), [
      makeRoutine({
        name: 'stable_fn',
        params: [{ name: 'x', type: 'int4' }],
        returnType: 'scalar-int',
        volatility: 'stable',
      }),
    ]);
    const doc = generateOpenApiDocument(stableSchema, makeTestConfig());
    const rpcPath = doc.paths['/rpc/stable_fn']!;
    expect(rpcPath.get).toBeDefined();
    const paramNames = (rpcPath.get!.parameters ?? []).map((p) => p.name);
    expect(paramNames).toContain('x');
  });
});

describe('generateOpenApiDocument — standard errors + security', () => {
  it('every operation has a 401 error response', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    const get = doc.paths['/books']!.get!;
    expect(get.responses['401']).toBeDefined();
    expect(get.responses['404']).toBeDefined();
    expect(get.responses['500']).toBeDefined();
  });

  it('security schemes are empty when no JWT secret is configured', () => {
    const doc = generateOpenApiDocument(SCHEMA, makeTestConfig());
    expect(doc.components.securitySchemes).toEqual({});
    expect(doc.security).toEqual([]);
  });

  it('security schemes include JWT when a secret IS configured', () => {
    const doc = generateOpenApiDocument(
      SCHEMA,
      makeTestConfig({
        auth: {
          ...makeTestConfig().auth,
          jwtSecret: 'test-secret',
        },
      }),
    );
    expect(doc.components.securitySchemes['JWT']).toBeDefined();
    expect(doc.security).toEqual([{ JWT: [] }]);
  });
});
