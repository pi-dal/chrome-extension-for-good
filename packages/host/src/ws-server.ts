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
/** Protocol-level liveness: browsers auto-pong ws pings without JS help. */
const PING_INTERVAL_MS = 30_000;

export interface BridgeStatus {
  connected: boolean;
  extVersion: string;
  tabs: TabInfo[];
}

type PendingResolve = {
  resolve: (v: Extract<ExtToHost, { type: 'snapshot' | 'action_result' | 'tab_result' }>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * WebSocket server the MV3 extension connects to (single client).
 *
 * Host -> extension requests (snapshot/action/open_tab) are correlated by
 * requestId; extension events and logs surface as EventEmitter events:
 *   'hello'   (TabInfo[] available)
 *   'event'   (ExtToHost event: nav/lms_heartbeat)
 *   'config'  (HostConfigPatch from the options page)
 *   'plugins' (SitePlugin[] from the options page)
 *   'log'     (extension log line)
 *   'status'  (connected/disconnected)
 */
export class WsBridge extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private clientAlive = true;
  private pingTimer: NodeJS.Timeout | null = null;
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
      // carries no auth — it must never be reachable from the LAN. (A token
      // handshake was considered and rejected: the CDP port this host also
      // needs (--remote-debugging-port) grants the same MAIN-world powers to
      // any local process already, so authenticating only this socket would
      // be security theatre. Harden the debug port instead if that changes.)
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
      // Requests in flight were sent on the OLD socket — no response can ever
      // arrive (the old close handler skips cleanup once client is replaced).
      // Fail them now instead of stalling every caller for the full timeout.
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('extension reconnected'));
      }
      this.pending.clear();
    }
    this.client = ws;
    this.clientAlive = true;
    this.startPing();
    this.log('info', 'extension connected');
    this.emit('status', { connected: true, extVersion: this.extVersion, tabs: this.tabs } satisfies BridgeStatus);

    ws.on('pong', () => {
      if (this.client === ws) this.clientAlive = true;
    });
    ws.on('message', (data: RawData) => this.handleRaw(data));
    ws.on('close', () => {
      if (this.client === ws) {
        this.client = null;
        // Drop stale state so waitHello()/status() can never serve tabs from a
        // previously connected extension.
        this.tabs = [];
        this.extVersion = '';
        // Fail in-flight requests immediately — the socket they were sent on
        // is gone, so no response can ever arrive; waiting out the 15s timer
        // just stalls every caller.
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error('extension disconnected'));
        }
        this.pending.clear();
        this.log('warn', 'extension disconnected');
        this.emit('status', { connected: false, extVersion: this.extVersion, tabs: this.tabs } satisfies BridgeStatus);
      }
    });
    ws.on('error', (err: Error) => this.log('error', `extension ws error: ${err.message}`));
  }

  /**
   * Half-open detection: a suspended service worker or a dead TCP path can
   * leave readyState=OPEN while nothing flows — messages would vanish until
   * TCP gives up (minutes). Ping at the protocol level (the browser answers
   * automatically); terminate a socket that misses one interval so pending
   * requests fail fast via the close handler instead of timing out.
   */
  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      const ws = this.client;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (!this.clientAlive) {
        this.log('warn', 'extension missed a ping interval — terminating half-open socket');
        ws.terminate();
        return;
      }
      this.clientAlive = false;
      ws.ping();
    }, PING_INTERVAL_MS);
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
      case 'action_result':
      case 'tab_result': {
        const entry = this.pending.get(msg.requestId);
        if (!entry) {
          this.log('warn', `response for unknown requestId ${msg.requestId}`);
          return;
        }
        clearTimeout(entry.timer);
        this.pending.delete(msg.requestId);
        if (msg.type === 'snapshot') entry.resolve(msg);
        else if (msg.type === 'action_result' && !msg.ok) entry.reject(new Error(msg.error ?? 'action failed'));
        else if (msg.type === 'tab_result' && !msg.ok) entry.reject(new Error(msg.error ?? 'tab operation failed'));
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
      case 'plugins_sync':
        // Site plugins pushed by the extension options page (full-state sync);
        // validated by the protocol parser before they reach this point.
        this.emit('plugins', msg.plugins);
        break;
      case 'log':
        this.emit('log', msg);
        break;
    }
  }

  private isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  private request(
    msg: DistributiveOmit<HostToExt, 'requestId'> & { requestId?: string },
  ): Promise<Extract<ExtToHost, { type: 'snapshot' | 'action_result' | 'tab_result' }>> {
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
      try {
        this.client!.send(JSON.stringify(payload));
      } catch (err) {
        // send() throws synchronously on a CLOSING socket — don't leave the
        // pending entry + timer to die of old age.
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Ask the extension for an element-table snapshot of a tab. */
  async snapshot(
    tabId: number,
    opts: { quizOnly?: boolean; includePageText?: boolean; includeOffscreen?: boolean } = {},
  ): Promise<{ table: ElementTable; pageText?: string }> {
    const res = await this.request({
      type: 'snapshot_request',
      tabId,
      quizOnly: opts.quizOnly ?? false,
      ...(opts.includePageText ? { includePageText: true } : {}),
      ...(opts.includeOffscreen ? { includeOffscreen: true } : {}),
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

  /**
   * Open a tab in the user's browser (swarm lane provisioning) and return its
   * chrome.tabs id — the id every snapshot/action request is keyed by.
   */
  async openTab(url: string, opts: { active?: boolean } = {}): Promise<{ tabId: number; url: string }> {
    const res = await this.request({ type: 'open_tab', url, active: opts.active ?? false });
    if (res.type !== 'tab_result') throw new Error('unexpected response kind');
    if (res.tabId < 0) throw new Error('extension returned no tab id for open_tab');
    return { tabId: res.tabId, url: res.url };
  }

  /** Close a tab this run created (idempotent from the host's point of view). */
  async closeTab(tabId: number): Promise<void> {
    const res = await this.request({ type: 'close_tab', tabId });
    if (res.type !== 'tab_result') throw new Error('unexpected response kind');
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
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
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
