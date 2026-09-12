/**
 * The map of the settings screen.
 *
 * Every control that can be searched for has exactly one entry here, keyed by
 * a dotted `tab.group.control` id. That buys three things at once:
 *
 *  - the search box can say which tab a match lives on without rendering the
 *    other eight tabs (and firing their network calls) to find out;
 *  - a group heading can hide itself when none of its members matched, just by
 *    testing the id prefix;
 *  - `SettingId` is a literal union, so rendering `<Setting id="…">` with an id
 *    that is not in this list is a compile error rather than a control that
 *    silently disappears the moment anyone types in the search box.
 *
 * `keywords` is for the words a person would actually type — "throttle",
 * "youtube", "spyware" — not a restatement of the label.
 */

import {
  Bell,
  CalendarClock,
  Clapperboard,
  ClipboardList,
  Folder,
  Gauge,
  Globe,
  Monitor,
  SlidersHorizontal,
} from "lucide-react";
import type { ReactNode } from "react";

export type TabId =
  | "general"
  | "downloads"
  | "scheduler"
  | "capture"
  | "browser"
  | "media"
  | "notifications"
  | "system"
  | "advanced";

export const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <Folder size={14} /> },
  { id: "downloads", label: "Downloads", icon: <Gauge size={14} /> },
  { id: "scheduler", label: "Scheduler", icon: <CalendarClock size={14} /> },
  { id: "capture", label: "Capture", icon: <ClipboardList size={14} /> },
  { id: "browser", label: "Browser", icon: <Globe size={14} /> },
  { id: "media", label: "Video pages", icon: <Clapperboard size={14} /> },
  { id: "notifications", label: "Notifications", icon: <Bell size={14} /> },
  { id: "system", label: "System", icon: <Monitor size={14} /> },
  { id: "advanced", label: "Advanced", icon: <SlidersHorizontal size={14} /> },
];

interface IndexEntry {
  /** `tab.group.control`. Exactly three segments. */
  id: `${TabId}.${string}.${string}`;
  label: string;
  /** Extra words to match on, beyond the label, tab name and group name. */
  keywords?: string;
}

export const SETTINGS_INDEX = [
  // -- General --------------------------------------------------------------
  {
    id: "general.files.downloadDir",
    label: "Download folder",
    keywords: "directory path location where files go save browse",
  },
  {
    id: "general.files.categories",
    label: "Sort downloads by file type",
    keywords:
      "category subfolder video music pictures documents compressed programs organise organize",
  },
  {
    id: "general.files.conflict",
    label: "When the file already exists",
    keywords: "duplicate rename overwrite skip conflict same name",
  },
  {
    id: "general.appearance.theme",
    label: "Theme",
    keywords: "dark light system night mode",
  },
  {
    id: "general.appearance.accent",
    label: "Accent colour",
    keywords: "color highlight aurora ember forest orchid slate gradient",
  },

  // -- Downloads ------------------------------------------------------------
  {
    id: "downloads.limits.concurrent",
    label: "Downloads at the same time",
    keywords: "concurrent parallel simultaneous queue how many at once",
  },
  {
    id: "downloads.limits.connections",
    label: "Connections per download",
    keywords: "segments threads parts chunks multipart range split accelerate",
  },
  {
    id: "downloads.bandwidth.speedLimit",
    label: "Speed limit",
    keywords: "throttle bandwidth cap slow down kbps mbps rate limit",
  },

  // -- Scheduler ------------------------------------------------------------
  {
    id: "scheduler.options.enabled",
    label: "Use the scheduler",
    keywords: "timer off peak overnight delay",
  },
  {
    id: "scheduler.options.newDownloads",
    label: "Schedule new downloads by default",
    keywords: "wait queue later hold",
  },
  {
    id: "scheduler.options.pauseOutside",
    label: "Pause when a window closes",
    keywords: "stop end of window overrun",
  },
  {
    id: "scheduler.options.speedLimit",
    label: "Speed limit inside windows",
    keywords: "throttle overnight bandwidth cap",
  },
  {
    id: "scheduler.options.onComplete",
    label: "When the queue finishes",
    keywords: "sleep hibernate shut down shutdown exit quit power",
  },
  {
    id: "scheduler.windows.editor",
    label: "Time windows",
    keywords: "hours days weekday weekend midnight start end",
  },

  // -- Capture --------------------------------------------------------------
  {
    id: "capture.clipboard.watch",
    label: "Watch the clipboard for links",
    keywords: "copy paste monitor detect grab url automatically",
  },
  {
    id: "capture.clipboard.autoAdd",
    label: "Start captured links without asking",
    keywords: "automatic auto add silently no prompt",
  },
  {
    id: "capture.clipboard.extensions",
    label: "Only capture these file types",
    keywords: "extensions filter zip iso mp4 pdf ignore",
  },
  {
    id: "capture.clipboard.preview",
    label: "On the clipboard now",
    keywords: "preview test check try it what would be captured",
  },

  // -- Browser --------------------------------------------------------------
  {
    id: "browser.extension.enabled",
    label: "Accept downloads from the extension",
    keywords: "chrome firefox edge integration hand off intercept",
  },
  {
    id: "browser.extension.status",
    label: "Listener status",
    keywords: "listening connected not working port bound loopback",
  },
  {
    id: "browser.extension.port",
    label: "Loopback port",
    keywords: "127.0.0.1 localhost number socket",
  },
  {
    id: "browser.extension.token",
    label: "Pairing token",
    keywords: "secret password key pair authorise authorize",
  },
  {
    id: "browser.extension.regenerate",
    label: "Regenerate the pairing token",
    keywords: "new secret revoke unpair reset key",
  },

  // -- Video pages ----------------------------------------------------------
  {
    id: "media.ytdlp.status",
    label: "yt-dlp",
    keywords:
      "youtube video page media extractor install download tool helper ytdlp",
  },

  // -- Notifications --------------------------------------------------------
  {
    id: "notifications.toasts.complete",
    label: "Notify when a download completes",
    keywords: "toast popup finished done alert",
  },
  {
    id: "notifications.toasts.error",
    label: "Notify when a download fails",
    keywords: "toast popup error failure alert",
  },
  {
    id: "notifications.toasts.sound",
    label: "Play a sound on completion",
    keywords: "chime noise audio ding mute",
  },
  {
    id: "notifications.panel.progressWindow",
    label: "Floating progress panel",
    keywords: "always on top mini popup window widget overlay",
  },

  // -- System ---------------------------------------------------------------
  {
    id: "system.windows.launchAtLogin",
    label: "Launch at login",
    keywords: "startup boot autostart start with windows",
  },
  {
    id: "system.windows.startMinimized",
    label: "Start minimised",
    keywords: "minimized tray hidden background",
  },
  {
    id: "system.windows.closeToTray",
    label: "Close to the tray",
    keywords: "x button quit exit background keep running",
  },

  // -- Advanced -------------------------------------------------------------
  {
    id: "advanced.network.userAgent",
    label: "User agent",
    keywords: "browser string header 403 forbidden blocked identify useragent",
  },
  {
    id: "advanced.network.timeout",
    label: "Request timeout",
    keywords: "seconds wait hang stall unresponsive",
  },
  {
    id: "advanced.network.retries",
    label: "Retries per download",
    keywords: "retry attempts give up failure resume",
  },
  {
    id: "advanced.diagnostics.log",
    label: "Application log",
    keywords: "log logs diagnostics debug crash error report troubleshoot bug",
  },
  {
    id: "advanced.limits.ceiling",
    label: "Why connections stop at 16",
    keywords: "maximum ceiling 32 more connections faster rate limit throttle",
  },
] as const satisfies readonly IndexEntry[];

export type SettingId = (typeof SETTINGS_INDEX)[number]["id"];

type GroupOf<T> = T extends `${infer A}.${infer B}.${string}` ? `${A}.${B}` : never;

/** `tab.group` — the prefix a `Group` heading is addressed by. */
export type GroupId = GroupOf<SettingId>;

/**
 * Group headings, here rather than in the tab files so that searching for
 * "appearance" or "bandwidth" finds the controls underneath them.
 */
export const GROUPS = {
  "general.files": "Files",
  "general.appearance": "Appearance",
  "downloads.limits": "How much at once",
  "downloads.bandwidth": "Bandwidth",
  "scheduler.options": "Scheduler",
  "scheduler.windows": "Time windows",
  "capture.clipboard": "Clipboard monitoring",
  "browser.extension": "Browser integration",
  "media.ytdlp": "Video pages",
  "notifications.toasts": "Notifications",
  "notifications.panel": "Progress panel",
  "system.windows": "Windows",
  "advanced.network": "Network",
  "advanced.limits": "Limits",
  "advanced.diagnostics": "Diagnostics",
} as const satisfies Record<GroupId, string>;

const TAB_LABEL = new Map<string, string>(
  TABS.map((t): [string, string] => [t.id, t.label]),
);

/** Lowercased searchable text per entry, built once. */
const HAYSTACK = new Map<string, string>(
  SETTINGS_INDEX.map((e): [string, string] => {
    const [tab, group] = e.id.split(".");
    const words = [
      TAB_LABEL.get(tab) ?? "",
      GROUPS[`${tab}.${group}` as GroupId] ?? "",
      e.label,
      "keywords" in e ? e.keywords : "",
    ];
    return [e.id, words.join(" ").toLowerCase()];
  }),
);

/**
 * The ids matching a query, or `null` when there is no query.
 *
 * `null` rather than "everything" so callers can tell "not searching" from
 * "searching and every setting happens to match", which look identical in a
 * set but mean different things to the highlight.
 *
 * Every whitespace-separated term must appear somewhere in an entry's text.
 * Deliberately substring matching and not fuzzy: "port" should not surface
 * "Import", but "speed limit" and "limit speed" should both find the throttle.
 */
export function searchHits(query: string): Set<string> | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  const hits = new Set<string>();
  for (const [id, hay] of HAYSTACK) {
    if (terms.every((t) => hay.includes(t))) hits.add(id);
  }
  return hits;
}

/** How many matches each tab holds, for the badge on the tab rail. */
export function countByTab(hits: Set<string>): Map<TabId, number> {
  const counts = new Map<TabId, number>();
  for (const id of hits) {
    const tab = id.split(".")[0] as TabId;
    counts.set(tab, (counts.get(tab) ?? 0) + 1);
  }
  return counts;
}
