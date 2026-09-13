/**
 * What's new, in plain language.
 *
 * `CHANGELOG.md` is the technical record: it names functions, explains why a
 * lock ordering changed, and is written for whoever reads the diff. This is the
 * version shown inside the app, written for whoever uses it — what changed for
 * them, in the words they would use for it.
 *
 * Deliberately short, and deliberately not a mirror of the changelog. It keeps
 * the current release plus a couple behind it, because two files that must be
 * edited together will drift, and bounding this one to what a person will
 * actually maintain is what stops it going stale.
 *
 * `title` is the headline a user scans; `detail` is the one sentence that says
 * what it means for them. No internals in either.
 *
 * The invariant: **every version bump adds an entry here.** The About window
 * falls back to the newest written release when the running version has none,
 * so a forgotten entry does not break anything -- it quietly shows the previous
 * release's notes beside the new version number, which is worse than an error
 * because nobody notices it.
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
