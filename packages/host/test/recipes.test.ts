import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { QuizRecipe } from '@c4g/protocol';
import { deleteRecipe, loadRecipe, saveRecipe } from '../src/recipes.js';

const tmpDirs: string[] = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpRecipes(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c4g-recipes-'));
  tmpDirs.push(dir);
  return dir;
}

function recipe(origin: string, overrides: Partial<QuizRecipe> = {}): QuizRecipe {
  return {
    origin,
    questionSelector: 'div.quiz-item > p.qtext',
    learnedVia: 'distill',
    confidence: 0.9,
    updatedAt: 1758200002000,
    ...overrides,
  };
}

describe('recipe store', () => {
  it('save/load roundtrip', () => {
    const dir = tmpRecipes();
    const r = recipe('https://exam.example.com');
    saveRecipe(dir, r);
    const loaded = loadRecipe(dir, 'https://exam.example.com');
    assert.deepEqual(loaded, r);
  });

  it('unknown origin → null', () => {
    const dir = tmpRecipes();
    assert.equal(loadRecipe(dir, 'https://never-seen.example'), null);
  });

  it('corrupt JSON → null (never throws)', () => {
    const dir = tmpRecipes();
    writeFileSync(join(dir, 'broken.example.json'), '{not json');
    assert.equal(loadRecipe(dir, 'https://broken.example'), null);
  });

  it('schema-invalid recipes are rejected on load', () => {
    const dir = tmpRecipes();
    writeFileSync(
      join(dir, 'invalid.example.json'),
      JSON.stringify({ origin: 'https://invalid.example', learnedVia: 'hand-written', confidence: 0.9 }),
    );
    assert.equal(loadRecipe(dir, 'https://invalid.example'), null);
  });

  it('invalid recipes are rejected before hitting disk on save', () => {
    const dir = tmpRecipes();
    assert.throws(() =>
      saveRecipe(dir, recipe('https://x.example', { learnedVia: 'guess' as never, confidence: 0.9 })),
    );
    assert.equal(loadRecipe(dir, 'https://x.example'), null);
  });

  it('origin-safe filenames and deleteRecipe', () => {
    const dir = tmpRecipes();
    saveRecipe(dir, recipe('https://weird origin.example/path'));
    const loaded = loadRecipe(dir, 'https://weird origin.example/path');
    assert.ok(loaded);
    assert.equal(deleteRecipe(dir, 'https://weird origin.example/path'), true);
    assert.equal(loadRecipe(dir, 'https://weird origin.example/path'), null);
    assert.equal(deleteRecipe(dir, 'https://gone.example'), false);
  });
});

