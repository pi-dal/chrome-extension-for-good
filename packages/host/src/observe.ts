/**
 * Generic heartbeat detection (design §4.4): install a request ring buffer in
 * the page (MAIN world via CDP), then frequency-cluster the samples.
 *
 * The patches wrap the page's own XHR/fetch and always call through: the host
 * reads traffic, it does not issue it. Server-credited time therefore only
 * advances through the page's own genuine playback.
 */

export interface XhrSample {
  /** epoch ms at request time */
  t: number;
  /** uppercased HTTP method */
  m: string;
  /** request URL as issued (may carry query params) */
  u: string;
}

export interface HeartbeatCandidate {
  method: string;
  /** URL pathname only — heartbeat queries (unique tokens) vary per call. */
  path: string;
  /** median inter-request period in ms */
  periodMs: number;
  /** samples in the cluster */
  samples: number;
  /** coefficient of variation of the periods (lower = more regular) */
  cv: number;
}

export interface CdpEvaluateLike {
  evaluate<T = unknown>(expression: string): Promise<T>;
}

const RING_CAP = 200;

/**
 * Idempotent MAIN-world installer: patches XHR and fetch to RECORD requests
 * into window.__c4gXhrRing (capped ring). Every original call still happens
 * with the original arguments; nothing is ever blocked, replayed, or forged.
 */
export const RING_SCRIPT = `(function () {
  if (window.__c4gXhrRing && window.__c4gXhrRing.__installed) return 'already';
  var ring = { __installed: true, cap: ${RING_CAP}, entries: [] };
  function push(e) {
    ring.entries.push(e);
    if (ring.entries.length > ring.cap) ring.entries.shift();
  }
  var XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR && !XHR.__c4gPatched) {
    var openOrig = XHR.open;
    var sendOrig = XHR.send;
    XHR.__c4gPatched = true;
    XHR.open = function (m, u) {
      this.__c4gMeta = { m: String(m || 'GET').toUpperCase(), u: String(u || '') };
      return openOrig.apply(this, arguments);
    };
    XHR.send = function () {
      if (this.__c4gMeta) push({ t: Date.now(), m: this.__c4gMeta.m, u: this.__c4gMeta.u });
      return sendOrig.apply(this, arguments);
    };
  }
  if (typeof window.fetch === 'function' && !window.fetch.__c4gWrapped) {
    var fetchOrig = window.fetch;
    var wrapped = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        push({ t: Date.now(), m: method, u: url });
      } catch (e) {}
      return fetchOrig.apply(this, arguments);
    };
    wrapped.__c4gWrapped = true;
    window.fetch = wrapped;
  }
  window.__c4gXhrRing = ring;
  return 'installed';
})()`;

/** Install (or reuse) the ring buffer in the page. Idempotent. */
export async function installRingBuffer(cdp: CdpEvaluateLike): Promise<'installed' | 'already'> {
  const result = await cdp.evaluate<string>(RING_SCRIPT);
  return result === 'already' ? 'already' : 'installed';
}

/** Read the recorded samples; empty array when the buffer is absent. */
export async function readRing(cdp: CdpEvaluateLike): Promise<XhrSample[]> {
  const raw = await cdp.evaluate<string>(
    'JSON.stringify((window.__c4gXhrRing && window.__c4gXhrRing.entries) || [])',
  );
  try {
    const parsed: unknown = JSON.parse(String(raw ?? '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is XhrSample =>
        typeof s === 'object' && s !== null &&
        typeof (s as XhrSample).t === 'number' &&
        typeof (s as XhrSample).m === 'string' &&
        typeof (s as XhrSample).u === 'string',
    );
  } catch {
    return [];
  }
}

function pathnameOf(u: string): string {
  try {
    return new URL(u, 'https://placeholder.local').pathname;
  } catch {
    return u;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface DetectOptions {
  minSamples?: number;      // default 4
  minPeriodMs?: number;     // default 5_000
  maxPeriodMs?: number;     // default 60_000
  maxCv?: number;           // default 0.35
}

/**
 * Frequency-cluster samples by method+pathname and surface regular periodic
 * requests as heartbeat candidates (design §4.4 thresholds). Pure function —
 * the input is never mutated and no requests are made.
 */
export function detectHeartbeat(samples: XhrSample[], opts: DetectOptions = {}): HeartbeatCandidate[] {
  const minSamples = opts.minSamples ?? 4;
  const minPeriodMs = opts.minPeriodMs ?? 5_000;
  const maxPeriodMs = opts.maxPeriodMs ?? 60_000;
  const maxCv = opts.maxCv ?? 0.35;

  const clusters = new Map<string, XhrSample[]>();
  for (const s of samples) {
    const key = `${s.m} ${pathnameOf(s.u)}`;
    const list = clusters.get(key);
    if (list) list.push(s);
    else clusters.set(key, [s]);
  }

  const candidates: HeartbeatCandidate[] = [];
  for (const [key, list] of clusters) {
    if (list.length < minSamples) continue;
    const ordered = [...list].sort((a, b) => a.t - b.t);
    const deltas: number[] = [];
    for (let i = 1; i < ordered.length; i++) deltas.push(ordered[i].t - ordered[i - 1].t);
    if (deltas.length === 0) continue;
    const periodMs = median(deltas);
    if (periodMs < minPeriodMs || periodMs > maxPeriodMs) continue;
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    if (mean <= 0) continue;
    const variance = deltas.reduce((acc, d) => acc + (d - mean) ** 2, 0) / deltas.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv >= maxCv) continue;
    const [method, path] = key.split(' ');
    candidates.push({ method, path, periodMs, samples: list.length, cv });
  }

  return candidates.sort((a, b) => b.samples - a.samples || a.cv - b.cv);
}
