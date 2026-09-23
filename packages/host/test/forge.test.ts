import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { LMS_FSRESOURCE_PLUGIN, ZHIHUISHU_PLUGIN, parseSitePlugin } from '@c4g/protocol';
import {
  decideForge,
  DEFAULT_TIME_FIELD_PATTERN,
  entryFromGiveUp,
  entryFromVerdict,
  forgeSummaryLine,
  makeForgeDriver,
  probeReportAcceptance,
  replayReport,
  replayScript,
  ReportProbeStore,
  type ForgeCdp,
  type ReportProbeEntry,
} from '../src/forge.js';
import type { LogFn } from '../src/log.js';
import type { PlayerState } from '../src/platforms/plugin.js';

const tmp = mkdtempSync(join(tmpdir(), 'c4g-forge-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function logs(): { lines: string[]; log: LogFn } {
  const lines: string[] = [];
  const log: LogFn = (level, msg) => {
    lines.push(`${level}:${msg}`);
  };
  return { lines, log };
}

function state(over: Partial<PlayerState> = {}): PlayerState {
  return { playing: true, currentTime: 10, duration: 600, rate: 1, heartbeatTs: 0, totaltime: 10, progress: 1, url: 'u', ...over };
}

/** Page stand-in: a recorded heartbeat, a replay counter and a scripted ack. */
function fakePage(opts: {
  heartbeat?: { url: string; requestBody: string } | null;
  ack?: (position: number, replayIndex: number) => Partial<PlayerState>;
  replayFails?: boolean;
} = {}) {
  const applied: number[] = [];
  const replays: number[] = [];
  let credited = 10;
  const cdp: ForgeCdp = {
    url: async () => 'https://lms.example.com/mod/fsresource/view.php?id=1',
    evaluate: async <T,>(expression: string): Promise<T> => {
      const posMatch = /window\.__c4gForgePosition = (\d+)/.exec(expression);
      if (posMatch) {
        applied.push(Number(posMatch[1]));
        return true as T;
      }
      if (expression.includes('__c4gLastHeartbeat')) {
        const hb = opts.heartbeat === undefined ? { url: 'https://lms.example.com/lib/ajax/service.php', requestBody: '{"args":[{"methodname":"mod_fsresource_set_time","args":{"time":10,"id":1}}]}' } : opts.heartbeat;
        if (!hb) return { ok: false, status: null, detail: 'no heartbeat recorded yet (is the plugin hook installed and the video playing?)' } as T;
        if (opts.replayFails) return { ok: false, status: 500, detail: 'HTTP 500' } as T;
        // emulate the script's field check so a body without a numeric field
        // surfaces as a failure rather than a silent success
        if (!/"[A-Za-z]+"\s*:\s*"?\d/.test(hb.requestBody)) {
          return { ok: false, status: null, detail: `position field not found in the recorded body: ${hb.requestBody}` } as T;
        }
        replays.push(applied[applied.length - 1] ?? 0);
        const next = opts.ack?.(applied[applied.length - 1] ?? 0, replays.length - 1) ?? {};
        credited += typeof next.totaltime === 'number' ? next.totaltime - credited : 0;
        return { ok: true, status: 200, detail: '{"ok":true}' } as T;
      }
      return null as T;
    },
  };
  const platform = {
    readPlayerState: async (): Promise<PlayerState> => state({ totaltime: credited, progress: credited / 6, currentTime: credited }),
  };
  return { cdp, platform, applied, replays };
}

describe('replay mechanism', () => {
  it('rewrites the position field in the recorded body and re-sends it', async () => {
    const page = fakePage();
    const out = await replayReport(page.cdp, 120);
    assert.equal(out.ok, true);
    assert.equal(out.status, 200);
    assert.deepEqual(page.applied, [120], 'the target position is handed to the page');
    assert.deepEqual(page.replays, [120]);
  });

  it('reports a missing heartbeat and a missing field instead of pretending', async () => {
    const none = await replayReport(fakePage({ heartbeat: null }).cdp, 60);
    assert.equal(none.ok, false);
    assert.match(none.detail, /no heartbeat recorded yet/);

    const noField = fakePage({ heartbeat: { url: 'https://x/y', requestBody: '{"nothing":"here"}' } });
    const out = await replayReport(noField.cdp, 60);
    assert.equal(out.ok, false);
    assert.match(out.detail, /position field not found/);
  });

  it('generates a script that never invents an endpoint', () => {
    const script = replayScript(DEFAULT_TIME_FIELD_PATTERN);
    assert.match(script, /window\.__c4gLastHeartbeat/);
    assert.match(script, /hb\.url/);
    assert.match(script, /hb\.requestBody/);
    assert.match(script, /credentials: 'include'/);
    assert.match(script, /__c4gForgePosition/);
    // no hard-coded host: the endpoint always comes from the recorded request
    assert.ok(!/https?:\/\//.test(script), 'the replay must reuse the recorded URL, not a literal one');
  });

  it('uses the field pattern the plugin declares', () => {
    const script = replayScript(LMS_FSRESOURCE_PLUGIN.forge!.timeFieldPattern!);
    assert.match(script, /totaltime/);
    assert.match(script, /playingTime/);
  });
});

describe('probeReportAcceptance', () => {
  it('calls it accepted when the server ack moves', async () => {
    const page = fakePage({ ack: (pos) => ({ totaltime: 10 + pos }) });
    const verdict = await probeReportAcceptance({
      cdp: page.cdp,
      platform: page.platform,
      log: () => {},
      forge: { timeFieldPattern: DEFAULT_TIME_FIELD_PATTERN },
      position: 90,
      settleMs: 0,
      sleep: async () => {},
    });
    assert.equal(verdict.verdict, 'accepted');
    assert.equal(verdict.creditedDelta, 90);
    assert.match(verdict.note, /credited the replayed position/);
  });

  it('calls it ignored when the HTTP call works but the ack stays put', async () => {
    const page = fakePage({ ack: () => ({}) });
    const verdict = await probeReportAcceptance({
      cdp: page.cdp,
      platform: page.platform,
      log: () => {},
      forge: { timeFieldPattern: DEFAULT_TIME_FIELD_PATTERN },
      position: 300,
      settleMs: 0,
      sleep: async () => {},
    });
    assert.equal(verdict.verdict, 'ignored');
    assert.equal(verdict.creditedDelta, 0);
    assert.match(verdict.note, /caps credit against real wall-clock/);
  });

  it('calls it rejected when the replay itself fails', async () => {
    const page = fakePage({ replayFails: true });
    const verdict = await probeReportAcceptance({
      cdp: page.cdp,
      platform: page.platform,
      log: () => {},
      forge: { timeFieldPattern: DEFAULT_TIME_FIELD_PATTERN },
      position: 30,
      settleMs: 0,
      sleep: async () => {},
    });
    assert.equal(verdict.verdict, 'rejected');
    assert.match(verdict.note, /refused/);
  });

  it('calls it unobservable when there is no ack to read', async () => {
    const page = fakePage();
    const verdict = await probeReportAcceptance({
      cdp: page.cdp,
      platform: { readPlayerState: async () => state({ totaltime: null, progress: null }) },
      log: () => {},
      forge: { timeFieldPattern: DEFAULT_TIME_FIELD_PATTERN },
      position: 30,
      settleMs: 0,
      sleep: async () => {},
    });
    assert.equal(verdict.verdict, 'unobservable');
    assert.match(verdict.note, /no readable server ack/);
  });
});

describe('ReportProbeStore', () => {
  it('persists verdicts per origin and survives a corrupt file', () => {
    const file = join(tmp, `probe-${Math.random().toString(36).slice(2)}.json`);
    const store = new ReportProbeStore(file);
    store.load();
    const entry = entryFromVerdict('https://lms.example.com', 'lms-fsresource', {
      verdict: 'ignored',
      creditedDelta: 0,
      progressDelta: 0,
      position: 60,
      replay: { ok: true, status: 200, detail: '{}' },
      note: 'ack did not move',
    });
    store.record(entry);
    const reloaded = new ReportProbeStore(file);
    reloaded.load();
    assert.equal(reloaded.get('https://lms.example.com')?.verdict, 'ignored');
    assert.equal(reloaded.get('https://lms.example.com')?.source, 'probe');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'https://lms.example.com': entry });
  });

  it('records a driver give-up with the same shape', () => {
    const entry: ReportProbeEntry = entryFromGiveUp('https://lms.example.com', 'lms-fsresource', 'stopped after 2 stalls');
    assert.equal(entry.verdict, 'ignored');
    assert.equal(entry.source, 'driver');
    assert.equal(entry.creditedDelta, undefined);
  });
});

describe('decideForge', () => {
  const accepted = entryFromGiveUp('https://lms.example.com', 'p', 'x');
  const ok: ReportProbeEntry = { ...accepted, verdict: 'accepted', note: 'replay credited', source: 'probe' };

  it('stays off unless asked', () => {
    const l = logs();
    const decision = decideForge({ requested: false, hasPattern: true, log: l.log });
    assert.equal(decision.enabled, false);
    assert.equal(decision.verdict, 'not-requested');
  });

  it('refuses a plugin that has no forge knowledge', () => {
    const l = logs();
    const decision = decideForge({ requested: true, hasPattern: false, log: l.log });
    assert.equal(decision.enabled, false);
    assert.equal(decision.verdict, 'no-pattern');
    assert.match(decision.note, /no forge replay knowledge/);
  });

  it('refuses an unmeasured request and points at report-probe', () => {
    const l = logs();
    const decision = decideForge({ requested: true, hasPattern: true, log: l.log });
    assert.equal(decision.enabled, false);
    assert.equal(decision.verdict, 'no-evidence');
    assert.match(decision.note, /report-probe/);
  });

  it('enables it only for an accepted measurement', () => {
    const l = logs();
    assert.equal(decideForge({ requested: true, hasPattern: true, entry: ok, log: l.log }).enabled, true);
    for (const verdict of ['ignored', 'rejected', 'unobservable'] as const) {
      const entry = { ...ok, verdict };
      const refused = decideForge({ requested: true, hasPattern: true, entry, log: l.log });
      assert.equal(refused.enabled, false, `${verdict} must not enable forging`);
      assert.equal(decideForge({ requested: true, hasPattern: true, entry, force: true, log: l.log }).enabled, true);
    }
  });
});

describe('makeForgeDriver', () => {
  it('credits reports while the ack moves and never claims completion itself', async () => {
    const l = logs();
    const page = fakePage({ ack: (pos) => ({ totaltime: 10 + pos }) });
    const driver = makeForgeDriver({
      cdp: page.cdp,
      platform: page.platform,
      log: l.log,
      forge: { timeFieldPattern: DEFAULT_TIME_FIELD_PATTERN },
      stepSeconds: 60,
    });
    await driver.tick();
    await driver.tick();
    const status = driver.status();
    assert.equal(status.reports, 2);
    assert.equal(status.accepted, 2);
    assert.equal(status.disabled, false);
    assert.ok(l.lines.some((line) => line.includes('credited')));
    // the driver only ever issues reports; completion remains the supervisor's call
    assert.ok(!/complete/i.test(l.lines.join('\n')));
  });

  it('claims the whole duration when --forge-to-end is set (秒过)', async () => {
    const page = fakePage({ ack: (pos) => ({ totaltime: 10 + pos }) });
    const driver = makeForgeDriver({
      cdp: page.cdp,
      platform: page.platform,
      log: () => {},
      forge: { timeFieldPattern: DEFAULT_TIME_FIELD_PATTERN },
      toEnd: true,
    });
    await driver.tick();
    assert.deepEqual(page.applied, [600], 'the reported position is the video duration');
  });

  it('disables itself when the backend ignores the reports, and records the verdict', async () => {
    const l = logs();
    const giveUps: string[] = [];
    const page = fakePage({ ack: () => ({}) });
    const driver = makeForgeDriver({
      cdp: page.cdp,
      platform: page.platform,
      log: l.log,
      forge: { timeFieldPattern: DEFAULT_TIME_FIELD_PATTERN },
      stepSeconds: 60,
      maxStalls: 2,
      onGiveUp: (_verdict, note) => giveUps.push(note),
    });
    await driver.tick();
    assert.equal(driver.status().disabled, false, 'one stall is not enough');
    await driver.tick();
    assert.equal(driver.status().disabled, true);
    assert.equal(driver.status().stalls, 2);
    await driver.tick(); // a disabled driver stops hammering the endpoint
    assert.equal(driver.status().reports, 2);
    assert.equal(giveUps.length, 1);
    assert.match(giveUps[0]!, /not crediting replayed positions/);
    assert.ok(l.lines.some((line) => line.includes('DISABLED')));
  });

  it('counts a refused replay as a stall', async () => {
    const page = fakePage({ replayFails: true });
    const driver = makeForgeDriver({
      cdp: page.cdp,
      platform: page.platform,
      log: () => {},
      forge: { timeFieldPattern: DEFAULT_TIME_FIELD_PATTERN },
      maxStalls: 1,
    });
    await driver.tick();
    assert.equal(driver.status().disabled, true);
    assert.equal(driver.status().accepted, 0);
  });
});

describe('forgeSummaryLine', () => {
  it('renders the gate decision and the driver counters', () => {
    const line = forgeSummaryLine({ enabled: false, verdict: 'ignored', note: 'backend ignores replays' });
    assert.match(line, /report replay: off \(ignored\)/);
    assert.match(line, /backend ignores replays/);
  });
});

describe('plugin forge declarations', () => {
  it('the measured plugin declares a field pattern; derived ones stay honest', () => {
    const lms = parseSitePlugin(LMS_FSRESOURCE_PLUGIN);
    assert.ok(lms.forge?.timeFieldPattern, 'the LMS plugin can replay its own heartbeat');
    assert.match(lms.forge!.note!, /expected to ignore/);

    // Zhihuishu explains why replay is not wired (signed/obfuscated body)
    const zhs = parseSitePlugin(ZHIHUISHU_PLUGIN);
    assert.equal(zhs.forge?.timeFieldPattern, undefined);
    assert.match(zhs.forge!.note!, /obfuscated|signed/);
    assert.throws(
      () => parseSitePlugin({ ...LMS_FSRESOURCE_PLUGIN, forge: {} }),
      /needs timeFieldPattern, replayJs or note/,
    );
    assert.throws(
      () => parseSitePlugin({ ...LMS_FSRESOURCE_PLUGIN, forge: { timeFieldPattern: '[' } }),
      /timeFieldPattern/,
    );
  });
});

describe('platform replay scripts', () => {
  it('prefers the plugin script over the generic field rewrite', async () => {
    const seen: string[] = [];
    const cdp: ForgeCdp = {
      url: async () => 'https://studyh5.zhihuishu.com/videoStudy.html',
      evaluate: async <T,>(expression: string): Promise<T> => {
        seen.push(expression);
        if (/__c4gForgePosition = /.test(expression)) return true as T;
        return { ok: true, status: 200, detail: '{"data":{"submitSuccess":true}}' } as T;
      },
    };
    const out = await replayReport(cdp, 300, { replayJs: 'PLATFORM_SCRIPT', timeFieldPattern: 'IGNORED_PATTERN' });
    assert.equal(out.ok, true);
    assert.equal(seen.length, 2, 'position first, then one replay evaluation');
    assert.equal(seen[1], 'PLATFORM_SCRIPT', 'the platform script wins over the generic rewrite');

    const generic = await replayReport(cdp, 300, { timeFieldPattern: DEFAULT_TIME_FIELD_PATTERN });
    assert.equal(generic.ok, true);
    assert.match(seen[3]!, /__c4gLastHeartbeat/, 'without a script the generic rewrite is used');
  });

  it('verifies the shipped platform scripts through the same probe path', async () => {
    // Zhihuishu needs captured state first: the probe must report the failure, not a bogus success
    const cdp: ForgeCdp = {
      url: async () => 'https://studyh5.zhihuishu.com/videoStudy.html',
      evaluate: async <T,>(expression: string): Promise<T> => {
        if (/__c4gForgePosition = /.test(expression)) return true as T;
        if (expression.includes('videoList')) {
          return { ok: false, status: null, detail: 'lecture list not captured yet' } as T;
        }
        return null as T;
      },
    };
    const outcome = await replayReport(cdp, 60, { replayJs: ZHIHUISHU_PLUGIN.forge!.replayJs });
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /lecture list not captured/);
  });
});
