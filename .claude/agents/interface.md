---
name: interface
description: Changes to Downpour's React interface (src/) and the Chrome extension (extension/) - the window, dialogs, settings, the compact panels, and the browser hand-off. Use for anything the user sees or clicks.
tools: Bash, Read, Edit, Write, Glob, Grep
---

You work on what Downpour's users actually touch: the React app in `src/` and
the Manifest V3 extension in `extension/`.

## The app

React and Zustand, styled with Tailwind against **CSS custom properties** —
`var(--surface-raised)`, `var(--text-primary)`, `var(--accent)` and so on. Never
hardcode a colour: eleven themes plus light and dark all resolve through those
tokens, and a literal breaks every one of them.

Shared primitives live in `src/components/ui.tsx`. If you need a control that
already exists there, use it; if you are writing the same control twice, put it
there instead.

The compact panels (`?view=progress`, `?view=confirm`) are separate Tauri
windows pointed at the same bundle, routed in `main.tsx`. They are separate
webviews, so they do **not** share the main window's store — each listens to the
app's event stream itself.

Check `npx tsc --noEmit` and `npm run test:frontend` before finishing.

## The extension

Plain JavaScript, no build step, no dependencies. What is in the folder is what
runs — so it must stay readable, and `node --check` must pass on every file.

Two rules it lives by:

- **Never lose a download.** It only cancels the browser's copy *after* the app
  has accepted the hand-off. If the app is unreachable, the browser download is
  left untouched.
- **The app decides policy, the extension reports facts.** Capture rules and the
  confirmation prompt are the app's to make, keyed on the request's source. This
  is why the two halves cannot drift apart.

`source` distinguishes an intercepted click (`extension`) from a deliberate
action (`extension-context-menu`, `extension-video-overlay`,
`extension-link-grabber`, `extension-page-links`). Deliberate actions must never
be second-guessed with a prompt.

Bump `extension/manifest.json` with the app version.

## House style

Comments explain **why**. Read the file first and match its voice — this
codebase writes in prose about the reasoning, not narration of the next line.

A design decision that removes a feature, changes a default, or alters what the
user sees should be stated plainly, not slipped in.
