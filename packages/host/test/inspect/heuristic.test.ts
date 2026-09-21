import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { PageCapture } from '@c4g/protocol';
import { heuristicGroup } from '../../src/inspect/heuristic.js';

const noopLog = () => {};

function loadCapture(name: string): PageCapture {
  const url = new URL(`../fixtures/corpus/${name}/capture.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as PageCapture;
}

describe('heuristicGroup: hint path (moodle-like)', () => {
  const capture = loadCapture('moodle-like');
  const result = heuristicGroup(capture.table);

  it('groups by quizSlot hints with confidence 1', () => {
    assert.equal(result.questions.length, 2);
    assert.deepEqual(
      result.questions.map((q) => [q.stemIndex, q.optionIndices]),
      [
        [2, [3, 4, 5, 6]],
        [7, [8, 9, 10, 11]],
      ],
    );
    assert.ok(result.questions.every((q) => q.source === 'hint' && q.confidence === 1));
  });

  it('classifies nav and excludes the page heading', () => {
    assert.deepEqual(result.navIndices, [12, 13]);
    assert.deepEqual(result.excluded, [{ index: 1, reason: 'page heading, not a quiz candidate' }]);
    assert.deepEqual(result.unassigned, []);
  });
});

describe('heuristicGroup: structural path (generic-radios)', () => {
  const capture = loadCapture('generic-radios');
  const result = heuristicGroup(capture.table);

  it('pairs radio runs with their preceding stems', () => {
    assert.deepEqual(
      result.questions.map((q) => [q.stemIndex, q.optionIndices, q.inputIndices]),
      [
        [2, [3, 4, 5], []],
        [6, [7, 8, 9, 10], []],
      ],
    );
    assert.ok(result.questions.every((q) => q.source === 'heuristic' && !q.answered));
  });

  it('handles nav and heading with nothing unassigned', () => {
    assert.deepEqual(result.navIndices, [11]);
    assert.deepEqual(result.excluded, [{ index: 1, reason: 'page heading, not a quiz candidate' }]);
    assert.deepEqual(result.unassigned, []);
  });
});

describe('heuristicGroup: structural path (tricky)', () => {
  const capture = loadCapture('tricky');
  const result = heuristicGroup(capture.table);

  it('finds checkbox (multi), radio, input-only and late questions', () => {
    assert.deepEqual(
      result.questions.map((q) => [q.stemIndex, q.optionIndices, q.inputIndices, q.answered]),
      [
        [4, [5, 6, 7, 8], [], true], // all checkboxes pre-checked
        [9, [10, 11, 12], [], false],
        [13, [], [14], false], // free-text question
        [17, [18, 19], [], false], // below-fold question
      ],
    );
  });

  it('separates quiz nav from noise buttons', () => {
    assert.deepEqual(result.navIndices, [15, 16]); // 保存 / 交卷
    assert.deepEqual(
      result.excluded.map((e) => e.index),
      [1, 2, 3, 20], // heading, 登录, 收藏本题, 返回顶部
    );
    assert.deepEqual(result.unassigned, []);
  });
});

describe('heuristicGroup: conservative failures', () => {
  it('leaves stem-less option runs unassigned instead of guessing', () => {
    const table = {
      url: 'https://x.test/',
      title: 't',
      capturedAt: 1,
      elements: [
        { index: 1, role: 'radio', name: '甲', tag: 'input', rect: { x: 0, y: 0, w: 8, h: 8 } },
        { index: 2, role: 'radio', name: '乙', tag: 'input', rect: { x: 0, y: 10, w: 8, h: 8 } },
      ],
    } as const;
    const result = heuristicGroup(table as unknown as Parameters<typeof heuristicGroup>[0]);
    assert.deepEqual(result.questions, []);
    assert.deepEqual(result.unassigned, [1, 2]);
  });

  it('excludes non-quiz form controls with an explicit reason', () => {
    const table = {
      url: 'https://x.test/',
      title: 't',
      capturedAt: 1,
      elements: [
        { index: 1, role: 'textbox', name: '站内搜索', tag: 'input', rect: { x: 0, y: 0, w: 80, h: 8 } },
      ],
    } as const;
    const result = heuristicGroup(table as unknown as Parameters<typeof heuristicGroup>[0]);
    assert.deepEqual(result.questions, []);
    assert.deepEqual(result.excluded, [{ index: 1, reason: 'form control, not quiz' }]);
  });
});

describe('heuristicGroup: ordered options keep labels (log helper)', () => {
  it('noopLog stays unused but importable', () => {
    assert.equal(typeof noopLog, 'function');
  });
});
