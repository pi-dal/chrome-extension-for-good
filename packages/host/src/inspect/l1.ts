/**
 * L1 recipe confirmation (design §4.3, review F5c): a stored recipe only ever
 * ACCELERATES a grouping — it must confirm the cheap heuristic grouping
 * element-for-element on the live page before the pipeline may skip L2/L3.
 * Completeness is never delegated to the recipe: the conservation audit still
 * runs on the confirmed grouping, and any mismatch (count or membership)
 * discards the recipe for this visit and falls back to L2.
 *
 * SECURITY (design §3): selectors are grammar-whitelisted and JSON-escaped
 * host-side (assertSafeSelector / buildCountProbeExpression); probes execute
 * in the extension's isolated world where `__c4gRef(i)` resolves the live
 * element cached for snapshot index i.
 */

import type { ElementTable, QuizRecipe } from '@c4g/protocol';
import { assertSafeSelector, buildCountProbeExpression } from '../distill.js';
import { heuristicGroup } from './heuristic.js';

export interface L1Deps {
  recipeFor(origin: string): Promise<QuizRecipe | null> | QuizRecipe | null;
  evalJson(expression: string): Promise<unknown | null>;
}

/**
 * indices.map(i => __c4gRef(i)?.matches(selector) ? 1 : 0) as a probe expression.
 *
 * CONTRACT: the expression evaluates to an ARRAY of 0/1. The transport already
 * serializes the page's value, so a JSON.stringify wrapper here would hand the
 * consumers a string and silently break membership confirmation.
 */
export function buildMembershipProbeExpression(selector: string, indices: number[]): string {
  const safe = assertSafeSelector(selector);
  return (
    `${JSON.stringify(indices)}.map(function(i){` +
    `var el=(typeof __c4gRef==="function"?__c4gRef(i):null)||null;` +
    `return el&&el.matches?el.matches(${JSON.stringify(safe)})?1:0:0;})`
  );
}

export interface L1Verdict {
  ok: boolean;
  reason?: string;
}

/**
 * Confirm a recipe against the live page AND the heuristic grouping:
 * question selector must match exactly the heuristic stem count (a larger
 * count means missed questions — reject), every stem must be a member, and
 * likewise for the option selector when present.
 */
export async function confirmRecipe(
  table: ElementTable,
  recipe: QuizRecipe,
  evalJson: (expression: string) => Promise<unknown | null>,
  heuristic: ReturnType<typeof heuristicGroup>,
): Promise<L1Verdict> {
  if (!recipe.questionSelector) return { ok: false, reason: 'recipe has no questionSelector' };
  const stems = heuristic.questions.map((q) => q.stemIndex);
  if (stems.length === 0) return { ok: false, reason: 'no heuristic stems to confirm' };
  try {
    const count = await evalJson(buildCountProbeExpression(recipe.questionSelector));
    if (count !== stems.length) {
      return { ok: false, reason: `question selector matched ${String(count)} elements, heuristic saw ${stems.length}` };
    }
    const flags = await evalJson(buildMembershipProbeExpression(recipe.questionSelector, stems));
    if (!Array.isArray(flags) || flags.length !== stems.length || flags.some((f) => f !== 1)) {
      return { ok: false, reason: 'stem membership mismatch' };
    }
    if (recipe.optionSelector) {
      const options = heuristic.questions.flatMap((q) => q.optionIndices);
      if (options.length > 0) {
        const oCount = await evalJson(buildCountProbeExpression(recipe.optionSelector));
        if (oCount !== options.length) {
          return { ok: false, reason: `option selector matched ${String(oCount)} elements, expected ${options.length}` };
        }
        const oFlags = await evalJson(buildMembershipProbeExpression(recipe.optionSelector, options));
        // Length matters as much as content: a truncated probe returning
        // [1,1] for 5 options must NOT pass — every option must be verified.
        if (!Array.isArray(oFlags) || oFlags.length !== options.length || oFlags.some((f) => f !== 1)) {
          return { ok: false, reason: 'option membership mismatch' };
        }
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
