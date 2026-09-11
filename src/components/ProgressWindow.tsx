/**
 * The compact progress panel.
 *
 * Rendered into a second Tauri window at `?view=progress`. It shares this
 * app's store and event stream rather than being a second frontend, so it is
 * live for free and can never disagree with the main window.
 *
 * Designed to be glanced at, not worked in: one download at a time, big
 * numbers, and only the controls you would reach for without switching
 * windows. Everything else is a click away in the main window.
 *
 * Two things it deliberately does not do. It is **not pinned above other
 * windows by default** — a panel that forces itself to the front is the kind of
 * thing people close once and never reopen, so the pin is opt-in. And closing
 * it **never touches the downloads**: they live in the engine, which knows
 * nothing about windows, and the app itself carries on in the tray.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import clsx from "clsx";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Pause,
  Pin,
  PinOff,
  Play,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { FileTile, fileKind } from "../lib/filetypes";
import { formatBytes, formatDuration, formatSpeed } from "../lib/format";
import { useApp } from "../store/app";
import { useTheme } from "../hooks/useTheme";
import { canPause, canStart } from "../lib/types";

export function ProgressWindow() {
  useTheme();

  const bootstrap = useApp((s) => s.bootstrap);
  const applyEvent = useApp((s) => s.applyEvent);
  const items = useApp((s) => s.items);
  const order = useApp((s) => s.order);
  const settings = useApp((s) => s.settings);
  const run = useApp((s) => s.run);
  const [index, setIndex] = useState(0);

  // Pinning is per-machine window behaviour, not a download preference, so it
  // lives in localStorage rather than round-tripping through the engine.
  const [pinned, setPinned] = useState(() => {
    try {
      return localStorage.getItem("downpour.progress.pinned") === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    void getCurrentWindow().setAlwaysOnTop(pinned);
    try {
      localStorage.setItem("downpour.progress.pinned", pinned ? "1" : "0");
    } catch {
      // Not worth surfacing.
    }
  }, [pinned]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void api.onEngineEvent(applyEvent).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyEvent]);

  // Active first, then anything still waiting, so the panel always has
  // something meaningful to show right up until the queue is empty.
  const shown = useMemo(() => {
    const rank: Record<string, number> = {
      running: 0,
      probing: 1,
      queued: 2,
      scheduled: 3,
      paused: 4,
    };
    return order
      .map((id) => items[id])
      .filter((i) => i && i.status in rank)
      .sort((a, b) => rank[a.status] - rank[b.status] || a.sequence - b.sequence);
  }, [items, order]);

  const current = shown[Math.min(index, Math.max(0, shown.length - 1))];

  // Close automatically once nothing is left, rather than leaving an empty
  // panel floating over everything the user does next.
  useEffect(() => {
    if (shown.length > 0) return;
    const timer = window.setTimeout(() => void getCurrentWindow().close(), 2500);
    return () => window.clearTimeout(timer);
  }, [shown.length]);

  if (!current) {
    return (
      <Shell>
        <div className="grid h-full place-items-center text-[12px] text-[var(--text-tertiary)]">
          Nothing downloading.
        </div>
      </Shell>
    );
  }

  const progress = current.totalBytes
    ? Math.min(1, current.downloadedBytes / current.totalBytes)
    : 0;
  const colour = fileKind(current.filename).colour;

  return (
    <Shell>
      <div className="flex h-full flex-col gap-2.5 p-3">
        <div className="flex items-center gap-2.5">
          <FileTile filename={current.filename} size={34} active />
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-[12.5px] font-medium text-[var(--text-primary)]"
              title={current.filename}
            >
              {current.filename}
            </div>
            <div className="truncate text-[10.5px] text-[var(--text-tertiary)]">
              {current.status === "running"
                ? `${current.connections} connection${current.connections === 1 ? "" : "s"}`
                : statusLabel(current.status)}
              {" · "}
              {current.destDir}
            </div>
          </div>
          <button
            type="button"
            aria-label={pinned ? "Unpin from the top" : "Keep on top of other windows"}
            title={pinned ? "Unpin" : "Keep on top"}
            onClick={() => setPinned((v) => !v)}
            className="grid size-6 shrink-0 place-items-center rounded-[6px] transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: pinned ? "var(--accent)" : "var(--text-tertiary)" }}
          >
            {pinned ? <Pin size={13} /> : <PinOff size={13} />}
          </button>
          <button
            type="button"
            aria-label="Close this panel"
            // Worth spelling out: people assume closing a progress window
            // cancels the thing it was showing.
            title="Close this panel — your downloads keep going"
            onClick={() => void getCurrentWindow().close()}
            className="grid size-6 shrink-0 place-items-center rounded-[6px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X size={14} />
          </button>
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-[22px] leading-none font-semibold tabular-nums text-[var(--text-primary)]">
              {current.totalBytes ? `${Math.floor(progress * 100)}%` : formatBytes(current.downloadedBytes)}
            </span>
            <span className="text-[11px] tabular-nums text-[var(--text-secondary)]">
              {formatBytes(current.downloadedBytes)}
              {current.totalBytes ? ` of ${formatBytes(current.totalBytes)}` : ""}
            </span>
          </div>

          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
            {current.totalBytes ? (
              <div
                className="h-full rounded-full transition-[width] duration-500 ease-linear"
                style={{
                  width: `${progress * 100}%`,
                  background: `linear-gradient(90deg, ${colour}, var(--color-accent-to))`,
                }}
              />
            ) : (
              <div
                className="h-full w-1/4 rounded-full"
                style={{
                  background: colour,
                  animation: "dp-indeterminate 1.4s ease-in-out infinite",
                }}
              />
            )}
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-1 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-2 py-1.5 text-center">
          <Stat label="Speed" value={current.speedBps > 0 ? formatSpeed(current.speedBps) : "—"} />
          <Stat
            label="Time left"
            value={current.etaSecs !== null ? formatDuration(current.etaSecs) : "—"}
          />
          <Stat label="Queue" value={`${shown.length}`} />
        </dl>

        <div className="mt-auto flex items-center gap-1.5">
          {shown.length > 1 && (
            <>
              <Ghost
                label="Previous"
                disabled={index === 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
              >
                <ChevronLeft size={14} />
              </Ghost>
              <span className="text-[10.5px] tabular-nums text-[var(--text-tertiary)]">
                {Math.min(index, shown.length - 1) + 1}/{shown.length}
              </span>
              <Ghost
                label="Next"
                disabled={index >= shown.length - 1}
                onClick={() => setIndex((i) => Math.min(shown.length - 1, i + 1))}
              >
                <ChevronRight size={14} />
              </Ghost>
            </>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {canPause(current.status) && (
              <Action
                onClick={() => void run("Could not pause", () => api.pauseDownload(current.id))}
                icon={<Pause size={13} />}
              >
                Pause
              </Action>
            )}
            {canStart(current.status) && (
              <Action
                onClick={() => void run("Could not start", () => api.startDownload(current.id))}
                icon={<Play size={13} />}
              >
                Resume
              </Action>
            )}
            <Action
              onClick={() => void run("Could not open Downpour", api.showMainWindow)}
              icon={<ExternalLink size={13} />}
            >
              Details
            </Action>
          </div>
        </div>

        {settings && (
          <label
            className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-tertiary)]"
            title="Downloads continue either way; this only hides the panel."
          >
            <input
              type="checkbox"
              className="size-3 accent-[var(--accent)]"
              checked={!settings.progressWindow}
              onChange={(e) =>
                void useApp
                  .getState()
                  .saveSettings({ ...settings, progressWindow: !e.target.checked })
              }
            />
            Do not show this panel again
          </label>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="h-full bg-[var(--surface-raised)]">{children}</div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[9px] tracking-wide text-[var(--text-tertiary)] uppercase">{label}</dt>
      <dd className="text-[11.5px] font-medium tabular-nums text-[var(--text-primary)]">{value}</dd>
    </div>
  );
}

function Ghost({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-6 place-items-center rounded-[6px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  );
}

function Action({
  onClick,
  icon,
  children,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5",
        "border border-[var(--border-strong)] bg-[var(--surface-raised)]",
        "text-[11.5px] font-medium text-[var(--text-primary)]",
        "transition-colors hover:bg-[var(--surface-hover)]",
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "probing":
      return "Connecting";
    case "queued":
      return "Waiting for a free slot";
    case "scheduled":
      return "Waiting for its window";
    case "paused":
      return "Paused";
    default:
      return status;
  }
}
