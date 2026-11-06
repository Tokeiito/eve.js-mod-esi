/**
 * eve.js-mod-esi: which build of this mod is the process actually running?
 *
 * The source of truth is this repository; the mod runs from a copy at
 * `<eve.js tree>/mods/esiApi/`, preloaded with `--require` into the game server's
 * process. Nothing syncs the two and nothing reloads the copy once the process
 * is up, so the repo, the deployment and the running process can all differ.
 *
 * `MOD_VERSION` cannot answer this: it is a hand-maintained string. A hash over
 * the code itself changes whenever the code does. It is reported by
 * `/_mod/health` and printed in the boot banner, so the two ends of "is my fix
 * deployed" can be compared.
 *
 * Ported from `nexumApi/lib/sourceHash.js`; the file list is this mod's.
 *
 * What goes in: runtime code only (`loader.js`, `config.js`, `server.js`, and
 * every `.js` under `lib/` and `routes/`). Not `test/`, `docs/`, `.env` or
 * `README.md`. The hash answers "which code is this server running"; if a test
 * edit moved it, it would change for reasons unrelated to the build.
 *
 * Line endings are normalized. Git checks out CRLF on Windows and LF in the
 * Linux container, so the same commit is different bytes depending on who
 * cloned it, and a byte-exact hash would report drift for identical code.
 *
 * Nothing here throws. This file runs on the `--require` preload path inside
 * the game server's process before the game boots (design constraint 2).
 * An unreadable tree is reported as `null` / `"unknown"`.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// The runtime surface, relative to the mod directory. Files are named
// individually and directories are walked; anything not reachable from here is
// outside the hash.
//
// A named file that is absent is not hashed (see `listHashedFiles`), so this
// list can describe files a given checkout lacks.
const HASHED_FILES = Object.freeze(["loader.js", "config.js", "server.js"]);
const HASHED_DIRS = Object.freeze(["lib", "routes"]);

// Only JavaScript. A `.md` beside a route is documentation, and a `.json`
// fixture beside a lib file is data the code reads, not code the process runs.
const HASHED_EXTENSION = ".js";

// How much of the digest to show. Twelve hex characters is 48 bits: enough to
// tell two builds of one small mod apart, short enough for a console line.
const SHORT_HASH_LENGTH = 12;

/**
 * Every hashed file under `relDir`, appended to `out` as paths relative to
 * `modDir`.
 *
 * Both properties exist so two machines agree:
 *
 *   - Separators are POSIX. `path.join` would produce `lib\a.js` on Windows and
 *     `lib/a.js` in the container, and the relative path is part of the digest
 *     (see `computeSourceHash`).
 *   - Errors are swallowed. A missing `lib/` or `routes/` is itself a fact about
 *     the build, and recording "no files here" keeps the hash defined for a
 *     half-copied deployment.
 */
function collectFiles(modDir, relDir, out) {
  const absDir = path.join(modDir, relDir);

  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      collectFiles(modDir, rel, out);
    } else if (entry.isFile() && entry.name.endsWith(HASHED_EXTENSION)) {
      out.push(rel);
    }
  }

  return out;
}

/**
 * The list of files this hash covers, relative to `modDir`, sorted.
 *
 * Sorted because `readdirSync` order differs between NTFS and ext4. Sorting the
 * whole list at the end also interleaves the named top-level files and the
 * walked directories the same way everywhere.
 *
 * Exported because it answers "what did you actually hash", the first question
 * when two hashes disagree.
 *
 * @param {string} modDir  absolute path to the mod directory
 * @returns {string[]}     sorted, POSIX-separated, relative to `modDir`
 */
function listHashedFiles(modDir) {
  const found = [];

  for (const name of HASHED_FILES) {
    // `existsSync` rather than a try/catch around the read: an absent named file is
    // normal (see HASHED_FILES), not an error to recover from.
    if (fs.existsSync(path.join(modDir, name))) found.push(name);
  }

  for (const dir of HASHED_DIRS) {
    collectFiles(modDir, dir, found);
  }

  return found.sort();
}

/**
 * Read one file as the hash sees it: text, with line endings normalized.
 *
 * A lone CR is normalized too, so no line-ending form hashes differently.
 *
 * @param {string} filePath  absolute path
 * @returns {string}
 */
function readNormalized(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * A hex SHA-256 over the mod's runtime source at `modDir`, or `null` if there
 * is nothing to hash or the tree cannot be read.
 *
 * Each file contributes its path and its length as well as its content, so that
 * moving a line between two files, or renaming one, changes the digest.
 * Concatenation alone loses the boundaries.
 *
 * @param {string} modDir
 * @returns {string|null}  64 lowercase hex characters, or null
 */
function computeSourceHash(modDir) {
  try {
    const files = listHashedFiles(modDir);

    // No runtime files at all means "this is not a mod directory", not a hash of
    // nothing. A digest of the empty string would compare equal between two
    // unrelated broken trees.
    if (files.length === 0) return null;

    const digest = crypto.createHash("sha256");

    for (const rel of files) {
      const content = readNormalized(path.join(modDir, rel));
      digest.update(rel);
      digest.update("\0");
      digest.update(String(content.length));
      digest.update("\0");
      digest.update(content);
      digest.update("\0");
    }

    return digest.digest("hex");
  } catch {
    // A file listed a moment ago and unreadable now (a deploy copying over the tree
    // while this runs). This must not throw on the preload path.
    return null;
  }
}

/**
 * The form meant for human eyes: a short prefix, or `"unknown"`.
 *
 * `"unknown"` rather than `null` because both callers put this straight into a
 * string (the boot banner and the `sourceHash` field of `/_mod/health`), and a
 * literal `"null"` in a log line reads as a logger bug.
 *
 * @param {string} modDir
 * @returns {string}  `SHORT_HASH_LENGTH` hex characters, or "unknown"
 */
function shortSourceHash(modDir) {
  const full = computeSourceHash(modDir);
  return full ? full.slice(0, SHORT_HASH_LENGTH) : "unknown";
}

module.exports = Object.freeze({
  HASHED_DIRS,
  HASHED_FILES,
  SHORT_HASH_LENGTH,
  computeSourceHash,
  listHashedFiles,
  readNormalized,
  shortSourceHash,
});
