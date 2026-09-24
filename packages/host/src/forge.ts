import { defaultDataDir, nodeIo, type LedgerIO } from './batch.js';
import type { LogFn } from './log.js';
import type { PlayerState } from './platforms/plugin.js';

/**
 * Report replay (instant-pass / accelerated reporting).
 *
 * The MECHANISM lives here, once: take the platform's own last heartbeat request
 * as the plugin's hook recorded it (`window.__c4gLastHeartbeat` = {url,
 * requestBody}), rewrite the position field, and re-issue it from the page with
 * the page's own credentials. The plugin contributes only platform knowledge —
 * which numeric field carries the position (`forge.timeFieldPattern`).
 *
 * WHY THE PROBE COMES FIRST
 * A backend that validates credited time against wall-clock deltas discards a
 * forged position, so the feature is worthless there and the replay is just an
 * extra request on the account. That question is settled by measurement, not by
 * opinion: `probeReportAcceptance` sends ONE report and reads back the server's
 * own ack (`totaltime`/`progress` from the plugin's player state). Only an
 * `accepted` verdict enables the driver; `ignored`/`rejected`/`unobservable`
 * need an explicit override.
 *
 * INTEGRITY: nothing here ever completes a video. Completion stays the
 * Timekeeper's rule — the server's own ack has to confirm it — so a forged
 * report the backend ignores can never enter the completion ledger.
 */

export interface ForgeCdp {
  url(): Promise<string>;
  evaluate<T = unknown>(expression: string, opts?: { awaitPromise?: boolean; userGesture?: boolean }): Promise<T>;
}

export interface ForgePlatform {
  readPlayerState(tab: ForgeCdp): Promise<PlayerState>;
}

export interface ReplayOutcome {
  ok: boolean;
  /** HTTP status when the request came back. */
  status: number | null;
  /** Server response excerpt or the failure reason. */
  detail: string;
}

/** How a replayed report was received, judged by the server's own ack. */
export type ReportVerdictKind = 'accepted' | 'ignored' | 'rejected' | 'unobservable';

export interface ReportVerdict {
  verdict: ReportVerdictKind;
  /** Server-acked seconds gained by the replayed report (null = unreadable). */
  creditedDelta: number | null;
  /** Server-acked progress points gained (fallback signal). */
  progressDelta: number | null;
  position: number;
  replay: ReplayOutcome;
  note: string;
}

export const DEFAULT_TIME_FIELD_PATTERN = '"(?:time|totaltime|playingTime|position)"\\s*:\\s*"?\\d+(?:\\.\\d+)?';

/** MAIN-world replay: rewrite the position in the recorded body and re-send it. */
export function replayScript(timeFieldPattern: string): string {
  return `(async () => {
  const hb = window.__c4gLastHeartbeat;
  if (!hb || !hb.url || !hb.requestBody) return { ok: false, status: null, detail: 'no heartbeat recorded yet (is the plugin hook installed and the video playing?)' };
  const pos = window.__c4gForgePosition;
  let re;
  try { re = new RegExp(${JSON.stringify(timeFieldPattern)}); } catch (e) { return { ok: false, status: null, detail: 'bad field pattern: ' + e }; }
  const m = re.exec(hb.requestBody);
  if (!m) return { ok: false, status: null, detail: 'position field not found in the recorded body: ' + String(hb.requestBody).slice(0, 160) };
  // Replace the LAST numeric run in the matched field text: the position value
  // is the trailing number; a first-number replace would corrupt a field NAME
  // that itself contains digits (custom patterns can declare e.g. "a1time").
  const body = hb.requestBody.replace(re, m[0].replace(/(\\d+(?:\\.\\d+)?)(?!.*\\d)/, String(pos)));
  const json = /^\\s*[\\[{]/.test(body);
  try {
    const resp = await fetch(hb.url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
      body: body
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, detail: String(text).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: null, detail: 'replay failed: ' + String(e) };
  }
})()`;
}

/** What a plugin contributes to replay: a field pattern, its own script, or both. */
export interface ForgeKnowledge {
  timeFieldPattern?: string;
  replayJs?: string;
}

/**
 * Issue one replayed report at `position` and return what the page answered.
 * A platform script (`replayJs`) wins over the generic field rewrite: signed or
 * obfuscated payloads have to be rebuilt by the plugin, not patched.
 */
export async function replayReport(cdp: ForgeCdp, position: number, knowledge: ForgeKnowledge = {}): Promise<ReplayOutcome> {
  await cdp.evaluate(`window.__c4gForgePosition = ${Number(position)}; true`);
  const source = knowledge.replayJs ?? replayScript(knowledge.timeFieldPattern ?? DEFAULT_TIME_FIELD_PATTERN);
  const raw = await cdp
    .evaluate<Partial<ReplayOutcome>>(source, { awaitPromise: true })
    .catch((err: unknown) => ({ ok: false, status: null, detail: err instanceof Error ? err.message : String(err) }));
  return {
    ok: raw?.ok === true,
    status: typeof raw?.status === 'number' ? raw.status : null,
    detail: typeof raw?.detail === 'string' ? raw.detail : '',
  };
}

export interface ReportProbeDeps {
  cdp: ForgeCdp;
  platform: ForgePlatform;
  log: LogFn;
  /** Plugin-supplied replay knowledge (pattern and/or platform script). */
  forge?: ForgeKnowledge;
  /** How long to wait for the ack after the replay (default 10s). */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One replayed report, judged by the server's ack: `accepted` when the credited
 * value moved, `ignored` when it did not, `rejected` when the replay itself
 * failed, `unobservable` when the platform exposes no ack to read.
 */
export async function probeReportAcceptance(deps: ReportProbeDeps & { position: number }): Promise<ReportVerdict> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const settleMs = deps.settleMs ?? 10_000;
  const before = await deps.platform.readPlayerState(deps.cdp).catch(() => null);
  // Judge observability BEFORE spending a report: a replay whose ack cannot
  // be read teaches nothing and still lands on the server.
  if (!before || (before.totaltime === null && before.progress === null)) {
    return {
      verdict: 'unobservable',
      creditedDelta: null,
      progressDelta: null,
      position: deps.position,
      replay: { ok: false, status: null, detail: 'not sent — no readable ack to judge against' },
      note: 'no readable server ack (totaltime/progress) — a forged report cannot be judged on this platform, so forging stays off',
    };
  }
  const replay = await replayReport(deps.cdp, deps.position, deps.forge);
  deps.log('info', `report-probe: replayed position ${deps.position}s → ${replay.ok ? `HTTP ${replay.status}` : replay.detail}`);
  await sleep(settleMs);
  const after = await deps.platform.readPlayerState(deps.cdp).catch(() => null);
  if (!after) {
    return {
      verdict: 'unobservable',
      creditedDelta: null,
      progressDelta: null,
      position: deps.position,
      replay,
      note: 'the page went away before the ack could be read',
    };
  }
  const creditedDelta =
    before.totaltime !== null && after.totaltime !== null ? after.totaltime - before.totaltime : null;
  const progressDelta = before.progress !== null && after.progress !== null ? after.progress - before.progress : null;
  // The video is PLAYING during the settle window, so the ack drifts upward
  // naturally (~settle × rate seconds). A bare "did it move" check would call
  // every ignored replay 'accepted'. The forged jump (position − currentTime)
  // is the signal: require the delta to clearly exceed natural drift AND to
  // cover a meaningful share of the jump (servers that cap per-report credit
  // still count — +20s on a +60s forge is real credit, +10s is playback).
  const rate = Math.max(1, before.rate || 1);
  const jump = Math.max(0, deps.position - before.currentTime);
  const driftBound = (settleMs / 1000) * rate * 1.5 + 2;
  const threshold = Math.max(driftBound, Math.min(jump * 0.5, 20));
  const creditedMoved = creditedDelta !== null && creditedDelta > threshold;
  // Progress is a percentage: convert the seconds bound via duration when
  // known; without a duration the progress signal alone cannot be judged.
  const progressBound = before.duration > 0 ? (threshold / before.duration) * 100 : null;
  const progressMoved =
    progressDelta !== null && progressBound !== null && progressDelta > progressBound;
  const moved = creditedMoved || progressMoved;
  if (moved) {
    return {
      verdict: 'accepted',
      creditedDelta,
      progressDelta,
      position: deps.position,
      replay,
      note: `the backend credited the replayed position (+${(creditedDelta ?? progressDelta ?? 0).toFixed(1)} beyond the ~${threshold.toFixed(0)}s natural-drift bound) — report replay works here`,
    };
  }
  if (!replay.ok) {
    return {
      verdict: 'rejected',
      creditedDelta,
      progressDelta,
      position: deps.position,
      replay,
      note: `the replay was refused (${replay.detail.slice(0, 120)})`,
    };
  }
  return {
    verdict: 'ignored',
    creditedDelta,
    progressDelta,
    position: deps.position,
    replay,
    note:
      `the replay was accepted by HTTP but the ack moved no more than natural playback explains (≤${threshold.toFixed(0)}s) — this backend caps credit against real wall-clock, so forged positions buy nothing`,
  };
}

/**
 * What the gate reads back. A measurement carries the full evidence; a driver
 * that gave up mid-run records the same shape with `source: 'driver'` so the
 * next run does not re-learn the same lesson.
 */
export interface ReportProbeEntry {
  origin: string;
  pluginId: string;
  at: string;
  verdict: ReportVerdictKind;
  note: string;
  source: 'probe' | 'driver';
  creditedDelta?: number | null;
  progressDelta?: number | null;
  position?: number | null;
  replay?: ReplayOutcome | null;
}

export function entryFromVerdict(origin: string, pluginId: string, verdict: ReportVerdict): ReportProbeEntry {
  return {
    origin,
    pluginId,
    at: new Date().toISOString(),
    verdict: verdict.verdict,
    note: verdict.note,
    source: 'probe',
    creditedDelta: verdict.creditedDelta,
    progressDelta: verdict.progressDelta,
    position: verdict.position,
    replay: verdict.replay,
  };
}

export function entryFromGiveUp(origin: string, pluginId: string, note: string): ReportProbeEntry {
  return { origin, pluginId, at: new Date().toISOString(), verdict: 'ignored', note, source: 'driver' };
}

/** data/report-probe.json — per origin, so the gate has evidence to read. */
export class ReportProbeStore {
  private readonly entries = new Map<string, ReportProbeEntry>();

  constructor(readonly file: string, private readonly io: LedgerIO = nodeIo) {}

  load(): void {
    if (!this.io.exists(this.file)) return;
    try {
      const parsed = JSON.parse(this.io.readFile(this.file)) as Record<string, ReportProbeEntry>;
      for (const [origin, entry] of Object.entries(parsed)) {
        if (entry && typeof entry === 'object' && typeof entry.verdict === 'string') this.entries.set(origin, entry);
      }
    } catch {
      // corrupt file — start empty rather than block a run
    }
  }

  get(origin: string): ReportProbeEntry | undefined {
    return this.entries.get(origin);
  }

  /**
   * Entry younger than `maxAgeMs` (default 30 days). A stale 'accepted' must
   * not arm replay forever — backends change — and a stale 'ignored' should
   * not ban it forever either; both expire back to 'no-evidence'.
   */
  getFresh(origin: string, maxAgeMs = 30 * 24 * 3_600_000, now = Date.now()): ReportProbeEntry | undefined {
    const entry = this.entries.get(origin);
    if (!entry) return undefined;
    const measured = Date.parse(entry.at);
    if (!Number.isFinite(measured) || now - measured > maxAgeMs) return undefined;
    return entry;
  }

  record(entry: ReportProbeEntry): void {
    this.entries.set(entry.origin, entry);
    this.io.writeAtomic(this.file, JSON.stringify(Object.fromEntries(this.entries), null, 2));
  }

  all(): ReportProbeEntry[] {
    return [...this.entries.values()];
  }
}

export function defaultReportProbeFile(): string {
  return `${defaultDataDir()}/report-probe.json`;
}

export interface ForgeDecision {
  enabled: boolean;
  verdict: ReportVerdictKind | 'no-evidence' | 'not-requested' | 'no-pattern';
  note: string;
}

/**
 * Gate forging on measured evidence — the same shape as the playback-rate gate:
 * state the measurement, let the operator override, never pretend.
 */
export function decideForge(opts: {
  requested: boolean;
  /** True when the plugin contributes replay knowledge (pattern or a script). */
  hasPattern: boolean;
  entry?: ReportProbeEntry | undefined;
  force?: boolean;
  log: LogFn;
}): ForgeDecision {
  const { requested, hasPattern, entry, force, log } = opts;
  if (!requested) return { enabled: false, verdict: 'not-requested', note: 'report replay off (default)' };
  if (!hasPattern) {
    return {
      enabled: false,
      verdict: 'no-pattern',
      note: 'this plugin contributes no forge replay knowledge — report replay is not implemented for the platform',
    };
  }
  if (!entry) {
    if (force) {
      log('warn', 'forge: no measurement for this origin — forcing report replay without evidence');
      return { enabled: true, verdict: 'no-evidence', note: 'report replay forced without a measurement' };
    }
    return {
      enabled: false,
      verdict: 'no-evidence',
      note: 'no measured report verdict for this origin — run `report-probe` first (~30s, one report) or override with --forge-force',
    };
  }
  const headline = `measured ${entry.at.slice(0, 16)}: ${entry.note}`;
  if (entry.verdict === 'accepted') {
    log('info', `forge: report replay enabled — ${headline}`);
    return { enabled: true, verdict: entry.verdict, note: `report replay accepted; ${headline}` };
  }
  if (force) {
    log('warn', `forge: forcing report replay although the measurement says "${entry.verdict}" — ${headline}`);
    return { enabled: true, verdict: entry.verdict, note: `forced despite "${entry.verdict}"; ${headline}` };
  }
  log('warn', `forge: report replay refused by measurement (${entry.verdict}) — ${headline}. Override with --forge-force if you disagree.`);
  return { enabled: false, verdict: entry.verdict, note: `off — measurement says "${entry.verdict}"; ${headline}` };
}

export interface ForgeDriverDeps {
  cdp: ForgeCdp;
  platform: ForgePlatform;
  log: LogFn;
  forge?: ForgeKnowledge;
  /** Seconds of credit to claim per report (default 60). */
  stepSeconds?: number;
  /** Claim the whole remaining duration instead (instant-pass). */
  toEnd?: boolean;
  /** Disable after this many reports without the ack moving (default 2). */
  maxStalls?: number;
  /** Where the verdict is persisted when the driver gives up. */
  onGiveUp?: (verdict: ReportVerdictKind, note: string) => void;
}

export interface ForgeDriver {
  /** One report attempt; call from the supervision tick. */
  tick(): Promise<void>;
  /** Reports accepted so far and whether the driver is still armed. */
  status(): { reports: number; accepted: number; stalls: number; disabled: boolean };
  disable(reason: string): void;
}

/**
 * Per-video report driver: one replay per tick, and it disables ITSELF as soon
 * as the ack stops moving — a backend that ignores forged positions must not be
 * hammered, and the operator gets the verdict instead of a silent no-op.
 */
export function makeForgeDriver(deps: ForgeDriverDeps): ForgeDriver {
  const step = deps.stepSeconds ?? 60;
  const maxStalls = deps.maxStalls ?? 2;
  let reports = 0;
  let accepted = 0;
  let stalls = 0;
  let disabled = false;

  return {
    async tick() {
      if (disabled) return;
      let state: PlayerState;
      try {
        state = await deps.platform.readPlayerState(deps.cdp);
      } catch (err) {
        deps.log('debug', `forge: cannot read player state — ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      // Compare the ack before/after THIS report: priming from a stale value
      // would score the first honest report as a stall. The ack field must be
      // the SAME on both reads — totaltime is seconds, progress is percent.
      const ackField: 'totaltime' | 'progress' | null =
        state.totaltime !== null ? 'totaltime' : state.progress !== null ? 'progress' : null;
      const beforeAck = ackField === null ? null : state[ackField];
      const target = deps.toEnd && state.duration > 0 ? state.duration : state.currentTime + step;
      const position = Math.max(1, Math.round(target));
      // Nothing to claim: the playhead already reached the forged position
      // (toEnd near the end of the video). Reporting a position at/behind the
      // playhead is meaningless and could regress the server-side ledger.
      if (position <= state.currentTime + 1) return;
      const replay = await replayReport(deps.cdp, position, deps.forge);
      reports += 1;
      if (!replay.ok) {
        stalls += 1;
        deps.log('warn', `forge: report ${reports} refused (${replay.detail.slice(0, 120)}) — stall ${stalls}/${maxStalls}`);
      } else {
        const after = await deps.platform.readPlayerState(deps.cdp).catch(() => null);
        const afterAck = after !== null && ackField !== null ? after[ackField] : null;
        // A bare `>` is not enough: a NATURAL heartbeat landing between the
        // two reads credits ~one heartbeat interval and would masquerade as
        // acceptance — the driver would never stall out on a backend that
        // ignores forging but heartbeats often. Require the ack to cover a
        // meaningful share of the forged jump (capped, so partial-credit
        // backends still count). Progress acks are percent — convert via
        // duration.
        const forgedJump = Math.max(0, position - state.currentTime);
        // Floor of 5s: a natural heartbeat ack landing between the two reads
        // credits its inter-report gap — a bound of 0 (jump≈0) or a bare
        // positive would score that as acceptance and never stall out.
        const boundSec = Math.max(5, Math.min(forgedJump * 0.5, 20));
        const acceptBound =
          ackField === 'progress' && state.duration > 0 ? (boundSec / state.duration) * 100 : boundSec;
        const moved =
          beforeAck !== null && afterAck !== null ? afterAck - beforeAck >= acceptBound : null;
        if (moved === true) {
          accepted += 1;
          stalls = 0;
          deps.log('info', `forge: report ${reports} credited (ack ${beforeAck?.toFixed(1)} → ${afterAck?.toFixed(1)})`);
        } else {
          stalls += 1;
          deps.log(
            'warn',
            `forge: report ${reports} answered HTTP ${replay.status} but the ack did not move (${moved === null ? 'no readable ack' : `${beforeAck?.toFixed(1)} → ${afterAck?.toFixed(1)}`}) — stall ${stalls}/${maxStalls}`,
          );
        }
      }
      if (stalls >= maxStalls) {
        disabled = true;
        const note = `stopped after ${stalls} reports without the ack moving (${accepted} credited first) — this backend is not crediting replayed positions`;
        deps.log('error', `forge: DISABLED — ${note}`);
        deps.onGiveUp?.('ignored', note);
      }
    },
    status: () => ({ reports, accepted, stalls, disabled }),
    disable(reason: string) {
      if (disabled) return;
      disabled = true;
      deps.log('info', `forge: disabled (${reason})`);
    },
  };
}

/** One-line report for a run summary. */
export function forgeSummaryLine(decision: ForgeDecision, driver?: ForgeDriver): string {
  if (!driver) return `report replay: ${decision.enabled ? 'on' : 'off'} (${decision.verdict}) — ${decision.note}`;
  const s = driver.status();
  return `report replay: ${decision.enabled ? 'on' : 'off'} (${decision.verdict}) — ${s.reports} report(s), ${s.accepted} credited${s.disabled ? ', self-disabled' : ''}`;
}
