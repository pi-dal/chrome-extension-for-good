import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { LogFn } from '../src/log.js';
import {
  clampRate,
  decideRate,
  MAX_RATE,
  MIN_RATE,
  originOf,
  POLICY_MAX_AGE_MS,
  rateSummaryLine,
  SpeedPolicyStore,
  type SpeedPolicyEntry,
} from '../src/speed-policy.js';

const tmp = mkdtempSync(join(tmpdir(), 'c4g-rate-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function logs(): { lines: string[]; log: LogFn } {
  const lines: string[] = [];
  const log: LogFn = (level, msg) => {
    lines.push(`${level}:${msg}`);
  };
  return { lines, log };
}

function entry(over: Partial<SpeedPolicyEntry> = {}): SpeedPolicyEntry {
  return {
    origin: 'https://lms.example.com',
    verdict: 'credited',
    creditRatio: 2,
    creditedSpeed: 2,
    requestedRate: 2,
    measuredAt: new Date().toISOString(),
    note: 'credit scales with playback rate',
    evidence: null,
    ...over,
  };
}

describe('clampRate / originOf', () => {
  it('keeps the rate inside the supported band', () => {
    assert.equal(clampRate(2), 2);
    assert.equal(clampRate(1.5), 1.5);
    assert.equal(clampRate(99), MAX_RATE);
    assert.equal(clampRate(0.01), MIN_RATE);
    assert.equal(clampRate(Number.NaN), 1);
    assert.equal(clampRate('1.25'), 1.25);
    assert.equal(clampRate(undefined, 2), 2);
  });

  it('derives an origin and tolerates junk URLs', () => {
    assert.equal(originOf('https://lms.example.com/mod/fsresource/view.php?id=1'), 'https://lms.example.com');
    assert.equal(originOf('/mod/fsresource/view.php?id=1'), '');
  });
});

describe('SpeedPolicyStore', () => {
  it('round-trips entries and tolerates a corrupt or missing file', () => {
    const file = join(tmp, `policy-${Math.random().toString(36).slice(2)}.json`);
    const store = new SpeedPolicyStore(file);
    store.load();
    assert.equal(store.get('https://lms.example.com'), undefined);

    store.record(entry());
    const reloaded = new SpeedPolicyStore(file);
    reloaded.load();
    assert.equal(reloaded.get('https://lms.example.com')?.verdict, 'credited');
    assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8')) as object).length, 1);

    const corrupt = join(tmp, `corrupt-${Math.random().toString(36).slice(2)}.json`);
    new SpeedPolicyStore(corrupt).load(); // missing file → empty, no throw
  });

  it('expires measurements older than the freshness window', () => {
    const store = new SpeedPolicyStore(join(tmp, `fresh-${Math.random().toString(36).slice(2)}.json`));
    const now = Date.parse('2026-09-21T00:00:00Z');
    store.record(entry({ measuredAt: new Date(now - POLICY_MAX_AGE_MS + 3_600_000).toISOString() }));
    assert.ok(store.getFresh('https://lms.example.com', POLICY_MAX_AGE_MS, now), 'a day inside the window is fresh');
    store.record(entry({ measuredAt: new Date(now - POLICY_MAX_AGE_MS - 3_600_000).toISOString() }));
    assert.equal(store.getFresh('https://lms.example.com', POLICY_MAX_AGE_MS, now), undefined, 'stale entries are re-probed');
    store.record(entry({ measuredAt: 'not-a-date' }));
    assert.equal(store.getFresh('https://lms.example.com', POLICY_MAX_AGE_MS, now), undefined);
  });
});

describe('decideRate', () => {
  it('leaves playback alone when no rate was requested', () => {
    const l = logs();
    const decision = decideRate({ requested: 1, log: l.log });
    assert.equal(decision.rate, 1);
    assert.equal(decision.verdict, 'not-requested');
    assert.equal(decision.allowed, true);
  });

  it('honours a rate the measurement says is credited', () => {
    const l = logs();
    const decision = decideRate({ requested: 2, entry: entry(), log: l.log });
    assert.equal(decision.rate, 2);
    assert.equal(decision.allowed, true);
    assert.match(decision.note, /credited ≈ 2\.00×/);
    assert.ok(l.lines.some((line) => line.includes('2x enabled')));
  });

  it('honours partial credit but says what the real speedup is', () => {
    const l = logs();
    const decision = decideRate({
      requested: 2,
      entry: entry({ verdict: 'partial', creditedSpeed: 1.6, creditRatio: 1.6, note: 'partial credit' }),
      log: l.log,
    });
    assert.equal(decision.rate, 2);
    assert.equal(decision.allowed, true);
    assert.match(decision.note, /partial credit ≈ 1\.60×/);
    assert.ok(l.lines.some((line) => line.includes('partial credit')));
  });

  it('refuses a wall-clock-capped rate unless forced', () => {
    const l = logs();
    const wall = entry({ verdict: 'wallclock', creditedSpeed: 1, creditRatio: 1, note: 'credit is wall-clock capped' });
    const refused = decideRate({ requested: 2, entry: wall, log: l.log });
    assert.equal(refused.rate, 1);
    assert.equal(refused.allowed, false);
    assert.equal(refused.verdict, 'wallclock');
    assert.ok(l.lines.some((line) => line.includes('refused by measurement')));

    const forced = decideRate({ requested: 2, entry: wall, force: true, log: l.log });
    assert.equal(forced.rate, 2);
    assert.equal(forced.allowed, true);
    assert.ok(l.lines.some((line) => line.includes('forcing 2x although the measurement says "wallclock"')));
  });

  it('refuses acceleration the backend rejects (stalled) unless forced', () => {
    const l = logs();
    const stalled = entry({ verdict: 'stalled', creditedSpeed: 0, creditRatio: 0, note: 'credit nearly stopped at 2x' });
    assert.equal(decideRate({ requested: 2, entry: stalled, log: l.log }).rate, 1);
    assert.equal(decideRate({ requested: 2, entry: stalled, force: true, log: l.log }).rate, 2);
  });

  it('refuses an unmeasured rate and points at the probe', () => {
    const l = logs();
    const decision = decideRate({ requested: 3, entry: undefined, log: l.log });
    assert.equal(decision.rate, 1);
    assert.equal(decision.verdict, 'no-evidence');
    assert.match(decision.note, /speed-probe/);
    assert.equal(decideRate({ requested: 3, entry: undefined, force: true, log: l.log }).rate, 3);
  });

  it('refuses when the measurement itself was unobservable', () => {
    const l = logs();
    const decision = decideRate({ requested: 2, entry: entry({ verdict: 'unobservable', creditedSpeed: null, creditRatio: null }), log: l.log });
    assert.equal(decision.rate, 1);
    assert.equal(decision.allowed, false);
  });

  it('reports the decision in one line', () => {
    const line = rateSummaryLine({ rate: 2, verdict: 'credited', allowed: true, note: 'credited ≈ 2.00× wall clock' });
    assert.match(line, /playback rate: 2x \(credited\)/);
    assert.match(line, /credited ≈ 2\.00×/);
  });
});
