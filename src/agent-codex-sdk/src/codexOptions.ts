// Top-level options for the Codex instance.

export interface CodexOptions {
  /** Base URL of the Cloudflare Agent worker (http/https/ws/wss). */
  url: string;
  /** Agent name as configured in the Durable Object binding. Default: "data-agent". */
  agentName?: string;
  /** Headers sent during the WebSocket upgrade (e.g. auth tokens). */
  headers?: Record<string, string>;
  /** Connection timeout in ms. Default: 10000. */
  connectTimeout?: number;
  /**
   * Cloudflare API token for authentication. If omitted, the SDK
   * reads the token from ~/.wrangler/config/default.toml (written
   * by `wrangler login`). Set to `false` to disable auto-discovery.
   */
  apiToken?: string | false;
}
