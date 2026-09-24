import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Action, ElementTable } from '@c4g/protocol';
import type { WsBridge } from '../src/ws-server.js';
import type { QuizSolver } from '../src/solver.js';
import type { LogFn } from '../src/log.js';
import { runQuizLoop, type QuizLoopDeps, type QuizLoopReport } from '../src/quiz-loop.js';
import { dryRunInspectDeps } from '../src/inspect/index.js';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

interface FakeEl {
  index: number;
  role: string;
  name: string;
  checked?: boolean;
  value?: string;
  disabled?: boolean;
  htmlName?: string;
}

/** In-memory page: click/type mutate state, scroll can reveal hidden content. */
class FakeWs {
  els: FakeEl[] = [];
  hidden: FakeEl[] = []; // revealed by the first scroll
  title = 'quiz';
  readonly calls: Array<{ method: string; action?: Action; opts?: { quizOnly?: boolean } }> = [];
  /** When false, clicks do NOT mutate state (read-back verification failure). */
  mutationsWork = true;
  /** Indices whose clicks silently fail to register (transient miss). */
  failClicksOn = new Set<number>();

  constructor(els: FakeEl[]) {
    this.els = els;
  }

  private table(): ElementTable {
    return {
      url: 'https://exam.example.com/quiz/1',
      title: this.title,
      capturedAt: 1_700_000_000_000,
      elements: this.els.map((el) => ({ ...el })),
    };
  }

  // WsBridge structural subset (opts-object signature)
  async snapshot(_tabId: number, opts?: { quizOnly?: boolean; includePageText?: boolean }) {
    this.calls.push({ method: 'snapshot', opts });
    return { table: this.table() };
  }

  /** Simulates the __c4gRef probe the loop uses for read-back (review M1). */
  async evalJson(_tabId: number, expression: string) {
    this.calls.push({ method: 'eval' });
    const m = /^\[([\d,\s]*)\]/.exec(expression);
    if (!m) return null;
    const indices = m[1]!.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    const wantsChecked = expression.includes('checked');
    return indices.map((i) => {
      const el = this.els.find((e) => e.index === i);
      if (!el) return null;
      return wantsChecked ? el.checked === true : (el.value ?? '').trim() !== '';
    });
  }

  async act(_tabId: number, action: Action) {
    this.calls.push({ method: 'act', action });
    if (action.op === 'scroll') {
      if (this.hidden.length > 0) {
        const max = Math.max(...this.els.map((e) => e.index));
        this.hidden.forEach((el, i) => this.els.push({ ...el, index: max + 1 + i }));
        this.hidden = [];
      }
      return { ok: true, url: 'https://exam.example.com/quiz/1' };
    }
    if (action.op === 'click') {
      const el = this.els.find((e) => e.index === action.index);
      if (el && this.mutationsWork && !this.failClicksOn.has(action.index)) {
        // Checkboxes TOGGLE like real inputs — a second click unchecks.
        if (el.role === 'checkbox') el.checked = !el.checked;
        else el.checked = true;
      }
      return { ok: true, url: 'https://exam.example.com/quiz/1' };
    }
    if (action.op === 'type') {
      const el = this.els.find((e) => e.index === action.index);
      if (el && this.mutationsWork) el.value = 'answer';
      return { ok: true, url: 'https://exam.example.com/quiz/1' };
    }
    return { ok: true, url: 'https://exam.example.com/quiz/1' };
  }

  clickedIndices(): number[] {
    return this.calls.filter((c) => c.action?.op === 'click').map((c) => (c.action as { index: number }).index);
  }

  evalCalls(): number {
    return this.calls.filter((c) => c.method === 'eval').length;
  }
}

function stubSolver(opts: { enabled?: boolean; pick?: (options: Array<{ index: number; text: string }>) => number } = {}): QuizSolver {
  return {
    enabled: opts.enabled ?? true,
    async solve(_q, options) {
      const pick = opts.pick ?? ((os) => os[0].index);
      return { indices: [pick(options)] };
    },
    async solveShortAnswer() {
      return { text: '42' };
    },
  } as unknown as QuizSolver;
}

const log: LogFn = () => {};

function makeDeps(ws: FakeWs, solver: QuizSolver, autoSubmit: boolean): QuizLoopDeps {
  return { ws: ws as unknown as WsBridge, solver, inspect: dryRunInspectDeps(log), log, autoSubmit };
}

function q1q2Page(): FakeEl[] {
  return [
    { index: 1, role: 'text', name: '1. 中国的首都是哪座城市？' },
    { index: 2, role: 'radio', name: '北京' },
    { index: 3, role: 'radio', name: '上海' },
    { index: 4, role: 'text', name: '2. 一加一等于？' },
    { index: 5, role: 'radio', name: '三' },
    { index: 6, role: 'radio', name: '二' },
  ];
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('runQuizLoop on the inspect pipeline', () => {
  it('answers two single-choice questions, saves, and never touches submit with AUTO_SUBMIT=false', async () => {
    const ws = new FakeWs([
      ...q1q2Page(),
      { index: 7, role: 'button', name: '保存答案' },
      { index: 8, role: 'button', name: '交卷' },
    ]);
    const solver = stubSolver({ pick: (os) => os.find((o) => o.text === '北京' || o.text === '二')?.index ?? os[0].index });
    const report: QuizLoopReport = await runQuizLoop(makeDeps(ws, solver, false), 42);

    assert.equal(report.stopped, 'no-questions');
    assert.equal(report.answered, 2);
    assert.equal(report.conservation, 'pass');
    assert.equal(report.hunts, 0);
    // Submit (8) must never be clicked when AUTO_SUBMIT=false.
    assert.equal(ws.clickedIndices().includes(8), false);
    assert.ok(ws.clickedIndices().includes(7), 'save control clicked');
  });

  it('stops with submit-blocked when only a submit control exists and AUTO_SUBMIT=false', async () => {
    const ws = new FakeWs([...q1q2Page(), { index: 7, role: 'button', name: '交卷' }]);
    const solver = stubSolver({ pick: (os) => os.find((o) => o.text === '北京' || o.text === '二')?.index ?? os[0].index });
    const report = await runQuizLoop(makeDeps(ws, solver, false), 42);

    assert.equal(report.stopped, 'submit-blocked');
    assert.equal(report.answered, 2);
    assert.equal(ws.clickedIndices().includes(7), false, 'submit never clicked');
  });

  it('submits and completes when AUTO_SUBMIT=true', async () => {
    const ws = new FakeWs([...q1q2Page(), { index: 7, role: 'button', name: '交卷' }]);
    const solver = stubSolver({ pick: (os) => os.find((o) => o.text === '北京' || o.text === '二')?.index ?? os[0].index });
    const report = await runQuizLoop(makeDeps(ws, solver, true), 42);

    assert.equal(report.stopped, 'completed');
    assert.equal(report.navClicked, '交卷');
    assert.ok(ws.clickedIndices().includes(7));
  });

  it('hunts when progress claims more questions than the page can reveal', async () => {
    const ws = new FakeWs(q1q2Page());
    ws.title = '第 2/5 题 小测'; // claim says 5, convergence capture only ever sees 2
    const solver = stubSolver({ pick: (os) => os.find((o) => o.text === '北京' || o.text === '二')?.index ?? os[0].index });
    const report = await runQuizLoop(makeDeps(ws, solver, false), 42);

    // Both hunts fired (claim still exceeds seen), both visible questions answered.
    assert.equal(report.hunts, 2);
    assert.equal(report.answered, 2);
    assert.equal(report.conservation, 'pass');
    assert.equal(report.stopped, 'no-questions');
    assert.ok(report.diagnostics.some((d) => d.includes('progress mismatch persists')));
  });

  it('refuses to answer when conservation stays red after all hunt rounds', async () => {
    const ws = new FakeWs([
      { index: 1, role: 'radio', name: '孤儿选项' }, // option run with no stem → unassigned
      { index: 2, role: 'button', name: '保存' },
    ]);
    const report = await runQuizLoop(makeDeps(ws, stubSolver(), false), 42);

    assert.equal(report.stopped, 'conservation-failed');
    assert.equal(report.answered, 0);
    assert.equal(report.conservation, 'fail');
    assert.equal(report.hunts, 2);
    assert.equal(ws.clickedIndices().length, 0, 'no answering clicks on a red inspection');
  });

  it('stops solver-unavailable without answering when no key is configured', async () => {
    const ws = new FakeWs(q1q2Page());
    const report = await runQuizLoop(makeDeps(ws, stubSolver({ enabled: false }), false), 42);

    assert.equal(report.stopped, 'solver-unavailable');
    assert.equal(report.answered, 0);
    assert.equal(ws.clickedIndices().filter((i) => i === 2 || i === 3).length, 0);
  });

  it('counts verify-failed questions as skipped when read-back never confirms', async () => {
    const ws = new FakeWs(q1q2Page());
    ws.mutationsWork = false; // clicks never change state
    const report = await runQuizLoop(makeDeps(ws, stubSolver(), false), 42);

    assert.equal(report.answered, 0);
    assert.equal(report.verifyFailed, 2);
    assert.equal(report.skipped, 2);
    assert.equal(report.stopped, 'no-questions');
  });
});

describe('read-back index space (review F1 + M1 regression)', () => {
  it('never reads back with quizOnly, and read-back probes do not snapshot', async () => {
    const ws = new FakeWs(q1q2Page());
    const report = await runQuizLoop(makeDeps(ws, stubSolver(), false), 42);
    const snapshotCalls = ws.calls.filter((c) => c.method === 'snapshot');
    assert.ok(snapshotCalls.length >= 1, 'expected at least the capture snapshot');
    assert.equal(
      snapshotCalls.some((c) => c.opts?.quizOnly === true),
      false,
      'quizOnly re-indexes and aliases the executor ref cache — forbidden for read-back',
    );
    // Read-back goes through __c4gRef eval probes — a fresh snapshot would
    // replace the ref cache and misalign every later click (review M1).
    assert.ok(ws.evalCalls() > 0, 'read-back must probe via eval');
    assert.equal(report.answered, 2);
  });

  it('verifies against a shifted full-table read-back (indices stay grounded)', async () => {
    // Simulate a real page: non-quiz elements before the quiz shift NOTHING in
    // the full table, but a quizOnly filter would. Read-back must agree with
    // the capture's index space.
    const ws = new FakeWs([
      { index: 1, role: 'button', name: '登录' }, // non-quiz noise
      ...q1q2Page().map((el) => ({ ...el, index: el.index + 1 })),
      { index: 9, role: 'button', name: '交卷' },
    ]);
    const solver = stubSolver({ pick: (os) => os.find((o) => o.text === '北京' || o.text === '二')?.index ?? os[0].index });
    const report = await runQuizLoop(makeDeps(ws, solver, false), 42);
    assert.equal(report.answered, 2);
    assert.equal(report.verifyFailed, 0, 'read-back must confirm answers in the full-table index space');
  });
});

describe('multi-select semantics (review H3)', () => {
  const multiSolver = (indices: number[]): QuizSolver =>
    ({
      enabled: true,
      async solve() {
        return { indices };
      },
      async solveShortAnswer() {
        return { text: '42' };
      },
    }) as unknown as QuizSolver;

  it('answers a proper-subset selection without toggling correct options off', async () => {
    const ws = new FakeWs([
      { index: 1, role: 'text', name: '1. 选出所有偶数' },
      { index: 2, role: 'checkbox', name: '一' },
      { index: 3, role: 'checkbox', name: '二' },
      { index: 4, role: 'checkbox', name: '三' },
      { index: 5, role: 'checkbox', name: '四' },
      { index: 6, role: 'button', name: '保存答案' },
    ]);
    // Solver picks a proper subset {二, 四}. The old every()-based read-back
    // marked this unanswered forever and the retry toggled the correct
    // selections back OFF (FakeWs checkboxes toggle like real inputs).
    const report = await runQuizLoop(makeDeps(ws, multiSolver([3, 5]), false), 42);
    assert.equal(report.answered, 1);
    assert.equal(report.verifyFailed, 0);
    const clicks = ws.clickedIndices();
    assert.equal(clicks.filter((i) => i === 3).length, 1, 'each chosen option clicked exactly once');
    assert.equal(clicks.filter((i) => i === 5).length, 1);
    assert.equal(clicks.includes(2) || clicks.includes(4), false, 'unwanted options untouched');
  });

  it('treats a partially-checked multi-select as already answered (no re-click)', async () => {
    const ws = new FakeWs([
      { index: 1, role: 'text', name: '1. 选出所有偶数' },
      { index: 2, role: 'checkbox', name: '一' },
      { index: 3, role: 'checkbox', name: '二', checked: true }, // pre-answered subset
      { index: 4, role: 'checkbox', name: '三' },
      { index: 5, role: 'button', name: '保存答案' },
    ]);
    const report = await runQuizLoop(makeDeps(ws, multiSolver([2, 4]), false), 42);
    // The question is already answered on the page — the loop must not
    // re-answer it (clicking 3 would toggle the correct selection OFF).
    assert.equal(report.answered, 0);
    assert.equal(report.verifyFailed, 0);
    const clicks = ws.clickedIndices();
    assert.equal(clicks.includes(3), false, 'never re-clicks a checked box');
    assert.equal(clicks.includes(2) || clicks.includes(4), false, 'no answering clicks at all');
  });

  it('idempotent retry: only the options still unchecked get re-clicked', async () => {
    const ws = new FakeWs([
      { index: 1, role: 'text', name: '1. 选出所有偶数' },
      { index: 2, role: 'checkbox', name: '一' },
      { index: 3, role: 'checkbox', name: '二' },
      { index: 4, role: 'checkbox', name: '四' },
      { index: 5, role: 'button', name: '保存答案' },
    ]);
    // The first click on index 4 silently misses; the retry must re-click
    // ONLY 4 — re-clicking the already-checked 3 would toggle it OFF.
    ws.failClicksOn.add(4);
    let released = false;
    const origAct = ws.act.bind(ws);
    ws.act = async (tabId: number, action: Action) => {
      const res = await origAct(tabId, action);
      if (!released && action.op === 'click' && action.index === 4) {
        released = true;
        ws.failClicksOn.delete(4); // second attempt lands
      }
      return res;
    };
    const report = await runQuizLoop(makeDeps(ws, multiSolver([3, 4]), false), 42);
    assert.equal(report.answered, 1);
    const clicks = ws.clickedIndices();
    assert.equal(clicks.filter((i) => i === 3).length, 1, 'checked option never re-clicked');
    assert.equal(clicks.filter((i) => i === 4).length, 2, 'missed option retried once');
  });
});
