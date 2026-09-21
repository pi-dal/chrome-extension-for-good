import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, describe, it } from 'node:test';
import {
  batchSummaryLine,
  CompletionLedger,
  FailedLedger,
  mergeIntoQueueFile,
  planNextPass,
  rescanCourse,
  type LedgerIO,
  type ScrapeItem,
} from '../src/batch.js';

const tmp = mkdtempSync(join(tmpdir(), 'c4g-batch-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** NodeIO against the shared tmp dir, but with a deterministic clock. */
function makeIo(): LedgerIO & { nowValue: string } {
  let tick = 0;
  return {
    nowValue: '',
    exists: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, 'utf8'),
    writeAtomic: (p, data) => {
      mkdirSync(dirname(p), { recursive: true });
      const tmpFile = `${p}.tmp-test`;
      writeFileSync(tmpFile, data);
      renameSync(tmpFile, p);
    },
    now: () => {
      tick += 1;
      return `2026-09-21T00:00:${String(tick).padStart(2, '0')}Z`;
    },
  };
}

describe('CompletionLedger', () => {
  it('starts empty when the file is missing and tolerates corrupt JSON', () => {
    const io = makeIo();
    const missing = new CompletionLedger(join(tmp, 'nope', 'completions.json'), io);
    missing.load();
    assert.equal(missing.has('1'), false);

    const corruptFile = join(tmp, 'corrupt.json');
    writeFileSync(corruptFile, '{not json');
    const corrupt = new CompletionLedger(corruptFile, io);
    corrupt.load();
    assert.equal(corrupt.has('1'), false);
  });

  it('records atomically (no tmp leftovers) and reloads across instances', () => {
    const io = makeIo();
    const file = join(tmp, `ledger-${Math.random().toString(36).slice(2)}.json`);
    const ledger = new CompletionLedger(file, io);
    ledger.load();
    ledger.record(101, 600);
    ledger.record('102', null);

    assert.equal(ledger.has(101), true);
    assert.equal(ledger.get('102')?.creditedSeconds, null);
    assert.equal(ledger.get(101)?.completedAt, '2026-09-21T00:00:01Z');
    // atomic write: payload lands via rename — no *.tmp-* residue
    assert.equal(readdirSync(tmp).filter((f) => f.includes('.tmp-')).length, 0);

    const reloaded = new CompletionLedger(file, io);
    reloaded.load();
    assert.equal(reloaded.has('101'), true);
    assert.equal(reloaded.get('101')?.creditedSeconds, 600);
  });

  it('flush re-persists current state (SIGINT hook)', () => {
    const io = makeIo();
    const file = join(tmp, `flush-${Math.random().toString(36).slice(2)}.json`);
    const ledger = new CompletionLedger(file, io);
    ledger.load();
    ledger.record('7', 42);
    rmSync(file, { force: true });
    ledger.flush();
    assert.equal(existsSync(file), true);
    assert.equal((JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)['7'] !== undefined, true);
  });
});

describe('FailedLedger', () => {
  it('counts attempts and exhausts at maxAttempts (default 3)', () => {
    const io = makeIo();
    const failed = new FailedLedger(join(tmp, `failed-${Math.random().toString(36).slice(2)}.json`), 3, io);
    failed.load();
    assert.equal(failed.exhausted(9), false);
    failed.recordFailed(9, 'recovery cap exceeded');
    failed.recordFailed(9, 'recovery cap exceeded');
    assert.equal(failed.exhausted(9), false);
    failed.recordFailed(9, 'recovery cap exceeded');
    assert.equal(failed.attempts(9), 3);
    assert.equal(failed.exhausted(9), true);
  });

  it('respects a custom maxAttempts and persists across instances', () => {
    const io = makeIo();
    const file = join(tmp, `failed2-${Math.random().toString(36).slice(2)}.json`);
    const failed = new FailedLedger(file, 2, io);
    failed.load();
    failed.recordFailed('v1', 'stall');
    failed.recordFailed('v1', 'stall again');

    const reloaded = new FailedLedger(file, 2, io);
    reloaded.load();
    assert.equal(reloaded.attempts('v1'), 2);
    assert.equal(reloaded.exhausted('v1'), true);
    assert.equal(reloaded.all()[0]?.[1].lastReason, 'stall again');
  });
});

describe('rescanCourse', () => {
  it('passes the course URL through to the injected scrape fn', async () => {
    const seen: string[] = [];
    const items: ScrapeItem[] = [{ url: '/a', resourceId: 1 }];
    const out = await rescanCourse('https://lms.example.com/course', async (url) => {
      seen.push(url);
      return items;
    });
    assert.deepEqual(seen, ['https://lms.example.com/course']);
    assert.deepEqual(out, items);
  });
});

describe('planNextPass', () => {
  function fixtures() {
    const io = makeIo();
    const ledger = new CompletionLedger(join(tmp, `plan-ledger-${Math.random().toString(36).slice(2)}.json`), io);
    const failed = new FailedLedger(join(tmp, `plan-failed-${Math.random().toString(36).slice(2)}.json`), 3, io);
    ledger.load();
    failed.load();
    return { ledger, failed };
  }

  it('drops credited videos and exhausted-failed videos, keeps the rest in order', async () => {
    const { ledger, failed } = fixtures();
    ledger.record(1, 300);
    failed.recordFailed(2, 'stall');
    failed.recordFailed(2, 'stall');
    failed.recordFailed(2, 'stall'); // exhausted at 3
    failed.recordFailed(3, 'stall'); // under cap — stays

    const items: ScrapeItem[] = [
      { url: '/v/1', resourceId: 1 }, // credited → drop
      { url: '/v/2', resourceId: 2 }, // exhausted → drop
      { url: '/v/3', resourceId: 3 }, // keep
      { url: '/v/4', resourceId: 4 }, // keep (never seen)
      { url: '/v/unknown' },          // unknown id → never filtered
    ];
    const planned = await planNextPass({ courseUrl: 'https://lms.example.com/course', scrape: async () => items, ledger, failed });
    assert.deepEqual(planned, [
      { url: '/v/3', resourceId: 3 },
      { url: '/v/4', resourceId: 4 },
      { url: '/v/unknown' },
    ]);
  });

  it('dedupes by resourceId when known and by url otherwise', async () => {
    const { ledger, failed } = fixtures();
    const items: ScrapeItem[] = [
      { url: '/v/5?dup', resourceId: 5 },
      { url: '/v/5?other', resourceId: 5 },  // same id → drop
      { url: '/v/x' },
      { url: '/v/x' },                        // same url, unknown id → drop
    ];
    const planned = await planNextPass({ courseUrl: 'https://lms.example.com/course', scrape: async () => items, ledger, failed });
    assert.deepEqual(planned, [
      { url: '/v/5?dup', resourceId: 5 },
      { url: '/v/x' },
    ]);
  });

  it('returns empty for an empty scrape', async () => {
    const { ledger, failed } = fixtures();
    const planned = await planNextPass({ courseUrl: 'https://lms.example.com/course', scrape: async () => [], ledger, failed });
    assert.deepEqual(planned, []);
  });
});

describe('mergeIntoQueueFile', () => {
  it('creates a fresh queue file when missing and unions without dropping done', () => {
    const io = makeIo();
    const file = join(tmp, `queue-${Math.random().toString(36).slice(2)}.json`);
    mergeIntoQueueFile(file, [3, 4], io);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { queue: [3, 4], done: [] });

    writeFileSync(file, JSON.stringify({ queue: [4, 5], done: [4] }));
    mergeIntoQueueFile(file, [4, 6], io);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { queue: number[]; done: number[] };
    assert.deepEqual(parsed, { queue: [5, 6], done: [4] });
  });

  it('tolerates a corrupt queue file by starting fresh from planned ids', () => {
    const io = makeIo();
    const file = join(tmp, `queue-bad-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, 'not json at all');
    mergeIntoQueueFile(file, [7], io);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { queue: [7], done: [] });
  });
});

describe('batchSummaryLine', () => {
  it('counts credited videos and failures not yet credited', () => {
    const io = makeIo();
    const ledger = new CompletionLedger(join(tmp, 'sum-ledger.json'), io);
    const failed = new FailedLedger(join(tmp, 'sum-failed.json'), 3, io);
    ledger.load();
    failed.load();
    ledger.record(1, 100);
    failed.recordFailed(2, 'x');
    failed.recordFailed(1, 'x'); // credited later — not counted as awaiting
    const line = batchSummaryLine(ledger, failed);
    assert.match(line, /1 video\(s\) credited/);
    assert.match(line, /1 awaiting retry/);
  });
});
