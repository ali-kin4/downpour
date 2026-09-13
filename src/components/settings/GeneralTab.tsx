/** Files, folders and how the app looks. */

import clsx from "clsx";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Check, Folder, Laptop, Moon, Sun } from "lucide-react";
import { Button, Field, Row, Segmented } from "../ui";
import { CategoryFolders } from "../CategoryFolders";
import { ACCENTS } from "../../hooks/useTheme";
import { DEFAULT_THEME_ID, themeById } from "../../themes/registry";
import { ThemeGallery } from "./ThemeGallery";
import type { ConflictPolicy, Settings } from "../../lib/types";
import { useApp } from "../../store/app";
import { DraftInput, Group, Setting, current, patch } from "./kit";

export function GeneralTab({ settings }: { settings: Settings }) {
  const run = useApp((s) => s.run);

  const browse = () =>
    void run("Could not open the folder picker", async () => {
      const picked = await openFileDialog({
        directory: true,
        multiple: false,
        defaultPath: settings.downloadDir || undefined,
        title: "Choose the download folder",
      });
      if (typeof picked === "string") await patch({ downloadDir: picked });
    });

  // A non-default theme carries its own accent, which outranks the swatches.
  const themed = settings.palette !== DEFAULT_THEME_ID;

  return (
    <>
      <Group
        id="general.files"
        description="Where finished downloads land, and what happens when a name is already taken."
      >
        <Setting id="general.files.downloadDir">
          <div className="py-2.5">
            <Field
              label="Download folder"
              hint="New downloads default here. Existing downloads keep the folder they were created with."
            >
              <div className="flex gap-2">
                <DraftInput
                  value={settings.downloadDir}
                  spellCheck={false}
                  aria-label="Download folder"
                  style={{ fontSize: 12 }}
                  className="font-mono"
                  onCommit={async (raw) => {
                    const next = raw.trim();
                    if (next) await patch({ downloadDir: next });
                    return current("downloadDir") ?? settings.downloadDir;
                  }}
                />
                <Button icon={<Folder size={14} />} onClick={browse}>
                  Browse
                </Button>
              </div>
            </Field>
          </div>
        </Setting>

        <Setting id="general.files.categories">
          <div className="py-2.5">
            <CategoryFolders settings={settings} />
          </div>
        </Setting>

        <Setting id="general.files.conflict">
          <Row
            label="When the file already exists"
            hint="Rename keeps both copies as “name (1).zip”. Skip marks the download complete without transferring."
          >
            <Segmented<ConflictPolicy>
              value={settings.conflictPolicy}
              onChange={(v) => void patch({ conflictPolicy: v })}
              options={[
                { value: "rename", label: "Rename" },
                { value: "overwrite", label: "Overwrite" },
                { value: "skip", label: "Skip" },
              ]}
            />
          </Row>
        </Setting>
      </Group>

      <Group id="general.appearance">
        <Setting id="general.appearance.theme">
          <Row label="Theme" hint="System follows Windows and changes with it.">
            <Segmented
              value={
                settings.theme === "light" || settings.theme === "dark"
                  ? settings.theme
                  : "system"
              }
              onChange={(v) => void patch({ theme: v })}
              options={[
                { value: "system", label: "System", icon: <Laptop size={13} /> },
                { value: "light", label: "Light", icon: <Sun size={13} /> },
                { value: "dark", label: "Dark", icon: <Moon size={13} /> },
              ]}
            />
          </Row>
        </Setting>

        <Setting id="general.appearance.palette">
          <div className="py-2.5">
            <div className="text-[13px] text-[var(--text-primary)]">
              Colour theme
            </div>
            <p className="mt-0.5 mb-3 text-[11px] leading-snug text-[var(--text-tertiary)]">
              Sits on top of the setting above rather than replacing it. Every
              theme has a light and a dark side, so on System it follows Windows
              from day to night and stays itself.
            </p>
            <ThemeGallery value={settings.palette} />
          </div>
        </Setting>

        <Setting id="general.appearance.accent">
          <Row
            label="Accent colour"
            hint={
              themed
                ? `Set by ${themeById(settings.palette).name}. Choose the Downpour theme to pick an accent yourself.`
                : "Used for progress bars, the selected sidebar item, focus rings and every primary button."
            }
          >
            <AccentPicker value={settings.accent} disabled={themed} />
          </Row>
        </Setting>
      </Group>
    </>
  );
}

/**
 * The accent swatches.
 *
 * The two stops come from `ACCENTS`, which is the same table `theme.css`
 * mirrors — a swatch cannot read `--color-accent-from` itself, because those
 * variables are only defined on `:root[data-accent=…]` and a swatch is not the
 * root. The tick is not decoration: it is what tells you which one is selected
 * without relying on seeing the ring colour.
 */
function AccentPicker({
  value,
  disabled,
}: {
  value: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Accent colour"
      className={clsx("flex gap-2", disabled && "pointer-events-none opacity-40")}
    >
      {ACCENTS.map((a) => {
        const selected = value === a.id;
        return (
          <button
            key={a.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={a.label}
            title={a.label}
            disabled={disabled}
            onClick={() => void patch({ accent: a.id })}
            className={clsx(
              "inline-flex size-7 items-center justify-center rounded-full border-2 p-[2px]",
              "transition-colors duration-150",
              selected
                ? "border-[var(--text-primary)]"
                : "border-transparent hover:border-[var(--border-strong)]",
            )}
          >
            <span
              className="flex size-full items-center justify-center rounded-full"
              style={{
                backgroundImage: `linear-gradient(115deg, ${a.from}, ${a.to})`,
              }}
            >
              {selected && (
                <Check size={12} style={{ color: "var(--text-on-accent)" }} />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
