// `generateTypeScript` tests.

import { describe, expect, it } from 'vitest';

import { generateTypeScript } from '@/typegen/generate';
import { parseSelect } from '@/parser/select';
import { makeSchema, makeM2O, makeO2M } from '@tests/fixtures/schema';
import { expectOk } from '@tests/fixtures/assert-result';
import type { SelectItem } from '@/parser/types';

const SCHEMA = makeSchema(
  [
    {
      name: 'authors',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'int4', nullable: false },
        { name: 'name', type: 'text', nullable: false },
        { name: 'bio', type: 'text' },
      ],
    },
    {
      name: 'books',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'int4', nullable: false },
        { name: 'title', type: 'text', nullable: false },
        { name: 'author_id', type: 'int4', nullable: false },
        { name: 'price', type: 'numeric', nullable: false },
        { name: 'published', type: 'bool', nullable: false },
      ],
    },
    {
      name: 'reviews',
      primaryKey: ['id'],
      columns: [
        { name: 'id', type: 'int4', nullable: false },
        { name: 'book_id', type: 'int4', nullable: false },
        { name: 'rating', type: 'int4', nullable: false },
      ],
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
      from: 'books',
      fromColumn: 'id',
      to: 'reviews',
      toColumn: 'book_id',
    }),
  ],
);

function parse(select: string): readonly SelectItem[] {
  return expectOk(parseSelect(select));
}

describe('generateTypeScript — simple column list', () => {
  it('emits every column when selectItems is empty', () => {
    const ts = generateTypeScript({
      schema: SCHEMA,
      tableName: 'authors',
      selectItems: [],
    });
    expect(ts).toContain('export interface AuthorsRow {');
    expect(ts).toContain('id: number;');
    expect(ts).toContain('name: string;');
    expect(ts).toContain('bio: string | null;');
    expect(ts).toContain('}');
  });

  it('emits only the selected columns', () => {
    const ts = generateTypeScript({
      schema: SCHEMA,
      tableName: 'books',
      selectItems: parse('id,title'),
    });
    expect(ts).toContain('id: number;');
    expect(ts).toContain('title: string;');
    expect(ts).not.toContain('author_id');
    expect(ts).not.toContain('price');
  });

  it('nullable columns get `| null`', () => {
    const ts = generateTypeScript({
      schema: SCHEMA,
      tableName: 'authors',
      selectItems: parse('bio'),
    });
    expect(ts).toContain('bio: string | null;');
  });

  it('non-null columns do NOT get `| null`', () => {
    const ts = generateTypeScript({
      schema: SCHEMA,
      tableName: 'books',
      selectItems: parse('published'),
    });
    expect(ts).toContain('published: boolean;');
    expect(ts).not.toContain('published: boolean | null');
  });
});

describe('generateTypeScript — embeds', () => {
  it('emits a to-one embed as `| null`', () => {
    const ts = generateTypeScript({
      schema: SCHEMA,
      tableName: 'books',
      selectItems: parse('id,authors(name)'),
    });
    expect(ts).toContain('authors: {');
    expect(ts).toContain('} | null;');
  });

  it('emits a to-many embed as `[]`', () => {
    const ts = generateTypeScript({
      schema: SCHEMA,
      tableName: 'books',
      selectItems: parse('id,reviews(rating)'),
    });
    expect(ts).toContain('reviews: {');
    expect(ts).toContain('}[];');
  });

  it('honors an embed alias', () => {
    const ts = generateTypeScript({
      schema: SCHEMA,
      tableName: 'books',
      selectItems: parse('id,author:authors(name)'),
    });
    expect(ts).toContain('author: {');
  });

  it('nests multiple levels of embeds', () => {
    const ts = generateTypeScript({
      schema: SCHEMA,
      tableName: 'books',
      selectItems: parse('title,authors(name),reviews(rating)'),
    });
    expect(ts).toContain('authors: {');
    expect(ts).toContain('} | null;');
    expect(ts).toContain('reviews: {');
    expect(ts).toContain('}[];');
  });
});

describe('generateTypeScript — column aliases', () => {
  it('honors a field alias', () => {
    const ts = generateTypeScript({
      schema: SCHEMA,
      tableName: 'books',
      selectItems: parse('book_title:title'),
    });
    expect(ts).toContain('book_title: string;');
  });
});

describe('generateTypeScript — enums and vectors', () => {
  it('emits enum values as a string-literal union', () => {
    const schemaWithEnum = makeSchema([
      {
        name: 'tasks',
        columns: [
          {
            name: 'id',
            type: 'int4',
            nullable: false,
          },
          {
            name: 'status',
            type: 'status_enum',
            nullable: false,
          },
        ],
      },
    ]);
    // Patch enumValues post-hoc since the fixture helper has no
    // dedicated slot for it.
    const tasks = [...schemaWithEnum.tables.values()][0]!;
    (tasks.columns.get('status') as { enumValues: readonly string[] }).enumValues =
      ['todo', 'doing', 'done'];

    const ts = generateTypeScript({
      schema: schemaWithEnum,
      tableName: 'tasks',
      selectItems: parse('status'),
    });
    expect(ts).toContain("status: 'todo' | 'doing' | 'done';");
  });
});
