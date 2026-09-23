/**
 * Recipe distillation (design §4.3): after a fully-green inspection, derive a
 * CSS selector recipe from the verified question/option elements so the next
 * visit to this origin skips L2/L3 entirely.
 *
 * SECURITY (design §3): every selector passes a grammar whitelist and is
 * JSON-escaped into a `document.querySelectorAll(...)` probe. Model output is
 * never executed as JavaScript — a distilled selector can only ever match
 * elements, never run.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InspectionResult, PageCapture, QuizRecipe } from '@c4g/protocol';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// selector grammar policy (§3)
// ---------------------------------------------------------------------------

const SELECTOR_MAX_LEN = 300;
/** Grammar whitelist: CSS simple-selector vocabulary only. */
const SAFE_SELECTOR_RE = /^[A-Za-z0-9_\-\s\.,#>:~^\|\$\+\*\=\]\["'\(\)\[\]]+$/;

/**
 * Validate a selector for use inside an eval probe. Throws on anything that is
 * not plain CSS-selector vocabulary (design §3: no `;`, no `//`, no backticks,
 * length ≤ 300).
 */
export function assertSafeSelector(selector: string): string {
  if (selector.length === 0) throw new Error('empty selector');
  if (selector.length > SELECTOR_MAX_LEN) throw new Error(`selector longer than ${SELECTOR_MAX_LEN} chars`);
  if (!SAFE_SELECTOR_RE.test(selector)) throw new Error(`selector fails grammar whitelist: ${selector}`);
  if (selector.includes(';') || selector.includes('`') || selector.includes('//')) {
    throw new Error(`selector contains forbidden sequence: ${selector}`);
  }
  return selector;
}

/** Probe expression returning the match count of a (validated) selector. */
export function buildCountProbeExpression(selector: string): string {
  const safe = assertSafeSelector(selector);
  // JSON.stringify(safe) yields a JS string literal — quotes escaped, so the
  // selector can never terminate the literal and inject code.
  //
  // CONTRACT: the expression evaluates to a NUMBER. The transport already
  // serializes whatever the page returns (content.ts JSON.stringify → host
  // JSON.parse), so wrapping it here would double-encode and hand consumers the
  // string "3" instead of 3 — every count comparison would then fail silently.
  return `document.querySelectorAll(${JSON.stringify(safe)}).length`;
}

// ---------------------------------------------------------------------------
// ancestry model
// ---------------------------------------------------------------------------

export interface AncestryNode {
  tag: string;
  classes: string[];
}

/** root → … → element inclusive; null when the element cannot be resolved. */
export interface AncestrySource {
  ancestryOf(elementIndex: number): AncestryNode[] | null;
}

const RANDOM_TOKEN_RE = /[a-f0-9]{6,}/i;
const MAX_CLASSES_PER_NODE = 3;
const DEFAULT_MAX_DEPTH = 8;

/** Strip build-tool hash classes (`abc12f`, `css-xyz123`) — never stable. */
export function stableClasses(classes: string[]): string[] {
  return classes.filter((c) => c.length > 0 && !RANDOM_TOKEN_RE.test(c)).slice(0, MAX_CLASSES_PER_NODE);
}

export function nodePart(node: AncestryNode): string {
  const cls = stableClasses(node.classes).map((c) => `.${c}`).join('');
  return `${node.tag}${cls}`;
}

export interface DerivedSelector {
  selector: string;
  /** k = elements' own node (k=1) or (k-1)-th ancestor, shared across stems. */
  depth: number;
  /** fraction of stems sharing the selector at this depth (≥ 0.8). */
  coverage: number;
}

/**
 * Find the nearest-ancestor part shared by ≥80% of the given elements
 * (design §4.3 "≥80% 共享的最短祖先前缀"). Discriminating power is enforced
 * afterwards by the live count verification, not here.
 */
export function deriveSelector(
  elementIndices: number[],
  source: AncestrySource,
  opts: { minCoverage?: number; maxDepth?: number } = {},
): DerivedSelector | null {
  const minCoverage = opts.minCoverage ?? 0.8;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (elementIndices.length === 0) return null;

  const chains = elementIndices.map((i) => source.ancestryOf(i));
  if (chains.some((c) => c === null || c.length === 0)) return null;

  const n = elementIndices.length;
  let best: DerivedSelector | null = null;
  for (let k = 1; k <= maxDepth; k++) {
    const counts = new Map<string, number>();
    for (const chain of chains as AncestryNode[][]) {
      const node = chain[chain.length - k];
      if (!node) continue; // this stem is shallower than k; it can't share
      const part = nodePart(node);
      counts.set(part, (counts.get(part) ?? 0) + 1);
    }
    for (const [part, count] of counts) {
      const coverage = count / n;
      if (coverage >= minCoverage) {
        // minimal depth wins; equal depth → higher coverage
        if (!best || k < best.depth || (k === best.depth && coverage > best.coverage)) {
          best = { selector: part, depth: k, coverage };
        }
      }
    }
    if (best && best.depth <= k) break; // nearest shared depth found
  }
  return best;
}

// ---------------------------------------------------------------------------
// live ancestry source via the __c4gRef convention
// ---------------------------------------------------------------------------

/**
 * The extension's eval scope is expected to expose `window.__c4gRef(i)` → the
 * live element cached for snapshot index i (integration lane wires this from
 * the content-script ref cache). Returns null-based results per index when the
 * convention is absent, so callers degrade instead of failing.
 */
export function ancestryProbeExpression(elementIndices: number[]): string {
  const idx = JSON.stringify(elementIndices);
  return (
    `JSON.stringify(${idx}.map(function(i){` +
    `var el=(window.__c4gRef&&window.__c4gRef(i))||null;if(!el)return null;` +
    `var out=[],n=el,d=0;while(n&&d<${DEFAULT_MAX_DEPTH}){` +
    `out.push({tag:n.tagName.toLowerCase(),classes:Array.from(n.classList||[])});` +
    `n=n.parentElement;d++;}` +
    `out.reverse();return out;}))`  // contract order: root → … → element
  );
}

/**
 * Batch-prefetch ancestries for all indices, then answer synchronously — the
 * derivation itself stays pure and fully unit-testable.
 */
export async function prefetchAncestrySource(
  evalJson: (expression: string) => Promise<unknown | null>,
  elementIndices: number[],
): Promise<AncestrySource> {
  const unique = [...new Set(elementIndices)];
  let raw: unknown = null;
  try {
    raw = await evalJson(ancestryProbeExpression(unique));
  } catch {
    raw = null;
  }
  const map = new Map<number, AncestryNode[] | null>();
  if (Array.isArray(raw) && raw.length === unique.length) {
    unique.forEach((idx, i) => {
      const chain = raw[i];
      if (Array.isArray(chain) && chain.every((n) => n && typeof (n as AncestryNode).tag === 'string')) {
        map.set(idx, chain as AncestryNode[]);
      } else {
        map.set(idx, null);
      }
    });
  } else {
    for (const idx of unique) map.set(idx, null);
  }
  return { ancestryOf: (i) => map.get(i) ?? null };
}

// ---------------------------------------------------------------------------
// recipe assembly
// ---------------------------------------------------------------------------

/** Confidence assigned to a live-verified distilled recipe (design §4.3). */
export const DISTILLED_CONFIDENCE = 0.9;

export interface DistillOutcome {
  recipe: QuizRecipe | null;
  reason?: string;
  questionSelector?: string;
  optionSelector?: string;
}

/**
 * Distill a recipe from a green inspection result using prefetched ancestries.
 * `liveCounts` (probe results) decide acceptance: question selector must match
 * exactly the stem count, option selector (best effort) exactly the option
 * count; otherwise no recipe is written — never a half-verified one.
 */
export async function distillRecipe(input: {
  capture: PageCapture;
  result: InspectionResult;
  evalJson: (expression: string) => Promise<unknown | null>;
}): Promise<DistillOutcome> {
  const { capture, result, evalJson } = input;
  if (result.conservation.status !== 'pass') {
    return { recipe: null, reason: 'inspection not green (conservation failed)' };
  }
  const stemIndices = result.questions.map((q) => q.stemIndex);
  if (stemIndices.length === 0) return { recipe: null, reason: 'no questions to distill from' };

  const optionIndices = result.questions.flatMap((q) => q.optionIndices);
  const source = await prefetchAncestrySource(
    evalJson,
    stemIndices.concat(optionIndices),
  );

  const q = deriveSelector(stemIndices, source);
  if (!q) return { recipe: null, reason: 'no ancestor part shared by ≥80% of stems' };

  const qCount = await evalJson(buildCountProbeExpression(q.selector));
  if (qCount !== stemIndices.length) {
    return {
      recipe: null,
      reason: `question selector matched ${String(qCount)} elements, expected ${stemIndices.length} — discarded`,
      questionSelector: q.selector,
    };
  }

  let optionSelector: string | undefined;
  if (optionIndices.length > 0) {
    const o = deriveSelector(optionIndices, source);
    if (o) {
      const oCount = await evalJson(buildCountProbeExpression(o.selector));
      if (oCount === optionIndices.length) optionSelector = o.selector;
    }
  }

  const recipe: QuizRecipe = {
    origin: capture.origin,
    questionSelector: q.selector,
    ...(optionSelector !== undefined ? { optionSelector } : {}),
    learnedVia: 'distill',
    confidence: DISTILLED_CONFIDENCE,
    updatedAt: Date.now(),
  };
  return { recipe, questionSelector: q.selector, optionSelector };
}

export function defaultRecipesDir(): string {
  return resolve(HERE, '..', 'data', 'recipes');
}
