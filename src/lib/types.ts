/**
 * Mirrors the serde representation of `downpour-core`'s public model.
 *
 * These are hand-written rather than generated because the surface is small
 * and stable, and a generator would be one more thing to keep working. The
 * Rust side carries `#[serde(rename_all = "camelCase")]` on every type here,
 * so the field names below are the wire names verbatim.
 */

export type DownloadId = string;

export type DownloadStatus =
  | "idle"
  | "queued"
  | "scheduled"
  | "probing"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type StartMode = "start" | "addonly" | "schedule";

export type ConflictPolicy = "rename" | "overwrite" | "skip";

export type OnQueueComplete =
  | "nothing"
  | "sleep"
  | "hibernate"
  | "shutdown"
  | "exit";

export interface DownloadItem {
  id: DownloadId;
  url: string;
  finalUrl: string | null;
  filename: string;
  userNamed: boolean;
  nameLocked: boolean;
  destDir: string;
  headers: Record<string, string>;
  status: DownloadStatus;
  totalBytes: number | null;
  downloadedBytes: number;
  speedBps: number;
  etaSecs: number | null;
  connections: number;
  supportsRange: boolean;
  category: string | null;
  source: string | null;
  scheduled: boolean;
  error: string | null;
  checksum: string | null;
  createdAt: number;
  sequence: number;
  startedAt: number | null;
  completedAt: number | null;
  /** Milliseconds spent transferring. */
  elapsedMs: number;
}

export interface RemoteInfo {
  finalUrl: string;
  size: number | null;
  supportsRange: boolean;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  suggestedFilename: string | null;
}

export interface QueueStats {
  total: number;
  running: number;
  queued: number;
  scheduled: number;
  paused: number;
  completed: number;
  failed: number;
  idle: number;
  totalSpeedBps: number;
  /** `null` when the scheduler is switched off entirely. */
  windowOpen: boolean | null;
  minutesUntilWindow: number | null;
}

export interface Category {
  name: string;
  extensions: string[];
  folder: string;
  /** A Lucide icon name. */
  icon: string;
}

/** Bitmask: Monday is bit 0, Sunday is bit 6. */
export type DaySet = number;

export const DAY_ALL: DaySet = 0b0111_1111;
export const DAY_WEEKDAYS: DaySet = 0b0001_1111;
export const DAY_WEEKENDS: DaySet = 0b0110_0000;
export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface ScheduleWindow {
  id: string;
  label: string | null;
  /** Minutes since midnight, inclusive. */
  start: number;
  /** Minutes since midnight, exclusive. `end <= start` wraps past midnight. */
  end: number;
  days: DaySet;
  enabled: boolean;
}

export interface Schedule {
  enabled: boolean;
  windows: ScheduleWindow[];
}

export interface Settings {
  downloadDir: string;

  maxConcurrentDownloads: number;
  maxConnectionsPerDownload: number;
  /** Bytes per second; 0 means unlimited. */
  speedLimitBps: number;
  scheduledSpeedLimitBps: number;
  maxRetries: number;
  requestTimeoutSecs: number;

  sortIntoCategories: boolean;
  categories: Category[];
  conflictPolicy: ConflictPolicy;

  schedule: Schedule;
  scheduleNewDownloads: boolean;
  pauseOutsideWindow: boolean;
  onQueueComplete: OnQueueComplete;

  clipboardWatch: boolean;
  clipboardExtensions: string[];
  clipboardAutoAdd: boolean;
  rpcPort: number;
  rpcToken: string;
  rpcEnabled: boolean;

  userAgent: string;
  theme: string;
  accent: string;
  /** Colour theme id, laid over light/dark/auto. See src/themes. */
  palette: string;
  startMinimized: boolean;
  launchAtLogin: boolean;
  closeToTray: boolean;
  notifyOnComplete: boolean;
  notifyOnError: boolean;
  /** Pop the compact always-on-top panel when a transfer starts. */
  progressWindow: boolean;
  soundOnComplete: boolean;
}

export interface RpcInfo {
  port: number;
  token: string;
  enabled: boolean;
  listening: boolean;
}

/**
 * Events pushed from the engine. Discriminated on `kind`, which is how the
 * store reduces them without a switch on shape.
 *
 * `resync` is emitted by the shell (not the engine) when the UI has fallen far
 * enough behind that events were dropped; the correct response is a full
 * `listDownloads()`.
 */
export type EngineEvent =
  | { kind: "added"; item: DownloadItem }
  | {
      kind: "statusChanged";
      id: DownloadId;
      status: DownloadStatus;
      error: string | null;
    }
  | {
      kind: "progress";
      id: DownloadId;
      downloadedBytes: number;
      totalBytes: number | null;
      speedBps: number;
      etaSecs: number | null;
      connections: number;
    }
  | { kind: "completed"; id: DownloadId; path: string; item: DownloadItem }
  | { kind: "failed"; id: DownloadId; error: string }
  | { kind: "removed"; id: DownloadId }
  | { kind: "schedulerWindow"; open: boolean; label: string | null }
  | { kind: "queueDrained"; completed: number; failed: number }
  | { kind: "resync" };

/** The sidebar's filter buckets. */
export type ViewFilter =
  | "all"
  | "active"
  | "waiting"
  | "completed"
  | "failed";

export interface AddRequest {
  url: string;
  headers?: Record<string, string>;
  filename?: string | null;
  destDir?: string | null;
  connections?: number | null;
  startMode?: StartMode;
  checksum?: string | null;
  source?: string | null;
}

/** Groups statuses into the buckets the sidebar counts. */
export function matchesFilter(
  status: DownloadStatus,
  filter: ViewFilter,
): boolean {
  switch (filter) {
    case "all":
      return status !== "cancelled";
    case "active":
      return status === "running" || status === "probing";
    case "waiting":
      return status === "queued" || status === "scheduled" || status === "idle" || status === "paused";
    case "completed":
      return status === "completed";
    case "failed":
      return status === "failed";
  }
}

/**
 * The result of a manual update check.
 *
 * `latest` is absent when the repository has no published release yet, which is
 * not a failure. A failed check never reaches here at all -- it rejects, so
 * "could not find out" can never be shown as "up to date".
 */
export interface UpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** The release page to open, or the releases index when there is no release. */
  url: string;
  name: string | null;
}

export function isTerminal(status: DownloadStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isActive(status: DownloadStatus): boolean {
  return status === "running" || status === "probing";
}

export function canStart(status: DownloadStatus): boolean {
  return status === "paused" || status === "failed" || status === "idle";
}

export function canPause(status: DownloadStatus): boolean {
  return (
    status === "running" ||
    status === "probing" ||
    status === "queued" ||
    status === "scheduled"
  );
}
