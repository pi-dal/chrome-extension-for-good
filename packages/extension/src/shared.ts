/**
 * Shared helpers for the c4g extension (background service worker + content script).
 * Popup/options pages are plain JS and duplicate the two trivial storage reads.
 */

export const DEFAULT_HOST_PORT = 8765;
export const WS_PATH = '/extension';

export const STORAGE = {
  hostPort: 'hostPort',
  wsStatus: 'wsStatus',
  solverBaseUrl: 'solverBaseUrl',
  solverApiKey: 'solverApiKey',
  solverModel: 'solverModel',
  typesafeBaseUrl: 'typesafeBaseUrl',
  typesafeApiKey: 'typesafeApiKey',
  typesafeModel: 'typesafeModel',
} as const;

/** Extension-configurable endpoint fields pushed to the host via config_sync. */
export const CONFIG_KEYS = [
  STORAGE.solverBaseUrl,
  STORAGE.solverApiKey,
  STORAGE.solverModel,
  STORAGE.typesafeBaseUrl,
  STORAGE.typesafeApiKey,
  STORAGE.typesafeModel,
] as const;

export type WsStatus = 'connected' | 'connecting' | 'disconnected';

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

export function wsUrlFor(port: number): string {
  return `ws://127.0.0.1:${port}${WS_PATH}`;
}

/** chrome.storage.local.get promisified (callback form for typing stability). */
export function storageGet(keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (items) => resolve(items as Record<string, unknown>));
  });
}

export function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => resolve());
  });
}

export async function getHostPort(): Promise<number> {
  const items = await storageGet([STORAGE.hostPort]);
  const p = items[STORAGE.hostPort];
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : DEFAULT_HOST_PORT;
}

/** Read the endpoint config as a full-state patch ('' when unset in the UI). */
export async function getConfigPatch(): Promise<Record<string, string>> {
  const items = await storageGet([...CONFIG_KEYS]);
  const patch: Record<string, string> = {};
  for (const k of CONFIG_KEYS) {
    patch[k] = typeof items[k] === 'string' ? (items[k] as string) : '';
  }
  return patch;
}
