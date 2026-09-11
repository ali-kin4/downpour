/**
 * Batch link import.
 *
 * This is the "I have twenty links in my clipboard, or in a .txt file" flow.
 * Two things make it usable rather than merely present: it accepts messy input
 * (prose, mixed separators, duplicates) and it tells you exactly how many
 * links it found *before* you commit, so a paste that silently found three
 * links out of twenty cannot slip through.
 */

import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import {
  CalendarClock,
  ClipboardPaste,
  FileUp,
  FolderOpen,
  Play,
  Plus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { open as openFolder } from "@tauri-apps/plugin-dialog";
import * as api from "../lib/api";
import { hostOf } from "../lib/format";
import type { StartMode } from "../lib/types";
import { useApp } from "../store/app";
import { Button, Dialog, Field, Segmented, TextArea, TextInput } from "./ui";

export function PasteDialog() {
  const open = useApp((s) => s.pasteOpen);
  const setOpen = useApp((s) => s.setPasteOpen);
  const settings = useApp((s) => s.settings);
  const run = useApp((s) => s.run);
  const toast = useApp((s) => s.toast);

  const [text, setText] = useState("");
  const [destDir, setDestDir] = useState("");
  // Defaults to "add only": pasting twenty links and having them all start at
  // once is rarely what anyone wants, and it is the destructive default.
  const [startMode, setStartMode] = useState<StartMode>("addonly");
  const [links, setLinks] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText("");
    setLinks([]);
    setDestDir(settings?.downloadDir ?? "");
    setStartMode(settings?.scheduleNewDownloads ? "schedule" : "addonly");

    // Pre-fill from the clipboard when it looks like a link list.
    void readText().then(
      (clip) => {
        if (clip && /https?:\/\//i.test(clip)) setText(clip);
      },
      () => undefined,
    );
  }, [open, settings?.downloadDir, settings?.scheduleNewDownloads]);

  // The backend owns URL extraction, so the count shown here is exactly what
  // will be added — a second, slightly different parser in the UI would be a
  // reliable source of "it said 20 but added 18".
  const seq = useRef(0);
  useEffect(() => {
    if (!text.trim()) {
      setLinks([]);
      return;
    }
    const id = ++seq.current;
    const timer = window.setTimeout(() => {
      api.previewLinks(text).then(
        (found) => id === seq.current && setLinks(found),
        () => id === seq.current && setLinks([]),
      );
    }, 200);
    return () => window.clearTimeout(timer);
  }, [text]);

  const hosts = new Set(links.map(hostOf));

  const submit = async () => {
    if (links.length === 0 || busy) return;
    setBusy(true);
    await run("Could not add the links", async () => {
      const ids = await api.addFromText(text, startMode, destDir.trim() || null);
      toast({
        tone: "success",
        title: `${ids.length} download${ids.length === 1 ? "" : "s"} added`,
        detail: startMode === "start" ? "Starting now." : undefined,
      });
      setOpen(false);
    });
    setBusy(false);
  };

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title="Add links"
      subtitle="Paste anything. Downpour finds the links in it."
      width={620}
      footer={
        <>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={links.length === 0 || busy}
            onClick={() => void submit()}
            icon={startMode === "start" ? <Play size={14} /> : <Plus size={14} />}
          >
            {links.length === 0
              ? "Add links"
              : `Add ${links.length} link${links.length === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex gap-2">
          <Button
            size="sm"
            icon={<ClipboardPaste size={13} />}
            onClick={async () => {
              const clip = await readText().catch(() => null);
              if (clip) setText((t) => (t ? `${t}\n${clip}` : clip));
            }}
          >
            Paste from clipboard
          </Button>
          <Button
            size="sm"
            icon={<FileUp size={13} />}
            onClick={async () => {
              const picked = await openFile({
                multiple: false,
                filters: [{ name: "Text", extensions: ["txt", "csv", "md", "log"] }],
              });
              if (typeof picked !== "string") return;
              await run("Could not read that file", async () => {
                const contents = await api.readTextFile(picked);
                setText((t) => (t ? `${t}
${contents}` : contents));
              });
            }}
          >
            Import from file
          </Button>
        </div>

        <Field label="Links">
          <TextArea
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "https://example.com/one.zip\nhttps://example.com/two.zip\n\nPaste a whole page of text if you like — anything that is not a link is ignored."
            }
            spellCheck={false}
          />
        </Field>

        <div
          className="flex items-center justify-between rounded-[var(--radius-card)] border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-2 text-[12px]"
          aria-live="polite"
        >
          {links.length === 0 ? (
            <span className="text-[var(--text-tertiary)]">
              {text.trim() ? "No links found yet." : "Nothing pasted yet."}
            </span>
          ) : (
            <>
              <span className="text-[var(--text-primary)]">
                <span className="font-semibold">{links.length}</span> link
                {links.length === 1 ? "" : "s"} found
                {hosts.size > 1 && (
                  <span className="text-[var(--text-tertiary)]">
                    {" "}
                    across {hosts.size} sites
                  </span>
                )}
              </span>
              <span className="truncate pl-3 text-[11px] text-[var(--text-tertiary)]">
                Duplicates removed
              </span>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Folder">
            <div className="flex gap-1.5">
              <TextInput
                value={destDir}
                onChange={(e) => setDestDir(e.target.value)}
                spellCheck={false}
              />
              <Button
                aria-label="Browse for a folder"
                icon={<FolderOpen size={14} />}
                onClick={async () => {
                  const picked = await openFolder({
                    directory: true,
                    defaultPath: destDir || undefined,
                  });
                  if (typeof picked === "string") setDestDir(picked);
                }}
              />
            </div>
          </Field>

          <Field label="When to start">
            <Segmented<StartMode>
              value={startMode}
              onChange={setStartMode}
              options={[
                { value: "addonly", label: "Add only", icon: <Plus size={12} /> },
                { value: "start", label: "Start now", icon: <Play size={12} /> },
                {
                  value: "schedule",
                  label: "Schedule",
                  icon: <CalendarClock size={12} />,
                },
              ]}
            />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}
