import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseInspectionResult, parsePageCapture } from '../src/index.js';

/**
 * Corpus fixture validator (docs/m2-auto-inspect.md §5): every fixture must
 * parse against the wire contract AND be index-consistent — every quiz
 * candidate element must be accounted for by the gold inspection, mirroring
 * the conservation law the real inspector is held to.
 */

const CORPUS_DIR = join(import.meta.dirname, '..', '..', 'host', 'test', 'fixtures', 'corpus');
const CASES = readdirSync(CORPUS_DIR).filter((d) => !d.startsWith('.'));

test(`corpus contains the three mandated fixture cases, found: ${CASES.join(', ')}`, () => {
  for (const required of ['moodle-like', 'generic-radios', 'tricky']) {
    assert.ok(CASES.includes(required), `missing fixture case ${required}`);
  }
});

for (const caseName of CASES) {
  test(`corpus/${caseName}: parses and is index-consistent`, () => {
    const dir = join(CORPUS_DIR, caseName);
    const capture = parsePageCapture(JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8')));
    const gold = parseInspectionResult(JSON.parse(readFileSync(join(dir, 'gold.json'), 'utf8')));

    assert.equal(gold.captureId, capture.captureId, 'gold must reference its own capture');
    assert.equal(gold.conservation.status, 'pass', 'gold fixtures must pass conservation');

    const known = new Set(capture.table.elements.map((e) => e.index));
    const claimed = new Set<number>();
    for (const q of gold.questions) {
      const refs = [q.stemIndex, ...q.optionIndices, ...q.inputIndices];
      for (const i of refs) {
        assert.ok(known.has(i), `${caseName}: question references missing index ${i}`);
        assert.ok(!claimed.has(i), `${caseName}: index ${i} claimed by two groups`);
        claimed.add(i);
      }
    }
    for (const i of gold.navIndices) {
      assert.ok(known.has(i), `${caseName}: nav references missing index ${i}`);
    }
    for (const e of gold.excluded) {
      assert.ok(known.has(e.index), `${caseName}: excluded references missing index ${e.index}`);
      assert.ok(!claimed.has(e.index), `${caseName}: excluded index ${e.index} also claimed by a question`);
    }

    // Conservation: every radio/checkbox/textbox must belong to a question;
    // every button must be nav or explicitly excluded.
    for (const el of capture.table.elements) {
      if (el.role === 'radio' || el.role === 'checkbox' || el.role === 'textbox') {
        const covered = gold.questions.some((q) =>
          [q.stemIndex, ...q.optionIndices, ...q.inputIndices].includes(el.index),
        );
        assert.ok(covered, `${caseName}: candidate #${el.index} (${el.role}) unaccounted`);
      }
      if (el.role === 'button') {
        const covered =
          gold.navIndices.includes(el.index) || gold.excluded.some((e) => e.index === el.index);
        assert.ok(covered, `${caseName}: button #${el.index} is neither nav nor excluded`);
      }
    }
  });
}
