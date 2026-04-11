// Having parser — `?having=count().gt.5,sum(total).gte.1000`.
//
// Grammar: comma-separated clauses. Each clause is:
//   aggregate '(' [column[->jsonpath]] ')' '.' operator '.' value
//
// COMPAT: PostgREST form. Aggregate names are the same closed allowlist
// used by the select grammar (CONSTITUTION §12.5).
//
// BUG FIX (#21): `sum()`/`avg()`/`min()`/`max()` with no column are
// errors — only `count()` accepts an empty argument.
//
// BUG FIX (#22): field arguments carry a full `Field` AST so JSON paths
// work consistently with select/filter/order.

import { err, ok, type Result } from '@/core/result';
import { parseErrors, type CloudRestError } from '@/core/errors';
import { parseField } from './json-path';
import { parseOpExpr } from './operators';
import { splitTopLevel } from './tokenize';
import type { HavingClause } from './types/having';
import type { AggregateFunction } from './types/select';

export function parseHavingClauses(
  raw: string,
): Result<readonly HavingClause[], CloudRestError> {
  if (!raw) return ok([]);

  const clauses: HavingClause[] = [];
  const partsResult = splitTopLevel(raw, ',', { context: 'having' });
  if (!partsResult.ok) return partsResult;

  // BUG FIX (#F/#O): a stray comma used to silently drop the empty
  // middle clause. Detect empties via the quote-aware split output so
  // a quoted JSON key like `sum(data->>"a,,b")` does not false-
  // positive the check.
  for (const part of partsResult.value) {
    const trimmed = part.trim();
    if (!trimmed) {
      return err(
        parseErrors.queryParam('having', 'empty having clause (stray comma)'),
      );
    }

    // Find the `aggregate(args)` prefix by tracking paren depth, then
    // consume the `.op.value` tail. A simple `^agg\(([^)]*)\)` regex is
    // not enough because the field inside the parens may be a JSON
    // path containing `)` (in theory) — but more importantly because
    // we want the split to be consistent with the rest of the parser.
    const aggMatch = trimmed.match(/^(count|sum|avg|max|min)\(/);
    if (!aggMatch) {
      return err(
        parseErrors.queryParam(
          'having',
          `invalid having clause: "${trimmed}". Expected: aggregate(column).operator.value`,
        ),
      );
    }
    const aggregate = aggMatch[1]! as AggregateFunction;
    const argsStart = aggMatch[0]!.length; // position of first char after `(`

    // Find the matching close-paren. Quote-aware so that a quoted
    // JSON key inside the argument (e.g. `sum(data->>"a)b")`) does not
    // close the aggregate prematurely.
    //
    // BUG FIX (#AA6): the old scan only tracked paren depth — it saw
    // the `)` inside `"a)b"` and closed the aggregate at the wrong
    // position. Walk with quote tracking to skip past quoted regions.
    let argsEnd = -1;
    {
      let depth = 1;
      let i = argsStart;
      while (i < trimmed.length) {
        const ch = trimmed[i]!;
        if (ch === "'") {
          i = skipHavingQuoted(trimmed, i, "'");
          continue;
        }
        if (ch === '"') {
          i = skipHavingQuoted(trimmed, i, '"');
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
            argsEnd = i;
            break;
          }
          i += 1;
          continue;
        }
        i += 1;
      }
    }
    if (argsEnd === -1) {
      return err(
        parseErrors.queryParam('having', `unbalanced parens in "${trimmed}"`),
      );
    }

    const argToken = trimmed.slice(argsStart, argsEnd).trim();
    const tail = trimmed.slice(argsEnd + 1);
    if (!tail.startsWith('.')) {
      return err(
        parseErrors.queryParam(
          'having',
          `expected ".op.value" after aggregate in "${trimmed}"`,
        ),
      );
    }

    // BUG FIX (#21): empty args only OK for count().
    let field: HavingClause['field'];
    if (argToken === '') {
      if (aggregate !== 'count') {
        return err(
          parseErrors.queryParam(
            'having',
            `${aggregate}() requires a column argument`,
          ),
        );
      }
      field = undefined;
    } else if (argToken === '*') {
      // BUG FIX (#AA4): only `count(*)` is meaningful. `sum(*).gt.1`
      // and `avg(*).gt.1` used to parse because parseField accepts
      // `*` as a bare field name. Normalize `count(*)` to the
      // count-with-no-field shape and reject every other aggregate.
      if (aggregate !== 'count') {
        return err(
          parseErrors.queryParam(
            'having',
            `${aggregate}(*) is not a valid aggregate — only count(*) is supported`,
          ),
        );
      }
      field = undefined;
    } else {
      // BUG FIX (#22): parse the argument as a full Field so JSON paths
      // like `sum(data->>'amount')` produce consistent ASTs.
      const fieldResult = parseField(argToken);
      if (!fieldResult.ok) return fieldResult;
      field = fieldResult.value;
    }

    const opResult = parseOpExpr(tail.slice(1));
    if (!opResult.ok) return opResult;
    if (opResult.value === null) {
      return err(
        parseErrors.queryParam('having', `invalid operator in having clause: "${trimmed}"`),
      );
    }

    clauses.push({ aggregate, field, opExpr: opResult.value });
  }

  return ok(clauses);
}

/**
 * Walk past a quoted region (single or double) starting at `start`,
 * honoring the doubled-quote escape form, and return the index one
 * past the closing quote. If the quote never closes, returns
 * `str.length` so the caller still terminates.
 */
function skipHavingQuoted(str: string, start: number, quoteChar: string): number {
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
