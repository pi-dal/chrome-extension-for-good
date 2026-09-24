import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import type { ElementTable } from '@c4g/protocol';
import type { LogFn } from './log.js';

export const OPERATIONS = ['CLICK', 'TYPE', 'SELECT', 'SCROLL_DOWN', 'SCROLL_UP', 'WAIT', 'DONE', 'BLOCKED'] as const;
export type JevOperation = (typeof OPERATIONS)[number];

export interface JevDecision {
  operation: JevOperation;
  targetIndex?: number;
  waitMs?: number;
  confidence: number;
  /** true when no TypeSafe key is configured and a heuristic picked the element. */
  dryRun: boolean;
}

/** Render a table like jev-ultrafast's element table: `[3] button "提交答案" · value(80)`. */
export function renderTable(table: ElementTable): string {
  const lines = table.elements.map((el) => {
    const value = el.value ? ` · ${el.value.slice(0, 80)}` : '';
    const flags = [el.disabled ? 'disabled' : '', el.checked ? 'checked' : ''].filter(Boolean).join(',');
    return `[${el.index}] ${el.role} "${el.name}"${value}${flags ? ` (${flags})` : ''}`;
  });
  return `url: ${table.url}\ntitle: ${table.title}\n${lines.join('\n')}`;
}

/** Heuristic scorer used when no TypeSafe key is configured (dry-run mode). */
export function heuristicPick(goal: string, table: ElementTable): JevDecision {
  const KEYWORDS = [
    /提交答案/, /提交/, /下一题/, /下一节/, /继续/, /播放/, /resume/i, /submit/i, /next/i,
    /check/i, /save/i, /开始/, /确认/,
  ];
  const goalWords = goal.toLowerCase();
  let best: { index: number; score: number } | null = null;
  for (const el of table.elements) {
    if (el.disabled) continue;
    if (el.rect.w <= 0 || el.rect.h <= 0) continue;
    let score = 0;
    for (const re of KEYWORDS) {
      if (!re.test(el.name) && !re.test(el.value ?? '')) continue;
      // Keywords that appear in the goal itself are what we are looking for (+3);
      // other action keywords still make an element clickable but weaker (+1).
      const inGoal = re.test(goal);
      score += inGoal ? 3 : 1;
    }
    if (el.role === 'button' || el.tag === 'button') score += 1;
    if (el.quizSlot === 'nav') score += 1;
    // Elements whose name also appears in the goal are more likely relevant.
    for (const word of goalWords.split(/\s+/)) {
      if (word.length > 3 && el.name.toLowerCase().includes(word)) score += 1;
    }
    if (score > 0 && (best === null || score > best.score)) {
      best = { index: el.index, score };
    }
  }
  if (best !== null) {
    return { operation: 'CLICK', targetIndex: best.index, confidence: 0.3, dryRun: true };
  }
  return { operation: 'BLOCKED', confidence: 0, dryRun: true };
}

/**
 * Element/action decision driver: TypeSafe System One (Jev) when a key is
 * configured, keyword heuristic otherwise. One network round trip per decision;
 * operation and target heads share the same observed state (speculative fan-out).
 */
export class JeDriver {
  private client: TypeSafeClient | null = null;

  constructor(
    private apiKey: string | undefined,
    private readonly log: LogFn,
    private readonly opts: { baseUrl?: string; model?: string } = {},
  ) {}

  /** Runtime reconfiguration (extension config_sync); rebuilds the client lazily. */
  configure(next: { apiKey?: string; baseUrl?: string; model?: string }): void {
    if (next.apiKey !== undefined) this.apiKey = next.apiKey === '' ? undefined : next.apiKey;
    if (next.baseUrl !== undefined) this.opts.baseUrl = next.baseUrl;
    if (next.model !== undefined) this.opts.model = next.model;
    this.client = null;
  }

  get dryRun(): boolean {
    return !this.apiKey;
  }

  async decide(goal: string, table: ElementTable): Promise<JevDecision> {
    if (!this.apiKey) {
      const decision = heuristicPick(goal, table);
      this.log('info', `[dry-run] jev heuristic: ${describeDecision(decision)} (goal: ${goal})`);
      return decision;
    }
    if (table.elements.length === 0) {
      return { operation: 'BLOCKED', confidence: 0, dryRun: false };
    }
    if (!this.client) {
      this.client = new TypeSafeClient({
        apiKey: this.apiKey,
        ...(this.opts.baseUrl ? { baseURL: this.opts.baseUrl } : {}),
        ...(this.opts.model ? { defaultModel: this.opts.model } : {}),
      });
    }
    const rendered = renderTable(table);
    const targetCriteria = Object.fromEntries(table.elements.map((el) => [String(el.index), null]));
    // Bounded wait: a hung LLM call would otherwise stall the supervision tick
    // forever (and, behind the tick-in-flight guard, the whole timekeeper).
    const response = await this.client.systemOne(
      {
        state: { goal, table: rendered },
        questions: {
          operation: choice('Which single operation best advances the goal?', {
            CLICK: null,
            TYPE: null,
            SELECT: null,
            SCROLL_DOWN: null,
            SCROLL_UP: null,
            WAIT: null,
            DONE: null,
            BLOCKED: null,
          }),
          // Speculative: only executes when operation === CLICK/TYPE/SELECT.
          target: choice(
            'Which element index should this operation act on? Answer with the [N] index.',
            targetCriteria as Record<string, null>,
          ),
        },
      },
      { timeout: 45_000 },
    );
    const operation = response.answers.operation.choice as JevOperation;
    const targetLabel = response.answers.target.choice as string;
    const targetIndex = /^\d+$/.test(targetLabel) ? Number(targetLabel) : undefined;
    const confidence = Math.min(response.answers.operation.confidence, response.answers.target.confidence);
    const decision: JevDecision = {
      operation,
      ...(operation === 'CLICK' || operation === 'TYPE' || operation === 'SELECT' ? { targetIndex } : {}),
      ...(operation === 'WAIT' ? { waitMs: 2000 } : {}),
      confidence,
      dryRun: false,
    };
    this.log('info', `jev: ${describeDecision(decision)} (goal: ${goal})`);
    return decision;
  }
}

export function describeDecision(d: JevDecision): string {
  const target = d.targetIndex !== undefined ? ` #${d.targetIndex}` : '';
  const conf = `conf=${d.confidence.toFixed(2)}${d.dryRun ? ' dry' : ''}`;
  return `${d.operation}${target} ${conf}`;
}
