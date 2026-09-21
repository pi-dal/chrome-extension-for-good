import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeAction,
  parseAction,
  parseExtToHost,
  parseHostToExt,
  parseInspectionResult,
  parseInspectionSession,
  parsePageCapture,
  parseProgressClaim,
  parseQuizQuestionModel,
  parseQuizRecipe,
  type ElementTable,
  type InspectionResult,
  type InspectionSession,
  type PageCapture,
  type QuizRecipe,
} from '../src/index.js';

function roundTrip<T>(parse: (raw: unknown) => T, msg: unknown): T {
  return parse(JSON.parse(JSON.stringify(msg)));
}

const table: ElementTable = {
  url: 'https://exam.example.com/quiz/1',
  title: 'Quiz',
  capturedAt: 1_758_100_000_000,
  elements: [
    { index: 1, role: 'text', name: '1. 题干?', tag: 'div', rect: { x: 20, y: 64, w: 560, h: 24 } },
    { index: 2, role: 'radio', name: '甲', tag: 'input', checked: false, rect: { x: 30, y: 104, w: 18, h: 18 } },
    { index: 3, role: 'radio', name: '乙', tag: 'input', checked: false, rect: { x: 30, y: 138, w: 18, h: 18 } },
  ],
};

const capture: PageCapture = {
  captureId: '9f1e2d3c4b5a6978',
  url: 'https://exam.example.com/quiz/1',
  origin: 'https://exam.example.com',
  capturedAt: 1_758_100_000_000,
  table,
  pageText: '1. 题干?\n甲\n乙',
  progressClaim: { raw: '第 1/3 题', current: 1, total: 3 },
  meta: { capturedVia: 'extension' },
};

const question = {
  stem: '1. 题干?',
  stemIndex: 1,
  optionIndices: [2, 3],
  inputIndices: [],
  answered: false,
  confidence: 0.92,
  source: 'heuristic' as const,
};

const inspection: InspectionResult = {
  captureId: '9f1e2d3c4b5a6978',
  questions: [question],
  navIndices: [4],
  excluded: [{ index: 5, reason: 'login button, not quiz nav' }],
  conservation: { status: 'pass', rounds: 2, unaccounted: [] },
  diagnostics: [],
};

const recipe: QuizRecipe = {
  origin: 'https://exam.example.com',
  questionSelector: '.exam-question',
  optionSelector: '.exam-question input[type=radio]',
  heartbeatUrlPattern: '/api/study/beat',
  learnedVia: 'distill',
  confidence: 0.9,
  updatedAt: 1_758_100_000_000,
};

const session: InspectionSession = {
  captures: [capture],
  questions: [{ ...question, source: 'llm' }],
  progress: { claimedDone: 1, claimedTotal: null, seen: 1 },
  diagnostics: ['page 2 progress claim missing'],
};

test('PageCapture round-trips with all optional fields', () => {
  assert.deepEqual(roundTrip(parsePageCapture, capture), capture);
  const minimal = {
    captureId: 'x',
    url: 'https://a',
    origin: 'https://a',
    capturedAt: 1,
    table,
  };
  assert.deepEqual(roundTrip(parsePageCapture, minimal), minimal);
});

test('PageCapture rejects garbage', () => {
  const bad: unknown[] = [
    null,
    {},
    { ...capture, captureId: '' },
    { ...capture, url: '' },
    { ...capture, origin: 42 },
    { ...capture, capturedAt: Number.NaN },
    { ...capture, capturedAt: Infinity },
    { ...capture, table: { url: 'u' } },
    { ...capture, pageText: 42 },
    { ...capture, progressClaim: { raw: '', current: 1, total: 2 } },
    { ...capture, progressClaim: { raw: 'r', current: '1', total: 2 } },
    { ...capture, screenshotRef: 7 },
    { ...capture, meta: ['not', 'a', 'record'] },
  ];
  for (const b of bad) {
    assert.throws(() => parsePageCapture(b), Error, `expected throw for ${JSON.stringify(b)}`);
  }
});

test('ProgressClaim parses standalone and rejects empties', () => {
  assert.deepEqual(parseProgressClaim({ raw: '第 1/3 题', current: 1, total: 3 }), {
    raw: '第 1/3 题',
    current: 1,
    total: 3,
  });
  assert.throws(() => parseProgressClaim({ raw: 'x' }), Error);
  assert.throws(() => parseProgressClaim(null), Error);
});

test('QuizQuestionModel round-trips and rejects bad source/confidence/indices', () => {
  assert.deepEqual(roundTrip(parseQuizQuestionModel, question), question);
  assert.throws(() => parseQuizQuestionModel({ ...question, source: 'vibes' }), Error);
  assert.throws(() => parseQuizQuestionModel({ ...question, confidence: 1.5 }), Error);
  assert.throws(() => parseQuizQuestionModel({ ...question, confidence: -0.1 }), Error);
  assert.throws(() => parseQuizQuestionModel({ ...question, confidence: 'high' }), Error);
  assert.throws(() => parseQuizQuestionModel({ ...question, stemIndex: Number.NaN }), Error);
  assert.throws(() => parseQuizQuestionModel({ ...question, optionIndices: [2, '3'] }), Error);
  assert.throws(() => parseQuizQuestionModel({ ...question, answered: 'no' }), Error);
});

test('InspectionResult round-trips and rejects garbage', () => {
  assert.deepEqual(roundTrip(parseInspectionResult, inspection), inspection);
  assert.throws(() => parseInspectionResult({ ...inspection, captureId: '' }), Error);
  assert.throws(
    () => parseInspectionResult({ ...inspection, conservation: { status: 'unknown', rounds: 1, unaccounted: [] } }),
    Error,
  );
  assert.throws(
    () => parseInspectionResult({ ...inspection, conservation: { status: 'pass', rounds: 'one', unaccounted: [] } }),
    Error,
  );
  assert.throws(() => parseInspectionResult({ ...inspection, excluded: [{ index: '5' }] }), Error);
  assert.throws(() => parseInspectionResult({ ...inspection, diagnostics: [1] }), Error);
  assert.throws(() => parseInspectionResult({ ...inspection, questions: 'none' }), Error);
});

test('QuizRecipe round-trips; learnedVia is whitelist of one', () => {
  assert.deepEqual(roundTrip(parseQuizRecipe, recipe), recipe);
  const minimal: QuizRecipe = {
    origin: 'https://a',
    learnedVia: 'distill',
    confidence: 0.5,
    updatedAt: 2,
  };
  assert.deepEqual(roundTrip(parseQuizRecipe, minimal), minimal);
  assert.throws(() => parseQuizRecipe({ ...recipe, learnedVia: 'learned' }), Error);
  assert.throws(() => parseQuizRecipe({ ...recipe, origin: '' }), Error);
  assert.throws(() => parseQuizRecipe({ ...recipe, questionSelector: '' }), Error);
  assert.throws(() => parseQuizRecipe({ ...recipe, confidence: 2 }), Error);
  assert.throws(() => parseQuizRecipe({ ...recipe, updatedAt: 'now' }), Error);
});

test('InspectionSession round-trips; claimedTotal nullable', () => {
  assert.deepEqual(roundTrip(parseInspectionSession, session), session);
  const total = { ...session, progress: { claimedDone: 2, claimedTotal: 12, seen: 2 } };
  assert.deepEqual(roundTrip(parseInspectionSession, total), total);
  assert.throws(() => parseInspectionSession({ ...session, captures: 'no' }), Error);
  assert.throws(() => parseInspectionSession({ ...session, progress: { claimedDone: 1, claimedTotal: 0, seen: 'x' } }), Error);
  assert.throws(() => parseInspectionSession({ ...session, progress: { claimedDone: 1, claimedTotal: true, seen: 1 } }), Error);
});

test('snapshot wire messages carry optional pageText; garbage rejected', () => {
  const msg = { type: 'snapshot', requestId: 'r1', table, pageText: 'text' };
  assert.deepEqual(roundTrip(parseExtToHost, msg), msg);
  assert.deepEqual(
    roundTrip(parseExtToHost, { type: 'snapshot', requestId: 'r1', table }),
    { type: 'snapshot', requestId: 'r1', table },
  );
  assert.throws(() => parseExtToHost({ type: 'snapshot', requestId: 'r1', table, pageText: 42 }), Error);
});

test('snapshot_request carries optional includePageText; garbage rejected', () => {
  const msg = { type: 'snapshot_request', requestId: 'r2', tabId: 3, includePageText: true, quizOnly: false };
  assert.deepEqual(roundTrip(parseHostToExt, msg), msg);
  assert.throws(
    () => parseHostToExt({ type: 'snapshot_request', requestId: 'r2', tabId: 3, includePageText: 'yes' }),
    Error,
  );
});

test('eval action round-trips; expression must be a string', () => {
  const action = { op: 'eval', expression: 'document.title' };
  assert.deepEqual(roundTrip(parseAction, action), action);
  assert.deepEqual(parseAction({ op: 'eval', expression: 'JSON.stringify(1)' }), {
    op: 'eval',
    expression: 'JSON.stringify(1)',
  });
  assert.throws(() => parseAction({ op: 'eval' }), Error);
  assert.throws(() => parseAction({ op: 'eval', expression: 42 }), Error);
});

test('describeAction renders eval (truncated, quoted)', () => {
  assert.equal(describeAction({ op: 'eval', expression: 'document.title' }), 'eval "document.title"');
  const long = 'a'.repeat(200);
  const rendered = describeAction({ op: 'eval', expression: long });
  assert.ok(rendered.startsWith('eval "'));
  assert.ok(rendered.includes('…'));
  assert.ok(rendered.length < 100);
});
