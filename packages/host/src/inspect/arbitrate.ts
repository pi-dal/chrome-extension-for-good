/**
 * Jev arbitration for L2/L3 grouping disputes (docs/m2-auto-inspect.md §2.2).
 *
 * When the structural heuristic and the LLM enumerator disagree about a group
 * of elements, the dispute is put to Jev as a single three-way choice
 * (heuristic / llm / neither). Verdicts below the confidence floor resolve to
 * `unclassified` (fail-safe): the elements then become explicitly excluded,
 * never silently answered.
 */
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import type { ElementTable } from '@c4g/protocol';
import type { LogFn } from '../log.js';

export type GroupOrigin = 'heuristic' | 'llm';

export interface DisputeGroup {
  /** Human-readable summary of the disputed region (stem + labels). */
  summary: string;
  heuristicIndices: number[];
  llmIndices: number[];
}

export interface ArbitrationVerdict {
  winner: GroupOrigin | 'unclassified';
  confidence: number;
}

export interface Arbitrator {
  dryRun: boolean;
  arbitrate(dispute: DisputeGroup, table: ElementTable): Promise<ArbitrationVerdict>;
}

/** Below this confidence the dispute is unresolved (design §2.2). */
export const ARBITRATION_CONFIDENCE_FLOOR = 0.7;

/** Pure verdict application: winner validation + confidence floor. */
export function applyArbitrationVerdict(rawWinner: unknown, confidence: number): ArbitrationVerdict {
  const winner = rawWinner === 'heuristic' || rawWinner === 'llm' ? rawWinner : 'unclassified';
  if (winner !== 'unclassified' && !(confidence >= ARBITRATION_CONFIDENCE_FLOOR)) {
    return { winner: 'unclassified', confidence };
  }
  return { winner, confidence };
}

/** Dry-run arbiter: every dispute resolves to unclassified (fail-safe). */
export class HeuristicOnlyArbiter implements Arbitrator {
  readonly dryRun = true;
  async arbitrate(): Promise<ArbitrationVerdict> {
    return { winner: 'unclassified', confidence: 0 };
  }
}

/** Jev-backed arbiter; one System One round trip per dispute. */
export class JevArbitrator implements Arbitrator {
  private client: TypeSafeClient | null = null;
  dryRun: boolean;

  constructor(
    private apiKey: string | undefined,
    private readonly log: LogFn,
    private readonly opts: { baseUrl?: string; model?: string } = {},
  ) {
    this.dryRun = !apiKey;
  }

  /** Runtime reconfiguration (extension config_sync); rebuilds the client lazily. */
  configure(next: { apiKey?: string; baseUrl?: string; model?: string }): void {
    if (next.apiKey !== undefined) {
      this.apiKey = next.apiKey === '' ? undefined : next.apiKey;
      this.dryRun = !this.apiKey;
    }
    if (next.baseUrl !== undefined) this.opts.baseUrl = next.baseUrl;
    if (next.model !== undefined) this.opts.model = next.model;
    this.client = null;
  }

  async arbitrate(dispute: DisputeGroup, table: ElementTable): Promise<ArbitrationVerdict> {
    if (this.dryRun || table.elements.length === 0) {
      return { winner: 'unclassified', confidence: 0 };
    }
    if (!this.client) {
      this.client = new TypeSafeClient({
        apiKey: this.apiKey,
        ...(this.opts.baseUrl ? { baseURL: this.opts.baseUrl } : {}),
        ...(this.opts.model ? { defaultModel: this.opts.model } : {}),
      });
    }
    try {
      const byIndex = new Map(table.elements.map((el) => [el.index, el]));
      const describe = (indices: number[]): string =>
        indices
          .map((i) => {
            const el = byIndex.get(i);
            return el ? `[${i}] ${el.role} "${el.name.slice(0, 40)}"` : `[${i}]`;
          })
          .join('\n');
      const response = await this.client.systemOne({
        state: {
          dispute: dispute.summary,
          heuristicGrouping: describe(dispute.heuristicIndices),
          llmGrouping: describe(dispute.llmIndices),
        },
        questions: {
          winner: choice('Which grouping of these elements is correct for the quiz structure?', {
            heuristic: null,
            llm: null,
            neither: null,
          }),
        },
      });
      const verdict = applyArbitrationVerdict(
        response.answers.winner.choice,
        response.answers.winner.confidence,
      );
      this.log('debug', `arbitration: ${dispute.summary.slice(0, 50)} → ${verdict.winner} (${verdict.confidence.toFixed(2)})`);
      return verdict;
    } catch (err) {
      this.log('warn', `arbitration failed: ${err instanceof Error ? err.message : String(err)}`);
      return { winner: 'unclassified', confidence: 0 };
    }
  }
}

export function createJevArbitratorFromEnv(log: LogFn, env: Record<string, string | undefined> = process.env): JevArbitrator {
  const apiKey = (env.TYPESAFE_API_KEY ?? '').trim();
  return new JevArbitrator(apiKey === '' ? undefined : apiKey, log, {
    baseUrl: (env.TYPESAFE_BASE_URL ?? '').trim() || undefined,
    model: (env.TYPESAFE_MODEL ?? '').trim() || undefined,
  });
}
