import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ElementTable } from '@c4g/protocol';
import { heuristicPick, JeDriver, renderTable } from '../src/jev.js';

function el(index: number, role: string, name: string, extra: Partial<ElementTable['elements'][number]> = {}): ElementTable['elements'][number] {
  return {
    index,
    role,
    name,
    tag: role === 'link' ? 'a' : 'button',
    rect: { x: index * 10, y: 10, w: 80, h: 24 },
    ...extra,
  };
}

const TABLE: ElementTable = {
  url: 'https://lms.example.com/mod/quiz/attempt.php',
  title: 'Quiz attempt',
  capturedAt: Date.now(),
  elements: [
    el(0, 'button', '播放视频'),
    el(1, 'button', '提交答案', { quizSlot: 'nav' }),
    el(2, 'link', '课程介绍'),
    el(3, 'button', '隐藏按钮', { disabled: true }),
  ],
};

describe('jev dry-run heuristic', () => {
  it('picks the submit/nav button for a submit goal', () => {
    const d = heuristicPick('提交答案并继续下一题', TABLE);
    assert.equal(d.operation, 'CLICK');
    assert.equal(d.targetIndex, 1);
    assert.equal(d.dryRun, true);
  });

  it('picks the play button when the goal is about playing', () => {
    const d = heuristicPick('播放视频继续学习', TABLE);
    assert.equal(d.operation, 'CLICK');
    assert.equal(d.targetIndex, 0);
  });

  it('returns BLOCKED when nothing matches', () => {
    const empty: ElementTable = { ...TABLE, elements: [el(0, 'heading', 'Some static text', { tag: 'h1' })] };
    const d = heuristicPick('submit the answer', empty);
    assert.equal(d.operation, 'BLOCKED');
  });

  it('never picks disabled elements', () => {
    const onlyDisabled: ElementTable = { ...TABLE, elements: [TABLE.elements[3]] };
    const d = heuristicPick('隐藏按钮', onlyDisabled);
    assert.equal(d.operation, 'BLOCKED');
  });
});

describe('JeDriver', () => {
  it('falls back to the heuristic in dry-run (no key)', async () => {
    const driver = new JeDriver(undefined, () => {});
    assert.equal(driver.dryRun, true);
    const d = await driver.decide('提交答案', TABLE);
    assert.equal(d.dryRun, true);
    assert.equal(d.targetIndex, 1);
  });

  it('renders a jev-ultrafast style table', () => {
    const rendered = renderTable(TABLE);
    assert.match(rendered, /\[1\] button "提交答案"/);
    assert.match(rendered, /\(disabled\)/);
  });
});
