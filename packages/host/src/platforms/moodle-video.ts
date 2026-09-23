import { LMS_FSRESOURCE_PLUGIN, type SitePlugin } from '@c4g/protocol';
import { buildPlatform, type PlayerState, type PluginTab } from './plugin.js';

/**
 * Built-in LMS adapter facade.
 *
 * The adapter itself is DATA now (`LMS_FSRESOURCE_PLUGIN` in @c4g/protocol,
 * registered by platforms/registry.ts); this module keeps the flat function
 * surface the M1/M2 code and tests were written against, and re-exports the
 * plugin so callers can register it, inspect it, or use it as a template.
 */

export type EvalCapable = PluginTab;
export type { PlayerState };

export const LMS_PLUGIN: SitePlugin = LMS_FSRESOURCE_PLUGIN;

const adapter = buildPlatform(LMS_FSRESOURCE_PLUGIN);

export function isVideoPage(url: string): boolean {
  return adapter.isVideoPage(url);
}

export function isCoursePage(url: string): boolean {
  return adapter.isCoursePage(url);
}

export async function installHeartbeatHook(tab: EvalCapable): Promise<void> {
  await adapter.installHeartbeatHook(tab);
}

export async function readPlayerState(tab: EvalCapable): Promise<PlayerState> {
  return adapter.readPlayerState(tab);
}

/** Ordered unique video ids on a course page. */
export async function scrapeCourseVideoIds(tab: EvalCapable): Promise<number[]> {
  return adapter.scrapeCourseVideoIds(tab);
}

/** Known heartbeat URL fragment — the fast path; generic detection is skipped when present. */
export const heartbeatUrlPattern = LMS_FSRESOURCE_PLUGIN.heartbeatUrlPattern!;
