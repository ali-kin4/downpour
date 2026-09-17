/**
 * Add a single download.
 *
 * Probes the URL as you type (debounced) so the real filename and size are
 * visible *before* committing. That preview is also where a user finds out the
 * server will not honour range requests, which explains why that particular
 * file downloads on one connection instead of eight.
 */

import { readText } from "@tauri-apps/plugin-clipboard-manager";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Link2,
  Play,
  Plus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { formatBytes } from "../lib/format";
import type { RemoteInfo, StartMode } from "../lib/types";
import { useApp } from "../store/app";
import { DuplicateNotice } from "./DuplicateNotice";
import { looksLikeMediaPage, MediaSuggestion } from "./MediaDialog";
import { Button, Dialog, Field, FolderPicker, Segmented, Spinner, TextArea, TextInput } from "./ui";

const PROBE_DEBOUNCE_MS = 550;

export function AddDialog() {
  const open = useApp((s) => s.addOpen);
  const pending = useApp((s) => s.pendingAdd);
  const setPendingAdd = useApp((s) => s.setPendingAdd);
  const setOpen = useApp((s) => s.setAddOpen);
  const settings = useApp((s) => s.settings);
  const run = useApp((s) => s.run);
  const toast = useApp((s) => s.toast);

  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [destDir, setDestDir] = useState("");
  const [startMode, setStartMode] = useState<StartMode>("start");
  const [connections, setConnections] = useState<number | "">("");
  const [headersText, setHeadersText] = useState("");
  const [checksum, setChecksum] = useState("");
  const [advanced, setAdvanced] = useState(false);

  const close = () => {
    setPendingAdd(null);
    setOpen(false);
  };

  const [duplicate, setDuplicate] = useState<api.DuplicateInfo | null>(null);
  const [dismissedDuplicate, setDismissedDuplicate] = useState(false);
  const [probe, setProbe] = useState<RemoteInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset on open, and pre-fill from the clipboard when it holds a URL. This
  // is the single biggest time-saver in the whole app: the link is almost
  // always already copied.
  useEffect(() => {
    if (!open) return;
    setUrl("");
    setFilename("");
    setDestDir("");
    setStartMode(settings?.scheduleNewDownloads ? "schedule" : "start");
    setConnections("");
    setHeadersText("");
    setChecksum("");
    setAdvanced(false);
    setProbe(null);
    setProbeError(null);
    setDuplicate(null);
    setDismissedDuplicate(false);

    // A download the browser handed over already knows everything the
    // clipboard could have guessed at, and carries the session that makes it
    // work. Reading the clipboard over the top of it would be worse than
    // useless -- it would replace the URL that is actually being asked about.
    if (pending) {
      setUrl(pending.url);
      if (pending.filename) setFilename(pending.filename);
      if (pending.destDir) setDestDir(pending.destDir);
      const headers = Object.entries(pending.headers);
      if (headers.length > 0) {
        setHeadersText(headers.map(([k, v]) => `${k}: ${v}`).join("\n"));
      }
      return;
    }

    void readText().then(
      (text) => {
        const candidate = text?.trim() ?? "";
        if (/^https?:\/\/\S+$/i.test(candidate)) setUrl(candidate);
      },
      () => undefined,
    );
  }, [open, pending, settings?.downloadDir, settings?.scheduleNewDownloads]);

  // Debounced probe. The request id guards against an older, slower probe
  // landing after a newer one and overwriting the correct preview.
  const probeSeq = useRef(0);
  useEffect(() => {
    const trimmed = url.trim();
    setProbe(null);
    setProbeError(null);
    setDuplicate(null);
    setDismissedDuplicate(false);
    if (!/^https?:\/\/\S+$/i.test(trimmed)) return;

    const seq = ++probeSeq.current;
    setProbing(true);
    const timer = window.setTimeout(() => {
      api.probeUrl(trimmed, parseHeaders(headersText)).then(
        (info) => {
          if (seq !== probeSeq.current) return;
          setProbe(info);
          setProbing(false);
          void api
            .checkDuplicate(trimmed, info.suggestedFilename ?? null)
            .then((dup) => seq === probeSeq.current && setDuplicate(dup), () => undefined);
        },
        (e) => {
          if (seq !== probeSeq.current) return;
          setProbeError(api.errorMessage(e));
          setProbing(false);
        },
      );
    }, PROBE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      setProbing(false);
    };
  }, [url, headersText]);

  const valid = /^https?:\/\/\S+$/i.test(url.trim());

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    await run("Could not add the download", async () => {
      await api.addDownload({
        url: url.trim(),
        filename: filename.trim() || null,
        destDir: destDir.trim() || null,
        connections: connections === "" ? null : Number(connections),
        startMode,
        checksum: checksum.trim() || null,
        headers: parseHeaders(headersText),
        source: "ui",
      });
      toast({
        tone: "success",
        title: startMode === "start" ? "Download started" : "Added to the list",
      });
      close();
    });
    setSubmitting(false);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New download"
      subtitle="Paste a link. Downpour checks it before adding."
      width={580}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!valid || submitting}
            onClick={() => void submit()}
            icon={
              submitting ? (
                <Spinner size={13} />
              ) : startMode === "start" ? (
                <Play size={14} />
              ) : (
                <Plus size={14} />
              )
            }
          >
            {startMode === "start" ? "Download" : "Add to list"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Link">
          <div className="relative">
            <Link2
              size={13}
              className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-tertiary)]"
            />
            <TextInput
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              placeholder="https://example.com/file.zip"
              spellCheck={false}
              autoComplete="off"
              className="pl-8"
            />
          </div>
        </Field>

        <ProbePreview probing={probing} probe={probe} error={probeError} url={url} />

        {looksLikeMediaPage(url.trim()) && <MediaSuggestion url={url.trim()} />}

        {duplicate && !dismissedDuplicate && (
          <DuplicateNotice info={duplicate} onDismiss={() => setDismissedDuplicate(true)} />
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Save as" hint="Leave blank to use the server's filename.">
            <TextInput
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder={probe?.suggestedFilename ?? "Automatic"}
              spellCheck={false}
            />
          </Field>

          <Field
            label="Folder"
            hint={
              settings?.sortIntoCategories && !destDir
                ? "Sorted automatically by file type."
                : undefined
            }
          >
            <div className="flex gap-1.5">
              <TextInput
                value={destDir}
                onChange={(e) => setDestDir(e.target.value)}
                placeholder={
                  settings?.sortIntoCategories
                    ? "Automatic (by file type)"
                    : (settings?.downloadDir ?? "")
                }
                spellCheck={false}
              />
              <FolderPicker defaultPath={destDir} onPick={setDestDir} />
            </div>
          </Field>
        </div>

        <Field label="When to start">
          <Segmented<StartMode>
            value={startMode}
            onChange={setStartMode}
            options={[
              { value: "start", label: "Start now", icon: <Play size={12} /> },
              { value: "addonly", label: "Add only", icon: <Plus size={12} /> },
              {
                value: "schedule",
                label: "On schedule",
                icon: <CalendarClock size={12} />,
              },
            ]}
          />
        </Field>

        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="flex w-fit items-center gap-1 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          <ChevronDown
            size={13}
            className={advanced ? "rotate-180 transition-transform" : "transition-transform"}
          />
          Advanced
        </button>

        {advanced && (
          <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
            <Field
              label="Connections"
              hint={`Blank uses the global default (${settings?.maxConnectionsPerDownload ?? 8}). Capped at 16 — past that servers rate-limit rather than serve faster.`}
            >
              <TextInput
                type="number"
                min={1}
                max={16}
                value={connections}
                onChange={(e) =>
                  setConnections(e.target.value === "" ? "" : Number(e.target.value))
                }
                placeholder="Automatic"
              />
            </Field>

            <Field
              label="Request headers"
              hint="One per line, as Name: value. Needed for links behind a login."
            >
              <TextArea
                rows={3}
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                placeholder={"Cookie: session=…\nReferer: https://example.com/"}
                spellCheck={false}
              />
            </Field>

            <Field
              label="Expected SHA-256"
              hint="Verified before the file is moved into place. A mismatch fails the download instead of saving a corrupt file."
            >
              <TextInput
                value={checksum}
                onChange={(e) => setChecksum(e.target.value)}
                placeholder="sha256:… (optional)"
                spellCheck={false}
                className="font-mono text-[11px]"
              />
            </Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ProbePreview({
  probing,
  probe,
  error,
  url,
}: {
  probing: boolean;
  probe: RemoteInfo | null;
  error: string | null;
  url: string;
}) {
  if (!url.trim()) return null;

  if (probing) {
    return (
      <Info tone="neutral" icon={<Spinner size={13} />}>
        Checking the link…
      </Info>
    );
  }

  if (error) {
    return (
      <Info tone="error" icon={<AlertTriangle size={14} />}>
        <span className="font-medium">Could not reach this link.</span>{" "}
        <span className="text-[var(--text-secondary)]">{error}</span>
      </Info>
    );
  }

  if (!probe) return null;

  return (
    <Info tone="ok" icon={<CheckCircle2 size={14} />}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="font-medium text-[var(--text-primary)]">
          {probe.suggestedFilename ?? "Ready"}
        </span>
        <span className="text-[var(--text-secondary)]">
          {probe.size !== null ? formatBytes(probe.size) : "size unknown"}
        </span>
        <span className="text-[var(--text-tertiary)]">
          {probe.supportsRange
            ? "supports multi-connection"
            : "single connection only"}
        </span>
      </div>
      {!probe.supportsRange && (
        <p className="mt-1 text-[11px] leading-snug text-[var(--text-tertiary)]">
          This server will not serve byte ranges, so the file downloads on one
          connection and cannot be resumed if it drops.
        </p>
      )}
    </Info>
  );
}

function Info({
  tone,
  icon,
  children,
}: {
  tone: "ok" | "error" | "neutral";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const colour =
    tone === "ok"
      ? "var(--status-complete)"
      : tone === "error"
        ? "var(--status-failed)"
        : "var(--text-tertiary)";
  return (
    <div
      className="flex items-start gap-2 rounded-[var(--radius-card)] border px-3 py-2 text-[12px]"
      style={{
        borderColor: `color-mix(in srgb, ${colour} 30%, transparent)`,
        background: `color-mix(in srgb, ${colour} 7%, transparent)`,
      }}
    >
      <span style={{ color: colour }} className="mt-px shrink-0">
        {icon}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * Parses a `Name: value` block into a header map.
 *
 * Lenient by design: this field is normally filled by pasting from a browser's
 * network tab, and rejecting the whole block over one malformed line would be
 * infuriating. Bad lines are skipped.
 */
function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}
