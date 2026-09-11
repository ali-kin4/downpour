import { useEffect } from "react";
import { AddDialog } from "./components/AddDialog";
import { CommandPalette } from "./components/CommandPalette";
import { DownloadList } from "./components/DownloadList";
import { MenuBar } from "./components/MenuBar";
import { PasteDialog } from "./components/PasteDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { Toasts } from "./components/Toasts";
import { Toolbar } from "./components/Toolbar";
import { useTheme } from "./hooks/useTheme";
import * as api from "./lib/api";
import { useApp } from "./store/app";

/**
 * How often the summary counters refresh.
 *
 * The download rows are event-driven and never polled. Stats are the one thing
 * that cannot be derived from the event stream alone, because the scheduler's
 * "opens in 4h 12m" counts down with the wall clock rather than in response to
 * anything the engine does.
 */
const STATS_INTERVAL_MS = 1000;

export function App() {
  useTheme();

  const bootstrap = useApp((s) => s.bootstrap);
  const applyEvent = useApp((s) => s.applyEvent);
  const refreshStats = useApp((s) => s.refreshStats);
  const ready = useApp((s) => s.ready);
  const loadError = useApp((s) => s.loadError);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    // The listener is registered asynchronously, so a fast unmount (React 19
    // StrictMode double-invokes effects in development) can resolve after the
    // cleanup has already run. Track it and unlisten immediately in that case,
    // or every progress tick is applied twice.
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

  useEffect(() => {
    void refreshStats();
    const timer = window.setInterval(() => void refreshStats(), STATS_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshStats]);

  useGlobalShortcuts();

  if (!ready) {
    return (
      <div className="grid h-full place-items-center text-[13px] text-[var(--text-tertiary)]">
        Starting Downpour…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="grid h-full place-items-center p-8">
        <div className="dp-card max-w-md p-6 text-center">
          <h1 className="mb-2 text-[15px] font-semibold text-[var(--text-primary)]">
            Downpour could not start
          </h1>
          <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
            {loadError}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <MenuBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <Toolbar />
          <DownloadList />
          <StatusBar />
        </main>
      </div>

      <AddDialog />
      <PasteDialog />
      <SettingsDialog />
      <CommandPalette />
      <Toasts />
    </div>
  );
}

/**
 * Application-wide keyboard shortcuts.
 *
 * Deliberately skipped whenever focus is in a text field: a user typing a URL
 * into the Add dialog must be able to press `n` without opening another one.
 */
function useGlobalShortcuts() {
  const store = useApp;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;

      const s = store.getState();
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.setPaletteOpen(true);
        return;
      }
      if (typing) return;

      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        s.setAddOpen(true);
      } else if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        s.setPasteOpen(true);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        s.setSettingsOpen(true);
      } else if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        s.selectAll(s.order);
      } else if (e.key === "Escape") {
        s.clearSelection();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}
