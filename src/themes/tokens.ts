/**
 * The token contract every theme must satisfy.
 *
 * `TokenName` is a literal union rather than `string`, so a theme that forgets
 * `--status-failed` is a compile error instead of one row of one table quietly
 * rendering in the default red. The list mirrors the `:root` block in
 * `theme.css`; adding a token there means adding it here, and the compiler will
 * then walk you round every theme that needs it.
 *
 * Two rules a theme must respect, because the app's layout depends on them:
 *
 *  1. `bgWindow` and `surfaceChrome` carry alpha — Windows 11 Mica renders the
 *     desktop through them, which is the point. `surfaceRaised` must stay
 *     **opaque**: it sits behind eight columns of dense text, and wallpaper
 *     showing through that is unreadable.
 *  2. Shadows are tokens too. A theme that leaves them out inherits neutral
 *     grey shadows, which look dirty against a warm or saturated ground.
 */

export const TOKEN_NAMES = [
  "bgWindow",
  "surfaceChrome",
  "surfaceRaised",
  "surfaceSunken",
  "surfaceHover",
  "surfaceSelected",
  "borderSubtle",
  "borderStrong",
  "borderFocus",
  "textPrimary",
  "textSecondary",
  "textTertiary",
  "textOnAccent",
  "accent",
  "accentHover",
  "accentSoft",
  "accentFrom",
  "accentTo",
  "statusRunning",
  "statusComplete",
  "statusFailed",
  "statusPaused",
  "statusScheduled",
  "statusIdle",
  "shadowCard",
  "shadowOverlay",
] as const;

export type TokenName = (typeof TOKEN_NAMES)[number];

/** Every token, no exceptions — that is what makes this type worth having. */
export type TokenSet = Record<TokenName, string>;

/** The CSS custom property each token is written to. */
export const CSS_VARIABLE: Record<TokenName, string> = {
  bgWindow: "--bg-window",
  surfaceChrome: "--surface-chrome",
  surfaceRaised: "--surface-raised",
  surfaceSunken: "--surface-sunken",
  surfaceHover: "--surface-hover",
  surfaceSelected: "--surface-selected",
  borderSubtle: "--border-subtle",
  borderStrong: "--border-strong",
  borderFocus: "--border-focus",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textTertiary: "--text-tertiary",
  textOnAccent: "--text-on-accent",
  accent: "--accent",
  accentHover: "--accent-hover",
  accentSoft: "--accent-soft",
  accentFrom: "--color-accent-from",
  accentTo: "--color-accent-to",
  statusRunning: "--status-running",
  statusComplete: "--status-complete",
  statusFailed: "--status-failed",
  statusPaused: "--status-paused",
  statusScheduled: "--status-scheduled",
  statusIdle: "--status-idle",
  shadowCard: "--shadow-card",
  shadowOverlay: "--shadow-overlay",
};

/**
 * A theme, resolved: both modes, fully populated.
 *
 * This is also the shape an installed or downloaded theme would arrive in — the
 * manifest a marketplace would serve. It is deliberately plain data: no
 * functions, no imports, nothing that has to be executed to be understood, so
 * validating a stranger's theme is reading a JSON object rather than running
 * their code.
 */
export interface Theme {
  /** Stable, lowercase, used in `data-palette` and saved in settings. */
  id: string;
  name: string;
  /** One line of character, shown under the name in the picker. */
  tagline: string;
  /** Who made it. Built-ins say "Downpour". */
  author: string;
  light: TokenSet;
  dark: TokenSet;
}
