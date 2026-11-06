/**
 * `lib/sourceHash.js`: does the build identifier actually identify the build?
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * The module answers "which build of the mod is this process running" by
 * hashing the runtime source on disk instead of trusting a hand-maintained
 * version string. That is only worth anything if the hash tracks exactly what
 * it claims to track, so this suite builds small synthetic mod directories: the
 * same tree twice is the same hash, a real edit changes it, and the two kinds
 * of change that must not move it (a line-ending difference, and an edit to a
 * file outside the runtime surface) do not.
 *
 * The fixtures live under `test/`, not `os.tmpdir()`. Each tree is created with
 * `mkdtempSync` inside this directory and removed in `t.after`, so a failure
 * partway through leaves the debris beside the test that made it rather than
 * in a shared system folder. Nothing under `test/` is hashed, so the fixtures
 * cannot perturb the real-directory tests further down.
 *
 * The last two tests point at the real mod directory, which a synthetic tree
 * cannot stand in for: proof that the function works against the actual files
 * this mod ships.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  HASHED_DIRS,
  HASHED_FILES,
  SHORT_HASH_LENGTH,
  computeSourceHash,
  listHashedFiles,
  readNormalized,
  shortSourceHash,
} = require(path.join(__dirname, "../lib/sourceHash"));

const REAL_MOD_DIR = path.resolve(__dirname, "..");

// Building synthetic mod directories

function makeModDir(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, "sourceHash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Writes `content` to `relPath` inside `modDir`, creating parent directories as
// needed. `relPath` is POSIX-style; the split makes it work on Windows too.
function write(modDir, relPath, content) {
  const abs = path.join(modDir, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

// A tree exercising every part of the runtime surface: a named top-level file,
// a file under lib/, and a nested file under routes/ so the recursive walk in
// collectFiles() is reached.
function makePopulatedModDir(t) {
  const dir = makeModDir(t);
  write(dir, "loader.js", "// loader\nmodule.exports = { loaded: true };\n");
  write(dir, "lib/util.js", "function helper() {\n  return 1;\n}\nmodule.exports = { helper };\n");
  write(dir, "routes/nested/deep.js", "module.exports = { deep: true };\n");
  return dir;
}

// Stability

test("the hash is stable across repeated calls over the same unchanged tree", (t) => {
  const dir = makePopulatedModDir(t);

  const first = computeSourceHash(dir);
  const second = computeSourceHash(dir);

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/, "a SHA-256 hex digest is 64 lowercase hex characters");
});

// The acceptance criterion, stated as one test
//
// The hash changes when any runtime file changes, and only then. Both halves
// matter and they fail in opposite directions. A hash that misses a runtime
// edit reports a build that is not running. A hash that moves on a test edit
// changes on nearly every commit, which makes it useless for telling two
// deployments apart.

test("the hash changes when a runtime file changes, and NOT when a test file does", (t) => {
  const dir = makePopulatedModDir(t);
  write(dir, "test/helper.js", "// a .js file, but not runtime code\n");

  const before = computeSourceHash(dir);

  // One byte of runtime code: 1 becomes 2.
  write(dir, "lib/util.js", "function helper() {\n  return 2;\n}\nmodule.exports = { helper };\n");
  const afterRuntimeEdit = computeSourceHash(dir);
  assert.notEqual(before, afterRuntimeEdit, "a runtime edit must move the hash");

  // A far larger edit to a file the running process never loads.
  write(dir, "test/helper.js", "// rewritten entirely\nconst x = 1;\nmodule.exports = { x };\n");
  const afterTestEdit = computeSourceHash(dir);
  assert.equal(afterTestEdit, afterRuntimeEdit, "test/ is not part of the runtime surface");
});

test("adding or removing a runtime file changes the hash", (t) => {
  const dir = makePopulatedModDir(t);
  const before = computeSourceHash(dir);

  write(dir, "routes/added.js", "module.exports = {};\n");
  const withExtra = computeSourceHash(dir);
  assert.notEqual(before, withExtra, "a new runtime file is a new build");

  fs.rmSync(path.join(dir, "routes", "added.js"));
  assert.equal(computeSourceHash(dir), before, "removing it again restores the original build");
});

// Line endings
//
// The module's central design decision (see its file header): git normalizes
// to LF and checks out CRLF on Windows, so the same commit is different bytes
// depending on who cloned it, and this mod is written on Windows and deployed
// into a Linux container, so the two forms are guaranteed to meet. A
// byte-exact hash would report drift for identical code every time, and a
// check that cries wolf gets ignored.

test("changing ONLY line endings (LF to CRLF) does not change the hash", (t) => {
  const dir = makePopulatedModDir(t);
  const before = computeSourceHash(dir);

  // Rewrite every hashed file's LF endings as CRLF without touching the logical
  // content, which is what a fresh Windows checkout produces.
  for (const rel of listHashedFiles(dir)) {
    const abs = path.join(dir, ...rel.split("/"));
    const crlf = fs.readFileSync(abs, "utf8").replace(/\n/g, "\r\n");
    fs.writeFileSync(abs, crlf);
  }

  const after = computeSourceHash(dir);
  assert.equal(before, after, "CRLF and LF forms of identical content must hash the same");
});

test("readNormalized folds CRLF and lone CR to LF", (t) => {
  const dir = makeModDir(t);
  const abs = write(dir, "lib/mixed.js", "line one\r\nline two\rline three\n");

  assert.equal(readNormalized(abs), "line one\nline two\nline three\n");
});

// Path and boundary sensitivity

test("renaming a file changes the hash even when total content is identical", (t) => {
  const dir = makeModDir(t);
  write(dir, "lib/original.js", "module.exports = 42;\n");
  const before = computeSourceHash(dir);

  fs.renameSync(path.join(dir, "lib", "original.js"), path.join(dir, "lib", "renamed.js"));
  const after = computeSourceHash(dir);

  assert.notEqual(before, after, "the relative path is part of the digest, so a rename must change it");
});

test("moving a line from one hashed file to another changes the hash", (t) => {
  const dir = makeModDir(t);
  write(dir, "lib/a.js", "const a = 1;\nconst shared = true;\n");
  write(dir, "lib/b.js", "const b = 2;\n");
  const before = computeSourceHash(dir);

  // Same total content, split at a different boundary between the two files.
  write(dir, "lib/a.js", "const a = 1;\n");
  write(dir, "lib/b.js", "const b = 2;\nconst shared = true;\n");
  const after = computeSourceHash(dir);

  assert.notEqual(
    before,
    after,
    "each file contributes its own length, so concatenation cannot hide where a line lives",
  );
});

// Outside the hashed set

test("editing docs, the README or .env does not change the hash", (t) => {
  const dir = makePopulatedModDir(t);
  write(dir, "docs/notes.md", "# notes\n");
  write(dir, "README.md", "# Not code\n");
  write(dir, ".env", "ESI_MOD_ESI_PORT=26005\n");
  write(dir, ".env.example", "ESI_MOD_ESI_PORT=26005\n");

  const before = computeSourceHash(dir);

  write(dir, "docs/notes.md", "# notes\n\nMuch more prose than before.\n");
  write(dir, "README.md", "# Also changed, extensively\n");
  write(dir, ".env", "ESI_MOD_ESI_PORT=26105\n");
  write(dir, ".env.example", "ESI_MOD_ESI_PORT=26105\n");

  const after = computeSourceHash(dir);
  assert.equal(before, after, "docs/, README.md and .env are not loaded by the running process");
});

test("a non-.js file inside lib/ or routes/ is not hashed", (t) => {
  const dir = makePopulatedModDir(t);
  write(dir, "lib/table.json", '{"a":1}\n');
  const before = computeSourceHash(dir);

  write(dir, "lib/table.json", '{"a":2}\n');
  assert.equal(computeSourceHash(dir), before, "only .js is code the process runs");
});

// listHashedFiles

test("listHashedFiles returns sorted, POSIX-separated relative paths and excludes test/", (t) => {
  const dir = makeModDir(t);
  write(dir, "loader.js", "module.exports = {};\n");
  write(dir, "config.js", "module.exports = {};\n");
  write(dir, "server.js", "module.exports = {};\n");
  write(dir, "lib/z.js", "module.exports = {};\n");
  write(dir, "lib/a.js", "module.exports = {};\n");
  write(dir, "lib/notes.md", "not code\n");
  write(dir, "routes/sub/deep.js", "module.exports = {};\n");
  write(dir, "test/helper.js", "// excluded: not runtime code\n");
  write(dir, "docs/plan.md", "# excluded\n");

  const files = listHashedFiles(dir);

  assert.deepEqual(files, [...files].sort(), "the result must already be sorted");

  assert.ok(files.includes("config.js"));
  assert.ok(files.includes("loader.js"));
  assert.ok(files.includes("server.js"));
  assert.ok(files.includes("lib/a.js"));
  assert.ok(files.includes("lib/z.js"));
  assert.ok(files.includes("routes/sub/deep.js"), "nested directories are walked recursively");

  assert.ok(!files.includes("lib/notes.md"), "non-.js files are excluded");
  assert.ok(!files.some((f) => f.startsWith("test/")), "the test/ directory is never part of the hash");
  assert.ok(!files.some((f) => f.startsWith("docs/")), "docs are not runtime code");

  // POSIX separators even though this test very likely ran on Windows. Without
  // this the same source would hash differently here and in the container, the
  // exact comparison the hash exists to make.
  assert.ok(!files.some((f) => f.includes("\\")), "paths must use / regardless of platform");
});

test("a named top-level file that does not exist is simply not listed", (t) => {
  const dir = makeModDir(t);
  write(dir, "lib/only.js", "module.exports = {};\n");

  // loader.js / config.js / server.js may be absent in a partial checkout. It
  // must hash, not throw.
  assert.deepEqual(listHashedFiles(dir), ["lib/only.js"]);
  assert.match(computeSourceHash(dir), /^[0-9a-f]{64}$/);
});

// Missing / empty directories

test("computeSourceHash is null with no hashed files, and shortSourceHash reports unknown", (t) => {
  const dir = makeModDir(t);
  // Only non-runtime content: no named top-level file, no lib/, no routes/.
  write(dir, "README.md", "# empty mod\n");

  assert.equal(computeSourceHash(dir), null);
  assert.equal(shortSourceHash(dir), "unknown");
});

test("shortSourceHash is a 12-character lowercase hex prefix of the full hash otherwise", (t) => {
  const dir = makePopulatedModDir(t);

  const full = computeSourceHash(dir);
  const short = shortSourceHash(dir);

  assert.equal(short.length, SHORT_HASH_LENGTH);
  assert.match(short, /^[0-9a-f]{12}$/);
  assert.equal(short, full.slice(0, SHORT_HASH_LENGTH));
});

// Never throws
//
// This module is read from the `--require` preload path, in the game server's
// own process, before the game boots. A throw there kills the server (README,
// design constraint 2), so "cannot identify the build" must degrade to a string,
// never to an exception.

test("nothing throws for a directory that does not exist", () => {
  const missing = path.join(__dirname, "sourceHash-does-not-exist-xyz");

  assert.doesNotThrow(() => computeSourceHash(missing));
  assert.doesNotThrow(() => shortSourceHash(missing));
  assert.doesNotThrow(() => listHashedFiles(missing));

  assert.equal(computeSourceHash(missing), null);
  assert.equal(shortSourceHash(missing), "unknown");
  assert.deepEqual(listHashedFiles(missing), []);
});

test("computeSourceHash never throws when modDir is actually a file, not a directory", (t) => {
  const dir = makeModDir(t);
  const filePath = write(dir, "not-a-directory.txt", "just a file\n");

  assert.doesNotThrow(() => computeSourceHash(filePath));
  assert.equal(computeSourceHash(filePath), null);
});

// The real mod directory

test("the real mod directory produces a non-null 64-character hex hash", () => {
  const hash = computeSourceHash(REAL_MOD_DIR);

  assert.notEqual(hash, null);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test("the real mod directory's hashed file list is the runtime surface, not the repo", () => {
  const files = listHashedFiles(REAL_MOD_DIR);

  // Only the files this module owns are asserted present. loader.js, config.js
  // and server.js are separate modules, and a test that required them would fail
  // for the uninteresting reason that a partial checkout lacks them.
  assert.ok(files.includes("lib/sourceHash.js"));
  assert.ok(files.includes("routes/health.js"));

  assert.ok(!files.some((f) => f.startsWith("test/")), "the suite is not part of the build");
  assert.ok(!files.some((f) => f.startsWith("docs/")), "the docs are not part of the build");
  assert.ok(!files.some((f) => f.endsWith(".md")));
});

// Constants

test("the exported constants describe the runtime surface this module documents", () => {
  assert.deepEqual(HASHED_FILES, ["loader.js", "config.js", "server.js"]);
  assert.deepEqual(HASHED_DIRS, ["lib", "routes"]);
  assert.equal(SHORT_HASH_LENGTH, 12);
});
