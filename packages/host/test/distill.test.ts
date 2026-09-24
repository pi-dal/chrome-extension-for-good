import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseHTML } from 'linkedom';
import type { AncestryNode } from '../src/distill.js';
import {
  ancestryProbeExpression,
  assertSafeSelector,
  buildCountProbeExpression,
  deriveSelector,
  distillRecipe,
  prefetchAncestrySource,
  stableClasses,
} from '../src/distill.js';
import type { InspectionResult, PageCapture } from '@c4g/protocol';

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// DOM fixture: three structurally identical questions + one noise element
// ---------------------------------------------------------------------------

const QUIZ_HTML = `
<html><body>
  <div class="quiz-item"><p class="qtext">1. 题？</p><label class="opt"><input type="radio"></label><label class="opt"><input type="radio"></label></div>
  <div class="quiz-item"><p class="qtext">2. 题？</p><label class="opt"><input type="radio"></label><label class="opt"><input type="radio"></label></div>
  <div class="quiz-item random9f2e1a"><p class="qtext">3. 题？</p><label class="opt"><input type="radio"></label><label class="opt"><input type="radio"></label></div>
  <div class="ad-banner"><span>广告</span></div>
</body></html>`;

const { document } = parseHTML(QUIZ_HTML);

function ancestryOfElement(el: Element): AncestryNode[] {
  const chain: AncestryNode[] = [];
  let node: Element | null = el;
  while (node) {
    const tag = node.tagName.toLowerCase();
    chain.unshift({ tag, classes: node.classList ? Array.from(node.classList) : [] });
    if (tag === 'body') break;
    node = node.parentElement;
  }
  return chain;
}

function domAncestrySource(selector: string): { source: { ancestryOf(i: number): AncestryNode[] | null }; stems: Element[] } {
  const stems = Array.from(document.querySelectorAll(selector));
  return {
    source: {
      ancestryOf(i: number): AncestryNode[] | null {
        const el = stems[i];
        return el ? ancestryOfElement(el) : null;
      },
    },
    stems,
  };
}

// ---------------------------------------------------------------------------

describe('selector grammar policy (design §3)', () => {
  it('accepts plain CSS selector vocabulary', () => {
    assert.equal(assertSafeSelector('div.quiz-item > p.qtext'), 'div.quiz-item > p.qtext');
    assert.equal(assertSafeSelector('input[type="radio"]'), 'input[type="radio"]');
  });

  it('rejects forbidden sequences and overlong selectors', () => {
    assert.throws(() => assertSafeSelector('div;x=1'));
    assert.throws(() => assertSafeSelector('div//comment'));
    assert.throws(() => assertSafeSelector('div`+process.exit(1)+`'));
    assert.throws(() => assertSafeSelector(''));
    assert.throws(() => assertSafeSelector('a'.repeat(301)));
    assert.throws(() => assertSafeSelector('div{background:url(evil)}'));
  });

  it('JSON-escapes the selector inside the probe expression', () => {
    const expr = buildCountProbeExpression('input[type="radio"]');
    assert.ok(expr.includes('input[type=\\"radio\\"]'), expr);
    // the selector string can never terminate the literal early
    assert.equal((expr.match(/document.querySelectorAll/g) ?? []).length, 1);
  });

  it('count probes evaluate to a NUMBER and survive the transport round-trip', () => {
    const expr = buildCountProbeExpression('p.qtext');
    const fn = new Function('document', `return (${expr});`);
    const value = fn(document);
    // Regression: the builder used to wrap the count in JSON.stringify, and the
    // content script serializes the page value anyway — so the host received
    // the string "3" and every `count !== n` comparison failed silently.
    assert.equal(typeof value, 'number');
    assert.equal(value, 3);
    // what the host's evalJson actually sees: one serialize/parse hop
    assert.equal(JSON.parse(JSON.stringify(value)), 3);
  });
});

describe('stable class extraction', () => {
  it('filters random build-tool tokens', () => {
    assert.deepEqual(stableClasses(['quiz-item', 'abc123def456', 'css-1a2b3c', 'qtext', '']), [
      'quiz-item',
      'qtext',
    ]);
  });
});

describe('deriveSelector (≥80% shared nearest ancestor)', () => {
  it('finds p.qtext shared by all stems at depth 1', () => {
    const { source } = domAncestrySource('p.qtext');
    const derived = deriveSelector([0, 1, 2], source);
    assert.ok(derived);
    assert.equal(derived.selector, 'p.qtext');
    assert.equal(derived.depth, 1);
    assert.equal(derived.coverage, 1);
  });

  it('ignores random tokens when forming parts', () => {
    const { source } = domAncestrySource('p.qtext');
    const derived = deriveSelector([2], source);
    assert.ok(derived);
    assert.ok(!derived.selector.includes('random9f2e1a'), derived.selector);
  });

  it('requires ≥80% coverage — a lone different element does not win', () => {
    const { source } = domAncestrySource('.ad-banner span');
    // two indices: one span (unique), one p.qtext — no part is shared by 80%
    const derived = deriveSelector([0, 3], source);
    assert.equal(derived, null);
  });

  it('returns null for empty input or unresolvable indices', () => {
    const { source } = domAncestrySource('p.qtext');
    assert.equal(deriveSelector([], source), null);
    assert.equal(deriveSelector([99], source), null);
  });
});

describe('prefetchAncestrySource (__c4gRef convention)', () => {
  it('parses probe JSON into a synchronous source', async () => {
    const stems = Array.from(document.querySelectorAll('p.qtext'));
    const byIndex = new Map<number, Element>(stems.map((el, i) => [i, el]));
    const evalJson = async (expression: string) => {
      assert.ok(expression.includes('__c4gRef'));
      // Mirror content.ts exactly: `new Function('__c4gRef', 'return (expr)')`
      // — the ref resolver is an injected PARAMETER, not a window property.
      const fn = new Function('__c4gRef', `return (${expression});`);
      return fn((i: number) => byIndex.get(i) ?? null);
    };
    const source = await prefetchAncestrySource(evalJson, [0, 1, 2]);
    const derived = deriveSelector([0, 1, 2], source);
    assert.ok(derived);
    assert.equal(derived.selector, 'p.qtext');
  });

  it('degrades to null chains when the convention is absent', async () => {
    const evalJson = async () => JSON.parse('null');
    const source = await prefetchAncestrySource(evalJson, [0]);
    assert.equal(source.ancestryOf(0), null);
  });
});

// ---------------------------------------------------------------------------
// distillRecipe end-to-end
// ---------------------------------------------------------------------------

function makeCapture(): PageCapture {
  return {
    captureId: 'a'.repeat(16),
    url: 'https://exam.example.com/quiz/1',
    origin: 'https://exam.example.com',
    capturedAt: 1758200002000,
    table: { url: 'https://exam.example.com/quiz/1', title: 't', capturedAt: 1, elements: [] },
  };
}

function greenResult(stems = 3, options = 6): InspectionResult {
  const questions = [];
  for (let i = 0; i < stems; i++) {
    questions.push({
      stem: `q${i}`,
      stemIndex: i + 1,
      optionIndices: options === 6 ? [10 + i * 2, 11 + i * 2] : [],
      inputIndices: [],
      answered: false,
      confidence: 0.9,
      source: 'llm' as const,
    });
  }
  return {
    captureId: 'a'.repeat(16),
    questions,
    navIndices: [],
    excluded: [],
    conservation: { status: 'pass', rounds: 1, unaccounted: [] },
    diagnostics: [],
  };
}

describe('distillRecipe', () => {
  function liveEval(stemCount: number, optionCount: number) {
    // __c4gRef is keyed by SNAPSHOT index: 1..3 = stems, 10..15 = options.
    const bySnapshotIndex = new Map<number, Element>();
    const stems = Array.from(document.querySelectorAll('p.qtext'));
    const opts = Array.from(document.querySelectorAll('label.opt'));
    [1, 2, 3].forEach((idx, i) => bySnapshotIndex.set(idx, stems[i]));
    [10, 11, 12, 13, 14, 15].forEach((idx, i) => bySnapshotIndex.set(idx, opts[i]));
    return async (expression: string) => {
      if (expression.includes('querySelectorAll')) {
        const fn = new Function('document', `return (${expression});`);
        const value = fn(document); // transport already parses the envelope
        // distinguish the two probes by their selector text
        if (expression.includes('p.qtext')) return value === 3 ? stemCount : value;
        if (expression.includes('label.opt')) return optionCount;
        return value;
      }
      // Mirror content.ts: `__c4gRef` is an injected Function parameter, and
      // the transport hands the host the expression's own value (no wrapper).
      const fn = new Function('__c4gRef', `return (${expression});`);
      return fn((i: number) => bySnapshotIndex.get(i) ?? null);
    };
  }

  it('produces a 0.9-confidence recipe on exact live verification', async () => {
    const outcome = await distillRecipe({
      capture: makeCapture(),
      result: greenResult(),
      evalJson: liveEval(3, 6),
    });
    assert.ok(outcome.recipe, outcome.reason);
    assert.equal(outcome.recipe.confidence, 0.9);
    assert.equal(outcome.recipe.learnedVia, 'distill');
    assert.equal(outcome.recipe.origin, 'https://exam.example.com');
    assert.equal(outcome.recipe.questionSelector, 'p.qtext');
    assert.equal(outcome.recipe.optionSelector, 'label.opt');
    assert.ok(outcome.recipe.updatedAt > 0);
  });

  it('discards the recipe when the live count mismatches', async () => {
    const outcome = await distillRecipe({
      capture: makeCapture(),
      result: greenResult(),
      evalJson: liveEval(7, 6), // probe would claim 7 matches ≠ 3 stems
    });
    assert.equal(outcome.recipe, null);
    assert.ok(outcome.reason?.includes('expected 3'));
  });

  it('refuses to run on a failed conservation', async () => {
    const result = greenResult();
    result.conservation.status = 'fail';
    const outcome = await distillRecipe({
      capture: makeCapture(),
      result,
      evalJson: liveEval(3, 6),
    });
    assert.equal(outcome.recipe, null);
    assert.ok(outcome.reason?.includes('not green'));
  });

  it('omits optionSelector when options cannot be verified', async () => {
    const outcome = await distillRecipe({
      capture: makeCapture(),
      result: greenResult(),
      evalJson: liveEval(3, 999), // option probe mismatch → dropped, question kept
    });
    assert.ok(outcome.recipe);
    assert.equal(outcome.recipe.questionSelector, 'p.qtext');
    assert.equal(outcome.recipe.optionSelector, undefined);
  });
});

describe('ancestryProbeExpression', () => {
  it('references the convention and caps depth', () => {
    const expr = ancestryProbeExpression([1, 2, 3]);
    assert.ok(expr.includes('__c4gRef'));
    assert.ok(expr.includes('parentElement'));
    assert.ok(expr.includes(JSON.stringify([1, 2, 3])));
  });
});
