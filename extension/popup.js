'use strict';

/**
 * Downpour popup: connection status, the capture switch, and "Open Downpour".
 *
 * All app traffic goes through the service worker (background.js) so there is
 * exactly one place that knows the port, the token and the error handling.
 * The popup only sends messages and renders what comes back.
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

function renderPrefs(prefs) {
  $('captureToggle').checked = Boolean(prefs.captureEnabled);
}

function showTransient(message, kind) {
  const box = $('errorBox');
  box.className = 'msg ' + (kind || 'err') + ' dismissable';
  box.textContent = message;
  box.hidden = false;
}

async function load() {
  try {
    const state = await send({ type: 'getState' });
    renderStatus(state.status);
    renderPrefs(state.prefs);
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

$('openApp').addEventListener('click', async () => {
  try {
    await send({ type: 'openApp' });
    window.close();
  } catch (err) {
    showTransient('Could not launch Downpour: ' + err.message);
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
