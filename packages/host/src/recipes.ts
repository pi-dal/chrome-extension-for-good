/**
 * Recipe store (design §4.3, L1 cache): per-origin distilled selector recipes
 * in data/recipes/<origin>.json. L1 is an accelerator only — inspect must
 * live-verify any recipe and fall back to L2/L3 when it fails.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuizRecipe, type QuizRecipe } from '@c4g/protocol';
import { buildCountProbeExpression } from './distill.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export function defaultRecipesDir(): string {
  return resolve(HERE, '..', 'data', 'recipes');
}

/** Host-injected evaluator for op:'eval' probes; null when the page is gone. */
export type EvalJsonFn = (expression: string) => Promise<unknown | null>;

function recipeFile(dir: string, origin: string): string {
  // strip the scheme so files read exam.example.com.json, then sanitize
  const safe = origin
    .replace(/^https?:\/\//, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error(`unusable origin: ${origin}`);
  return join(dir, `${safe}.json`);
}

export function saveRecipe(dir: string, recipe: QuizRecipe): void {
  // Round-trip through the parser so invalid recipes can never reach disk.
  const validated = parseQuizRecipe(recipe);
  const file = recipeFile(dir, recipe.origin);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(validated, null, 2));
}

/** Returns null for missing, corrupt, or schema-invalid recipes — never throws. */
export function loadRecipe(dir: string, origin: string): QuizRecipe | null {
  try {
    return parseQuizRecipe(JSON.parse(readFileSync(recipeFile(dir, origin), 'utf8')));
  } catch {
    return null;
  }
}

export function deleteRecipe(dir: string, origin: string): boolean {
  try {
    rmSync(recipeFile(dir, origin));
    return true;
  } catch {
    return false;
  }
}

export interface RecipeExpectation {
  /** Number of question-stem elements the inspection found on the live page. */
  questions: number;
}

export interface RecipeVerification {
  valid: boolean;
  counts: { questionSelector: number | null; optionSelector: number | null };
  reasons: string[];
}

/**
 * Live-verify a recipe against the current page: questionSelector must match
 * EXACTLY the inspected stem count (over- or under-matching both fail — a
 * recipe that highlights ads as questions is as broken as one that misses
 * questions). optionSelector, when present, must match at least one option
 * per question.
 */
export async function verifyRecipe(
  evalJson: EvalJsonFn,
  recipe: QuizRecipe,
  expected: RecipeExpectation,
): Promise<RecipeVerification> {
  const counts: RecipeVerification['counts'] = { questionSelector: null, optionSelector: null };
  const reasons: string[] = [];

  if (!recipe.questionSelector) {
    reasons.push('recipe has no questionSelector');
    return { valid: false, counts, reasons };
  }

  const qCount = await evalJson(buildCountProbeExpression(recipe.questionSelector));
  counts.questionSelector = typeof qCount === 'number' ? qCount : null;
  if (counts.questionSelector === null) {
    reasons.push('questionSelector probe failed (page gone or eval unavailable)');
  } else if (counts.questionSelector !== expected.questions) {
    reasons.push(
      `questionSelector matched ${counts.questionSelector} elements, expected exactly ${expected.questions}`,
    );
  }

  if (recipe.optionSelector) {
    const oCount = await evalJson(buildCountProbeExpression(recipe.optionSelector));
    counts.optionSelector = typeof oCount === 'number' ? oCount : null;
    if (counts.optionSelector === null) {
      reasons.push('optionSelector probe failed');
    } else if (counts.optionSelector < expected.questions) {
      reasons.push(
        `optionSelector matched ${counts.optionSelector} elements, expected at least ${expected.questions}`,
      );
    }
  }

  return { valid: reasons.length === 0, counts, reasons };
}
