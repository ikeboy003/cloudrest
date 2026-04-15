// Parse errors — PGRST1xx family.
//
// These are raised when the incoming request fails the parse or validate
// lifecycle step: bad query params, unknown operators, unsupported media,
// invalid ranges, malformed payloads.
//
// PostgREST uses PGRST100 for unknown query params, PGRST102 for
// invalid body, PGRST103 for unsatisfiable range, PGRST105 for filter
// constraint, PGRST107 for media type, PGRST108 for embeds, PGRST122 for
// strict preference violations, PGRST125 for invalid resource paths.

import { makeError, type CloudRestError } from './types';

export const parseErrors = {
  queryParam(param: string, detail: string): CloudRestError {
    return makeError({
      code: 'PGRST100',
      message: `"${param}" parse error: ${detail}`,
      details: detail,
      httpStatus: 400,
    });
  },

  invalidRpcMethod(method: string): CloudRestError {
    return makeError({
      code: 'PGRST101',
      message: `Cannot use the ${method} method on RPC`,
      httpStatus: 405,
    });
  },

  invalidBody(message: string): CloudRestError {
    return makeError({
      code: 'PGRST102',
      message,
      httpStatus: 400,
    });
  },

  invalidRange(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST103',
      message: 'Requested range not satisfiable',
      details: detail,
      httpStatus: 416,
    });
  },

  invalidFilters(): CloudRestError {
    return makeError({
      code: 'PGRST105',
      message:
        "Filters must include all and only primary key columns with 'eq' operators",
      httpStatus: 405,
    });
  },

  notEmbedded(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST108',
      message: 'An embedding is not possible',
      details: detail,
      httpStatus: 400,
    });
  },

  putLimitNotAllowed(): CloudRestError {
    return makeError({
      code: 'PGRST114',
      message: 'limit/offset querystring parameters are not allowed for PUT',
      httpStatus: 400,
    });
  },

  putMatchingPk(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST115',
      message: 'PUT payload must include all primary key columns',
      details: detail,
      httpStatus: 400,
    });
  },

  unsupportedMethod(method: string): CloudRestError {
    return makeError({
      code: 'PGRST117',
      message: `Cannot use ${method} with the requested resource`,
      httpStatus: 405,
    });
  },

  relatedOrderNotToOne(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST118',
      message: 'A related order on a to-many relationship is not allowed',
      details: detail,
      httpStatus: 400,
    });
  },

  unacceptableFilter(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST120',
      message: 'Unacceptable filter',
      details: detail,
      httpStatus: 400,
    });
  },

  invalidPreferences(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST122',
      message: 'Invalid preferences given with handling=strict',
      details: `Invalid preferences: ${detail}`,
      httpStatus: 400,
    });
  },

  aggregatesNotAllowed(): CloudRestError {
    return makeError({
      code: 'PGRST123',
      message: 'Use of aggregate functions is not allowed',
      httpStatus: 400,
    });
  },

  invalidResourcePath(): CloudRestError {
    return makeError({
      code: 'PGRST125',
      message: 'Invalid resource path',
      httpStatus: 404,
    });
  },

  notImplemented(detail: string): CloudRestError {
    // A request that uses syntax the server doesn't yet implement is not
    // malformed — it's a server capability gap. RFC 9110 §15.6.2 maps
    // this case to 501, not 400.
    return makeError({
      code: 'PGRST127',
      message: 'Not implemented',
      details: detail,
      httpStatus: 501,
    });
  },
};
