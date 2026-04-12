// Auth — reads Codex credentials.
//
// On a Worker:  reads from env.CODEX_AUTH_JSON (pushed via `wrangler secret put`)
// Local dev:    reads from ~/.codex/auth.json (written by `codex login`)
//
// Deploy flow:
//   1. Run `codex login` locally
//   2. cat ~/.codex/auth.json | wrangler secret put CODEX_AUTH_JSON
//   3. wrangler deploy
//   4. Worker reads env.CODEX_AUTH_JSON at runtime

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

// ── Read from env (Worker) ────────────────────────────────────────

/**
 * Parse CODEX_AUTH_JSON from a Worker env binding.
 * This is the primary path in production.
 */
export function readAuthFromEnv(env: { CODEX_AUTH_JSON?: string }): CodexAuth | null {
  if (!env.CODEX_AUTH_JSON) return null;
  try {
    return JSON.parse(env.CODEX_AUTH_JSON) as CodexAuth;
  } catch {
    return null;
  }
}

/**
 * Get the access token from a Worker env binding.
 */
export function getAccessTokenFromEnv(env: { CODEX_AUTH_JSON?: string }): string | null {
  const auth = readAuthFromEnv(env);
  return auth?.tokens?.access_token ?? null;
}

// ── Read from disk (local dev / Node) ─────────────────────────────

/**
 * Read ~/.codex/auth.json from disk.
 * Only works in Node.js — returns null on Workers (no filesystem).
 */
export async function readAuthFromDisk(): Promise<CodexAuth | null> {
  try {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const codexHome = process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
    const content = fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf-8');
    return JSON.parse(content) as CodexAuth;
  } catch {
    return null;
  }
}

/**
 * Get the access token — tries env first, then disk.
 */
export async function getAccessToken(env?: { CODEX_AUTH_JSON?: string }): Promise<string | null> {
  if (env) {
    const token = getAccessTokenFromEnv(env);
    if (token) return token;
  }
  // Fallback to disk (local dev)
  const auth = await readAuthFromDisk();
  return auth?.tokens?.access_token ?? null;
}
