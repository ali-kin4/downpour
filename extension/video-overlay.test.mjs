/**
 * Downpour — tests for the video overlay's "should the pill be here at all?"
 * decisions.
 *
 * WHY A DOM STUB AND NOT A UNIT TEST ON THE PREDICATES. The three bugs these
 * cover were all caller bugs, not predicate bugs: the pill appeared because
 * `show()` was reached, or stayed up because nothing retracted it. A test that
 * called `isLinkedPreview()` directly would pass whether or not `eligible()`
 * consulted it. So the real content script is evaluated here, in a DOM small
 * enough to hand-write, and driven with the same events a browser sends —
 * `loadedmetadata`, `pointerenter`, `encrypted`, a click on the × — with the
 * assertion being the one thing the user sees: is the overlay host displayed.
 *
 * Run: node extension/video-overlay.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, 'video-overlay.js'), 'utf8');

/* ------------------------------------------------------------------ *
 * A DOM, in as few lines as will run the script
 * ------------------------------------------------------------------ */

function makeStyle() {
  const props = new Map();
  return {
    setProperty(name, value) {
      props.set(name, value);
    },
    getPropertyValue(name) {
      return props.get(name) || '';
    },
    set cssText(_v) {
      /* the host's inline block; nothing reads it back */
    },
    get cssText() {
      return '';
    }
  };
}

function makeClassList(el) {
  return {
    add(...names) {
      for (const n of names) el.__classes.add(n);
    },
    remove(...names) {
      for (const n of names) el.__classes.delete(n);
    },
    contains(n) {
      return el.__classes.has(n);
    },
    toggle(n, on) {
      if (on) el.__classes.add(n);
      else el.__classes.delete(n);
    }
  };
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.style = makeStyle();
    this.__classes = new Set();
    this.classList = makeClassList(this);
    this.__listeners = new Map(); // type -> [{ fn, capture }]
    this.__rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    this.__shadow = null;
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.isConnected = false;
  }

  get className() {
    return this.attributes.get('class') || '';
  }
  set className(v) {
    this.attributes.set('class', v);
    this.__classes = new Set(String(v).split(/\s+/).filter(Boolean));
    this.classList = makeClassList(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    // A shadow root is an El too, so a node inside one has the root as its
    // parent and the root has none — which is exactly the boundary `closest`
    // must not cross.
    child.parentElement = this;
    this.children.push(child);
    child.__markConnected(this.isConnected);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i !== -1) this.children.splice(i, 1);
    child.parentElement = null;
    child.__markConnected(false);
    return child;
  }
  get parentNode() {
    return this.parentElement;
  }

  __markConnected(on) {
    this.isConnected = Boolean(on);
    for (const c of this.children) c.__markConnected(on);
    if (this.__shadow) for (const c of this.__shadow.children) c.__markConnected(on);
  }

  attachShadow() {
    const root = new El('#shadow');
    this.__shadow = root;
    return root;
  }

  getBoundingClientRect() {
    return this.__rect;
  }

  /** Only the selectors this script actually uses. */
  closest(selector) {
    let node = this;
    while (node) {
      if (selector === 'a' && node.tagName === 'A') return node;
      if (selector === 'a[href]' && node.tagName === 'A' && node.attributes.has('href')) return node;
      node = node.parentElement;
    }
    return null;
  }
  querySelector() {
    return null;
  }
  querySelectorAll(selector) {
    const want = selector.toUpperCase();
    const out = [];
    const walk = (node) => {
      for (const c of node.children) {
        if (c.tagName === want) out.push(c);
        walk(c);
      }
      if (node.__shadow) walk(node.__shadow);
    };
    walk(this);
    return out;
  }

  addEventListener(type, fn, opts) {
    const capture = opts === true || (opts && opts.capture === true);
    if (!this.__listeners.has(type)) this.__listeners.set(type, []);
    this.__listeners.get(type).push({ fn, capture });
  }
  removeEventListener(type, fn, opts) {
    const capture = opts === true || (opts && opts.capture === true);
    const list = this.__listeners.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i !== -1) list.splice(i, 1);
  }

  focus() {}
}

/** Fire `type` at `target`, running document's capture listeners on the way. */
function dispatch(doc, target, type, extra) {
  const path = [];
  for (let n = target; n; n = n.parentElement) path.push(n);
  path.push(doc);

  const event = Object.assign({ type, target, timeStamp: Date.now(), preventDefault() {}, stopPropagation() {} }, extra || {});
  event.composedPath = () => path.slice();

  // Capture: document first, down to the target.
  for (let i = path.length - 1; i >= 1; i--) {
    for (const l of (path[i].__listeners.get(type) || []).slice()) {
      if (l.capture) l.fn(event);
    }
  }
  // At the target both phases fire.
  for (const l of (target.__listeners.get(type) || []).slice()) l.fn(event);
  return event;
}

function rect(x, y, w, h) {
  return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
}

/* ------------------------------------------------------------------ *
 * A page
 * ------------------------------------------------------------------ */

function makePage({ href, config }) {
  const doc = new El('#document');
  doc.isConnected = true;
  const body = new El('body');
  body.isConnected = true;
  doc.appendChild(body);
  doc.body = body;
  doc.documentElement = body;
  doc.readyState = 'complete';
  doc.fullscreenElement = null;
  doc.createElement = (tag) => new El(tag);

  const url = new URL(href);
  const timers = [];
  const frames = [];

  const win = {
    innerWidth: 1440,
    innerHeight: 800,
    __listeners: new Map(),
    addEventListener: El.prototype.addEventListener,
    removeEventListener: El.prototype.removeEventListener
  };

  const sandbox = {
    window: win,
    document: doc,
    location: {
      href,
      hostname: url.hostname,
      origin: url.origin,
      pathname: url.pathname,
      search: url.search
    },
    __goto(next) {
      const u = new URL(next);
      Object.assign(sandbox.location, {
        href: next,
        hostname: u.hostname,
        origin: u.origin,
        pathname: u.pathname,
        search: u.search
      });
    },
    URL,
    Set,
    Map,
    WeakMap,
    WeakSet,
    Math,
    Date,
    Number,
    Boolean,
    String,
    Array,
    Object,
    JSON,
    Promise,
    isFinite,
    console,
    setTimeout: (fn, ms) => {
      timers.push({ fn, at: ms || 0 });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1].fn = null;
    },
    requestAnimationFrame: (fn) => {
      frames.push(fn);
      return frames.length;
    },
    cancelAnimationFrame: (id) => {
      if (frames[id - 1]) frames[id - 1] = null;
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    chrome: {
      runtime: {
        id: 'test',
        lastError: null,
        sendMessage(message, cb) {
          if (message.type === 'videoOverlayConfig') cb({ ok: true, data: config });
          else cb({ ok: true, data: {} });
        }
      },
      storage: { onChanged: { addListener() {} } }
    }
  };
  sandbox.window.document = doc;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);

  const flushFrames = () => {
    while (frames.length) {
      const fn = frames.shift();
      if (fn) fn();
    }
  };

  return {
    doc,
    body,
    win,
    flushFrames,
    /** Let the config promise settle, then run any deferred layout reads. */
    async settle() {
      for (let i = 0; i < 6; i++) await Promise.resolve();
      flushFrames();
      for (let i = 0; i < 6; i++) await Promise.resolve();
      flushFrames();
    },
    /** A soft navigation: the address changes, the document does not. */
    goto(next) {
      sandbox.__goto(next);
    },
    host() {
      return body.children.find((c) => c.tagName === 'DOWNPOUR-VIDEO-OVERLAY') || null;
    },
    visible() {
      const h = this.host();
      if (!h) return false;
      return h.style.getPropertyValue('display') === 'block';
    },
    /** Find a button by class inside the (closed) shadow root. */
    shadowButton(className) {
      const h = this.host();
      if (!h || !h.__shadow) return null;
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (c.__classes.has(className)) out.push(c);
          walk(c);
        }
      };
      walk(h.__shadow);
      return out[0] || null;
    }
  };
}

/** A <video> with media behind it, inside `parent`, at a downloadable size. */
function addVideo(page, parent) {
  const video = new El('video');
  video.__rect = rect(100, 100, 640, 360);
  video.readyState = 2;
  video.duration = 300;
  video.currentSrc = 'blob:https://example.test/abc';
  video.paused = false;
  video.loop = false;
  video.muted = false;
  video.controls = true;
  video.mediaKeys = null;
  parent.appendChild(video);
  return video;
}

async function wake(page, video) {
  dispatch(page.doc, video, 'loadedmetadata');
  await page.settle();
}

function hover(page, video) {
  // pointerenter is attached to the resolved container, which for these
  // fixtures is the video itself or its same-sized wrapper.
  dispatch(page.doc, video, 'pointerenter');
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const ON = { enabled: true, siteBlocked: false, drmSite: false };

test('a plain video on the page gets the pill', async () => {
  const page = makePage({ href: 'https://example.test/watch', config: ON });
  const video = addVideo(page, page.body);
  await wake(page, video);
  hover(page, video);
  assert.equal(page.visible(), true, 'the pill should appear over an ordinary video');
});

test('a video that is a link to another page gets no pill', async () => {
  // The YouTube feed card: the hover preview lives inside the anchor that
  // opens the watch page. Probing would run yt-dlp against the feed.
  const page = makePage({ href: 'https://www.youtube.com/', config: ON });
  const anchor = new El('a');
  anchor.setAttribute('href', '/watch?v=aqz-KE-bpKQ');
  anchor.__rect = rect(100, 100, 640, 360);
  page.body.appendChild(anchor);
  const video = addVideo(page, anchor);
  await wake(page, video);
  hover(page, video);
  assert.equal(page.visible(), false, 'no pill over a feed card preview');
});

test('a video inside a card link with no href gets no pill', async () => {
  // YouTube's `yt-simple-endpoint`: an <a> with no href at all, navigated by
  // the page's own JavaScript. `closest('a[href]')` walks straight past it,
  // which is how the feed pill survived the first version of this check.
  const page = makePage({ href: 'https://www.youtube.com/', config: ON });
  const anchor = new El('a');
  anchor.className = 'yt-simple-endpoint';
  anchor.__rect = rect(100, 100, 640, 360);
  page.body.appendChild(anchor);
  const video = addVideo(page, anchor);
  await wake(page, video);
  hover(page, video);
  assert.equal(page.visible(), false, 'an anchor with no address is still a card wrapper');
});

test('a video linking to the page it is already on still gets the pill', async () => {
  const page = makePage({ href: 'https://example.test/post?id=7', config: ON });
  const anchor = new El('a');
  anchor.setAttribute('href', '/post?id=7');
  anchor.__rect = rect(100, 100, 640, 360);
  page.body.appendChild(anchor);
  const video = addVideo(page, anchor);
  await wake(page, video);
  hover(page, video);
  assert.equal(page.visible(), true, 'a self-link is not a preview of somewhere else');
});

test('an encrypted video gets no pill', async () => {
  const page = makePage({ href: 'https://example.test/watch', config: ON });
  const video = addVideo(page, page.body);
  await wake(page, video);
  dispatch(page.doc, video, 'encrypted');
  hover(page, video);
  assert.equal(page.visible(), false, 'DRM means nothing can download it');
});

test('a pill already on screen is retracted when the video turns out to be encrypted', async () => {
  // The timing hole: a DRM player can paint its first frame before the key
  // session is negotiated, so the pill can be up before `encrypted` arrives.
  const page = makePage({ href: 'https://example.test/watch', config: ON });
  const video = addVideo(page, page.body);
  await wake(page, video);
  hover(page, video);
  assert.equal(page.visible(), true, 'precondition: the pill is up');
  dispatch(page.doc, video, 'encrypted');
  assert.equal(page.visible(), false, 'the pill should retract, not linger');
});

test('a DRM-only site never gets the pill', async () => {
  const page = makePage({
    href: 'https://www.netflix.com/watch/81978231',
    config: { enabled: true, siteBlocked: false, drmSite: true }
  });
  const video = addVideo(page, page.body);
  await wake(page, video);
  hover(page, video);
  assert.equal(page.visible(), false, 'the whole library is protected; never offer');
});

test('the close button hides the pill, and it stays hidden on the next hover', async () => {
  const page = makePage({ href: 'https://example.test/watch', config: ON });
  const video = addVideo(page, page.body);
  await wake(page, video);
  hover(page, video);
  assert.equal(page.visible(), true, 'precondition: the pill is up');

  const close = page.shadowButton('close');
  assert.ok(close, 'there should be a × next to the pill');
  dispatch(page.doc, close, 'click');
  assert.equal(page.visible(), false, 'clicking × hides it');

  hover(page, video);
  assert.equal(page.visible(), false, 'and it does not come straight back');
});

test('a dismissal survives a navigation event that did not change the URL', async () => {
  // YouTube fires `yt-navigate-start`/`-finish` on a watch page without the
  // address changing. Clearing the dismissal on the event rather than on the
  // URL retracted the × within seconds of it being pressed.
  const page = makePage({ href: 'https://example.test/watch', config: ON });
  const video = addVideo(page, page.body);
  await wake(page, video);
  hover(page, video);
  dispatch(page.doc, page.shadowButton('close'), 'click');
  dispatch(page.doc, page.doc, 'yt-navigate-finish');
  hover(page, video);
  assert.equal(page.visible(), false, 'the same page is still the same page');
});

test('a dismissal does not follow the user to the next page', async () => {
  const page = makePage({ href: 'https://example.test/watch', config: ON });
  const video = addVideo(page, page.body);
  await wake(page, video);
  hover(page, video);
  dispatch(page.doc, page.shadowButton('close'), 'click');
  page.goto('https://example.test/watch?v=next');
  dispatch(page.doc, page.doc, 'yt-navigate-finish');
  hover(page, video);
  assert.equal(page.visible(), true, 'a new page is a new decision');
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log('  ok  ' + t.name);
  } catch (err) {
    failed++;
    console.log('FAIL  ' + t.name);
    console.log('      ' + (err && err.message));
  }
}

if (failed) {
  console.log('\n' + failed + ' of ' + tests.length + ' failed');
  process.exit(1);
}
console.log('\n' + tests.length + ' passed');
