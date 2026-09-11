/**
 * The shared machinery every settings tab is built from.
 *
 * Two rules shape everything here, and they are the same two the dialog has
 * always had:
 *
 *  1. There is no Save button. Toggles and segmented controls commit on click;
 *     free text commits after a short pause. A settings screen you can leave in
 *     an unsaved state is a settings screen that lies about the app's state.
 *  2. Every control renders from the store, never from local state. The engine
 *     clamps on save (`Settings::normalise`) and `saveSettings` puts the
 *     clamped result back, so typing 99 into a field capped at 16 has to be
 *     seen snapping back to 16 rather than sitting there looking accepted.
 */

import clsx from "clsx";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { Section, TextInput } from "../ui";
import { formatBytes, formatSpeed, parseSpeed } from "../../lib/format";
import type { Settings } from "../../lib/types";
import { useApp } from "../../store/app";
import { GROUPS, type GroupId, type SettingId } from "./registry";

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * Applies a partial change and resolves once the store holds the engine's
 * answer, so a caller can read the clamped value straight back afterwards.
 *
 * Reads the current settings from the store rather than closing over them:
 * a debounced commit fires long after its render, and two fields committing
 * near each other must not overwrite one another with a stale snapshot.
 */
export async function patch(p: Partial<Settings>): Promise<void> {
  const { settings, saveSettings } = useApp.getState();
  if (!settings) return;
  await saveSettings({ ...settings, ...p });
}

/** The freshest value of one field, for redisplay after a save. */
export function current<K extends keyof Settings>(key: K): Settings[K] | undefined {
  return useApp.getState().settings?.[key];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** `null` means "not searching", which is not the same as "nothing matched". */
const SearchCtx = createContext<Set<string> | null>(null);

export function SearchScope({
  hits,
  children,
}: {
  hits: Set<string> | null;
  children: ReactNode;
}) {
  return <SearchCtx.Provider value={hits}>{children}</SearchCtx.Provider>;
}

/**
 * One searchable control.
 *
 * While a search is running, a setting that did not match is not rendered at
 * all and one that did gets an accent wash, so a query of "token" leaves the
 * Browser tab holding the token row and nothing else. The negative margin
 * keeps the highlight from nudging the layout sideways when it appears.
 */
export function Setting({
  id,
  children,
}: {
  id: SettingId;
  children: ReactNode;
}) {
  const hits = useContext(SearchCtx);
  if (hits && !hits.has(id)) return null;
  return (
    <div
      className={clsx(
        hits && "-mx-2 rounded-[var(--radius-card)] bg-[var(--accent-soft)] px-2",
      )}
    >
      {children}
    </div>
  );
}

/**
 * A group heading, which disappears when a search has emptied it.
 *
 * The title comes from the registry rather than a prop so that the word in the
 * heading is one of the words the search box matches on.
 */
export function Group({
  id,
  description,
  children,
}: {
  id: GroupId;
  description?: string;
  children: ReactNode;
}) {
  const hits = useContext(SearchCtx);
  if (hits && ![...hits].some((h) => h.startsWith(`${id}.`))) return null;
  return (
    <Section title={GROUPS[id]} description={description}>
      {children}
    </Section>
  );
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
 * 16 it already held, the canonical value never changes, so an effect watching
 * it would never fire and the box would keep showing 99. Pulling the string
 * back after every commit is what makes the clamp visible.
 */
export function DraftInput({
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
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    // Adopt an external change only while nothing local is pending.
    if (edits.current === settled.current) setDraft(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current === undefined) return;
      window.clearTimeout(timer.current);
      // Escape closes the dialog without blurring the field first, so a
      // debounce still waiting here would be thrown away — and the footer
      // promises the change was saved. Commit it on the way out. This touches
      // no React state, only the store, so running after unmount is safe.
      void commitRef.current(draftRef.current);
    },
    [],
  );

  const flush = useCallback(async (raw: string) => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
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
export function numberCommit<K extends keyof Settings>(
  key: K,
  min: number,
  max: number,
) {
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
export function speedToText(bps: number | undefined): string {
  return bps ? formatBytes(bps) : "";
}

export function speedCommit(key: SpeedKey) {
  return async (raw: string): Promise<string> => {
    const parsed = parseSpeed(raw);
    // `null` is unparseable; `0` is a legitimate "unlimited".
    if (parsed === null) return speedToText(current(key) as number | undefined);
    await patch({ [key]: parsed });
    return speedToText(current(key) as number | undefined);
  };
}

export function speedHint(draft: string): ReactNode {
  const parsed = parseSpeed(draft);
  if (parsed === null) return "Not a speed — try 2 MB, 500k, or 0 for unlimited.";
  if (parsed === 0) return "Unlimited.";
  return `Capped at ${formatSpeed(parsed)}.`;
}

// ---------------------------------------------------------------------------
// Callout
// ---------------------------------------------------------------------------

/**
 * A block of explanation that is not attached to a control — the "why can I
 * not set this higher" answers that would otherwise become a support thread.
 */
export function Note({
  icon,
  tone = "neutral",
  children,
}: {
  icon?: ReactNode;
  tone?: "neutral" | "warn";
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2.5 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3">
      {icon && (
        <span
          className="mt-px shrink-0"
          style={{
            color: tone === "warn" ? "var(--status-paused)" : "var(--text-tertiary)",
          }}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 text-[11px] leading-relaxed text-[var(--text-secondary)]">
        {children}
      </div>
    </div>
  );
}
