/**
 * The capture confirmation panel.
 *
 * Rendered into a second Tauri window at `?view=confirm`. When the extension
 * intercepts a click in the browser, this is what asks whether to take it --
 * previously the whole main window came forward to put a one-line question,
 * which interrupted far more than the question was worth.
 *
 * It keeps a **queue**. A page that fires four downloads at once would stack
 * four dialogs if each got its own window; instead they are asked about in
 * turn, the count is visible so nobody is surprised by a second question, and
 * the window closes itself once the last one is answered.
 *
 * Dismissing is not destructive in the way it looks: the browser's own copy of
 * the download was already taken away when the app accepted the hand-off, so
 * "Don't download" means exactly that -- nothing is fetched, by anyone.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { Download, FolderOpen, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api";
import { FileTile } from "../lib/filetypes";
import { formatBytes, hostOf } from "../lib/format";
import { useTheme } from "../hooks/useTheme";
import { Button, FolderPicker } from "./ui";

export function ConfirmWindow() {
  useTheme();

  const [queue, setQueue] = useState<api.PendingDownload[]>([]);
  const [destDir, setDestDir] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = queue[0];

  // Every capture arrives on the same channel, whether or not this window was
  // already open, so appending is all the queueing there is to do.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void api
      .onConfirmDownload((item) => setQueue((q) => [...q, item]))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // The destination belongs to the download being asked about, not to the
  // window, so it is reset as each one comes to the front.
  useEffect(() => {
    setDestDir(pending?.destDir ?? "");
  }, [pending]);

  // Nothing left to ask about. The window has no other purpose, so it goes --
  // the downloads themselves live in the engine and are unaffected.
  useEffect(() => {
    if (queue.length === 0) void getCurrentWindow().close();
  }, [queue.length]);

  const answer = useCallback(() => setQueue((q) => q.slice(1)), []);

  const start = useCallback(async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      await api.addDownload({
        url: pending.url,
        filename: pending.filename,
        destDir: destDir.trim() || null,
        connections: null,
        startMode: "start",
        checksum: null,
        // The browser's session, carried across verbatim. Without these a
        // login-gated file arrives as the login page instead of the file.
        headers: pending.headers,
        source: pending.source ?? "extension",
      });
      answer();
    } finally {
      setBusy(false);
    }
  }, [pending, destDir, busy, answer]);

  // Enter takes it, Escape declines. A question this small should not need the
  // mouse, and the window takes focus precisely so these work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") void start();
      if (e.key === "Escape") answer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [start, answer]);

  if (!pending) return null;

  const name = pending.filename || "this file";

  return (
    <div className="flex h-screen flex-col bg-[var(--surface-base)] text-[var(--text-primary)]">
      <header className="flex items-center justify-between border-b border-[var(--border-subtle)] px-4 py-2.5">
        <div className="text-[12px] font-medium text-[var(--text-secondary)]">
          Download this file?
        </div>
        <div className="flex items-center gap-2">
          {queue.length > 1 && (
            <span className="text-[11px] text-[var(--text-tertiary)]">
              1 of {queue.length}
            </span>
          )}
          <button
            type="button"
            aria-label="Don't download"
            onClick={answer}
            className="grid size-6 place-items-center rounded-[6px] text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <FileTile filename={name} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium" title={name}>
              {name}
            </div>
            <div className="truncate text-[11px] text-[var(--text-tertiary)]">
              {hostOf(pending.url)}
              {pending.sizeHint ? ` · ${formatBytes(pending.sizeHint)}` : ""}
            </div>
          </div>
        </div>

        <div>
          <div className="mb-1 text-[11px] font-medium text-[var(--text-tertiary)]">
            Save to
          </div>
          <div className="flex gap-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-2.5 text-[12px]">
              <FolderOpen size={13} className="shrink-0 text-[var(--text-tertiary)]" />
              <span className="truncate py-2 text-[var(--text-secondary)]">
                {destDir || "Automatic (by file type)"}
              </span>
            </div>
            <FolderPicker defaultPath={destDir} onPick={setDestDir} />
          </div>
        </div>
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-4 py-3">
        <Button onClick={answer}>Don't download</Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => void start()}
          icon={<Download size={14} />}
        >
          Download
        </Button>
      </footer>
    </div>
  );
}
