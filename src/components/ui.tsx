/**
 * Shared UI primitives.
 *
 * Deliberately small and unstyled-by-default: they carry the design tokens so
 * that spacing, radius and focus behaviour are consistent everywhere, and
 * nothing more. Anything with real behaviour lives in its own component file.
 */

import clsx from "clsx";
import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { FolderOpen, X } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-control)]",
        "font-medium whitespace-nowrap transition-colors duration-150",
        "disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]",
        !children && (size === "sm" ? "w-7 px-0" : "w-8 px-0"),
        variant === "primary" &&
          "text-[var(--text-on-accent)] bg-linear-100 from-[var(--color-accent-from)] to-[var(--color-accent-to)] hover:brightness-110 active:brightness-95 shadow-sm",
        variant === "secondary" &&
          "border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
        variant === "ghost" &&
          "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
        variant === "danger" &&
          "border border-transparent bg-[var(--status-failed)] text-white hover:brightness-110",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Folder picker
// ---------------------------------------------------------------------------

/**
 * The browse control that sits beside a folder field.
 *
 * Its own component because it appears next to every folder input in the app
 * and was drifting: a 14px glyph in a square grey button, the same weight as a
 * cancel or a close, reading as decoration rather than as the one control on
 * the row that opens something. It is the only way to answer "where does this
 * go?" without typing a path by hand, so it is drawn like an action -- a larger
 * mark in the accent colour, on a button wide enough to look deliberate, with
 * a border that picks up the accent under the pointer.
 */
export function FolderPicker({
  onPick,
  defaultPath,
  label = "Browse for a folder",
}: {
  onPick: (dir: string) => void;
  defaultPath?: string;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={async () => {
        const picked = await openFolder({
          directory: true,
          defaultPath: defaultPath || undefined,
        });
        if (typeof picked === "string") onPick(picked);
      }}
      className={clsx(
        "inline-flex h-8 w-10 shrink-0 items-center justify-center",
        "rounded-[var(--radius-control)] border border-[var(--border-strong)]",
        "bg-[var(--surface-raised)] text-[var(--accent)]",
        "transition-colors duration-150",
        "hover:border-[var(--accent)] hover:bg-[var(--surface-hover)]",
        "active:brightness-95",
      )}
    >
      <FolderOpen size={17} strokeWidth={1.9} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Text input
// ---------------------------------------------------------------------------

export function TextInput({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={clsx(
        "h-8 w-full rounded-[var(--radius-control)] border border-[var(--border-strong)]",
        "bg-[var(--surface-raised)] px-2.5 text-[13px] text-[var(--text-primary)]",
        "placeholder:text-[var(--text-tertiary)]",
        "focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-soft)]",
        "transition-colors duration-150 disabled:opacity-50",
        className,
      )}
    />
  );
}

export function TextArea({
  className,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={clsx(
        "w-full rounded-[var(--radius-control)] border border-[var(--border-strong)]",
        "bg-[var(--surface-raised)] p-2.5 font-mono text-[12px] leading-relaxed",
        "text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]",
        "focus:border-[var(--border-focus)] focus:ring-2 focus:ring-[var(--accent-soft)]",
        "resize-none transition-colors duration-150",
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-200",
        "disabled:pointer-events-none disabled:opacity-40",
        checked
          ? "bg-linear-100 from-[var(--color-accent-from)] to-[var(--color-accent-to)]"
          : "bg-[var(--border-strong)]",
      )}
    >
      <span
        className={clsx(
          "absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white shadow-sm",
          "transition-[left] duration-200 ease-[var(--ease-spring)]",
          checked ? "left-[16px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Segmented control
// ---------------------------------------------------------------------------

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: string; icon?: ReactNode }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={clsx(
        "inline-flex gap-0.5 rounded-[var(--radius-control)] border border-[var(--border-subtle)]",
        "bg-[var(--surface-sunken)] p-0.5",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "inline-flex h-7 items-center gap-1.5 rounded-[6px] px-2.5 text-[12px]",
            "font-medium transition-colors duration-150",
            value === o.value
              ? "bg-[var(--surface-raised)] text-[var(--text-primary)] shadow-sm"
              : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field / Section
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-[12px] font-medium text-[var(--text-primary)]"
      >
        {label}
      </label>
      {children}
      {hint && (
        <p className="text-[11px] leading-snug text-[var(--text-tertiary)]">{hint}</p>
      )}
    </div>
  );
}

/** A settings row: label and description on the left, control on the right. */
export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] text-[var(--text-primary)]">{label}</div>
        {hint && (
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-tertiary)]">
            {hint}
          </p>
        )}
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-7">
      <h3 className="mb-1 text-[13px] font-semibold text-[var(--text-primary)]">
        {title}
      </h3>
      {description && (
        <p className="mb-2 text-[11px] leading-snug text-[var(--text-tertiary)]">
          {description}
        </p>
      )}
      <div className="divide-y divide-[var(--border-subtle)]">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

const DialogCtx = createContext<{ close: () => void } | null>(null);
export const useDialog = () => useContext(DialogCtx);

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 560,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Escape closes, and focus moves into the dialog so a keyboard user is not
  // left tabbing through the window behind it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const timer = window.setTimeout(() => {
      panelRef.current
        ?.querySelector<HTMLElement>("input, textarea, button")
        ?.focus();
    }, 20);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.clearTimeout(timer);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <DialogCtx.Provider value={{ close: onClose }}>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-6"
        role="presentation"
      >
        <div
          className="absolute inset-0 bg-black/25 backdrop-blur-[2px]"
          onClick={onClose}
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          style={{ width, maxWidth: "100%" }}
          className={clsx(
            "dp-enter relative flex max-h-full flex-col overflow-hidden",
            "rounded-[var(--radius-panel)] border border-[var(--border-subtle)]",
            "bg-[var(--surface-raised)] shadow-[var(--shadow-overlay)]",
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] px-5 py-3.5">
            <div className="min-w-0">
              <h2
                id={titleId}
                className="text-[14px] font-semibold text-[var(--text-primary)]"
              >
                {title}
              </h2>
              {subtitle && (
                <p className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">
                  {subtitle}
                </p>
              )}
            </div>
            {/* Not the generic ghost Button: at `size="sm"` that is a 28px
                square holding a 15px glyph in secondary text, which reads as a
                stray character rather than a control. A dialog's close is the
                one affordance every user reaches for blind, so it gets a real
                32px circular target, a heavier stroke, and a hover state that
                fills rather than merely tints. Focus is handled globally by the
                :focus-visible outline. */}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className={clsx(
                "-mt-0.5 -mr-1.5 grid size-8 shrink-0 place-items-center rounded-full",
                "text-[var(--text-tertiary)] transition-colors duration-150",
                "hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
                "active:bg-[var(--surface-selected)]",
              )}
            >
              <X size={16} strokeWidth={2.25} />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

          {footer && (
            <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-5 py-3">
              {footer}
            </footer>
          )}
        </div>
      </div>
    </DialogCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "accent";
}) {
  return (
    <span
      className={clsx(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5",
        "text-[10px] font-semibold tabular-nums",
        tone === "accent"
          ? "bg-[var(--accent-soft)] text-[var(--accent)]"
          : "bg-[var(--surface-sunken)] text-[var(--text-tertiary)]",
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="animate-spin text-[var(--accent)]"
      aria-hidden
    >
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="44"
        strokeDashoffset="14"
        opacity="0.9"
      />
    </svg>
  );
}

/** Keyboard shortcut chip, e.g. Ctrl N. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      className={clsx(
        "rounded border border-[var(--border-subtle)] bg-[var(--surface-sunken)]",
        "px-1 py-px font-sans text-[10px] font-medium text-[var(--text-tertiary)]",
      )}
    >
      {children}
    </kbd>
  );
}
