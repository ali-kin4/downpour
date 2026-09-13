/**
 * One row of the download table, plus its right-click menu.
 *
 * Subscribes to a single item, so a progress event for one download re-renders
 * only this component rather than the whole list.
 */

import clsx from "clsx";
import {
  AlertCircle,
  ArrowUpToLine,
  CalendarClock,
  Check,
  ChevronsDown,
  Clock,
  Copy,
  Folder,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as api from "../lib/api";
import { FileTile } from "../lib/filetypes";
import {
  formatBytes,
  formatDuration,
  formatRelative,
  formatSpeed,
  formatStamp,
  hostOf,
} from "../lib/format";
import type { DownloadItem, DownloadStatus } from "../lib/types";
import { canPause, canStart } from "../lib/types";
import { useApp, useItem } from "../store/app";
import {
  COLUMN_GAP,
  gridTemplate,
  useColumns,
  type ColumnId,
} from "../store/columns";

export function DownloadRow({ id }: { id: string }) {
  const item = useItem(id);
  const widths = useColumns((s) => s.widths);
  const hidden = useColumns((s) => s.hidden);
  const show = (id: ColumnId) => !hidden.includes(id);
  const selected = useApp((s) => s.selection.has(id));
  const select = useApp((s) => s.select);
  const run = useApp((s) => s.run);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

  if (!item) return null;

  const progress = item.totalBytes
    ? Math.min(1, item.downloadedBytes / item.totalBytes)
    : 0;

  return (
    <>
      <div
        role="row"
        tabIndex={0}
        aria-selected={selected}
        onClick={(e) =>
          select(id, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : "replace")
        }
        onDoubleClick={() => {
          // Double-click opens a finished file, which is what every file
          // manager does; on an unfinished one it toggles run/pause.
          if (item.status === "completed") {
            void run("Could not open the file", () => api.openPath(fullPath(item)));
          } else if (canStart(item.status)) {
            void run("Could not start", () => api.startDownload(id));
          } else if (canPause(item.status)) {
            void run("Could not pause", () => api.pauseDownload(id));
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!selected) select(id, "replace");
          setMenuAt({ x: e.clientX, y: e.clientY });
        }}
        className={clsx(
          "grid h-14 cursor-default items-center border-b border-[var(--border-subtle)] px-3",
          "transition-colors duration-100",
          // Opaque, never translucent: Mica behind a dense data grid destroys
          // legibility. Translucency is reserved for the chrome around it.
          selected
            ? "bg-[var(--surface-selected)]"
            : "bg-[var(--surface-raised)] hover:bg-[var(--surface-hover)]",
        )}
        style={{
          gridTemplateColumns: gridTemplate(widths, hidden),
          columnGap: COLUMN_GAP,
        }}
      >
        <input
          type="checkbox"
          aria-label={`Select ${item.filename}`}
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onChange={() => select(id, "toggle")}
          className="size-3.5 accent-[var(--accent)]"
        />

        {/* Name */}
        <div className="flex min-w-0 items-center gap-2.5">
          <FileTile filename={item.filename} active={item.status === "running"} />
          <div className="min-w-0">
            <div className="truncate text-[12.5px] font-medium text-[var(--text-primary)]">
              {item.filename}
            </div>
            <div className="flex items-center gap-1.5 truncate text-[11px] text-[var(--text-tertiary)]">
              <span className="truncate">{hostOf(item.url)}</span>
              {item.source === "extension" && <Dot />}
              {item.source === "extension" && <span>browser</span>}
              {item.scheduled && (
                <>
                  <Dot />
                  <CalendarClock size={10} />
                </>
              )}
            </div>
          </div>
        </div>

        {/* Size */}
        {show("size") && (
          <div className="text-right text-[12px] tabular-nums text-[var(--text-secondary)]">
            {formatBytes(item.totalBytes)}
          </div>
        )}

        {/* Progress */}
        {show("progress") && (
        <div>
          <ProgressBar
            value={progress}
            status={item.status}
            indeterminate={item.status === "probing" || (item.status === "running" && !item.totalBytes)}
          />
          <div className="mt-1 flex justify-between text-[10.5px] tabular-nums text-[var(--text-tertiary)]">
            <span>
              {item.totalBytes
                ? `${(progress * 100).toFixed(progress >= 0.1 ? 0 : 1)}%`
                : formatBytes(item.downloadedBytes)}
            </span>
            {item.connections > 1 && item.status === "running" && (
              <span title={`${item.connections} parallel connections`}>
                ×{item.connections}
              </span>
            )}
          </div>
        </div>
        )}

        {/* Speed */}
        {show("speed") && (
          <div className="text-right text-[12px] tabular-nums text-[var(--text-secondary)]">
            {item.status === "running" && item.speedBps > 0
              ? formatSpeed(item.speedBps)
              : "—"}
          </div>
        )}

        {/* Time left */}
        {show("left") && (
          <div className="text-right text-[12px] tabular-nums text-[var(--text-tertiary)]">
            {item.status === "running" && item.etaSecs !== null
              ? formatDuration(item.etaSecs)
              : item.status === "completed"
                ? formatRelative(item.completedAt)
                : "—"}
          </div>
        )}

        {/* Status */}
        {show("status") && <StatusPill item={item} />}

        {/* When the link was added. Absolute, because this column is scanned
            down and compared row to row, not read as a sentence. */}
        {show("added") && (
          <div
            className="truncate text-[12px] tabular-nums text-[var(--text-secondary)]"
            title={new Date(item.createdAt * 1000).toLocaleString()}
          >
            {formatStamp(item.createdAt)}
          </div>
        )}

        {show("completed") && (
          <div
            className="truncate text-[12px] tabular-nums text-[var(--text-tertiary)]"
            title={
              item.completedAt
                ? new Date(item.completedAt * 1000).toLocaleString()
                : undefined
            }
          >
            {formatStamp(item.completedAt)}
          </div>
        )}

        {show("source") && (
          <div className="truncate text-[12px] text-[var(--text-tertiary)]" title={item.url}>
            {item.source === "extension" ? "Browser" : hostOf(item.url)}
          </div>
        )}

        {/* Inline actions */}
        <div className="flex items-center justify-end gap-0.5">
          {canStart(item.status) && (
            <IconAction
              label="Start"
              onClick={() => void run("Could not start", () => api.startDownload(id))}
            >
              <Play size={14} />
            </IconAction>
          )}
          {canPause(item.status) && (
            <IconAction
              label="Pause"
              onClick={() => void run("Could not pause", () => api.pauseDownload(id))}
            >
              <Pause size={14} />
            </IconAction>
          )}
          {item.status === "completed" && (
            <IconAction
              label="Show in folder"
              onClick={() => void run("Could not open folder", () => api.revealPath(fullPath(item)))}
            >
              <Folder size={14} />
            </IconAction>
          )}
          <IconAction
            label="More actions"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenuAt({ x: r.right, y: r.bottom });
            }}
          >
            <MoreHorizontal size={14} />
          </IconAction>
        </div>
      </div>

      {menuAt && (
        <RowMenu item={item} at={menuAt} onClose={() => setMenuAt(null)} />
      )}
    </>
  );
}

function Dot() {
  return <span className="text-[var(--text-tertiary)]">·</span>;
}

function fullPath(item: DownloadItem): string {
  // The backend stores the directory and filename separately; the shell
  // commands want one path. Windows tolerates a forward slash here, so a naive
  // join is safe on every platform we target.
  const dir = item.destDir.replace(/[\\/]+$/, "");
  return `${dir}\\${item.filename}`;
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className="grid size-7 place-items-center rounded-[6px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
    >
      {children}
    </button>
  );
}

function ProgressBar({
  value,
  status,
  indeterminate,
}: {
  value: number;
  status: DownloadStatus;
  indeterminate: boolean;
}) {
  const colour =
    status === "failed"
      ? "var(--status-failed)"
      : status === "completed"
        ? "var(--status-complete)"
        : status === "paused"
          ? "var(--status-paused)"
          : "var(--status-running)";

  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-sunken)]">
      {indeterminate ? (
        // Unknown total: show motion rather than a bar frozen at 0%, which
        // reads as "stuck" when the download is running fine.
        <div
          className="h-full w-1/4 rounded-full"
          style={{
            background: colour,
            animation: "dp-indeterminate 1.4s ease-in-out infinite",
          }}
        />
      ) : (
        <div
          className="dp-progress-fill h-full rounded-full"
          style={{ width: `${value * 100}%`, background: colour }}
        />
      )}
    </div>
  );
}

const STATUS_META: Record<
  DownloadStatus,
  { label: string; colour: string; icon?: ReactNode }
> = {
  idle: { label: "Not started", colour: "var(--status-idle)", icon: <Clock size={11} /> },
  queued: { label: "Queued", colour: "var(--status-idle)", icon: <Clock size={11} /> },
  scheduled: {
    label: "Scheduled",
    colour: "var(--status-scheduled)",
    icon: <CalendarClock size={11} />,
  },
  probing: { label: "Connecting", colour: "var(--status-running)" },
  running: { label: "Downloading", colour: "var(--status-running)" },
  paused: { label: "Paused", colour: "var(--status-paused)", icon: <Pause size={11} /> },
  completed: {
    label: "Complete",
    colour: "var(--status-complete)",
    icon: <Check size={11} />,
  },
  failed: { label: "Failed", colour: "var(--status-failed)", icon: <AlertCircle size={11} /> },
  cancelled: { label: "Cancelled", colour: "var(--status-idle)", icon: <X size={11} /> },
};

function StatusPill({ item }: { item: DownloadItem }) {
  const meta = STATUS_META[item.status];
  return (
    <div
      className="flex items-center gap-1 truncate text-[11px] font-medium"
      style={{ color: meta.colour }}
      // The full error is often long; the pill shows the label and the tooltip
      // carries the detail rather than wrapping the row to three lines.
      title={item.error ?? meta.label}
    >
      {meta.icon}
      <span className="truncate">{item.error ? "Failed" : meta.label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function RowMenu({
  item,
  at,
  onClose,
}: {
  item: DownloadItem;
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const run = useApp((s) => s.run);
  const toast = useApp((s) => s.toast);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);

  // Flip the menu back inside the window when opened near an edge.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: at.x + r.width > window.innerWidth ? Math.max(4, at.x - r.width) : at.x,
      y: at.y + r.height > window.innerHeight ? Math.max(4, at.y - r.height) : at.y,
    });
  }, [at.x, at.y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const go = (label: string, fn: () => Promise<unknown>) => () => {
    void run(label, fn);
    onClose();
  };

  const path = fullPath(item);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      className="dp-enter fixed z-50 min-w-[214px] overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] py-1 shadow-[var(--shadow-overlay)]"
    >
      {item.status === "completed" && (
        <>
          <Entry icon={<Play size={14} />} onClick={go("Could not open", () => api.openPath(path))}>
            Open file
          </Entry>
          <Entry
            icon={<Folder size={14} />}
            onClick={go("Could not open folder", () => api.revealPath(path))}
          >
            Show in folder
          </Entry>
          <Divider />
        </>
      )}

      {canStart(item.status) && (
        <Entry icon={<Play size={14} />} onClick={go("Could not start", () => api.startDownload(item.id))}>
          {item.status === "failed" ? "Retry" : "Start"}
        </Entry>
      )}
      {canPause(item.status) && (
        <Entry icon={<Pause size={14} />} onClick={go("Could not pause", () => api.pauseDownload(item.id))}>
          Pause
        </Entry>
      )}
      {item.status === "scheduled" && (
        <Entry
          icon={<Rocket size={14} />}
          onClick={go("Could not start", () => api.forceStartDownload(item.id))}
        >
          Download now anyway
        </Entry>
      )}
      {item.status === "failed" && (
        <Entry
          icon={<RefreshCw size={14} />}
          onClick={go("Could not retry", () => api.startDownload(item.id))}
        >
          Retry
        </Entry>
      )}

      <Divider />

      <Entry icon={<ArrowUpToLine size={14} />} onClick={go("Could not reorder", () => api.moveToTop(item.id))}>
        Move to top of queue
      </Entry>
      <Entry icon={<ChevronsDown size={14} />} onClick={go("Could not reorder", () => api.moveToBottom(item.id))}>
        Move to bottom
      </Entry>
      <Entry
        icon={<CalendarClock size={14} />}
        onClick={go("Could not change schedule", () =>
          api.setScheduled(item.id, !item.scheduled),
        )}
      >
        {item.scheduled ? "Remove from schedule" : "Add to schedule"}
      </Entry>

      <Divider />

      <Entry
        icon={<Copy size={14} />}
        onClick={() => {
          void writeText(item.url).then(
            () => toast({ tone: "success", title: "Link copied" }),
            () => toast({ tone: "error", title: "Could not copy the link" }),
          );
          onClose();
        }}
      >
        Copy source link
      </Entry>

      <Divider />

      <Entry
        icon={<X size={14} />}
        onClick={go("Could not remove", () => api.removeDownload(item.id, false))}
      >
        Remove from list
      </Entry>
      <Entry
        danger
        icon={<Trash2 size={14} />}
        onClick={go("Could not delete", () => api.removeDownload(item.id, true))}
      >
        Delete file from disk
      </Entry>
    </div>
  );
}

function Entry({
  icon,
  children,
  onClick,
  danger,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] transition-colors",
        danger
          ? "text-[var(--status-failed)] hover:bg-[var(--status-failed)]/10"
          : "text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
      )}
    >
      <span className="flex w-4 justify-center text-[var(--text-tertiary)]">{icon}</span>
      {children}
    </button>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-[var(--border-subtle)]" />;
}
