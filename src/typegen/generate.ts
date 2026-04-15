// TypeScript type emission from a `SchemaCache` + a parsed select
// tree.
//
// Given a table name and a list of `SelectItem` (from the normal
// parser), produce a TypeScript `export interface`. Columns map via
// `pgTypeToTs`, nullables get `| null`, and embed items become
// nested objects / arrays based on the relationship cardinality.
//
// INVARIANT: this module is PURE. No DB access, no runtime state.
// It's a format-from-cache operation.

import type { SchemaCache } from '@/schema/cache';
import type { Column, Table } from '@/schema/table';
import type { SelectItem } from '@/parser/types';
import { relationshipIsToOne } from '@/schema/relationship';
import { pgTypeToTs } from './pg-to-ts';

export interface GenerateInput {
  readonly schema: SchemaCache;
  readonly tableName: string;
  /** The parser's `SelectItem[]`. An empty array means "all columns". */
  readonly selectItems: readonly SelectItem[];
  /** Optional schema to disambiguate across multi-schema deployments. */
  readonly tableSchema?: string;
}

/**
 * Emit a TypeScript interface declaration string for the given
 * table + select tree.
 */
export function generateTypeScript(input: GenerateInput): string {
  const interfaceName = `${toPascalCase(input.tableName)}Row`;
  const lines: string[] = [];
  lines.push(`export interface ${interfaceName} {`);
  emitFields(
    input.schema,
    input.selectItems,
    input.tableName,
    input.tableSchema,
    lines,
    '  ',
  );
  lines.push('}');
  return lines.join('\n');
}

// ----- Recursive emitter ------------------------------------------------

function emitFields(
  schema: SchemaCache,
  selectItems: readonly SelectItem[],
  tableName: string,
  tableSchema: string | undefined,
  lines: string[],
  indent: string,
): void {
  const table = findTableByName(schema, tableName, tableSchema);

  // Empty select = select all columns.
  const items: readonly SelectItem[] =
    selectItems.length === 0
      ? [{ type: 'field', field: { name: '*', jsonPath: [] } }]
      : selectItems;

  for (const item of items) {
    if (item.type === 'field') {
      emitFieldItem(item, table, lines, indent);
      continue;
    }
    emitEmbedItem(schema, item, tableName, lines, indent);
  }
}

function emitFieldItem(
  item: Extract<SelectItem, { type: 'field' }>,
  table: Table | null,
  lines: string[],
  indent: string,
): void {
  if (item.field.name === '*') {
    if (table === null) return;
    for (const [colName, col] of table.columns) {
      lines.push(`${indent}${colName}: ${columnToTsType(col)};`);
    }
    return;
  }
  const col = table?.columns.get(item.field.name);
  if (col !== undefined) {
    const alias = item.alias ?? item.field.name;
    lines.push(`${indent}${alias}: ${columnToTsType(col)};`);
    return;
  }
  // Unknown column — emit `unknown` so the user sees the name but
  // doesn't get a misleading type.
  lines.push(`${indent}${item.alias ?? item.field.name}: unknown;`);
}

function emitEmbedItem(
  schema: SchemaCache,
  item: Exclude<SelectItem, { type: 'field' }>,
  parentTable: string,
  lines: string[],
  indent: string,
): void {
  const relName = item.relation;
  const alias = item.type === 'relation' && item.alias !== undefined ? item.alias : relName;

  const toOne = isRelationToOne(schema, parentTable, relName);
  const innerItems: readonly SelectItem[] =
    item.innerSelect !== undefined && item.innerSelect.length > 0
      ? item.innerSelect
      : [{ type: 'field', field: { name: '*', jsonPath: [] } }];

  if (item.type === 'spread') {
    // Spread: inline the child's columns at the current indent level.
    emitFields(schema, innerItems, relName, undefined, lines, indent);
    return;
  }

  lines.push(`${indent}${alias}: {`);
  emitFields(schema, innerItems, relName, undefined, lines, indent + '  ');
  lines.push(toOne ? `${indent}} | null;` : `${indent}}[];`);
}

// ----- Helpers ----------------------------------------------------------

function columnToTsType(col: Column): string {
  const base = pgTypeToTs(col.type, col);
  return col.nullable ? `${base} | null` : base;
}

function findTableByName(
  schema: SchemaCache,
  tableName: string,
  tableSchema: string | undefined,
): Table | null {
  for (const table of schema.tables.values()) {
    if (tableSchema !== undefined && table.schema !== tableSchema) continue;
    if (table.name === tableName) return table;
  }
  return null;
}

function isRelationToOne(
  schema: SchemaCache,
  fromTable: string,
  toTable: string,
): boolean {
  for (const [, rels] of schema.relationships) {
    for (const rel of rels) {
      if (rel.table.name === fromTable && rel.foreignTable.name === toTable) {
        return relationshipIsToOne(rel);
      }
    }
  }
  return false;
}

function toPascalCase(name: string): string {
  return name
    .split(/[_\s-]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
