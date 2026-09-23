import { join } from 'node:path';
import { defaultDataDir, nodeIo, planNextPass, type CompletionLedger, type FailedLedger, type ScrapeFn } from './batch.js';
import { clampRate } from './speed-policy.js';
import type { LogFn } from './log.js';
import type { WatchOutcome } from './timekeeper.js';

/**
 * Swarm mode: N lanes, each a separate Chrome tab running its own Timekeeper.
 *
 * NOT THE DEFAULT, because this deployment's backend has answered concurrent
 * playback with a DOM warning reading 「禁止同时观看多个视频」. So swarm:
 *   - plays every lane at the configured rate (the operator's measured choice,
 *     see speed-policy.ts) — concurrency changes how many distinct resources are
 *     watched at once, nothing else,
 *   - watches for that platform signal and degrades to a single lane the moment
 *     it appears, recording the evidence in data/swarm-flag.json,
 *   - is opt-in (`chain --swarm N`) and capped (see MAX_SWARM_LANES).
 *
 * WHAT A LANE NEEDS FROM THE BROWSER
 * Background tabs are throttled/frozen by Chrome, and most players stop when
 * they believe the tab is hidden or blurred. Each lane therefore arms a
 * keep-alive: MAIN-world visibility/focus spoof, page lifecycle pinned to
 * 'active', a held Web Lock (a documented Chromium throttling exemption), and
 * a user-gesture play nudge so a freshly opened tab can actually start media.
 */

/** Hard ceiling: more lanes than this has no upside and multiplies detection risk. */
export const MAX_SWARM_LANES = 4;

/**
 * Clamp a requested lane count and explain the risky zone. Kept here (not in
 * the CLI) so the platform knowledge lives in one place.
 */
export function planSwarmLanes(requested: number, log: LogFn): number {
  const wanted = Math.floor(Number.isFinite(requested) ? requested : 1);
  const lanes = Math.max(1, Math.min(MAX_SWARM_LANES, wanted));
  if (wanted > MAX_SWARM_LANES) {
    log('warn', `swarm: ${wanted} lanes requested — capped at ${MAX_SWARM_LANES}`);
  }
  if (lanes >= 3) {
    log('warn', `swarm: ${lanes} concurrent lanes. This deployment has previously answered concurrent playback with 「禁止同时观看多个视频」; every lane still plays at real 1x, and swarm degrades to one lane the moment that warning appears.`);
  }
  return lanes;
}

/** Lane index -> unique marker embedded in that lane's tab URL. */
export function laneMarker(nonce: string, index: number): string {
  return `c4g_lane=${nonce}-${index}`;
}

/** One-off nonce so tabs from a previous run can never be mistaken for ours. */
export function swarmNonce(seed = Date.now()): string {
  return `${seed.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Park URL for a freshly created lane tab: the marker makes the tab uniquely
 * matchable both by the extension (chrome.tabs) and by the CDP target list.
 */
export function laneMarkerUrl(courseUrl: string, marker: string): string {
  try {
    const url = new URL(courseUrl);
    const [key, value] = marker.split('=');
    url.searchParams.set(key, value);
    return url.toString();
  } catch {
    return `${courseUrl}${courseUrl.includes('?') ? '&' : '?'}${marker}`;
  }
}

// ---------------------------------------------------------------------------
// Lane keep-alive / policy scripts (MAIN world)
// ---------------------------------------------------------------------------

/**
 * MAIN-world keep-alive. Idempotent per document; re-running it after a
 * navigation is harmless.
 */
export function laneKeepAliveScript(laneId: string): string {
  const lock = JSON.stringify(`c4g-swarm-${laneId}`);
  return `(() => {
  if (window.__c4gSwarm) return true;
  try { window.__c4gSwarm = { lane: ${JSON.stringify(laneId)}, at: Date.now() }; } catch (e) {}
  try {
    const proto = Document.prototype;
    const spoof = (prop, value) => {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc && desc.get && desc.configurable) {
        Object.defineProperty(proto, prop, { get: () => value, configurable: true });
      }
    };
    spoof('hidden', false);
    spoof('visibilityState', 'visible');
    spoof('webkitHidden', false);
    spoof('webkitVisibilityState', 'visible');
  } catch (e) {}
  try { Document.prototype.hasFocus = function () { return true; }; } catch (e) {}
  try {
    // Holding a Web Lock is a documented Chromium opt-out from intensive timer
    // throttling and tab freezing. Unique per lane: same-name locks queue.
    if (navigator.locks && navigator.locks.request) {
      navigator.locks.request(${lock}, () => new Promise(() => {}));
    }
  } catch (e) {}
  return true;
})()`;
}

export interface LanePolicyOptions {
  mute: boolean;
  /** Operator-configured playback rate to pin (1 = default; never invented here). */
  rate?: number;
}

/**
 * Per-document policy applied after every navigation: restore 1x, apply the
 * mute policy, and nudge a paused <video> into playing. Evaluated with
 * `userGesture: true` so the play() call carries user activation (that is what
 * makes autoplay work in a tab the user never clicked).
 */
export function lanePolicyScript(opts: LanePolicyOptions): string {
  const rate = clampRate(opts.rate ?? 1);
  return `(() => {
  const v = document.querySelector('video');
  if (!v) return 'no-video';
  if (${opts.mute ? 'true' : 'false'}) v.muted = true;
  if (Math.abs(v.playbackRate - ${rate}) > 0.01) v.playbackRate = ${rate};
  if (v.paused) {
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
    return 'play-requested';
  }
  return 'playing';
})()`;
}

/** Structural subset of CdpTab a lane needs (fake-able in tests). */
export interface LaneCdp {
  url(): Promise<string>;
  navigate(url: string): Promise<void>;
  evaluate<T = unknown>(
    expression: string,
    opts?: { userGesture?: boolean; awaitPromise?: boolean },
  ): Promise<T>;
  /**
   * Optional CDP-level arming: register `source` (the keep-alive script) as a
   * MAIN-world init script, emulate focus, pin the page lifecycle to 'active'.
   */
  armKeepAlive?(source: string): Promise<void>;
}

export interface ApplyLanePolicyDeps extends LanePolicyOptions {
  laneId: string;
  log: LogFn;
}

/** Arm keep-alive for the current document and every future one. */
export async function applyLanePolicy(cdp: LaneCdp, deps: ApplyLanePolicyDeps): Promise<void> {
  await cdp.evaluate<boolean>(laneKeepAliveScript(deps.laneId));
  if (cdp.armKeepAlive) {
    try {
      await cdp.armKeepAlive(laneKeepAliveScript(deps.laneId));
    } catch (err) {
      // Focus/lifecycle emulation is a bonus; the in-page script already ran.
      deps.log('debug', `swarm: cdp keep-alive arming failed on ${deps.laneId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const status = await cdp.evaluate<string>(lanePolicyScript({ mute: deps.mute, rate: deps.rate }), { userGesture: true });
  deps.log('debug', `swarm: lane ${deps.laneId} policy applied (${status})`);
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

export interface SwarmLane {
  index: number;
  label: string;
  /** chrome.tabs id — the key every snapshot/action request uses. */
  tabId: number;
  marker: string;
  cdp: LaneCdp;
  /** True when this run created the tab (so shutdown may close it again). */
  created: boolean;
}

/** Per-lane supervisor surface (Timekeeper implements it). */
export interface LaneSupervisor {
  watch(id: number): Promise<WatchOutcome>;
  stop(): void;
  runSummary(): WatchOutcome[];
}

/** Round-robin partition: keeps lane workloads balanced when lengths differ. */
export function splitIntoLanes(ids: number[], laneCount: number): number[][] {
  if (laneCount <= 0) return [];
  const slices: number[][] = Array.from({ length: laneCount }, () => []);
  ids.forEach((id, i) => slices[i % laneCount]!.push(id));
  return slices;
}

export interface ProvisionLanesDeps {
  count: number;
  courseUrl: string;
  nonce: string;
  /** Opens a tab and returns its chrome.tabs id (WsBridge.openTab). */
  openTab: (url: string) => Promise<{ tabId: number }>;
  /**
   * Attaches CDP to the lane tab. `before` is the page-target id set captured
   * just before the tab was opened, so an implementation can fall back to
   * "the one new page target" when the park URL redirects away from its marker.
   */
  connectLane: (marker: string, index: number, before: readonly string[]) => Promise<LaneCdp>;
  /** Page-target ids before each `openTab` call (cdp.listPageTargetIds). */
  listTargets?: (index: number) => Promise<string[]>;
  /** Closes a lane tab whose CDP attach failed (WsBridge.closeTab). */
  closeTab?: (tabId: number) => Promise<void>;
  log: LogFn;
}

/**
 * Create `count` lane tabs, park each on a uniquely marked course URL and
 * attach CDP to it. A lane that fails to provision is dropped (its tab is
 * closed again) rather than sinking the run; zero surviving lanes is an error.
 */
export async function provisionLanes(deps: ProvisionLanesDeps): Promise<SwarmLane[]> {
  const lanes: SwarmLane[] = [];
  for (let i = 0; i < deps.count; i++) {
    const marker = laneMarker(deps.nonce, i);
    const url = laneMarkerUrl(deps.courseUrl, marker);
    let tabId: number | null = null;
    try {
      const before = deps.listTargets ? await deps.listTargets(i) : [];
      const opened = await deps.openTab(url);
      tabId = opened.tabId;
      const cdp = await deps.connectLane(marker, i, before);
      lanes.push({ index: i, label: `lane${i}`, tabId, marker, cdp, created: true });
      deps.log('info', `swarm: ${`lane${i}`} ready (tab ${tabId}, marker ${marker})`);
    } catch (err) {
      deps.log('error', `swarm: lane${i} provisioning failed (tab ${tabId ?? '-'}): ${err instanceof Error ? err.message : String(err)}`);
      if (tabId !== null && deps.closeTab) {
        await deps.closeTab(tabId).catch((closeErr: unknown) =>
          deps.log('debug', `swarm: closing half-built lane${i} tab ${tabId} failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`),
        );
      }
    }
  }
  if (lanes.length === 0) {
    throw new Error('swarm: no lane could be provisioned (extension bridge + CDP debugging port required)');
  }
  return lanes;
}

// ---------------------------------------------------------------------------
// Platform concurrency-warning detection
// ---------------------------------------------------------------------------

/**
 * HARD signal: the platform explicitly forbids concurrent playback. Matching
 * this degrades the run to a single lane immediately.
 */
export const HARD_WARNING_PATTERNS: readonly RegExp[] = [
  /禁止[^。\n]{0,12}(同时|多个|多路)[^。\n]{0,8}(观看|播放|学习)?/,
  /(不得|请勿|严禁|不能|不可)[^。\n]{0,10}(同时|多[个路台])[^。\n]{0,8}(观看|播放)/,
];

/** SOFT signal: looks related but is not proof (course rules text etc.). */
export const SOFT_WARNING_PATTERNS: readonly RegExp[] = [
  /(同时|并发)(观看|播放)/,
  /multiple videos/i,
  /concurrent (viewing|watching|playback)/i,
];

export interface WarningProbe {
  hard: string | null;
  soft: string | null;
}

/** How much DOM text one probe reads — the probe runs every poll interval. */
export const PROBE_TEXT_CAP = 8000;

export function clampProbeText(text: unknown): string {
  return typeof text === 'string' ? text.slice(0, PROBE_TEXT_CAP) : '';
}

/** Read-only DOM text scan for the platform's concurrent-playback warning. */
export async function detectConcurrencyWarning(cdp: LaneCdp): Promise<WarningProbe> {
  let text: string;
  try {
    text = clampProbeText(await cdp.evaluate<unknown>('document.body ? document.body.textContent : ""'));
  } catch {
    return { hard: null, soft: null };
  }
  if (text.length === 0) return { hard: null, soft: null };
  return { hard: matchAny(HARD_WARNING_PATTERNS, text), soft: matchAny(SOFT_WARNING_PATTERNS, text) };
}

function matchAny(patterns: readonly RegExp[], text: string): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[0].slice(0, 120);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Swarm run
// ---------------------------------------------------------------------------

export interface SwarmRunSummary {
  lanes: number;
  activeLanes: number;
  watched: number;
  completed: number;
  failed: number;
  flagged: { laneIndex: number; sample: string } | null;
}

export interface SwarmRun {
  done: Promise<SwarmRunSummary>;
  /** Graceful stop: no further ledger writes, tabs closed unless kept. */
  stop(): void;
}

export interface SwarmDeps {
  lanes: SwarmLane[];
  courseUrl: string;
  /** Read-only course rescrape (navigates the scout tab, not a lane). */
  scrape: ScrapeFn;
  ledger: CompletionLedger;
  failed: FailedLedger;
  log: LogFn;
  maxPasses?: number;
  /** Builds the real per-lane Timekeeper (injected so tests stay hermetic). */
  makeSupervisor: (lane: SwarmLane) => LaneSupervisor;
  /** Closes a lane tab this run created. */
  closeTab?: (tabId: number) => Promise<void>;
  keepTabs?: boolean;
  probeWarning?: (cdp: LaneCdp) => Promise<WarningProbe>;
  warningPollMs?: number;
  /** Where the platform-warning evidence is persisted. */
  flagFile?: string;
}

export function startSwarm(deps: SwarmDeps): SwarmRun {
  const { log } = deps;
  const maxPasses = deps.maxPasses ?? 3;
  const pollMs = deps.warningPollMs ?? 30_000;
  const probe = deps.probeWarning ?? detectConcurrencyWarning;
  const runtimes = deps.lanes.map((lane) => ({ lane, supervisor: deps.makeSupervisor(lane) }));
  const outcomes: WatchOutcome[] = [];
  // Counted at record time: an interrupted video is neither a completion nor a
  // failed attempt (it never got its turn), so it must not show up as either.
  let completedCount = 0;
  let failedCount = 0;
  /**
   * Ids already WATCHED in this run (marked at watch time, not plan time, so a
   * video that never got its turn is still retryable). A plan may legitimately
   * repeat an id whose outcome was not terminal; this is the guard that keeps a
   * single run from playing the same video twice.
   */
  const attempted = new Set<string>();
  /** Requests stopped by a degrade/shutdown: their outcomes are not attempts. */
  const dropped = new Set<number>();
  /** laneIndex -> id currently being watched, so a drop can release it. */
  const inFlight = new Map<number, number>();
  let stopping = false;
  let flagged: { laneIndex: number; sample: string } | null = null;
  let active = runtimes.length;
  let watchdog: NodeJS.Timeout | null = null;

  const clearedWatchdog = (): void => {
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
  };

  const closeLaneTabs = (): void => {
    if (deps.keepTabs || !deps.closeTab) return;
    for (const { lane } of runtimes) {
      if (!lane.created) continue;
      void deps.closeTab(lane.tabId).catch((err: unknown) =>
        log('debug', `swarm: closing ${lane.label} tab failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  };

  const degrade = (laneIndex: number, matched: string): void => {
    if (flagged) return;
    flagged = { laneIndex, sample: matched };
    log('error', `swarm: PLATFORM CONCURRENCY WARNING detected on ${runtimes[laneIndex]?.lane.label ?? laneIndex} — "${matched}". Degrading to a single lane: the platform validates credited time against wall-clock and flags concurrent playback.`);
    try {
      nodeIo.writeAtomic(
        deps.flagFile ?? join(defaultDataDir(), 'swarm-flag.json'),
        JSON.stringify({ at: nodeIo.now(), laneIndex, matched }, null, 2),
      );
    } catch (err) {
      log('debug', `swarm: could not persist flag evidence: ${err instanceof Error ? err.message : String(err)}`);
    }
    active = 1;
    clearedWatchdog();
    // Stop every lane but the first; their in-flight watches resolve as failed
    // but must NOT count as attempts — those ids are released for re-planning.
    for (const rt of runtimes.slice(1)) {
      dropped.add(rt.lane.index);
      const id = inFlight.get(rt.lane.index);
      if (id !== undefined) attempted.delete(String(id));
      rt.supervisor.stop();
    }
  };

  /**
   * Read-only warning probe for one lane. Returns true when the run was
   * degraded (the caller must then stop handing work to other lanes).
   */
  const checkLane = async (laneIndex: number): Promise<boolean> => {
    if (flagged || stopping) return false;
    const rt = runtimes[laneIndex];
    if (!rt) return false;
    let result: WarningProbe;
    try {
      result = await probe(rt.lane.cdp);
    } catch {
      return false;
    }
    if (result.hard) {
      degrade(laneIndex, result.hard);
      return true;
    }
    if (result.soft) {
      log('warn', `swarm: possible concurrency wording on ${rt.lane.label} ("${result.soft}") — not proof, continuing`);
    }
    return false;
  };

  /**
   * Mid-video net for long lectures: a warning raised halfway through a
   * 40-minute video must not go unnoticed until the video ends.
   */
  const startWatchdog = (): void => {
    if (pollMs <= 0 || watchdog) return;
    watchdog = setInterval(() => {
      void (async () => {
        if (stopping || flagged) return;
        for (const rt of runtimes.slice(0, active)) {
          if (await checkLane(rt.lane.index)) return;
        }
      })();
    }, pollMs);
  };

  const recordOutcome = (laneLabel: string, outcome: WatchOutcome, interrupted: boolean): void => {
    outcomes.push(outcome);
    if (stopping || interrupted) {
      log('info', `swarm[${laneLabel}]: video ${outcome.resourceId} interrupted — will retry next pass`);
      return;
    }
    if (outcome.completed) {
      completedCount += 1;
      deps.ledger.record(outcome.resourceId, outcome.creditedDeltaSeconds);
      log('info', `swarm[${laneLabel}]: video ${outcome.resourceId} completed (credited ${outcome.creditedDeltaSeconds ?? '?'}s, ${outcome.wallSeconds.toFixed(0)}s wall, ${outcome.recoveries} recoveries)`);
    } else if (outcome.failed) {
      failedCount += 1;
      deps.failed.recordFailed(outcome.resourceId, 'recovery cap exceeded');
      log('warn', `swarm[${laneLabel}]: video ${outcome.resourceId} failed after ${outcome.recoveries} recoveries — will retry next pass`);
    } else {
      log('info', `swarm[${laneLabel}]: video ${outcome.resourceId} stopped before terminal state — will retry next pass`);
    }
  };

  const runLane = async (rt: { lane: SwarmLane; supervisor: LaneSupervisor }, slice: number[]): Promise<boolean> => {
    for (const id of slice) {
      if (stopping || dropped.has(rt.lane.index)) return true;
      let outcome: WatchOutcome;
      inFlight.set(rt.lane.index, id);
      attempted.add(String(id));
      try {
        outcome = await rt.supervisor.watch(id);
      } catch (err) {
        inFlight.delete(rt.lane.index);
        // Infrastructure failure, not a viewing attempt: release the id so a
        // surviving lane picks it up on the next pass.
        attempted.delete(String(id));
        log('error', `swarm[${rt.lane.label}]: lane died on video ${id} — ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }
      inFlight.delete(rt.lane.index);
      const interrupted = stopping || dropped.has(rt.lane.index);
      recordOutcome(rt.lane.label, outcome, interrupted);
      if (interrupted) return true;
      // Cheap, deterministic check: one read after each video lands.
      if (await checkLane(rt.lane.index)) return true;
    }
    return true;
  };

  const done = (async (): Promise<SwarmRunSummary> => {
    startWatchdog();
    const alive = new Set(runtimes.map((rt) => rt.lane.index));
    try {
      for (let pass = 1; pass <= maxPasses; pass++) {
        if (stopping) break;
        let planned;
        try {
          planned = await planNextPass({ courseUrl: deps.courseUrl, scrape: deps.scrape, ledger: deps.ledger, failed: deps.failed });
        } catch (err) {
          log('error', `swarm: pass ${pass}/${maxPasses} plan failed — will retry next pass: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        const fresh: number[] = [];
        for (const item of planned) {
          if (typeof item.resourceId !== 'number') {
            log('warn', `swarm: skipping item without numeric resourceId: ${item.url.slice(0, 100)}`);
            continue;
          }
          const key = String(item.resourceId);
          if (attempted.has(key)) {
            log('debug', `swarm: video ${key} was already watched this run — skipping (outcome was not terminal)`);
            continue;
          }
          fresh.push(item.resourceId);
        }
        if (fresh.length === 0) {
          log('info', `swarm: pass ${pass}/${maxPasses} — nothing left to watch, course complete`);
          break;
        }
        const usable = runtimes.filter((rt) => alive.has(rt.lane.index)).slice(0, active);
        if (usable.length === 0) {
          log('error', 'swarm: every lane died — stopping');
          break;
        }
        // Pass-start probe: catches a warning still showing from this or a
        // previous run before any lane is sent back to work.
        for (const rt of usable) {
          if (await checkLane(rt.lane.index)) break;
        }
        const survivors = runtimes.filter((rt) => alive.has(rt.lane.index)).slice(0, active);
        const slices = splitIntoLanes(fresh, survivors.length);
        log('info', `swarm: pass ${pass}/${maxPasses} — ${fresh.length} video(s) across ${survivors.length} lane(s): ${survivors.map((rt, i) => `${rt.lane.label}=[${slices[i]!.join(', ')}]`).join(' ')}`);
        const statuses = await Promise.all(survivors.map((rt, i) => runLane(rt, slices[i]!)));
        statuses.forEach((ok, i) => {
          if (!ok) {
            alive.delete(survivors[i]!.lane.index);
            log('error', `swarm: ${survivors[i]!.lane.label} removed from the rotation for the rest of this run`);
          }
        });
      }
    } finally {
      clearedWatchdog();
    }
    const summary: SwarmRunSummary = {
      lanes: runtimes.length,
      activeLanes: active,
      watched: outcomes.length,
      completed: completedCount,
      failed: failedCount,
      flagged,
    };
    log('info', swarmSummaryLine(summary));
    return summary;
  })();

  return {
    done,
    stop(): void {
      if (stopping) return;
      stopping = true;
      clearedWatchdog();
      for (const { supervisor } of runtimes) supervisor.stop();
      closeLaneTabs();
    },
  };
}

export function swarmSummaryLine(summary: SwarmRunSummary): string {
  const flag = summary.flagged ? ` · FLAGGED by platform on lane ${summary.flagged.laneIndex} ("${summary.flagged.sample}")` : '';
  return `swarm summary: ${summary.lanes} lane(s) (${summary.activeLanes} active), ${summary.watched} watched, ${summary.completed} completed, ${summary.failed} failed${flag}`;
}
