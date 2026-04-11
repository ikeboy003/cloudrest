// Assertion helpers for Result<T, E> in tests.
//
// WHY THIS FILE EXISTS: the parser tests were shipping a silent-skip
// antipattern —
//
//     const r = parseSelect('something');
//     if (r.ok) expect(r.value).toEqual(...);
//
// — where a regression that caused `parseSelect` to start returning an
// error would SKIP the assertions entirely and the test would still
// pass. Use these helpers in every test that produces a Result.
//
//     const value = expectOk(parseSelect('something'));
//     expect(value).toEqual(...);
//
// `expectOk` throws with the actual error if the Result is an Err, so
// the failure message tells you exactly what went wrong instead of
// "expected 42 but got undefined".

import type { Result } from '../../src/core/result';

/**
 * Assert that a Result is Ok and return the value. Throws with a
 * helpful message on Err.
 */
export function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    const detail =
      result.error instanceof Error
        ? result.error.message
        : JSON.stringify(result.error);
    throw new Error(`expected Ok, got Err: ${detail}`);
  }
  return result.value;
}

/**
 * Assert that a Result is Err and return the error. Throws with the
 * unexpected success value on Ok.
 */
export function expectErr<T, E>(result: Result<T, E>): E {
  if (result.ok) {
    throw new Error(
      `expected Err, got Ok: ${JSON.stringify(result.value)}`,
    );
  }
  return result.error;
}
