/**
 * Display formatting.
 *
 * Sizes and speeds use decimal units (1 kB = 1000 B) to match how bandwidth is
 * universally quoted and how every browser reports download speed. Using
 * binary units here would make Downpour disagree with Chrome about the size of
 * the same file, which reads as a bug.
 */

const UNITS = ["B", "kB", "MB", "GB", "TB", "PB"] as const;

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1000) return `${Math.round(n)} B`;
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // Keep three significant figures so the number does not jitter in width as
  // a download progresses.
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatSpeed(bps: number): string {
  if (!bps) return "—";
  return `${formatBytes(bps)}/s`;
}

export function formatDuration(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || !Number.isFinite(secs)) return "—";
  const s = Math.max(0, Math.round(secs));
  if (s >= 86400) {
    const d = Math.floor(s / 86400);
    return `${d}d ${Math.floor((s % 86400) / 3600)}h`;
  }
  if (s >= 3600) {
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  }
  if (s >= 60) {
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  }
  return `${s}s`;
}

/**
 * Duration from milliseconds, with sub-second resolution.
 *
 * A download that finished in 400ms should say so rather than reporting "0s",
 * which reads as "something went wrong".
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms / 1000);
}

/** `02:00` from minutes since midnight. */
export function formatMinuteOfDay(m: number): string {
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Parses `02:00` or `9:30`; returns null when it is not a valid time. */
export function parseMinuteOfDay(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** "in 4h 12m" / "in 30m" — for the next scheduler window. */
export function formatUntil(minutes: number | null): string {
  if (minutes === null) return "";
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
}

/** Relative time for the completed list: "2m ago", "yesterday". */
export function formatRelative(unixSecs: number | null): string {
  if (!unixSecs) return "—";
  const delta = Date.now() / 1000 - unixSecs;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 172800) return "yesterday";
  if (delta < 604800) return `${Math.floor(delta / 86400)}d ago`;
  return new Date(unixSecs * 1000).toLocaleDateString();
}

/** Truncates the middle of a long path so both ends stay readable. */
export function elideMiddle(text: string, max = 48): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 1) / 2);
  return `${text.slice(0, keep)}…${text.slice(-keep)}`;
}

/** Host of a URL, for the secondary line in the list. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function fileExtension(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(i + 1).toLowerCase() : "";
}

/**
 * Converts a human speed entry ("2 MB", "500k", "1.5") into bytes per second.
 * Returns null when it cannot be parsed, so the caller can keep the previous
 * value rather than silently setting an unlimited rate.
 */
export function parseSpeed(input: string): number | null {
  const t = input.trim().toLowerCase().replace(/\/s$/, "").trim();
  if (t === "" || t === "0") return 0;
  const m = /^([\d.]+)\s*(k|kb|m|mb|g|gb|b)?$/.exec(t);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const mult =
    m[2] === "k" || m[2] === "kb"
      ? 1000
      : m[2] === "m" || m[2] === "mb"
        ? 1000 * 1000
        : m[2] === "g" || m[2] === "gb"
          ? 1000 * 1000 * 1000
          : 1;
  return Math.round(value * mult);
}
