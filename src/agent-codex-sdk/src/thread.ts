// Thread — a conversation session backed by a Cloudflare Agent DO.
//
// Mirrors the Codex SDK Thread: run() buffers the full turn,
// runStreamed() yields ThreadEvents via an AsyncGenerator.
// Under the hood, communicates over WebSocket using the
// cf_agent_use_chat_request / cf_agent_use_chat_response protocol.

import type WebSocket from 'ws';
import type { ThreadEvent, Usage } from './events.js';
import type { ThreadItem } from './items.js';
import type { TurnOptions } from './threadOptions.js';

/** A single input item. */
export type UserInput =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string };

export type Input = string | UserInput[];

export interface RunResult {
  items: ThreadItem[];
  finalResponse: string;
  usage: Usage | null;
}

export interface RunStreamedResult {
  events: AsyncGenerator<ThreadEvent>;
}

let msgSeq = 0;

export class Thread {
  private _ws: WebSocket;
  private _id: string;
  /** Resolves once the WebSocket is open. */
  private _connected: Promise<void>;
  private _messageHistory: Array<{
    id: string;
    role: string;
    content: string;
  }> = [];

  get id(): string {
    return this._id;
  }

  constructor(id: string, ws: WebSocket, connectTimeout: number = 10_000) {
    this._id = id;
    this._ws = ws;

    // Wait for the WebSocket to open and receive initial state
    this._connected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection timed out after ${connectTimeout}ms`));
      }, connectTimeout);

      const onOpen = () => {
        clearTimeout(timer);
        ws.off('error', onError);
        resolve();
      };

      const onError = (err: Error) => {
        clearTimeout(timer);
        ws.off('open', onOpen);
        reject(new Error(`WebSocket connection failed: ${err.message}`));
      };

      if (ws.readyState === ws.OPEN) {
        clearTimeout(timer);
        resolve();
      } else {
        ws.once('open', onOpen);
        ws.once('error', onError);
      }
    });
  }

  /**
   * Send input and return the completed turn.
   * Consumes the full stream internally.
   */
  async run(input: Input, turnOptions: TurnOptions = {}): Promise<RunResult> {
    const { events } = await this.runStreamed(input, turnOptions);
    const items: ThreadItem[] = [];
    let finalResponse = '';
    let usage: Usage | null = null;

    for await (const event of events) {
      if (event.type === 'item.completed') {
        if (event.item.type === 'agent_message') {
          finalResponse = event.item.text;
        }
        items.push(event.item);
      } else if (event.type === 'turn.completed') {
        usage = event.usage;
      } else if (event.type === 'turn.failed') {
        throw new Error(event.error.message);
      }
    }

    return { items, finalResponse, usage };
  }

  /**
   * Send input and stream events as they are produced.
   */
  async runStreamed(
    input: Input,
    turnOptions: TurnOptions = {},
  ): Promise<RunStreamedResult> {
    return { events: this._runStreamedInternal(input, turnOptions) };
  }

  private async *_runStreamedInternal(
    input: Input,
    turnOptions: TurnOptions = {},
  ): AsyncGenerator<ThreadEvent> {
    const text = normalizeInput(input);
    const msgId = `msg-${++msgSeq}-${Date.now()}`;
    const userMsgId = `u-${msgSeq}`;

    this._messageHistory.push({ id: userMsgId, role: 'user', content: text });

    // Ensure WebSocket is connected before sending
    await this._connected;

    // Yield thread.started on first message
    if (this._messageHistory.length === 1) {
      yield { type: 'thread.started', thread_id: this._id };
    }

    yield { type: 'turn.started' };

    // Track tool calls in progress
    const pendingTools = new Map<
      string,
      { tool_name: string; args: Record<string, unknown> }
    >();
    const totalUsage: Usage = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
    };
    let agentText = '';

    // Set up message routing
    type QueueItem = { event: ThreadEvent } | { done: true } | { error: Error };
    const queue: QueueItem[] = [];
    let resolve: ((value: void) => void) | null = null;
    const signal = () => {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    };
    const waitForItem = () =>
      new Promise<void>((r) => {
        resolve = r;
      });

    const pushEvent = (event: ThreadEvent) => {
      queue.push({ event });
      signal();
    };
    const pushDone = () => {
      queue.push({ done: true });
      signal();
    };
    const pushError = (err: Error) => {
      queue.push({ error: err });
      signal();
    };

    // Timeout
    const timeout = turnOptions.timeout ?? 60_000;
    const timer = setTimeout(() => {
      pushError(new Error(`Turn timed out after ${timeout}ms`));
    }, timeout);

    if (turnOptions.signal) {
      turnOptions.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          pushError(new Error('Aborted'));
        },
        { once: true },
      );
    }

    const handler = (data: WebSocket.Data) => {
      const str = data.toString();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(str) as Record<string, unknown>;
      } catch {
        return;
      }

      if (parsed.type === 'cf_agent_state') return;
      if (
        parsed.type !== 'cf_agent_use_chat_response' ||
        parsed.id !== msgId
      )
        return;

      const body = parsed.body as string;
      if (!body) {
        if (parsed.done === true) {
          clearTimeout(timer);
          this._ws.off('message', handler);

          // Emit final agent_message if we collected text
          if (agentText) {
            const msgItem: ThreadItem = {
              type: 'agent_message',
              text: agentText,
            };
            pushEvent({ type: 'item.completed', item: msgItem });
          }

          pushEvent({ type: 'turn.completed', usage: totalUsage });
          pushDone();
        }
        return;
      }

      const prefix = body.charAt(0);
      const payload = body.slice(2).trimEnd();

      if (prefix === '0') {
        // Text chunk
        const chunk = JSON.parse(payload) as string;
        agentText += chunk;
        // Emit item.updated with partial text
        pushEvent({
          type: 'item.updated',
          item: { type: 'agent_message', text: agentText },
        });
      } else if (prefix === '9') {
        // Tool call started
        const tc = JSON.parse(payload) as {
          toolCallId: string;
          toolName: string;
          args: Record<string, unknown>;
        };
        pendingTools.set(tc.toolCallId, {
          tool_name: tc.toolName,
          args: tc.args,
        });
        const toolItem: ThreadItem = {
          type: 'tool_call',
          status: 'in_progress',
          tool_name: tc.toolName,
          tool_call_id: tc.toolCallId,
          arguments: tc.args,
        };
        pushEvent({ type: 'item.started', item: toolItem });
      } else if (prefix === 'a') {
        // Tool result
        const tr = JSON.parse(payload) as {
          toolCallId: string;
          result: unknown;
        };
        const pending = pendingTools.get(tr.toolCallId);
        pendingTools.delete(tr.toolCallId);

        const hasError =
          tr.result != null &&
          typeof tr.result === 'object' &&
          'error' in (tr.result as Record<string, unknown>);

        const toolItem: ThreadItem = {
          type: 'tool_call',
          status: hasError ? 'failed' : 'completed',
          tool_name: pending?.tool_name ?? 'unknown',
          tool_call_id: tr.toolCallId,
          arguments: pending?.args ?? {},
          result: tr.result,
          error: hasError
            ? String((tr.result as Record<string, unknown>).error)
            : undefined,
        };
        pushEvent({ type: 'item.completed', item: toolItem });

        // Also emit as query_execution if it looks like a data query
        if (
          pending?.tool_name === 'query_data' &&
          tr.result != null &&
          typeof tr.result === 'object'
        ) {
          const r = tr.result as Record<string, unknown>;
          const qItem: ThreadItem = {
            type: 'query_execution',
            status: r.error ? 'failed' : 'completed',
            row_count: (r.row_count as number) ?? undefined,
            rows: (r.rows as Record<string, unknown>[]) ?? undefined,
            error: r.error ? String(r.error) : undefined,
          };
          pushEvent({ type: 'item.completed', item: qItem });
        }
      } else if (prefix === 'e') {
        // Step finish
        const sf = JSON.parse(payload) as {
          finishReason: string;
          usage: { promptTokens?: number; completionTokens?: number };
        };
        totalUsage.input_tokens += sf.usage.promptTokens ?? 0;
        totalUsage.output_tokens += sf.usage.completionTokens ?? 0;
      } else if (prefix === 'd') {
        // Turn-level finish (aggregated usage)
        const tf = JSON.parse(payload) as {
          usage: { promptTokens?: number; completionTokens?: number };
        };
        totalUsage.input_tokens = tf.usage.promptTokens ?? totalUsage.input_tokens;
        totalUsage.output_tokens =
          tf.usage.completionTokens ?? totalUsage.output_tokens;
      } else if (prefix === '3') {
        // Error text from model
        const errorText = JSON.parse(payload) as string;
        agentText += errorText;
      }
    };

    this._ws.on('message', handler);

    // Send the request
    this._ws.send(
      JSON.stringify({
        type: 'cf_agent_use_chat_request',
        id: msgId,
        init: {
          method: 'POST',
          body: JSON.stringify({ messages: this._messageHistory }),
        },
      }),
    );

    // Yield events from the queue
    try {
      while (true) {
        if (queue.length === 0) {
          await waitForItem();
        }
        while (queue.length > 0) {
          const item = queue.shift()!;
          if ('done' in item) {
            // Store assistant response in history
            if (agentText) {
              this._messageHistory.push({
                id: `a-${msgSeq}`,
                role: 'assistant',
                content: agentText,
              });
            }
            return;
          }
          if ('error' in item) {
            this._ws.off('message', handler);
            clearTimeout(timer);
            yield {
              type: 'turn.failed',
              error: { message: item.error.message },
            };
            return;
          }
          yield item.event;
        }
      }
    } finally {
      clearTimeout(timer);
      this._ws.off('message', handler);
    }
  }
}

function normalizeInput(input: Input): string {
  if (typeof input === 'string') return input;
  return input
    .map((item) => {
      if (item.type === 'text') return item.text;
      return `[image: ${item.path}]`;
    })
    .join('\n');
}
