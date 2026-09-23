import type { SitePlugin } from '../index.js';
import { CHAOXING_FORGE_JS, CHAOXING_MD5_JS, CHAOXING_PLUGIN } from './chaoxing.js';
import { ICOURSE163_PLUGIN } from './icourse163.js';
import { LMS_FSRESOURCE_PLUGIN } from './lms-fsresource.js';
import { ZHIHUISHU_FORGE_JS, ZHIHUISHU_PLUGIN } from './zhihuishu.js';

/**
 * Built-in site plugins, shipped as DATA so the host, the extension options page
 * and any third party read the same adapter definitions. The first entry is the
 * reference adapter (measured end to end); the rest are derived from public
 * open-source implementations and carry `source` + `notes` saying exactly what
 * is unverified and what to wire up next.
 *
 * See docs/m5-site-plugins.md for the catalog and how to verify one.
 */
export const BUILTIN_PLUGINS: SitePlugin[] = [
  LMS_FSRESOURCE_PLUGIN,
  ZHIHUISHU_PLUGIN,
  CHAOXING_PLUGIN,
  ICOURSE163_PLUGIN,
];

export {
  CHAOXING_FORGE_JS,
  CHAOXING_MD5_JS,
  CHAOXING_PLUGIN,
  ICOURSE163_PLUGIN,
  LMS_FSRESOURCE_PLUGIN,
  ZHIHUISHU_FORGE_JS,
  ZHIHUISHU_PLUGIN,
};
