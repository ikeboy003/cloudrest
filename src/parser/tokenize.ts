// Shared token-splitting helpers used by every grammar.
//
// INVARIANT: These are the only splitters used by parser/*. If a new
// grammar needs a different split rule, add it here with a distinct
// name; do not inline a bespoke splitter in a grammar file.
//
// INVARIANT: splitTopLevel returns a Result<string[]>. It surfaces
// malformed input (unbalanced parens, unclosed quotes) as a PGRST100
// error instead of silently returning a best-effort slice. The old
// helper silently accepted `select=author(id,name` as a two-item list
// with truncation, which later produced confusing planner failures.

import { err, ok, type Result } from '@/core/result';
import { parseErrors, type CloudRestError } from '@/core/errors';

export interface SplitOptions {
  /** Human-readable context for error messages (e.g. "select"). */
  readonly context?: string;
}

/**
 * Split `str` by `separator`, respecting:
 *   - parenthesis depth (separator inside `(...)` is not a split point)
 *   - single-quoted strings `'...'` with `''` escape form
 *   - double-quoted strings `"..."` with `""` escape form
 *
 * Unbalanced parens or an unclosed quoted string produce a PGRST100
 * parse error.
 *
 * Used by every comma-separated grammar: select, order, logic, having,
 * columns, on_conflict, distinct.
 */
export function splitTopLevel(
  str: string,
  separator: string,
  options: SplitOptions = {},
): Result<string[], CloudRestError> {
  const context = options.context ?? 'query';
  const result: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;

  while (i < str.length) {
    const ch = str[i]!;

    // Single-quoted string: `'...''...'`.
    // BUG FIX: the termination check used `current.endsWith("'")`, which
    // was a false positive for inputs like `'a''` (ends with quote char
    // but the doubled-quote escape was never followed by a real close).
    // Use an explicit `closed` flag so termination is unambiguous.
    if (ch === "'") {
      current += ch;
      i += 1;
      let closed = false;
      while (i < str.length) {
        const inner = str[i]!;
        if (inner === "'") {
          if (i + 1 < str.length && str[i + 1] === "'") {
            // Doubled single-quote is an escape form — stays quoted.
            current += "''";
            i += 2;
            continue;
          }
          // Lone single-quote closes the string.
          current += inner;
          i += 1;
          closed = true;
          break;
        }
        current += inner;
        i += 1;
      }
      if (!closed) {
        return err(
          parseErrors.queryParam(context, 'unterminated single-quoted string'),
        );
      }
      continue;
    }

    // Double-quoted string: `"...""..."`.
    if (ch === '"') {
      current += ch;
      i += 1;
      let closed = false;
      while (i < str.length) {
        const inner = str[i]!;
        if (inner === '"') {
          if (i + 1 < str.length && str[i + 1] === '"') {
            current += '""';
            i += 2;
            continue;
          }
          current += inner;
          i += 1;
          closed = true;
          break;
        }
        current += inner;
        i += 1;
      }
      if (!closed) {
        return err(
          parseErrors.queryParam(context, 'unterminated double-quoted string'),
        );
      }
      continue;
    }

    if (ch === '(') {
      depth += 1;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === ')') {
      depth -= 1;
      if (depth < 0) {
        return err(parseErrors.queryParam(context, 'unbalanced parentheses'));
      }
      current += ch;
      i += 1;
      continue;
    }

    if (ch === separator && depth === 0) {
      result.push(current);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  if (depth !== 0) {
    return err(parseErrors.queryParam(context, 'unbalanced parentheses'));
  }

  // Always emit the trailing token when the input was non-empty.
  // When the whole input is empty, emit `[]`.
  if (str.length > 0) {
    result.push(current);
  }
  return ok(result);
}

/**
 * Split values inside an `in.(...)` clause. Preserves empty strings:
 *
 *   `in.(1,2,3)`      -> ['1', '2', '3']
 *   `in.("")`         -> ['']     (empty string is a valid SQL value)
 *   `in.("a,b","c")`  -> ['a,b', 'c']
 *   `in.(,,)`         -> ['', '', '']
 */
export function splitInValues(
  str: string,
  options: SplitOptions = {},
): Result<string[], CloudRestError> {
  const context = options.context ?? 'in';
  const result: string[] = [];
  let current = '';
  let inQuote = false;
  let hasAnyChar = false;
  let i = 0;

  while (i < str.length) {
    const ch = str[i]!;

    if (ch === '"' && !inQuote) {
      inQuote = true;
      hasAnyChar = true;
      i += 1;
      continue;
    }
    if (ch === '"' && inQuote) {
      if (i + 1 < str.length && str[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      inQuote = false;
      i += 1;
      continue;
    }

    if (ch === ',' && !inQuote) {
      result.push(current);
      current = '';
      hasAnyChar = false;
      i += 1;
      continue;
    }

    current += ch;
    hasAnyChar = true;
    i += 1;
  }

  if (inQuote) {
    return err(
      parseErrors.queryParam(context, 'unterminated double-quoted string in IN list'),
    );
  }

  // Final value: push if there was any content OR if there are
  // preceding values (trailing comma). The only edge case is an
  // entirely empty string, which represents in.() — handled by the
  // caller passing an empty string in, not by this function.
  if (hasAnyChar || result.length > 0) {
    result.push(current);
  }

  return ok(result);
}

/**
 * Strictly parse an integer. Accepts only `-?\d+` and rejects:
 *   - floats (`1.5`)
 *   - scientific notation (`1e2`)
 *   - trailing garbage (`12abc`)
 *   - leading plus (`+5`)
 *   - values outside Number.MAX_SAFE_INTEGER
 */
export function strictParseInt(value: string): number | null {
  if (!/^-?\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n > Number.MAX_SAFE_INTEGER || n < Number.MIN_SAFE_INTEGER) return null;
  return n;
}

/**
 * Strictly parse a non-negative integer — accepts only `\d+`.
 */
export function strictParseNonNegInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  if (n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}
