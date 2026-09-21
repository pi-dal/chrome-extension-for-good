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
}

/** In-memory page: click/type mutate state, scroll can reveal hidden content. */
class FakeWs {
  els: FakeEl[] = [];
  hidden: FakeEl[] = []; // revealed by the first scroll
  title = 'quiz';
  readonly calls: Array<{ method: string; action?: Action }> = [];
  /** When false, clicks do NOT mutate state (read-back verification failure). */
  mutationsWork = true;

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
  async snapshot(_tabId: number, _opts?: { quizOnly?: boolean; includePageText?: boolean }) {
    this.calls.push({ method: 'snapshot' });
    return { table: this.table() };
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
      if (el && this.mutationsWork) el.checked = true;
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

describe('read-back index space (review F1 regression)', () => {
  it('never reads back with quizOnly (index space must match the capture)', async () => {
    const ws = new FakeWs(q1q2Page());
    const report = await runQuizLoop(makeDeps(ws, stubSolver(), false), 42);
    const snapshotCalls = ws.calls.filter((c) => c.method === 'snapshot') as Array<{ quizOnly?: boolean }>;
    assert.ok(snapshotCalls.length >= 2, 'expected capture + read-back snapshots');
    assert.equal(
      snapshotCalls.some((c) => c.quizOnly === true),
      false,
      'quizOnly re-indexes and aliases the executor ref cache — forbidden for read-back',
    );
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
