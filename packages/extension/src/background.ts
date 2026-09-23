/**
 * c4g background service worker.
 *
 * Owns the WebSocket bridge to the host process (ws://127.0.0.1:<hostPort>/extension):
 * reconnect with exponential backoff, 20s ping keepalive (resets the MV3 SW idle
 * timer), hello with the live tab list, and routing of snapshot/action requests to
 * content scripts. Also observes LMS heartbeat requests (webRequest) and page
 * navigations and relays them as events.
 *
 * MV3 rules: all chrome.* listeners are registered at the top level; no state is
 * relied upon across SW restarts except chrome.storage.
 */

import { parseExtToHost, parseHostToExt, parseSitePlugins } from '@c4g/protocol';
import type { ExtToHost, HostToExt, TabInfo } from '@c4g/protocol';
import {
  CONFIG_KEYS,
  STORAGE,
  getConfigPatch,
  getHostPort,
  getPluginsJson,
  storageSet,
  truncate,
  wsUrlFor,
} from './shared.js';

const MAX_BACKOFF_MS = 30_000;
const PING_INTERVAL_MS = 20_000;
// Must stay strictly smaller than the host's REQUEST_TIMEOUT_MS (15s),
// otherwise the host times out first and this fallback envelope is dropped
// as an unknown requestId.
const TAB_TIMEOUT_MS = 14_000;
const NAV_RATE_LIMIT_MS = 1_000;
const RECONNECT_ALARM = 'c4g-reconnect';

let ws: WebSocket | null = null;
let backoffMs = 1_000;
let reconnectTimer: number | undefined;
let pingTimer: number | undefined;

// ---------------------------------------------------------------------------
// storage / status
// ---------------------------------------------------------------------------

async function setStatus(status: 'connected' | 'connecting' | 'disconnected'): Promise<void> {
  await storageSet({ [STORAGE.wsStatus]: status });
}

// ---------------------------------------------------------------------------
// ws send / hello
// ---------------------------------------------------------------------------

function sendRaw(msg: ExtToHost): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function listTabs(): Promise<TabInfo[]> {
  return new Promise((resolve) => {
    chrome.tabs.query({}, (tabs) => {
      resolve(tabs.map((t) => ({ id: t.id ?? -1, url: t.url ?? '', title: t.title ?? '' })));
    });
  });
}

async function sendHello(reason: string): Promise<void> {
  const tabs = await listTabs();
  const sent = sendRaw({ type: 'hello', extVersion: chrome.runtime.getManifest().version, tabs });
  if (sent) console.debug(`[c4g-bg] hello sent (${reason}), ${tabs.length} tabs`);
}

/** Push the options-page endpoint config to the host (full-state sync). */
async function sendConfigSync(reason: string): Promise<void> {
  const config = await getConfigPatch();
  const sent = sendRaw({ type: 'config_sync', config });
  if (sent) console.debug(`[c4g-bg] config_sync sent (${reason})`);
}

/**
 * Push the site-plugin list to the host (full-state sync). Validated with the
 * protocol parser first: an invalid list is reported and simply not pushed, so
 * the host keeps its previous plugins instead of losing platform support.
 */
async function sendPluginsSync(reason: string): Promise<void> {
  const text = (await getPluginsJson()).trim();
  let plugins;
  try {
    // An empty box means "built-ins only": push [] so the host resets, rather
    // than silently keeping a plugin list the operator just cleared.
    plugins = text === '' ? [] : parseSitePlugins(JSON.parse(text));
  } catch (err) {
    sendRaw({
      type: 'log',
      level: 'warn',
      msg: 'site plugins from options page are invalid — not pushed',
      data: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const sent = sendRaw({ type: 'plugins_sync', plugins });
  if (sent) console.debug(`[c4g-bg] plugins_sync sent (${reason}), ${plugins.length} plugin(s)`);
}

// ---------------------------------------------------------------------------
// connect / reconnect / keepalive
// ---------------------------------------------------------------------------

function startPing(): void {
  stopPing();
  pingTimer = setInterval(() => {
    sendRaw({ type: 'log', level: 'debug', msg: 'ping' });
  }, PING_INTERVAL_MS);
}

function stopPing(): void {
  if (pingTimer !== undefined) {
    clearInterval(pingTimer);
    pingTimer = undefined;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

async function connect(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const port = await getHostPort();
  void setStatus('connecting');
  try {
    ws = new WebSocket(wsUrlFor(port));
  } catch (err) {
    console.warn('[c4g-bg] websocket construct failed:', err);
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    backoffMs = 1_000;
    void setStatus('connected');
    startPing();
    void sendHello('ws-open');
    void sendConfigSync('ws-open');
    void sendPluginsSync('ws-open');
  };
  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === 'string') void handleHostText(ev.data);
  };
  ws.onclose = () => {
    stopPing();
    ws = null;
    void setStatus('disconnected');
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose always follows an error; reconnect is scheduled there.
  };
}

// ---------------------------------------------------------------------------
// host message routing
// ---------------------------------------------------------------------------

function asEnvelope(resp: unknown): ExtToHost | null {
  try {
    return parseExtToHost(resp);
  } catch {
    return null;
  }
}

/**
 * Swarm lane lifecycle. `open_tab` is how the host gets a chrome.tabs id for a
 * lane it just created (CDP alone could not map a target back to that id);
 * `close_tab` tears the lane down again. Backgrounded by default so the user's
 * current tab keeps focus — the host arms per-lane keep-alive separately.
 */
function handleTabOp(msg: Extract<HostToExt, { type: 'open_tab' | 'close_tab' }>): Promise<ExtToHost> {
  return new Promise((resolve) => {
    const fail = (error: string, tabId = -1, url = ''): void =>
      resolve({ type: 'tab_result', requestId: msg.requestId, ok: false, tabId, url, error });
    try {
      if (msg.type === 'open_tab') {
        chrome.tabs.create({ url: msg.url, active: msg.active ?? false }, (tab) => {
          const err = chrome.runtime.lastError;
          if (err) fail(err.message ?? 'tabs.create failed');
          else if (!tab || tab.id === undefined) fail('tabs.create returned no tab id');
          else {
            resolve({
              type: 'tab_result',
              requestId: msg.requestId,
              ok: true,
              tabId: tab.id,
              url: tab.url ?? msg.url,
            });
          }
        });
      } else {
        chrome.tabs.remove(msg.tabId, () => {
          const err = chrome.runtime.lastError;
          // Closing an already-gone tab is a success for the host's purposes.
          if (err) fail(err.message ?? 'tabs.remove failed', msg.tabId);
          else resolve({ type: 'tab_result', requestId: msg.requestId, ok: true, tabId: msg.tabId, url: '' });
        });
      }
    } catch (err) {
      fail(String(err));
    }
  });
}

function routeToTab(
  tabId: number,
  msg: HostToExt,
): Promise<{ resp: unknown; detail?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ resp: null, detail: `content-script timeout (${TAB_TIMEOUT_MS / 1000}s)` }),
      TAB_TIMEOUT_MS,
    );
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp: unknown) => {
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) resolve({ resp: null, detail: err.message ?? 'sendMessage failed' });
        else resolve({ resp });
      });
    } catch (err) {
      clearTimeout(timer);
      resolve({ resp: null, detail: `sendMessage threw: ${String(err)}` });
    }
  });
}

async function handleHostText(text: string): Promise<void> {
  let msg: HostToExt;
  try {
    msg = parseHostToExt(JSON.parse(text));
  } catch (err) {
    sendRaw({ type: 'log', level: 'warn', msg: 'invalid host message', data: String(err) });
    return;
  }

  // Tab lifecycle requests are answered by the service worker itself — they are
  // not addressed to a content script, so they must not go through routeToTab.
  if (msg.type === 'open_tab' || msg.type === 'close_tab') {
    sendRaw(await handleTabOp(msg));
    return;
  }

  const { resp, detail } = await routeToTab(msg.tabId, msg);
  const env = asEnvelope(resp);

  if (msg.type === 'snapshot_request') {
    if (env && env.type === 'snapshot') {
      sendRaw(env);
    } else {
      // Protocol has no error envelope for snapshots; the host's request
      // correlation will time out — surface the reason via log.
      sendRaw({
        type: 'log',
        level: 'warn',
        msg: 'snapshot failed',
        data: { requestId: msg.requestId, reason: detail ?? 'malformed response' },
      });
    }
  } else {
    if (env && env.type === 'action_result') {
      sendRaw(env);
    } else {
      sendRaw({
        type: 'action_result',
        requestId: msg.requestId,
        ok: false,
        error: detail ?? 'malformed response from content script',
        url: '',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// top-level event wiring (MV3: must be registered synchronously)
// ---------------------------------------------------------------------------

// LMS heartbeat observer (Moodle-based LMS heartbeat AJAX posts land here).
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!details.url.includes('/lib/ajax/service.php')) return;
    // Real tabId (may be -1 when the request is not tab-associated).
    sendRaw({
      type: 'event',
      kind: 'lms_heartbeat',
      tabId: details.tabId,
      detail: truncate(details.url, 300),
      ts: Date.now(),
    });
  },
  { urls: ['<all_urls>'] },
);

const lastNavAt = new Map<number, number>();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const now = Date.now();
  if (now - (lastNavAt.get(tabId) ?? 0) < NAV_RATE_LIMIT_MS) return;
  lastNavAt.set(tabId, now);
  sendRaw({
    type: 'event',
    kind: 'nav',
    tabId,
    detail: truncate(tab.url ?? '', 300),
    ts: now,
  });
  void sendHello('tabs-changed');
});

chrome.tabs.onCreated.addListener(() => {
  void sendHello('tab-created');
});

chrome.tabs.onRemoved.addListener(() => {
  void sendHello('tab-removed');
});

// Reconnect when the configured host port changes; push endpoint config
// changes to the host immediately.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE.hostPort]) {
    if (ws) ws.close(); // onclose schedules the reconnect, which reads the new port.
    else void connect();
    return;
  }
  if (CONFIG_KEYS.some((k) => changes[k])) void sendConfigSync('storage-changed');
  if (changes[STORAGE.pluginsJson]) void sendPluginsSync('storage-changed');
});

// Safety net: if the SW was suspended while the host is down (no ping keeping it
// alive), the alarm wakes it periodically so it can reconnect.
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void connect();
});

void connect();
