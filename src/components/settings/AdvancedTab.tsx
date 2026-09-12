/**
 * The dials that change how requests are made, plus the one limit that is not
 * a preference at all.
 */

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ClipboardCopy, FolderOpen, Info, RotateCcw, ScrollText } from "lucide-react";
import { useState } from "react";
import * as api from "../../lib/api";
import { Button, Field, Row } from "../ui";
import { useApp } from "../../store/app";
import type { Settings } from "../../lib/types";
import {
  DraftInput,
  Group,
  Note,
  Setting,
  current,
  numberCommit,
  patch,
} from "./kit";

/**
 * The log controls.
 *
 * Downpour runs unattended in the tray, so when something goes wrong the user
 * is almost never watching. The log is the only record of why, and these two
 * buttons are the difference between "it broke" and a report someone can act
 * on. Copy assembles version, OS, queue state, redacted settings and the recent
 * log into one block — the pairing token is never included.
 */
function DiagnosticsRow() {
  const run = useApp((s) => s.run);
  const toast = useApp((s) => s.toast);
  const [preview, setPreview] = useState<string | null>(null);

  return (
    <div className="py-2.5">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-[13px] text-[var(--text-primary)]">Application log</div>
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-tertiary)]">
            Downpour keeps a small rolling log beside its database — the last few
            days, then it prunes itself. It never leaves your machine, and the
            browser pairing token is redacted from it.
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          icon={<FolderOpen size={13} />}
          onClick={() => void run("Could not open the log folder", api.openLogFolder)}
        >
          Open log folder
        </Button>
        <Button
          size="sm"
          icon={<ClipboardCopy size={13} />}
          onClick={() =>
            void run("Could not copy diagnostics", async () => {
              const text = await api.copyDiagnostics();
              await writeText(text);
              toast({
                tone: "success",
                title: "Diagnostics copied",
                detail: "Paste it into a bug report. The pairing token is not included.",
              });
            })
          }
        >
          Copy diagnostics
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<ScrollText size={13} />}
          onClick={() =>
            preview !== null
              ? setPreview(null)
              : void run("Could not read the log", async () =>
                  setPreview((await api.readLogTail(200)) || "The log is empty."),
                )
          }
        >
          {preview !== null ? "Hide log" : "View recent log"}
        </Button>
      </div>

      {preview !== null && (
        <pre
          data-selectable
          className="dp-slide-down mt-2 max-h-64 overflow-auto rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]"
        >
          {preview}
        </pre>
      )}
    </div>
  );
}

export function AdvancedTab({ settings }: { settings: Settings }) {
  return (
    <>
      <Group id="advanced.network">
        <Setting id="advanced.network.userAgent">
          <div className="py-2.5">
            <Field
              label="User agent"
              hint="The name Downpour gives when it asks a server for a file. Plenty of hosts serve a different file — or nothing at all — to a client they do not recognise, so the default presents as an ordinary desktop browser. Change it only if a specific site needs something else."
            >
              <div className="flex gap-2">
                <DraftInput
                  value={settings.userAgent}
                  aria-label="User agent"
                  spellCheck={false}
                  style={{ fontSize: 11 }}
                  className="font-mono"
                  onCommit={async (raw) => {
                    // An empty string is the engine's "use the default"
                    // sentinel, so blanking the box restores the shipped
                    // value rather than sending no header at all.
                    await patch({ userAgent: raw });
                    return current("userAgent") ?? settings.userAgent;
                  }}
                />
                <Button
                  icon={<RotateCcw size={14} />}
                  title="Put the shipped user agent back"
                  onClick={() => void patch({ userAgent: "" })}
                >
                  Reset
                </Button>
              </div>
            </Field>
          </div>
        </Setting>

        <Setting id="advanced.network.timeout">
          <Row
            label="Request timeout"
            hint="Seconds to wait for a server to answer before treating the connection as dead. 5 to 3600. Raise it for servers that take a long time to start sending."
          >
            <DraftInput
              value={String(settings.requestTimeoutSecs)}
              aria-label="Request timeout in seconds"
              inputMode="numeric"
              style={{ width: 66 }}
              className="text-center tabular-nums"
              onCommit={numberCommit("requestTimeoutSecs", 5, 3600)}
            />
          </Row>
        </Setting>

        <Setting id="advanced.network.retries">
          <Row
            label="Retries per download"
            hint="How many times a stalled or failed transfer is picked up again before it gives up and shows as failed. 0 to 100. A retry resumes from where it stopped; it does not start the file over."
          >
            <DraftInput
              value={String(settings.maxRetries)}
              aria-label="Retries per download"
              inputMode="numeric"
              style={{ width: 66 }}
              className="text-center tabular-nums"
              onCommit={numberCommit("maxRetries", 0, 100)}
            />
          </Row>
        </Setting>
      </Group>

      <Group id="advanced.diagnostics">
        <Setting id="advanced.diagnostics.log">
          <DiagnosticsRow />
        </Setting>
      </Group>

      <Group id="advanced.limits">
        <Setting id="advanced.limits.ceiling">
          <div className="py-2.5">
            <Note icon={<Info size={13} />}>
              <p className="font-medium text-[var(--text-primary)]">
                Connections per download stops at 16.
              </p>
              <p className="mt-1.5">
                That is not caution. Past roughly this point servers stop
                cooperating: most either refuse the extra connections, split the
                same total bandwidth more ways, or start rate-limiting the whole
                transfer — so asking for 32 usually finishes later than asking
                for 8.
              </p>
              <p className="mt-1.5">
                It is a limit on how servers behave rather than a preference
                being withheld. Raising it would make Downpour slower, so there
                is no box to raise it in.
              </p>
            </Note>
          </div>
        </Setting>
      </Group>
    </>
  );
}
