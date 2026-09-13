/**
 * The theme registry, and the CSS it generates.
 *
 * Themes are registered rather than imported directly, so that the day a theme
 * arrives from somewhere else — a file the user drops in, a download, a
 * marketplace — it enters through the same door as the built-ins and needs no
 * change here. That door is `registerTheme`. Nothing else is required to make
 * this extensible, and building a loader before a second source of themes
 * exists would be inventing a format nobody has written against yet.
 *
 * ## Why generated CSS rather than JavaScript-resolved colours
 *
 * The app's light/dark switch is deliberately CSS-only: `data-theme` unset
 * means "follow the OS", and `prefers-color-scheme` keeps working with no
 * JavaScript re-running. Resolving a palette in JS and writing inline styles
 * would break that — the window would stop following the system live.
 *
 * So each theme emits the same three selectors the app already uses:
 *
 *     :root[data-palette="x"]                              → light
 *     @media (prefers-color-scheme: dark) → :not([data-theme="light"]) → dark
 *     :root[data-palette="x"][data-theme="dark"]           → dark
 *
 * Light, dark and auto behave exactly as before; the theme rides on top of
 * whichever one is in force. `[data-palette]` also raises specificity above the
 * bare `:root` defaults in `theme.css`, so the cascade does not depend on where
 * this stylesheet happens to land in `<head>`.
 */

import { BUILT_IN_THEMES, DEFAULT_THEME_ID } from "./catalog";
import { CSS_VARIABLE, TOKEN_NAMES, type Theme, type TokenSet } from "./tokens";

const registry = new Map<string, Theme>();

/**
 * Adds a theme, or replaces one with the same id.
 *
 * Returns the problems found rather than throwing: a malformed theme from
 * outside the app should be refused and reported, not allowed to take the
 * window down on startup.
 */
export function registerTheme(theme: Theme): string[] {
  const problems = validateTheme(theme);
  if (problems.length === 0) registry.set(theme.id, theme);
  return problems;
}

/** Everything registered, default first, then in registration order. */
export function allThemes(): Theme[] {
  const themes = [...registry.values()];
  return [
    ...themes.filter((t) => t.id === DEFAULT_THEME_ID),
    ...themes.filter((t) => t.id !== DEFAULT_THEME_ID),
  ];
}

/** A theme by id, falling back to the default for an id that no longer exists
 *  — an uninstalled theme must not leave the app with no palette at all. */
export function themeById(id: string | undefined | null): Theme {
  return (
    (id ? registry.get(id) : undefined) ??
    registry.get(DEFAULT_THEME_ID) ??
    BUILT_IN_THEMES[0]
  );
}

/** What is wrong with this theme, in words. Empty means it is usable. */
export function validateTheme(theme: Theme): string[] {
  const problems: string[] = [];
  if (!theme.id?.match(/^[a-z0-9][a-z0-9-]*$/)) {
    problems.push("id must be lowercase letters, digits and dashes");
  }
  if (!theme.name?.trim()) problems.push("name is required");

  for (const mode of ["light", "dark"] as const) {
    const set = theme[mode];
    if (!set) {
      problems.push(`${mode} palette is missing`);
      continue;
    }
    for (const token of TOKEN_NAMES) {
      if (typeof set[token] !== "string" || !set[token].trim()) {
        problems.push(`${mode}.${token} is missing`);
      }
    }
    // The rule the layout depends on: the download table sits on this surface,
    // and the desktop wallpaper showing through eight columns of dense text is
    // unreadable. Chrome may be translucent; this may not.
    const raised = set?.surfaceRaised ?? "";
    if (/\/\s*0?\.\d/.test(raised) || /rgba|hsla/.test(raised)) {
      problems.push(`${mode}.surfaceRaised must be opaque`);
    }
  }
  return problems;
}

function block(selector: string, set: TokenSet): string {
  const body = TOKEN_NAMES.map(
    (name) => `  ${CSS_VARIABLE[name]}: ${set[name]};`,
  ).join("\n");
  return `${selector} {\n${body}\n}`;
}

const indent = (css: string) =>
  css
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

/**
 * The stylesheet for one theme.
 *
 * Two scopes. `:root[data-palette]` paints the window, and being two selectors
 * deep it outranks the bare `:root` defaults in `theme.css` whatever order the
 * stylesheets land in.
 *
 * `[data-palette-preview]` paints an *element* — the picker's preview cards,
 * which must wear a palette the window is not wearing. Its dark blocks are
 * qualified by the root's state, so a preview is dark exactly when the app is
 * dark. A grid of light cards in a dark window is the tell of a theme picker
 * bolted on afterwards.
 */
export function themeCss(theme: Theme): string {
  const root = `:root[data-palette="${theme.id}"]`;
  const card = `[data-palette-preview="${theme.id}"]`;
  return [
    `/* ${theme.name} — ${theme.tagline} */`,
    block(root, theme.light),
    `@media (prefers-color-scheme: dark) {\n${indent(block(`${root}:not([data-theme="light"])`, theme.dark))}\n}`,
    block(`${root}[data-theme="dark"]`, theme.dark),

    block(card, theme.light),
    `@media (prefers-color-scheme: dark) {\n${indent(block(`:root:not([data-theme="light"]) ${card}`, theme.dark))}\n}`,
    block(`:root[data-theme="dark"] ${card}`, theme.dark),
  ].join("\n\n");
}

const STYLE_ID = "dp-themes";

/**
 * Writes every registered theme's CSS into one `<style>` in the document head.
 *
 * All themes at once, not just the active one: the picker renders live
 * previews by scoping a card under `data-palette`, and a preview can only be
 * honest if the real generated rules are what paint it. Eleven palettes is a
 * few kilobytes of custom properties — cheaper than keeping a second, drifting
 * set of colours for previews.
 */
export function installThemeStyles(doc: Document = document): void {
  const css = allThemes().map(themeCss).join("\n\n");
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

// The built-ins register themselves on import. A theme that fails its own
// validation is a bug in this repository, so it is loud in development rather
// than silently missing from the picker.
for (const theme of BUILT_IN_THEMES) {
  const problems = registerTheme(theme);
  if (problems.length > 0 && import.meta.env.DEV) {
    console.error(`[themes] "${theme.id}" rejected:`, problems);
  }
}

export { DEFAULT_THEME_ID } from "./catalog";
export type { Theme } from "./tokens";
