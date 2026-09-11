'use strict';

/**
 * Downpour browser extension — MV3 service worker.
 *
 * Implements the client side of docs/rpc-protocol.md (protocol version 1).
 *
 * MV3 CONSTRAINTS THAT SHAPE THIS FILE — please read before editing:
 *
 * 1. The service worker is killed aggressively (roughly 30s idle). Anything
 *    that must survive lives in chrome.storage.local. Module-scope variables
 *    are treated as a *cache only*: every read path must work when they are
 *    undefined because the worker just woke up.
 *
 * 2. All chrome.* listeners are registered synchronously at the top level of
 *    this file. Registering inside an async callback means the worker wakes
 *    up with no listener attached and the event is lost.
 *
 * 3. No timers for expiry. setTimeout does not survive worker death, so TTLs
 *    are timestamp comparisons evaluated lazily on read.
 *
 * 4. Nothing here blocks the browser's download UI. onDeterminingFilename
 *    calls suggest() synchronously and then does its work fire-and-forget.
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

// Port range from the protocol: default 47113, app tries the next 10.
const PORT_MIN = 47113;
const PORT_MAX = 47123;

const PROBE_TIMEOUT_MS = 1200; // per-port /health probe
const REQUEST_TIMEOUT_MS = 8000; // normal API call
const CAPTURE_TTL_MS = 30000; // protocol says cache /api/v1/capture ~30s

// Protocol caps the body at 256 KB. Stay well under it: cookies are long and
// our size estimate is a serialisation, not the exact wire body.
const BODY_BUDGET_BYTES = 200 * 1024;

const TOKEN_HEADER = 'X-Downpour-Token';

// Custom scheme the desktop app is expected to register for "Open Downpour".
// See README — if the app has not registered it, the tab simply fails to open
// and the popup keeps showing the connection status instead.
const APP_URL_SCHEME = 'downpour://open';

const STORE = {
  token: 'token',
  port: 'port',
  prefs: 'prefs',
  captureCache: 'captureCache',
  status: 'status'
};

/** Local (extension-side) preferences. */
const DEFAULT_PREFS = {
  captureEnabled: true, // the user toggle from the popup
  useAppRules: true, // follow /api/v1/capture instead of the local fields
  minSizeBytes: 0,
  includeExtensions: [], // empty = everything not excluded
  excludeExtensions: ['html', 'htm', 'css', 'js', 'json', 'svg', 'php'],
  excludeHosts: []
};

/**
 * Fallback capture rules, used only when the app has never answered
 * /api/v1/capture. Deliberately permissive except for page-ish types: if we
 * cannot reach the app we will not be capturing anything anyway.
 */
const FALLBACK_APP_SETTINGS = {
  enabled: true,
  minSizeBytes: 0,
  includeExtensions: [],
  excludeHosts: [],
  excludeExtensions: ['html', 'htm', 'css', 'js', 'json', 'svg']
};

/** Connection states surfaced to the popup. */
const STATE = {
  unknown: 'unknown',
  connected: 'connected',
  offline: 'offline', // app not running / connection refused
  unauthorized: 'unauthorized', // 401 — bad or missing token
  noToken: 'no_token' // user has not pasted a token yet
};

/* ------------------------------------------------------------------ *
 * Errors — the three outcomes are NOT interchangeable
 * ------------------------------------------------------------------ */

/** The app could not be reached at all (connection refused, timeout). */
class OfflineError extends Error {
  constructor(message) {
    super(message || 'Downpour is not reachable on 127.0.0.1');
    this.name = 'OfflineError';
  }
}

/**
 * HTTP 401, or no token saved at all. Never retried in a loop.
 *
 * The two cases need different words: someone who has never paired should not
 * be told to "re-pair", they should be told where the token comes from.
 */
class AuthError extends Error {
  constructor(noToken) {
    super(
      noToken
        ? "Downpour isn't paired yet — paste the token from the app into the extension's options page."
        : 'token invalid — re-pair in Downpour Settings'
    );
    this.name = 'AuthError';
    this.noToken = Boolean(noToken);
  }
}

/** Any other non-2xx from the app (400 / 413 / 500 ...). */
class ApiError extends Error {
  constructor(status, body) {
    super(describeApiError(status, body));
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function describeApiError(status, body) {
  const code = body && typeof body.error === 'string' ? body.error : null;
  const detail = body && typeof body.detail === 'string' ? body.detail : null;
  switch (code) {
    case 'invalid_url':
      return 'Downpour rejected the URL (must be http or https)';
    case 'payload_too_large':
      return 'Request too large for Downpour (over 256 KB)';
    case 'internal':
      return 'Downpour hit an internal error' + (detail ? ': ' + detail : '');
    default:
      return 'Downpour returned HTTP ' + status + (code ? ' (' + code + ')' : '');
  }
}

/* ------------------------------------------------------------------ *
 * Storage helpers
 * ------------------------------------------------------------------ */

function getLocal(keys) {
  return chrome.storage.local.get(keys);
}

function setLocal(items) {
  return chrome.storage.local.set(items);
}

// In-memory fast paths. Always fall back to storage — the worker may have
// been restarted a millisecond ago and these will be undefined.
let memPort = null;
let memToken = null;

async function getToken() {
  if (memToken !== null) return memToken;
  const data = await getLocal(STORE.token);
  memToken = typeof data[STORE.token] === 'string' ? data[STORE.token] : '';
  return memToken;
}

async function setToken(token) {
  memToken = token;
  await setLocal({ [STORE.token]: token });
}

async function getPrefs() {
  const data = await getLocal(STORE.prefs);
  return Object.assign({}, DEFAULT_PREFS, data[STORE.prefs] || {});
}

async function setPrefs(patch) {
  const next = Object.assign(await getPrefs(), patch);
  await setLocal({ [STORE.prefs]: next });
  return next;
}

/* ------------------------------------------------------------------ *
 * Status + badge — errors must be visible, never swallowed
 * ------------------------------------------------------------------ */

async function getStatus() {
  const data = await getLocal(STORE.status);
  return Object.assign(
    { state: STATE.unknown, port: null, appVersion: null, lastError: null, lastErrorAt: 0 },
    data[STORE.status] || {}
  );
}

async function setStatus(patch) {
  const current = await getStatus();
  const next = Object.assign({}, current, patch);
  // Skip the write when nothing actually changed: this is called after every
  // successful request, and a storage write per download is pure overhead.
  const changed = Object.keys(next).some((k) => next[k] !== current[k]);
  if (!changed) return current;
  await setLocal({ [STORE.status]: next });
  await paintBadge(next);
  return next;
}

async function paintBadge(status) {
  let text = '';
  let color = '#6366F1';
  let title = 'Downpour';

  if (status.state === STATE.unauthorized) {
    text = '!';
    color = '#DC2626';
    title = 'Downpour — token invalid, re-pair in Downpour Settings';
  } else if (status.state === STATE.noToken) {
    text = '?';
    color = '#F59E0B';
    title = 'Downpour — not paired yet, open the options page';
  } else if (status.lastError) {
    text = '!';
    color = '#DC2626';
    title = 'Downpour — ' + status.lastError;
  } else if (status.state === STATE.offline) {
    text = '';
    title = 'Downpour — app not running';
  } else if (status.state === STATE.connected) {
    text = '';
    title = 'Downpour — connected on port ' + status.port;
  }

  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    await chrome.action.setTitle({ title });
  } catch (_) {
    /* action API can be unavailable very early in worker startup */
  }
}

/** Record a user-visible failure. Nothing in this file fails silently. */
async function reportError(message) {
  console.warn('[Downpour]', message);
  await setStatus({ lastError: String(message), lastErrorAt: Date.now() });
}

async function clearError() {
  const status = await getStatus();
  if (status.lastError) await setStatus({ lastError: null, lastErrorAt: 0 });
}

/** Briefly flash a success count on the badge (batch adds). */
async function flashBadge(text) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#22D3EE' });
    await chrome.action.setBadgeText({ text: String(text) });
  } catch (_) {
    /* ignore */
  }
  // No setTimeout for teardown: the worker may die first. The badge is
  // repainted on the next status write, and the popup clears it on open.
}

/* ------------------------------------------------------------------ *
 * Port discovery
 * ------------------------------------------------------------------ */

function baseUrl(port) {
  return 'http://127.0.0.1:' + port;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /health on one port. Returns the parsed body, or null if this port is
 * not Downpour (refused, timed out, or answered with something else).
 */
async function probePort(port) {
  try {
    const res = await fetchWithTimeout(baseUrl(port) + '/health', { method: 'GET', cache: 'no-store' }, PROBE_TIMEOUT_MS);
    if (!res.ok) return null;
    const body = await res.json();
    if (body && body.app === 'downpour' && body.ok === true) return body;
    return null;
  } catch (_) {
    // Connection refused / aborted / not JSON — just not our app here.
    return null;
  }
}

/** Cached port, if any. May be stale; callers re-probe on failure. */
async function getCachedPort() {
  if (memPort) return memPort;
  const data = await getLocal(STORE.port);
  memPort = typeof data[STORE.port] === 'number' ? data[STORE.port] : null;
  return memPort;
}

async function cachePort(port) {
  memPort = port;
  await setLocal({ [STORE.port]: port });
}

/**
 * Find the app. Tries the cached port first, then walks 47113..47123.
 * Returns { port, health } or throws OfflineError.
 *
 * Ports are probed sequentially rather than in parallel: eleven simultaneous
 * connections to loopback against an app that accepts 32 is rude, and the
 * cached-port hit means we almost never walk the range.
 */
async function discoverPort(forceRescan) {
  if (!forceRescan) {
    const cached = await getCachedPort();
    if (cached) {
      const health = await probePort(cached);
      if (health) return { port: cached, health };
    }
  }
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    const health = await probePort(port);
    if (health) {
      await cachePort(port);
      return { port, health };
    }
  }
  memPort = null;
  await setLocal({ [STORE.port]: null });
  throw new OfflineError();
}

/**
 * Port to use for a normal API call. Trusts the cached value WITHOUT probing
 * /health first — probing before every request would double the traffic and
 * the latency on the hot path (one hand-off per download). If the cached port
 * is stale the request itself fails, and apiRequest rescans once.
 */
async function resolvePort() {
  const cached = await getCachedPort();
  if (cached) return cached;
  const found = await discoverPort(true);
  return found.port;
}

/* ------------------------------------------------------------------ *
 * API client
 * ------------------------------------------------------------------ */

/**
 * Call an authenticated endpoint.
 *
 * Throws exactly one of:
 *   OfflineError — app unreachable (caller must NOT cancel a download)
 *   AuthError    — 401 (caller must NOT retry)
 *   ApiError     — any other non-2xx
 *
 * Note on CORS: <all_urls> host permission covers http://127.0.0.1, so a
 * service-worker fetch here is not CORS-constrained and a thrown TypeError
 * really does mean "nothing is listening", which is what makes the
 * offline branch trustworthy.
 */
async function apiRequest(path, { method = 'GET', body = null, retryOnRescan = true } = {}) {
  const token = await getToken();
  if (!token) {
    await setStatus({ state: STATE.noToken });
    throw new AuthError(true);
  }

  const port = await resolvePort();

  const init = {
    method,
    cache: 'no-store',
    headers: { [TOKEN_HEADER]: token }
  };
  if (body !== null) {
    init.headers['Content-Type'] = 'application/json; charset=utf-8';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetchWithTimeout(baseUrl(port) + path, init, REQUEST_TIMEOUT_MS);
  } catch (err) {
    // The cached port may simply be stale (app restarted onto another port).
    // Re-probe the whole range once, then give up and report offline.
    if (retryOnRescan) {
      try {
        await discoverPort(true);
      } catch (_) {
        await setStatus({ state: STATE.offline, port: null, appVersion: null });
        throw new OfflineError();
      }
      return apiRequest(path, { method, body, retryOnRescan: false });
    }
    await setStatus({ state: STATE.offline, port: null, appVersion: null });
    throw new OfflineError(err && err.message);
  }

  if (res.status === 401) {
    // Do not retry. A bad token stays bad until the user re-pairs.
    await setStatus({ state: STATE.unauthorized, port });
    throw new AuthError();
  }

  let parsed = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      parsed = null;
    }
  }

  if (!res.ok) throw new ApiError(res.status, parsed);

  await setStatus({ state: STATE.connected, port });
  return parsed;
}

/* ------------------------------------------------------------------ *
 * Capture settings (cached ~30s, per the protocol)
 * ------------------------------------------------------------------ */

async function getAppCaptureSettings({ allowStale = true } = {}) {
  const data = await getLocal(STORE.captureCache);
  const cached = data[STORE.captureCache];
  const fresh = cached && Date.now() - cached.fetchedAt < CAPTURE_TTL_MS;
  if (fresh) return cached.settings;

  try {
    const settings = await apiRequest('/api/v1/capture');
    await setLocal({ [STORE.captureCache]: { settings, fetchedAt: Date.now() } });
    return settings;
  } catch (err) {
    // Stale is better than nothing: if the app is momentarily down we still
    // want a sane decision, and the POST itself will fail safely anyway.
    if (allowStale && cached) return cached.settings;
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Capture decision
 * ------------------------------------------------------------------ */

function fileExtensionOf(name) {
  if (!name) return '';
  const clean = String(name).split(/[?#]/)[0];
  const base = clean.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function isHttpUrl(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch (_) {
    return false;
  }
}

function hostExcluded(host, list) {
  if (!host || !Array.isArray(list)) return false;
  return list.some((entry) => {
    const e = String(entry || '').trim().toLowerCase().replace(/^\./, '');
    if (!e) return false;
    return host === e || host.endsWith('.' + e);
  });
}

/**
 * Merge the app's advisory rules with the user's local preferences.
 * When "use the app's rules" is off, the local fields win outright.
 */
function effectiveRules(prefs, appSettings) {
  if (prefs.useAppRules) {
    const s = appSettings || FALLBACK_APP_SETTINGS;
    return {
      enabled: s.enabled !== false,
      minSizeBytes: Number(s.minSizeBytes) || 0,
      includeExtensions: normaliseExtList(s.includeExtensions),
      excludeExtensions: normaliseExtList(s.excludeExtensions),
      excludeHosts: Array.isArray(s.excludeHosts) ? s.excludeHosts : []
    };
  }
  return {
    enabled: true,
    minSizeBytes: Number(prefs.minSizeBytes) || 0,
    includeExtensions: normaliseExtList(prefs.includeExtensions),
    excludeExtensions: normaliseExtList(prefs.excludeExtensions),
    excludeHosts: Array.isArray(prefs.excludeHosts) ? prefs.excludeHosts : []
  };
}

function normaliseExtList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => String(e || '').trim().toLowerCase().replace(/^[.*]+/, ''))
    .filter(Boolean);
}

/**
 * Decide whether to hand this download to Downpour.
 * Returns { intercept: boolean, reason: string }.
 */
function decideCapture(item, rules) {
  if (!isHttpUrl(item.finalUrl || item.url)) {
    return { intercept: false, reason: 'not an http(s) URL' };
  }
  if (!rules.enabled) return { intercept: false, reason: 'capture disabled by the app' };

  const url = item.finalUrl || item.url;
  const host = hostOf(url);
  if (hostExcluded(host, rules.excludeHosts)) {
    return { intercept: false, reason: 'host excluded: ' + host };
  }

  const ext = fileExtensionOf(item.filename) || fileExtensionOf(url);
  if (ext && rules.excludeExtensions.includes(ext)) {
    return { intercept: false, reason: 'extension excluded: .' + ext };
  }
  if (rules.includeExtensions.length > 0 && !rules.includeExtensions.includes(ext)) {
    return { intercept: false, reason: 'extension not in the include list' };
  }

  // SIZE FLOOR — read this before "fixing" it.
  // At onDeterminingFilename the response headers are frequently not parsed
  // yet, so totalBytes is 0 and fileSize is -1 for a great many real
  // downloads. Comparing an unknown size against the floor would skip
  // essentially everything. Only apply the floor when we actually have a
  // positive byte count.
  const known = knownSize(item);
  if (rules.minSizeBytes > 0 && known > 0 && known < rules.minSizeBytes) {
    return { intercept: false, reason: 'below the size floor (' + known + ' bytes)' };
  }

  return { intercept: true, reason: 'ok' };
}

function knownSize(item) {
  const total = Number(item.totalBytes);
  if (total > 0) return total;
  const file = Number(item.fileSize);
  if (file > 0) return file;
  return 0;
}

/* ------------------------------------------------------------------ *
 * Header collection — the reason this extension exists
 * ------------------------------------------------------------------ */

/**
 * Build the request headers Downpour needs to fetch the file as the browser
 * would have. Without Cookie, session-gated downloads come back as a login
 * page and "succeed" at a few KB of HTML.
 *
 * Empty values are omitted entirely rather than sent as "" — an empty
 * Referer header is worse than no Referer header.
 */
async function collectHeaders(url, referrer) {
  const headers = {};

  const cookie = await cookieHeaderFor(url);
  if (cookie) headers['Cookie'] = cookie;

  if (referrer && isHttpUrl(referrer)) headers['Referer'] = referrer;

  // WorkerNavigator exposes userAgent; this matches what the page sent.
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    headers['User-Agent'] = navigator.userAgent;
  }

  return headers;
}

/** Serialise all cookies (including httpOnly) that apply to this exact URL. */
async function cookieHeaderFor(url) {
  if (!isHttpUrl(url)) return '';
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies || cookies.length === 0) return '';
    return cookies.map((c) => c.name + '=' + c.value).join('; ');
  } catch (err) {
    // Not fatal: the download may not need cookies at all. But say so.
    console.warn('[Downpour] could not read cookies for', url, err);
    return '';
  }
}

/** Cookie lookups are per-URL; batches reuse them per origin. */
async function cookieHeaderCached(url, cache) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch (_) {
    return '';
  }
  if (cache.has(origin)) return cache.get(origin);
  const value = await cookieHeaderFor(url);
  cache.set(origin, value);
  return value;
}

/* ------------------------------------------------------------------ *
 * Download hand-off
 * ------------------------------------------------------------------ */

async function postDownload(payload) {
  return apiRequest('/api/v1/downloads', { method: 'POST', body: payload });
}

/**
 * THE CANCEL-VS-FALLBACK ORDER. Do not reorder this.
 *
 * We POST first and cancel only after a 201. If the app is closed, the POST
 * throws OfflineError and the browser's own download — which we never
 * touched — just carries on. That is the whole requirement: losing a user's
 * file because Downpour was not running is unacceptable.
 *
 * Cancelling first and "re-creating the download on failure" would also
 * work, but re-created downloads lose the original request context and
 * re-fire onDeterminingFilename. POST-then-cancel needs neither.
 */
async function handOffDownload(item) {
  const url = item.finalUrl || item.url;

  let payload;
  try {
    const headers = await collectHeaders(url, item.referrer);
    payload = {
      url,
      headers,
      filename: baseNameOf(item.filename),
      destDir: null,
      startMode: 'start',
      source: 'extension'
      // No pageTitle here: onDeterminingFilename gives us the referrer URL
      // but not the originating tab's title.
    };
    const size = knownSize(item);
    if (size > 0) payload.sizeHint = size;
  } catch (err) {
    await reportError('Could not prepare the download: ' + (err && err.message));
    return; // browser download proceeds
  }

  try {
    await postDownload(payload);
  } catch (err) {
    if (err instanceof OfflineError) {
      // Silent-ish by design: the user still gets their file from Chrome.
      // The popup shows "app not running" via the status we just wrote.
      console.info('[Downpour] app not running — letting Chrome download', url);
    } else if (err instanceof AuthError) {
      await reportError(err.message);
    } else {
      await reportError('Hand-off failed: ' + (err && err.message));
    }
    return; // NOTHING was cancelled — the browser download is untouched
  }

  // 201 received: Downpour owns this download now. Take Chrome's copy away.
  await cancelBrowserDownload(item.id);
  await clearError();
}

async function cancelBrowserDownload(id) {
  try {
    await chrome.downloads.cancel(id);
  } catch (err) {
    // Races with a download that already finished (tiny files, cached
    // responses). Report it: the user may now have a duplicate file.
    await reportError(
      'Downpour took over, but Chrome had already finished its own copy — check your Downloads folder for a duplicate.'
    );
    return;
  }
  try {
    // Removes the (now cancelled) entry from Chrome's download shelf/history.
    // It does not delete anything from disk; cancel() already discarded the
    // partial file.
    await chrome.downloads.erase({ id });
  } catch (err) {
    console.warn('[Downpour] could not erase the cancelled download entry', err);
  }
}

function baseNameOf(path) {
  if (!path) return undefined;
  const base = String(path).split(/[\\/]/).pop();
  return base || undefined;
}

/* ------------------------------------------------------------------ *
 * chrome.downloads.onDeterminingFilename — the capture entry point
 * ------------------------------------------------------------------ */

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // Accept Chrome's default filename immediately and synchronously. Holding
  // this callback open would freeze the browser's download UI while we talk
  // to the app, which the protocol explicitly warns against.
  suggest();

  // Never intercept a download this extension itself created — that would
  // re-enter this listener forever.
  if (item.byExtensionId && item.byExtensionId === chrome.runtime.id) return;

  // Fire-and-forget. Any rejection is reported inside.
  maybeCapture(item).catch((err) => reportError('Capture failed: ' + (err && err.message)));
});

async function maybeCapture(item) {
  const prefs = await getPrefs();
  if (!prefs.captureEnabled) return; // user toggle in the popup

  const token = await getToken();
  if (!token) {
    // Not paired yet: do nothing, but make the badge say why.
    await setStatus({ state: STATE.noToken });
    return;
  }

  // Never let a bad token turn into a request per download.
  const status = await getStatus();
  if (status.state === STATE.unauthorized) return;

  let appSettings = null;
  if (prefs.useAppRules) {
    try {
      appSettings = await getAppCaptureSettings();
    } catch (err) {
      if (err instanceof OfflineError) return; // app closed — let Chrome download
      if (err instanceof AuthError) return; // already surfaced by apiRequest
      await reportError('Could not read capture settings: ' + (err && err.message));
      return;
    }
  }

  const rules = effectiveRules(prefs, appSettings);
  const decision = decideCapture(item, rules);
  if (!decision.intercept) {
    console.debug('[Downpour] not capturing:', decision.reason, item.finalUrl || item.url);
    return;
  }

  await handOffDownload(item);
}

/* ------------------------------------------------------------------ *
 * Context menus
 * ------------------------------------------------------------------ */

const MENU = {
  link: 'downpour-link',
  pageLinks: 'downpour-page-links',
  selection: 'downpour-selection'
};

/**
 * contextMenus.create throws on a duplicate id, and both onInstalled and
 * onStartup can fire for the same profile. removeAll() first makes this
 * idempotent however many times it runs.
 */
async function installContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU.link,
    title: 'Download with Downpour',
    contexts: ['link', 'image', 'video', 'audio']
  });
  chrome.contextMenus.create({
    id: MENU.pageLinks,
    title: 'Download all links on this page',
    contexts: ['page', 'frame']
  });
  chrome.contextMenus.create({
    id: MENU.selection,
    title: 'Send selected text links to Downpour',
    contexts: ['selection']
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  installContextMenus().catch((err) => console.warn('[Downpour] menu install failed', err));
  // First run with no token: take the user straight to pairing.
  if (details.reason === 'install') {
    getToken().then((token) => {
      if (!token) chrome.runtime.openOptionsPage();
    });
  }
});

chrome.runtime.onStartup.addListener(() => {
  installContextMenus().catch((err) => console.warn('[Downpour] menu install failed', err));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleMenuClick(info, tab).catch((err) => reportError(friendlyError(err)));
});

function friendlyError(err) {
  if (err instanceof OfflineError) return 'Downpour is not running — start the app and try again.';
  // AuthError already carries the right wording for "never paired" vs "401".
  return (err && err.message) || String(err);
}

async function handleMenuClick(info, tab) {
  if (info.menuItemId === MENU.link) return sendSingleLink(info, tab);
  if (info.menuItemId === MENU.pageLinks) return sendAllPageLinks(info, tab);
  if (info.menuItemId === MENU.selection) return sendSelectionText(info, tab);
}

async function sendSingleLink(info, tab) {
  const url = info.linkUrl || info.srcUrl;
  if (!isHttpUrl(url)) throw new Error('That link is not an http(s) URL.');

  const headers = await collectHeaders(url, info.pageUrl);
  await postDownload({
    url,
    headers,
    destDir: null,
    startMode: 'start',
    source: 'extension-context-menu',
    pageTitle: (tab && tab.title) || undefined
  });
  await clearError();
  await flashBadge('1');
}

/**
 * Collect every href on the page. Injected with chrome.scripting rather than
 * a declared content script so the extension ships no content-script file
 * and no page ever runs our code unless the user asks for it.
 */
function collectLinksInPage() {
  const out = [];
  document.querySelectorAll('a[href]').forEach((a) => {
    // a.href is already resolved to an absolute URL by the DOM.
    if (a.href) out.push(a.href);
  });
  return { title: document.title, links: out };
}

async function sendAllPageLinks(info, tab) {
  if (!tab || typeof tab.id !== 'number') throw new Error('No page to scan.');

  // Scan the frame that was right-clicked; frameId 0 is the top frame, for
  // which the property must be omitted rather than passed as undefined.
  const target = { tabId: tab.id };
  if (info.frameId) target.frameIds = [info.frameId];

  let results;
  try {
    results = await chrome.scripting.executeScript({ target, func: collectLinksInPage });
  } catch (err) {
    throw new Error('Cannot read this page (Chrome blocks extensions on it): ' + (err && err.message));
  }

  const payload = results && results[0] && results[0].result;
  const raw = (payload && payload.links) || [];

  // Dedupe and drop anything the app would reject with 400 anyway.
  const seen = new Set();
  const urls = [];
  for (const u of raw) {
    if (!isHttpUrl(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    urls.push(u);
  }
  if (urls.length === 0) throw new Error('No downloadable links found on this page.');

  const cookieCache = new Map();
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const items = [];
  for (const url of urls) {
    const headers = {};
    const cookie = await cookieHeaderCached(url, cookieCache);
    if (cookie) headers['Cookie'] = cookie;
    if (info.pageUrl && isHttpUrl(info.pageUrl)) headers['Referer'] = info.pageUrl;
    if (ua) headers['User-Agent'] = ua;
    items.push({
      url,
      headers,
      startMode: 'addonly', // a whole page of links should not all start at once
      source: 'extension-page-links',
      pageTitle: (payload && payload.title) || (tab && tab.title) || undefined
    });
  }

  let accepted = 0;
  let rejected = 0;
  for (const chunk of chunkByBodySize(items)) {
    const res = await apiRequest('/api/v1/downloads/batch', { method: 'POST', body: { items: chunk } });
    accepted += (res && Number(res.accepted)) || 0;
    rejected += (res && Number(res.rejected)) || 0;
  }

  await clearError();
  await flashBadge(accepted > 99 ? '99+' : String(accepted));
  if (rejected > 0) {
    await reportError('Sent ' + accepted + ' links; Downpour rejected ' + rejected + '.');
  }
}

/**
 * Split a batch so no single request approaches the protocol's 256 KB body
 * cap. Cookie headers are long and a link-heavy page can produce hundreds of
 * items, so this is not theoretical.
 */
function chunkByBodySize(items) {
  const chunks = [];
  let current = [];
  let size = 2; // "[]"
  for (const item of items) {
    const encoded = JSON.stringify(item).length + 1;
    if (current.length > 0 && size + encoded > BODY_BUDGET_BYTES) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(item);
    size += encoded;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function sendSelectionText(info) {
  const text = (info.selectionText || '').trim();
  if (!text) throw new Error('Nothing selected.');
  if (!/https?:\/\//i.test(text)) throw new Error('No http(s) links in the selection.');

  // The app does the URL extraction (POST /api/v1/downloads/text).
  const res = await apiRequest('/api/v1/downloads/text', {
    method: 'POST',
    body: { text: text.slice(0, BODY_BUDGET_BYTES), startMode: 'addonly' }
  });
  const accepted = (res && Number(res.accepted)) || 0;
  await clearError();
  if (accepted === 0) throw new Error('Downpour found no usable links in the selection.');
  await flashBadge(String(accepted));
}

/* ------------------------------------------------------------------ *
 * Messages from popup / options
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Returning true keeps the message channel open for the async reply.
  handleMessage(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: friendlyError(err), kind: errorKind(err) }));
  return true;
});

function errorKind(err) {
  if (err instanceof OfflineError) return 'offline';
  if (err instanceof AuthError) return 'unauthorized';
  if (err instanceof ApiError) return 'api';
  return 'error';
}

async function handleMessage(msg) {
  switch (msg && msg.type) {
    case 'getState': {
      const [status, prefs, token] = await Promise.all([getStatus(), getPrefs(), getToken()]);
      return { status, prefs, hasToken: Boolean(token), token: msg.includeToken ? token : undefined };
    }

    case 'setPrefs':
      return setPrefs(msg.prefs || {});

    case 'setToken': {
      const token = String(msg.token || '').trim();
      await setToken(token);
      // A new token clears the "unauthorized" latch and the stale rules cache.
      await setLocal({ [STORE.captureCache]: null });
      await setStatus({
        state: token ? STATE.unknown : STATE.noToken,
        lastError: null,
        lastErrorAt: 0
      });
      return { saved: true };
    }

    case 'refreshStatus':
      return refreshStatus();

    case 'testConnection':
      return testConnection();

    case 'clearError':
      // Clear the transient error, then REPAINT FROM STATE rather than
      // blanking the badge. Blanking unconditionally would wipe the "token
      // invalid" / "not paired" markers, and setStatus's no-op short-circuit
      // means nothing would ever repaint them.
      await clearError();
      await paintBadge(await getStatus());
      return { cleared: true };

    case 'openApp':
      return openDesktopApp();

    default:
      throw new Error('Unknown message: ' + (msg && msg.type));
  }
}

/** Cheap health-only refresh, used when the popup opens. */
async function refreshStatus() {
  const token = await getToken();

  // Leg 1: is anything listening?
  let port, health;
  try {
    const found = await discoverPort(false);
    port = found.port;
    health = found.health;
  } catch (_) {
    return setStatus({ state: STATE.offline, port: null, appVersion: null });
  }

  const appVersion = health.version || null;
  if (!token) return setStatus({ state: STATE.noToken, port, appVersion });

  // Leg 2: health alone does not prove the token, so hit an authenticated
  // endpoint too.
  try {
    await apiRequest('/api/v1/capture');
  } catch (err) {
    if (err instanceof AuthError) return getStatus(); // apiRequest already set it
    if (err instanceof OfflineError) {
      return setStatus({ state: STATE.offline, port: null, appVersion: null });
    }
    // The app answered, it just answered badly (400/413/500). Reporting "not
    // running" here would send the user off to fix the wrong problem.
    return setStatus({
      state: STATE.connected,
      port,
      appVersion,
      lastError: friendlyError(err),
      lastErrorAt: Date.now()
    });
  }

  return setStatus({ state: STATE.connected, port, appVersion, lastError: null, lastErrorAt: 0 });
}

/**
 * Two-legged test for the options page: it must say WHICH leg failed —
 * "the app is not running" and "the app is running but rejected the token"
 * need completely different fixes from the user.
 */
async function testConnection() {
  const result = {
    health: { ok: false, detail: '' },
    auth: { ok: false, detail: '' },
    port: null,
    version: null,
    settings: null
  };

  let port, health;
  try {
    const found = await discoverPort(true); // always rescan on an explicit test
    port = found.port;
    health = found.health;
  } catch (_) {
    result.health.detail =
      'No response on 127.0.0.1:' + PORT_MIN + '–' + PORT_MAX + '. Is Downpour running?';
    await setStatus({ state: STATE.offline, port: null, appVersion: null });
    return result;
  }

  result.health.ok = true;
  result.port = port;
  result.version = health.version || null;
  result.health.detail =
    'Downpour ' + (health.version || '?') + ' answered on port ' + port + ' (protocol ' + health.protocol + ').';
  if (health.protocol !== 1) {
    result.health.detail += ' This extension speaks protocol 1 — update one side.';
  }

  const token = await getToken();
  if (!token) {
    result.auth.detail = 'No token saved yet. Copy it from Downpour → Settings → Browser integration.';
    await setStatus({ state: STATE.noToken, port, appVersion: health.version || null });
    return result;
  }

  try {
    const settings = await apiRequest('/api/v1/capture');
    result.auth.ok = true;
    result.settings = settings;
    result.auth.detail = 'Token accepted.';
    await setLocal({ [STORE.captureCache]: { settings, fetchedAt: Date.now() } });
    await setStatus({ state: STATE.connected, port, appVersion: health.version || null, lastError: null });
  } catch (err) {
    if (err instanceof AuthError) {
      result.auth.detail = 'The app is running but rejected the token — re-pair in Downpour Settings.';
    } else if (err instanceof OfflineError) {
      result.auth.detail = 'The app answered /health but then stopped responding.';
    } else {
      result.auth.detail = 'Authenticated request failed: ' + friendlyError(err);
    }
  }
  return result;
}

/**
 * "Open Downpour". There is no show-window endpoint in protocol v1, so this
 * relies on the desktop app registering the downpour:// URL scheme with
 * Windows. If it has not, Chrome quietly refuses to navigate and the tab we
 * opened is closed again — no harm, and the popup still reports status.
 */
async function openDesktopApp() {
  const tab = await chrome.tabs.create({ url: APP_URL_SCHEME, active: false });
  // The scheme handler takes over; the blank tab is not useful either way.
  try {
    await chrome.tabs.remove(tab.id);
  } catch (_) {
    /* already gone */
  }
  return { launched: true };
}

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

// Paint the badge from whatever we persisted last, so a freshly-woken worker
// does not show a stale or blank state.
getStatus()
  .then(paintBadge)
  .catch(() => {});
