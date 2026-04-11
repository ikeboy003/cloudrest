// JSON path parsing for field references.
//
// Accepts:
//   `col`               -> name: 'col', path: []
//   `col->key`          -> arrow, key
//   `col->>key`         -> doubleArrow, key
//   `col->0`            -> arrow, idx       (pure digits)
//   `col->>'key'`       -> doubleArrow, key (quoted)
//   `col->"k""v"`       -> arrow, key `k"v` (doubled-quote escape)
//   `col->'a'->>'b'`    -> two segments
//
// COMPAT: PostgREST accepts both single-quoted and double-quoted JSON
// path keys. Doubled quotes inside are the escape form.

import type { Field, JsonOperation } from './types/field';

/**
 * Parse a field reference (column name + optional JSON path).
 * Never fails — arbitrary tokens are treated as plain names.
 */
export function parseField(raw: string): Field {
  const segments = raw.split(/(?=->)/);
  if (segments.length === 1) {
    return { name: raw, jsonPath: [] };
  }

  const name = segments[0]!;
  const jsonPath: JsonOperation[] = [];

  for (const segment of segments.slice(1)) {
    if (segment.startsWith('->>')) {
      const value = stripJsonKeyQuotes(segment.slice(3));
      jsonPath.push({
        type: 'doubleArrow',
        operand: /^\d+$/.test(value)
          ? { type: 'idx', value }
          : { type: 'key', value },
      });
    } else if (segment.startsWith('->')) {
      const value = stripJsonKeyQuotes(segment.slice(2));
      jsonPath.push({
        type: 'arrow',
        operand: /^\d+$/.test(value)
          ? { type: 'idx', value }
          : { type: 'key', value },
      });
    } else {
      jsonPath.push({
        type: 'arrow',
        operand: { type: 'key', value: stripJsonKeyQuotes(segment) },
      });
    }
  }

  return { name, jsonPath };
}

/**
 * Strip surrounding quotes from a JSON-path key. Accepts both single
 * and double quotes. Doubled inner quotes are the escape form and
 * become a single quote character.
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
