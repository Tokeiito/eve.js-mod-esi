/**
 * eve.js-mod-esi: is the deployed copy current, and is it only the mod?
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat on Windows)
 *
 * The mod is developed in this repository and runs from a copy at
 * `<eve.js tree>/mods/esiApi/`, built by `scripts/deploy-mod.js`. Nothing syncs the
 * two. That gives a failure with no wrong-looking step in it: edit the mod,
 * run the suite, see green, restart the server, and the behaviour is unchanged
 * because the server is loading a copy that was never updated.
 *
 * This check is part of the ordinary suite rather than a separate command,
 * because a check that only helps when you remember to run it does not help.
 * Comparison and deployment share one implementation (`scripts/deploy-mod.js`)
 * so that "the same" cannot mean one thing here and another there.
 *
 * What skips, and what never skips: the drift check needs a deployment to
 * compare against, so it follows the rule of the vendor-drift tests beside it.
 * When it cannot find one it skips with a reason rather than failing or
 * passing quietly. A machine with no eve.js checkout cannot tell whether its
 * deployment is current. `ESI_MOD_REQUIRE_VENDOR` turns the missing-tree case
 * into a failure, through the single guard in `vendorPresence.test.js`.
 *
 * "Deployed and stale" and "never deployed" are kept apart. The first is the
 * bug; the second is the normal state of a fresh clone, and failing on it would
 * make a red suite the default on a machine that has done nothing wrong.
 *
 * The manifest tests below never skip. They assert what D20 says the artifact
 * is, a property of this repository alone.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MOD_DIR, REPO_ROOT } = require(path.join(__dirname, "vendorTree"));
const { HASHED_DIRS, HASHED_FILES, listHashedFiles } = require(
  path.join(MOD_DIR, "lib", "sourceHash"),
);

// `scripts/` is source-repo tooling. It does not travel with the mod (see the
// release manifest below), so a deployed copy could not run this test even if
// the suite were there, which is the separation D20 asks for.
const DEPLOY_SCRIPT = path.join(MOD_DIR, "scripts", "deploy-mod.js");

const deploy = require(DEPLOY_SCRIPT);

/** Where a deployment would be, given the vendor tree the suite found. */
function deployedDir() {
  return REPO_ROOT ? path.join(REPO_ROOT, deploy.DEPLOY_SUBPATH) : null;
}

/**
 * Why the drift check cannot run, or null if it can.
 *
 * The two reasons are kept distinct because "skipped" without a reason is
 * indistinguishable from "passed" at a glance.
 */
function skipReason() {
  if (!REPO_ROOT) {
    return "no eve.js vendor tree found: set EVEJS_REPO_ROOT to an eve.js checkout "
      + "(the directory containing server/src) to check the deployed copy";
  }

  const deployed = deployedDir();
  if (!fs.existsSync(deployed)) {
    return `the mod has never been deployed to ${deployed}: run `
      + "`node scripts/deploy-mod.js` if you want this tree to run the mod";
  }

  return null;
}

const reason = skipReason();
const deployedOnly = reason ? { skip: reason } : {};

test("the deployed copy at <eve.js tree>/mods/esiApi is this source", deployedOnly, () => {
  const deployed = deployedDir();
  const diff = deploy.compareTrees(MOD_DIR, deployed);

  if (deploy.driftCount(diff) === 0) return;

  // The message is the value of this test. A bare "expected 0 to equal 3" would
  // send someone looking for a bug in the mod, when the mod is fine and the
  // deployment is old.
  const lines = [
    `The deployed mod at ${deployed} is not this source.`,
    "",
    "The game server loads that copy, not this repository, so changes made here",
    "have no effect on it until it is redeployed.",
    "",
    ...diff.changed.map((rel) => `  ~ ${rel} (differs)`),
    ...diff.added.map((rel) => `  + ${rel} (missing from the deployment)`),
    ...diff.removed.map((rel) => `  - ${rel} (left over in the deployment)`),
    "",
    "Fix it with:  node scripts/deploy-mod.js",
    "Then restart the eve.js server: copying files does not reload a running one.",
  ];

  assert.fail(lines.join("\n"));
});

test("a deployment's .env never travels, in either direction", () => {
  // The deployed `.env` holds that server's ports, bind address and the path to
  // its signing key. It exists only on the deployment side, so a mirroring copy
  // that treated it as "extra" would delete it and leave the mod dormant on the
  // next restart, with the loader blaming a configuration problem for a file
  // nobody touched.
  assert.equal(deploy.isProtected(".env"), true, ".env must never be copied or purged");
  assert.equal(
    deploy.isProtected(".env.local"),
    true,
    "a local override must not travel either",
  );
  assert.equal(
    deploy.isProtected(".env.production"),
    true,
    "the rule is the .env. prefix, not an enumeration of known suffixes",
  );

  // And the committed example must travel, or a fresh deployment has no shape
  // to copy when someone needs to configure it.
  assert.equal(
    deploy.isProtected(".env.example"),
    false,
    ".env.example is tracked and does travel",
  );

  // Naming a directory once covers everything under it.
  assert.equal(deploy.isProtected(path.join(".git", "config")), true);
  assert.equal(deploy.isProtected("node_modules/left-pad/index.js"), true);
});

test("the release artifact is the hashed runtime surface plus the named extras (D20, D47)", () => {
  const manifest = deploy.listReleaseFiles(MOD_DIR);
  const hashed = listHashedFiles(MOD_DIR);

  // The two lists are one list, by construction. If this fails, the manifest
  // has grown a second description of the runtime surface, and the build
  // identity `/_mod/health` reports has stopped covering the whole artifact.
  assert.deepEqual(
    manifest,
    [...hashed, ...deploy.EXTRA_RELEASE_FILES].sort(),
    "the manifest must be exactly the hashed files plus EXTRA_RELEASE_FILES",
  );

  // Sorted and POSIX-separated: the manifest is compared against a listing of
  // the deployed tree, and a Windows separator on one side would read as one
  // file added and one removed.
  assert.deepEqual(manifest, [...manifest].sort(), "the manifest must be sorted");
  for (const rel of manifest) {
    assert.equal(rel.includes("\\"), false, `manifest path must use / separators: ${rel}`);
  }
});

test("source-repo tooling stays in the source repo (D20)", () => {
  const manifest = new Set(deploy.listReleaseFiles(MOD_DIR));

  // D5: deleting `mods/esiApi/` must remove the mod completely, and the surest
  // way to keep that true is for the deployed directory to hold nothing that is
  // not the mod. `package.json` is the pointed case: one sitting beside eve.js's
  // own is what D20 was written about.
  const staysHome = [
    "package.json",
    "RunTests.bat",
    ".gitignore",
    ".gitattributes",
    "docs/concept.md",
    "docs/deployment.md",
    "scripts/deploy-mod.js",
    "test/deployDrift.test.js",
    "test/vendorTree.js",
  ];

  for (const rel of staysHome) {
    assert.equal(manifest.has(rel), false, `${rel} must not travel with the mod`);
  }

  // Stated the other way round, so adding a top-level directory does not
  // quietly start shipping it: nothing outside lib/ and routes/ travels except
  // the named runtime files and the named extras.
  const allowedTopLevel = new Set([...HASHED_FILES, ...deploy.EXTRA_RELEASE_FILES]);
  for (const rel of manifest) {
    const [first] = rel.split("/");
    const inWalkedDir = rel.includes("/") && HASHED_DIRS.includes(first);
    assert.equal(
      inWalkedDir || allowedTopLevel.has(rel),
      true,
      `${rel} is neither a named runtime file nor under ${HASHED_DIRS.join("/, ")}/`,
    );
  }
});

test("every file in the manifest exists and is readable", () => {
  for (const rel of deploy.listReleaseFiles(MOD_DIR)) {
    const abs = path.join(MOD_DIR, rel);
    assert.equal(fs.statSync(abs).isFile(), true, `${rel} must be a real file`);
  }
});

// Temp trees for the cases below and the hint after them. They live under
// `test/`, removed in `t.after`.
function fakeTree(t, files) {
  const dir = fs.mkdtempSync(path.join(__dirname, "deployDrift-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  return dir;
}

// Launcher state in the destination

test("settings.json and .env.txt are the launcher user's, and never travel (D47)", (t) => {
  assert.equal(deploy.isProtected("settings.json"), true);
  assert.equal(deploy.isProtected(".env.txt"), true);

  const source = fakeTree(t, { "loader.js": "// a\n", ".env.example": "# a\n" });
  const dest = fakeTree(t, {
    "loader.js": "// a\n",
    ".env.example": "# a\n",
    "settings.json": '{"esiPort":26105}\n',
    ".env.txt": "ESI_MOD_LOG_LEVEL=debug\n",
  });

  const diff = deploy.compareTrees(source, dest);
  assert.deepEqual(diff.removed, []);
  assert.equal(deploy.driftCount(diff), 0);
});

test("a disabled destination compares against loader.js.disabled and stays disabled (D47)", (t) => {
  const source = fakeTree(t, { "loader.js": "// new\n" });
  const dest = fakeTree(t, { "loader.js.disabled": "// new\n" });

  assert.equal(deploy.driftCount(deploy.compareTrees(source, dest)), 0, "the same bytes are not drift");

  fs.writeFileSync(path.join(source, "loader.js"), "// newer\n");
  const diff = deploy.compareTrees(source, dest);
  assert.deepEqual(diff, { added: [], changed: ["loader.js.disabled"], removed: [] });

  deploy.applyDiff(source, dest, diff);
  assert.equal(fs.existsSync(path.join(dest, "loader.js")), false, "deploying must not enable the mod");
  assert.equal(fs.readFileSync(path.join(dest, "loader.js.disabled"), "utf8"), "// newer\n");
  assert.equal(deploy.driftCount(deploy.compareTrees(source, dest)), 0);
});

test("an enabled destination stays enabled, and a fresh one gets loader.js (D47)", (t) => {
  const source = fakeTree(t, { "loader.js": "// new\n" });

  const enabled = fakeTree(t, { "loader.js": "// old\n" });
  deploy.applyDiff(source, enabled, deploy.compareTrees(source, enabled));
  assert.equal(fs.readFileSync(path.join(enabled, "loader.js"), "utf8"), "// new\n");
  assert.equal(fs.existsSync(path.join(enabled, "loader.js.disabled")), false);

  const fresh = fakeTree(t, {});
  deploy.applyDiff(source, fresh, deploy.compareTrees(source, fresh));
  assert.equal(fs.existsSync(path.join(fresh, "loader.js")), true);
  assert.equal(fs.existsSync(path.join(fresh, "loader.js.disabled")), false);
});

test("a destination holding both loader files is repaired to disabled, never to both (D47)", (t) => {
  // The launcher treats both at once as an invalid package. Which was meant is
  // unknowable, so the repair takes the direction that cannot start a listener.
  const source = fakeTree(t, { "loader.js": "// new\n" });
  const dest = fakeTree(t, { "loader.js": "// new\n", "loader.js.disabled": "// new\n" });

  const diff = deploy.compareTrees(source, dest);
  assert.deepEqual(diff, { added: [], changed: [], removed: ["loader.js"] });

  deploy.applyDiff(source, dest, diff);
  assert.equal(fs.existsSync(path.join(dest, "loader.js")), false);
  assert.equal(fs.existsSync(path.join(dest, "loader.js.disabled")), true);
});

test("with no --target and no EVEJS_REPO_ROOT there is no root at all", () => {
  // A private default path is what must not ship.
  const saved = process.env.EVEJS_REPO_ROOT;
  delete process.env.EVEJS_REPO_ROOT;
  try {
    assert.equal(deploy.resolveEvejsRoot(undefined), null);
    assert.equal(deploy.resolveEvejsRoot(path.join(__dirname, "x")), path.join(__dirname, "x"));
  } finally {
    if (saved !== undefined) process.env.EVEJS_REPO_ROOT = saved;
  }
});

// The "is my vendor tree still clean" hint
test("an unignored deployment is spotted so the vendor tree's git stays quiet", (t) => {
  // D5 is checked by looking at `git status`, and a deployed copy nothing
  // ignores turns up there as untracked from the first deploy onwards. That is
  // not a modification, but it reads like the beginning of one.
  const tree = fakeTree(t, {
    ".git/info/exclude": "# nothing relevant\n/tools/something/\n",
    ".gitignore": "*.sqlite\nnode_modules/\n",
  });

  assert.equal(deploy.deploymentIsExcluded(tree), false);
});

test(".git/info/exclude and .gitignore are both accepted, in several spellings", (t) => {
  const spellings = ["mods/esiApi/", "mods/esiApi", "/mods/esiApi/", "mods/"];

  for (const line of spellings) {
    const viaExclude = fakeTree(t, { ".git/info/exclude": `# a comment\n${line}\n` });
    assert.equal(
      deploy.deploymentIsExcluded(viaExclude),
      true,
      `.git/info/exclude should accept "${line}"`,
    );

    // `.gitignore` is a vendor file here, so it is not where the entry belongs,
    // but a tree that already has one has nothing to say about.
    const viaGitignore = fakeTree(t, {
      ".git/info/exclude": "# nothing\n",
      ".gitignore": `*.sqlite\n${line}\n`,
    });
    assert.equal(
      deploy.deploymentIsExcluded(viaGitignore),
      true,
      `.gitignore should accept "${line}"`,
    );
  }
});

test("a tree with no git metadata is not nagged", () => {
  // Erring towards silence: a suggestion nobody needs is worse than a missing
  // one, and this script must not look like it is diagnosing a problem in a tree
  // it cannot read.
  assert.equal(
    deploy.deploymentIsExcluded(path.join(__dirname, "no-such-tree-anywhere")),
    true,
  );
});

// Source and destination must be separate trees

test("the README is in the deploy manifest, so --check and the ZIP agree on it", () => {
  assert.equal(deploy.listReleaseFiles(MOD_DIR).includes("README.md"), true);
});

test("treesOverlap compares real paths: same, nested either way, through a link, or absent", (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "esi-mod-deploy-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const source = path.join(base, "source");
  const other = path.join(base, "other");
  fs.mkdirSync(path.join(source, "nested"), { recursive: true });
  fs.mkdirSync(other);
  const link = path.join(base, "link");
  fs.symlinkSync(source, link, "junction");

  assert.equal(deploy.treesOverlap(source, source), true, "the same directory");
  assert.equal(deploy.treesOverlap(source, path.join(source, "nested")), true, "destination inside source");
  assert.equal(deploy.treesOverlap(path.join(source, "nested"), source), true, "source inside destination");
  assert.equal(deploy.treesOverlap(source, link), true, "the same directory through a link");
  assert.equal(deploy.treesOverlap(source, path.join(link, "not-yet", "made")), true, "absent, under a link");
  assert.equal(deploy.treesOverlap(source, other), false, "siblings");
  assert.equal(deploy.treesOverlap(source, path.join(other, "not-yet")), false, "absent, under a sibling");
  assert.equal(deploy.treesOverlap(source, `${source}-suffix`), false, "a shared name prefix is not nesting");
});

test("applyDiff refuses overlapping trees before it deletes anything", (t) => {
  const dir = fakeTree(t, { "keep.txt": "keep\n" });
  assert.throws(
    () => deploy.applyDiff(dir, dir, { added: [], changed: [], removed: ["keep.txt"] }),
    /same or nested/,
  );
  assert.equal(fs.existsSync(path.join(dir, "keep.txt")), true);
});

test("a clone inside mods/esiApi deployed with --target ../.. errors and deletes nothing", (t) => {
  const evejs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "esi-mod-deploy-")));
  t.after(() => fs.rmSync(evejs, { recursive: true, force: true }));
  fs.mkdirSync(path.join(evejs, "server", "src"), { recursive: true });

  // Enough of a clone to run the script, and files the manifest would call stale.
  const clone = path.join(evejs, "mods", "esiApi");
  for (const rel of [
    "loader.js",
    "scripts/deploy-mod.js",
    "lib/sourceHash.js",
  ]) {
    const to = path.join(clone, ...rel.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(MOD_DIR, ...rel.split("/")), to);
  }
  const bystander = path.join(clone, "test", "a.test.js");
  fs.mkdirSync(path.dirname(bystander), { recursive: true });
  fs.writeFileSync(bystander, "// must survive\n");

  for (const args of [["--target", "../.."], ["--check", "--target", "../.."]]) {
    const run = spawnSync(process.execPath, ["scripts/deploy-mod.js", ...args], {
      cwd: clone,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(run.status, 2, `${args.join(" ")}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /same or nested/);
    assert.equal(fs.existsSync(bystander), true, "nothing was deleted");
    assert.equal(fs.existsSync(path.join(clone, "scripts", "deploy-mod.js")), true);
  }
});
