// Stage 17 — schema codec round-trip test.
//
// Closes critique #60: the `Map` fields on `SchemaCache` must
// survive JSON serialization. A naive `JSON.stringify(cache)`
// loses every Map entry; the codec explicitly enumerates them.

import { describe, expect, it } from 'vitest';

import { decodeSchemaCache, encodeSchemaCache } from '@/schema/codec';
import { makeSchema, makeM2O, makeO2M } from '@tests/fixtures/schema';

describe('schema codec', () => {
  it('round-trips an empty cache', () => {
    const cache = makeSchema([]);
    const raw = encodeSchemaCache(cache);
    const decoded = decodeSchemaCache(raw);
    expect(decoded.tables.size).toBe(0);
    expect(decoded.relationships.size).toBe(0);
    expect(decoded.routines.size).toBe(0);
  });

  it('round-trips tables with multiple columns', () => {
    const cache = makeSchema([
      {
        name: 'books',
        primaryKey: ['id'],
        columns: [
          { name: 'id', type: 'bigint', nullable: false },
          { name: 'title', type: 'text' },
          { name: 'author_id', type: 'bigint' },
        ],
      },
      {
        name: 'authors',
        primaryKey: ['id'],
        columns: [{ name: 'id', type: 'bigint', nullable: false }],
      },
    ]);
    const decoded = decodeSchemaCache(encodeSchemaCache(cache));
    expect(decoded.tables.size).toBe(2);
    const books = decoded.tables.get('public\u0000books')!;
    expect(books).toBeDefined();
    expect(books.primaryKeyColumns).toEqual(['id']);
    expect(books.columns.size).toBe(3);
    expect(books.columns.get('title')!.type).toBe('text');
  });

  it('round-trips relationships', () => {
    const cache = makeSchema(
      [
        {
          name: 'books',
          primaryKey: ['id'],
          columns: [
            { name: 'id', type: 'bigint', nullable: false },
            { name: 'author_id', type: 'bigint' },
          ],
        },
        {
          name: 'authors',
          primaryKey: ['id'],
          columns: [{ name: 'id', type: 'bigint', nullable: false }],
        },
      ],
      [
        makeM2O({
          from: 'books',
          fromColumn: 'author_id',
          to: 'authors',
          toColumn: 'id',
        }),
        makeO2M({
          from: 'authors',
          fromColumn: 'id',
          to: 'books',
          toColumn: 'author_id',
        }),
      ],
    );
    const decoded = decodeSchemaCache(encodeSchemaCache(cache));
    expect(decoded.relationships.size).toBe(cache.relationships.size);
    for (const [key, entries] of cache.relationships) {
      const roundTripped = decoded.relationships.get(key);
      expect(roundTripped).toHaveLength(entries.length);
    }
  });

  it('refuses to decode an unsupported codec version', () => {
    const bad = JSON.stringify({
      codecVersion: 999,
      loadedAt: 0,
      version: 0,
      tables: [],
      relationships: [],
      routines: [],
    });
    expect(() => decodeSchemaCache(bad)).toThrow(/codec version/);
  });
});
