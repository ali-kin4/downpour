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

  useEffect(() => {
    const el = document.documentElement;
    if (theme === "light" || theme === "dark") {
      el.setAttribute("data-theme", theme);
    } else {
      el.removeAttribute("data-theme");
    }
  }, [theme]);
}
