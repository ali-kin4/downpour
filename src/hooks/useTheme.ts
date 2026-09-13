import { useEffect } from "react";
import { useApp } from "../store/app";
import { installThemeStyles, themeById } from "../themes/registry";

/**
 * Applies the theme preference to the document root.
 *
 * "system" removes the attribute entirely rather than resolving it here, so the
 * CSS `prefers-color-scheme` block stays authoritative and the window follows
 * the OS live without JavaScript re-running.
 */
export function useTheme() {
  const theme = useApp((s) => s.settings?.theme);
  const accent = useApp((s) => s.settings?.accent);
  const palette = useApp((s) => s.settings?.palette);

  // Every registered theme's CSS, written once. The picker previews palettes by
  // scoping a card under `data-palette`, so the rules have to exist before one
  // is chosen, not only after.
  useEffect(() => {
    installThemeStyles();
  }, []);

  useEffect(() => {
    // Resolved rather than written through: a palette that has been uninstalled
    // must fall back to the default instead of leaving the window with no
    // matching rule and therefore the bare `:root` colours.
    document.documentElement.setAttribute("data-palette", themeById(palette).id);
  }, [palette]);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "light" || theme === "dark") {
      el.setAttribute("data-theme", theme);
    } else {
      el.removeAttribute("data-theme");
    }
  }, [theme]);

  useEffect(() => {
    // Unset falls through to the bare :root defaults, which are the aurora
    // pair — so an unknown or missing accent still renders correctly rather
    // than leaving the app with undefined colour variables.
    document.documentElement.setAttribute("data-accent", accent || "aurora");
  }, [accent]);
}

/**
 * The accents Settings can offer, for the default palette only.
 *
 * A theme carries its own accent, and its generated rules are scoped by
 * `[data-palette]`, so they outrank these. That is deliberate: someone who
 * picked Sakura asked for Sakura's pink, not for their old accent on top of it.
 * Settings disables the accent row while a non-default palette is active rather
 * than leaving a control that silently does nothing.
 */
export const ACCENTS = [
  { id: "aurora", label: "Aurora", from: "#6366f1", to: "#22d3ee" },
  { id: "ember", label: "Ember", from: "#f43f5e", to: "#f59e0b" },
  { id: "forest", label: "Forest", from: "#059669", to: "#84cc16" },
  { id: "orchid", label: "Orchid", from: "#a855f7", to: "#ec4899" },
  { id: "slate", label: "Slate", from: "#475569", to: "#64748b" },
] as const;
