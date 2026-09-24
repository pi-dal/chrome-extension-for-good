/**
 * c4g content script (main frame, isolated world).
 *
 * Builds indexed element tables (snapshot_request) and executes actions
 * (action_request) addressed by snapshot index. Indices are valid only within
 * one snapshot: the executor keeps live DOM references for the last snapshot
 * with a 30s TTL, so hosts must re-snapshot after navigation or expiry.
 *
 * Moodle quiz support: elements inside .que are classified into quizSlots
 * (question / option / answer-input / nav); .qtext blocks are included so the
 * host can pair questions with the options that follow them in document order.
 */

import { parseHostToExt } from '@c4g/protocol';
import type { Action, ElementInfo, ElementTable, ExtToHost, HostToExt } from '@c4g/protocol';

const NAME_MAX = 120;
const QUESTION_MAX = 300;
const VALUE_MAX = 80;
const CACHE_TTL_MS = 30_000;
const ACTION_SETTLE_MS = 250;

const NAV_RE = /保存|下一题|提交|检查|check|save|next|finish|submit/i;

const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  'video',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
  '.que .qtext',
].join(',');

// ---------------------------------------------------------------------------
// snapshot cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  ts: number;
  refs: (HTMLElement | null)[];
}

let cache: CacheEntry | null = null;

function remember(refs: (HTMLElement | null)[]): void {
  cache = { ts: Date.now(), refs };
}

function cachedRefs(): (HTMLElement | null)[] | null {
  if (!cache) return null;
  if (Date.now() - cache.ts > CACHE_TTL_MS) {
    cache = null;
    return null;
  }
  // Sliding expiry: the cache's real epoch is "until the next snapshot
  // replaces it" — the TTL is only an idle-safety bound. A multi-question
  // quiz round (LLM solve latency + paced clicks) easily exceeds 30s and
  // must not lose its index epoch mid-round; detached elements are still
  // caught by the isConnected check at the action site.
  cache.ts = Date.now();
  return cache.refs;
}

// ---------------------------------------------------------------------------
// visibility / metadata helpers
// ---------------------------------------------------------------------------

type VisibilityChecker = Element & {
  checkVisibility?: (options?: { checkVisibilityCSS?: boolean }) => boolean;
};

function isVisible(el: Element): boolean {
  const checker = el as VisibilityChecker;
  if (typeof checker.checkVisibility === 'function') {
    return checker.checkVisibility({ checkVisibilityCSS: true });
  }
  for (let n: Element | null = el; n !== null; n = n.parentElement) {
    const cs = window.getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  }
  return true;
}

function isDisabled(el: HTMLElement): boolean {
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
}

function squish(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function textOf(el: Element, max: number): string {
  return squish(el.textContent ?? '').slice(0, max);
}

function hasInteractiveSemantics(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (['button', 'a', 'input', 'textarea', 'select', 'video', 'summary'].includes(tag)) return true;
  return el.hasAttribute('role') || el.hasAttribute('onclick') || el.classList.contains('qtext');
}

function labelForControl(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) {
        const t = squish(lab.textContent ?? '');
        if (t) return t;
      }
    }
    const wrap = el.closest('label');
    if (wrap) {
      const t = squish(wrap.textContent ?? '');
      if (t) return t;
    }
  }
  return '';
}

function accessibleName(el: HTMLElement): string {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return squish(ariaLabel).slice(0, NAME_MAX);

  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const text = labelledby
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    const t = squish(text);
    if (t) return t.slice(0, NAME_MAX);
  }

  const label = labelForControl(el);
  if (label) return label.slice(0, NAME_MAX);

  const own = textOf(el, NAME_MAX);
  if (own) return own;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (el.placeholder) return el.placeholder.trim().slice(0, NAME_MAX);
    if (el.value) return el.value.trim().slice(0, NAME_MAX);
  }
  const alt = el.getAttribute('alt');
  if (alt && alt.trim()) return alt.trim().slice(0, NAME_MAX);
  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim().slice(0, NAME_MAX);
  return '';
}

function classifyRole(el: HTMLElement): { role: string; checked?: boolean } {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');

  if (el instanceof HTMLInputElement) {
    if (el.type === 'checkbox') return { role: 'checkbox', checked: el.checked };
    if (el.type === 'radio') return { role: 'radio', checked: el.checked };
    if (el.type === 'button' || el.type === 'submit' || el.type === 'reset' || el.type === 'image') {
      return { role: 'button' };
    }
    return { role: 'textbox' };
  }
  if (el instanceof HTMLTextAreaElement) return { role: 'textbox' };
  if (el instanceof HTMLSelectElement) return { role: 'combobox' };
  if (tag === 'a') return { role: 'link' };
  if (tag === 'button' || tag === 'summary') return { role: 'button' };
  if (tag === 'video') return { role: 'video' };
  if (role === 'checkbox' || role === 'radio' || role === 'switch') {
    return { role, checked: el.getAttribute('aria-checked') === 'true' };
  }
  if (role === 'button' || role === 'link' || role === 'tab') return { role };
  if (el.classList.contains('qtext')) return { role: 'text' };
  return { role: 'other' };
}

function valueOf(el: HTMLElement): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const v = el.value.trim();
    return v ? v.slice(0, VALUE_MAX) : undefined;
  }
  if (el instanceof HTMLSelectElement) {
    const opt = el.selectedOptions[0];
    const v = opt ? opt.text.trim() : '';
    return v ? v.slice(0, VALUE_MAX) : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Moodle quiz classification
// ---------------------------------------------------------------------------

function classifyQuiz(el: HTMLElement, name: string): ElementInfo['quizSlot'] | undefined {
  const tag = el.tagName.toLowerCase();
  const isButtonish =
    tag === 'button' ||
    el.getAttribute('role') === 'button' ||
    (el instanceof HTMLInputElement &&
      (el.type === 'button' || el.type === 'submit' || el.type === 'reset'));

  // Nav buttons are matched anywhere on the page (Moodle renders them outside .que).
  if (isButtonish && NAV_RE.test(name)) return 'nav';

  const que = el.closest('.que');
  if (!que) return undefined;

  if (el.classList.contains('qtext') || el.closest('.qtext') !== null) return 'question';
  if (el instanceof HTMLInputElement) {
    if (el.type === 'radio' || el.type === 'checkbox') return 'option';
    if (!['button', 'submit', 'reset', 'hidden', 'image'].includes(el.type)) return 'answer-input';
  }
  if (el instanceof HTMLTextAreaElement) return 'answer-input';
  return undefined;
}

// ---------------------------------------------------------------------------
// snapshot builder
// ---------------------------------------------------------------------------

interface SnapEntry {
  info: ElementInfo;
  el: HTMLElement;
}

function toInfo(el: HTMLElement, rect: DOMRect): ElementInfo {
  const { role, checked } = classifyRole(el);
  const isQtext = el.classList.contains('qtext');
  let name = isQtext ? textOf(el, QUESTION_MAX) : accessibleName(el);
  const quizSlot = classifyQuiz(el, name);
  if (quizSlot === 'question') name = textOf(el.closest('.qtext') ?? el, QUESTION_MAX);

  const info: ElementInfo = {
    index: 0,
    role,
    name,
    tag: el.tagName.toLowerCase(),
    rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
  };
  if (checked !== undefined) info.checked = checked;
  const value = valueOf(el);
  if (value !== undefined) info.value = value;
  if (quizSlot) info.quizSlot = quizSlot;
  // DOM `name` attribute (radio groups share it) — the F8 grouping signal.
  const htmlName = el.getAttribute('name');
  if (htmlName) info.htmlName = htmlName;
  return info;
}

function buildEntries(includeOffscreen: boolean): SnapEntry[] {
  const out: SnapEntry[] = [];
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR));
  for (const el of nodes) {
    // [tabindex] candidates are only kept with interactive semantics or an aria-label.
    if (!hasInteractiveSemantics(el)) {
      const ariaLabel = el.getAttribute('aria-label');
      if (!ariaLabel || !ariaLabel.trim()) continue;
    }
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (!includeOffscreen) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx < 0 || cx > window.innerWidth || cy < 0 || cy > window.innerHeight) continue;
    }
    if (isDisabled(el)) continue;
    out.push({ info: toInfo(el, rect), el });
  }
  return out;
}

function snapshot(
  quizOnly: boolean,
  includeOffscreen: boolean,
): { table: ElementTable; refs: (HTMLElement | null)[] } {
  // Quiz snapshots keep below-fold elements: the executor clicks via
  // el.click(), which works offscreen, and long Moodle pages put questions
  // far below the fold. includeOffscreen does the same for full captures —
  // a multi-screen quiz must enumerate every question, not just the viewport.
  let entries = buildEntries(quizOnly || includeOffscreen);
  if (quizOnly) {
    entries = entries.filter((e) => e.info.quizSlot !== undefined || e.info.role === 'button');
  }
  const elements: ElementInfo[] = entries.map((e, i) => {
    const info: ElementInfo = { ...e.info };
    info.index = i + 1;
    return info;
  });
  const refs: (HTMLElement | null)[] = entries.map((e) => e.el);
  return {
    table: { url: location.href, title: document.title, capturedAt: Date.now(), elements },
    refs,
  };
}

// ---------------------------------------------------------------------------
// action executor
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firePointer(el: HTMLElement, type: string, clientX: number, clientY: number): void {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      isPrimary: true,
      clientX,
      clientY,
      button: 0,
    }),
  );
}

function fireMouse(el: HTMLElement, type: string, clientX: number, clientY: number): void {
  el.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      button: 0,
    }),
  );
}

/**
 * Full click realism with a single click event: pointer/mouse press sequence for
 * handlers that track them, then el.click() for activation (runs default actions
 * like link navigation and form submission). A separately dispatched synthetic
 * click would double-fire handlers.
 */
function doClick(el: HTMLElement): void {
  el.focus();
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  // Real press sequence: pointerdown → mousedown → pointerup → mouseup → click.
  firePointer(el, 'pointerdown', cx, cy);
  fireMouse(el, 'mousedown', cx, cy);
  firePointer(el, 'pointerup', cx, cy);
  fireMouse(el, 'mouseup', cx, cy);
  el.click();
}

function doType(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  el.focus();
  // Native prototype setter so framework value observers (React/Vue) see the change.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) desc.set.call(el, text);
  else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function doSelect(el: HTMLSelectElement, option: string): void {
  const norm = option.trim().toLowerCase();
  let match: HTMLOptionElement | null = null;
  for (const o of Array.from(el.options)) {
    if (o.value.trim().toLowerCase() === norm || o.text.trim().toLowerCase() === norm) {
      match = o;
      break;
    }
  }
  if (!match) throw new Error(`option not found: ${option}`);
  el.focus();
  el.value = match.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function doKey(el: HTMLElement, key: string): void {
  const init: KeyboardEventInit = { key, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

function fail(requestId: string, error: string): Extract<ExtToHost, { type: 'action_result' }> {
  return { type: 'action_result', requestId, ok: false, error, url: location.href };
}

async function executeAction(
  requestId: string,
  action: Action,
): Promise<Extract<ExtToHost, { type: 'action_result' }>> {
  try {
    if (action.op === 'scroll') {
      window.scrollBy(0, action.deltaY);
    } else if (action.op === 'key') {
      const target = (document.activeElement as HTMLElement | null) ?? document.body;
      doKey(target, action.key);
    } else if (action.op === 'eval') {
      // Host-constant probe expressions only (design §3): distill/recipe
      // selectors are grammar-whitelisted and JSON-escaped HOST-side before
      // they ever appear inside an expression. `__c4gRef(i)` resolves the
      // live element cached for snapshot index i. Runs in the isolated world
      // (DOM access, no page JS vars); pages with a strict CSP may refuse
      // Function construction — fails safe below.
      const refs = cachedRefs();
      const c4gRef = (i: number): HTMLElement | null =>
        refs && Number.isInteger(i) && i >= 1 && i <= refs.length ? refs[i - 1] : null;
      let value: unknown;
      try {
        const fn = new Function('__c4gRef', `return (${action.expression});`);
        value = fn(c4gRef);
      } catch (err) {
        return fail(requestId, `eval failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      let json: string;
      try {
        json = JSON.stringify(value ?? null);
      } catch {
        return fail(requestId, 'eval result is not JSON-serializable');
      }
      if (json.length > 65_536) return fail(requestId, 'eval result exceeds 64KB');
      return { type: 'action_result', requestId, ok: true, url: location.href, value: JSON.parse(json) as unknown };
    } else {
      const refs = cachedRefs();
      const el = refs?.[action.index - 1] ?? null;
      if (!el || !el.isConnected) return fail(requestId, 'stale-snapshot');
      if (action.op === 'click') {
        doClick(el);
      } else if (action.op === 'type') {
        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
          return fail(requestId, 'element is not a text field');
        }
        doType(el, action.text);
      } else {
        if (!(el instanceof HTMLSelectElement)) return fail(requestId, 'element is not a select');
        doSelect(el, action.option);
      }
    }
  } catch (err) {
    return fail(requestId, String(err));
  }

  await sleep(ACTION_SETTLE_MS);
  return { type: 'action_result', requestId, ok: true, url: location.href };
}

// ---------------------------------------------------------------------------
// message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (resp: unknown) => void) => {
  void (async () => {
    let msg: HostToExt;
    try {
      msg = parseHostToExt(raw);
    } catch {
      return; // not a c4g message (or malformed) — ignore
    }
    if (msg.type === 'snapshot_request') {
      try {
        const { table, refs } = snapshot(msg.quizOnly === true, msg.includeOffscreen === true);
        remember(refs);
        // includePageText: body text for the LLM enumeration fallback channel
        // (design §3); truncated to the protocol's 32KB budget.
        const payload: { type: 'snapshot'; requestId: string; table: ElementTable; pageText?: string } = {
          type: 'snapshot',
          requestId: msg.requestId,
          table,
        };
        if (msg.includePageText === true) {
          payload.pageText = (document.body?.innerText ?? '').slice(0, 32 * 1024);
        }
        sendResponse(payload);
      } catch (err) {
        // No error envelope exists for snapshots; the host request times out.
        console.warn('[c4g-cs] snapshot failed:', err);
      }
    } else if (msg.type === 'action_request') {
      sendResponse(await executeAction(msg.requestId, msg.action));
    }
    // open_tab/close_tab never reach a content script (the service worker
    // answers those itself), so any other variant is ignored here.
  })();
  return true; // keep the message channel open for the async response
});
