'use strict';

/**
 * Downpour popup: connection status, the capture switch, the bypass hint, the
 * per-site rule for whatever tab you are on, the link grabber, and
 * "Open Downpour".
 *
 * All app traffic goes through the service worker (background.js) so there is
 * exactly one place that knows the port, the token and the error handling.
 * The popup only sends messages and renders what comes back.
 *
 * THE CURRENT TAB. `chrome.tabs.query` only returns `url` for tabs the
 * extension may see. The `activeTab` permission grants exactly that, and only
 * for the tab whose toolbar button the user just clicked — which is the tab
 * this popup is about. That is why the manifest asks for `activeTab` rather
 * than leaning on the broad host permission the cookie forwarding needs.
 */

const $ = (id) => document.getElementById(id);

/** Wrapper: the worker replies { ok, data } or { ok:false, error, kind }. */
function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (reply) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!reply) {
        reject(new Error('No reply from the Downpour service worker.'));
        return;
      }
      if (reply.ok) resolve(reply.data);
      else reject(Object.assign(new Error(reply.error), { kind: reply.kind }));
    });
  });
}

const STATUS_VIEW = {
  connected: {
    dot: 'ok',
    text: 'Connected',
    hint: (s) => (s.appVersion ? 'Downpour ' + s.appVersion : 'Downpour') + ' on port ' + s.port
  },
  offline: {
    dot: 'err',
    text: 'Downpour is not running',
    hint: () => 'Downloads stay in the browser until the app is open.'
  },
  unauthorized: {
    dot: 'err',
    text: 'Token invalid',
    hint: () => 'Re-pair in Downpour Settings → Browser integration.'
  },
  no_token: {
    dot: 'warn',
    text: 'Not paired yet',
    hint: () => 'Open Settings and paste the token from the app.'
  },
  unknown: {
    dot: '',
    text: 'Checking…',
    hint: () => ''
  }
};

/** The tab the popup was opened over. Null on chrome:// and similar. */
let currentTab = null;
let currentHost = '';

function renderStatus(status) {
  const view = STATUS_VIEW[status.state] || STATUS_VIEW.unknown;
  $('dot').className = 'dot ' + view.dot;
  $('statusText').textContent = view.text;
  $('statusHint').textContent = view.hint(status);
  $('version').textContent = status.appVersion ? 'v' + status.appVersion : '';

  const box = $('errorBox');
  if (status.lastError && status.state !== 'unauthorized') {
    box.className = 'msg err dismissable';
    box.textContent = status.lastError;
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

function renderPrefs(prefs, bypassLabel) {
  $('captureToggle').checked = Boolean(prefs.captureEnabled);

  // The bypass is useless if the user cannot see which key it is, so the hint
  // names the configured key rather than assuming Alt.
  const key = bypassLabel || '';
  if (key) {
    $('bypassKey').textContent = key;
    $('bypassHint').hidden = false;
  } else {
    $('bypassHint').hidden = true; // set to "none" in Options
  }

  renderSiteRule(prefs);
}

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function renderSiteRule(prefs) {
  const toggle = $('siteToggle');
  if (!currentHost) {
    $('siteHost').textContent = 'Not available on this page';
    toggle.checked = false;
    toggle.disabled = true;
    return;
  }
  toggle.disabled = false;
  $('siteHost').textContent = currentHost;
  const list = Array.isArray(prefs.siteBlocklist) ? prefs.siteBlocklist : [];
  toggle.checked = list.includes(currentHost);
}

function showTransient(message, kind) {
  const box = $('errorBox');
  box.className = 'msg ' + (kind || 'err') + ' dismissable';
  box.textContent = message;
  box.hidden = false;
}

async function readCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab || null;
    currentHost = hostOf((tab && tab.url) || '');
  } catch (_) {
    currentTab = null;
    currentHost = '';
  }
}

async function load() {
  await readCurrentTab();

  // "Grab links" cannot work on chrome://, the Web Store or the PDF viewer;
  // disabling the button says so before the user finds out by pressing it.
  if (!currentHost) {
    $('grabLinks').disabled = true;
    $('grabLinks').title = 'Chrome does not let extensions read this page.';
  }

  try {
    const state = await send({ type: 'getState' });
    renderStatus(state.status);
    renderPrefs(state.prefs, state.bypassLabel);
  } catch (err) {
    showTransient(err.message);
  }

  // Opening the popup is an explicit "is it working?" — re-probe. The worker
  // persists the result, so this is also what keeps the status honest after
  // the worker has been asleep. A refresh that succeeds clears any stored
  // error by itself; one that fails leaves it on screen, which is the point.
  try {
    const status = await send({ type: 'refreshStatus' });
    renderStatus(status);
  } catch (err) {
    showTransient(err.message);
  }
}

// Errors stay until acknowledged. Clicking one dismisses it and repaints the
// badge from the underlying connection state.
$('errorBox').addEventListener('click', async () => {
  $('errorBox').hidden = true;
  try {
    await send({ type: 'clearError' });
  } catch (_) {
    /* nothing useful to say if even this fails */
  }
});

$('captureToggle').addEventListener('change', async (e) => {
  const enabled = e.target.checked;
  try {
    await send({ type: 'setPrefs', prefs: { captureEnabled: enabled } });
  } catch (err) {
    e.target.checked = !enabled; // roll the UI back if the write failed
    showTransient('Could not save the setting: ' + err.message);
  }
});

$('siteToggle').addEventListener('change', async (e) => {
  const on = e.target.checked;
  if (!currentHost) return;
  try {
    await send({ type: 'setSiteRule', host: currentHost, list: 'block', on });
    showTransient(
      on
        ? 'Downloads from ' + currentHost + ' will stay in the browser.'
        : 'Capture is on again for ' + currentHost + '.',
      on ? 'warn' : 'ok'
    );
  } catch (err) {
    e.target.checked = !on;
    showTransient('Could not save the site rule: ' + err.message);
  }
});

$('grabLinks').addEventListener('click', async () => {
  const button = $('grabLinks');
  button.disabled = true;
  button.textContent = 'Scanning…';
  try {
    await send({ type: 'grabLinks', tabId: currentTab ? currentTab.id : -1 });
    window.close(); // the picker opened in its own tab
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Grab links from this page…';
    showTransient(err.message);
  }
});

$('openApp').addEventListener('click', async () => {
  try {
    await send({ type: 'openApp' });
    window.close();
  } catch (err) {
    // POST /api/v1/show reports offline and bad-token like any other call, so
    // this can finally say why nothing happened.
    showTransient('Could not bring Downpour to the front: ' + err.message);
  }
});

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('recheck').addEventListener('click', async () => {
  $('statusText').textContent = 'Checking…';
  try {
    const status = await send({ type: 'refreshStatus' });
    renderStatus(status);
  } catch (err) {
    showTransient(err.message);
  }
});

load();
