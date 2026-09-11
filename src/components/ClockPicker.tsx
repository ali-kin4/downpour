/**
 * A 24-hour dial for choosing a scheduler window.
 *
 * Typing `02:00` is precise but abstract. A scheduler's job is expressing
 * "overnight" or "while I'm asleep", and a dial makes that legible at a glance
 * — particularly the part people get wrong, which is a window running past
 * midnight into the next day.
 *
 * **Twenty-four hours, not twelve.** A 12-hour face needs an AM/PM control to
 * disambiguate every time, and worse, it cannot draw "22:00 → 06:00" as one
 * arc: the span wraps the dial twice and reads as nonsense. On a 24-hour dial
 * midnight is at the top, noon at the bottom, and an overnight window is a
 * single unbroken sweep through the top of the circle. Both hands and the
 * sweep share one scale, so they can never disagree.
 *
 * Drag either hand, or click anywhere on the dial to move the selected one.
 */

import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMinuteOfDay } from "../lib/format";

const SIZE = 196;
const CENTER = SIZE / 2;
const RADIUS = SIZE / 2 - 22;

/** Minutes the hand snaps to: fine enough for a schedule, coarse enough that
 *  dragging never feels twitchy. */
const SNAP = 5;

const MINUTES_PER_DAY = 1440;

export type ClockEnd = "start" | "end";

export function ClockPicker({
  start,
  end,
  active,
  onActiveChange,
  onChange,
}: {
  start: number;
  end: number;
  active: ClockEnd;
  onActiveChange: (end: ClockEnd) => void;
  onChange: (end: ClockEnd, minute: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<ClockEnd | null>(null);

  /** Pointer position → minute of day. Midnight at the top, clockwise. */
  const minuteAt = useCallback((clientX: number, clientY: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    // Scale from rendered pixels back to the viewBox, so this stays correct if
    // the SVG is ever laid out at a different size than its intrinsic one.
    const scale = SIZE / rect.width;
    const x = (clientX - rect.left) * scale - CENTER;
    const y = (clientY - rect.top) * scale - CENTER;

    let angle = Math.atan2(y, x) + Math.PI / 2;
    if (angle < 0) angle += Math.PI * 2;

    const minutes = (angle / (Math.PI * 2)) * MINUTES_PER_DAY;
    return (Math.round(minutes / SNAP) * SNAP) % MINUTES_PER_DAY;
  }, []);

  /** Whichever hand the pointer went down nearest to is the one it moves. */
  const nearestHand = useCallback(
    (minute: number): ClockEnd => {
      const gap = (a: number, b: number) => {
        const d = Math.abs(a - b);
        return Math.min(d, MINUTES_PER_DAY - d);
      };
      return gap(minute, start) <= gap(minute, end) ? "start" : "end";
    },
    [start, end],
  );

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => onChange(dragging, minuteAt(e.clientX, e.clientY));
    const up = () => setDragging(null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [dragging, minuteAt, onChange]);

  const wraps = end <= start;
  const spanMinutes = end > start ? end - start : MINUTES_PER_DAY - start + end;

  return (
    <div className="flex flex-col items-center gap-2">
      <svg
        ref={svgRef}
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="application"
        aria-label={`Window from ${formatMinuteOfDay(start)} to ${formatMinuteOfDay(end)}`}
        className="cursor-pointer touch-none select-none"
        onPointerDown={(e) => {
          e.preventDefault();
          const minute = minuteAt(e.clientX, e.clientY);
          const hand = nearestHand(minute);
          onActiveChange(hand);
          setDragging(hand);
          onChange(hand, minute);
        }}
      >
        <defs>
          <linearGradient id="dp-clock-sweep" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--color-accent-from)" />
            <stop offset="100%" stopColor="var(--color-accent-to)" />
          </linearGradient>
        </defs>

        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS + 14}
          fill="var(--surface-sunken)"
          stroke="var(--border-subtle)"
        />

        {/* Night is shaded, so "overnight" is recognisable before reading a
            single number: 20:00 to 06:00, the hours people schedule into. */}
        <path d={annulus(20 * 60, 6 * 60)} fill="var(--text-tertiary)" opacity={0.07} />

        <path
          d={sweepPath(start, end)}
          fill="url(#dp-clock-sweep)"
          opacity={0.3}
          style={{ transition: "d 200ms var(--ease-out-expo)" }}
        />

        {/* One tick an hour; the four quarter-day marks are longer and labelled. */}
        {Array.from({ length: 24 }, (_, h) => {
          const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
          const major = h % 6 === 0;
          const r1 = RADIUS - (major ? 8 : 4);
          return (
            <line
              key={h}
              x1={CENTER + Math.cos(a) * r1}
              y1={CENTER + Math.sin(a) * r1}
              x2={CENTER + Math.cos(a) * RADIUS}
              y2={CENTER + Math.sin(a) * RADIUS}
              stroke={major ? "var(--text-tertiary)" : "var(--border-strong)"}
              strokeWidth={major ? 1.5 : 1}
              strokeLinecap="round"
            />
          );
        })}

        {[0, 6, 12, 18].map((h) => {
          const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
          const r = RADIUS + 9;
          return (
            <text
              key={h}
              x={CENTER + Math.cos(a) * r}
              y={CENTER + Math.sin(a) * r}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="8.5"
              fill="var(--text-tertiary)"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {String(h).padStart(2, "0")}
            </text>
          );
        })}

        <Hand minute={start} activeHand={active === "start"} label="Start" />
        <Hand minute={end} activeHand={active === "end"} label="End" />

        <circle cx={CENTER} cy={CENTER} r={3} fill="var(--text-secondary)" />
        <text
          x={CENTER}
          y={CENTER + 20}
          textAnchor="middle"
          fontSize="9"
          fill="var(--text-tertiary)"
        >
          {formatSpan(spanMinutes)}
        </text>
      </svg>

      <div className="flex items-center gap-1.5">
        <EndButton end="start" minute={start} active={active === "start"} onSelect={onActiveChange} />
        <span className="text-[11px] text-[var(--text-tertiary)]">→</span>
        <EndButton end="end" minute={end} active={active === "end"} onSelect={onActiveChange} />
        {wraps && spanMinutes !== MINUTES_PER_DAY && (
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              background: "color-mix(in srgb, var(--status-scheduled) 16%, transparent)",
              color: "var(--status-scheduled)",
            }}
            title="This window runs past midnight into the following day"
          >
            +1 day
          </span>
        )}
      </div>
    </div>
  );
}

function Hand({
  minute,
  activeHand,
  label,
}: {
  minute: number;
  activeHand: boolean;
  label: string;
}) {
  const angle = (minute / MINUTES_PER_DAY) * Math.PI * 2 - Math.PI / 2;
  const r = RADIUS - 12;
  const x = CENTER + Math.cos(angle) * r;
  const y = CENTER + Math.sin(angle) * r;

  return (
    <g aria-label={`${label} ${formatMinuteOfDay(minute)}`}>
      <line
        x1={CENTER}
        y1={CENTER}
        x2={x}
        y2={y}
        stroke={activeHand ? "var(--accent)" : "var(--text-tertiary)"}
        strokeWidth={activeHand ? 2.5 : 1.5}
        strokeLinecap="round"
        opacity={activeHand ? 1 : 0.6}
        style={{ transition: "all 160ms var(--ease-out-expo)" }}
      />
      <circle
        cx={x}
        cy={y}
        r={activeHand ? 7 : 5}
        fill={activeHand ? "var(--accent)" : "var(--surface-raised)"}
        stroke={activeHand ? "var(--surface-raised)" : "var(--text-tertiary)"}
        strokeWidth={2}
        style={{ transition: "all 160ms var(--ease-out-expo)" }}
      />
    </g>
  );
}

function EndButton({
  end,
  minute,
  active,
  onSelect,
}: {
  end: ClockEnd;
  minute: number;
  active: boolean;
  onSelect: (e: ClockEnd) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(end)}
      aria-pressed={active}
      title={end === "start" ? "Start time" : "End time"}
      className={clsx(
        "rounded-[6px] px-2 py-1 font-mono text-[13px] tabular-nums transition-colors",
        active
          ? "bg-[var(--accent-soft)] font-semibold text-[var(--accent)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]",
      )}
    >
      {formatMinuteOfDay(minute)}
    </button>
  );
}

function formatSpan(minutes: number): string {
  if (minutes === 0 || minutes >= MINUTES_PER_DAY) return "all day";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * The wedge between the two times, swept clockwise the way the day runs.
 *
 * Shares the dial's 24-hour scale with the hands — which is the whole reason
 * this is a 24-hour dial. On a 12-hour face the arc and the hands are on
 * different scales and visibly disagree.
 */
function sweepPath(start: number, end: number): string {
  const span = end > start ? end - start : MINUTES_PER_DAY - start + end;
  if (span === 0 || span >= MINUTES_PER_DAY) {
    // A full day cannot be one arc, so draw it as two halves.
    return `${annulus(0, 719.9)} ${annulus(720, 1439.9)}`;
  }
  return annulus(start, end);
}

function annulus(from: number, to: number): string {
  const inner = RADIUS - 24;
  const outer = RADIUS - 2;
  const a0 = (from / MINUTES_PER_DAY) * Math.PI * 2 - Math.PI / 2;
  const a1 = (to / MINUTES_PER_DAY) * Math.PI * 2 - Math.PI / 2;
  const span = to > from ? to - from : MINUTES_PER_DAY - from + to;
  const large = span > MINUTES_PER_DAY / 2 ? 1 : 0;

  const p = (r: number, a: number) =>
    `${(CENTER + Math.cos(a) * r).toFixed(2)} ${(CENTER + Math.sin(a) * r).toFixed(2)}`;

  return [
    `M ${p(outer, a0)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${p(outer, a1)}`,
    `L ${p(inner, a1)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${p(inner, a0)}`,
    "Z",
  ].join(" ");
}
