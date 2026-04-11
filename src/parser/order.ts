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
import { splitTopLevel } from './tokenize';
import type { NullOrder, OrderDirection, OrderTerm } from './types/order';

const KNOWN_MODIFIERS = new Set(['asc', 'desc', 'nullsfirst', 'nullslast']);

export function parseOrder(raw: string): Result<readonly OrderTerm[], CloudRestError> {
  if (!raw) return ok([]);
  const terms: OrderTerm[] = [];

  const partsResult = splitTopLevel(raw, ',', { context: 'order' });
  if (!partsResult.ok) return partsResult;

  // BUG FIX (#C/#N): `order=col.desc,,col2.asc` used to silently drop
  // the empty middle term. Use the quote-aware split output to detect
  // empty entries — a simple `raw.includes(',,')` false-positives on
  // quoted JSON keys like `data->>"a,,b"` where the comma is inside
  // the quoted region.
  for (const part of partsResult.value) {
    const trimmed = part.trim();
    if (!trimmed) {
      return err(
        parseErrors.queryParam('order', 'empty order term (stray comma)'),
      );
    }

    // BUG FIX (#23): reject structurally malformed terms.
    if (trimmed.startsWith('.') || trimmed.endsWith('.')) {
      return err(
        parseErrors.queryParam('order', `malformed order term: "${trimmed}"`),
      );
    }

    // BUG FIX (#E): a relation-qualified order term's field argument is
    // a full Field, which may contain quoted JSON keys whose contents
    // include `)` characters — `author(data->>"a)b").desc`. The old
    // regex `\(([^)]+)\)` stopped at the first `)`. Scan with quote
    // awareness and paren depth instead.
    const relInfo = matchRelationOrderPrefix(trimmed);
    if (relInfo) {
      const { relation, fieldName, modifierStr } = relInfo;
      const mods = parseModifiers(modifierStr);
      if (!mods.ok) return mods;
      const fieldResult = parseField(fieldName);
      if (!fieldResult.ok) return fieldResult;
      terms.push({
        relation,
        field: fieldResult.value,
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

    if (fieldPart === '') {
      return err(
        parseErrors.queryParam(
          'order',
          `missing field in order term: "${trimmed}"`,
        ),
      );
    }

    // No modifiers: pass an empty string so parseModifiers skips its
    // leading-dot normalization entirely. `'.' + ''` used to land as
    // a single-dot input that the stricter parseModifiers rejected as
    // an empty modifier segment.
    const mods = parseModifiers(
      modifierSegments.length === 0 ? '' : '.' + modifierSegments.join('.'),
    );
    if (!mods.ok) return mods;
    const fieldResult = parseField(fieldPart);
    if (!fieldResult.ok) return fieldResult;
    terms.push({
      field: fieldResult.value,
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
  const out: { direction?: OrderDirection; nullOrder?: NullOrder } = {};
  if (!raw) return ok(out);
  // BUG FIX (#D): the old code used `.filter(Boolean)` which silently
  // collapsed `col..desc` and `col.desc..nullsfirst` into valid modifier
  // lists. Any empty segment (from a doubled dot or a leading dot that
  // is not the prefix we always prepend) is a parse error.
  //
  // Callers prepend a leading `.` to normalize the form, so we always
  // see an empty FIRST segment from the split. Skip exactly that first
  // empty and then require every remaining segment to be non-empty.
  const rawSegments = raw.split('.');
  const segments: string[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i]!;
    if (i === 0 && seg === '') continue;
    if (seg === '') {
      return err(
        parseErrors.queryParam('order', 'empty modifier segment'),
      );
    }
    segments.push(seg);
  }

  for (const segment of segments) {
    const sl = segment.toLowerCase();
    if (sl === 'asc' || sl === 'desc') {
      if (out.direction !== undefined) {
        return err(
          parseErrors.queryParam(
            'order',
            `duplicate direction modifier: "${segment}"`,
          ),
        );
      }
      out.direction = sl;
      continue;
    }
    if (sl === 'nullsfirst' || sl === 'nullslast') {
      if (out.nullOrder !== undefined) {
        return err(
          parseErrors.queryParam(
            'order',
            `duplicate null-order modifier: "${segment}"`,
          ),
        );
      }
      out.nullOrder = sl;
      continue;
    }
    return err(
      parseErrors.queryParam('order', `unknown order modifier: "${segment}"`),
    );
  }
  return ok(out);
}

/**
 * Match a relation-qualified order prefix: `rel(<field>)<rest>`.
 *
 * The field argument may contain quoted JSON path segments whose
 * contents include `)` characters, so a simple `\(([^)]+)\)` regex is
 * not enough. Walks with paren depth and quote tracking instead.
 *
 * Returns `null` if the token does not start with `ident(`.
 */
function matchRelationOrderPrefix(
  term: string,
): { relation: string; fieldName: string; modifierStr: string } | null {
  const identMatch = term.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\(/);
  if (!identMatch) return null;
  const relation = identMatch[1]!;
  const fieldStart = identMatch[0]!.length; // first char after `(`

  // Walk forward from fieldStart tracking paren depth and quotes.
  let depth = 1;
  let i = fieldStart;
  while (i < term.length) {
    const ch = term[i]!;
    if (ch === "'") {
      i = skipQuotedRegion(term, i, "'");
      continue;
    }
    if (ch === '"') {
      i = skipQuotedRegion(term, i, '"');
      continue;
    }
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        const fieldName = term.slice(fieldStart, i);
        if (fieldName === '') return null;
        const modifierStr = term.slice(i + 1);
        return { relation, fieldName, modifierStr };
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  // Unbalanced parens — let the plain-field branch handle the error.
  return null;
}

function skipQuotedRegion(str: string, start: number, quoteChar: string): number {
  let i = start + 1;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === quoteChar) {
      if (str[i + 1] === quoteChar) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return str.length;
}
