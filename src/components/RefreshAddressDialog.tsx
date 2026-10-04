/**
 * "Refresh download address": give a stopped download a working link again.
 *
 * Signed, session-bound and single-use links stop working long before the
 * bytes already fetched stop being good. Rather than starting a second
 * download beside the first, this attaches a new address to the same item, and
 * the engine's ordinary resume rules decide whether the bytes are kept -- only
 * when the server confirms it is the same file.
 *
 * There are two ways to get that address, and the first is the one most people
 * need: they cannot see the link, only the button on the page that makes one.
 * So Downpour waits while they click it again, and the browser extension's
 * capture becomes this download's address. Pasting a link is the fallback.
 *
 * Closing the dialog does **not** stop the wait. The row says it is waiting,
 * the wait lapses on its own, and the user who closed this to go and find the
 * page in their browser should not have to keep it open to be heard. Stopping
 * it is the explicit Cancel.
 */

import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { Clipboard, Globe, Link2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNow } from "../hooks/useNow";
import * as api from "../lib/api";
import { awaitingAddress, type DownloadItem } from "../lib/types";
import { useApp, useItem } from "../store/app";
import { Button, Dialog, Field, Spinner, TextInput } from "./ui";

export function RefreshAddressDialog() {
  const id = useApp((s) => s.refreshAddressId);
  const setId = useApp((s) => s.setRefreshAddressId);
  const item = useItem(id ?? "");

  // Keyed on the id so every opening starts clean: no pasted text or "the wait
  // ran out" left over from another download.
  if (!id || !item) return null;
  return <RefreshAddressBody key={id} item={item} onClose={() => setId(null)} />;
}

function RefreshAddressBody({
  item,
  onClose,
}: {
  item: DownloadItem;
  onClose: () => void;
}) {
  const reloadItem = useApp((s) => s.reloadItem);
  const toast = useApp((s) => s.toast);

  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set once a wait is under way -- started here, or already running when the
  // dialog was reopened from the row -- so one that lapses can be told apart
  // from one that was never started.
  const [waitStarted, setWaitStarted] = useState(() =>
    awaitingAddress(item, Date.now() / 1000),
  );

  const until = item.awaitingAddressUntil;
  const now = useNow(until !== null && until > Date.now() / 1000);
  const waiting = awaitingAddress(item, now);
  const lapsed = waitStarted && !waiting;

  // A new address has arrived when the item's address changes or it starts
  // moving. Either way there is nothing left to ask, so the dialog gets out of
  // the way and says what happened. The address is remembered from opening,
  // because the dialog never offers this on a download that is moving.
  const openedWith = useRef(item.url);
  const arrived =
    item.url !== openedWith.current ||
    item.status === "queued" ||
    item.status === "scheduled" ||
    item.status === "probing" ||
    item.status === "running";
  // Said once: the dialog can re-render, and StrictMode re-runs effects, in
  // the moment between asking to close and actually unmounting.
  const announced = useRef(false);
  useEffect(() => {
    if (!arrived || announced.current) return;
    announced.current = true;
    toast({ tone: "success", title: "New address received", detail: item.filename });
    onClose();
  }, [arrived, item.filename, onClose, toast]);

  const attempt = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      // Shown inside the dialog rather than as a toast: the toast host sits
      // behind the backdrop, and the user is looking here.
      setError(api.errorMessage(e));
    } finally {
      // The event stream announces a status change but not the address or
      // the wait, so read the item back to see what the engine did.
      await reloadItem(item.id);
      setBusy(false);
    }
  };

  const wait = () =>
    attempt(async () => {
      await api.waitForNewAddress(item.id);
      setWaitStarted(true);
    });

  const cancelWait = () =>
    attempt(async () => {
      await api.cancelNewAddress(item.id);
      // Cancelling is a choice, not a lapse; do not report it as one.
      setWaitStarted(false);
    });

  const trimmed = pasted.trim();
  const valid = isHttpUrl(trimmed);
  const submitAddress = () => {
    if (!valid || busy) return;
    void attempt(() => api.setDownloadAddress(item.id, trimmed));
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Refresh download address"
      subtitle={item.filename}
      width={500}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="flex flex-col gap-4">
        <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
          Links from many sites stop working after a while. Give this download a
          fresh one and it carries on: what has already been downloaded is kept
          if the server confirms it is the same file, and it starts over if not.
        </p>

        {/* A media download knows the page it came from, and the app resolves
            a fresh address from it on its own. Still offered by hand, because
            that can fail -- the page may want a sign-in the app does not have. */}
        {item.addressExpired && item.media && (
          <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
            Downpour is already fetching a new address from the page this video
            came from. If that does not work, use one of the options below.
          </p>
        )}

        {waiting && until !== null ? (
          <div
            className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2.5"
            aria-live="polite"
          >
            <Spinner />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-[var(--text-primary)]">
                Start the download again in your browser — Downpour is waiting
              </div>
              <div className="mt-0.5 text-[11px] tabular-nums text-[var(--text-tertiary)]">
                {formatClock(until - now)} left
              </div>
            </div>
            <Button size="sm" disabled={busy} onClick={() => void cancelWait()}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                icon={<Globe size={14} />}
                disabled={busy}
                onClick={() => void wait()}
              >
                {lapsed ? "Wait again" : "Wait for the browser"}
              </Button>
              <span className="text-[11px] leading-snug text-[var(--text-tertiary)]">
                Then click the download on the page again; Downpour picks it up.
              </span>
            </div>
            {lapsed && (
              <p className="text-[11px] text-[var(--status-paused)]" aria-live="polite">
                The wait ran out before the browser sent this download.
              </p>
            )}
          </div>
        )}

        <Field label="or paste a new address" htmlFor="dp-refresh-address">
          <div className="flex gap-1.5">
            <TextInput
              id="dp-refresh-address"
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAddress();
              }}
              placeholder="https://"
              spellCheck={false}
            />
            <Button
              aria-label="Paste from clipboard"
              title="Paste from clipboard"
              icon={<Clipboard size={14} />}
              onClick={async () => {
                const clip = await readText().catch(() => "");
                if (clip) setPasted(clip.trim());
              }}
            />
          </div>
        </Field>

        <div className="flex items-center justify-between gap-3">
          <p
            className="min-w-0 text-[11px] leading-snug text-[var(--status-failed)]"
            aria-live="polite"
          >
            {error ??
              (trimmed && !valid ? "That is not a web address (http:// or https://)." : "")}
          </p>
          <Button
            icon={busy ? <Spinner size={13} /> : <Link2 size={14} />}
            disabled={!valid || busy}
            onClick={submitAddress}
          >
            Use this address
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Only what the engine accepts. Checked here too so a typo is pointed out as it
 * is typed rather than after a round trip, but the engine has the last word.
 */
function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** mm:ss, as a countdown reads -- 09:05 rather than the table's "9m 05s". */
function formatClock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
