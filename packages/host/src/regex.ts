/**
 * Progress-claim extraction (design §4.1): platforms self-report quiz progress
 * ("第 3/12 题", "Question 3 of 12"). Used for progress-conservation accounting.
 * Pure regex — no network, no model calls.
 */

import type { ProgressClaim } from '@c4g/protocol';

interface MatchSpec {
  /** Explicit patterns carry an ordinal AND a total in one phrase. */
  re: RegExp;
  currentGroup: number;
  totalGroup: number;
}

const EXPLICIT_PATTERNS: MatchSpec[] = [
  // 第 3/12 题 · 第3/12题
  { re: /第\s*(\d+)\s*\/\s*(\d+)\s*题/g, currentGroup: 1, totalGroup: 2 },
  // Question 3 of 12 · question 3 of 12
  { re: /question\s+(\d+)\s+of\s+(\d+)/gi, currentGroup: 1, totalGroup: 2 },
  // 3/12 题 (bare fraction must still mention 题 to avoid dates/scores)
  { re: /(\d+)\s*\/\s*(\d+)\s*题/g, currentGroup: 1, totalGroup: 2 },
];

/**
 * Extract the most credible progress claim from free text. Returns null when
 * nothing credible is found (caller leaves progressClaim unset).
 */
export function extractProgressClaim(text: string): ProgressClaim | null {
  if (!text) return null;
  for (const spec of EXPLICIT_PATTERNS) {
    const re = new RegExp(spec.re.source, spec.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const current = Number(m[spec.currentGroup]);
      const total = Number(m[spec.totalGroup]);
      const claim = sanitize(current, total, m[0]);
      if (claim) return claim;
    }
  }
  return null;
}

/**
 * All credible claims, ordered by appearance — session merge uses the set to
 * reconcile continuity across pages.
 */
export function extractProgressClaims(text: string): ProgressClaim[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: ProgressClaim[] = [];
  for (const spec of EXPLICIT_PATTERNS) {
    const re = new RegExp(spec.re.source, spec.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const claim = sanitize(Number(m[spec.currentGroup]), Number(m[spec.totalGroup]), m[0]);
      if (claim) {
        const key = `${claim.current}/${claim.total}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(claim);
        }
      }
    }
  }
  return out;
}

function sanitize(current: number, total: number, raw: string): ProgressClaim | null {
  if (!Number.isFinite(current) || !Number.isFinite(total)) return null;
  if (total < 1 || total > 1000) return null;
  if (current < 1 || current > total) return null;
  return { raw: raw.trim(), current, total };
}
