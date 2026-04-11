// Order parser — `?order=col.desc.nullslast,author(name).desc,data->>key.desc`
//
// Grammar:
//   term        := ( relation '(' field ')' | field ) ( '.' modifier )*
//   modifier    := 'asc' | 'desc' | 'nullsfirst' | 'nullslast'
//   field       := plain column or JSON path using `->`/`->>`
//
// For JSON-path fields, modifiers are collected by walking back from
// the end of the dot-split until a non-modifier is found — this avoids
// confusing the arrows with dot separators.

import { err, ok, type Result } from '../core/result';
import { parseErrors, type CloudRestError } from '../core/errors';
import { parseField } from './json-path';
import type { NullOrder, OrderDirection, OrderTerm } from './types/order';

const KNOWN_MODIFIERS = new Set(['asc', 'desc', 'nullsfirst', 'nullslast']);

export function parseOrder(raw: string): Result<readonly OrderTerm[], CloudRestError> {
  if (!raw) return ok([]);
  const terms: OrderTerm[] = [];

  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const relationMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\(([^)]+)\)(.*)$/);
    if (relationMatch) {
      const relation = relationMatch[1]!;
      const fieldName = relationMatch[2]!;
      const modifierStr = relationMatch[3]!;
      const mods = parseModifiers(modifierStr);
      if (!mods.ok) return mods;
      terms.push({
        relation,
        field: parseField(fieldName),
        direction: mods.value.direction,
        nullOrder: mods.value.nullOrder,
      });
      continue;
    }

    // Plain or JSON-path field plus modifiers.
    let fieldPart: string;
    let modifierSegments: string[];

    const arrowIdx = trimmed.indexOf('->');
    if (arrowIdx !== -1) {
      const allSegments = trimmed.split('.');
      modifierSegments = [];
      while (allSegments.length > 1) {
        const last = allSegments[allSegments.length - 1]!.toLowerCase();
        if (KNOWN_MODIFIERS.has(last)) {
          modifierSegments.unshift(allSegments.pop()!);
        } else {
          break;
        }
      }
      fieldPart = allSegments.join('.');
    } else {
      const segments = trimmed.split('.');
      fieldPart = segments[0]!;
      modifierSegments = segments.slice(1);
    }

    const mods = parseModifiers('.' + modifierSegments.join('.'));
    if (!mods.ok) return mods;
    terms.push({
      field: parseField(fieldPart),
      direction: mods.value.direction,
      nullOrder: mods.value.nullOrder,
    });
  }

  return ok(terms);
}

interface Modifiers {
  direction?: OrderDirection;
  nullOrder?: NullOrder;
}

function parseModifiers(raw: string): Result<Modifiers, CloudRestError> {
  const out: Modifiers = {};
  if (!raw) return ok(out);
  const segments = raw.split('.').filter(Boolean);

  for (const segment of segments) {
    const sl = segment.toLowerCase();
    if (sl === 'asc') out.direction = 'asc';
    else if (sl === 'desc') out.direction = 'desc';
    else if (sl === 'nullsfirst') out.nullOrder = 'nullsfirst';
    else if (sl === 'nullslast') out.nullOrder = 'nullslast';
    else {
      return err(
        parseErrors.queryParam('order', `unknown order modifier: "${segment}"`),
      );
    }
  }
  return ok(out);
}
