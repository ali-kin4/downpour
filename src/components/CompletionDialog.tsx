/**
 * The "your download finished" moment.
 *
 * Shown only when a single download completes and nothing else is still
 * running. That condition is the whole design: popping a modal for each of
 * twenty batch downloads would be an assault, while a single deliberate
 * download finishing is exactly when someone wants to open the file.
 *
 * Suppressed entirely when the window is hidden — a modal waiting behind the
 * tray icon helps nobody, and the desktop notification already fired.
 */

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { CheckCircle2, Copy, FolderOpen, Play, X } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { FileTile, fileKind } from "../lib/filetypes";
import { formatBytes, formatDurationMs, formatSpeed, hostOf } from "../lib/format";
import type { DownloadItem } from "../lib/types";
import { useApp } from "../store/app";
import { Button } from "./ui";

export function CompletionDialog() {
  const finished = useApp((s) => s.justFinished);
  const dismiss = useApp((s) => s.dismissFinished);
  const run = useApp((s) => s.run);
  const toast = useApp((s) => s.toast);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [finished?.id]);

  useEffect(() => {
    if (!finished) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [finished, dismiss]);

  if (!finished) return null;

  const path = filePath(finished);
  const kind = fileKind(finished.filename);
  // Guard the divisor rather than the numerator: a 2 MB file that took 180ms
  // has a perfectly meaningful average, and reporting a dash for it looks
  // broken.
  const average =
    finished.elapsedMs > 0 && finished.totalBytes
      ? (finished.totalBytes * 1000) / finished.elapsedMs
      : 0;

  return (
    <div className="fixed inset-0 z-[58] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-black/25 backdrop-blur-[2px]" onClick={dismiss} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Download complete"
        className="dp-enter relative w-[420px] max-w-full overflow-hidden rounded-[var(--radius-panel)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-[var(--shadow-overlay)]"
      >
        {/* A thin band of the file's own colour, so the dialog feels like it
            belongs to this file rather than being a generic alert. */}
        <div
          className="h-1 w-full"
          style={{
            background: `linear-gradient(90deg, ${kind.colour}, var(--color-accent-to))`,
          }}
        />

        <button
          type="button"
          aria-label="Close"
          onClick={dismiss}
          className="absolute top-3 right-3 grid size-7 place-items-center rounded-[6px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <X size={15} />
        </button>

        <div className="px-6 pt-6 pb-5">
          <div className="flex flex-col items-center text-center">
            <div className="relative">
              <FileTile filename={finished.filename} size={56} active />
              <span
                className="dp-pop absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full border-2 border-[var(--surface-raised)]"
                style={{ background: "var(--status-complete)" }}
              >
                <CheckCircle2 size={11} className="text-white" strokeWidth={3} />
              </span>
            </div>

            <h2 className="mt-3.5 text-[14px] font-semibold text-[var(--text-primary)]">
              Download complete
            </h2>
            <p
              className="mt-1 max-w-full truncate text-[12.5px] text-[var(--text-secondary)]"
              title={finished.filename}
              data-selectable
            >
              {finished.filename}
            </p>
          </div>

          <dl className="mt-4 grid grid-cols-3 gap-2 rounded-[var(--radius-card)] bg-[var(--surface-sunken)] px-3 py-2.5 text-center">
            <Stat label="Size" value={formatBytes(finished.totalBytes)} />
            <Stat label="Took" value={formatDurationMs(finished.elapsedMs)} />
            <Stat
              label="Average"
              value={average > 0 ? formatSpeed(average) : "—"}
            />
          </dl>

          <p
            className="mt-2.5 truncate text-center text-[11px] text-[var(--text-tertiary)]"
            title={path}
            data-selectable
          >
            {finished.destDir}
          </p>
        </div>

        <div className="flex gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-5 py-3">
          <Button
            variant="primary"
            className="flex-1"
            icon={<Play size={14} />}
            onClick={() => {
              void run("Could not open the file", () => api.openPath(path));
              dismiss();
            }}
          >
            Open
          </Button>
          <Button
            className="flex-1"
            icon={<FolderOpen size={14} />}
            onClick={() => {
              void run("Could not open the folder", () => api.revealPath(path));
              dismiss();
            }}
          >
            Show in folder
          </Button>
          <Button
            aria-label={copied ? "Copied" : "Copy source link"}
            title={copied ? "Copied" : "Copy source link"}
            icon={<Copy size={14} />}
            onClick={() => {
              void writeText(finished.url).then(
                () => setCopied(true),
                () => toast({ tone: "error", title: "Could not copy the link" }),
              );
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] tracking-wide text-[var(--text-tertiary)] uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 text-[12px] font-medium tabular-nums text-[var(--text-primary)]">
        {value}
      </dd>
    </div>
  );
}

function filePath(item: DownloadItem): string {
  const dir = item.destDir.replace(/[\\/]+$/, "");
  return `${dir}\\${item.filename}`;
}

/** Exported so the row and the dialog agree on how a path is assembled. */
export { filePath, hostOf };
