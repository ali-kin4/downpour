/**
 * The primary action bar.
 *
 * When rows are selected it swaps to a selection-scoped bar, so bulk actions
 * are unambiguous: "Pause" with three rows highlighted should never be able to
 * mean "pause everything".
 */

import {
  ArrowDownToLine,
  ClipboardList,
  Eraser,
  Pause,
  Play,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useMemo } from "react";
import * as api from "../lib/api";
import { useApp } from "../store/app";
import { Button, TextInput } from "./ui";

export function Toolbar() {
  const selection = useApp((s) => s.selection);
  return selection.size > 0 ? <SelectionBar /> : <DefaultBar />;
}

function DefaultBar() {
  const setAddOpen = useApp((s) => s.setAddOpen);
  const setPasteOpen = useApp((s) => s.setPasteOpen);
  const search = useApp((s) => s.search);
  const setSearch = useApp((s) => s.setSearch);
  const stats = useApp((s) => s.stats);
  const run = useApp((s) => s.run);

  const hasActive = (stats?.running ?? 0) > 0 || (stats?.queued ?? 0) > 0;
  const hasResumable =
    (stats?.paused ?? 0) > 0 || (stats?.idle ?? 0) > 0 || (stats?.failed ?? 0) > 0;
  // Anything that will not run again and is just taking up space in the list.
  const finished = (stats?.completed ?? 0) + (stats?.failed ?? 0);

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] px-3">
      <Button
        variant="primary"
        icon={<ArrowDownToLine size={14} />}
        onClick={() => setAddOpen(true)}
      >
        New download
      </Button>
      <Button
        icon={<ClipboardList size={14} />}
        onClick={() => setPasteOpen(true)}
        title="Paste or import a list of links (Ctrl V)"
      >
        New batch
      </Button>

      <div className="mx-1 h-5 w-px bg-[var(--border-subtle)]" />

      <Button
        variant="ghost"
        icon={<Play size={14} />}
        disabled={!hasResumable}
        title="Resume everything that is paused, idle or failed"
        onClick={() => void run("Could not resume", api.resumeAll)}
      >
        Resume all
      </Button>
      <Button
        variant="ghost"
        icon={<Pause size={14} />}
        disabled={!hasActive}
        onClick={() => void run("Could not pause", api.pauseAll)}
      >
        Pause all
      </Button>
      {(stats?.failed ?? 0) > 0 && (
        <Button
          variant="ghost"
          icon={<RefreshCw size={14} />}
          onClick={() => void run("Could not retry", api.retryFailed)}
        >
          Retry failed
        </Button>
      )}
      {finished > 0 && (
        <Button
          variant="ghost"
          icon={<Eraser size={14} />}
          title={`Remove ${finished} finished row${finished === 1 ? "" : "s"} from the list — completed, failed and cancelled. Files on disk are kept.`}
          onClick={() => void run("Could not clear", api.clearFinished)}
        >
          Clear finished
        </Button>
      )}

      <div className="ml-auto w-[220px]">
        <SearchBox value={search} onChange={setSearch} />
      </div>
    </div>
  );
}

function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <Search
        size={13}
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-tertiary)]"
      />
      <TextInput
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search downloads"
        className="pr-7 pl-8"
        aria-label="Search downloads"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
}

function SelectionBar() {
  const selection = useApp((s) => s.selection);
  const items = useApp((s) => s.items);
  const clearSelection = useApp((s) => s.clearSelection);
  const run = useApp((s) => s.run);

  const ids = useMemo(() => [...selection], [selection]);

  // Only offer actions that apply to something in the selection, so a bar full
  // of greyed-out buttons never appears.
  const { startable, pausable, anyCompleted } = useMemo(() => {
    let startable = 0;
    let pausable = 0;
    let anyCompleted = false;
    for (const id of ids) {
      const it = items[id];
      if (!it) continue;
      if (it.status === "paused" || it.status === "failed" || it.status === "idle") startable++;
      if (it.status === "running" || it.status === "probing" || it.status === "queued" || it.status === "scheduled")
        pausable++;
      if (it.status === "completed") anyCompleted = true;
    }
    return { startable, pausable, anyCompleted };
  }, [ids, items]);

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--accent-soft)] px-3">
      <span className="text-[12px] font-medium text-[var(--text-primary)]">
        {ids.length} selected
      </span>

      <div className="mx-1 h-5 w-px bg-[var(--border-strong)]" />

      {startable > 0 && (
        <Button
          size="sm"
          icon={<Play size={13} />}
          onClick={() => void run("Could not start", () => api.startMany(ids))}
        >
          Start
        </Button>
      )}
      {pausable > 0 && (
        <Button
          size="sm"
          icon={<Pause size={13} />}
          onClick={() => void run("Could not pause", () => api.pauseMany(ids))}
        >
          Pause
        </Button>
      )}
      <Button
        size="sm"
        icon={<Trash2 size={13} />}
        title="Remove from the list; files on disk are kept"
        onClick={() =>
          void run("Could not remove", async () => {
            await api.removeMany(ids, false);
            clearSelection();
          })
        }
      >
        Remove
      </Button>
      <Button
        size="sm"
        variant="danger"
        icon={<Trash2 size={13} />}
        title={
          anyCompleted
            ? "Remove and permanently delete the downloaded files"
            : "Remove and delete any partial data"
        }
        onClick={() =>
          void run("Could not delete", async () => {
            await api.removeMany(ids, true);
            clearSelection();
          })
        }
      >
        Delete files
      </Button>

      <Button
        size="sm"
        variant="ghost"
        className="ml-auto"
        icon={<X size={13} />}
        onClick={clearSelection}
      >
        Clear selection
      </Button>
    </div>
  );
}
