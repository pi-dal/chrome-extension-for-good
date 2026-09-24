/**
 * c4g options page.
 *
 * Persists the host port, the LLM/Jev endpoints, and the SITE PLUGIN list. The
 * plugin list is validated here with the same protocol parser the host uses, so
 * a typo is caught in the UI instead of silently degrading the host to
 * "no plugin matches this page".
 */

import { BUILTIN_PLUGINS, parseSitePlugins, type SitePlugin } from '@c4g/protocol';
import { STORAGE, storageGet, storageSet } from './shared.js';

const ENDPOINT_FIELDS = [
  'solverBaseUrl',
  'solverApiKey',
  'solverModel',
  'typesafeBaseUrl',
  'typesafeApiKey',
  'typesafeModel',
] as const;

const msg = document.getElementById('msg') as HTMLElement;
const pluginsBox = document.getElementById('plugins') as HTMLTextAreaElement;

function say(text: string, ok = true): void {
  msg.textContent = text;
  msg.style.color = ok ? '#0a7d32' : '#b3261e';
}

function pluginsToText(plugins: SitePlugin[]): string {
  return JSON.stringify(plugins, null, 2);
}

/** Parse + validate the textarea; throws with the protocol's own message. */
function readPluginsBox(): SitePlugin[] {
  const text = pluginsBox.value.trim();
  if (text === '') return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseSitePlugins(raw);
}

/**
 * Built-in catalog: what each shipped plugin matches and whether it was verified
 * against a live account. The operator copies the closest entry into the box
 * instead of inventing probes from scratch.
 */
function renderCatalog(): void {
  const host = document.getElementById('catalog');
  if (!host) return;
  host.innerHTML = '';
  for (const p of BUILTIN_PLUGINS) {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    const head = document.createElement('div');
    head.className = 'plugin-head';
    head.textContent = `${p.id} — ${p.label ?? ''} `;
    const badge = document.createElement('span');
    badge.className = p.verified === true ? 'badge ok' : 'badge warn';
    badge.textContent = p.verified === true ? 'verified' : 'unverified';
    head.appendChild(badge);
    row.appendChild(head);
    const body = document.createElement('div');
    body.className = 'plugin-body';
    const patterns = [p.match.video, ...(p.match.videoAny ?? [])];
    body.textContent = `match: ${patterns.join(' | ')}${p.match.course ? ` · course: ${p.match.course}` : ''}`;
    row.appendChild(body);
    if (p.source) {
      const src = document.createElement('div');
      src.className = 'plugin-body';
      src.textContent = `source: ${p.source}`;
      row.appendChild(src);
    }
    if (p.notes) {
      const notes = document.createElement('div');
      notes.className = 'plugin-body';
      notes.textContent = `notes: ${p.notes}`;
      row.appendChild(notes);
    }
    const use = document.createElement('button');
    use.type = 'button';
    use.textContent = 'Use as template';
    use.addEventListener('click', () => {
      pluginsBox.value = JSON.stringify([p], null, 2);
      say(`Loaded the ${p.id} template (not saved yet)`, true);
    });
    row.appendChild(use);
    host.appendChild(row);
  }
}

async function load(): Promise<void> {
  const stored = await storageGet([STORAGE.hostPort, 'port', ...ENDPOINT_FIELDS, STORAGE.pluginsJson]);
  for (const field of ENDPOINT_FIELDS) {
    (document.getElementById(field) as HTMLInputElement).value =
      typeof stored[field] === 'string' ? (stored[field] as string) : '';
  }
  // hostPort is the canonical key; 'port' is the legacy alias older saves used.
  const port = stored[STORAGE.hostPort] ?? stored['port'];
  (document.getElementById('port') as HTMLInputElement).value =
    typeof port === 'number' && port > 0 ? String(port) : '8765';

  const pluginsJson = stored[STORAGE.pluginsJson];
  if (typeof pluginsJson === 'string' && pluginsJson.trim() !== '') {
    pluginsBox.value = pluginsJson;
    try {
      const count = readPluginsBox().length;
      say(`${count} plugin(s) configured`, true);
    } catch {
      say('The stored site-plugin JSON is currently invalid — fix it and save', false);
    }
  } else {
    // Empty box = built-ins only. Deliberately NOT seeded with the catalog:
    // saving a seeded copy would PIN today's built-in definitions as pushed
    // plugins, shadowing every future built-in fix (same ids → pushed wins).
    // The catalog below is for copying single entries from.
    say('Empty = built-in plugins only · copy a catalog entry below to customize', true);
  }
}

function on(id: string, event: string, handler: () => void | Promise<void>): void {
  document.getElementById(id)?.addEventListener(event, () => {
    void handler();
  });
}

on('save', 'click', async () => {
  const p = parseInt((document.getElementById('port') as HTMLInputElement).value, 10);
  if (!Number.isFinite(p) || p <= 0 || p > 65535) {
    say('Invalid port', false);
    return;
  }
  let plugins: SitePlugin[];
  try {
    plugins = readPluginsBox();
  } catch (err) {
    say(`Site-plugin validation failed: ${err instanceof Error ? err.message : String(err)}`, false);
    return;
  }
  const items: Record<string, unknown> = { [STORAGE.hostPort]: p, [STORAGE.pluginsJson]: pluginsBox.value.trim() };
  for (const field of ENDPOINT_FIELDS) {
    items[field] = (document.getElementById(field) as HTMLInputElement).value.trim();
  }
  await storageSet(items);
  // background listens to storage.onChanged and pushes config_sync + plugins_sync
  say(`Saved and pushed to the host (${plugins.length} site plugin(s))`, true);
});

on('template', 'click', () => {
  pluginsBox.value = pluginsToText(BUILTIN_PLUGINS);
  say('Restored the built-in catalog (not saved yet)', true);
});

on('validate', 'click', () => {
  try {
    const plugins = readPluginsBox();
    say(`Valid: ${plugins.map((x) => x.id).join(', ') || '(empty list)'}`, true);
  } catch (err) {
    say(`Invalid: ${err instanceof Error ? err.message : String(err)}`, false);
  }
});

renderCatalog();
void load();
