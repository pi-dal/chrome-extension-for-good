import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Action, ElementTable, Rect } from '@c4g/protocol';
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
}

export type TickOutcome =
  | { kind: 'navigate'; id: number }
  | { kind: 'resume'; action: string }
  | { kind: 'resume-blocked' }
  | { kind: 'stall-warned' }
  | { kind: 'none'; detail: string }
  | { kind: 'idle'; detail: string };

const GOAL_RESUME =
  'Resume the video playback: dismiss any blocking dialog, then click the play button or a continue/confirm button.';

interface PersistedQueue {
  queue: number[];
  done: number[];
}

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
 *   - verifies server-credited totaltime keeps advancing (warn only),
 *   - chains to the next queued video when one finishes.
 */
export class Timekeeper {
  private queue: number[] = [];
  private readonly done = new Set<number>();
  private consecutiveNotPlaying = 0;
  private lastTotalTime: number | null = null;
  private ticksAtSameTotalTime = 0;
  private stallWarned = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly dataFile: string;
  private running = false;
  private ringInstalled = false;
  private genericHeartbeatReported = false;

  constructor(private readonly deps: TimekeeperDeps) {
    this.dataFile = deps.dataFile ?? defaultDataFile();
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
    this.queue = this.queue.filter((id) => !this.done.has(id));
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
    this.deps.log('info', 'timekeeper: stopped');
  }

  // ---------------------------------------------------------------------- tick

  /** One supervision step. Public for tests; start() drives it on an interval. */
  async tick(): Promise<TickOutcome> {
    const { cdp, ws, jev, platform, log, tabId } = this.deps;
    const url = await cdp.url();

    // Not on a video page → move to the next queued video.
    if (!platform.isVideoPage(url)) {
      const next = this.queue.find((id) => !this.done.has(id));
      if (next === undefined) {
        return { kind: 'idle', detail: 'queue empty — all videos done' };
      }
      log('info', `timekeeper: navigating to video ${next}`);
      await cdp.navigate(videoUrl(next));
      await platform.installHeartbeatHook(cdp);
      this.resetPlaybackWatch();
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
      const { table } = await ws.snapshot(tabId, { quizOnly: false });
      const decision: JevDecision = await jev.decide(GOAL_RESUME, table);
      if (decision.operation === 'CLICK' && decision.targetIndex !== undefined) {
        const el = table.elements.find((e) => e.index === decision.targetIndex);
        const action: Action = { op: 'click', index: decision.targetIndex };
        log('info', `timekeeper: resuming via [${decision.targetIndex}] "${el?.name.slice(0, 60) ?? '?'}"`);
        await ws.act(tabId, action);
        this.consecutiveNotPlaying = 0;
        return { kind: 'resume', action: `click #${decision.targetIndex}` };
      }
      log(
        'warn',
        `timekeeper: paused but no actionable element (${decision.operation}) — table excerpt:\n` +
          table.elements
            .slice(0, 12)
            .map((e) => `  [${e.index}] ${e.role} "${e.name.slice(0, 50)}"`)
            .join('\n'),
      );
      this.consecutiveNotPlaying = 0;
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
      if (this.lastTotalTime !== null && state.totaltime === this.lastTotalTime) {
        this.ticksAtSameTotalTime++;
      } else {
        this.ticksAtSameTotalTime = 0;
        this.stallWarned = false;
      }
      this.lastTotalTime = state.totaltime;
      if (this.ticksAtSameTotalTime >= 4 && !this.stallWarned) {
        this.stallWarned = true;
        log(
          'warn',
          `timekeeper: server totaltime (${state.totaltime}s) unchanged across 4 ticks while playing — ` +
            'server may not be crediting time. Investigate manually; do NOT forge heartbeats.',
        );
        return { kind: 'stall-warned' };
      }
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
      const next = this.queue.find((id) => !this.done.has(id));
      if (next === undefined) {
        log('info', 'timekeeper: all videos done 🎉');
        this.stop();
        return { kind: 'idle', detail: 'queue drained' };
      }
      await cdp.navigate(videoUrl(next));
      await platform.installHeartbeatHook(cdp);
      this.resetPlaybackWatch();
      return { kind: 'navigate', id: next };
    }

    return { kind: 'none', detail: `playing ${state.currentTime.toFixed(0)}/${state.duration.toFixed(0)}s totaltime=${state.totaltime ?? '?'}` };
  }

  private resetPlaybackWatch(): void {
    this.consecutiveNotPlaying = 0;
    this.lastTotalTime = null;
    this.ticksAtSameTotalTime = 0;
    this.stallWarned = false;
    // A new page is a fresh JS world: the ring buffer must be re-installed.
    this.ringInstalled = false;
    this.genericHeartbeatReported = false;
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
