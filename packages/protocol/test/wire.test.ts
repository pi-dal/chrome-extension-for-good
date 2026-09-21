import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeAction,
  parseAction,
  parseElementTable,
  parseExtToHost,
  parseHostToExt,
  type Action,
  type ElementTable,
  type ExtToHost,
  type HostToExt,
} from '../src/index.js';

const table: ElementTable = {
  url: 'https://lms.university.example.edu/mod/quiz/attempt.php',
  title: 'Quiz attempt',
  capturedAt: 1_700_000_000_000,
  elements: [
    { index: 0, role: 'heading', name: 'Question 1', tag: 'h3', rect: { x: 10, y: 20, w: 300, h: 24 } },
    {
      index: 1,
      role: 'radio',
      name: '选项 A',
      tag: 'input',
      checked: false,
      disabled: false,
      rect: { x: 12, y: 60, w: 16, h: 16 },
      framePath: 'main>quiz-frame',
      quizSlot: 'option',
    },
  ],
};

function roundTrip<T>(parse: (raw: unknown) => T, msg: unknown): T {
  return parse(JSON.parse(JSON.stringify(msg)));
}

test('describeAction renders every op', () => {
  const actions: Action[] = [
    { op: 'click', index: 3 },
    { op: 'type', index: 5, text: '答案' },
    { op: 'select', index: 2, option: 'B' },
    { op: 'scroll', deltaY: -240 },
    { op: 'key', key: 'Enter' },
  ];
  assert.deepEqual(
    actions.map(describeAction),
    ['click #3', 'type #5 "答案"', 'select #2 "B"', 'scroll -240', 'key "Enter"'],
  );
});

test('parseAction accepts every op and rejects garbage', () => {
  assert.deepEqual(parseAction({ op: 'click', index: 1 }), { op: 'click', index: 1 });
  assert.deepEqual(parseAction({ op: 'type', index: 1, text: 'x' }), { op: 'type', index: 1, text: 'x' });
  assert.deepEqual(parseAction({ op: 'scroll', deltaY: 0 }), { op: 'scroll', deltaY: 0 });
  for (const bad of [null, 'click', {}, { op: 'hover', index: 1 }, { op: 'click' }, { op: 'type', index: 1 }, { op: 'scroll', deltaY: 'x' }]) {
    assert.throws(() => parseAction(bad), Error, `expected throw for ${JSON.stringify(bad)}`);
  }
});

test('parseElementTable validates deeply', () => {
  const parsed = parseElementTable(JSON.parse(JSON.stringify(table)));
  assert.equal(parsed.elements.length, 2);
  assert.equal(parsed.elements[1].quizSlot, 'option');
  assert.throws(() => parseElementTable({ ...table, elements: [{ index: 0, rect: { x: 1 } }] }), Error);
  assert.throws(() => parseElementTable({ ...table, capturedAt: 'now' }), Error);
});

test('ExtToHost: hello round-trip and narrowing', () => {
  const msg: ExtToHost = {
    type: 'hello',
    extVersion: '0.1.0',
    tabs: [{ id: 7, url: 'https://example.com', title: 'Example' }],
  };
  const parsed = roundTrip(parseExtToHost, msg);
  assert.deepEqual(parsed, msg);
  if (parsed.type === 'hello') {
    const t: { id: number; url: string; title: string } = parsed.tabs[0];
    assert.equal(t.id, 7);
  } else {
    assert.fail('narrowing failed');
  }
});

test('ExtToHost: snapshot round-trip', () => {
  const msg: ExtToHost = { type: 'snapshot', requestId: 'req-1', table };
  assert.deepEqual(roundTrip(parseExtToHost, msg), msg);
});

test('ExtToHost: action_result round-trip with and without error', () => {
  const ok: ExtToHost = { type: 'action_result', requestId: 'r1', ok: true, url: 'https://a' };
  const bad: ExtToHost = { type: 'action_result', requestId: 'r2', ok: false, error: 'stale-snapshot', url: 'https://b' };
  assert.deepEqual(roundTrip(parseExtToHost, ok), ok);
  assert.deepEqual(roundTrip(parseExtToHost, bad), bad);
});

test('ExtToHost: event round-trip for all kinds', () => {
  for (const kind of ['nav', 'lms_heartbeat'] as const) {
    const msg: ExtToHost = { type: 'event', kind, tabId: 3, detail: 'd', ts: 42 };
    assert.deepEqual(roundTrip(parseExtToHost, msg), msg);
  }
});

test('ExtToHost: log round-trip, data optional', () => {
  const withData: ExtToHost = { type: 'log', level: 'warn', msg: 'stall', data: { tries: 2 } };
  const bare: ExtToHost = { type: 'log', level: 'info', msg: 'ok' };
  assert.deepEqual(roundTrip(parseExtToHost, withData), withData);
  assert.deepEqual(roundTrip(parseExtToHost, bare), bare);
});

test('ExtToHost rejects garbage', () => {
  const garbage: unknown[] = [
    null,
    42,
    'snapshot',
    {},
    { type: 'nope' },
    { type: 'snapshot', requestId: 'r' },
    { type: 'snapshot', requestId: 'r', table: { url: 'u', title: 't', capturedAt: 1, elements: 'no' } },
    { type: 'hello', extVersion: '0.1.0', tabs: 'no' },
    { type: 'action_result', requestId: 'r', ok: 'yes', url: 'u' },
    { type: 'event', kind: 'explosion', tabId: 1, ts: 1 },
    { type: 'log', level: 'loud', msg: 'm' },
  ];
  for (const g of garbage) {
    assert.throws(() => parseExtToHost(g), Error, `expected throw for ${JSON.stringify(g)}`);
  }
});

test('HostToExt: both variants round-trip', () => {
  const snap: HostToExt = { type: 'snapshot_request', requestId: 'h1', tabId: 9, quizOnly: true };
  const act: HostToExt = {
    type: 'action_request',
    requestId: 'h2',
    tabId: 9,
    action: { op: 'click', index: 4 },
  };
  assert.deepEqual(roundTrip(parseHostToExt, snap), snap);
  assert.deepEqual(roundTrip(parseHostToExt, act), act);
  const bare: HostToExt = { type: 'snapshot_request', requestId: 'h3', tabId: 1 };
  assert.deepEqual(roundTrip(parseHostToExt, bare), bare);
});

test('HostToExt rejects garbage', () => {
  const garbage: unknown[] = [
    undefined,
    [],
    { type: 'snapshot_request', tabId: 1 },
    { type: 'snapshot_request', requestId: 'r', tabId: 'one' },
    { type: 'action_request', requestId: 'r', tabId: 1, action: { op: 'nope' } },
    { type: 'action_request', requestId: 'r', tabId: 1, action: { op: 'click', index: NaN } },
  ];
  for (const g of garbage) {
    assert.throws(() => parseHostToExt(g), Error, `expected throw for ${JSON.stringify(g)}`);
  }
});

test('NaN index is rejected by parseAction (finite check)', () => {
  assert.throws(() => parseAction({ op: 'click', index: Number.NaN }), Error);
});

test('action_result with eval value round-trips and enforces the 64KB cap', () => {
  const msg: ExtToHost = { type: 'action_result', requestId: 'r9', ok: true, url: 'https://x/', value: { n: 3, flags: [1, 0] } };
  assert.deepEqual(roundTrip(parseExtToHost, msg), msg);
  const big = 'x'.repeat(70_000);
  assert.throws(() => parseExtToHost({ type: 'action_result', requestId: 'r9', ok: true, url: 'https://x/', value: { big } }));
});

test('config_sync round-trips and rejects malformed patches', () => {
  const msg: ExtToHost = {
    type: 'config_sync',
    config: { solverBaseUrl: 'https://api.deepseek.com', solverApiKey: '', typesafeModel: 'jev-staging' },
  };
  assert.deepEqual(roundTrip(parseExtToHost, msg), msg);
  assert.deepEqual(parseExtToHost({ type: 'config_sync', config: {} }), { type: 'config_sync', config: {} });
  assert.throws(() => parseExtToHost({ type: 'config_sync', config: { solverApiKey: 42 } }));
  assert.throws(() => parseExtToHost({ type: 'config_sync', config: 'nope' }));
});
