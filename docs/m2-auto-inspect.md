# M2 design: automatic inspect pipeline (L1/L2/L3 + integrity mechanics)

> Status: approved (Chairman, 2026-09-21). This document is the single source of truth for M2; where an implementation disagrees with it, this document wins.
> Prerequisites: README.md (M1 architecture), packages/protocol/src/index.ts (existing wire contract).

## 0. Goals and non-goals

**Goal**: for an arbitrary quiz page, complete capture → inspect → answer → recipe distillation without writing platform-specific adapter code. Platform knowledge is demoted from a requirement to an accelerator.

**Non-goals**: multimodal enumeration for canvas/image questions (only a `screenshotRef` extension point is left); cross-origin iframe aggregation (M3); adversarial work against anti-automation platforms.

## 1. Layers and failure modes

| Layer | Mechanism | Failure mode | Countermeasure |
|---|---|---|---|
| L1 Recipe | Load the distilled CSS recipe for the origin | Page redesign | Confirmation failure drops to L2 automatically |
| L2 Structural heuristics | Same-name radio/checkbox groups, text-block stems, XHR frequency clustering | Unusual layouts go undetected | Cross-checked against L3 |
| L3 LLM enumeration + Jev arbitration | Open-world LLM enumeration (element indices only), closed-world Jev arbitration of disagreements | LLM hallucination | Index grounding + conservation audit |

Division of labour (invariant): **LLM = discoverer (recall), Jev = judge (precision), code = auditor (conservation)**. Model output is always indices / structured JSON / recipe strings, never executable JS.

## 2. Four mechanical integrity guarantees

1. **Element conservation**: every quiz-candidate element (all radios/checkboxes, text inputs in the question area, nav candidates) must be accounted for as stem ∪ option ∪ input ∪ nav ∪ explicitly-excluded. Any leftover sends the missing indices back to the LLM for re-enumeration (≤2 rounds); still failing means `conservation.status='fail'` and quiz-loop refuses to answer (report only).
2. **Dual-channel cross-validation**: L2 and L3 group independently; agreement passes, disagreements go group-by-group to Jev `noul`/`choice`, and confidence < 0.7 lands in `unclassified` (fail-safe).
3. **Progress conservation**: extract the platform's self-reported progress (`progressClaim`) and reconcile it against the visible question count; a mismatch triggers a hunting loop (scroll/expand/paginate) and re-enumeration.
4. **Read-back after action**: every answer action re-snapshots to verify `checked`/`value` took effect (M1 `actSafe` plus a new read-back assertion).

## 3. Protocol additions (packages/protocol — additive only, never breaking)

```ts
interface PageCapture {
  captureId: string;            // first 16 hex chars of sha1(origin|pathname|capturedAt)
  url: string; origin: string; capturedAt: number;
  table: ElementTable;
  pageText?: string;            // ≤32KB, truncated; LLM fallback for canvas/odd structures
  progressClaim?: { raw: string; current: number; total: number };
  screenshotRef?: string;       // M3 extension point
  meta?: Record<string, unknown>;
}

interface QuizQuestionModel {
  stem: string; stemIndex: number;
  optionIndices: number[]; inputIndices: number[];
  answered: boolean; confidence: number;   // 0..1
  source: 'recipe' | 'hint' | 'heuristic' | 'llm' | 'arbitrated';
}

interface InspectionResult {
  captureId: string;
  questions: QuizQuestionModel[];
  navIndices: number[];                       // check/save/next/submit
  excluded: Array<{ index: number; reason: string }>;
  conservation: { status: 'pass' | 'fail'; rounds: number; unaccounted: number[] };
  diagnostics: string[];
}

interface QuizRecipe {
  origin: string;
  questionSelector?: string; optionSelector?: string;
  heartbeatUrlPattern?: string; videoSelector?: string;
  learnedVia: 'distill'; confidence: number; updatedAt: number;
}

interface InspectionSession {   // cross-page merge result
  captures: PageCapture[];      // ordered by capturedAt ascending
  questions: QuizQuestionModel[];   // deduped across pages
  progress: { claimedDone: number; claimedTotal: number | null; seen: number };
  diagnostics: string[];
}
```

- `snapshot_request` gains an optional `includePageText?: boolean`; `snapshot` gains an optional `pageText?: string`.
- `Action` gains `{ op: 'eval'; expression: string }`: host → extension, executed in the isolated world (DOM queries). **Grammar policy**: expressions may only come from host code constants; model-derived selectors must pass a syntax allow-list (no `;`, `//`, backticks; length ≤300) and be JSON-escaped before interpolation into `document.querySelectorAll(...)`; results are JSON-serialized and capped at 64KB.
- `action_result` gains an optional `value?: unknown` (eval actions only; 64KB JSON cap enforced on both sides). The extension executes the expression in the isolated world and binds `__c4gRef(i)` to the live element cached for snapshot index i. (review F5)
- No other protocol changes. Conservation candidate detection keeps using the `role` field (radio/checkbox/textbox); no new fields.

## 4. Module design (packages/host)

### 4.1 capture.ts (online capture)
- `captureFromWs(ws, tabId, opts)`: convergence loop (snapshot → scroll to bottom → element count stable, or ≤4 rounds) → assemble `PageCapture`; `pageText` via `op:'eval'` reading `document.body.innerText` (≤32KB); `progressClaim` extracted by `regex.ts` ("第 x/y 题", "Question x of y", "共 N 题", "x/y"); empty on failure so the LLM can take over.
- `saveCapture/loadCapture`: persist to `data/corpus/<origin>/<captureId>.json` plus `data/corpus/index.json` (runtime corpus, **gitignored**).
- Capture quality gate: conservation is pre-checked at the entrance (an incomplete table is marked defective and never reaches inspect).

### 4.2 inspect/ (core, pure-function orchestration)
```ts
interface InspectDeps { heuristic; llm; jev; log; }   // all injectable mocks
function inspectPage(capture: PageCapture, deps: InspectDeps): Promise<InspectionResult>
function inspectSession(captures: PageCapture[], deps: InspectDeps): Promise<InspectionSession>
```
- `heuristic.ts` (L2): consecutive radios sharing a name = a single-choice group; checkbox groups = multi-choice; the nearest preceding text element (≥6 chars, or ending in ?/？/：) = the stem; an existing Moodle `quizSlot` hint is trusted directly (`source:'hint'`).
  - **Known deviation (review F8, pending protocol support)**: grouping is currently by "consecutive same role" without checking the DOM `name` attribute, because `ElementInfo` does not carry it. Two adjacent questions with contiguous selectors can be merged into one group, and conservation/Jev cannot catch a *consistent* dual-channel error. Tighten once the protocol carries `htmlName?: string`.
- `llm.ts` (L3 enumeration): input is the numbered element table (+ `pageText` fallback); the system prompt forces JSON only — `{questions:[{stemIndex,optionIndices[],inputIndices[]}],navIndices[],excludedIndices[]}`; tolerant parsing reuses the solver's `extractJson`; **validation**: indices exist, groups are disjoint; failure re-feeds the diff for re-enumeration (≤2 rounds); `enabled` shares the solver switch.
- `arbitrate.ts`: every L2/L3 disagreement goes to Jev (`choice`/`noul`); in dry-run all disagreements land in `unclassified`.
- `conservation.ts`: candidate universe = role ∈ {radio,checkbox} ∪ elements with `quizSlot` ∪ textboxes inside the question area; ownership checks, round control, final `unaccounted` list.
- `session.ts`: sort by `capturedAt`; dedupe stems by normalized hash; reconcile `progressClaim` continuity across pages and record mismatches as diagnostics plus a `needsHunt` flag.

### 4.3 recipes.ts + distill.ts (sedimentation)

**L1 read direction (review F5c)**: a stored recipe is only an **accelerator** — it must prove the heuristic grouping on the live page (equal stem count + identical membership) before L2/L3 may be skipped, and it is marked `source:'recipe'`. A larger count means missed questions, so the recipe is rejected and L2 takes over. The conservation audit still runs; integrity is never delegated to a recipe.
- Distillation runs only **after an online inspect completes green**: compute a CSS path per stem element (tag + limited classes, dropping suspicious random tokens `[a-f0-9]{6,}`), find the shortest ancestor prefix shared by ≥80% of them, and write it only when `querySelectorAll(sel).length === stems.length` verifies live (`op:'eval'` probes, selectors escaped per §3); confidence 0.9, discarded when verification fails.
- One recipe file per origin; the L1 hit is verified live in the same way and silently dropped (falling back to L2) when it fails.

### 4.4 timekeeper generic heartbeat detection (observe.ts)
- Install an XHR/fetch ring buffer `window.__c4gXhrRing` (≤200 entries) via CDP (MAIN world); `detectHeartbeat()` clusters by method+path and calls a candidate when it sees ≥4 occurrences, a median period in [5,60]s and a coefficient of variation < 0.35. **Read-only**, never forged. A known pattern (moodle-video) takes the fast path; unknown platforms use detection.

### 4.5 quiz-loop / CLI changes
- quiz-loop consumes `InspectionResult` (the old direct `quizSlot` read is demoted to a hint input); a hunting loop was added (conservation fail or `needsHunt` → scroll/expand → re-capture + re-inspect, ≤2 rounds); the `AUTO_SUBMIT` gate is unchanged.
- New CLI: `inspect [--url SUB | --from FILE] [--learn]`, `corpus list|show <id>`.

## 5. Tests and corpus

- Unit tests: heuristic grouping, three-state conservation, LLM validator (hallucinated indices rejected + re-fed), arbitration mocks, session merge/dedupe, distill selector derivation (needs a DOM; host adds the `linkedom` devDependency), heartbeat clustering.
- Corpus fixtures (committed): `packages/host/test/fixtures/corpus/<case>/capture.json + gold.json`. Three cases: (1) moodle-like (with `.que` hints), (2) generic-radios (pure heuristics), (3) tricky (multi-choice + fill-in + nav noise + collapsed region). `gold` is `QuizQuestionModel[]` referencing `capture.table` indices.
- Source-level guards (same style as the M1 tests): no forged heartbeats, no acceleration, eval-expression allow-list.

## 6. Implementation lanes

P1 protocol+fixtures → P2a capture/recipes/distill ∥ P2b inspect core → P3 integration (quiz-loop/timekeeper/CLI) → P4 independent review. One commit per step.
