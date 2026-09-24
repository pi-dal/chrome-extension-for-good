import type { LogFn } from './log.js';
import type { PlayerState } from './platforms/plugin.js';

/**
 * Playback-rate exploration (M4): does the server credit time faster when the
 * video plays faster?
 *
 * WHY MEASURE INSTEAD OF ASSUME
 * Two plausible backend implementations, opposite answers: crediting by the
 * *reported position* means 2x halves the wall time needed; capping against the
 * wall clock means 2x credits the same seconds per wall second as 1x and buys
 * nothing. Only a measurement on the operator's own account can tell them
 * apart:
 *
 *   phase A (1x, W seconds)  -> credited-per-wall baseline
 *   phase B (R×, W seconds)  -> credited-per-wall at the requested rate
 *   verdict = classify(slopeB / slopeA, R)
 *
 * The measurement only READS heartbeat responses the page already received and
 * sets `video.playbackRate`; the rate is restored when the probe finishes.
 */

/** Structural subset of CdpTab the probe needs (fake-able in tests). */
export interface ProbeCdp {
  url(): Promise<string>;
  evaluate<T = unknown>(expression: string, opts?: { userGesture?: boolean }): Promise<T>;
}

export interface ProbePlatform {
  installHeartbeatHook(tab: ProbeCdp): Promise<void>;
  readPlayerState(tab: ProbeCdp): Promise<PlayerState>;
}

export interface CreditSample {
  /** Node clock when the sample was taken. */
  at: number;
  /** Page clock of the last heartbeat response (0 = none seen yet). */
  heartbeatTs: number;
  /** Server-acked accumulated seconds (null = not present in the response). */
  credited: number | null;
  /** Server-acked progress percent (fallback credit signal). */
  progress: number | null;
  currentTime: number;
  rate: number;
  playing: boolean;
}

export interface PhaseMeasurement {
  requestedRate: number;
  /** Median playbackRate observed while sampling (proves the page obeyed). */
  observedRate: number;
  samples: CreditSample[];
  /** Distinct heartbeat responses seen in the window. */
  heartbeats: number;
  /** Server-acked seconds per wall second (null = unobservable). */
  creditedPerWall: number | null;
  /** Server-acked progress % per wall second (fallback, null = unobservable). */
  progressPerWall: number | null;
  /** Video seconds per wall second — the client-side sanity check. */
  videoPerWall: number;
  wallSeconds: number;
  /** Set when the phase could not run at all (video never played, etc.). */
  aborted: string | null;
}

export type CreditVerdictKind = 'credited' | 'partial' | 'wallclock' | 'stalled' | 'unobservable';

export interface CreditVerdict {
  verdict: CreditVerdictKind;
  /** credited-per-wall at R× ÷ credited-per-wall at 1× (null = unobservable). */
  creditRatio: number | null;
  /** Measured credit speed at R× as a multiple of wall clock (null = unknown). */
  creditedSpeed: number | null;
  note: string;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Credit slope across the window, derived only from heartbeat boundaries: the
 * first and last DISTINCT heartbeat response seen, so a stalled response cannot
 * masquerade as progress.
 */
export function creditSlopes(samples: CreditSample[]): {
  creditedPerWall: number | null;
  progressPerWall: number | null;
  videoPerWall: number;
  heartbeats: number;
} {
  const withHeartbeat = samples.filter((s) => s.heartbeatTs > 0);
  const first = withHeartbeat[0];
  const last = withHeartbeat[withHeartbeat.length - 1];
  const distinct = new Set(withHeartbeat.map((s) => s.heartbeatTs)).size;
  const wallSpan = first && last ? (last.heartbeatTs - first.heartbeatTs) / 1000 : 0;
  // A slope over a tiny heartbeat span is noise, not signal: two responses
  // 0.5s apart with 10s of credit between them would read as 20x wall clock.
  // Below MIN_SLOPE_SPAN_S the phase is unobservable rather than misleading.
  const usableSpan = wallSpan >= MIN_SLOPE_SPAN_S;
  const creditedPerWall =
    first && last && usableSpan && first.credited !== null && last.credited !== null
      ? (last.credited - first.credited) / wallSpan
      : null;
  const progressPerWall =
    first && last && usableSpan && first.progress !== null && last.progress !== null
      ? (last.progress - first.progress) / wallSpan
      : null;
  const videoFirst = samples[0];
  const videoLast = samples[samples.length - 1];
  const videoWall = videoFirst && videoLast ? (videoLast.at - videoFirst.at) / 1000 : 0;
  const videoPerWall =
    videoFirst && videoLast && videoWall > 0 ? (videoLast.currentTime - videoFirst.currentTime) / videoWall : 0;
  return { creditedPerWall, progressPerWall, videoPerWall, heartbeats: distinct };
}

/** Preferred credit signal: acked seconds, else acked progress percent. */
export function creditSignal(phase: Pick<PhaseMeasurement, 'creditedPerWall' | 'progressPerWall'>): number | null {
  return phase.creditedPerWall ?? phase.progressPerWall;
}

/**
 * Thresholds are deliberately asymmetric: "credited" requires ~90% of the
 * expected gain (below that the operator should know the speedup is partial),
 * and anything close to the 1x baseline is called wall-clock capped.
 */
export const CREDITED_FRACTION = 0.9;
export const WALLCLOCK_CEILING = 1.2;
export const MIN_BASELINE_SPEED = 0.5;
/** Heartbeat span below this many seconds cannot carry a slope (burst noise). */
export const MIN_SLOPE_SPAN_S = 3;
/** The page must hold at least this fraction of the requested rate. */
export const MIN_OBSERVED_RATE_FRACTION = 0.8;

export function computeVerdict(
  base: PhaseMeasurement,
  fast: PhaseMeasurement,
  requestedRate: number,
): CreditVerdict {
  if (base.aborted || fast.aborted) {
    return {
      verdict: 'unobservable',
      creditRatio: null,
      creditedSpeed: null,
      note: `probe could not run: ${base.aborted ?? fast.aborted}`,
    };
  }
  if (base.heartbeats < 2 || fast.heartbeats < 2) {
    return {
      verdict: 'unobservable',
      creditRatio: null,
      creditedSpeed: null,
      note: `not enough heartbeat responses in a window (1x=${base.heartbeats}, ${requestedRate}x=${fast.heartbeats}) — extend --window or check that the page is heartbeating`,
    };
  }
  const baseSpeed = creditSignal(base);
  const fastSpeed = creditSignal(fast);
  if (baseSpeed === null || fastSpeed === null) {
    return {
      verdict: 'unobservable',
      creditRatio: null,
      creditedSpeed: null,
      note: 'heartbeat responses carry neither totaltime nor progress — cannot read server-credited time on this platform',
    };
  }
  if (baseSpeed < MIN_BASELINE_SPEED) {
    return {
      verdict: 'unobservable',
      creditRatio: null,
      creditedSpeed: fastSpeed,
      note: `baseline 1x credit is only ${baseSpeed.toFixed(2)}x wall clock — investigate the stall before judging any playback rate`,
    };
  }
  // The verdict judges the BACKEND — but only if the page actually ran at
  // the requested rate. A player that clamps/resets playbackRate produces a
  // 1x fast phase whose ~1.0 ratio would masquerade as 'wallclock'.
  if (fast.observedRate < requestedRate * MIN_OBSERVED_RATE_FRACTION) {
    return {
      verdict: 'unobservable',
      creditRatio: null,
      creditedSpeed: fastSpeed,
      note: `the page never held the requested rate (observed ${fast.observedRate.toFixed(2)}x of ${requestedRate}x) — the player refused, so nothing about the backend was measured`,
    };
  }
  const ratio = fastSpeed / baseSpeed;
  if (fastSpeed <= baseSpeed * 0.25) {
    return {
      verdict: 'stalled',
      creditRatio: ratio,
      creditedSpeed: fastSpeed,
      note: `credit nearly stopped at ${requestedRate}x (${fastSpeed.toFixed(2)}x wall) — the backend appears to reject accelerated playback`,
    };
  }
  if (ratio >= requestedRate * CREDITED_FRACTION) {
    return {
      verdict: 'credited',
      creditRatio: ratio,
      creditedSpeed: fastSpeed,
      note: `credit scales with playback rate (${fastSpeed.toFixed(2)}x wall at ${requestedRate}x) — acceleration is credited`,
    };
  }
  if (ratio <= WALLCLOCK_CEILING) {
    return {
      verdict: 'wallclock',
      creditRatio: ratio,
      creditedSpeed: fastSpeed,
      note: `credit is wall-clock capped (${fastSpeed.toFixed(2)}x wall at ${requestedRate}x) — speeding up buys nothing and adds flag risk`,
    };
  }
  return {
    verdict: 'partial',
    creditRatio: ratio,
    creditedSpeed: fastSpeed,
    note: `partial credit (${fastSpeed.toFixed(2)}x wall at ${requestedRate}x, ratio ${ratio.toFixed(2)}) — still a net win over 1x`,
  };
}

const SET_RATE_JS = (rate: number, nudge: boolean): string => `(() => {
  const v = document.querySelector('video');
  if (!v) return 'no-video';
  if (Math.abs(v.playbackRate - ${rate}) > 0.01) v.playbackRate = ${rate};
  ${nudge ? 'if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }' : ''}
  return v.paused ? 'paused' : 'playing';
})()`;

/** Read-only evidence: what the page reports and what the server answered. */
export const HEARTBEAT_EVIDENCE_JS = `(() => {
  const hb = window.__c4gLastHeartbeat;
  return hb ? { requestBody: String(hb.requestBody || '').slice(0, 400), responseText: String(hb.responseText || '').slice(0, 300), ts: hb.ts } : null;
})()`;

export interface ProbeDeps {
  cdp: ProbeCdp;
  platform: ProbePlatform;
  log: LogFn;
  /** Sampling interval inside a phase (default 2000ms). */
  sampleMs?: number;
  /** Injected clock (tests). */
  now?: () => number;
  /** Injected sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One measurement phase: pin `rate`, wait `windowMs`, sample player state.
 * Leaves the page at `rate` (the caller decides what to restore) and never
 * issues a network request of its own.
 */
export async function measurePhase(deps: ProbeDeps, rate: number, windowMs: number): Promise<PhaseMeasurement> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const sampleMs = deps.sampleMs ?? 2_000;
  const samples: CreditSample[] = [];

  const started = (await deps.cdp.evaluate<string>(SET_RATE_JS(rate, true), { userGesture: true }).catch(() => 'error')) ?? 'error';
  if (started === 'no-video') {
    return emptyPhase(rate, `no <video> element on ${await safeUrl(deps.cdp)}`);
  }
  if (started === 'paused') {
    await sleep(2_000);
    const retry = await deps.platform.readPlayerState(deps.cdp).catch(() => null);
    if (!retry || !retry.playing) {
      return emptyPhase(rate, 'the video is not playing — start playback (or handle the dialog) before probing');
    }
  }

  const start = now();
  while (now() - start < windowMs) {
    await sleep(sampleMs);
    const state = await deps.platform.readPlayerState(deps.cdp).catch(() => null);
    if (!state) continue;
    samples.push({
      at: now(),
      heartbeatTs: state.heartbeatTs,
      credited: state.totaltime,
      progress: state.progress,
      currentTime: state.currentTime,
      rate: state.rate,
      playing: state.playing,
    });
  }

  const slopes = creditSlopes(samples);
  const measurement: PhaseMeasurement = {
    requestedRate: rate,
    observedRate: median(samples.filter((s) => s.playing).map((s) => s.rate)),
    samples,
    heartbeats: slopes.heartbeats,
    creditedPerWall: slopes.creditedPerWall,
    progressPerWall: slopes.progressPerWall,
    videoPerWall: slopes.videoPerWall,
    wallSeconds: Math.round((now() - start) / 1000),
    aborted: null,
  };
  deps.log(
    'info',
    `speed-probe: ${rate}x phase — credited/wall=${fmt(measurement.creditedPerWall)} progress/wall=${fmt(measurement.progressPerWall)} video/wall=${measurement.videoPerWall.toFixed(2)} heartbeats=${measurement.heartbeats} observedRate=${measurement.observedRate}`,
  );
  return measurement;
}

function emptyPhase(rate: number, aborted: string): PhaseMeasurement {
  return {
    requestedRate: rate,
    observedRate: 0,
    samples: [],
    heartbeats: 0,
    creditedPerWall: null,
    progressPerWall: null,
    videoPerWall: 0,
    wallSeconds: 0,
    aborted,
  };
}

async function safeUrl(cdp: ProbeCdp): Promise<string> {
  return cdp.url().catch(() => '(unknown page)');
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : v.toFixed(2);
}

export interface SpeedProbeResult {
  base: PhaseMeasurement;
  fast: PhaseMeasurement;
  verdict: CreditVerdict;
  /** What the page sent / the server answered, for the report. */
  evidence: { requestBody: string; responseText: string } | null;
}

/**
 * Full A/B probe: baseline at 1x, then at the requested rate, then restore 1x
 * unless `keepRate`. Returns the verdict plus both phases for the report.
 */
export async function probeCreditSpeed(
  deps: ProbeDeps & { rate: number; windowMs: number; keepRate?: boolean },
): Promise<SpeedProbeResult> {
  const { log } = deps;
  log('info', `speed-probe: baseline phase at 1x for ${Math.round(deps.windowMs / 1000)}s (read-only observation of server-credited time)`);
  const base = await measurePhase(deps, 1, deps.windowMs);
  log('info', `speed-probe: measuring phase at ${deps.rate}x for ${Math.round(deps.windowMs / 1000)}s`);
  const fast = await measurePhase(deps, deps.rate, deps.windowMs);
  const verdict = computeVerdict(base, fast, deps.rate);
  if (!deps.keepRate) {
    await deps.cdp.evaluate<string>(SET_RATE_JS(1, false)).catch(() => 'error');
    log('info', 'speed-probe: playback rate restored to 1x');
  }
  const evidence = await deps.cdp
    .evaluate<{ requestBody: string; responseText: string } | null>(HEARTBEAT_EVIDENCE_JS)
    .catch(() => null);
  return { base, fast, verdict, evidence };
}
