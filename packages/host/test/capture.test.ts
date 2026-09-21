import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { ElementTable } from '@c4g/protocol';
import {
  assembleCapture,
  captureFromWs,
  computeCaptureId,
  listCaptures,
  loadCapture,
  qualityCheck,
  saveCapture,
  tableSignature,
  wsCaptureTransport,
  type CaptureTransport,
} from '../src/capture.js';
import { extractProgressClaim } from '../src/regex.js';


function el(index: number, role: string, name: string, checked?: boolean) {
  return {
    index,
    role,
    name,
    tag: role === 'text' ? 'div' : 'input',
    ...(checked !== undefined ? { checked } : {}),
    rect: { x: 0, y: 0, w: 10, h: 10 },
  };
}

function table(elements: Array<ReturnType<typeof el>>, url = 'https://exam.example.com/quiz/1'): ElementTable {
  return { url, title: 'quiz', capturedAt: 1000, elements };
}

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c4g-corpus-'));
  tmpDirs.push(dir);
  return dir;
}

describe('regex extractProgressClaim', () => {
  it('parses 第 x/y 题', () => {
    const claim = extractProgressClaim('当前进度 第 3/12 题,请认真作答');
    assert.deepEqual(claim, { raw: '第 3/12 题', current: 3, total: 12 });
  });

  it('parses Question x of y case-insensitively', () => {
    const claim = extractProgressClaim('Question 7 of 30');
    assert.deepEqual(claim, { raw: 'Question 7 of 30', current: 7, total: 30 });
  });

  it('parses x/y 题 without 第', () => {
    const claim = extractProgressClaim('进度:2/20 题');
    assert.deepEqual(claim, { raw: '2/20 题', current: 2, total: 20 });
  });

  it('rejects date-like fractions without 题', () => {
    assert.equal(extractProgressClaim('截止 2026/09/21'), null);
    assert.equal(extractProgressClaim('得分 5/100'), null);
  });

  it('rejects out-of-range ordinals', () => {
    assert.equal(extractProgressClaim('第 15/12 题'), null);
    assert.equal(extractProgressClaim('第 0/12 题'), null);
    assert.equal(extractProgressClaim('第 3/5000 题'), null);
  });

  it('returns null on empty input', () => {
    assert.equal(extractProgressClaim(''), null);
  });
});

describe('capture ids and signatures', () => {
  it('captureId is deterministic 16-hex from origin|path|time', () => {
    const id1 = computeCaptureId('https://exam.example.com/quiz/123', 1758200002000);
    const id2 = computeCaptureId('https://exam.example.com/quiz/123', 1758200002000);
    const id3 = computeCaptureId('https://exam.example.com/quiz/124', 1758200002000);
    assert.equal(id1, id2);
    assert.notEqual(id1, id3);
    assert.match(id1, /^[0-9a-f]{16}$/);
    // query strings must not affect the id (pathname only)
    assert.equal(computeCaptureId('https://x.com/a?b=1', 5), computeCaptureId('https://x.com/a?c=2', 5));
  });

  it('tableSignature changes when checked state changes', () => {
    const t1 = table([el(1, 'radio', 'a', false), el(2, 'radio', 'b', false)]);
    const t2 = table([el(1, 'radio', 'a', true), el(2, 'radio', 'b', false)]);
    const t3 = table([el(1, 'radio', 'a', false), el(2, 'radio', 'b', false)]);
    assert.notEqual(tableSignature(t1), tableSignature(t2));
    assert.equal(tableSignature(t1), tableSignature(t3));
  });
});

describe('captureFromWs convergence loop', () => {
  function scriptedTransport(snapshots: ElementTable[], pageText?: string): {
    transport: CaptureTransport;
    scrolls: number[];
  } {
    const scrolls: number[] = [];
    let call = 0;
    return {
      scrolls,
      transport: {
        async snapshot() {
          const table = snapshots[Math.min(call, snapshots.length - 1)];
          call++;
          return { table, ...(pageText !== undefined ? { pageText } : {}) };
        },
        async act(action) {
          if (action.op === 'scroll') scrolls.push(action.deltaY);
          return { ok: true, url: 'https://exam.example.com/quiz/1' };
        },
      },
    };
  }

  it('stops early when the table stabilises', async () => {
    // Convergence means two consecutive identical snapshots: the first repeat
    // (not the first change) is what proves the page settled.
    const stable = table([el(1, 'radio', 'a'), el(2, 'radio', 'b'), el(3, 'text', '1. 题？'), el(4, 'radio', 'c')]);
    const { transport, scrolls } = scriptedTransport([stable, stable]);
    const capture = await captureFromWs(transport, { now: () => 1758200002000 });
    assert.equal(scrolls.length, 1, 'one scroll before the confirming re-snapshot');
    assert.equal(capture.table.elements.length, 4);
    assert.equal(capture.captureId, computeCaptureId('https://exam.example.com/quiz/1', 1758200002000));
  });

  it('caps rounds at maxRounds', async () => {
    let counter = 0;
    const { transport, scrolls } = scriptedTransport([]);
    const mutating: CaptureTransport = {
      snapshot: async () => {
        counter++;
        return { table: table([el(1, 'radio', `gen-${counter}`)]) };
      },
      act: transport.act,
    };
    const capture = await captureFromWs(mutating, { maxRounds: 4, now: () => 1 });
    assert.equal(scrolls.length, 3, 'no scroll after the final round');
    assert.equal(capture.table.elements.length, 1);
  });

  it('notes missing pageText in diagnostics but still captures', async () => {
    const { transport } = scriptedTransport([table([el(1, 'radio', 'a')])]);
    const capture = await captureFromWs(transport, { now: () => 5 });
    assert.equal(capture.pageText, undefined);
    assert.ok(capture.diagnostics.some((d) => d.includes('pageText')));
  });

  it('extracts progressClaim from pageText when present', async () => {
    const { transport } = scriptedTransport([table([el(1, 'radio', 'a')])], '第 2/10 题');
    const capture = await captureFromWs(transport, { now: () => 5 });
    assert.deepEqual(capture.progressClaim, { raw: '第 2/10 题', current: 2, total: 10 });
  });
});

describe('assembleCapture + qualityCheck', () => {
  it('derives origin and truncates pageText', () => {
    const capture = assembleCapture({
      table: table([el(1, 'radio', 'a')]),
      pageText: 'x'.repeat(40 * 1024),
      capturedAt: 7,
    });
    assert.equal(capture.origin, 'https://exam.example.com');
    assert.ok((capture.pageText?.length ?? 0) <= 32 * 1024);
  });

  it('falls back to title for progress claims when no pageText', () => {
    const capture = assembleCapture({
      table: { ...table([el(1, 'radio', 'a')]), title: '第 1/5 题 小测' },
      capturedAt: 7,
    });
    assert.deepEqual(capture.progressClaim, { raw: '第 1/5 题', current: 1, total: 5 });
  });

  it('flags empty table, candidate-less tables and broken indices', () => {
    const empty = assembleCapture({ table: table([]), capturedAt: 1 });
    assert.ok(qualityCheck(empty).defective);

    const noCandidates = assembleCapture({ table: table([el(1, 'text', 'hello world')]), capturedAt: 1 });
    assert.ok(qualityCheck(noCandidates).defective);

    const dup = assembleCapture({ table: table([el(1, 'radio', 'a'), el(1, 'radio', 'b')]), capturedAt: 1 });
    assert.ok(qualityCheck(dup).defective);

    const good = assembleCapture({ table: table([el(1, 'radio', 'a'), el(2, 'radio', 'b')]), capturedAt: 1 });
    assert.equal(qualityCheck(good).defective, false);
  });

  it('flags origin/url mismatch', () => {
    const bad = assembleCapture({ table: table([el(1, 'radio', 'a')], 'https://other.example.net/q'), capturedAt: 1 });
    // assembleCapture derives origin from table.url, so build a mismatch by hand:
    const mutated = { ...bad, origin: 'https://somewhere.else' };
    assert.ok(qualityCheck(mutated).defective);
  });
});

describe('corpus persistence', () => {
  function sampleCapture(captureId: string): ReturnType<typeof assembleCapture> {
    const base = assembleCapture({ table: table([el(1, 'radio', 'a')]), capturedAt: 1758200002000 });
    return { ...base, captureId };
  }

  it('save/load roundtrip and index bookkeeping', () => {
    const dir = tmpCorpus();
    const a = sampleCapture('aaaaaaaaaaaaaaaa');
    const b = sampleCapture('bbbbbbbbbbbbbbbb');
    assert.equal(saveCapture(dir, a).defective, false);
    assert.equal(saveCapture(dir, b).defective, false);
    // re-saving the same id must not duplicate index entries
    saveCapture(dir, a);

    assert.equal(listCaptures(dir).length, 2);
    const loaded = loadCapture(dir, 'aaaaaaaaaaaaaaaa');
    assert.ok(loaded);
    assert.equal(loaded.captureId, 'aaaaaaaaaaaaaaaa');
    assert.equal(loaded.table.elements[0].name, 'a');
    assert.equal(loadCapture(dir, 'missing00000000000'), null);

    const rawIndex = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as {
      captures: Array<{ captureId: string }>;
    };
    assert.equal(rawIndex.captures.length, 2);
  });

  it('persists defective captures with their defects', () => {
    const dir = tmpCorpus();
    const defective = assembleCapture({ table: table([]), capturedAt: 9 });
    const quality = saveCapture(dir, defective);
    assert.equal(quality.defective, true);
    const entry = listCaptures(dir).find((c) => c.captureId === defective.captureId);
    assert.ok(entry?.defective);
    assert.ok(entry?.defects.includes('empty element table'));
  });

  it('groups captures by origin directory', () => {
    const dir = tmpCorpus();
    const other = assembleCapture({
      table: table([el(1, 'radio', 'a')], 'https://other.example.net/quiz'),
      capturedAt: 3,
    });
    saveCapture(dir, other);
    assert.equal(loadCapture(dir, other.captureId)?.origin, 'https://other.example.net');
  });
});

describe('wsCaptureTransport adapter', () => {
  it('bridges the WsBridge structural subset', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const fakeWs = {
      snapshot: async (tabId: number, opts?: { includePageText?: boolean }) => {
        calls.push({ method: 'snapshot', args: [tabId, opts] });
        return opts?.includePageText
          ? { table: table([el(1, 'radio', 'a')]), pageText: 'body text' }
          : { table: table([el(1, 'radio', 'a')]) };
      },
      act: async (tabId: number, action: Parameters<CaptureTransport['act']>[0]) => {
        calls.push({ method: 'act', args: [tabId, action] });
        return { ok: true, url: 'https://exam.example.com/quiz/1' };
      },
    };
    const transport = wsCaptureTransport(fakeWs, 42);
    const snap = await transport.snapshot({ includePageText: true });
    assert.equal(snap.table.elements.length, 1);
    assert.equal(snap.pageText, 'body text');
    const act = await transport.act({ op: 'scroll', deltaY: 600 });
    assert.equal(act.ok, true);
    assert.deepEqual(
      calls.map((c) => c.method),
      ['snapshot', 'act'],
    );
    assert.deepEqual(calls[0].args, [42, { includePageText: true }]);
  });
});

describe('P1 fixture compatibility', () => {
  it('generic-radios fixture passes the quality gate', async () => {
    const { readFileSync } = await import('node:fs');
    const { parsePageCapture } = await import('@c4g/protocol');
    const fixtureRoot = join(import.meta.dirname, 'fixtures/corpus');
    const capture = parsePageCapture(
      JSON.parse(readFileSync(join(fixtureRoot, 'generic-radios/capture.json'), 'utf8')),
    );
    const quality = qualityCheck(capture);
    assert.equal(quality.defective, false, JSON.stringify(quality.defects));
  });
});
