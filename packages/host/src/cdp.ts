import { WebSocket, type RawData } from 'ws';
import type { Rect } from '@c4g/protocol';

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
      this.ws!.send(JSON.stringify({ id, method, params }));
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
    const target =
      candidates.find((t) => urlSubstring !== '' && t.url.includes(urlSubstring)) ??
      candidates.find((t) => urlSubstring === '' && !t.url.startsWith('devtools://')) ??
      candidates[0];
    const conn = await CdpConnection.connect(target.webSocketDebuggerUrl!);
    return new CdpTab(conn, target.id);
  }

  /** Runtime.evaluate with returnByValue; throws on JS exceptions. */
  async evaluate<T = unknown>(expression: string, { awaitPromise = false } = {}): Promise<T> {
    const result = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    })) as {
      result?: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    };
    if (result.exceptionDetails) {
      throw new Error('Evaluate error: ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown'));
    }
    return result.result?.value as T;
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

  /**
   * Trusted input click at the center of a viewport-space rect
   * (extension snapshots report viewport coords; CDP input expects the same).
   *
   * If the page scrolled between snapshot and click, the raw rect would land
   * on the wrong element — so scroll the point toward viewport center first
   * and adjust the coordinates by the actually-applied scroll delta, then
   * verify the element under the cursor before pressing.
   */
  async clickAt(rect: Rect): Promise<void> {
    const cx = Math.round(rect.x + rect.w / 2);
    const cy = Math.round(rect.y + rect.h / 2);
    const adjusted = await this.evaluate<{ x: number; y: number; hit: string | null }>(`(function(){
      const vh = window.innerHeight;
      const dy = ${cy} - vh / 2;
      let x = ${cx}, y = ${cy};
      if (Math.abs(dy) > 2) {
        const before = window.scrollY;
        window.scrollBy(0, dy);
        y = y - (window.scrollY - before);
      }
      const el = document.elementFromPoint(x, y);
      return { x, y, hit: el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') : null };
    })()`);
    if (!adjusted || adjusted.hit === null) {
      throw new Error(`clickAt: no element at viewport point (${cx}, ${cy})`);
    }
    const x = Math.round(adjusted.x);
    const y = Math.round(adjusted.y);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 40));
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.conn.send(method, params);
  }

  close(): void {
    this.conn.close();
  }
}
