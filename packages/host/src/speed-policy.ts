import { defaultDataDir, nodeIo, type LedgerIO } from './batch.js';
import type { LogFn } from './log.js';
import type { CreditVerdictKind } from './speed-probe.js';

/**
 * Measured playback-rate policy per origin (data/speed-policy.json).
 *
 * `--rate R` is a user choice, but it is only worth honouring when the probe
 * proved the backend credits faster playback. This store keeps the evidence
 * (not just the verdict) so the decision is auditable and re-measurable.
 */

export interface SpeedPolicyEntry {
  origin: string;
  verdict: CreditVerdictKind;
  /** credited-per-wall at R× ÷ credited-per-wall at 1×. */
  creditRatio: number | null;
  /** Measured credit speed at R×, as a multiple of wall clock. */
  creditedSpeed: number | null;
  /** The rate that was actually measured. */
  requestedRate: number;
  measuredAt: string;
  note: string;
  evidence: { requestBody: string; responseText: string } | null;
}

/** Re-probe after this long: platform behaviour changes without notice. */
export const POLICY_MAX_AGE_MS = 7 * 24 * 3_600_000;

export class SpeedPolicyStore {
  private readonly entries = new Map<string, SpeedPolicyEntry>();

  constructor(readonly file: string, private readonly io: LedgerIO = nodeIo) {}

  load(): void {
    if (!this.io.exists(this.file)) return;
    try {
      const parsed = JSON.parse(this.io.readFile(this.file)) as Record<string, SpeedPolicyEntry>;
      for (const [origin, entry] of Object.entries(parsed)) {
        if (entry && typeof entry === 'object' && typeof entry.verdict === 'string') {
          this.entries.set(origin, entry);
        }
      }
    } catch {
      // corrupt file — start empty rather than block a run
    }
  }

  get(origin: string): SpeedPolicyEntry | undefined {
    return this.entries.get(origin);
  }

  /** Entry younger than `maxAgeMs` (default 7 days); expired entries are re-probed. */
  getFresh(origin: string, maxAgeMs = POLICY_MAX_AGE_MS, now = Date.now()): SpeedPolicyEntry | undefined {
    const entry = this.entries.get(origin);
    if (!entry) return undefined;
    const measured = Date.parse(entry.measuredAt);
    if (!Number.isFinite(measured) || now - measured > maxAgeMs) return undefined;
    return entry;
  }

  record(entry: SpeedPolicyEntry): void {
    this.entries.set(entry.origin, entry);
    this.flush();
  }

  flush(): void {
    this.io.writeAtomic(this.file, JSON.stringify(Object.fromEntries(this.entries), null, 2));
  }

  all(): SpeedPolicyEntry[] {
    return [...this.entries.values()];
  }
}

export function defaultSpeedPolicyFile(): string {
  return `${defaultDataDir()}/speed-policy.json`;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** Playback rates the host will apply: 0.25x..4x, default 1x. */
export const MIN_RATE = 0.25;
export const MAX_RATE = 4;

export function clampRate(value: unknown, fallback = 1): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, n));
}

export interface RateDecision {
  /** Effective playback rate for this run (1 = leave playback alone). */
  rate: number;
  verdict: CreditVerdictKind | 'not-requested' | 'no-evidence';
  /** False when the user asked for a rate the measurement says is worthless. */
  allowed: boolean;
  note: string;
}

/**
 * Gate a requested rate on measured evidence.
 *
 *   credited  -> honour it (credit scales with the rate)
 *   partial   -> honour it, but say what the real credit rate is
 *   wallclock -> refuse by default: same credit, more flag risk
 *   stalled   -> refuse by default: the backend rejects acceleration
 *   unknown   -> refuse by default and point at the probe
 *
 * `force` is the operator's override — the tool states the measurement, the
 * operator decides.
 */
export function decideRate(opts: {
  requested: number;
  entry?: SpeedPolicyEntry | undefined;
  force?: boolean;
  log: LogFn;
}): RateDecision {
  const { requested, entry, force, log } = opts;
  if (!Number.isFinite(requested) || requested <= 1.001) {
    return { rate: 1, verdict: 'not-requested', allowed: true, note: '1x (default)' };
  }
  if (!entry) {
    if (force) {
      log('warn', `rate: no measurement for this origin — forcing ${requested}x without evidence (credit is likely still wall-clock capped)`);
      return { rate: requested, verdict: 'no-evidence', allowed: true, note: `${requested}x forced without evidence` };
    }
    return {
      rate: 1,
      verdict: 'no-evidence',
      allowed: false,
      note: `no measured playback-rate policy for this origin — running 1x; measure first (\`speed-probe\`, ~2 minutes) or override with --rate-force`,
    };
  }
  const headline = `measured ${entry.measuredAt.slice(0, 16)}: ${entry.note}`;
  if (entry.verdict === 'credited') {
    log('info', `rate: ${requested}x enabled — ${headline}`);
    return { rate: requested, verdict: entry.verdict, allowed: true, note: `credited ≈ ${fmtX(entry.creditedSpeed)} wall clock; ${headline}` };
  }
  if (entry.verdict === 'partial') {
    log('warn', `rate: ${requested}x enabled with partial credit — ${headline}`);
    return { rate: requested, verdict: entry.verdict, allowed: true, note: `partial credit ≈ ${fmtX(entry.creditedSpeed)} wall clock; ${headline}` };
  }
  if (force) {
    log('warn', `rate: forcing ${requested}x although the measurement says "${entry.verdict}" — ${headline}`);
    return { rate: requested, verdict: entry.verdict, allowed: true, note: `${requested}x forced despite "${entry.verdict}"; ${headline}` };
  }
  log('warn', `rate: ${requested}x refused by measurement (${entry.verdict}) — running 1x; ${headline}. Override with --rate-force if you disagree.`);
  return { rate: 1, verdict: entry.verdict, allowed: false, note: `1x — measurement says "${entry.verdict}"; ${headline}` };
}

function fmtX(v: number | null): string {
  return v === null ? 'unknown×' : `${v.toFixed(2)}×`;
}

/** One-line report for the run summary. */
export function rateSummaryLine(decision: RateDecision): string {
  return `playback rate: ${decision.rate}x (${decision.verdict}) — ${decision.note}`;
}
