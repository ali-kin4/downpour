/**
 * Transient notices.
 *
 * Errors persist until dismissed; everything else clears itself. A download
 * manager runs unattended, so an error that vanished after four seconds is an
 * error the user never saw.
 */

import clsx from "clsx";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useApp } from "../store/app";

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[320px] flex-col gap-2"
      role="region"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const colour =
          t.tone === "error"
            ? "var(--status-failed)"
            : t.tone === "success"
              ? "var(--status-complete)"
              : "var(--accent)";
        const Icon =
          t.tone === "error" ? AlertCircle : t.tone === "success" ? CheckCircle2 : Info;

        return (
          <div
            key={t.id}
            className={clsx(
              "dp-toast-enter pointer-events-auto flex items-start gap-2.5 rounded-[var(--radius-card)]",
              "border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3",
              "shadow-[var(--shadow-overlay)]",
            )}
          >
            <Icon size={15} style={{ color: colour }} className="mt-px shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-medium text-[var(--text-primary)]">
                {t.title}
              </div>
              {t.detail && (
                <p
                  className="mt-0.5 text-[11px] leading-snug break-words text-[var(--text-secondary)]"
                  data-selectable
                >
                  {t.detail}
                </p>
              )}
              {t.action && (
                <button
                  type="button"
                  onClick={() => {
                    t.action?.run();
                    dismiss(t.id);
                  }}
                  className="mt-1.5 rounded-[6px] bg-[var(--accent-soft)] px-2 py-1 text-[11px] font-medium text-[var(--accent)] transition-colors hover:brightness-110"
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
