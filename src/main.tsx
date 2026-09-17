import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ConfirmWindow } from "./components/ConfirmWindow";
import { DownloadWindow } from "./components/DownloadWindow";
import { ProgressWindow } from "./components/ProgressWindow";
import "./styles/theme.css";

// In a browser (`npm run dev`) there is no Tauri bridge, so stub it before the
// app mounts. Tree-shaken out of any production build by the DEV guard.
if (import.meta.env.DEV) {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend();
}

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

// The compact panels -- the progress display, the capture prompt and the
// per-download boxes -- are further Tauri windows pointed at this same bundle.
// Routing on a query parameter keeps one build, one store and one set of
// design tokens rather than a second frontend to keep in sync.
//
// `download` is the only view that is parameterised. There is one window per
// download, so which download it is has to travel in the URL: the window has
// no store to read a selection out of, and its label is set before it loads.
//
// A missing id still routes to the box, which already knows how to say "that
// download is no longer in the list" and close itself. Falling through to the
// main app instead would render the whole interface into a 360x146 pane,
// which is a far worse answer to a malformed URL than an empty panel.
const params = new URLSearchParams(window.location.search);
const view = params.get("view");
const downloadId = params.get("id");

createRoot(root).render(
  <StrictMode>
    {view === "progress" ? (
      <ProgressWindow />
    ) : view === "confirm" ? (
      <ConfirmWindow />
    ) : view === "download" ? (
      <DownloadWindow id={downloadId ?? ""} />
    ) : (
      <App />
    )}
  </StrictMode>,
);
