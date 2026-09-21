/**
 * Element conservation auditor (docs/m2-auto-inspect.md §2.1).
 *
 * Every quiz-candidate element must be accounted for by the inspection:
 * stem ∪ options ∪ inputs ∪ nav ∪ explicitly excluded. Anything left over is
 * returned as `unaccounted` — the caller must feed it back to the LLM
 * enumerator or fail conservation (fail-safe: no answering).
 */
import type { ElementTable } from '@c4g/protocol';

const CANDIDATE_ROLES: ReadonlySet<string> = new Set(['radio', 'checkbox', 'button', 'textbox']);

/** Quiz-candidate element indices: interactive controls + anything slot-hinted. */
export function conservationCandidates(table: ElementTable): number[] {
  return table.elements
    .filter((el) => CANDIDATE_ROLES.has(el.role) || el.quizSlot !== undefined)
    .map((el) => el.index);
}

/**
 * Candidates not covered by `assigned` (stem/option/input/nav/excluded
 * indices). Pure function; `assigned` may contain duplicates and non-candidates.
 */
export function auditConservation(candidates: number[], assigned: Iterable<number>): number[] {
  const covered = new Set(assigned);
  return candidates.filter((idx) => !covered.has(idx));
}
