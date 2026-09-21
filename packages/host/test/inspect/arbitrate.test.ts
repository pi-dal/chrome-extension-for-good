import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ElementTable } from '@c4g/protocol';
import {
  applyArbitrationVerdict,
  ARBITRATION_CONFIDENCE_FLOOR,
  HeuristicOnlyArbiter,
  JevArbitrator,
} from '../../src/inspect/arbitrate.js';

const noopLog = () => {};

function table(): ElementTable {
  return {
    url: 'https://x.test/',
    title: 't',
    capturedAt: 1,
    elements: [
      { index: 1, role: 'text', name: '题干', tag: 'div', rect: { x: 0, y: 0, w: 8, h: 8 } },
      { index: 2, role: 'radio', name: 'A', tag: 'input', rect: { x: 0, y: 8, w: 8, h: 8 } },
    ],
  };
}

describe('applyArbitrationVerdict', () => {
  it('keeps valid winners at or above the confidence floor', () => {
    assert.deepEqual(applyArbitrationVerdict('heuristic', 0.9), { winner: 'heuristic', confidence: 0.9 });
    assert.deepEqual(applyArbitrationVerdict('llm', ARBITRATION_CONFIDENCE_FLOOR), {
      winner: 'llm',
      confidence: ARBITRATION_CONFIDENCE_FLOOR,
    });
  });

  it('resolves sub-floor verdicts to unclassified', () => {
    assert.deepEqual(applyArbitrationVerdict('llm', ARBITRATION_CONFIDENCE_FLOOR - 0.01), {
      winner: 'unclassified',
      confidence: ARBITRATION_CONFIDENCE_FLOOR - 0.01,
    });
  });

  it('maps neither/unknown winners to unclassified regardless of confidence', () => {
    assert.equal(applyArbitrationVerdict('neither', 0.99).winner, 'unclassified');
    assert.equal(applyArbitrationVerdict('banana', 0.99).winner, 'unclassified');
    assert.equal(applyArbitrationVerdict(undefined, 0.99).winner, 'unclassified');
  });
});

describe('HeuristicOnlyArbiter (dry-run)', () => {
  it('always resolves to unclassified and reports dryRun', async () => {
    const arbiter = new HeuristicOnlyArbiter();
    assert.equal(arbiter.dryRun, true);
    const verdict = await arbiter.arbitrate({ summary: 's', heuristicIndices: [1], llmIndices: [2] }, table());
    assert.deepEqual(verdict, { winner: 'unclassified', confidence: 0 });
  });
});

describe('JevArbitrator', () => {
  it('is a dry-run arbiter without an API key and never builds a client', async () => {
    const arbiter = new JevArbitrator(undefined, noopLog);
    assert.equal(arbiter.dryRun, true);
    const verdict = await arbiter.arbitrate({ summary: 's', heuristicIndices: [1], llmIndices: [2] }, table());
    assert.equal(verdict.winner, 'unclassified');
  });

  it('resolves empty tables to unclassified even with a key', async () => {
    const arbiter = new JevArbitrator('key', noopLog);
    assert.equal(arbiter.dryRun, false);
    const verdict = await arbiter.arbitrate({ summary: 's', heuristicIndices: [], llmIndices: [] }, {
      url: '',
      title: '',
      capturedAt: 0,
      elements: [],
    });
    assert.equal(verdict.winner, 'unclassified');
  });
});
