/**
 * Clipboard monitoring, and the floating progress panel.
 *
 * Clipboard capture is the feature most likely to feel intrusive, so the copy
 * here says plainly what is read, when, and what happens to it — and the live
 * preview lets someone see exactly what would be taken before switching it on,
 * rather than finding out by copying a link and watching a download start.
 */

import { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, RefreshCw, TriangleAlert } from "lucide-react";
import { Badge, Button, Field, Row, Switch } from "../ui";
import * as api from "../../lib/api";
import type { Settings } from "../../lib/types";
import { DraftInput, Group, Note, Setting, current, patch } from "./kit";

export function CaptureTab({ settings }: { settings: Settings }) {
  return (
    <>
      <Group
        id="capture.clipboard"
        description="Downpour can watch what you copy and pick out download links. Only text is read, only while this is on, and nothing leaves your machine."
      >
        <Setting id="capture.clipboard.watch">
          <Row
            label="Watch the clipboard for links"
            hint="Off by default. While it is on, Downpour checks the clipboard about once a second and offers any links it finds. It skips anything Downpour itself copied, and never offers the same text twice."
          >
            <Switch
              checked={settings.clipboardWatch}
              label="Watch the clipboard for links"
              onChange={(v) => void patch({ clipboardWatch: v })}
            />
          </Row>
        </Setting>

        <Setting id="capture.clipboard.autoAdd">
          <Row
            label="Start captured links without asking"
            hint="Copied links go straight into the queue and begin downloading. Nothing prompts first, so every matching link you copy becomes a file on disk. Leave this off to get a notification you can ignore instead."
          >
            <Switch
              checked={settings.clipboardAutoAdd}
              disabled={!settings.clipboardWatch}
              label="Start captured links without asking"
              onChange={(v) => void patch({ clipboardAutoAdd: v })}
            />
          </Row>
        </Setting>

        <Setting id="capture.clipboard.extensions">
          <div className="py-2.5">
            <Field
              label="Only capture these file types"
              hint="Separate them with commas. Leave it empty to capture every link. Anything after a “?” in the address is ignored, so a signed link still matches."
            >
              <DraftInput
                value={settings.clipboardExtensions.join(", ")}
                aria-label="File types to capture"
                placeholder="zip, iso, mp4 — empty means every link"
                spellCheck={false}
                style={{ width: 320 }}
                onCommit={async (raw) => {
                  const list = Array.from(
                    new Set(
                      raw
                        .split(/[\s,;]+/)
                        .map((s) => s.trim().replace(/^\.+/, "").toLowerCase())
                        .filter(Boolean),
                    ),
                  );
                  await patch({ clipboardExtensions: list });
                  return (current("clipboardExtensions") ?? list).join(", ");
                }}
              />
            </Field>
          </div>
        </Setting>

        <Setting id="capture.clipboard.preview">
          <div className="py-2.5">
            <ClipboardPreview filter={settings.clipboardExtensions.join(",")} />
          </div>
        </Setting>
      </Group>
    </>
  );
}

/**
 * What is on the clipboard right now, run through the same filter the watcher
 * uses.
 *
 * The backend does the extracting and the matching, so this is what would
 * actually be captured rather than a second parser's opinion of it. It re-runs
 * when the extension filter changes, which is the fastest way to see whether a
 * filter you just typed does what you meant.
 */
function ClipboardPreview({ filter }: { filter: string }) {
  const [urls, setUrls] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const found = await api.readClipboardUrls();
      // The browser-only dev harness answers unknown commands with `null`.
      setUrls(Array.isArray(found) ? found : []);
      setError(null);
    } catch (e) {
      setUrls(null);
      setError(api.errorMessage(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check, filter]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-[var(--text-primary)]">
            On the clipboard now
          </span>
          {urls && urls.length > 0 && <Badge tone="accent">{urls.length}</Badge>}
        </div>
        <Button
          size="sm"
          icon={<RefreshCw size={13} />}
          disabled={checking}
          onClick={() => void check()}
        >
          Check clipboard now
        </Button>
      </div>

      {error ? (
        <Note tone="warn" icon={<TriangleAlert size={13} />}>
          Could not read the clipboard: {error}
        </Note>
      ) : urls === null ? (
        <Note icon={<ClipboardCheck size={13} />}>
          Copy a link, then press Check clipboard now.
        </Note>
      ) : urls.length === 0 ? (
        <Note icon={<ClipboardCheck size={13} />}>
          Nothing on the clipboard would be captured. Either there is no link on
          it, or the link does not match the file types above.
        </Note>
      ) : (
        <div className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2.5">
          <ul className="flex flex-col gap-1">
            {urls.slice(0, 5).map((u) => (
              <li
                key={u}
                title={u}
                className="truncate font-mono text-[11px] text-[var(--text-secondary)]"
              >
                {u}
              </li>
            ))}
          </ul>
          {urls.length > 5 && (
            <p className="mt-1.5 text-[11px] text-[var(--text-tertiary)]">
              and {urls.length - 5} more
            </p>
          )}
        </div>
      )}
    </div>
  );
}
