import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { Action, ElementTable } from '@c4g/protocol';
import { Timekeeper, type TickOutcome, type TimekeeperDeps } from '../src/timekeeper.js';
import type { PlayerState } from '../src/platforms/moodle-video.js';

const tmp = mkdtempSync(join(tmpdir(), 'c4g-tk-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const TABLE: ElementTable = {
  url: 'https://lms.example.com/mod/fsresource/view.php?id=101',
  title: 'video',
  capturedAt: Date.now(),
  elements: [
    { index: 5, role: 'button', name: '继续播放', tag: 'button', rect: { x: 0, y: 0, w: 50, h: 20 } },
    { index: 6, role: 'button', name: '确定', tag: 'button', rect: { x: 0, y: 30, w: 50, h: 20 } },
  ],
};

interface Harness {
  deps: TimekeeperDeps;
  navigations: string[];
  actions: Action[];
  evals: string[];
  logs: string[];
  ringSamples: Array<{ t: number; m: string; u: string }>;
  setUrl(url: string): void;
  setPlayer(p: Partial<PlayerState>): void;
}

function makeHarness(playerOverrides: Partial<PlayerState> = {}): Harness {
  const videoUrl = 'https://lms.example.com/mod/fsresource/view.php?id=101';
  let url = videoUrl;
  const player: PlayerState = {
    playing: true,
    currentTime: 10,
    duration: 6000,
    rate: 1,
    heartbeatTs: Date.now(),
    totaltime: 10,
    progress: 0,
    url: videoUrl,
    ...playerOverrides,
  };
  const h: Harness = {
    navigations: [],
    actions: [],
    evals: [],
    logs: [],
    ringSamples: [],
    setUrl(u) {
      url = u;
    },
    setPlayer(p) {
      Object.assign(player, p);
    },
    deps: {
      tabId: 7,
      cdp: {
        url: async () => url,
        navigate: async (u) => {
          url = u.startsWith('http') ? u : `https://lms.example.com${u}`;
          h.navigations.push(u);
        },
        evaluate: async <T,>(expr: string): Promise<T> => {
          h.evals.push(expr);
          if (/playbackRate/.test(expr)) player.rate = 1;
          if (/__c4gXhrRing/.test(expr)) {
            if (/XMLHttpRequest/.test(expr)) return 'installed' as T; // RING_SCRIPT install
            return JSON.stringify(h.ringSamples) as T; // readRing
          }
          return true as T;
        },
      },
      ws: {
        snapshot: async () => ({ table: TABLE }),
        act: async (_tabId, action) => {
          h.actions.push(action);
          if (action.op === 'click' && action.index === 5) player.playing = true;
          return { ok: true, url };
        },
      },
      jev: {
        decide: async (goal) => {
          h.logs.push(`decide:${goal.slice(0, 30)}`);
          return { operation: 'CLICK', targetIndex: 5, confidence: 0.9, dryRun: true };
        },
      },
      platform: {
        isVideoPage: (u) => u.includes('/mod/fsresource/view.php'),
        installHeartbeatHook: async () => {},
        readPlayerState: async () => ({ ...player, url }),
        scrapeCourseVideoIds: async () => [101, 102],
      },
      log: (level, msg) => {
        h.logs.push(`${level}:${msg.slice(0, 80)}`);
      },
      dataFile: join(tmp, `queue-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    },
  };
  return h;
}

describe('Timekeeper', () => {
  it('navigates to the next queued video when not on a video page', async () => {
    const h = makeHarness();
    h.setUrl('https://lms.example.com/course/view.php?id=42');
    const tk = new Timekeeper(h.deps);
    tk.setQueue([101, 102]);
    const outcome = await tk.tick();
    assert.deepEqual(outcome, { kind: 'navigate', id: 101 });
    assert.deepEqual(h.navigations, ['/mod/fsresource/view.php?id=101']);
    tk.stop();
  });

  it('reports idle when the queue is empty and not on a video page', async () => {
    const h = makeHarness();
    h.setUrl('https://lms.example.com/course/view.php?id=42');
    const tk = new Timekeeper(h.deps);
    const outcome = await tk.tick();
    assert.equal(outcome.kind, 'idle');
    tk.stop();
  });

  it('waits one tick then resumes paused playback via Jev click', async () => {
    const h = makeHarness({ playing: false });
    const tk = new Timekeeper(h.deps);
    const first = await tk.tick();
    assert.equal(first.kind, 'none'); // first paused tick = grace
    const second = await tk.tick();
    assert.equal(second.kind, 'resume');
    assert.deepEqual(h.actions, [{ op: 'click', index: 5 }]);
    assert.equal(h.logs.filter((l) => l.startsWith('decide:')).length, 1);
    tk.stop();
  });

  it('warns once when server totaltime stalls for 4 ticks while playing', async () => {
    const h = makeHarness({ playing: true, totaltime: 100, currentTime: 100, duration: 6000 });
    const tk = new Timekeeper(h.deps);
    const outcomes: TickOutcome[] = [];
    for (let i = 0; i < 6; i++) outcomes.push(await tk.tick());
    // ticks 2..5 keep totaltime identical → the 4th identical tick warns
    assert.equal(outcomes.filter((o) => o.kind === 'stall-warned').length, 1);
    assert.ok(h.logs.some((l) => l.startsWith('warn:timekeeper: server totaltime')));
    tk.stop();
  });

  it('marks a finished video done and chains to the next one', async () => {
    const h = makeHarness({ playing: false, currentTime: 299, duration: 300, totaltime: 299, progress: 99 });
    const tk = new Timekeeper(h.deps);
    tk.setQueue([101, 102]);
    const first = await tk.tick(); // paused tick 1
    assert.equal(first.kind, 'none');
    const second = await tk.tick(); // resume attempt → click 继续播放 sets playing=true in fake ws.act
    assert.equal(second.kind, 'resume');
    const third = await tk.tick();
    assert.equal(third.kind, 'navigate');
    assert.deepEqual(h.navigations, ['/mod/fsresource/view.php?id=102']);
    const persisted = JSON.parse(readFileSync(h.deps.dataFile, 'utf8')) as { queue: number[]; done: number[] };
    assert.deepEqual(persisted.done, [101]);
    tk.stop();
  });

  it('restores 1x playback when acceleration is detected', async () => {
    const h = makeHarness({ rate: 4 });
    const tk = new Timekeeper(h.deps);
    await tk.tick();
    assert.ok(h.evals.some((e) => /playbackRate = 1/.test(e)));
    tk.stop();
  });

  it('detects a generic heartbeat candidate once on platforms without a known pattern', async () => {
    const h = makeHarness({ playing: true, totaltime: 200, currentTime: 200 });
    const base = 1_700_000_000_000;
    h.ringSamples = [0, 15_000, 30_000, 45_000].map((delta, i) => ({
      t: base + delta,
      m: 'POST',
      u: `https://lms.example.com/api/progress?token=${i}`, // same pathname, varying query
    }));
    const tk = new Timekeeper(h.deps);
    await tk.tick();
    await tk.tick();
    const candidateLogs = h.logs.filter((l) => l.includes('generic heartbeat candidate'));
    assert.equal(candidateLogs.length, 1, candidateLogs.join('\n'));
    assert.ok(candidateLogs[0].includes('POST /api/progress'));
    assert.ok(candidateLogs[0].includes('every 15.0s'));
    // Observation only: the ring never issues requests of its own.
    assert.ok(!h.evals.some((e) => /setRequestHeader|\.open\(/.test(e)));
    tk.stop();
  });

  it('NEVER contains heartbeat-forging or acceleration code paths (source guard)', async () => {
    const { readFileSync: rf } = await import('node:fs');
    const tkSource = rf(new URL('../src/timekeeper.ts', import.meta.url), 'utf8');
    assert.ok(!/XMLHttpRequest|\.ajax\(|fetch\(/.test(tkSource), 'timekeeper must not issue HTTP requests');
    const rateAssignments = tkSource.match(/playbackRate\s*=\s*[^;\s][^;]*/g) ?? [];
    for (const a of rateAssignments) {
      assert.match(a, /=\s*1\s*$/, `timekeeper must never set playbackRate above 1: ${a.trim()}`);
    }
    const solverish = rf(new URL('../src/quiz-loop.ts', import.meta.url), 'utf8');
    assert.ok(!/XMLHttpRequest|\.ajax\(|fetch\(/.test(solverish), 'quiz loop must not issue raw HTTP');
  });
});
