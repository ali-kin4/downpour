/**
 * Left navigation: filter buckets with live counts, plus the scheduler status.
 *
 * The scheduler panel sits here rather than being buried in Settings because
 * "why is nothing downloading?" is the question it exists to answer, and the
 * answer needs to be visible without opening a dialog.
 */

import clsx from "clsx";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Gauge,
  Layers,
  Loader,
  MoonStar,
} from "lucide-react";
import type { ReactNode } from "react";
import { formatSpeed, formatUntil } from "../lib/format";
import type { ViewFilter } from "../lib/types";
import { useApp } from "../store/app";
import { Badge } from "./ui";

export function Sidebar() {
  const filter = useApp((s) => s.filter);
  const setFilter = useApp((s) => s.setFilter);
  const stats = useApp((s) => s.stats);
  const settings = useApp((s) => s.settings);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);

  const buckets: {
    id: ViewFilter;
    label: string;
    icon: ReactNode;
    count: number;
    tone?: string;
  }[] = [
    {
      id: "all",
      label: "All downloads",
      icon: <Layers size={15} />,
      count: stats?.total ?? 0,
    },
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
      count: (stats?.queued ?? 0) + (stats?.scheduled ?? 0) + (stats?.paused ?? 0) + (stats?.idle ?? 0),
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

  return (
    <nav className="dp-panel flex w-[212px] shrink-0 flex-col border-t-0 border-b-0 border-l-0 py-2">
      <div className="px-2">
        {buckets.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setFilter(b.id)}
            className={clsx(
              "mb-0.5 flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-1.5",
              "text-left text-[12.5px] transition-colors duration-120",
              filter === b.id
                ? "bg-[var(--surface-selected)] font-medium text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
            )}
          >
            <span
              style={{ color: filter === b.id ? "var(--accent)" : b.tone }}
              className={clsx(filter !== b.id && !b.tone && "text-[var(--text-tertiary)]")}
            >
              {b.icon}
            </span>
            <span className="flex-1 truncate">{b.label}</span>
            {b.count > 0 && (
              <Badge tone={filter === b.id ? "accent" : "neutral"}>{b.count}</Badge>
            )}
          </button>
        ))}
      </div>

      <div className="mt-auto space-y-2 px-3 pt-3">
        <SchedulerCard />

        {settings && settings.speedLimitBps > 0 && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex w-full items-center gap-2 rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-hover)]"
          >
            <Gauge size={14} className="text-[var(--text-tertiary)]" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-[var(--text-tertiary)]">Speed limit</div>
              <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                {formatSpeed(settings.speedLimitBps)}
              </div>
            </div>
          </button>
        )}
      </div>
    </nav>
  );
}

/**
 * Scheduler status.
 *
 * Three distinct states, because conflating them is what makes a scheduler
 * feel broken: off entirely, armed and currently open, armed and waiting.
 */
function SchedulerCard() {
  const stats = useApp((s) => s.stats);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);

  const armed = stats?.windowOpen !== null && stats?.windowOpen !== undefined;
  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className="flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-[11px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)]"
      >
        <CalendarClock size={14} />
        <span>Scheduler off</span>
      </button>
    );
  }

  const open = stats.windowOpen === true;
  return (
    <button
      type="button"
      onClick={() => setSettingsOpen(true)}
      className={clsx(
        "w-full rounded-[var(--radius-card)] border px-2.5 py-2 text-left transition-colors",
        open
          ? "border-[var(--status-complete)]/30 bg-[var(--status-complete)]/8 hover:bg-[var(--status-complete)]/12"
          : "border-[var(--status-scheduled)]/30 bg-[var(--status-scheduled)]/8 hover:bg-[var(--status-scheduled)]/12",
      )}
    >
      <div className="flex items-center gap-1.5">
        <MoonStar
          size={13}
          style={{
            color: open ? "var(--status-complete)" : "var(--status-scheduled)",
          }}
        />
        <span
          className="text-[11px] font-semibold"
          style={{ color: open ? "var(--status-complete)" : "var(--status-scheduled)" }}
        >
          {open ? "Window open" : "Scheduled"}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-secondary)]">
        {open
          ? "Scheduled downloads are running now."
          : stats.minutesUntilWindow !== null
            ? `${stats.scheduled} waiting, next window ${formatUntil(stats.minutesUntilWindow)}.`
            : "Armed, but no window will open."}
      </p>
    </button>
  );
}
