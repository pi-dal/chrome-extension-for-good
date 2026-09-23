import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RING_SCRIPT,
  detectHeartbeat,
  installRingBuffer,
  readRing,
  type XhrSample,
} from '../src/observe.js';

describe('RING_SCRIPT (behavioral, fake window)', () => {
  function run(script: string, fakeWindow: Record<string, unknown>): unknown {
    return new Function('window', 'return ' + script)(fakeWindow);
  }

  function fakeWindow() {
    const xhrProto: Record<string, unknown> = {
      open() {},
      send() {},
    };
    function XMLHttpRequestLike(this: unknown) {}
    XMLHttpRequestLike.prototype = xhrProto as never;
    return {
      XMLHttpRequest: XMLHttpRequestLike,
      xhrProto,
      fetch: async () => ({ ok: true }),
    };
  }

  it('is syntactically valid JS and self-installs', () => {
    const w = fakeWindow() as unknown as Record<string, unknown>;
    const result = run(RING_SCRIPT, w);
    assert.equal(result, 'installed');
    const ring = w.__c4gXhrRing as { __installed: boolean; entries: unknown[] };
    assert.equal(ring.__installed, true);
  });

  it('is idempotent — second install is a no-op', () => {
    const w = fakeWindow() as unknown as Record<string, unknown>;
    assert.equal(run(RING_SCRIPT, w), 'installed');
    const ring = w.__c4gXhrRing as { entries: unknown[] };
    ring.entries.push({ t: 1, m: 'GET', u: '/keep-me' });
    assert.equal(run(RING_SCRIPT, w), 'already');
    assert.equal((w.__c4gXhrRing as { entries: unknown[] }).entries.length, 1);
  });

  it('records XHR requests without altering call-through', () => {
    const w = fakeWindow() as unknown as Record<string, unknown>;
    run(RING_SCRIPT, w);
    const XHR = w.XMLHttpRequest as new () => { open: (...a: unknown[]) => void; send: () => void; __c4gMeta?: unknown };
    const xhr = new XHR();
    xhr.open('post', '/lib/ajax/service.php?uniq=1');
    xhr.send();
    const ring = w.__c4gXhrRing as { entries: Array<{ m: string; u: string }> };
    assert.equal(ring.entries.length, 1);
    assert.equal(ring.entries[0].m, 'POST');
    assert.equal(ring.entries[0].u, '/lib/ajax/service.php?uniq=1');
  });

  it('caps the ring at 200 entries', () => {
    const w = fakeWindow() as unknown as Record<string, unknown>;
    run(RING_SCRIPT, w);
    const XHR = w.XMLHttpRequest as new () => { open: (...a: unknown[]) => void; send: () => void };
    for (let i = 0; i < 205; i++) {
      const xhr = new XHR();
      xhr.open('GET', `/p/${i}`);
      xhr.send();
    }
    const ring = w.__c4gXhrRing as { entries: Array<{ u: string }> };
    assert.equal(ring.entries.length, 200);
    assert.equal(ring.entries[0].u, '/p/5', 'oldest entries evicted first');
  });
});

describe('readRing', () => {
  it('parses the JSON envelope and drops malformed samples', async () => {
    const seen: string[] = [];
    const cdp = {
      evaluate: async <T>(expression: string): Promise<T> => {
        seen.push(expression);
        return JSON.stringify([
          { t: 1, m: 'GET', u: '/a' },
          { t: 'nope', m: 'GET', u: '/b' },
          'garbage',
        ]) as T;
      },
    };
    const samples = await readRing(cdp);
    assert.equal(samples.length, 1);
    assert.deepEqual(samples[0], { t: 1, m: 'GET', u: '/a' });
    assert.equal(seen.length, 1);
  });

  it('returns empty when the buffer is absent', async () => {
    const cdp = { evaluate: async () => 'undefined' };
    assert.deepEqual(await readRing(cdp), []);
  });
});

describe('detectHeartbeat (frequency clustering)', () => {
  const beat = (t: number, u = '/api/study/beat'): XhrSample => ({ t, m: 'POST', u });

  it('detects a regular 15s heartbeat, clustering by path (queries ignored)', () => {
    const samples = [
      beat(0, '/api/study/beat?u=aaa'),
      beat(15_000, '/api/study/beat?u=bbb'),
      beat(30_000, '/api/study/beat?u=ccc'),
      beat(45_000, '/api/study/beat?u=ddd'),
      beat(60_000, '/api/study/beat?u=eee'),
      { t: 1_000, m: 'GET', u: '/page/1' },
      { t: 22_000, m: 'GET', u: '/page/2' },
    ];
    const candidates = detectHeartbeat(samples);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].method, 'POST');
    assert.equal(candidates[0].path, '/api/study/beat');
    assert.equal(candidates[0].periodMs, 15_000);
    assert.equal(candidates[0].samples, 5);
    assert.ok(candidates[0].cv < 0.35);
  });

  it('needs at least 4 samples', () => {
    assert.deepEqual(detectHeartbeat([beat(0), beat(15_000), beat(30_000)]), []);
  });

  it('rejects irregular cadence (high CV)', () => {
    const samples = [beat(0), beat(4_000), beat(42_000), beat(46_500), beat(91_000)];
    assert.deepEqual(detectHeartbeat(samples), []);
  });

  it('rejects periods outside the 5–60s band', () => {
    const fast = [beat(0), beat(1_000), beat(2_000), beat(3_000), beat(4_000)];
    const slow = [beat(0), beat(120_000), beat(240_000), beat(360_000), beat(480_000)];
    assert.deepEqual(detectHeartbeat(fast), []);
    assert.deepEqual(detectHeartbeat(slow), []);
  });

  it('ranks multiple candidates by sample count then regularity', () => {
    const samples: XhrSample[] = [];
    for (let i = 0; i < 6; i++) samples.push(beat(i * 10_000, '/a/beat'));
    for (let i = 0; i < 4; i++) samples.push({ t: i * 20_000, m: 'POST', u: '/b/report' });
    const candidates = detectHeartbeat(samples);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].path, '/a/beat');
    assert.equal(candidates[1].path, '/b/report');
  });

  it('is pure: the input is never mutated', () => {
    const samples = [beat(0), beat(15_000), beat(30_000), beat(45_000)];
    const snapshot = JSON.stringify(samples);
    detectHeartbeat(samples);
    assert.equal(JSON.stringify(samples), snapshot);
  });
});

describe('observation-only invariants (source-level guards)', () => {
  it('ring script only observes — it always calls the original XHR/fetch', () => {
    assert.ok(RING_SCRIPT.includes('openOrig.apply(this, arguments)'));
    assert.ok(RING_SCRIPT.includes('sendOrig.apply(this, arguments)'));
    assert.ok(RING_SCRIPT.includes('fetchOrig.apply(this, arguments)'));
    // and it never constructs requests of its own
    assert.ok(!RING_SCRIPT.includes('new XMLHttpRequest'));
    assert.ok(!RING_SCRIPT.includes("fetch('"));
    assert.ok(!RING_SCRIPT.includes('set_time'));
  });

  it('detectHeartbeat never issues requests (no fetch/XHR references)', () => {
    assert.equal(detectHeartbeat.toString().includes('fetch'), false);
    assert.equal(detectHeartbeat.toString().includes('XMLHttpRequest'), false);
  });
});
