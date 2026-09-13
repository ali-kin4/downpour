/**
 * The themes Downpour ships with.
 *
 * Each is a *pair*, not a colour. Light and dark are the same idea seen at two
 * times of day: Sakura's light mode is blossom on paper, its dark mode is the
 * same tree at night. That is what makes the setting survive someone leaving
 * Downpour on "auto" — at 6pm the window turns dark and the theme is still
 * recognisably itself, rather than swapping to a stranger.
 *
 * Adding one: append a spec. The builder fills in all 26 tokens for both modes,
 * so a theme cannot be half-finished, and `Theme` is plain data — the same
 * shape an installed or downloaded theme would arrive in.
 *
 * The default, `downpour`, reproduces the palette the app has always had. It
 * must stay first and must stay recognisable: it is what someone returns to.
 */

import { makeTheme, type ThemeSpec } from "./build";
import type { Theme } from "./tokens";

const SPECS: ThemeSpec[] = [
  {
    id: "downpour",
    name: "Downpour",
    tagline: "Indigo and cyan. The original.",
    light: {
      ground: "#f3f4f6",
      raised: "#ffffff",
      ink: "#111827",
      from: "#6366f1",
      to: "#22d3ee",
    },
    dark: {
      ground: "#111218",
      raised: "#1c1e26",
      ink: "#f3f4f6",
      from: "#818cf8",
      to: "#22d3ee",
      accent: "#818cf8",
    },
  },
  {
    id: "sakura",
    name: "Sakura",
    tagline: "Blossom on paper, and the same tree at night.",
    light: {
      ground: "#fdf2f6",
      raised: "#ffffff",
      ink: "#4a2334",
      from: "#ec4899",
      to: "#fbcfe8",
      accent: "#db2777",
    },
    dark: {
      ground: "#1d1119",
      raised: "#281823",
      ink: "#fbe9f1",
      from: "#f472b6",
      to: "#fbcfe8",
      accent: "#f472b6",
    },
  },
  {
    id: "matcha",
    name: "Matcha",
    tagline: "Stone-ground green, whisked in a warm bowl.",
    light: {
      ground: "#f2f7ec",
      raised: "#ffffff",
      ink: "#23301c",
      from: "#65a30d",
      to: "#bef264",
      accent: "#4d7c0f",
    },
    dark: {
      ground: "#111a10",
      raised: "#1a2418",
      ink: "#e9f2e2",
      from: "#84cc16",
      to: "#d9f99d",
      accent: "#a3e635",
    },
  },
  {
    id: "cinnamon",
    name: "Cinnamon",
    tagline: "Amber, caramel, and something in the oven.",
    light: {
      ground: "#faf3ea",
      raised: "#fffdfa",
      ink: "#3d2a1b",
      from: "#d97706",
      to: "#fcd34d",
      accent: "#b45309",
    },
    dark: {
      ground: "#1a130d",
      raised: "#241a12",
      ink: "#f7ebdb",
      from: "#f59e0b",
      to: "#fde68a",
      accent: "#fbbf24",
    },
  },
  {
    id: "moonlit",
    name: "Moonlit",
    tagline: "Deep blue quiet, the hour before sleep.",
    light: {
      ground: "#eef3fa",
      raised: "#ffffff",
      ink: "#16203a",
      from: "#3b82f6",
      to: "#93c5fd",
      accent: "#2563eb",
    },
    dark: {
      ground: "#0d1423",
      raised: "#151d30",
      ink: "#e6edfa",
      from: "#60a5fa",
      to: "#c7d2fe",
      accent: "#60a5fa",
    },
  },
  {
    id: "grape-soda",
    name: "Grape Soda",
    tagline: "Fizzy violet. Unapologetically purple.",
    light: {
      ground: "#f6f1fe",
      raised: "#ffffff",
      ink: "#2d1a48",
      from: "#8b5cf6",
      to: "#e879f9",
      accent: "#7c3aed",
    },
    dark: {
      ground: "#150f21",
      raised: "#1f172e",
      ink: "#f0e8fd",
      from: "#a78bfa",
      to: "#f0abfc",
      accent: "#a78bfa",
    },
  },
  {
    id: "peach-fuzz",
    name: "Peach Fuzz",
    tagline: "Soft, warm, faintly sunburnt.",
    light: {
      ground: "#fff4ee",
      raised: "#ffffff",
      ink: "#46291d",
      from: "#fb923c",
      to: "#fecdd3",
      accent: "#ea580c",
    },
    dark: {
      ground: "#1c120d",
      raised: "#261a13",
      ink: "#fcece2",
      from: "#fdba74",
      to: "#fecdd3",
      accent: "#fdba74",
    },
  },
  {
    id: "mint",
    name: "Mint Condition",
    tagline: "Cool, clean, slightly minty.",
    light: {
      ground: "#edfaf5",
      raised: "#ffffff",
      ink: "#12302a",
      from: "#14b8a6",
      to: "#99f6e4",
      accent: "#0d9488",
    },
    dark: {
      ground: "#0a1a17",
      raised: "#112622",
      ink: "#e0f7f1",
      from: "#2dd4bf",
      to: "#99f6e4",
      accent: "#2dd4bf",
    },
  },
  {
    id: "glacier",
    name: "Glacier",
    tagline: "Ice light, and very far north.",
    light: {
      ground: "#eff7fc",
      raised: "#ffffff",
      ink: "#0f2530",
      from: "#0ea5e9",
      to: "#a5f3fc",
      accent: "#0284c7",
    },
    dark: {
      ground: "#08161f",
      raised: "#10202c",
      ink: "#e0f2fb",
      from: "#38bdf8",
      to: "#a5f3fc",
      accent: "#38bdf8",
    },
  },
  {
    id: "bubblegum",
    name: "Bubblegum",
    tagline: "Pink and sky blue, chewed loudly.",
    light: {
      ground: "#fff0f7",
      raised: "#ffffff",
      ink: "#3d1b33",
      from: "#ec4899",
      to: "#7dd3fc",
      accent: "#db2777",
    },
    dark: {
      ground: "#1a0e1a",
      raised: "#241426",
      ink: "#fce7f4",
      from: "#f472b6",
      to: "#7dd3fc",
      accent: "#f472b6",
    },
  },
  {
    id: "midnight-oil",
    name: "Midnight Oil",
    tagline: "Indigo dark, one amber lamp still on.",
    light: {
      ground: "#f5f3ed",
      raised: "#fffefb",
      ink: "#1f2430",
      from: "#4f46e5",
      to: "#f59e0b",
      accent: "#4338ca",
    },
    dark: {
      ground: "#0c0f17",
      raised: "#141926",
      ink: "#eaedf6",
      from: "#818cf8",
      to: "#fbbf24",
      accent: "#a5b4fc",
      status: { paused: "#fbbf24" },
    },
  },
];

/** Resolved, in the order the picker shows them. */
export const BUILT_IN_THEMES: Theme[] = SPECS.map(makeTheme);

/** The one everything falls back to. */
export const DEFAULT_THEME_ID = "downpour";
