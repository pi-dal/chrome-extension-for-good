import type { SitePlugin } from '@c4g/protocol';

/**
 * Platform adapter contract: a SitePlugin (data) turned into callable behaviour.
 *
 * The plugin's JS fields are evaluated in the page's MAIN world, exactly where
 * the built-in adapter used to live. Nothing here is platform-specific — the
 * LMS deployment is one plugin among others (see platforms/builtins).
 */

/** Structural subset of CdpTab the platform readers need (fake-able in tests). */
export interface PluginTab {
  evaluate<T = unknown>(expression: string): Promise<T>;
  navigate(url: string): Promise<void>;
  url(): Promise<string>;
}

export interface PlayerState {
  playing: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  heartbeatTs: number;
  /** Server-acked accumulated seconds from the last heartbeat response. */
  totaltime: number | null;
  /** Server-acked progress percent from the last heartbeat response. */
  progress: number | null;
  url: string;
}

export interface PlatformAdapter {
  plugin: SitePlugin;
  isVideoPage(url: string): boolean;
  isCoursePage(url: string): boolean;
  installHeartbeatHook(tab: PluginTab): Promise<void>;
  readPlayerState(tab: PluginTab): Promise<PlayerState>;
  scrapeCourseVideoIds(tab: PluginTab): Promise<number[]>;
  /** Video page URL for a resource id ({id} template from the plugin). */
  videoUrl(id: number | string): string;
  /** Resource id parsed out of a video page URL, or null when unparseable. */
  idFromUrl(url: string): number | null;
  /** Known heartbeat URL fragment — the fast path; generic detection is skipped. */
  heartbeatUrlPattern?: string;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function nullableNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Tolerate both shapes a plugin may return: an object (returnByValue) or a JSON
 * string. Anything else is a plugin bug and must be loud.
 */
export function coercePlayerState(raw: unknown): PlayerState {
  let value: unknown = raw;
  if (typeof value === 'string') {
    const text = value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`plugin playerStateJs returned a non-JSON string: ${text.slice(0, 80)}`);
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`plugin playerStateJs must return an object or JSON string, got ${typeof value}`);
  }
  const o = value as Record<string, unknown>;
  return {
    playing: o.playing === true,
    currentTime: num(o.currentTime),
    duration: num(o.duration),
    rate: typeof o.rate === 'number' && Number.isFinite(o.rate) && o.rate > 0 ? o.rate : 1,
    heartbeatTs: num(o.heartbeatTs),
    totaltime: nullableNum(o.totaltime),
    progress: nullableNum(o.progress),
    url: typeof o.url === 'string' ? o.url : '',
  };
}

/** Same tolerance for the course listing: array or JSON string of numbers. */
export function coerceIdList(raw: unknown): number[] {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    if (typeof item === 'number' && Number.isFinite(item)) out.push(item);
    else if (typeof item === 'string' && /^\d+$/.test(item)) out.push(Number(item));
  }
  return out;
}

export function buildPlatform(plugin: SitePlugin): PlatformAdapter {
  const idRe = plugin.idPattern ? new RegExp(plugin.idPattern) : null;
  // A platform may have several player/list URLs (e.g. /learn/ + /spoc/learn/).
  const videoPatterns = [plugin.match.video, ...(plugin.match.videoAny ?? [])];
  const coursePatterns = [...(plugin.match.course !== undefined ? [plugin.match.course] : []), ...(plugin.match.courseAny ?? [])];
  const adapter: PlatformAdapter = {
    plugin,
    isVideoPage: (url) => videoPatterns.some((p) => url.includes(p)),
    isCoursePage: (url) => coursePatterns.some((p) => url.includes(p)),
    async installHeartbeatHook(tab) {
      const ok = await tab.evaluate<boolean>(plugin.heartbeatHookJs);
      if (ok !== true) throw new Error(`plugin ${plugin.id}: heartbeat hook did not install`);
    },
    async readPlayerState(tab) {
      return coercePlayerState(await tab.evaluate<unknown>(plugin.playerStateJs));
    },
    async scrapeCourseVideoIds(tab) {
      if (!plugin.courseIdsJs) throw new Error(`plugin ${plugin.id}: no courseIdsJs (cannot scrape a course page)`);
      return coerceIdList(await tab.evaluate<unknown>(plugin.courseIdsJs));
    },
    videoUrl(id) {
      const template = plugin.videoUrlTemplate ?? `${plugin.match.video}?id={id}`;
      return template.replace('{id}', String(id));
    },
    idFromUrl(url) {
      if (!idRe) return null;
      const m = idRe.exec(url);
      if (!m || m[1] === undefined) return null;
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : null;
    },
  };
  if (plugin.heartbeatUrlPattern !== undefined) adapter.heartbeatUrlPattern = plugin.heartbeatUrlPattern;
  return adapter;
}
