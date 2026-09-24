import { WebSocket, type RawData } from 'ws';

/**
 * Minimal CDP client for one page target.
 *
 * Patterns (request-id correlation, event wait) follow opencli's
 * src/browser/cdp.ts; this is a fresh ~250-line implementation scoped to what
 * the c4g host needs: evaluate, navigate, trusted input clicks.
 */

export const CDP_SEND_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

export interface CdpTargetInfo {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl?: string;
}

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function debugPortHint(port: number): string {
  return (
    `Chrome DevTools port ${port} is not reachable. ` +
    `Start Chrome with remote debugging, e.g.:\n` +
    `  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=${port}`
  );
}

/** GET http://127.0.0.1:<port>/json and return page-ish targets. */
export async function listTargets(port: number): Promise<CdpTargetInfo[]> {
  let res: Response;
  try {
    // Never let a hung DevTools endpoint stall host startup.
    res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new Error(debugPortHint(port));
  }
  if (!res.ok) throw new Error(debugPortHint(port) + ` (HTTP ${res.status})`);
  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) throw new Error('Unexpected /json payload (not an array)');
  return raw
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map((t) => ({
      id: String(t.id ?? ''),
      type: String(t.type ?? ''),
      url: String(t.url ?? ''),
      title: String(t.title ?? ''),
      webSocketDebuggerUrl: typeof t.webSocketDebuggerUrl === 'string' ? t.webSocketDebuggerUrl : undefined,
    }));
}

export class CdpConnection {
  private ws: WebSocket | null = null;
  private idCounter = 0;
  private readonly pending = new Map<number, PendingEntry>();
  private readonly listeners = new Map<string, Set<(params: unknown) => void>>();

  private constructor() {}

  /** Attach to a target's debugger websocket. */
  static connect(webSocketDebuggerUrl: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const conn = new CdpConnection();
      const ws = new WebSocket(webSocketDebuggerUrl);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`CDP websocket connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s`));
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(timer);
        conn.ws = ws;
        // Frame flakiness guard: re-send as JS evaluation, not protocol state.
        conn.send('Runtime.enable').catch(() => {});
        resolve(conn);
      });
      ws.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on('close', () => {
        for (const entry of conn.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error('CDP connection closed'));
        }
        conn.pending.clear();
      });
      ws.on('message', (data: RawData) => {
        conn.handleMessage(data);
      });
    });
  }

  private handleMessage(data: RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id)!;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = msg.error as { message?: string };
        entry.reject(new Error(`CDP error: ${err.message ?? JSON.stringify(msg.error)}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === 'string') {
      const set = this.listeners.get(msg.method);
      if (set) for (const fn of set) fn(msg.params);
    }
  }

  on(method: string, handler: (params: unknown) => void): void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);
  }

  waitForEvent(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(method, handler);
        reject(new Error(`Timed out waiting for CDP event '${method}'`));
      }, timeoutMs);
      const handler = (params: unknown): void => {
        clearTimeout(timer);
        this.off(method, handler);
        resolve(params);
      };
      this.on(method, handler);
    });
  }

  private off(method: string, handler: (params: unknown) => void): void {
    this.listeners.get(method)?.delete(handler);
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = CDP_SEND_TIMEOUT_MS): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('CDP connection is not open');
    }
    const id = ++this.idCounter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command '${method}' timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}

export class CdpTab {
  private constructor(
    private readonly conn: CdpConnection,
    readonly targetId: string,
  ) {}

  /** Connect to the first page target whose URL contains urlSubstring. */
  static async connect(port: number, urlSubstring = ''): Promise<CdpTab> {
    const targets = await listTargets(port);
    const candidates = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (candidates.length === 0) throw new Error(debugPortHint(port) + ' (no page targets)');
    let target: CdpTargetInfo | undefined;
    if (urlSubstring !== '') {
      // An explicit selector that matches nothing must fail loudly — falling
      // back to an arbitrary page would drive the WRONG tab (clicks, typing,
      // navigations on a page the operator never chose).
      target = candidates.find((t) => t.url.includes(urlSubstring));
      if (!target) {
        throw new Error(
          `no CDP page target matched "${urlSubstring}" — refusing an arbitrary tab. ` +
            `Open pages: ${candidates.map((t) => t.url.slice(0, 60)).join(' | ') || '(none)'}`,
        );
      }
    } else {
      target = candidates.find((t) => !t.url.startsWith('devtools://')) ?? candidates[0];
    }
    const conn = await CdpConnection.connect(target.webSocketDebuggerUrl!);
    return new CdpTab(conn, target.id);
  }

  /** Internal factory for module-level helpers that already hold a connection. */
  static fromConnection(conn: CdpConnection, targetId: string): CdpTab {
    return new CdpTab(conn, targetId);
  }

  /** Runtime.evaluate with returnByValue; throws on JS exceptions. */
  async evaluate<T = unknown>(
    expression: string,
    { awaitPromise = false, userGesture = false } = {},
  ): Promise<T> {
    const result = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (result.exceptionDetails) {
      throw new Error('Evaluate error: ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown'));
    }
    return result.result?.value as T;
  }

  /**
   * Register a script that runs in the MAIN world of every future document of
   * this target (swarm lane keep-alive). Returns the CDP script identifier.
   */
  async addInitScript(source: string): Promise<string> {
    await this.send('Page.enable');
    const res = (await this.send('Page.addScriptToEvaluateOnNewDocument', { source })) as {
      identifier?: string;
    };
    return res.identifier ?? '';
  }

  /** Pretend this page is focused (players gate playback on focus/blur). */
  async setFocusEmulation(enabled: boolean): Promise<void> {
    await this.send('Emulation.setFocusEmulationEnabled', { enabled });
  }

  /** Pin the page lifecycle to 'active' so Chrome never freezes a lane tab. */
  async setLifecycleState(state: 'active' | 'frozen'): Promise<void> {
    await this.send('Page.enable');
    await this.send('Page.setWebLifecycleState', { state });
  }

  /**
   * Background-tab survival kit for a swarm lane: run `source` (the lane
   * keep-alive script, owned by swarm.ts) in the MAIN world of every future
   * document, emulate focus, and pin the lifecycle to 'active'.
   */
  async armKeepAlive(source: string): Promise<void> {
    await this.addInitScript(source);
    await this.setFocusEmulation(true);
    await this.setLifecycleState('active');
  }

  /** Page.navigate + wait for loadEventFired (soft cap; some pages never fire load). */
  async navigate(url: string, timeoutMs = 20_000): Promise<void> {
    await this.send('Page.enable');
    const load = this.conn.waitForEvent('Page.loadEventFired', timeoutMs).catch(() => {});
    await this.send('Page.navigate', { url });
    await load;
  }

  async url(): Promise<string> {
    return this.evaluate<string>('location.href');
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.conn.send(method, params);
  }

  close(): void {
    this.conn.close();
  }
}

export interface ConnectToMarkerOptions {
  /** Total budget for the target to appear (tab creation + first navigation). */
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Attach to the page target whose URL contains `marker`, retrying until the
 * deadline. Swarm lanes park new tabs on a URL carrying a per-run marker so a
 * freshly created extension tab can be matched to its CDP target without
 * guessing (urls of two lanes are never identical).
 */
export async function connectToMarker(
  port: number,
  marker: string,
  { timeoutMs = 15_000, intervalMs = 250 }: ConnectToMarkerOptions = {},
): Promise<CdpTab> {
  const deadline = Date.now() + timeoutMs;
  let seen: string[] = [];
  for (;;) {
    const targets = await listTargets(port);
    const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const match = pages.find((t) => t.url.includes(marker));
    if (match) {
      const conn = await CdpConnection.connect(match.webSocketDebuggerUrl!);
      return CdpTab.fromConnection(conn, match.id);
    }
    seen = pages.map((t) => t.url.slice(0, 60));
    if (Date.now() >= deadline) {
      throw new Error(
        `no CDP page target matched lane marker "${marker}" within ${timeoutMs / 1000}s — saw: ${seen.join(' | ') || '(none)'}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Page-target ids right now — the "before" set for new-target detection. */
export async function listPageTargetIds(port: number): Promise<string[]> {
  const targets = await listTargets(port);
  return targets.filter((t) => t.type === 'page').map((t) => t.id);
}

/**
 * The page target that appeared after `beforeIds` was captured. Pure so the
 * matching rule is testable; `connectToNewPage` does the IO around it.
 */
export function pickNewTarget(targets: CdpTargetInfo[], beforeIds: readonly string[]): CdpTargetInfo | null {
  const known = new Set(beforeIds);
  return targets.find((t) => t.type === 'page' && !!t.webSocketDebuggerUrl && !known.has(t.id)) ?? null;
}

/**
 * Fallback lane attach for a tab whose park URL no longer carries the marker
 * (redirect to a login or consent page). The tab is still the one new page
 * target that appeared since the tab was opened.
 */
export async function connectToNewPage(
  port: number,
  beforeIds: readonly string[],
  { timeoutMs = 10_000, intervalMs = 250 }: ConnectToMarkerOptions = {},
): Promise<CdpTab> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const targets = await listTargets(port);
    const fresh = pickNewTarget(targets, beforeIds);
    if (fresh) {
      const conn = await CdpConnection.connect(fresh.webSocketDebuggerUrl!);
      return CdpTab.fromConnection(conn, fresh.id);
    }
    if (Date.now() >= deadline) {
      throw new Error(`no new CDP page target appeared within ${timeoutMs / 1000}s (tab was never created?)`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
