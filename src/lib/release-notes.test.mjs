/**
 * The in-app release notes, against the version the app actually reports.
 *
 * Eight releases shipped without this file being touched, so What's new sat on
 * 1.2.1 while the app said 1.5.1 — and because the upgrade prompt only opens
 * when the running version has notes, nobody was shown the dialog that would
 * have made the staleness obvious. Nothing failed; the window simply told a
 * lie, quietly, for eight versions.
 *
 * So the invariant is not "1.5.1 has notes" — that goes stale exactly as the
 * notes did. It is that whatever the manifests say the version is, that version
 * is written here, and that the newest entry comes first, because both the
 * fallback and the "Earlier releases" list read position rather than dates.
 *
 * Arithmetic and text, no DOM: transpiled with the esbuild Vite already ships,
 * the same way `columns.test.mjs` does. `npm run test:frontend`.
 */

import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = await mkdtemp(join(tmpdir(), "downpour-release-notes-"));
const outfile = join(dir, "release-notes.mjs");
await build({
  entryPoints: ["src/lib/release-notes.ts"],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "error",
});
const { RELEASES, notesFor } = await import(pathToFileURL(outfile).href);
await rm(dir, { recursive: true, force: true });

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const pkg = await json("package.json");
const tauri = await json("src-tauri/tauri.conf.json");
const manifest = await json("extension/manifest.json");
const cargo = (await readFile("Cargo.toml", "utf8")).match(/^version = "(.+)"$/m)?.[1];

// The four manifests are bumped together by hand at release time, and a missed
// one sends the rest of this test looking at the wrong version.
const manifests = {
  "package.json": pkg.version,
  "Cargo.toml": cargo,
  "src-tauri/tauri.conf.json": tauri.version,
  "extension/manifest.json": manifest.version,
};
const version = pkg.version;
check(
  "every manifest names the same version",
  Object.values(manifests).every((v) => v === version),
  Object.entries(manifests)
    .map(([f, v]) => `${f}=${v}`)
    .join(" "),
);

// The one that actually broke: the running version has no notes, so What's new
// silently falls back to an older release and the upgrade prompt never opens.
check("the running version has notes", notesFor(version) !== undefined, version);

// Both the fallback and the "Earlier releases" list take the newest release to
// be `RELEASES[0]`, so notes appended to the bottom would fix nothing.
check(
  "the running version is the first entry",
  RELEASES[0]?.version === version,
  `RELEASES[0]=${RELEASES[0]?.version}`,
);

/** Semver compare, newest first. Every version here is plain `x.y.z`. */
const descending = (a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
};
const order = RELEASES.map((r) => r.version);
check(
  "releases run newest to oldest",
  order.every((v, i) => i === 0 || descending(order[i - 1], v) < 0),
  order.join(" > "),
);

check(
  "no version is written twice",
  new Set(order).size === order.length,
  `${order.length} entries`,
);

// A release with no notes renders an empty window; an undated one reads as
// unreleased in a list where everything else carries a date.
for (const r of RELEASES) {
  check(
    `${r.version} is complete`,
    r.notes.length > 0 &&
      r.notes.every((n) => n.title?.trim() && n.detail?.trim()) &&
      (r.date === null || /^\d{4}-\d{2}-\d{2}$/.test(r.date)),
    `${r.notes.length} note(s), ${r.date ?? "undated"}`,
  );
}

// `notesFor` is given whatever the shell reports, which may carry a `v`.
check("a leading v is tolerated", notesFor(`v${version}`)?.version === version, `v${version}`);

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
