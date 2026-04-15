// INVARIANT: CloudRestError is a plain readonly object. No classes, no prototypes.
// This lets errors cross Worker isolate boundaries, serialize to JSON trivially,
// and survive structured cloning without surprises.
//
// The `code` field follows PostgREST's PGRSTxxx convention. Unknown
// codes are a compat hazard; always reuse an existing code or allocate a new
// one explicitly.

export type ErrorCode = string;

export interface CloudRestError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details: string | null;
  readonly hint: string | null;
  readonly httpStatus: number;
}

/**
 * Internal helper: build a frozen CloudRestError.
 * Factory modules call this; external callers use the namespaced factories.
 */
export function makeError(fields: {
  code: ErrorCode;
  message: string;
  httpStatus: number;
  details?: string | null;
  hint?: string | null;
}): CloudRestError {
  return Object.freeze({
    code: fields.code,
    message: fields.message,
    details: fields.details ?? null,
    hint: fields.hint ?? null,
    httpStatus: fields.httpStatus,
  });
}

export type ErrorVerbosity = 'verbose' | 'minimal';

/**
 * Strip details/hint when the client requested minimal verbosity.
 * Does not touch `code`, `message`, or `httpStatus`.
 */
export function applyVerbosity(
  error: CloudRestError,
  verbosity: ErrorVerbosity,
): CloudRestError {
  if (verbosity === 'verbose') return error;
  return makeError({
    code: error.code,
    message: error.message,
    httpStatus: error.httpStatus,
    details: null,
    hint: null,
  });
}
