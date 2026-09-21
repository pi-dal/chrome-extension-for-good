import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * LOCAL CONTRACT SHADOW (integration note): the recovery lane lands the real
 * `WatchOutcome` export in timekeeper.ts; until that merge, batch.ts declares
 * the identical shape so the chain loop can code against the contract.
 * Structural typing keeps both declarations compatible — integrator should
 * re-point the chain loop import at the timekeeper export.
 */
export interface WatchOutcome {
  resourceId: string | number;         // fsresourceid from playerdata
  completed: boolean;                  // player reached end AND server totaltime confirms final credit
  failed: boolean;                     // exceeded maxRecovery recoveries; gave up on this video
  wallSeconds: number;                 // wall-clock seconds spent on this video
  creditedDeltaSeconds: number | null; // server totaltime delta observed; null if unverifiable
  recoveries: number;                  // stall-recovery attempts used
}

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
