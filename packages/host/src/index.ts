import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { CompletionLedger, batchSummaryLine, defaultDataDir, FailedLedger, mergeIntoQueueFile, planNextPass, runBatchLoop, type ScrapeFn } from './batch.js';
import { captureFromWs, defaultCorpusDir, listCaptures, loadCapture, qualityCheck, saveCapture, wsCaptureTransport } from './capture.js';
import { CdpTab, connectToMarker, connectToNewPage, listPageTargetIds } from './cdp.js';
import { distillRecipe } from './distill.js';
import { JeDriver } from './jev.js';
import { log } from './log.js';
import { inspectPage, type InspectDeps } from './inspect/index.js';
import {
  applyQuizScope,
  emptyAppliedHints,
  hintSummaryLine,
  mergeNavLabels,
  readProgressHint,
  type AppliedHints,
} from './inspect/plugin-hints.js';
import { createJevArbitratorFromEnv } from './inspect/arbitrate.js';
import { createLlmEnumeratorFromEnv } from './inspect/llm.js';
import { defaultRecipesDir, loadRecipe, saveRecipe } from './recipes.js';
import { runQuizLoop } from './quiz-loop.js';
import { QuizSolver } from './solver.js';
import {
  decideForge,
  defaultReportProbeFile,
  entryFromGiveUp,
  entryFromVerdict,
  forgeSummaryLine,
  makeForgeDriver,
  probeReportAcceptance,
  ReportProbeStore,
  type ForgeDecision,
  type ForgeDriver,
} from './forge.js';
import { probeCreditSpeed, type ProbeCdp, type SpeedProbeResult } from './speed-probe.js';
import {
  clampRate,
  decideRate,
  defaultSpeedPolicyFile,
  originOf,
  rateSummaryLine,
  SpeedPolicyStore,
  type RateDecision,
  type SpeedPolicyEntry,
} from './speed-policy.js';
import { applyLanePolicy, planSwarmLanes, provisionLanes, startSwarm, swarmNonce, type SwarmLane } from './swarm.js';
import { Timekeeper } from './timekeeper.js';
import {
  defaultPluginsDir,
  loadPluginFiles,
  makeDynamicPlatform,
  PlatformRegistry,
} from './platforms/registry.js';
import type { ForgeCdp } from './forge.js';
import type { PlatformAdapter } from './platforms/plugin.js';
import { WsBridge } from './ws-server.js';
import {
  parsePageCapture,
  type HostConfigPatch,
  type InspectionResult,
  type PageCapture,
  type SitePlugin,
} from '@c4g/protocol';

const USAGE = `c4g host — unattended LMS supervisor

Usage:
  tsx src/index.ts watch   [--url SUBSTR] [--queue 1,2,3]
  tsx src/index.ts quiz    [--url SUBSTR]
  tsx src/index.ts chain   <courseUrl> [--queue 1,2,3] [--loop] [--max-passes N]
  tsx src/index.ts chain   <courseUrl> --loop --swarm N [--swarm-mute] [--swarm-keep-tabs]
  tsx src/index.ts speed-probe [--url SUBSTR] [--rate R] [--window SECONDS] [--keep-rate]
  tsx src/index.ts report-probe [--url SUBSTR] [--to-end] [--position SECONDS]
  tsx src/index.ts inspect [--url SUBSTR | --from FILE] [--learn]
  tsx src/index.ts corpus  list | corpus show <captureId>

Report replay (秒过 / 加速上报 — any supervising command):
  --forge         replay the platform's own heartbeat with the position field
                  rewritten, one report per tick. Gated on measurement: run
                  report-probe first (ONE report, ~30s) — an "ignored" verdict
                  means the backend caps credit by wall clock and forging buys
                  nothing, so it stays off. --forge-force overrides (logged).
  --forge-to-end  claim the whole remaining duration per report (秒过) instead
                  of --forge-step seconds (default 60).
  --forge-stalls  disable replay after N reports whose ack did not move (default 2).

Playback rate (any supervising command):
  --rate R        R>1 is a user choice GATED on measurement: without a fresh
                  data/speed-policy.json entry the host probes the first video
                  (~2×--window seconds) and then honours or refuses R by what it
                  measured. --rate-force overrides the refusal (logged).
  --window N      seconds per probe phase (default 60).

Commands:
  watch    attach the timekeeper to a matching tab (queue from --queue or course scrape)
  quiz     run the quiz loop once on a matching tab (capture → inspect → answer)
  speed-probe  measure whether the backend credits faster playback: 1x baseline
           vs --rate R over --window seconds each, verdict + evidence written to
           data/speed-policy.json (read-only observation; rate restored after)
  report-probe measure whether a REPLAYED heartbeat is credited: one report at
           --position (or the full duration with --to-end), then the server's own
           ack decides. Verdict lands in data/report-probe.json and gates --forge
  chain    navigate the tab to a course page, scrape video ids, supervise;
           --loop rescrapes the course after each drain and retries incomplete
           videos until done or --max-passes (default 3) — overnight batch
             completions land in data/completions.json, retry counts in data/failed.json
           --swarm N supervises N videos concurrently, one tab per lane (each
           lane still plays at real 1x); auto-degrades to one lane if the
           platform shows its concurrent-playback warning (data/swarm-flag.json)
  inspect  capture + inspect a quiz page (live tab, or a saved capture via --from);
           --learn distills a per-origin recipe when the inspection is green (live only)
  corpus   list saved page captures / show one capture's detail

Site plugins (platform adapters): the built-in LMS plugin is a template — paste
your own JSON in the extension options page (站点插件) or drop it into
data/plugins/*.json; both are merged over the built-ins by id (see
docs/m5-site-plugins.md).`;

interface CliArgs {
  url?: string;
  queue?: number[];
  from?: string;
  learn?: boolean;
  loop?: boolean;
  maxPasses?: number;
  swarm?: number;
  swarmMute?: boolean;
  swarmKeepTabs?: boolean;
  rate?: number;
  rateForce?: boolean;
  keepRate?: boolean;
  windowSeconds?: number;
  forge?: boolean;
  forgeForce?: boolean;
  forgeToEnd?: boolean;
  forgeStep?: number;
  forgeStalls?: number;
  toEnd?: boolean;
  position?: number;
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
    else if (argv[i] === '--swarm') args.swarm = Number(argv[++i] ?? 2) || 2;
    else if (argv[i] === '--swarm-mute') args.swarmMute = true;
    else if (argv[i] === '--swarm-keep-tabs') args.swarmKeepTabs = true;
    else if (argv[i] === '--rate') args.rate = clampRate(Number(argv[++i] ?? 1));
    else if (argv[i] === '--rate-force') args.rateForce = true;
    else if (argv[i] === '--keep-rate') args.keepRate = true;
    else if (argv[i] === '--window') args.windowSeconds = Math.max(20, Number(argv[++i] ?? 60) || 60);
    else if (argv[i] === '--forge') args.forge = true;
    else if (argv[i] === '--forge-force') args.forgeForce = true;
    else if (argv[i] === '--forge-to-end') args.forgeToEnd = true;
    else if (argv[i] === '--forge-step') args.forgeStep = Math.max(5, Number(argv[++i] ?? 60) || 60);
    else if (argv[i] === '--forge-stalls') args.forgeStalls = Math.max(1, Number(argv[++i] ?? 2) || 2);
    else if (argv[i] === '--to-end') args.toEnd = true;
    else if (argv[i] === '--position') args.position = Math.max(0, Number(argv[++i] ?? 0) || 0);
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
  if (urlSubstring) {
    const match = tabs.find((t) => t.url.includes(urlSubstring));
    if (!match) {
      throw new Error(
        `--url "${urlSubstring}" matched no open tab — refusing to drive an arbitrary tab. ` +
          `Open tabs: ${tabs.map((t) => t.url.slice(0, 60)).join(' | ') || '(none)'}`,
      );
    }
    log('info', `picked tab ${match.id}: ${match.title.slice(0, 60)} — ${match.url.slice(0, 80)}`);
    return match.id;
  }
  const tab = tabs[0];
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
// Platform adapters are data: built-in plugin < data/plugins/*.json < the
// extension options page (live push). One registry instance for the process.
const registry = new PlatformRegistry(log);
registry.useFilePlugins(loadPluginFiles(defaultPluginsDir(), log));
const platform = makeDynamicPlatform(registry, log);

bridge.on('plugins', (plugins: SitePlugin[]) => {
  try {
    registry.usePushedPlugins(plugins);
  } catch (err) {
    log('error', `plugins from extension rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
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

const PROBE_WINDOW_DEFAULT_S = 60;

function fmtRate(v: number | null): string {
  return v === null ? 'n/a' : `${v.toFixed(2)}×`;
}

/** Human-readable A/B report for a playback-rate probe. */
function printProbeReport(result: SpeedProbeResult, rate: number): void {
  const phase = (label: string, m: SpeedProbeResult['base']): void =>
    log(
      'info',
      `speed-probe ${label}: credited/wall=${fmtRate(m.creditedPerWall)} progress/wall=${fmtRate(m.progressPerWall)} ` +
        `video/wall=${m.videoPerWall.toFixed(2)}× heartbeats=${m.heartbeats} observedRate=${m.observedRate}× (${m.wallSeconds}s)`,
    );
  phase('1x ', result.base);
  phase(`${String(rate).padEnd(2)}x`, result.fast);
  log('info', `speed-probe VERDICT: ${result.verdict.verdict} — ${result.verdict.note}`);
  if (result.verdict.verdict === 'credited' && result.verdict.creditedSpeed !== null) {
    const minutes = Math.round(60 / result.verdict.creditedSpeed);
    log('info', `speed-probe: a 60-minute video would take ≈${minutes} min at ${rate}x (measured credit ${result.verdict.creditedSpeed.toFixed(2)}× wall)`);
  }
  if (result.evidence?.requestBody) {
    log('debug', `speed-probe evidence — request: ${result.evidence.requestBody.slice(0, 200)}`);
    log('debug', `speed-probe evidence — response: ${result.evidence.responseText.slice(0, 200)}`);
  }
}

function toPolicyEntry(origin: string, result: SpeedProbeResult): SpeedPolicyEntry {
  return {
    origin,
    verdict: result.verdict.verdict,
    creditRatio: result.verdict.creditRatio,
    creditedSpeed: result.verdict.creditedSpeed,
    requestedRate: result.fast.requestedRate,
    measuredAt: new Date().toISOString(),
    note: result.verdict.note,
    evidence: result.evidence,
  };
}

/**
 * Absolute video URL for a resource id, built from the resolved site plugin's
 * `videoUrlTemplate` (falling back to the built-in LMS shape when no adapter
 * was resolved yet) against the tab's current origin.
 */
async function videoUrlFor(cdp: { url(): Promise<string> }, id: number): Promise<string> {
  const current = await cdp.url().catch(() => '');
  // Prefer the plugin that owns the CURRENT page (video or course matcher);
  // fall back to the last-resolved adapter / built-in LMS template.
  const adapter = registry.forUrl(current) ?? registry.forCourseUrl(current);
  const template = adapter?.videoUrl(id) ?? platform.videoUrl(id);
  try {
    return new URL(template, current || 'https://localhost').toString();
  } catch {
    return template;
  }
}

/**
 * `speed-probe`: measure on a live video page whether the backend credits
 * faster playback. No extension/bridge needed — CDP plus the page's own
 * heartbeat responses are enough, and nothing is forged.
 */
async function speedProbeCmd(args: CliArgs): Promise<void> {
  const rate = clampRate(args.rate ?? 2);
  const windowMs = (args.windowSeconds ?? PROBE_WINDOW_DEFAULT_S) * 1_000;
  const cdp = await CdpTab.connect(config.chromeDebugPort, args.url ?? '');
  try {
    const url = await cdp.url();
    const adapter = registry.forUrl(url);
    if (!adapter) {
      console.error(`speed-probe needs a video page owned by a site plugin (${url || 'unknown tab'}) — open one and re-run, or pass --url SUBSTR`);
      process.exitCode = 1;
      return;
    }
    await adapter.installHeartbeatHook(cdp);
    log('info', `speed-probe: using plugin ${adapter.plugin.id} (${adapter.plugin.label ?? 'no label'})`);
    const origin = originOf(url);
    log('info', `speed-probe on ${origin} — 1x baseline then ${rate}x, ${windowMs / 1000}s each (~${((windowMs * 2) / 60_000).toFixed(1)} min). Observation only; the rate is restored afterwards.`);
    const result = await probeCreditSpeed({ cdp, platform: adapter, log, rate, windowMs, keepRate: args.keepRate ?? false });
    printProbeReport(result, rate);
    const store = new SpeedPolicyStore(defaultSpeedPolicyFile());
    store.load();
    store.record(toPolicyEntry(origin, result));
    log('info', `speed-probe: saved ${store.file} (${origin} => ${result.verdict.verdict}) — \`--rate ${rate}\` will now use this measurement`);
  } finally {
    cdp.close();
  }
}

/** Text handed to the LLM layer as advisory platform structure. */
function quizHintText(quiz: SitePlugin['quiz'], applied: AppliedHints): string | undefined {
  if (!quiz) return undefined;
  const lines: string[] = [];
  if (quiz.questionSelector) lines.push(`one question container per ${quiz.questionSelector}`);
  if (quiz.optionSelector) lines.push(`one option row per ${quiz.optionSelector}`);
  if (quiz.navLabels && quiz.navLabels.length > 0) lines.push(`nav buttons are labelled: ${quiz.navLabels.join(' / ')}`);
  if (applied.scoped && applied.scopeNote) lines.push(applied.scopeNote);
  if (quiz.notes) lines.push(quiz.notes);
  return lines.length > 0 ? lines.join('; ') : undefined;
}

/**
 * Apply the platform plugin's quiz hints around the inspect pipeline: narrow the
 * capture to the quiz subtree, then merge the platform's nav labels into the
 * result. Both are additive — a failing hint degrades to the previous behaviour.
 */
async function inspectWithHints(
  capture: PageCapture,
  quiz: SitePlugin['quiz'],
  evalJson: (expression: string) => Promise<unknown | null>,
): Promise<{ capture: PageCapture; applied: AppliedHints; hints?: string }> {
  const { capture: scoped, applied } = await applyQuizScope(capture, quiz, { evalJson, log });
  if (quiz?.navLabels) applied.navLabels = quiz.navLabels;
  if (!capture.progressClaim) {
    const claim = await readProgressHint(quiz, { evalJson });
    if (claim) {
      scoped.progressClaim = claim;
      applied.diagnostics.push(`hints: progressClaim from ${quiz!.progressSelector} (${claim.raw})`);
    }
  }
  log('info', hintSummaryLine(quiz, applied));
  return { capture: scoped, applied, hints: quizHintText(quiz, applied) };
}

/**
 * `report-probe`: ONE replayed heartbeat, judged by the server's own ack. This
 * is the measurement that decides whether report replay is worth anything on
 * this deployment, and it gates --forge. No extension needed: CDP + the page.
 */
async function reportProbeCmd(args: CliArgs): Promise<void> {
  const cdp = await CdpTab.connect(config.chromeDebugPort, args.url ?? '');
  try {
    const url = await cdp.url();
    const adapter = registry.forUrl(url);
    if (!adapter) {
      console.error(`report-probe needs a video page owned by a site plugin (${url || 'unknown tab'})`);
      process.exitCode = 1;
      return;
    }
    const forge = adapter.plugin.forge;
    if (!forge?.replayJs && !forge?.timeFieldPattern) {
      console.error(
        `plugin ${adapter.plugin.id} declares no forge replay knowledge — report replay is not implemented for this platform${forge?.note ? ` (${forge.note})` : ''}`,
      );
      process.exitCode = 1;
      return;
    }
    await adapter.installHeartbeatHook(cdp);
    const state = await adapter.readPlayerState(cdp);
    if (!state.playing) {
      console.error('report-probe needs the video playing (the platform only sends heartbeats while it plays)');
      process.exitCode = 1;
      return;
    }
    const origin = originOf(url);
    log('info', `report-probe on ${origin} with plugin ${adapter.plugin.id} — waiting for one real heartbeat to learn the report shape…`);
    const seen = await waitForHeartbeat(cdp);
    if (!seen) {
      console.error('no heartbeat was recorded within 45s — the platform may use a different endpoint (check the plugin hook), or the player is not reporting yet');
      process.exitCode = 1;
      return;
    }
    log('info', `report-probe: recorded ${seen}`);
    const position = args.toEnd ? Math.round(state.duration) : args.position ?? Math.round(state.currentTime) + 30;
    const verdict = await probeReportAcceptance({ cdp, platform: adapter, log, forge: adapter.plugin.forge, position });
    log('info', `report-probe VERDICT: ${verdict.verdict} — ${verdict.note}`);
    log(
      'info',
      `report-probe: ack delta credited=${verdict.creditedDelta ?? 'n/a'}s progress=${verdict.progressDelta ?? 'n/a'} · replay ${verdict.replay.ok ? `HTTP ${verdict.replay.status}` : verdict.replay.detail.slice(0, 160)}`,
    );
    const store = new ReportProbeStore(defaultReportProbeFile());
    store.load();
    store.record(entryFromVerdict(origin, adapter.plugin.id, verdict));
    log('info', `report-probe: saved ${store.file} (${origin} => ${verdict.verdict}) — \`--forge\` now reads this measurement`);
  } finally {
    cdp.close();
  }
}

/** Poll the page for a recorded heartbeat (the platform sends them on its own schedule). */
async function waitForHeartbeat(cdp: CdpTab, timeoutMs = 45_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await cdp
      .evaluate<{ ts: number; url?: string; bytes?: number } | null>(
        `(window.__c4gLastHeartbeat ? { ts: window.__c4gLastHeartbeat.ts, url: window.__c4gLastHeartbeat.url, bytes: (window.__c4gLastHeartbeat.requestBody || '').length } : null)`,
      )
      .catch(() => null);
    if (seen && seen.ts > 0) {
      return `heartbeat ${seen.url ?? '(url not recorded by this plugin)'} (${seen.bytes ?? 0}B body)`;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return null;
}

/** Gate --forge on a stored measurement (or an explicit override). */
function resolveForge(args: CliArgs, adapter: PlatformAdapter | null, origin: string): ForgeDecision {
  const store = new ReportProbeStore(defaultReportProbeFile());
  store.load();
  const decision = decideForge({
    requested: args.forge ?? false,
    hasPattern: adapter?.plugin.forge?.timeFieldPattern !== undefined || adapter?.plugin.forge?.replayJs !== undefined,
    // Fresh only: a stale 'accepted' must not arm replay forever (backends
    // change), and a stale 'ignored' should not ban it forever either.
    entry: store.getFresh(origin),
    force: args.forgeForce ?? false,
    log,
  });
  log('info', forgeSummaryLine(decision));
  return decision;
}

/**
 * Build the per-supervisor report driver. The plugin is resolved lazily on the
 * first tick that actually sits on a video page (a supervisor starts on a
 * course page, and swarm lanes are parked there too), and a give-up is recorded
 * into the same store the gate reads — so the next run starts from evidence.
 */
function makeForgeHook(
  decision: ForgeDecision,
  cdp: ForgeCdp,
  args: CliArgs,
  origin: string,
): { onTick: () => Promise<void>; driver: () => ForgeDriver | null } {
  let driver: ForgeDriver | null = null;
  const onTick = async (): Promise<void> => {
    if (!decision.enabled) return;
    if (!driver) {
      const adapter = registry.forUrl(await cdp.url());
      const forge = adapter?.plugin.forge;
      if (!adapter || (!forge?.replayJs && !forge?.timeFieldPattern)) return; // not on a video page yet, or no forge support
      log('info', `forge: arming report replay on ${adapter.plugin.id} (${decision.note})`);
      driver = makeForgeDriver({
        cdp,
        platform: adapter,
        log,
        forge,
        stepSeconds: args.forgeStep ?? 60,
        toEnd: args.forgeToEnd ?? false,
        maxStalls: args.forgeStalls ?? 2,
        onGiveUp: (_verdict, note) => {
          const store = new ReportProbeStore(defaultReportProbeFile());
          store.load();
          store.record(entryFromGiveUp(origin, adapter.plugin.id, note));
          log('warn', `forge: recorded the give-up verdict in ${store.file}`);
        },
      });
    }
    await driver.tick();
  };
  return { onTick, driver: () => driver };
}

/**
 * Resolve the playback rate for a supervising run. Above 1x this is a user
 * choice with a measurement requirement: reuse a fresh policy entry, else probe
 * the first queued video inline, then honour/refuse the rate by evidence.
 */
type RateProbeTab = ProbeCdp & { navigate(url: string): Promise<void> };

async function resolveRunRate(
  args: CliArgs,
  probeTarget: { cdp: RateProbeTab },
  queueHead: number | null,
): Promise<RateDecision> {
  const requested = clampRate(args.rate ?? 1);
  if (requested <= 1.001) return decideRate({ requested: 1, log });

  const store = new SpeedPolicyStore(defaultSpeedPolicyFile());
  store.load();
  const currentUrl = await probeTarget.cdp.url().catch(() => '');
  const origin = originOf(currentUrl);
  let entry = store.getFresh(origin);

  if (!entry && !args.rateForce) {
    if (queueHead === null) {
      log('warn', `rate: no fresh measurement for ${origin || 'this origin'} and no video available to probe`);
    } else {
      const windowS = args.windowSeconds ?? PROBE_WINDOW_DEFAULT_S;
      log('info', `rate: no fresh measurement for ${origin} — probing the first queued video first (exploration, ~${((windowS * 2) / 60).toFixed(1)} min)`);
      try {
        await probeTarget.cdp.navigate(await videoUrlFor(probeTarget.cdp, queueHead));
        const adapter = registry.forUrl(await probeTarget.cdp.url());
        if (!adapter) throw new Error('probe target is not a video page owned by a site plugin');
        await adapter.installHeartbeatHook(probeTarget.cdp);
        const result = await probeCreditSpeed({
          cdp: probeTarget.cdp,
          platform: adapter,
          log,
          rate: requested,
          windowMs: windowS * 1_000,
        });
        printProbeReport(result, requested);
        entry = toPolicyEntry(origin, result);
        store.record(entry);
      } catch (err) {
        log('warn', `rate: inline probe failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const decision = decideRate({ requested, entry, force: args.rateForce ?? false, log });
  log('info', rateSummaryLine(decision));
  return decision;
}

/**
 * chain --loop: overnight batch supervisor. Passes = course rescrape + ledger
 * diff; each video runs to a terminal WatchOutcome under real playback.
 * Completions land in data/completions.json, retry counts in data/failed.json
 * (exhausted videos are skipped by later passes). No queue item is ever
 * started twice within a run.
 *
 * --rate / --forge are measured user choices and gate here exactly like the
 * single-shot watch/chain path and the swarm path (docs/m4, docs/m5 §6):
 * the rate resolves once for the whole run (inline probe on the first scraped
 * video when no fresh policy exists), and the forge driver arms lazily on the
 * first tick that lands on a video page.
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
    const ids = await platform.scrapeCourseVideoIds(live.cdp);
    return ids.map((id) => ({ url: platform.videoUrl(id), resourceId: id }));
  };

  // Probe candidate for the rate gate: the first video the course page lists.
  // The tab is already on the course page (main() navigated it here).
  let queueHead: number | null = null;
  try {
    const ids = await platform.scrapeCourseVideoIds(live.cdp);
    queueHead = ids[0] ?? null;
  } catch (err) {
    log('debug', `chain --loop: couldn't scrape a probe candidate: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rate = (await resolveRunRate(args, { cdp: live.cdp }, queueHead)).rate;

  // Forge gate: the tab sits on the COURSE page here, so the video matcher
  // (forUrl) would miss — resolve through the course matcher like the swarm
  // path does.
  const loopOrigin = originOf(courseUrl);
  const loopForge = resolveForge(args, registry.forCourseUrl(courseUrl) ?? registry.forUrl(courseUrl), loopOrigin);
  const forgeHook = makeForgeHook(loopForge, live.cdp, args, loopOrigin);

  persistOnShutdown = () => {
    ledger.flush();
    failed.flush();
    log('info', forgeSummaryLine(loopForge, forgeHook.driver() ?? undefined));
  };

  // F1 (review): ONE supervisor for the whole run. The timekeeper's interval
  // auto-chains through the persisted queue, so per-item instances would race
  // the same tab (duplicate resume clicks, racy navigations, misattributed
  // failures). Sequential watch() on a single instance short-circuits via the
  // in-memory done set instead.
  const timekeeper = new Timekeeper({ tabId: live.tabId, cdp: live.cdp, ws: bridge, jev, platform, log, rate, onTick: forgeHook.onTick });
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

/**
 * chain --swarm N: N lanes = N tabs, N Timekeepers, disjoint video slices,
 * one shared completion ledger. The tab the user launched from stays the
 * *scout* (it rescrapes the course between passes and never plays a video), so
 * a pass plan can never navigate away from a lane's live playback.
 */
async function runChainSwarm(args: CliArgs, courseUrl: string, scout: { tabId: number; cdp: CdpTab }): Promise<void> {
  const dataDir = defaultDataDir();
  const ledger = new CompletionLedger(join(dataDir, 'completions.json'));
  const failed = new FailedLedger(join(dataDir, 'failed.json'));
  ledger.load();
  failed.load();

  const laneCount = planSwarmLanes(args.swarm ?? 2, log);
  const mute = args.swarmMute ?? false;
  if (args.queue && args.queue.length > 0) {
    log('warn', 'swarm plans its own queue from the course page — --queue is ignored in swarm mode');
  }
  const lanes = await provisionLanes({
    count: laneCount,
    courseUrl,
    nonce: swarmNonce(),
    openTab: (url) => bridge.openTab(url, { active: false }),
    listTargets: (index) =>
      listPageTargetIds(config.chromeDebugPort).catch((err: unknown) => {
        log('debug', `swarm: lane${index} target pre-scan failed: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }),
    connectLane: async (marker, index, before) => {
      try {
        return await connectToMarker(config.chromeDebugPort, marker, { timeoutMs: 6_000 });
      } catch (err) {
        // The park URL can redirect away from its marker (login/consent page).
        // The lane tab is still the one new page target since we opened it.
        log('warn', `swarm: lane${index} marker attach failed (${err instanceof Error ? err.message : String(err)}) — falling back to new-target detection`);
        return await connectToNewPage(config.chromeDebugPort, before);
      }
    },
    closeTab: (tabId) => bridge.closeTab(tabId),
    log,
  });

  // Playback rate is a measured user choice (see speed-policy.ts): resolve it
  // before any lane starts, probing lane0's first queued video if needed.
  let queueHead: number | null = null;
  try {
    const ids = await platform.scrapeCourseVideoIds(scout.cdp);
    queueHead = ids[0] ?? null;
  } catch (err) {
    log('debug', `swarm: couldn't scrape a probe candidate: ${err instanceof Error ? err.message : String(err)}`);
  }
  const rate = (await resolveRunRate(args, { cdp: lanes[0]!.cdp }, queueHead)).rate;

  // Arm each lane before it ever loads a video page: the init script must
  // already be registered when the first video document starts.
  for (const lane of lanes) {
    await applyLanePolicy(lane.cdp, { laneId: lane.label, mute, rate, log }).catch((err: unknown) =>
      log('warn', `swarm: ${lane.label} pre-arm failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  const swarmOrigin = originOf(courseUrl);
  const swarmForge = resolveForge(args, registry.forCourseUrl(courseUrl), swarmOrigin);
  const laneForgeHooks = new Map<number, ReturnType<typeof makeForgeHook>>();
  const makeSupervisor = (lane: SwarmLane): Timekeeper => {
    const hook = makeForgeHook(swarmForge, lane.cdp, args, swarmOrigin);
    laneForgeHooks.set(lane.index, hook);
    return new Timekeeper({
      tabId: lane.tabId,
      cdp: lane.cdp,
      ws: bridge,
      jev,
      platform,
      log,
      // One queue file per lane: lanes must never share the persisted queue.
      dataFile: join(dataDir, `queue.${lane.label}.json`),
      rate,
      onPageReady: () => applyLanePolicy(lane.cdp, { laneId: lane.label, mute, rate, log }),
      onTick: hook.onTick,
    });
  };

  const run = startSwarm({
    lanes,
    courseUrl,
    ledger,
    failed,
    log,
    maxPasses: args.maxPasses ?? 3,
    keepTabs: args.swarmKeepTabs ?? false,
    closeTab: (tabId) => bridge.closeTab(tabId),
    makeSupervisor,
    scrape: async (url) => {
      await scout.cdp.navigate(url);
      const ids = await platform.scrapeCourseVideoIds(scout.cdp);
      return ids.map((id) => ({ url: platform.videoUrl(id), resourceId: id }));
    },
  });

  persistOnShutdown = () => {
    run.stop();
    ledger.flush();
    failed.flush();
    for (const [index, hook] of laneForgeHooks) {
      const driver = hook.driver();
      if (driver) log('info', `swarm[lane${index}]: ${forgeSummaryLine(swarmForge, driver)}`);
    }
  };

  const summary = await run.done;
  // Natural completion never passed through stop(): close the lane tabs this
  // run created (unless --swarm-keep-tabs) so a successful run doesn't leak
  // N parked tabs into the user's browser. stop() is idempotent.
  run.stop();
  if (summary.flagged) {
    log('warn', `swarm: run was degraded after the platform warned about concurrent playback (evidence: data/swarm-flag.json, lane ${summary.flagged.laneIndex}) — inspect the account before running swarm again`);
  }
  log('info', batchSummaryLine(ledger, failed));
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
  if (cmd === 'speed-probe') {
    await speedProbeCmd(args);
    return;
  }
  if (cmd === 'report-probe') {
    await reportProbeCmd(args);
    return;
  }

  // Live commands — bridge + CDP attach.
  await bridge.start(config.hostPort);
  await bridge.waitHello();
  const tabId = pickTabId(args.url);
  // The extension-side tabId and the CDP target must be the SAME page. With
  // --url both sides match on the substring; without it, anchor the CDP attach
  // to the picked tab's exact URL — otherwise the two "first page" fallbacks
  // can silently resolve to different tabs (navigate one, snapshot the other).
  const pickedUrl = bridge.tabs.find((t) => t.id === tabId)?.url ?? '';
  const cdp = await CdpTab.connect(config.chromeDebugPort, args.url ?? pickedUrl);
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
        if (args.loop && (args.swarm ?? 1) > 1) {
          await runChainSwarm(args, courseUrl, { tabId, cdp });
          break;
        }
        if (args.swarm !== undefined && args.swarm > 1) {
          log('warn', 'swarm needs --loop (it is a batch supervisor): add --loop, e.g. `chain <courseUrl> --loop --swarm 2`');
          process.exit(1);
        }
        if (args.loop) {
          await runChainLoop(args, courseUrl, { tabId, cdp });
          break;
        }
      }
      let queue = args.queue;
      if (!queue || queue.length === 0) {
        const currentUrl = await cdp.url();
        if (platform.isCoursePage(currentUrl)) {
          queue = await platform.scrapeCourseVideoIds(cdp);
          log('info', `scraped ${queue.length} video ids from course page: [${queue.slice(0, 10).join(', ')}${queue.length > 10 ? ', …' : ''}]`);
        } else {
          console.error('no --queue given and current page is not a course page for any site plugin (cannot scrape video ids)');
          process.exit(1);
        }
      }
      // Playback rate and report replay are measured user choices: gate both.
      const rate = (await resolveRunRate(args, { cdp }, queue[0] ?? null)).rate;
      const tabUrl = await cdp.url();
      // The tab may sit on a course page (chain) rather than a video page
      // (watch): resolve the plugin through whichever matcher applies, then
      // through the first queued video's URL as a last resort — otherwise
      // `chain --forge` would misjudge the gate as 'no-pattern'.
      const forgeAdapter =
        registry.forUrl(tabUrl) ??
        registry.forCourseUrl(tabUrl) ??
        (queue.length > 0 ? registry.forUrl(platform.videoUrl(queue[0]!)) : null);
      const forge = resolveForge(args, forgeAdapter, originOf(tabUrl));
      const forgeHook = makeForgeHook(forge, cdp, args, originOf(tabUrl));
      persistOnShutdown = () => log('info', forgeSummaryLine(forge, forgeHook.driver() ?? undefined));
      const timekeeper = new Timekeeper({ tabId, cdp, ws: bridge, jev, platform, log, rate, onTick: forgeHook.onTick });
      timekeeper.start(queue);
      break;
    }
    case 'quiz': {
      await platform
        .installHeartbeatHook(cdp)
        .catch(() => log('debug', 'no site plugin heartbeat hook installed for this page'));
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
      // The plugin's quiz knowledge applies on VIDEO, COURSE and QUIZ pages
      // alike — a /mod/quiz/ attempt matches none of the video/course
      // patterns, so resolve through the quiz matcher too (M5 §7 was dead
      // on real quiz pages before this).
      const pageUrl = await cdp.url();
      const quizPlugin =
        (registry.forUrl(pageUrl) ?? registry.forCourseUrl(pageUrl) ?? registry.forQuizUrl(pageUrl))?.plugin;
      const quizHints = quizPlugin?.quiz
        ? quizHintText(quizPlugin.quiz, emptyAppliedHints())
        : undefined;
      // M5 §7 wiring: the plugin's quiz knowledge is applied to every capture
      // inside the loop (scope narrowing, nav labels, progress fallback).
      const pluginQuiz =
        quizPlugin?.quiz !== undefined && bridge.status().connected
          ? {
              quiz: quizPlugin.quiz,
              evalJson: async (expression: string): Promise<unknown | null> => {
                try {
                  return await bridge.evalJson(tabId, expression);
                } catch {
                  return null;
                }
              },
            }
          : undefined;
      const report = await runQuizLoop(
        {
          ws: bridge,
          solver,
          inspect: { ...inspectDeps, l1, ...(quizHints ? { hints: quizHints } : {}) },
          log,
          autoSubmit: config.autoSubmit,
          ...(pluginQuiz ? { pluginQuiz } : {}),
        },
        tabId,
      );
      log('info', `quiz loop finished: ${JSON.stringify(report)}`);
      cleanup();
      break;
    }
    case 'inspect': {
      const rawCapture = await captureFromWs(wsCaptureTransport(bridge, tabId), { includePageText: true });
      const captureUrl = rawCapture.url;
      const inspectPlugin =
        (registry.forUrl(captureUrl) ?? registry.forCourseUrl(captureUrl) ?? registry.forQuizUrl(captureUrl))?.plugin;
      const evalJsonForHints = async (expression: string): Promise<unknown | null> => {
        try {
          return await bridge.evalJson(tabId, expression);
        } catch {
          return null;
        }
      };
      const hinted =
        inspectPlugin?.quiz !== undefined
          ? await inspectWithHints(rawCapture, inspectPlugin.quiz, evalJsonForHints)
          : { capture: rawCapture, applied: emptyAppliedHints(), hints: undefined };
      const capture: PageCapture = hinted.capture;
      const quality = saveCapture(defaultCorpusDir(), capture);
      log('info', `capture ${capture.captureId} saved to corpus${quality.defective ? ` — DEFECTIVE: ${quality.defects.join('; ')}` : ''}`);
      if (quality.defective) {
        log('error', 'defective capture — refusing to inspect');
        cleanup();
        process.exit(1);
      }
      let result = await inspectPage(capture, {
        ...inspectDeps,
        ...(hinted.hints ? { hints: hinted.hints } : {}),
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
      if (inspectPlugin?.quiz?.navLabels) {
        const merged = mergeNavLabels(result, capture.table, inspectPlugin.quiz.navLabels);
        result = merged.result;
        if (merged.added.length > 0) {
          log('info', `inspect hints: nav buttons added from plugin labels [${merged.added.join(', ')}]`);
        }
      }
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
