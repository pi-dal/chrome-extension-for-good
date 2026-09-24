/**
 * L2 structural heuristic grouper (docs/m2-auto-inspect.md §4.2).
 *
 * Platform-free quiz grouping over an element table: consecutive
 * radio/checkbox runs are option groups (a radio run is also split when the
 * DOM `name` changes — F8: two questions' radios can be contiguous in the
 * table when the second stem was never captured), the nearest preceding
 * free-text element is the stem, trailing textboxes become answer inputs,
 * and buttons are classified as quiz nav or explicitly excluded. When the
 * snapshot carries quizSlot hints (e.g. Moodle .que), the hints are trusted
 * directly (source 'hint', confidence 1).
 *
 * The grouper is deliberately conservative: quiz-candidate controls it cannot
 * place (e.g. an option run with no stem) are returned in `unassigned` for
 * the conservation auditor and the LLM feedback loop — never silently
 * dropped.
 */
import type { ElementInfo, ElementTable } from '@c4g/protocol';

export type HeuristicSource = 'hint' | 'heuristic';

export interface HeuristicQuestion {
  stem: string;
  stemIndex: number;
  optionIndices: number[];
  inputIndices: number[];
  answered: boolean;
  source: HeuristicSource;
  confidence: number;
}

export interface HeuristicResult {
  questions: HeuristicQuestion[];
  navIndices: number[];
  excluded: Array<{ index: number; reason: string }>;
  /** Quiz-candidate controls the grouper could not place. */
  unassigned: number[];
}

const NAV_RE = /保存|检查|交卷|提交|下一题|下一页|下一节|next|submit|check|save/i;
const LOGIN_RE = /登录|登陆|log\s?in|sign\s?in/i;
const BOOKMARK_RE = /收藏|bookmark|favorite/i;
const SCROLL_TOP_RE = /返回顶部|back[ .-]?to[ .-]?top|scroll[ .-]?to[ .-]?top/i;
const OPTION_ROLES: ReadonlySet<string> = new Set(['radio', 'checkbox']);
const INPUT_ROLES: ReadonlySet<string> = new Set(['textbox']);
/** A stem is question-like when long enough or ends with question punctuation. */
const STEM_MIN_CHARS = 6;
const STEM_TAIL_RE = /[？?:：]\s*$/;

const HINT_CONFIDENCE = 1;
const HEURISTIC_CONFIDENCE = 0.9;

function isHeading(el: ElementInfo): boolean {
  return el.role === 'heading' || /^h[1-6]$/.test(el.tag);
}

function isOptionControl(el: ElementInfo): boolean {
  return OPTION_ROLES.has(el.role);
}

function isInputControl(el: ElementInfo): boolean {
  return INPUT_ROLES.has(el.role);
}

function isButtonish(el: ElementInfo): boolean {
  return el.role === 'button' || el.tag === 'button' || el.role === 'link';
}

function looksLikeStem(el: ElementInfo): boolean {
  const name = el.name.trim();
  return name.length >= STEM_MIN_CHARS || STEM_TAIL_RE.test(el.name);
}

function isAnswered(options: ElementInfo[], inputs: ElementInfo[]): boolean {
  if (options.length > 0) {
    // Single-choice radios and multi-select checkboxes alike: a question
    // counts as answered once ANY of its options is selected — the platform
    // marks a multi-select answered on the first tick. Requiring every box
    // would misread proper-subset answers as unanswered, and re-answering
    // would toggle the existing selections back off (review H3).
    const radios = options.filter((el) => el.role === 'radio');
    const checkboxes = options.filter((el) => el.role === 'checkbox');
    const radiosOk = radios.length === 0 || radios.some((el) => el.checked === true);
    const boxesOk = checkboxes.length === 0 || checkboxes.some((el) => el.checked === true);
    return radiosOk && boxesOk;
  }
  if (inputs.length > 0) return inputs.every((el) => (el.value ?? '').trim() !== '');
  return false;
}

/** Common button taxonomy shared by both paths. */
function classifyButton(el: ElementInfo, nav: number[], excluded: Array<{ index: number; reason: string }>): void {
  if (el.disabled) {
    excluded.push({ index: el.index, reason: 'disabled control' });
    return;
  }
  if (NAV_RE.test(el.name)) {
    nav.push(el.index);
  } else if (LOGIN_RE.test(el.name)) {
    excluded.push({ index: el.index, reason: 'login button, not quiz nav' });
  } else if (BOOKMARK_RE.test(el.name)) {
    excluded.push({ index: el.index, reason: 'bookmark button, not quiz nav' });
  } else if (SCROLL_TOP_RE.test(el.name)) {
    excluded.push({ index: el.index, reason: 'scroll-to-top button, not quiz nav' });
  } else {
    excluded.push({ index: el.index, reason: 'not quiz nav' });
  }
}

/** Hint path: trust quizSlot annotations directly (Moodle-like platforms). */
function groupByHints(table: ElementTable): HeuristicResult {
  const questions: HeuristicQuestion[] = [];
  const navIndices: number[] = [];
  const excluded: Array<{ index: number; reason: string }> = [];
  const unassigned: number[] = [];
  let current: HeuristicQuestion | null = null;

  for (const el of table.elements) {
    switch (el.quizSlot) {
      case 'question': {
        current = {
          stem: el.name,
          stemIndex: el.index,
          optionIndices: [],
          inputIndices: [],
          answered: false,
          source: 'hint',
          confidence: HINT_CONFIDENCE,
        };
        questions.push(current);
        break;
      }
      case 'option':
        // An option before any question stem is an ORPHAN — surface it to the
        // conservation/LLM feedback path instead of vanishing silently.
        if (current) current.optionIndices.push(el.index);
        else unassigned.push(el.index);
        break;
      case 'answer-input':
        if (current) current.inputIndices.push(el.index);
        else unassigned.push(el.index);
        break;
      case 'nav':
        navIndices.push(el.index);
        break;
      default: {
        if (isHeading(el)) excluded.push({ index: el.index, reason: 'page heading, not a quiz candidate' });
        else if (isButtonish(el)) classifyButton(el, navIndices, excluded);
        else excluded.push({ index: el.index, reason: 'no quiz hint' });
        break;
      }
    }
  }

  for (const q of questions) {
    const opts = q.optionIndices
      .map((idx) => table.elements.find((el) => el.index === idx))
      .filter((el): el is ElementInfo => el !== undefined);
    const inputs = q.inputIndices
      .map((idx) => table.elements.find((el) => el.index === idx))
      .filter((el): el is ElementInfo => el !== undefined);
    q.answered = isAnswered(opts, inputs);
  }
  return { questions, navIndices, excluded, unassigned };
}

/** Structural path: runs of option controls, nearest preceding text stem. */
function groupStructurally(table: ElementTable): HeuristicResult {
  const questions: HeuristicQuestion[] = [];
  const navIndices: number[] = [];
  const excluded: Array<{ index: number; reason: string }> = [];
  const unassigned: number[] = [];
  let lastStem: ElementInfo | null = null;
  let stemConsumed = false;
  let cur: HeuristicQuestion | undefined;

  for (let i = 0; i < table.elements.length; i++) {
    const el = table.elements[i];
    const prev = i > 0 ? table.elements[i - 1] : undefined;

    if (isHeading(el)) {
      excluded.push({ index: el.index, reason: 'page heading, not a quiz candidate' });
      continue;
    }
    if (isButtonish(el)) {
      classifyButton(el, navIndices, excluded);
      continue;
    }
    if (el.role === 'text') {
      if (looksLikeStem(el)) {
        lastStem = el;
        stemConsumed = false;
        cur = undefined;
      }
      continue;
    }
    if (isOptionControl(el)) {
      // A contiguous option run continues the current group only when it is
      // the same kind of control AND — for radios — shares the DOM name.
      // A name change mid-run means the next question's options are adjacent
      // with no captured stem between them (F8: the stem is a plain text node
      // outside the interactive selector, so the table never saw it).
      const continuesGroup =
        cur !== undefined &&
        prev !== undefined &&
        isOptionControl(prev) &&
        prev.role === el.role &&
        !(
          el.role === 'radio' &&
          el.htmlName !== undefined &&
          prev.htmlName !== undefined &&
          el.htmlName !== prev.htmlName
        );
      if (continuesGroup) {
        cur!.optionIndices.push(el.index);
        continue;
      }
      if (lastStem !== null && !stemConsumed) {
        stemConsumed = true;
        cur = {
          stem: lastStem.name,
          stemIndex: lastStem.index,
          optionIndices: [el.index],
          inputIndices: [],
          answered: false,
          source: 'heuristic',
          confidence: HEURISTIC_CONFIDENCE,
        };
        questions.push(cur);
        continue;
      }
      unassigned.push(el.index);
      // The split-off run has no stem to claim it — close the open group so
      // the NEXT option of the same run lands in unassigned too instead of
      // being appended to the previous question.
      cur = undefined;
      continue;
    }
    if (isInputControl(el)) {
      if (cur !== undefined && lastStem !== null && cur.stemIndex === lastStem.index) {
        // Textbox after its stem's options (or directly after the stem).
        cur.inputIndices.push(el.index);
        stemConsumed = true;
        continue;
      }
      if (lastStem !== null && !stemConsumed) {
        stemConsumed = true;
        cur = {
          stem: lastStem.name,
          stemIndex: lastStem.index,
          optionIndices: [],
          inputIndices: [el.index],
          answered: false,
          source: 'heuristic',
          confidence: HEURISTIC_CONFIDENCE,
        };
        questions.push(cur);
        continue;
      }
      excluded.push({ index: el.index, reason: 'form control, not quiz' });
      continue;
    }
    // role 'text' without stem shape, video, etc. — not quiz candidates.
  }

  for (const q of questions) {
    const opts = q.optionIndices
      .map((idx) => table.elements.find((el2) => el2.index === idx))
      .filter((el2): el2 is ElementInfo => el2 !== undefined);
    const inputs = q.inputIndices
      .map((idx) => table.elements.find((el2) => el2.index === idx))
      .filter((el2): el2 is ElementInfo => el2 !== undefined);
    q.answered = isAnswered(opts, inputs);
  }
  return { questions, navIndices, excluded, unassigned };
}

export function heuristicGroup(table: ElementTable): HeuristicResult {
  const hasHints = table.elements.some((el) => el.quizSlot !== undefined);
  return hasHints ? groupByHints(table) : groupStructurally(table);
}
