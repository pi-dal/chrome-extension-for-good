/**
 * Cross-page session merge (docs/m2-auto-inspect.md §4.2).
 *
 * Inspects every capture in chronological order, dedupes questions by
 * normalized stem across pages, and reconciles the platform's own progress
 * claims (第 x/y 题, Question x of y) against what was actually seen.
 * Incompleteness is surfaced via `needs-hunt:` diagnostics — the quiz loop's
 * hunting cycle consumes those.
 */
import type { InspectionSession, PageCapture, QuizQuestionModel } from '@c4g/protocol';
import type { InspectDeps } from './index.js';
import { inspectPage } from './index.js';

/** Normalize a stem for cross-page identity: strip numbering/markers/spacing. */
export function stemKey(stem: string): string {
  return stem
    .replace(/^\s*\d+\s*[.、)）:：]\s*/, '')
    .replace(/（多选）|（单选）|（折叠区）/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export async function inspectSession(captures: PageCapture[], deps: InspectDeps): Promise<InspectionSession> {
  const ordered = [...captures].sort((a, b) => a.capturedAt - b.capturedAt);
  const diagnostics: string[] = [];
  const questions: QuizQuestionModel[] = [];
  const firstSeen = new Map<string, string>(); // stemKey → captureId
  let claimedDone = 0;
  let claimedTotal: number | null = null;
  let lastCurrent = -1;

  for (const capture of ordered) {
    const result = await inspectPage(capture, deps);
    for (const d of result.diagnostics) diagnostics.push(`${capture.captureId}: ${d}`);

    const claim = capture.progressClaim;
    if (claim) {
      claimedDone = Math.max(claimedDone, claim.current);
      if (claimedTotal === null) {
        claimedTotal = claim.total;
      } else if (claimedTotal !== claim.total) {
        diagnostics.push(
          `${capture.captureId}: progress total changed (${claimedTotal} → ${claim.total}) — suspicious`,
        );
      }
      if (claim.current < lastCurrent) {
        diagnostics.push(
          `needs-hunt: progress moved backwards at ${capture.captureId} (${lastCurrent} → ${claim.current})`,
        );
      }
      lastCurrent = Math.max(lastCurrent, claim.current);
    }

    if (result.conservation.status === 'fail') {
      diagnostics.push(
        `needs-hunt: capture ${capture.captureId} failed conservation (unaccounted [${result.conservation.unaccounted.join(', ')}])`,
      );
    }

    for (const q of result.questions) {
      const key = stemKey(q.stem);
      const first = firstSeen.get(key);
      if (first !== undefined) {
        diagnostics.push(`deduped question "${q.stem.slice(0, 40)}" (first seen in ${first})`);
        continue;
      }
      firstSeen.set(key, capture.captureId);
      questions.push(q);
    }
  }

  const seen = questions.length;
  if (claimedTotal !== null && seen < claimedTotal) {
    diagnostics.push(`needs-hunt: ${claimedTotal - seen} question(s) unaccounted (claimed ${claimedTotal}, seen ${seen})`);
  }

  return {
    captures: ordered,
    questions,
    progress: { claimedDone, claimedTotal, seen },
    diagnostics,
  };
}
