import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractJson, QuizSolver } from '../src/solver.js';

const noopLog = () => {};

describe('extractJson', () => {
  it('parses fenced JSON', () => {
    const parsed = extractJson('```json\n{"indices":[1,2]}\n```');
    assert.deepEqual(parsed, { indices: [1, 2] });
  });

  it('parses JSON embedded in prose', () => {
    const parsed = extractJson('The answer is {"indices":[0]} hope that helps');
    assert.deepEqual(parsed, { indices: [0] });
  });

  it('handles braces inside strings', () => {
    const parsed = extractJson('{"text":"a } weird { answer"}');
    assert.deepEqual(parsed, { text: 'a } weird { answer' });
  });

  it('returns undefined for garbage', () => {
    assert.equal(extractJson('Sorry, I cannot answer that.'), undefined);
    assert.equal(extractJson(''), undefined);
  });
});

describe('QuizSolver', () => {
  it('is disabled and returns null without an API key (dry-run)', async () => {
    const solver = new QuizSolver('https://example.invalid/api', undefined, 'test-model', noopLog);
    assert.equal(solver.enabled, false);
    const choice = await solver.solve('1+1?', [
      { index: 0, text: '2' },
      { index: 1, text: '3' },
    ]);
    assert.equal(choice, null);
    const short = await solver.solveShortAnswer('写出一元一次方程的一个解');
    assert.equal(short, null);
  });
});
