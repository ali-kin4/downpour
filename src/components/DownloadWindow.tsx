/**
 * A progress box for one download.
 *
 * Rendered into its own Tauri window at `?view=download&id=...`, opened from
 * the tray's Downloads submenu. The compact panel next door is queue-shaped --
 * one window that pages through whatever is moving; this is the other half of
 * IDM's behaviour, where you pick a download and get a box for that download,
 * and you can have several of them open at once.
 *
 * It keeps its **own** copy of the one item rather than joining the shared
 * store. That is not squeamishness about globals: the store's reducer plays the
 * completion chime and arms the completion dialog, so three open boxes would
 * mean three chimes for one finished file. Reading one download and reducing
 * the events that name it is also simply less code than filtering a whole
 * queue down to one row.
 *
 * Two behaviours worth stating, because both are choices:
 *
 * - **It stays when the download ends**, showing "Done" or the error. The box
 *   was opened for one specific download, so the outcome *is* the thing it was
 *   opened to see; vanishing at the moment of the answer would leave the user
 *   unsure whether it finished or they mis-clicked, and on a failure it would
 *   hide the error outright. The queue panel and the capture prompt close
 *   themselves because they are scoped to a queue that has genuinely emptied.
 *   This one is scoped to an item, and the item still has something to say.
 * - **Closing it never touches the download.** It lives in the engine, which
 *   knows nothing about windows. Closing every box changes nothing at all.
 *
 * The one case it does close itself is the download being *removed* from the
 * list, which is the only way its subject can stop existing.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { ExternalLink, FolderOpen, Pause, Play, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { FileTile } from "../lib/filetypes";
import { formatBytes, formatDuration, formatSpeed } from "../lib/format";
import { useTheme } from "../hooks/useTheme";
import { canPause, canStart, type DownloadItem, type DownloadStatus } from "../lib/types";
import { useApp } from "../store/app";
import { filePath } from "./CompletionDialog";
import { Button } from "./ui";

/** How long an empty box lingers before it goes, matching the queue panel. */
const CLOSE_DELAY_MS = 2500;

export function DownloadWindow({ id }: { id: string }) {
  useTheme();

  const [item, setItem] = useState<DownloadItem | null>(null);
  const [gone, setGone] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Only the theme is wanted from the store, and only once. Calling `bootstrap`
  // instead would pull the whole queue in for a window that shows one row.
  useEffect(() => {
    void useApp.getState().refreshSettings();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api
      .getDownload(id)
      .then((found) => {
        if (cancelled) return;
        if (found) setItem(found);
        else setGone(true);
      })
      .catch(() => {
        if (!cancelled) setGone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void api
      .onEngineEvent((event) => {
        switch (event.kind) {
          case "progress":
            if (event.id !== id) break;
            setItem((prev) =>
              prev
                ? {
                    ...prev,
                    downloadedBytes: event.downloadedBytes,
                    totalBytes: event.totalBytes ?? prev.totalBytes,
                    speedBps: event.speedBps,
                    etaSecs: event.etaSecs,
                    connections: event.connections,
                  }
                : prev,
            );
            break;
          case "statusChanged":
            if (event.id !== id) break;
            setItem((prev) =>
              prev ? { ...prev, status: event.status, error: event.error } : prev,
            );
            break;
          case "completed":
            if (event.id !== id) break;
            // The engine sends the finished item, and it is the only thing
            // that knows the final byte count and duration; patching our own
            // copy would report a 148 MB file as having taken no time at all.
            setItem({ ...event.item, status: "completed", speedBps: 0, etaSecs: null });
            break;
          case "failed":
            if (event.id !== id) break;
            setItem((prev) =>
              prev ? { ...prev, status: "failed", error: event.error, speedBps: 0 } : prev,
            );
            break;
          case "removed":
            if (event.id === id) setGone(true);
            break;
          case "resync":
            // Events were dropped. One round trip is cheaper than showing a
            // number that stopped being true some seconds ago.
            void api.getDownload(id).then((found) => {
              if (found) setItem(found);
              else setGone(true);
            });
            break;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [id]);

  // Nothing left to watch, and no way for it to come back.
  useEffect(() => {
    if (!gone) return;
    const timer = window.setTimeout(() => void getCurrentWindow().close(), CLOSE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [gone]);

  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      // There is no toast host in this window, so the failure goes where the
      // user is already looking: the line under the filename.
      setActionError(`${label}: ${api.errorMessage(e)}`);
    }
  }, []);

  if (gone || !item) {
    return (
      <Shell>
        <div className="grid h-full place-items-center px-4 text-center text-[11.5px] text-[var(--text-tertiary)]">
          {gone ? "That download is no longer in the list." : "Loading…"}
        </div>
      </Shell>
    );
  }

  const progress = item.totalBytes
    ? Math.min(1, item.downloadedBytes / item.totalBytes)
    : 0;
  const path = filePath(item);

  return (
    <Shell>
      <div className="flex h-full flex-col gap-2 p-2.5">
        <div className="flex items-center gap-2">
          <FileTile filename={item.filename} size={28} active={item.status === "running"} />
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-[12px] font-medium text-[var(--text-primary)]"
              title={item.filename}
            >
              {item.filename}
            </div>
            <div
              className="truncate text-[10.5px]"
              style={{
                color:
                  actionError || item.error
                    ? "var(--status-failed)"
                    : "var(--text-tertiary)",
              }}
              title={actionError ?? item.error ?? item.destDir}
            >
              {actionError ?? item.error ?? item.destDir}
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Close this box"
            // Worth spelling out: people assume closing a progress window
            // cancels the thing it was showing.
            title="Close this box — the download keeps going"
            onClick={() => void getCurrentWindow().close()}
          >
            <X size={14} />
          </Button>
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[17px] leading-none font-semibold tabular-nums text-[var(--text-primary)]">
              {item.totalBytes
                ? `${Math.floor(progress * 100)}%`
                : formatBytes(item.downloadedBytes)}
            </span>
            <span className="truncate text-[10.5px] tabular-nums text-[var(--text-secondary)]">
              {formatBytes(item.downloadedBytes)}
              {item.totalBytes ? ` of ${formatBytes(item.totalBytes)}` : ""}
            </span>
          </div>

          {/*
            The shuttling bar is reserved for a transfer that is genuinely
            moving with an unknown size. A download that has failed with no
            Content-Length is not making progress, and animating its bar makes
            a dead transfer look alive -- it gets the empty track, and the
            error above it says the rest.
          */}
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
            {item.totalBytes || item.status === "completed" ? (
              <div
                className="h-full rounded-full transition-[width] duration-500 ease-linear"
                style={{
                  width: `${item.status === "completed" ? 100 : progress * 100}%`,
                  background: statusColour(item.status),
                }}
              />
            ) : item.status === "running" || item.status === "probing" ? (
              <div
                className="h-full w-1/4 rounded-full"
                style={{
                  background: statusColour(item.status),
                  animation: "dp-indeterminate 1.4s ease-in-out infinite",
                }}
              />
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[10.5px] tabular-nums text-[var(--text-tertiary)]">
            {summary(item)}
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {item.status === "completed" ? (
              <Button
                size="sm"
                icon={<ExternalLink size={13} />}
                onClick={() => void act("Could not open the file", () => api.openPath(path))}
              >
                Open
              </Button>
            ) : canPause(item.status) ? (
              <Button
                size="sm"
                icon={<Pause size={13} />}
                onClick={() => void act("Could not pause", () => api.pauseDownload(item.id))}
              >
                Pause
              </Button>
            ) : canStart(item.status) ? (
              <Button
                size="sm"
                icon={
                  item.status === "failed" ? <RotateCcw size={13} /> : <Play size={13} />
                }
                onClick={() => void act("Could not start", () => api.startDownload(item.id))}
              >
                {item.status === "failed" ? "Retry" : "Resume"}
              </Button>
            ) : null}

            <Button
              size="sm"
              aria-label="Show in folder"
              title="Show in folder"
              onClick={() => void act("Could not open the folder", () => api.revealPath(path))}
            >
              <FolderOpen size={13} />
            </Button>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="h-screen bg-[var(--surface-raised)]">{children}</div>;
}

/**
 * The line under the bar. Speed and time left while it is moving, and the
 * reason it is not otherwise -- a box that showed "— · —" for a paused
 * download would be telling the user nothing they could act on.
 */
function summary(item: DownloadItem): string {
  if (item.status === "running") {
    const speed = item.speedBps > 0 ? formatSpeed(item.speedBps) : "—";
    const eta = item.etaSecs !== null ? `${formatDuration(item.etaSecs)} left` : "";
    const conns = `${item.connections} connection${item.connections === 1 ? "" : "s"}`;
    return [speed, eta, conns].filter(Boolean).join(" · ");
  }
  switch (item.status) {
    case "probing":
      return "Connecting";
    case "queued":
      return "Waiting for a free slot";
    case "scheduled":
      return "Waiting for its window";
    case "paused":
      return "Paused";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Not started";
  }
}

function statusColour(status: DownloadStatus): string {
  switch (status) {
    case "completed":
      return "var(--status-complete)";
    case "failed":
    case "cancelled":
      return "var(--status-failed)";
    case "paused":
      return "var(--status-paused)";
    case "scheduled":
      return "var(--status-scheduled)";
    case "queued":
    case "idle":
      return "var(--status-idle)";
    default:
      return "var(--status-running)";
  }
}
