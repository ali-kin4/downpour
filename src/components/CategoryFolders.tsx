/**
 * Per-file-type destination folders.
 *
 * Downpour sorts downloads the way IDM does — Video, Music, Pictures,
 * Documents, Compressed, Programs — and this is where those destinations are
 * changed. Each row shows the folder's real path and whether it exists yet, so
 * "where did my file go?" is answerable without leaving the screen.
 */

import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import {
  AppWindow,
  Archive,
  Check,
  Clapperboard,
  FileText,
  FolderOpen,
  FolderPlus,
  Image,
  Music,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import * as api from "../lib/api";
import type { Settings } from "../lib/types";
import { useApp } from "../store/app";
import { Button, Switch, TextInput } from "./ui";

/** Maps the icon name stored on each category to a component. */
const ICONS: Record<string, ReactNode> = {
  clapperboard: <Clapperboard size={14} />,
  music: <Music size={14} />,
  image: <Image size={14} />,
  "file-text": <FileText size={14} />,
  archive: <Archive size={14} />,
  "app-window": <AppWindow size={14} />,
};

export function CategoryFolders({ settings }: { settings: Settings }) {
  const saveSettings = useApp((s) => s.saveSettings);
  const run = useApp((s) => s.run);
  const toast = useApp((s) => s.toast);
  const [folders, setFolders] = useState<api.CategoryFolderInfo[]>([]);

  const refresh = useCallback(() => {
    api.categoryFolders().then(setFolders, () => setFolders([]));
  }, []);

  useEffect(refresh, [refresh, settings.downloadDir, settings.categories]);

  const missing = folders.filter((f) => !f.exists).length;

  const setFolder = (name: string, folder: string) => {
    void saveSettings({
      ...settings,
      categories: settings.categories.map((c) =>
        c.name === name ? { ...c, folder } : c,
      ),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="text-[13px] text-[var(--text-primary)]">
            Sort downloads by file type
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-tertiary)]">
            Each download lands in the folder for its type. Turn this off to put
            everything straight in the download folder.
          </p>
        </div>
        <Switch
          checked={settings.sortIntoCategories}
          label="Sort downloads by file type"
          onChange={(v) => void saveSettings({ ...settings, sortIntoCategories: v })}
        />
      </div>

      {settings.sortIntoCategories && (
        <>
          <div className="divide-y divide-[var(--border-subtle)] rounded-[var(--radius-card)] border border-[var(--border-subtle)]">
            {settings.categories.map((c) => {
              const info = folders.find((f) => f.name === c.name);
              return (
                <div key={c.name} className="flex items-center gap-2.5 px-3 py-2">
                  <span className="flex w-5 shrink-0 justify-center text-[var(--text-tertiary)]">
                    {ICONS[c.icon] ?? <FolderOpen size={14} />}
                  </span>

                  <div className="w-[86px] shrink-0">
                    <div className="text-[12.5px] text-[var(--text-primary)]">{c.name}</div>
                    <div
                      className="truncate text-[10px] text-[var(--text-tertiary)]"
                      title={c.extensions.join(", ")}
                    >
                      {c.extensions.length} types
                    </div>
                  </div>

                  <TextInput
                    value={c.folder}
                    aria-label={`${c.name} folder`}
                    placeholder="(download folder)"
                    spellCheck={false}
                    onChange={(e) => setFolder(c.name, e.target.value)}
                  />

                  <span
                    className="w-4 shrink-0"
                    title={
                      info?.exists
                        ? `${info.path} exists`
                        : "This folder does not exist yet; it is created on the first download."
                    }
                  >
                    {info?.exists ? (
                      <Check size={13} style={{ color: "var(--status-complete)" }} />
                    ) : (
                      <TriangleAlert size={13} style={{ color: "var(--status-paused)" }} />
                    )}
                  </span>

                  <Button
                    size="sm"
                    aria-label={`Browse for the ${c.name} folder`}
                    icon={<FolderOpen size={13} />}
                    onClick={async () => {
                      const picked = await pickFolder({
                        directory: true,
                        defaultPath: settings.downloadDir,
                      });
                      if (typeof picked !== "string") return;
                      // Store a path relative to the download folder when it
                      // sits inside it, so moving the download folder moves the
                      // whole tree with it.
                      const base = settings.downloadDir.replace(/[\\/]+$/, "");
                      const rel = picked.startsWith(base + "\\")
                        ? picked.slice(base.length + 1)
                        : picked;
                      setFolder(c.name, rel);
                    }}
                  />
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              icon={<FolderPlus size={13} />}
              disabled={missing === 0}
              onClick={() =>
                void run("Could not create the folders", async () => {
                  const made = await api.createCategoryFolders();
                  toast({
                    tone: "success",
                    title: made === 0 ? "All folders already exist" : `Created ${made} folder${made === 1 ? "" : "s"}`,
                  });
                  refresh();
                })
              }
            >
              {missing === 0 ? "All folders exist" : `Create ${missing} missing folder${missing === 1 ? "" : "s"}`}
            </Button>
            <Button
              size="sm"
              icon={<FolderOpen size={13} />}
              onClick={() =>
                void run("Could not open the folder", () => api.openPath(settings.downloadDir))
              }
            >
              Open download folder
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
