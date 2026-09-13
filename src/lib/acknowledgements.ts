/**
 * Open-source components Downpour is built on.
 *
 * Principal components only — the ones a person would recognise and the ones
 * doing the real work. Not a generated dependency tree: a list of six hundred
 * transitive crates is not an acknowledgement, it is a way of not making one,
 * and nobody has ever read the second screen of it.
 *
 * Every licence string here was read from the package as it is installed in this
 * repository, not from memory. If a component is upgraded across a licence
 * change, this list is wrong until someone corrects it — so check the package's
 * own metadata when bumping, rather than trusting this file.
 *
 * `bundled: false` marks something Downpour fetches at your request rather than
 * ships. That distinction is the whole point of the field: claiming to
 * redistribute software you merely download would misstate both what the app
 * does and whose licence applies.
 */

export interface Acknowledgement {
  name: string;
  /** What it does here, in the app's own terms. */
  role: string;
  license: string;
  url: string;
  /** False when Downpour downloads it on demand instead of shipping it. */
  bundled?: boolean;
}

export const ACKNOWLEDGEMENTS: Acknowledgement[] = [
  {
    name: "Tauri",
    role: "The desktop shell and its webview",
    license: "Apache-2.0 OR MIT",
    url: "https://tauri.app",
  },
  {
    name: "React",
    role: "The interface",
    license: "MIT",
    url: "https://react.dev",
  },
  {
    name: "Tokio",
    role: "The async runtime every transfer runs on",
    license: "MIT",
    url: "https://tokio.rs",
  },
  {
    name: "reqwest",
    role: "The HTTP client behind the download engine",
    license: "MIT OR Apache-2.0",
    url: "https://github.com/seanmonstar/reqwest",
  },
  {
    name: "SQLite",
    role: "The queue, kept on disk so it survives a restart",
    license: "Public domain, via rusqlite (MIT)",
    url: "https://www.sqlite.org",
  },
  {
    name: "axum",
    role: "The local RPC server the browser extension talks to",
    license: "MIT",
    url: "https://github.com/tokio-rs/axum",
  },
  {
    name: "Tailwind CSS",
    role: "The styling system",
    license: "MIT",
    url: "https://tailwindcss.com",
  },
  {
    name: "Zustand",
    role: "Interface state",
    license: "MIT",
    url: "https://github.com/pmndrs/zustand",
  },
  {
    name: "Lucide",
    role: "The icons",
    license: "ISC",
    url: "https://lucide.dev",
  },
  {
    name: "TanStack Virtual",
    role: "Smooth scrolling through very long queues",
    license: "MIT",
    url: "https://tanstack.com/virtual",
  },
  {
    name: "yt-dlp",
    role: "Video page support — downloaded from its own releases when you ask for it, never bundled",
    license: "Unlicense",
    url: "https://github.com/yt-dlp/yt-dlp",
    bundled: false,
  },
];
