// Top-level options for the Codex instance.

export interface CodexOptions {
  /** Base URL of the agent (http/https/ws/wss). */
  url: string;
  /** Agent name in the URL path. Default: "data-agent". */
  agentName?: string;
  /** OpenAI API key. If omitted, discovered from OPENAI_API_KEY env
   *  or ~/.codex-agent/auth.json. Set to `false` to skip discovery. */
  apiKey?: string | false;
  /** Additional headers sent during the WebSocket upgrade. */
  headers?: Record<string, string>;
  /** Connection timeout in ms. Default: 10000. */
  connectTimeout?: number;
}
