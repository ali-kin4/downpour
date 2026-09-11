/** Throughput: how many files at once, how many connections each, how fast. */

import { Minus, Plus } from "lucide-react";
import { Button, Field, Row } from "../ui";
import type { Settings } from "../../lib/types";
import {
  DraftInput,
  Group,
  Setting,
  numberCommit,
  patch,
  speedCommit,
  speedHint,
  speedToText,
} from "./kit";

/** `transfer::MAX_CONNECTIONS`; see the Advanced tab for why it is not higher. */
const MAX_CONNECTIONS = 16;

export function DownloadsTab({ settings }: { settings: Settings }) {
  const step = (delta: number) =>
    void patch({
      maxConcurrentDownloads: Math.min(
        32,
        Math.max(1, settings.maxConcurrentDownloads + delta),
      ),
    });

  return (
    <>
      <Group
        id="downloads.limits"
        description="Two different numbers. One is how many files move at the same time; the other is how many connections a single file is split across."
      >
        {/* The headline control: given a card of its own because "why are four
            things downloading at once" is the question this screen exists for. */}
        <Setting id="downloads.limits.concurrent">
          <div className="my-2.5 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-4">
            <div className="flex items-start justify-between gap-6">
              <div className="min-w-0">
                <h4 className="text-[13px] font-semibold text-[var(--text-primary)]">
                  Downloads at the same time
                </h4>
                <p className="mt-1 text-[11px] leading-snug text-[var(--text-tertiary)]">
                  Anything over this waits in the queue instead of competing for
                  the same connection. Set it to 1 to finish files one at a time.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="sm"
                  aria-label="One fewer at a time"
                  icon={<Minus size={14} />}
                  disabled={settings.maxConcurrentDownloads <= 1}
                  onClick={() => step(-1)}
                />
                <DraftInput
                  value={String(settings.maxConcurrentDownloads)}
                  aria-label="Maximum downloads at the same time"
                  inputMode="numeric"
                  style={{ width: 60, fontSize: 15 }}
                  className="text-center font-semibold tabular-nums"
                  onCommit={numberCommit("maxConcurrentDownloads", 1, 32)}
                />
                <Button
                  size="sm"
                  aria-label="One more at a time"
                  icon={<Plus size={14} />}
                  disabled={settings.maxConcurrentDownloads >= 32}
                  onClick={() => step(1)}
                />
              </div>
            </div>
          </div>
        </Setting>

        <Setting id="downloads.limits.connections">
          <Row
            label="Connections per download"
            hint={`1 to ${MAX_CONNECTIONS}. Splitting a file across connections is what makes it fast, but servers that do not support range requests ignore this and fetch the file in one piece.`}
          >
            <DraftInput
              value={String(settings.maxConnectionsPerDownload)}
              aria-label="Connections per download"
              inputMode="numeric"
              style={{ width: 66 }}
              className="text-center tabular-nums"
              onCommit={numberCommit(
                "maxConnectionsPerDownload",
                1,
                MAX_CONNECTIONS,
              )}
            />
          </Row>
        </Setting>
      </Group>

      <Group
        id="downloads.bandwidth"
        description="One cap shared by everything downloading at once, not a cap per file. Leave it empty to use whatever the connection will give."
      >
        <Setting id="downloads.bandwidth.speedLimit">
          <div className="py-2.5">
            <Field label="Speed limit">
              <DraftInput
                value={speedToText(settings.speedLimitBps)}
                aria-label="Global speed limit"
                placeholder="0 = unlimited"
                style={{ width: 190 }}
                onCommit={speedCommit("speedLimitBps")}
                hint={speedHint}
              />
            </Field>
          </div>
        </Setting>
      </Group>
    </>
  );
}
