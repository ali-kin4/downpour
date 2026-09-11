/**
 * The bottom status strip.
 *
 * Carries the two numbers a download manager is judged on — total throughput
 * and how many things are running — plus a one-click concurrency control,
 * because "only download two at a time" is a decision people change often
 * enough that burying it in Settings is wrong.
 */

import { Gauge, Layers, Zap } from "lucide-react";
import { formatSpeed } from "../lib/format";
import { useApp } from "../store/app";

export function StatusBar() {
  const stats = useApp((s) => s.stats);
  const settings = useApp((s) => s.settings);
  const saveSettings = useApp((s) => s.saveSettings);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);

  const concurrency = settings?.maxConcurrentDownloads ?? 3;

  return (
    <footer className="dp-panel flex h-8 shrink-0 items-center gap-4 border-r-0 border-b-0 border-l-0 px-3 text-[11px] text-[var(--text-secondary)]">
      <span className="flex items-center gap-1.5">
        <Zap size={12} className="text-[var(--accent)]" />
        <span className="tabular-nums">
          {stats && stats.totalSpeedBps > 0 ? formatSpeed(stats.totalSpeedBps) : "Idle"}
        </span>
      </span>

      <span className="flex items-center gap-1.5">
        <Layers size={12} className="text-[var(--text-tertiary)]" />
        <span className="tabular-nums">
          {stats?.running ?? 0} running · {stats?.queued ?? 0} queued
        </span>
      </span>

      <div className="ml-auto flex items-center gap-2">
        {settings && settings.speedLimitBps > 0 && (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-[var(--surface-hover)]"
            title="Global speed limit — click to change"
          >
            <Gauge size={12} className="text-[var(--status-paused)]" />
            <span className="tabular-nums">{formatSpeed(settings.speedLimitBps)}</span>
          </button>
        )}

        <label className="flex items-center gap-1.5">
          <span className="text-[var(--text-tertiary)]">Simultaneous</span>
          <select
            value={concurrency}
            aria-label="Maximum simultaneous downloads"
            onChange={(e) => {
              if (!settings) return;
              void saveSettings({
                ...settings,
                maxConcurrentDownloads: Number(e.target.value),
              });
            }}
            className="h-5 rounded border border-[var(--border-strong)] bg-[var(--surface-raised)] px-1 text-[11px] tabular-nums text-[var(--text-primary)]"
          >
            {[1, 2, 3, 4, 5, 6, 8, 10, 16].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
    </footer>
  );
}
