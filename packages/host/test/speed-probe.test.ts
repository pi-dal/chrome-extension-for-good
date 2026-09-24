import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LogFn } from '../src/log.js';
import type { PlayerState } from '../src/platforms/moodle-video.js';
import {
  computeVerdict,
  creditSignal,
  creditSlopes,
  measurePhase,
  median,
  probeCreditSpeed,
  type CreditSample,
  type PhaseMeasurement,
  type ProbeCdp,
  type ProbePlatform,
} from '../src/speed-probe.js';

function logs(): { lines: string[]; log: LogFn } {
  const lines: string[] = [];
  const log: LogFn = (level, msg) => {
    lines.push(`${level}:${msg}`);
  };
  return { lines, log };
}

const sample = (at: number, over: Partial<CreditSample> = {}): CreditSample => ({
  at,
  heartbeatTs: at,
  credited: null,
  progress: null,
  currentTime: 0,
  rate: 1,
  playing: true,
  ...over,
});

function phase(over: Partial<PhaseMeasurement> = {}): PhaseMeasurement {
  return {
    requestedRate: 1,
    // Default: the page obeyed the request. Tests that model a refusing
    // player override observedRate explicitly.
    observedRate: over.observedRate ?? over.requestedRate ?? 1,
    samples: [],
    heartbeats: 4,
    creditedPerWall: 1,
    progressPerWall: null,
    videoPerWall: 1,
    wallSeconds: 60,
    aborted: null,
    ...over,
  };
}

describe('speed-probe math', () => {
  it('median handles even and odd counts', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 0);
  });

  it('derives the credit slope only from distinct heartbeat responses', () => {
    const samples: CreditSample[] = [
      sample(0, { heartbeatTs: 1000, credited: 10 }),
      sample(2_000, { heartbeatTs: 1000, credited: 10 }), // same response — ignored
      sample(4_000, { heartbeatTs: 5_000, credited: 14 }),
      sample(6_000, { heartbeatTs: 5_000, credited: 14 }),
      sample(8_000, { heartbeatTs: 9_000, credited: 18 }),
    ];
    const slopes = creditSlopes(samples);
    assert.equal(slopes.heartbeats, 3);
    // (18 - 10) credited seconds over (9000 - 1000)/1000 wall seconds = 1.0x
    assert.equal(slopes.creditedPerWall, 1);
    assert.equal(slopes.progressPerWall, null, 'no progress field in these responses');
  });

  it('falls back to progress when the response carries no totaltime', () => {
    const samples: CreditSample[] = [
      sample(0, { heartbeatTs: 1_000, progress: 1 }),
      sample(30_000, { heartbeatTs: 31_000, progress: 2.5 }),
    ];
    const slopes = creditSlopes(samples);
    assert.equal(slopes.creditedPerWall, null);
    assert.ok(Math.abs(slopes.progressPerWall! - 0.05) < 1e-9);
    assert.equal(creditSignal({ creditedPerWall: null, progressPerWall: 0.05 }), 0.05);
  });

  it('classifies credited / partial / wallclock / stalled / unobservable', () => {
    // 2x with 2.0x credit → fully credited
    const credited = computeVerdict(phase(), phase({ requestedRate: 2, creditedPerWall: 2, videoPerWall: 2 }), 2);
    assert.equal(credited.verdict, 'credited');
    assert.equal(credited.creditRatio, 2);

    // 2x with 1.7x credit → partial (85% of the gain, still a net win)
    const partial = computeVerdict(phase(), phase({ requestedRate: 2, creditedPerWall: 1.7, videoPerWall: 2 }), 2);
    assert.equal(partial.verdict, 'partial');
    assert.match(partial.note, /partial credit/);

    // 2x with 1.0x credit → wall-clock capped
    const wallclock = computeVerdict(phase(), phase({ requestedRate: 2, creditedPerWall: 1, videoPerWall: 2 }), 2);
    assert.equal(wallclock.verdict, 'wallclock');

    // 2x and the counter stops → the backend rejects acceleration
    const stalled = computeVerdict(phase(), phase({ requestedRate: 2, creditedPerWall: 0, videoPerWall: 2 }), 2);
    assert.equal(stalled.verdict, 'stalled');

    // not enough heartbeats → unobservable, never a guess
    const thin = computeVerdict(phase({ heartbeats: 1 }), phase({ heartbeats: 4, creditedPerWall: 2 }), 2);
    assert.equal(thin.verdict, 'unobservable');
    assert.match(thin.note, /not enough heartbeat responses/);

    // the page never held 2x (player clamped the rate) → unobservable, NOT
    // 'wallclock' — a 1x fast phase says nothing about the backend
    const refused = computeVerdict(
      phase(),
      phase({ requestedRate: 2, observedRate: 1, creditedPerWall: 1, videoPerWall: 1 }),
      2,
    );
    assert.equal(refused.verdict, 'unobservable');
    assert.match(refused.note, /never held the requested rate/);

    // aborted phase → unobservable with the reason
    const aborted = computeVerdict(phase({ aborted: 'the video is not playing' }), phase(), 2);
    assert.equal(aborted.verdict, 'unobservable');
    assert.match(aborted.note, /video is not playing/);

    // a broken 1x baseline must not be used to judge the rate
    const brokenBase = computeVerdict(phase({ creditedPerWall: 0.2 }), phase({ creditedPerWall: 0.4 }), 2);
    assert.equal(brokenBase.verdict, 'unobservable');
    assert.match(brokenBase.note, /baseline 1x credit/);

    // no credit signal at all
    const noSignal = computeVerdict(phase({ creditedPerWall: null }), phase({ creditedPerWall: null }), 2);
    assert.equal(noSignal.verdict, 'unobservable');
    assert.match(noSignal.note, /neither totaltime nor progress/);
  });
});

// ---------------------------------------------------------------------------
// phase measurement against a scripted player + backend model
// ---------------------------------------------------------------------------

type BackendModel = 'credited' | 'wallclock' | 'stalled';

interface Plant {
  cdp: ProbeCdp;
  platform: ProbePlatform;
  /** Every rate the probe asked the page to pin, in order. */
  ratesApplied: number[];
  lines: string[];
  /** Simulated clock (ms) — the probe is driven by injected now/sleep. */
  now(): number;
  advance(ms: number): void;
  deps(): Parameters<typeof probeCreditSpeed>[0];
}

/**
 * Simulates the page + backend: `evaluate` records the rate it was asked to
 * pin, samples advance video time at that rate, and the backend credits each
 * wall-clock heartbeat interval according to its model.
 */
function makePlant(model: BackendModel): Plant {
  let clock = 0;
  let rate = 1;
  let videoTime = 0;
  let credited = 0;
  let progress = 0;
  let lastSample = 0;
  let lastHeartbeat = 0;
  let heartbeatTs = 0;
  let heartbeatCredited = 0;
  let heartbeatProgress = 0;
  const ratesApplied: number[] = [];
  const { lines, log } = logs();

  const cdp: ProbeCdp = {
    url: async () => 'https://lms.example.com/mod/fsresource/view.php?id=1',
    evaluate: async <T,>(expression: string): Promise<T> => {
      const match = /v\.playbackRate = ([0-9.]+)/.exec(expression);
      if (match) {
        rate = Number(match[1]);
        ratesApplied.push(rate);
      }
      return 'playing' as T;
    },
  };

  const platform: ProbePlatform = {
    installHeartbeatHook: async () => {},
    readPlayerState: async (): Promise<PlayerState> => {
      const dt = (clock - lastSample) / 1000;
      lastSample = clock;
      videoTime += dt * rate;
      if (clock - lastHeartbeat >= 15_000) {
        const wallDelta = (clock - lastHeartbeat) / 1000;
        lastHeartbeat = clock;
        // "stalled" = credits normally at 1x but stops the moment we accelerate
        const creditedDelta = model === 'stalled' && rate > 1.001 ? 0 : wallDelta * (model === 'credited' ? rate : 1);
        credited += creditedDelta;
        progress += creditedDelta * 0.1;
        heartbeatTs = clock;
        heartbeatCredited = credited;
        heartbeatProgress = progress;
      }
      return {
        playing: true,
        currentTime: videoTime,
        duration: 600,
        rate,
        heartbeatTs,
        totaltime: heartbeatCredited,
        progress: heartbeatProgress,
        url: 'https://lms.example.com/mod/fsresource/view.php?id=1',
      };
    },
  };

  return {
    cdp,
    platform,
    ratesApplied,
    lines,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    deps: () => ({
      cdp,
      platform,
      log,
      windowMs: 60_000,
      sampleMs: 5_000,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    }),
  };
}

describe('measurePhase', () => {
  it('pins the requested rate, reports the observed rate and needs no real clock', async () => {
    const plant = makePlant('credited');
    const m = await measurePhase(plant.deps(), 2, 60_000);
    assert.equal(m.aborted, null);
    assert.equal(m.requestedRate, 2);
    assert.equal(m.observedRate, 2);
    assert.equal(m.heartbeats, 4, 'a 60s window with 15s heartbeats');
    assert.equal(plant.ratesApplied[0], 2, 'the phase must pin the rate it measures');
    assert.ok(m.videoPerWall > 1.8, `video should advance at ~2x, got ${m.videoPerWall}`);
    assert.ok(m.creditedPerWall! > 1.5, `a crediting backend should show ~2x credit, got ${m.creditedPerWall}`);
  });

  it('aborts when there is no video element', async () => {
    const plant = makePlant('credited');
    const cdp: ProbeCdp = { url: plant.cdp.url, evaluate: async <T,>() => 'no-video' as T };
    const m = await measurePhase({ ...plant.deps(), cdp }, 1, 10_000);
    assert.match(m.aborted ?? '', /no <video> element/);
  });

  it('aborts when playback never starts (a paused page cannot be measured)', async () => {
    const plant = makePlant('credited');
    const cdp: ProbeCdp = { url: plant.cdp.url, evaluate: async <T,>() => 'paused' as T };
    const paused: ProbePlatform = {
      ...plant.platform,
      readPlayerState: async () => ({ ...(await plant.platform.readPlayerState(cdp)), playing: false }),
    };
    const m = await measurePhase({ ...plant.deps(), cdp, platform: paused }, 1, 10_000);
    assert.match(m.aborted ?? '', /not playing/);
  });
});

describe('probeCreditSpeed end to end (scripted backend)', () => {
  for (const [model, expected] of [
    ['credited', 'credited'],
    ['wallclock', 'wallclock'],
    ['stalled', 'stalled'],
  ] as Array<[BackendModel, string]>) {
    it(`classifies a ${model} backend as "${expected}" and restores 1x`, async () => {
      const plant = makePlant(model);
      const result = await probeCreditSpeed({ ...plant.deps(), rate: 2, windowMs: 60_000 });
      assert.equal(result.verdict.verdict, expected, result.verdict.note);
      assert.equal(result.base.requestedRate, 1);
      assert.equal(result.fast.requestedRate, 2);
      assert.equal(plant.ratesApplied[plant.ratesApplied.length - 1], 1, 'the probe must leave the page at 1x');
    });
  }

  it('keeps the requested rate when --keep-rate is set', async () => {
    const plant = makePlant('credited');
    const result = await probeCreditSpeed({ ...plant.deps(), rate: 2, windowMs: 45_000, keepRate: true });
    assert.equal(result.verdict.verdict, 'credited');
    assert.equal(plant.ratesApplied[plant.ratesApplied.length - 1], 2, 'keepRate leaves the page accelerated');
  });
});

describe('speed-probe source guards', () => {
  it('issues no requests of its own and always has a restore path', async () => {
    const { readFileSync: rf } = await import('node:fs');
    const src = rf(new URL('../src/speed-probe.ts', import.meta.url), 'utf8');
    assert.ok(!/XMLHttpRequest|\.ajax\(|fetch\(/.test(src), 'the probe must not issue requests of its own');
    assert.ok(!/_set_time/.test(src), 'the probe must never reference the heartbeat method');
    assert.match(src, /if \(!deps\.keepRate\)/, 'the probe must restore the rate when asked');
    assert.ok(!/playbackRate\s*=\s*[2-9]/.test(src), 'rates must come from the caller, never a literal');
  });
});
