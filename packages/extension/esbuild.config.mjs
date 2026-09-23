import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

// MV3 service worker — ESM, chrome.* stays external (runtime global).
await build({
  entryPoints: ['src/background.ts'],
  outfile: 'dist/background.js',
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  external: ['chrome'],
  logLevel: 'info',
});

// Content script — isolated world, IIFE.
await build({
  entryPoints: ['src/content.ts'],
  outfile: 'dist/content.js',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  logLevel: 'info',
});

// Options page — plain page script (IIFE); imports the protocol validator so
// plugin JSON is checked in the UI before it is ever pushed to the host.
await build({
  entryPoints: ['src/options.ts'],
  outfile: 'dist/options.js',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  logLevel: 'info',
});

cpSync('public', 'dist', { recursive: true });
console.log('[c4g-extension] dist ready');
