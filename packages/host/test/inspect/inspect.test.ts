import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { ElementTable, InspectionResult, PageCapture } from '@c4g/protocol';
import { inspectPage } from '../../src/inspect/index.js';
import { dryRunInspectDeps } from '../../src/inspect/index.js';
import type { Arbitrator } from '../../src/inspect/arbitrate.js';
import { LlmEnumerator } from '../../src/inspect/llm.js';
import { inspectSession } from '../../src/inspect/session.js';

const noopLog = () => {};

function loadFixture(name: string): { capture: PageCapture; gold: InspectionResult } {
  const capture = JSON.parse(
    readFileSync(new URL(`../fixtures/corpus/${name}/capture.json`, import.meta.url), 'utf8'),
  ) as PageCapture;
  const gold = JSON.parse(
    readFileSync(new URL(`../fixtures/corpus/${name}/gold.json`, import.meta.url), 'utf8'),
  ) as InspectionResult;
  return { capture, gold };
}

function assertMatchesGold(result: InspectionResult, gold: InspectionResult): void {
  assert.equal(result.questions.length, gold.questions.length, 'question count');
  gold.questions.forEach((gq, i) => {
    const rq = result.questions[i];
    assert.equal(rq.stemIndex, gq.stemIndex, `question ${i} stemIndex`);
    assert.deepEqual([...rq.optionIndices].sort((a, b) => a - b), [...gq.optionIndices].sort((a, b) => a - b), `question ${i} options`);
    assert.deepEqual([...rq.inputIndices].sort((a, b) => a - b), [...gq.inputIndices].sort((a, b) => a - b), `question ${i} inputs`);
    assert.equal(rq.answered, gq.answered, `question ${i} answered`);
    assert.equal(rq.source, gq.source, `question ${i} source`);
  });
  assert.deepEqual([...result.navIndices].sort((a, b) => a - b), [...gold.navIndices].sort((a, b) => a - b), 'nav');
  assert.deepEqual(
    result.excluded.map((e) => e.index).sort((a, b) => a - b),
    gold.excluded.map((e) => e.index).sort((a, b) => a - b),
    'excluded',
  );
  assert.equal(result.conservation.status, gold.conservation.status, 'conservation');
}

describe('inspectPage vs P1 gold fixtures (dry-run, heuristic-only)', () => {
  for (const name of ['moodle-like', 'generic-radios', 'tricky'] as const) {
    it(`matches gold: ${name}`, async () => {
      const { capture, gold } = loadFixture(name);
      const result = await inspectPage(capture, dryRunInspectDeps(noopLog));
      assertMatchesGold(result, gold);
      assert.equal(result.conservation.rounds, 1);
      assert.deepEqual(result.conservation.unaccounted, []);
      assert.ok(result.diagnostics.some((d) => d.includes('dry-run')));
    });
  }
});

// --- scripted-LLM helpers -----------------------------------------------------

interface ScriptedLlm {
  llm: LlmEnumerator;
  calls: () => number;
  prompts: () => string[];
}

function scriptedLlm(responses: string[]): ScriptedLlm {
  const prompts: string[] = [];
  let call = 0;
  const llm = new LlmEnumerator(
    async (_system, user) => {
      prompts.push(user);
      const response = responses[call];
      call++;
      return response ?? '{}';
    },
    noopLog,
    true,
  );
  return { llm, calls: () => call, prompts: () => prompts };
}

function acceptLlmArbitrator(): Arbitrator {
  return { dryRun: false, arbitrate: async () => ({ winner: 'llm', confidence: 0.9 }) };
}

function stemlessRadiosCapture(): PageCapture {
  const table: ElementTable = {
    url: 'https://odd.test/quiz',
    title: 'odd',
    capturedAt: 42,
    elements: [
      { index: 1, role: 'text', name: '选项', tag: 'div', rect: { x: 0, y: 0, w: 8, h: 8 } }, // too short to be a stem
      { index: 2, role: 'radio', name: '甲', tag: 'input', rect: { x: 0, y: 8, w: 8, h: 8 } },
      { index: 3, role: 'radio', name: '乙', tag: 'input', rect: { x: 0, y: 16, w: 8, h: 8 } },
      { index: 4, role: 'button', name: '提交', tag: 'button', rect: { x: 0, y: 24, w: 8, h: 8 } },
    ],
  };
  return { captureId: 'odd0000000000001', url: table.url, origin: 'https://odd.test', capturedAt: table.capturedAt, table };
}

describe('inspectPage: conservation feedback loop', () => {
  it('rescues stem-less controls in round 2 after a hallucinated first reply', async () => {
    const scripted = scriptedLlm([
      // round 1: hallucinated option index 999 → dropped, question dies
      '{"questions":[{"stemIndex":1,"optionIndices":[999],"inputIndices":[]}],"navIndices":[],"excludedIndices":[]}',
      // round 2 (missing [2,3]): valid grouping
      '{"questions":[{"stemIndex":1,"optionIndices":[2,3],"inputIndices":[]}],"navIndices":[4],"excludedIndices":[]}',
    ]);
    const deps = { llm: scripted.llm, arbitrate: acceptLlmArbitrator(), log: noopLog };
    const result = await inspectPage(stemlessRadiosCapture(), deps);

    assert.equal(result.conservation.status, 'pass');
    assert.equal(result.conservation.rounds, 2);
    assert.equal(result.questions.length, 1);
    assert.equal(result.questions[0].source, 'arbitrated');
    assert.deepEqual(result.questions[0].optionIndices, [2, 3]);
    assert.deepEqual(result.navIndices, [4]);
    assert.ok(result.diagnostics.some((d) => d.includes('hallucinated option index 999')));
    assert.ok(result.diagnostics.some((d) => d.includes('conservation feedback')));
    assert.ok(scripted.prompts()[1].includes('[2, 3]'), 'feedback prompt names the missing indices');
  });

  it('fails conservation when the feedback round cannot place the controls', async () => {
    const scripted = scriptedLlm([
      '{"questions":[],"navIndices":[],"excludedIndices":[]}',
      '{"questions":[],"navIndices":[],"excludedIndices":[2]}', // only covers one of [2,3]
    ]);
    const deps = { llm: scripted.llm, arbitrate: acceptLlmArbitrator(), log: noopLog };
    const result = await inspectPage(stemlessRadiosCapture(), deps);

    assert.equal(result.conservation.status, 'fail');
    assert.deepEqual(result.conservation.unaccounted, [3]);
    assert.ok(result.diagnostics.some((d) => d.includes('answering must not proceed')));
  });

  it('excludes rejected llm-only questions so conservation stays auditable', async () => {
    const scripted = scriptedLlm([
      '{"questions":[{"stemIndex":1,"optionIndices":[2,3],"inputIndices":[]}],"navIndices":[],"excludedIndices":[]}',
    ]);
    const deps = {
      llm: scripted.llm,
      arbitrate: { dryRun: false, arbitrate: async () => ({ winner: 'unclassified', confidence: 0.2 }) } as Arbitrator,
      log: noopLog,
    };
    const result = await inspectPage(stemlessRadiosCapture(), deps);

    assert.equal(result.questions.length, 0);
    // stem is role 'text' (not a quiz candidate); the option controls are
    // explicitly excluded so conservation stays auditable.
    assert.deepEqual(
      result.excluded.map((e) => e.index).sort((a, b) => a - b),
      [2, 3],
    );
    assert.equal(result.conservation.status, 'pass');
    assert.ok(result.diagnostics.some((d) => d.includes('rejected')));
  });
});

// --- session merge ------------------------------------------------------------

function questionPage(captureId: string, url: string, capturedAt: number, elements: ElementTable['elements'], claim?: PageCapture['progressClaim']): PageCapture {
  const table: ElementTable = { url, title: 't', capturedAt, elements };
  return { captureId, url, origin: 'https://s.test', capturedAt, table, ...(claim ? { progressClaim: claim } : {}) };
}

const el = (index: number, role: string, name: string, tag: string): ElementTable['elements'][number] => ({
  index,
  role,
  name,
  tag,
  rect: { x: 0, y: index * 8, w: 8, h: 8 },
});

describe('inspectSession', () => {
  it('dedupes overlapping questions and reconciles progress claims', async () => {
    const a = questionPage('cap-a', 'https://s.test/1', 1000, [
      el(1, 'text', '1. 问题一？', 'div'),
      el(2, 'radio', '甲', 'input'),
      el(3, 'radio', '乙', 'input'),
      el(4, 'text', '2. 问题二？', 'div'),
      el(5, 'radio', '丙', 'input'),
      el(6, 'radio', '丁', 'input'),
      el(7, 'button', '下一页', 'button'),
    ], { raw: '第 1 题，共 2 题', current: 1, total: 2 });
    const b = questionPage('cap-b', 'https://s.test/2', 2000, [
      el(1, 'text', '1. 问题一？', 'div'), // duplicate of cap-a question 1
      el(2, 'radio', '甲', 'input'),
      el(3, 'radio', '乙', 'input'),
      el(4, 'text', '3. 问题三？', 'div'),
      el(5, 'radio', '戊', 'input'),
      el(6, 'radio', '己', 'input'),
      el(7, 'button', '提交答案', 'button'),
    ], { raw: '第 2 题，共 2 题', current: 2, total: 2 });

    const session = await inspectSession([b, a], dryRunInspectDeps(noopLog)); // deliberately out of order

    assert.deepEqual(session.captures.map((c) => c.captureId), ['cap-a', 'cap-b']);
    assert.equal(session.questions.length, 3);
    assert.deepEqual(
      session.questions.map((q) => q.stem),
      ['1. 问题一？', '2. 问题二？', '3. 问题三？'],
    );
    assert.deepEqual(session.progress, { claimedDone: 2, claimedTotal: 2, seen: 3 });
    assert.ok(session.diagnostics.some((d) => d.includes('deduped')));
    assert.ok(!session.diagnostics.some((d) => d.startsWith('needs-hunt')));
  });

  it('flags needs-hunt when fewer questions were seen than the platform claims', async () => {
    const a = questionPage('cap-c', 'https://s.test/1', 1000, [
      el(1, 'text', '1. 问题一？', 'div'),
      el(2, 'radio', '甲', 'input'),
      el(3, 'radio', '乙', 'input'),
      el(4, 'button', '保存', 'button'),
    ], { raw: '第 1 题，共 5 题', current: 1, total: 5 });

    const session = await inspectSession([a], dryRunInspectDeps(noopLog));

    assert.equal(session.questions.length, 1);
    assert.equal(session.progress.claimedTotal, 5);
    assert.ok(session.diagnostics.some((d) => d.startsWith('needs-hunt') && d.includes('4')));
  });

  it('flags needs-hunt when a page fails conservation', async () => {
    const a = questionPage('cap-d', 'https://s.test/1', 1000, [
      el(1, 'text', '选项', 'div'),
      el(2, 'radio', '甲', 'input'),
      el(3, 'radio', '乙', 'input'),
    ]);

    const session = await inspectSession([a], dryRunInspectDeps(noopLog));

    assert.equal(session.questions.length, 0);
    assert.ok(session.diagnostics.some((d) => d.startsWith('needs-hunt') && d.includes('conservation')));
  });
});
