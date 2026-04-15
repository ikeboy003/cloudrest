// Authentication and authorization errors — PGRST3xx.
//
// SECURITY: The distinction between PGRST301 (malformed/invalid token) and
// PGRST303 (expired/claim error) matters for Bearer challenge headers — see
// response/finalize.ts. PGRST302 is the "anonymous access disabled" signal.
//
// PostgREST uses these codes and status 401 across the board, with
// PGRST300 as a server misconfiguration (500) when the JWT secret is missing.

import { makeError, type CloudRestError } from './types';

export const authErrors = {
  jwtSecretMissing(): CloudRestError {
    return makeError({
      code: 'PGRST300',
      message: 'Server lacks JWT secret',
      httpStatus: 500,
    });
  },

  jwtDecodeError(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST301',
      message: detail,
      httpStatus: 401,
    });
  },

  jwtTokenRequired(): CloudRestError {
    return makeError({
      code: 'PGRST302',
      message: 'Anonymous access is disabled',
      httpStatus: 401,
    });
  },

  jwtExpired(): CloudRestError {
    return makeError({
      code: 'PGRST303',
      message: 'JWT expired',
      httpStatus: 401,
    });
  },

  jwtClaimsError(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST303',
      message: detail,
      httpStatus: 401,
    });
  },

  // SECURITY: Explicit alg=none rejection.
  algNotAllowed(alg: string): CloudRestError {
    return makeError({
      code: 'PGRST304',
      message: `JWT algorithm "${alg}" is not allowed`,
      httpStatus: 401,
    });
  },

  // SECURITY: JWKS URL scheme allowlist.
  jwksSchemeNotAllowed(scheme: string): CloudRestError {
    return makeError({
      code: 'PGRST305',
      message: `JWKS URL scheme "${scheme}" is not allowed; only https is accepted`,
      httpStatus: 500,
    });
  },
};
