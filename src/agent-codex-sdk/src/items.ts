// Item types produced during agent turns.
// Mirrors the Codex SDK item taxonomy, adapted for data agents.

export interface AgentMessageItem {
  type: 'agent_message';
  text: string;
}

export interface ReasoningItem {
  type: 'reasoning';
  summary: string;
}

export interface ToolCallItem {
  type: 'tool_call';
  status: 'in_progress' | 'completed' | 'failed';
  tool_name: string;
  tool_call_id: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface QueryExecutionItem {
  type: 'query_execution';
  status: 'in_progress' | 'completed' | 'failed';
  sql?: string;
  params?: unknown[];
  row_count?: number;
  rows?: Record<string, unknown>[];
  error?: string;
}

export interface ErrorItem {
  type: 'error';
  message: string;
}

export type ThreadItem =
  | AgentMessageItem
  | ReasoningItem
  | ToolCallItem
  | QueryExecutionItem
  | ErrorItem;
