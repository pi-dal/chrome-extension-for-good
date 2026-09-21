import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ElementTable } from '@c4g/protocol';
import {
  buildUserPrompt,
  LlmEnumerator,
  validateEnumeration,
} from '../../src/inspect/llm.js';

const noopLog = () => {};

function table(): ElementTable {
  return {
    url: 'https://x.test/quiz',
    title: 't',
    capturedAt: 1,
    elements: [
      { index: 1, role: 'text', name: '1. 首都是？', tag: 'div', rect: { x: 0, y: 0, w: 8, h: 8 } },
      { index: 2, role: 'radio', name: '北京', tag: 'input', rect: { x: 0, y: 8, w: 8, h: 8 } },
      { index: 3, role: 'radio', name: '上海', tag: 'input', rect: { x: 0, y: 16, w: 8, h: 8 } },
      { index: 4, role: 'button', name: '保存', tag: 'button', rect: { x: 0, y: 24, w: 8, h: 8 } },
    ],
  };
}

describe('validateEnumeration: grounding', () => {
  it('drops hallucinated indices and records them', () => {
    const attempt = validateEnumeration(
      {
        questions: [{ stemIndex: 1, optionIndices: [2, 99], inputIndices: [] }],
        navIndices: [4],
        excludedIndices: [77],
      },
      table(),
    );
    assert.deepEqual(attempt.invalidIndices.sort(), [77, 99]);
    assert.deepEqual(attempt.enumeration.questions[0].optionIndices, [2]);
    assert.deepEqual(attempt.enumeration.navIndices, [4]);
    assert.deepEqual(attempt.enumeration.excludedIndices, []);
    assert.equal(attempt.clean, false);
    assert.ok(attempt.notes.some((n) => n.includes('99')));
  });

  it('rejects role-mismatched claims (textbox as option)', () => {
    const t = table();
    t.elements.push({ index: 5, role: 'textbox', name: '作答区', tag: 'textarea', rect: { x: 0, y: 32, w: 8, h: 8 } });
    const attempt = validateEnumeration(
      { questions: [{ stemIndex: 1, optionIndices: [5], inputIndices: [5] }], navIndices: [], excludedIndices: [] },
      t,
    );
    // index 5 can only be an input; as an option it is dropped, then claimed
    // by the input slot.
    assert.deepEqual(attempt.enumeration.questions[0].optionIndices, []);
    assert.deepEqual(attempt.enumeration.questions[0].inputIndices, [5]);
    assert.ok(attempt.notes.some((n) => n.includes('unsuitable for option')));
  });

  it('enforces disjointness: a claimed index stays with the first question', () => {
    const t = table();
    t.elements.push({ index: 6, role: 'text', name: '2. 第二题？', tag: 'div', rect: { x: 0, y: 40, w: 8, h: 8 } });
    const attempt = validateEnumeration(
      {
        questions: [
          { stemIndex: 1, optionIndices: [2], inputIndices: [] },
          { stemIndex: 6, optionIndices: [2, 3], inputIndices: [] },
        ],
        navIndices: [],
        excludedIndices: [],
      },
      t,
    );
    assert.equal(attempt.enumeration.questions.length, 2);
    assert.deepEqual(attempt.enumeration.questions[0].optionIndices, [2]);
    // index 2 stays with the first question; the duplicate claim is dropped.
    assert.deepEqual(attempt.enumeration.questions[1].optionIndices, [3]);
    assert.ok(attempt.notes.some((n) => n.includes('duplicate claim')));
  });

  it('drops a second question reusing an already-claimed stem', () => {
    const attempt = validateEnumeration(
      {
        questions: [
          { stemIndex: 1, optionIndices: [2], inputIndices: [] },
          { stemIndex: 1, optionIndices: [3], inputIndices: [] },
        ],
        navIndices: [],
        excludedIndices: [],
      },
      table(),
    );
    assert.equal(attempt.enumeration.questions.length, 1);
    assert.ok(attempt.notes.some((n) => n.includes('dropped question without usable stem')));
  });

  it('drops questions without a usable stem and empty questions', () => {
    const attempt = validateEnumeration(
      {
        questions: [
          { stemIndex: 2, optionIndices: [3], inputIndices: [] }, // stem is a radio → dropped
          { stemIndex: 1, optionIndices: [], inputIndices: [] }, // nothing survived → dropped
        ],
        navIndices: [],
        excludedIndices: [],
      },
      table(),
    );
    assert.deepEqual(attempt.enumeration.questions, []);
    assert.ok(attempt.notes.length >= 2);
  });

  it('flags non-object replies', () => {
    const attempt = validateEnumeration('nope', table());
    assert.equal(attempt.clean, false);
    assert.deepEqual(attempt.notes, ['reply was not a JSON object']);
  });
});

describe('buildUserPrompt', () => {
  it('embeds the rendered table, page text and the missing-index feedback', () => {
    const prompt = buildUserPrompt(table(), '页面文本', [3, 4]);
    assert.ok(prompt.includes('[1] text'));
    assert.ok(prompt.includes('页面文本'));
    assert.ok(prompt.includes('[3, 4]'));
  });

  it('omits optional sections when absent', () => {
    const prompt = buildUserPrompt(table(), undefined, []);
    assert.ok(!prompt.includes('page text'));
    assert.ok(!prompt.includes('IMPORTANT'));
  });
});

describe('LlmEnumerator', () => {
  it('is inert when disabled (dry-run): complete is never called', async () => {
    let calls = 0;
    const enumerator = new LlmEnumerator(
      async () => {
        calls++;
        return '{}';
      },
      noopLog,
      false,
    );
    assert.equal(enumerator.enabled, false);
    assert.equal(await enumerator.enumerate(table()), null);
    assert.equal(calls, 0);
  });

  it('wraps transport errors as null, not exceptions', async () => {
    const enumerator = new LlmEnumerator(
      async () => {
        throw new Error('boom');
      },
      noopLog,
      true,
    );
    assert.equal(await enumerator.enumerate(table()), null);
  });

  it('returns null for unparseable replies and attempts for valid ones', async () => {
    const bad = new LlmEnumerator(async () => '我不会', noopLog, true);
    assert.equal(await bad.enumerate(table()), null);

    const good = new LlmEnumerator(
      async () => '{"questions":[{"stemIndex":1,"optionIndices":[2,3],"inputIndices":[]}],"navIndices":[4],"excludedIndices":[]}',
      noopLog,
      true,
    );
    const attempt = await good.enumerate(table());
    assert.equal(attempt?.clean, true);
    assert.equal(attempt?.enumeration.questions.length, 1);
  });
});
