import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
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

// The compact progress panel is a second Tauri window pointed at this same
// bundle. Routing on a query parameter keeps one build, one store and one set
// of design tokens rather than a second frontend to keep in sync.
const view = new URLSearchParams(window.location.search).get("view");

createRoot(root).render(
  <StrictMode>{view === "progress" ? <ProgressWindow /> : <App />}</StrictMode>,
);
