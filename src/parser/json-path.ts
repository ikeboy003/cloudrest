// JSON path parsing for field references.
//
// Accepts:
//   `col`               -> name: 'col', path: []
//   `col->key`          -> arrow, key
//   `col->>key`         -> doubleArrow, key
//   `col->0`            -> arrow, idx       (pure digits, unquoted)
//   `col->"0"`          -> arrow, key "0"   (quoted digits stay keys)
//   `col->>'key'`       -> doubleArrow, key (quoted)
//   `col->"k""v"`       -> arrow, key `k"v` (doubled-quote escape)
//   `col->'a->b'`       -> arrow, key `a->b` (quoted key may contain arrows)
//   `col->'a'->>'b'`    -> two segments
//
// BUG FIX (#18): parseField used to never fail. It now returns a Result
// and rejects:
//   - `data->`      (dangling arrow with no key)
//   - `->key`       (arrow with no field name)
//   - unterminated quoted keys
//
// BUG FIX (#17): quoted numeric keys (`data->"0"`) now stay as `key`
// operands; only UNQUOTED digit sequences become `idx` operands. The old
// code stripped quotes first and then tested `^\d+$`, losing the
// distinction.

import { err, ok, type Result } from '@/core/result';
import { parseErrors, type CloudRestError } from '@/core/errors';
import type { Field, JsonOperation } from './types/field';

export function parseField(raw: string): Result<Field, CloudRestError> {
  if (raw === '') {
    return err(parseErrors.queryParam('field', 'empty field reference'));
  }

  // Fast path: no arrow at all.
  if (!raw.includes('->')) {
    // BUG FIX (#A): the old fast path returned the raw string verbatim
    // as the column name, so filter/order/having/logic would accept
    // garbage like `a;DROP`, `a b`, `max(x)`, backticks, and SQL
    // comments. Select has its own validator, but the shared parseField
    // did not — now the plain-name case is gated by the same identifier
    // rule (letters/digits/underscore, non-digit first char) or `*`.
    if (!isValidPlainFieldName(raw)) {
      return err(
        parseErrors.queryParam('field', `invalid field name: "${raw}"`),
      );
    }
    return ok({ name: raw, jsonPath: [] });
  }

  const segmentsResult = scanArrowSegments(raw);
  if (!segmentsResult.ok) return segmentsResult;
  const segments = segmentsResult.value;

  // BUG FIX (#18): `->key` scans as one segment because the arrow is
  // at position 0 and no `current` gets pushed ahead of it. Detect by
  // inspecting the first segment for a leading arrow.
  const first = segments[0]!;
  if (first.startsWith('->')) {
    return err(
      parseErrors.queryParam('field', `missing field name before JSON path: "${raw}"`),
    );
  }

  if (segments.length === 1) {
    return ok({ name: raw, jsonPath: [] });
  }

  const name = first;
  if (name === '') {
    // `->key` with no field name (defensive — covered by the check above).
    return err(
      parseErrors.queryParam('field', `missing field name before JSON path: "${raw}"`),
    );
  }
  // BUG FIX (#A): the head of a JSON-path field must also be a plain
  // identifier. `max(x)->key` and `a b->key` must not slip through.
  if (!isValidPlainFieldName(name)) {
    return err(
      parseErrors.queryParam('field', `invalid field name: "${name}"`),
    );
  }
  // BUG FIX (#AA2): `*->key` used to parse as "wildcard traverses JSON",
  // which is not meaningful. The wildcard is only valid as a bare
  // field reference.
  if (name === '*') {
    return err(
      parseErrors.queryParam('field', `wildcard "*" cannot have a JSON path: "${raw}"`),
    );
  }

  const jsonPath: JsonOperation[] = [];

  for (const segment of segments.slice(1)) {
    const isDoubleArrow = segment.startsWith('->>');
    const rawOperand = segment.slice(isDoubleArrow ? 3 : 2);

    if (rawOperand === '') {
      // `data->` or `data->>` with nothing after the arrow.
      return err(
        parseErrors.queryParam(
          'field',
          `dangling JSON path arrow in "${raw}"`,
        ),
      );
    }

    // BUG FIX (#B): an operand that STARTS with a quote but has
    // trailing junk after the closing quote (`data->"a"b`) must not
    // silently become the literal key `"a"b`. Detect the shape before
    // the quoted / unquoted fork.
    if (
      (rawOperand.startsWith('"') || rawOperand.startsWith("'"))
      && !isQuoted(rawOperand)
    ) {
      return err(
        parseErrors.queryParam(
          'field',
          `malformed quoted JSON key in "${raw}"`,
        ),
      );
    }

    const wasQuoted = isQuoted(rawOperand);
    const unquoted = stripJsonKeyQuotes(rawOperand);

    // Quoted keys must have matching delimiters.
    if (wasQuoted && unquoted === rawOperand) {
      // stripJsonKeyQuotes returned the input unchanged despite seeing
      // a leading quote — means the closing quote was missing.
      return err(
        parseErrors.queryParam('field', `unterminated quoted JSON key in "${raw}"`),
      );
    }

    // BUG FIX (#17): quoted numeric keys remain keys.
    const isUnquotedInteger = !wasQuoted && /^\d+$/.test(rawOperand);
    // BUG FIX (#AA18): an unquoted JSON path key must be a plain SQL
    // identifier (or a bare non-negative integer for array indexes).
    // The old grammar accepted anything scanArrowSegments didn't stop
    // at, so `data->a b`, `data->a;DROP`, and `data->a)bad` all
    // parsed as valid keys. The builder binds keys safely, but the
    // grammar should still reject shapes that could only have been
    // typos or injection attempts — users wanting arbitrary keys
    // should quote them.
    if (!wasQuoted && !isUnquotedInteger) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawOperand)) {
        return err(
          parseErrors.queryParam(
            'field',
            `invalid unquoted JSON key "${rawOperand}" in "${raw}" (quote it or use a plain identifier)`,
          ),
        );
      }
    }
    const operand = isUnquotedInteger
      ? ({ type: 'idx', value: rawOperand } as const)
      : ({ type: 'key', value: unquoted } as const);

    jsonPath.push({
      type: isDoubleArrow ? 'doubleArrow' : 'arrow',
      operand,
    });
  }

  return ok({ name, jsonPath });
}

function isQuoted(value: string): boolean {
  return (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  );
}

/**
 * Walk `raw` and produce `[name, '->seg1', '->>seg2', ...]`, treating
 * `->` / `->>` as segment boundaries only when outside single or double
 * quoted strings. Doubled-quote-char is the escape form.
 *
 * Returns an error on unterminated quoted regions.
 */
function scanArrowSegments(raw: string): Result<string[], CloudRestError> {
  const segments: string[] = [];
  let current = '';
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i]!;

    // Single-quoted region.
    if (ch === "'") {
      const closing = findMatchingQuote(raw, i, "'");
      if (closing === -1) {
        return err(
          parseErrors.queryParam('field', 'unterminated single-quoted JSON key'),
        );
      }
      current += raw.slice(i, closing + 1);
      i = closing + 1;
      continue;
    }

    // Double-quoted region.
    if (ch === '"') {
      const closing = findMatchingQuote(raw, i, '"');
      if (closing === -1) {
        return err(
          parseErrors.queryParam('field', 'unterminated double-quoted JSON key'),
        );
      }
      current += raw.slice(i, closing + 1);
      i = closing + 1;
      continue;
    }

    // Arrow boundary.
    if (ch === '-' && raw[i + 1] === '>') {
      if (current.length > 0) {
        segments.push(current);
        current = '';
      }
      if (raw[i + 2] === '>') {
        current = '->>';
        i += 3;
      } else {
        current = '->';
        i += 2;
      }
      continue;
    }

    current += ch;
    i += 1;
  }

  if (current !== '') segments.push(current);
  return ok(segments);
}

/**
 * Find the matching closing quote, honoring the doubled-quote escape
 * form. Returns the index of the closing quote, or -1 if not found.
 */
function findMatchingQuote(
  str: string,
  start: number,
  quoteChar: string,
): number {
  let i = start + 1;
  while (i < str.length) {
    const ch = str[i]!;
    if (ch === quoteChar) {
      if (str[i + 1] === quoteChar) {
        i += 2;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Strip surrounding quotes from a JSON-path key. Accepts both single
 * and double quotes. Doubled inner quotes are the escape form and
 * become a single quote character.
 *
 * If the value is not properly quoted (wrong length, mismatched
 * delimiters), returns the input unchanged.
 */
function stripJsonKeyQuotes(value: string): string {
  if (value.length >= 2) {
    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      return value.slice(1, -1).replace(/""/g, '"');
    }
  }
  return value;
}

/**
 * True if `raw` is a legal plain field name: `*`, or one-or-more dotted
 * SQL identifiers (letters/digits/underscore, non-digit first char). A
 * dotted form like `actors.name` is permitted because logic.ts's leaf
 * splitter hands fields with an embed prefix directly to parseField.
 *
 * Used to gate the shared `parseField` so that garbage like `a;DROP`,
 * `a b`, `max(x)`, backticks, and SQL comments cannot parse as valid
 * field references through filter/order/having/logic. Select has its
 * own, stricter, undotted identifier validator — select items never
 * carry embed-qualified names at parse time.
 */
export function isValidPlainFieldName(raw: string): boolean {
  if (raw === '*') return true;
  return /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(raw);
}
