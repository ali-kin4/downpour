/**
 * Turns a short theme spec into a complete, valid pair of token sets.
 *
 * Writing 26 tokens twice by hand, ten times over, is 520 hex values nobody can
 * keep consistent — the tenth theme's hover tint drifts from the first's and
 * the app stops feeling like one app. So a theme states its *character*: an
 * accent pair, a ground colour, an ink colour. Everything structural — hover
 * tints, borders, the soft accent wash, shadows — is derived here, identically
 * for every theme.
 *
 * What a spec may not do is break the two layout rules in `tokens.ts`. That is
 * enforced by construction rather than by review: `surfaceRaised` is always
 * opaque, and only the window and chrome layers are given alpha.
 */

import type { Theme, TokenSet } from "./tokens";

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

function hex(value: string): Rgb {
  const h = value.replace("#", "").trim();
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/** `amount` of `b` mixed into `a`. 0 is all `a`, 1 is all `b`. */
function mix(a: string, b: string, amount: number): string {
  const [r1, g1, b1] = hex(a);
  const [r2, g2, b2] = hex(b);
  const m = (x: number, y: number) => clamp(x + (y - x) * amount);
  return `#${[m(r1, r2), m(g1, g2), m(b1, b2)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * WCAG relative luminance. Used to decide what colour text can sit on an
 * accent, rather than assuming white and hoping.
 */
function luminance(color: string): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hex(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/**
 * White, or the theme's own ink darkened until it is legible — whichever reads
 * better on this accent.
 */
function readableOn(accent: string, ink: string): string {
  const dark = mix(ink, "#000000", 0.25);
  return contrast(accent, "#ffffff") >= contrast(accent, dark) ? "#ffffff" : dark;
}

/** The app writes colours as `rgb(r g b / a)`, so alpha stays readable. */
function alpha(color: string, a: number): string {
  const [r, g, b] = hex(color);
  return `rgb(${r} ${g} ${b} / ${a})`;
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

/** One mode of a theme, stated as the few colours that give it character. */
export interface ModeSpec {
  /** The paper (light) or the room (dark). Everything else is built from it. */
  ground: string;
  /** Panels and dialogs — the opaque layer the download table sits on. */
  raised: string;
  /** The main text colour. */
  ink: string;
  /** The accent gradient, and the solid accent derived from `from`. */
  from: string;
  to: string;
  /** Optional: a solid accent that differs from `from` (dark modes often want
   *  a lighter one so it reads against a dark ground). */
  accent?: string;
  /** Optional status overrides, where a theme wants its own success green. */
  status?: Partial<{
    complete: string;
    failed: string;
    paused: string;
    scheduled: string;
  }>;
}

export interface ThemeSpec {
  id: string;
  name: string;
  tagline: string;
  author?: string;
  light: ModeSpec;
  dark: ModeSpec;
}

// Sensible status colours, so a theme only names the ones it wants to change.
const LIGHT_STATUS = {
  complete: "#059669",
  failed: "#dc2626",
  paused: "#d97706",
  scheduled: "#7c3aed",
};
const DARK_STATUS = {
  complete: "#34d399",
  failed: "#f87171",
  paused: "#fbbf24",
  scheduled: "#a78bfa",
};

function tokens(spec: ModeSpec, mode: "light" | "dark"): TokenSet {
  const isLight = mode === "light";
  const accent = spec.accent ?? spec.from;
  // Ink and ground are the two poles; every neutral is a point between them.
  const { ground, raised, ink } = spec;
  const status = { ...(isLight ? LIGHT_STATUS : DARK_STATUS), ...spec.status };

  return {
    // Chrome is translucent on purpose — Mica shows the desktop through it.
    bgWindow: alpha(ground, 0.72),
    surfaceChrome: alpha(isLight ? raised : mix(raised, ink, 0.06), 0.55),
    // Opaque. The download table sits on this.
    surfaceRaised: raised,
    // In light the sunken layer is the ground itself; in dark it lifts
    // slightly, because a panel recessed below an already-black window reads as
    // a hole rather than a surface.
    surfaceSunken: isLight ? ground : mix(ground, ink, 0.035),
    surfaceHover: alpha(accent, isLight ? 0.06 : 0.08),
    surfaceSelected: alpha(accent, isLight ? 0.11 : 0.16),

    borderSubtle: isLight ? alpha(ink, 0.07) : alpha("#ffffff", 0.07),
    borderStrong: isLight ? alpha(ink, 0.13) : alpha("#ffffff", 0.14),
    borderFocus: accent,

    textPrimary: ink,
    textSecondary: mix(ink, ground, isLight ? 0.35 : 0.38),
    textTertiary: mix(ink, ground, isLight ? 0.58 : 0.6),
    // Decided against the accent, not assumed. A pastel theme's accent is a
    // pale peach or mint; white text on it is invisible, and every accent
    // button in the app uses this token.
    textOnAccent: readableOn(accent, ink),

    accent,
    accentHover: isLight ? mix(accent, ink, 0.22) : mix(accent, "#ffffff", 0.28),
    accentSoft: alpha(accent, isLight ? 0.12 : 0.16),
    accentFrom: spec.from,
    accentTo: spec.to,

    statusRunning: accent,
    statusComplete: status.complete,
    statusFailed: status.failed,
    statusPaused: status.paused,
    statusScheduled: status.scheduled,
    statusIdle: mix(ink, ground, isLight ? 0.45 : 0.4),

    // Tinted with the ground rather than neutral grey, so a warm theme casts a
    // warm shadow instead of a dirty one.
    shadowCard: isLight
      ? `0 1px 2px ${alpha(ink, 0.04)}, 0 1px 3px ${alpha(ink, 0.06)}`
      : "0 1px 2px rgb(0 0 0 / 0.3), 0 1px 3px rgb(0 0 0 / 0.2)",
    shadowOverlay: isLight
      ? `0 10px 38px ${alpha(ink, 0.18)}, 0 4px 12px ${alpha(ink, 0.1)}`
      : "0 10px 38px rgb(0 0 0 / 0.5), 0 4px 12px rgb(0 0 0 / 0.3)",
  };
}

export function makeTheme(spec: ThemeSpec): Theme {
  return {
    id: spec.id,
    name: spec.name,
    tagline: spec.tagline,
    author: spec.author ?? "Downpour",
    light: tokens(spec.light, "light"),
    dark: tokens(spec.dark, "dark"),
  };
}
