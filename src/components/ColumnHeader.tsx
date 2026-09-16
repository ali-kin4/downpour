/**
 * The sortable, resizable column header.
 *
 * Every edge is a drag handle: drag to resize, double-click to fit the column
 * to its widest visible value. The hit area is 9px wide and the rule inside it
 * 1px, painted faintly at rest and darkening under the pointer. An unpainted
 * edge kept the header clean but left both gestures undiscoverable — nobody
 * drags an edge they cannot see.
 */

import clsx from "clsx";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatBytes,
  formatDuration,
  formatSpeed,
  formatStamp,
  hostOf,
} from "../lib/format";
import type { DownloadItem } from "../lib/types";
import { useApp, type SortKey } from "../store/app";
import {
  COLUMNS,
  visibleColumns,
  COLUMN_GAP,
  GUTTER_LEAD,
  GUTTER_TRAIL,
  gridTemplate,
  measureText,
  useColumns,
  type ColumnId,
} from "../store/columns";

/** Matches the row's name cell, so auto-fit measures the right thing. */
const NAME_FONT = '500 12.5px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const CELL_FONT = '12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
/** Icon tile (32) + its gap (10) sit left of the filename inside the Name cell. */
const NAME_LEADING = 42;

export function ColumnHeader({
  visible,
  allSelected,
  anySelected,
  onToggleAll,
  disabled,
}: {
  visible: DownloadItem[];
  allSelected: boolean;
  anySelected: boolean;
  onToggleAll: () => void;
  disabled: boolean;
}) {
  const widths = useColumns((s) => s.widths);
  const hidden = useColumns((s) => s.hidden);
  const toggle = useColumns((s) => s.toggle);
  const shown = visibleColumns(hidden);
  // Right-click anywhere on the header picks columns, the way Explorer's
  // details view does. Discoverable to anyone who has used one, and it keeps
  // optional fields out of the way until someone wants them.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const resize = useColumns((s) => s.resize);
  const endResize = useColumns((s) => s.endResize);
  const autoFit = useColumns((s) => s.autoFit);
  const fitToContainer = useColumns((s) => s.fitToContainer);

  const sortKey = useApp((s) => s.sortKey);
  const sortDir = useApp((s) => s.sortDir);
  const setSort = useApp((s) => s.setSort);

  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<ColumnId | null>(null);

  // Keep Name filling the leftover width until the user sizes it themselves.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      fitToContainer(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitToContainer]);

  const startDrag = useCallback(
    (id: ColumnId, event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = useColumns.getState().widths[id];
      setDragging(id);

      const onMove = (e: PointerEvent) => resize(id, startWidth + (e.clientX - startX));
      const onUp = () => {
        endResize(id);
        setDragging(null);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      // Held on the body so the cursor stays correct even when the pointer
      // leaves the 9px handle mid-drag, which it always does.
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [resize, endResize],
  );

  const fit = useCallback(
    (id: ColumnId) => {
      let widest = measureText(
        COLUMNS.find((c) => c.id === id)?.label ?? "",
        CELL_FONT,
      );
      for (const item of visible) {
        const text = cellText(item, id);
        if (!text) continue;
        const w =
          measureText(text, id === "name" ? NAME_FONT : CELL_FONT) +
          (id === "name" ? NAME_LEADING : 0);
        if (w > widest) widest = w;
      }
      autoFit(id, widest);
    },
    [visible, autoFit],
  );

  return (
    <div
      ref={ref}
      className="relative flex h-8 shrink-0 items-center border-b border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 text-[11px] font-medium text-[var(--text-tertiary)]"
      onContextMenu={(e) => {
        e.preventDefault();
        const box = ref.current?.getBoundingClientRect();
        setMenu({ x: e.clientX - (box?.left ?? 0), y: 28 });
      }}
      style={{
        display: "grid",
        gridTemplateColumns: gridTemplate(widths, hidden),
        columnGap: COLUMN_GAP,
      }}
    >
      <input
        type="checkbox"
        aria-label="Select all"
        checked={allSelected}
        ref={(el) => {
          if (el) el.indeterminate = anySelected && !allSelected;
        }}
        disabled={disabled}
        onChange={onToggleAll}
        className="size-3.5 accent-[var(--accent)]"
      />

      {shown.map((c) => (
        <div key={c.id} className="relative min-w-0">
          <button
            type="button"
            disabled={!c.sortable}
            onClick={() => c.sortable && setSort(c.id as SortKey)}
            title={c.sortable ? `Sort by ${c.label}` : c.label}
            className={clsx(
              "flex w-full min-w-0 items-center gap-1 truncate",
              c.align === "right" && "justify-end",
              c.sortable && "hover:text-[var(--text-primary)]",
            )}
          >
            <span className="truncate">{c.label}</span>
            {sortKey === (c.id as SortKey) &&
              (sortDir === "asc" ? (
                <ChevronUp size={11} className="shrink-0" />
              ) : (
                <ChevronDown size={11} className="shrink-0" />
              ))}
          </button>

          {/* Resize handle. Sits half outside the cell so it straddles the gap
              and both neighbours feel grabbable. The rule is full height at
              rest so the boundary reads as a boundary. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${c.label}`}
            onPointerDown={(e) => startDrag(c.id, e)}
            onDoubleClick={(e) => {
              e.preventDefault();
              fit(c.id);
            }}
            title="Drag to resize · double-click to fit"
            className="group absolute top-0 -right-[10px] z-10 flex h-8 w-[9px] cursor-col-resize items-center justify-center"
          >
            <span
              className={clsx(
                "w-px transition-all duration-100",
                dragging === c.id
                  ? "h-8 bg-[var(--accent)]"
                  : "h-4 bg-[var(--border-strong)] group-hover:h-8 group-hover:bg-[var(--accent)]",
              )}
            />
          </div>
        </div>
      ))}

      <span />

      {dragging && (
        // A full-height rule while dragging, so the new boundary is visible
        // against the rows rather than only in the header.
        <div
          className="pointer-events-none fixed inset-y-0 w-px bg-[var(--accent)] opacity-60"
          style={{ left: dragGuideX(ref.current, widths, dragging, hidden) }}
        />
      )}

      {menu && (
        <ColumnMenu
          x={menu.x}
          y={menu.y}
          hidden={hidden}
          onToggle={toggle}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * The column chooser.
 *
 * Name is listed but locked: it is the row's identity, and a table of sizes and
 * percentages belonging to nothing is not a table. Everything else is fair game.
 */
function ColumnMenu({
  x,
  y,
  hidden,
  onToggle,
  onClose,
}: {
  x: number;
  y: number;
  hidden: ColumnId[];
  onToggle: (id: ColumnId) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const dismiss = () => onClose();
    // Deferred by a tick, or the same click that opened the menu closes it.
    const t = window.setTimeout(() => {
      window.addEventListener("click", dismiss);
      window.addEventListener("contextmenu", dismiss);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
    };
  }, [onClose]);

  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      style={{ left: x, top: y }}
      className={clsx(
        "dp-enter absolute z-40 min-w-[176px] overflow-hidden py-1",
        "rounded-[var(--radius-card)] border border-[var(--border-subtle)]",
        "bg-[var(--surface-raised)] shadow-[var(--shadow-overlay)]",
      )}
    >
      <p className="px-3 py-1 text-[10px] font-semibold tracking-[0.09em] text-[var(--text-tertiary)] uppercase">
        Columns
      </p>
      {COLUMNS.map((c) => {
        const locked = c.id === "name";
        const on = !hidden.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            disabled={locked}
            onClick={() => onToggle(c.id)}
            className={clsx(
              "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px]",
              "transition-colors duration-100",
              locked
                ? "text-[var(--text-tertiary)]"
                : "text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
            )}
          >
            <span className="flex w-3.5 justify-center text-[var(--accent)]">
              {on && <Check size={12} strokeWidth={3} />}
            </span>
            <span className="flex-1">{c.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Screen x of the right edge of the column being dragged. */
function dragGuideX(
  el: HTMLElement | null,
  widths: Record<ColumnId, number>,
  id: ColumnId,
  hidden: ColumnId[],
): number {
  if (!el) return -1;
  const rect = el.getBoundingClientRect();
  let x = rect.left + 12 + GUTTER_LEAD + COLUMN_GAP;
  for (const c of visibleColumns(hidden)) {
    x += widths[c.id];
    if (c.id === id) return x + COLUMN_GAP / 2;
    x += COLUMN_GAP;
  }
  return x;
}

/** The text a cell renders, used only for auto-fit measurement. */
function cellText(item: DownloadItem, id: ColumnId): string {
  switch (id) {
    case "name":
      return item.filename;
    case "size":
      return formatBytes(item.totalBytes);
    case "progress":
      return "100%";
    case "speed":
      return item.speedBps > 0 ? formatSpeed(item.speedBps) : "—";
    case "left":
      return item.etaSecs !== null ? formatDuration(item.etaSecs) : "—";
    case "status":
      return item.error ? "Failed" : "Downloading";
    case "added":
      return formatStamp(item.createdAt);
    case "completed":
      return formatStamp(item.completedAt);
    case "source":
      return hostOf(item.url);
  }
}

export { GUTTER_TRAIL };
