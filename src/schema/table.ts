// Schema cache: table and column shapes.
//
// INVARIANT: field names are normalized. The old code carried
// `table.tableColumns`, `column.colType`, etc. — a Haskell record-field
// naming convention that created visual noise and made TypeScript feel
// mechanically ported. The rewrite uses plain `columns`, `type`, etc.

import type { QualifiedIdentifier } from '../http/request';

export interface Column {
  readonly name: string;
  /** Resolved base type, e.g. `integer`, `text`. */
  readonly type: string;
  /** Type with modifiers, e.g. `varchar(255)`. */
  readonly nominalType: string;
  readonly nullable: boolean;
  readonly maxLength: number | null;
  readonly defaultValue: string | null;
  readonly description: string | null;
  readonly enumValues: readonly string[];
  /** GENERATED ALWAYS columns (stored or virtual). */
  readonly generated: boolean;
  /** PostGIS geometry or geography column. */
  readonly isGeo: boolean;
}

export interface Table {
  readonly schema: string;
  readonly name: string;
  readonly description: string | null;
  readonly isView: boolean;
  readonly insertable: boolean;
  readonly updatable: boolean;
  readonly deletable: boolean;
  readonly primaryKeyColumns: readonly string[];
  readonly columns: ReadonlyMap<string, Column>;
}

export type TablesMap = ReadonlyMap<string, Table>;

/**
 * Convert a Table back to its QualifiedIdentifier. Convenience for
 * planner code that needs to build an identifier from a table it has
 * already resolved.
 */
export function tableIdentifier(table: Table): QualifiedIdentifier {
  return { schema: table.schema, name: table.name };
}

/**
 * Look up a column by name (case-sensitive).
 */
export function findColumn(table: Table, name: string): Column | undefined {
  return table.columns.get(name);
}
