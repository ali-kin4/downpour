/**
 * Application state.
 *
 * The download list is **event-driven**: `listDownloads()` runs once on start
 * and after a `resync`, and everything after that is applied from the engine's
 * event stream. Polling the full list twice a second would clone every item
 * (headers included) on every tick, which is fine at ten downloads and awful
 * at two thousand — and an IDM user accumulates thousands of finished rows.
 *
 * Items live in a keyed record so a row can subscribe to exactly its own item.
 * A progress tick for one download then re-renders one row rather than the
 * whole table.
 */

import { create } from "zustand";
import * as api from "../lib/api";
import type {
  DownloadId,
  DownloadItem,
  EngineEvent,
  QueueStats,
  Settings,
  ViewFilter,
} from "../lib/types";
import { matchesFilter } from "../lib/types";

export type SortKey = "added" | "name" | "size" | "progress" | "speed" | "status";
export type SortDir = "asc" | "desc";

export interface Toast {
  id: number;
  tone: "info" | "success" | "error";
  title: string;
  detail?: string;
}

interface AppState {
  // --- data ---
  items: Record<DownloadId, DownloadItem>;
  order: DownloadId[];
  stats: QueueStats | null;
  settings: Settings | null;
  ready: boolean;
  loadError: string | null;

  // --- view ---
  filter: ViewFilter;
  search: string;
  sortKey: SortKey;
  sortDir: SortDir;
  selection: Set<DownloadId>;
  lastClicked: DownloadId | null;

  // --- overlays ---
  addOpen: boolean;
  pasteOpen: boolean;
  settingsOpen: boolean;
  paletteOpen: boolean;
  toasts: Toast[];

  // --- actions ---
  bootstrap: () => Promise<void>;
  applyEvent: (event: EngineEvent) => void;
  refreshStats: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  saveSettings: (next: Settings) => Promise<void>;

  setFilter: (f: ViewFilter) => void;
  setSearch: (s: string) => void;
  setSort: (key: SortKey) => void;

  select: (id: DownloadId, mode: "replace" | "toggle" | "range") => void;
  selectAll: (ids: DownloadId[]) => void;
  clearSelection: () => void;

  setAddOpen: (v: boolean) => void;
  setPasteOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setPaletteOpen: (v: boolean) => void;

  toast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;
  /** Wraps an async action so a rejected IPC call surfaces instead of vanishing. */
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
}

let toastSeq = 0;

/** Newest first. Sequence is monotonic, so this is insertion order reversed. */
function sortByRecency(items: Record<DownloadId, DownloadItem>): DownloadId[] {
  return Object.values(items)
    .sort((a, b) => b.sequence - a.sequence)
    .map((i) => i.id);
}

export const useApp = create<AppState>((set, get) => ({
  items: {},
  order: [],
  stats: null,
  settings: null,
  ready: false,
  loadError: null,

  filter: "all",
  search: "",
  sortKey: "added",
  sortDir: "desc",
  selection: new Set(),
  lastClicked: null,

  addOpen: false,
  pasteOpen: false,
  settingsOpen: false,
  paletteOpen: false,
  toasts: [],

  async bootstrap() {
    try {
      const [list, stats, settings] = await Promise.all([
        api.listDownloads(),
        api.getStats(),
        api.getSettings(),
      ]);
      const items: Record<DownloadId, DownloadItem> = {};
      for (const item of list) items[item.id] = item;
      set({
        items,
        order: sortByRecency(items),
        stats,
        settings,
        ready: true,
        loadError: null,
      });
    } catch (e) {
      set({ ready: true, loadError: api.errorMessage(e) });
    }
  },

  applyEvent(event) {
    switch (event.kind) {
      case "added": {
        const items = { ...get().items, [event.item.id]: event.item };
        set({ items, order: sortByRecency(items) });
        break;
      }
      case "statusChanged": {
        const current = get().items[event.id];
        if (!current) break;
        set({
          items: {
            ...get().items,
            [event.id]: { ...current, status: event.status, error: event.error },
          },
        });
        break;
      }
      case "progress": {
        const current = get().items[event.id];
        if (!current) break;
        set({
          items: {
            ...get().items,
            [event.id]: {
              ...current,
              downloadedBytes: event.downloadedBytes,
              totalBytes: event.totalBytes ?? current.totalBytes,
              speedBps: event.speedBps,
              etaSecs: event.etaSecs,
              connections: event.connections,
            },
          },
        });
        break;
      }
      case "completed": {
        const current = get().items[event.id];
        if (!current) break;
        set({
          items: {
            ...get().items,
            [event.id]: {
              ...current,
              status: "completed",
              speedBps: 0,
              etaSecs: null,
              downloadedBytes: current.totalBytes ?? current.downloadedBytes,
            },
          },
        });
        break;
      }
      case "failed": {
        const current = get().items[event.id];
        if (!current) break;
        set({
          items: {
            ...get().items,
            [event.id]: { ...current, status: "failed", error: event.error, speedBps: 0 },
          },
        });
        break;
      }
      case "removed": {
        const items = { ...get().items };
        delete items[event.id];
        const selection = new Set(get().selection);
        selection.delete(event.id);
        set({ items, order: sortByRecency(items), selection });
        break;
      }
      case "schedulerWindow": {
        get().toast({
          tone: "info",
          title: event.open ? "Scheduler window open" : "Scheduler window closed",
          detail: event.label ?? undefined,
        });
        break;
      }
      case "queueDrained": {
        if (event.completed > 0 || event.failed > 0) {
          get().toast({
            tone: event.failed > 0 ? "info" : "success",
            title: "All downloads finished",
            detail:
              event.failed > 0
                ? `${event.completed} complete, ${event.failed} failed`
                : `${event.completed} complete`,
          });
        }
        break;
      }
      case "resync": {
        // Events were dropped because the UI fell behind; a partial state is
        // worse than a round trip, so reload from scratch.
        void get().bootstrap();
        break;
      }
    }
  },

  async refreshStats() {
    try {
      set({ stats: await api.getStats() });
    } catch {
      // Stats are decoration; a failure here must not surface as an error.
    }
  },

  async refreshSettings() {
    try {
      set({ settings: await api.getSettings() });
    } catch (e) {
      get().toast({ tone: "error", title: "Could not read settings", detail: api.errorMessage(e) });
    }
  },

  async saveSettings(next) {
    try {
      const saved = await api.updateSettings(next);
      // Use what came back, not what was sent: the engine clamps out-of-range
      // values, and showing the unclamped input would be a lie.
      set({ settings: saved });
    } catch (e) {
      get().toast({ tone: "error", title: "Could not save settings", detail: api.errorMessage(e) });
    }
  },

  setFilter(filter) {
    set({ filter, selection: new Set() });
  },
  setSearch(search) {
    set({ search });
  },
  setSort(key) {
    const { sortKey, sortDir } = get();
    set(
      sortKey === key
        ? { sortDir: sortDir === "asc" ? "desc" : "asc" }
        : { sortKey: key, sortDir: key === "name" ? "asc" : "desc" },
    );
  },

  select(id, mode) {
    const { selection, lastClicked, order, items, filter, search } = get();
    if (mode === "replace") {
      set({ selection: new Set([id]), lastClicked: id });
      return;
    }
    if (mode === "toggle") {
      const next = new Set(selection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      set({ selection: next, lastClicked: id });
      return;
    }
    // Range: shift-click extends across the *visible* rows, not the raw list,
    // or a filtered view would silently select rows the user cannot see.
    const visible = order.filter((rid) => {
      const item = items[rid];
      if (!item) return false;
      if (!matchesFilter(item.status, filter)) return false;
      if (search && !item.filename.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
    const from = lastClicked ? visible.indexOf(lastClicked) : -1;
    const to = visible.indexOf(id);
    if (from === -1 || to === -1) {
      set({ selection: new Set([id]), lastClicked: id });
      return;
    }
    const [lo, hi] = from < to ? [from, to] : [to, from];
    set({ selection: new Set(visible.slice(lo, hi + 1)) });
  },

  selectAll(ids) {
    set({ selection: new Set(ids) });
  },
  clearSelection() {
    set({ selection: new Set() });
  },

  setAddOpen: (addOpen) => set({ addOpen }),
  setPasteOpen: (pasteOpen) => set({ pasteOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  toast(t) {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { ...t, id }] });
    // Errors stay until dismissed; transient notices clear themselves.
    if (t.tone !== "error") {
      setTimeout(() => get().dismissToast(id), 4000);
    }
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  async run(label, fn) {
    try {
      await fn();
    } catch (e) {
      get().toast({ tone: "error", title: label, detail: api.errorMessage(e) });
    }
  },
}));

/** Rows subscribe to only their own item, so one progress tick re-renders one row. */
export const useItem = (id: DownloadId) => useApp((s) => s.items[id]);

/** Stable empty set, so selectors returning "nothing selected" do not thrash. */
export const EMPTY_SELECTION: ReadonlySet<DownloadId> = new Set();
