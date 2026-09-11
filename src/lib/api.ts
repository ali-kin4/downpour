/**
 * Typed wrapper over the Tauri IPC surface.
 *
 * Every call the UI makes goes through here, so there is exactly one place
 * where command names are spelled and exactly one place to look when a command
 * is renamed. Nothing in `components/` should import `invoke` directly.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AddRequest,
  DownloadId,
  DownloadItem,
  EngineEvent,
  QueueStats,
  RemoteInfo,
  RpcInfo,
  Settings,
  StartMode,
} from "./types";

/** The single channel the shell forwards engine events on. */
const EVENT_CHANNEL = "downpour://event";

/**
 * True when running inside the Tauri webview.
 *
 * The UI is also openable in a plain browser during development (`npm run
 * dev`), where every IPC call would otherwise throw on load and leave a blank
 * screen. Guarding here means the layout can still be worked on in a browser.
 */
export const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri()) {
    throw new Error(`not running in Tauri; "${cmd}" is unavailable`);
  }
  return invoke<T>(cmd, args);
}

// -- Reading ----------------------------------------------------------------

export const listDownloads = () => call<DownloadItem[]>("list_downloads");
export const getDownload = (id: DownloadId) =>
  call<DownloadItem | null>("get_download", { id });
export const getStats = () => call<QueueStats>("get_stats");
export const getSettings = () => call<Settings>("get_settings");
export const updateSettings = (settings: Settings) =>
  call<Settings>("update_settings", { settings });
export const probeUrl = (url: string, headers?: Record<string, string>) =>
  call<RemoteInfo>("probe_url", { url, headers: headers ?? null });

// -- Adding -----------------------------------------------------------------

export const addDownload = (request: AddRequest) =>
  call<DownloadId>("add_download", { request });
export const addDownloads = (requests: AddRequest[]) =>
  call<DownloadId[]>("add_downloads", { requests });
export const addFromText = (
  text: string,
  startMode: StartMode,
  destDir?: string | null,
) => call<DownloadId[]>("add_from_text", { text, startMode, destDir: destDir ?? null });
/** Extracts links without adding them, so a paste dialog can show a count. */
export const previewLinks = (text: string) =>
  call<string[]>("preview_links", { text });

// -- Per-item control -------------------------------------------------------

export const startDownload = (id: DownloadId) => call<void>("start_download", { id });
export const forceStartDownload = (id: DownloadId) =>
  call<void>("force_start_download", { id });
export const pauseDownload = (id: DownloadId) => call<void>("pause_download", { id });
export const cancelDownload = (id: DownloadId) => call<void>("cancel_download", { id });
export const removeDownload = (id: DownloadId, deleteFiles: boolean) =>
  call<void>("remove_download", { id, deleteFiles });
export const setScheduled = (id: DownloadId, scheduled: boolean) =>
  call<void>("set_scheduled", { id, scheduled });
export const moveToTop = (id: DownloadId) => call<void>("move_to_top", { id });
export const moveToBottom = (id: DownloadId) => call<void>("move_to_bottom", { id });

// -- Bulk -------------------------------------------------------------------

export const pauseAll = () => call<void>("pause_all");
export const resumeAll = () => call<void>("resume_all");
export const retryFailed = () => call<number>("retry_failed");
export const clearCompleted = () => call<number>("clear_completed");
export const clearFinished = () => call<number>("clear_finished");
export const removeMany = (ids: DownloadId[], deleteFiles: boolean) =>
  call<number>("remove_many", { ids, deleteFiles });
export const startMany = (ids: DownloadId[]) => call<number>("start_many", { ids });
export const pauseMany = (ids: DownloadId[]) => call<number>("pause_many", { ids });

// -- Shell ------------------------------------------------------------------

export const openPath = (path: string) => call<void>("open_path", { path });
export const revealPath = (path: string) => call<void>("reveal_path", { path });
export const pathExists = (path: string) => call<boolean>("path_exists", { path });
export const appVersion = () => call<string>("app_version");
/** Brings the main window to the front (used by the progress panel). */
export const showMainWindow = () => call<void>("show_main_window");
/** Reads a user-picked .txt of links. Size-capped on the Rust side. */
export const readTextFile = (path: string) => call<string>("read_text_file", { path });
/** Pauses everything, flushes resume state, then exits. */
export const quitApp = () => call<void>("quit_app");
export const abortPowerAction = () => call<void>("abort_power_action");

// -- Duplicates -------------------------------------------------------------

export interface DuplicateInfo {
  previous: DownloadItem | null;
  previousFileExists: boolean;
  inProgress: DownloadItem | null;
  conflictingPath: string | null;
}

/** Checks a URL against the history and the filesystem before adding it. */
export const checkDuplicate = (url: string, filename?: string | null) =>
  call<DuplicateInfo>("check_duplicate", { url, filename: filename ?? null });

// -- Progress window --------------------------------------------------------

export const openProgressWindow = () => call<void>("open_progress_window");
export const closeProgressWindow = () => call<void>("close_progress_window");
export const progressWindowOpen = () => call<boolean>("progress_window_open");

// -- Category folders -------------------------------------------------------

export interface CategoryFolderInfo {
  name: string;
  icon: string;
  path: string;
  exists: boolean;
  extensions: string[];
}

export const categoryFolders = () => call<CategoryFolderInfo[]>("category_folders");
/** Creates any missing category folder; returns how many were made. */
export const createCategoryFolders = () => call<number>("create_category_folders");

// -- Browser integration ----------------------------------------------------

export const getRpcInfo = () => call<RpcInfo>("get_rpc_info");
export const regenerateRpcToken = () => call<string>("regenerate_rpc_token");

// -- Events -----------------------------------------------------------------

/**
 * Subscribes to engine events.
 *
 * Returns the unlisten function; callers must call it on unmount or a hot
 * reload will stack duplicate listeners and every progress tick will be
 * applied several times.
 */
export async function onEngineEvent(
  handler: (event: EngineEvent) => void,
): Promise<UnlistenFn> {
  if (!inTauri()) return () => {};
  return listen<EngineEvent>(EVENT_CHANNEL, (e) => handler(e.payload));
}

/**
 * Normalises an IPC rejection into something displayable.
 *
 * Tauri rejects with whatever the command returned as its error type, which
 * for us is a plain string; anything else means the bridge itself failed.
 */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}
