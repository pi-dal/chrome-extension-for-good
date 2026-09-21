import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  parseExtToHost,
  type Action,
  type ElementTable,
  type ExtToHost,
  type HostToExt,
  type TabInfo,
} from '@c4g/protocol';
import type { LogFn } from './log.js';

const REQUEST_TIMEOUT_MS = 15_000;

export interface BridgeStatus {
  connected: boolean;
  extVersion: string;
  tabs: TabInfo[];
}

type PendingResolve = {
  resolve: (v: Extract<ExtToHost, { type: 'snapshot' | 'action_result' }>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * WebSocket server the MV3 extension connects to (single client).
 *
 * Host -> extension requests (snapshot/action) are correlated by requestId;
 * extension events and logs surface as EventEmitter events:
 *   'hello'  (TabInfo[] available)
 *   'event'  (ExtToHost event: nav/lms_heartbeat)
 *   'log'    (extension log line)
 *   'status' (connected/disconnected)
 */
export class WsBridge extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private readonly pending = new Map<string, PendingResolve>();
  private reqCounter = 0;

  extVersion = '';
  tabs: TabInfo[] = [];

  constructor(private readonly log: LogFn) {
    super();
  }

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Loopback only: the bridge can drive the user's logged-in browser and
      // carries no auth — it must never be reachable from the LAN.
      const wss = new WebSocketServer({ port, host: '127.0.0.1', path: '/extension' });
      wss.on('listening', () => {
        this.log('info', `ws bridge listening on ws://127.0.0.1:${port}/extension`);
        resolve();
      });
      wss.on('error', reject);
      wss.on('connection', (ws) => this.onConnection(ws));
      this.wss = wss;
    });
  }

  private onConnection(ws: WebSocket): void {
    if (this.client && this.client.readyState === WebSocket.OPEN) {
      this.log('warn', 'second extension connection; replacing previous client');
      this.client.close();
    }
    this.client = ws;
    this.log('info', 'extension connected');
    this.emit('status', { connected: true, extVersion: this.extVersion, tabs: this.tabs } satisfies BridgeStatus);

    ws.on('message', (data: RawData) => this.handleRaw(data));
    ws.on('close', () => {
      if (this.client === ws) {
        this.client = null;
        // Drop stale state so waitHello()/status() can never serve tabs from a
        // previously connected extension.
        this.tabs = [];
        this.extVersion = '';
        this.log('warn', 'extension disconnected');
        this.emit('status', { connected: false, extVersion: this.extVersion, tabs: this.tabs } satisfies BridgeStatus);
      }
    });
    ws.on('error', (err: Error) => this.log('error', `extension ws error: ${err.message}`));
  }

  private handleRaw(data: RawData): void {
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      this.log('warn', 'dropping non-JSON message from extension');
      return;
    }
    let msg: ExtToHost;
    try {
      msg = parseExtToHost(raw);
    } catch (err) {
      this.log('warn', 'dropping invalid protocol message', err instanceof Error ? err.message : String(err));
      return;
    }
    switch (msg.type) {
      case 'hello':
        this.extVersion = msg.extVersion;
        this.tabs = msg.tabs;
        this.emit('hello', msg.tabs);
        break;
      case 'snapshot':
      case 'action_result': {
        const entry = this.pending.get(msg.requestId);
        if (!entry) {
          this.log('warn', `response for unknown requestId ${msg.requestId}`);
          return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(msg.requestId);
        if (msg.type === 'snapshot') entry.resolve(msg);
        else if (msg.type === 'action_result' && !msg.ok) entry.reject(new Error(msg.error ?? 'action failed'));
        else entry.resolve(msg);
        break;
      }
      case 'event':
        this.emit('event', msg);
        break;
      case 'config_sync':
        // Endpoint config pushed by the extension options page (full-state sync).
        this.emit('config', msg.config);
        break;
      case 'log':
        this.emit('log', msg);
        break;
    }
  }

  private isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  private request(msg: DistributiveOmit<HostToExt, 'requestId'> & { requestId?: string }): Promise<Extract<ExtToHost, { type: 'snapshot' | 'action_result' }>> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error('extension not connected (is the c4g extension loaded and running?)'));
        return;
      }
      const requestId = msg.requestId ?? `r${++this.reqCounter}`;
      const payload = { ...msg, requestId } as HostToExt;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`extension request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.client!.send(JSON.stringify(payload));
    });
  }

  /** Ask the extension for an element-table snapshot of a tab. */
  async snapshot(
    tabId: number,
    opts: { quizOnly?: boolean; includePageText?: boolean } = {},
  ): Promise<{ table: ElementTable; pageText?: string }> {
    const res = await this.request({
      type: 'snapshot_request',
      tabId,
      quizOnly: opts.quizOnly ?? false,
      ...(opts.includePageText ? { includePageText: true } : {}),
    });
    if (res.type !== 'snapshot') throw new Error('unexpected response kind');
    return res.pageText !== undefined ? { table: res.table, pageText: res.pageText } : { table: res.table };
  }

  /** Execute an action in the tab; rejects on failure or timeout. */
  async act(tabId: number, action: Action): Promise<{ ok: boolean; url: string }> {
    const res = await this.request({ type: 'action_request', tabId, action });
    if (res.type !== 'action_result') throw new Error('unexpected response kind');
    return { ok: res.ok, url: res.url };
  }

  /**
   * Run a host-constant probe expression in the extension's isolated world
   * (design §3) and return the parsed `value`. The extension binds
   * `__c4gRef(i)` to the live element cached for snapshot index i.
   */
  async evalJson(tabId: number, expression: string): Promise<unknown> {
    const res = await this.request({ type: 'action_request', tabId, action: { op: 'eval', expression } });
    if (res.type !== 'action_result') throw new Error('unexpected response kind');
    if (!res.ok) throw new Error(res.error ?? 'eval failed');
    if (res.value === undefined) throw new Error('eval returned no value (extension build without eval support?)');
    return res.value;
  }

  status(): BridgeStatus {
    return { connected: this.isConnected(), extVersion: this.extVersion, tabs: this.tabs };
  }

  /** Resolves when the extension sends hello (or rejects after timeoutMs). */
  waitHello(timeoutMs = 30_000): Promise<TabInfo[]> {
    if (this.tabs.length > 0) return Promise.resolve(this.tabs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('hello', onHello);
        reject(new Error(`extension did not connect within ${timeoutMs / 1000}s (load packages/extension/dist in chrome://extensions)`));
      }, timeoutMs);
      const onHello = (tabs: TabInfo[]): void => {
        clearTimeout(timer);
        resolve(tabs);
      };
      this.once('hello', onHello);
    });
  }

  close(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('bridge closing'));
    }
    this.pending.clear();
    this.client?.close();
    this.client = null;
    this.wss?.close();
    this.wss = null;
  }
}
