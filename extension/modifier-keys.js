'use strict';

/**
 * Downpour — modifier-key watcher.
 *
 * The ONLY declared content script in this extension, and deliberately the
 * smallest thing that can do the job: it lets a user send one download to the
 * browser instead of Downpour by holding a modifier key, without turning
 * capture off.
 *
 * WHAT IT DOES: listens for keydown / keyup / mousedown on window and, when a
 * modifier is held, tells the service worker "alt/ctrl/shift was down at time
 * T". The worker stores that in chrome.storage.session and
 * onDeterminingFilename skips interception if the configured modifier was seen
 * within the last couple of seconds.
 *
 * WHAT IT NEVER DOES: read the DOM, read page content, touch cookies, make
 * network requests, or inject anything into the page. The entire payload it
 * can ever send is three booleans and a timestamp.
 *
 * WHY A DECLARED CONTENT SCRIPT AND NOT chrome.scripting: the modifier has to
 * already be recorded at the moment the download starts. There is no user
 * gesture on the extension to hang an activeTab injection off — by the time we
 * knew we needed it, the click has already happened.
 *
 * MV3 NOTE: every message here wakes the service worker, so messages are
 * throttled and are only ever sent while a modifier is actually down. Ordinary
 * typing and ordinary clicking send nothing at all.
 */

(function () {
  // Bail out of contexts where this makes no sense (e.g. non-HTML documents
  // that still match the pattern).
  if (typeof window === 'undefined' || typeof chrome === 'undefined' || !chrome.runtime) return;

  const THROTTLE_MS = 300;
  let lastSentAt = 0;
  let lastSignature = '';

  function report(alt, ctrl, shift, force) {
    if (!alt && !ctrl && !shift) return; // never wake the worker for nothing

    const signature = (alt ? 'a' : '') + (ctrl ? 'c' : '') + (shift ? 's' : '');
    const now = Date.now();
    // Key repeat fires continuously while a key is held. Re-send only when the
    // combination changes or the throttle window has passed, so that a held
    // key refreshes the timestamp without spamming the worker.
    if (!force && signature === lastSignature && now - lastSentAt < THROTTLE_MS) return;
    lastSignature = signature;
    lastSentAt = now;

    try {
      chrome.runtime.sendMessage({ type: 'modifierHeld', alt, ctrl, shift, at: now }, () => {
        // Swallow "Extension context invalidated" / "no receiving end" — the
        // worker is allowed to be gone, and there is nothing useful to do.
        void chrome.runtime.lastError;
      });
    } catch (_) {
      /* extension was reloaded out from under this page */
    }
  }

  // metaKey is folded into ctrl so that Cmd works as the bypass on macOS. The
  // options page and the popup both label that choice "Ctrl/Cmd" rather than
  // "Ctrl", so a Mac user is not told to hold a key that does nothing.
  function onKey(e) {
    report(e.altKey, e.ctrlKey || e.metaKey, e.shiftKey, false);
  }

  // MOUSEDOWN IS THE PRIMARY SIGNAL, not a fallback. If focus is in the
  // browser chrome (address bar, bookmark bar, tab strip) when the modifier
  // goes down, the page never sees the keydown at all — but it does see the
  // click that follows, with the modifier flags attached. Alt+click is the
  // gesture the user actually performs, so this is the event that matters.
  function onMouse(e) {
    report(e.altKey, e.ctrlKey || e.metaKey, e.shiftKey, true);
  }

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('mousedown', onMouse, true);
  // Middle-click / "open in new tab" style gestures arrive as auxclick.
  window.addEventListener('auxclick', onMouse, true);
})();
