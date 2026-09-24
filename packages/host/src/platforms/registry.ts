import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PLUGINS, parseSitePlugin, type SitePlugin } from '@c4g/protocol';
import type { LogFn } from '../log.js';
import { buildPlatform, type PlatformAdapter, type PlayerState, type PluginTab } from './plugin.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** data/plugins — local site plugins, loaded at startup. */
export function defaultPluginsDir(): string {
  return resolve(HERE, '..', '..', 'data', 'plugins');
}

/**
 * Plugin sources, lowest priority first. A later source overrides an earlier
 * plugin with the same id, so an operator can fix a built-in without rebuilding.
 */
export interface PluginSources {
  builtin?: SitePlugin[];
  /** Parsed from data/plugins/*.json. */
  files?: SitePlugin[];
  /** Pushed live by the extension options page. */
  pushed?: SitePlugin[];
}

export function mergePlugins(sources: PluginSources): SitePlugin[] {
  const order: string[] = [];
  const byId = new Map<string, SitePlugin>();
  for (const list of [sources.builtin ?? [], sources.files ?? [], sources.pushed ?? []]) {
    for (const plugin of list) {
      if (!byId.has(plugin.id)) order.push(plugin.id);
      byId.set(plugin.id, plugin);
    }
  }
  return order.map((id) => byId.get(id)!);
}

/** Read data/plugins/*.json; a broken file is reported and skipped, never fatal. */
export function loadPluginFiles(dir: string, log: LogFn): SitePlugin[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: SitePlugin[] = [];
  for (const file of entries.sort()) {
    const path = join(dir, file);
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      for (const item of Array.isArray(raw) ? raw : [raw]) out.push(parseSitePlugin(item));
    } catch (err) {
      log('warn', `platform: ignoring ${path} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (out.length > 0) {
    log('info', `platform: loaded ${out.length} plugin(s) from ${dir}: [${out.map((p) => p.id).join(', ')}]`);
  }
  return out;
}

/**
 * Resolves the platform adapter for a URL. Adapters are built lazily and cached
 * per plugin id, so a plugin swap at runtime (extension push) is one map clear.
 */
export class PlatformRegistry {
  private filePlugins: SitePlugin[] = [];
  private pushedPlugins: SitePlugin[] = [];
  private plugins: SitePlugin[];
  private readonly adapters = new Map<string, PlatformAdapter>();

  constructor(private readonly log: LogFn) {
    this.plugins = mergePlugins({ builtin: BUILTIN_PLUGINS });
  }

  /** Register the file-sourced plugins (startup). */
  useFilePlugins(plugins: SitePlugin[]): void {
    this.filePlugins = plugins;
    this.rebuild();
  }

  /** Register the extension-pushed plugins (live). */
  usePushedPlugins(plugins: SitePlugin[]): void {
    this.pushedPlugins = plugins;
    this.rebuild();
    this.log('info', `platform: plugins updated from extension → [${this.plugins.map((p) => p.id).join(', ')}]`);
  }

  private rebuild(): void {
    this.plugins = mergePlugins({ builtin: BUILTIN_PLUGINS, files: this.filePlugins, pushed: this.pushedPlugins });
    this.adapters.clear();
  }

  list(): SitePlugin[] {
    return [...this.plugins];
  }

  adapter(id: string): PlatformAdapter | null {
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) return null;
    let adapter = this.adapters.get(id);
    if (!adapter) {
      adapter = buildPlatform(plugin);
      this.adapters.set(id, adapter);
      if (plugin.verified === true) {
        this.log('debug', `platform: using ${plugin.id} (verified)`);
      } else {
        // Fact, not a warning about intent: nobody should mistake a derived
        // adapter for one that was measured on a live account.
        this.log(
          'warn',
          `platform: using ${plugin.id} — NOT verified against a live account${plugin.source ? ` (source: ${plugin.source})` : ''}` +
            `${plugin.notes ? ` · ${plugin.notes}` : ''}`,
        );
      }
    }
    return adapter;
  }

  /** Adapter owning a video-page URL, or null. */
  forUrl(url: string): PlatformAdapter | null {
    const plugin = this.plugins.find((p) => [p.match.video, ...(p.match.videoAny ?? [])].some((m) => url.includes(m)));
    return plugin ? this.adapter(plugin.id) : null;
  }

  /** Adapter owning a course/list URL, or null. */
  forCourseUrl(url: string): PlatformAdapter | null {
    const plugin = this.plugins.find((p) => {
      const patterns = [...(p.match.course !== undefined ? [p.match.course] : []), ...(p.match.courseAny ?? [])];
      return patterns.some((m) => url.includes(m));
    });
    return plugin ? this.adapter(plugin.id) : null;
  }

  /** Adapter owning a quiz/attempt URL, or null. */
  forQuizUrl(url: string): PlatformAdapter | null {
    const plugin = this.plugins.find((p) => {
      const patterns = [...(p.match.quiz !== undefined ? [p.match.quiz] : []), ...(p.match.quizAny ?? [])];
      return patterns.some((m) => url.includes(m));
    });
    return plugin ? this.adapter(plugin.id) : null;
  }

  /** Same as forUrl but with an actionable error for the operator. */
  requireForUrl(url: string): PlatformAdapter {
    const adapter = this.forUrl(url);
    if (adapter) return adapter;
    const known = this.plugins.map((p) => `${p.id} → ${p.match.video}`).join(', ');
    throw new Error(
      `no site plugin matches ${url || '(unknown url)'} — add one in the extension options page (Site plugins), ` +
        `drop a JSON file into data/plugins/, or run \`inspect --learn\` first. Known: [${known}]`,
    );
  }
}

/** Platform surface the Timekeeper needs, resolved lazily per URL. */
export interface DynamicPlatform {
  isVideoPage(url: string): boolean;
  isCoursePage(url: string): boolean;
  installHeartbeatHook(tab: PluginTab): Promise<void>;
  readPlayerState(tab: PluginTab): Promise<PlayerState>;
  scrapeCourseVideoIds(tab: PluginTab): Promise<number[]>;
  videoUrl(id: number | string): string;
  idFromUrl(url: string): number | null;
  readonly heartbeatUrlPattern?: string;
}

/**
 * A platform facade over the registry: each call resolves the plugin from the
 * tab's CURRENT url, so one supervisor can follow a chain across platforms.
 * `videoUrl`/`idFromUrl`/`heartbeatUrlPattern` carry no url, so they read the
 * most recently resolved adapter — always warm, since every tick reads the url
 * before it needs them.
 */
export function makeDynamicPlatform(registry: PlatformRegistry, log: LogFn): DynamicPlatform {
  let last: PlatformAdapter | null = null;
  const resolve = async (tab: PluginTab): Promise<PlatformAdapter> => {
    const url = await tab.url();
    // The current page may be a VIDEO page (watch ticks), a COURSE page
    // (scrapeCourseVideoIds runs there) or a QUIZ page (hints/hook install) —
    // resolve through whichever matcher owns it. requireForUrl only exists
    // for its actionable error message.
    const adapter =
      registry.forUrl(url) ?? registry.forCourseUrl(url) ?? registry.forQuizUrl(url) ?? registry.requireForUrl(url);
    last = adapter;
    return adapter;
  };
  const platform: DynamicPlatform = {
    isVideoPage: (url) => registry.forUrl(url) !== null,
    isCoursePage: (url) => registry.forCourseUrl(url) !== null,
    installHeartbeatHook: async (tab) => (await resolve(tab)).installHeartbeatHook(tab),
    readPlayerState: async (tab) => (await resolve(tab)).readPlayerState(tab),
    scrapeCourseVideoIds: async (tab) => (await resolve(tab)).scrapeCourseVideoIds(tab),
    videoUrl(id) {
      if (last) return last.videoUrl(id);
      log('debug', 'platform: videoUrl requested before any url was resolved — using the built-in template');
      return `/mod/fsresource/view.php?id=${id}`;
    },
    idFromUrl: (url) => registry.forUrl(url)?.idFromUrl(url) ?? null,
  };
  Object.defineProperty(platform, 'heartbeatUrlPattern', {
    enumerable: true,
    get: () => last?.heartbeatUrlPattern,
  });
  return platform;
}
