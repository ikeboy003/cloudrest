// Auto-discover Cloudflare auth token from wrangler config.
//
// After `wrangler login`, credentials are stored at:
//   ~/.wrangler/config/default.toml
//
// The SDK reads the oauth_token from that file so users
// never need to pass an API key — same pattern as Codex
// reading ~/.codex/ after `codex login`.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Paths wrangler may store auth tokens. */
const WRANGLER_CONFIG_PATHS = [
  () => join(homedir(), '.wrangler', 'config', 'default.toml'),
  () => {
    const xdg = process.env['XDG_CONFIG_HOME'];
    return xdg
      ? join(xdg, 'wrangler', 'config', 'default.toml')
      : null;
  },
];

/**
 * Read the Cloudflare OAuth token from the local wrangler config.
 * Returns null if no token is found (user hasn't run `wrangler login`).
 */
export function discoverToken(): string | null {
  // Environment variable takes precedence (same as wrangler CLI)
  const envToken = process.env['CLOUDFLARE_API_TOKEN'];
  if (envToken) return envToken;

  for (const pathFn of WRANGLER_CONFIG_PATHS) {
    const path = pathFn();
    if (!path) continue;
    try {
      const content = readFileSync(path, 'utf-8');
      // Parse the TOML-ish format for oauth_token
      const match = /oauth_token\s*=\s*"([^"]+)"/.exec(content);
      if (match?.[1]) return match[1];
    } catch {
      // File doesn't exist or unreadable — try next path
    }
  }

  return null;
}
