/**
 * What's new.
 *
 * Its own window, not a panel inside About. About answers "what is this and who
 * made it" — identity, version, credit, legal — and it answers that at a glance.
 * Release notes are a different question asked at a different moment: once,
 * just after an upgrade, when someone wants to know what changed. Stacking them
 * into About turns a card into a page you scroll, and the scrolling is what
 * makes an About box feel cheap.
 *
 * Shown automatically on the first launch after an upgrade, and from
 * Help → What's new whenever someone wants it again.
 *
 * The notes come from `release-notes.ts`: what changed for the person using
 * Downpour, in their words. `CHANGELOG.md` stays the technical record.
 */

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { RELEASES, notesFor } from "../lib/release-notes";
import { useApp } from "../store/app";
import { Button, Dialog } from "./ui";

export function WhatsNewDialog() {
  const open = useApp((s) => s.whatsNewOpen);
  const setOpen = useApp((s) => s.setWhatsNewOpen);

  const [version, setVersion] = useState<string | null>(null);
  /** Which older release is expanded, if any. */
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setExpanded(null);
    api
      .appVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, [open]);

  // Falls back to the newest written notes when the running version has none,
  // so a build made between releases still shows something true.
  const current = (version ? notesFor(version) : undefined) ?? RELEASES[0];
  const older = RELEASES.filter((r) => r.version !== current?.version);

  if (!current) return null;

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={`What's new in ${current.version}`}
      subtitle={current.date ?? undefined}
      width={560}
      footer={
        <div className="flex w-full justify-end">
          <Button variant="primary" onClick={() => setOpen(false)}>
            Got it
          </Button>
        </div>
      }
    >
      {current.summary && (
        <p className="mb-4 text-[12px] leading-snug text-[var(--text-tertiary)]">
          {current.summary}
        </p>
      )}

      <ul className="space-y-3">
        {current.notes.map((n) => (
          <li key={n.title} className="flex gap-2.5">
            <Check
              size={13}
              className="mt-[3px] shrink-0 text-[var(--color-accent-from)]"
              aria-hidden
            />
            <div className="min-w-0">
              <p className="text-[12.5px] leading-snug font-medium text-[var(--text-primary)]">
                {n.title}
              </p>
              <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--text-secondary)]">
                {n.detail}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {older.length > 0 && (
        <div className="mt-5 border-t border-[var(--border-subtle)] pt-3">
          <p className="mb-1 text-[10px] font-semibold tracking-[0.11em] text-[var(--text-tertiary)] uppercase">
            Earlier releases
          </p>
          {older.map((r) => {
            const isOpen = expanded === r.version;
            return (
              <div key={r.version}>
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : r.version)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-1.5 rounded-[6px] py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text-primary)]"
                >
                  <ChevronDown
                    size={13}
                    className={`shrink-0 transition-transform duration-150 ${isOpen ? "" : "-rotate-90"}`}
                    aria-hidden
                  />
                  <span className="font-medium tabular-nums">{r.version}</span>
                  {r.date && (
                    <span className="text-[var(--text-tertiary)]">
                      · {r.date}
                    </span>
                  )}
                </button>
                {isOpen && (
                  <ul className="mb-1 ml-[19px] space-y-1.5 border-l border-[var(--border-subtle)] pl-3">
                    {r.notes.map((n) => (
                      <li key={n.title}>
                        <p className="text-[12px] leading-snug text-[var(--text-primary)]">
                          {n.title}
                        </p>
                        <p className="text-[11px] leading-snug text-[var(--text-tertiary)]">
                          {n.detail}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
