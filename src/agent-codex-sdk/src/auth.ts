// Auth — credential discovery for the agent-codex-sdk.
//
// Mirrors the Codex pattern: credentials are cached locally in
// ~/.codex-agent/auth.json after running `codex-agent login`.
//
// Discovery order:
//   1. Explicit `apiToken` option passed to Codex constructor
//   2. CLOUDFLARE_API_TOKEN environment variable
//   3. ~/.codex-agent/auth.json (written by `codex-agent login`)
//   4. ~/.wrangler/config/default.toml (fallback — written by `wrangler login`)
//
// On a Worker, none of this runs — you use a DO binding instead.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Paths ─────────────────────────────────────────────────────────

const CODEX_AGENT_HOME =
  process.env['CODEX_AGENT_HOME'] ?? join(homedir(), '.codex-agent');
const AUTH_FILE = join(CODEX_AGENT_HOME, 'auth.json');

// ── Types ─────────────────────────────────────────────────────────

interface AuthCredentials {
  /** Cloudflare API token. */
  api_token: string;
  /** Cloudflare account ID (optional, speeds up routing). */
  account_id?: string;
  /** When the credentials were stored (ISO string). */
  stored_at: string;
}

// ── Read ──────────────────────────────────────────────────────────

/**
 * Discover a Cloudflare API token from the local environment.
 * Returns null if no credentials are found.
 *
 * Treat ~/.codex-agent/auth.json like a password: it contains
 * access tokens. Don't commit it, paste it into tickets, or
 * share it in chat.
 */
export function discoverToken(): string | null {
  // 1. Environment variable (CI, scripts)
  const envToken = process.env['CLOUDFLARE_API_TOKEN'];
  if (envToken) return envToken;

  // 2. ~/.codex-agent/auth.json (our native store)
  try {
    const content = readFileSync(AUTH_FILE, 'utf-8');
    const creds = JSON.parse(content) as AuthCredentials;
    if (creds.api_token) return creds.api_token;
  } catch {
    // File doesn't exist or is malformed
  }

  // 3. Fallback: ~/.wrangler/config/default.toml (wrangler login)
  try {
    const wranglerPath = join(homedir(), '.wrangler', 'config', 'default.toml');
    const content = readFileSync(wranglerPath, 'utf-8');
    const match = /oauth_token\s*=\s*"([^"]+)"/.exec(content);
    if (match?.[1]) return match[1];
  } catch {
    // Not available
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
 * Called by `codex-agent login`.
 */
export function storeCredentials(
  apiToken: string,
  accountId?: string,
): void {
  const creds: AuthCredentials = {
    api_token: apiToken,
    account_id: accountId,
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
