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

/**
 * Host lists are edited one-per-line but pasted comma-separated just as often,
 * so accept both. A pasted URL is reduced to its host: typing
 * "https://example.com/downloads" and getting a rule that never matches is a
 * pointless way to lose ten minutes.
 */
function parseHostList(value) {
  return String(value || '')
    .split(/[\s,;]+/)
    .map((s) =>
      s
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[/?#].*$/, '')
        .replace(/^www\./, '')
        .replace(/^\./, '')
    )
    .filter(Boolean)
    .filter((host, i, all) => all.indexOf(host) === i);
}

function formatHostList(list) {
  return Array.isArray(list) ? list.join('\n') : '';
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
  $('bypassModifier').value = String(prefs.bypassModifier || 'alt');
  $('siteBlocklist').value = formatHostList(prefs.siteBlocklist);
  $('siteAllowlist').value = formatHostList(prefs.siteAllowlist);
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
    'excluded hosts: ' +
      (s.excludeHosts && s.excludeHosts.length ? s.excludeHosts.join(', ') : 'none') +
      ' (always honoured, even with the browser-side rules in charge)'
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

/* ------------------------------------------------------------------ *
 * Bypass key
 * ------------------------------------------------------------------ */

const BYPASS_LABEL = { alt: 'Alt', ctrl: 'Ctrl (or Cmd)', shift: 'Shift' };

$('bypassModifier').addEventListener('change', async (e) => {
  const value = e.target.value;
  try {
    await send({ type: 'setPrefs', prefs: { bypassModifier: value } });
    $('bypassMsg').textContent =
      value === 'none'
        ? 'Bypass disabled — every matching download goes to Downpour.'
        : 'Hold ' + BYPASS_LABEL[value] + ' to send one download to the browser.';
  } catch (err) {
    $('bypassMsg').textContent = 'Could not save: ' + err.message;
  }
});

/* ------------------------------------------------------------------ *
 * Per-site rules
 * ------------------------------------------------------------------ */

$('saveSites').addEventListener('click', async () => {
  const blocklist = parseHostList($('siteBlocklist').value);
  const allowlist = parseHostList($('siteAllowlist').value);

  // Show the user what was actually stored: the parser strips schemes, paths
  // and "www.", and silently rewriting what someone typed without showing it
  // back is how a rule ends up looking broken.
  $('siteBlocklist').value = formatHostList(blocklist);
  $('siteAllowlist').value = formatHostList(allowlist);

  try {
    await send({ type: 'setPrefs', prefs: { siteBlocklist: blocklist, siteAllowlist: allowlist } });
    $('sitesMsg').textContent = allowlist.length
      ? 'Saved. Capture now runs ONLY on the ' + allowlist.length + ' allowed site(s).'
      : 'Saved. ' + blocklist.length + ' site(s) will be skipped.';
    setTimeout(() => {
      $('sitesMsg').textContent = '';
    }, 4000);
  } catch (err) {
    $('sitesMsg').textContent = 'Could not save: ' + err.message;
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
