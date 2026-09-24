/**
 * inspect orchestration (docs/m2-auto-inspect.md §4.2).
 *
 * inspectPage runs the L2 heuristic grouper, then — when an LLM key is
 * configured — the L3 enumerator, merges the two channels (agreement keeps
 * the local source; disputes go to Jev arbitration), and audits element
 * conservation. Unaccounted quiz-candidate controls are fed back to the LLM
 * (max 2 attempts total); anything still unaccounted after that fails
 * conservation and the caller must NOT answer.
 */
import type { ElementInfo, ElementTable, InspectionResult, PageCapture, QuizQuestionModel } from '@c4g/protocol';
import type { LogFn } from '../log.js';
import type { Arbitrator } from './arbitrate.js';
import { HeuristicOnlyArbiter } from './arbitrate.js';
import { auditConservation, conservationCandidates } from './conservation.js';
import { heuristicGroup } from './heuristic.js';
import { createLlmEnumeratorFromEnv, LlmEnumerator, MAX_ENUMERATION_ATTEMPTS } from './llm.js';
import { createJevArbitratorFromEnv } from './arbitrate.js';
import { confirmRecipe, type L1Deps } from './l1.js';

export interface InspectDeps {
  llm: LlmEnumerator;
  arbitrate: Arbitrator;
  log: LogFn;
  /** Optional L1 accelerator (design §4.3): live recipe confirmation. */
  l1?: L1Deps;
  /** Advisory platform structure for the LLM layer (from the site plugin). */
  hints?: string;
}

/** Live deps from env (SOLVER_* for the enumerator, TYPESAFE_API_KEY for arbitration). */
export function createInspectDepsFromEnv(log: LogFn, env: Record<string, string | undefined> = process.env): InspectDeps {
  return {
    llm: createLlmEnumeratorFromEnv(log, env),
    arbitrate: createJevArbitratorFromEnv(log, env),
    log,
  };
}

/** Dry-run deps: heuristic-only inspection, arbitration always unresolved. */
export function dryRunInspectDeps(log: LogFn): InspectDeps {
  return {
    llm: new LlmEnumerator(async () => undefined, log, false),
    arbitrate: new HeuristicOnlyArbiter(),
    log,
  };
}

interface GroupingState {
  questions: QuizQuestionModel[];
  navIndices: number[];
  excluded: Array<{ index: number; reason: string }>;
}

function elementAt(table: ElementTable, index: number): ElementInfo | undefined {
  return table.elements.find((el) => el.index === index);
}

function setEquals(a: number[], b: number[]): boolean {
  return a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;
}

function sortedUnique(indices: number[]): number[] {
  return [...new Set(indices)].sort((a, b) => a - b);
}

function assignedOf(state: GroupingState): number[] {
  const assigned: number[] = [];
  for (const q of state.questions) {
    assigned.push(q.stemIndex, ...q.optionIndices, ...q.inputIndices);
  }
  assigned.push(...state.navIndices);
  for (const e of state.excluded) assigned.push(e.index);
  return assigned;
}

function answeredFromTable(table: ElementTable, stemIndex: number, optionIndices: number[], inputIndices: number[]): boolean {
  if (optionIndices.length > 0) {
    // Role-aware (see heuristic.ts isAnswered): radios and checkboxes alike
    // count as answered once ANY option is selected — a proper-subset
    // multi-select answer is answered, and treating it as unanswered would
    // toggle the correct selections back off on retry (review H3).
    const options = optionIndices
      .map((idx) => elementAt(table, idx))
      .filter((el): el is ElementInfo => el !== undefined);
    const radios = options.filter((el) => el.role === 'radio');
    const checkboxes = options.filter((el) => el.role === 'checkbox');
    const radiosOk = radios.length === 0 || radios.some((el) => el.checked === true);
    const boxesOk = checkboxes.length === 0 || checkboxes.some((el) => el.checked === true);
    return radiosOk && boxesOk;
  }
  if (inputIndices.length > 0) {
    return inputIndices.every((idx) => (elementAt(table, idx)?.value ?? '').trim() !== '');
  }
  void stemIndex;
  return false;
}

/**
 * Merge one validated LLM enumeration into the current grouping state.
 * - same stem, same index sets → agreement, local source kept
 * - same stem, different index sets → arbitrate
 * - llm-only stem → arbitrate; acceptance adds an 'arbitrated' question,
 *   rejection explicitly excludes the elements (conservation stays auditable)
 */
async function applyEnumeration(
  state: GroupingState,
  enumeration: { questions: Array<{ stemIndex: number; optionIndices: number[]; inputIndices: number[] }>; navIndices: number[]; excludedIndices: number[] },
  table: ElementTable,
  deps: InspectDeps,
  diagnostics: string[],
): Promise<GroupingState> {
  const questions = state.questions.map((q) => ({ ...q, optionIndices: [...q.optionIndices], inputIndices: [...q.inputIndices] }));
  const excluded = [...state.excluded];
  const byStem = new Map(questions.map((q) => [q.stemIndex, q]));
  const candidateSet = new Set(conservationCandidates(table));

  for (const eq of enumeration.questions) {
    const hq = byStem.get(eq.stemIndex);
    if (hq) {
      const agree = setEquals(hq.optionIndices, eq.optionIndices) && setEquals(hq.inputIndices, eq.inputIndices);
      if (agree) continue;
      const verdict = await deps.arbitrate.arbitrate(
        {
          summary: `question at stem #${eq.stemIndex}: "${hq.stem}"`,
          heuristicIndices: [hq.stemIndex, ...hq.optionIndices, ...hq.inputIndices],
          llmIndices: [eq.stemIndex, ...eq.optionIndices, ...eq.inputIndices],
        },
        table,
      );
      if (verdict.winner === 'llm') {
        hq.optionIndices = [...eq.optionIndices];
        hq.inputIndices = [...eq.inputIndices];
        // The option set changed — recompute answered against the NEW indices
        // (the flag was computed on the heuristic grouping's set).
        hq.answered = answeredFromTable(table, hq.stemIndex, hq.optionIndices, hq.inputIndices);
        hq.source = 'arbitrated';
        hq.confidence = Math.max(0.5, verdict.confidence);
        diagnostics.push(`arbitration: llm grouping adopted for stem #${eq.stemIndex} (${verdict.confidence.toFixed(2)})`);
      } else if (verdict.winner === 'heuristic') {
        diagnostics.push(`arbitration: heuristic grouping kept for stem #${eq.stemIndex} (${verdict.confidence.toFixed(2)})`);
      } else {
        // Fail-safe (design §2.2): an unresolved dispute must NOT silently fall
        // back to an answerable heuristic group — drop it and exclude its
        // elements explicitly so conservation stays auditable.
        const at = questions.indexOf(hq);
        if (at !== -1) questions.splice(at, 1);
        byStem.delete(eq.stemIndex);
        const reason = 'arbitration unclassified';
        for (const idx of [hq.stemIndex, ...hq.optionIndices, ...hq.inputIndices]) {
          if (candidateSet.has(idx) && !excluded.some((e) => e.index === idx)) {
            excluded.push({ index: idx, reason });
          }
        }
        diagnostics.push(`arbitration: dispute unresolved (${verdict.winner}) — stem #${eq.stemIndex} excluded`);
      }
      continue;
    }
    // LLM-only question — needs arbitration before it may exist.
    const stemEl = elementAt(table, eq.stemIndex);
    const verdict = await deps.arbitrate.arbitrate(
      {
        summary: `llm-only question at stem #${eq.stemIndex}: "${stemEl?.name.slice(0, 60) ?? '?'}"`,
        heuristicIndices: [],
        llmIndices: [eq.stemIndex, ...eq.optionIndices, ...eq.inputIndices],
      },
      table,
    );
    if (verdict.winner === 'llm') {
      const model: QuizQuestionModel = {
        stem: stemEl?.name ?? '',
        stemIndex: eq.stemIndex,
        optionIndices: [...eq.optionIndices],
        inputIndices: [...eq.inputIndices],
        answered: answeredFromTable(table, eq.stemIndex, eq.optionIndices, eq.inputIndices),
        confidence: Math.max(0.5, verdict.confidence),
        source: 'arbitrated',
      };
      questions.push(model);
      byStem.set(model.stemIndex, model);
      diagnostics.push(`arbitration: llm-only question at stem #${eq.stemIndex} accepted (${verdict.confidence.toFixed(2)})`);
    } else {
      const reason = 'arbitration rejected llm grouping';
      for (const idx of [eq.stemIndex, ...eq.optionIndices, ...eq.inputIndices]) {
        if (candidateSet.has(idx) && !excluded.some((e) => e.index === idx)) {
          excluded.push({ index: idx, reason });
        }
      }
      diagnostics.push(`arbitration: llm-only question at stem #${eq.stemIndex} rejected (${verdict.winner})`);
    }
  }

  questions.sort((a, b) => a.stemIndex - b.stemIndex);
  const navIndices = sortedUnique([...state.navIndices, ...enumeration.navIndices]);
  const excludedIdx = new Set(excluded.map((e) => e.index));
  for (const idx of enumeration.excludedIndices) {
    if (!excludedIdx.has(idx)) {
      excluded.push({ index: idx, reason: 'excluded by llm enumeration' });
      excludedIdx.add(idx);
    }
  }
  return { questions, navIndices, excluded };
}

export async function inspectPage(capture: PageCapture, deps: InspectDeps): Promise<InspectionResult> {
  const { table } = capture;
  const diagnostics: string[] = [];
  const H = heuristicGroup(table);
  const state: GroupingState = {
    questions: H.questions.map((q) => ({ ...q })),
    navIndices: [...H.navIndices],
    excluded: H.excluded.map((e) => ({ ...e })),
  };
  let rounds = 1;

  // L1 accelerator (design §4.3, review F5c): a stored recipe must confirm the
  // heuristic grouping on the live page before we may skip L2/L3. Conservation
  // is still audited — completeness is never delegated to the recipe.
  if (deps.l1 && H.questions.length > 0) {
    try {
      const recipe = await deps.l1.recipeFor(capture.origin);
      if (recipe?.questionSelector) {
        const verdict = await confirmRecipe(table, recipe, deps.l1.evalJson, H);
        if (verdict.ok) {
          diagnostics.push(`l1: recipe confirmed (confidence ${recipe.confidence.toFixed(2)}) — skipping L2/L3`);
          const l1State = {
            questions: H.questions.map((q) => ({ ...q, source: 'recipe' as const, confidence: recipe.confidence })),
            navIndices: [...H.navIndices],
            excluded: [...H.excluded],
          };
          const unaccountedL1 = auditConservation(conservationCandidates(table), assignedOf(l1State));
          if (unaccountedL1.length === 0) {
            return {
              captureId: capture.captureId,
              questions: l1State.questions,
              navIndices: sortedUnique(l1State.navIndices),
              excluded: l1State.excluded,
              conservation: { status: 'pass' as const, rounds: 0, unaccounted: [] },
              diagnostics,
            };
          }
          diagnostics.push('l1: conservation failed on recipe grouping — falling back to L2');
        } else {
          diagnostics.push(`l1: recipe rejected (${verdict.reason ?? 'unknown'}) — falling back to L2`);
        }
      }
    } catch (err) {
      diagnostics.push(`l1: probe error — falling back to L2 (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  if (!deps.llm.enabled) {
    diagnostics.push('llm unavailable (dry-run): heuristic-only inspection');
  } else {
    const attempt = await deps.llm.enumerate(table, capture.pageText, [], deps.hints);
    if (!attempt) {
      diagnostics.push('llm enumeration unavailable (no parseable reply)');
    } else {
      diagnostics.push(...attempt.notes.map((n) => `llm: ${n}`));
      const merged = await applyEnumeration(state, attempt.enumeration, table, deps, diagnostics);
      let unaccounted = auditConservation(conservationCandidates(table), assignedOf(merged));
      if (unaccounted.length > 0 && rounds < MAX_ENUMERATION_ATTEMPTS) {
        rounds = 2;
        diagnostics.push(`conservation feedback: unaccounted [${unaccounted.join(', ')}] fed back to llm`);
        const retry = await deps.llm.enumerate(table, capture.pageText, unaccounted, deps.hints);
        if (retry) {
          diagnostics.push(...retry.notes.map((n) => `llm(r2): ${n}`));
          const merged2 = await applyEnumeration(merged, retry.enumeration, table, deps, diagnostics);
          unaccounted = auditConservation(conservationCandidates(table), assignedOf(merged2));
          if (unaccounted.length === 0) {
            Object.assign(state, merged2);
          } else {
            diagnostics.push(`conservation still incomplete after feedback: [${unaccounted.join(', ')}]`);
            Object.assign(state, merged2);
          }
        } else {
          diagnostics.push('llm feedback round returned nothing');
          Object.assign(state, merged);
        }
      } else {
        Object.assign(state, merged);
      }
    }
  }

  const unaccounted = auditConservation(conservationCandidates(table), assignedOf(state));
  const conservation = {
    status: (unaccounted.length === 0 ? 'pass' : 'fail') as 'pass' | 'fail',
    rounds,
    unaccounted,
  };
  if (unaccounted.length > 0) {
    diagnostics.push(`conservation failed: unaccounted [${unaccounted.join(', ')}] — answering must not proceed`);
  }
  return {
    captureId: capture.captureId,
    questions: state.questions,
    navIndices: sortedUnique(state.navIndices),
    excluded: state.excluded,
    conservation,
    diagnostics,
  };
}
