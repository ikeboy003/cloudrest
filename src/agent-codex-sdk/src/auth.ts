// Auth — reads ~/.codex/auth.json written by `codex login`.
//
// The SDK uses the same credentials Codex CLI stores locally.
// After running `codex login`, the tokens are cached at
// ~/.codex/auth.json. This module reads that file.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Paths ─────────────────────────────────────────────────────────

const CODEX_HOME =
  process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
const AUTH_FILE = join(CODEX_HOME, 'auth.json');

// ── Types ─────────────────────────────────────────────────────────

/** Shape written by `codex login`. */
export interface CodexAuth {
  auth_mode: 'chatgpt' | 'api';
  OPENAI_API_KEY: string | null;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh: string;
}

// ── Read ──────────────────────────────────────────────────────────

/**
 * Read ~/.codex/auth.json. Returns the full auth object
 * or null if not found (user hasn't run `codex login`).
 */
export function readAuth(): CodexAuth | null {
  try {
    const content = readFileSync(AUTH_FILE, 'utf-8');
    return JSON.parse(content) as CodexAuth;
  } catch {
    return null;
  }
}

/**
 * Get the access token from ~/.codex/auth.json.
 * This is the token Codex uses to authenticate with OpenAI.
 */
export function getAccessToken(): string | null {
  const auth = readAuth();
  return auth?.tokens?.access_token ?? null;
}

// ── Paths (exported for tooling) ──────────────────────────────────

export const AUTH_PATH = AUTH_FILE;
export const CODEX_DIR = CODEX_HOME;
