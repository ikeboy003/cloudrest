// Codex — main entry point for the agent-codex-sdk.
//
// On a Worker:
//   const codex = await Codex.create({ url: "...", env });
//
// Local dev:
//   const codex = await Codex.create({ url: "http://localhost:8788" });

import WebSocket from 'ws';
import { Thread } from './thread.js';
import { getAccessToken } from './auth.js';
import type { CodexOptions } from './codexOptions.js';
import type { ThreadOptions } from './threadOptions.js';

export class Codex {
  private _url: string;
  private _agentName: string;
  private _headers: Record<string, string>;
  private _connectTimeout: number;

  private constructor(
    url: string,
    agentName: string,
    headers: Record<string, string>,
    connectTimeout: number,
  ) {
    this._url = url;
    this._agentName = agentName;
    this._headers = headers;
    this._connectTimeout = connectTimeout;
  }

  /**
   * Create a Codex instance. Resolves auth from env (Worker) or disk (local dev).
   */
  static async create(options: CodexOptions): Promise<Codex> {
    let url = options.url.replace(/\/+$/, '');
    if (url.startsWith('http://')) url = 'ws://' + url.slice(7);
    else if (url.startsWith('https://')) url = 'wss://' + url.slice(8);
    else if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = 'ws://' + url;
    }

    const headers = { ...(options.headers ?? {}) };
    if (options.accessToken !== false && !headers['Authorization']) {
      const token =
        typeof options.accessToken === 'string'
          ? options.accessToken
          : await getAccessToken(options.env);
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    return new Codex(
      url,
      options.agentName ?? 'data-agent',
      headers,
      options.connectTimeout ?? 10_000,
    );
  }

  /**
   * Start a new conversation thread.
   */
  startThread(options: ThreadOptions = {}): Thread {
    const name = options.name ?? generateThreadId();
    return this._createThread(name);
  }

  /**
   * Resume a previously created thread by its ID.
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
