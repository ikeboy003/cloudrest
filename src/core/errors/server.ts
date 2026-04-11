// Server and connection errors — PGRST000 family plus SQLSTATE mapping.
//
// COMPAT: PostgREST uses PGRST000/001/002/003 for connection and schema
// cache errors. Status codes match (503 for connection, 503 for schema
// cache, 504 for acquisition timeout).
//
// The SQLSTATE → HTTP mapping below is the one Postgres clients rely on;
// extend with care — adding a mapping changes the HTTP contract.

import { makeError, type CloudRestError } from './types';

export const serverErrors = {
  connectionUsage(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST000',
      message: 'Connection error',
      details: detail,
      httpStatus: 503,
    });
  },

  client(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST001',
      message: 'Database client error',
      details: detail,
      httpStatus: 503,
    });
  },

  noSchemaCache(): CloudRestError {
    return makeError({
      code: 'PGRST002',
      message:
        'Schema cache not available. The server is starting up or was unable to load the database schema.',
      httpStatus: 503,
    });
  },

  acquisitionTimeout(): CloudRestError {
    return makeError({
      code: 'PGRST003',
      message: 'Timed out acquiring connection from pool',
      httpStatus: 504,
    });
  },

  /**
   * Translate a Postgres error into a CloudRestError.
   *
   * SQLSTATE 'PGRST' is treated as a "raise with custom HTTP" sentinel;
   * callers that need the full custom-response parsing should use
   * `parseRaisePgrst` (response layer) instead of this function.
   */
  pgError(
    sqlState: string,
    message: string,
    details: string | null,
    hint: string | null = null,
  ): CloudRestError {
    return makeError({
      code: sqlState,
      message,
      details,
      hint,
      httpStatus: sqlStateToHttpStatus(sqlState),
    });
  },

  notImplemented(detail: string): CloudRestError {
    return makeError({
      code: 'PGRST501',
      message: 'Not implemented',
      details: detail,
      httpStatus: 501,
    });
  },
};

/**
 * SQLSTATE → HTTP status mapping.
 *
 * COMPAT: These codes follow PostgREST's mapping as closely as possible.
 * Class prefixes (23, 42, 08, 57, P0) are fallbacks for unlisted codes.
 */
export function sqlStateToHttpStatus(state: string): number {
  switch (state) {
    case '23505':
      return 409; // unique_violation
    case '23503':
      return 409; // foreign_key_violation
    case '23502':
      return 400; // not_null_violation
    case '23514':
      return 400; // check_violation
    case '42501':
      return 403; // insufficient_privilege
    case '42P01':
      return 404; // undefined_table
    case '42883':
      return 404; // undefined_function
    case '42703':
      return 400; // undefined_column
    case '25006':
      return 405; // read_only_sql_transaction
    case '25P02':
      return 500; // in_failed_sql_transaction
    case '08000':
      return 503; // connection_exception
    case '08003':
      return 503; // connection_does_not_exist
    case '08006':
      return 503; // connection_failure
    case '57014':
      return 504; // query_canceled (statement_timeout)
    case 'P0001':
      return 400; // raise_exception
    default:
      if (state.startsWith('42')) return 400;
      if (state.startsWith('23')) return 409;
      if (state.startsWith('08') || state.startsWith('57')) return 503;
      if (state.startsWith('P0')) return 400;
      return 500;
  }
}
