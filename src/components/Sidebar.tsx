/**
 * Left navigation: status buckets, file-type categories, and scheduler state.
 *
 * Collapsible to an icon rail, because on a laptop the download table is the
 * thing that needs the pixels. The scheduler panel lives down here rather than
 * inside Settings because "why is nothing downloading?" is the question it
 * exists to answer, and the answer should not require opening a dialog.
 */

import clsx from "clsx";
import {
  AlertCircle,
  Archive,
  CalendarClock,
  CheckCircle2,
  Clapperboard,
  Clock,
  FileText,
  Gauge,
  Image,
  Layers,
  Loader,
  MonitorCog,
  MoonStar,
  Music,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { fileKind } from "../lib/filetypes";
import { formatSpeed, formatUntil } from "../lib/format";
import type { FileKind } from "../lib/filetypes";
import type { ViewFilter } from "../lib/types";
import { useApp } from "../store/app";
import { Badge } from "./ui";

const STORAGE_KEY = "downpour.sidebar.collapsed";

type Group = FileKind["group"];

const CATEGORIES: { group: Group; label: string; icon: ReactNode; colour: string }[] = [
  { group: "video", label: "Video", icon: <Clapperboard size={14} />, colour: "#8b5cf6" },
  { group: "audio", label: "Music", icon: <Music size={14} />, colour: "#ec4899" },
  { group: "image", label: "Pictures", icon: <Image size={14} />, colour: "#f59e0b" },
  { group: "document", label: "Documents", icon: <FileText size={14} />, colour: "#3b82f6" },
  { group: "archive", label: "Compressed", icon: <Archive size={14} />, colour: "#eab308" },
  { group: "program", label: "Programs", icon: <MonitorCog size={14} />, colour: "#0ea5e9" },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // Not worth surfacing.
    }
  }, [collapsed]);

  const filter = useApp((s) => s.filter);
  const setFilter = useApp((s) => s.setFilter);
  const category = useApp((s) => s.category);
  const setCategory = useApp((s) => s.setCategory);
  const stats = useApp((s) => s.stats);
  const items = useApp((s) => s.items);
  const settings = useApp((s) => s.settings);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);

  const buckets: { id: ViewFilter; label: string; icon: ReactNode; count: number; tone?: string }[] =
    [
      { id: "all", label: "All downloads", icon: <Layers size={15} />, count: stats?.total ?? 0 },
      {
        id: "active",
        label: "Downloading",
        icon: <Loader size={15} />,
        count: stats?.running ?? 0,
        tone: "var(--status-running)",
      },
      {
        id: "waiting",
        label: "Waiting",
        icon: <Clock size={15} />,
        count:
          (stats?.queued ?? 0) + (stats?.scheduled ?? 0) + (stats?.paused ?? 0) + (stats?.idle ?? 0),
        tone: "var(--status-paused)",
      },
      {
        id: "completed",
        label: "Completed",
        icon: <CheckCircle2 size={15} />,
        count: stats?.completed ?? 0,
        tone: "var(--status-complete)",
      },
      {
        id: "failed",
        label: "Failed",
        icon: <AlertCircle size={15} />,
        count: stats?.failed ?? 0,
        tone: "var(--status-failed)",
      },
    ];

  // Counted from the live items rather than from stats: the engine groups by
  // its own category table, while the sidebar groups by the icon system, and
  // two different answers to "how many videos" would be worse than one.
  const categoryCounts = new Map<Group, number>();
  for (const item of Object.values(items)) {
    if (item.status === "cancelled") continue;
    const g = fileKind(item.filename).group;
    categoryCounts.set(g, (categoryCounts.get(g) ?? 0) + 1);
  }

  return (
    <nav
      className="dp-panel flex shrink-0 flex-col border-t-0 border-b-0 border-l-0 py-2"
      style={{
        width: collapsed ? 52 : 212,
        transition: "width 220ms var(--ease-out-expo)",
      }}
    >
      <div className="px-2">
        {buckets.map((b) => (
          <Entry
            key={b.id}
            collapsed={collapsed}
            active={filter === b.id && category === null}
            icon={b.icon}
            tone={b.tone}
            label={b.label}
            count={b.count}
            onClick={() => {
              setCategory(null);
              setFilter(b.id);
            }}
          />
        ))}
      </div>

      <div className="mt-3 px-2">
        {!collapsed && (
          <div className="mb-1 px-2.5 text-[10px] font-semibold tracking-wide text-[var(--text-tertiary)] uppercase">
            Categories
          </div>
        )}
        {collapsed && <div className="mx-2 mb-2 h-px bg-[var(--border-subtle)]" />}
        {CATEGORIES.map((c) => (
          <Entry
            key={c.group}
            collapsed={collapsed}
            active={category === c.group}
            icon={c.icon}
            tone={c.colour}
            label={c.label}
            count={categoryCounts.get(c.group) ?? 0}
            dim={(categoryCounts.get(c.group) ?? 0) === 0}
            onClick={() => {
              setFilter("all");
              setCategory(category === c.group ? null : c.group);
            }}
          />
        ))}
      </div>

      <div className="mt-auto space-y-1.5 px-2 pt-3">
        <SchedulerCard collapsed={collapsed} />

        {settings && settings.speedLimitBps > 0 && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title={`Speed limit ${formatSpeed(settings.speedLimitBps)}`}
            className="flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
          >
            <Gauge size={14} className="shrink-0 text-[var(--status-paused)]" />
            {!collapsed && (
              <div className="min-w-0 flex-1">
                <div className="text-[10px] text-[var(--text-tertiary)]">Speed limit</div>
                <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                  {formatSpeed(settings.speedLimitBps)}
                </div>
              </div>
            )}
          </button>
        )}

        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          {!collapsed && <span className="text-[12px]">Collapse</span>}
        </button>
      </div>
    </nav>
  );
}

function Entry({
  collapsed,
  active,
  icon,
  tone,
  label,
  count,
  dim,
  onClick,
}: {
  collapsed: boolean;
  active: boolean;
  icon: ReactNode;
  tone?: string;
  label: string;
  count: number;
  dim?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // The title is the only label when collapsed, so it is always present
      // rather than only when the text is hidden.
      title={count > 0 ? `${label} (${count})` : label}
      className={clsx(
        "mb-0.5 flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-1.5",
        "text-left text-[12.5px] transition-colors duration-150",
        active
          ? "bg-[var(--surface-selected)] font-medium text-[var(--text-primary)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
        dim && !active && "opacity-45",
      )}
    >
      <span
        className="shrink-0"
        style={{ color: active ? "var(--accent)" : tone ?? "var(--text-tertiary)" }}
      >
        {icon}
      </span>
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{label}</span>
          {count > 0 && <Badge tone={active ? "accent" : "neutral"}>{count}</Badge>}
        </>
      )}
    </button>
  );
}

/**
 * Scheduler status, in three distinct states.
 *
 * Conflating "off", "armed and open" and "armed and waiting" is what makes a
 * scheduler feel broken, so each gets its own colour and its own sentence.
 */
function SchedulerCard({ collapsed }: { collapsed: boolean }) {
  const stats = useApp((s) => s.stats);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);

  const armed = stats?.windowOpen !== null && stats?.windowOpen !== undefined;

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        title="Scheduler is off — click to set up a download window"
        className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-left text-[11px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
      >
        <CalendarClock size={15} className="shrink-0" />
        {!collapsed && <span>Scheduler off</span>}
      </button>
    );
  }

  const open = stats.windowOpen === true;
  const colour = open ? "var(--status-complete)" : "var(--status-scheduled)";
  const summary = open
    ? "Scheduled downloads are running now."
    : stats.minutesUntilWindow !== null
      ? `${stats.scheduled} waiting, next window ${formatUntil(stats.minutesUntilWindow)}.`
      : "Armed, but no window will open.";

  return (
    <button
      type="button"
      onClick={() => setSettingsOpen(true)}
      title={summary}
      className="w-full rounded-[var(--radius-card)] border px-2.5 py-2 text-left transition-colors"
      style={{
        borderColor: `color-mix(in srgb, ${colour} 30%, transparent)`,
        background: `color-mix(in srgb, ${colour} 8%, transparent)`,
      }}
    >
      <div className="flex items-center gap-1.5">
        <MoonStar size={13} className="shrink-0" style={{ color: colour }} />
        {!collapsed && (
          <span className="text-[11px] font-semibold" style={{ color: colour }}>
            {open ? "Window open" : "Scheduled"}
          </span>
        )}
      </div>
      {!collapsed && (
        <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-secondary)]">{summary}</p>
      )}
    </button>
  );
}
