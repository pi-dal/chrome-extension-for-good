/** Structural subset of CdpTab the platform readers need (fake-able in tests). */
export interface EvalCapable {
  evaluate<T = unknown>(expression: string): Promise<T>;
  navigate(url: string): Promise<void>;
  url(): Promise<string>;
}

/**
 * Moodle-based LMS video adapter (custom video module + TCPlayer-style player).
 *
 * Platform conventions this adapter reads (read-only):
 * - Video pages live under /mod/<video-module>/view.php; courses under /course/view.php.
 * - The page exposes a global `playerdata` object (siteUrl, sesskey, resource id, user id).
 * - Watch-time heartbeats are periodic AJAX posts to /lib/ajax/service.php with a
 *   module-specific method name (see HEARTBEAT_URL_FRAGMENT).
 *
 * DESIGN CONSTRAINTS (docs/m2-auto-inspect.md, review-enforced):
 *   1. NEVER forge or replay heartbeat requests — several LMS platforms validate
 *      credited time server-side against the real wall-clock delta, so forged
 *      values are discarded (and submitting them can flag the account).
 *   2. NEVER accelerate playback (playbackRate, timer acceleration, seeking).
 *   3. NEVER run multiple videos concurrently.
 * This module only READS player/heartbeat state and reports it upstream.
 */

export function isVideoPage(url: string): boolean {
  return url.includes('/mod/fsresource/view.php');
}

export function isCoursePage(url: string): boolean {
  return url.includes('/course/view.php');
}

/** Page-global playerdata convention → { siteUrl, sesskey, resource id, user id }. */
export interface LmsPlayerData {
  siteUrl?: string;
  sesskey?: string;
  fsresourceid?: number | string;
  userId?: number | string;
}

export interface HeartbeatRecord {
  ts: number;
  requestBody: string;
  responseText: string;
}

export interface PlayerState {
  playing: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  heartbeatTs: number;
  /** Server-credited accumulated seconds from the last heartbeat response. */
  totaltime: number | null;
  /** Server-acked progress percent from the last heartbeat response. */
  progress: number | null;
  url: string;
}

/** Idempotently wraps XHR + fetch to RECORD (never modify) the last heartbeat. */
const HEARTBEAT_HOOK_JS = `
(() => {
  const w = window;
  if (w.__c4gHookInstalled) return true;
  w.__c4gHookInstalled = true;
  w.__c4gLastHeartbeat = null;
  var MATCH = 'mod_fsresource_set_time';
  var record = function (url, requestBody, responseText) {
    try {
      if (typeof url === 'string' && url.indexOf('service.php') !== -1 &&
          requestBody && String(requestBody).indexOf(MATCH) !== -1) {
        w.__c4gLastHeartbeat = {
          ts: Date.now(),
          requestBody: String(requestBody).slice(0, 1000),
          responseText: String(responseText || '').slice(0, 500)
        };
      }
    } catch (e) {}
  };
  var XHR = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
  if (XHR && !XHR.__c4gPatched) {
    XHR.__c4gPatched = true;
    var origOpen = XHR.open, origSend = XHR.send;
    XHR.open = function (method, url) { this.__c4gUrl = url; return origOpen.apply(this, arguments); };
    XHR.send = function (body) {
      var xhr = this;
      xhr.addEventListener('load', function () { record(xhr.__c4gUrl, body, xhr.responseText); });
      return origSend.apply(this, arguments);
    };
  }
  if (w.fetch && !w.fetch.__c4gPatched) {
    var origFetch = w.fetch;
    var patched = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var body = init && init.body;
      return origFetch.apply(this, arguments).then(function (resp) {
        try { resp.clone().text().then(function (t) { record(url, body, t); }); } catch (e) {}
        return resp;
      });
    };
    patched.__c4gPatched = true;
    w.fetch = patched;
  }
  return true;
})()`;

const PLAYER_STATE_JS = `
(() => {
  var v = document.querySelector('video');
  var hb = window.__c4gLastHeartbeat || null;
  var totaltime = null, progress = null;
  if (hb) {
    var m1 = /"totaltime"\\s*:\\s*"?([\\d.]+)/i.exec(hb.responseText);
    if (m1) totaltime = parseFloat(m1[1]);
    var m2 = /"progress"\\s*:\\s*"?([\\d.]+)/i.exec(hb.responseText);
    if (m2) progress = parseFloat(m2[1]);
  }
  return {
    playing: !!v && !v.paused && !v.ended,
    currentTime: v ? v.currentTime : 0,
    duration: v ? v.duration : 0,
    rate: v ? v.playbackRate : 1,
    heartbeatTs: hb ? hb.ts : 0,
    totaltime: totaltime,
    progress: progress,
    url: location.href
  };
})()`;

const SCRAPE_IDS_JS = `
(() => {
  var seen = new Set(); var out = [];
  var re = /mod\\/fsresource\\/view\\.php\\?id=(\\d+)/g;
  var html = document.documentElement.innerHTML; var m;
  while ((m = re.exec(html)) !== null) {
    if (!seen.has(m[1])) { seen.add(m[1]); out.push(Number(m[1])); }
  }
  return JSON.stringify(out);
})()`;

export async function installHeartbeatHook(tab: EvalCapable): Promise<void> {
  const ok = await tab.evaluate<boolean>(HEARTBEAT_HOOK_JS);
  if (ok !== true) throw new Error('heartbeat hook did not install');
}

export async function readPlayerData(tab: EvalCapable): Promise<LmsPlayerData | null> {
  const raw = await tab.evaluate<string>('JSON.stringify(window.playerdata || null)');
  if (!raw || raw === 'null') return null;
  try {
    return JSON.parse(raw) as LmsPlayerData;
  } catch {
    return null;
  }
}

export async function readPlayerState(tab: EvalCapable): Promise<PlayerState> {
  return tab.evaluate<PlayerState>(PLAYER_STATE_JS);
}

/** Ordered unique video ids on a course page. */
export async function scrapeCourseVideoIds(tab: EvalCapable): Promise<number[]> {
  const raw = await tab.evaluate<string>(SCRAPE_IDS_JS);
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}

/** Known heartbeat URL fragment — the fast path; generic detection (observe.ts) is skipped when present. */
export const heartbeatUrlPattern = "mod_fsresource_set_time";

/** Parse server-credited totaltime out of a heartbeat response body. */
export function extractTotalTime(responseText: string): number | null {
  const m = /"totaltime"\s*:\s*"?([\d.]+)/i.exec(responseText);
  return m ? Number(m[1]) : null;
}
