import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rect } from '@c4g/protocol';
import type { JevDecision, JeDriver } from './jev.js';
import type { LogFn } from './log.js';
import type { PlayerState } from './platforms/moodle-video.js';
import { installHeartbeatHook, isVideoPage } from './platforms/moodle-video.js';
import { detectHeartbeat, installRingBuffer, readRing } from './observe.js';
import type { WsBridge } from './ws-server.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface TimekeeperDeps {
  tabId: number;
  cdp: {
    url(): Promise<string>;
    navigate(url: string): Promise<void>;
    evaluate<T = unknown>(expression: string): Promise<T>;
  };
  ws: Pick<WsBridge, 'snapshot' | 'act'>;
  jev: Pick<JeDriver, 'decide'>;
  platform: {
    isVideoPage(url: string): boolean;
    installHeartbeatHook(tab: TimekeeperDeps['cdp']): Promise<void>;
    readPlayerState(tab: TimekeeperDeps['cdp']): Promise<PlayerState>;
    scrapeCourseVideoIds(tab: TimekeeperDeps['cdp']): Promise<number[]>;
    /** Known heartbeat URL fragment — fast path; generic detection is skipped. */
    heartbeatUrlPattern?: string;
  };
  log: LogFn;
  intervalMs?: number;
  dataFile?: string;
  /** Stall-recovery attempts per video before giving up (default 3). */
  maxRecovery?: number;
  /** Give up on a video after this many consecutive never-played ticks (review F3). */
  maxNotPlayingTicks?: number;
}

/** Outcome of supervising one video to a terminal state. */
export interface WatchOutcome {
  resourceId: string | number; // fsresourceid from playerdata
  completed: boolean; // player reached end AND server totaltime confirms final credit
  failed: boolean; // exceeded maxRecovery recoveries; gave up on this video
  wallSeconds: number; // wall-clock seconds spent on this video
  creditedDeltaSeconds: number | null; // server totaltime delta observed; null if unverifiable
  recoveries: number; // stall-recovery attempts used
}

export type TickOutcome =
  | { kind: 'navigate'; id: number }
  | { kind: 'resume'; action: string }
  | { kind: 'resume-blocked' }
  | { kind: 'recover'; stage: 'in-page' | 'reload'; attempt: number }
  | { kind: 'abandon'; id: number }
  | { kind: 'none'; detail: string }
  | { kind: 'idle'; detail: string };

const GOAL_RESUME =
  'Resume the video playback: dismiss any blocking dialog, then click the play button or a continue/confirm button.';

interface PersistedQueue {
  queue: number[];
  done: number[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Ticks to observe after a recovery attempt before re-judging the stall. */
const GRACE_TICKS = 2;

function defaultDataFile(): string {
  return resolve(HERE, '..', 'data', 'queue.json');
}

function videoUrl(id: number): string {
  return `/mod/fsresource/view.php?id=${id}`;
}

function idFromUrl(url: string): number | null {
  const m = /view\.php\?id=(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * Unattended real-time playback supervisor for Moodle-based LMS video pages.
 *
 * DESIGN CONSTRAINTS (see platforms/moodle-video.ts): several LMS servers cap
 * credited time against the real wall-clock delta and reject concurrent
 * videos, so this supervisor NEVER forges heartbeats, NEVER accelerates
 * playback, and NEVER runs videos concurrently. It only:
 *   - keeps the current video genuinely playing at 1x (auto-dismiss dialogs
 *     via snapshot + Jev),
 *   - on server-credit stalls: attempts bounded recovery (in-page resume,
 *     then page reload + resume) — never by forging requests or speeding up
 *     playback — and gives up on the video after maxRecovery attempts,
 *   - verifies server-credited totaltime keeps advancing (read-back only),
 *   - chains to the next queued video when one finishes.
 */
export class Timekeeper {
  private queue: number[] = [];
  private readonly done = new Set<number>();
  private readonly gaveUp = new Set<number>();
  private consecutiveNotPlaying = 0;
  private lastTotalTime: number | null = null;
  private ticksAtSameTotalTime = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly dataFile: string;
  private running = false;
  private ringInstalled = false;
  private genericHeartbeatReported = false;
  // --- stall recovery + per-video accounting
  private stallRecoveries = 0;
  private graceTicks = 0;
  private videoStartedAt: number | null = null;
  private firstCredited: number | null = null;
  private lastCredited: number | null = null;
  private readonly pending = new Map<number, Deferred<WatchOutcome>>();
  private readonly summary: WatchOutcome[] = [];

  constructor(private readonly deps: TimekeeperDeps) {
    this.dataFile = deps.dataFile ?? defaultDataFile();
  }

  private get maxRecovery(): number {
    return this.deps.maxRecovery ?? 3;
  }

  private get maxNotPlayingTicks(): number {
    return this.deps.maxNotPlayingTicks ?? 6;
  }

  // ---------------------------------------------------------------- persistence

  private loadPersisted(): void {
    try {
      const raw = readFileSync(this.dataFile, 'utf8');
      const parsed = JSON.parse(raw) as PersistedQueue;
      if (Array.isArray(parsed.queue)) {
        // Dedup on merge — repeated setQueue() must not grow the queue.
        this.queue = Array.from(new Set([...this.queue, ...parsed.queue.filter((n) => !this.done.has(n))]));
      }
      if (Array.isArray(parsed.done)) for (const id of parsed.done) this.done.add(id);
    } catch {
      // first run or unreadable — fine
    }
  }

  private persist(): void {
    const payload: PersistedQueue = { queue: [...this.queue], done: [...this.done] };
    mkdirSync(dirname(this.dataFile), { recursive: true });
    writeFileSync(this.dataFile, JSON.stringify(payload, null, 2));
  }

  // -------------------------------------------------------------------- control

  /** Set the playback queue and persist it (no timers started). */
  setQueue(queue: number[]): void {
    this.queue = [...queue];
    this.loadPersisted();
    this.queue = this.queue.filter((id) => !this.done.has(id) && !this.gaveUp.has(id));
    this.persist();
  }

  /** Start supervising; queue is a list of fsresourceids in playback order. */
  start(queue: number[]): void {
    this.setQueue(queue);
    this.running = true;
    const interval = this.deps.intervalMs ?? 20_000;
    this.deps.log('info', `timekeeper: supervising ${this.queue.length} video(s): [${this.queue.join(', ')}]`);
    void this.tick().catch((err: unknown) => {
      this.deps.log('error', `timekeeper first tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }); // first tick immediately — must not become an unhandled rejection
    this.timer = setInterval(() => {
      if (!this.running) return;
      void this.tick().catch((err: unknown) => {
        this.deps.log('error', `timekeeper tick failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, interval);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Interrupted watches resolve as failed so no caller promise hangs.
    for (const [id, d] of this.pending) {
      const outcome: WatchOutcome = {
        resourceId: id,
        completed: false,
        failed: true,
        wallSeconds: this.videoStartedAt ? Math.round((Date.now() - this.videoStartedAt) / 1000) : 0,
        creditedDeltaSeconds: null,
        recoveries: this.stallRecoveries,
      };
      this.summary.push(outcome);
      d.resolve(outcome);
    }
    this.pending.clear();
    this.deps.log('info', 'timekeeper: stopped');
  }

  // ------------------------------------------------------------- per-video API

  /**
   * Supervise one video until it reaches a terminal state and resolve with its
   * WatchOutcome. Safe to call for an id that already finished (resolves
   * immediately as completed). Does not reject — failures resolve with
   * failed=true after maxRecovery exhausted recovery attempts.
   */
  async watch(id: number): Promise<WatchOutcome> {
    // A planner retry may re-queue a previously abandoned id (failed.json cap
    // not yet exhausted). Re-arm it — abandon is per-attempt state; without
    // this, start()'s gaveUp queue filter would silently drop the id and this
    // promise would never resolve.
    this.gaveUp.delete(id);
    if (this.done.has(id)) {
      const outcome: WatchOutcome = {
        resourceId: id,
        completed: true,
        failed: false,
        wallSeconds: 0,
        creditedDeltaSeconds: null,
        recoveries: 0,
      };
      this.summary.push(outcome);
      this.deps.log('info', `timekeeper: ${id} completed credited=?/recovered=0 (already done)`);
      return outcome;
    }
    const existing = this.pending.get(id);
    if (existing) return existing.promise;
    const d = deferred<WatchOutcome>();
    this.pending.set(id, d);
    if (!this.running) {
      this.start([id, ...this.queue]);
    } else {
      this.queue = Array.from(new Set([id, ...this.queue]));
      this.persist();
      void this.tick().catch((err: unknown) => {
        this.deps.log('error', `timekeeper tick failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return d.promise;
  }

  /** All outcomes recorded this process, in completion order. */
  runSummary(): WatchOutcome[] {
    return [...this.summary];
  }

  // ---------------------------------------------------------------------- tick

  /** One supervision step. Public for tests; start() drives it on an interval. */
  async tick(): Promise<TickOutcome> {
    const { cdp, platform, log } = this.deps;
    const url = await cdp.url();

    // Not on a video page → move to the next queued video.
    if (!platform.isVideoPage(url)) {
      const next = this.queue.find((id) => !this.done.has(id) && !this.gaveUp.has(id));
      if (next === undefined) {
        return { kind: 'idle', detail: 'queue empty — all videos done' };
      }
      log('info', `timekeeper: navigating to video ${next}`);
      await cdp.navigate(videoUrl(next));
      await platform.installHeartbeatHook(cdp);
      this.resetPlaybackWatch(true);
      return { kind: 'navigate', id: next };
    }

    const state = await platform.readPlayerState(cdp);
    const currentId = idFromUrl(url);

    // Anti-acceleration guard: never allow >1x playback on our watch.
    if (state.rate > 1.01) {
      log('warn', `timekeeper: playbackRate ${state.rate} detected — restoring 1x (acceleration is not credited by the server)`);
      await cdp.evaluate('(() => { const v = document.querySelector("video"); if (v) v.playbackRate = 1; return true; })()');
    }

    // Stalled playback → dismiss dialogs / press play via snapshot + Jev.
    if (!state.playing) {
      this.consecutiveNotPlaying++;
      if (this.consecutiveNotPlaying < 2) {
        return { kind: 'none', detail: `paused (tick ${this.consecutiveNotPlaying})` };
      }
      const resumed = await this.resumeAttempt();
      if (resumed) {
        this.consecutiveNotPlaying = 0;
        return { kind: 'resume', action: 'jev click' };
      }
      // F3 (review): a page that never starts playing must not block the run
      // forever — the stall path below never fires while paused (no totaltime
      // progression to compare), so enforce its own bound here. The counter is
      // deliberately NOT reset on resume-blocked ticks.
      if (this.consecutiveNotPlaying >= this.maxNotPlayingTicks) {
        const id = idFromUrl(url);
        if (id !== null) {
          return await this.abandonVideo(id, `never started playing after ${this.consecutiveNotPlaying} ticks`);
        }
        // Unattributable page (no parseable id): keep trying, cannot record.
        this.consecutiveNotPlaying = 0;
      }
      return { kind: 'resume-blocked' };
    }

    // Playing — watch server-credited time progression.
    this.consecutiveNotPlaying = 0;
    // Generic heartbeat observability (design §4.4): platforms without a known
    // heartbeat pattern get passive frequency detection over the XHR ring.
    // Strictly read-only — nothing is ever replayed or forged.
    if (!this.deps.platform.heartbeatUrlPattern) {
      await this.observeGenericHeartbeat();
    }
    if (state.totaltime !== null) {
      if (this.firstCredited === null) this.firstCredited = state.totaltime;
      this.lastCredited = state.totaltime;
      if (this.lastTotalTime !== null && state.totaltime === this.lastTotalTime) {
        this.ticksAtSameTotalTime++;
      } else {
        this.ticksAtSameTotalTime = 0;
      }
      this.lastTotalTime = state.totaltime;
    }
    if (this.videoStartedAt === null) this.videoStartedAt = Date.now();

    // Server-credit stall → bounded recovery (never by forging or speeding up).
    // Requires a parseable video id for per-video accounting; otherwise fall through.
    if (state.totaltime !== null && currentId !== null && this.ticksAtSameTotalTime >= 4) {
      if (this.graceTicks > 0) {
        this.graceTicks--;
        return { kind: 'none', detail: `recovery grace (${this.graceTicks} ticks left)` };
      }
      if (this.stallRecoveries >= this.maxRecovery) {
        // Give up on this video: resolve as failed and move on (no throw).
        const id = currentId;
        return await this.abandonVideo(
          id,
          `still stalled after ${this.stallRecoveries} recovery attempts — server may not be crediting time; investigate manually`,
        );
      }
      this.stallRecoveries++;
      const stage: 'in-page' | 'reload' = this.stallRecoveries === 1 ? 'in-page' : 'reload';
      if (stage === 'in-page') {
        log('warn', `timekeeper: totaltime stalled at ${state.totaltime}s — recovery #${this.stallRecoveries}: in-page resume attempt`);
        await this.resumeAttempt();
      } else {
        log('warn', `timekeeper: totaltime stalled at ${state.totaltime}s — recovery #${this.stallRecoveries}: reloading video page`);
        const currentUrl = await cdp.url();
        await cdp.navigate(currentUrl);
        await platform.installHeartbeatHook(cdp);
        this.resetPlaybackWatch(false);
      }
      this.ticksAtSameTotalTime = 0;
      this.graceTicks = GRACE_TICKS;
      return { kind: 'recover', stage, attempt: this.stallRecoveries };
    }

    // Finished → mark done, chain to next.
    const finished =
      state.duration > 0 &&
      (state.currentTime >= state.duration - 3 ||
        (state.progress !== null && state.progress >= 99) ||
        (state.totaltime !== null && state.totaltime >= state.duration - 3));
    if (finished && currentId !== null) {
      log('info', `timekeeper: video ${currentId} finished (currentTime=${state.currentTime.toFixed(0)}s/${state.duration.toFixed(0)}s, totaltime=${state.totaltime ?? '?'})`);
      this.done.add(currentId);
      this.queue = this.queue.filter((id) => id !== currentId);
      this.persist();
      this.recordOutcome(currentId, { completed: true, failed: false });
      const next = this.queue.find((id) => !this.done.has(id) && !this.gaveUp.has(id));
      if (next === undefined) {
        log('info', 'timekeeper: all videos done 🎉');
        this.stop();
        return { kind: 'idle', detail: 'queue drained' };
      }
      await cdp.navigate(videoUrl(next));
      await platform.installHeartbeatHook(cdp);
      this.resetPlaybackWatch(true);
      return { kind: 'navigate', id: next };
    }

    return { kind: 'none', detail: `playing ${state.currentTime.toFixed(0)}/${state.duration.toFixed(0)}s totaltime=${state.totaltime ?? '?'}` };
  }

  private resetPlaybackWatch(newVideo: boolean): void {
    this.consecutiveNotPlaying = 0;
    this.lastTotalTime = null;
    this.ticksAtSameTotalTime = 0;
    this.graceTicks = 0;
    this.firstCredited = null;
    this.lastCredited = null;
    this.videoStartedAt = Date.now();
    if (newVideo) this.stallRecoveries = 0;
    // A new page is a fresh JS world: the ring buffer must be re-installed.
    this.ringInstalled = false;
    this.genericHeartbeatReported = false;
  }

  /** Give up on one video: mark failed, resolve its watch, advance or stop. */
  private async abandonVideo(id: number, reason: string): Promise<TickOutcome> {
    const { cdp, platform, log } = this.deps;
    log('error', `timekeeper: video ${id} giving up — ${reason}. do NOT forge heartbeats.`);
    this.gaveUp.add(id);
    this.queue = this.queue.filter((qid) => qid !== id);
    this.persist();
    this.recordOutcome(id, { completed: false, failed: true });
    const next = this.queue.find((qid) => !this.done.has(qid) && !this.gaveUp.has(qid));
    if (next === undefined) {
      this.stop();
      return { kind: 'idle', detail: 'queue drained (with failures)' };
    }
    await cdp.navigate(videoUrl(next));
    await platform.installHeartbeatHook(cdp);
    this.resetPlaybackWatch(true);
    return { kind: 'abandon', id };
  }

  /**
   * One resume attempt through the existing trusted path: snapshot + Jev
   * decide + act click. Returns whether an actionable element was clicked.
   */
  private async resumeAttempt(): Promise<boolean> {
    const { tabId, ws, jev, log } = this.deps;
    const { table } = await ws.snapshot(tabId, { quizOnly: false });
    const decision: JevDecision = await jev.decide(GOAL_RESUME, table);
    if (decision.operation === 'CLICK' && decision.targetIndex !== undefined) {
      const el = table.elements.find((e) => e.index === decision.targetIndex);
      log('info', `timekeeper: resuming via [${decision.targetIndex}] "${el?.name.slice(0, 60) ?? '?'}"`);
      await ws.act(tabId, { op: 'click', index: decision.targetIndex });
      return true;
    }
    log(
      'warn',
      `timekeeper: paused but no actionable element (${decision.operation}) — table excerpt:\n` +
        table.elements
          .slice(0, 12)
          .map((e) => `  [${e.index}] ${e.role} "${e.name.slice(0, 50)}"`)
          .join('\n'),
    );
    return false;
  }

  /** Build, log, record, and deliver the terminal outcome for a video. */
  private recordOutcome(id: number, terminal: { completed: boolean; failed: boolean }): void {
    const outcome: WatchOutcome = {
      resourceId: id,
      completed: terminal.completed,
      failed: terminal.failed,
      wallSeconds: this.videoStartedAt !== null ? Math.round((Date.now() - this.videoStartedAt) / 1000) : 0,
      creditedDeltaSeconds:
        this.firstCredited !== null && this.lastCredited !== null ? this.lastCredited - this.firstCredited : null,
      recoveries: this.stallRecoveries,
    };
    this.summary.push(outcome);
    this.deps.log(
      terminal.failed ? 'error' : 'info',
      `timekeeper: ${id} ${terminal.failed ? 'failed' : 'completed'} ` +
        `credited=${outcome.creditedDeltaSeconds ?? '?'}/recovered=${outcome.recoveries}`,
    );
    const d = this.pending.get(id);
    if (d) {
      this.pending.delete(id);
      d.resolve(outcome);
    }
  }

  /**
   * Install (once per page) and read the XHR ring; report the first regular
   * periodic request as a heartbeat candidate. Observation only.
   */
  private async observeGenericHeartbeat(): Promise<void> {
    const { cdp, log } = this.deps;
    if (!this.ringInstalled) {
      try {
        await installRingBuffer(cdp);
        this.ringInstalled = true;
      } catch (err) {
        log('debug', `timekeeper: xhr ring install failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    if (this.genericHeartbeatReported) return;
    try {
      const samples = await readRing(cdp);
      const [candidate] = detectHeartbeat(samples);
      if (candidate) {
        this.genericHeartbeatReported = true;
        log(
          'info',
          `timekeeper: generic heartbeat candidate ${candidate.method} ${candidate.path} ` +
            `every ${(candidate.periodMs / 1000).toFixed(1)}s (${candidate.samples} samples, cv ${candidate.cv.toFixed(2)}) — observation only`,
        );
      }
    } catch (err) {
      log('debug', `timekeeper: heartbeat detection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export type { Rect };
