import type { LogFn } from './log.js';

export interface SolverOption {
  index: number;
  text: string;
}

export interface ChoiceAnswer {
  indices: number[];
}

export interface TextAnswer {
  text: string;
}

const SYSTEM_PROMPT =
  'You answer quiz questions. Reply ONLY compact JSON {indices:[number,...]} where each number ' +
  'is the exact option number N as shown in the provided list (single choice: one index; ' +
  'multi-choice: every correct index). Never invent numbers not present in the list. No markdown.';

const SYSTEM_PROMPT_SHORT =
  'You answer quiz short-answer questions. Reply ONLY compact JSON {text:"..."} with a concise ' +
  'answer in the same language as the question. No markdown.';

/**
 * Tolerant JSON extractor: strips code fences, then scans for the first
 * balanced {...} block. Returns undefined when nothing parseable exists.
 */
export function extractJson(raw: string): Record<string, unknown> | undefined {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const direct = tryParse(text);
  if (direct !== undefined) return direct;
  // Scan for balanced {...} blocks; a block that fails to parse (a stray
  // `{x}` in prose) does NOT end the search — the real JSON may come later.
  let start = text.indexOf('{');
  while (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const parsed = tryParse(text.slice(start, i + 1));
          if (parsed !== undefined) return parsed;
          closed = true;
          break;
        }
      }
    }
    if (!closed) break; // unbalanced tail — nothing parseable remains
    start = text.indexOf('{', start + 1);
  }
  return undefined;
}

function tryParse(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** OpenAI-compatible quiz solver (default: GLM free tier). dry-run when no key. */
export class QuizSolver {
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;

  constructor(
    baseUrl: string,
    apiKey: string | undefined,
    model: string,
    private readonly log: LogFn,
  ) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey === '' ? undefined : apiKey;
    this.model = model;
  }

  /** Runtime reconfiguration (extension config_sync); stateless fetch picks it up on the next call. */
  configure(next: { baseUrl: string; apiKey: string; model: string }): void {
    this.baseUrl = next.baseUrl;
    this.apiKey = next.apiKey === '' ? undefined : next.apiKey;
    this.model = next.model;
  }

  get enabled(): boolean {
    return this.apiKey !== undefined;
  }

  /** Multiple-choice / multi-select. Returns null in dry-run mode. */
  async solve(question: string, options: SolverOption[], multi = false): Promise<ChoiceAnswer | null> {
    if (!this.enabled) {
      this.log('info', `[dry-run] solver skipped: "${question.slice(0, 60)}..."`);
      return null;
    }
    const optionLines = options.map((o) => `${o.index}. ${o.text}`).join('\n');
    const user = `${question}\n${optionLines}${multi ? '\n(多选: return every correct index.)' : ''}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.complete(
        attempt === 0 ? user : user + '\n\nIMPORTANT: reply with valid compact JSON only.',
      );
      const parsed = raw !== undefined ? extractJson(raw) : undefined;
      if (parsed && Array.isArray(parsed['indices'])) {
        const known = new Set(options.map((o) => o.index));
        let indices = (parsed['indices'] as unknown[])
          .filter((n): n is number => typeof n === 'number' && known.has(n));
        // Single-choice contract is exactly one index: a model returning
        // several would have the loop click each radio in turn — the LAST
        // click wins, so the answer becomes whichever index happened to be
        // last, and read-back can never confirm the rest. Keep the first.
        if (!multi && indices.length > 1) {
          this.log('warn', `solver returned ${indices.length} indices for a single-choice question — keeping the first`);
          indices = indices.slice(0, 1);
        }
        if (indices.length > 0) return { indices };
      }
      this.log('warn', `solver reply not parseable (attempt ${attempt + 1})`, raw?.slice(0, 120));
    }
    return null;
  }

  /** Short-answer / fill-in-the-blank. Returns null in dry-run mode. */
  async solveShortAnswer(question: string): Promise<TextAnswer | null> {
    if (!this.enabled) {
      this.log('info', `[dry-run] solver skipped (short answer): "${question.slice(0, 60)}..."`);
      return null;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.complete(
        question,
        attempt === 0 ? SYSTEM_PROMPT_SHORT : SYSTEM_PROMPT_SHORT + ' Valid JSON only.',
      );
      const parsed = raw !== undefined ? extractJson(raw) : undefined;
      if (parsed && typeof parsed['text'] === 'string' && parsed['text'] !== '') {
        return { text: parsed['text'] };
      }
    }
    return null;
  }

  private async complete(user: string, system = SYSTEM_PROMPT): Promise<string | undefined> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) {
        this.log('warn', `solver HTTP ${res.status}`, (await res.text()).slice(0, 200));
        return undefined;
      }
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return body.choices?.[0]?.message?.content;
    } catch (err) {
      this.log('error', `solver request failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }
}
