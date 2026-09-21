/**
 * c4g shared wire contract.
 *
 * Consumed by packages/extension (produces element-table snapshots, executes
 * actions, observes heartbeats) and packages/host (orchestrates, decides,
 * clicks). Pure types + validators — no runtime dependencies.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElementInfo {
  /** Stable within a single snapshot; the executor resolves elements by this. */
  index: number;
  role: string;
  name: string;
  value?: string;
  tag: string;
  checked?: boolean;
  disabled?: boolean;
  rect: Rect;
  framePath?: string;
  quizSlot?: 'question' | 'option' | 'answer-input' | 'nav';
}

export interface ElementTable {
  url: string;
  title: string;
  capturedAt: number;
  elements: ElementInfo[];
}

export type Action =
  | { op: 'click'; index: number }
  | { op: 'type'; index: number; text: string }
  | { op: 'select'; index: number; option: string }
  | { op: 'scroll'; deltaY: number }
  | { op: 'key'; key: string }
  | { op: 'eval'; expression: string };

export interface TabInfo {
  id: number;
  url: string;
  title: string;
}

export type HostToExt =
  | {
      type: 'snapshot_request';
      requestId: string;
      tabId: number;
      quizOnly?: boolean;
      includePageText?: boolean;
    }
  | { type: 'action_request'; requestId: string; tabId: number; action: Action };

export interface HostConfigPatch {
  solverBaseUrl?: string;
  solverApiKey?: string;
  solverModel?: string;
  typesafeBaseUrl?: string;
  typesafeApiKey?: string;
  typesafeModel?: string;
}

export type ExtToHost =
  | { type: 'hello'; extVersion: string; tabs: TabInfo[] }
  | { type: 'snapshot'; requestId: string; table: ElementTable; pageText?: string }
  | { type: 'action_result'; requestId: string; ok: boolean; error?: string; url: string; value?: unknown }
  | {
      type: 'event';
      kind: 'nav' | 'lms_heartbeat';
      tabId: number;
      detail?: string;
      ts: number;
    }
  | { type: 'config_sync'; config: HostConfigPatch }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: unknown };

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const QUIZ_SLOTS: readonly ElementInfo['quizSlot'][] = ['question', 'option', 'answer-input', 'nav'];
type EventMsg = Extract<ExtToHost, { type: 'event' }>;
type LogMsg = Extract<ExtToHost, { type: 'log' }>;
const EVENT_KINDS: readonly EventMsg['kind'][] = ['nav', 'lms_heartbeat'];
const LOG_LEVELS: readonly LogMsg['level'][] = ['debug', 'info', 'warn', 'error'];

export function parseRect(raw: unknown): Rect {
  if (!isRecord(raw) || !isNum(raw.x) || !isNum(raw.y) || !isNum(raw.w) || !isNum(raw.h)) {
    throw new Error('invalid Rect: expected finite {x,y,w,h}');
  }
  return { x: raw.x, y: raw.y, w: raw.w, h: raw.h };
}

export function parseElementInfo(raw: unknown): ElementInfo {
  if (!isRecord(raw)) throw new Error('invalid ElementInfo: not an object');
  if (!isNum(raw.index)) throw new Error('invalid ElementInfo.index');
  if (!isStr(raw.role)) throw new Error('invalid ElementInfo.role');
  if (!isStr(raw.name)) throw new Error('invalid ElementInfo.name');
  if (!isStr(raw.tag)) throw new Error('invalid ElementInfo.tag');
  const el: ElementInfo = {
    index: raw.index,
    role: raw.role,
    name: raw.name,
    tag: raw.tag,
    rect: parseRect(raw.rect),
  };
  if (raw.value !== undefined) {
    if (!isStr(raw.value)) throw new Error('invalid ElementInfo.value');
    el.value = raw.value;
  }
  if (raw.checked !== undefined) {
    if (typeof raw.checked !== 'boolean') throw new Error('invalid ElementInfo.checked');
    el.checked = raw.checked;
  }
  if (raw.disabled !== undefined) {
    if (typeof raw.disabled !== 'boolean') throw new Error('invalid ElementInfo.disabled');
    el.disabled = raw.disabled;
  }
  if (raw.framePath !== undefined) {
    if (!isStr(raw.framePath)) throw new Error('invalid ElementInfo.framePath');
    el.framePath = raw.framePath;
  }
  if (raw.quizSlot !== undefined) {
    if (!isStr(raw.quizSlot) || !QUIZ_SLOTS.includes(raw.quizSlot as ElementInfo['quizSlot'])) {
      throw new Error(`invalid ElementInfo.quizSlot: ${JSON.stringify(raw.quizSlot)}`);
    }
    el.quizSlot = raw.quizSlot as ElementInfo['quizSlot'];
  }
  return el;
}

export function parseElementTable(raw: unknown): ElementTable {
  if (!isRecord(raw)) throw new Error('invalid ElementTable: not an object');
  if (!isStr(raw.url)) throw new Error('invalid ElementTable.url');
  if (!isStr(raw.title)) throw new Error('invalid ElementTable.title');
  if (!isNum(raw.capturedAt)) throw new Error('invalid ElementTable.capturedAt');
  if (!Array.isArray(raw.elements)) throw new Error('invalid ElementTable.elements: not an array');
  return {
    url: raw.url,
    title: raw.title,
    capturedAt: raw.capturedAt,
    elements: raw.elements.map((e) => parseElementInfo(e)),
  };
}

export function parseAction(raw: unknown): Action {
  if (!isRecord(raw) || !isStr(raw.op)) throw new Error('invalid Action: missing op');
  switch (raw.op) {
    case 'click':
      if (!isNum(raw.index)) throw new Error('invalid click Action.index');
      return { op: 'click', index: raw.index };
    case 'type':
      if (!isNum(raw.index)) throw new Error('invalid type Action.index');
      if (!isStr(raw.text)) throw new Error('invalid type Action.text');
      return { op: 'type', index: raw.index, text: raw.text };
    case 'select':
      if (!isNum(raw.index)) throw new Error('invalid select Action.index');
      if (!isStr(raw.option)) throw new Error('invalid select Action.option');
      return { op: 'select', index: raw.index, option: raw.option };
    case 'scroll':
      if (!isNum(raw.deltaY)) throw new Error('invalid scroll Action.deltaY');
      return { op: 'scroll', deltaY: raw.deltaY };
    case 'key':
      if (!isStr(raw.key)) throw new Error('invalid key Action.key');
      return { op: 'key', key: raw.key };
    case 'eval':
      if (!isStr(raw.expression)) throw new Error('invalid eval Action.expression');
      return { op: 'eval', expression: raw.expression };
    default:
      throw new Error(`invalid Action.op: ${JSON.stringify(raw.op)}`);
  }
}

export function parseExtToHost(raw: unknown): ExtToHost {
  if (!isRecord(raw) || !isStr(raw.type)) throw new Error('invalid ExtToHost: missing type');
  switch (raw.type) {
    case 'hello': {
      if (!isStr(raw.extVersion)) throw new Error('invalid hello.extVersion');
      if (!Array.isArray(raw.tabs)) throw new Error('invalid hello.tabs: not an array');
      const tabs = raw.tabs.map((t) => {
        if (!isRecord(t) || !isNum(t.id) || !isStr(t.url) || !isStr(t.title)) {
          throw new Error('invalid hello.tabs entry');
        }
        return { id: t.id, url: t.url, title: t.title };
      });
      return { type: 'hello', extVersion: raw.extVersion, tabs };
    }
    case 'snapshot': {
      if (!isStr(raw.requestId)) throw new Error('invalid snapshot.requestId');
      if (raw.pageText !== undefined && !isStr(raw.pageText)) {
        throw new Error('invalid snapshot.pageText');
      }
      return {
        type: 'snapshot',
        requestId: raw.requestId,
        table: parseElementTable(raw.table),
        ...(raw.pageText !== undefined ? { pageText: raw.pageText } : {}),
      };
    }
    case 'action_result': {
      if (!isStr(raw.requestId)) throw new Error('invalid action_result.requestId');
      if (typeof raw.ok !== 'boolean') throw new Error('invalid action_result.ok');
      if (!isStr(raw.url)) throw new Error('invalid action_result.url');
      if (raw.error !== undefined && !isStr(raw.error)) {
        throw new Error('invalid action_result.error');
      }
      // `value` carries eval-op probe results only (design §3). The producer
      // caps at 64KB of JSON; re-stringify here to enforce the cap on the
      // receiving side too.
      let value: unknown;
      if (raw.value !== undefined) {
        let json: string;
        try {
          json = JSON.stringify(raw.value);
        } catch {
          throw new Error('invalid action_result.value (not JSON-serializable)');
        }
        if (json.length > 65_536) throw new Error('invalid action_result.value (exceeds 64KB)');
        value = JSON.parse(json) as unknown;
      }
      return {
        type: 'action_result',
        requestId: raw.requestId,
        ok: raw.ok,
        url: raw.url,
        ...(raw.error !== undefined ? { error: raw.error } : {}),
        ...(value !== undefined ? { value } : {}),
      };
    }
    case 'event': {
      if (
        !isStr(raw.kind) ||
        !EVENT_KINDS.includes(raw.kind as Extract<ExtToHost, { type: 'event' }>['kind'])
      ) {
        throw new Error(`invalid event.kind: ${JSON.stringify(raw.kind)}`);
      }
      if (!isNum(raw.tabId)) throw new Error('invalid event.tabId');
      if (!isNum(raw.ts)) throw new Error('invalid event.ts');
      if (raw.detail !== undefined && !isStr(raw.detail)) {
        throw new Error('invalid event.detail');
      }
      return {
        type: 'event',
        kind: raw.kind as EventMsg['kind'],
        tabId: raw.tabId,
        ts: raw.ts,
        ...(raw.detail !== undefined ? { detail: raw.detail } : {}),
      };
    }
    case 'config_sync': {
      // Full-state sync from the extension options page: present keys apply,
      // empty strings mean "not configured in the UI" (host falls back to env).
      const rawCfg = raw.config;
      if (typeof rawCfg !== 'object' || rawCfg === null || Array.isArray(rawCfg)) {
        throw new Error('invalid config_sync.config');
      }
      const keys: Array<keyof HostConfigPatch> = [
        'solverBaseUrl', 'solverApiKey', 'solverModel',
        'typesafeBaseUrl', 'typesafeApiKey', 'typesafeModel',
      ];
      const cfg: HostConfigPatch = {};
      for (const k of keys) {
        const v = (rawCfg as Record<string, unknown>)[k];
        if (v === undefined) continue;
        if (typeof v !== 'string' || v.length > 2048) {
          throw new Error(`invalid config_sync.config.${k}`);
        }
        cfg[k] = v;
      }
      return { type: 'config_sync', config: cfg };
    }
    case 'log': {
      if (
        !isStr(raw.level) ||
        !LOG_LEVELS.includes(raw.level as Extract<ExtToHost, { type: 'log' }>['level'])
      ) {
        throw new Error(`invalid log.level: ${JSON.stringify(raw.level)}`);
      }
      if (!isStr(raw.msg)) throw new Error('invalid log.msg');
      return {
        type: 'log',
        level: raw.level as LogMsg['level'],
        msg: raw.msg,
        ...(raw.data !== undefined ? { data: raw.data } : {}),
      };
    }
    default:
      throw new Error(`invalid ExtToHost.type: ${JSON.stringify(raw.type)}`);
  }
}

export function parseHostToExt(raw: unknown): HostToExt {
  if (!isRecord(raw) || !isStr(raw.type)) throw new Error('invalid HostToExt: missing type');
  switch (raw.type) {
    case 'snapshot_request': {
      if (!isStr(raw.requestId)) throw new Error('invalid snapshot_request.requestId');
      if (!isNum(raw.tabId)) throw new Error('invalid snapshot_request.tabId');
      if (raw.quizOnly !== undefined && typeof raw.quizOnly !== 'boolean') {
        throw new Error('invalid snapshot_request.quizOnly');
      }
      if (raw.includePageText !== undefined && typeof raw.includePageText !== 'boolean') {
        throw new Error('invalid snapshot_request.includePageText');
      }
      return {
        type: 'snapshot_request',
        requestId: raw.requestId,
        tabId: raw.tabId,
        ...(raw.quizOnly !== undefined ? { quizOnly: raw.quizOnly } : {}),
        ...(raw.includePageText !== undefined ? { includePageText: raw.includePageText } : {}),
      };
    }
    case 'action_request': {
      if (!isStr(raw.requestId)) throw new Error('invalid action_request.requestId');
      if (!isNum(raw.tabId)) throw new Error('invalid action_request.tabId');
      return {
        type: 'action_request',
        requestId: raw.requestId,
        tabId: raw.tabId,
        action: parseAction(raw.action),
      };
    }
    default:
      throw new Error(`invalid HostToExt.type: ${JSON.stringify(raw.type)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function describeAction(a: Action): string {
  switch (a.op) {
    case 'click':
      return `click #${a.index}`;
    case 'type':
      return `type #${a.index} ${JSON.stringify(a.text)}`;
    case 'select':
      return `select #${a.index} "${a.option}"`;
    case 'scroll':
      return `scroll ${a.deltaY >= 0 ? '+' : ''}${a.deltaY}`;
    case 'key':
      return `key "${a.key}"`;
    case 'eval': {
      const expr = a.expression.length > 80 ? a.expression.slice(0, 77) + '…' : a.expression;
      return `eval ${JSON.stringify(expr)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// M2: capture / inspection / recipe contract (docs/m2-auto-inspect.md §3)
// ---------------------------------------------------------------------------

export interface ProgressClaim {
  raw: string;
  current: number;
  total: number;
}

export interface PageCapture {
  /** sha1(origin|pathname|capturedAt), first 16 hex chars. */
  captureId: string;
  url: string;
  origin: string;
  capturedAt: number;
  table: ElementTable;
  /** ≤32KB truncated document body text; fallback for canvas/odd structures. */
  pageText?: string;
  progressClaim?: ProgressClaim;
  /** M3 extension point: screenshot for multimodal enumeration. */
  screenshotRef?: string;
  meta?: Record<string, unknown>;
}

export type QuizSource = 'recipe' | 'hint' | 'heuristic' | 'llm' | 'arbitrated';

export interface QuizQuestionModel {
  stem: string;
  stemIndex: number;
  optionIndices: number[];
  inputIndices: number[];
  answered: boolean;
  /** 0..1; below-threshold questions must not be acted on. */
  confidence: number;
  source: QuizSource;
}

export interface InspectionResult {
  captureId: string;
  questions: QuizQuestionModel[];
  /** 检查/保存/下一页/交卷 etc. — submission is still gated by AUTO_SUBMIT. */
  navIndices: number[];
  /** Quiz-candidate elements deliberately NOT part of the quiz, with reasons. */
  excluded: Array<{ index: number; reason: string }>;
  conservation: {
    status: 'pass' | 'fail';
    rounds: number;
    unaccounted: number[];
  };
  diagnostics: string[];
}

export interface QuizRecipe {
  origin: string;
  questionSelector?: string;
  optionSelector?: string;
  heartbeatUrlPattern?: string;
  videoSelector?: string;
  learnedVia: 'distill';
  confidence: number;
  updatedAt: number;
}

export interface InspectionSession {
  captures: PageCapture[]; // ordered by capturedAt ascending
  questions: QuizQuestionModel[]; // deduped across pages
  progress: { claimedDone: number; claimedTotal: number | null; seen: number };
  diagnostics: string[];
}

const QUIZ_SOURCES: readonly QuizSource[] = ['recipe', 'hint', 'heuristic', 'llm', 'arbitrated'];

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isIndexArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => isNum(n));
}

function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => isStr(s));
}

function parseConfidence(v: unknown, label: string): number {
  if (!isNum(v) || v < 0 || v > 1) {
    throw new Error(`invalid ${label}.confidence: expected finite number in [0,1]`);
  }
  return v;
}

export function parseProgressClaim(raw: unknown): ProgressClaim {
  if (!isRecord(raw)) throw new Error('invalid ProgressClaim: not an object');
  if (!isNonEmptyStr(raw.raw)) throw new Error('invalid ProgressClaim.raw');
  if (!isNum(raw.current)) throw new Error('invalid ProgressClaim.current');
  if (!isNum(raw.total)) throw new Error('invalid ProgressClaim.total');
  return { raw: raw.raw, current: raw.current, total: raw.total };
}

export function parsePageCapture(raw: unknown): PageCapture {
  if (!isRecord(raw)) throw new Error('invalid PageCapture: not an object');
  if (!isNonEmptyStr(raw.captureId)) throw new Error('invalid PageCapture.captureId');
  if (!isNonEmptyStr(raw.url)) throw new Error('invalid PageCapture.url');
  if (!isNonEmptyStr(raw.origin)) throw new Error('invalid PageCapture.origin');
  if (!isNum(raw.capturedAt)) throw new Error('invalid PageCapture.capturedAt');
  const out: PageCapture = {
    captureId: raw.captureId,
    url: raw.url,
    origin: raw.origin,
    capturedAt: raw.capturedAt,
    table: parseElementTable(raw.table),
  };
  if (raw.pageText !== undefined) {
    if (!isStr(raw.pageText)) throw new Error('invalid PageCapture.pageText');
    out.pageText = raw.pageText;
  }
  if (raw.progressClaim !== undefined) out.progressClaim = parseProgressClaim(raw.progressClaim);
  if (raw.screenshotRef !== undefined) {
    if (!isStr(raw.screenshotRef)) throw new Error('invalid PageCapture.screenshotRef');
    out.screenshotRef = raw.screenshotRef;
  }
  if (raw.meta !== undefined) {
    if (!isRecord(raw.meta)) throw new Error('invalid PageCapture.meta');
    out.meta = raw.meta;
  }
  return out;
}

export function parseQuizQuestionModel(raw: unknown): QuizQuestionModel {
  if (!isRecord(raw)) throw new Error('invalid QuizQuestionModel: not an object');
  if (!isStr(raw.stem)) throw new Error('invalid QuizQuestionModel.stem');
  if (!isNum(raw.stemIndex)) throw new Error('invalid QuizQuestionModel.stemIndex');
  if (!isIndexArray(raw.optionIndices)) throw new Error('invalid QuizQuestionModel.optionIndices');
  if (!isIndexArray(raw.inputIndices)) throw new Error('invalid QuizQuestionModel.inputIndices');
  if (typeof raw.answered !== 'boolean') throw new Error('invalid QuizQuestionModel.answered');
  if (!isStr(raw.source) || !QUIZ_SOURCES.includes(raw.source as QuizSource)) {
    throw new Error(`invalid QuizQuestionModel.source: ${JSON.stringify(raw.source)}`);
  }
  return {
    stem: raw.stem,
    stemIndex: raw.stemIndex,
    optionIndices: [...raw.optionIndices],
    inputIndices: [...raw.inputIndices],
    answered: raw.answered,
    confidence: parseConfidence(raw.confidence, 'QuizQuestionModel'),
    source: raw.source as QuizSource,
  };
}

export function parseInspectionResult(raw: unknown): InspectionResult {
  if (!isRecord(raw)) throw new Error('invalid InspectionResult: not an object');
  if (!isNonEmptyStr(raw.captureId)) throw new Error('invalid InspectionResult.captureId');
  if (!Array.isArray(raw.questions)) throw new Error('invalid InspectionResult.questions');
  if (!isIndexArray(raw.navIndices)) throw new Error('invalid InspectionResult.navIndices');
  if (!Array.isArray(raw.excluded)) throw new Error('invalid InspectionResult.excluded');
  const excluded = raw.excluded.map((e) => {
    if (!isRecord(e) || !isNum(e.index) || !isStr(e.reason)) {
      throw new Error('invalid InspectionResult.excluded entry');
    }
    return { index: e.index, reason: e.reason };
  });
  const cons = raw.conservation;
  if (!isRecord(cons) || (cons.status !== 'pass' && cons.status !== 'fail')) {
    throw new Error('invalid InspectionResult.conservation.status');
  }
  if (!isNum(cons.rounds)) throw new Error('invalid InspectionResult.conservation.rounds');
  if (!isIndexArray(cons.unaccounted)) throw new Error('invalid InspectionResult.conservation.unaccounted');
  if (!isStrArray(raw.diagnostics)) throw new Error('invalid InspectionResult.diagnostics');
  return {
    captureId: raw.captureId,
    questions: raw.questions.map((q) => parseQuizQuestionModel(q)),
    navIndices: [...raw.navIndices],
    excluded,
    conservation: {
      status: cons.status,
      rounds: cons.rounds,
      unaccounted: [...cons.unaccounted],
    },
    diagnostics: [...raw.diagnostics],
  };
}

export function parseQuizRecipe(raw: unknown): QuizRecipe {
  if (!isRecord(raw)) throw new Error('invalid QuizRecipe: not an object');
  if (!isNonEmptyStr(raw.origin)) throw new Error('invalid QuizRecipe.origin');
  if (raw.learnedVia !== 'distill') {
    throw new Error(`invalid QuizRecipe.learnedVia: ${JSON.stringify(raw.learnedVia)}`);
  }
  if (!isNum(raw.updatedAt)) throw new Error('invalid QuizRecipe.updatedAt');
  const out: QuizRecipe = {
    origin: raw.origin,
    learnedVia: 'distill',
    confidence: parseConfidence(raw.confidence, 'QuizRecipe'),
    updatedAt: raw.updatedAt,
  };
  const selectorKeys = [
    'questionSelector',
    'optionSelector',
    'heartbeatUrlPattern',
    'videoSelector',
  ] as const;
  for (const key of selectorKeys) {
    if (raw[key] !== undefined) {
      if (!isNonEmptyStr(raw[key])) throw new Error(`invalid QuizRecipe.${key}`);
      out[key] = raw[key];
    }
  }
  return out;
}

export function parseInspectionSession(raw: unknown): InspectionSession {
  if (!isRecord(raw)) throw new Error('invalid InspectionSession: not an object');
  if (!Array.isArray(raw.captures)) throw new Error('invalid InspectionSession.captures');
  if (!Array.isArray(raw.questions)) throw new Error('invalid InspectionSession.questions');
  const prog = raw.progress;
  if (!isRecord(prog) || !isNum(prog.claimedDone) || !isNum(prog.seen)) {
    throw new Error('invalid InspectionSession.progress');
  }
  if (prog.claimedTotal !== null && !isNum(prog.claimedTotal)) {
    throw new Error('invalid InspectionSession.progress.claimedTotal');
  }
  if (!isStrArray(raw.diagnostics)) throw new Error('invalid InspectionSession.diagnostics');
  return {
    captures: raw.captures.map((c) => parsePageCapture(c)),
    questions: raw.questions.map((q) => parseQuizQuestionModel(q)),
    progress: {
      claimedDone: prog.claimedDone,
      claimedTotal: prog.claimedTotal,
      seen: prog.seen,
    },
    diagnostics: [...raw.diagnostics],
  };
}
