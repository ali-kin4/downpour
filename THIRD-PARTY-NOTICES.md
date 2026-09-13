# Third-party notices

Downpour is built on the open-source components below. Each remains under its own
licence, which continues to govern it: nothing in Downpour's [LICENSE](LICENSE)
restricts, reduces or overrides any right those licences grant you.

Licence identifiers here were read from each package as installed in this
repository rather than from memory. When a component is upgraded, check its own
metadata rather than trusting this file.

## Tauri

- Licence: **Apache-2.0 OR MIT**
- Home: https://tauri.app
- Used for: The desktop shell and its webview

## React

- Licence: **MIT**
- Home: https://react.dev
- Used for: The interface

## Tokio

- Licence: **MIT**
- Home: https://tokio.rs
- Used for: The async runtime every transfer runs on

## reqwest

- Licence: **MIT OR Apache-2.0**
- Home: https://github.com/seanmonstar/reqwest
- Used for: The HTTP client behind the download engine

## SQLite

- Licence: **Public domain, via rusqlite (MIT)**
- Home: https://www.sqlite.org
- Used for: The queue, kept on disk so it survives a restart

## axum

- Licence: **MIT**
- Home: https://github.com/tokio-rs/axum
- Used for: The local RPC server the browser extension talks to

## Tailwind CSS

- Licence: **MIT**
- Home: https://tailwindcss.com
- Used for: The styling system

## Zustand

- Licence: **MIT**
- Home: https://github.com/pmndrs/zustand
- Used for: Interface state

## Lucide

- Licence: **ISC**
- Home: https://lucide.dev
- Used for: The icons

## TanStack Virtual

- Licence: **MIT**
- Home: https://tanstack.com/virtual
- Used for: Smooth scrolling through very long queues

## yt-dlp

- Licence: **Unlicense**
- Home: https://github.com/yt-dlp/yt-dlp
- **Not bundled with Downpour.** Downpour downloads it from its own
  publisher at your request; it is not part of Downpour and is covered
  solely by its own licence.
- Used for: Video page support â€” downloaded from its own releases when you ask for it, never bundled

---

Full licence texts are published by each project at the addresses above. Where a
licence requires its copyright notice to accompany distributions of the software
-- as MIT, Apache-2.0 and ISC each do -- this file is that notice, and it is
published with every Downpour release.

© 2026 Ali Jabbary. Downpour itself is licensed separately: see [LICENSE](LICENSE).
