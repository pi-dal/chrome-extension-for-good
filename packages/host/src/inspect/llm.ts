/**
 * L3 LLM enumerator (docs/m2-auto-inspect.md §4.2).
 *
 * Open-world discovery: given the numbered element table, the LLM enumerates
 * every quiz question (stem/option/input element indices), quiz nav buttons,
 * and explicitly excluded elements. The model never touches the DOM — it only
 * references indices, which this module grounds against the table: invented
 * indices are dropped with notes and reported back to the model in a
 * difference-feedback round (max MAX_ENUMERATION_ATTEMPTS attempts total).
 */
import type { ElementTable } from '@c4g/protocol';
import { renderTable } from '../jev.js';
import type { LogFn } from '../log.js';
import { extractJson } from '../solver.js';

export type CompleteFn = (system: string, user: string) => Promise<string | undefined>;

export interface LlmQuestion {
  stemIndex: number;
  optionIndices: number[];
  inputIndices: number[];
}

export interface LlmEnumeration {
  questions: LlmQuestion[];
  navIndices: number[];
  excludedIndices: number[];
}

export interface EnumerationAttempt {
  enumeration: LlmEnumeration;
  /** True when no correction was needed (no hallucinations, no drops). */
  clean: boolean;
  /** Human-readable validation notes (surfaced as diagnostics by the caller). */
  notes: string[];
  /** Referenced-but-nonexistent indices — the hallucinations. */
  invalidIndices: number[];
}

export const MAX_ENUMERATION_ATTEMPTS = 2;
const PAGE_TEXT_BUDGET = 4_000;

const SYSTEM_PROMPT =
  'You inspect an online quiz page. You are given a numbered element table: every line is ' +
  '[N] role "name" for one element. Enumerate the quiz structure:\n' +
  '- questions: for EVERY question, the stem element index (the text line), the option element ' +
  'indices (radio/checkbox), and free-text answer input indices (textbox). A question may have ' +
  'options only, inputs only, or both.\n' +
  '- navIndices: button indices for quiz flow controls (检查/保存/下一题/下一页/提交/交卷/next/submit/check/save).\n' +
  '- excludedIndices: element indices that are NOT part of the quiz (headings, login, bookmarks, ' +
  'search boxes, layout buttons).\n' +
  'Account for every radio/checkbox/textbox/button index in exactly one place. ' +
  'Use only indices that appear in the table — never invent numbers. ' +
  'Reply ONLY compact JSON {"questions":[{"stemIndex":N,"optionIndices":[..],"inputIndices":[..]}],' +
  '"navIndices":[..],"excludedIndices":[..]}. No markdown.';

/**
 * Ground the raw questions list against the table: drop hallucinated indices,
 * role-mismatched claims and duplicates; drop questions that lost their stem
 * or all of their options/inputs. Every drop is explained in notes.
 */
function sanitizeQuestions(rawQuestions: unknown[], table: ElementTable): {
  questions: LlmQuestion[];
  invalidIndices: number[];
  notes: string[];
} {
  const questions: LlmQuestion[] = [];
  const invalidIndices: number[] = [];
  const notes: string[] = [];
  const claimed = new Set<number>();
  const roleOf = new Map<number, string>();
  for (const el of table.elements) roleOf.set(el.index, el.role);

  const claim = (idx: unknown, accept: (role: string) => boolean, label: string): number | null => {
    if (typeof idx !== 'number' || !Number.isInteger(idx)) return null;
    const role = roleOf.get(idx);
    if (role === undefined) {
      invalidIndices.push(idx);
      notes.push(`dropped hallucinated ${label} index ${idx} (not in table)`);
      return null;
    }
    if (!accept(role)) {
      notes.push(`dropped ${label} index ${idx} (role ${role} unsuitable for ${label})`);
      return null;
    }
    if (claimed.has(idx)) {
      notes.push(`dropped duplicate claim on index ${idx}`);
      return null;
    }
    claimed.add(idx);
    return idx;
  };

  for (const raw of rawQuestions) {
    if (typeof raw !== 'object' || raw === null) {
      notes.push('dropped non-object question entry');
      continue;
    }
    const q = raw as Record<string, unknown>;
    const stemIndex = claim(q.stemIndex, (role) => role === 'text' || role === 'heading', 'stem');
    const optionIndices: number[] = [];
    for (const idx of Array.isArray(q.optionIndices) ? q.optionIndices : []) {
      const ok = claim(idx, (role) => role === 'radio' || role === 'checkbox', 'option');
      if (ok !== null) optionIndices.push(ok);
    }
    const inputIndices: number[] = [];
    for (const idx of Array.isArray(q.inputIndices) ? q.inputIndices : []) {
      const ok = claim(idx, (role) => role === 'textbox', 'input');
      if (ok !== null) inputIndices.push(ok);
    }
    if (stemIndex === null) {
      if (optionIndices.length > 0 || inputIndices.length > 0) {
        notes.push(`dropped question without usable stem (options ${optionIndices}, inputs ${inputIndices})`);
      }
      continue;
    }
    if (optionIndices.length === 0 && inputIndices.length === 0) {
      notes.push(`dropped question at stem ${stemIndex}: no options or inputs survived validation`);
      continue;
    }
    questions.push({ stemIndex, optionIndices, inputIndices });
  }
  return { questions, invalidIndices, notes };
}

function sanitizeIndexList(raw: unknown, validIndices: Set<number>, label: string): {
  indices: number[];
  invalidIndices: number[];
  notes: string[];
} {
  const indices: number[] = [];
  const invalidIndices: number[] = [];
  const notes: string[] = [];
  for (const idx of Array.isArray(raw) ? raw : []) {
    if (typeof idx !== 'number' || !Number.isInteger(idx)) continue;
    if (!validIndices.has(idx)) {
      invalidIndices.push(idx);
      notes.push(`dropped hallucinated ${label} index ${idx} (not in table)`);
      continue;
    }
    indices.push(idx);
  }
  return { indices, invalidIndices, notes };
}

/** Validate + ground a raw parsed LLM answer against the table. Never throws. */
export function validateEnumeration(parsed: unknown, table: ElementTable): EnumerationAttempt {
  const empty: LlmEnumeration = { questions: [], navIndices: [], excludedIndices: [] };
  if (typeof parsed !== 'object' || parsed === null) {
    return { enumeration: empty, clean: false, notes: ['reply was not a JSON object'], invalidIndices: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const validIndices = new Set(table.elements.map((el) => el.index));

  const q = sanitizeQuestions(Array.isArray(obj.questions) ? obj.questions : [], table);
  const nav = sanitizeIndexList(obj.navIndices, validIndices, 'nav');
  const excluded = sanitizeIndexList(obj.excludedIndices, validIndices, 'excluded');

  const notes = [...q.notes, ...nav.notes, ...excluded.notes];
  const invalidIndices = [...q.invalidIndices, ...nav.invalidIndices, ...excluded.invalidIndices];
  return {
    enumeration: { questions: q.questions, navIndices: nav.indices, excludedIndices: excluded.indices },
    clean: invalidIndices.length === 0 && notes.length === 0,
    notes,
    invalidIndices,
  };
}

export function buildUserPrompt(table: ElementTable, pageText: string | undefined, missing: number[]): string {
  const parts: string[] = [renderTable(table)];
  if (pageText) {
    parts.push(`\npage text (fallback, may be truncated):\n${pageText.slice(0, PAGE_TEXT_BUDGET)}`);
  }
  if (missing.length > 0) {
    parts.push(
      `\nIMPORTANT: your previous enumeration was incomplete. These candidate element indices were ` +
        `not accounted for: [${missing.join(', ')}]. Assign each one to a question, navIndices, or ` +
        `excludedIndices.`,
    );
  }
  return parts.join('\n');
}

/** LLM-backed enumerator; inert (enumerate → null) unless `enabled`. */
export class LlmEnumerator {
  private complete: CompleteFn;
  private enabledFlag: boolean;

  constructor(
    complete: CompleteFn,
    private readonly log: LogFn,
    enabledFlag: boolean,
  ) {
    this.complete = complete;
    this.enabledFlag = enabledFlag;
  }

  /** Runtime reconfiguration (extension config_sync). */
  setEndpoint(baseUrl: string, apiKey: string, model: string): void {
    this.complete = httpComplete(baseUrl, apiKey, model, this.log);
    this.enabledFlag = apiKey !== '';
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  /**
   * Enumerate the quiz structure. Returns null when disabled or when no
   * parseable reply arrives. Validation/grounding never throws: bad replies
   * surface as notes + invalidIndices on the returned attempt.
   */
  async enumerate(table: ElementTable, pageText?: string, missing: number[] = []): Promise<EnumerationAttempt | null> {
    if (!this.enabled) return null;
    const user = buildUserPrompt(table, pageText, missing);
    let raw: string | undefined;
    try {
      raw = await this.complete(SYSTEM_PROMPT, user);
    } catch (err) {
      this.log('warn', `llm enumerator request failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (raw === undefined) {
      this.log('warn', 'llm enumerator returned no content');
      return null;
    }
    const parsed = extractJson(raw);
    if (parsed === undefined) {
      this.log('warn', 'llm enumerator reply was not parseable JSON', raw.slice(0, 120));
      return null;
    }
    const attempt = validateEnumeration(parsed, table);
    for (const note of attempt.notes) this.log('debug', `llm enumerator: ${note}`);
    return attempt;
  }
}

/** OpenAI-compatible chat-completions transport (mirrors solver's HTTP path). */
export function httpComplete(baseUrl: string, apiKey: string, model: string, log?: LogFn): CompleteFn {
  return async (system, user) => {
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'content-type': 'application/json',
        ...(apiKey !== '' ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      log?.('warn', `llm enumerator HTTP ${res.status}`, (await res.text()).slice(0, 200));
      return undefined;
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content;
  };
}

/** Factory mirroring the solver's env contract (SOLVER_*); read-only. */
export function createLlmEnumeratorFromEnv(
  log: LogFn,
  env: Record<string, string | undefined> = process.env,
): LlmEnumerator {
  const apiKey = (env.SOLVER_API_KEY ?? '').trim();
  const baseUrl = (env.SOLVER_BASE_URL ?? '').trim() || 'https://open.bigmodel.cn/api/paas/v4';
  const model = (env.SOLVER_MODEL ?? '').trim() || 'glm-4.5-flash';
  return new LlmEnumerator(httpComplete(baseUrl, apiKey, model, log), log, apiKey !== '');
}
