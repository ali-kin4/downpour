'use strict';

/**
 * Downpour — the "download this video" overlay.
 *
 * An IDM-style pill that fades in over a video and offers to hand it to the
 * desktop app. This is the single most intrusive thing the extension does on
 * a page it was not asked to touch, so the whole file is written around one
 * rule: BE INVISIBLE UNTIL WANTED, AND CHEAP ALWAYS.
 *
 * WHAT THAT MEANS CONCRETELY
 *
 * 1. NO POLLING, NO WHOLE-DOCUMENT MutationObserver. Videos are discovered
 *    from capture-phase `loadedmetadata` / `play` / `playing` listeners on
 *    `document`. Media events do not bubble, but they DO travel through the
 *    capture phase, so one listener on the document catches every video on
 *    the page — including ones a SPA creates ten minutes from now — for the
 *    price of three listeners and no tree walking.
 *
 * 2. NOTHING IS MEASURED UNTIL SOMETHING COULD BE SHOWN. getBoundingClientRect
 *    is called on hover, on the play timer, and inside a rAF while the pill is
 *    visible. Never on a timer, never while hidden.
 *
 * 2b. THE FIRST <video> IS WHAT WAKES THE SERVICE WORKER, not page load. This
 *    script is declared with `all_frames: true`, so it runs in every banner
 *    iframe on the internet; asking for its configuration on load would mean
 *    thirty worker wake-ups on an ad-heavy page. A frame with no video in it
 *    sends no messages at all, and a subframe too small to hold one does not
 *    even attach listeners.
 *
 * 3. THE PILL NEVER EATS A CLICK MEANT FOR THE PLAYER. The host wrapper is
 *    `pointer-events: none`; only the pill and the open panel take pointer
 *    events, and the pill stops its own click from reaching the page so a
 *    player does not read it as play/pause.
 *
 * 4. ONE HOST PER FRAME, REUSED. The overlay is a single element appended to
 *    <body> and positioned over whichever video is currently relevant. A SPA
 *    re-render therefore cannot multiply it: there is nothing to multiply.
 *
 * 5. SHADOW DOM, CLOSED. The page's CSS cannot reach in and ours cannot leak
 *    out. The host is a custom tag name so even `body > div` selectors miss.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * - It does not show in fullscreen. A fixed-position element in <body> is not
 *   rendered inside the fullscreen element anyway, and re-parenting ourselves
 *   into a player mid-playback is exactly the kind of DOM surgery that breaks
 *   sites. Someone watching fullscreen is watching, not downloading.
 * - It does not appear over decorative background loops, DRM-protected
 *   players, tiny videos, or a poster with no media behind it.
 * - It does not talk to the network. Everything goes through the service
 *   worker, which owns the token and the port.
 *
 * SIZES AND QUALITIES: see the comment above `renderPanel`. Short version —
 * a file the browser can see the address of is measured directly, and for
 * everything else the app's `/api/v1/media/probe` runs yt-dlp and returns the
 * real format list. Progressive formats are listed first and plainly; the
 * rest are behind a disclosure and badged, because Downpour ships no ffmpeg
 * and must never hand someone a video with no sound without saying so.
 */

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  // Declared content scripts run once per frame, but a manual re-injection or
  // a same-document reload should not build a second overlay.
  if (window.__downpourVideoOverlay) return;
  window.__downpourVideoOverlay = true;

  /* ---------------------------------------------------------------- *
   * Tuning
   * ---------------------------------------------------------------- */

  // Below this the pill would be a bigger feature of the frame than the video.
  // 240x135 is a 16:9 thumbnail; anything smaller is an icon, a sprite or an
  // autoplaying decoration.
  const MIN_W = 240;
  const MIN_H = 135;

  // "After the video has been playing ~2 seconds" — long enough that an
  // autoplaying preroll or a hover-preview never triggers it.
  const PLAY_DELAY_MS = 2000;

  // After appearing on its own it dims rather than vanishing: vanishing means
  // the user has to guess where it was, dimming keeps it findable and quiet.
  const DIM_DELAY_MS = 4000;

  // Reserved along the bottom of the video for the player's control strip.
  // The pill lives at the TOP right, so this only matters for the clamp that
  // keeps it out of the strip when a video is partly scrolled off the top.
  const CONTROL_STRIP_PX = 56;

  const INSET_PX = 10;
  const PILL_H = 28;

  const CONFIRM_MS = 2200;

  // Floor on how often the pointer position is compared against video boxes.
  // 200ms is below the threshold at which a hover feels delayed and well above
  // the rate `pointerover` can fire at.
  const HIT_TEST_MS = 200;

  /* ---------------------------------------------------------------- *
   * State
   * ---------------------------------------------------------------- */

  const state = {
    enabled: false, // global switch
    siteBlocked: false, // per-site switch
    configLoaded: false, // have we ever asked the worker?
    configPending: null, // in-flight request, so N videos ask once
    running: false, // listeners attached?
    host: null, // the overlay element
    shadow: null,
    pill: null,
    pillLabel: null,
    panel: null,
    wrap: null,
    active: null, // the <video> the pill currently belongs to
    hovered: null, // the <video> the pointer is over
    shown: false,
    panelOpen: false,
    tracking: false,
    raf: 0,
    dimTimer: 0,
    confirmTimer: 0,
    pillBusy: false, // a send is in flight
    io: null
  };

  /** video -> { container, onEnter, onLeave, playTimer } */
  const records = new WeakMap();
  /** Live set so teardown can reach every registration. Pruned on disconnect. */
  const registered = new Set();
  /** url -> bytes | null. One HEAD per file per page, at most. */
  const sizeCache = new Map();

  /* ---------------------------------------------------------------- *
   * Messaging
   * ---------------------------------------------------------------- */

  function send(message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          if (settled) return;
          settled = true;
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          if (!reply) {
            reject(new Error('No reply from Downpour.'));
            return;
          }
          if (reply.ok) resolve(reply.data);
          else reject(Object.assign(new Error(reply.error), { kind: reply.kind }));
        });
      } catch (e) {
        // The extension was reloaded out from under this page.
        reject(e);
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * Eligibility — "is there a real video here?"
   * ---------------------------------------------------------------- */

  /** Has media behind it, not just a poster frame waiting for a click. */
  function hasMedia(video) {
    if (video.readyState >= 1) return true;
    if (video.duration > 0) return true;
    if (video.currentSrc || video.getAttribute('src')) return true;
    return Boolean(video.querySelector('source[src]'));
  }

  /**
   * Muted + looping + no controls is the signature of a background hero loop
   * or a GIF replacement. Nobody wants to download those, and offering to is
   * how a download manager starts feeling like adware.
   */
  function isDecorative(video) {
    if (video.controls) return false;
    if (!video.loop || !video.muted) return false;
    const d = Number(video.duration);
    return !isFinite(d) || d < 31;
  }

  /**
   * Encrypted Media Extensions. A DRM stream cannot be downloaded by anything,
   * so a pill over one can only ever disappoint. `mediaKeys` is set by the
   * page on the same DOM node we can see, so this reads correctly from the
   * isolated world; it is wrapped anyway because a throwing getter here would
   * take the whole overlay down.
   */
  function isProtected(video) {
    try {
      return Boolean(video.mediaKeys);
    } catch (_) {
      return false;
    }
  }

  function eligible(video) {
    if (!video || !video.isConnected) return false;
    if (isDecorative(video)) return false;
    if (isProtected(video)) return false;
    return hasMedia(video);
  }

  function bigEnough(rect) {
    return rect.width >= MIN_W && rect.height >= MIN_H;
  }

  /* ---------------------------------------------------------------- *
   * Registration
   * ---------------------------------------------------------------- */

  /**
   * The element the user perceives as "the video".
   *
   * Every real player stacks its controls in a sibling layer ABOVE the
   * <video>, so the video element itself never receives a pointer event. The
   * hover target has to be the wrapper whose box matches the video's — walk up
   * a few levels and take the outermost ancestor that is still the same size.
   *
   * Bounded to six levels so a page of nested full-width sections cannot walk
   * us up to <body> and make the whole page a hover target.
   */
  function resolveContainer(video) {
    let best = video;
    let node = video.parentElement;
    let rect;
    try {
      rect = video.getBoundingClientRect();
    } catch (_) {
      return video;
    }
    if (rect.width < 1 || rect.height < 1) return video;
    for (let i = 0; i < 6 && node && node !== document.body; i++) {
      const r = node.getBoundingClientRect();
      if (Math.abs(r.width - rect.width) <= 8 && Math.abs(r.height - rect.height) <= 8) {
        best = node;
      }
      node = node.parentElement;
    }
    return best;
  }

  function register(video) {
    if (records.has(video)) return records.get(video);
    if (!video || video.tagName !== 'VIDEO') return null;

    // THE FIRST VIDEO IS WHAT WAKES THE SERVICE WORKER, not page load. With
    // `all_frames: true` this script runs in every advertising iframe on the
    // internet, and a config request per frame per page load would be a
    // constant drip of worker wake-ups for nothing. A frame with no <video> in
    // it never sends a single message.
    ensureConfig();

    const rec = { container: video, onEnter: null, onLeave: null, playTimer: 0, resolved: false };
    records.set(video, rec);
    registered.add(video);

    // Container resolution reads layout, so defer it one frame: at
    // `loadedmetadata` a player is frequently still sizing itself, and a rect
    // read there is both wrong and a forced reflow.
    requestAnimationFrame(() => {
      if (!video.isConnected || !records.has(video)) return;
      rec.container = resolveContainer(video);
      rec.resolved = true;

      rec.onEnter = () => onHover(video);
      rec.onLeave = (e) => onUnhover(video, e);
      // pointerenter/leave fire for descendants too, so the controls layer is
      // covered. Passive: we never preventDefault here.
      rec.container.addEventListener('pointerenter', rec.onEnter, { passive: true });
      rec.container.addEventListener('pointerleave', rec.onLeave, { passive: true });
      if (rec.container !== video) {
        video.addEventListener('pointerenter', rec.onEnter, { passive: true });
      }

      observer().observe(video);
    });

    return rec;
  }

  function unregister(video) {
    const rec = records.get(video);
    if (rec) {
      if (rec.playTimer) clearTimeout(rec.playTimer);
      if (rec.onEnter && rec.container) rec.container.removeEventListener('pointerenter', rec.onEnter);
      if (rec.onLeave && rec.container) rec.container.removeEventListener('pointerleave', rec.onLeave);
      if (rec.onEnter) video.removeEventListener('pointerenter', rec.onEnter);
      records.delete(video);
    }
    registered.delete(video);
    if (state.io) {
      try {
        state.io.unobserve(video);
      } catch (_) {
        /* already gone */
      }
    }
    if (state.active === video) hide();
    if (state.hovered === video) state.hovered = null;
  }

  /**
   * One shared IntersectionObserver for every video in the frame. It is the
   * teardown trigger as well as the visibility one: an entry for a node that
   * is no longer connected means the SPA replaced the player, and the
   * registration goes with it.
   */
  function observer() {
    if (state.io) return state.io;
    state.io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const video = entry.target;
          if (!video.isConnected) {
            unregister(video);
            continue;
          }
          if (!entry.isIntersecting && state.active === video) hideUnlessPinned();
        }
      },
      { threshold: 0.15 }
    );
    return state.io;
  }

  /* ---------------------------------------------------------------- *
   * Show / hide
   * ---------------------------------------------------------------- */

  function onHover(video) {
    state.hovered = video;
    if (!state.running) return;
    if (!eligible(video)) return;
    show(video, 'hover');
  }

  /**
   * THE HOVER FALLBACK, and why it is a hit test rather than more listeners.
   *
   * `pointerenter` on the resolved container is the cheap path and it covers
   * most players. It cannot cover all of them: plenty stack their controls,
   * gradients and end-screens in layers that are SIBLINGS of the video, so
   * neither the video nor any same-sized wrapper ever receives a pointer
   * event, and walking the ancestor chain to find "the player" is a guess
   * that is wrong differently on every site.
   *
   * "Is the pointer inside the video's box" is the question actually being
   * asked, so ask it directly. `pointerover` only fires when the pointer
   * crosses into a different element, and this is throttled on top of that,
   * so the cost ceiling is a handful of rect reads per second while the mouse
   * is moving over a page that has a video on it — and nothing at all
   * otherwise. No style is written in between, so no thrash.
   */
  let lastHitTest = -1e9;

  function onPointerOver(e) {
    if (registered.size === 0) return;
    if (!allowed()) return;
    const now = e.timeStamp || Date.now();
    if (now - lastHitTest < HIT_TEST_MS) return;
    lastHitTest = now;
    hitTest(e.clientX, e.clientY);
  }

  function hitTest(x, y) {
    for (const video of registered) {
      if (!video.isConnected) continue;
      const r = video.getBoundingClientRect();
      if (!bigEnough(r)) continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        onHover(video);
        return;
      }
    }
    // The pill sits INSIDE the video's box, so hovering it still counts as
    // hovering the video and this branch is not reached while reaching for it.
    if (!state.hovered) return;
    state.hovered = null;
    if (state.panelOpen || !state.active) return;
    if (state.active.paused) hideUnlessPinned();
    else dimSoon(0);
  }

  function onUnhover(video, event) {
    // Moving the pointer onto our own pill leaves the container (the pill is
    // not a descendant of it), which would hide the thing being reached for.
    if (event && event.relatedTarget === state.host) return;
    if (state.hovered === video) state.hovered = null;
    if (state.panelOpen) return; // an open menu is an explicit intent; keep it
    if (state.active === video) {
      if (video.paused) hideUnlessPinned();
      else dimSoon(0);
    }
  }

  /** Both switches must say yes, and the answer must have actually arrived. */
  function allowed() {
    return state.running && state.configLoaded && state.enabled && !state.siteBlocked;
  }

  function show(video, reason) {
    if (!allowed()) return;
    if (document.fullscreenElement) return;
    if (!eligible(video)) return;

    let rect;
    try {
      rect = video.getBoundingClientRect();
    } catch (_) {
      return;
    }
    if (!bigEnough(rect)) return;

    if (state.active !== video) {
      if (state.panelOpen) closePanel();
      state.active = video;
      resetPill();
    }

    ensureHost();
    place(rect);

    state.shown = true;
    state.host.style.setProperty('display', 'block', 'important');
    state.wrap.classList.add('visible');
    state.wrap.classList.remove('dim');
    startTracking();

    if (reason === 'hover') {
      clearTimeout(state.dimTimer);
      state.dimTimer = 0;
    } else {
      dimSoon(DIM_DELAY_MS);
    }
  }

  /** Fade to a low opacity instead of disappearing. Full opacity on hover. */
  function dimSoon(delay) {
    if (pinned()) return;
    clearTimeout(state.dimTimer);
    state.dimTimer = setTimeout(() => {
      state.dimTimer = 0;
      if (!state.shown || state.panelOpen) return;
      if (state.hovered === state.active) return;
      state.wrap.classList.add('dim');
    }, delay);
  }

  function hide() {
    clearTimeout(state.dimTimer);
    state.dimTimer = 0;
    state.shown = false;
    state.active = null;
    stopTracking();
    if (state.panelOpen) closePanel();
    if (state.host) {
      state.wrap.classList.remove('visible', 'dim');
      state.host.style.setProperty('display', 'none', 'important');
    }
  }

  /**
   * Position the pill at the top-right INSIDE the video box.
   *
   * Top-right is chosen because every player on earth puts its controls along
   * the bottom edge and its own overflow menu is either bottom-right or hidden
   * until hover. The clamp below is what keeps the promise even when the video
   * is half scrolled off the top of the viewport: the pill slides down with
   * the visible part of the video but is never allowed into the bottom strip.
   */
  function place(known) {
    const video = state.active;
    if (!video) return;
    if (!video.isConnected) {
      unregister(video);
      return;
    }
    if (document.fullscreenElement) {
      hide();
      return;
    }

    const rect = known || video.getBoundingClientRect();
    if (!bigEnough(rect)) {
      hide();
      return;
    }

    let x = rect.right - INSET_PX;
    let y = Math.max(rect.top + INSET_PX, INSET_PX);

    const floor = rect.bottom - CONTROL_STRIP_PX - PILL_H;
    if (y > floor) y = Math.max(rect.top + INSET_PX, floor);

    x = Math.min(x, window.innerWidth - 6);
    y = Math.min(y, window.innerHeight - PILL_H - 6);

    state.host.style.setProperty('transform', 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)', 'important');

    // Open the menu upwards when there is no room beneath the pill.
    const below = window.innerHeight - y;
    state.wrap.classList.toggle('up', below < 260);
  }

  function startTracking() {
    if (state.tracking) return;
    state.tracking = true;
    // Capture so that scrolling an inner container (a feed, a modal) moves the
    // pill too. Passive so scrolling is never delayed by us.
    window.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', onViewportChange, { passive: true });
  }

  function stopTracking() {
    if (!state.tracking) return;
    state.tracking = false;
    window.removeEventListener('scroll', onViewportChange, { capture: true });
    window.removeEventListener('resize', onViewportChange);
    if (state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
  }

  /** Coalesce every scroll/resize burst into one rect read per frame. */
  function onViewportChange() {
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      if (state.shown) place(null);
    });
  }

  /* ---------------------------------------------------------------- *
   * The overlay itself
   * ---------------------------------------------------------------- */

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  position: relative;
  pointer-events: none;
  opacity: 0;
  transition: opacity 160ms ease;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text);
  --dp-gradient: linear-gradient(120deg, #6366f1 0%, #22d3ee 100%);
  --surface: #ffffff;
  --surface-2: #f1f3f9;
  --border: #e2e5ef;
  --text: #16181f;
  --text-dim: #5c6274;
  --shadow: 0 1px 2px rgba(16,18,31,.10), 0 10px 30px rgba(16,18,31,.18);
}
@media (prefers-color-scheme: dark) {
  .wrap {
    --surface: #171a22;
    --surface-2: #1e222c;
    --border: #2a2f3d;
    --text: #e8eaf2;
    --text-dim: #9aa1b5;
    --shadow: 0 1px 2px rgba(0,0,0,.5), 0 10px 30px rgba(0,0,0,.45);
  }
}
.wrap.visible { opacity: 1; }
.wrap.dim { opacity: .28; }
.wrap.dim:hover { opacity: 1; }

.pill {
  pointer-events: auto;
  position: absolute;
  top: 0; right: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px 0 8px;
  margin: 0;
  border: 0;
  border-radius: 999px;
  background: var(--dp-gradient);
  color: #fff;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: var(--shadow);
  transition: transform 120ms ease, filter 120ms ease;
}
.pill:hover { filter: brightness(1.08); }
.pill:active { transform: scale(.97); }
.pill:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.pill svg { width: 14px; height: 14px; flex: none; display: block; }
.pill.busy { filter: saturate(.5); cursor: progress; }
.pill.done { background: #10b981; }
.pill.failed { background: #dc2626; }

.panel {
  pointer-events: auto;
  position: absolute;
  top: 34px; right: 0;
  width: 268px;
  max-height: 320px;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow);
  padding: 6px;
  text-align: left;
}
.wrap.up .panel { top: auto; bottom: 34px; }
.panel[hidden] { display: none; }

.group {
  padding: 6px 8px 2px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: .6px;
  text-transform: uppercase;
  color: var(--text-dim);
}
.note { padding: 2px 8px 8px; color: var(--text-dim); font-size: 11px; }

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.row:hover { background: var(--surface-2); }
.row:focus-visible { outline: 2px solid #6366f1; outline-offset: -2px; }
.row.disabled { cursor: default; opacity: .5; }
.row.disabled:hover { background: transparent; }
.row .main { flex: 1 1 auto; min-width: 0; }
.row .title,
.row .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .title { font-weight: 600; font-size: 12px; }
.row .sub { color: var(--text-dim); font-size: 11px; }
.row .size { flex: none; color: var(--text-dim); font-size: 11px; font-variant-numeric: tabular-nums; }
.row .badge {
  flex: none;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .4px;
  text-transform: uppercase;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 1px 4px;
}

hr { border: 0; border-top: 1px solid var(--border); margin: 6px 4px; }

.foot { display: flex; flex-direction: column; gap: 2px; }
.link {
  display: block;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}
.link:hover { background: var(--surface-2); color: var(--text); }
.msg { padding: 6px 8px; font-size: 11px; color: #dc2626; }
.detail {
  padding: 6px 8px;
  margin: 0 0 2px;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 11px;
  /* yt-dlp's message, verbatim: it can be long and it can contain a path. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.working { display: flex; align-items: center; gap: 7px; padding: 8px; color: var(--text-dim); font-size: 11px; }
.spinner {
  flex: none;
  width: 12px; height: 12px;
  border: 2px solid var(--border);
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: dp-spin .7s linear infinite;
}
@keyframes dp-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .spinner { animation-duration: 2.4s; }
  .wrap { transition: none; }
}
`;

  const ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3v11"/><path d="m7 10 5 5 5-5"/><path d="M4 20h16"/></svg>';

  function ensureHost() {
    if (state.host) return;

    // An unknown element name means no page stylesheet can select it by tag,
    // and `all: initial` inside the shadow root blocks inheritance.
    const host = document.createElement('downpour-video-overlay');
    host.style.cssText =
      'all:initial;position:fixed!important;left:0!important;top:0!important;' +
      'width:0!important;height:0!important;margin:0!important;padding:0!important;' +
      'border:0!important;z-index:2147483647!important;pointer-events:none!important;' +
      'contain:layout style!important;display:none!important;';
    host.setAttribute('aria-hidden', 'false');

    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pill';
    pill.setAttribute('aria-haspopup', 'menu');
    pill.setAttribute('aria-expanded', 'false');
    pill.innerHTML = ICON;
    const label = document.createElement('span');
    label.textContent = 'Download';
    pill.appendChild(label);

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'menu');
    panel.hidden = true;

    wrap.appendChild(pill);
    wrap.appendChild(panel);
    shadow.appendChild(wrap);

    // The click must not reach the page: on most players a click anywhere in
    // the video box toggles playback.
    pill.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
    pill.addEventListener('pointerdown', (e) => e.stopPropagation());
    pill.addEventListener('mousedown', (e) => e.stopPropagation());
    wrap.addEventListener('pointerenter', () => {
      clearTimeout(state.dimTimer);
      state.dimTimer = 0;
      wrap.classList.remove('dim');
    });
    wrap.addEventListener('pointerleave', () => {
      if (!state.panelOpen && state.active && !state.active.paused) dimSoon(DIM_DELAY_MS);
    });

    (document.body || document.documentElement).appendChild(host);

    state.host = host;
    state.shadow = shadow;
    state.wrap = wrap;
    state.pill = pill;
    state.pillLabel = label;
    state.panel = panel;
  }

  function resetPill() {
    clearTimeout(state.confirmTimer);
    state.confirmTimer = 0;
    state.pillBusy = false;
    if (!state.pill) return;
    state.pill.classList.remove('busy', 'done', 'failed');
    state.pillLabel.textContent = 'Download';
  }

  /**
   * The "brief confirmation in the pill itself".
   *
   * While one of these is on screen the pill is PINNED: the ordinary reasons
   * to dim or hide it — the pointer left the video, the video paused, it
   * scrolled out of view — are all suspended. Clicking a row necessarily moves
   * the pointer off the row and the menu closes underneath it, so without this
   * the confirmation the user just asked for would fade out or vanish before
   * they saw it.
   */
  function flashPill(text, kind) {
    if (!state.pill) return;
    clearTimeout(state.confirmTimer);
    state.confirmTimer = 0;
    state.pill.classList.remove('busy', 'done', 'failed');
    if (kind) state.pill.classList.add(kind);
    state.pillLabel.textContent = text;

    if (kind === 'busy') {
      state.pillBusy = true;
      return;
    }
    state.pillBusy = false;
    state.confirmTimer = setTimeout(() => {
      state.confirmTimer = 0;
      resetPill();
      // The suspended decision is taken now instead of being lost.
      if (!state.active) return;
      if (state.hovered === state.active) return;
      if (state.active.paused) hide();
      else dimSoon(0);
    }, CONFIRM_MS);
  }

  /** Is a confirmation (or a send) currently owning the pill? */
  function pinned() {
    return state.pillBusy || state.confirmTimer !== 0;
  }

  /** Hide, unless a confirmation is using the pill right now. */
  function hideUnlessPinned() {
    if (pinned()) return;
    hide();
  }

  /* ---------------------------------------------------------------- *
   * Panel
   * ---------------------------------------------------------------- */

  function togglePanel() {
    if (state.panelOpen) closePanel();
    else openPanel();
  }

  function openPanel() {
    if (!state.active) return;
    renderPanel(state.active);
    state.panel.hidden = false;
    state.panelOpen = true;
    state.pill.setAttribute('aria-expanded', 'true');
    state.wrap.classList.remove('dim');
    clearTimeout(state.dimTimer);
    place(null);
    document.addEventListener('pointerdown', onOutsidePointer, true);
    document.addEventListener('keydown', onPanelKey, true);
  }

  function closePanel() {
    if (!state.panel) return;
    state.panel.hidden = true;
    state.panel.textContent = '';
    state.panelOpen = false;
    if (state.pill) state.pill.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    document.removeEventListener('keydown', onPanelKey, true);
    if (state.active && !state.active.paused && state.hovered !== state.active) dimSoon(DIM_DELAY_MS);
  }

  /**
   * Close on a click elsewhere — WITHOUT swallowing that click. The page still
   * gets it; we only notice it went past us.
   */
  function onOutsidePointer(e) {
    if (e.composedPath && e.composedPath().indexOf(state.host) !== -1) return;
    closePanel();
  }

  function onPanelKey(e) {
    if (e.key === 'Escape') {
      closePanel();
      if (state.pill) state.pill.focus();
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function row({ title, sub, size, badge, onClick, disabled }) {
    const button = el('button', 'row' + (disabled ? ' disabled' : ''));
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    const main = el('div', 'main');
    main.appendChild(el('div', 'title', title));
    if (sub) main.appendChild(el('div', 'sub', sub));
    button.appendChild(main);
    if (badge) button.appendChild(el('span', 'badge', badge));
    const sizeEl = el('span', 'size', size || '');
    button.appendChild(sizeEl);
    if (disabled) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    } else {
      button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(sizeEl);
      });
    }
    return { button, sizeEl };
  }

  function working(text) {
    const box = el('div', 'working');
    box.appendChild(el('div', 'spinner'));
    box.appendChild(el('span', null, text));
    return box;
  }

  /**
   * WHERE THE NUMBERS COME FROM.
   *
   * Two independent sources, and the menu keeps them visibly separate because
   * they fail differently.
   *
   * 1. DIRECT FILES — a `<video src>` or `<source src>` pointing at a real
   *    file. The browser can see the address, so no tool is needed: the worker
   *    asks the server for a size (HEAD, then a one-byte ranged GET) and the
   *    resolution comes from `videoWidth`/`videoHeight`. These render
   *    instantly, before anything is asked of the app, and they still work
   *    when Downpour cannot resolve the page at all.
   *
   * 2. THE APP'S PROBE — `POST /api/v1/media/probe` runs yt-dlp and returns
   *    the real format list: resolution, fps, exact or estimated size,
   *    container, and whether each one is progressive and plain HTTP. This is
   *    the only way to get a quality list for a streamed player, and it costs
   *    a process spawn, so it is only run when it can pay for itself — see
   *    `renderPanel`.
   *
   * A `502 media_unavailable` from the probe carries yt-dlp's own message
   * ("Private video", "Unsupported URL", "yt-dlp is not installed at …") and
   * that message is shown verbatim. It is genuinely the most useful sentence
   * available, and "could not list formats" would be strictly worse.
   */
  function renderPanel(video) {
    const panel = state.panel;
    panel.textContent = '';

    const sources = directSources(video);

    if (sources.length) {
      panel.appendChild(el('div', 'group', 'Video file'));
      for (const source of sources) {
        // No badge: these are the plain case — one file, video and audio in
        // it, downloadable with nothing but the browser's own cookies. The
        // badge is reserved for rows that cannot promise that.
        const r = row({
          title: source.title,
          sub: source.sub,
          size: sizeText(sizeCache.get(source.url)),
          badge: null,
          onClick: () => sendFile(source)
        });
        panel.appendChild(r.button);
        fillSize(source.url, r.sizeEl);
      }
      panel.appendChild(document.createElement('hr'));
    }

    // Everything the app has to be asked about lives in here, so it can be
    // re-rendered in place as the answer arrives without rebuilding the menu.
    const area = el('div', 'probe');
    panel.appendChild(area);

    const pageUrl = location.href;
    const remembered = probeCache.get(pageUrl);

    if (remembered) {
      renderProbeResult(area, remembered, pageUrl);
    } else if (sources.length) {
      // WHEN THE PROBE IS *NOT* RUN AUTOMATICALLY. The page already offers a
      // complete file. Probing costs a yt-dlp spawn of a second or more, and
      // on a page that is just a <video> tag it would spend that second to be
      // told "Unsupported URL". So it is offered, not taken.
      const more = row({
        title: 'Look for other qualities',
        sub: 'Asks Downpour to read this page',
        size: '',
        badge: 'Needs app',
        onClick: () => startProbe(area, pageUrl)
      });
      area.appendChild(more.button);
    } else {
      // Nothing downloadable is visible from the browser, so the probe is the
      // only thing that can produce a menu at all. Run it straight away.
      startProbe(area, pageUrl);
    }

    panel.appendChild(document.createElement('hr'));

    const foot = el('div', 'foot');
    const site = el('button', 'link', 'Don’t show this on ' + location.hostname);
    site.type = 'button';
    site.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      blockSite();
    });
    const off = el('button', 'link', 'Turn the video button off everywhere');
    off.type = 'button';
    off.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      disableEverywhere();
    });
    foot.appendChild(site);
    foot.appendChild(off);
    panel.appendChild(foot);
  }

  /* ---------------------------------------------------------------- *
   * The quality list
   * ---------------------------------------------------------------- */

  /** pageUrl -> probe result. Survives closing and reopening the menu. */
  const probeCache = new Map();

  function startProbe(area, pageUrl) {
    area.textContent = '';
    area.appendChild(el('div', 'group', 'Qualities'));
    area.appendChild(working('Asking Downpour…'));

    send({ type: 'videoOverlayProbe', url: pageUrl })
      .then((result) => {
        // ONLY SUCCESSES ARE REMEMBERED. A cached "yt-dlp is not installed"
        // is a trap: the user clicks through to the app, installs it, comes
        // back, reopens the menu — and is told the same thing with no way to
        // retry. Every failure here is one the user might have just fixed.
        if (result && result.ok) probeCache.set(pageUrl, result);
        // The menu may have been closed, or the page navigated, while yt-dlp
        // was running. Rendering into a detached node is harmless but the
        // early return keeps it honest.
        if (!area.isConnected) return;
        renderProbeResult(area, result, pageUrl);
      })
      .catch((err) => {
        if (!area.isConnected) return;
        renderProbeFailure(area, err);
      });
  }

  /**
   * A probe that came back. `ok: false` is an ANSWER, not an error — yt-dlp
   * ran (or could not be run) and said why, and that sentence plus a way
   * forward is what belongs on screen.
   */
  function renderProbeResult(area, result, pageUrl) {
    area.textContent = '';

    if (!result || !result.ok) {
      area.appendChild(el('div', 'group', 'Qualities'));
      area.appendChild(el('div', 'detail', (result && result.detail) || 'Downpour could not read this page.'));

      if (result && result.notInstalled) {
        // The one failure with a thirty-second fix, so it gets a button
        // instead of a paragraph.
        const install = row({
          title: 'Open Downpour to install yt-dlp',
          sub: 'Settings → Video pages',
          size: '',
          badge: null,
          onClick: () => openApp()
        });
        area.appendChild(install.button);
        return;
      }

      area.appendChild(fallbackRow());
      area.appendChild(
        el(
          'div',
          'note',
          'Downpour could not list the qualities from here. Sending the page link adds it to the queue without starting it, so you can try again in the app.'
        )
      );
      return;
    }

    const info = result.info || {};
    const formats = Array.isArray(info.formats) ? info.formats : [];

    if (info.isLive) {
      area.appendChild(el('div', 'group', 'Live stream'));
      area.appendChild(
        el('div', 'note', 'A live stream has no fixed length and no byte range to download. Downpour cannot fetch this one.')
      );
      return;
    }

    if (formats.length === 0) {
      area.appendChild(el('div', 'group', 'Qualities'));
      area.appendChild(el('div', 'note', 'Downpour read the page but found no downloadable formats on it.'));
      area.appendChild(fallbackRow());
      return;
    }

    // PROGRESSIVE FIRST AND PLAINLY. A progressive format has video and audio
    // in one plain HTTP stream: it is the only kind Downpour can deliver as a
    // finished file, because combining separate streams needs ffmpeg, which
    // the app deliberately does not ship. Everything else is listed too — but
    // behind a disclosure and with a badge, because handing someone a 1080p
    // file with no sound is the failure this ordering exists to prevent.
    const progressive = formats.filter((f) => f && f.progressive && f.directHttp);
    const separate = formats.filter((f) => f && !f.progressive && f.directHttp);
    const manifests = formats.filter((f) => f && !f.directHttp);

    byQuality(progressive);
    byQuality(separate);
    byQuality(manifests);

    // "fps where it differs" — a single frame rate across the whole list is
    // noise on every row, so it is only printed when there is a choice in it.
    const showFps = distinctFps(formats) > 1;

    if (progressive.length) {
      area.appendChild(el('div', 'group', 'Video with sound'));
      for (const f of progressive) area.appendChild(formatRow(f, pageUrl, showFps));
    }

    const rest = separate.concat(manifests);
    if (rest.length === 0) return;

    if (progressive.length === 0) {
      // The empty case, handled explicitly: an empty picker with no
      // explanation reads as a broken feature.
      area.appendChild(el('div', 'group', 'Separate streams only'));
      area.appendChild(
        el(
          'div',
          'note',
          'This site offers video and audio as separate streams. Joining them needs ffmpeg, which Downpour does not bundle, so each of these is only half the video.'
        )
      );
      for (const f of rest) area.appendChild(formatRow(f, pageUrl, showFps));
      return;
    }

    const disclosure = el('button', 'link', 'Show ' + rest.length + ' more format' + (rest.length === 1 ? '' : 's') + ' — video or audio only');
    disclosure.type = 'button';
    disclosure.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      disclosure.remove();
      area.appendChild(el('div', 'group', 'One stream at a time'));
      area.appendChild(
        el('div', 'note', 'These carry either video or audio, not both. Downpour cannot join them — that needs ffmpeg, which it does not bundle.')
      );
      for (const f of rest) area.appendChild(formatRow(f, pageUrl, showFps));
      place(null);
    });
    area.appendChild(disclosure);
  }

  /** Offline, unauthorised, or anything that is not a "yt-dlp said no". */
  function renderProbeFailure(area, err) {
    area.textContent = '';
    area.appendChild(el('div', 'group', 'Qualities'));
    area.appendChild(el('div', 'detail', (err && err.message) || 'Could not reach Downpour.'));
    // No fallback row here on purpose: if the app is unreachable or the token
    // is wrong, sending it a page link would fail in exactly the same way.
  }

  /** Tallest first; within a height, the bigger file is the better one. */
  function byQuality(list) {
    list.sort((a, b) => {
      const h = (Number(b.height) || 0) - (Number(a.height) || 0);
      if (h !== 0) return h;
      return (Number(b.filesize) || 0) - (Number(a.filesize) || 0);
    });
  }

  function distinctFps(formats) {
    const seen = new Set();
    for (const f of formats) {
      const v = Math.round(Number(f && f.fps));
      if (v > 0) seen.add(v);
    }
    return seen.size;
  }

  function hasStream(codec) {
    return Boolean(codec) && String(codec).toLowerCase() !== 'none';
  }

  /**
   * One format. The app has already computed a display `label`, so that is
   * preferred over anything reconstructed here — it is the same string the
   * app's own dialog shows, and two different names for one format across two
   * windows is a support question waiting to happen.
   */
  function formatRow(f, pageUrl, showFps) {
    const video = hasStream(f.vcodec);
    const audio = hasStream(f.acodec);
    const playable = Boolean(f.directHttp);

    const title =
      (f.label && String(f.label)) ||
      (Number(f.height) > 0 ? f.height + 'p' : null) ||
      (f.resolution && String(f.resolution)) ||
      String(f.formatId || 'Format');

    const bits = [];
    if (f.ext) bits.push(String(f.ext));
    if (showFps && Number(f.fps) > 0) bits.push(Math.round(Number(f.fps)) + 'fps');
    if (!playable) bits.push(String(f.protocol || 'playlist') + ' — not a file');
    else if (video && audio) bits.push('video + audio');
    else if (video) bits.push('video only — no sound');
    else if (audio) bits.push('audio only');
    if (f.note) bits.push(String(f.note));

    let badge = null;
    if (!playable) badge = 'Unsupported';
    else if (video && !audio) badge = 'No sound';
    else if (audio && !video) badge = 'Audio only';

    let size = sizeText(f.filesize);
    // "about" rather than a precise number that is not one.
    if (size && f.filesizeIsEstimate) size = '~' + size;

    return row({
      title,
      sub: bits.join(' · '),
      size,
      badge,
      disabled: !playable,
      onClick: () => chooseFormat(pageUrl, f)
    }).button;
  }

  /** The page-link hand-over, used only when the probe could not answer. */
  function fallbackRow() {
    return row({
      title: 'Send the page link anyway',
      sub: 'Added to Downpour without starting',
      size: '',
      badge: null,
      onClick: () => sendPage()
    }).button;
  }

  /* ---------------------------------------------------------------- *
   * Direct sources — the files that need no yt-dlp at all
   * ---------------------------------------------------------------- */

  function isDirect(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  function extOf(url, type) {
    if (type) {
      const m = /^video\/([a-z0-9.-]+)/i.exec(type);
      if (m) return m[1].toLowerCase().replace('x-matroska', 'mkv').replace('quicktime', 'mov');
    }
    try {
      const path = new URL(url, location.href).pathname;
      const m = /\.([a-z0-9]{2,5})$/i.exec(path);
      if (m) return m[1].toLowerCase();
    } catch (_) {
      /* fall through */
    }
    return '';
  }

  function fileNameOf(url) {
    try {
      const path = new URL(url, location.href).pathname;
      const base = decodeURIComponent(path.split('/').pop() || '');
      return base && /\.[a-z0-9]{2,5}$/i.test(base) ? base : '';
    } catch (_) {
      return '';
    }
  }

  /**
   * A plain file, not a manifest. `blob:`/`mediasource` current sources are
   * MSE — there is no URL a downloader could fetch — and .m3u8/.mpd are
   * playlists a byte-range engine cannot use, so both are excluded here and
   * handled by the page route instead.
   */
  function directSources(video) {
    const urls = [];
    const push = (raw, type) => {
      if (!isDirect(raw)) return;
      if (/\.(m3u8|mpd)(\?|#|$)/i.test(raw)) return;
      if (urls.some((u) => u.url === raw)) return;
      urls.push({ url: raw, type: type || '' });
    };

    const absolute = (raw) => {
      if (!raw) return '';
      try {
        return new URL(raw, location.href).href;
      } catch (_) {
        return '';
      }
    };

    push(video.currentSrc, '');
    push(absolute(video.getAttribute('src')), '');
    for (const s of video.querySelectorAll('source')) {
      push(absolute(s.getAttribute('src')), s.getAttribute('type') || '');
    }

    const height = video.videoHeight;
    return urls.map((entry) => {
      const ext = extOf(entry.url, entry.type);
      // The resolution is only known for the source actually decoding.
      const isCurrent = entry.url === video.currentSrc;
      const title = isCurrent && height ? height + 'p' : 'Video file';
      const bits = [];
      if (ext) bits.push(ext);
      if (isCurrent && video.videoWidth && height) bits.push(video.videoWidth + '×' + height);
      bits.push('video + audio');
      return {
        url: entry.url,
        ext,
        title,
        sub: bits.join(' · '),
        filename: fileNameOf(entry.url)
      };
    });
  }

  function sizeText(bytes) {
    if (!(Number(bytes) > 0)) return '';
    const n = Number(bytes);
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
  }

  /** Ask the worker for a size; a failure just leaves the cell blank. */
  function fillSize(url, cell) {
    if (sizeCache.has(url)) {
      cell.textContent = sizeText(sizeCache.get(url));
      return;
    }
    send({ type: 'videoOverlaySize', url, pageUrl: location.href })
      .then((data) => {
        const bytes = data && Number(data.bytes) > 0 ? Number(data.bytes) : null;
        sizeCache.set(url, bytes);
        if (cell.isConnected) cell.textContent = sizeText(bytes);
      })
      .catch(() => {
        sizeCache.set(url, null);
      });
  }

  /* ---------------------------------------------------------------- *
   * Sending
   * ---------------------------------------------------------------- */

  function sendFile(source) {
    closePanel();
    flashPill('Sending…', 'busy');
    send({
      type: 'videoOverlaySend',
      mode: 'file',
      url: source.url,
      // location.href is read HERE, at send time, not when the video was
      // registered. A SPA can have navigated five times since then and the
      // only moment the URL has to be right is this one.
      pageUrl: location.href,
      pageTitle: document.title,
      filename: source.filename,
      sizeHint: Number(sizeCache.get(source.url)) || 0
    })
      .then(() => flashPill('Sent to Downpour', 'done'))
      .catch((err) => flashPill(shortError(err), 'failed'));
  }

  /**
   * A chosen format from the probe.
   *
   * The worker re-runs yt-dlp to resolve it, which is deliberate rather than
   * wasteful: the direct URLs are signed and expire within minutes, so one
   * captured while the user was still reading the menu is frequently dead.
   * That is why the pill sits on "Resolving…" instead of "Sent" straight away
   * — the wait is a real one, and the confirmation is pinned so it cannot be
   * dimmed or hidden out from under whoever is waiting for it.
   */
  function chooseFormat(pageUrl, format) {
    closePanel();
    flashPill('Resolving…', 'busy');
    send({
      type: 'videoOverlayResolve',
      url: pageUrl,
      formatId: format.formatId,
      pageTitle: document.title
    })
      .then(() => flashPill('Sent to Downpour', 'done'))
      .catch((err) => flashPill(shortError(err), 'failed'));
  }

  /** The fallback: hand over the page link for the app to deal with. */
  function sendPage() {
    closePanel();
    flashPill('Sending…', 'busy');
    send({
      type: 'videoOverlaySend',
      mode: 'page',
      url: location.href,
      pageTitle: document.title
    })
      .then(() => flashPill('Added in Downpour', 'done'))
      .catch((err) => flashPill(shortError(err), 'failed'));
  }

  /** Raise the app window — the answer to "yt-dlp is not installed". */
  function openApp() {
    closePanel();
    flashPill('Opening…', 'busy');
    send({ type: 'openApp' })
      .then(() => flashPill('Opened Downpour', 'done'))
      .catch((err) => flashPill(shortError(err), 'failed'));
  }

  function shortError(err) {
    if (err && err.kind === 'offline') return 'Downpour not running';
    if (err && err.kind === 'unauthorized') return 'Not paired';
    // A resolve can fail with yt-dlp's own words (the link died, the video
    // went private between probing and choosing). The pill is far too small
    // for them, so it says something true and short; the detail is already in
    // the extension's error state, which the popup shows.
    return 'Failed';
  }

  /* ---------------------------------------------------------------- *
   * Off switches
   * ---------------------------------------------------------------- */

  function blockSite() {
    closePanel();
    // Optimistic: the button is gone before the round trip finishes, because
    // "don't show here again" that takes 300ms to obey feels ignored. The
    // storage listener confirms it, and a failure is surfaced on the pill of
    // the next page load rather than by springing back into view.
    send({ type: 'videoOverlayBlockSite', host: location.hostname }).catch(() => {});
    state.siteBlocked = true;
    stop();
  }

  function disableEverywhere() {
    closePanel();
    send({ type: 'videoOverlaySetEnabled', on: false }).catch(() => {});
    state.enabled = false;
    stop();
  }

  /* ---------------------------------------------------------------- *
   * Discovery listeners
   * ---------------------------------------------------------------- */

  /**
   * One handler for all three media events. Media events do not bubble, so
   * this MUST stay in the capture phase — that is the whole trick that lets a
   * single document listener see videos created long after load.
   */
  function onMediaEvent(e) {
    const video = e.target;
    if (!video || video.tagName !== 'VIDEO') return;
    const rec = register(video);
    if (!rec) return;

    if (e.type === 'play' || e.type === 'playing') {
      if (rec.playTimer) return;
      rec.playTimer = setTimeout(() => {
        rec.playTimer = 0;
        if (!state.running || video.paused) return;
        if (state.panelOpen) return;
        show(video, 'play');
      }, PLAY_DELAY_MS);
    }
  }

  function onPause(e) {
    const video = e.target;
    if (!video || video.tagName !== 'VIDEO') return;
    const rec = records.get(video);
    if (rec && rec.playTimer) {
      clearTimeout(rec.playTimer);
      rec.playTimer = 0;
    }
    // A pause while the pointer is elsewhere means the user walked away.
    if (state.active === video && state.hovered !== video && !state.panelOpen) hideUnlessPinned();
  }

  function onFullscreen() {
    if (document.fullscreenElement) hide();
  }

  /**
   * Soft navigation. The visual teardown is all that is needed here — the URL
   * itself is read fresh at send time — so these three signals covering
   * YouTube (`yt-navigate-finish`), the History API's back/forward and hash
   * routing are enough without patching anything on the page.
   */
  function onSoftNavigation() {
    hide();
    for (const video of Array.from(registered)) {
      if (!video.isConnected) unregister(video);
    }
    // Both caches are keyed by URL, so a soft navigation can never read a
    // wrong entry out of them — but nothing else ever empties them either,
    // and a long YouTube session is hundreds of navigations. A format list is
    // thirty-odd objects. This is the natural boundary to drop them at.
    probeCache.clear();
    sizeCache.clear();
  }

  function onPageHide() {
    teardown();
  }

  function start() {
    if (state.running) return;
    state.running = true;

    document.addEventListener('loadedmetadata', onMediaEvent, true);
    document.addEventListener('play', onMediaEvent, true);
    document.addEventListener('playing', onMediaEvent, true);
    document.addEventListener('pause', onPause, true);
    document.addEventListener('pointerover', onPointerOver, { capture: true, passive: true });
    document.addEventListener('fullscreenchange', onFullscreen, true);
    document.addEventListener('yt-navigate-finish', onSoftNavigation, true);
    document.addEventListener('yt-navigate-start', onSoftNavigation, true);
    window.addEventListener('popstate', onSoftNavigation);
    window.addEventListener('hashchange', onSoftNavigation);
    window.addEventListener('pagehide', onPageHide);

    // Whatever is already on the page. One query, once.
    for (const video of document.querySelectorAll('video')) register(video);
  }

  function stop() {
    if (!state.running) return;
    state.running = false;

    document.removeEventListener('loadedmetadata', onMediaEvent, true);
    document.removeEventListener('play', onMediaEvent, true);
    document.removeEventListener('playing', onMediaEvent, true);
    document.removeEventListener('pause', onPause, true);
    document.removeEventListener('pointerover', onPointerOver, true);
    document.removeEventListener('fullscreenchange', onFullscreen, true);
    document.removeEventListener('yt-navigate-finish', onSoftNavigation, true);
    document.removeEventListener('yt-navigate-start', onSoftNavigation, true);
    window.removeEventListener('popstate', onSoftNavigation);
    window.removeEventListener('hashchange', onSoftNavigation);

    hide();
    probeCache.clear();
    sizeCache.clear();
    for (const video of Array.from(registered)) unregister(video);
    if (state.io) {
      state.io.disconnect();
      state.io = null;
    }
    if (state.host && state.host.parentNode) state.host.parentNode.removeChild(state.host);
    state.host = null;
    state.shadow = null;
    state.wrap = null;
    state.pill = null;
    state.pillLabel = null;
    state.panel = null;
  }

  function teardown() {
    window.removeEventListener('pagehide', onPageHide);
    stop();
  }

  function applyConfig(config) {
    state.configLoaded = true;
    state.enabled = Boolean(config && config.enabled);
    state.siteBlocked = Boolean(config && config.siteBlocked);
    if (state.enabled && !state.siteBlocked) start();
    else stop();
  }

  /**
   * Ask once. Concurrent callers share the in-flight promise, and a failure
   * leaves `configLoaded` false so nothing is ever drawn on a guess — the
   * wrong guess here is a pill on the page of someone who turned it off.
   */
  function ensureConfig() {
    if (state.configLoaded || state.configPending) return state.configPending;
    state.configPending = send({ type: 'videoOverlayConfig', host: location.hostname })
      .then((config) => {
        state.configPending = null;
        applyConfig(config);
      })
      .catch(() => {
        // Worker asleep mid-restart, or the extension is reloading. Allow a
        // later video to try again rather than latching off for the session.
        state.configPending = null;
      });
    return state.configPending;
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  // Flipping either switch has to take effect in tabs that are ALREADY open —
  // "don't show here again" that needs a reload to obey is not an off switch.
  // Gated on configLoaded so that frames which never saw a video (most of
  // them) stay silent instead of all messaging at once on a preference write.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.prefs) return;
      if (!state.configLoaded) return;
      send({ type: 'videoOverlayConfig', host: location.hostname })
        .then(applyConfig)
        .catch(() => {});
    });
  } catch (_) {
    /* storage events are a nicety, not a requirement */
  }

  function boot() {
    // A frame too small to hold a video worth a pill is not worth watching.
    // This is what keeps tracking pixels and banner iframes out entirely.
    if (window !== window.top) {
      if (window.innerWidth < MIN_W || window.innerHeight < MIN_H) return;
    }
    // Listeners only. Nothing is measured, nothing is drawn and no message is
    // sent until a <video> actually turns up.
    start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
