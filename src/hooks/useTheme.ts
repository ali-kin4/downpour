import { useEffect } from "react";
import { useApp } from "../store/app";

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

/** The accents Settings can offer. Keep in step with `theme.css`. */
export const ACCENTS = [
  { id: "aurora", label: "Aurora", from: "#6366f1", to: "#22d3ee" },
  { id: "ember", label: "Ember", from: "#f43f5e", to: "#f59e0b" },
  { id: "forest", label: "Forest", from: "#059669", to: "#84cc16" },
  { id: "orchid", label: "Orchid", from: "#a855f7", to: "#ec4899" },
  { id: "slate", label: "Slate", from: "#475569", to: "#64748b" },
] as const;
