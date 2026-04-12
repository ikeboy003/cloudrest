// Top-level options for the Codex instance.

export interface CodexOptions {
  /** Base URL of the agent (http/https/ws/wss). */
  url: string;
  /** Agent name in the URL path. Default: "data-agent". */
  agentName?: string;
  /** Worker env with CODEX_AUTH_JSON secret. Pass this when running on a Worker. */
  env?: { CODEX_AUTH_JSON?: string };
  /** Explicit access token. Overrides env and disk discovery. */
  accessToken?: string | false;
  /** Additional headers sent during the WebSocket upgrade. */
  headers?: Record<string, string>;
  /** Connection timeout in ms. Default: 10000. */
  connectTimeout?: number;
}
