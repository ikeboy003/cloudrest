// Auth — credential discovery for the agent-codex-sdk.
//
// Mirrors the Codex pattern: credentials are cached locally in
// ~/.codex-agent/auth.json after running `codex-agent login`.
//
// Discovery order:
//   1. Explicit `apiKey` option passed to Codex constructor
//   2. OPENAI_API_KEY environment variable
//   3. ~/.codex-agent/auth.json (written by login flow)
//
// Treat ~/.codex-agent/auth.json like a password: it contains
// access tokens. Don't commit it, paste it into tickets, or
// share it in chat.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Paths ─────────────────────────────────────────────────────────

const CODEX_AGENT_HOME =
  process.env['CODEX_AGENT_HOME'] ?? join(homedir(), '.codex-agent');
const AUTH_FILE = join(CODEX_AGENT_HOME, 'auth.json');

// ── Types ─────────────────────────────────────────────────────────

interface AuthCredentials {
  /** OpenAI API key. */
  api_key: string;
  /** When the credentials were stored (ISO string). */
  stored_at: string;
}

// ── Read ──────────────────────────────────────────────────────────

/**
 * Discover an OpenAI API key from the local environment.
 * Returns null if no credentials are found.
 */
export function discoverApiKey(): string | null {
  // 1. Environment variable
  const envKey = process.env['OPENAI_API_KEY'];
  if (envKey) return envKey;

  // 2. ~/.codex-agent/auth.json
  try {
    const content = readFileSync(AUTH_FILE, 'utf-8');
    const creds = JSON.parse(content) as AuthCredentials;
    if (creds.api_key) return creds.api_key;
  } catch {
    // File doesn't exist or is malformed
  }

  return null;
}

/**
 * Read the full stored credentials, or null if not logged in.
 */
export function readCredentials(): AuthCredentials | null {
  try {
    const content = readFileSync(AUTH_FILE, 'utf-8');
    return JSON.parse(content) as AuthCredentials;
  } catch {
    return null;
  }
}

// ── Write ─────────────────────────────────────────────────────────

/**
 * Store credentials to ~/.codex-agent/auth.json.
 * Called by the login flow.
 */
export function storeCredentials(apiKey: string): void {
  const creds: AuthCredentials = {
    api_key: apiKey,
    stored_at: new Date().toISOString(),
  };
  mkdirSync(CODEX_AGENT_HOME, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(creds, null, 2) + '\n', {
    mode: 0o600, // Owner read/write only
  });
}

/**
 * Remove stored credentials (logout).
 */
export function clearCredentials(): void {
  try {
    const { unlinkSync } = require('node:fs') as typeof import('node:fs');
    unlinkSync(AUTH_FILE);
  } catch {
    // Already gone
  }
}

// ── Paths (exported for tooling) ──────────────────────────────────

export const AUTH_PATH = AUTH_FILE;
export const CODEX_AGENT_DIR = CODEX_AGENT_HOME;
