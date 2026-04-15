// Reference resolver for batch operations.
//
// Walks the parsed AST in place and substitutes references at the
// node level. A whole-string reference (`"$0.id"` as a value)
// replaces the node with the referenced field's native type. An
// embedded reference (`"user-$0.id"`) still goes through string
// interpolation.
//
// FORMAT: `$N.field` where N is a zero-based operation index.
// Nested fields are NOT supported — `$0.user.name` would reference
// the field literally named `user.name` on the referenced body.

import { err, ok, type Result } from '@/core/result';
import { parseErrors, type CloudRestError } from '@/core/errors';

const WHOLE_REF = /^\$(\d+)\.([a-zA-Z_][a-zA-Z0-9_]*)$/;
const EMBEDDED_REF = /\$(\d+)\.([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Walk a parsed JSON value and substitute every `$N.field`
 * reference. Returns a new value; the input is never mutated.
 *
 * Forward-only: an operation can only reference earlier
 * operations (`$0` .. `$(opIndex - 1)`). The caller tells us
 * `opIndex` so we can enforce that.
 */
export function resolveReferences(
  value: unknown,
  resolved: readonly unknown[],
  opIndex: number,
): Result<unknown, CloudRestError> {
  return walk(value, resolved, opIndex);
}

function walk(
  value: unknown,
  resolved: readonly unknown[],
  opIndex: number,
): Result<unknown, CloudRestError> {
  if (typeof value === 'string') {
    return substituteString(value, resolved, opIndex);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const child of value) {
      const r = walk(child, resolved, opIndex);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return ok(out);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = walk(v, resolved, opIndex);
      if (!r.ok) return r;
      out[k] = r.value;
    }
    return ok(out);
  }
  return ok(value);
}

function substituteString(
  raw: string,
  resolved: readonly unknown[],
  opIndex: number,
): Result<unknown, CloudRestError> {
  // Whole-string reference — replace the node with the raw value,
  // preserving type (number stays number, boolean stays boolean).
  const whole = WHOLE_REF.exec(raw);
  if (whole !== null) {
    const refIdx = Number(whole[1]!);
    const field = whole[2]!;
    const err0 = enforceForwardOnly(refIdx, opIndex, raw);
    if (err0 !== null) return err(err0);
    const target = resolved[refIdx];
    if (target === undefined || target === null || typeof target !== 'object') {
      return err(
        parseErrors.invalidBody(
          `batch reference ${raw}: operation ${refIdx} did not return an object`,
        ),
      );
    }
    return ok((target as Record<string, unknown>)[field]);
  }

  // Embedded reference — string interpolation. Each match is
  // coerced via `String()`.
  let replaced = raw;
  let anyMatch = false;
  for (const m of raw.matchAll(EMBEDDED_REF)) {
    anyMatch = true;
    const refIdx = Number(m[1]!);
    const field = m[2]!;
    const err0 = enforceForwardOnly(refIdx, opIndex, m[0]);
    if (err0 !== null) return err(err0);
    const target = resolved[refIdx];
    if (target === null || typeof target !== 'object') {
      return err(
        parseErrors.invalidBody(
          `batch reference ${m[0]}: operation ${refIdx} did not return an object`,
        ),
      );
    }
    const fieldValue = (target as Record<string, unknown>)[field];
    const stringified =
      fieldValue === undefined || fieldValue === null
        ? 'null'
        : String(fieldValue);
    replaced = replaced.replace(m[0], stringified);
  }
  return ok(anyMatch ? replaced : raw);
}

function enforceForwardOnly(
  refIdx: number,
  opIndex: number,
  match: string,
): CloudRestError | null {
  if (refIdx >= opIndex) {
    return parseErrors.invalidBody(
      `batch reference ${match}: only forward references to earlier operations ($0..$${opIndex - 1}) are allowed`,
    );
  }
  return null;
}
