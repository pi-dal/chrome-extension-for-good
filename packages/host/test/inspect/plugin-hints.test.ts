import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ElementTable, InspectionResult, PageCapture, SitePluginQuiz } from '@c4g/protocol';
import {
  applyQuizScope,
  hintSummaryLine,
  mergeNavLabels,
  navIndicesFromLabels,
  readProgressHint,
} from '../../src/inspect/plugin-hints.js';
import type { LogFn } from '../../src/log.js';

function logs(): { lines: string[]; log: LogFn } {
  const lines: string[] = [];
  const log: LogFn = (level, msg) => {
    lines.push(`${level}:${msg}`);
  };
  return { lines, log };
}

/** Two questions, two nav buttons and chrome outside the quiz container. */
function pageTable(): ElementTable {
  return {
    url: 'https://lms.example.com/mod/quiz/attempt.php',
    title: 'quiz',
    capturedAt: 1,
    elements: [
      { index: 0, role: 'link', name: '课程首页', tag: 'a', rect: { x: 0, y: 0, w: 10, h: 10 } },
      { index: 1, role: 'text', name: '第 1 题', tag: 'div', rect: { x: 0, y: 20, w: 10, h: 10 }, quizSlot: 'question' },
      { index: 2, role: 'radio', name: 'A', tag: 'input', rect: { x: 0, y: 40, w: 10, h: 10 }, quizSlot: 'option' },
      { index: 3, role: 'text', name: '第 2 题', tag: 'div', rect: { x: 0, y: 60, w: 10, h: 10 }, quizSlot: 'question' },
      { index: 4, role: 'radio', name: 'B', tag: 'input', rect: { x: 0, y: 80, w: 10, h: 10 }, quizSlot: 'option' },
      { index: 5, role: 'button', name: '保存', tag: 'button', rect: { x: 0, y: 100, w: 10, h: 10 } },
      { index: 6, role: 'button', name: '提交', tag: 'button', rect: { x: 0, y: 120, w: 10, h: 10 } },
      { index: 7, role: 'button', name: '返回课程', tag: 'button', rect: { x: 0, y: 140, w: 10, h: 10 } },
    ],
  };
}

function capture(): PageCapture {
  return {
    captureId: 'c1',
    url: 'https://lms.example.com/mod/quiz/attempt.php',
    origin: 'https://lms.example.com',
    capturedAt: 1,
    table: pageTable(),
  };
}

/** evalJson stand-in: the selector is passed through as the matching index set. */
function evalBySelector(map: Record<string, number[] | 'error'>, log: LogFn = () => {}): {
  evalJson: (expression: string) => Promise<unknown | null>;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    evalJson: async (expression: string): Promise<unknown | null> => {
      asked.push(expression);
      if (expression.includes('__c4gRef')) {
        const hit = Object.entries(map).find(([selector]) => expression.includes(selector));
        if (!hit) return null;
        if (hit[1] === 'error') throw new Error('probe exploded');
        // the transport hands the host the builder's raw value: an array of 0/1
        const inside = new Set(hit[1]);
        return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (inside.has(i) ? 1 : 0));
      }
      const text = Object.entries(map).find(([selector]) => expression.includes(selector));
      if (!text || text[1] === 'error') return null;
      return '已完成 37.5%';
    },
  };
}

describe('applyQuizScope', () => {
  const quiz: SitePluginQuiz = { rootSelector: '#quiz-region' };

  it('keeps only the elements inside the quiz container', async () => {
    const l = logs();
    const deps = evalBySelector({ '#quiz-region': [1, 2, 3, 4, 5, 6] }, l.log);
    const { capture: scoped, applied } = await applyQuizScope(capture(), quiz, { evalJson: deps.evalJson, log: l.log });
    assert.deepEqual(scoped.table.elements.map((e) => e.index), [1, 2, 3, 4, 5, 6]);
    assert.equal(applied.scoped, true);
    assert.match(applied.scopeNote ?? '', /kept 6\/8/);
    assert.match(applied.diagnostics[0]!, /kept 6\/8/);
  });

  it('keeps the whole page when the selector matches nothing', async () => {
    const l = logs();
    const deps = evalBySelector({ '#quiz-region': [] }, l.log);
    const { capture: scoped, applied } = await applyQuizScope(capture(), quiz, { evalJson: deps.evalJson, log: l.log });
    assert.equal(scoped.table.elements.length, 8, 'never silently produces an empty quiz');
    assert.equal(applied.scoped, false);
    assert.match(applied.scopeNote ?? '', /matched no snapshot element/);
    assert.ok(l.lines.some((line) => line.includes('matched no snapshot element')));
  });

  it('keeps the whole page when the probe fails', async () => {
    const l = logs();
    const deps = evalBySelector({ '#quiz-region': 'error' }, l.log);
    const { capture: scoped, applied } = await applyQuizScope(capture(), quiz, { evalJson: deps.evalJson, log: l.log });
    assert.equal(scoped.table.elements.length, 8);
    assert.equal(applied.scoped, false);
    assert.match(applied.scopeNote ?? '', /probe failed/);
  });

  it('does nothing when the plugin declares no scope', async () => {
    const l = logs();
    const deps = evalBySelector({}, l.log);
    const { capture: scoped, applied } = await applyQuizScope(capture(), {}, { evalJson: deps.evalJson, log: l.log });
    assert.equal(scoped.table.elements.length, 8);
    assert.equal(applied.scoped, false);
    assert.deepEqual(deps.asked, []);
  });

  it('rejects a selector that is not grammar-safe, without touching the capture', async () => {
    const l = logs();
    const deps = evalBySelector({}, l.log);
    const { capture: scoped, applied } = await applyQuizScope(capture(), { rootSelector: 'div{color:red}' }, { evalJson: deps.evalJson, log: l.log });
    assert.equal(scoped.table.elements.length, 8);
    assert.match(applied.scopeNote ?? '', /probe failed/);
  });
});

describe('navIndicesFromLabels', () => {
  it('matches labels case/whitespace-insensitively and skips disabled elements', () => {
    const table = pageTable();
    table.elements.push({ index: 8, role: 'button', name: '下一页', tag: 'button', disabled: true, rect: { x: 0, y: 160, w: 10, h: 10 } });
    assert.deepEqual(navIndicesFromLabels(table, ['保存', '提交']), [5, 6]);
    assert.deepEqual(navIndicesFromLabels(table, ['下一页']), [], 'disabled buttons are not nav');
    // whitespace inside a label is ignored on both sides, so "  保 存 " still hits 保存
    assert.deepEqual(navIndicesFromLabels(table, ['  保 存 ']), [5]);
    assert.deepEqual(navIndicesFromLabels(table, []), []);
  });
});

describe('mergeNavLabels', () => {
  it('adds only new indices and keeps them sorted', () => {
    const result: InspectionResult = {
      captureId: 'c1',
      questions: [],
      navIndices: [6],
      excluded: [],
      conservation: { status: 'pass', rounds: 1, unaccounted: [] },
      diagnostics: [],
    };
    const merged = mergeNavLabels(result, pageTable(), ['保存', '提交', '返回课程']);
    assert.deepEqual(merged.result.navIndices, [5, 6, 7]);
    assert.deepEqual(merged.added, [5, 7], 'the index the pipeline already found is not reported twice');
    assert.ok(merged.result.diagnostics.some((d) => d.includes('nav buttons from plugin labels')));
  });

  it('is a no-op when nothing matches', () => {
    const result: InspectionResult = {
      captureId: 'c1',
      questions: [],
      navIndices: [1],
      excluded: [],
      conservation: { status: 'pass', rounds: 1, unaccounted: [] },
      diagnostics: ['kept'],
    };
    const merged = mergeNavLabels(result, pageTable(), ['不存在的按钮']);
    assert.deepEqual(merged.result.navIndices, [1]);
    assert.deepEqual(merged.added, []);
    assert.deepEqual(merged.result.diagnostics, ['kept']);
  });
});

describe('readProgressHint', () => {
  it('reads the platform progress widget when the capture had no claim', async () => {
    const deps = evalBySelector({ '.num-bfjd span': [0] });
    const claim = await readProgressHint({ progressSelector: '.num-bfjd span' }, deps);
    assert.deepEqual(claim, { raw: '已完成 37.5%', current: 37.5, total: 100 });
  });

  it('returns null without a selector, on a failed probe, or on a numberless widget', async () => {
    assert.equal(await readProgressHint({}, evalBySelector({})), null);
    assert.equal(await readProgressHint({ progressSelector: '.x' }, evalBySelector({ '.x': 'error' })), null);
    const deps = { evalJson: async (): Promise<unknown | null> => '进行中' };
    assert.equal(await readProgressHint({ progressSelector: '.x' }, deps), null);
  });
});

describe('hintSummaryLine', () => {
  it('states what was applied and what is missing', () => {
    const none = hintSummaryLine(undefined, { scoped: false, scopeNote: null, navLabels: [], diagnostics: [] });
    assert.match(none, /no quiz section/);
    const line = hintSummaryLine(
      { questionSelector: '.u-questionItem' },
      { scoped: true, scopeNote: 'scoped to #quiz: kept 6/8 elements', navLabels: ['保存'], diagnostics: [] },
    );
    assert.match(line, /scoped to #quiz/);
    assert.match(line, /nav labels: 保存/);
    assert.match(line, /questionSelector: \.u-questionItem/);
  });
});
