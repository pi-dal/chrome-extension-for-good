import type { ElementTable, QuizQuestionModel } from '@c4g/protocol';
import { describeAction } from '@c4g/protocol';
import type { WsBridge } from './ws-server.js';
import type { QuizSolver } from './solver.js';
import type { LogFn } from './log.js';
import { captureFromWs, qualityCheck, wsCaptureTransport, type CaptureOptions } from './capture.js';
import { inspectPage, type InspectDeps } from './inspect/index.js';
import { applyQuizScope, mergeNavLabels, readProgressHint } from './inspect/plugin-hints.js';
import { stemKey } from './inspect/session.js';
import type { SitePluginQuiz } from '@c4g/protocol';

const SAVE_NAV_RE = /保存|check|save/i;
const SUBMIT_NAV_RE = /交卷|提交试卷|submit all|finish attempt|提交|submit/i;
const NEXT_NAV_RE = /下一题|下一页|next question|next page|下一步/i;
const EXPAND_NAV_RE = /展开|更多|展开全部|expand|show all|more\b/i;

export interface QuizLoopReport {
  answered: number;
  skipped: number;
  /** Questions already answered before we saw them (not solver skips). */
  preAnswered: number;
  navClicked: string | null;
  stopped:
    | 'completed'
    | 'no-questions'
    | 'submit-blocked'
    | 'max-questions'
    | 'solver-unavailable'
    | 'conservation-failed'
    | 'capture-defective';
  hunts: number;
  verifyFailed: number;
  conservation: 'pass' | 'fail' | 'not-run';
  diagnostics: string[];
}

export interface QuizLoopDeps {
  ws: WsBridge;
  solver: QuizSolver;
  inspect: InspectDeps;
  log: LogFn;
  autoSubmit: boolean;
  captureOpts?: CaptureOptions;
  maxQuestions?: number;
  maxHuntRounds?: number;
  /**
   * Site-plugin quiz knowledge (docs/m5 §7), applied to EVERY capture inside
   * the loop: rootSelector narrows the candidate table, navLabels extend
   * navIndices, progressSelector backs progressClaim when the capture has
   * none. All additive — a failing hint degrades to the previous behaviour.
   */
  pluginQuiz?: {
    quiz: SitePluginQuiz;
    evalJson: (expression: string) => Promise<unknown | null>;
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function elementAt(table: ElementTable, index: number) {
  return table.elements.find((el) => el.index === index);
}

/**
 * Quiz answering state machine over the M2 inspect pipeline
 * (docs/m2-auto-inspect.md §4.5): capture → inspectPage → answer → verify.
 *
 * Completeness gates (design §2):
 * - capture quality gate: defective captures are hunted (scroll + re-capture),
 *   never inspected
 * - element conservation: `conservation.status === 'fail'` refuses answering —
 *   hunt first, then stop; answers are only given on green inspections
 * - progress conservation: a progressClaim totalling more questions than were
 *   seen triggers a hunt round
 * - read-back verification: after answering, the elements we acted on must
 *   confirm their new state (via __c4gRef probes — see verifyAction) before
 *   the question counts as answered
 *
 * With autoSubmit=false this loop stops before clicking anything matching
 * SUBMIT_NAV_RE — it logs and stops instead. Saving answers (保存/check) is fine.
 */
export async function runQuizLoop(deps: QuizLoopDeps, tabId: number): Promise<QuizLoopReport> {
  const { ws, solver, log, autoSubmit } = deps;
  const maxQuestions = deps.maxQuestions ?? 50;
  const maxHuntRounds = deps.maxHuntRounds ?? 2;
  const transport = wsCaptureTransport(ws, tabId);
  const diagnostics: string[] = [];
  const report: QuizLoopReport = {
    answered: 0,
    skipped: 0,
    preAnswered: 0,
    navClicked: null,
    stopped: 'max-questions',
    hunts: 0,
    verifyFailed: 0,
    conservation: 'not-run',
    diagnostics,
  };
  /**
   * Stems already attempted (answered, skipped or verify-failed) this session.
   * Keyed by normalized stem text, NOT element index: every round re-captures
   * and indices shift between tables (review F2).
   */
  const done = new Set<string>();
  let consecutiveActFailures = 0;

  const actSafe = async (action: Parameters<WsBridge['act']>[1]): Promise<boolean> => {
    try {
      await ws.act(tabId, action);
      consecutiveActFailures = 0;
      return true;
    } catch (err) {
      consecutiveActFailures++;
      log(
        'warn',
        `quiz action failed (${consecutiveActFailures} consecutive): ${describeAction(action)}`,
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  };

  const hunt = async (reason: string, table: ElementTable): Promise<boolean> => {
    if (report.hunts >= maxHuntRounds) return false;
    report.hunts++;
    log('info', `quiz hunt #${report.hunts}: ${reason} — expanding, scrolling and re-capturing`);
    // Expand collapsed sections first (design §2.3: 滚动/展开/翻页), then scroll.
    // Expand controls are NOT in navIndices — the heuristic NAV taxonomy
    // excludes them (they are 'excluded: not quiz nav'), so searching only
    // navIndices would make this step dead code. Scan the table's buttonish
    // elements instead, still guarded against submit/save labels.
    const expandNav = table.elements.find(
      (el) =>
        !el.disabled &&
        EXPAND_NAV_RE.test(el.name) &&
        !SUBMIT_NAV_RE.test(el.name) &&
        !SAVE_NAV_RE.test(el.name) &&
        (el.role === 'button' || el.tag === 'button' || el.role === 'link'),
    );
    if (expandNav !== undefined) {
      await actSafe({ op: 'click', index: expandNav.index });
      await sleep(1200);
    }
    await actSafe({ op: 'scroll', deltaY: 700 });
    await sleep(1500);
    return true;
  };

  /**
   * Live state of specific element indices, probed through `__c4gRef` — the
   * function the extension injects into every eval scope, resolving the live
   * element cached for a snapshot index — instead of a fresh snapshot. This
   * is deliberate (review M1): every snapshot_request replaces the content
   * script's ref cache, so a read-back snapshot would re-index the cache and
   * every later click addressed by this capture's indices would resolve to
   * the wrong element. Probing keeps the index epoch stable for the whole
   * round.
   *
   * Returns null when the extension cannot evaluate (older build); callers
   * then fall back to a fresh-snapshot check and accept the epoch risk.
   */
  const probeFlags = async (indices: number[], kind: 'option' | 'input'): Promise<boolean[] | null> => {
    const test = kind === 'option' ? 'el.checked===true' : `String(el.value||'').trim()!==''`;
    try {
      const flags = await ws.evalJson(
        tabId,
        `${JSON.stringify(indices)}.map(function(i){` +
          `var el=(typeof __c4gRef==="function"?__c4gRef(i):null)||null;` +
          `return el?(${test}):null;})`,
      );
      if (Array.isArray(flags) && flags.length === indices.length) {
        return flags.map((f) => f === true);
      }
    } catch {
      // eval unsupported — fall through
    }
    return null;
  };

  /**
   * Fresh FULL-table snapshot — FALLBACK ONLY for extensions without eval
   * support. Must stay `quizOnly: false`: the capture (and therefore every
   * index in `QuizQuestionModel`) refers to the full element table, and a
   * quizOnly snapshot is filtered + re-indexed — reading it back would verify
   * the wrong elements.
   */
  const snapshotFlags = async (indices: number[], kind: 'option' | 'input'): Promise<boolean[]> => {
    const res = await ws.snapshot(tabId, { quizOnly: false });
    return indices.map((idx) => {
      const el = elementAt(res.table, idx);
      if (!el) return false;
      return kind === 'option' ? el.checked === true : (el.value ?? '').trim() !== '';
    });
  };

  /** Per-index state; prefers the __c4gRef probe, falls back to a snapshot. */
  const stateFlags = async (indices: number[], kind: 'option' | 'input'): Promise<boolean[]> => {
    return (await probeFlags(indices, kind)) ?? (await snapshotFlags(indices, kind));
  };

  /**
   * Read-back verification (design §2.4): the elements WE acted on must show
   * the new state — the clicked option checked, the typed input filled.
   *
   * This deliberately verifies OUR indices rather than "all boxes": a
   * multi-select whose correct set is a proper subset is answered once the
   * chosen options are checked — requiring every box would mark it
   * unanswered forever, and the retry would then toggle the correct
   * selections back OFF (review H3).
   */
  const verifyAction = async (indices: number[], kind: 'option' | 'input'): Promise<boolean> => {
    const flags = await stateFlags(indices, kind);
    return flags.every(Boolean);
  };

  /** Answer one question; verifies via read-back before reporting success. */
  const answerOne = async (
    table: ElementTable,
    q: QuizQuestionModel,
  ): Promise<'answered' | 'no-answer' | 'verify-failed' | 'act-failed' | 'solver-unavailable'> => {
    if (!solver.enabled) return 'solver-unavailable';

    if (q.optionIndices.length > 0) {
      const options = q.optionIndices
        .map((idx) => elementAt(table, idx))
        .filter((el): el is NonNullable<typeof el> => el !== undefined);
      const multi = options.some((el) => el.role === 'checkbox');
      const answer = await solver.solve(
        q.stem,
        options.map((el) => ({ index: el.index, text: el.name })),
        multi,
      );
      if (!answer) return 'no-answer';
      // Solver contract: indices are the exact option numbers shown in the
      // list (validated in solver.ts). No positional fallback.
      const wanted: number[] = [];
      for (const idx of answer.indices) {
        if (!options.some((el) => el.index === idx)) {
          log('warn', `quiz: solver returned unknown option index ${idx}, skipping`);
          continue;
        }
        wanted.push(idx);
      }
      if (wanted.length === 0) return 'no-answer';
      // Checkboxes the solver did NOT pick must end up unchecked — a stray
      // pre-checked box would silently join the submitted set. Radios are
      // excluded: picking the wanted radio clears the group automatically and
      // a radio cannot be toggled off by clicking.
      const unwanted = options
        .filter((el) => el.role === 'checkbox' && !wanted.includes(el.index))
        .map((el) => el.index);
      for (const attempt of [1, 2]) {
        // Click ONLY the options not yet checked: re-clicking a checkbox
        // toggles it OFF, so an idempotent retry must skip what took effect.
        const missing = (await stateFlags(wanted, 'option'))
          .map((ok, i) => (ok ? null : wanted[i]!))
          .filter((idx): idx is number => idx !== null);
        for (const idx of missing) {
          const action = { op: 'click' as const, index: idx };
          log('debug', `quiz action: ${describeAction(action)}`);
          if (!await actSafe(action)) return 'act-failed';
          await sleep(1200 + Math.random() * 400);
        }
        if (unwanted.length > 0) {
          const stray = (await stateFlags(unwanted, 'option'))
            .map((checked, i) => (checked ? unwanted[i]! : null))
            .filter((idx): idx is number => idx !== null);
          for (const idx of stray) {
            const action = { op: 'click' as const, index: idx };
            log('debug', `quiz action (uncheck): ${describeAction(action)}`);
            if (!await actSafe(action)) return 'act-failed';
            await sleep(1200 + Math.random() * 400);
          }
        }
        const wantedOk = await verifyAction(wanted, 'option');
        const unwantedOk =
          unwanted.length === 0 || (await stateFlags(unwanted, 'option')).every((checked) => !checked);
        if (wantedOk && unwantedOk) return 'answered';
        if (attempt === 1) log('warn', `quiz: read-back failed for "${q.stem.slice(0, 50)}" — retrying once`);
      }
      return 'verify-failed';
    }

    if (q.inputIndices.length > 0) {
      const answer = await solver.solveShortAnswer(q.stem);
      if (!answer) return 'no-answer';
      const target = q.inputIndices[0]!;
      for (const attempt of [1, 2]) {
        // Type only when the field is still empty (idempotent retry).
        const [filled] = await stateFlags([target], 'input');
        if (!filled) {
          const action = { op: 'type' as const, index: target, text: answer.text };
          log('debug', `quiz action: ${describeAction(action)}`);
          if (!await actSafe(action)) return 'act-failed';
          await sleep(1200 + Math.random() * 400);
        }
        if (await verifyAction(q.inputIndices, 'input')) return 'answered';
        if (attempt === 1) log('warn', `quiz: read-back failed for "${q.stem.slice(0, 50)}" — retrying once`);
      }
      return 'verify-failed';
    }

    return 'no-answer';
  };

  for (let round = 1; round <= maxQuestions; round++) {
    if (consecutiveActFailures >= 3) {
      diagnostics.push('stopped: 3 consecutive action failures');
      report.stopped = 'no-questions';
      return report;
    }

    // 1) Capture with convergence (the capture loop scrolls; lazy content settles).
    let cap = await captureFromWs(transport, { includePageText: true, ...deps.captureOpts });

    // 1b) Plugin quiz hints (docs/m5 §7): narrow the capture to the quiz
    // subtree when the plugin declares rootSelector — additive, a failing or
    // empty probe keeps the full page. Quality is re-checked on the narrowed
    // table.
    if (deps.pluginQuiz) {
      const { capture: scoped, applied } = await applyQuizScope(cap, deps.pluginQuiz.quiz, {
        evalJson: deps.pluginQuiz.evalJson,
        log,
      });
      for (const d of applied.diagnostics) diagnostics.push(`[hints r${round}] ${d}`);
      if (scoped !== cap) {
        cap = { ...scoped, quality: qualityCheck(scoped), diagnostics: cap.diagnostics };
      }
      if (!cap.progressClaim) {
        const claim = await readProgressHint(deps.pluginQuiz.quiz, { evalJson: deps.pluginQuiz.evalJson });
        if (claim) {
          cap = { ...cap, progressClaim: claim };
          diagnostics.push(`[hints r${round}] progressClaim from ${deps.pluginQuiz.quiz.progressSelector} (${claim.raw})`);
        }
      }
    }
    if (cap.quality.defective) {
      diagnostics.push(`capture defective: ${cap.quality.defects.join('; ')}`);
      // Nav list of a defective capture is not trustworthy — expand none.
      if (await hunt('defective capture', cap.table)) continue;
      report.stopped = 'capture-defective';
      return report;
    }

    // 2) Inspect (conservation-audited; heuristic channel in dry-run).
    let inspection = await inspectPage(cap, deps.inspect);
    // Plugin nav labels are additive to the inspection's nav indices.
    if (deps.pluginQuiz?.quiz.navLabels) {
      const merged = mergeNavLabels(inspection, cap.table, deps.pluginQuiz.quiz.navLabels);
      inspection = merged.result;
      if (merged.added.length > 0) {
        diagnostics.push(`[hints r${round}] nav labels added [${merged.added.join(', ')}]`);
      }
    }
    report.conservation = inspection.conservation.status;
    for (const d of inspection.diagnostics) diagnostics.push(`[inspect r${round}] ${d}`);

    // 3) Conservation gate — hard (design §2.1): no answering on red.
    if (inspection.conservation.status === 'fail') {
      if (await hunt(`conservation failed (unaccounted [${inspection.conservation.unaccounted.join(', ')}])`, cap.table)) continue;
      diagnostics.push('refusing to answer: conservation failed after all hunt rounds');
      report.stopped = 'conservation-failed';
      return report;
    }

    // 4) Answer what is open.
    const open = inspection.questions.filter((q) => !q.answered && !done.has(stemKey(q.stem)));
    let solverUnavailable = false;
    for (const q of open) {
      log('info', `quiz: answering "${q.stem.slice(0, 80)}" (${q.optionIndices.length} options, ${q.inputIndices.length} inputs)`);
      const outcome = await answerOne(cap.table, q);
      const key = stemKey(q.stem);
      switch (outcome) {
        case 'answered':
          report.answered++;
          done.add(key);
          break;
        case 'no-answer':
          report.skipped++;
          done.add(key);
          diagnostics.push(`no solver answer for stem #${q.stemIndex} — skipped`);
          break;
        case 'verify-failed':
          report.verifyFailed++;
          report.skipped++;
          done.add(key);
          diagnostics.push(`read-back verification failed for stem #${q.stemIndex} — skipped`);
          break;
        case 'act-failed':
          done.add(key);
          report.skipped++;
          break;
        case 'solver-unavailable':
          solverUnavailable = true;
          break;
      }
      if (solverUnavailable) break;
      await sleep(800 + Math.random() * 400);
    }
    if (solverUnavailable) {
      diagnostics.push('solver unavailable (no key configured) — nothing answered');
      report.stopped = 'solver-unavailable';
      return report;
    }
    for (const q of inspection.questions) {
      if (q.answered && !done.has(stemKey(q.stem))) {
        done.add(stemKey(q.stem));
        report.preAnswered++;
      }
    }

    // 5) Save progress when a save/check control exists.
    const navName = (idx: number): string => elementAt(cap.table, idx)?.name ?? '';
    const navEnabled = (idx: number): boolean => elementAt(cap.table, idx)?.disabled !== true;
    const saveNav = inspection.navIndices.find(
      (idx) => SAVE_NAV_RE.test(navName(idx)) && !SUBMIT_NAV_RE.test(navName(idx)) && navEnabled(idx),
    );
    if (saveNav !== undefined) {
      const action = { op: 'click' as const, index: saveNav };
      log('info', `quiz nav: ${describeAction(action)} "${navName(saveNav)}"`);
      if (!await actSafe(action)) continue;
      await sleep(2000);
    }

    // 6) Progress conservation BEFORE any irreversible action (design §2.3,
    // review F3): never submit while the platform claims more questions than
    // were seen — hunt first.
    const claim = cap.progressClaim;
    if (claim && claim.total > inspection.questions.length) {
      if (await hunt(`progress claims ${claim.total} questions, only ${inspection.questions.length} seen`, cap.table)) continue;
      diagnostics.push(`progress mismatch persists: claimed ${claim.total}, seen ${inspection.questions.length}`);
      report.stopped = 'no-questions';
      return report;
    }

    // 7) Submit only when no save control was present AND autoSubmit is on.
    const submitNav = inspection.navIndices.find((idx) => SUBMIT_NAV_RE.test(navName(idx)) && navEnabled(idx));
    if (submitNav !== undefined && saveNav === undefined) {
      if (!autoSubmit) {
        log('warn', `quiz: submit control "${navName(submitNav)}" found but AUTO_SUBMIT=false — stopping (answers are saved)`);
        report.stopped = 'submit-blocked';
        return report;
      }
      log('info', `quiz nav: ${describeAction({ op: 'click', index: submitNav })} "${navName(submitNav)}" (autoSubmit)`);
      await actSafe({ op: 'click', index: submitNav });
      report.navClicked = navName(submitNav);
      report.stopped = 'completed';
      return report;
    }

    // 8) Next page / next question: paginated quizzes continue instead of
    // stopping after page one (review F6). Submit is excluded here — it is
    // only ever reached through the AUTO_SUBMIT-gated branch above.
    const nextNav = inspection.navIndices.find(
      (idx) => NEXT_NAV_RE.test(navName(idx)) && !SUBMIT_NAV_RE.test(navName(idx)) && !SAVE_NAV_RE.test(navName(idx)) && navEnabled(idx),
    );
    if (nextNav !== undefined) {
      const action = { op: 'click' as const, index: nextNav };
      log('info', `quiz nav: ${describeAction(action)} "${navName(nextNav)}"`);
      if (!await actSafe(action)) continue;
      await sleep(2000);
      continue; // re-capture + re-inspect the next page
    }

    // 9) Nothing open and nothing to hunt — the page is exhausted.
    if (open.length === 0) {
      diagnostics.push('all visible questions handled; no submit control acted on');
      report.stopped = 'no-questions';
      return report;
    }
    await sleep(1500);
  }
  return report;
}
