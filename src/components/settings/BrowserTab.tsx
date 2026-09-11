/** The loopback listener the browser extension hands downloads to. */

import { useCallback, useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Copy, Eye, EyeOff, RefreshCw, TriangleAlert } from "lucide-react";
import { Badge, Button, Field, Row, Switch, TextInput } from "../ui";
import {
  errorMessage,
  getRpcInfo,
  noteClipboardCopy,
  regenerateRpcToken,
} from "../../lib/api";
import type { RpcInfo, Settings } from "../../lib/types";
import { useApp } from "../../store/app";
import { DraftInput, Group, Setting, numberCommit, patch } from "./kit";

export function BrowserTab({ settings }: { settings: Settings }) {
  const run = useApp((s) => s.run);
  const toast = useApp((s) => s.toast);
  const refreshSettings = useApp((s) => s.refreshSettings);

  const [rpc, setRpc] = useState<RpcInfo | null>(null);
  const [rpcError, setRpcError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setRpc(await getRpcInfo());
      setRpcError(null);
    } catch (e) {
      setRpc(null);
      setRpcError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const token = rpc?.token ?? settings.rpcToken;

  const copyToken = () =>
    void run("Could not copy the pairing token", async () => {
      await writeText(token);
      // Tell the clipboard watcher this text came from Downpour, so capture
      // never reacts to something the app itself put there.
      await noteClipboardCopy(token).catch(() => {});
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });

  const regenerate = () =>
    void run("Could not regenerate the pairing token", async () => {
      await regenerateRpcToken();
      // The command persists through `update_settings`, so the copy in the
      // store is stale until it is re-read.
      await refreshSettings();
      await load();
      setConfirmRegen(false);
      setRevealed(false);
      toast({
        tone: "success",
        title: "New pairing token issued",
        detail: "Paste it into the extension to pair again.",
      });
    });

  // `get_rpc_info` reports the port actually bound, and the listener scans
  // upwards from the configured port when it is busy — so the two can
  // legitimately differ, and only a restart reconciles them.
  const boundElsewhere = rpc?.listening === true && rpc.port !== settings.rpcPort;

  return (
    <Group
      id="browser.extension"
      description="Downpour listens on loopback so the extension can hand downloads over. Nothing is exposed off this machine."
    >
      <Setting id="browser.extension.enabled">
        <Row
          label="Accept downloads from the extension"
          hint="Turning this off stops the listener starting on the next launch."
        >
          <Switch
            checked={settings.rpcEnabled}
            label="Accept downloads from the extension"
            onChange={(v) =>
              void (async () => {
                await patch({ rpcEnabled: v });
                await load();
              })()
            }
          />
        </Row>
      </Setting>

      <Setting id="browser.extension.status">
        <div className="py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--text-primary)]">Status</span>
            {rpcError ? (
              <Badge>Unavailable</Badge>
            ) : rpc?.listening ? (
              <Badge tone="accent">Listening on 127.0.0.1:{rpc.port}</Badge>
            ) : (
              <Badge>Not listening</Badge>
            )}
          </div>
          <p className="mt-1 text-[11px] leading-snug text-[var(--text-tertiary)]">
            {rpcError
              ? `Could not read the listener state: ${rpcError}`
              : rpc?.listening
                ? "The extension can reach Downpour right now."
                : settings.rpcEnabled
                  ? "The listener is not bound. It only starts at launch, so restart Downpour — and if it still fails, another program is holding the port."
                  : "Browser integration is switched off, so nothing is listening."}
          </p>
        </div>
      </Setting>

      <Setting id="browser.extension.port">
        <div className="py-2.5">
          <Field
            label="Loopback port"
            hint="The listener binds once at startup. Changing the port here does nothing until Downpour is restarted."
          >
            <DraftInput
              value={String(settings.rpcPort)}
              aria-label="Loopback port"
              inputMode="numeric"
              style={{ width: 120 }}
              className="text-center tabular-nums"
              // Bounded to the u16 range only: the engine rejects anything
              // below 1024 by snapping back to its default, and that
              // correction is worth letting the user see.
              onCommit={numberCommit("rpcPort", 0, 65535)}
            />
          </Field>
          {boundElsewhere && (
            <p
              className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-snug"
              style={{ color: "var(--status-paused)" }}
            >
              <TriangleAlert size={12} className="mt-px shrink-0" />
              Currently bound to {rpc?.port}. Restart Downpour to move it to{" "}
              {settings.rpcPort}.
            </p>
          )}
        </div>
      </Setting>

      <Setting id="browser.extension.token">
        <div className="py-2.5">
          <Field
            label="Pairing token"
            hint="The shared secret the extension presents. Treat it like a password — anything that has it can queue downloads."
          >
            <div className="flex gap-2">
              <TextInput
                readOnly
                aria-label="Pairing token"
                value={revealed ? token : "•".repeat(32)}
                style={{ fontSize: 11 }}
                className="font-mono"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                aria-label={revealed ? "Hide the token" : "Reveal the token"}
                title={revealed ? "Hide the token" : "Reveal the token"}
                icon={revealed ? <EyeOff size={14} /> : <Eye size={14} />}
                onClick={() => setRevealed((v) => !v)}
              />
              <Button icon={<Copy size={14} />} onClick={copyToken}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </Field>
        </div>
      </Setting>

      <Setting id="browser.extension.regenerate">
        <div className="py-2.5">
          {confirmRegen ? (
            <div className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
              <p className="text-[12px] leading-snug text-[var(--text-primary)]">
                Issue a new pairing token?
              </p>
              <p className="mt-1 text-[11px] leading-snug text-[var(--text-tertiary)]">
                The current token stops working immediately. Any browser
                extension already paired with Downpour will be rejected until you
                paste the new token into it.
              </p>
              <div className="mt-2.5 flex gap-2">
                <Button variant="danger" onClick={regenerate}>
                  Regenerate and unpair
                </Button>
                <Button variant="ghost" onClick={() => setConfirmRegen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              icon={<RefreshCw size={14} />}
              onClick={() => setConfirmRegen(true)}
            >
              Regenerate token
            </Button>
          )}
        </div>
      </Setting>
    </Group>
  );
}
