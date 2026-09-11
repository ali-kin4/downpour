'use strict';

/**
 * Downpour options page: pairing, the two-legged connection test, and the
 * capture rules.
 *
 * Like the popup, this page holds no protocol knowledge — everything goes
 * through the service worker.
 */

const $ = (id) => document.getElementById(id);

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

function setMsg(id, text, kind) {
  const el = $(id);
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.className = 'msg' + (kind ? ' ' + kind : '');
  el.textContent = text;
  el.hidden = false;
}

function parseList(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase().replace(/^[.*]+/, ''))
    .filter(Boolean);
}

function formatList(list) {
  return Array.isArray(list) ? list.join(', ') : '';
}

/* ------------------------------------------------------------------ *
 * Load
 * ------------------------------------------------------------------ */

async function load() {
  let state;
  try {
    state = await send({ type: 'getState', includeToken: true });
  } catch (err) {
    setMsg('tokenMsg', 'Could not talk to the extension worker: ' + err.message, 'err');
    return;
  }

  const { prefs, status, token } = state;
  $('token').value = token || '';
  $('captureEnabled').checked = Boolean(prefs.captureEnabled);
  $('useAppRules').checked = Boolean(prefs.useAppRules);
  $('minSizeMb').value = String((Number(prefs.minSizeBytes) || 0) / (1024 * 1024));
  $('includeExtensions').value = formatList(prefs.includeExtensions);
  $('excludeExtensions').value = formatList(prefs.excludeExtensions);
  $('excludeHosts').value = formatList(prefs.excludeHosts);
  $('version').textContent = status.appVersion ? 'app v' + status.appVersion : '';

  reflectRuleSource();

  if (status.state === 'unauthorized') {
    setMsg('tokenMsg', 'token invalid — re-pair in Downpour Settings', 'err');
  } else if (!token) {
    setMsg('tokenMsg', 'No token saved yet. Paste the one from the app and press Save.', 'warn');
  }
}

/** Grey out the browser-side rules when the app's rules are in charge. */
function reflectRuleSource() {
  const useApp = $('useAppRules').checked;
  const section = $('localRules');
  section.style.opacity = useApp ? '0.55' : '1';
  section.querySelectorAll('input, button').forEach((el) => {
    el.disabled = useApp;
  });
}

/* ------------------------------------------------------------------ *
 * Token
 * ------------------------------------------------------------------ */

$('saveToken').addEventListener('click', async () => {
  const token = $('token').value.trim();

  // Validated here purely as a typo catcher; the app is the real authority.
  if (token && !/^[0-9a-fA-F]{64}$/.test(token)) {
    setMsg(
      'tokenMsg',
      'That does not look like a Downpour token: it should be exactly 64 hexadecimal characters. Saving it anyway — press “Test connection” to check.',
      'warn'
    );
  }

  try {
    await send({ type: 'setToken', token });
    if (/^[0-9a-fA-F]{64}$/.test(token)) {
      setMsg('tokenMsg', 'Token saved. Press “Test connection” to verify it.', 'ok');
    } else if (!token) {
      setMsg('tokenMsg', 'Token cleared. Capture is off until you paste a new one.', 'warn');
    }
    setMsg('healthMsg', '');
    setMsg('authMsg', '');
  } catch (err) {
    setMsg('tokenMsg', 'Could not save the token: ' + err.message, 'err');
  }
});

$('toggleReveal').addEventListener('click', () => {
  const input = $('token');
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  $('toggleReveal').textContent = hidden ? 'Hide' : 'Show';
});

/* ------------------------------------------------------------------ *
 * Connection test — must say WHICH leg failed
 * ------------------------------------------------------------------ */

$('testConn').addEventListener('click', async () => {
  const btn = $('testConn');
  btn.disabled = true;
  setMsg('healthMsg', 'Probing 127.0.0.1:47113–47123 …');
  setMsg('authMsg', '');

  try {
    const r = await send({ type: 'testConnection' });

    setMsg(
      'healthMsg',
      (r.health.ok ? '1/2 App reachable — ' : '1/2 App NOT reachable — ') + r.health.detail,
      r.health.ok ? 'ok' : 'err'
    );

    if (r.health.ok) {
      setMsg(
        'authMsg',
        (r.auth.ok ? '2/2 Authentication OK — ' : '2/2 Authentication FAILED — ') + r.auth.detail,
        r.auth.ok ? 'ok' : 'err'
      );
    } else {
      setMsg('authMsg', '2/2 Authentication not tested — the app never answered.', 'warn');
    }

    if (r.settings) showAppRules(r.settings);
  } catch (err) {
    setMsg('healthMsg', 'The test itself failed: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

function showAppRules(s) {
  const parts = [
    'Capture ' + (s.enabled ? 'enabled' : 'disabled') + ' in the app',
    'size floor ' + (Number(s.minSizeBytes) ? formatBytes(s.minSizeBytes) : 'none'),
    'include: ' + (s.includeExtensions && s.includeExtensions.length ? s.includeExtensions.join(', ') : 'everything'),
    'exclude: ' + (s.excludeExtensions && s.excludeExtensions.length ? s.excludeExtensions.join(', ') : 'nothing'),
    'excluded hosts: ' + (s.excludeHosts && s.excludeHosts.length ? s.excludeHosts.join(', ') : 'none')
  ];
  setMsg('appRulesPreview', 'Rules currently reported by the app:\n• ' + parts.join('\n• '));
}

function formatBytes(n) {
  const mb = Number(n) / (1024 * 1024);
  return mb >= 1 ? mb.toFixed(mb % 1 ? 1 : 0) + ' MB' : Number(n) + ' bytes';
}

/* ------------------------------------------------------------------ *
 * Capture settings
 * ------------------------------------------------------------------ */

$('captureEnabled').addEventListener('change', async (e) => {
  try {
    await send({ type: 'setPrefs', prefs: { captureEnabled: e.target.checked } });
  } catch (err) {
    e.target.checked = !e.target.checked;
    setMsg('tokenMsg', 'Could not save: ' + err.message, 'err');
  }
});

$('useAppRules').addEventListener('change', async (e) => {
  reflectRuleSource();
  try {
    await send({ type: 'setPrefs', prefs: { useAppRules: e.target.checked } });
  } catch (err) {
    e.target.checked = !e.target.checked;
    reflectRuleSource();
    setMsg('tokenMsg', 'Could not save: ' + err.message, 'err');
  }
});

$('saveRules').addEventListener('click', async () => {
  const mb = Number($('minSizeMb').value);
  if (!isFinite(mb) || mb < 0) {
    $('rulesMsg').textContent = 'Size floor must be zero or more.';
    return;
  }
  const prefs = {
    minSizeBytes: Math.round(mb * 1024 * 1024),
    includeExtensions: parseList($('includeExtensions').value),
    excludeExtensions: parseList($('excludeExtensions').value),
    excludeHosts: parseList($('excludeHosts').value)
  };
  try {
    await send({ type: 'setPrefs', prefs });
    $('rulesMsg').textContent = 'Saved.';
    setTimeout(() => {
      $('rulesMsg').textContent = '';
    }, 2500);
  } catch (err) {
    $('rulesMsg').textContent = 'Could not save: ' + err.message;
  }
});

load();
