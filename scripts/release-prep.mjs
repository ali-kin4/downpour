/**
 * The mechanical half of a release, in one command.
 *
 * `node scripts/release-prep.mjs 1.5.2`, or `npm run release:prep 1.5.2`.
 *
 * Four manifests, a lockfile and two edits to CHANGELOG.md have to agree, and
 * they are spread far enough apart that doing them by hand means doing most of
 * them by hand. This does that part and stops.
 *
 * What it deliberately does **not** do is write `src/lib/release-notes.ts`.
 * Seeding that from the changelog would make the gate pass with diff-voiced
 * text in a window that users read -- a quiet wrong answer in place of a loud
 * failure, which is the exact bug this whole apparatus exists to prevent. So
 * the notes stay a human step, and the failing test at the end of this script
 * is what tells you to take it.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const REPO = "https://github.com/ali-kin4/downpour";
const version = process.argv[2];

const die = (message) => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  die("Usage: npm run release:prep <x.y.z>");
}

const read = (p) => readFileSync(p, "utf8");
const write = (p, s) => writeFileSync(p, s, "utf8");

/** Replace the first match only: every manifest carries the version once, at the top. */
const bump = (path, pattern, replacement) => {
  const before = read(path);
  const after = before.replace(pattern, replacement);
  if (after === before) die(`Could not find the version line in ${path}.`);
  write(path, after);
  console.log(`  ${path}`);
};

const current = JSON.parse(read("package.json")).version;
if (current === version) die(`package.json is already ${version}. Nothing to bump.`);

const changelog = read("CHANGELOG.md");
if (changelog.includes(`## [${version}]`)) {
  die(`CHANGELOG.md already has a heading for ${version}.`);
}

// What sits under [Unreleased] is the release. An empty one means the notes
// were never written, and a release with no notes is a tag nobody can read.
const unreleased = changelog
  .slice(changelog.indexOf("## [Unreleased]") + "## [Unreleased]".length)
  .split(/^## \[/m)[0]
  .trim();
if (!unreleased) {
  die("Nothing under [Unreleased] in CHANGELOG.md. Write the entry first -- it is the release.");
}

const date = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time.

// Everything is computed and checked before anything is written. A script that
// dies half way through leaves the manifests bumped and the changelog not,
// which is a worse state to be handed than the one it started from.
const dated = changelog.replace(
  "## [Unreleased]\n",
  `## [Unreleased]\n\n## [${version}] - ${date}\n`,
);

// A literal replace rather than a pattern: the version being replaced is known,
// and the link references are the part of this file most often edited by hand.
const oldLink = `[Unreleased]: ${REPO}/compare/v${current}...HEAD`;
if (!dated.includes(oldLink)) {
  die(`Could not find "${oldLink}" at the bottom of CHANGELOG.md.`);
}
const nextChangelog = dated.replace(
  oldLink,
  `[Unreleased]: ${REPO}/compare/v${version}...HEAD\n[${version}]: ${REPO}/releases/tag/v${version}`,
);

console.log(`\nPreparing ${current} -> ${version} (${date})\n`);

console.log("Manifests:");
bump("package.json", /"version": "\d+\.\d+\.\d+"/, `"version": "${version}"`);
bump("src-tauri/tauri.conf.json", /"version": "\d+\.\d+\.\d+"/, `"version": "${version}"`);
bump("extension/manifest.json", /"version": "\d+\.\d+\.\d+"/, `"version": "${version}"`);
bump("Cargo.toml", /^version = "\d+\.\d+\.\d+"$/m, `version = "${version}"`);

// Never edited by hand: cargo owns its own format, and --offline keeps a
// version bump from turning into a registry fetch on a metered connection.
console.log("\nLockfile:");
execFileSync("cargo", ["update", "-p", "downpour", "--offline"], { stdio: "inherit" });

write("CHANGELOG.md", nextChangelog);
console.log(`\nCHANGELOG.md:\n  heading "## [${version}] - ${date}" and its link references`);

console.log(`
Done with the mechanical part. One step left, and it is the one that gets
forgotten:

  src/lib/release-notes.ts -- add ${version} at the TOP of RELEASES, written for
  whoever uses Downpour rather than whoever reads the diff. Not a copy of the
  changelog: the test rejects text pasted from it.

Then \`npm run test:frontend\` goes green and the release can proceed.
`);

// Left failing on purpose. Told rather than shown, this step is skipped.
try {
  execFileSync("node", ["src/lib/release-notes.test.mjs"], { stdio: "inherit" });
} catch {
  process.exit(1);
}
