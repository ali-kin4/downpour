import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri serves the dev build over a fixed port and needs a predictable one;
// letting Vite pick a free port would break `tauri dev` on every restart.
const HOST = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 5183,
    strictPort: true,
    host: HOST || false,
    hmr: HOST ? { protocol: "ws", host: HOST, port: 5184 } : undefined,
    watch: {
      // Rust rebuilds are driven by cargo, not Vite; watching target/ would
      // trigger a full page reload on every incremental compile.
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
  build: {
    // WebView2 on Windows 11 is evergreen Chromium, so there is no reason to
    // ship downlevelled output.
    target: "chrome120",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
