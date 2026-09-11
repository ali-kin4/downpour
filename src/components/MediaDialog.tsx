/**
 * Media-page support: paste a video page URL, get the video.
 *
 * Downpour does not extract media URLs itself — yt-dlp does, and it is the
 * only thing that keeps up with how often sites change. This dialog is the
 * user-facing half of that arrangement:
 *
 *   1. Is yt-dlp installed? If not, say exactly what would be downloaded and
 *      from where, and install it only on an explicit click.
 *   2. Ask yt-dlp what the page offers.
 *   3. Let the user pick a quality.
 *   4. Resolve that choice to a direct URL **plus the headers it requires**,
 *      and hand it to Downpour's own segmented engine through the normal add
 *      path — so it downloads on many connections, resumes, and appears in
 *      the list like anything else.
 *
 * See `docs/media.md` for why the direct URL goes to our engine rather than
 * letting yt-dlp download, and why the format list is progressive-only by
 * default.
 */

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  Film,
  RefreshCw,
  ShieldCheck,
  User,
  VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as api from "../lib/api";
import { formatBytes, formatDuration } from "../lib/format";
import { useApp } from "../store/app";
import { Button, Dialog, Field, Segmented, Spinner } from "./ui";

// ---------------------------------------------------------------------------
// URL sniffing
// ---------------------------------------------------------------------------

/**
 * Sites where a page URL is almost never the media itself.
 *
 * Not exhaustive and not meant to be — yt-dlp supports well over a thousand
 * extractors. This list only decides whether Downpour *offers* the media route
 * up front; the generic path check below catches the rest, and the user can
 * always paste a page URL and be told plainly that it is not supported.
 */
const MEDIA_HOSTS = [
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "vimeo.com",
  "dailymotion.com",
  "twitch.tv",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "reddit.com",
  "soundcloud.com",
  "bandcamp.com",
  "bilibili.com",
  "nicovideo.jp",
  "rumble.com",
  "odysee.com",
  "streamable.com",
  "kick.com",
  "ted.com",
  "aparat.com",
  "vk.com",
  "coub.com",
];

/** Extensions that mean the link *is* the file, so the normal path is right. */
const DIRECT_FILE = /\.(mp4|mkv|webm|mov|avi|flv|m4v|mp3|m4a|flac|wav|ogg|opus|zip|7z|rar|exe|msi|iso|pdf|dmg|apk|tar|gz)$/i;

/** Paths that read like a video page on a site we do not have listed. */
const MEDIA_PATH = /(^|\/)(watch|video|videos|embed|clip|clips|episode|media)(\/|$)/i;

/**
 * Whether a URL looks like a *page containing* media rather than media itself.
 *
 * Deliberately a hint, not a gate: a false positive costs one dismissible
 * banner, and a false negative just means the user downloads the page's HTML
 * and wonders why.
 */
export function looksLikeMediaPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // A direct file link never needs yt-dlp, even on a known video host.
  if (DIRECT_FILE.test(parsed.pathname)) return false;

  const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
  if (MEDIA_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  return MEDIA_PATH.test(parsed.pathname);
}

// ---------------------------------------------------------------------------
// The one-line hook for the Add dialog
// ---------------------------------------------------------------------------

/**
 * The banner the Add dialog shows when a pasted link looks like a video page,
 * plus the dialog it opens. Self-contained on purpose: adding media support to
 * the Add dialog costs exactly one line there.
 */
export function MediaSuggestion({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  // Stable, so the dialog's Escape listener does not re-subscribe every render.
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <div
        className="flex items-center gap-2.5 rounded-[var(--radius-card)] border px-3 py-2"
        style={{
          borderColor: "color-mix(in srgb, var(--accent) 30%, transparent)",
          background: "color-mix(in srgb, var(--accent) 7%, transparent)",
        }}
      >
        <Film size={15} className="shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1 text-[12px] leading-snug text-[var(--text-secondary)]">
          <span className="font-medium text-[var(--text-primary)]">
            This looks like a video page.
          </span>{" "}
          Downpour can read it and download the video itself instead of the page.
        </div>
        <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
          Get video
        </Button>
      </div>
      <MediaDialog url={url} open={open} onClose={close} />
    </>
  );
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

type Quality = "progressive" | "all";

export function MediaDialog({
  url,
  open,
  onClose,
}: {
  url: string;
  open: boolean;
  onClose: () => void;
}) {
  const run = useApp((s) => s.run);
  const toast = useApp((s) => s.toast);
  const setAddOpen = useApp((s) => s.setAddOpen);

  const [tool, setTool] = useState<api.YtDlpStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [install, setInstall] = useState<api.YtDlpInstallProgress | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const [info, setInfo] = useState<api.MediaInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const [quality, setQuality] = useState<Quality>("progressive");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const probe = useCallback(async () => {
    setProbing(true);
    setProbeError(null);
    setInfo(null);
    try {
      const result = await api.probeMedia(url);
      setInfo(result);
    } catch (e) {
      // yt-dlp's own stderr, verbatim. It is usually a plain-English reason
      // ("Video unavailable", "Sign in to confirm your age") and paraphrasing
      // it into "probe failed" would throw away the only useful information.
      setProbeError(api.errorMessage(e));
    } finally {
      setProbing(false);
    }
  }, [url]);

  // Reset and start over every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setInfo(null);
    setProbeError(null);
    setInstall(null);
    setInstallError(null);
    setSelectedId(null);
    setQuality("progressive");

    void api.ytDlpStatus().then(
      (status) => {
        if (cancelled) return;
        setTool(status);
        if (status.installed) void probe();
      },
      (e) => !cancelled && setProbeError(api.errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [open, probe]);

  // Escape must close only the topmost dialog. Both this dialog and the Add
  // dialog behind it trap Escape on `document`; capture order is window before
  // document, so intercepting here stops *both* of those handlers — which
  // means this listener has to do the closing itself. Only Escape is taken;
  // Tab still reaches each dialog's own focus trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const startInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    setInstall(null);
    const unlisten = await api.onYtDlpInstallProgress(setInstall);
    try {
      const status = await api.installYtDlp();
      setTool(status);
      void probe();
    } catch (e) {
      setInstallError(api.errorMessage(e));
    } finally {
      unlisten();
      setInstalling(false);
    }
  };

  // Progressive formats are the ones with both picture and sound in a single
  // stream. Everything else would need ffmpeg to mux, which Downpour does not
  // ship, so showing them by default would mean routinely handing someone a
  // silent video. HLS/DASH playlists are excluded too: they are manifests, not
  // files, and a byte-range engine cannot fetch them at all.
  const visible = useMemo(() => {
    const all = info?.formats ?? [];
    return quality === "all" ? all : all.filter((f) => f.progressive && f.directHttp);
  }, [info, quality]);

  // Keep the selection valid as the filter changes.
  useEffect(() => {
    if (visible.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) =>
      current && visible.some((f) => f.formatId === current)
        ? current
        : (visible[0]?.formatId ?? null),
    );
  }, [visible]);

  const chosen = visible.find((f) => f.formatId === selectedId) ?? null;

  const download = async () => {
    if (!chosen || submitting) return;
    setSubmitting(true);
    await run("Could not add the video", async () => {
      // Resolved fresh at the moment of the click: the URLs most sites hand
      // out are signed and expire while the user is still choosing.
      const resolved = await api.resolveMedia(url, chosen.formatId);
      await api.addDownload({
        url: resolved.url,
        // Without these the CDN answers 403, not a slow download.
        headers: resolved.headers,
        filename: resolved.filename,
        startMode: "start",
        source: "media",
      });
      toast({
        tone: "success",
        title: "Download started",
        detail: resolved.filename,
      });
      onClose();
      setAddOpen(false);
    });
    setSubmitting(false);
  };

  const canDownload = Boolean(chosen?.directHttp) && !submitting && !probing;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Download from a video page"
      subtitle={info?.extractor ? `Read by yt-dlp (${info.extractor})` : "Powered by yt-dlp"}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!canDownload}
            onClick={() => void download()}
            icon={submitting ? <Spinner size={13} /> : <Download size={14} />}
          >
            Download
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!tool ? (
          <Notice tone="neutral" icon={<Spinner size={13} />}>
            Checking for yt-dlp…
          </Notice>
        ) : !tool.installed ? (
          <InstallPanel
            status={tool}
            installing={installing}
            progress={install}
            error={installError}
            onInstall={() => void startInstall()}
          />
        ) : null}

        {tool?.installed && probing && (
          <Notice tone="neutral" icon={<Spinner size={13} />}>
            Reading the page with yt-dlp {tool.version ?? ""}…
          </Notice>
        )}

        {tool?.installed && probeError && (
          <Notice tone="error" icon={<AlertTriangle size={14} />}>
            <div className="font-medium">yt-dlp could not read this page.</div>
            <pre className="mt-1 max-h-32 overflow-auto font-mono text-[11px] leading-snug whitespace-pre-wrap text-[var(--text-secondary)]">
              {probeError}
            </pre>
            <div className="mt-2 flex gap-2">
              <Button size="sm" icon={<RefreshCw size={12} />} onClick={() => void probe()}>
                Try again
              </Button>
            </div>
          </Notice>
        )}

        {info && (
          <>
            <MediaHeader info={info} />

            {info.isLive && (
              <Notice tone="warn" icon={<AlertTriangle size={14} />}>
                This is a live stream. It has no fixed length, so it cannot be
                segmented or resumed — and it will not stop on its own.
              </Notice>
            )}

            <Field
              label="Quality"
              hint={
                quality === "progressive"
                  ? "Only formats that already contain both video and audio. Downpour fetches these directly, at full speed."
                  : "Every format yt-dlp reported, including audio-only and video-only streams."
              }
            >
              <Segmented<Quality>
                value={quality}
                onChange={setQuality}
                options={[
                  { value: "progressive", label: "Video with sound" },
                  { value: "all", label: "All formats" },
                ]}
              />
            </Field>

            {visible.length === 0 ? (
              <Notice tone="warn" icon={<VolumeX size={14} />}>
                This site only offers separate video and audio streams, so there
                is nothing here Downpour can download with sound in one file.
                Combining them needs ffmpeg, which Downpour does not bundle —
                switch to <span className="font-medium">All formats</span> above
                to take a video-only or audio-only stream instead.
              </Notice>
            ) : (
              <div
                role="radiogroup"
                aria-label="Quality"
                className="flex max-h-56 flex-col gap-1 overflow-y-auto"
              >
                {visible.map((format) => (
                  <FormatRow
                    key={format.formatId}
                    format={format}
                    selected={format.formatId === selectedId}
                    onSelect={() => setSelectedId(format.formatId)}
                  />
                ))}
              </div>
            )}

            {chosen && <ChosenNotice format={chosen} />}
          </>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function MediaHeader({ info }: { info: api.MediaInfo }) {
  const [thumbBroken, setThumbBroken] = useState(false);

  return (
    <div className="flex gap-3">
      <div
        className="flex h-[68px] w-[120px] shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)]"
        aria-hidden={!info.thumbnail || thumbBroken}
      >
        {info.thumbnail && !thumbBroken ? (
          <img
            src={info.thumbnail}
            alt=""
            className="h-full w-full object-cover"
            // A remote thumbnail is decoration. If the content-security
            // policy or the network blocks it, fall back rather than leaving
            // a broken-image icon in the middle of the dialog.
            onError={() => setThumbBroken(true)}
          />
        ) : (
          <Film size={20} className="text-[var(--text-tertiary)]" />
        )}
      </div>

      <div className="flex min-w-0 flex-col justify-center gap-1">
        <div
          className="text-[13px] leading-snug font-semibold text-[var(--text-primary)]"
          title={info.title}
        >
          {info.title}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-tertiary)]">
          {info.uploader && (
            <span className="inline-flex items-center gap-1">
              <User size={11} />
              {info.uploader}
            </span>
          )}
          {info.durationSecs !== null && (
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Clock size={11} />
              {formatDuration(info.durationSecs)}
            </span>
          )}
          <span>{info.formats.length} formats</span>
        </div>
      </div>
    </div>
  );
}

function FormatRow({
  format,
  selected,
  onSelect,
}: {
  format: api.MediaFormat;
  selected: boolean;
  onSelect: () => void;
}) {
  const size =
    format.filesize === null
      ? "size unknown"
      : format.filesizeIsEstimate
        ? `about ${formatBytes(format.filesize)}`
        : formatBytes(format.filesize);

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] border px-2.5 py-2 text-left transition-colors duration-150"
      style={{
        borderColor: selected ? "var(--border-focus)" : "var(--border-subtle)",
        background: selected ? "var(--surface-selected)" : "var(--surface-raised)",
      }}
    >
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: selected ? "var(--accent)" : "var(--border-strong)" }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-[var(--text-primary)]">
          {format.label}
        </span>
        {format.note && (
          <span className="block truncate text-[11px] text-[var(--text-tertiary)]">
            {format.note}
          </span>
        )}
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-secondary)]">
        {size}
      </span>
    </button>
  );
}

/**
 * The honesty line. A user who picks a video-only stream is going to get a
 * file with no sound, and they must be told that before the download starts,
 * not after they open it.
 */
function ChosenNotice({ format }: { format: api.MediaFormat }) {
  if (!format.directHttp) {
    return (
      <Notice tone="error" icon={<AlertTriangle size={14} />}>
        This format is a streaming playlist
        {format.protocol ? ` (${format.protocol})` : ""}, not a single file.
        Downpour downloads files by byte range and cannot assemble a playlist,
        so this one cannot be fetched. Pick a different quality.
      </Notice>
    );
  }

  if (!format.progressive) {
    const videoOnly = Boolean(format.vcodec);
    return (
      <Notice tone="warn" icon={<VolumeX size={14} />}>
        {videoOnly ? (
          <>
            This is a <span className="font-medium">video-only</span> stream. The
            file will have <span className="font-medium">no sound</span> —
            combining it with an audio stream needs ffmpeg, which Downpour does
            not bundle.
          </>
        ) : (
          <>
            This is an <span className="font-medium">audio-only</span> stream.
            The file will have no picture.
          </>
        )}
      </Notice>
    );
  }

  return (
    <Notice tone="ok" icon={<CheckCircle2 size={14} />}>
      Video and audio in one file. Downpour fetches it directly on multiple
      connections, so it downloads at full speed and can be paused and resumed.
    </Notice>
  );
}

/**
 * The install offer.
 *
 * It names the tool, the exact source and the exact destination *before* the
 * button, because this is the one place where the app reaches out and puts an
 * executable on someone's machine. Nothing here happens automatically.
 */
function InstallPanel({
  status,
  installing,
  progress,
  error,
  onInstall,
}: {
  status: api.YtDlpStatus;
  installing: boolean;
  progress: api.YtDlpInstallProgress | null;
  error: string | null;
  onInstall: () => void;
}) {
  const pct =
    progress && progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
      <div className="flex items-start gap-2">
        <ShieldCheck size={15} className="mt-px shrink-0 text-[var(--accent)]" />
        <div className="text-[12px] leading-snug text-[var(--text-secondary)]">
          <div className="font-medium text-[var(--text-primary)]">
            Reading video pages needs yt-dlp.
          </div>
          <p className="mt-1">
            Downpour does not bundle it. With your go-ahead it will download{" "}
            <span className="font-mono text-[11px] text-[var(--text-primary)]">
              yt-dlp.exe
            </span>{" "}
            from the official yt-dlp releases on GitHub (
            <span className="font-mono text-[11px]">github.com/yt-dlp/yt-dlp</span>
            ) and check it against the SHA-256 checksum published in that same
            release before using it.
          </p>
          <p className="mt-1.5">
            It is saved to{" "}
            <span className="font-mono text-[11px] break-all text-[var(--text-primary)]">
              {status.path}
            </span>{" "}
            and nowhere else. Delete that file to remove it.
          </p>
          {status.error && (
            <p className="mt-1.5 text-[var(--status-failed)]">
              A copy is already there but will not run: {status.error}
            </p>
          )}
        </div>
      </div>

      {installing && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
            <Spinner size={13} />
            <span className="min-w-0 flex-1 truncate">
              {progress?.message ?? "Starting…"}
            </span>
            {pct !== null && <span className="tabular-nums">{pct}%</span>}
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-[var(--border-subtle)]">
            <div
              className="h-full rounded-full transition-[width] duration-200"
              style={{
                width: pct === null ? "35%" : `${pct}%`,
                background: "var(--accent)",
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <Notice tone="error" icon={<AlertTriangle size={14} />}>
          <div className="font-medium">yt-dlp was not installed.</div>
          <div className="mt-0.5 text-[var(--text-secondary)]">{error}</div>
        </Notice>
      )}

      {!installing && (
        <Button variant="primary" className="w-fit" onClick={onInstall}>
          Download yt-dlp from GitHub
        </Button>
      )}
    </div>
  );
}

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "ok" | "warn" | "error" | "neutral";
  icon: ReactNode;
  children: ReactNode;
}) {
  const colour =
    tone === "ok"
      ? "var(--status-complete)"
      : tone === "warn"
        ? "var(--status-paused)"
        : tone === "error"
          ? "var(--status-failed)"
          : "var(--text-tertiary)";
  return (
    <div
      className="flex items-start gap-2 rounded-[var(--radius-card)] border px-3 py-2 text-[12px] leading-snug"
      style={{
        borderColor: `color-mix(in srgb, ${colour} 30%, transparent)`,
        background: `color-mix(in srgb, ${colour} 7%, transparent)`,
      }}
    >
      <span style={{ color: colour }} className="mt-px shrink-0">
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
