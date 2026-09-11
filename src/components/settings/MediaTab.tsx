/**
 * yt-dlp: the helper that makes video pages downloadable.
 *
 * Nothing here implies the tool ships with Downpour, because it does not. The
 * copy names the program, names where the bytes come from, and says the file is
 * checked against the published SHA-256 before it is kept — someone agreeing to
 * fetch an executable deserves to know all three before they click.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Download, ShieldCheck, TriangleAlert } from "lucide-react";
import { Badge, Button, Spinner } from "../ui";
import * as api from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { Group, Note, Setting } from "./kit";

const PHASES: Record<api.YtDlpInstallProgress["phase"], string> = {
  resolving: "Looking up the latest release",
  checksum: "Reading the published checksum",
  downloading: "Downloading",
  verifying: "Checking the SHA-256",
  done: "Done",
};

export function MediaTab() {
  const [status, setStatus] = useState<api.YtDlpStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<api.YtDlpInstallProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const unlisten = useRef<UnlistenFn | null>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const s = await api.ytDlpStatus();
      // The browser-only dev harness answers unknown commands with `null`.
      setStatus(s ?? null);
      setStatusError(s ? null : "The media commands are not available.");
    } catch (e) {
      setStatus(null);
      setStatusError(api.errorMessage(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // An install left running when the dialog closes would keep pushing progress
  // into a dead listener; drop the subscription either way.
  useEffect(
    () => () => {
      unlisten.current?.();
      unlisten.current = null;
    },
    [],
  );

  const install = async () => {
    setInstalling(true);
    setInstallError(null);
    setProgress(null);
    unlisten.current = await api.onYtDlpInstallProgress(setProgress);
    try {
      setStatus(await api.installYtDlp());
      setStatusError(null);
    } catch (e) {
      setInstallError(api.errorMessage(e));
    } finally {
      unlisten.current?.();
      unlisten.current = null;
      setInstalling(false);
      setProgress(null);
    }
  };

  const installed = status?.installed === true;

  return (
    <Group
      id="media.ytdlp"
      description="Downloading from a video page means reading the page first to find the real media file. Downpour uses yt-dlp for that, and only for that."
    >
      <Setting id="media.ytdlp.status">
        <div className="flex flex-col gap-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--text-primary)]">yt-dlp</span>
            {checking ? (
              <Spinner size={13} />
            ) : statusError ? (
              <Badge>Unknown</Badge>
            ) : installed ? (
              <Badge tone="accent">
                {status?.version ? `Installed · ${status.version}` : "Installed"}
              </Badge>
            ) : (
              <Badge>Not installed</Badge>
            )}
          </div>

          {status?.path && (
            <p
              className="truncate font-mono text-[11px] text-[var(--text-tertiary)]"
              title={status.path}
            >
              {installed ? status.path : `Would be saved to ${status.path}`}
            </p>
          )}

          {statusError && (
            <Note tone="warn" icon={<TriangleAlert size={13} />}>
              Could not check for yt-dlp: {statusError}
            </Note>
          )}

          {status?.error && (
            <Note tone="warn" icon={<TriangleAlert size={13} />}>
              The file is there but will not run: {status.error}. Installing again
              replaces it.
            </Note>
          )}

          <Note icon={<ShieldCheck size={13} />}>
            yt-dlp is a separate open-source program, and Downpour does not
            include a copy of it. Installing downloads the official Windows build
            from yt-dlp&rsquo;s GitHub releases and checks the file against the
            SHA-256 published alongside it; if the two do not match, nothing is
            kept. It goes into Downpour&rsquo;s own app data folder and nothing
            else on the machine is changed.
          </Note>

          {installError && (
            <Note tone="warn" icon={<TriangleAlert size={13} />}>
              The install did not finish: {installError}
            </Note>
          )}

          {installing && progress ? (
            <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
              <Spinner size={13} />
              <span>
                {PHASES[progress.phase]}
                {progress.phase === "downloading" && progress.total
                  ? ` — ${formatBytes(progress.downloaded)} of ${formatBytes(progress.total)}`
                  : ""}
              </span>
            </div>
          ) : (
            <div>
              <Button
                variant={installed ? "secondary" : "primary"}
                icon={<Download size={14} />}
                disabled={installing || checking}
                onClick={() => void install()}
              >
                {installed
                  ? "Download the latest yt-dlp again"
                  : "Download and verify yt-dlp"}
              </Button>
            </div>
          )}
        </div>
      </Setting>
    </Group>
  );
}
