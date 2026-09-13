/**
 * About, and what's new.
 *
 * Identity, authorship, legal standing, and whether a newer version exists.
 * Deliberately a card rather than a page: release notes live in their own
 * window (see WhatsNewDialog) because "what is this" and "what changed in it"
 * are asked at different moments, and stacking them here means scrolling an
 * About box, which is what makes one feel cheap.
 *
 * The update check is manual and says so. Nothing here runs on a timer or at
 * launch: the button is the only thing that touches the network, and a check
 * that fails says it failed rather than quietly reading as "up to date".
 *
 * On the look of it: the accent gradient belongs to the product mark and to
 * nothing else in here. Running it through the author's name would conflate the
 * person with the product and read as self-branding, which is the opposite of
 * the impression this window exists to make. The credit carries its weight
 * through type, space and a steady hairline instead.
 *
 * The legal block is not boilerplate padding. Downpour is free to use and not
 * free to redistribute, and someone deciding whether to trust a build -- or
 * wondering what they are allowed to do with it -- should be able to read that
 * here rather than infer it. The phrasing states the grant before the
 * restriction, because the grant is the part that applies to almost everyone
 * reading it.
 */

import {
  ArrowUpRight,
  Check,
  ExternalLink,
  GitBranch,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../lib/api";
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

      {/* -- Legal --------------------------------------------------------- */}
      <section className="mt-6 border-t border-[var(--border-subtle)] pt-4">
        <div className="space-y-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
          <p>
            © {COPYRIGHT_YEAR} {AUTHOR}. All rights reserved. Downpour is free to
            use, personally and at work, on as many machines as you like. It may
            not be redistributed, sold, or rebuilt and shipped by anyone else.
          </p>
          {/* Deliberately "trademarks", never "registered trademarks", and no ®
              anywhere: the marks are unregistered, and claiming otherwise would
              be a false statement of fact. */}
          <p>
            Downpour™, the Downpour name and the Downpour droplet logo are
            trademarks of {AUTHOR}. The source is published so you can audit what
            it does with your files and your network — that is transparency, not
            a licence to reuse it.
          </p>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          <QuietLink
            label="Licence"
            onClick={() => void openUrl(`${REPO_URL}/blob/main/LICENSE`)}
          />
          <QuietLink
            label="Trademark policy"
            onClick={() => void openUrl(`${REPO_URL}/blob/main/TRADEMARK.md`)}
          />
          <QuietLink
            label="Third-party notices"
            onClick={() =>
              void openUrl(`${REPO_URL}/blob/main/THIRD-PARTY-NOTICES.md`)
            }
          />
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
