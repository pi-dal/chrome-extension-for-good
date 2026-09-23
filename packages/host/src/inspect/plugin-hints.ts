import type { ElementInfo, ElementTable, InspectionResult, PageCapture, SitePluginQuiz } from '@c4g/protocol';
import { assertSafeSelector, buildCountProbeExpression } from '../distill.js';
import type { LogFn } from '../log.js';
import { buildMembershipProbeExpression } from './l1.js';

/**
 * Plugin quiz hints (M5 §7): the static half of "the platform knows something
 * about its own quiz pages".
 *
 * These helpers deliberately sit OUTSIDE the inspect pipeline: they narrow what
 * the pipeline looks at and extend what it reports, but the conservation audit,
 * L1 recipe confirmation, L2 heuristics and L3 enumeration stay exactly as
 * before. A wrong hint therefore degrades to today's behaviour instead of
 * silently changing the answer:
 *
 *   - scope narrowing keeps every element when the probe fails or matches
 *     nothing (never "empty quiz" as a silent outcome),
 *   - nav labels only ADD indices to `navIndices` (deduped, sorted),
 *   - the report always says which hints were applied.
 */

/** Hints that survived validation and are usable for this page. */
export interface AppliedHints {
  scoped: boolean;
  scopeNote: string | null;
  navLabels: string[];
  diagnostics: string[];
}

export function emptyAppliedHints(): AppliedHints {
  return { scoped: false, scopeNote: null, navLabels: [], diagnostics: [] };
}

export interface ScopeDeps {
  evalJson(expression: string): Promise<unknown | null>;
  log: LogFn;
}

/**
 * Restrict a capture to the subtree matched by `rootSelector` (via CDP/isolated
 * world probes over the cached snapshot refs). Elements outside are dropped;
 * everything else — including the conservation audit — is untouched.
 */
export async function applyQuizScope(
  capture: PageCapture,
  quiz: SitePluginQuiz | undefined,
  deps: ScopeDeps,
): Promise<{ capture: PageCapture; applied: AppliedHints }> {
  const applied = emptyAppliedHints();
  const selector = quiz?.rootSelector;
  if (!selector) return { capture, applied };
  try {
    const safe = assertSafeSelector(selector);
    const indices = capture.table.elements.map((el) => el.index);
    const flags = await deps.evalJson(buildMembershipProbeExpression(safe, indices));
    const inside = new Set<number>();
    if (Array.isArray(flags)) {
      flags.forEach((flag, i) => {
        if (flag === 1) inside.add(indices[i]!);
      });
    }
    if (inside.size === 0) {
      applied.scopeNote = `quiz.rootSelector ${safe} matched no snapshot element — keeping the full page`;
      deps.log('warn', `inspect hints: ${applied.scopeNote}`);
      return { capture, applied };
    }
    const kept = capture.table.elements.filter((el) => inside.has(el.index));
    applied.scoped = true;
    applied.scopeNote = `scoped to ${safe}: kept ${kept.length}/${capture.table.elements.length} elements`;
    applied.diagnostics.push(applied.scopeNote);
    deps.log('info', `inspect hints: ${applied.scopeNote}`);
    return { capture: { ...capture, table: { ...capture.table, elements: kept } }, applied };
  } catch (err) {
    applied.scopeNote = `quiz.rootSelector probe failed — keeping the full page (${err instanceof Error ? err.message : String(err)})`;
    deps.log('warn', `inspect hints: ${applied.scopeNote}`);
    return { capture, applied };
  }
}

/** Elements whose accessible name carries one of the platform's nav labels. */
export function navIndicesFromLabels(table: ElementTable, labels: string[]): number[] {
  if (labels.length === 0) return [];
  const wanted = labels.map((l) => normalize(l)).filter((l) => l.length > 0);
  const out: number[] = [];
  for (const el of table.elements) {
    if (el.disabled === true) continue;
    const name = normalize(el.name);
    if (name === '') continue;
    if (wanted.some((label) => name === label || name.includes(label))) out.push(el.index);
  }
  return out;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

/**
 * Merge plugin-declared nav buttons into an inspection result. Additive only:
 * indices the pipeline already found stay where they are, and the result is
 * re-sorted so consumers keep seeing ascending indices.
 */
export function mergeNavLabels(
  result: InspectionResult,
  table: ElementTable,
  labels: string[],
): { result: InspectionResult; added: number[] } {
  const fromLabels = navIndicesFromLabels(table, labels);
  if (fromLabels.length === 0) return { result, added: [] };
  const existing = new Set(result.navIndices);
  const added = fromLabels.filter((i) => !existing.has(i));
  if (added.length === 0) return { result, added };
  const navIndices = [...result.navIndices, ...added].sort((a, b) => a - b);
  return {
    result: {
      ...result,
      navIndices,
      diagnostics: [
        ...result.diagnostics,
        `hints: nav buttons from plugin labels [${added.join(', ')}]`,
      ],
    },
    added,
  };
}

export interface ProgressHintDeps {
  evalJson(expression: string): Promise<unknown | null>;
}

/**
 * Read the platform's own progress widget with the plugin's selector, as a
 * fallback when the capture did not yield a progressClaim.
 */
export async function readProgressHint(
  quiz: SitePluginQuiz | undefined,
  deps: ProgressHintDeps,
): Promise<{ raw: string; current: number; total: number } | null> {
  const selector = quiz?.progressSelector;
  if (!selector) return null;
  try {
    const safe = assertSafeSelector(selector);
    const raw = await deps.evalJson(
      `(function(){var el=document.querySelector(${JSON.stringify(safe)});return el?String(el.textContent||el.innerText||'').slice(0,120):null;})()`,
    );
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const nums = (raw.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n));
    if (nums.length === 0) return null;
    // "已完成 37.5%" style widgets: one number is a percentage of the whole
    const first = nums[0]!;
    const second = nums.length > 1 ? nums[1]! : 100;
    return { raw: raw.trim(), current: first, total: second === 0 ? 100 : second };
  } catch {
    return null;
  }
}

/** One-line hint summary for the inspection log. */
export function hintSummaryLine(quiz: SitePluginQuiz | undefined, applied: AppliedHints): string {
  if (!quiz) return 'inspect hints: none (no quiz section in the platform plugin)';
  const bits = [
    applied.scoped ? (applied.scopeNote ?? 'scoped') : 'scope: full page',
    applied.navLabels.length > 0 ? `nav labels: ${applied.navLabels.join('/')}` : 'nav labels: none',
    quiz.questionSelector ? `questionSelector: ${quiz.questionSelector}` : 'questionSelector: none',
  ];
  return `inspect hints: ${bits.join(' · ')}`;
}

export type { ElementInfo };
