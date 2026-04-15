// Media type errors — PGRST106, PGRST107, PGRST116.
//
// PostgREST returns 406 for unacceptable Accept headers and for
// the singular-object coercion failure. PGRST106 ("schema not exposed")
// also lives here because the failure surfaces during content negotiation
// via Accept-Profile.

import { makeError, type CloudRestError } from './types';

export const mediaErrors = {
  unacceptableSchema(schema: string, available: readonly string[]): CloudRestError {
    return makeError({
      code: 'PGRST106',
      message: `The schema "${schema}" is not exposed`,
      details: `Available schemas: ${available.join(', ')}`,
      httpStatus: 406,
    });
  },

  mediaTypeError(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST107',
      message: 'Media type not acceptable',
      details: detail,
      httpStatus: 406,
    });
  },

  notAcceptable(accept: string): CloudRestError {
    return makeError({
      code: 'PGRST107',
      message: 'None of the requested media types are available',
      details: `Accept: ${accept}`,
      hint: 'Use application/json, text/csv, application/vnd.pgrst.object+json, or */*',
      httpStatus: 406,
    });
  },

  singularityError(count: number): CloudRestError {
    return makeError({
      code: 'PGRST116',
      message: 'Cannot coerce the result to a single JSON object',
      details: `The result contains ${count} rows`,
      httpStatus: 406,
    });
  },
};
