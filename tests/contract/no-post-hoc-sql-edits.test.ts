/// <reference types="node" />
// Stage 8 — contract test: no code path downstream of the builder
// calls `.replace()` on a `BuiltQuery.sql`.
//
// INVARIANT (CONSTITUTION §1.6, critique #2, #12, #72, #77, #78):
// once the builder emits a BuiltQuery, its SQL is immutable. The old
// code injected DISTINCT, vector, and search clauses via post-hoc
// `query.sql.replace(...)` surgery; every such rewrite is a bug
// opportunity because param allocation is only consistent when done
// through `SqlBuilder.addParam`.
//
// This test reads every file under `src/handlers/`, `src/response/`,
// `src/router/`, and `src/executor/` and asserts that none of them
// references `.sql.replace(` on a BuiltQuery-shaped value. A match
// fails the test and points at the file.
//
// RUNTIME: this contract test needs Node's `fs` / `path` / `process`
// to walk the source tree. The tsconfig intentionally does NOT
// include `@types/node` globally — the Workers runtime has no
// Node, and leaking Node globals into `src/` would let a runtime
// file accidentally `import 'node:fs'` and compile cleanly while
// crashing in production. The `/// <reference types="node" />`
// directive at the top of THIS file opts in locally without
// affecting any other file in the graph.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SCAN_DIRS = [
  'src/handlers',
  'src/response',
  'src/router',
  'src/executor',
];

// A literal `.replace(` call on `.sql` or on a variable whose name
// includes `built` or `query` is the pattern we're guarding against.
// We use a broad regex because the point is the structural rule;
// false-positive risk is low given the narrow SCAN_DIRS list.
const FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\.sql\.replace\s*\(/,
  /built(Query)?\.sql\s*=/,
  /query\.sql\s*=/,
];

function* walkTsFiles(root: string): Generator<string> {
  const here = join(process.cwd(), root);
  let names: readonly string[];
  try {
    names = readdirSync(here) as readonly string[];
  } catch {
    return; // Directory doesn't exist yet — skip.
  }
  for (const name of names) {
    const nameStr = String(name);
    const full = join(here, nameStr);
    const rel = join(root, nameStr);
    // Cheap dir-vs-file detection via a second stat call — the
    // Dirent-with-string overload is finicky under newer @types/node.
    let isDir = false;
    try {
      readdirSync(full);
      isDir = true;
    } catch {
      isDir = false;
    }
    if (isDir) {
      yield* walkTsFiles(rel);
      continue;
    }
    if (nameStr.endsWith('.ts')) {
      yield full;
    }
  }
}

describe('structural — no post-hoc SQL edits', () => {
  for (const dir of SCAN_DIRS) {
    it(`${dir}: no \`.sql.replace(...)\` surgery`, () => {
      const offenders: string[] = [];
      for (const file of walkTsFiles(dir)) {
        const content = readFileSync(file, 'utf-8');
        for (const pattern of FORBIDDEN_PATTERNS) {
          const match = pattern.exec(content);
          if (match) {
            // Ignore matches that are inside a line comment — the
            // constitution reference may legitimately appear in a
            // comment explaining why NOT to do this.
            const lineStart = content.lastIndexOf('\n', match.index) + 1;
            const lineEnd = content.indexOf('\n', match.index);
            const line = content.slice(
              lineStart,
              lineEnd === -1 ? undefined : lineEnd,
            );
            if (/^\s*\/\/|^\s*\*/.test(line)) continue;
            offenders.push(`${file}: ${line.trim()}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
