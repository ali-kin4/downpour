/**
 * Ctrl-K palette: every action, plus a jump-to-download search.
 *
 * Worth having in a utility app because the actions people want are verbs
 * ("pause all", "clear completed") that are otherwise spread across a toolbar,
 * a menu bar and a context menu.
 */

import clsx from "clsx";
import {
  ArrowDownToLine,
  ClipboardList,
  Cog,
  CornerDownLeft,
  Eraser,
  FolderOpen,
  Pause,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "../lib/api";
import { formatBytes } from "../lib/format";
import { useApp } from "../store/app";
import { Kbd } from "./ui";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void | Promise<unknown>;
}

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  const items = useApp((s) => s.items);
  const order = useApp((s) => s.order);
  const settings = useApp((s) => s.settings);
  const store = useApp;

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const s = () => store.getState();
    const act = (label: string, fn: () => Promise<unknown>) => () =>
      void s().run(label, fn);

    const base: Command[] = [
      {
        id: "new",
        label: "New download",
        icon: <ArrowDownToLine size={15} />,
        keywords: "add url link",
        run: () => s().setAddOpen(true),
      },
      {
        id: "paste",
        label: "New batch",
        icon: <ClipboardList size={15} />,
        keywords: "batch paste bulk many clipboard links import list",
        run: () => s().setPasteOpen(true),
      },
      {
        id: "resume",
        label: "Resume all",
        icon: <Play size={15} />,
        keywords: "start unpause continue",
        run: act("Could not resume", api.resumeAll),
      },
      {
        id: "pause",
        label: "Pause all",
        icon: <Pause size={15} />,
        keywords: "stop halt",
        run: act("Could not pause", api.pauseAll),
      },
      {
        id: "retry",
        label: "Retry failed downloads",
        icon: <RefreshCw size={15} />,
        keywords: "error again",
        run: act("Could not retry", api.retryFailed),
      },
      {
        id: "clear",
        label: "Clear completed",
        hint: "Files on disk are kept",
        icon: <Eraser size={15} />,
        keywords: "tidy remove finished",
        run: act("Could not clear", api.clearCompleted),
      },
      {
        id: "clear-all",
        label: "Clear all finished",
        hint: "Completed, failed and cancelled",
        icon: <Trash2 size={15} />,
        keywords: "purge",
        run: act("Could not clear", api.clearFinished),
      },
      {
        id: "folder",
        label: "Open downloads folder",
        icon: <FolderOpen size={15} />,
        keywords: "explorer directory",
        run: act("Could not open folder", () => api.openPath(settings?.downloadDir ?? "")),
      },
      {
        id: "settings",
        label: "Settings",
        icon: <Cog size={15} />,
        keywords: "preferences options config schedule",
        run: () => s().setSettingsOpen(true),
      },
    ];

    // Jump to a download. Capped so a large queue does not turn the palette
    // into an unscannable wall.
    const q = query.trim().toLowerCase();
    if (q.length >= 2) {
      for (const id of order) {
        const item = items[id];
        if (!item) continue;
        if (
          !item.filename.toLowerCase().includes(q) &&
          !item.url.toLowerCase().includes(q)
        ) {
          continue;
        }
        base.push({
          id: `goto-${id}`,
          label: item.filename,
          hint: `${item.status} · ${formatBytes(item.totalBytes)}`,
          icon: <Search size={15} />,
          run: () => {
            s().setFilter("all");
            s().setSearch(item.filename);
            s().select(id, "replace");
          },
        });
        if (base.length > 40) break;
      }
    }

    return base;
  }, [query, items, order, settings?.downloadDir, store]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.keywords ?? ""} ${c.hint ?? ""}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Clamp rather than reset: a shrinking list should not silently move the
  // highlight back to the top while the user is arrowing down.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const commit = (index: number) => {
    const cmd = filtered[index];
    if (!cmd) return;
    setOpen(false);
    void cmd.run();
  };

  return (
    <div className="fixed inset-0 z-[55] flex items-start justify-center pt-[14vh]">
      <div
        className="absolute inset-0 bg-black/25 backdrop-blur-[2px]"
        onClick={() => setOpen(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="dp-enter relative w-[560px] max-w-[92vw] overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-[var(--shadow-overlay)]"
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--border-subtle)] px-4">
          <Search size={15} className="shrink-0 text-[var(--text-tertiary)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                commit(active);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="Type a command or search downloads"
            className="h-12 flex-1 bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
          <Kbd>Esc</Kbd>
        </div>

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-[var(--text-tertiary)]">
              Nothing matches “{query}”.
            </p>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                type="button"
                data-index={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(i)}
                className={clsx(
                  "flex w-full items-center gap-3 px-4 py-2 text-left transition-colors",
                  i === active ? "bg-[var(--surface-selected)]" : "hover:bg-[var(--surface-hover)]",
                )}
              >
                <span
                  className={
                    i === active ? "text-[var(--accent)]" : "text-[var(--text-tertiary)]"
                  }
                >
                  {c.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] text-[var(--text-primary)]">
                    {c.label}
                  </span>
                  {c.hint && (
                    <span className="block truncate text-[11px] text-[var(--text-tertiary)]">
                      {c.hint}
                    </span>
                  )}
                </span>
                {i === active && (
                  <CornerDownLeft size={13} className="text-[var(--text-tertiary)]" />
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
