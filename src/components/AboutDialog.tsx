/**
 * About, and what's new.
 *
 * One window rather than two, because the three things a person opens "About"
 * for — which version am I on, what changed in it, and is there a newer one —
 * are the same question asked three ways. Splitting them across an About box
 * and a separate release-notes window means answering none of them in one look.
 *
 * The update check is manual and says so. Nothing here runs on a timer or at
 * launch: the button is the only thing that touches the network, and a check
 * that fails says it failed rather than quietly reading as "up to date".
 *
 * The what's-new list comes from `release-notes.ts` — the plain-language notes,
 * not `CHANGELOG.md`. Someone opening this window wants to know that Pause All
 * holds now, not which lock ordering changed.
 *
 * On the look of it: the accent gradient belongs to the product mark and to
 * nothing else in here. Running it through the author's name would conflate the
 * person with the product and read as self-branding, which is the opposite of
 * the impression this window exists to make. The credit carries its weight
 * through type, space and a steady hairline instead.
 *
 * The legal block is not boilerplate padding. Downpour's code is MIT and its
 * name is not, and someone deciding whether to trust a build should be able to
 * read that distinction here rather than infer it.
 */

import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ExternalLink,
  GitBranch,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../lib/api";
import { ACKNOWLEDGEMENTS } from "../lib/acknowledgements";
import { RELEASES, notesFor } from "../lib/release-notes";
import type { UpdateCheck } from "../lib/types";
import { useApp } from "../store/app";
import { Button, Dialog, Spinner } from "./ui";
import { DropletMark } from "./MenuBar";

const REPO_URL = "https://github.com/ali-kin4/downpour";
const AUTHOR = "Ali Jabbary";
const AUTHOR_SITE = "alijabbary.com";
/** The year in the notices. A constant, not `new Date()`: a copyright year that
 *  changes because the machine's clock rolled over is not a claim about
 *  anything. */
const COPYRIGHT_YEAR = "2026";

/** Where the update check has got to. */
type CheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "done"; result: UpdateCheck }
  | { phase: "failed"; message: string };

export function AboutDialog() {
  const open = useApp((s) => s.aboutOpen);
  const setOpen = useApp((s) => s.setAboutOpen);
  const checkOnOpen = useApp((s) => s.aboutCheckOnOpen);
  const clearCheckOnOpen = useApp((s) => s.clearAboutCheckOnOpen);

  const [version, setVersion] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckState>({ phase: "idle" });
  /** Which older release's notes are expanded, if any. */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creditsOpen, setCreditsOpen] = useState(false);

  const runCheck = useCallback(async () => {
    setCheck({ phase: "checking" });
    try {
      setCheck({ phase: "done", result: await api.checkForUpdates() });
    } catch (e) {
      setCheck({ phase: "failed", message: String(e) });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // Reset on each open: a check from twenty minutes ago is not an answer to
    // "is there an update" now.
    setCheck({ phase: "idle" });
    setExpanded(null);
    setCreditsOpen(false);
    api
      .appVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
    // Opened from "Check for updates…" rather than "About": do the thing the
    // menu item promised instead of making the user press the button again.
    if (checkOnOpen) {
      clearCheckOnOpen();
      void runCheck();
    }
  }, [open, checkOnOpen, clearCheckOnOpen, runCheck]);

  // The notes for the running version, falling back to the newest written set
  // so a build whose version has no notes yet still shows something useful.
  const current = (version ? notesFor(version) : undefined) ?? RELEASES[0];
  const older = RELEASES.filter((r) => r.version !== current?.version);

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="About Downpour"
      width={620}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <QuietLink
              icon={<GitBranch size={13} />}
              label="Source"
              onClick={() => void openUrl(REPO_URL)}
            />
            <QuietLink
              icon={<ExternalLink size={13} />}
              label="Report an issue"
              onClick={() => void openUrl(`${REPO_URL}/issues/new/choose`)}
            />
          </div>
          <Button variant="primary" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      }
    >
      {/* -- Identity ------------------------------------------------------ */}
      <div className="flex items-start gap-4">
        <div
          className="grid size-14 shrink-0 place-items-center rounded-[16px] border border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-sm"
          aria-hidden
        >
          <DropletMark size={30} />
        </div>

        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h2 className="text-[20px] leading-none font-semibold tracking-[-0.015em] text-[var(--text-primary)]">
              Downpour
            </h2>
            <span className="rounded-full border border-[var(--border-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] tabular-nums">
              {version ? `Version ${version}` : "…"}
            </span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-snug text-[var(--text-secondary)]">
            A fast, modern download manager for Windows.
          </p>
        </div>
      </div>

      {/* -- Credit -------------------------------------------------------- */}
      <div className="mt-6 border-y border-[var(--border-subtle)] py-4">
        <p className="text-[10px] font-semibold tracking-[0.11em] text-[var(--text-tertiary)] uppercase">
          Designed and built by
        </p>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-[16.5px] leading-none font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
            {AUTHOR}
          </p>
          <button
            type="button"
            onClick={() => void openUrl(`https://${AUTHOR_SITE}`)}
            className="group inline-flex items-baseline gap-1 text-[12.5px] text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text-primary)]"
          >
            <span className="border-b border-transparent group-hover:border-[var(--border-strong)]">
              {AUTHOR_SITE}
            </span>
            <ArrowUpRight
              size={11}
              className="shrink-0 self-center text-[var(--text-tertiary)] transition-transform duration-150 group-hover:-translate-y-px group-hover:translate-x-px"
            />
          </button>
        </div>
      </div>

      {/* -- Updates ------------------------------------------------------- */}
      <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] border border-[var(--border-subtle)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-medium text-[var(--text-primary)]">
            Updates
          </p>
          <div className="mt-0.5 min-h-4 text-[11.5px] leading-snug">
            <CheckStatus state={check} />
          </div>
        </div>

        {check.phase === "done" && check.result.updateAvailable ? (
          <Button
            variant="primary"
            size="sm"
            icon={<ArrowUpRight size={13} />}
            onClick={() => void openUrl((check.result as UpdateCheck).url)}
          >
            Get {check.result.latest}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={check.phase === "checking"}
            icon={
              check.phase === "checking" ? (
                <Spinner size={13} />
              ) : (
                <RefreshCw size={13} />
              )
            }
            onClick={() => void runCheck()}
          >
            {check.phase === "checking" ? "Checking…" : "Check for updates"}
          </Button>
        )}
      </div>

      {/* -- What's new ---------------------------------------------------- */}
      {current && (
        <section className="mt-6">
          <div className="mb-2.5 flex items-baseline justify-between gap-3">
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
              What's new in {current.version}
            </h3>
            {current.date && (
              <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                {current.date}
              </span>
            )}
          </div>
          {current.summary && (
            <p className="mb-3 text-[11.5px] leading-snug text-[var(--text-tertiary)]">
              {current.summary}
            </p>
          )}
          <ul className="space-y-2.5">
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
            <div className="mt-4 border-t border-[var(--border-subtle)] pt-3">
              {older.map((r) => {
                const isOpen = expanded === r.version;
                return (
                  <div key={r.version}>
                    <Disclosure
                      open={isOpen}
                      onToggle={() => setExpanded(isOpen ? null : r.version)}
                    >
                      <span className="font-medium tabular-nums">
                        {r.version}
                      </span>
                      {r.date && (
                        <span className="text-[var(--text-tertiary)]">
                          · {r.date}
                        </span>
                      )}
                    </Disclosure>
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
        </section>
      )}

      {/* -- Legal --------------------------------------------------------- */}
      <section className="mt-6 border-t border-[var(--border-subtle)] pt-4">
        <div className="space-y-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
          <p>
            © {COPYRIGHT_YEAR} {AUTHOR}. Downpour's source code is released under
            the MIT Licence.
          </p>
          {/* Deliberately "trademarks", never "registered trademarks", and no ®
              anywhere: the marks are unregistered, and claiming otherwise would
              be a false statement of fact. */}
          <p>
            Downpour™, the Downpour name and the Downpour droplet logo are
            trademarks of {AUTHOR}. The MIT Licence covers the code, not the name
            — a fork is welcome, under its own.
          </p>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          <QuietLink
            label="MIT Licence"
            onClick={() => void openUrl(`${REPO_URL}/blob/main/LICENSE`)}
          />
          <QuietLink
            label="Trademark policy"
            onClick={() => void openUrl(`${REPO_URL}/blob/main/TRADEMARK.md`)}
          />
        </div>

        {/* -- Acknowledgements -------------------------------------------- */}
        <div className="mt-3">
          <Disclosure
            open={creditsOpen}
            onToggle={() => setCreditsOpen(!creditsOpen)}
          >
            <span className="font-medium">Open-source components</span>
            <span className="text-[var(--text-tertiary)]">
              · {ACKNOWLEDGEMENTS.length}
            </span>
          </Disclosure>

          {creditsOpen && (
            <ul className="mt-1 ml-[19px] divide-y divide-[var(--border-subtle)] border-l border-[var(--border-subtle)] pl-3">
              {ACKNOWLEDGEMENTS.map((a) => (
                <li
                  key={a.name}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5"
                >
                  <button
                    type="button"
                    onClick={() => void openUrl(a.url)}
                    className="text-[12px] font-medium text-[var(--text-primary)] transition-colors duration-150 hover:text-[var(--color-accent-from)]"
                  >
                    {a.name}
                  </button>
                  <span className="text-[11px] text-[var(--text-tertiary)]">
                    {a.license}
                  </span>
                  {a.bundled === false && (
                    <span className="rounded-full border border-[var(--border-subtle)] px-1.5 text-[10px] text-[var(--text-tertiary)]">
                      not bundled
                    </span>
                  )}
                  <p className="w-full text-[11px] leading-snug text-[var(--text-tertiary)]">
                    {a.role}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </Dialog>
  );
}

/**
 * The update line. Every state says which it is, including the two that are
 * easy to conflate: "no newer release" and "could not find out".
 */
function CheckStatus({ state }: { state: CheckState }) {
  if (state.phase === "idle") {
    return (
      <span className="text-[var(--text-tertiary)]">
        Downpour never checks on its own — ask it when you want to know.
      </span>
    );
  }
  if (state.phase === "checking") {
    return <span className="text-[var(--text-tertiary)]">Asking GitHub…</span>;
  }
  if (state.phase === "failed") {
    return (
      <span className="inline-flex items-start gap-1.5 text-[var(--status-failed)]">
        <TriangleAlert size={12} className="mt-[2px] shrink-0" aria-hidden />
        <span>{state.message}</span>
      </span>
    );
  }

  const { updateAvailable, latest, name } = state.result;
  if (updateAvailable) {
    return (
      <span className="text-[var(--text-secondary)]">
        {name ? `${name} (${latest})` : `Version ${latest}`} is available.
      </span>
    );
  }
  if (!latest) {
    return (
      <span className="text-[var(--text-tertiary)]">
        No releases have been published yet.
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
      <Check size={12} className="shrink-0 text-[var(--status-completed)]" aria-hidden />
      This is the newest release.
    </span>
  );
}

/** A chevron row that expands something. Shared so the two lists in here open
 *  and close identically. */
function Disclosure({
  open,
  onToggle,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-1.5 rounded-[6px] py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors duration-150 hover:text-[var(--text-primary)]"
    >
      <ChevronDown
        size={13}
        className={`shrink-0 transition-transform duration-150 ${open ? "" : "-rotate-90"}`}
        aria-hidden
      />
      {children}
    </button>
  );
}

/** A quiet link. Text, not a button that looks like a command. */
function QuietLink({
  icon,
  label,
  onClick,
}: {
  icon?: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[12px] text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
    >
      {icon}
      {label}
    </button>
  );
}
