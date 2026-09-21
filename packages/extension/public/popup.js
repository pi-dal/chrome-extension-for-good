/** c4g dev popup: shows bridge status and smoke-tests the snapshot path. */

const $id = (x) => document.getElementById(x);

function fmtRow(e) {
  return `[${e.index}] ${e.role} ${e.name || ''}`.slice(0, 90);
}

async function refresh() {
  const st = await chrome.storage.local.get(['wsStatus']);
  const status = $id('status');
  status.textContent = st.wsStatus || 'unknown';
  status.className = st.wsStatus || '';

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  $id('url').textContent = tab && tab.url ? tab.url : '(no active tab)';
  $id('snapshot').disabled = !tab || !tab.id;

  $id('snapshot').onclick = async () => {
    if (!tab || !tab.id) return;
    $id('out').textContent = 'snapshotting…';
    const msg = { type: 'snapshot_request', requestId: 'popup-' + Date.now(), tabId: tab.id, quizOnly: false };
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, msg);
      if (resp && resp.type === 'snapshot') {
        const els = resp.table.elements;
        const lines = els.slice(0, 10).map(fmtRow).join('\n');
        $id('out').textContent = els.length + ' elements\n' + lines;
      } else {
        $id('out').textContent = 'unexpected response: ' + JSON.stringify(resp).slice(0, 300);
      }
    } catch (e) {
      $id('out').textContent = 'error: ' + e;
    }
  };
}

refresh();
