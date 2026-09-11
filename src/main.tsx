import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/theme.css";

// In a browser (`npm run dev`) there is no Tauri bridge, so stub it before the
// app mounts. Tree-shaken out of any production build by the DEV guard.
if (import.meta.env.DEV) {
  const { installMockBackend } = await import("./dev/mockBackend");
  installMockBackend();
}

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
