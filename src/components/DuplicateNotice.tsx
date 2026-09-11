/**
 * "You already have this."
 *
 * Shown inside the Add dialog once the URL resolves, before anything is
 * queued. Three distinct cases, because lumping them together is what makes
 * this kind of warning useless:
 *
 * - it is **already in the list and still running** → go to it, do not add a
 *   second copy fighting the first for bandwidth;
 * - it was **downloaded before and the file is still there** → open it;
 * - it was **downloaded before and the file is gone** → just download it, and
 *   say why the warning appeared at all.
 *
 * The fourth case is a file already occupying the target name that Downpour has
 * no record of — usually a manual download — where the only honest thing to do
 * is say so and let the conflict policy pick the name.
 */

import { AlertTriangle, CheckCircle2, FolderOpen, Play, RotateCcw } from "lucide-react";
import * as api from "../lib/api";
import { FileTile } from "../lib/filetypes";
import { formatBytes, formatRelative } from "../lib/format";
import type { DownloadItem } from "../lib/types";
import { useApp } from "../store/app";
import { Button } from "./ui";

export function DuplicateNotice({
  info,
  onDismiss,
}: {
  info: api.DuplicateInfo;
  onDismiss: () => void;
}) {
  const run = useApp((s) => s.run);
  const setAddOpen = useApp((s) => s.setAddOpen);
  const select = useApp((s) => s.select);
  const setFilter = useApp((s) => s.setFilter);

  if (info.inProgress) {
    const item = info.inProgress;
    return (
      <Panel tone="var(--status-running)" icon={<RotateCcw size={14} />}>
        <Title>Already in your list</Title>
        <Body>
          <strong className="font-medium text-[var(--text-primary)]">{item.filename}</strong> is
          {item.status === "running" ? " downloading now" : ` ${statusWord(item)}`}. Adding it again
          would download the same file twice.
        </Body>
        <Actions>
          <Button
            size="sm"
            onClick={() => {
              setFilter("all");
              select(item.id, "replace");
              setAddOpen(false);
            }}
          >
            Go to it
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Add anyway
          </Button>
        </Actions>
      </Panel>
    );
  }

  if (info.previous) {
    const item = info.previous;
    const path = targetPath(item);

    if (!info.previousFileExists) {
      return (
        <Panel tone="var(--text-tertiary)" icon={<AlertTriangle size={14} />}>
          <Title>You downloaded this before</Title>
          <Body>
            Finished {formatRelative(item.completedAt)}, but the file is no longer at{" "}
            <span className="break-all">{item.destDir}</span>. Downloading it again is probably what
            you want.
          </Body>
          <Actions>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Got it
            </Button>
          </Actions>
        </Panel>
      );
    }

    return (
      <Panel tone="var(--status-complete)" icon={<CheckCircle2 size={14} />}>
        <Title>You already have this file</Title>
        <div className="mt-1.5 flex items-center gap-2.5 rounded-[var(--radius-control)] bg-[var(--surface-raised)] px-2.5 py-2">
          <FileTile filename={item.filename} size={28} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium text-[var(--text-primary)]">
              {item.filename}
            </div>
            <div className="truncate text-[10.5px] text-[var(--text-tertiary)]">
              {formatBytes(item.totalBytes)} · {formatRelative(item.completedAt)} · {item.destDir}
            </div>
          </div>
        </div>
        <Actions>
          <Button
            size="sm"
            variant="primary"
            icon={<Play size={13} />}
            onClick={() => {
              void run("Could not open the file", () => api.openPath(path));
              setAddOpen(false);
            }}
          >
            Open it
          </Button>
          <Button
            size="sm"
            icon={<FolderOpen size={13} />}
            onClick={() => {
              void run("Could not open the folder", () => api.revealPath(path));
              setAddOpen(false);
            }}
          >
            Show in folder
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Download again
          </Button>
        </Actions>
      </Panel>
    );
  }

  if (info.conflictingPath) {
    return (
      <Panel tone="var(--status-paused)" icon={<AlertTriangle size={14} />}>
        <Title>A file with that name is already there</Title>
        <Body>
          <span className="break-all">{info.conflictingPath}</span> exists but was not downloaded by
          Downpour. Your conflict setting decides what happens — by default the new file is saved
          alongside it as <em>name (1)</em>.
        </Body>
        <Actions>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Continue
          </Button>
        </Actions>
      </Panel>
    );
  }

  return null;
}

function statusWord(item: DownloadItem): string {
  switch (item.status) {
    case "paused":
      return "paused partway through";
    case "queued":
      return "waiting in the queue";
    case "scheduled":
      return "waiting for its scheduled window";
    case "idle":
      return "in your list, not started";
    default:
      return "in your list";
  }
}

function targetPath(item: DownloadItem): string {
  return `${item.destDir.replace(/[\\/]+$/, "")}\\${item.filename}`;
}

function Panel({
  tone,
  icon,
  children,
}: {
  tone: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-[var(--radius-card)] border px-3 py-2.5"
      style={{
        borderColor: `color-mix(in srgb, ${tone} 32%, transparent)`,
        background: `color-mix(in srgb, ${tone} 7%, transparent)`,
      }}
    >
      <div className="flex items-start gap-2">
        <span className="mt-px shrink-0" style={{ color: tone }}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[12.5px] font-semibold text-[var(--text-primary)]">{children}</div>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--text-secondary)]">{children}</p>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 flex flex-wrap gap-1.5">{children}</div>;
}
