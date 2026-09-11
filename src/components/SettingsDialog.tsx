/**
 * The settings dialog.
 *
 * Three rules shape everything here:
 *
 *  1. There is no Save button. Toggles and segmented controls commit on click;
 *     free text commits after a short pause. A settings screen you can leave in
 *     an unsaved state is a settings screen that lies about the app's state.
 *  2. Every control renders from the store, never from local state. The engine
 *     clamps on save (`Settings::normalise`) and `saveSettings` puts the
 *     clamped result back, so typing 99 into a field capped at 16 has to be
 *     seen snapping back to 16 rather than sitting there looking accepted.
 *  3. Nine tabs is more than anyone will browse, so the search box is not a
 *     convenience — it is the primary way in. It filters across every tab at
 *     once, moves to the tab holding the first match, and hides everything that
 *     did not match so the answer is the only thing on screen.
 *
 * The controls themselves live in `settings/`, one file per tab, with the
 * searchable index of all of them in `settings/registry.tsx`.
 */

import clsx from "clsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw, Search, X } from "lucide-react";
import * as api from "../lib/api";
import { Badge, Button, Dialog, Kbd, TextInput } from "./ui";
import { AdvancedTab } from "./settings/AdvancedTab";
import { BrowserTab } from "./settings/BrowserTab";
import { CaptureTab } from "./settings/CaptureTab";
import { DownloadsTab } from "./settings/DownloadsTab";
import { GeneralTab } from "./settings/GeneralTab";
import { MediaTab } from "./settings/MediaTab";
import { NotificationsTab } from "./settings/NotificationsTab";
import { SchedulerTab } from "./settings/SchedulerTab";
import { SystemTab } from "./settings/SystemTab";
import { SearchScope } from "./settings/kit";
import { TABS, countByTab, searchHits, type TabId } from "./settings/registry";
import { useApp } from "../store/app";

export function SettingsDialog() {
  const settingsOpen = useApp((s) => s.settingsOpen);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const settings = useApp((s) => s.settings);
  const toast = useApp((s) => s.toast);

  const [tab, setTab] = useState<TabId>("general");
  const [query, setQuery] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  const hits = useMemo(() => searchHits(query), [query]);
  const counts = useMemo(() => (hits ? countByTab(hits) : null), [hits]);

  // A query that matches nothing on the open tab should move to a tab where it
  // does, rather than showing an empty panel next to a rail full of badges.
  useEffect(() => {
    if (!counts || counts.get(tab)) return;
    const first = TABS.find((t) => counts.get(t.id));
    if (first) setTab(first.id);
  }, [counts, tab]);

  const close = useCallback(() => {
    setConfirmReset(false);
    setSettingsOpen(false);
  }, [setSettingsOpen]);

  const refreshSettings = useApp((s) => s.refreshSettings);
  const run = useApp((s) => s.run);

  const reset = () => {
    setConfirmReset(false);
    setQuery("");
    // The engine owns the defaults. Rebuilding them here would be a copy that
    // drifts silently the first time a default changes on the Rust side.
    void run("Could not reset settings", async () => {
      await api.resetSettings();
      await refreshSettings();
      toast({
        tone: "success",
        title: "Settings reset",
        detail: "Your downloads, download folder and files on disk were not touched.",
      });
    });
  };

  const nothingMatched = hits !== null && hits.size === 0;

  return (
    <Dialog
      open={settingsOpen && settings !== null}
      onClose={close}
      title="Settings"
      subtitle="Changes take effect immediately."
      width={760}
      footer={
        confirmReset ? (
          <>
            <span className="mr-auto max-w-[440px] text-[11px] leading-snug text-[var(--text-secondary)]">
              Put every setting back to how Downpour ships? Your download folder,
              your scheduler windows and the pairing token are kept. Nothing is
              removed from the download list and no files are deleted.
            </span>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={reset}>
              Reset settings
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw size={13} />}
              onClick={() => setConfirmReset(true)}
            >
              Reset to defaults
            </Button>
            <span className="mr-auto flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
              Saved automatically · <Kbd>Esc</Kbd> to close
            </span>
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        )
      }
    >
      {settings && (
        <div className="flex flex-col">
          {/* Pulled out to the panel edges so the rule under it spans the whole
              dialog while the field keeps the body's own gutter. */}
          <div className="sticky top-0 z-20 -mx-5 -mt-4 mb-4 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-5 pt-4 pb-3">
            <div className="relative">
              <Search
                size={14}
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-tertiary)]"
              />
              <TextInput
                value={query}
                // Deliberately not `type="search"`: Chromium adds its own
                // clear button, which would sit next to the one below.
                type="text"
                spellCheck={false}
                aria-label="Search settings"
                placeholder="Search every setting — try “clipboard”, “token”, “sleep”"
                className="pl-8"
                onChange={(e) => setQuery(e.target.value)}
              />
              {query !== "" && (
                <button
                  type="button"
                  aria-label="Clear the search"
                  onClick={() => setQuery("")}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-[var(--radius-control)] p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          <div className="flex gap-5">
            {/* Vertical tab rail. Selection is carried by the Button variant so
                no colour utility has to out-order another. */}
            <nav
              role="tablist"
              aria-orientation="vertical"
              aria-label="Settings sections"
              className="sticky top-[60px] flex w-[152px] shrink-0 flex-col gap-1 self-start"
            >
              {TABS.map((t) => {
                const n = counts?.get(t.id) ?? 0;
                const muted = counts !== null && n === 0;
                return (
                  <Button
                    key={t.id}
                    role="tab"
                    aria-selected={tab === t.id}
                    variant={tab === t.id ? "secondary" : "ghost"}
                    icon={t.icon}
                    disabled={muted}
                    className={clsx("w-full", muted && "opacity-40")}
                    onClick={() => setTab(t.id)}
                  >
                    {/* flex-1 does the left-aligning, which keeps the primitive's
                        own justify-center from having to be overridden. */}
                    <span className="flex-1 text-left">{t.label}</span>
                    {counts !== null && n > 0 && <Badge tone="accent">{n}</Badge>}
                  </Button>
                );
              })}
            </nav>

            <div className="min-h-[440px] min-w-0 flex-1">
              {nothingMatched ? (
                <div className="flex min-h-[260px] flex-col items-center justify-center gap-2 text-center">
                  <p className="text-[13px] text-[var(--text-primary)]">
                    Nothing matches “{query}”
                  </p>
                  <p className="max-w-[300px] text-[11px] leading-snug text-[var(--text-tertiary)]">
                    Search matches the name of a setting, the section it sits in
                    and the words people usually use for it.
                  </p>
                  <Button size="sm" className="mt-1" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                </div>
              ) : (
                <SearchScope hits={hits}>
                  {tab === "general" && <GeneralTab settings={settings} />}
                  {tab === "downloads" && <DownloadsTab settings={settings} />}
                  {tab === "scheduler" && <SchedulerTab settings={settings} />}
                  {tab === "capture" && <CaptureTab settings={settings} />}
                  {tab === "browser" && <BrowserTab settings={settings} />}
                  {tab === "media" && <MediaTab />}
                  {tab === "notifications" && (
                    <NotificationsTab settings={settings} />
                  )}
                  {tab === "system" && <SystemTab settings={settings} />}
                  {tab === "advanced" && <AdvancedTab settings={settings} />}
                </SearchScope>
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/**
 * What "reset to defaults" means.
 *
 * There is no `reset_settings` command, so this mirrors `Settings::default()`
 * in `crates/downpour-core/src/settings.rs` — keep the two in step. Where the
 * engine has a sentinel for "put your own default back" it is used instead of a
 * copied constant: `user_agent: ""` and any `rpc_port` under 1024 are both
 * replaced by `normalise()` on save, so those two values cannot drift.
 *
 * Three things are deliberately *not* reset, and the confirmation names all
 * three: the download folder (a path nobody wants re-guessed), the pairing
 * token (resetting it would silently unpair the browser extension — there is a
 * button on the Browser tab for that) and the scheduler's windows (hand-authored
 * content, not a preference). Category folders go back to being named after
 * their category, which is what the engine ships.
 */
