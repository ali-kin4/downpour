/**
 * The application menu bar.
 *
 * Rendered in-app rather than as a native Windows menu so it can carry the
 * app's own material and typography, and so every action stays one click from
 * the same place regardless of platform. It behaves like a real menu bar:
 * click to open, then hover to move between menus without clicking again.
 */

import clsx from "clsx";
import {
  ArrowDownToLine,
  ArrowUpCircle,
  Ban,
  BookOpen,
  Brush,
  ClipboardList,
  Cog,
  Eraser,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Info,
  ListRestart,
  Pause,
  Play,
  Power,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as api from "../lib/api";
import { useApp } from "../store/app";
import { Kbd } from "./ui";

const REPO_URL = "https://github.com/ali-kin4/downpour";

interface MenuAction {
  kind?: "action";
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}
interface MenuSeparator {
  kind: "separator";
}
type MenuEntry = MenuAction | MenuSeparator;

const sep: MenuSeparator = { kind: "separator" };

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const store = useApp;
  const stats = useApp((s) => s.stats);
  const settings = useApp((s) => s.settings);

  // Clicking anywhere else, or pressing Escape, closes the open menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const s = () => store.getState();
  const act = (label: string, fn: () => Promise<unknown>) => () =>
    void s().run(label, fn);

  const menus: Record<string, MenuEntry[]> = {
    File: [
      {
        label: "New download…",
        icon: <ArrowDownToLine size={14} />,
        shortcut: "Ctrl N",
        run: () => s().setAddOpen(true),
      },
      {
        label: "New batch…",
        icon: <ClipboardList size={14} />,
        shortcut: "Ctrl V",
        run: () => s().setPasteOpen(true),
      },
      sep,
      {
        label: "Open downloads folder",
        icon: <FolderOpen size={14} />,
        disabled: !settings,
        run: act("Could not open folder", () =>
          api.openPath(settings?.downloadDir ?? ""),
        ),
      },
      sep,
      {
        label: "Exit Downpour",
        icon: <Power size={14} />,
        run: act("Could not exit cleanly", api.quitApp),
      },
    ],

    Downloads: [
      {
        label: "Resume all",
        icon: <Play size={14} />,
        run: act("Could not resume", api.resumeAll),
      },
      {
        label: "Pause all",
        icon: <Pause size={14} />,
        run: act("Could not pause", api.pauseAll),
      },
      {
        label: "Retry failed",
        icon: <RefreshCw size={14} />,
        disabled: (stats?.failed ?? 0) === 0,
        run: act("Could not retry", api.retryFailed),
      },
      sep,
      {
        label: "Clear completed",
        icon: <Eraser size={14} />,
        disabled: (stats?.completed ?? 0) === 0,
        run: act("Could not clear", api.clearCompleted),
      },
      {
        label: "Clear all finished",
        icon: <Trash2 size={14} />,
        danger: true,
        run: act("Could not clear", api.clearFinished),
      },
    ],

    View: [
      {
        label: "All downloads",
        icon: <ListRestart size={14} />,
        run: () => s().setFilter("all"),
      },
      { label: "Active", icon: <Play size={14} />, run: () => s().setFilter("active") },
      { label: "Waiting", icon: <Pause size={14} />, run: () => s().setFilter("waiting") },
      {
        label: "Completed",
        icon: <ArrowDownToLine size={14} />,
        run: () => s().setFilter("completed"),
      },
      { label: "Failed", icon: <Ban size={14} />, run: () => s().setFilter("failed") },
      sep,
      {
        label: "Command palette…",
        icon: <Search size={14} />,
        shortcut: "Ctrl K",
        run: () => s().setPaletteOpen(true),
      },
    ],

    Tools: [
      {
        label: "Settings…",
        icon: <Cog size={14} />,
        shortcut: "Ctrl ,",
        run: () => s().setSettingsOpen(true),
      },
      {
        label: "Appearance",
        icon: <Brush size={14} />,
        run: () => s().setSettingsOpen(true),
      },
      sep,
      {
        label: "Cancel pending shutdown",
        icon: <Power size={14} />,
        // Only meaningful once a post-queue power action has been armed.
        disabled: !settings || settings.onQueueComplete === "nothing",
        run: act("Could not cancel", api.abortPowerAction),
      },
    ],

    Help: [
      {
        label: "Documentation",
        icon: <BookOpen size={14} />,
        run: () => void openUrl(`${REPO_URL}#readme`),
      },
      {
        label: "Report an issue",
        icon: <ExternalLink size={14} />,
        run: () => void openUrl(`${REPO_URL}/issues/new/choose`),
      },
      {
        label: "Source on GitHub",
        icon: <GitBranch size={14} />,
        run: () => void openUrl(REPO_URL),
      },
      sep,
      {
        label: "What's new",
        icon: <Sparkles size={14} />,
        run: () => s().setWhatsNewOpen(true),
      },
      {
        label: "Check for updates…",
        icon: <ArrowUpCircle size={14} />,
        run: () => s().openAboutForUpdates(),
      },
      {
        label: "About Downpour",
        icon: <Info size={14} />,
        run: () => s().setAboutOpen(true),
      },
    ],
  };

  return (
    <div
      ref={barRef}
      className="dp-panel relative z-30 flex h-9 shrink-0 items-center gap-0.5 border-t-0 border-r-0 border-l-0 px-2"
    >
      <div className="mr-2 flex items-center gap-1.5 pl-1">
        <DropletMark />
        <span className="text-[12px] font-semibold tracking-tight text-[var(--text-primary)]">
          Downpour
        </span>
      </div>

      {Object.entries(menus).map(([name, entries]) => (
        <div key={name} className="relative">
          <button
            type="button"
            onClick={() => setOpen(open === name ? null : name)}
            // Once one menu is open, hovering another switches to it, which is
            // how every desktop menu bar behaves.
            onMouseEnter={() => open && setOpen(name)}
            className={clsx(
              "h-7 rounded-[6px] px-2.5 text-[12px] transition-colors duration-100",
              open === name
                ? "bg-[var(--surface-selected)] text-[var(--text-primary)]"
                : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
            )}
          >
            {name}
          </button>

          {open === name && (
            <div
              role="menu"
              className={clsx(
                "dp-enter absolute top-full left-0 mt-1 min-w-[228px] overflow-hidden py-1",
                "rounded-[var(--radius-card)] border border-[var(--border-subtle)]",
                "bg-[var(--surface-raised)] shadow-[var(--shadow-overlay)]",
              )}
            >
              {entries.map((entry, i) =>
                "kind" in entry && entry.kind === "separator" ? (
                  <div
                    key={`sep-${i}`}
                    className="my-1 h-px bg-[var(--border-subtle)]"
                  />
                ) : (
                  <MenuRow
                    key={(entry as MenuAction).label}
                    action={entry as MenuAction}
                    onRun={() => setOpen(null)}
                  />
                ),
              )}
            </div>
          )}
        </div>
      ))}

      {/* Settings is the one thing people open constantly, and burying it three
          levels into Tools makes a menu bar feel like a filing cabinet. The
          shortcut still works; this is for the hand already on the mouse. */}
      <div className="ml-auto flex items-center gap-0.5 pr-0.5">
        <BarButton
          label="What's new"
          icon={<Sparkles size={15} />}
          onClick={() => s().setWhatsNewOpen(true)}
        />
        <BarButton
          label="Settings"
          shortcut="Ctrl+,"
          icon={<Cog size={15} />}
          onClick={() => s().setSettingsOpen(true)}
        />
      </div>
    </div>
  );
}

/**
 * An icon button in the bar itself, as opposed to an entry inside a menu.
 *
 * Reserved for things opened often enough that a two-click path is a tax.
 * `title` carries the label and the shortcut, because an unlabelled gear is
 * only obvious to someone who already knows what it does.
 */
function BarButton({
  label,
  shortcut,
  icon,
  onClick,
}: {
  label: string;
  shortcut?: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      onClick={onClick}
      className={clsx(
        "grid size-7 place-items-center rounded-[6px]",
        "text-[var(--text-secondary)] transition-colors duration-100",
        "hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
        "active:bg-[var(--surface-selected)]",
      )}
    >
      {icon}
    </button>
  );
}

function MenuRow({ action, onRun }: { action: MenuAction; onRun: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={action.disabled}
      onClick={() => {
        action.run();
        onRun();
      }}
      className={clsx(
        "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px]",
        "transition-colors duration-100 disabled:pointer-events-none disabled:opacity-35",
        action.danger
          ? "text-[var(--status-failed)] hover:bg-[var(--status-failed)]/10"
          : "text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
      )}
    >
      <span className="flex w-4 justify-center text-[var(--text-tertiary)]">
        {action.icon}
      </span>
      <span className="flex-1">{action.label}</span>
      {action.shortcut && <Kbd>{action.shortcut}</Kbd>}
    </button>
  );
}

/** The app mark: the same droplet as the installer icon, drawn inline. */
export function DropletMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="dp-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--color-accent-from)" />
          <stop offset="100%" stopColor="var(--color-accent-to)" />
        </linearGradient>
      </defs>
      <path
        d="M12 2.2c3.9 4.6 6.6 8.1 6.6 11.4a6.6 6.6 0 1 1-13.2 0C5.4 10.3 8.1 6.8 12 2.2Z"
        fill="url(#dp-mark)"
      />
      <path
        d="M12 9.6v5.2m0 0 2.2-2.2M12 14.8l-2.2-2.2"
        stroke="white"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
