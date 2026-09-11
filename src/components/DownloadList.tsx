/**
 * The download table.
 *
 * Virtualised because a download manager accumulates finished rows
 * indefinitely — an IDM user can have thousands — and rendering them all would
 * make scrolling and every progress tick expensive. Rows subscribe to their own
 * item in the store, so a tick for one download re-renders one row.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownToLine,
  CheckCircle2,
  ClipboardList,
  Inbox,
  SearchX,
} from "lucide-react";
import { useMemo, useRef } from "react";
import { fileKind } from "../lib/filetypes";
import { ColumnHeader } from "./ColumnHeader";
import type { DownloadItem, ViewFilter } from "../lib/types";
import { matchesFilter } from "../lib/types";
import { useApp, type SortKey } from "../store/app";
import { DownloadRow } from "./DownloadRow";
import { Button } from "./ui";

const ROW_HEIGHT = 56;

export function DownloadList() {
  const items = useApp((s) => s.items);
  const order = useApp((s) => s.order);
  const filter = useApp((s) => s.filter);
  const category = useApp((s) => s.category);
  const search = useApp((s) => s.search);
  const sortKey = useApp((s) => s.sortKey);
  const sortDir = useApp((s) => s.sortDir);
  const selection = useApp((s) => s.selection);
  const selectAll = useApp((s) => s.selectAll);
  const clearSelection = useApp((s) => s.clearSelection);

  const visibleItems = useMemo(
    () => filterAndSort(items, order, filter, category, search, sortKey, sortDir),
    [items, order, filter, category, search, sortKey, sortDir],
  );
  const visible = useMemo(() => visibleItems.map((i) => i.id), [visibleItems]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const allSelected = visible.length > 0 && visible.every((id) => selection.has(id));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ColumnHeader
        visible={visibleItems}
        allSelected={allSelected}
        anySelected={selection.size > 0}
        onToggleAll={() => (allSelected ? clearSelection() : selectAll(visible))}
        disabled={visible.length === 0}
      />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <EmptyState
          hasAny={order.length > 0}
          filtered={Boolean(search) || filter !== "all" || category !== null}
        />
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {virtualizer.getVirtualItems().map((v) => (
              <div
                key={visible[v.index]}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: v.size,
                  transform: `translateY(${v.start}px)`,
                }}
              >
                <DownloadRow id={visible[v.index]} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ hasAny, filtered }: { hasAny: boolean; filtered: boolean }) {
  const setAddOpen = useApp((s) => s.setAddOpen);
  const setPasteOpen = useApp((s) => s.setPasteOpen);
  const setFilter = useApp((s) => s.setFilter);
  const setCategory = useApp((s) => s.setCategory);
  const setSearch = useApp((s) => s.setSearch);

  if (hasAny && filtered) {
    return (
      <Centered
        icon={<SearchX size={30} />}
        title="Nothing matches"
        body="No downloads match the current filter and search."
        action={
          <Button
            onClick={() => {
              setFilter("all");
              setCategory(null);
              setSearch("");
            }}
          >
            Show all downloads
          </Button>
        }
      />
    );
  }

  if (hasAny) {
    return (
      <Centered
        icon={<CheckCircle2 size={30} />}
        title="Nothing here"
        body="This view is empty."
      />
    );
  }

  return (
    <Centered
      icon={<Inbox size={30} />}
      title="No downloads yet"
      body="Paste a link, drop in a batch of URLs, or install the browser extension to capture downloads automatically."
      action={
        <div className="flex gap-2">
          <Button
            variant="primary"
            icon={<ArrowDownToLine size={14} />}
            onClick={() => setAddOpen(true)}
          >
            New download
          </Button>
          <Button icon={<ClipboardList size={14} />} onClick={() => setPasteOpen(true)}>
            New batch
          </Button>
        </div>
      }
    />
  );
}

function Centered({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="text-[var(--text-tertiary)] opacity-60">{icon}</div>
      <div>
        <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">{title}</h2>
        <p className="mx-auto mt-1 max-w-sm text-[12px] leading-relaxed text-[var(--text-secondary)]">
          {body}
        </p>
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/** Rank used when sorting by status, so the list reads busiest-first. */
const STATUS_RANK: Record<string, number> = {
  running: 0,
  probing: 1,
  queued: 2,
  scheduled: 3,
  paused: 4,
  idle: 5,
  failed: 6,
  completed: 7,
  cancelled: 8,
};

function filterAndSort(
  items: Record<string, DownloadItem>,
  order: string[],
  filter: ViewFilter,
  category: string | null,
  search: string,
  sortKey: SortKey,
  sortDir: "asc" | "desc",
): DownloadItem[] {
  const needle = search.trim().toLowerCase();
  const rows = order
    .map((id) => items[id])
    .filter((it): it is DownloadItem => {
      if (!it) return false;
      if (!matchesFilter(it.status, filter)) return false;
      if (category && fileKind(it.filename).group !== category) return false;
      if (!needle) return true;
      // Search the URL too: a user hunting for a download often remembers the
      // site, not the filename the server chose.
      return (
        it.filename.toLowerCase().includes(needle) ||
        it.url.toLowerCase().includes(needle)
      );
    });

  const dir = sortDir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    switch (sortKey) {
      case "name":
        return dir * a.filename.localeCompare(b.filename, undefined, { numeric: true });
      case "size":
        return dir * ((a.totalBytes ?? 0) - (b.totalBytes ?? 0));
      case "progress": {
        const pa = a.totalBytes ? a.downloadedBytes / a.totalBytes : 0;
        const pb = b.totalBytes ? b.downloadedBytes / b.totalBytes : 0;
        return dir * (pa - pb);
      }
      case "speed":
        return dir * (a.speedBps - b.speedBps);
      case "status":
        return dir * ((STATUS_RANK[b.status] ?? 9) - (STATUS_RANK[a.status] ?? 9));
      case "added":
      default:
        return dir * (a.sequence - b.sequence);
    }
  });

  return rows;
}
