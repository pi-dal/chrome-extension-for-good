/** c4g options page: persists host port + LLM/Jev endpoint config. */

const FIELDS = [
  'port',
  'solverBaseUrl',
  'solverApiKey',
  'solverModel',
  'typesafeBaseUrl',
  'typesafeApiKey',
  'typesafeModel',
] as const;

const msg = document.getElementById('msg') as HTMLElement;

chrome.storage.local.get([...FIELDS]).then((v) => {
  for (const f of FIELDS) {
    const el = document.getElementById(f) as HTMLInputElement;
    el.value = typeof v[f] === 'string' ? (v[f] as string) : '';
  }
  const port = v['port'];
  (document.getElementById('port') as HTMLInputElement).value =
    typeof port === 'number' && port > 0 ? String(port) : '8765';
});

document.getElementById('save').addEventListener('click', async () => {
  const portEl = document.getElementById('port') as HTMLInputElement;
  const p = parseInt(portEl.value, 10);
  if (!Number.isFinite(p) || p <= 0 || p > 65535) {
    msg.textContent = 'invalid port';
    msg.style.color = '#b3261e';
    return;
  }
  const items: Record<string, unknown> = { hostPort: p };
  for (const f of FIELDS) {
    if (f === 'port') continue;
    items[f] = (document.getElementById(f) as HTMLInputElement).value.trim();
  }
  await chrome.storage.local.set(items);
  // background listens to storage.onChanged and pushes config_sync to the host
  msg.textContent = 'saved — pushed to host';
  msg.style.color = '#0a7d32';
});
