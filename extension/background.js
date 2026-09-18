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

// /api/v1/media/probe and /media/resolve both SPAWN yt-dlp and wait for it.
// The app bounds a probe at 90s; 45s is the point past which a user watching a
// spinner has concluded the feature is broken anyway, and a timeout here just
// means the menu says so instead of hanging. Never use this for anything that
// is not a media route — an 8s ceiling is what keeps the ordinary hand-off
// from stalling the download UI.
const MEDIA_TIMEOUT_MS = 45000;
const CAPTURE_TTL_MS = 30000; // protocol says cache /api/v1/capture ~30s

// Protocol caps the body at 256 KB. Stay well under it: cookies are long and
// our size estimate is a serialisation, not the exact wire body.
const BODY_BUDGET_BYTES = 200 * 1024;

const TOKEN_HEADER = 'X-Downpour-Token';

// How long after a modifier key was last seen held a download still counts as
// "the user asked for this one to go to the browser". Long enough to cover the
// gap between the click and the server's first response byte, short enough
// that a stray Alt press does not disable capture for the rest of the session.
const BYPASS_WINDOW_MS = 2000;

// A grabbed page is handed to grabber.html through chrome.storage.session.
// Session storage is capped (1 MB on Chrome 102), so the collector is bounded.
const GRAB_MAX_ITEMS = 1000;
const GRAB_LABEL_MAX = 120;
const GRAB_KEEP = 3; // how many previous grabs to leave in session storage

// The protocol caps a batch at 500 items as well as at 256 KB.
const BATCH_MAX_ITEMS = 500;

const STORE = {
  token: 'token',
  port: 'port',
  prefs: 'prefs',
  captureCache: 'captureCache',
  status: 'status'
};

/** chrome.storage.session keys — cleared when the browser closes. */
const SESSION = {
  modifiers: 'modifiers', // { alt: ts, ctrl: ts, shift: ts }
  grabPrefix: 'grab:',
  grabIndex: 'grabIndex'
};

/** Local (extension-side) preferences. */
const DEFAULT_PREFS = {
  captureEnabled: true, // the user toggle from the popup
  useAppRules: true, // follow /api/v1/capture instead of the local fields
  minSizeBytes: 0,
  includeExtensions: [], // empty = everything not excluded
  excludeExtensions: ['html', 'htm', 'css', 'js', 'json', 'svg', 'php'],
  excludeHosts: [],

  // Hold this key while starting a download to let that ONE download go to the
  // browser. 'alt' | 'ctrl' | 'shift' | 'none'.
  bypassModifier: 'alt',

  // Per-site rules. These apply ALWAYS — they are not part of the
  // "app rules vs browser rules" switch, because "never capture from this
  // site" has to mean never.
  siteBlocklist: [], // hosts we must not capture from
  siteAllowlist: [], // if non-empty, capture ONLY from these hosts

  // The floating "download this video" pill drawn over video elements by
  // video-overlay.js. Its own switches, deliberately separate from capture:
  // someone can want their downloads intercepted without wanting anything
  // drawn on top of the pages they visit.
  videoOverlayEnabled: true,
  videoOverlayHosts: [], // hosts where the pill is suppressed

  // Hide Chrome's own download shelf/bubble while capture is on.
  //
  // Off by default, and deliberately so. It is a browser-wide setting, not a
  // per-download one: while it is on, a download the user deliberately sent to
  // the browser with the bypass modifier loses its progress UI too. Someone who
  // wants every download in Downpour will want this; someone who switches
  // between the two will not.
  hideBrowserDownloadUi: false
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
    // yt-dlp's own stderr — "Video unavailable", "Sign in to confirm your
    // age", "Unsupported URL", "yt-dlp is not installed at …". It is the only
    // useful information in the failure, so it is passed through untouched
    // rather than flattened into "probe failed".
    case 'media_unavailable':
      return detail || 'Downpour could not read this video page';
    case 'media_page':
      return 'That is a video page, not a file — ask Downpour for its formats instead';
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

/**
 * chrome.storage.session — in-memory, per browser session, survives service
 * worker restarts. Used for things that must outlive the worker but must NOT
 * outlive the browser: which modifier keys are being held, and the pending
 * link-grab payload.
 */
function getSession(keys) {
  return chrome.storage.session.get(keys);
}

function setSession(items) {
  return chrome.storage.session.set(items);
}

/* ------------------------------------------------------------------ *
 * Modifier-key bypass
 * ------------------------------------------------------------------ */

/**
 * Record that a modifier was held. Called from the modifier-keys.js content
 * script, which throttles and only reports while a key is actually down.
 *
 * Stored per key rather than as one "last event" record so that releasing
 * Shift does not wipe the fact that Alt is still down.
 */
async function noteModifiers(msg) {
  const at = Number(msg && msg.at) || Date.now();
  const data = await getSession(SESSION.modifiers);
  const current = Object.assign({ alt: 0, ctrl: 0, shift: 0 }, data[SESSION.modifiers] || {});
  if (msg.alt) current.alt = at;
  if (msg.ctrl) current.ctrl = at;
  if (msg.shift) current.shift = at;
  await setSession({ [SESSION.modifiers]: current });
  return { noted: true };
}

/**
 * Was the bypass modifier held around the time this download started?
 *
 * Compares against the EARLIER of "now" and the download's own startTime. The
 * event usually fires within milliseconds of the click, but a slow server can
 * put seconds between the two, and a fixed window measured from `now` would
 * then miss a bypass the user really did perform.
 */
async function bypassRequested(item, prefs) {
  const key = String(prefs.bypassModifier || 'alt').toLowerCase();
  if (key === 'none' || !['alt', 'ctrl', 'shift'].includes(key)) return false;

  const data = await getSession(SESSION.modifiers);
  const held = data[SESSION.modifiers] || {};
  const ts = Number(held[key]) || 0;
  if (!ts) return false;

  let reference = Date.now();
  if (item && item.startTime) {
    const started = Date.parse(item.startTime);
    if (isFinite(started) && started > 0) reference = Math.min(reference, started);
  }
  return reference - ts <= BYPASS_WINDOW_MS && reference - ts >= -BYPASS_WINDOW_MS;
}

// 'ctrl' also covers Cmd on macOS — see modifier-keys.js, which folds metaKey
// into ctrlKey. The label has to admit that or Mac users are told the wrong key.
const MODIFIER_LABEL = { alt: 'Alt', ctrl: 'Ctrl/Cmd', shift: 'Shift', none: '' };

function modifierLabel(prefs) {
  return MODIFIER_LABEL[String((prefs && prefs.bypassModifier) || 'alt').toLowerCase()] || '';
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
async function apiRequest(
  path,
  { method = 'GET', body = null, retryOnRescan = true, timeoutMs = REQUEST_TIMEOUT_MS } = {}
) {
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
    res = await fetchWithTimeout(baseUrl(port) + path, init, timeoutMs);
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
      return apiRequest(path, { method, body, retryOnRescan: false, timeoutMs });
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
 * When "use the app's rules" is off, the local fields win outright — EXCEPT
 * for two things that always apply:
 *
 *   - the app's own `excludeHosts`, because a host the desktop app refuses to
 *     handle should not be handed to it from the browser either; and
 *   - the per-site allow/block lists, which are a user instruction rather
 *     than a filter preference.
 *
 * That means the capture settings are fetched even when `useAppRules` is off.
 * It costs one request per 30 seconds and the existing stale-cache fallback
 * absorbs an app that is momentarily down.
 */
function effectiveRules(prefs, appSettings) {
  const appHosts = appSettings && Array.isArray(appSettings.excludeHosts) ? appSettings.excludeHosts : [];

  const base = prefs.useAppRules
    ? (() => {
        const s = appSettings || FALLBACK_APP_SETTINGS;
        return {
          enabled: s.enabled !== false,
          minSizeBytes: Number(s.minSizeBytes) || 0,
          includeExtensions: normaliseExtList(s.includeExtensions),
          excludeExtensions: normaliseExtList(s.excludeExtensions),
          excludeHosts: Array.isArray(s.excludeHosts) ? s.excludeHosts : []
        };
      })()
    : {
        enabled: true,
        minSizeBytes: Number(prefs.minSizeBytes) || 0,
        includeExtensions: normaliseExtList(prefs.includeExtensions),
        excludeExtensions: normaliseExtList(prefs.excludeExtensions),
        excludeHosts: Array.isArray(prefs.excludeHosts) ? prefs.excludeHosts : []
      };

  base.excludeHosts = base.excludeHosts.concat(
    prefs.useAppRules ? [] : appHosts, // already in there when the app's rules are in charge
    normaliseHostList(prefs.siteBlocklist)
  );
  base.allowHosts = normaliseHostList(prefs.siteAllowlist);
  return base;
}

function normaliseHostList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((h) =>
      String(h || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/[/?#].*$/, '')
        .replace(/^www\./, '')
        .replace(/^\./, '')
    )
    .filter(Boolean);
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

  // Check BOTH the download's own host and the page that started it. A file on
  // cdn.example.net linked from example.com must be covered by "never capture
  // from example.com", otherwise the rule looks broken every time a site uses
  // a separate download domain.
  const hosts = [hostOf(url), hostOf(item.referrer || '')].filter(Boolean);

  const blocked = hosts.find((h) => hostExcluded(h, rules.excludeHosts));
  if (blocked) return { intercept: false, reason: 'host excluded: ' + blocked };

  if (rules.allowHosts && rules.allowHosts.length > 0) {
    if (!hosts.some((h) => hostExcluded(h, rules.allowHosts))) {
      return { intercept: false, reason: 'host not on the allowlist: ' + (hosts[0] || '?') };
    }
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

  // THE ONE-OFF ESCAPE HATCH. Checked before anything else, and before any
  // network traffic: "let this one go to the browser" should cost nothing and
  // should work even when the app is unreachable.
  if (await bypassRequested(item, prefs)) {
    console.debug('[Downpour] bypass modifier held — letting the browser download', item.finalUrl || item.url);
    return;
  }

  const token = await getToken();
  if (!token) {
    // Not paired yet: do nothing, but make the badge say why.
    await setStatus({ state: STATE.noToken });
    return;
  }

  // Never let a bad token turn into a request per download.
  const status = await getStatus();
  if (status.state === STATE.unauthorized) return;

  // Fetched even when `useAppRules` is off: the app's excludeHosts are always
  // honoured (see effectiveRules). Cached for 30s, so this is not a request
  // per download.
  let appSettings = null;
  try {
    appSettings = await getAppCaptureSettings();
  } catch (err) {
    // Offline and 401 stop capture outright regardless of whose rules are in
    // charge: with no reachable app there is nothing to hand the download to,
    // and carrying on would only mean the POST failing a moment later. The
    // browser keeps the download either way, which is the outcome that
    // matters.
    if (err instanceof OfflineError) return;
    if (err instanceof AuthError) return; // already surfaced by apiRequest

    // The app answered, it just answered badly. If its rules are in charge we
    // cannot decide anything, so stop and say so. If the browser-side rules
    // are in charge we only lose the app's excludeHosts, which is not worth
    // abandoning a capture the user configured locally.
    if (prefs.useAppRules) {
      await reportError('Could not read capture settings: ' + (err && err.message));
      return;
    }
    console.warn('[Downpour] could not read capture settings:', err && err.message);
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
  grab: 'downpour-grab',
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
    id: MENU.grab,
    title: 'Grab links from this page…',
    contexts: ['page', 'frame']
  });
  chrome.contextMenus.create({
    id: MENU.pageLinks,
    title: 'Download all links on this page',
    contexts: ['page', 'frame']
  });
  chrome.contextMenus.create({
    id: MENU.selection,
    title: 'Send selected links to Downpour',
    contexts: ['selection']
  });
}

/* ------------------------------------------------------------------ *
 * Chrome's own download UI
 * ------------------------------------------------------------------ */

/**
 * Hides or restores the browser's download shelf/bubble.
 *
 * Capture cannot stop Chrome starting a download -- `onDeterminingFilename`
 * has to return before we know whether the app will take it, and holding it
 * open freezes the browser. So Chrome's UI appears for as long as the hand-off
 * takes, then the download is cancelled out from under it. Suppressing that UI
 * is the only way to make the flash go away.
 *
 * Feature-detected rather than assumed: `setUiOptions` is recent, and an older
 * Chrome should lose this quietly rather than throw on every startup. The
 * permission it needs is declared in the manifest, and a Chrome that does not
 * recognise it ignores it.
 *
 * Applied on install and on startup because it does not survive a browser
 * restart -- it is a request by this extension, not a stored browser setting.
 */
async function applyDownloadUiPreference() {
  if (!chrome.downloads || typeof chrome.downloads.setUiOptions !== 'function') return;
  try {
    const prefs = await getPrefs();
    await chrome.downloads.setUiOptions({ enabled: !prefs.hideBrowserDownloadUi });
  } catch (err) {
    // Another extension holds the setting, or the permission was refused.
    // Neither is worth interrupting the user over: the cost is a visible
    // download shelf, which is what they had before.
    console.info('[Downpour] could not set the browser download UI:', err && err.message);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  installContextMenus().catch((err) => console.warn('[Downpour] menu install failed', err));
  applyDownloadUiPreference();
  // First run with no token: take the user straight to pairing.
  if (details.reason === 'install') {
    getToken().then((token) => {
      if (!token) chrome.runtime.openOptionsPage();
    });
  }
});

chrome.runtime.onStartup.addListener(() => {
  installContextMenus().catch((err) => console.warn('[Downpour] menu install failed', err));
  applyDownloadUiPreference();
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
  if (info.menuItemId === MENU.grab) return startGrab(tab && tab.id, info.frameId);
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

  const result = await queueUrls(raw, {
    startMode: 'addonly', // a whole page of links should not all start at once
    source: 'extension-page-links',
    pageUrl: info.pageUrl,
    pageTitle: (payload && payload.title) || (tab && tab.title) || undefined
  });
  if (result.sent === 0) throw new Error('No downloadable links found on this page.');
  return result;
}

/**
 * Attach headers to a list of URLs and hand them to POST /downloads/batch.
 *
 * Shared by "download all links", the link grabber and anything else that
 * queues more than one URL, so that cookie handling, chunking and the badge
 * feedback exist once. Nothing here cancels a browser download, so the
 * POST-then-cancel rule is satisfied by construction.
 */
async function queueUrls(rawUrls, { startMode, source, pageUrl, pageTitle }) {
  // Dedupe and drop anything the app would reject with 400 anyway.
  const seen = new Set();
  const urls = [];
  for (const u of rawUrls || []) {
    if (!isHttpUrl(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    urls.push(u);
  }
  if (urls.length === 0) return { sent: 0, accepted: 0, rejected: 0 };

  const cookieCache = new Map();
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const items = [];
  for (const url of urls) {
    const headers = {};
    const cookie = await cookieHeaderCached(url, cookieCache);
    if (cookie) headers['Cookie'] = cookie;
    if (pageUrl && isHttpUrl(pageUrl)) headers['Referer'] = pageUrl;
    if (ua) headers['User-Agent'] = ua;
    items.push({
      url,
      headers,
      startMode: startMode === 'start' ? 'start' : 'addonly',
      source: source || 'extension',
      pageTitle: pageTitle || undefined
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
  return { sent: items.length, accepted, rejected };
}

/**
 * Split a batch so no single request breaks either of the protocol's two
 * limits: 256 KB of body and 500 items. Cookie headers are long and a
 * link-heavy page can produce hundreds of items, so neither cap is theoretical
 * — a page of short, cookie-free URLs hits the count limit long before the
 * byte limit.
 */
function chunkByBodySize(items) {
  const chunks = [];
  let current = [];
  let size = 2; // "[]"
  for (const item of items) {
    const encoded = JSON.stringify(item).length + 1;
    if (current.length > 0 && (size + encoded > BODY_BUDGET_BYTES || current.length >= BATCH_MAX_ITEMS)) {
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

/** Injected: the full selection, not Chrome's truncated copy of it. */
function readSelectionInPage() {
  const sel = window.getSelection();
  return sel ? sel.toString() : '';
}

/**
 * Send the selected text to the app, verbatim.
 *
 * NO URL PARSING HAPPENS HERE, on purpose. `POST /api/v1/downloads/text`
 * exists precisely so that there is exactly one URL extractor in the system,
 * in the app. A second, subtly different regex in the extension would mean
 * "the same selection gives different results depending on how you sent it",
 * which is the worst kind of bug to explain.
 *
 * That is also why there is no local "does this even look like a link?"
 * pre-check: deciding that is the app's job, and the `accepted === 0` path
 * below already says so clearly.
 */
async function sendSelectionText(info, tab) {
  // info.selectionText is truncated by Chrome (a few hundred characters), so a
  // pasted list of twenty links would silently lose most of itself. Read the
  // real selection from the frame that was right-clicked, and fall back to
  // Chrome's copy if injection is not allowed there.
  let text = '';
  if (tab && typeof tab.id === 'number') {
    const target = { tabId: tab.id };
    if (info.frameId) target.frameIds = [info.frameId];
    try {
      const results = await chrome.scripting.executeScript({ target, func: readSelectionInPage });
      const value = results && results[0] && results[0].result;
      if (typeof value === 'string') text = value;
    } catch (_) {
      /* injection blocked on this page — use what the menu gave us */
    }
  }
  if (!text) text = info.selectionText || '';
  text = text.trim();
  if (!text) throw new Error('Nothing selected.');

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
 * Link grabber
 *
 * Collect every downloadable-looking URL on a page, then show the user a
 * picker BEFORE anything is queued.
 *
 * The picker is its own extension page (grabber.html) opened in a tab, not a
 * popup and not an injected overlay:
 *   - a 320px popup cannot host a filterable list of 400 links, and it closes
 *     the instant focus moves;
 *   - an injected overlay inherits the host page's CSS resets, z-index wars
 *     and `!important` rules, and would have to be defended against every
 *     site on the internet.
 * An extension page has its own origin, its own stylesheet and nothing to
 * fight with.
 *
 * The list travels through chrome.storage.session rather than a message: the
 * service worker can be killed between opening the tab and the tab asking for
 * its data, and session storage survives that while module scope does not.
 * ------------------------------------------------------------------ */

/**
 * Injected into every frame. Must be entirely self-contained — it is
 * serialised and evaluated in the page, so it can close over nothing.
 *
 * Returns absolute, deduplicated, http(s)-only URLs. `data:`, `blob:`,
 * `javascript:` and `mailto:` are dropped here rather than later: they are
 * never fetchable by the app and would only clutter the picker.
 */
function collectGrabbablesInPage(maxItems, labelMax) {
  const out = [];
  const seen = new Set();
  const base = document.baseURI || location.href;

  // The page's own address, so that same-page anchors (href="#section") do not
  // turn into "download this page" once the fragment is stripped.
  const selfUrl = (function () {
    try {
      const u = new URL(location.href);
      u.hash = '';
      return u.href;
    } catch (_) {
      return '';
    }
  })();

  function clean(text) {
    if (!text) return '';
    return String(text).replace(/\s+/g, ' ').trim().slice(0, labelMax);
  }

  function add(raw, kind, label) {
    if (out.length >= maxItems || !raw) return;
    let abs;
    try {
      abs = new URL(String(raw).trim(), base);
    } catch (_) {
      return;
    }
    // The single protocol test that kills data:, blob:, javascript:, mailto:,
    // about: and every other scheme in one go.
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
    abs.hash = ''; // #anchor variants of one URL are one file
    const url = abs.href;
    if (url === selfUrl) return; // a link back to this very page is not a file
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url: url, kind: kind, label: clean(label) });
  }

  // srcset is "url descriptor, url descriptor". URLs may legally contain a
  // comma, which no simple split survives; taking the first whitespace-
  // delimited token of each comma-separated entry and letting `new URL()`
  // reject the wreckage is the pragmatic trade.
  function addSrcset(value, kind, label) {
    if (!value) return;
    String(value)
      .split(',')
      .forEach(function (entry) {
        const first = entry.trim().split(/\s+/)[0];
        if (first) add(first, kind, label);
      });
  }

  document.querySelectorAll('a[href]').forEach(function (a) {
    add(a.getAttribute('href'), 'link', a.textContent || a.getAttribute('title'));
  });

  document.querySelectorAll('img').forEach(function (img) {
    const label = img.getAttribute('alt') || img.getAttribute('title');
    add(img.getAttribute('src'), 'image', label);
    addSrcset(img.getAttribute('srcset'), 'image', label);
  });

  document.querySelectorAll('picture source[srcset]').forEach(function (s) {
    addSrcset(s.getAttribute('srcset'), 'image', '');
  });

  document.querySelectorAll('video, audio').forEach(function (m) {
    const kind = m.tagName.toLowerCase() === 'video' ? 'video' : 'audio';
    const label = m.getAttribute('title') || m.getAttribute('aria-label');
    add(m.getAttribute('src'), kind, label);
    add(m.getAttribute('poster'), 'image', label);
    m.querySelectorAll('source').forEach(function (s) {
      add(s.getAttribute('src'), kind, label || s.getAttribute('type'));
      addSrcset(s.getAttribute('srcset'), kind, label);
    });
  });

  document.querySelectorAll('embed[src]').forEach(function (e) {
    add(e.getAttribute('src'), 'embed', e.getAttribute('type'));
  });
  document.querySelectorAll('object[data]').forEach(function (e) {
    add(e.getAttribute('data'), 'embed', e.getAttribute('type'));
  });

  // CSS background images on VISIBLE elements only.
  //
  // getComputedStyle is the expensive call here — it can force style and
  // layout flushes — so the cheap geometry test runs first and the scan is
  // hard-capped. This runs synchronously in the page, but only ever because
  // the user explicitly asked for a grab.
  const STYLE_SCAN_CAP = 4000;
  let scanned = 0;
  const all = document.body ? document.body.querySelectorAll('*') : [];
  for (let i = 0; i < all.length; i++) {
    if (scanned >= STYLE_SCAN_CAP || out.length >= maxItems) break;
    const el = all[i];
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue; // display:none, collapsed, empty
    scanned++;
    let bg;
    try {
      bg = getComputedStyle(el).backgroundImage;
    } catch (_) {
      continue;
    }
    if (!bg || bg === 'none') continue;
    const re = /url\((['"]?)(.*?)\1\)/g;
    let m;
    while ((m = re.exec(bg)) !== null) add(m[2], 'background', el.getAttribute('aria-label') || '');
  }

  return {
    url: location.href,
    title: document.title,
    items: out,
    truncated: out.length >= maxItems
  };
}

/**
 * Run the collector over a tab and open the picker.
 *
 * `allFrames: true` returns one result per frame and individual frames can
 * come back with a null result (sandboxed, about:blank, cross-origin quirks).
 * One bad frame must not discard the other nine, so results are merged
 * defensively. The whole call still rejects when the TOP frame is off limits
 * — chrome://, the Web Store, the PDF viewer — which is the case worth an
 * explanatory error.
 */
async function startGrab(tabId, frameId) {
  if (typeof tabId !== 'number') throw new Error('No page to scan.');

  const args = [GRAB_MAX_ITEMS, GRAB_LABEL_MAX];
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: collectGrabbablesInPage,
      args
    });
  } catch (err) {
    // Some pages refuse allFrames outright. Fall back to the single frame the
    // user was actually looking at before giving up.
    const target = { tabId };
    if (frameId) target.frameIds = [frameId];
    try {
      results = await chrome.scripting.executeScript({ target, func: collectGrabbablesInPage, args });
    } catch (err2) {
      throw new Error('Cannot read this page (Chrome blocks extensions on it): ' + (err2 && err2.message));
    }
  }

  const seen = new Set();
  const items = [];
  let pageUrl = '';
  let pageTitle = '';
  let truncated = false;

  for (const frame of results || []) {
    if (items.length >= GRAB_MAX_ITEMS) {
      truncated = true;
      break;
    }
    const payload = frame && frame.result;
    if (!payload || !Array.isArray(payload.items)) continue;
    if (frame.frameId === 0 || !pageUrl) {
      pageUrl = payload.url || pageUrl;
      pageTitle = payload.title || pageTitle;
    }
    if (payload.truncated) truncated = true;
    for (const entry of payload.items) {
      if (items.length >= GRAB_MAX_ITEMS) {
        truncated = true;
        break;
      }
      if (!entry || typeof entry.url !== 'string') continue;
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      items.push(entry);
    }
  }

  if (items.length === 0) throw new Error('Nothing downloadable found on this page.');

  const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  await storeGrab(id, { id, pageUrl, pageTitle, items, truncated, at: Date.now() });

  await chrome.tabs.create({
    url: chrome.runtime.getURL('grabber.html') + '?id=' + encodeURIComponent(id)
  });
  return { id, count: items.length, truncated };
}

/**
 * Persist a grab for the picker tab to collect.
 *
 * chrome.storage.session is capped (1 MB on Chrome 102, 10 MB later), and a
 * page of long URLs with long labels can get close. Rather than failing with
 * an empty picker and no explanation, degrade: drop the labels, then drop the
 * tail of the list, and only then give up with something the user can read.
 */
async function storeGrab(id, record) {
  await pruneGrabs(id);
  const key = SESSION.grabPrefix + id;

  const attempts = [
    record,
    Object.assign({}, record, {
      items: record.items.map((i) => ({ url: i.url, kind: i.kind })),
      labelsDropped: true
    }),
    Object.assign({}, record, {
      items: record.items.slice(0, 300).map((i) => ({ url: i.url, kind: i.kind })),
      labelsDropped: true,
      truncated: true
    })
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    try {
      await setSession({ [key]: attempt });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    'That page produced more links than the extension can hand over at once (' +
      (lastErr && lastErr.message ? lastErr.message : 'session storage full') +
      '). Try grabbing a narrower page.'
  );
}

/** Keep only the most recent few grabs; session storage is not a filing cabinet. */
async function pruneGrabs(newId) {
  const data = await getSession(SESSION.grabIndex);
  const index = Array.isArray(data[SESSION.grabIndex]) ? data[SESSION.grabIndex] : [];
  index.push(newId);
  const drop = index.slice(0, Math.max(0, index.length - GRAB_KEEP));
  const keep = index.slice(-GRAB_KEEP);
  if (drop.length > 0) {
    try {
      await chrome.storage.session.remove(drop.map((i) => SESSION.grabPrefix + i));
    } catch (_) {
      /* nothing to clean up */
    }
  }
  await setSession({ [SESSION.grabIndex]: keep });
}

async function readGrab(id) {
  const key = SESSION.grabPrefix + String(id || '');
  const data = await getSession(key);
  const record = data[key];
  if (!record) {
    throw new Error(
      'That list has expired. Grabs are kept only for the current browser session — run “Grab links” again.'
    );
  }
  return record;
}

/* ------------------------------------------------------------------ *
 * Video overlay — the pill drawn over videos by video-overlay.js
 * ------------------------------------------------------------------ */

/**
 * Content-script-visible configuration. Deliberately two booleans and nothing
 * else: the overlay has no business knowing the token, the port, the capture
 * rules or the host lists, and a content script runs in every page the user
 * visits. The less it can be asked for, the less a compromised page could
 * learn if it ever found a way to impersonate one.
 */
/**
 * Sites whose video is DRM-protected as a matter of course.
 *
 * The overlay already refuses a video that has told it it is encrypted, but
 * that verdict arrives per-video and only once the player has got far enough
 * to say so — too late for the trailer on a title page, and no help at all on
 * the browse grid, where a pill can appear over a preview that is not itself
 * encrypted but belongs to a library that entirely is. Nothing on these sites
 * can be downloaded by Downpour, by yt-dlp, or by any other tool, so the
 * honest thing is to never offer.
 *
 * Kept SEPARATE from `videoOverlayHosts`: that list is the user's own, it is
 * shown to them in options, and a built-in that silently appeared in it would
 * be both surprising and deletable. This one is a fact about the site.
 */
const DRM_ONLY_HOSTS = [
  'netflix.com',
  'primevideo.com',
  'disneyplus.com',
  'hulu.com',
  'max.com',
  'hbomax.com',
  'peacocktv.com',
  'paramountplus.com',
  'tv.apple.com',
  'britbox.com',
  'crave.ca',
  'stan.com.au',
  'skyshowtime.com'
];

async function videoOverlayConfig(host) {
  const prefs = await getPrefs();
  const clean = String(host || '').toLowerCase();
  return {
    enabled: prefs.videoOverlayEnabled !== false,
    siteBlocked: hostExcluded(clean, normaliseHostList(prefs.videoOverlayHosts)),
    drmSite: hostExcluded(clean, DRM_ONLY_HOSTS)
  };
}

/**
 * Size of a directly-downloadable video file.
 *
 * HEAD first; a server that answers HEAD with 405 (or with no length) gets a
 * one-byte ranged GET, and the total comes out of Content-Range. Both are
 * allowed to fail: hotlink protection, a missing Content-Length on a chunked
 * response, or a CORS policy that does not expose the header are all ordinary,
 * and the overlay renders the row without a size rather than hiding it.
 *
 * `credentials: 'include'` rather than a Cookie header, because Cookie is a
 * forbidden header name for fetch — the browser attaches the jar itself. The
 * same reason applies to Referer, which cannot be set here at all; a server
 * that demands one simply yields no size.
 */
const sizeProbeCache = new Map(); // url -> { bytes, at }
const SIZE_CACHE_TTL_MS = 5 * 60 * 1000;
const SIZE_PROBE_TIMEOUT_MS = 6000;

async function probeFileSize(url) {
  if (!isHttpUrl(url)) return { bytes: null };

  const cached = sizeProbeCache.get(url);
  if (cached && Date.now() - cached.at < SIZE_CACHE_TTL_MS) return { bytes: cached.bytes };

  let bytes = null;
  try {
    const res = await fetchWithTimeout(
      url,
      { method: 'HEAD', credentials: 'include', cache: 'no-store', redirect: 'follow' },
      SIZE_PROBE_TIMEOUT_MS
    );
    if (res.ok) {
      const len = Number(res.headers.get('content-length'));
      if (len > 0) bytes = len;
    }
  } catch (_) {
    /* fall through to the ranged GET */
  }

  if (bytes === null) {
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          headers: { Range: 'bytes=0-0' }
        },
        SIZE_PROBE_TIMEOUT_MS
      );
      const range = res.headers.get('content-range');
      const m = range && /\/(\d+)\s*$/.exec(range);
      if (m) bytes = Number(m[1]);
      // One byte of body, but leaving it unread keeps the connection open.
      if (res.body && typeof res.body.cancel === 'function') {
        res.body.cancel().catch(() => {});
      }
    } catch (_) {
      /* no size available; that is a normal outcome */
    }
  }

  if (sizeProbeCache.size > 200) sizeProbeCache.clear();
  sizeProbeCache.set(url, { bytes, at: Date.now() });
  return { bytes };
}

/* ---- media probe / resolve ---- */

/**
 * Formats for a media page.
 *
 * FAILURE IS DATA HERE, NOT AN EXCEPTION. A `502 media_unavailable` is the
 * single most likely outcome on a random page — yt-dlp not installed, an
 * unsupported site, a private video — and it is something the menu renders,
 * not something that breaks it. So it comes back as a result object carrying
 * yt-dlp's own words. Offline and auth errors still throw: those are problems
 * with the extension's link to the app, not with the page, and the pill
 * already has wording for them.
 */
const mediaProbeCache = new Map(); // pageUrl -> { result, at }
const MEDIA_PROBE_TTL_MS = 3 * 60 * 1000;

async function videoOverlayProbe(url) {
  if (!isHttpUrl(url)) throw new Error('That page has no address Downpour can read.');

  const cached = mediaProbeCache.get(url);
  if (cached && Date.now() - cached.at < MEDIA_PROBE_TTL_MS) return cached.result;

  let result;
  try {
    const info = await apiRequest('/api/v1/media/probe', {
      method: 'POST',
      body: { url },
      timeoutMs: MEDIA_TIMEOUT_MS
    });
    await clearError();
    result = { ok: true, info };
  } catch (err) {
    if (err instanceof ApiError && err.status === 502) {
      const detail = err.body && typeof err.body.detail === 'string' ? err.body.detail : '';
      result = {
        ok: false,
        detail: detail || 'Downpour could not read this page.',
        // Worth its own case: it is the one failure the user can fix in thirty
        // seconds, and the fix is a button in the app rather than a mystery.
        notInstalled: /not installed/i.test(detail)
      };
    } else {
      throw err;
    }
  }

  // Only metadata is cached. `resolve` is always run fresh because the direct
  // URLs it returns are signed and expire in minutes — see docs/media.md.
  //
  // "yt-dlp is not installed" is the one answer NOT worth remembering: it is
  // the failure the user is most likely to go and fix in the next thirty
  // seconds, and serving it back for three minutes afterwards makes the fix
  // look like it did not work. Other failures — unsupported site, private
  // video — are stable, and caching them is what stops every menu open on a
  // non-media page from spawning yt-dlp again.
  if (!result.ok && result.notInstalled) return result;

  if (mediaProbeCache.size > 24) mediaProbeCache.clear();
  mediaProbeCache.set(url, { result, at: Date.now() });
  return result;
}

/**
 * Turn a chosen format into a queued download.
 *
 * THE HEADERS FROM `resolve` GO STRAIGHT THROUGH, UNMERGED. They are the exact
 * set yt-dlp used, the app has already stripped the ones that would corrupt a
 * ranged download (`Accept-Encoding` above all), and the URLs are signed CDN
 * links that answer 403 without them. Folding our own Cookie/Referer/UA in on
 * top would be guessing against a source that already knows the answer.
 */
async function videoOverlayResolve(pageUrl, formatId, pageTitle) {
  if (!isHttpUrl(pageUrl)) throw new Error('That page has no address Downpour can read.');
  if (!formatId) throw new Error('No format was chosen.');

  const resolved = await apiRequest('/api/v1/media/resolve', {
    method: 'POST',
    body: { url: pageUrl, formatId: String(formatId) },
    timeoutMs: MEDIA_TIMEOUT_MS
  });

  if (!resolved || !isHttpUrl(resolved.url)) {
    throw new Error('Downpour returned no usable address for that format.');
  }

  const payload = {
    url: resolved.url,
    headers: resolved.headers && typeof resolved.headers === 'object' ? resolved.headers : {},
    startMode: 'start',
    source: 'extension-video-overlay',
    pageTitle: typeof pageTitle === 'string' ? pageTitle.slice(0, 300) : undefined
  };
  const filename = baseNameOf(String(resolved.filename || ''));
  if (filename) payload.filename = filename;
  if (Number(resolved.filesize) > 0) payload.sizeHint = Number(resolved.filesize);

  const result = await postDownload(payload);
  await clearError();
  await flashBadge('1');
  return Object.assign({ mode: 'format' }, result);
}

/**
 * Hand a chosen video to the app.
 *
 * TWO MODES, AND THE DIFFERENCE MATTERS.
 *
 * `file` — a real media file the browser can see the URL of. Queued with
 * `start`, with the full header set, exactly like an intercepted download.
 * Nothing else is needed: no yt-dlp, no probe, no app-side resolution.
 *
 * `page` — the URL of a page whose video is streamed, used ONLY when the probe
 * could not answer. It is sent with **`addonly`** and the app window is
 * raised, so the link lands visibly in the queue, inert, for the user to deal
 * with in the app itself.
 *
 * `addonly` is not a preference. `POST /api/v1/downloads` now rejects a
 * recognised media page sent with `start` (422 `media_page`) precisely because
 * queueing one used to save the watch page's HTML and report success. Sending
 * it added-but-not-started is the one way this route can carry a page URL at
 * all, and it is the fallback rather than the main path for the same reason.
 */
async function videoOverlaySend(msg) {
  const url = String(msg && msg.url ? msg.url : '');
  if (!isHttpUrl(url)) throw new Error('That video has no downloadable address.');

  const pageTitle = typeof msg.pageTitle === 'string' ? msg.pageTitle.slice(0, 300) : undefined;

  if (msg.mode === 'page') {
    // Cookies still go along: an age-gated or subscriber-only page is
    // unresolvable without them, whoever ends up doing the resolving.
    const headers = await collectHeaders(url, null);
    const result = await postDownload({
      url,
      headers,
      startMode: 'addonly',
      source: 'extension-video-page',
      pageTitle
    });
    // Raise the window: an item added but not started is only useful if the
    // user is looking at the place it was added to.
    try {
      await apiRequest('/api/v1/show', { method: 'POST' });
    } catch (_) {
      /* the add succeeded; failing to focus is not worth an error */
    }
    await clearError();
    return Object.assign({ mode: 'page' }, result);
  }

  const referrer = isHttpUrl(msg.pageUrl) ? msg.pageUrl : null;
  const headers = await collectHeaders(url, referrer);
  const payload = {
    url,
    headers,
    startMode: 'start',
    source: 'extension-video-overlay',
    pageTitle
  };
  const filename = baseNameOf(String(msg.filename || ''));
  if (filename) payload.filename = filename;
  const size = Number(msg.sizeHint);
  if (size > 0) payload.sizeHint = size;

  const result = await postDownload(payload);
  await clearError();
  await flashBadge('1');
  return Object.assign({ mode: 'file' }, result);
}

/* ------------------------------------------------------------------ *
 * Messages from popup / options / content scripts
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
    // From the modifier-keys content script. Kept first and kept cheap: this
    // is the only message that arrives without a user opening any of our UI.
    case 'modifierHeld':
      return noteModifiers(msg);

    case 'getState': {
      const [status, prefs, token] = await Promise.all([getStatus(), getPrefs(), getToken()]);
      return {
        status,
        prefs,
        hasToken: Boolean(token),
        token: msg.includeToken ? token : undefined,
        bypassLabel: modifierLabel(prefs)
      };
    }

    /* ---- per-site rules ---- */

    case 'setSiteRule': {
      const host = normaliseHostList([msg.host])[0];
      if (!host) throw new Error('That page has no host to add a rule for.');
      const list = msg.list === 'allow' ? 'siteAllowlist' : 'siteBlocklist';
      const prefs = await getPrefs();
      const current = normaliseHostList(prefs[list]);
      const next = msg.on ? current.concat(current.includes(host) ? [] : [host]) : current.filter((h) => h !== host);
      const saved = await setPrefs({ [list]: next });
      return { prefs: saved, host };
    }

    /* ---- video overlay ---- */

    case 'videoOverlayConfig':
      return videoOverlayConfig(msg.host);

    case 'pair': {
      // Asks the app to hand over the token. Only answered while the user has
      // a pairing window open, which they open by clicking in the app -- so a
      // refusal here is nearly always "you have not clicked it yet", and the
      // message says so rather than reporting a bare 403.
      // A full scan rather than the cached port: pairing is the one moment the
      // extension may know nothing yet, including where the app is.
      const { port } = await discoverPort(true);
      const res = await fetchWithTimeout(
        baseUrl(port) + '/api/v1/pair',
        { method: 'POST', cache: 'no-store' },
        PROBE_TIMEOUT_MS
      );
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body.error === 'no_pairing_window'
            ? 'Downpour is not expecting a pairing right now. In the app open Settings -> Browser integration and press "Pair a browser", then try again within a minute.'
            : 'Downpour refused the pairing request.'
        );
      }
      if (!res.ok) throw new ApiError(res.status, null);
      const body = await res.json();
      if (!body || typeof body.token !== 'string' || body.token.length < 32) {
        throw new Error('Downpour returned something that is not a token.');
      }
      await setToken(body.token);
      await cachePort(port);
      await setStatus({ state: STATE.ok, port, lastError: null });
      return { ok: true };
    }

    case 'setHideBrowserDownloadUi': {
      await setPrefs({ hideBrowserDownloadUi: Boolean(msg.on) });
      await applyDownloadUiPreference();
      const supported =
        Boolean(chrome.downloads) && typeof chrome.downloads.setUiOptions === 'function';
      return { on: Boolean(msg.on), supported };
    }

    case 'videoOverlaySetEnabled': {
      const prefs = await setPrefs({ videoOverlayEnabled: Boolean(msg.on) });
      return { enabled: prefs.videoOverlayEnabled };
    }

    case 'videoOverlayBlockSite': {
      const host = normaliseHostList([msg.host])[0];
      if (!host) throw new Error('That page has no host to add a rule for.');
      const prefs = await getPrefs();
      const current = normaliseHostList(prefs.videoOverlayHosts);
      if (current.includes(host)) return { host, hosts: current };
      const next = current.concat([host]);
      await setPrefs({ videoOverlayHosts: next });
      return { host, hosts: next };
    }

    case 'videoOverlaySize':
      return probeFileSize(String(msg.url || ''));

    case 'videoOverlayProbe':
      return videoOverlayProbe(String(msg.url || ''));

    case 'videoOverlayResolve':
      return videoOverlayResolve(String(msg.url || ''), msg.formatId, msg.pageTitle);

    case 'videoOverlaySend':
      return videoOverlaySend(msg);

    /* ---- link grabber ---- */

    case 'grabLinks': {
      let tabId = Number(msg.tabId);
      if (!isFinite(tabId) || tabId < 0) {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!active) throw new Error('No active tab to scan.');
        tabId = active.id;
      }
      return startGrab(tabId, 0);
    }

    case 'getGrab':
      return readGrab(msg.id);

    case 'queueGrabbed':
      return queueUrls(msg.urls, {
        startMode: msg.startMode === 'start' ? 'start' : 'addonly',
        source: 'extension-link-grabber',
        pageUrl: msg.pageUrl,
        pageTitle: msg.pageTitle
      });

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
 * "Open Downpour" — POST /api/v1/show, which brings the app's window to the
 * foreground and answers 204.
 *
 * This used to navigate a throwaway tab to a `downpour://` URL. That scheme
 * was never registered by the app, so the button did nothing at all and
 * failed silently, which is the worst of both worlds. The endpoint is
 * authenticated and reports offline / bad-token through the same paths as
 * every other call, so the popup can now say why it did not work.
 *
 * The 204 has no body: apiRequest returns null and that is a success.
 */
async function openDesktopApp() {
  await apiRequest('/api/v1/show', { method: 'POST' });
  await clearError();
  return { shown: true };
}

/* ------------------------------------------------------------------ *
 * Startup
 * ------------------------------------------------------------------ */

// Paint the badge from whatever we persisted last, so a freshly-woken worker
// does not show a stale or blank state.
getStatus()
  .then(paintBadge)
  .catch(() => {});
