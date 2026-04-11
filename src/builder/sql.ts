// SqlBuilder — owns SQL text accumulation and parameter allocation.
//
// INVARIANT: `addParam` is monotonic — every call returns a fresh `$N`
// that is never reused, never rewritten, never compacted. Downstream
// code that needs to reorder or splice SQL must use fresh builders and
// combine their rendered output; it must NOT reach into an already-
// built SQL string to rewrite `$N` references. CONSTITUTION §1.1.
//
// INVARIANT: The only way user-controlled values reach SQL is through
// `addParam`. Builders do not inline user strings with `pgFmtLit`;
// `pgFmtLit` is reserved for database-catalog strings (see
// builder/identifiers.ts). CONSTITUTION §1.3.

import type { BuiltQuery } from './types';

/**
 * Accumulates SQL text and parameters while building a query.
 *
 * Usage:
 *
 *   const b = new SqlBuilder();
 *   b.write('SELECT * FROM "t" WHERE "id" = ');
 *   b.write(b.addParam(42));
 *   return b.toBuiltQuery();
 */
export class SqlBuilder {
  private readonly parts: string[] = [];
  private readonly boundParams: unknown[] = [];
  private skipGucRead = false;

  /** Append raw SQL. Caller is responsible for identifier/literal safety. */
  write(sql: string): this {
    this.parts.push(sql);
    return this;
  }

  /**
   * Allocate a fresh `$N` parameter slot bound to `value`.
   * Returns the SQL placeholder token (`$1`, `$2`, ...) the caller must
   * splice into the SQL text.
   *
   * INVARIANT: N is monotonic per builder; never reused across calls.
   */
  addParam(value: unknown): string {
    this.boundParams.push(value);
    return `$${this.boundParams.length}`;
  }

  /**
   * Add a raw value AND splice its placeholder into the SQL stream in
   * one step. Convenience for the common case.
   */
  writeParam(value: unknown): this {
    this.write(this.addParam(value));
    return this;
  }

  /**
   * Mark this query so the executor skips reading the `pgrst_source`
   * GUCs from the result. Used for prequery-only queries (stage 7).
   */
  markSkipGucRead(): this {
    this.skipGucRead = true;
    return this;
  }

  /** Current `$N` count. Useful for conditional branches. */
  get paramCount(): number {
    return this.boundParams.length;
  }

  /** Freeze and return a BuiltQuery. The builder is not reusable after this. */
  toBuiltQuery(): BuiltQuery {
    return Object.freeze({
      sql: this.parts.join(''),
      params: Object.freeze([...this.boundParams]),
      skipGucRead: this.skipGucRead || undefined,
    });
  }

  /** Peek at the current SQL text without freezing. Test-only. */
  peekSql(): string {
    return this.parts.join('');
  }
}
