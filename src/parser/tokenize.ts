// Shared token-splitting helpers used by every grammar.
//
// INVARIANT: These are the only splitters used by parser/*. If a new
// grammar needs a different split rule, add it here with a distinct name;
// do not inline a bespoke splitter in a grammar file.

/**
 * Split `str` by `separator`, respecting:
 *   - parenthesis depth (commas inside `(...)` are not split points)
 *   - double-quoted identifiers (commas inside `"..."` are not split points,
 *     and `""` inside a quoted identifier is the escape form)
 *
 * Used by select, order, logic, and having grammars.
 */
export function splitTopLevel(str: string, separator: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = '';

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;

    if (inQuote) {
      current += ch;
      if (ch === '"') {
        // Doubled quote is escape-form: `""` stays quoted and adds one quote char.
        if (i + 1 < str.length && str[i + 1] === '"') {
          current += str[++i];
        } else {
          inQuote = false;
        }
      }
      continue;
    }

    if (ch === '"') {
      inQuote = true;
      current += ch;
      continue;
    }

    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;

    if (ch === separator && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current !== '') result.push(current);
  return result;
}

/**
 * Split values inside an `in.(...)` clause. Differs from `splitTopLevel`
 * in that it does not track parens — `in` values are flat — and it
 * understands the quoted-string escape form used in URLs.
 *
 *   `"a,b","c","d""e"` -> ['a,b', 'c', 'd"e']
 *   `1,2,3`            -> ['1', '2', '3']
 *   `val1,`            -> ['val1']        (trailing comma dropped)
 */
export function splitInValues(str: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;

    if (ch === '"' && !inQuote) {
      inQuote = true;
      continue;
    }
    if (ch === '"' && inQuote) {
      if (i + 1 < str.length && str[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuote = false;
      continue;
    }

    if (ch === ',' && !inQuote) {
      result.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  if (current !== '' || result.length > 0) result.push(current);
  return result.filter((v) => v !== '');
}

/**
 * Strictly parse an integer. Accepts only `-?\d+` and rejects:
 *   - floats (`1.5`)
 *   - scientific notation (`1e2`)
 *   - trailing garbage (`12abc`)
 *   - leading plus (`+5`)
 *   - values outside Number.MAX_SAFE_INTEGER
 *
 * REGRESSION: the old code used this for `?limit=`/`?offset=`; matching
 * behavior is necessary so `?count=exact` does NOT parse as
 * `count = exact` (critique #71) and `?limit=1e2` does not silently
 * round-trip to 100.
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
