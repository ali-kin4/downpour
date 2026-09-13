/**
 * Browser-only stand-in for the Tauri backend.
 *
 * Running `npm run dev` opens the UI in an ordinary browser, where every
 * `invoke` would otherwise reject and leave nothing but the error card. This
 * installs a fake `__TAURI_INTERNALS__` so the whole interface can be built,
 * reviewed and screenshotted without compiling Rust — which turns a four-minute
 * rebuild cycle into a hot reload.
 *
 * It is imported only under `import.meta.env.DEV` and never reaches a release
 * bundle. It is a fixture, not a simulator: it holds plausible state and
 * answers commands, but it does not implement the engine's real semantics, so
 * it must never be used to *test* behaviour. Behaviour is tested in Rust.
 */

import type { DownloadItem, Settings } from "../lib/types";

type Handler = (args: Record<string, unknown>) => unknown;

const now = Math.floor(Date.now() / 1000);

/** 64 characters, so the UI's masking and length checks behave, but obviously
 *  not a credential to a human or to a secret scanner. */
const DEV_FAKE_TOKEN = "dev-fixture-token-not-a-real-secret".padEnd(64, "0");

function item(over: Partial<DownloadItem> & { id: string; filename: string }): DownloadItem {
  return {
    url: `https://releases.example.com/${over.filename}`,
    finalUrl: null,
    userNamed: false,
    nameLocked: true,
    destDir: "C:\\Users\\You\\Downloads\\Downpour",
    headers: {},
    status: "completed",
    totalBytes: 1024 * 1024 * 64,
    downloadedBytes: 1024 * 1024 * 64,
    speedBps: 0,
    etaSecs: null,
    connections: 1,
    supportsRange: true,
    category: null,
    source: "ui",
    scheduled: false,
    error: null,
    checksum: null,
    createdAt: now,
    sequence: 0,
    startedAt: now - 60,
    completedAt: now,
    elapsedMs: 60_000,
    ...over,
  };
}

const items: DownloadItem[] = [
  item({
    id: "1",
    filename: "Ubuntu-24.04.2-desktop-amd64.iso",
    status: "running",
    totalBytes: 6_203_180_032,
    downloadedBytes: 2_411_724_800,
    speedBps: 11_400_000,
    etaSecs: 332,
    connections: 8,
    sequence: 6,
    destDir: "C:\\Users\\You\\Downloads\\Downpour\\Compressed",
  }),
  item({
    id: "2",
    filename: "Blender 4.5 Splash Reel.mp4",
    status: "running",
    totalBytes: 842_000_000,
    downloadedBytes: 199_000_000,
    speedBps: 5_800_000,
    etaSecs: 110,
    connections: 4,
    sequence: 5,
    destDir: "C:\\Users\\You\\Downloads\\Downpour\\Video",
  }),
  item({
    id: "3",
    filename: "Annual Report 2026.pdf",
    status: "queued",
    totalBytes: 14_400_000,
    downloadedBytes: 0,
    sequence: 4,
  }),
  item({
    id: "4",
    filename: "Nightly Dataset.tar.gz",
    status: "scheduled",
    scheduled: true,
    totalBytes: 18_900_000_000,
    downloadedBytes: 4_100_000_000,
    sequence: 3,
  }),
  item({
    id: "5",
    filename: "rustup-init.exe",
    status: "paused",
    totalBytes: 9_100_000,
    downloadedBytes: 3_300_000,
    sequence: 2,
  }),
  item({
    id: "6",
    filename: "podcast-ep-214.flac",
    status: "failed",
    error: "server returned status 403",
    totalBytes: null,
    downloadedBytes: 0,
    sequence: 1,
  }),
  item({ id: "7", filename: "wallpaper-4k.png", sequence: 0, totalBytes: 8_400_000, downloadedBytes: 8_400_000 }),
];

const settings: Settings = {
  downloadDir: "C:\\Users\\You\\Downloads\\Downpour",
  maxConcurrentDownloads: 3,
  maxConnectionsPerDownload: 8,
  speedLimitBps: 0,
  scheduledSpeedLimitBps: 0,
  maxRetries: 8,
  requestTimeoutSecs: 60,
  sortIntoCategories: true,
  categories: [
    { name: "Video", icon: "clapperboard", folder: "Video", extensions: ["mp4", "mkv", "mov"] },
    { name: "Music", icon: "music", folder: "Music", extensions: ["mp3", "flac", "wav"] },
    { name: "Pictures", icon: "image", folder: "Pictures", extensions: ["jpg", "png", "webp"] },
    { name: "Documents", icon: "file-text", folder: "Documents", extensions: ["pdf", "docx"] },
    { name: "Compressed", icon: "archive", folder: "Compressed", extensions: ["zip", "rar", "7z", "iso"] },
    { name: "Programs", icon: "app-window", folder: "Programs", extensions: ["exe", "msi"] },
  ],
  conflictPolicy: "rename",
  schedule: {
    enabled: true,
    windows: [
      { id: "a", label: "Overnight", start: 120, end: 420, days: 0b0111_1111, enabled: true },
      { id: "b", label: "Weeknights", start: 1320, end: 360, days: 0b0001_1111, enabled: true },
    ],
  },
  scheduleNewDownloads: false,
  pauseOutsideWindow: true,
  onQueueComplete: "nothing",
  clipboardWatch: false,
  clipboardExtensions: [],
  clipboardAutoAdd: false,
  rpcPort: 47113,
  // Deliberately low-entropy and self-describing. A realistic-looking 64-hex
  // string here is indistinguishable from a leaked credential to a secret
  // scanner, and it trips one on every clone of this repo. The real token is
  // generated per install and never leaves the user's local database.
  rpcToken: DEV_FAKE_TOKEN,
  rpcEnabled: true,
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0",
  theme: "system",
  accent: "aurora",
  palette: "downpour",
  startMinimized: false,
  launchAtLogin: false,
  closeToTray: true,
  notifyOnComplete: true,
  notifyOnError: true,
  progressWindow: true,
  soundOnComplete: false,
};

let current = { ...settings };

const handlers: Record<string, Handler> = {
  list_downloads: () => items,
  get_download: ({ id }) => items.find((i) => i.id === id) ?? null,
  get_settings: () => current,
  update_settings: (a) => {
    current = { ...(a.settings as Settings) };
    return current;
  },
  get_stats: () => ({
    total: items.length,
    running: items.filter((i) => i.status === "running").length,
    queued: items.filter((i) => i.status === "queued").length,
    scheduled: items.filter((i) => i.status === "scheduled").length,
    paused: items.filter((i) => i.status === "paused").length,
    completed: items.filter((i) => i.status === "completed").length,
    failed: items.filter((i) => i.status === "failed").length,
    idle: items.filter((i) => i.status === "idle").length,
    totalSpeedBps: items.reduce((n, i) => n + i.speedBps, 0),
    windowOpen: false,
    minutesUntilWindow: 252,
  }),
  get_rpc_info: () => ({
    port: current.rpcPort,
    token: current.rpcToken,
    enabled: current.rpcEnabled,
    listening: true,
  }),
  category_folders: () =>
    current.categories.map((c) => ({
      name: c.name,
      icon: c.icon,
      path: `${current.downloadDir}\\${c.folder}`,
      exists: c.name !== "Programs",
      extensions: c.extensions,
    })),
  create_category_folders: () => 1,
  // Reports the completed wallpaper as a prior download, so the duplicate
  // notice is reachable in the browser harness.
  check_duplicate: ({ url }) => ({
    previous: String(url).includes("wallpaper") ? items[6] : null,
    previousFileExists: true,
    inProgress: null,
    conflictingPath: null,
  }),
  show_main_window: () => null,
  reset_settings: () => {
    current = { ...settings, downloadDir: current.downloadDir, rpcToken: current.rpcToken };
    return current;
  },
  yt_dlp_status: () => ({ installed: false, version: null, path: null }),
  read_clipboard_urls: () => [
    "https://releases.example.com/sample-from-clipboard.zip",
  ],
  note_clipboard_copy: () => null,
  open_progress_window: () => null,
  close_progress_window: () => null,
  progress_window_open: () => false,
  preview_links: ({ text }) =>
    String(text ?? "").match(/https?:\/\/\S+/g) ?? [],
  app_version: () => "1.1.0",
  // The fixture is always up to date. Reviewing the "update available" state
  // means editing this line, which is the right amount of friction for a state
  // the real check reaches only when GitHub says so.
  check_for_updates: () => ({
    current: "1.1.0",
    latest: "1.1.0",
    updateAvailable: false,
    url: "https://github.com/ali-kin4/downpour/releases",
    name: null,
  }),
  // `listen()` goes through the same invoke bridge. Returning a handler id
  // keeps its matching `unlisten` from dereferencing undefined and throwing
  // during StrictMode's double-mount.
  "plugin:event|listen": () => Math.floor(Math.random() * 1e9),
  "plugin:event|unlisten": () => null,
  "plugin:event|emit": () => null,
  probe_url: () => ({
    finalUrl: "https://releases.example.com/file.iso",
    size: 6_203_180_032,
    supportsRange: true,
    etag: '"abc"',
    lastModified: null,
    contentType: "application/octet-stream",
    suggestedFilename: "file.iso",
  }),
};

export function installMockBackend() {
  if (typeof window === "undefined" || "__TAURI_INTERNALS__" in window) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      const handler = handlers[cmd];
      if (!handler) {
        // Unknown commands resolve rather than reject: a missing fixture should
        // not make the screen under review disappear behind an error card.
        console.info(`[mock] unhandled command: ${cmd}`, args);
        return null;
      }
      return handler(args);
    },
    transformCallback: (cb: unknown) => cb,
    unregisterListener: () => {},
  };
  // `unlisten()` reads a *different* global than `invoke` does; without this
  // stub every StrictMode double-mount throws on cleanup.
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: async () => {},
  };

  console.info("[mock] Tauri backend stubbed for browser development");
}
