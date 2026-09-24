/**
 * Recipe store (design §4.3, L1 cache): per-origin distilled selector recipes
 * in data/recipes/<origin>.json. L1 is an accelerator only — inspect must
 * live-verify any recipe and fall back to L2/L3 when it fails.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuizRecipe, type QuizRecipe } from '@c4g/protocol';

const HERE = dirname(fileURLToPath(import.meta.url));

export function defaultRecipesDir(): string {
  return resolve(HERE, '..', 'data', 'recipes');
}

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


