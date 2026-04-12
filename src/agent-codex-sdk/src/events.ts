// Event types emitted during a thread turn.
// Mirrors the Codex SDK event taxonomy.

import type { ThreadItem } from './items.js';

export interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export interface ThreadError {
  message: string;
}

// ── Lifecycle events ─────────────────────────────────────────────

export interface ThreadStartedEvent {
  type: 'thread.started';
  thread_id: string;
}

export interface ThreadErrorEvent {
  type: 'thread.error';
  message: string;
}

// ── Turn events ──────────────────────────────────────────────────

export interface TurnStartedEvent {
  type: 'turn.started';
}

export interface TurnCompletedEvent {
  type: 'turn.completed';
  usage: Usage;
}

export interface TurnFailedEvent {
  type: 'turn.failed';
  error: ThreadError;
}

// ── Item events ──────────────────────────────────────────────────

export interface ItemStartedEvent {
  type: 'item.started';
  item: ThreadItem;
}

export interface ItemUpdatedEvent {
  type: 'item.updated';
  item: ThreadItem;
}

export interface ItemCompletedEvent {
  type: 'item.completed';
  item: ThreadItem;
}

// ── Union ────────────────────────────────────────────────────────

export type ThreadEvent =
  | ThreadStartedEvent
  | ThreadErrorEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent;
