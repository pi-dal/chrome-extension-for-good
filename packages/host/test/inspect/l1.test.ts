import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PageCapture } from '@c4g/protocol';
import { parsePageCapture } from '@c4g/protocol';
import { inspectPage, dryRunInspectDeps } from '../../src/inspect/index.js';
import { buildMembershipProbeExpression, confirmRecipe } from '../../src/inspect/l1.js';
import type { LogFn } from '../../src/log.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const log: LogFn = () => {};

function loadCapture(name: string): PageCapture {
  const raw = JSON.parse(readFileSync(resolve(HERE, '../../test/fixtures/corpus', name, 'capture.json'), 'utf8'));
  return parsePageCapture(raw);
}

/** Fake evalJson: count probes return `count`, membership probes return all-ones (or `flags`). */
function fakeEval(opts: { count: number; flags?: number[]; throwOnProbe?: boolean }) {
  return async (expression: string): Promise<unknown | null> => {
    if (opts.throwOnProbe) throw new Error('probe boom');
    if (expression.includes('querySelectorAll')) return opts.count;
    if (expression.includes('.map(function(i)')) return opts.flags ?? expression.match(/\[(.*?)\]/)?.[1]?.split(',').map(() => 1) ?? [];
    return null;
  };
}

describe('L1 recipe confirmation (review F5c)', () => {
  it('membership probe embeds a JSON-escaped selector and index list', () => {
    const expr = buildMembershipProbeExpression('.que > .form-radio', [3, 4, 5]);
    assert.ok(expr.includes(JSON.stringify('.que > .form-radio')));
    assert.ok(expr.includes('[3,4,5]'));
    assert.ok(!expr.includes("'"), 'selector must be double-quoted, never raw');
  });

  it('confirms when counts and membership match', async () => {
    const capture = loadCapture('moodle-like');
    const { heuristicGroup } = await import('../../src/inspect/heuristic.js');
    const H = heuristicGroup(capture.table);
    const verdict = await confirmRecipe(
      capture.table,
      { origin: capture.origin, questionSelector: '.que', learnedVia: 'distill', confidence: 0.9, updatedAt: 0 },
      fakeEval({ count: H.questions.length }),
      H,
    );
    assert.equal(verdict.ok, true);
  });

  it('rejects when the selector matches more elements than the heuristic saw (missed questions)', async () => {
    const capture = loadCapture('moodle-like');
    const { heuristicGroup } = await import('../../src/inspect/heuristic.js');
    const H = heuristicGroup(capture.table);
    const verdict = await confirmRecipe(
      capture.table,
      { origin: capture.origin, questionSelector: '.que', learnedVia: 'distill', confidence: 0.9, updatedAt: 0 },
      fakeEval({ count: H.questions.length + 2 }),
      H,
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason ?? '', /matched .* heuristic saw/);
  });

  it('rejects on membership mismatch or probe errors (fail-safe)', async () => {
    const capture = loadCapture('moodle-like');
    const { heuristicGroup } = await import('../../src/inspect/heuristic.js');
    const H = heuristicGroup(capture.table);
    const recipe = { origin: capture.origin, questionSelector: '.que', learnedVia: 'distill' as const, confidence: 0.9, updatedAt: 0 };
    assert.equal((await confirmRecipe(capture.table, recipe, fakeEval({ count: H.questions.length, flags: [1, 0] }), H)).ok, false);
    assert.equal((await confirmRecipe(capture.table, recipe, fakeEval({ count: H.questions.length, throwOnProbe: true }), H)).ok, false);
  });

  it('inspectPage: confirmed recipe short-circuits L2/L3 and tags source=recipe', async () => {
    const capture = loadCapture('moodle-like');
    let llmCalled = 0;
    const deps = {
      ...dryRunInspectDeps(log),
      llm: {
        enabled: true,
        enumerate: async () => {
          llmCalled++;
          return null;
        },
      } as never,
      l1: {
        recipeFor: () => ({ origin: capture.origin, questionSelector: '.que', learnedVia: 'distill' as const, confidence: 0.9, updatedAt: 0 }),
        evalJson: fakeEval({ count: 2 }), // moodle-like gold has 2 stems
      },
    };
    const result = await inspectPage(capture, deps as never);
    assert.equal(llmCalled, 0, 'L1 hit must skip L2/L3 enumeration');
    assert.ok(result.questions.every((q) => q.source === 'recipe'));
    assert.equal(result.conservation.status, 'pass');
    assert.ok(result.diagnostics.some((d) => d.includes('l1: recipe confirmed')));
  });

  it('inspectPage: rejected recipe falls back to the normal pipeline', async () => {
    const capture = loadCapture('moodle-like');
    const deps = {
      ...dryRunInspectDeps(log),
      l1: {
        recipeFor: () => ({ origin: capture.origin, questionSelector: '.que', learnedVia: 'distill' as const, confidence: 0.9, updatedAt: 0 }),
        evalJson: fakeEval({ count: 99 }),
      },
    };
    const result = await inspectPage(capture, deps as never);
    assert.ok(result.diagnostics.some((d) => d.includes('l1: recipe rejected')));
    assert.ok(result.questions.every((q) => q.source !== 'recipe'));
    assert.equal(result.conservation.status, 'pass');
  });
});
