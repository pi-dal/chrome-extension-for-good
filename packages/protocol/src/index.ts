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
  /**
   * The element's DOM `name` attribute (radio inputs sharing a name are one
   * question). Carried since the F8 fix — structural grouping uses it to
   * split contiguous radio runs that belong to different questions.
   */
  htmlName?: string;
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

// ---------------------------------------------------------------------------
// Site plugins (platform adapters as data)
// ---------------------------------------------------------------------------

/**
 * A platform adapter, expressed as data instead of code.
 *
 * The JS fields run in the page's MAIN world through CDP `evaluate`, exactly
 * like the built-in adapter used to: `heartbeatHookJs` installs an idempotent
 * recorder for the platform's own heartbeat traffic, `playerStateJs` reads the
 * player, `courseIdsJs` lists the videos on a course page. They are trusted
 * configuration — written by the operator in the extension options page or in
 * data/plugins/*.json — so validation guarantees shape, size and compilable
 * patterns, never sandboxing.
 */
export interface SitePluginMatch {
  /** Substring of a TAB url that this plugin owns (e.g. '/mod/fsresource/view.php'). */
  video: string;
  /** Additional video-page substrings (platforms with several player URLs). */
  videoAny?: string[];
  /** Optional substring identifying the course/list page (enables `chain` scraping). */
  course?: string;
  /** Additional course-page substrings. */
  courseAny?: string[];
  /** Optional substring identifying a quiz/attempt page (enables quiz hints). */
  quiz?: string;
  /** Additional quiz-page substrings. */
  quizAny?: string[];
}

export interface SitePlugin {
  id: string;
  label?: string;
  match: SitePluginMatch;
  /** Known heartbeat URL fragment (enables the fast path in observation). */
  heartbeatUrlPattern?: string;
  /** MAIN-world source: record the platform's last heartbeat request/response. */
  heartbeatHookJs: string;
  /** MAIN-world expression: player state object (or its JSON string). */
  playerStateJs: string;
  /** MAIN-world expression: JSON array of video ids on a course page. */
  courseIdsJs?: string;
  /** Video page URL template containing `{id}`. */
  videoUrlTemplate?: string;
  /** Regex with one capture group extracting the video id from a video URL. */
  idPattern?: string;
  /**
   * Where this definition came from (repo/URL/path, free text). Required in
   * spirit for anything not measured on the deployment: the host logs it and
   * the options page shows it, so nobody mistakes a derived adapter for a
   * battle-tested one.
   */
  source?: string;
  /** What is missing or must be re-checked (fields to look for, caveats). */
  notes?: string;
  /** True only when this definition was measured against a live account. */
  verified?: boolean;
  /**
   * Report-replay knowledge (instant-pass / accelerated reporting). The MECHANISM lives in the host
   * (forge.ts): replay the plugin's own recorded heartbeat request with the
   * position field rewritten. A plugin only contributes the platform knowledge —
   * which numeric field carries the position — plus a note. A plugin that cannot
   * expose a readable server ack (totaltime/progress) cannot be verified, and
   * forging stays off for it.
   */
  forge?: SitePluginForge;
  /**
   * Quiz-page knowledge for the automatic inspect pipeline (M2).
   *
   * inspect's own layers stay in charge — a plugin only contributes what the
   * platform knows up front: where the quiz lives on the page, what the nav
   * buttons are called, and which selectors describe a question. Everything is
   * still verified against the live page and audited by the conservation rule;
   * learned recipes (data/recipes/<origin>.json) take precedence over this.
   */
  quiz?: SitePluginQuiz;
}

export interface SitePluginQuiz {
  /** Narrow candidate scanning to this subtree (containers, chrome, forums). */
  rootSelector?: string;
  /** Selector describing one question container (confirms/anchors grouping). */
  questionSelector?: string;
  /** Selector describing one option row. */
  optionSelector?: string;
  /** Selector for the platform's own progress/time widget (progressClaim). */
  progressSelector?: string;
  /** Exact nav button labels (e.g. check/save/next/submit in the page's language). */
  navLabels?: string[];
  source?: string;
  notes?: string;
  /** True only when these selectors were confirmed on a live quiz page. */
  verified?: boolean;
}

export interface SitePluginForge {
  /**
   * G ENERAL path: regex matching the position field inside the recorded
   * heartbeat body, e.g. `"(?:time|totaltime|playingTime)"\\s*:\\s*"?\\d+`. The
   * host rewrites that number and re-sends the recorded request.
   */
  timeFieldPattern?: string;
  /**
   * PLATFORM path for reports that cannot be edited generically (signed or
   * obfuscated payloads). MAIN-world source that reads
   * `window.__c4gForgePosition` and resolves with `{ok, status, detail}`; it may
   * use whatever its own hook captured. Takes precedence over timeFieldPattern.
   */
  replayJs?: string;
  /** What is known/unknown about replaying this platform's report. */
  note?: string;
}

export interface PluginLimits {
  maxPlugins: number;
  maxJsBytes: number;
  maxTextBytes: number;
  maxTotalBytes: number;
  maxAltPatterns: number;
}

export const PLUGIN_LIMITS: PluginLimits = {
  maxPlugins: 16,
  maxJsBytes: 16_384,
  maxTextBytes: 512,
  maxTotalBytes: 262_144,
  maxAltPatterns: 8,
};

export type HostToExt =
  | {
      type: 'snapshot_request';
      requestId: string;
      tabId: number;
      quizOnly?: boolean;
      includePageText?: boolean;
      /**
       * Keep elements whose center is outside the viewport. Captures need the
       * whole page (a multi-screen quiz must pass progress conservation);
       * the default viewport crop only exists to keep resume-path tables small.
       */
      includeOffscreen?: boolean;
    }
  | { type: 'action_request'; requestId: string; tabId: number; action: Action }
  /** Swarm lane provisioning: open a tab and report its chrome.tabs id. */
  | { type: 'open_tab'; requestId: string; url: string; active?: boolean }
  /** Swarm lane teardown: close a tab this run created. */
  | { type: 'close_tab'; requestId: string; tabId: number };

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
  /** Reply to open_tab/close_tab: the affected chrome.tabs id. */
  | { type: 'tab_result'; requestId: string; ok: boolean; tabId: number; url: string; error?: string }
  | {
      type: 'event';
      kind: 'nav' | 'lms_heartbeat';
      tabId: number;
      detail?: string;
      ts: number;
    }
  | { type: 'config_sync'; config: HostConfigPatch }
  /** Site plugins pushed by the extension options page (full-state sync). */
  | { type: 'plugins_sync'; plugins: SitePlugin[] }
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
  if (raw.htmlName !== undefined) {
    if (!isStr(raw.htmlName)) throw new Error('invalid ElementInfo.htmlName');
    el.htmlName = raw.htmlName;
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
  // Size bounds: action payloads are partly model-influenced (solver text) and
  // travel the ws bridge — cap them so a pathological answer cannot smuggle a
  // megabyte into a type/eval op.
  const bounded = (v: unknown, label: string, max: number): string => {
    if (!isStr(v)) throw new Error(`invalid ${label}`);
    if (v.length > max) throw new Error(`invalid ${label}: exceeds ${max} chars`);
    return v;
  };
  switch (raw.op) {
    case 'click':
      if (!isNum(raw.index)) throw new Error('invalid click Action.index');
      return { op: 'click', index: raw.index };
    case 'type':
      if (!isNum(raw.index)) throw new Error('invalid type Action.index');
      return { op: 'type', index: raw.index, text: bounded(raw.text, 'type Action.text', 4096) };
    case 'select':
      if (!isNum(raw.index)) throw new Error('invalid select Action.index');
      return { op: 'select', index: raw.index, option: bounded(raw.option, 'select Action.option', 512) };
    case 'scroll':
      if (!isNum(raw.deltaY)) throw new Error('invalid scroll Action.deltaY');
      return { op: 'scroll', deltaY: raw.deltaY };
    case 'key':
      return { op: 'key', key: bounded(raw.key, 'key Action.key', 64) };
    case 'eval':
      return { op: 'eval', expression: bounded(raw.expression, 'eval Action.expression', 8192) };
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
    case 'tab_result': {
      if (!isStr(raw.requestId)) throw new Error('invalid tab_result.requestId');
      if (typeof raw.ok !== 'boolean') throw new Error('invalid tab_result.ok');
      if (!isNum(raw.tabId)) throw new Error('invalid tab_result.tabId');
      if (!isStr(raw.url)) throw new Error('invalid tab_result.url');
      if (raw.error !== undefined && !isStr(raw.error)) {
        throw new Error('invalid tab_result.error');
      }
      return {
        type: 'tab_result',
        requestId: raw.requestId,
        ok: raw.ok,
        tabId: raw.tabId,
        url: raw.url,
        ...(raw.error !== undefined ? { error: raw.error } : {}),
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
    case 'plugins_sync': {
      // Full-state sync of the site-plugin list from the extension options page.
      return { type: 'plugins_sync', plugins: parseSitePlugins(raw.plugins) };
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
      if (raw.includeOffscreen !== undefined && typeof raw.includeOffscreen !== 'boolean') {
        throw new Error('invalid snapshot_request.includeOffscreen');
      }
      return {
        type: 'snapshot_request',
        requestId: raw.requestId,
        tabId: raw.tabId,
        ...(raw.quizOnly !== undefined ? { quizOnly: raw.quizOnly } : {}),
        ...(raw.includePageText !== undefined ? { includePageText: raw.includePageText } : {}),
        ...(raw.includeOffscreen !== undefined ? { includeOffscreen: raw.includeOffscreen } : {}),
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
    case 'open_tab': {
      if (!isStr(raw.requestId)) throw new Error('invalid open_tab.requestId');
      if (!isNonEmptyStr(raw.url)) throw new Error('invalid open_tab.url');
      if (raw.active !== undefined && typeof raw.active !== 'boolean') {
        throw new Error('invalid open_tab.active');
      }
      return {
        type: 'open_tab',
        requestId: raw.requestId,
        url: raw.url,
        ...(raw.active !== undefined ? { active: raw.active } : {}),
      };
    }
    case 'close_tab': {
      if (!isStr(raw.requestId)) throw new Error('invalid close_tab.requestId');
      if (!isNum(raw.tabId)) throw new Error('invalid close_tab.tabId');
      return { type: 'close_tab', requestId: raw.requestId, tabId: raw.tabId };
    }
    default:
      throw new Error(`invalid HostToExt.type: ${JSON.stringify(raw.type)}`);
  }
}

// ---------------------------------------------------------------------------
// Site plugin validators
// ---------------------------------------------------------------------------

/** UTF-8 byte length without Buffer — this module also runs in the browser. */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function boundedText(raw: unknown, label: string, maxBytes: number): string {
  if (!isStr(raw)) throw new Error(`invalid ${label}: expected string`);
  if (raw.length === 0) throw new Error(`invalid ${label}: empty`);
  if (utf8Bytes(raw) > maxBytes) {
    throw new Error(`invalid ${label}: exceeds ${maxBytes} bytes`);
  }
  return raw;
}

export function parseSitePlugin(raw: unknown): SitePlugin {
  if (!isRecord(raw)) throw new Error('invalid SitePlugin: not an object');
  const id = boundedText(raw.id, 'SitePlugin.id', 64);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid SitePlugin.id: ${JSON.stringify(id)}`);
  if (!isRecord(raw.match)) throw new Error('invalid SitePlugin.match: not an object');
  const match: SitePluginMatch = {
    video: boundedText(raw.match.video, 'SitePlugin.match.video', 256),
  };
  for (const key of ['videoAny', 'courseAny', 'quizAny'] as const) {
    const value = raw.match[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`invalid SitePlugin.match.${key}: expected a non-empty array`);
    }
    if (value.length > PLUGIN_LIMITS.maxAltPatterns) {
      throw new Error(`invalid SitePlugin.match.${key}: more than ${PLUGIN_LIMITS.maxAltPatterns} entries`);
    }
    match[key] = value.map((v) => boundedText(v, `SitePlugin.match.${key}[]`, 256));
  }
  if (raw.match.course !== undefined) {
    match.course = boundedText(raw.match.course, 'SitePlugin.match.course', 256);
  }
  if (raw.match.quiz !== undefined) {
    match.quiz = boundedText(raw.match.quiz, 'SitePlugin.match.quiz', 256);
  }
  const plugin: SitePlugin = {
    id,
    match,
    heartbeatHookJs: boundedText(raw.heartbeatHookJs, 'SitePlugin.heartbeatHookJs', PLUGIN_LIMITS.maxJsBytes),
    playerStateJs: boundedText(raw.playerStateJs, 'SitePlugin.playerStateJs', PLUGIN_LIMITS.maxJsBytes),
  };
  if (raw.label !== undefined) plugin.label = boundedText(raw.label, 'SitePlugin.label', 128);
  if (raw.source !== undefined) plugin.source = boundedText(raw.source, 'SitePlugin.source', PLUGIN_LIMITS.maxTextBytes);
  if (raw.notes !== undefined) plugin.notes = boundedText(raw.notes, 'SitePlugin.notes', PLUGIN_LIMITS.maxTextBytes);
  if (raw.verified !== undefined) {
    if (typeof raw.verified !== 'boolean') throw new Error('invalid SitePlugin.verified: expected boolean');
    plugin.verified = raw.verified;
  }
  if (raw.quiz !== undefined) {
    if (!isRecord(raw.quiz)) throw new Error('invalid SitePlugin.quiz: not an object');
    const quiz: SitePluginQuiz = {};
    const selectors = ['rootSelector', 'questionSelector', 'optionSelector', 'progressSelector'] as const;
    for (const key of selectors) {
      if (raw.quiz[key] !== undefined) quiz[key] = boundedText(raw.quiz[key], `SitePlugin.quiz.${key}`, 256);
    }
    if (raw.quiz.navLabels !== undefined) {
      if (!Array.isArray(raw.quiz.navLabels) || raw.quiz.navLabels.length === 0) {
        throw new Error('invalid SitePlugin.quiz.navLabels: expected a non-empty array');
      }
      if (raw.quiz.navLabels.length > PLUGIN_LIMITS.maxAltPatterns) {
        throw new Error(`invalid SitePlugin.quiz.navLabels: more than ${PLUGIN_LIMITS.maxAltPatterns} labels`);
      }
      quiz.navLabels = raw.quiz.navLabels.map((l) => boundedText(l, 'SitePlugin.quiz.navLabels[]', 64));
    }
    if (raw.quiz.source !== undefined) quiz.source = boundedText(raw.quiz.source, 'SitePlugin.quiz.source', PLUGIN_LIMITS.maxTextBytes);
    if (raw.quiz.notes !== undefined) quiz.notes = boundedText(raw.quiz.notes, 'SitePlugin.quiz.notes', PLUGIN_LIMITS.maxTextBytes);
    if (raw.quiz.verified !== undefined) {
      if (typeof raw.quiz.verified !== 'boolean') throw new Error('invalid SitePlugin.quiz.verified: expected boolean');
      quiz.verified = raw.quiz.verified;
    }
    if (Object.keys(quiz).length === 0) throw new Error('invalid SitePlugin.quiz: empty object');
    plugin.quiz = quiz;
  }
  if (raw.forge !== undefined) {
    if (!isRecord(raw.forge)) throw new Error('invalid SitePlugin.forge: not an object');
    const forge: SitePluginForge = {};
    if (raw.forge.timeFieldPattern !== undefined) {
      const pattern = boundedText(raw.forge.timeFieldPattern, 'SitePlugin.forge.timeFieldPattern', 256);
      try {
        new RegExp(pattern);
      } catch (err) {
        throw new Error(`invalid SitePlugin.forge.timeFieldPattern: ${err instanceof Error ? err.message : String(err)}`);
      }
      forge.timeFieldPattern = pattern;
    }
    if (raw.forge.replayJs !== undefined) {
      forge.replayJs = boundedText(raw.forge.replayJs, 'SitePlugin.forge.replayJs', PLUGIN_LIMITS.maxJsBytes);
    }
    if (raw.forge.note !== undefined) forge.note = boundedText(raw.forge.note, 'SitePlugin.forge.note', PLUGIN_LIMITS.maxTextBytes);
    if (forge.timeFieldPattern === undefined && forge.replayJs === undefined && forge.note === undefined) {
      throw new Error('invalid SitePlugin.forge: needs timeFieldPattern, replayJs or note');
    }
    plugin.forge = forge;
  }
  if (raw.heartbeatUrlPattern !== undefined) {
    plugin.heartbeatUrlPattern = boundedText(raw.heartbeatUrlPattern, 'SitePlugin.heartbeatUrlPattern', 256);
  }
  if (raw.courseIdsJs !== undefined) {
    plugin.courseIdsJs = boundedText(raw.courseIdsJs, 'SitePlugin.courseIdsJs', PLUGIN_LIMITS.maxJsBytes);
  }
  if (raw.videoUrlTemplate !== undefined) {
    const tpl = boundedText(raw.videoUrlTemplate, 'SitePlugin.videoUrlTemplate', PLUGIN_LIMITS.maxTextBytes);
    if (!tpl.includes('{id}')) throw new Error('invalid SitePlugin.videoUrlTemplate: missing {id} placeholder');
    plugin.videoUrlTemplate = tpl;
  }
  if (raw.idPattern !== undefined) {
    const pattern = boundedText(raw.idPattern, 'SitePlugin.idPattern', 256);
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      throw new Error(`invalid SitePlugin.idPattern: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!/\((?!\?)/.test(pattern)) {
      throw new Error('invalid SitePlugin.idPattern: needs a capture group, e.g. "view\\\\.php\\\\?id=(\\\\d+)"');
    }
    plugin.idPattern = pattern;
  }
  return plugin;
}

export function parseSitePlugins(raw: unknown): SitePlugin[] {
  if (!Array.isArray(raw)) throw new Error('invalid plugins payload: not an array');
  if (raw.length > PLUGIN_LIMITS.maxPlugins) {
    throw new Error(`invalid plugins payload: more than ${PLUGIN_LIMITS.maxPlugins} plugins`);
  }
  const plugins = raw.map((p) => parseSitePlugin(p));
  const ids = new Set<string>();
  for (const p of plugins) {
    if (ids.has(p.id)) throw new Error(`invalid plugins payload: duplicate id ${p.id}`);
    ids.add(p.id);
  }
  if (JSON.stringify(plugins).length > PLUGIN_LIMITS.maxTotalBytes) {
    throw new Error(`invalid plugins payload: exceeds ${PLUGIN_LIMITS.maxTotalBytes} bytes`);
  }
  return plugins;
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
  /** check/save/next/submit controls — submission is still gated by AUTO_SUBMIT. */
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

// ---------------------------------------------------------------------------
// Built-in site plugins (data)
// ---------------------------------------------------------------------------

export {
  BUILTIN_PLUGINS,
  CHAOXING_FORGE_JS,
  CHAOXING_MD5_JS,
  CHAOXING_PLUGIN,
  ICOURSE163_PLUGIN,
  LMS_FSRESOURCE_PLUGIN,
  ZHIHUISHU_FORGE_JS,
  ZHIHUISHU_PLUGIN,
} from './plugins/index.js';
