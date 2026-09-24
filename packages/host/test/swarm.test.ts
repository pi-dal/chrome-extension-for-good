import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { CompletionLedger, FailedLedger, type ScrapeItem } from '../src/batch.js';
import {
  applyLanePolicy,
  clampProbeText,
  detectConcurrencyWarning,
  laneKeepAliveScript,
  laneMarker,
  laneMarkerUrl,
  lanePolicyScript,
  planSwarmLanes,
  provisionLanes,
  splitIntoLanes,
  startSwarm,
  swarmNonce,
  swarmSummaryLine,
  type LaneCdp,
  type LaneSupervisor,
  type SwarmLane,
} from '../src/swarm.js';
import type { LogFn } from '../src/log.js';
import type { WatchOutcome } from '../src/timekeeper.js';

const tmp = mkdtempSync(join(tmpdir(), 'c4g-swarm-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Bounded wait: fails the test instead of hanging when a condition never holds. */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

function logs(): { lines: string[]; log: LogFn } {
  const lines: string[] = [];
  const log: LogFn = (level, msg) => {
    lines.push(`${level}:${msg}`);
  };
  return { lines, log };
}

function outcome(id: number, over: Partial<WatchOutcome> = {}): WatchOutcome {
  return { resourceId: id, completed: true, failed: false, wallSeconds: 30, creditedDeltaSeconds: 300, recoveries: 0, ...over };
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('swarm lane math', () => {
  it('clamps the requested lane count, warns above the cap and in the risky zone', () => {
    const l = logs();
    assert.equal(planSwarmLanes(2, l.log), 2);
    assert.equal(planSwarmLanes(99, l.log), 4);
    assert.equal(planSwarmLanes(0, l.log), 1);
    assert.equal(planSwarmLanes(Number.NaN, l.log), 1);
    assert.ok(l.lines.some((line) => line.includes('capped at 4')));
    assert.ok(l.lines.some((line) => line.includes('禁止同时观看多个视频')));
  });

  it('builds per-run unique lane markers and park URLs', () => {
    assert.notEqual(swarmNonce(1), swarmNonce(2));
    assert.equal(laneMarker('n1', 2), 'c4g_lane=n1-2');
    assert.equal(
      laneMarkerUrl('https://lms.example.com/course/view.php?id=42', 'c4g_lane=n1-2'),
      'https://lms.example.com/course/view.php?id=42&c4g_lane=n1-2',
    );
    // non-URL input falls back to string concatenation
    assert.equal(laneMarkerUrl('/course/view.php', laneMarker('n1', 0)), '/course/view.php?c4g_lane=n1-0');
    assert.equal(laneMarkerUrl('/course/view.php?a=1', laneMarker('n1', 0)), '/course/view.php?a=1&c4g_lane=n1-0');
  });

  it('partitions the queue round-robin without dropping or duplicating ids', () => {
    assert.deepEqual(splitIntoLanes([1, 2, 3, 4, 5], 2), [[1, 3, 5], [2, 4]]);
    assert.deepEqual(splitIntoLanes([1], 3), [[1], [], []]);
    assert.deepEqual(splitIntoLanes([], 2), [[], []]);
    assert.deepEqual(splitIntoLanes([1, 2], 0), []);
    const all = splitIntoLanes([1, 2, 3, 4, 5, 6, 7], 4).flat();
    assert.deepEqual(all.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('swarm lane keep-alive', () => {
  it('spoofs visibility/focus and holds a per-lane Web Lock', () => {
    const src = laneKeepAliveScript('lane1');
    assert.match(src, /__c4gSwarm/);
    assert.match(src, /'lane1'|"lane1"/);
    assert.match(src, /spoof\('hidden', false\)/);
    assert.match(src, /spoof\('visibilityState', 'visible'\)/);
    assert.match(src, /hasFocus/);
    assert.match(src, /navigator\.locks\.request\("c4g-swarm-lane1"/);
    // idempotent guard: re-injection after a navigation is a no-op
    assert.match(src, /if \(window\.__c4gSwarm\) return true;/);
  });

  it('policy script pins the configured rate and never touches the network', () => {
    const muted = lanePolicyScript({ mute: true, rate: 1 });
    assert.match(muted, /if \(true\) v\.muted = true;/);
    assert.match(lanePolicyScript({ mute: false, rate: 1 }), /if \(false\) v\.muted = true;/);
    for (const src of [muted, lanePolicyScript({ mute: false, rate: 1 })]) {
      assert.match(src, /if \(Math\.abs\(v\.playbackRate - 1\) > 0\.01\) v\.playbackRate = 1;/);
      assert.ok(!/XMLHttpRequest|fetch\(|_set_time/.test(src));
    }
    // the operator's measured choice flows through, clamped to the sane band
    assert.match(lanePolicyScript({ mute: false, rate: 2 }), /v\.playbackRate = 2;/);
    assert.match(lanePolicyScript({ mute: false, rate: 99 }), /v\.playbackRate = 4;/);
    assert.match(lanePolicyScript({ mute: false, rate: 0.1 }), /v\.playbackRate = 0\.25;/);
  });

  it('applies the policy to the current document and arms future ones', async () => {
    const l = logs();
    const evals: Array<{ expr: string; gesture: boolean }> = [];
    const armed: string[] = [];
    const cdp: LaneCdp = {
      url: async () => 'about:blank',
      navigate: async () => {},
      evaluate: async <T,>(expr: string, opts?: { userGesture?: boolean }) => {
        evals.push({ expr, gesture: opts?.userGesture === true });
        return 'play-requested' as T;
      },
      armKeepAlive: async (source: string) => {
        armed.push(source);
      },
    };
    await applyLanePolicy(cdp, { laneId: 'lane0', mute: false, log: l.log });
    assert.equal(evals.length, 2);
    assert.match(evals[0]!.expr, /__c4gSwarm/);
    assert.equal(evals[0]!.gesture, false);
    assert.match(evals[1]!.expr, /document\.querySelector\('video'\)/);
    // the play() nudge must carry user activation or autoplay stays blocked
    assert.equal(evals[1]!.gesture, true);
    assert.equal(armed.length, 1);
    assert.match(armed[0]!, /c4g-swarm-lane0/);
    assert.ok(l.lines.some((line) => line.includes('lane lane0 policy applied (play-requested)')));
  });

  it('survives a CDP arming failure (in-page keep-alive already ran)', async () => {
    const l = logs();
    const cdp: LaneCdp = {
      url: async () => '',
      navigate: async () => {},
      evaluate: async <T,>() => true as T,
      armKeepAlive: async () => {
        throw new Error('Page.setWebLifecycleState unsupported');
      },
    };
    await applyLanePolicy(cdp, { laneId: 'lane0', mute: false, log: l.log });
    assert.ok(l.lines.some((line) => line.includes('cdp keep-alive arming failed')));
  });
});

describe('swarm platform-warning probe', () => {
  const cdpWith = (text: string): LaneCdp => ({
    url: async () => '',
    navigate: async () => {},
    evaluate: async <T,>() => text as T,
  });

  it('flags the platform warning as a hard signal', async () => {
    const probe = await detectConcurrencyWarning(cdpWith('系统提示：禁止同时观看多个视频'));
    assert.equal(probe.hard, '禁止同时观看多个视频');
  });

  it('treats mere course wording as a soft signal only', async () => {
    const probe = await detectConcurrencyWarning(cdpWith('学习建议：本课程支持同时观看多个章节'));
    assert.equal(probe.hard, null);
    assert.ok(probe.soft !== null);
  });

  it('returns nothing for an ordinary page and never throws on a broken probe', async () => {
    assert.deepEqual(await detectConcurrencyWarning(cdpWith('第一讲 绪论')), { hard: null, soft: null });
    const broken: LaneCdp = {
      url: async () => '',
      navigate: async () => {},
      evaluate: async <T,>() => {
        throw new Error('target closed');
      },
    };
    assert.deepEqual(await detectConcurrencyWarning(broken), { hard: null, soft: null });
  });

  it('exposes the probe text cap', () => {
    assert.match(clampProbeText('x'.repeat(20_000)), /^x+$/);
    assert.equal(clampProbeText('x'.repeat(20_000)).length, 8000);
  });
});

// ---------------------------------------------------------------------------
// provisioning
// ---------------------------------------------------------------------------

describe('swarm lane provisioning', () => {
  const fakeCdp: LaneCdp = { url: async () => '', navigate: async () => {}, evaluate: async <T,>() => true as T };

  it('opens one distinctly marked tab per lane and attaches CDP by marker', async () => {
    const l = logs();
    const openedUrls: string[] = [];
    const markers: string[] = [];
    const beforeSets: string[] = [];
    const lanes = await provisionLanes({
      count: 3,
      courseUrl: 'https://lms.example.com/course/view.php?id=42',
      nonce: 'n0',
      openTab: async (url) => {
        openedUrls.push(url);
        return { tabId: 100 + openedUrls.length - 1 };
      },
      listTargets: async () => ['existing-target'],
      connectLane: async (marker, _index, before) => {
        markers.push(marker);
        beforeSets.push(before.join(','));
        return fakeCdp;
      },
      log: l.log,
    });
    assert.deepEqual(lanes.map((lane) => lane.tabId), [100, 101, 102]);
    assert.deepEqual(markers, ['c4g_lane=n0-0', 'c4g_lane=n0-1', 'c4g_lane=n0-2']);
    assert.ok(openedUrls.every((url) => url.startsWith('https://lms.example.com/course/view.php?id=42&c4g_lane=n0-')));
    // each lane learns the page targets that existed before its tab was opened,
    // so a redirected park URL can still be attached by new-target detection
    assert.deepEqual(beforeSets, ['existing-target', 'existing-target', 'existing-target']);
    assert.ok(lanes.every((lane) => lane.created));
  });

  it('drops a lane it cannot attach to and closes that tab again', async () => {
    const l = logs();
    const closed: number[] = [];
    const lanes = await provisionLanes({
      count: 2,
      courseUrl: 'https://lms.example.com/course/view.php?id=42',
      nonce: 'n1',
      openTab: async (url) => ({ tabId: url.includes('c4g_lane=n1-1') ? 201 : 200 }),
      connectLane: async (marker) => {
        if (marker.endsWith('-1')) throw new Error('no CDP target matched lane marker');
        return fakeCdp;
      },
      closeTab: async (tabId) => {
        closed.push(tabId);
      },
      log: l.log,
    });
    assert.deepEqual(lanes.map((lane) => lane.tabId), [200]);
    assert.deepEqual(closed, [201]);
    assert.ok(l.lines.some((line) => line.includes('lane1 provisioning failed')));
  });

  it('fails loudly when no lane can be provisioned', async () => {
    const l = logs();
    await assert.rejects(
      provisionLanes({
        count: 2,
        courseUrl: 'https://lms.example.com/course/view.php?id=42',
        nonce: 'n2',
        openTab: async () => {
          throw new Error('extension not connected');
        },
        connectLane: async () => fakeCdp,
        log: l.log,
      }),
      /no lane could be provisioned/,
    );
  });
});

// ---------------------------------------------------------------------------
// run orchestration (fake supervisors — no Chrome, no timers left behind)
// ---------------------------------------------------------------------------

interface FakeLane {
  lane: SwarmLane;
  sup: LaneSupervisor;
  calls: number[];
  stopCount(): number;
  releaseAll(): void;
  setMode(mode: 'immediate' | 'hold'): void;
}

function fakeLane(index: number, opts: { mode?: 'immediate' | 'hold'; failOn?: number; throwOn?: number } = {}): FakeLane {
  const calls: number[] = [];
  const pending: Array<{ id: number; resolve: (o: WatchOutcome) => void }> = [];
  let mode = opts.mode ?? 'immediate';
  let stops = 0;
  const sup: LaneSupervisor = {
    watch: async (id: number) => {
      calls.push(id);
      if (opts.throwOn === id) throw new Error('CDP connection closed');
      if (opts.failOn === id) return outcome(id, { completed: false, failed: true, creditedDeltaSeconds: null, recoveries: 3 });
      if (mode === 'hold') {
        return await new Promise<WatchOutcome>((resolve) => pending.push({ id, resolve }));
      }
      return outcome(id);
    },
    stop() {
      stops += 1;
      // Mirrors Timekeeper.stop(): interrupted watches resolve as failed.
      for (const p of pending.splice(0)) p.resolve(outcome(p.id, { completed: false, failed: true, creditedDeltaSeconds: null }));
    },
    runSummary: () => [],
  };
  return {
    lane: {
      index,
      label: `lane${index}`,
      tabId: 300 + index,
      marker: `c4g_lane=t-${index}`,
      cdp: { url: async () => '', navigate: async () => {}, evaluate: async <T,>() => '' as T },
      created: true,
    },
    sup,
    calls,
    stopCount: () => stops,
    releaseAll: () => {
      for (const p of pending.splice(0)) p.resolve(outcome(p.id));
    },
    setMode: (next) => {
      mode = next;
    },
  };
}

function makeLedgers(tag: string): { ledger: CompletionLedger; failed: FailedLedger } {
  const ledger = new CompletionLedger(join(tmp, `swarm-${tag}-ledger.json`));
  const failed = new FailedLedger(join(tmp, `swarm-${tag}-failed.json`));
  ledger.load();
  failed.load();
  return { ledger, failed };
}

function scriptedScrape(passes: ScrapeItem[][]): () => Promise<ScrapeItem[]> {
  return async () => passes.shift() ?? [];
}

const item = (id: number): ScrapeItem => ({ url: `/mod/fsresource/view.php?id=${id}`, resourceId: id });

describe('startSwarm', () => {
  it('watches every planned video exactly once, spread across lanes, and stops on course complete', async () => {
    const l = logs();
    const { ledger, failed } = makeLedgers('happy');
    const lanes = [fakeLane(0), fakeLane(1)];
    const run = startSwarm({
      lanes: lanes.map((f) => f.lane),
      courseUrl: 'https://lms.example.com/course/view.php?id=42',
      scrape: scriptedScrape([[item(1), item(2), item(3), item(4), item(5)], []]),
      ledger,
      failed,
      log: l.log,
      makeSupervisor: (lane) => lanes[lane.index]!.sup,
      warningPollMs: 0,
    });
    const summary = await run.done;

    assert.deepEqual(lanes[0]!.calls, [1, 3, 5]);
    assert.deepEqual(lanes[1]!.calls, [2, 4]);
    assert.equal(summary.watched, 5);
    assert.equal(summary.completed, 5);
    assert.equal(summary.failed, 0);
    assert.equal(summary.flagged, null);
    for (const id of [1, 2, 3, 4, 5]) assert.equal(ledger.has(id), true, `video ${id} not credited`);
    assert.ok(l.lines.some((line) => line.includes('course complete')));
    assert.ok(l.lines.some((line) => line.includes('lane0=[1, 3, 5]') && line.includes('lane1=[2, 4]')));
  });

  it('records failed videos in the retry ledger (never in completions)', async () => {
    const l = logs();
    const { ledger, failed } = makeLedgers('fail');
    const lanes = [fakeLane(0, { failOn: 1 }), fakeLane(1, { failOn: 2 })];
    const run = startSwarm({
      lanes: lanes.map((f) => f.lane),
      courseUrl: 'https://lms.example.com/course/view.php?id=42',
      scrape: scriptedScrape([[item(1), item(2), item(3), item(4)], []]),
      ledger,
      failed,
      log: l.log,
      makeSupervisor: (lane) => lanes[lane.index]!.sup,
      warningPollMs: 0,
    });
    const summary = await run.done;
    assert.equal(ledger.has(1), false);
    assert.equal(ledger.has(2), false);
    assert.equal(failed.attempts(1), 1);
    assert.equal(failed.attempts(2), 1);
    assert.equal(ledger.has(3), true);
    assert.equal(ledger.has(4), true);
    assert.equal(summary.failed, 2);
    assert.equal(summary.completed, 2);
  });

  it('keeps a dead lane out of the rotation and re-plans its videos for the survivors', async () => {
    const l = logs();
    const { ledger, failed } = makeLedgers('dead');
    const lanes = [fakeLane(0), fakeLane(1, { throwOn: 2 })];
    const run = startSwarm({
      lanes: lanes.map((f) => f.lane),
      courseUrl: 'https://lms.example.com/course/view.php?id=42',
      scrape: scriptedScrape([[item(1), item(2), item(3)], [item(2), item(3)]]),
      ledger,
      failed,
      log: l.log,
      makeSupervisor: (lane) => lanes[lane.index]!.sup,
      warningPollMs: 0,
    });
    const summary = await run.done;
    assert.equal(summary.lanes, 2);
    // lane1 died on 2 → 2 and 3 are replanned and picked up by lane0 only
    assert.deepEqual(lanes[1]!.calls, [2]);
    assert.deepEqual(lanes[0]!.calls, [1, 3, 2]);
    assert.ok(l.lines.some((line) => line.includes('swarm[lane1]: lane died on video 2')));
    assert.ok(l.lines.some((line) => line.includes('lane1 removed from the rotation')));
    assert.equal(ledger.has(3), true);
  });

  it('never starts the same video twice within one run', async () => {
    const l = logs();
    const { ledger, failed } = makeLedgers('once');
    // A supervisor that stops short of a terminal state: nothing is recorded,
    // so the planner would happily hand the same id out again.
    const sup: LaneSupervisor = {
      watch: async (id) => outcome(id, { completed: false, failed: false, creditedDeltaSeconds: null }),
      stop: () => {},
      runSummary: () => [],
    };
    const calls: number[] = [];
    const run = startSwarm({
      lanes: [fakeLane(0).lane],
      courseUrl: 'https://lms.example.com/course/view.php?id=42',
      scrape: scriptedScrape([[item(7)], [item(7)], []]),
      ledger,
      failed,
      log: l.log,
      makeSupervisor: () => ({ ...sup, watch: async (id) => { calls.push(id); return outcome(id, { completed: false, failed: false, creditedDeltaSeconds: null }); } }),
      warningPollMs: 0,
    });
    await run.done;
    assert.deepEqual(calls, [7]);
    assert.ok(l.lines.some((line) => line.includes('was already watched this run')));
    assert.equal(ledger.has(7), false);
  });

  it('degrades to a single lane when the platform warns about concurrent playback', async () => {
    const l = logs();
    const { ledger, failed } = makeLedgers('flag');
    const flagFile = join(tmp, 'swarm-flag.json');
    const lanes = [fakeLane(0), fakeLane(1, { mode: 'hold' })];
    // Deterministic trigger: the platform starts warning right after lane0's
    // first video lands, so the post-video probe sees it (no timer race).
    let warningShown = false;
    const log: LogFn = (level, msg) => {
      l.log(level, msg);
      if (msg.includes('[lane0]: video 1 completed')) warningShown = true;
    };
    const run = startSwarm({
      lanes: lanes.map((f) => f.lane),
      courseUrl: 'https://lms.example.com/course/view.php?id=42',
      scrape: scriptedScrape([[item(1), item(2), item(3), item(4)], [item(2), item(3), item(4)]]),
      ledger,
      failed,
      log,
      flagFile,
      makeSupervisor: (lane) => lanes[lane.index]!.sup,
      warningPollMs: 0,
      probeWarning: async () => (warningShown ? { hard: '禁止同时观看多个视频', soft: null } : { hard: null, soft: null }),
    });

    try {
      const summary = await run.done;

      assert.deepEqual(summary.flagged, { laneIndex: 0, sample: '禁止同时观看多个视频' });
      assert.equal(summary.activeLanes, 1);
      assert.equal(summary.completed, 4);
      assert.equal(summary.failed, 0, 'an interrupted video is not a failed attempt');
      assert.equal(lanes[1]!.stopCount(), 1);
      assert.deepEqual(lanes[1]!.calls, [2], 'lane1 keeps its in-flight video and nothing else');
      // the interrupted lane's video must not be charged against the retry cap
      assert.equal(failed.attempts(2), 0);
      assert.equal(failed.all().length, 0);
      // everything that was still outstanding is finished single-handed
      assert.deepEqual(lanes[0]!.calls, [1, 2, 3, 4]);
      for (const id of [1, 2, 3, 4]) assert.equal(ledger.has(id), true, `video ${id} never got credited`);
      assert.equal(existsSync(flagFile), true);
      const evidence = JSON.parse(readFileSync(flagFile, 'utf8')) as { laneIndex: number; matched: string };
      assert.equal(evidence.laneIndex, 0);
      assert.equal(evidence.matched, '禁止同时观看多个视频');
      assert.ok(l.lines.some((line) => line.includes('Degrading to a single lane')));
      assert.ok(l.lines.some((line) => line.includes('interrupted — will retry next pass')));
    } finally {
      // never leave a held watch behind: a failed assertion must not hang the run
      for (const lane of lanes) lane.releaseAll();
      run.stop();
    }
  });

  it('catches a warning raised mid-video through the polling watchdog', async () => {
    const l = logs();
    const { ledger, failed } = makeLedgers('watchdog');
    const lanes = [fakeLane(0, { mode: 'hold' }), fakeLane(1, { mode: 'hold' })];
    let probes = 0;
    const run = startSwarm({
      lanes: lanes.map((f) => f.lane),
      courseUrl: 'https://lms.example.com/course/view.php?id=42',
      scrape: scriptedScrape([[item(1), item(2), item(3), item(4)], [item(3), item(4)]]),
      ledger,
      failed,
      log: l.log,
      makeSupervisor: (lane) => lanes[lane.index]!.sup,
      keepTabs: true,
      warningPollMs: 5,
      // Both pass-start probes (one per lane) are clean; the polling watchdog
      // then sees the warning while both lanes are still mid-video.
      probeWarning: async () => {
        probes += 1;
        return probes >= 3 ? { hard: '禁止同时观看多个视频', soft: null } : { hard: null, soft: null };
      },
    });

    try {
      const sawFlag = await waitFor(() => l.lines.some((line) => line.includes('PLATFORM CONCURRENCY WARNING')));
      assert.equal(sawFlag, true, `watchdog never degraded the run; logs:\n${l.lines.join('\n')}`);
      assert.equal(lanes[1]!.stopCount(), 1, 'the second lane is stood down');
      assert.equal(lanes[0]!.stopCount(), 0, 'the surviving lane keeps running');
      // lane0 takes over single-handed from here
      lanes[0]!.setMode('immediate');
      lanes[0]!.releaseAll();
      const summary = await run.done;
      assert.equal(summary.activeLanes, 1);
      assert.equal(summary.flagged?.laneIndex, 0);
      assert.equal(failed.all().length, 0, 'interrupted video is not charged against the retry cap');
      assert.deepEqual(lanes[0]!.calls, [1, 3, 4], 'the surviving lane finishes the remaining queue');
      assert.deepEqual(lanes[1]!.calls, [2]);
    } finally {
      for (const lane of lanes) lane.releaseAll();
      run.stop();
    }
  });

  it('stops cleanly when a degrade fires and the designated survivor (lane0) is already dead', async () => {
    // Regression: `usable`/`survivors` used to filter only on `alive`, so a
    // lane dropped by degrade() could be selected — its runLane returns
    // immediately on the dropped check, and every remaining pass idled with
    // zero watches until maxPasses. The dropped set must be excluded too.
    const l = logs();
    const { ledger, failed } = makeLedgers('degrade-dead');
    const lanes = [fakeLane(0, { throwOn: 1 }), fakeLane(1)];
    let probes = 0;
    const run = startSwarm({
      lanes: lanes.map((f) => f.lane),
      courseUrl: 'https://lms.example.com/course/view.php?id=42',
      scrape: scriptedScrape([[item(1), item(2), item(3)], [item(1), item(2), item(3)], [item(1), item(2), item(3)]]),
      ledger,
      failed,
      log: l.log,
      flagFile: join(tmp, 'swarm-flag-degrade-dead.json'),
      makeSupervisor: (lane) => lanes[lane.index]!.sup,
      warningPollMs: 0,
      // First pass-start probe (lane0) is clean; the second (lane1) trips the
      // warning → degrade keeps lane0, drops lane1 — then lane0 dies on its
      // first video, leaving no usable lane at all.
      probeWarning: async () => {
        probes += 1;
        return probes >= 2 ? { hard: '禁止同时观看多个视频', soft: null } : { hard: null, soft: null };
      },
    });
    const summary = await run.done;

    assert.equal(summary.flagged?.laneIndex, 1);
    assert.deepEqual(lanes[0]!.calls, [1], 'lane0 died on its first video');
    assert.deepEqual(lanes[1]!.calls, [], 'the dropped lane must never be handed work');
    assert.equal(lanes[1]!.stopCount(), 1, 'degrade stood the lane down');
    assert.ok(
      l.lines.some((line) => line.includes('every lane died')),
      `the run must stop loudly instead of idling for maxPasses; logs:\n${l.lines.join('\n')}`,
    );
    assert.equal(summary.completed, 0);
    assert.equal(ledger.all().length, 0);
    assert.equal(failed.all().length, 0, 'a thrown watch is not an attempt');
  });

  it('stop() ends the run without charging interrupted videos against the retry cap', async () => {
    const l = logs();
    const { ledger, failed } = makeLedgers('stop');
    const closed: number[] = [];
    const lanes = [fakeLane(0, { mode: 'hold' }), fakeLane(1, { mode: 'hold' })];
    const run = startSwarm({
      lanes: lanes.map((f) => f.lane),
      courseUrl: 'https://lms.example.com/course/view.php?id=42',
      scrape: scriptedScrape([[item(1), item(2)], []]),
      ledger,
      failed,
      log: l.log,
      makeSupervisor: (lane) => lanes[lane.index]!.sup,
      closeTab: async (tabId) => {
        closed.push(tabId);
      },
      warningPollMs: 0,
    });
    try {
      await waitFor(() => lanes.every((lane) => lane.calls.length === 1)); // both lanes mid-video
      run.stop();
      await run.done;
      assert.equal(failed.all().length, 0);
      assert.equal(ledger.all().length, 0);
      assert.deepEqual(closed.sort(), [300, 301]);
      assert.ok(l.lines.some((line) => line.includes('interrupted — will retry next pass')));
    } finally {
      run.stop();
    }
  });

  it('keeps lane tabs when asked (--swarm-keep-tabs)', async () => {
    const l = logs();
    const { ledger, failed } = makeLedgers('keep');
    const closed: number[] = [];
    const lanes = [fakeLane(0)];
    const run = startSwarm({
      lanes: lanes.map((f) => f.lane),
      courseUrl: 'https://lms.example.com/course/view.php?id=42',
      scrape: scriptedScrape([[]]),
      ledger,
      failed,
      log: l.log,
      keepTabs: true,
      makeSupervisor: () => lanes[0]!.sup,
      warningPollMs: 0,
      closeTab: async (tabId) => {
        closed.push(tabId);
      },
    });
    await run.done;
    run.stop();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(closed, []);
    assert.equal(lanes[0]!.stopCount(), 1);
  });

  it('summarises the run in one line', () => {
    const line = swarmSummaryLine({ lanes: 2, activeLanes: 1, watched: 4, completed: 3, failed: 1, flagged: { laneIndex: 1, sample: '禁止同时观看多个视频' } });
    assert.match(line, /2 lane\(s\) \(1 active\)/);
    assert.match(line, /4 watched, 3 completed, 1 failed/);
    assert.match(line, /FLAGGED by platform on lane 1/);
  });
});

describe('swarm source guards', () => {
  it('keeps the rate and network invariants', async () => {
    const { readFileSync: rf } = await import('node:fs');
    const src = rf(new URL('../src/swarm.ts', import.meta.url), 'utf8');
    assert.ok(!/XMLHttpRequest|\.ajax\(|fetch\(/.test(src), 'swarm must not issue HTTP requests');
    assert.ok(!/_set_time/.test(src), 'swarm must never reference the heartbeat method');
    const rateAssignments = src.match(/playbackRate\s*=\s*[^;]+/g) ?? [];
    assert.ok(rateAssignments.length > 0, 'policy script should pin playbackRate');
    for (const a of rateAssignments) {
      assert.match(a, /\$\{rate\}/, `lane policy must pin the operator's rate: ${a.trim()}`);
      assert.ok(!/=\s*(?:[2-9]|\d\d)/.test(a), `swarm must never hard-code a rate above 1: ${a.trim()}`);
    }
  });
});
