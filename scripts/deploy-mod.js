#!/usr/bin/env node
/**
 * The release step: build the deployable mod out of this repository and put it
 * at `<eve.js tree>/mods/esiApi/`.
 *
 *   node scripts/deploy-mod.js               # deploy
 *   node scripts/deploy-mod.js --check       # report drift, change nothing, exit 1 if stale
 *   node scripts/deploy-mod.js --target /path/to/other-eve.js-checkout
 *
 * eve.js loads a mod from `<eve.js tree>/mods/<name>/loader.js` and from nowhere else,
 * and this repository is not inside an eve.js tree, so getting one to the other
 * is a copy. A copy that happens only by hand stops happening: the mod is
 * edited, the suite is green, the server restarts, and behaviour is unchanged.
 *
 * The artifact is defined by a manifest (D20), `listReleaseFiles`: the file list
 * of `lib/sourceHash.js` plus `EXTRA_RELEASE_FILES`. Everything outside it
 * (`test/`, `docs/`, `package.json`, `RunTests.bat`, `scripts/`, git metadata)
 * stays here, so deleting `mods/esiApi/` removes the mod completely (D5). One
 * list means what ships and what is hashed cannot drift apart, and `sourceHash`
 * identifies the whole artifact: `GET /_mod/health` reporting the hash this
 * script prints means the running process is this source. To widen the release
 * set, widen `HASHED_FILES` / `HASHED_DIRS` in `lib/sourceHash.js` first.
 * `.env.example`, the launcher manifest and `README.md` are the exceptions: they
 * are not code, and hashing them would move the build identity on every reworded
 * label. `scripts/build-release.js` packages this same list.
 *
 * Copy rather than junction (D21). A link at `<eve.js tree>/mods/esiApi` fails for two
 * reasons that belong to Node and this mod:
 *
 *  1. Node resolves the link to its real path unless `--preserve-symlinks` is
 *     passed, and neither eve.js launcher passes it. `loader.js` sets
 *     `MOD_DIR = __dirname`, and `lib/runtimeAccess.js` finds `server/src` by
 *     walking upward from there. Through a link the walk finds no eve.js tree,
 *     and the mod loads but can reach no game state.
 *  2. `config.js` reads `.env` beside itself via `__dirname`, so through a link
 *     the server's configuration (ports, bind address, signing-key path) would
 *     live in this source tree and be shared by every linked server.
 *
 * `EVEJS_REPO_ROOT` works around (1) and is tests-only; nothing works around (2).
 *
 * Divergence is caught three ways:
 *
 *   - `--check` asks whether the deployed files are current, on demand.
 *   - `test/deployDrift.test.js` asks the same inside the ordinary suite.
 *   - `GET /_mod/health` reports `sourceHash`, which asks whether the running
 *     process is current. Files can be redeployed under a server that has not
 *     restarted, and only the process can answer that.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** This repository's root, which is the mod's source directory. */
const SOURCE_DIR = path.resolve(__dirname, "..");

const { listHashedFiles, readNormalized, shortSourceHash } = require(
  path.join(SOURCE_DIR, "lib", "sourceHash"),
);

// Where the mod is deployed, relative to an eve.js tree. The directory name is
// load-bearing in two places: `compose.override.yaml` names
// `/app/mods/esiApi/loader.js` in NODE_OPTIONS, and the Windows launcher finds
// mods by walking `mods\*`.
const DEPLOY_SUBPATH = path.join("mods", "esiApi");

// In the artifact, not in the hash: see the header.
const EXTRA_RELEASE_FILES = Object.freeze([".env.example", "LICENSE", "README.md", "evejs-launcher.mod.json"]);

// The launcher disables a package by renaming its loader. Both names at once is
// an invalid package to the launcher (D47).
const ENABLED_LOADER = "loader.js";
const DISABLED_LOADER = "loader.js.disabled";

// Never copied, in either direction, and never deleted from the destination.
//
// `.env` is the deployed server's own configuration (ports, bind address, path
// to the signing key). It exists only on the deployment side, and a mirroring
// copy that treated it as extra would delete it and leave the mod dormant on
// the next restart. `.env.example` is tracked and does travel. `settings.json`
// is the launcher form's, with the same hazard (D47).
const NEVER_TRAVELS = Object.freeze([".env", ".git", "node_modules", "settings.json"]);

/**
 * Is `relPath` excluded from the copy, in both directions?
 *
 * Matches on the first path segment, so naming a directory once covers all of
 * it, and `.env.local` / `.env.production` are covered by the prefix rule
 * without enumerating forms nobody has invented yet.
 */
function isProtected(relPath) {
  const first = relPath.split(/[\\/]/)[0];
  if (NEVER_TRAVELS.includes(first)) return true;
  // Anything `.env.`-prefixed except the committed example.
  return first.startsWith(".env.") && first !== ".env.example";
}

// Manifest

/**
 * Exactly what a deployment of `sourceDir` consists of: sorted,
 * POSIX-separated paths relative to `sourceDir`.
 *
 * A named file that is absent is not in the manifest, the same rule
 * `listHashedFiles` follows: a half-built checkout deploys what it has.
 *
 * @param {string} sourceDir
 * @returns {string[]}
 */
function listReleaseFiles(sourceDir) {
  const files = listHashedFiles(sourceDir);

  for (const name of EXTRA_RELEASE_FILES) {
    if (fs.existsSync(path.join(sourceDir, name))) files.push(name);
  }

  return files.sort();
}

/**
 * Every file under `dir`, as sorted POSIX-separated relative paths, minus what
 * never travels.
 *
 * Separators are normalized here and in `listReleaseFiles` alike, because the
 * two lists are compared: `lib\health.js` and `lib/health.js` would otherwise
 * read as one file added and one removed, on Windows only.
 */
function listDeployedFiles(dir, rel = "", out = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    // An absent destination is "nothing deployed": the state of every tree before
    // the first deploy.
    return out;
  }

  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (isProtected(childRel)) continue;

    if (entry.isDirectory()) listDeployedFiles(dir, childRel, out);
    else if (entry.isFile()) out.push(childRel);
  }

  return out.sort();
}

/**
 * Compare the manifest against what is deployed. Returns `{ added, changed,
 * removed }` as lists of relative paths, from the destination's point of view:
 * what deploying would add to it, change in it, and delete from it.
 *
 * Content is compared through `readNormalized`, so line endings are not drift.
 * This repository normalizes to LF and checks out CRLF on Windows, while the
 * mod runs in a Linux container: a byte-exact comparison would flag every file.
 *
 * @param {string} sourceDir
 * @param {string} destDir
 * @returns {{added: string[], changed: string[], removed: string[]}}
 */
function compareTrees(sourceDir, destDir) {
  const releaseFiles = listReleaseFiles(sourceDir);
  const deployedFiles = new Set(listDeployedFiles(destDir));

  // A disabled destination stays disabled: `loader.js` is compared against, and
  // written to, the disabled name. A destination holding both is repaired in the
  // same direction, because that one cannot start a listener: the stray
  // `loader.js` is left in `deployedFiles` and so reports as removed.
  const disabled = deployedFiles.has(DISABLED_LOADER);

  const added = [];
  const changed = [];

  for (const sourceRel of releaseFiles) {
    const rel = disabled && sourceRel === ENABLED_LOADER ? DISABLED_LOADER : sourceRel;

    if (!deployedFiles.has(rel)) {
      added.push(rel);
      continue;
    }
    deployedFiles.delete(rel);

    let same;
    try {
      same = readNormalized(path.join(sourceDir, sourceRel))
        === readNormalized(path.join(destDir, rel));
    } catch {
      // Unreadable on either side is not "the same". Reporting it as drift gets it
      // copied, which is the repair.
      same = false;
    }
    if (!same) changed.push(rel);
  }

  // Whatever is left in the destination is not in the manifest any more: a
  // renamed lib file, a deleted route, or a file from before D20 that no longer
  // travels. Leaving it would let `require()` resolve a module the source no
  // longer has.
  return { added, changed, removed: [...deployedFiles].sort() };
}

/** Total number of differing paths. 0 means the deployment is current. */
function driftCount({ added, changed, removed }) {
  return added.length + changed.length + removed.length;
}

// Vendor tree git hygiene

/**
 * Does `evejsRoot`'s git already know to ignore the deployed mod?
 *
 * D5 says the vendor tree is unmodified. A deployment nothing ignores shows up
 * as `?? mods/` in every `git status`, which reads like the start of a
 * modification. The repair is one line the artifact cannot carry, because
 * `.git/info/exclude` cannot be shipped.
 *
 * `.git/info/exclude` rather than `.gitignore` is the convention already used
 * for `mods/nexumApi/` and `mods/skillWhileDoing/` in this tree, and
 * `.gitignore` is itself a vendor file: an entry there would conflict on the
 * next distribution drop.
 *
 * Text matching, not `git check-ignore`: this runs against a tree that may be
 * anything, and a subprocess that can hang or fail is a poor trade for a hint.
 * It errs towards staying quiet: a blanket `mods/` pattern counts, and an
 * unreadable file counts.
 */
function deploymentIsExcluded(evejsRoot) {
  const posixSubpath = DEPLOY_SUBPATH.split(path.sep).join("/");
  const accepted = new Set([
    posixSubpath,
    `${posixSubpath}/`,
    `/${posixSubpath}`,
    `/${posixSubpath}/`,
    "mods",
    "mods/",
    "/mods",
    "/mods/",
  ]);

  const candidates = [
    path.join(evejsRoot, ".git", "info", "exclude"),
    path.join(evejsRoot, ".gitignore"),
  ];

  for (const file of candidates) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      // No git metadata, or no read access. Nothing to be quiet about.
      return true;
    }

    for (const line of text.split(/\r?\n/)) {
      if (accepted.has(line.trim())) return true;
    }
  }

  return false;
}

/** The block to append to `.git/info/exclude`, as advice. Never written here. */
function excludeAdvice(evejsRoot) {
  const posixSubpath = DEPLOY_SUBPATH.split(path.sep).join("/");
  return [
    "",
    `Note: ${path.join(evejsRoot, DEPLOY_SUBPATH)} is a deployed copy, and this`,
    "tree's git does not ignore it yet, so it will show up as untracked in every",
    "`git status` from now on. Append this to .git/info/exclude (not .gitignore,",
    "which is a vendor file and would conflict on a distribution drop):",
    "",
    "    # The esiApi mod is a DEPLOYED COPY. Its source of truth is the",
    "    # evejs-mod-esi repo. Committing it here would create a second source",
    "    # of truth and silently diverge.",
    `    ${posixSubpath}/`,
  ].join("\n");
}

// Writing

/**
 * Copy bytes verbatim. The comparison normalizes line endings; the copy does
 * not need to, because `lib/sourceHash.js` normalizes too, so a CRLF checkout
 * and an LF one produce the same build identity.
 */
function copyFile(sourceDir, destDir, rel) {
  const sourceRel = rel === DISABLED_LOADER ? ENABLED_LOADER : rel;
  const to = path.join(destDir, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(sourceDir, sourceRel), to);
}

/** Remove a file, then any directories it leaves empty, up to `destDir`. */
function removeFile(destDir, rel) {
  fs.rmSync(path.join(destDir, rel), { force: true });

  let dir = path.dirname(path.join(destDir, rel));
  while (dir !== destDir && dir.startsWith(destDir)) {
    try {
      if (fs.readdirSync(dir).length > 0) break;
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

/** The real path of `target`, resolving as much of it as exists. */
function realPathOf(target) {
  const missing = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Are these the same directory, or is one inside the other, once links are
 * resolved? A deploy deletes whatever in the destination is not in the manifest,
 * and against an overlapping source that is the source's own `test/` and `docs/`.
 */
function treesOverlap(sourceDir, destDir) {
  const source = realPathOf(sourceDir);
  const dest = realPathOf(destDir);
  return contains(source, dest) || contains(dest, source);
}

/** Make the destination match a `compareTrees` answer. */
function applyDiff(sourceDir, destDir, diff) {
  if (treesOverlap(sourceDir, destDir)) {
    throw new Error(`source and destination are the same or nested: ${sourceDir}, ${destDir}`);
  }

  for (const rel of [...diff.changed, ...diff.added]) copyFile(sourceDir, destDir, rel);
  for (const rel of diff.removed) removeFile(destDir, rel);
}

// Reporting

function report(diff, { verb }) {
  const lines = [];
  for (const rel of diff.changed) lines.push(`  ~ ${rel}`);
  for (const rel of diff.added) lines.push(`  + ${rel}`);
  for (const rel of diff.removed) lines.push(`  - ${rel}`);

  // A first deploy is every file at once, and printing the whole tree buries the
  // one line that matters.
  const LIST_LIMIT = 40;
  if (lines.length > LIST_LIMIT) {
    console.log(lines.slice(0, LIST_LIMIT).join("\n"));
    console.log(`  … and ${lines.length - LIST_LIMIT} more`);
  } else if (lines.length > 0) {
    console.log(lines.join("\n"));
  }

  console.log(
    `\n${verb}: ${diff.changed.length} changed, ${diff.added.length} added, `
      + `${diff.removed.length} removed`,
  );
}

// Entry point

function parseArgs(argv) {
  const args = { check: false, target: null, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check" || arg === "-n") args.check = true;
    else if (arg === "--target" || arg === "-t") {
      args.target = argv[i + 1];
      i += 1;
    } else if (arg === "--help" || arg === "-h") args.help = true;
    else {
      console.error(`deploy-mod: unrecognized argument "${arg}"`);
      process.exit(2);
    }
  }

  return args;
}

/** `--target`, then `EVEJS_REPO_ROOT`, else `null`. There is no default location. */
function resolveEvejsRoot(explicit) {
  const root = explicit || process.env.EVEJS_REPO_ROOT;
  return root ? path.resolve(root) : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      "Usage: node scripts/deploy-mod.js [--check] [--target <evejs-root>]\n\n"
        + "  --check   report drift and change nothing; exit 1 if the deployed copy is stale\n"
        + "  --target  the eve.js tree to deploy into (default: $EVEJS_REPO_ROOT; one is required)",
    );
    return 0;
  }

  const evejsRoot = resolveEvejsRoot(args.target);
  if (evejsRoot === null) {
    console.error(
      "deploy-mod: no eve.js tree named. Pass --target <evejs-root> or set EVEJS_REPO_ROOT.",
    );
    return 2;
  }

  const destDir = path.join(evejsRoot, DEPLOY_SUBPATH);

  if (treesOverlap(SOURCE_DIR, destDir)) {
    console.error(
      `deploy-mod: source and destination are the same or nested, so a deploy would delete `
        + `the source. Nothing was changed.\n`
        + `            source: ${SOURCE_DIR}\n`
        + `            target: ${destDir}\n`
        + "            Clone this repository outside the eve.js tree.",
    );
    return 2;
  }

  // `server/src` is what `lib/runtimeAccess.js` looks for, so it is what makes a
  // directory an eve.js tree. Checking anything else would let this script deploy
  // somewhere the mod would then refuse to work.
  if (!fs.existsSync(path.join(evejsRoot, "server", "src"))) {
    console.error(
      `deploy-mod: no eve.js tree at ${evejsRoot}: expected `
        + `${path.join(evejsRoot, "server", "src")}.\n`
        + "            Set EVEJS_REPO_ROOT or pass --target.",
    );
    return 2;
  }

  if (!fs.existsSync(path.join(SOURCE_DIR, "loader.js"))) {
    console.error(`deploy-mod: no mod source at ${SOURCE_DIR}.`);
    return 2;
  }

  console.log(`source: ${SOURCE_DIR}`);
  console.log(`target: ${destDir}\n`);

  const diff = compareTrees(SOURCE_DIR, destDir);

  if (driftCount(diff) === 0) {
    console.log(
      `in sync: the deployed copy matches this source (${shortSourceHash(SOURCE_DIR)}).`,
    );
    return 0;
  }

  if (args.check) {
    report(diff, { verb: "stale" });
    console.log("\nRun `node scripts/deploy-mod.js` to update the deployed copy.");
    return 1;
  }

  applyDiff(SOURCE_DIR, destDir, diff);

  report(diff, { verb: "deployed" });

  // The copy is on disk; the running server is not affected by it. Say so, or a
  // working deploy looks like one that did nothing.
  console.log(`\nbuild identity: ${shortSourceHash(SOURCE_DIR)}`);
  console.log("Restart the eve.js server for this to take effect, then confirm what it");
  console.log("actually loaded with:  GET /_mod/health  ->  sourceHash");

  if (!deploymentIsExcluded(evejsRoot)) console.log(excludeAdvice(evejsRoot));

  return 0;
}

// Importable as well as runnable. `test/deployDrift.test.js` uses
// `compareTrees` so the test and the deploy agree by construction about what
// "the same" means.
module.exports = Object.freeze({
  DEPLOY_SUBPATH,
  EXTRA_RELEASE_FILES,
  NEVER_TRAVELS,
  SOURCE_DIR,
  applyDiff,
  compareTrees,
  deploymentIsExcluded,
  driftCount,
  isProtected,
  listDeployedFiles,
  listReleaseFiles,
  resolveEvejsRoot,
  treesOverlap,
});

if (require.main === module) {
  process.exitCode = main();
}
