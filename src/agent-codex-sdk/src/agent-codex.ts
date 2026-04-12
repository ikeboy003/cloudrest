// Codex — main entry point for the agent-codex-sdk.
//
// Usage:
//   const codex = new Codex({ url: "http://localhost:8788" });
//   const thread = codex.startThread();
//   const result = await thread.run("What tables are in the database?");
//   console.log(result.finalResponse);
//
// Auth is automatic — reads from ~/.wrangler/config/default.toml
// (written by `wrangler login`), or CLOUDFLARE_API_TOKEN env var.

import WebSocket from 'ws';
import { Thread } from './thread.js';
import { discoverToken } from './auth.js';
import type { CodexOptions } from './codexOptions.js';
import type { ThreadOptions } from './threadOptions.js';

export class Codex {
  private _url: string;
  private _agentName: string;
  private _headers: Record<string, string>;
  private _connectTimeout: number;

  constructor(options: CodexOptions) {
    let url = options.url.replace(/\/+$/, '');
    if (url.startsWith('http://')) url = 'ws://' + url.slice(7);
    else if (url.startsWith('https://')) url = 'wss://' + url.slice(8);
    else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = 'ws://' + url;
    }
    this._url = url;
    this._agentName = options.agentName ?? 'data-agent';
    this._connectTimeout = options.connectTimeout ?? 10_000;

    // Build headers with auto-discovered auth
    const headers = { ...(options.headers ?? {}) };
    if (options.apiToken !== false && !headers['Authorization']) {
      const token =
        typeof options.apiToken === 'string'
          ? options.apiToken
          : discoverToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }
    this._headers = headers;
  }

  /**
   * Start a new conversation thread.
   * Each thread maps to a unique Durable Object instance.
   */
  startThread(options: ThreadOptions = {}): Thread {
    const name = options.name ?? generateThreadId();
    return this._createThread(name);
  }

  /**
   * Resume a previously created thread by its ID.
   * The Durable Object retains the conversation history.
   */
  resumeThread(id: string, _options: ThreadOptions = {}): Thread {
    return this._createThread(id);
  }

  private _createThread(threadId: string): Thread {
    const wsUrl = `${this._url}/agents/${this._agentName}/${threadId}`;
    const ws = new WebSocket(wsUrl, { headers: this._headers });
    return new Thread(threadId, ws, this._connectTimeout);
  }
}

function generateThreadId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'thread-';
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
