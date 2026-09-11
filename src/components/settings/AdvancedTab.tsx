/**
 * The dials that change how requests are made, plus the one limit that is not
 * a preference at all.
 */

import { Info, RotateCcw } from "lucide-react";
import { Button, Field, Row } from "../ui";
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
