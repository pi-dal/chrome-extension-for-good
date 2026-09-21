/**
 * Online capture pipeline (design §4.1): convergence snapshots → PageCapture,
 * quality pre-check, corpus persistence under data/corpus/.
 *
 * Transport is an interface, not the concrete WsBridge, so the convergence
 * loop is unit-testable and survives WsBridge signature evolution (P3 will
 * forward includePageText; capture.ts needs no changes then).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePageCapture, type Action, type ElementTable, type PageCapture } from '@c4g/protocol';
import { extractProgressClaim } from './regex.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const PAGE_TEXT_LIMIT = 32 * 1024;

export interface SnapshotResult {
  table: ElementTable;
  /** Present only when the extension forwards includePageText snapshots. */
  pageText?: string;
}

export interface CaptureTransport {
  snapshot(req?: { includePageText?: boolean }): Promise<SnapshotResult>;
  act(action: Action): Promise<{ ok: boolean; url: string }>;
}

export interface CaptureOptions {
  maxRounds?: number;
  scrollDelta?: number;
  includePageText?: boolean;
  now?: () => number;
}

export interface CaptureQuality {
  defective: boolean;
  defects: string[];
}

// ---------------------------------------------------------------------------
// id / signature helpers
// ---------------------------------------------------------------------------

/** sha1(origin|pathname|capturedAt), first 16 hex chars (protocol §3). */
export function computeCaptureId(url: string, capturedAt: number): string {
  const parsed = new URL(url);
  return createHash('sha1')
    .update(`${parsed.origin}|${parsed.pathname}|${capturedAt}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Convergence signature: element count plus a hash over index/role/name/checked
 * so re-renders that swap question content (same shape, new names) count as
 * changes worth re-snapshotting.
 */
export function tableSignature(table: ElementTable): string {
  const h = createHash('sha1');
  for (const el of table.elements) {
    h.update(`${el.index}|${el.role}|${el.name}|${el.checked === true ? 1 : 0};`);
  }
  return `${table.elements.length}:${h.digest('hex').slice(0, 12)}`;
}

// ---------------------------------------------------------------------------
// captureFromWs — convergence snapshot loop
// ---------------------------------------------------------------------------

/**
 * Snapshot until the element table stabilises (lazy-loaded pages keep growing)
 * or maxRounds is exhausted. Never clicks; scroll actions only.
 */
export async function captureFromWs(
  transport: CaptureTransport,
  opts: CaptureOptions = {},
): Promise<PageCapture & { quality: CaptureQuality; diagnostics: string[] }> {
  const maxRounds = opts.maxRounds ?? 4;
  const scrollDelta = opts.scrollDelta ?? 600;
  const includePageText = opts.includePageText ?? true;
  const now = opts.now ?? Date.now;
  const diagnostics: string[] = [];

  let best: SnapshotResult | null = null;
  let prevSignature: string | null = null;
  for (let round = 1; round <= maxRounds; round++) {
    const snap = await transport.snapshot({ includePageText });
    best = snap;
    const signature = tableSignature(snap.table);
    if (signature === prevSignature) break;
    prevSignature = signature;
    if (round < maxRounds) {
      await transport.act({ op: 'scroll', deltaY: scrollDelta });
    }
  }
  const finalSnap = best as SnapshotResult;

  if (!finalSnap.pageText && includePageText) {
    // The snapshot channel is the only protocol-legal way to read pageText:
    // action_result carries no value payload. Note it and continue — pageText
    // is optional (design §3).
    diagnostics.push('pageText unavailable (extension did not forward includePageText snapshot)');
  }

  const capturedAt = now();
  const table: ElementTable = { ...finalSnap.table, capturedAt };
  const capture = assembleCapture({
    table,
    pageText: finalSnap.pageText,
    capturedAt,
  });
  const quality = qualityCheck(capture);
  return { ...capture, quality, diagnostics };
}

/** Pure assembly from a final table (+optional pageText) to a PageCapture. */
export function assembleCapture(input: {
  table: ElementTable;
  pageText?: string;
  capturedAt: number;
}): PageCapture {
  const url = input.table.url;
  const parsed = new URL(url);
  // Progress platforms usually print it in the body text; the page title is a
  // common fallback carrier ("第 1/5 题 小测").
  const progressSource = input.pageText ?? input.table.title ?? '';
  const capture: PageCapture = {
    captureId: computeCaptureId(url, input.capturedAt),
    url,
    origin: parsed.origin,
    capturedAt: input.capturedAt,
    table: input.table,
  };
  if (input.pageText !== undefined) {
    capture.pageText = input.pageText.slice(0, PAGE_TEXT_LIMIT);
  }
  const claim = extractProgressClaim(progressSource);
  if (claim) capture.progressClaim = claim;
  return capture;
}

// ---------------------------------------------------------------------------
// quality pre-check (design §4.1: defective captures never reach inspect)
// ---------------------------------------------------------------------------

const CANDIDATE_ROLES = new Set(['radio', 'checkbox', 'textbox', 'searchbox', 'combobox']);

/**
 * Structural pre-check on the capture itself (element-conservation happens in
 * inspect; this only rejects tables the executor/inspect could never use).
 */
export function qualityCheck(capture: PageCapture): CaptureQuality {
  const defects: string[] = [];
  const els = capture.table.elements;
  if (els.length === 0) {
    defects.push('empty element table');
  }
  let candidates = 0;
  let prevIndex = 0;
  for (const el of els) {
    if (!Number.isInteger(el.index) || el.index <= prevIndex) {
      defects.push(`non-ascending or duplicate index at #${el.index}`);
      break; // one report is enough; indices are the executor's lookup key
    }
    prevIndex = el.index;
    if (CANDIDATE_ROLES.has(el.role)) candidates++;
  }
  if (els.length > 0 && candidates === 0) {
    defects.push('no quiz-candidate elements (radio/checkbox/textbox family)');
  }
  try {
    if (new URL(capture.url).origin !== capture.origin) defects.push('origin does not match url');
  } catch {
    defects.push('unparsable url');
  }
  return { defective: defects.length > 0, defects };
}

// ---------------------------------------------------------------------------
// corpus persistence — data/corpus/<host>/<captureId>.json + index.json
// ---------------------------------------------------------------------------

export function defaultCorpusDir(): string {
  return resolve(HERE, '..', 'data', 'corpus');
}

function originDirName(origin: string): string {
  const safe = origin.replace(/[^A-Za-z0-9._-]+/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error(`unusable origin: ${origin}`);
  return safe;
}

function capturePath(corpusDir: string, capture: PageCapture): string {
  return join(corpusDir, originDirName(capture.origin), `${capture.captureId}.json`);
}

interface CorpusIndex {
  version: 1;
  captures: Array<{
    captureId: string;
    origin: string;
    url: string;
    capturedAt: number;
    defective: boolean;
    defects: string[];
  }>;
}

function readIndex(corpusDir: string): CorpusIndex {
  try {
    const raw = JSON.parse(readFileSync(join(corpusDir, 'index.json'), 'utf8')) as CorpusIndex;
    if (raw.version === 1 && Array.isArray(raw.captures)) return raw;
  } catch {
    // first run / missing index
  }
  return { version: 1, captures: [] };
}

/**
 * Persist a capture (defect-preserving: defective captures ARE stored, flagged,
 * so the corpus records what went wrong — design §4.1 quality gate).
 */
export function saveCapture(corpusDir: string, capture: PageCapture): CaptureQuality {
  const quality = qualityCheck(capture);
  const file = capturePath(corpusDir, capture);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(capture, null, 2));

  const index = readIndex(corpusDir);
  const entry = {
    captureId: capture.captureId,
    origin: capture.origin,
    url: capture.url,
    capturedAt: capture.capturedAt,
    defective: quality.defective,
    defects: quality.defects,
  };
  const existing = index.captures.findIndex((c) => c.captureId === capture.captureId);
  if (existing >= 0) index.captures[existing] = entry;
  else index.captures.push(entry);
  writeFileSync(join(corpusDir, 'index.json'), JSON.stringify(index, null, 2));
  return quality;
}

export function loadCapture(corpusDir: string, captureId: string): PageCapture | null {
  const index = readIndex(corpusDir);
  const entry = index.captures.find((c) => c.captureId === captureId);
  if (!entry) return null;
  try {
    return parsePageCapture(JSON.parse(readFileSync(join(corpusDir, originDirName(entry.origin), `${captureId}.json`), 'utf8')));
  } catch {
    return null;
  }
}

export function listCaptures(corpusDir: string): CorpusIndex['captures'] {
  return readIndex(corpusDir).captures;
}

/** Adapter from the concrete WsBridge (structural subset) to CaptureTransport. */
export interface WsBridgeLike {
  snapshot(
    tabId: number,
    opts?: { quizOnly?: boolean; includePageText?: boolean },
  ): Promise<{ table: ElementTable; pageText?: string }>;
  act(tabId: number, action: Action): Promise<{ ok: boolean; url: string }>;
}

export function wsCaptureTransport(ws: WsBridgeLike, tabId: number): CaptureTransport {
  return {
    async snapshot(req) {
      const res = await ws.snapshot(tabId, { includePageText: req?.includePageText === true });
      return res.pageText !== undefined ? res : { table: res.table };
    },
    act: (action) => ws.act(tabId, action),
  };
}
