/**
 * The theme picker.
 *
 * A row of coloured circles is not a showcase — it tells you a theme is pink
 * without telling you whether the app in it is *legible*. So each card renders
 * a miniature of the real chrome: title bar, sidebar with a selected item, two
 * download rows, a progress bar in the theme's gradient, and the status colours
 * as three dots. That is enough to tell cute from muddy before applying it.
 *
 * Nothing here hard-codes a colour. Each card carries `data-palette-preview`,
 * which the generated stylesheet targets, so previews are painted by the very
 * rules the window will use. Hand-written preview colours would drift from the
 * themes within a release, and drift silently.
 *
 * The cards follow the app's light/dark state, so in a dark window every
 * preview is that theme at night. A grid of bright cards in a dark app is how
 * you can tell a picker was added late.
 */

import clsx from "clsx";
import { Check } from "lucide-react";
import { allThemes } from "../../themes/registry";
import { patch } from "./kit";

export function ThemeGallery({ value }: { value: string }) {
  const themes = allThemes();

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="grid grid-cols-2 gap-2.5 sm:grid-cols-3"
    >
      {themes.map((theme) => {
        const selected = value === theme.id;
        return (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => void patch({ palette: theme.id })}
            data-palette-preview={theme.id}
            className={clsx(
              "group overflow-hidden rounded-[var(--radius-card)] border text-left",
              "transition-[border-color,box-shadow,transform] duration-150",
              "hover:-translate-y-px",
              selected
                ? "border-[var(--accent)] shadow-[0_0_0_1px_var(--accent)]"
                : "border-[var(--border-subtle)] hover:border-[var(--border-strong)]",
            )}
          >
            <Preview />

            <div
              className="flex items-center gap-1.5 px-2.5 py-2"
              style={{ background: "var(--surface-raised)" }}
            >
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-[12px] font-semibold"
                  style={{ color: "var(--text-primary)" }}
                >
                  {theme.name}
                </p>
                <p
                  className="truncate text-[10.5px] leading-snug"
                  style={{ color: "var(--text-tertiary)" }}
                >
                  {theme.tagline}
                </p>
              </div>
              {selected && (
                <span
                  className="grid size-4 shrink-0 place-items-center rounded-full"
                  style={{
                    background: "var(--accent)",
                    color: "var(--text-on-accent)",
                  }}
                  aria-hidden
                >
                  <Check size={10} strokeWidth={3} />
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The miniature. Deliberately the app's own anatomy rather than an abstract
 * swatch: chrome over ground, an opaque table beside a translucent sidebar,
 * and the accent doing the three jobs it actually does — selection, progress,
 * and the gradient.
 */
function Preview() {
  return (
    <div
      className="border-b p-2"
      style={{
        background: "var(--surface-sunken)",
        borderColor: "var(--border-subtle)",
      }}
      aria-hidden
    >
      <div
        className="overflow-hidden rounded-[7px] border"
        style={{
          borderColor: "var(--border-subtle)",
          background: "var(--surface-raised)",
          boxShadow: "var(--shadow-card)",
        }}
      >
        {/* Title bar */}
        <div
          className="flex items-center gap-1 px-1.5 py-1"
          style={{ background: "var(--surface-chrome)" }}
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{
              backgroundImage:
                "linear-gradient(115deg, var(--color-accent-from), var(--color-accent-to))",
            }}
          />
          <span
            className="h-[3px] w-6 rounded-full opacity-70"
            style={{ background: "var(--text-tertiary)" }}
          />
          <span className="flex-1" />
          {/* The status palette, which is most of what a theme has to get right
              for a list of downloads to be readable at a glance. */}
          {["--status-complete", "--status-paused", "--status-failed"].map(
            (v) => (
              <span
                key={v}
                className="size-[3px] rounded-full"
                style={{ background: `var(${v})` }}
              />
            ),
          )}
        </div>

        <div className="flex">
          {/* Sidebar */}
          <div
            className="w-7 shrink-0 space-y-[3px] p-1.5"
            style={{ background: "var(--surface-chrome)" }}
          >
            <span
              className="block h-[3px] w-full rounded-full"
              style={{ background: "var(--accent)" }}
            />
            <span
              className="block h-[3px] w-4/5 rounded-full opacity-50"
              style={{ background: "var(--text-tertiary)" }}
            />
            <span
              className="block h-[3px] w-3/5 rounded-full opacity-50"
              style={{ background: "var(--text-tertiary)" }}
            />
          </div>

          {/* The table. Opaque, because this is where dense text lives. */}
          <div className="flex-1 space-y-[7px] p-1.5">
            <Row width="w-4/5" progress="60%" />
            <Row width="w-3/5" progress="25%" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ width, progress }: { width: string; progress: string }) {
  return (
    <div className="space-y-[3px]">
      <span
        className={clsx("block h-[3px] rounded-full opacity-80", width)}
        style={{ background: "var(--text-secondary)" }}
      />
      <span
        className="block h-[3px] w-full overflow-hidden rounded-full"
        style={{ background: "var(--surface-selected)" }}
      >
        <span
          className="block h-full rounded-full"
          style={{
            width: progress,
            backgroundImage:
              "linear-gradient(115deg, var(--color-accent-from), var(--color-accent-to))",
          }}
        />
      </span>
    </div>
  );
}
