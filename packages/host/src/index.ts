import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { CompletionLedger, defaultDataDir, FailedLedger, mergeIntoQueueFile, planNextPass, runBatchLoop, type ScrapeFn } from './batch.js';
import { captureFromWs, defaultCorpusDir, listCaptures, loadCapture, qualityCheck, saveCapture, wsCaptureTransport } from './capture.js';
import { CdpTab } from './cdp.js';
import { distillRecipe } from './distill.js';
import { JeDriver } from './jev.js';
import { log } from './log.js';
import { inspectPage, type InspectDeps } from './inspect/index.js';
import { createJevArbitratorFromEnv } from './inspect/arbitrate.js';
import { createLlmEnumeratorFromEnv } from './inspect/llm.js';
import { defaultRecipesDir, loadRecipe, saveRecipe } from './recipes.js';
import { runQuizLoop } from './quiz-loop.js';
import { QuizSolver } from './solver.js';
import { Timekeeper } from './timekeeper.js';
import * as moodleVideo from './platforms/moodle-video.js';
import { WsBridge } from './ws-server.js';
import { parsePageCapture, type HostConfigPatch, type InspectionResult } from '@c4g/protocol';

const USAGE = `c4g host — unattended LMS supervisor

Usage:
  tsx src/index.ts watch   [--url SUBSTR] [--queue 1,2,3]
  tsx src/index.ts quiz    [--url SUBSTR]
  tsx src/index.ts chain   <courseUrl> [--queue 1,2,3] [--loop] [--max-passes N]
  tsx src/index.ts inspect [--url SUBSTR | --from FILE] [--learn]
  tsx src/index.ts corpus  list | corpus show <captureId>

Commands:
  watch    attach the timekeeper to a matching tab (queue from --queue or course scrape)
  quiz     run the quiz loop once on a matching tab (capture → inspect → answer)
  chain    navigate the tab to a course page, scrape video ids, supervise;
           --loop rescrapes the course after each drain and retries incomplete
           videos until done or --max-passes (default 3) — overnight batch
             completions land in data/completions.json, retry counts in data/failed.json
  inspect  capture + inspect a quiz page (live tab, or a saved capture via --from);
           --learn distills a per-origin recipe when the inspection is green (live only)
  corpus   list saved page captures / show one capture's detail`;

interface CliArgs {
  url?: string;
  queue?: number[];
  from?: string;
  learn?: boolean;
  loop?: boolean;
  maxPasses?: number;
  positional: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') args.url = argv[++i];
    else if (argv[i] === '--queue') args.queue = (argv[++i] ?? '').split(',').map(Number).filter(Number.isFinite);
    else if (argv[i] === '--from') args.from = argv[++i];
    else if (argv[i] === '--learn') args.learn = true;
    else if (argv[i] === '--loop') args.loop = true;
    else if (argv[i] === '--max-passes') args.maxPasses = Math.max(1, Number(argv[++i] ?? 3) || 3);
    else args.positional.push(argv[i]);
  }
  return args;
}

const config = loadConfig();
const jev = new JeDriver(config.typesafeApiKey, log, {
  baseUrl: config.typesafeBaseUrl || undefined,
  model: config.typesafeModel || undefined,
});
const solver = new QuizSolver(config.solverBaseUrl, config.solverApiKey, config.solverModel, log);
// Hoisted so the extension config_sync handler can reconfigure them at runtime.
const arbitrator = createJevArbitratorFromEnv(log);
const inspectDeps: InspectDeps = { llm: createLlmEnumeratorFromEnv(log), arbitrate: arbitrator, log };

if (config.autoSubmit) {
  log('warn', 'AUTO_SUBMIT=true — quiz loop MAY submit attempts. Ensure this is intended.');
}

function pickTabId(urlSubstring: string | undefined): number {
  const tabs = bridge.tabs.filter((t) => t.url.startsWith('http'));
  const match = urlSubstring ? tabs.find((t) => t.url.includes(urlSubstring)) : undefined;
  const tab = match ?? tabs[0];
  if (!tab) throw new Error('no eligible tab found in the extension hello payload');
  log('info', `picked tab ${tab.id}: ${tab.title.slice(0, 60)} — ${tab.url.slice(0, 80)}`);
  return tab.id;
}

const bridge = new WsBridge(log);
// Extension options page pushes endpoint config (full-state sync); blank
// fields fall back to the .env defaults. Never log secrets — models only.
bridge.on('config', (patch: HostConfigPatch) => {
  const pick = (v: string | undefined, fallback: string): string => (v !== undefined && v !== '' ? v : fallback);
  const solverCfg = {
    baseUrl: pick(patch.solverBaseUrl, config.solverBaseUrl),
    apiKey: pick(patch.solverApiKey, config.solverApiKey),
    model: pick(patch.solverModel, config.solverModel),
  };
  const typesafeCfg = {
    baseUrl: pick(patch.typesafeBaseUrl, config.typesafeBaseUrl),
    apiKey: pick(patch.typesafeApiKey, config.typesafeApiKey),
    model: pick(patch.typesafeModel, config.typesafeModel),
  };
  solver.configure(solverCfg);
  inspectDeps.llm.setEndpoint(solverCfg.baseUrl, solverCfg.apiKey, solverCfg.model);
  jev.configure(typesafeCfg);
  arbitrator.configure(typesafeCfg);
  log('info', `config updated from extension (solver model: ${solverCfg.model || '-'} · jev model: ${typesafeCfg.model || 'default'} · solver live: ${solverCfg.apiKey !== ''} · jev live: ${typesafeCfg.apiKey !== ''})`);
});
bridge.on('event', (msg: { kind: string; tabId: number; detail?: string }) => {
  if (msg.kind === 'lms_heartbeat') log('debug', `lms heartbeat on tab ${msg.tabId}${msg.detail ? `: ${msg.detail.slice(0, 100)}` : ''}`);
});
bridge.on('log', (msg: { level: string; msg: string }) => log(msg.level as never, `[ext] ${msg.msg}`));

function printInspection(result: InspectionResult): void {
  log('info', `inspection ${result.captureId}: conservation=${result.conservation.status} questions=${result.questions.length} nav=[${result.navIndices.join(', ')}]`);
  for (const q of result.questions) {
    log('info', `  #${q.stemIndex} [${q.source} ×${q.confidence.toFixed(2)}] ${q.stem.slice(0, 70)} — options [${q.optionIndices.join(', ')}]${q.inputIndices.length ? ` inputs [${q.inputIndices.join(', ')}]` : ''}${q.answered ? ' (answered)' : ''}`);
  }
  if (result.excluded.length > 0) log('info', `  excluded: ${result.excluded.map((e) => `#${e.index}(${e.reason})`).join(', ')}`);
  console.log(JSON.stringify(result, null, 2));
}

/** Offline: inspect a saved capture JSON. No Chrome/extension needed. */
async function inspectFromFile(file: string): Promise<void> {
  const capture = parsePageCapture(JSON.parse(readFileSync(file, 'utf8')));
  const quality = qualityCheck(capture);
  if (quality.defective) {
    log('error', `capture ${capture.captureId} is defective — refusing to inspect: ${quality.defects.join('; ')}`);
    process.exit(1);
  }
  const result = await inspectPage(capture, inspectDeps);
  printInspection(result);
}

/** Offline: corpus bookkeeping. */
async function corpusCmd(args: CliArgs): Promise<void> {
  const dir = defaultCorpusDir();
  const sub = args.positional[0] ?? 'list';
  if (sub === 'list') {
    const all = listCaptures(dir);
    if (all.length === 0) {
      console.log('corpus is empty — run `inspect --url <tab>` to add captures');
      return;
    }
    for (const c of all) {
      console.log(`${c.defective ? '✗' : '✓'} ${c.captureId}  ${new Date(c.capturedAt).toISOString()}  ${c.origin}${c.defective ? `  defects: ${c.defects.join('; ')}` : ''}`);
      console.log(`    ${c.url.slice(0, 100)}`);
    }
    return;
  }
  if (sub === 'show') {
    const id = args.positional[1];
    if (!id) {
      console.error('corpus show requires a captureId');
      process.exit(1);
    }
    const capture = loadCapture(dir, id);
    if (!capture) {
      console.error(`capture ${id} not found in corpus`);
      process.exit(1);
    }
    console.log(JSON.stringify({ ...capture, table: { ...capture.table, elements: `${capture.table.elements.length} elements` } }, null, 2));
    return;
  }
  console.error(`unknown corpus subcommand: ${sub}`);
  process.exit(1);
}

/** Set by chain --loop; the shared SIGINT handler flushes batch state before exit. */
let persistOnShutdown: (() => void) | null = null;

/**
 * chain --loop: overnight batch supervisor. Passes = course rescrape + ledger
 * diff; each video runs to a terminal WatchOutcome under real 1x playback.
 * Completions land in data/completions.json, retry counts in data/failed.json
 * (exhausted videos are skipped by later passes). No queue item is ever
 * started twice within a run.
 */
async function runChainLoop(args: CliArgs, courseUrl: string, live: { tabId: number; cdp: CdpTab }): Promise<void> {
  const dataDir = defaultDataDir();
  const ledger = new CompletionLedger(join(dataDir, 'completions.json'));
  const failed = new FailedLedger(join(dataDir, 'failed.json'));
  ledger.load();
  failed.load();
  const queueFile = join(dataDir, 'queue.json');

  // Scrape is read-only: navigate the tab to the course page and list video ids.
  const scrape: ScrapeFn = async (url) => {
    await live.cdp.navigate(url);
    const ids = await moodleVideo.scrapeCourseVideoIds(live.cdp);
    return ids.map((id) => ({ url: `/mod/fsresource/view.php?id=${id}`, resourceId: id }));
  };

  persistOnShutdown = () => {
    ledger.flush();
    failed.flush();
  };

  // F1 (review): ONE supervisor for the whole run. The timekeeper's interval
  // auto-chains through the persisted queue, so per-item instances would race
  // the same tab (duplicate resume clicks, racy navigations, misattributed
  // failures). Sequential watch() on a single instance short-circuits via the
  // in-memory done set instead.
  const timekeeper = new Timekeeper({ tabId: live.tabId, cdp: live.cdp, ws: bridge, jev, platform: moodleVideo, log });
  await runBatchLoop({
    maxPasses: args.maxPasses ?? 3,
    plan: async () => {
      const planned = await planNextPass({ courseUrl, scrape, ledger, failed });
      if (planned.length > 0) {
        mergeIntoQueueFile(
          queueFile,
          planned.map((item) => Number(item.resourceId)).filter(Number.isFinite),
        );
      }
      return planned;
    },
    watch: (id) => timekeeper.watch(id),
    ledger,
    failed,
    log,
  });
  timekeeper.stop();
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    process.exit(cmd ? 0 : 1);
  }
  const args = parseArgs(rest);

  // Offline commands — no Chrome/extension required.
  if (cmd === 'corpus') {
    await corpusCmd(args);
    return;
  }
  if (cmd === 'inspect' && args.from) {
    await inspectFromFile(args.from);
    return;
  }

  // Live commands — bridge + CDP attach.
  await bridge.start(config.hostPort);
  await bridge.waitHello();
  const tabId = pickTabId(args.url);
  const cdp = await CdpTab.connect(config.chromeDebugPort, args.url ?? '');
  log('info', `cdp attached to target ${cdp.targetId}`);

  const cleanup = (): void => {
    bridge.close();
    cdp.close();
  };
  // chain --loop flushes batch ledgers here before the process exits (130 = SIGINT).
  process.once('SIGINT', () => {
    log('info', 'shutting down…');
    persistOnShutdown?.();
    cleanup();
    process.exit(persistOnShutdown ? 130 : 0);
  });

  switch (cmd) {
    case 'watch':
    case 'chain': {
      if (cmd === 'chain') {
        const courseUrl = args.positional[0];
        if (!courseUrl) {
          console.error('chain requires a course URL');
          process.exit(1);
        }
        await cdp.navigate(courseUrl);
        if (args.loop) {
          await runChainLoop(args, courseUrl, { tabId, cdp });
          break;
        }
      }
      let queue = args.queue;
      if (!queue || queue.length === 0) {
        const currentUrl = await cdp.url();
        if (moodleVideo.isCoursePage(currentUrl)) {
          queue = await moodleVideo.scrapeCourseVideoIds(cdp);
          log('info', `scraped ${queue.length} video ids from course page: [${queue.slice(0, 10).join(', ')}${queue.length > 10 ? ', …' : ''}]`);
        } else {
          console.error('no --queue given and current page is not a course page (cannot scrape video ids)');
          process.exit(1);
        }
      }
      const timekeeper = new Timekeeper({ tabId, cdp, ws: bridge, jev, platform: moodleVideo, log });
      timekeeper.start(queue);
      break;
    }
    case 'quiz': {
      await moodleVideo.installHeartbeatHook(cdp).catch(() => log('debug', 'heartbeat hook not installed (not an LMS page?)'));
      const l1 = bridge.status().connected
        ? {
            recipeFor: (origin: string) => loadRecipe(defaultRecipesDir(), origin),
            evalJson: async (expression: string) => {
              try {
                return await bridge.evalJson(tabId, expression);
              } catch {
                return null;
              }
            },
          }
        : undefined;
      const report = await runQuizLoop(
        { ws: bridge, solver, inspect: { ...inspectDeps, l1 }, log, autoSubmit: config.autoSubmit },
        tabId,
      );
      log('info', `quiz loop finished: ${JSON.stringify(report)}`);
      cleanup();
      break;
    }
    case 'inspect': {
      const capture = await captureFromWs(wsCaptureTransport(bridge, tabId), { includePageText: true });
      const quality = saveCapture(defaultCorpusDir(), capture);
      log('info', `capture ${capture.captureId} saved to corpus${quality.defective ? ` — DEFECTIVE: ${quality.defects.join('; ')}` : ''}`);
      if (quality.defective) {
        log('error', 'defective capture — refusing to inspect');
        cleanup();
        process.exit(1);
      }
      const result = await inspectPage(capture, {
        ...inspectDeps,
        ...(bridge.status().connected
          ? {
              l1: {
                recipeFor: (origin: string) => loadRecipe(defaultRecipesDir(), origin),
                evalJson: async (expression: string) => {
                  try {
                    return await bridge.evalJson(tabId, expression);
                  } catch {
                    return null;
                  }
                },
              },
            }
          : {}),
      });
      printInspection(result);
      if (args.learn) {
        if (result.conservation.status !== 'pass') {
          log('warn', '--learn skipped: inspection is not green');
        } else {
          // Distill probes must run in the extension's isolated world where
          // __c4gRef(i) resolves live elements for snapshot indices (review
          // F5). CDP MAIN-world evaluation has no ref cache and can never
          // resolve ancestries — kept only as a disconnected fallback.
          const evalJson = bridge.status().connected
            ? async (expression: string) => bridge.evalJson(tabId, expression)
            : async (expression: string) => cdp.evaluate<unknown>(expression);
          const outcome = await distillRecipe({ capture, result, evalJson });
          if (outcome.recipe) {
            saveRecipe(defaultRecipesDir(), outcome.recipe);
            log('info', `recipe distilled for ${capture.origin}: question=${outcome.recipe.questionSelector ?? '-'}${outcome.recipe.optionSelector ? ` option=${outcome.recipe.optionSelector}` : ''}`);
          } else {
            log('warn', `recipe distillation skipped: ${outcome.reason ?? 'unknown reason'}`);
          }
        }
      }
      cleanup();
      break;
    }
    default:
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  log('error', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
