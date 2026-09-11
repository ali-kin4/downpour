/**
 * The settings dialog.
 *
 * Two rules shape everything here:
 *
 *  1. There is no Save button. Toggles and segmented controls commit on click;
 *     free text commits after a short pause. A settings screen you can leave in
 *     an unsaved state is a settings screen that lies about the app's state.
 *  2. Every control renders from the store, never from local state. The engine
 *     clamps on save (`Settings::normalise`) and `saveSettings` puts the
 *     clamped result back, so typing 99 into a field capped at 32 has to be
 *     seen snapping back to 32 rather than sitting there looking accepted.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Bell,
  Copy,
  Eye,
  EyeOff,
  Folder,
  Gauge,
  Globe,
  Laptop,
  Minus,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Sun,
  TriangleAlert,
} from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  Field,
  Kbd,
  Row,
  Section,
  Segmented,
  Switch,
  TextInput,
} from "./ui";
import { ScheduleEditor } from "./ScheduleEditor";
import { errorMessage, getRpcInfo, regenerateRpcToken } from "../lib/api";
import { formatBytes, formatSpeed, parseSpeed } from "../lib/format";
import type {
  ConflictPolicy,
  OnQueueComplete,
  RpcInfo,
  Settings,
} from "../lib/types";
import { useApp } from "../store/app";

type TabId =
  | "general"
  | "downloads"
  | "scheduler"
  | "browser"
  | "notifications"
  | "system";

const TABS: { id: TabId; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <Folder size={14} /> },
  { id: "downloads", label: "Downloads", icon: <Gauge size={14} /> },
  { id: "scheduler", label: "Scheduler", icon: <Moon size={14} /> },
  { id: "browser", label: "Browser", icon: <Globe size={14} /> },
  { id: "notifications", label: "Notifications", icon: <Bell size={14} /> },
  { id: "system", label: "System", icon: <Monitor size={14} /> },
];

/**
 * Applies a partial change and resolves once the store holds the engine's
 * answer, so a caller can read the clamped value straight back afterwards.
 *
 * Reads the current settings from the store rather than closing over them:
 * a debounced commit fires long after its render, and two fields committing
 * near each other must not overwrite one another with a stale snapshot.
 */
async function patch(p: Partial<Settings>): Promise<void> {
  const { settings, saveSettings } = useApp.getState();
  if (!settings) return;
  await saveSettings({ ...settings, ...p });
}

/** The freshest value of one field, for redisplay after a save. */
function current<K extends keyof Settings>(key: K): Settings[K] | undefined {
  return useApp.getState().settings?.[key];
}

// ---------------------------------------------------------------------------
// Debounced text entry
// ---------------------------------------------------------------------------

/**
 * A text field that commits after a pause and then re-reads what was actually
 * stored.
 *
 * The re-read is unconditional rather than keyed on the incoming `value`
 * changing, and that is the whole point: when the engine clamps 99 back to the
 * 32 it already held, the canonical value never changes, so an effect watching
 * it would never fire and the box would keep showing 99. Pulling the string
 * back after every commit is what makes the clamp visible.
 */
function DraftInput({
  value,
  onCommit,
  hint,
  delay = 400,
  ...rest
}: {
  /** Canonical text, derived from the store. */
  value: string;
  /** Commits `raw` and resolves with the text to display afterwards. */
  onCommit: (raw: string) => Promise<string>;
  /** Live feedback on what the current text means, before it is committed. */
  hint?: (draft: string) => ReactNode;
  delay?: number;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "onBlur"
>) {
  const [draft, setDraft] = useState(value);
  // Edit / settled counters rather than a boolean: a commit that resolves after
  // the user has typed again must not stomp on the newer text.
  const edits = useRef(0);
  const settled = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    // Adopt an external change only while nothing local is pending.
    if (edits.current === settled.current) setDraft(value);
  }, [value]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const flush = useCallback(async (raw: string) => {
    window.clearTimeout(timer.current);
    const mine = edits.current;
    const text = await commitRef.current(raw);
    if (edits.current !== mine) return;
    settled.current = mine;
    setDraft(text);
  }, []);

  return (
    <>
      <TextInput
        {...rest}
        value={draft}
        onChange={(e) => {
          const raw = e.target.value;
          edits.current += 1;
          setDraft(raw);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void flush(raw), delay);
        }}
        onBlur={() => {
          if (edits.current !== settled.current) void flush(draft);
        }}
      />
      {hint && (
        <p className="text-[11px] leading-snug text-[var(--text-tertiary)]">
          {hint(draft)}
        </p>
      )}
    </>
  );
}

/**
 * Commit handler for a whole-number setting.
 *
 * The bounds are applied locally as well as by the engine. The engine is the
 * authority, but it takes unsigned integers over IPC, so a stray "-1" would
 * fail deserialisation and surface as an error toast instead of a clamp.
 */
function numberCommit<K extends keyof Settings>(key: K, min: number, max: number) {
  return async (raw: string): Promise<string> => {
    const n = Number(raw.trim());
    if (raw.trim() === "" || !Number.isFinite(n)) return String(current(key) ?? "");
    const clamped = Math.min(max, Math.max(min, Math.round(n)));
    await patch({ [key]: clamped } as Partial<Settings>);
    return String(current(key) ?? clamped);
  };
}

type SpeedKey = "speedLimitBps" | "scheduledSpeedLimitBps";

/** Empty box means unlimited, matching the engine's `0`. */
function speedToText(bps: number | undefined): string {
  return bps ? formatBytes(bps) : "";
}

function speedCommit(key: SpeedKey) {
  return async (raw: string): Promise<string> => {
    const parsed = parseSpeed(raw);
    // `null` is unparseable; `0` is a legitimate "unlimited".
    if (parsed === null) return speedToText(current(key) as number | undefined);
    await patch({ [key]: parsed });
    return speedToText(current(key) as number | undefined);
  };
}

function speedHint(draft: string): ReactNode {
  const parsed = parseSpeed(draft);
  if (parsed === null) return "Not a speed — try 2 MB, 500k, or 0 for unlimited.";
  if (parsed === 0) return "Unlimited.";
  return `Capped at ${formatSpeed(parsed)}.`;
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function SettingsDialog() {
  const settingsOpen = useApp((s) => s.settingsOpen);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const settings = useApp((s) => s.settings);
  const [tab, setTab] = useState<TabId>("general");

  const close = useCallback(() => setSettingsOpen(false), [setSettingsOpen]);

  return (
    <Dialog
      open={settingsOpen && settings !== null}
      onClose={close}
      title="Settings"
      subtitle="Changes take effect immediately."
      width={720}
      footer={
        <>
          <span className="mr-auto flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
            Saved automatically · <Kbd>Esc</Kbd> to close
          </span>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      {settings && (
        <div className="flex gap-5">
          {/* Vertical tab rail. Selection is carried by the Button variant so
              no colour utility has to out-order another. */}
          <nav
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings sections"
            className="sticky top-0 flex w-[150px] shrink-0 flex-col gap-1 self-start"
          >
            {TABS.map((t) => (
              <Button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                variant={tab === t.id ? "secondary" : "ghost"}
                icon={t.icon}
                className="w-full"
                onClick={() => setTab(t.id)}
              >
                {/* flex-1 does the left-aligning, which keeps the primitive's
                    own justify-center from having to be overridden. */}
                <span className="flex-1 text-left">{t.label}</span>
              </Button>
            ))}
          </nav>

          <div className="min-h-[440px] min-w-0 flex-1">
            {tab === "general" && <GeneralTab settings={settings} />}
            {tab === "downloads" && <DownloadsTab settings={settings} />}
            {tab === "scheduler" && <SchedulerTab settings={settings} />}
            {tab === "browser" && <BrowserTab settings={settings} />}
            {tab === "notifications" && <NotificationsTab settings={settings} />}
            {tab === "system" && <SystemTab settings={settings} />}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function GeneralTab({ settings }: { settings: Settings }) {
  const run = useApp((s) => s.run);

  const browse = () =>
    void run("Could not open the folder picker", async () => {
      const picked = await openFileDialog({
        directory: true,
        multiple: false,
        defaultPath: settings.downloadDir || undefined,
        title: "Choose the download folder",
      });
      if (typeof picked === "string") await patch({ downloadDir: picked });
    });

  return (
    <>
      <Section
        title="Files"
        description="Where finished downloads land, and what happens when a name is already taken."
      >
        <div className="py-2.5">
          <Field
            label="Download folder"
            hint="New downloads default here. Existing downloads keep the folder they were created with."
          >
            <div className="flex gap-2">
              <DraftInput
                value={settings.downloadDir}
                spellCheck={false}
                aria-label="Download folder"
                style={{ fontSize: 12 }}
                className="font-mono"
                onCommit={async (raw) => {
                  const next = raw.trim();
                  if (next) await patch({ downloadDir: next });
                  return current("downloadDir") ?? settings.downloadDir;
                }}
              />
              <Button icon={<Folder size={14} />} onClick={browse}>
                Browse
              </Button>
            </div>
          </Field>
        </div>

        <Row
          label="Sort into category folders"
          hint="Files go into Video, Audio, Documents and so on, under the download folder."
        >
          <Switch
            checked={settings.sortIntoCategories}
            label="Sort into category folders"
            onChange={(v) => void patch({ sortIntoCategories: v })}
          />
        </Row>

        <Row
          label="When the file already exists"
          hint="Rename keeps both copies as “name (1).zip”. Skip marks the download complete without transferring."
        >
          <Segmented<ConflictPolicy>
            value={settings.conflictPolicy}
            onChange={(v) => void patch({ conflictPolicy: v })}
            options={[
              { value: "rename", label: "Rename" },
              { value: "overwrite", label: "Overwrite" },
              { value: "skip", label: "Skip" },
            ]}
          />
        </Row>
      </Section>

      <Section title="Appearance">
        <Row label="Theme" hint="System follows Windows and changes with it.">
          <Segmented
            value={
              settings.theme === "light" || settings.theme === "dark"
                ? settings.theme
                : "system"
            }
            onChange={(v) => void patch({ theme: v })}
            options={[
              { value: "system", label: "System", icon: <Laptop size={13} /> },
              { value: "light", label: "Light", icon: <Sun size={13} /> },
              { value: "dark", label: "Dark", icon: <Moon size={13} /> },
            ]}
          />
        </Row>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

function DownloadsTab({ settings }: { settings: Settings }) {
  const step = (delta: number) =>
    void patch({
      maxConcurrentDownloads: Math.min(
        32,
        Math.max(1, settings.maxConcurrentDownloads + delta),
      ),
    });

  return (
    <>
      {/* The headline control: given a card of its own because "why are four
          things downloading at once" is the question this screen exists for. */}
      <div className="mb-7 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-4">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
              Downloads at the same time
            </h3>
            <p className="mt-1 text-[11px] leading-snug text-[var(--text-tertiary)]">
              Anything over this waits in the queue instead of competing for the
              same connection. Set it to 1 to finish files one at a time.
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

      <Section
        title="Connections"
        description="More connections per file usually means more speed, up to the point where the server starts throttling."
      >
        <Row
          label="Connections per download"
          hint="1 to 32. Ignored by servers that do not support range requests."
        >
          <DraftInput
            value={String(settings.maxConnectionsPerDownload)}
            aria-label="Connections per download"
            inputMode="numeric"
            style={{ width: 66 }}
            className="text-center tabular-nums"
            onCommit={numberCommit("maxConnectionsPerDownload", 1, 32)}
          />
        </Row>
      </Section>

      <Section title="Bandwidth">
        <div className="py-2.5">
          <Field label="Global speed limit">
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
      </Section>

      <Section title="Reliability">
        <Row
          label="Retries per download"
          hint="How many times a stalled or failed transfer is retried before it gives up. 0 to 100."
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
        <Row
          label="Request timeout"
          hint="Seconds to wait for a server to respond. 5 to 3600."
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
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

function SchedulerTab({ settings }: { settings: Settings }) {
  return (
    <>
      <Section
        title="Scheduler"
        description="Holds scheduled downloads back until one of the windows below is open."
      >
        <Row
          label="Use the scheduler"
          hint="Off by default. While off, nothing here gates anything."
        >
          <Switch
            checked={settings.schedule.enabled}
            label="Use the scheduler"
            onChange={(v) =>
              void patch({ schedule: { ...settings.schedule, enabled: v } })
            }
          />
        </Row>

        <Row
          label="Schedule new downloads by default"
          hint="New downloads arrive waiting for a window instead of starting straight away."
        >
          <Switch
            checked={settings.scheduleNewDownloads}
            label="Schedule new downloads by default"
            onChange={(v) => void patch({ scheduleNewDownloads: v })}
          />
        </Row>

        <Row
          label="Pause when a window closes"
          hint="Off lets a transfer that started inside a window run past the end of it."
        >
          <Switch
            checked={settings.pauseOutsideWindow}
            label="Pause when a window closes"
            onChange={(v) => void patch({ pauseOutsideWindow: v })}
          />
        </Row>

        <div className="py-2.5">
          <Field label="Speed limit inside windows">
            <DraftInput
              value={speedToText(settings.scheduledSpeedLimitBps)}
              aria-label="Speed limit inside scheduler windows"
              placeholder="0 = use the global limit"
              style={{ width: 190 }}
              onCommit={speedCommit("scheduledSpeedLimitBps")}
              hint={(draft) => {
                const parsed = parseSpeed(draft);
                if (parsed === null)
                  return "Not a speed — try 2 MB, 500k, or 0 to use the global limit.";
                if (parsed === 0)
                  return "Windows use the global limit above.";
                return `Inside a window, capped at ${formatSpeed(parsed)}.`;
              }}
            />
          </Field>
        </div>

        <div className="py-2.5">
          <Field
            label="When the queue finishes"
            hint="Only fires when the last download completes; there is a countdown you can cancel first."
          >
            <Segmented<OnQueueComplete>
              value={settings.onQueueComplete}
              onChange={(v) => void patch({ onQueueComplete: v })}
              options={[
                { value: "nothing", label: "Nothing" },
                { value: "sleep", label: "Sleep" },
                { value: "hibernate", label: "Hibernate" },
                { value: "shutdown", label: "Shut down" },
                { value: "exit", label: "Exit" },
              ]}
            />
          </Field>
        </div>
      </Section>

      <ScheduleEditor
        schedule={settings.schedule}
        onChange={(schedule) => void patch({ schedule })}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

function BrowserTab({ settings }: { settings: Settings }) {
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
  const boundElsewhere =
    rpc?.listening === true && rpc.port !== settings.rpcPort;

  return (
    <>
      <Section
        title="Browser integration"
        description="Downpour listens on loopback so the extension can hand downloads over. Nothing is exposed off this machine."
      >
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

        <div className="py-2.5">
          {confirmRegen ? (
            <div className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
              <p className="text-[12px] leading-snug text-[var(--text-primary)]">
                Issue a new pairing token?
              </p>
              <p className="mt-1 text-[11px] leading-snug text-[var(--text-tertiary)]">
                The current token stops working immediately. Any browser
                extension already paired with Downpour will be rejected until
                you paste the new token into it.
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
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function NotificationsTab({ settings }: { settings: Settings }) {
  return (
    <Section
      title="Notifications"
      description="Windows toasts, raised by Downpour when a download reaches a final state."
    >
      <Row label="Notify when a download completes">
        <Switch
          checked={settings.notifyOnComplete}
          label="Notify when a download completes"
          onChange={(v) => void patch({ notifyOnComplete: v })}
        />
      </Row>
      <Row
        label="Notify when a download fails"
        hint="Includes the reason it gave up, so a failure is not silent."
      >
        <Switch
          checked={settings.notifyOnError}
          label="Notify when a download fails"
          onChange={(v) => void patch({ notifyOnError: v })}
        />
      </Row>
      <Row
        label="Play a sound on completion"
        hint="Off by default. Unsolicited noise from a background app is rude."
      >
        <Switch
          checked={settings.soundOnComplete}
          label="Play a sound on completion"
          onChange={(v) => void patch({ soundOnComplete: v })}
        />
      </Row>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

function SystemTab({ settings }: { settings: Settings }) {
  return (
    <Section
      title="Windows"
      description="How Downpour behaves as a desktop application."
    >
      <Row
        label="Launch at login"
        hint="Adds Downpour to Windows startup. The registry entry is reconciled with this setting on every launch."
      >
        <Switch
          checked={settings.launchAtLogin}
          label="Launch at login"
          onChange={(v) => void patch({ launchAtLogin: v })}
        />
      </Row>
      <Row
        label="Start minimised"
        hint="Opens straight to the tray, which only makes sense alongside launch at login."
      >
        <Switch
          checked={settings.startMinimized}
          label="Start minimised"
          onChange={(v) => void patch({ startMinimized: v })}
        />
      </Row>
      <Row
        label="Close to the tray"
        hint="The window close button hides Downpour instead of quitting, so transfers keep running. Off makes closing quit."
      >
        <Switch
          checked={settings.closeToTray}
          label="Close to the tray"
          onChange={(v) => void patch({ closeToTray: v })}
        />
      </Row>
    </Section>
  );
}
