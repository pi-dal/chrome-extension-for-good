import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { ElementTable, PageCapture } from '@c4g/protocol';
import { auditConservation, conservationCandidates } from '../../src/inspect/conservation.js';
import { heuristicGroup } from '../../src/inspect/heuristic.js';

function miniTable(elements: Array<Record<string, unknown>>): ElementTable {
  return {
    url: 'https://x.test/',
    title: 't',
    capturedAt: 1,
    elements: elements.map((e) => ({
      value: undefined,
      ...e,
      rect: (e.rect as ElementTable['elements'][number]['rect']) ?? { x: 0, y: 0, w: 8, h: 8 },
    })) as ElementTable['elements'],
  };
}

describe('conservationCandidates', () => {
  it('collects interactive controls and slot-hinted elements', () => {
    const table = miniTable([
      { index: 1, role: 'heading', name: '标题', tag: 'h2' },
      { index: 2, role: 'radio', name: 'A', tag: 'input' },
      { index: 3, role: 'button', name: '保存', tag: 'button' },
      { index: 4, role: 'text', name: '题干？', tag: 'div', quizSlot: 'question' },
    ]);
    assert.deepEqual(conservationCandidates(table), [2, 3, 4]);
  });
});

describe('auditConservation', () => {
  const table = miniTable([
    { index: 1, role: 'radio', name: 'A', tag: 'input' },
    { index: 2, role: 'radio', name: 'B', tag: 'input' },
    { index: 3, role: 'button', name: '保存', tag: 'button' },
  ]);

  it('passes when every candidate is assigned (dedup + non-candidates tolerated)', () => {
    const candidates = conservationCandidates(table);
    const assigned = [1, 2, 3, 3, 99]; // duplicates and non-candidates are fine
    assert.deepEqual(auditConservation(candidates, assigned), []);
  });

  it('lists unaccounted candidates in index order', () => {
    const candidates = conservationCandidates(table);
    assert.deepEqual(auditConservation(candidates, [2]), [1, 3]);
  });

  it('end-to-end: heuristic-assigned fixture tables conserve', () => {
    // Load the three P1 fixtures through the real grouper: the assigned set
    // (stems + options + inputs + nav + excluded) must cover all candidates.
    for (const name of ['moodle-like', 'generic-radios', 'tricky']) {
      const url = new URL(`../fixtures/corpus/${name}/capture.json`, import.meta.url);
      const capture = JSON.parse(readFileSync(url, 'utf8')) as PageCapture;
      const h = heuristicGroup(capture.table);
      const assigned = new Set<number>();
      for (const q of h.questions) {
        assigned.add(q.stemIndex);
        for (const i of q.optionIndices) assigned.add(i);
        for (const i of q.inputIndices) assigned.add(i);
      }
      for (const i of h.navIndices) assigned.add(i);
      for (const e of h.excluded) assigned.add(e.index);
      const unaccounted = auditConservation(conservationCandidates(capture.table), assigned);
      assert.deepEqual(unaccounted, [], `${name}: unexpected unaccounted elements`);
      assert.deepEqual(h.unassigned, [], `${name}: heuristic left controls unassigned`);
    }
  });
});
