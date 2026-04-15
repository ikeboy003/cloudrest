// Schema relationships — the FK graph used by embed planning.
//
// The planner consumes typed relationship records; no string surgery, no
// resolution-by-regex. Ambiguity is a first-class result of
// `resolveRelationship`, not an exception.

import type { QualifiedIdentifier } from '@/http/request';

/** Name of a foreign-key constraint. */
export type FKConstraint = string;

/** Column pair `[localCol, foreignCol]`. */
export type ColumnPair = readonly [string, string];

/**
 * Many-to-many junction. `sourceColumns` describes the mapping from the
 * parent table to the junction; `targetColumns` describes the mapping
 * from the junction to the child.
 */
export interface Junction {
  readonly table: QualifiedIdentifier;
  readonly constraint1: FKConstraint;
  readonly constraint2: FKConstraint;
  /** `[parentRefColumn, junctionColumn]` pairs. */
  readonly sourceColumns: readonly ColumnPair[];
  /** `[childRefColumn, junctionColumn]` pairs. */
  readonly targetColumns: readonly ColumnPair[];
}

export type Cardinality =
  | { readonly type: 'O2M'; readonly constraint: FKConstraint; readonly columns: readonly ColumnPair[] }
  | { readonly type: 'M2O'; readonly constraint: FKConstraint; readonly columns: readonly ColumnPair[] }
  | {
      readonly type: 'O2O';
      readonly constraint: FKConstraint;
      readonly columns: readonly ColumnPair[];
      readonly isParent: boolean;
    }
  | { readonly type: 'M2M'; readonly junction: Junction };

export interface Relationship {
  readonly table: QualifiedIdentifier;
  readonly foreignTable: QualifiedIdentifier;
  readonly isSelf: boolean;
  readonly cardinality: Cardinality;
  readonly tableIsView: boolean;
  readonly foreignTableIsView: boolean;
}

/**
 * Keyed by `schema\0table\0foreignSchema`. Multiple relationships can
 * share a key (e.g. two FKs from the same parent to the same target),
 * which is why each entry is an array — ambiguity is a legitimate
 * state that the resolver must surface.
 */
export type RelationshipsMap = ReadonlyMap<string, readonly Relationship[]>;

export function relationshipKey(
  table: QualifiedIdentifier,
  foreignSchema: string,
): string {
  return `${table.schema}\0${table.name}\0${foreignSchema}`;
}

export function relationshipIsToOne(rel: Relationship): boolean {
  const c = rel.cardinality;
  return c.type === 'M2O' || c.type === 'O2O';
}

// ----- Resolution --------------------------------------------------------

export type RelationshipResolution =
  | { readonly kind: 'found'; readonly relationship: Relationship }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly Relationship[] }
  | { readonly kind: 'not-found' };

/**
 * Look up a relationship from `parentTable` to an embed named `embedName`,
 * optionally disambiguated by `hint`.
 *
 * Matching rules:
 * - By foreign table name (primary);
 * - By M2M junction-table name;
 * - By FK constraint name.
 *
 * If multiple match and no hint is supplied (or the hint matches
 * nothing), the result is `ambiguous`.
 */
export function resolveRelationship(
  parentTable: QualifiedIdentifier,
  embedName: string,
  hint: string | undefined,
  relationships: RelationshipsMap,
): RelationshipResolution {
  const matches: Relationship[] = [];
  for (const [mapKey, rels] of relationships) {
    const parts = mapKey.split('\0');
    if (
      parts.length >= 2 &&
      parts[0] === parentTable.schema &&
      parts[1] === parentTable.name
    ) {
      for (const r of rels) {
        if (r.foreignTable.name === embedName) {
          matches.push(r);
          continue;
        }
        const card = r.cardinality;
        if (card.type === 'M2M' && card.junction.table.name === embedName) {
          matches.push(r);
          continue;
        }
        if (card.type !== 'M2M' && card.constraint === embedName) {
          matches.push(r);
          continue;
        }
      }
    }
  }

  if (matches.length === 0) return { kind: 'not-found' };

  // A wrong hint should always fail, whether or not the match set is
  // ambiguous — a typo in the constraint name should never be ignored.
  const hintMatches = (r: Relationship): boolean => {
    if (hint === undefined) return true;
    const card = r.cardinality;
    if (card.type === 'M2M') {
      return (
        card.junction.constraint1 === hint ||
        card.junction.constraint2 === hint
      );
    }
    return card.constraint === hint;
  };

  if (matches.length === 1) {
    const sole = matches[0]!;
    if (!hintMatches(sole)) return { kind: 'not-found' };
    return { kind: 'found', relationship: sole };
  }

  if (hint !== undefined) {
    const hinted = matches.find(hintMatches);
    if (hinted) return { kind: 'found', relationship: hinted };
    // Hint was supplied but did not match any candidate — the user
    // asked for a specific constraint that does not exist, so
    // "not found" is a better description than "ambiguous".
    return { kind: 'not-found' };
  }

  return { kind: 'ambiguous', candidates: matches };
}
