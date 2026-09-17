/**
 * What's new, in plain language.
 *
 * `CHANGELOG.md` is the technical record: it names functions, explains why a
 * lock ordering changed, and is written for whoever reads the diff. This is the
 * version shown inside the app, written for whoever uses it — what changed for
 * them, in the words they would use for it.
 *
 * Deliberately short, and deliberately not a mirror of the changelog: a couple
 * of lines per release, in the words someone would use for the thing itself.
 * Every release is kept, newest first, because What's new lists the earlier
 * ones and someone upgrading from three versions back wants all three.
 *
 * `title` is the headline a user scans; `detail` is the one sentence that says
 * what it means for them. No internals in either.
 *
 * The invariant: **every version bump adds an entry here, at the top.** What's
 * new falls back to the newest written release when the running version has
 * none, so a forgotten entry breaks nothing -- it quietly shows an older
 * release's notes under an older release's number, and the upgrade prompt that
 * would have made that obvious never opens, because it too waits for notes
 * that match. That is how this file came to sit on 1.2.1 while the app said
 * 1.5.1, for eight releases. `release-notes.test.mjs` now fails on it, and the
 * `release` skill names the step.
 */

export interface ReleaseNote {
  title: string;
  detail: string;
}

export interface Release {
  version: string;
  /** ISO date, or `null` while the version is still unreleased. */
  date: string | null;
  /** One line on the release as a whole, where it has a theme worth naming. */
  summary?: string;
  notes: ReleaseNote[];
}

export const RELEASES: Release[] = [
  {
    version: "1.5.2",
    date: "2026-09-17",
    notes: [
      {
        title: "This window tells you about the version you are running",
        detail:
          "It had been announcing 1.2.1 since 1.2.1 — eight releases arrived without it noticing, and everything you had actually been given sat in the list below as though it were older news. All eight are written up, so what you see here is the real history again.",
      },
    ],
  },
  {
    version: "1.5.1",
    date: "2026-09-17",
    notes: [
      {
        title: "Keep a link without spending the bandwidth on it",
        detail:
          "The question Downpour asks about a download from your browser now has a third answer: Add to list. It goes into the list without starting, ready for whenever you want it — which used to mean taking the download and pausing it a second later.",
      },
      {
        title: "That question is sized to what it asks",
        detail:
          "It stood taller than its contents, with a band of empty panel under the destination that made a one-line question look like an unfinished window.",
      },
    ],
  },
  {
    version: "1.5.0",
    date: "2026-09-17",
    summary: "History for what you remove, a panel per download, and pairing without a token.",
    notes: [
      {
        title: "Downloads you remove are kept",
        detail:
          "Removing one from the list used to erase every trace of it. Removed downloads are now kept as history, where you can see what was there and put one back. They are forgotten after 90 days, or never, if you would rather keep the lot.",
      },
      {
        title: "A box per download, from the tray",
        detail:
          "The tray lists what is downloading now; picking one opens a small always-on-top panel for that download alone — progress, speed, time left, pause and resume. Several can be open at once, and a box stays put when its download finishes or fails, because that is the thing you opened it to see.",
      },
      {
        title: "Pair a browser with one click",
        detail:
          "Settings › Browser integration opens a one-minute window in which the extension collects the pairing key itself. There is no 64-character token to find, copy and paste, and the key never appears on screen or on a clipboard — so this is the safer route as well as the shorter one.",
      },
      {
        title: "Chrome's download bar can be hidden",
        detail:
          "Chrome starts every download before the extension can hand it over, so its bar appears for a moment and is then taken away again. Off by default: it applies to the whole browser, so a download you deliberately leave to Chrome would lose its progress bar too.",
      },
      {
        title: "A download captured from the browser asks again",
        detail:
          "In 1.4.0 the question never arrived and the download simply vanished — nothing was queued and nothing was said.",
      },
    ],
  },
  {
    version: "1.4.0",
    date: "2026-09-17",
    notes: [
      {
        title: "The browser asks in a small panel, not by raising the whole app",
        detail:
          "A download from your browser is put to you in a compact window near the middle of the screen, carrying the filename, size, source and destination — Enter to take it, Escape to decline. A page that fires four at once asks about them in turn and shows how many are waiting. Declining is not a half measure: nothing is fetched, by Downpour or by the browser.",
      },
    ],
  },
  {
    version: "1.3.3",
    date: "2026-09-17",
    notes: [
      {
        title: "Pause stops a download now, not in a few seconds",
        detail:
          "A paused download used to trickle on, slower and slower, until the last connection gave up — and longer still with a speed limit set. It now stops when you ask, including when the server has gone quiet and nothing is arriving at all.",
      },
    ],
  },
  {
    version: "1.3.2",
    date: "2026-09-17",
    notes: [
      {
        title: "The folder button beside a destination is easier to see and to hit",
        detail:
          "It was a small grey glyph with the same weight as a cancel, though it is the only way to answer \"where does this go?\" without typing a path by hand. It is now a larger mark in the accent colour, on a wider button, and the same one everywhere.",
      },
      {
        title: "Re-adding a download continues from the bytes on disk",
        detail:
          "The part file left behind by a removed download is picked up, rather than set aside while the whole file downloads a second time under a numbered name.",
      },
    ],
  },
  {
    version: "1.3.1",
    date: "2026-09-17",
    notes: [
      {
        title: "Adding a removed download again resumes it",
        detail:
          "Removing a download from the list leaves its bytes on disk — the file is only deleted if you ask for that separately. Adding the same link again now carries on from those bytes, instead of downloading the whole file a second time and leaving the original stranded. Two things have to agree before it does: no other download is using that name, and the bytes belong to the same link.",
      },
    ],
  },
  {
    version: "1.3.0",
    date: "2026-09-16",
    notes: [
      {
        title: "Downloads from the browser can ask first",
        detail:
          "Clicking a download in your browser opens Downpour's add dialog already filled in — filename, folder, size and the browser's own session — instead of starting straight away. Only the click the extension intercepts is put to you: the right-click menu, the button over a video and the link grabber are already an explicit choice. Settings › Browser integration › Ask before starting a download from the browser.",
      },
      {
        title: "The extension shows the version it really is",
        detail:
          "Your browser's extensions page read 0.1.0 whichever release you had installed.",
      },
    ],
  },
  {
    version: "1.2.2",
    date: "2026-09-16",
    notes: [
      {
        title: "The row menu no longer drags the table sideways",
        detail:
          "Opening a row's ... menu, or right-clicking a row, shifted every column and cut the filenames off mid-word. The menu now opens where you asked for it and the table stays where it is.",
      },
      {
        title: "Column edges can be found",
        detail:
          "Dragging an edge to resize a column and double-clicking one to fit it to its contents both worked already, but nothing was drawn to say so. Each boundary now carries a visible rule.",
      },
      {
        title: "Columns stay inside the window",
        detail:
          "A column dragged wider than the window — or an extra one switched on — scrolled the rows out from under their own headings. Widths are held to the space there is, and given back when the window shrinks.",
      },
    ],
  },
  {
    version: "1.2.1",
    date: "2026-09-13",
    notes: [
      {
        title: "Menus close when you expect them to",
        detail:
          "Opening a menu and then clicking or moving elsewhere in the bar left it hanging open — including behind the Settings window.",
      },
    ],
  },
  {
    version: "1.2.0",
    date: "2026-09-13",
    summary: "Eleven themes, dates on your downloads, and settings one click away.",
    notes: [
      {
        title: "Eleven colour themes",
        detail:
          "Sakura, Matcha, Cinnamon, Moonlit, Grape Soda, Peach Fuzz, Mint Condition, Glacier, Bubblegum and Midnight Oil. Each has a light and a dark side, so they sit on top of your Light/Dark/System choice rather than replacing it — leave Downpour on System and your theme follows Windows from day to night. Settings › General › Appearance.",
      },
      {
        title: "See when you added a download",
        detail:
          "The list has an Added column. Right-click the column headings to add Finished and Source too, or to hide anything you do not use.",
      },
      {
        title: "Settings is one click away",
        detail:
          "A gear in the top-right of the menu bar, next to a button for this window.",
      },
      {
        title: "Dialogs close properly",
        detail:
          "The little × in the corner of every dialog was too small and too faint to aim at. It is now a real button.",
      },
    ],
  },
  {
    version: "1.1.1",
    date: "2026-09-13",
    notes: [
      {
        title: "What's new has its own window",
        detail:
          "It used to be buried in About. About now says what Downpour is, who made it and what you may do with it — and this window tells you what changed. Find it again under Help.",
      },
    ],
  },
  {
    version: "1.1.0",
    date: "2026-09-13",
    summary: "Two pauses that did not hold, and a window that tells you what you are running.",
    notes: [
      {
        title: "Pause All now stops scheduled downloads",
        detail:
          "A download pinned to a schedule could start itself again a moment after you paused it. Pausing now holds until you resume it yourself.",
      },
      {
        title: "Your PC no longer sleeps after a download fails",
        detail:
          "\"Sleep when finished\" acted on a queue where nothing had actually finished, and kept firing on later downloads. It now runs only when something completed, and only once per time you ask for it.",
      },
      {
        title: "Sleep is gentler, and cancellable",
        detail:
          "Sleep was forced on the machine immediately. It is now requested normally, after the same 60-second countdown as shutdown, and one Cancel calls off any of the three.",
      },
      {
        title: "Free to use, not free to take",
        detail:
          "Downpour is free on as many machines as you like, at home or at work, with no account and no payment — and from this version nobody may redistribute it, sell it, or ship their own build of it.",
      },
      {
        title: "Credits, licences and trademark, properly stated",
        detail:
          "About now says who made Downpour, what it is built on, and that while the code is open, the name and logo are not free to take.",
      },
      {
        title: "An About window, with a check for updates",
        detail:
          "See the version you are running, what changed in it, and check for a newer one when you feel like it. Downpour never checks on its own.",
      },
    ],
  },
  {
    version: "1.0.1",
    date: "2026-09-11",
    notes: [
      {
        title: "A download button on videos",
        detail:
          "The browser extension shows a button over a video when you hover it, and lists the real qualities with their sizes.",
      },
      {
        title: "A round clock for scheduler windows",
        detail:
          "Midnight sits at the top, so an overnight window reads as one sweep rather than two numbers to subtract.",
      },
      {
        title: "Downloads resume where they stopped",
        detail:
          "A video download interrupted part-way carries on from there instead of starting over.",
      },
    ],
  },
  {
    version: "1.0.0",
    date: "2026-09-11",
    notes: [
      {
        title: "The first release",
        detail:
          "Multi-connection downloads, clipboard and browser capture, a scheduler, and the compact progress panel.",
      },
    ],
  },
];

/** The notes for a specific version, or `undefined` when none are written. */
export const notesFor = (version: string): Release | undefined =>
  RELEASES.find((r) => r.version === version.trim().replace(/^v/i, ""));
