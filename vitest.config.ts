import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Path aliases mirror tsconfig.json's `paths` so `@/…` and `@tests/…`
// imports resolve the same way under tsc (typecheck) and vitest (test).
// If you add a new alias, update BOTH files.
const resolveRelative = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@/': `${resolveRelative('./src')}/`,
      '@tests/': `${resolveRelative('./tests')}/`,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: 'default',
    // `tests/setup.ts` installs `globalThis.crypto` on Node 18
    // (where `crypto` is not yet a global). See setup.ts header.
    setupFiles: ['./tests/setup.ts'],
  },
});
