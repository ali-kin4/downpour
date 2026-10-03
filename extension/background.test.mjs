/**
 * Downpour — tests for which browser downloads the extension takes over.
 *
 * WHY THE WHOLE SERVICE WORKER. The bug these cover is a caller bug: a
 * download produced by a form POST was handed to the app, which can only GET
 * it, and the browser's correct copy was cancelled. A test of a helper that
 * answers "was this a POST?" would pass whether or not the capture path asked
 * it. So the real background.js is evaluated against a stub `chrome` and a
 * stub app, driven with the events the browser sends — a navigation through
 * webRequest, then onDeterminingFilename — and the assertion is the thing the
 * user loses: was Chrome's own download cancelled.
 *
 * Run: node extension/background.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, 'background.js'), 'utf8');

const PORT = 47113;

/* ------------------------------------------------------------------ *
 * A browser and an app, in as few lines as will run the worker
 * ------------------------------------------------------------------ */

function makeEvent() {
  const listeners = [];
  return {
    addListener(fn) {
      listeners.push(fn);
    },
    fire(...args) {
      for (const fn of listeners) fn(...args);
    },
    get count() {
      return listeners.length;
    }
  };
}

function makeArea(backing) {
  return {
    async get(keys) {
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
      const out = {};
      for (const k of names) if (k in backing) out[k] = structuredClone(backing[k]);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) backing[k] = structuredClone(v);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete backing[k];
    }
  };
}

/**
 * One service worker lifetime. Pass the same `session` object to a second
 * call to model the worker being killed and woken: module scope is gone,
 * chrome.storage.session is not.
 */
function boot({ session = {} } = {}) {
  const calls = { handedOff: [], cancelled: [] };
  const local = {
    token: 'test-token',
    port: PORT,
    // Fresh capture settings, so the only app traffic is the hand-off itself.
    captureCache: {
      fetchedAt: Date.now(),
      settings: { enabled: true, minSizeBytes: 0, includeExtensions: [], excludeExtensions: ['html'], excludeHosts: [] }
    }
  };

  const chrome = {
    runtime: { id: 'downpour-test', onInstalled: makeEvent(), onStartup: makeEvent(), onMessage: makeEvent() },
    storage: { local: makeArea(local), session: makeArea(session) },
    downloads: {
      onDeterminingFilename: makeEvent(),
      async cancel(id) {
        calls.cancelled.push(id);
      },
      async erase() {}
    },
    webRequest: { onBeforeRequest: makeEvent() },
    contextMenus: { onClicked: makeEvent(), create() {}, removeAll: async () => {} },
    cookies: { getAll: async () => [] },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} }
  };

  async function fetch(url, init = {}) {
    const path = new URL(url).pathname;
    if (path === '/api/v1/downloads' && init.method === 'POST') {
      calls.handedOff.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'x', filename: 'f', status: 'queued' }), { status: 201 });
    }
    if (path === '/health') return new Response(JSON.stringify({ app: 'downpour', ok: true }), { status: 200 });
    return new Response('{}', { status: 404 });
  }

  const context = vm.createContext({
    chrome,
    fetch,
    Response,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    structuredClone,
    navigator: { userAgent: 'test-agent' },
    console: { log() {}, info() {}, debug() {}, warn() {}, error: console.error }
  });
  vm.runInContext(SOURCE, context, { filename: 'background.js' });

  assert.equal(chrome.webRequest.onBeforeRequest.count, 1, 'the worker must observe navigations');

  let nextId = 1;
  return {
    calls,
    navigate(url, method = 'GET', type = 'main_frame') {
      chrome.webRequest.onBeforeRequest.fire({ url, method, type, requestId: String(nextId++) });
    },
    download(url, finalUrl = url) {
      const item = { id: nextId++, url, finalUrl, filename: 'C:\\Downloads\\report.pdf', referrer: '', totalBytes: 0, fileSize: -1 };
      chrome.downloads.onDeterminingFilename.fire(item, () => {});
      return item.id;
    }
  };
}

/** Lets the fire-and-forget capture path run to the end. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

// The control. If this fails the harness is broken, and every "was not
// cancelled" below would be passing for the wrong reason.
test('an ordinary GET download is handed over and the browser copy cancelled', async () => {
  const w = boot();
  w.navigate('https://example.com/file.zip');
  const id = w.download('https://example.com/file.zip');
  await settle();
  assert.equal(w.calls.handedOff.length, 1);
  assert.deepEqual(w.calls.cancelled, [id]);
});

test('a download nobody saw navigate to is captured as before', async () => {
  const w = boot();
  const id = w.download('https://example.com/file.zip');
  await settle();
  assert.deepEqual(w.calls.cancelled, [id]);
});

test('a download produced by a form POST stays with the browser', async () => {
  const w = boot();
  w.navigate('https://bank.example/statements/export', 'POST');
  w.download('https://bank.example/statements/export');
  await settle();
  assert.equal(w.calls.handedOff.length, 0, 'the app cannot GET what the form POSTed');
  assert.deepEqual(w.calls.cancelled, [], "the browser's copy is the only correct one");
});

test('a POST from a frame stays with the browser too', async () => {
  const w = boot();
  w.navigate('https://reports.example/run', 'POST', 'sub_frame');
  w.download('https://reports.example/run');
  await settle();
  assert.deepEqual(w.calls.cancelled, []);
});

test('a POST answered by a redirect to a GET is captured', async () => {
  const w = boot();
  w.navigate('https://example.com/export', 'POST');
  w.navigate('https://cdn.example.com/out/report.pdf', 'GET');
  const id = w.download('https://example.com/export', 'https://cdn.example.com/out/report.pdf');
  await settle();
  assert.equal(w.calls.handedOff.length, 1);
  assert.equal(w.calls.handedOff[0].url, 'https://cdn.example.com/out/report.pdf');
  assert.deepEqual(w.calls.cancelled, [id]);
});

test('a POST whose final hop was never seen stays with the browser', async () => {
  const w = boot();
  w.navigate('https://example.com/export', 'POST');
  w.download('https://example.com/export', 'https://elsewhere.example/blob');
  await settle();
  assert.deepEqual(w.calls.cancelled, []);
});

test('a later GET of the same URL is captured again', async () => {
  const w = boot();
  w.navigate('https://example.com/report', 'POST');
  w.navigate('https://example.com/report', 'GET');
  const id = w.download('https://example.com/report');
  await settle();
  assert.deepEqual(w.calls.cancelled, [id]);
});

test('the POST is still remembered after the worker is killed and woken', async () => {
  const session = {};
  const before = boot({ session });
  before.navigate('https://bank.example/statements/export', 'POST');
  await settle();

  const after = boot({ session });
  after.download('https://bank.example/statements/export');
  await settle();
  assert.deepEqual(after.calls.cancelled, []);
});

/* ------------------------------------------------------------------ */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log('ok   ' + name);
  } catch (err) {
    failed++;
    console.error('FAIL ' + name + '\n     ' + (err && err.message));
  }
}
if (failed) {
  console.error('\n' + failed + ' of ' + tests.length + ' failed');
  process.exit(1);
}
console.log('\nall ' + tests.length + ' passed');
