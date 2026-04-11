// Having parser — `?having=count().gt.5,sum(total).gte.1000`.
//
// Grammar: comma-separated clauses. Each clause is:
//   aggregate '(' [column] ')' '.' operator '.' value
//
// COMPAT: PostgREST form. Aggregate names are the same closed allowlist
// used by the select grammar (CONSTITUTION §12.5).

import { err, ok, type Result } from '../core/result';
import { parseErrors, type CloudRestError } from '../core/errors';
import { parseOpExpr } from './operators';
import { splitTopLevel } from './tokenize';
import type { HavingClause } from './types/having';
import type { AggregateFunction } from './types/select';

const PATTERN = /^(count|sum|avg|max|min)\(([^)]*)\)\.(.+)$/;

export function parseHavingClauses(
  raw: string,
): Result<readonly HavingClause[], CloudRestError> {
  if (!raw) return ok([]);

  const clauses: HavingClause[] = [];
  for (const part of splitTopLevel(raw, ',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const match = trimmed.match(PATTERN);
    if (!match) {
      return err(
        parseErrors.queryParam(
          'having',
          `invalid having clause: "${trimmed}". Expected: aggregate(column).operator.value`,
        ),
      );
    }

    const aggregate = match[1]! as AggregateFunction;
    const fieldName = match[2]!.trim() || undefined;
    const opAndValue = match[3]!;

    const opResult = parseOpExpr(opAndValue);
    if (!opResult.ok) return opResult;
    if (opResult.value === null) {
      return err(
        parseErrors.queryParam('having', `invalid operator in having clause: "${trimmed}"`),
      );
    }

    clauses.push({ aggregate, field: fieldName, opExpr: opResult.value });
  }

  return ok(clauses);
}
