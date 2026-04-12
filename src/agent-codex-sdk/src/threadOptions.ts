// Thread and turn configuration options.

/** Controls how the agent handles tool execution. */
export type ApprovalMode = 'never' | 'on-request' | 'always';

/** Options for creating a thread. */
export interface ThreadOptions {
  /** Custom thread/session name. Auto-generated if omitted. */
  name?: string;
}

/** Options for a single run() or runStreamed() call. */
export interface TurnOptions {
  /** JSON Schema to constrain the final response shape. */
  outputSchema?: Record<string, unknown>;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Max time in ms to wait for the turn. Default: 60000. */
  timeout?: number;
}
