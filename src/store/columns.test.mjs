/**
 * Layout arithmetic for the download table's columns.
 *
 * The store decides how wide every column is, and one invariant matters more
 * than the rest: the grid must never be wider than its container. The header
 * is a sibling *above* the scroll area rather than a row inside it, so an
 * overflowing grid does not scroll them together — it scrolls the rows out
 * from under their own headings. Every width change therefore goes through a
 * clamp, and each of the four paths that can widen the grid (a drag, an
 * auto-fit, showing a hidden column, the window growing) has to respect it.
 *
 * That is arithmetic, not behaviour: it needs no DOM, no React and no window.
 * So rather than bring a test framework and a jsdom into a project whose
 * testing lives in Rust, this transpiles the store with the esbuild that Vite
 * already ships, hands it a `localStorage` stub, and asserts on the numbers.
 * `node src/store/columns.test.mjs`, or `npm run test:frontend`.
 */

import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Widths are read from storage as the module loads, so stub it first. */
const saved = new Map();
globalThis.localStorage = {
  getItem: (k) => (saved.has(k) ? saved.get(k) : null),
  setItem: (k, v) => saved.set(k, String(v)),
  removeItem: (k) => saved.delete(k),
};

// Bundled rather than merely transpiled: the output is imported from a temp
// directory, where a bare `zustand` specifier would not resolve.
const dir = await mkdtemp(join(tmpdir(), "downpour-columns-"));
const outfile = join(dir, "columns.mjs");
await build({
  entryPoints: ["src/store/columns.ts"],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "error",
});

const { useColumns, COLUMNS, COLUMN_GAP, GUTTER_LEAD, GUTTER_TRAIL, visibleColumns } =
  await import(pathToFileURL(outfile).href);
await rm(dir, { recursive: true, force: true });

/** What `gridTemplate` will actually occupy: both gutters, the columns, the gaps. */
function laidOut() {
  const { widths, hidden } = useColumns.getState();
  const cols = visibleColumns(hidden);
  return (
    GUTTER_LEAD +
    GUTTER_TRAIL +
    cols.reduce((total, c) => total + widths[c.id], 0) +
    COLUMN_GAP * (cols.length + 1)
  );
}

const minOf = (id) => COLUMNS.find((c) => c.id === id).min;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

/**
 * Back to defaults, fitted to `container`.
 *
 * Each section starts here on purpose. Run end to end on one layout and the
 * assertions stop meaning anything: an auto-fit that shrinks Name leaves
 * enough slack that a *later* section passes whether or not the code under it
 * works. Every case below wants a full layout with no room to spare.
 */
function fresh(container) {
  useColumns.getState().reset();
  useColumns.getState().fitToContainer(container);
}

/** A window wide enough for every column at a comfortable width. */
const WIDE = 2348;

fresh(WIDE);
check("the initial layout fits its container", laidOut() <= WIDE, `${laidOut()} / ${WIDE}`);

// A drag thrown far past the right edge stops at the edge...
fresh(WIDE);
useColumns.getState().resize("name", 9999);
useColumns.getState().endResize("name");
check("a drag past the edge is clamped", laidOut() <= WIDE, `${laidOut()} / ${WIDE}`);

// ...and the width it settled on survives a restart.
const stored = JSON.parse(localStorage.getItem("downpour.columns.v1") ?? "null");
check(
  "the drag is persisted",
  stored?.widths.name === useColumns.getState().widths.name && stored?.nameManual === true,
  `stored name=${stored?.widths.name} nameManual=${stored?.nameManual}`,
);

// Auto-fit is clamped too: one absurd filename cannot push the rest off screen.
fresh(WIDE);
useColumns.getState().autoFit("name", 5000);
check("auto-fit is clamped", laidOut() <= WIDE, `${laidOut()} / ${WIDE}`);

// Showing a column widens the grid without changing the header's own width, so
// no ResizeObserver tick is coming: `toggle` has to refit by itself. Starting
// from a full layout is the whole point -- with slack in it, an unfitted
// toggle would fit by accident and prove nothing.
fresh(WIDE);
useColumns.getState().toggle("completed");
check("showing Finished refits", laidOut() <= WIDE, `${laidOut()} / ${WIDE}`);
useColumns.getState().toggle("source");
check("showing Source refits", laidOut() <= WIDE, `${laidOut()} / ${WIDE}`);
check(
  "both optional columns really are shown",
  visibleColumns(useColumns.getState().hidden).length === COLUMNS.length,
  `${visibleColumns(useColumns.getState().hidden).length} / ${COLUMNS.length}`,
);

// A window that shrinks under a hand-made layout takes space back rather than
// letting the grid overflow the header.
const NARROW = 1100;
const before = laidOut();
useColumns.getState().fitToContainer(NARROW);
check("shrinking the window gives space back", laidOut() < before, `${before} → ${laidOut()}`);

// 1100px cannot hold all nine columns however they are arranged. The floor is
// both flexible columns at their hard minimums, with columns the user sized
// left alone -- so assert the store gave back everything it may, not that it
// achieved the impossible.
const narrowed = useColumns.getState().widths;
check(
  "the flexible columns reach their hard floor",
  narrowed.name === minOf("name") && narrowed.progress === minOf("progress"),
  `name=${narrowed.name}/${minOf("name")} progress=${narrowed.progress}/${minOf("progress")}`,
);

// Nothing is ever driven below its own minimum.
check(
  "no column is below its minimum",
  visibleColumns(useColumns.getState().hidden).every(
    (c) => useColumns.getState().widths[c.id] >= c.min,
  ),
  "every visible column",
);

// Hiding the optional columns again leaves a layout that still fits.
useColumns.getState().toggle("completed");
useColumns.getState().toggle("source");
check("hiding them again still fits", laidOut() <= NARROW, `${laidOut()} / ${NARROW}`);

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
