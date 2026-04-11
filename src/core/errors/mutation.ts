// Mutation and GUC errors — PGRST111, PGRST112, PGRST121, PGRST124, PGRST128.
//
// These are raised when a mutation succeeds at the parse/plan/build level
// but fails a policy gate: GUC headers returned by the database are
// malformed, a RAISE SQLSTATE 'PGRST' cannot be parsed, or the result
// exceeds a max-affected preference.

import { makeError, type CloudRestError } from './types';

export const mutationErrors = {
  gucHeaders(): CloudRestError {
    return makeError({
      code: 'PGRST111',
      message:
        'response.headers guc must be a JSON array composed of objects with a single key and a string value',
      httpStatus: 500,
    });
  },

  gucStatus(): CloudRestError {
    return makeError({
      code: 'PGRST112',
      message: 'response.status guc must be a valid status code',
      httpStatus: 500,
    });
  },

  pgrstParse(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST121',
      message: "Could not parse RAISE SQLSTATE 'PGRST' error",
      details: detail,
      httpStatus: 500,
    });
  },

  maxAffectedViolation(count: number): CloudRestError {
    return makeError({
      code: 'PGRST124',
      message: 'Query result exceeds max-affected preference constraint',
      details: `The query affects ${count} rows`,
      httpStatus: 400,
    });
  },

  maxAffectedScalarViolation(): CloudRestError {
    return makeError({
      code: 'PGRST128',
      message:
        'Function must return SETOF or TABLE when max-affected preference is used with handling=strict',
      httpStatus: 400,
    });
  },
};
