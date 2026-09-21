import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogFn } from './log.js';
import type { WatchOutcome } from './timekeeper.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Injectable filesystem + clock seam (tests point this at a temp dir). */
export interface LedgerIO {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeAtomic(path: string, data: string): void;
  now(): string;
}

export const nodeIo: LedgerIO = {
  exists: (path) => existsSync(path),
  readFile: (path) => readFileSync(path, 'utf8'),
  writeAtomic: (path, data) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  },
  now: () => new Date().toISOString(),
};

export interface LedgerEntry {
  completedAt: string;
  creditedSeconds: number | null;
}

/** Record of videos the server has fully credited (data/completions.json). */
export class CompletionLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(readonly file: string, private readonly io: LedgerIO = nodeIo) {}

  /** Tolerates a missing or corrupt file by starting empty (mirrors timekeeper queue load). */
  load(): void {
    if (!this.io.exists(this.file)) return;
    try {
      const parsed = JSON.parse(this.io.readFile(this.file)) as Record<string, LedgerEntry>;
      for (const [id, entry] of Object.entries(parsed)) {
        if (entry && typeof entry === 'object') this.entries.set(id, entry);
      }
    } catch {
      // corrupt ledger — start fresh rather than crash an overnight run
    }
  }

  has(id: string | number): boolean {
    return this.entries.has(String(id));
  }

  get(id: string | number): LedgerEntry | undefined {
    return this.entries.get(String(id));
  }

  record(id: string | number, creditedSeconds: number | null): void {
    this.entries.set(String(id), { completedAt: this.io.now(), creditedSeconds });
    this.flush();
  }

  /** Re-persist current state (SIGINT hook; record() already flushes). */
  flush(): void {
    this.io.writeAtomic(this.file, JSON.stringify(Object.fromEntries(this.entries), null, 2));
  }

  all(): Array<[string, LedgerEntry]> {
    return [...this.entries.entries()];
  }
}

export interface FailedEntry {
  attempts: number;
  lastReason: string;
  lastAt: string;
}

/** Retry counter per video (data/failed.json); exhausted ids are skipped by planners. */
export class FailedLedger {
  private readonly entries = new Map<string, FailedEntry>();

  constructor(readonly file: string, readonly maxAttempts = 3, private readonly io: LedgerIO = nodeIo) {}

  load(): void {
    if (!this.io.exists(this.file)) return;
    try {
      const parsed = JSON.parse(this.io.readFile(this.file)) as Record<string, FailedEntry>;
      for (const [id, entry] of Object.entries(parsed)) {
        if (entry && typeof entry === 'object') this.entries.set(id, entry);
      }
    } catch {
      // corrupt ledger — start fresh rather than crash an overnight run
    }
  }

  attempts(id: string | number): number {
    return this.entries.get(String(id))?.attempts ?? 0;
  }

  exhausted(id: string | number): boolean {
    return this.attempts(id) >= this.maxAttempts;
  }

  recordFailed(id: string | number, reason: string): void {
    const key = String(id);
    const entry = this.entries.get(key) ?? { attempts: 0, lastReason: reason, lastAt: this.io.now() };
    entry.attempts += 1;
    entry.lastReason = reason;
    entry.lastAt = this.io.now();
    this.entries.set(key, entry);
    this.flush();
  }

  flush(): void {
    this.io.writeAtomic(this.file, JSON.stringify(Object.fromEntries(this.entries), null, 2));
  }

  all(): Array<[string, FailedEntry]> {
    return [...this.entries.entries()];
  }
}

export interface ScrapeItem {
  url: string;
  resourceId?: string | number | null;
}

export type ScrapeFn = (courseUrl: string) => Promise<ScrapeItem[]>;

/** Named seam: course rescrape. The injected scrape fn keeps tests network-free. */
export async function rescanCourse(courseUrl: string, scrape: ScrapeFn): Promise<ScrapeItem[]> {
  return scrape(courseUrl);
}

/**
 * One overnight pass plan: rescrape the course page, drop videos the server
 * already credited and videos that exhausted their retry budget. Items with
 * an unknown resourceId are never ledger-filtered (cannot be tracked).
 */
export async function planNextPass(opts: {
  courseUrl: string;
  scrape: ScrapeFn;
  ledger: CompletionLedger;
  failed: FailedLedger;
}): Promise<ScrapeItem[]> {
  const items = await rescanCourse(opts.courseUrl, opts.scrape);
  const seen = new Set<string>();
  const remaining: ScrapeItem[] = [];
  for (const item of items) {
    const known = item.resourceId !== undefined && item.resourceId !== null;
    const key = known ? `id:${String(item.resourceId)}` : `url:${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (known) {
      if (opts.ledger.has(item.resourceId as string | number)) continue;
      if (opts.failed.exhausted(item.resourceId as string | number)) continue;
    }
    remaining.push(item);
  }
  return remaining;
}

export interface PersistedQueueFile {
  queue: number[];
  done: number[];
}

/**
 * Union planned ids into the timekeeper's queue.json without dropping its
 * done-set, so the supervisor's own persistence stays authoritative.
 */
export function mergeIntoQueueFile(queueFile: string, ids: number[], io: LedgerIO = nodeIo): void {
  let current: PersistedQueueFile = { queue: [], done: [] };
  if (io.exists(queueFile)) {
    try {
      const parsed = JSON.parse(io.readFile(queueFile)) as Partial<PersistedQueueFile>;
      if (Array.isArray(parsed.queue)) current.queue = parsed.queue.filter(Number.isFinite);
      if (Array.isArray(parsed.done)) current.done = parsed.done.filter(Number.isFinite);
    } catch {
      // corrupt queue file — start fresh from the planned ids
    }
  }
  const done = new Set(current.done);
  const merged = Array.from(new Set([...current.queue, ...ids])).filter((id) => !done.has(id));
  io.writeAtomic(queueFile, JSON.stringify({ queue: merged, done: [...done] }, null, 2));
}

/** Matches the timekeeper's data/ directory convention (src/../data). */
export function defaultDataDir(): string {
  return resolve(HERE, '..', 'data');
}

/** One-line end-of-run report for the chain --loop summary. */
export function batchSummaryLine(ledger: CompletionLedger, failed: FailedLedger): string {
  const credited = ledger.all().length;
  const awaitingRetry = failed.all().filter(([id]) => !ledger.has(id)).length;
  return `batch summary: ${credited} video(s) credited, ${awaitingRetry} awaiting retry (completions: ${ledger.file}, failures: ${failed.file})`;
}

// ---------------------------------------------------------------------------
// Overnight batch orchestration (chain --loop)
// ---------------------------------------------------------------------------

export interface BatchLoopDeps {
  maxPasses: number;
  /** One pass plan: rescrape + ledger diff. */
  plan: () => Promise<ScrapeItem[]>;
  /** Supervise one video to terminal state. MUST be bound to a single
   *  Timekeeper instance for the whole run: the timekeeper's interval
   *  auto-chains through the persisted queue, so per-item instances would
   *  race the same tab (duplicate resume clicks, racy navigations,
   *  misattributed failures). */
  watch: (id: number) => Promise<WatchOutcome>;
  ledger: CompletionLedger;
  failed: FailedLedger;
  log: LogFn;
}

/**
 * Passes of plan → watch → ledger, strictly one watch at a time. The
 * Timekeeper (owned by the caller) does the actual chaining between videos.
 */
export async function runBatchLoop(deps: BatchLoopDeps): Promise<void> {
  for (let pass = 1; pass <= deps.maxPasses; pass++) {
    let planned: ScrapeItem[];
    try {
      planned = await deps.plan();
    } catch (err) {
      // F2 (review): one transient CDP/navigation failure must not kill the
      // whole overnight run — log it and let the next pass retry.
      deps.log('error', `batch: pass ${pass}/${deps.maxPasses} plan failed — will retry next pass: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (planned.length === 0) {
      deps.log('info', `batch: pass ${pass}/${deps.maxPasses} — nothing left to watch, course complete`);
      deps.log('info', batchSummaryLine(deps.ledger, deps.failed));
      return;
    }
    deps.log('info', `batch: pass ${pass}/${deps.maxPasses} — ${planned.length} video(s) to watch`);
    for (const item of planned) {
      if (typeof item.resourceId !== 'number') {
        deps.log('warn', `batch: skipping item without numeric resourceId: ${item.url.slice(0, 100)}`);
        continue;
      }
      // CONTRACT: watch() supervises one video to terminal state and resolves
      // its WatchOutcome (never rejects; failed=true after maxRecovery).
      const outcome = await deps.watch(item.resourceId);
      if (outcome.completed) {
        deps.ledger.record(outcome.resourceId, outcome.creditedDeltaSeconds);
        deps.log('info', `batch: video ${outcome.resourceId} completed (credited ${outcome.creditedDeltaSeconds ?? '?'}s, ${outcome.wallSeconds.toFixed(0)}s wall, ${outcome.recoveries} recoveries)`);
      } else if (outcome.failed) {
        deps.failed.recordFailed(outcome.resourceId, 'recovery cap exceeded');
        deps.log('warn', `batch: video ${outcome.resourceId} failed after ${outcome.recoveries} recoveries — will retry next pass`);
      } else {
        deps.log('info', `batch: video ${outcome.resourceId} stopped before terminal state — will retry next pass`);
      }
    }
  }
  deps.log('warn', `batch: reached --max-passes (${deps.maxPasses}) with videos remaining`);
  deps.log('info', batchSummaryLine(deps.ledger, deps.failed));
}
