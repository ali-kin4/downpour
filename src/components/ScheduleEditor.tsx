/**
 * Editor for the scheduler's time windows.
 *
 * The whole reason this is a bespoke component rather than a list of time
 * pickers is the midnight-crossing case. `end <= start` means the window runs
 * into the next day, and the day-of-week filter then applies to the day the
 * window *opened* — a Friday-only 22:00-06:00 window is still open at 02:00 on
 * Saturday. That rule lives in `scheduler.rs::ScheduleWindow::contains`, and
 * the "open now" indicator here mirrors it exactly so the UI and the engine can
 * never disagree about whether downloads are allowed to run.
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarClock,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Badge, Button, Switch, TextInput } from "./ui";
import { formatMinuteOfDay, formatUntil, parseMinuteOfDay } from "../lib/format";
import {
  DAY_ALL,
  DAY_LABELS,
  DAY_WEEKDAYS,
  DAY_WEEKENDS,
  type DaySet,
  type Schedule,
  type ScheduleWindow,
} from "../lib/types";

const MINUTES_PER_DAY = 24 * 60;

/** Weekday (Monday = 0) plus minutes since midnight — the engine's `LocalMoment`. */
interface Moment {
  weekday: number;
  minute: number;
}

function nowMoment(): Moment {
  const d = new Date();
  // `getDay()` is Sunday-based; the engine and `DAY_LABELS` are Monday-based.
  return {
    weekday: (d.getDay() + 6) % 7,
    minute: d.getHours() * 60 + d.getMinutes(),
  };
}

function hasDay(days: DaySet, weekday: number): boolean {
  return (days & (1 << weekday)) !== 0;
}

function wrapsMidnight(w: ScheduleWindow): boolean {
  return w.end <= w.start;
}

/**
 * Mirror of `ScheduleWindow::contains`.
 *
 * Two branches are easy to get wrong and both are deliberate here:
 *   - `start === end` is a full 24 hours on its enabled days, not an empty
 *     window, so an "all day" preset is not silently a no-op.
 *   - for a wrapping window past midnight the day filter is tested against
 *     *yesterday*, because that is the day the window opened on.
 */
function isOpenAt(w: ScheduleWindow, at: Moment): boolean {
  if (!w.enabled || (w.days & DAY_ALL) === 0) return false;
  if (w.start === w.end) return hasDay(w.days, at.weekday);
  if (wrapsMidnight(w)) {
    if (at.minute >= w.start) return hasDay(w.days, at.weekday);
    if (at.minute < w.end) return hasDay(w.days, (at.weekday + 6) % 7);
    return false;
  }
  return at.minute >= w.start && at.minute < w.end && hasDay(w.days, at.weekday);
}

/** Mirror of `ScheduleWindow::minutes_until_open`. `null` means it never opens. */
function minutesUntilOpen(w: ScheduleWindow, at: Moment): number | null {
  if (!w.enabled || (w.days & DAY_ALL) === 0) return null;
  if (isOpenAt(w, at)) return 0;
  for (let offset = 0; offset < 8; offset += 1) {
    const day = (at.weekday + offset) % 7;
    if (!hasDay(w.days, day)) continue;
    const absoluteStart = offset * MINUTES_PER_DAY + w.start;
    if (absoluteStart > at.minute) return absoluteStart - at.minute;
  }
  return null;
}

function describeDays(days: DaySet): string {
  const d = days & DAY_ALL;
  if (d === 0) return "no days";
  if (d === DAY_ALL) return "every day";
  if (d === DAY_WEEKDAYS) return "Mon–Fri";
  if (d === DAY_WEEKENDS) return "Sat–Sun";
  return DAY_LABELS.filter((_, i) => hasDay(d, i)).join(", ");
}

/** "22:00 → 06:00 next day, Mon–Fri" — the sentence the user is checking. */
function describeWindow(w: ScheduleWindow): string {
  const days = describeDays(w.days);
  if (w.start === w.end) return `All day, ${days}`;
  const span = `${formatMinuteOfDay(w.start)} → ${formatMinuteOfDay(w.end)}${
    wrapsMidnight(w) ? " next day" : ""
  }`;
  return `${span}, ${days}`;
}

interface Preset {
  label: string;
  start: number;
  end: number;
  days: DaySet;
}

const PRESETS: Preset[] = [
  { label: "Overnight", start: 2 * 60, end: 7 * 60, days: DAY_ALL },
  { label: "Late night", start: 22 * 60, end: 6 * 60, days: DAY_ALL },
  { label: "Weekends only", start: 0, end: 0, days: DAY_WEEKENDS },
  { label: "All day", start: 0, end: 0, days: DAY_ALL },
];

function presetCaption(p: Preset): string {
  if (p.start === p.end) return describeDays(p.days);
  return `${formatMinuteOfDay(p.start)}–${formatMinuteOfDay(p.end)}`;
}

// ---------------------------------------------------------------------------
// Time entry
// ---------------------------------------------------------------------------

/**
 * An `HH:MM` box that only ever commits a parsed value.
 *
 * Rejecting rather than coercing matters: `Number("2:0")` is `NaN`, and writing
 * a NaN into `start` would produce a window the engine can neither open nor
 * describe. Half-typed text is simply held locally until it parses.
 */
function TimeField({
  value,
  onCommit,
  label,
}: {
  value: number;
  onCommit: (minute: number) => void;
  label: string;
}) {
  const [draft, setDraft] = useState(() => formatMinuteOfDay(value));
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    // Adopt the canonical value, unless the box already spells the same time a
    // different way ("9:30" vs "09:30") — rewriting it then would move the
    // caret out from under someone who is still typing.
    if (parseMinuteOfDay(draftRef.current) !== value) {
      setDraft(formatMinuteOfDay(value));
    }
  }, [value]);

  const parsed = parseMinuteOfDay(draft);

  return (
    <TextInput
      value={draft}
      aria-label={label}
      aria-invalid={parsed === null}
      inputMode="numeric"
      placeholder="HH:MM"
      // Inline styles rather than classes: the primitive already sets a width
      // and a border colour, and two utilities for the same property resolve by
      // stylesheet order rather than by which one is written last.
      style={{
        width: 72,
        ...(parsed === null ? { borderColor: "var(--status-failed)" } : null),
      }}
      className="text-center tabular-nums"
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const m = parseMinuteOfDay(raw);
        if (m !== null && m !== value) onCommit(m);
      }}
      onBlur={() => setDraft(formatMinuteOfDay(parsed ?? value))}
    />
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export function ScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: Schedule;
  onChange: (s: Schedule) => void;
}) {
  // "Open now" is wall-clock derived, so it has to be re-evaluated on a timer
  // rather than only when the schedule is edited.
  const [now, setNow] = useState<Moment>(nowMoment);
  useEffect(() => {
    const id = window.setInterval(() => setNow(nowMoment()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const setWindows = (windows: ScheduleWindow[]) => onChange({ ...schedule, windows });

  const updateWindow = (id: string, patch: Partial<ScheduleWindow>) =>
    setWindows(schedule.windows.map((w) => (w.id === id ? { ...w, ...patch } : w)));

  const removeWindow = (id: string) =>
    setWindows(schedule.windows.filter((w) => w.id !== id));

  const addPreset = (p: Preset) =>
    setWindows([
      ...schedule.windows,
      {
        id: crypto.randomUUID(),
        label: p.label,
        start: p.start,
        end: p.end,
        days: p.days,
        enabled: true,
      },
    ]);

  const presetButtons = (
    <div className="flex flex-wrap gap-1.5">
      {PRESETS.map((p) => (
        <Button
          key={p.label}
          size="sm"
          icon={<Plus size={13} />}
          onClick={() => addPreset(p)}
          title={`${p.label} — ${presetCaption(p)}`}
        >
          {p.label}
          <span className="text-[var(--text-tertiary)] tabular-nums">
            {presetCaption(p)}
          </span>
        </Button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-[var(--text-primary)]">
            Windows
          </span>
          <Badge>{schedule.windows.length}</Badge>
        </div>
        {schedule.windows.length > 0 && presetButtons}
      </div>

      {!schedule.enabled && schedule.windows.length > 0 && (
        <p className="text-[11px] leading-snug text-[var(--text-tertiary)]">
          The scheduler is switched off, so these windows are saved but not
          enforced. Nothing is being held back right now.
        </p>
      )}

      {schedule.windows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-[var(--border-strong)] px-4 py-7 text-center">
          <CalendarClock size={22} className="text-[var(--text-tertiary)]" />
          <div>
            <p className="text-[13px] text-[var(--text-primary)]">No windows yet</p>
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-tertiary)]">
              With the scheduler on and no windows, scheduled downloads never
              run. Start from one of these:
            </p>
          </div>
          {presetButtons}
        </div>
      ) : (
        <ul className="flex list-none flex-col gap-2 p-0">
          {schedule.windows.map((w) => {
            const open = isOpenAt(w, now);
            const until = minutesUntilOpen(w, now);
            const noDays = (w.days & DAY_ALL) === 0;
            const wraps = w.start !== w.end && wrapsMidnight(w);

            return (
              <li
                key={w.id}
                className="rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3"
              >
                <div className="flex items-center gap-2">
                  <Switch
                    checked={w.enabled}
                    label={`Enable ${w.label ?? "window"}`}
                    onChange={(enabled) => updateWindow(w.id, { enabled })}
                  />
                  <TextInput
                    // Uncontrolled: every other edit in this list round-trips
                    // through the engine and rebuilds the window object, and a
                    // controlled label would fight that on each keystroke.
                    defaultValue={w.label ?? ""}
                    aria-label="Window label"
                    placeholder="Untitled window"
                    className="min-w-0 flex-1"
                    onBlur={(e) =>
                      updateWindow(w.id, { label: e.target.value.trim() || null })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                  />
                  {open && <Badge tone="accent">Open now</Badge>}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Delete this window"
                    title="Delete this window"
                    icon={<Trash2 size={14} />}
                    onClick={() => removeWindow(w.id)}
                  />
                </div>

                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <TimeField
                    value={w.start}
                    label="Start time"
                    onCommit={(start) => updateWindow(w.id, { start })}
                  />
                  <ArrowRight size={13} className="text-[var(--text-tertiary)]" />
                  <TimeField
                    value={w.end}
                    label="End time"
                    onCommit={(end) => updateWindow(w.id, { end })}
                  />
                  {wraps && <Badge tone="accent">+1 day</Badge>}
                  {w.start === w.end && <Badge>24 h</Badge>}

                  <div className="ml-auto flex flex-wrap gap-1">
                    {DAY_LABELS.map((day, i) => {
                      const on = hasDay(w.days, i);
                      return (
                        <Button
                          key={day}
                          size="sm"
                          // Selection is carried by the variant, not by an
                          // override class, so there is no ambiguity about
                          // which colour utility wins.
                          variant={on ? "primary" : "secondary"}
                          aria-pressed={on}
                          onClick={() =>
                            updateWindow(w.id, { days: w.days ^ (1 << i) })
                          }
                        >
                          {day}
                        </Button>
                      );
                    })}
                  </div>
                </div>

                <p className="mt-2.5 text-[11px] leading-snug text-[var(--text-secondary)]">
                  <span className="tabular-nums">{describeWindow(w)}</span>
                  {" · "}
                  {!w.enabled
                    ? "disabled"
                    : open
                      ? "open right now"
                      : until === null
                        ? "never opens"
                        : `opens ${formatUntil(until)}`}
                </p>

                {wraps && (w.days & DAY_ALL) !== DAY_ALL && !noDays && (
                  <p className="mt-1 text-[11px] leading-snug text-[var(--text-tertiary)]">
                    The days above are the evenings it starts on. A{" "}
                    {describeDays(w.days)} window that opens at{" "}
                    {formatMinuteOfDay(w.start)} keeps running until{" "}
                    {formatMinuteOfDay(w.end)} the next morning.
                  </p>
                )}

                {noDays && (
                  <p
                    className="mt-1 flex items-center gap-1.5 text-[11px] leading-snug"
                    style={{ color: "var(--status-paused)" }}
                  >
                    <TriangleAlert size={12} />
                    No days selected, so this window never opens.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
