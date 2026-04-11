// INVARIANT: Result<T, E> is a discriminated union with `ok: boolean`.
// Callers must check `result.ok` before accessing `.value` or `.error`.
// This is the one and only error-handling contract at module boundaries;
// no `throw` at public boundaries, no `'code' in result` structural checks.

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };

export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/**
 * Transform the success value. Pass-through on error.
 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Transform the error value. Pass-through on success.
 */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Sequence a fallible computation. If `result` is Ok, call `fn` with its value.
 * If `fn` itself returns an Err, that Err propagates.
 */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/**
 * Return the success value, or the fallback if the result is an error.
 * Does not swallow errors silently at module boundaries; use at leaf call sites.
 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Collect an array of results into a Result of array.
 * On the first Err, returns that Err. On all Ok, returns an Ok of values.
 */
export function collect<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}
