/**
 * Drag-and-drop target for the whole window.
 *
 * Two things get dropped on a download manager, and both matter:
 *
 * - **A link dragged out of a browser.** This is the IDM gesture people have in
 *   their fingers. It arrives as `text/uri-list` or `text/plain`.
 * - **A `.txt` of links.** Arrives as a `File`, read here rather than through a
 *   filesystem permission, because the drop itself is the user's consent and
 *   the webview already has the bytes.
 *
 * This requires `dragDropEnabled: false` in `tauri.conf.json`. With Tauri's own
 * drag-drop handling on, the webview never sees an HTML5 drop event at all and
 * dragging a link from a browser silently does nothing.
 */

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import * as api from "../lib/api";
import { useApp } from "../store/app";

/** Files above this are certainly not a list of links. */
const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;

export function DropZone() {
  const [active, setActive] = useState(false);
  const run = useApp((s) => s.run);
  const toast = useApp((s) => s.toast);
  const settings = useApp((s) => s.settings);

  useEffect(() => {
    // Depth counting, not a boolean: dragging across a child element fires
    // `dragleave` on the parent, and a naive flag makes the overlay flicker on
    // every internal boundary.
    let depth = 0;

    const onEnter = (e: DragEvent) => {
      if (!hasDroppableData(e)) return;
      e.preventDefault();
      depth += 1;
      setActive(true);
    };

    const onOver = (e: DragEvent) => {
      if (!hasDroppableData(e)) return;
      // Without preventDefault the browser treats the drop as navigation and
      // replaces the whole app with the dropped file.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };

    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setActive(false);
      void handleDrop(e);
    };

    const handleDrop = async (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt) return;

      // `text/uri-list` is what a browser gives for a dragged link and is
      // preferred; `text/plain` is the fallback and is often the same string.
      let text = dt.getData("text/uri-list") || dt.getData("text/plain") || "";

      for (const file of Array.from(dt.files ?? [])) {
        if (file.size > MAX_TEXT_FILE_BYTES) {
          toast({
            tone: "error",
            title: `${file.name} is too large to read as a link list`,
          });
          continue;
        }
        // Anything that is not plainly text is far more likely to be a file
        // the user wanted to *upload* somewhere than a list of links.
        if (file.type && !file.type.startsWith("text/")) {
          toast({
            tone: "info",
            title: `${file.name} is not a text file`,
            detail: "Drop a .txt of links, or a link dragged from your browser.",
          });
          continue;
        }
        text += `\n${await file.text()}`;
      }

      if (!text.trim()) return;

      const found = await api.previewLinks(text).catch(() => []);
      if (found.length === 0) {
        toast({ tone: "info", title: "No links in what you dropped" });
        return;
      }

      await run("Could not add the dropped links", async () => {
        // A single dropped link is an unambiguous "get this"; a batch is more
        // likely something to review first, matching the paste dialog's
        // default.
        const ids = await api.addFromText(
          text,
          found.length === 1 ? "start" : settings?.scheduleNewDownloads ? "schedule" : "addonly",
          null,
        );
        toast({
          tone: "success",
          title:
            ids.length === 1
              ? "Download started"
              : `${ids.length} links added`,
          detail: ids.length > 1 ? "Review them in the list, then start." : undefined,
        });
      });
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [run, toast, settings?.scheduleNewDownloads]);

  if (!active) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center p-6">
      <div className="absolute inset-0 bg-[var(--accent-soft)] backdrop-blur-[2px]" />
      <div
        className="dp-enter relative flex flex-col items-center gap-2 rounded-[var(--radius-panel)] border-2 border-dashed px-10 py-8"
        style={{
          borderColor: "var(--accent)",
          background: "var(--surface-raised)",
          boxShadow: "var(--shadow-overlay)",
        }}
      >
        <Download size={28} style={{ color: "var(--accent)" }} />
        <div className="text-[14px] font-semibold text-[var(--text-primary)]">
          Drop to download
        </div>
        <div className="text-[11.5px] text-[var(--text-secondary)]">
          A link, or a text file full of them
        </div>
      </div>
    </div>
  );
}

/**
 * Whether a drag carries something worth intercepting.
 *
 * Checked on `dragenter`/`dragover`, where the *contents* are not readable for
 * security reasons — only the types are. Reading them here would return empty
 * strings and make the overlay never appear.
 */
function hasDroppableData(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return (
    types.includes("text/uri-list") ||
    types.includes("text/plain") ||
    types.includes("Files")
  );
}
