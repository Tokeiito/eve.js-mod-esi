/**
 * Tests for lib/runtimeAccess.js
 *
 * Run with:  node --test "test/**\/*.test.js"   (from the mod directory)
 *
 * Almost everything here runs against fixture doubles, which is the argument for
 * the pure-core/thin-wrapper split: `xFromRuntime(module, ...)` takes the game
 * module as an argument, so the suite exercises every accessor without booting
 * the emulator, opening the game store or requiring a single file from
 * `server/src`.
 *
 * The exceptions are the vendor-drift checks, gated on `vendorOnly` from
 * test/vendorTree.js. They need a real eve.js checkout and skip without one;
 * `ESI_MOD_REQUIRE_VENDOR=1` turns that skip into a failure (see
 * vendorPresence.test.js). Two rules for them:
 *
 *   - The `GAME_MODULES` check resolves each path and never requires it.
 *     Requiring `characterState` or `wormholeRuntimeState` opens SQLite, and a
 *     drift check must not boot the thing it is checking. It resolves through
 *     `gameModuleFilenameIn`, the mod's own probe, so "does this module exist?"
 *     cannot answer differently here than in production.
 *   - The one module they do require, `gameStore/tableRepository`, is safe
 *     because its only dependency is the dependency-free `tableOwnership.js` and
 *     its gameStore backend is injectable. That is a property of upstream, and
 *     the test that relies on it also proves it.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  GAME_MODULES,
  OWNER_SALT_FILE_NAME,
  READ_ONLY_REPOSITORY_OPTIONS,
  REFRESH_TOKEN_STORE_FILE_NAME,
  SDE_DIR_NAME,
  SERVER_SRC_SEARCH_DEPTH,
  SIGNING_KEY_FILE_NAME,
  SSO_DIR_NAME,
  STRUCTURE_READ_OPTIONS,
  SKILLS_TABLE,
  TABLE_REPOSITORY_OWNER,
  DESTINATION_ID_TYPE,
  DESTINATION_NOTIFICATION,
  GameModuleShapeError,
  PUSH_OUTCOME,
  findServerSrc,
  gameModuleFilenameIn,
  getCharacterOnlineSnapshotFromRuntime,
  getAllianceContactsFromRuntime,
  getCorporationContactsFromRuntime,
  getCorporationMemberFromRuntime,
  getCorporationRecordFromRuntime,
  getOwnerTypeIdFromRuntime,
  getOwnerSaltPath,
  getReadOnlyTableRepositoryFromRuntime,
  getRefreshTokenStorePath,
  getSigningKeyPath,
  getStorePaths,
  getStorePathsFromRuntime,
  isRuntimeReachable,
  isRuntimeReachableFromRuntime,
  listCharacterSkillsFromRuntime,
  listCorporationStructuresFromRuntime,
  loadGameModuleWith,
  peekCharacterRecordFromRuntime,
  peekFleetByIdFromRuntime,
  peekFleetForCharacterFromRuntime,
  peekGameModuleWith,
  peekStructureRecordFromRuntime,
  readOwnCallable,
  requireOwnCallable,
  ownerSaltPathFromGameStoreRoot,
  refreshTokenStorePathFromGameStoreRoot,
  resolveServerSrcFrom,
  resolveServerSrcFromEnv,
  sdeRootFromGameStoreRoot,
  sendChatSystemMessageFromRuntime,
  sendDestinationChangeFromRuntime,
  signingKeyPathFromGameStoreRoot,
  ssoDirFromGameStoreRoot,
  ssoPathsFromDir,
} = require(path.join(__dirname, "..", "lib", "runtimeAccess"));

const { MOD_DIR, REPO_ROOT, vendorOnly } = require(path.join(__dirname, "vendorTree"));

// Own-property duck typing.
// The rule that keeps the mod from tripping Node's circular-dependency warning
// proxy, which eve.js's ProcessLifecycle logs with a stack and a heap snapshot.

test("readOwnCallable finds an own function", () => {
  const fn = () => "ok";
  assert.equal(readOwnCallable({ go: fn }, "go"), fn);
});

test("readOwnCallable ignores an inherited function", () => {
  // A mid-circular-require module's warning proxy sits on the prototype, so
  // anything that reads through it is the bug.
  const child = Object.create({ go: () => "ok" });
  assert.equal(readOwnCallable(child, "go"), null);
});

test("readOwnCallable ignores non-functions and junk receivers", () => {
  assert.equal(readOwnCallable({ go: 1 }, "go"), null);
  assert.equal(readOwnCallable(null, "go"), null);
  assert.equal(readOwnCallable(undefined, "go"), null);
  assert.equal(readOwnCallable("string", "go"), null);
});

test("requireOwnCallable returns the own function", () => {
  const fn = () => "ok";
  assert.equal(requireOwnCallable({ go: fn }, "go", "someModule"), fn);
});

test("requireOwnCallable throws a named GameModuleShapeError naming the module", () => {
  assert.throws(
    () => requireOwnCallable({}, "go", "someModule"),
    (err) => {
      assert.ok(err instanceof GameModuleShapeError);
      assert.equal(err.name, "GameModuleShapeError");
      assert.equal(err.moduleKey, "someModule");
      assert.equal(err.property, "go");
      assert.match(err.message, /changed shape/);
      return true;
    },
  );
});

// Locating server/src.
// Driven entirely through the injected `moduleExists` probe, so these run
// identically on a machine with a game server and one without.

/** A probe that answers true for exactly the given candidate paths. */
function probeFor(...found) {
  const set = new Set(found.map((p) => path.resolve(p)));
  return (candidate) => set.has(path.resolve(candidate));
}

test("resolveServerSrcFrom finds a tree at the start directory", () => {
  const start = path.resolve("/a/b/c");
  const probe = probeFor(path.join(start, "server", "src", "config"));
  assert.equal(resolveServerSrcFrom(start, probe), path.join(start, "server", "src"));
});

test("resolveServerSrcFrom walks up and returns the nearest tree", () => {
  const root = path.resolve("/evejs");
  const start = path.join(root, "mods", "esiApi", "lib");
  const probe = probeFor(path.join(root, "server", "src", "config"));
  assert.equal(resolveServerSrcFrom(start, probe), path.join(root, "server", "src"));
});

test("resolveServerSrcFrom probes <candidate>/config, not the bare directory", () => {
  // A directory that merely happens to be called server/src is not an eve.js
  // tree; answering "found" for one sends every require off to a path that does
  // not exist and blames upstream for it.
  const start = path.resolve("/a/b");
  const probe = probeFor(path.join(start, "server", "src"));
  assert.equal(resolveServerSrcFrom(start, probe), null);
});

test("resolveServerSrcFrom gives up after SERVER_SRC_SEARCH_DEPTH levels", () => {
  let probes = 0;
  const deep = path.resolve("/" + Array.from({ length: 40 }, (_, i) => `d${i}`).join("/"));
  const result = resolveServerSrcFrom(deep, () => {
    probes += 1;
    return false;
  });
  assert.equal(result, null);
  assert.equal(probes, SERVER_SRC_SEARCH_DEPTH);
});

test("resolveServerSrcFrom stops at the filesystem root rather than looping", () => {
  let probes = 0;
  const result = resolveServerSrcFrom(path.resolve("/"), () => {
    probes += 1;
    return false;
  });
  assert.equal(result, null);
  assert.equal(probes, 1);
});

test("resolveServerSrcFrom rejects a junk start directory", () => {
  const yes = () => true;
  assert.equal(resolveServerSrcFrom("", yes), null);
  assert.equal(resolveServerSrcFrom("   ", yes), null);
  assert.equal(resolveServerSrcFrom(null, yes), null);
  assert.equal(resolveServerSrcFrom(undefined, yes), null);
});

test("resolveServerSrcFromEnv turns a repo root into its server/src", () => {
  const root = path.resolve("/somewhere/evejs");
  const probe = probeFor(path.join(root, "server", "src", "config"));
  assert.equal(resolveServerSrcFromEnv(root, probe), path.join(root, "server", "src"));
});

test("resolveServerSrcFromEnv rejects a root that is not an eve.js tree", () => {
  assert.equal(resolveServerSrcFromEnv(path.resolve("/nope"), () => false), null);
});

test("resolveServerSrcFromEnv rejects empty, blank and non-string roots", () => {
  const yes = () => true;
  assert.equal(resolveServerSrcFromEnv("", yes), null);
  assert.equal(resolveServerSrcFromEnv("   ", yes), null);
  assert.equal(resolveServerSrcFromEnv(undefined, yes), null);
  assert.equal(resolveServerSrcFromEnv(42, yes), null);
});

test("findServerSrc prefers the explicit override over the walk", () => {
  const overrideRoot = path.resolve("/override");
  const walkRoot = path.resolve("/walk");
  const probe = probeFor(
    path.join(overrideRoot, "server", "src", "config"),
    path.join(walkRoot, "server", "src", "config"),
  );
  assert.equal(
    findServerSrc(walkRoot, overrideRoot, probe),
    path.join(overrideRoot, "server", "src"),
  );
});

test("findServerSrc falls back to the walk when the override names no tree", () => {
  const walkRoot = path.resolve("/walk");
  const probe = probeFor(path.join(walkRoot, "server", "src", "config"));
  assert.equal(
    findServerSrc(walkRoot, path.resolve("/nope"), probe),
    path.join(walkRoot, "server", "src"),
  );
});

test("findServerSrc with one argument is the pure walk-up the contract names", () => {
  const walkRoot = path.resolve("/walk");
  const probe = probeFor(path.join(walkRoot, "server", "src", "config"));
  assert.equal(findServerSrc(walkRoot, undefined, probe), path.join(walkRoot, "server", "src"));
});

test("findServerSrc returns null when neither the override nor the walk finds a tree", () => {
  assert.equal(findServerSrc(path.resolve("/a/b"), path.resolve("/c"), () => false), null);
});

// The GAME_MODULES table

test("GAME_MODULES is frozen", () => {
  // The blast radius of an upstream file move is meant to be this object. A
  // caller that could edit it at runtime would move the blast somewhere else.
  assert.equal(Object.isFrozen(GAME_MODULES), true);
});

test("every GAME_MODULES value is an extension-less relative path", () => {
  for (const [key, value] of Object.entries(GAME_MODULES)) {
    assert.equal(typeof value, "string", `GAME_MODULES.${key} must be a string`);
    assert.ok(value.length > 0, `GAME_MODULES.${key} must not be empty`);
    assert.doesNotMatch(value, /\.js$/, `GAME_MODULES.${key} must not carry an extension`);
    assert.doesNotMatch(value, /^[/\\]/, `GAME_MODULES.${key} must be relative to server/src`);
    assert.doesNotMatch(value, /\\/, `GAME_MODULES.${key} must use forward slashes`);
    assert.doesNotMatch(value, /(^|\/)\.\.(\/|$)/, `GAME_MODULES.${key} must not escape server/src`);
  }
});

test("every path in GAME_MODULES still resolves in the vendor tree", vendorOnly, () => {
  // The mod's own probe, not a second one: `gameModuleFilenameIn` is the pure
  // core `getGameModule` resolves through, so a module this check calls missing is
  // a module the mod could not load either, and vice versa.
  //
  // Deliberately a resolve, not a require. `require.resolve` finds the filename
  // without executing it, and requiring characterState or wormholeRuntimeState
  // opens the game store.
  //
  // A stat of `<path>.js` is not enough. A module is a file or a directory with an
  // `index.js`, and upstream moves entries between those two shapes: `config.js`
  // became `config/index.js`, which `require("config")` loads exactly as before.
  // A stat of the file alone would call that drift and send somebody looking for
  // a break that is not there.
  const serverSrc = path.join(REPO_ROOT, "server", "src");
  for (const [key, relativePath] of Object.entries(GAME_MODULES)) {
    assert.notEqual(
      gameModuleFilenameIn(serverSrc, key),
      null,
      `GAME_MODULES.${key} ("${relativePath}") resolves to nothing under ${serverSrc}`,
    );
  }
});

// Resolving a game module's filename.
// The probe the drift check above shares with `getGameModule`. These run against
// a made-up tree, so they say what the probe accepts on a machine with no eve.js
// checkout at all.

/** A throwaway `server/src` containing exactly the files named. */
function fakeServerSrc(t, ...relativeFiles) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "esi-mod-vendor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const serverSrc = path.join(root, "server", "src");
  for (const relative of relativeFiles) {
    const absolute = path.join(serverSrc, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, "module.exports = {};\n");
  }
  return serverSrc;
}

test("gameModuleFilenameIn resolves a module that is a file", (t) => {
  const serverSrc = fakeServerSrc(t, `${GAME_MODULES.gameStoreRoot}.js`);
  assert.equal(
    gameModuleFilenameIn(serverSrc, "gameStoreRoot"),
    path.join(serverSrc, `${GAME_MODULES.gameStoreRoot}.js`),
  );
});

test("gameModuleFilenameIn resolves a module that is a directory", (t) => {
  // The shape a stat of `<path>.js` cannot see, and not hypothetical: upstream
  // replaced `server/src/config.js` with a `config/` package. `require` loads the
  // index either way, so the mod never noticed and the check must not either.
  const serverSrc = fakeServerSrc(t, path.join(GAME_MODULES.config, "index.js"));
  assert.equal(
    gameModuleFilenameIn(serverSrc, "config"),
    path.join(serverSrc, GAME_MODULES.config, "index.js"),
  );
});

test("gameModuleFilenameIn returns null for a module that is neither", (t) => {
  const serverSrc = fakeServerSrc(t, `${GAME_MODULES.gameStoreRoot}.js`);
  // A directory with no `index.js` is not a module: `require` would throw, so the
  // honest answer is the same null as a file that was deleted outright.
  fs.mkdirSync(path.join(serverSrc, GAME_MODULES.config), { recursive: true });
  assert.equal(gameModuleFilenameIn(serverSrc, "config"), null);
  assert.equal(gameModuleFilenameIn(serverSrc, "characterState"), null);
});

test("gameModuleFilenameIn refuses an unknown key and a junk tree", (t) => {
  const serverSrc = fakeServerSrc(t, `${GAME_MODULES.gameStoreRoot}.js`);
  assert.equal(gameModuleFilenameIn(serverSrc, "notAKey"), null);
  assert.equal(gameModuleFilenameIn(serverSrc, "toString"), null);
  assert.equal(gameModuleFilenameIn("", "gameStoreRoot"), null);
  assert.equal(gameModuleFilenameIn("   ", "gameStoreRoot"), null);
  assert.equal(gameModuleFilenameIn(null, "gameStoreRoot"), null);
  assert.equal(gameModuleFilenameIn(undefined, "gameStoreRoot"), null);
});

// Loading a game module

test("loadGameModuleWith hands the loader the server/src-relative path", () => {
  const seen = [];
  const exports = { ok: true };
  const loaded = loadGameModuleWith((relativePath) => {
    seen.push(relativePath);
    return exports;
  }, "gameStoreRoot");

  assert.equal(loaded, exports);
  assert.deepEqual(seen, [GAME_MODULES.gameStoreRoot]);
});

test("loadGameModuleWith rejects an unknown key and lists the known ones", () => {
  assert.throws(
    () => loadGameModuleWith(() => ({}), "notAKey"),
    (err) => {
      assert.match(err.message, /unknown game module "notAKey"/);
      for (const key of Object.keys(GAME_MODULES)) {
        assert.ok(err.message.includes(key), `the message should name ${key}`);
      }
      return true;
    },
  );
});

test("loadGameModuleWith wraps a loader failure with the key that wanted it", () => {
  const cause = new Error("Cannot find module 'x'");
  assert.throws(
    () => loadGameModuleWith(() => { throw cause; }, "characterState"),
    (err) => {
      assert.match(err.message, /characterState/);
      assert.match(err.message, /Cannot find module 'x'/);
      // The original is preserved, because the wrapped message deliberately drops the
      // stack's most useful half in favour of naming the accessor.
      assert.equal(err.cause, cause);
      return true;
    },
  );
});

test("loadGameModuleWith rejects a loader that returns a non-object", () => {
  for (const value of [null, undefined, 1, "text", true]) {
    assert.throws(
      () => loadGameModuleWith(() => value, "gameStoreRoot"),
      /did not export an object/,
      `loader returning ${String(value)} should be rejected`,
    );
  }
});

// Peeking at what is already loaded

test("peekGameModuleWith returns the exports of an already-cached module", () => {
  const exports = { mutateState() {} };
  const cache = { "/evejs/server/src/x.js": { exports } };
  const resolve = () => "/evejs/server/src/x.js";
  assert.equal(peekGameModuleWith(resolve, cache, "wormholeRuntimeState"), exports);
});

test("peekGameModuleWith returns null when the module is not in the cache", () => {
  assert.equal(peekGameModuleWith(() => "/evejs/server/src/x.js", {}, "wormholeRuntimeState"), null);
});

test("peekGameModuleWith returns null when the filename cannot be resolved", () => {
  assert.equal(peekGameModuleWith(() => null, {}, "wormholeRuntimeState"), null);
  assert.equal(peekGameModuleWith(() => "", {}, "wormholeRuntimeState"), null);
});

test("peekGameModuleWith swallows a throwing resolver", () => {
  // `require.resolve` throws MODULE_NOT_FOUND for a path that is not there, and
  // "not there" is a normal answer on the health path, not an error.
  const resolve = () => { throw new Error("MODULE_NOT_FOUND"); };
  assert.equal(peekGameModuleWith(resolve, {}, "wormholeRuntimeState"), null);
});

test("peekGameModuleWith ignores junk cache entries and non-object exports", () => {
  const filename = "/evejs/server/src/x.js";
  const resolve = () => filename;
  assert.equal(peekGameModuleWith(resolve, null, "wormholeRuntimeState"), null);
  assert.equal(peekGameModuleWith(resolve, { [filename]: null }, "wormholeRuntimeState"), null);
  assert.equal(peekGameModuleWith(resolve, { [filename]: {} }, "wormholeRuntimeState"), null);
  assert.equal(
    peekGameModuleWith(resolve, { [filename]: { exports: "text" } }, "wormholeRuntimeState"),
    null,
  );
});

test("peekGameModuleWith does not read a cache key through the prototype", () => {
  // `require.cache` is a plain object, but a filename that collides with an
  // Object.prototype member ("toString", "constructor") must not read as a loaded
  // module.
  const cache = Object.create({ "/evejs/server/src/x.js": { exports: { mutateState() {} } } });
  assert.equal(
    peekGameModuleWith(() => "/evejs/server/src/x.js", cache, "wormholeRuntimeState"),
    null,
  );
});

// Readiness

test("isRuntimeReachableFromRuntime is true for a module owning mutateState", () => {
  assert.deepEqual(
    isRuntimeReachableFromRuntime({ mutateState() {} }),
    { reachable: true, reason: null },
  );
});

test("isRuntimeReachableFromRuntime reports an absent module rather than throwing", () => {
  for (const value of [null, undefined]) {
    const result = isRuntimeReachableFromRuntime(value);
    assert.equal(result.reachable, false);
    assert.match(result.reason, /not loaded/);
  }
});

test("isRuntimeReachableFromRuntime rejects an inherited mutateState", () => {
  const result = isRuntimeReachableFromRuntime(Object.create({ mutateState() {} }));
  assert.equal(result.reachable, false);
  assert.match(result.reason, /mutateState/);
});

test("isRuntimeReachableFromRuntime rejects a non-callable mutateState", () => {
  const result = isRuntimeReachableFromRuntime({ mutateState: true });
  assert.equal(result.reachable, false);
  assert.match(result.reason, /mutateState/);
});

test("isRuntimeReachable never throws and always answers in the contract's shape", () => {
  // Called with whatever this machine happens to have: a vendor tree or not, a
  // booted game or not. Every one of those is a legitimate answer, and the health
  // endpoint has to get one of them rather than an exception.
  const result = isRuntimeReachable();
  assert.equal(typeof result.reachable, "boolean");
  assert.ok(result.reason === null || typeof result.reason === "string");
  if (!result.reachable) assert.ok(result.reason.length > 0, "an unreachable runtime must say why");
});

test("isRuntimeReachable does not load the module it probes", vendorOnly, () => {
  // The health endpoint runs in eve.js's forked healthcheck process too, and
  // `wormholeRuntimeState` requires `server/src/gameStore` at module scope, which
  // opens SQLite. Probing must read `require.cache`, never populate it.
  const filename = path.join(
    REPO_ROOT, "server", "src", `${GAME_MODULES.wormholeRuntimeState}.js`,
  );
  assert.equal(Object.prototype.hasOwnProperty.call(require.cache, filename), false,
    "precondition: the test process has not loaded the game runtime module");

  const result = isRuntimeReachable();

  assert.equal(result.reachable, false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(require.cache, filename),
    false,
    "isRuntimeReachable() required the game runtime module: it must only peek",
  );
});

// Store paths

test("sdeRootFromGameStoreRoot derives the sibling sde directory", () => {
  const storeRoot = path.resolve("/var/lib/evejs/gameStore");
  assert.equal(
    sdeRootFromGameStoreRoot(storeRoot),
    path.join(path.resolve("/var/lib/evejs"), SDE_DIR_NAME),
  );
});

test("sdeRootFromGameStoreRoot returns null for a missing or blank root", () => {
  assert.equal(sdeRootFromGameStoreRoot(""), null);
  assert.equal(sdeRootFromGameStoreRoot("   "), null);
  assert.equal(sdeRootFromGameStoreRoot(null), null);
  assert.equal(sdeRootFromGameStoreRoot(undefined), null);
});

test("getStorePathsFromRuntime asks the game and derives the SDE root beside it", () => {
  const fake = { resolveStoreRoot: () => "/var/lib/evejs/gameStore" };
  assert.deepEqual(getStorePathsFromRuntime(fake), {
    gameStoreRoot: path.resolve("/var/lib/evejs/gameStore"),
    sdeRoot: path.join(path.resolve("/var/lib/evejs"), SDE_DIR_NAME),
    reason: null,
  });
});

test("getStorePathsFromRuntime calls resolveStoreRoot, never resolveDataDir", () => {
  // They are the same directory upstream (`resolveStoreRoot` is literally
  // `path.resolve(resolveDataDir(), "..")`), which is why re-deriving the parent
  // on this side would be a second copy of a rule that has an owner.
  const called = [];
  const fake = {
    resolveStoreRoot: () => { called.push("resolveStoreRoot"); return "/store/gameStore"; },
    resolveDataDir: () => { called.push("resolveDataDir"); return "/store/gameStore/data"; },
  };
  getStorePathsFromRuntime(fake);
  assert.deepEqual(called, ["resolveStoreRoot"]);
});

test("getStorePathsFromRuntime throws GameModuleShapeError when the export is gone", () => {
  assert.throws(() => getStorePathsFromRuntime({}), GameModuleShapeError);
  assert.throws(
    () => getStorePathsFromRuntime(Object.create({ resolveStoreRoot: () => "/x" })),
    GameModuleShapeError,
  );
});

test("getStorePathsFromRuntime throws when resolveStoreRoot returns no usable path", () => {
  for (const value of ["", "   ", null, undefined, 7]) {
    assert.throws(
      () => getStorePathsFromRuntime({ resolveStoreRoot: () => value }),
      GameModuleShapeError,
      `resolveStoreRoot returning ${String(value)} should be rejected`,
    );
  }
});

test("getStorePaths never throws and reports why when it cannot answer", () => {
  const result = getStorePaths();
  assert.ok(Object.prototype.hasOwnProperty.call(result, "gameStoreRoot"));
  assert.ok(Object.prototype.hasOwnProperty.call(result, "sdeRoot"));
  if (result.gameStoreRoot === null) {
    assert.equal(result.sdeRoot, null);
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  } else {
    assert.equal(path.isAbsolute(result.gameStoreRoot), true);
    assert.equal(path.isAbsolute(result.sdeRoot), true);
    assert.equal(result.reason, null);
  }
});

test("getStorePaths answers from the real storeRoot module", vendorOnly, () => {
  // The one game module this mod requires outside a running game process, and it
  // is safe only because upstream keeps it dependency-free (fs + path). If that
  // stops being true, this test opens SQLite from a node:test process and the
  // failure will say so loudly.
  const result = getStorePaths();
  assert.equal(result.reason, null, `getStorePaths() failed: ${result.reason}`);
  assert.equal(path.isAbsolute(result.gameStoreRoot), true);
  assert.equal(path.basename(result.sdeRoot), SDE_DIR_NAME);
  assert.equal(path.dirname(result.sdeRoot), path.dirname(result.gameStoreRoot));
});

// The SSO signing key's default home (D8).
//
// The third derived sibling, and the one with the sharpest consequence for
// getting it wrong: a key resolved into the mod directory dies with the next
// deploy, and every token every tool is holding dies with it.

test("signingKeyPathFromGameStoreRoot derives the sibling sso directory", () => {
  const storeRoot = path.resolve("/var/lib/evejs/gameStore");
  assert.equal(
    signingKeyPathFromGameStoreRoot(storeRoot),
    path.join(path.resolve("/var/lib/evejs"), SSO_DIR_NAME, SIGNING_KEY_FILE_NAME),
  );
});

test("signingKeyPathFromGameStoreRoot puts the key beside the SDE, not under the store", () => {
  // It is a sibling, not a child: the store root is a directory the game
  // regenerates, and `_local/gameStore` on a host checkout is not the durable half
  // of anything.
  const storeRoot = path.resolve("/srv/evejs/_local/gameStore");
  const keyPath = signingKeyPathFromGameStoreRoot(storeRoot);

  assert.equal(
    path.dirname(path.dirname(keyPath)),
    path.dirname(sdeRootFromGameStoreRoot(storeRoot)),
  );
  assert.equal(keyPath.startsWith(storeRoot + path.sep), false);
});

test("signingKeyPathFromGameStoreRoot is never inside the mod directory", () => {
  // D8's location. `<eve.js tree>/mods/esiApi/` is a copy `scripts/deploy-mod.js`
  // replaces wholesale (D21), so a key stored under it survives exactly until the
  // next deploy and takes every issued token with it. Asserted over both deployed
  // layouts, from synthetic roots rather than from a vendor tree, so it runs
  // everywhere including CI.
  const layouts = [
    // Container: the store root is in the mounted volume, the mod is in the image.
    ["/var/lib/evejs/gameStore", "/opt/evejs/mods/esiApi"],
    // Host checkout: both are under one tree, which is the layout that can go wrong
    // if the derivation ever reaches downward instead of sideways.
    ["/srv/evejs/_local/gameStore", "/srv/evejs/mods/esiApi"],
  ];

  for (const [storeRoot, modDir] of layouts) {
    const keyPath = signingKeyPathFromGameStoreRoot(path.resolve(storeRoot));
    const relative = path.relative(path.resolve(modDir), keyPath);
    assert.ok(
      relative.startsWith("..") || path.isAbsolute(relative),
      `the default signing key path fell inside the mod directory: ${keyPath}`,
    );
  }
});

test("signingKeyPathFromGameStoreRoot returns null for a missing or blank root", () => {
  assert.equal(signingKeyPathFromGameStoreRoot(""), null);
  assert.equal(signingKeyPathFromGameStoreRoot("   "), null);
  assert.equal(signingKeyPathFromGameStoreRoot(null), null);
  assert.equal(signingKeyPathFromGameStoreRoot(undefined), null);
});

test("getSigningKeyPath never throws and reports why when it cannot answer", () => {
  // Same promise as getStorePaths, and a sharper reason: an unresolvable key path
  // means the SSO listener declines to start, so this string is the only output an
  // operator gets.
  const result = getSigningKeyPath();
  assert.ok(Object.prototype.hasOwnProperty.call(result, "path"));
  assert.ok(Object.prototype.hasOwnProperty.call(result, "reason"));
  if (result.path === null) {
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  } else {
    assert.equal(path.isAbsolute(result.path), true);
    assert.equal(path.basename(result.path), SIGNING_KEY_FILE_NAME);
    assert.equal(result.reason, null);
  }
});

test("getSigningKeyPath answers from the real storeRoot module", vendorOnly, () => {
  const { path: keyPath, reason } = getSigningKeyPath();
  assert.equal(reason, null, `getSigningKeyPath() failed: ${reason}`);
  const { gameStoreRoot } = getStorePaths();
  assert.equal(path.basename(keyPath), SIGNING_KEY_FILE_NAME);
  assert.equal(path.basename(path.dirname(keyPath)), SSO_DIR_NAME);
  assert.equal(path.dirname(path.dirname(keyPath)), path.dirname(gameStoreRoot));
});

// The refresh token store's home (D8).
//
// The fourth derived sibling, and the one whose location the deployment forces
// rather than merely prefers: the container mounts the mod tree read-only, so
// "beside the signing key" is the only writable place that also survives a
// redeploy. Getting it wrong does not fail loudly: a store written somewhere the
// deploy replaces simply logs every client out at the next release.

test("refreshTokenStorePathFromGameStoreRoot derives the sibling sso directory", () => {
  const storeRoot = path.resolve("/var/lib/evejs/gameStore");
  assert.equal(
    refreshTokenStorePathFromGameStoreRoot(storeRoot),
    path.join(path.resolve("/var/lib/evejs"), SSO_DIR_NAME, REFRESH_TOKEN_STORE_FILE_NAME),
  );
});

test("refreshTokenStorePathFromGameStoreRoot puts the store beside the signing key", () => {
  // In the same directory, not merely the same tree. `lib/runtimeAccess.js`
  // argues for one directory per service, and the refresh store is the "anything
  // beside the key" that paragraph anticipated, so a single `chmod 700` covers
  // every credential in it rather than one of them.
  const storeRoot = path.resolve("/srv/evejs/_local/gameStore");
  assert.equal(
    path.dirname(refreshTokenStorePathFromGameStoreRoot(storeRoot)),
    path.dirname(signingKeyPathFromGameStoreRoot(storeRoot)),
  );
  assert.notEqual(
    refreshTokenStorePathFromGameStoreRoot(storeRoot),
    signingKeyPathFromGameStoreRoot(storeRoot),
  );
});

test("refreshTokenStorePathFromGameStoreRoot is never inside the mod directory", () => {
  // The same property as the signing key's, and it matters more here because this
  // deployment mounts the mod tree read-only: a store resolved under it does not
  // merely die at the next deploy, it cannot be written at all.
  const layouts = [
    ["/var/lib/evejs/gameStore", "/opt/evejs/mods/esiApi"],
    ["/srv/evejs/_local/gameStore", "/srv/evejs/mods/esiApi"],
  ];

  for (const [storeRoot, modDir] of layouts) {
    const storePath = refreshTokenStorePathFromGameStoreRoot(path.resolve(storeRoot));
    const relative = path.relative(path.resolve(modDir), storePath);
    assert.ok(
      relative.startsWith("..") || path.isAbsolute(relative),
      `the refresh token store path fell inside the mod directory: ${storePath}`,
    );
  }
});

test("refreshTokenStorePathFromGameStoreRoot returns null for a missing or blank root", () => {
  assert.equal(refreshTokenStorePathFromGameStoreRoot(""), null);
  assert.equal(refreshTokenStorePathFromGameStoreRoot("   "), null);
  assert.equal(refreshTokenStorePathFromGameStoreRoot(null), null);
  assert.equal(refreshTokenStorePathFromGameStoreRoot(undefined), null);
});

test("getRefreshTokenStorePath never throws and reports why when it cannot answer", () => {
  // `{ path, reason }` rather than a bare null, for getSigningKeyPath's reason:
  // an unresolvable store path means the SSO listener declines to start, and this
  // string is the only thing an operator has to go on.
  const result = getRefreshTokenStorePath();
  assert.ok(Object.prototype.hasOwnProperty.call(result, "path"));
  assert.ok(Object.prototype.hasOwnProperty.call(result, "reason"));
  if (result.path === null) {
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  } else {
    assert.equal(path.isAbsolute(result.path), true);
    assert.equal(path.basename(result.path), REFRESH_TOKEN_STORE_FILE_NAME);
    assert.equal(result.reason, null);
  }
});

// The `owner` claim's salt (D8).
//
// The third durable thing in `sso/`, and the one whose loss is worst. An account
// id is a small integer, so an unsalted `owner` claim is a reversible encoding
// rather than an opaque identifier. The salt makes it opaque, and losing it
// moves every `owner` on the server at once, which every client reads as a
// character transfer. That is a fleet-wide re-authorisation, so the path has to
// land where a redeploy (D21) and a container rebuild cannot reach it, like its
// two neighbours.

test("ownerSaltPathFromGameStoreRoot derives the sibling sso directory", () => {
  const storeRoot = path.resolve("/var/lib/evejs/gameStore");
  assert.equal(
    ownerSaltPathFromGameStoreRoot(storeRoot),
    path.join(path.resolve("/var/lib/evejs"), SSO_DIR_NAME, OWNER_SALT_FILE_NAME),
  );
});

test("the sso directory holds three distinct durable files", () => {
  // One directory, three names, no collisions. A salt that landed on the signing
  // key's path would be found by `loadOrCreateSigningKey` and refused as a damaged
  // key, which is a confusing way to discover a typo.
  const storeRoot = path.resolve("/srv/evejs/_local/gameStore");
  const paths = [
    signingKeyPathFromGameStoreRoot(storeRoot),
    refreshTokenStorePathFromGameStoreRoot(storeRoot),
    ownerSaltPathFromGameStoreRoot(storeRoot),
  ];
  assert.equal(new Set(paths).size, 3);
  assert.equal(new Set(paths.map((p) => path.dirname(p))).size, 1);
});

test("ownerSaltPathFromGameStoreRoot is never inside the mod directory", () => {
  for (const [storeRoot, modDir] of [
    ["/var/lib/evejs/gameStore", "/opt/evejs/mods/esiApi"],
    ["/srv/evejs/_local/gameStore", "/srv/evejs/mods/esiApi"],
  ]) {
    const saltPath = ownerSaltPathFromGameStoreRoot(path.resolve(storeRoot));
    const relative = path.relative(path.resolve(modDir), saltPath);
    assert.ok(
      relative.startsWith("..") || path.isAbsolute(relative),
      `the owner salt path fell inside the mod directory: ${saltPath}`,
    );
  }
});

test("ownerSaltPathFromGameStoreRoot returns null for a missing or blank root", () => {
  assert.equal(ownerSaltPathFromGameStoreRoot(""), null);
  assert.equal(ownerSaltPathFromGameStoreRoot("   "), null);
  assert.equal(ownerSaltPathFromGameStoreRoot(null), null);
  assert.equal(ownerSaltPathFromGameStoreRoot(undefined), null);
});

// The sso/ directory, named rather than derived

test("ssoDirFromGameStoreRoot is the sibling directory the three files live in", () => {
  const storeRoot = path.join("/var", "lib", "evejs", "gameStore");
  assert.equal(
    ssoDirFromGameStoreRoot(storeRoot),
    path.join(path.resolve("/var/lib/evejs"), SSO_DIR_NAME),
  );
  assert.equal(ssoDirFromGameStoreRoot(""), null);
  assert.equal(ssoDirFromGameStoreRoot("   "), null);
  assert.equal(ssoDirFromGameStoreRoot(null), null);
  assert.equal(ssoDirFromGameStoreRoot(undefined), null);
});

test("ssoPathsFromDir names all three files in one directory", () => {
  const dir = path.join(os.tmpdir(), "esi-sso-state");
  const paths = ssoPathsFromDir(dir);

  assert.equal(paths.ssoDir, path.resolve(dir));
  assert.equal(paths.signingKeyPath, path.join(path.resolve(dir), SIGNING_KEY_FILE_NAME));
  assert.equal(paths.ownerSaltPath, path.join(path.resolve(dir), OWNER_SALT_FILE_NAME));
  assert.equal(
    paths.refreshTokenStorePath,
    path.join(path.resolve(dir), REFRESH_TOKEN_STORE_FILE_NAME),
  );
  // Frozen, like every other answer this module hands out: a caller that rewrote
  // one of these would move a credential for everybody downstream.
  assert.equal(Object.isFrozen(paths), true);
});

test("ssoPathsFromDir returns null for anything that is not a directory string", () => {
  for (const junk of ["", "   ", null, undefined, 42, {}]) {
    assert.equal(ssoPathsFromDir(junk), null);
  }
});

test("a named directory and a derived one agree about what is inside an sso/", () => {
  // The knob rests on this, and it is why both branches go through
  // `ssoPathsFromDir` instead of each doing its own join: an operator who points
  // `ESI_MOD_SSO_STATE_DIR` at the directory the derivation would have found must
  // get byte-identical paths, or the knob silently relocates credentials instead
  // of naming them.
  const storeRoot = path.join("/var", "lib", "evejs", "gameStore");
  const named = ssoPathsFromDir(ssoDirFromGameStoreRoot(storeRoot));

  assert.equal(named.signingKeyPath, signingKeyPathFromGameStoreRoot(storeRoot));
  assert.equal(named.ownerSaltPath, ownerSaltPathFromGameStoreRoot(storeRoot));
  assert.equal(named.refreshTokenStorePath, refreshTokenStorePathFromGameStoreRoot(storeRoot));
});

test("getOwnerSaltPath never throws and reports why when it cannot answer", () => {
  const result = getOwnerSaltPath();
  assert.ok(Object.prototype.hasOwnProperty.call(result, "path"));
  assert.ok(Object.prototype.hasOwnProperty.call(result, "reason"));
  if (result.path === null) {
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0);
  } else {
    assert.equal(path.isAbsolute(result.path), true);
    assert.equal(path.basename(result.path), OWNER_SALT_FILE_NAME);
    assert.equal(result.reason, null);
  }
});

test("this install's sso directory is where all three credentials go", vendorOnly, () => {
  // One vendor-gated check for the whole directory rather than one per file: what
  // a real tree can tell us that a synthetic root cannot is where this install's
  // store root actually resolves to, and that answer is shared.
  const { gameStoreRoot } = getStorePaths();
  const storePath = getRefreshTokenStorePath();
  const saltPath = getOwnerSaltPath();
  const keyPath = getSigningKeyPath();

  for (const [name, result] of [
    ["refresh token store", storePath],
    ["owner salt", saltPath],
    ["signing key", keyPath],
  ]) {
    assert.equal(result.reason, null, `${name} path failed: ${result.reason}`);
    assert.equal(path.basename(path.dirname(result.path)), SSO_DIR_NAME);
    assert.equal(path.dirname(path.dirname(result.path)), path.dirname(gameStoreRoot));
  }

  assert.equal(path.basename(storePath.path), REFRESH_TOKEN_STORE_FILE_NAME);
  assert.equal(path.basename(saltPath.path), OWNER_SALT_FILE_NAME);
  assert.equal(new Set([storePath.path, saltPath.path, keyPath.path]).size, 3);
});

// Read-only by construction

test("getReadOnlyTableRepositoryFromRuntime binds mod:esiApi with both guards", () => {
  const seen = [];
  const handle = { domain: TABLE_REPOSITORY_OWNER };
  const fake = {
    createTableRepository: (domain, options) => {
      seen.push([domain, options]);
      return handle;
    },
  };

  assert.equal(getReadOnlyTableRepositoryFromRuntime(fake), handle);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "mod:esiApi");
  assert.equal(seen[0][1].strict, true);
  // Not upstream's default (true). The "shared" seam is dormant today, so this
  // changes nothing now. It keeps "physically unable to write" true through a
  // vendor drop that classifies a table shared without telling us.
  assert.equal(seen[0][1].allowSharedWrites, false);
});

test("getReadOnlyTableRepositoryFromRuntime passes a mutable options object", () => {
  // READ_ONLY_REPOSITORY_OPTIONS is frozen; handing the frozen object itself to
  // game code would turn any upstream write into a TypeError from inside the
  // vendor tree.
  let received = null;
  getReadOnlyTableRepositoryFromRuntime({
    createTableRepository: (_domain, options) => { received = options; return {}; },
  });
  assert.notEqual(received, READ_ONLY_REPOSITORY_OPTIONS);
  assert.equal(Object.isFrozen(received), false);
  assert.deepEqual(received, { ...READ_ONLY_REPOSITORY_OPTIONS });
});

test("getReadOnlyTableRepositoryFromRuntime throws GameModuleShapeError when the factory is gone", () => {
  assert.throws(() => getReadOnlyTableRepositoryFromRuntime({}), GameModuleShapeError);
});

// A character's trained skills.
//
// This accessor exists because `skillState` has no `peek`. Every public read it
// offers goes through `ensureCharacterSkills`, which seeds a skill set for a
// character who has none, so this reads the table it owns instead, through the
// handle that is physically unable to write it.

/** A read-only repository double holding one `skills` table. */
function skillsRepository(table) {
  return {
    read: (name, pointer) => {
      if (name !== SKILLS_TABLE || pointer !== "/") return { success: false };
      return table === null ? { success: false } : { success: true, data: table };
    },
  };
}

/** CCP's documented example id, which is nobody's. */
const A_CHARACTER = 90000001;

test("listCharacterSkillsFromRuntime reads the skills table and nothing else", () => {
  const seen = [];
  const repository = {
    read: (name, pointer) => {
      seen.push([name, pointer]);
      return { success: true, data: {} };
    },
  };

  listCharacterSkillsFromRuntime(repository, A_CHARACTER);

  // One read, of one table, at the root. `characters` is not touched: the record's
  // denormalised `skillPoints` is a stale copy and routes/skills.js sums the rows
  // instead.
  assert.deepEqual(seen, [[SKILLS_TABLE, "/"]]);
});

test("listCharacterSkillsFromRuntime projects the four fields a body needs", () => {
  const repository = skillsRepository({
    [String(A_CHARACTER)]: {
      3300: {
        typeID: 3300,
        trainedSkillLevel: 5,
        effectiveSkillLevel: 5,
        skillPoints: 256000,
        // The rest of eve.js's twenty-odd stored columns, which must not come out the
        // other side: a projection is what stops game-state shape from reaching a
        // response by accident.
        itemName: "Gunnery",
        inTraining: false,
        trainingDestinationSP: 256000,
      },
    },
  });

  const [skill] = listCharacterSkillsFromRuntime(repository, A_CHARACTER);

  assert.deepEqual(Object.keys(skill).sort(), [
    "effectiveSkillLevel",
    "skillPoints",
    "trainedSkillLevel",
    "typeID",
  ]);
  assert.deepEqual(skill, {
    typeID: 3300,
    trainedSkillLevel: 5,
    effectiveSkillLevel: 5,
    skillPoints: 256000,
  });
});

test("a row is owned, not borrowed from the live table", () => {
  // `read` hands back the stored object, as `peekCharacterRecord` does. Nothing
  // above this line may be given a reference into a table the game is rewriting.
  const stored = {
    typeID: 3300, trainedSkillLevel: 5, effectiveSkillLevel: 5, skillPoints: 256000,
  };
  const table = { [String(A_CHARACTER)]: { 3300: stored } };

  const [skill] = listCharacterSkillsFromRuntime(skillsRepository(table), A_CHARACTER);
  assert.notEqual(skill, stored);

  skill.skillPoints = 0;
  assert.equal(stored.skillPoints, 256000, "the accessor handed out the table's own object");
});

test("an unreadable table is null and a character with no row is empty", () => {
  // routes/skills.js turns this into a 500 on one side and an honest empty body on
  // the other: collapsing them would report every pilot on the server as untrained
  // whenever the table could not be opened.
  assert.equal(listCharacterSkillsFromRuntime(skillsRepository(null), A_CHARACTER), null);
  assert.deepEqual(listCharacterSkillsFromRuntime(skillsRepository({}), A_CHARACTER), []);

  // An empty row is the ordinary state of a character eve.js has not seeded yet,
  // not a corrupt one.
  assert.deepEqual(
    listCharacterSkillsFromRuntime(skillsRepository({ [String(A_CHARACTER)]: {} }), A_CHARACTER),
    [],
  );
});

test("a row that is not a skill is skipped rather than published as skill 0", () => {
  const repository = skillsRepository({
    [String(A_CHARACTER)]: {
      good: { typeID: 3300, trainedSkillLevel: 1, effectiveSkillLevel: 1, skillPoints: 250 },
      nullRow: null,
      notAnObject: 7,
      zeroType: { typeID: 0, trainedSkillLevel: 1, effectiveSkillLevel: 1, skillPoints: 250 },
      unreadableType: { typeID: "gunnery", trainedSkillLevel: 1 },
    },
  });

  assert.deepEqual(
    listCharacterSkillsFromRuntime(repository, A_CHARACTER).map((skill) => skill.typeID),
    [3300],
  );
});

test("listCharacterSkillsFromRuntime throws GameModuleShapeError with no read()", () => {
  assert.throws(() => listCharacterSkillsFromRuntime({}, A_CHARACTER), GameModuleShapeError);
});

test("there is no skillState entry in GAME_MODULES, and that is deliberate", () => {
  // The accessor above is the reason. Every public read skillState offers goes
  // through `ensureCharacterSkills`, which seeds, re-normalises, persists and
  // writes the total back onto the character record: a read that writes, and one
  // that creates game state because somebody polled an API.
  for (const modulePath of Object.values(GAME_MODULES)) {
    assert.doesNotMatch(modulePath, /skill/i);
  }
});

test("the real tableRepository still refuses writes for mod:esiApi", vendorOnly, () => {
  // Safe to require: tableRepository's only dependency is the dependency-free
  // tableOwnership.js, and its gameStore backend is injectable, so this opens no
  // database. Both facts are asserted by this test running.
  //
  // Built with READ_ONLY_REPOSITORY_OPTIONS rather than a retyped copy, so what is
  // proven is the mod's policy and not the test's idea of it.
  const tableRepository = require(
    path.join(REPO_ROOT, "server", "src", GAME_MODULES.gameStoreTableRepository),
  );

  const reads = [];
  const writes = [];
  const fakeStore = {
    read: (table, p) => { reads.push([table, p]); return { id: 1 }; },
    tableExists: () => true,
    write: (...args) => { writes.push(args); },
    remove: (...args) => { writes.push(args); },
    ensureTable: (...args) => { writes.push(args); },
  };

  const repo = tableRepository.createTableRepository(TABLE_REPOSITORY_OWNER, {
    ...READ_ONLY_REPOSITORY_OPTIONS,
    store: fakeStore,
  });

  // Reads pass straight through. Upstream's own header says so, and that is what
  // the handle is for.
  assert.deepEqual(repo.read("characters", "/90000001"), { id: 1 });
  assert.deepEqual(reads, [["characters", "/90000001"]]);

  // Writes throw, by name, and never reach the store.
  for (const op of ["write", "remove", "ensureTable"]) {
    assert.throws(
      () => repo[op]("characters", "/90000001", { hacked: true }),
      (err) => {
        assert.equal(err.name, "OwnershipViolationError");
        assert.ok(err instanceof tableRepository.OwnershipViolationError);
        return true;
      },
      `repo.${op} must throw OwnershipViolationError for ${TABLE_REPOSITORY_OWNER}`,
    );
  }
  assert.deepEqual(writes, [], "no mutation may reach the store");
});

// Worked accessor: a character record

test("peekCharacterRecordFromRuntime forwards the character ID", () => {
  const seen = [];
  peekCharacterRecordFromRuntime({
    peekCharacterRecord: (id) => { seen.push(id); return { characterID: id }; },
  }, 90000001);
  assert.deepEqual(seen, [90000001]);
});

test("peekCharacterRecordFromRuntime never reaches for getCharacterRecord", () => {
  // The measured rule, enforced rather than documented: getCharacterRecord
  // deep-clones, ensures skills, resolves the active ship, re-derives standings,
  // and calls writeCharacterRecord when normalisation drifts. A read that writes
  // cannot appear anywhere in a read-only replica.
  const called = [];
  const fake = {
    peekCharacterRecord: (id) => { called.push("peek"); return { characterID: id }; },
    getCharacterRecord: (id) => { called.push("get"); return { characterID: id }; },
  };
  peekCharacterRecordFromRuntime(fake, 90000001);
  assert.deepEqual(called, ["peek"]);
});

test("peekCharacterRecordFromRuntime copies rather than handing back the live record", () => {
  // `peek` returns the in-memory object the game is mutating, by reference.
  // Nothing above this line may be handed that.
  const live = { characterID: 90000001, solarSystemID: 30000142 };
  const projected = peekCharacterRecordFromRuntime(
    { peekCharacterRecord: () => live },
    90000001,
  );
  assert.notEqual(projected, live);
  assert.deepEqual(projected, live);

  projected.solarSystemID = 0;
  assert.equal(live.solarSystemID, 30000142, "the live game record must be untouched");
});

test("peekCharacterRecordFromRuntime applies an injected projector", () => {
  const live = { characterID: 90000001, solarSystemID: 30000142, standingData: {} };
  const result = peekCharacterRecordFromRuntime(
    { peekCharacterRecord: () => live },
    90000001,
    { project: (record, id) => ({ character_id: id, solar_system_id: record.solarSystemID }) },
  );
  assert.deepEqual(result, { character_id: 90000001, solar_system_id: 30000142 });
});

test("peekCharacterRecordFromRuntime returns null for an unknown character", () => {
  // "No such character" is an answer, not an error. Whether it becomes a 404 is
  // routes/'s decision.
  for (const value of [null, undefined, "", 0, false]) {
    assert.equal(
      peekCharacterRecordFromRuntime({ peekCharacterRecord: () => value }, 1),
      null,
    );
  }
});

test("peekCharacterRecordFromRuntime throws GameModuleShapeError when peek is gone", () => {
  assert.throws(
    () => peekCharacterRecordFromRuntime({ getCharacterRecord: () => ({}) }, 1),
    (err) => {
      assert.ok(err instanceof GameModuleShapeError);
      assert.equal(err.moduleKey, "characterState");
      assert.equal(err.property, "peekCharacterRecord");
      return true;
    },
  );
});

// Is this character online?
//
// Doubles rather than the real runtime, as everywhere else here. The shape they
// return is upstream's `makeSnapshot`
// (`services/online/characterControlRuntime.js:74-90`) verbatim, including the
// freeze: a double that returned a plain object would make the "we do not hand
// the vendor's object back" test pass for the wrong reason.

/** Upstream's `makeSnapshot`, as the vendor builds it. */
function vendorSnapshot(characterID, controlState, leaseExpiresAt = null) {
  return Object.freeze({
    characterID,
    online: controlState !== "offline",
    controlState,
    transport: controlState === "retail_client"
      ? "tcp"
      : controlState === "browser_pilot" ? "web" : null,
    leaseExpiresAt,
  });
}

/** Upstream's 503 for an id it cannot normalise (`characterControlRuntime.js:118-124`). */
function vendorControlError() {
  const err = new Error("Authoritative character control is unavailable.");
  err.name = "CharacterControlError";
  err.code = "CHARACTER_CONTROL_UNAVAILABLE";
  err.statusCode = 503;
  return err;
}

test("getCharacterOnlineSnapshotFromRuntime reports a retail client as online", () => {
  const snapshot = getCharacterOnlineSnapshotFromRuntime(
    { getCharacterControlSnapshot: (id) => vendorSnapshot(id, "retail_client") },
    90000001,
  );
  assert.deepEqual(snapshot, { online: true });
});

test("getCharacterOnlineSnapshotFromRuntime reports a browser pilot as online", () => {
  // This accessor does not go to `sessionRegistry`: a browser pilot holds a
  // control lease and never enters that registry, so the count `countPlayers()`
  // reports would call this player offline.
  const snapshot = getCharacterOnlineSnapshotFromRuntime(
    {
      getCharacterControlSnapshot: (id) =>
        vendorSnapshot(id, "browser_pilot", "2026-08-25T11:03:14.000Z"),
    },
    90000001,
  );
  assert.deepEqual(snapshot, { online: true });
});

test("getCharacterOnlineSnapshotFromRuntime reports an idle character as offline", () => {
  const snapshot = getCharacterOnlineSnapshotFromRuntime(
    { getCharacterControlSnapshot: (id) => vendorSnapshot(id, "offline") },
    90000001,
  );
  assert.deepEqual(snapshot, { online: false });
});

test("getCharacterOnlineSnapshotFromRuntime is passed the id and the module as receiver", () => {
  const calls = [];
  const module = {
    getCharacterControlSnapshot(id) {
      calls.push({ id, self: this });
      return vendorSnapshot(id, "offline");
    },
  };
  getCharacterOnlineSnapshotFromRuntime(module, 90000001);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 90000001);
  assert.equal(calls[0].self, module);
});

test("getCharacterOnlineSnapshotFromRuntime borrows nothing from the vendor snapshot", () => {
  // Upstream's snapshot is frozen, which makes handing it back look safe. It is
  // still the object the runtime gives every caller, and returning it would put
  // `controlState`, `transport` and `leaseExpiresAt` (this server's private
  // presence vocabulary, none of it in CCP's `/online/`) within a route's reach.
  const live = vendorSnapshot(90000001, "browser_pilot", "2026-08-25T11:03:14.000Z");
  const projected = getCharacterOnlineSnapshotFromRuntime(
    { getCharacterControlSnapshot: () => live },
    90000001,
  );

  assert.notEqual(projected, live);
  assert.deepEqual(Object.keys(projected), ["online"]);
  assert.equal(Object.isFrozen(projected), true);
  for (const withheld of ["characterID", "controlState", "transport", "leaseExpiresAt"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(projected, withheld),
      false,
      `${withheld} is upstream's vocabulary and must not cross the boundary`,
    );
  }
});

test("getCharacterOnlineSnapshotFromRuntime returns null when the game refuses the id", () => {
  // `getCharacterControlSnapshot` normalises anything that is not a positive safe
  // integer to 0 and throws a 503 `CharacterControlError`. That throw reaching a
  // route handler would be a logged 500 for a client's typo, so it is contained
  // here, the same "an unknown character is null, not a throw" rule
  // `peekCharacterRecord` follows.
  const module = {
    getCharacterControlSnapshot(id) {
      if (!Number.isSafeInteger(id) || id <= 0) throw vendorControlError();
      return vendorSnapshot(id, "offline");
    },
  };
  for (const bad of [0, -1, 1.5, NaN, null, undefined, "", "abc", {}]) {
    assert.equal(
      getCharacterOnlineSnapshotFromRuntime(module, bad),
      null,
      `a bad id (${String(bad)}) must be null, never a throw`,
    );
  }
});

test("getCharacterOnlineSnapshotFromRuntime contains any throw out of game code", () => {
  // Deliberately broader than `instanceof CharacterControlError`: nothing from
  // inside game code reaches the handler, and a narrow catch would let the next
  // vendor drop's TypeError through.
  for (const thrown of [
    vendorControlError(),
    new TypeError("Cannot read properties of undefined (reading 'get')"),
    new RangeError("Maximum call stack size exceeded"),
    "a string, because game code is allowed to be rude",
  ]) {
    assert.equal(
      getCharacterOnlineSnapshotFromRuntime(
        { getCharacterControlSnapshot: () => { throw thrown; } },
        90000001,
      ),
      null,
    );
  }
});

test("getCharacterOnlineSnapshotFromRuntime returns null for a non-object snapshot", () => {
  for (const value of [null, undefined, true, false, 0, 1, "online"]) {
    assert.equal(
      getCharacterOnlineSnapshotFromRuntime(
        { getCharacterControlSnapshot: () => value },
        90000001,
      ),
      null,
    );
  }
});

test("getCharacterOnlineSnapshotFromRuntime does not coerce a drifted online field", () => {
  // `online` is a boolean today. A drop that made it a string would make every
  // character permanently online under a truthiness test; false is the safe side
  // of that guess.
  for (const drifted of ["offline", "false", 1, {}, undefined, null]) {
    assert.deepEqual(
      getCharacterOnlineSnapshotFromRuntime(
        { getCharacterControlSnapshot: () => ({ online: drifted }) },
        90000001,
      ),
      { online: false },
    );
  }
});

test("getCharacterOnlineSnapshotFromRuntime throws GameModuleShapeError when the export is gone", () => {
  // Upstream drift, not an absent player, the same distinction
  // `countPlayersFromRuntime` draws. It must not be swallowed by the catch that
  // contains a bad id, which is why `requireOwnCallable` runs before the try.
  assert.throws(
    () => getCharacterOnlineSnapshotFromRuntime({ claimBrowserControl: () => {} }, 1),
    (err) => {
      assert.ok(err instanceof GameModuleShapeError);
      assert.equal(err.moduleKey, "characterControlRuntime");
      assert.equal(err.property, "getCharacterControlSnapshot");
      return true;
    },
  );
});

test("an inherited getCharacterControlSnapshot is not accepted", () => {
  assert.throws(
    () => getCharacterOnlineSnapshotFromRuntime(
      Object.create({ getCharacterControlSnapshot: () => vendorSnapshot(1, "offline") }),
      1,
    ),
    GameModuleShapeError,
  );
});

test("no accessor reaches for characterControlRuntime's lease-management exports", () => {
  // `/online/` is a read. `claimBrowserControl`, `renewBrowserControl` and
  // `releaseBrowserControl` take control of a character; `subscribe` and
  // `shutdown` reach into the runtime's lifecycle. A replica of a read API should
  // be unable to fly somebody's ship, not merely disciplined about it (the chatHub
  // argument below, made about character control).
  const source = fs.readFileSync(path.join(MOD_DIR, "lib", "runtimeAccess.js"), "utf8");
  for (const forbidden of [
    "claimBrowserControl",
    "renewBrowserControl",
    "releaseBrowserControl",
    "validateBrowserControl",
    "recordRetailSessionStarted",
    "recordRetailSessionEnded",
    "assertRetailControlAvailable",
    "subscribe",
    "shutdown",
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`requireOwnCallable\\([^)]*${forbidden}`),
      `runtimeAccess reaches for characterControlRuntime.${forbidden}`,
    );
  }
});

test("characterControlRuntime still has the snapshot shape the accessor assumes", vendorOnly, () => {
  // A stat is enough for GAME_MODULES; this one needs the body, because three
  // claims in `getCharacterOnlineSnapshotFromRuntime`'s comment are about what
  // upstream does, not where it lives. Read as text, because the module builds a
  // default runtime with timers on require.
  const file = path.join(
    REPO_ROOT, "server", "src", `${GAME_MODULES.characterControlRuntime}.js`,
  );
  const source = fs.readFileSync(file, "utf8");

  assert.match(
    source,
    /^\s*getCharacterControlSnapshot,\s*$/m,
    "characterControlRuntime no longer exports getCharacterControlSnapshot",
  );

  // Claim 1: a bad id is a throw, not a falsy answer, which is why this accessor
  // has a try/catch at all.
  assert.match(
    source,
    /function\s+getCharacterControlSnapshot\s*\([^)]*\)\s*\{\s*const\s+characterID\s*=\s*normalizeCharacterID\([^)]*\);\s*if\s*\(\s*!characterID\s*\)\s*\{\s*throw\s+makeControlError\(ERROR_CODES\.UNAVAILABLE\);/,
    "getCharacterControlSnapshot no longer throws for an id it cannot normalise",
  );
  assert.match(
    source,
    /ERROR_CODES\.UNAVAILABLE,\s*"Authoritative character control is unavailable\.",\s*503,/,
    "the unavailable error is no longer the 503 the accessor's comment describes",
  );

  // Claim 2: `online` is a boolean derived from the control state, which is why
  // the projection tests it with `=== true` rather than coercing it.
  assert.match(
    source,
    /^\s*online:\s*controlState\s*!==\s*CONTROL_STATES\.OFFLINE,\s*$/m,
    "the snapshot's `online` is no longer a boolean over the control state",
  );

  // Claim 3: the snapshot is frozen and carries exactly the five fields the
  // projection deliberately narrows to one.
  assert.match(
    source,
    /function\s+makeSnapshot\s*\([^)]*\)\s*\{[\s\S]{0,120}?return Object\.freeze\(\{/,
    "makeSnapshot no longer returns a frozen object",
  );
  for (const field of ["characterID", "online", "controlState", "transport", "leaseExpiresAt"]) {
    assert.match(
      source,
      new RegExp(`^\\s*${field}[:,]`, "m"),
      `the snapshot no longer carries ${field}: re-read the projection's field list`,
    );
  }

  // Claim 4, the load-bearing one. The game's own online-status answer is this
  // same call, which makes `/online/` agree with what a player sees in their
  // watchlist rather than merely resemble it. If upstream ever stops deriving
  // presence this way, the mod picked the wrong source.
  const onlineStatus = fs.readFileSync(
    path.join(REPO_ROOT, "server", "src", "services", "online", "onlineStatusRuntime.js"),
    "utf8",
  );
  assert.match(
    onlineStatus,
    /characterControlRuntime\.getCharacterControlSnapshot\(\s*normalizedTargetID,?\s*\)\.online/,
    "onlineStatusRuntime no longer derives presence from getCharacterControlSnapshot",
  );
});

// Corporation membership, without creating one.
//
// Doubles throughout, as everywhere else here. The two vendor functions these
// wrap are a `cloneValue` read and a read-clone-normalise read, and neither
// writes, which the vendor-gated check further down asserts against the real
// tree rather than assuming it.

/** A member record as `buildDefaultMemberState` shapes one: masks as strings. */
function vendorMemberRecord(characterID, overrides = {}) {
  return {
    characterID,
    isCEO: false,
    roles: "0",
    rolesAtBase: "0",
    rolesAtHQ: "0",
    rolesAtOther: "0",
    titleMask: 0,
    memberOptOuts: { acceptsFleetWarp: true },
    ...overrides,
  };
}

test("getCorporationMemberFromRuntime forwards both ids, in the vendor's order", () => {
  const seen = [];
  getCorporationMemberFromRuntime({
    getCorporationMember(corporationID, characterID) {
      seen.push([corporationID, characterID]);
      return vendorMemberRecord(characterID);
    },
  }, 98777771, 90000001);
  // `(corporationID, characterID)` upstream. Transposing them would answer for a
  // corporation nobody asked about, silently and with a plausible body.
  assert.deepEqual(seen, [[98777771, 90000001]]);
});

test("getCorporationMemberFromRuntime is passed the module as receiver", () => {
  const calls = [];
  const module = {
    getCorporationMember(corporationID, characterID) {
      calls.push(this);
      return vendorMemberRecord(characterID);
    },
  };
  getCorporationMemberFromRuntime(module, 98777771, 90000001);
  assert.deepEqual(calls, [module]);
});

test("getCorporationMemberFromRuntime deep-copies rather than sharing nested state", () => {
  // Upstream clones today. Ownership must not rest on that: a drop that made this
  // a live read would move a mutable game record above the boundary without a
  // single call site changing.
  const live = vendorMemberRecord(90000001, { memberOptOuts: { acceptsFleetWarp: true } });
  const copy = getCorporationMemberFromRuntime(
    { getCorporationMember: () => live },
    98777771,
    90000001,
  );

  assert.notEqual(copy, live);
  assert.deepEqual(copy, live);
  assert.notEqual(copy.memberOptOuts, live.memberOptOuts, "a nested object must not be shared");

  copy.roles = "9222811354509877121";
  copy.memberOptOuts.acceptsFleetWarp = false;
  assert.equal(live.roles, "0", "the live member record must be untouched");
  assert.equal(live.memberOptOuts.acceptsFleetWarp, true);
});

test("getCorporationMemberFromRuntime returns null for a character with no member record", () => {
  // This answer must not tempt a caller back to the accessor that would create
  // the record in order to read it. A CEO with no member record still holds every
  // role, and routes/roles.js answers that from ceoID.
  for (const value of [null, undefined, "", 0, false]) {
    assert.equal(
      getCorporationMemberFromRuntime({ getCorporationMember: () => value }, 98777771, 90000001),
      null,
    );
  }
});

test("getCorporationMemberFromRuntime throws GameModuleShapeError when the export is gone", () => {
  assert.throws(
    () => getCorporationMemberFromRuntime({ listCorporationMembers: () => [] }, 98777771, 1),
    (err) => {
      assert.ok(err instanceof GameModuleShapeError);
      assert.equal(err.moduleKey, "corporationRuntimeState");
      assert.equal(err.property, "getCorporationMember");
      return true;
    },
  );
  // Own-property duck typing, the rule the whole file runs on.
  assert.throws(
    () => getCorporationMemberFromRuntime(
      Object.create({ getCorporationMember: () => vendorMemberRecord(1) }), 98777771, 1,
    ),
    GameModuleShapeError,
  );
});

test("getCorporationRecordFromRuntime forwards the corporation id and copies the record", () => {
  const live = { corporationID: 98777771, ceoID: 90000001, memberCount: 3 };
  const seen = [];
  const copy = getCorporationRecordFromRuntime({
    getCorporationRecord(corporationID) { seen.push(corporationID); return live; },
  }, 98777771);

  assert.deepEqual(seen, [98777771]);
  assert.notEqual(copy, live);
  assert.deepEqual(copy, live);
  assert.equal(copy.ceoID, 90000001, "ceoID is the field the director short-circuit needs");
});

test("getCorporationRecordFromRuntime returns null for an unknown corporation", () => {
  for (const value of [null, undefined, "", 0, false]) {
    assert.equal(
      getCorporationRecordFromRuntime({ getCorporationRecord: () => value }, 98777771),
      null,
    );
  }
});

test("getCorporationRecordFromRuntime throws GameModuleShapeError when the export is gone", () => {
  assert.throws(
    () => getCorporationRecordFromRuntime({ getAllianceRecord: () => ({}) }, 98777771),
    (err) => {
      assert.ok(err instanceof GameModuleShapeError);
      assert.equal(err.moduleKey, "corporationState");
      assert.equal(err.property, "getCorporationRecord");
      return true;
    },
  );
});

// Contacts: the two owner buckets, and what an id is

test("the two contact accessors forward the owner id and hand back the map only", () => {
  const seen = [];
  const runtime = (contacts) => ({
    corporationID: 98777771,
    members: { 90000001: { roles: "0" } },
    contacts,
  });

  const corporation = getCorporationContactsFromRuntime({
    getCorporationRuntime(corporationID) {
      seen.push(["corporation", corporationID]);
      return runtime({ 99000001: { relationshipID: 5, labelMask: 0, inWatchlist: true } });
    },
  }, 98777771);

  const alliance = getAllianceContactsFromRuntime({
    getAllianceRuntime(allianceID) {
      seen.push(["alliance", allianceID]);
      return runtime({ 98000001: { relationshipID: -10, labelMask: 0, inWatchlist: false } });
    },
  }, 99000001);

  assert.deepEqual(seen, [["corporation", 98777771], ["alliance", 99000001]]);

  // The map, not the runtime. Everything else in there (members, titles, the role
  // history) is a different endpoint's business or nobody's.
  assert.deepEqual(corporation, {
    99000001: { relationshipID: 5, labelMask: 0, inWatchlist: true },
  });
  assert.deepEqual(alliance, {
    98000001: { relationshipID: -10, labelMask: 0, inWatchlist: false },
  });
});

test("the two contact accessors deep-copy, so a stored row cannot be edited through them", () => {
  // Upstream clones the runtime today. Ownership must not rest on that, for
  // `getCorporationMember`'s reason one section up: a drop that made this a live
  // read would put a mutable game record above the boundary with no call site
  // changing.
  const live = { 99000001: { relationshipID: 5, labelMask: 0, inWatchlist: true } };
  const copy = getCorporationContactsFromRuntime(
    { getCorporationRuntime: () => ({ contacts: live }) },
    98777771,
  );

  assert.notEqual(copy, live);
  assert.notEqual(copy[99000001], live[99000001], "a nested row must not be shared");

  copy[99000001].relationshipID = -10;
  assert.equal(live[99000001].relationshipID, 5, "the stored contact must be untouched");
});

test("an owner with no runtime entry and one with no contacts are both null", () => {
  // `null` rather than `{}`, and the difference is load-bearing: routes/contacts.js
  // treats "this corporation is not in the runtime table" as this server
  // disagreeing with itself, because the subject check has already proved the
  // caller is a member of it.
  for (const value of [null, undefined, "", 0, false]) {
    assert.equal(
      getCorporationContactsFromRuntime({ getCorporationRuntime: () => value }, 98777771),
      null,
    );
    assert.equal(
      getAllianceContactsFromRuntime({ getAllianceRuntime: () => value }, 99000001),
      null,
    );
  }

  assert.equal(
    getCorporationContactsFromRuntime({ getCorporationRuntime: () => ({ members: {} }) }, 98777771),
    null,
    "a runtime with no contacts key at all",
  );
});

test("the two contact accessors throw GameModuleShapeError when their export is gone", () => {
  for (const [accessor, property, decoy] of [
    [getCorporationContactsFromRuntime, "getCorporationRuntime", "getCorporationRecord"],
    [getAllianceContactsFromRuntime, "getAllianceRuntime", "getAllianceRecord"],
  ]) {
    assert.throws(
      () => accessor({ [decoy]: () => ({}) }, 98777771),
      (err) => {
        assert.ok(err instanceof GameModuleShapeError);
        assert.equal(err.moduleKey, "corporationRuntimeState");
        assert.equal(err.property, property);
        return true;
      },
    );
  }
});

test("getOwnerTypeIdFromRuntime narrows an owner record to its typeID and nothing else", () => {
  // The narrowing is deliberate: an owner record also carries `ownerName`, and
  // "what kind of thing is this id" is answerable without it.
  const seen = [];
  const typeId = getOwnerTypeIdFromRuntime({
    getOwnerLookupRecord(ownerID) {
      seen.push(ownerID);
      return { ownerID, ownerName: "a name this accessor must not hand up", typeID: 2 };
    },
  }, 98777771);

  assert.deepEqual(seen, [98777771]);
  assert.equal(typeId, 2);
});

test("getOwnerTypeIdFromRuntime is null for an id the game cannot name", () => {
  // An answer, not a failure: a player character is not this lookup's business
  // (those are characterState's), so routes/contacts.js asks peekCharacterRecord
  // first and reads a null here as "and not one of the other four either", which
  // drops the row.
  for (const record of [null, undefined, "", 0, false]) {
    assert.equal(getOwnerTypeIdFromRuntime({ getOwnerLookupRecord: () => record }, 90000001), null);
  }

  // A record with an unusable typeID is the same answer rather than a NaN
  // travelling up into a lookup table.
  for (const typeID of [null, undefined, 0, -1, "", "corporation", 1.5, NaN]) {
    assert.equal(
      getOwnerTypeIdFromRuntime({ getOwnerLookupRecord: () => ({ typeID }) }, 90000001),
      null,
      `typeID ${JSON.stringify(typeID)} should not read as an owner type`,
    );
  }

  // A numeric string does read, because the table is keyed on the number.
  assert.equal(
    getOwnerTypeIdFromRuntime({ getOwnerLookupRecord: () => ({ typeID: "16159" }) }, 99000001),
    16159,
  );
});

test("getOwnerTypeIdFromRuntime throws GameModuleShapeError when the export is gone", () => {
  assert.throws(
    () => getOwnerTypeIdFromRuntime({ getCorporationRecord: () => ({}) }, 98777771),
    (err) => {
      assert.ok(err instanceof GameModuleShapeError);
      assert.equal(err.moduleKey, "corporationState");
      assert.equal(err.property, "getOwnerLookupRecord");
      return true;
    },
  );
});

test("no accessor reaches for the corporation getter that writes", () => {
  // `getCorporationSessionRoleState` is the obvious accessor and is disqualified:
  // for a member it calls `ensureCharacterMemberState`, which calls
  // `updateCorporationRuntime` and persists a default member record. A read
  // endpoint built on it writes into the game on the first request from a pilot
  // the corporation runtime has never seen. This file applies the same
  // disqualification to `getCharacterRecord`, enforced the same way.
  //
  // Scanned for in the call position only, so the prose above the accessors may
  // go on naming it.
  const source = fs.readFileSync(path.join(MOD_DIR, "lib", "runtimeAccess.js"), "utf8");
  for (const forbidden of [
    "getCorporationSessionRoleState",
    "ensureCharacterMemberState",
    "updateCorporationRuntime",
    "recordCorporationRoleHistory",
    "setCorporationMemberRoles",
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`requireOwnCallable\\([^)]*${forbidden}`),
      `runtimeAccess reaches for corporationRuntimeState.${forbidden}`,
    );
    assert.doesNotMatch(
      source,
      new RegExp(`readOwnCallable\\([^)]*${forbidden}`),
      `runtimeAccess probes for corporationRuntimeState.${forbidden}`,
    );
  }
});

// Structures, without running the world to read them

test("STRUCTURE_READ_OPTIONS is the frozen { refresh: false } both reads carry", () => {
  assert.deepEqual({ ...STRUCTURE_READ_OPTIONS }, { refresh: false });
  assert.equal(Object.isFrozen(STRUCTURE_READ_OPTIONS), true);
});

test("listCorporationStructuresFromRuntime reads with refresh disabled", () => {
  // Not a preference. Without it `listStructures` opens with
  // `tickStructures(Date.now())`, the fuel and state machine over every structure
  // on the server, ending in `persistStructures`, so an HTTP GET would mutate and
  // persist game state on the loop the universe ticks on.
  const seen = [];
  const rows = [{ structureID: 1 }];
  const result = listCorporationStructuresFromRuntime({
    listOwnedStructures(ownerCorpID, options) { seen.push([ownerCorpID, options]); return rows; },
  }, 98777771);

  assert.equal(result, rows);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 98777771);
  assert.equal(seen[0][1].refresh, false);
});

test("peekStructureRecordFromRuntime reads with refresh disabled", () => {
  const seen = [];
  peekStructureRecordFromRuntime({
    getStructureByID(structureID, options) { seen.push([structureID, options]); return {}; },
  }, 1000000000001);

  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 1000000000001);
  assert.equal(seen[0][1].refresh, false);
});

test("both structure reads hand the vendor a mutable copy of the options", () => {
  // STRUCTURE_READ_OPTIONS is frozen; handing the frozen object itself to game
  // code would turn any upstream write into a TypeError from inside the vendor
  // tree, the same argument READ_ONLY_REPOSITORY_OPTIONS makes.
  const received = [];
  listCorporationStructuresFromRuntime(
    { listOwnedStructures: (_id, options) => { received.push(options); return []; } }, 98777771,
  );
  peekStructureRecordFromRuntime(
    { getStructureByID: (_id, options) => { received.push(options); return null; } }, 1,
  );

  assert.equal(received.length, 2);
  for (const options of received) {
    assert.notEqual(options, STRUCTURE_READ_OPTIONS);
    assert.equal(Object.isFrozen(options), false);
    assert.deepEqual(options, { ...STRUCTURE_READ_OPTIONS });
  }
});

test("there is exactly one place in runtimeAccess that invokes a structureState export", () => {
  // The mechanism: `{ refresh: false }` cannot be omitted, because neither
  // accessor takes an options parameter and neither invokes the vendor itself. One
  // call site supplies the options for both, so "did this call site remember?"
  // cannot be asked of a second one.
  const source = fs.readFileSync(path.join(MOD_DIR, "lib", "runtimeAccess.js"), "utf8");

  assert.equal(
    (source.match(/\.call\(structureStateModule/g) ?? []).length,
    1,
    "a second call site into structureState can omit the refresh option; route it through "
    + "readStructureState instead",
  );
  assert.equal(
    (source.match(/\{\s*\.\.\.STRUCTURE_READ_OPTIONS\s*\}/g) ?? []).length,
    1,
    "the read options are built in more than one place, so one of them can drift",
  );

  // Neither vendor function is duck-typed anywhere else, which is the form that
  // would carry its own options argument.
  for (const forbidden of ["listOwnedStructures", "getStructureByID", "listStructures"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`requireOwnCallable\\(\\s*structureStateModule\\s*,\\s*"${forbidden}"`),
      `runtimeAccess duck-types structureState.${forbidden} outside readStructureState`,
    );
  }
});

test("listCorporationStructuresFromRuntime refuses to answer an empty collection on drift", () => {
  // An empty array is a valid, complete, wrong answer: eve-nexum reads it as
  // authoritative and deletes every structure it had recorded for the
  // corporation. A missing export and a corporation owning nothing are different
  // failures, the distinction countPlayersFromRuntime draws.
  assert.throws(
    () => listCorporationStructuresFromRuntime({ listStructures: () => [] }, 98777771),
    (err) => {
      assert.ok(err instanceof GameModuleShapeError);
      assert.equal(err.moduleKey, "structureState");
      assert.equal(err.property, "listOwnedStructures");
      return true;
    },
  );
  for (const value of [null, undefined, {}, "", 0]) {
    assert.throws(
      () => listCorporationStructuresFromRuntime({ listOwnedStructures: () => value }, 98777771),
      GameModuleShapeError,
      `listOwnedStructures returning ${String(value)} is drift, not an empty corporation`,
    );
  }
});

test("peekStructureRecordFromRuntime hands back the live row, and says so in its name", () => {
  // The opposite rule to the list beside it. `listStructures` maps `cloneValue`
  // over its rows; `getStructureByID` returns the cached row by reference, so this
  // is peekCharacterRecord's situation and the caller projects immediately rather
  // than holding it.
  const live = { structureID: 1000000000001, state: "shield_vulnerable" };
  assert.equal(peekStructureRecordFromRuntime({ getStructureByID: () => live }, 1), live);
});

test("peekStructureRecordFromRuntime returns null for an unknown structure", () => {
  for (const value of [null, undefined, "", 0, false]) {
    assert.equal(peekStructureRecordFromRuntime({ getStructureByID: () => value }, 1), null);
  }
});

test("peekStructureRecordFromRuntime throws GameModuleShapeError when the export is gone", () => {
  assert.throws(
    () => peekStructureRecordFromRuntime({ getStructureByName: () => null }, 1),
    (err) => {
      assert.ok(err instanceof GameModuleShapeError);
      assert.equal(err.moduleKey, "structureState");
      assert.equal(err.property, "getStructureByID");
      return true;
    },
  );
});

test("no accessor reaches for structureState's writes", () => {
  const source = fs.readFileSync(path.join(MOD_DIR, "lib", "runtimeAccess.js"), "utf8");
  for (const forbidden of [
    "tickStructures",
    "persistStructures",
    "updateStructureRecord",
    "createStructureRecord",
    "destroyStructure",
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`requireOwnCallable\\([^)]*${forbidden}`),
      `runtimeAccess reaches for structureState.${forbidden}`,
    );
  }
});

// Fleets, which exist only in memory.
//
// Both accessors are peekCharacterRecord's shape, and the doubles below return
// what the vendor returns: the live fleet object, with `members` as a real
// `Map`, because a projector that borrowed that Map would borrow a handle onto a
// collection the game adds to and deletes from.

/** A fleet as `createFleetRecord` builds one, cut down to what the routes read. */
function vendorFleet(fleetID, members = []) {
  return {
    fleetID,
    members: new Map(members.map((member) => [member.charID, member])),
    wings: new Map(),
  };
}

test("peekFleetForCharacterFromRuntime forwards the character id and the receiver", () => {
  const calls = [];
  const module = {
    getFleetForCharacter(characterID) { calls.push({ characterID, self: this }); return null; },
  };
  peekFleetForCharacterFromRuntime(module, 90000001);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].characterID, 90000001);
  assert.equal(calls[0].self, module);
});

test("peekFleetForCharacterFromRuntime applies an injected projector to the live fleet", () => {
  const live = vendorFleet(9000001, [{ charID: 90000001, role: 1, wingID: -1, squadID: -1 }]);
  const seen = [];
  const result = peekFleetForCharacterFromRuntime(
    { getFleetForCharacter: () => live },
    90000001,
    {
      project: (fleet, id) => {
        seen.push([fleet, id]);
        return { fleet_id: fleet.fleetID, character_id: id };
      },
    },
  );

  assert.deepEqual(result, { fleet_id: 9000001, character_id: 90000001 });
  // The projector runs against the live object, which is what a `peek` buys by not
  // cloning, and is why it must copy rather than borrow.
  assert.equal(seen[0][0], live);
  assert.equal(seen[0][1], 90000001);
});

test("peekFleetForCharacterFromRuntime never hands back the live fleet unprojected", () => {
  const live = vendorFleet(9000001);
  const copy = peekFleetForCharacterFromRuntime({ getFleetForCharacter: () => live }, 90000001);
  assert.notEqual(copy, live);
  assert.equal(copy.fleetID, 9000001);
});

test("peekFleetForCharacterFromRuntime returns null for a character in no fleet", () => {
  // The ordinary answer on /characters/{id}/fleet/, not an edge case, which is
  // why an absent accessor must not be answered the same way.
  for (const value of [null, undefined, "", 0, false]) {
    assert.equal(
      peekFleetForCharacterFromRuntime({ getFleetForCharacter: () => value }, 90000001),
      null,
    );
  }
});

test("peekFleetByIdFromRuntime forwards the fleet id and projects the live fleet", () => {
  const live = vendorFleet(9000001, [
    { charID: 90000001, role: 1, wingID: -1, squadID: -1 },
    { charID: 90000002, role: 4, wingID: 1, squadID: 1 },
  ]);
  const seen = [];
  const roster = peekFleetByIdFromRuntime(
    { getFleetByID(fleetID) { seen.push(fleetID); return live; } },
    9000001,
    { project: (fleet) => [...fleet.members.values()].map((m) => ({ charID: m.charID })) },
  );

  assert.deepEqual(seen, [9000001]);
  // An array projection passes straight through: /fleets/{id}/members/ is a
  // collection, and the accessor does not care what shape the caller wants.
  assert.deepEqual(roster, [{ charID: 90000001 }, { charID: 90000002 }]);
});

test("peekFleetByIdFromRuntime returns null for a fleet the runtime no longer holds", () => {
  for (const value of [null, undefined, "", 0, false]) {
    assert.equal(peekFleetByIdFromRuntime({ getFleetByID: () => value }, 9000001), null);
  }
});

test("both fleet accessors throw GameModuleShapeError when their export is gone", () => {
  for (const [core, property] of [
    [peekFleetForCharacterFromRuntime, "getFleetForCharacter"],
    [peekFleetByIdFromRuntime, "getFleetByID"],
  ]) {
    assert.throws(
      () => core({ getMemberRecord: () => null }, 1),
      (err) => {
        assert.ok(err instanceof GameModuleShapeError);
        assert.equal(err.moduleKey, "fleetRuntime");
        assert.equal(err.property, property);
        return true;
      },
    );
    // Own-property duck typing: a half-built circular require's warning proxy sits
    // on the prototype, and reading through it is the bug.
    assert.throws(
      () => core(Object.create({ [property]: () => vendorFleet(1) }), 1),
      GameModuleShapeError,
    );
  }
});

test("no accessor reaches for fleetRuntime's command exports", () => {
  // Both fleet routes are reads. `kickMember`, `makeLeader`, `disbandFleet`,
  // `moveMember` and `sendBroadcast` fly other people's fleets; a replica of a
  // read API should be unable to disband one, not merely disciplined about it (the
  // chatHub argument, made about fleets).
  const source = fs.readFileSync(path.join(MOD_DIR, "lib", "runtimeAccess.js"), "utf8");
  for (const forbidden of [
    "kickMember",
    "makeLeader",
    "disbandFleet",
    "moveMember",
    "leaveFleet",
    "forceLeaveFleet",
    "inviteCharacter",
    "sendBroadcast",
    "setMotd",
    "runtimeState",
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`requireOwnCallable\\([^)]*${forbidden}`),
      `runtimeAccess reaches for fleetRuntime.${forbidden}`,
    );
  }
});

// Vendor drift: the structure, corporation and fleet modules

test("structureState still gates its tick on the option the accessors pass", vendorOnly, () => {
  // The load-bearing claim of the structure section, and the one a stat cannot
  // make: that omitting `{ refresh: false }` would run the world. Read as text,
  // because requiring structureState opens SQLite at module scope.
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "server", "src", `${GAME_MODULES.structureState}.js`), "utf8",
  );

  for (const [name, signature] of [
    ["getStructureByID", /function\s+getStructureByID\s*\(\s*structureID\s*,\s*options\s*=\s*\{\}\s*\)\s*\{\s*if\s*\(\s*options\.refresh\s*!==\s*false\s*\)\s*\{\s*tickStructures\(/],
    ["listStructures", /function\s+listStructures\s*\(\s*options\s*=\s*\{\}\s*\)\s*\{\s*if\s*\(\s*options\.refresh\s*!==\s*false\s*\)\s*\{\s*tickStructures\(/],
  ]) {
    assert.match(source, signature, `${name} no longer runs tickStructures unless refresh is false`);
  }

  // `listOwnedStructures` has no options of its own; it forwards, so passing them
  // to it is enough.
  assert.match(
    source,
    /function\s+listOwnedStructures\s*\(\s*ownerCorpID\s*,\s*options\s*=\s*\{\}\s*\)[\s\S]*?return listStructures\(options\)\.filter\(/,
    "listOwnedStructures no longer forwards its options to listStructures",
  );

  // The tick still persists, which is why omitting the option is a write rather
  // than merely a slow read.
  assert.match(
    source,
    /function\s+tickStructures\s*\([\s\S]*?persistStructures\(nextRows\)/,
    "tickStructures no longer persists: re-read whether { refresh: false } is still the rule",
  );

  // The list clones its rows and the by-id read does not. That asymmetry is why
  // one accessor is named `peek` and the other is not.
  assert.match(
    source,
    /\.map\(\(entry\)\s*=>\s*cloneValue\(entry\)\)/,
    "listStructures no longer clones its rows, so listCorporationStructures now leaks live records",
  );
  assert.match(
    source,
    /return ensureStructureCache\(\)\.byStructureID\.get\([^;]*\)\s*\|\|\s*null;/,
    "getStructureByID no longer returns the cached row by reference: re-read peekStructureRecord",
  );

  assert.match(source, /^\s*getStructureByID,\s*$/m, "getStructureByID is no longer exported");
  assert.match(source, /^\s*listOwnedStructures,\s*$/m, "listOwnedStructures is no longer exported");
});

test("the corporation reads are still non-writing, and the avoided getter still writes", vendorOnly, () => {
  // Two claims, and the second is why this check exists: the accessor this mod
  // does not use must still be the one that writes, because the day it stops
  // being so is the day the note above getCorporationMember stops being true and a
  // future reader is entitled to ignore it.
  const runtimeSource = fs.readFileSync(
    path.join(REPO_ROOT, "server", "src", `${GAME_MODULES.corporationRuntimeState}.js`), "utf8",
  );
  const stateSource = fs.readFileSync(
    path.join(REPO_ROOT, "server", "src", `${GAME_MODULES.corporationState}.js`), "utf8",
  );

  /** The body of a top-level function, up to the first column-zero brace. */
  const bodyOf = (source, name) => {
    const found = new RegExp(`function\\s+${name}\\s*\\([\\s\\S]*?\\n\\}`).exec(source);
    assert.ok(found, `${name} is gone from the vendor tree`);
    return found[0];
  };

  // 1. The read this mod uses: the vendor's own argument order, a clone, and no
  //    write anywhere in it.
  const member = bodyOf(runtimeSource, "getCorporationMember");
  assert.match(
    member,
    /function\s+getCorporationMember\s*\(\s*corporationID\s*,\s*characterID\s*\)/,
    "getCorporationMember no longer takes (corporationID, characterID): the accessor's order",
  );
  assert.match(member, /cloneValue\(/, "getCorporationMember no longer clones");
  assert.doesNotMatch(
    member,
    /updateCorporationRuntime|writeTable|database\.write/,
    "getCorporationMember now writes: it is no longer the non-writing read",
  );
  assert.match(runtimeSource, /^\s*getCorporationMember,\s*$/m, "and it is no longer exported");

  // Masks are still decimal strings on the member record, which is why
  // routes/roles.js is BigInt throughout.
  assert.match(
    runtimeSource,
    /roles:\s*roleMask\.toString\(\)/,
    "the member record's role masks are no longer persisted as decimal strings",
  );

  // 2. The accessor this mod avoids. It is still a getter and still writes: the
  //    member record comes out of the writing call, now behind a check that the
  //    character is in that corporation, which is the caller a roles read serves.
  const trap = bodyOf(runtimeSource, "getCorporationSessionRoleState");
  assert.match(
    trap,
    /const memberState\s*=[^;]*\bensureCharacterMemberState\(/,
    "getCorporationSessionRoleState no longer takes its member from ensureCharacterMemberState: "
    + "re-read whether it is still the accessor this mod must refuse",
  );
  const ensure = bodyOf(runtimeSource, "ensureCharacterMemberState");
  assert.match(ensure, /updateCorporationRuntime\(/, "ensureCharacterMemberState no longer writes");
  assert.match(
    ensure,
    /buildDefaultMemberState\(/,
    "ensureCharacterMemberState no longer persists a default member record",
  );

  // 3. ceoID's owner: read, clone, normalise, and no write-back, which separates
  //    it from getCharacterRecord.
  const record = bodyOf(stateSource, "getCorporationRecord");
  assert.match(
    record,
    /function\s+getCorporationRecord\s*\(\s*corporationID\s*\)/,
    "getCorporationRecord no longer takes just the corporation id",
  );
  assert.match(record, /cloneValue\(storedRecord\)/, "getCorporationRecord no longer clones");
  assert.doesNotMatch(
    record,
    /database\.write|persistCorporation/,
    "getCorporationRecord now writes the normalised record back: it is a read that writes",
  );
  assert.match(stateSource, /^\s*getCorporationRecord,\s*$/m, "and it is no longer exported");
  assert.match(
    stateSource,
    /\bceoID\b/,
    "the corporation record no longer carries ceoID, which is the whole reason it is read",
  );
});

test("fleetRuntime still hands out the live in-memory fleet", vendorOnly, () => {
  // Read as text: requiring fleetRuntime pulls in characterSettingsState, which
  // calls createTableRepository at module scope and opens SQLite.
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "server", "src", `${GAME_MODULES.fleetRuntime}.js`), "utf8",
  );

  // In memory, not in the store. That makes both accessors `peek`s and a 404 the
  // ordinary answer.
  assert.match(
    source,
    /const runtimeState\s*=\s*\{[\s\S]{0,240}?fleets:\s*new Map\(\)/,
    "fleetRuntime no longer keeps its fleets in a module-scope Map",
  );

  // One Map get each, no clone: what comes back is the object the game mutates.
  assert.match(
    source,
    /function\s+getFleetByID\s*\(\s*fleetID\s*\)\s*\{\s*return runtimeState\.fleets\.get\(/,
    "getFleetByID is no longer a bare Map read: re-read whether peekFleetById may still borrow",
  );
  assert.match(
    source,
    /function\s+getFleetForCharacter\s*\(\s*characterID\s*\)\s*\{\s*const fleetID = runtimeState\.characterToFleet\.get\(/,
    "getFleetForCharacter is no longer a bare index lookup",
  );
  assert.match(source, /^\s*getFleetByID,\s*$/m, "getFleetByID is no longer exported");
  assert.match(source, /^\s*getFleetForCharacter,\s*$/m, "getFleetForCharacter is no longer exported");

  // `members` is still a Map, which is the shape both routes' projectors walk with
  // `.get(...)` and `.values()`.
  assert.match(
    source,
    /members:\s*new Map\(\)/,
    "a fleet's members are no longer a Map: routes/fleets.js projects them as one",
  );

  // The boss is still derived rather than exported, which is why routes/fleets.js
  // scans the job bit itself for `fleet_boss_id`.
  assert.match(source, /function\s+getBossCharacterID\s*\(/, "getBossCharacterID is gone");
  assert.doesNotMatch(
    source,
    /^\s*getBossCharacterID,\s*$/m,
    "getBossCharacterID is now exported: routes/fleets.js may stop deriving fleet_boss_id",
  );
});

// Saying one thing to one player (D3)

test("sendChatSystemMessageFromRuntime addresses the session's own channel", () => {
  const calls = [];
  const chatHub = {
    sendSystemMessage(session, message, channel) {
      calls.push({ session, message, channel, self: this });
    },
  };
  const session = { characterID: 90000001 };

  assert.equal(sendChatSystemMessageFromRuntime(chatHub, session, "hello"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session, session);
  assert.equal(calls[0].message, "hello");
  // `null` is upstream's "wherever this session is listening", which is what a
  // reply to a slash command wants: the answer appears where the player typed.
  assert.equal(calls[0].channel, null);
  assert.equal(calls[0].self, chatHub);
});

test("sendChatSystemMessageFromRuntime passes an explicit channel through", () => {
  const calls = [];
  const chatHub = { sendSystemMessage: (s, m, c) => calls.push(c) };
  sendChatSystemMessageFromRuntime(chatHub, {}, "hello", 42);
  assert.deepEqual(calls, [42]);
});

test("sendChatSystemMessageFromRuntime stringifies at the boundary", () => {
  // Everything above this line is the mod's own copy, but a non-string reaching
  // `sendSystemMessage` would fail inside game code rather than in ours, and the
  // conversion is one call.
  const calls = [];
  const chatHub = { sendSystemMessage: (s, message) => calls.push(message) };
  sendChatSystemMessageFromRuntime(chatHub, {}, 7);
  assert.deepEqual(calls, ["7"]);
  assert.equal(typeof calls[0], "string");
});

test("sendChatSystemMessageFromRuntime throws GameModuleShapeError when the export is gone", () => {
  // Drift, not an absent player. `lib/slashCommandPatch.js` catches it and costs
  // the player one reply rather than the slash system.
  assert.throws(
    () => sendChatSystemMessageFromRuntime({ broadcastLocalMessage: () => {} }, {}, "hi"),
    (err) => {
      assert.ok(err instanceof GameModuleShapeError);
      assert.equal(err.moduleKey, "chatHub");
      assert.equal(err.property, "sendSystemMessage");
      return true;
    },
  );
});

test("an inherited sendSystemMessage is not accepted", () => {
  // Own-property duck typing, the rule the whole file runs on.
  assert.throws(
    () => sendChatSystemMessageFromRuntime(
      Object.create({ sendSystemMessage: () => {} }), {}, "hi",
    ),
    GameModuleShapeError,
  );
});

test("no accessor reaches for chatHub's broadcast or channel-management exports", () => {
  // The mod's one write into the game is a system line to the session that ran a
  // command. `broadcastLocalMessage`, `joinLocalChannel`, `moveLocalSession` and
  // `unregisterSession` are upstream's, and a replica of a read API should be
  // unable to shout at the server rather than merely disciplined about it (the
  // chat counterpart of the read-only table handle above).
  const source = fs.readFileSync(path.join(MOD_DIR, "lib", "runtimeAccess.js"), "utf8");
  for (const forbidden of [
    "broadcastLocalMessage",
    "joinLocalChannel",
    "leaveLocalChannel",
    "moveLocalSession",
    "unregisterSession",
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`requireOwnCallable\\([^)]*${forbidden}`),
      `runtimeAccess reaches for chatHub.${forbidden}`,
    );
  }
});

test("chatHub still exports sendSystemMessage with the signature the accessor assumes", vendorOnly, () => {
  // A stat is enough for GAME_MODULES; this one needs the arity too, because the
  // accessor passes a third argument and a vendor drop that dropped the
  // `specificChannel` parameter would silently start ignoring it. Read as text,
  // because requiring chatHub would pull in the XMPP layer.
  const file = path.join(REPO_ROOT, "server", "src", `${GAME_MODULES.chatHub}.js`);
  const source = fs.readFileSync(file, "utf8");
  assert.match(
    source,
    /function\s+sendSystemMessage\s*\(\s*session\s*,\s*message\s*,\s*specificChannel\s*=\s*null\s*\)/,
    "chatHub.sendSystemMessage no longer has the (session, message, specificChannel) shape",
  );
  assert.match(source, /^\s*sendSystemMessage,\s*$/m, "and it is no longer exported");
});

// Setting one pilot's autopilot route

/** A session double: a class instance, because the real one is. */
function sessionDouble(sent = []) {
  class ClientSession {
    sendNotification(notifyType, idType, payloadTuple) {
      sent.push({ notifyType, idType, payloadTuple, self: this });
    }
  }
  return new ClientSession();
}

/** A registry double that hands out `session` for `characterID` and nothing else. */
function registryDouble(characterID, session) {
  return {
    findSessionByCharacterID(id) {
      return id === characterID ? session : null;
    },
  };
}

test("the push names the notification, the id type and the three arguments in order", () => {
  const sent = [];
  const session = sessionDouble(sent);
  const registry = registryDouble(90000001, session);

  const outcome = sendDestinationChangeFromRuntime(registry, {
    characterId: 90000001,
    destinationId: 30000142,
    clearOtherWaypoints: true,
    addToBeginning: false,
  });

  assert.equal(outcome, PUSH_OUTCOME.PUSHED);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].notifyType, DESTINATION_NOTIFICATION);
  assert.equal(sent[0].idType, DESTINATION_ID_TYPE);
  // Argument order is the contract, not the argument names: the client reads the
  // three positionally out of the payload tuple, so a reordering is a pilot sent
  // somewhere they did not ask to go with their route cleared.
  assert.deepEqual(sent[0].payloadTuple, [30000142, true, false]);
  assert.equal(sent[0].self, session, "called as a method of the session");
});

test("the two flags are read strictly, so an absent one is never a truthy accident", () => {
  const sent = [];
  const registry = registryDouble(90000001, sessionDouble(sent));

  sendDestinationChangeFromRuntime(registry, { characterId: 90000001, destinationId: 30000142 });
  assert.deepEqual(sent[0].payloadTuple, [30000142, false, false]);

  sendDestinationChangeFromRuntime(registry, {
    characterId: 90000001,
    destinationId: 30000142,
    clearOtherWaypoints: "false",
    addToBeginning: 1,
  });
  assert.deepEqual(sent[1].payloadTuple, [30000142, false, false], "only `true` is true");
});

test("a character with no session is an outcome, never an error", () => {
  // This is not "the pilot is offline": `sessionRegistry` says in its own opening
  // lines that presence is derived through `characterControlRuntime` "so
  // browser-pilot leases never need fake sessions in this registry", which means a
  // pilot flying through the browser lands here too. Reporting that as offline
  // would be a false statement, which is half of why D34 refuses to report
  // anything at all.
  const registry = registryDouble(90000001, sessionDouble());

  assert.equal(
    sendDestinationChangeFromRuntime(registry, { characterId: 90000002, destinationId: 30000142 }),
    PUSH_OUTCOME.NO_SESSION,
  );
});

test("an inherited sendNotification IS accepted, unlike every module export here", () => {
  // The one place in the accessor file that duck-types on the prototype chain. A
  // game module is an object literal of exports, so an inherited member is
  // something other than the export meant; a session is a class instance and every
  // method it has is on `ClientSession.prototype`, so own-property duck typing
  // would reject the genuine article and accept nothing at all.
  const sent = [];
  const session = sessionDouble(sent);
  assert.equal(
    Object.prototype.hasOwnProperty.call(session, "sendNotification"),
    false,
    "the double is a class instance, as the real session is",
  );

  assert.equal(
    sendDestinationChangeFromRuntime(registryDouble(90000001, session), {
      characterId: 90000001,
      destinationId: 30000142,
    }),
    PUSH_OUTCOME.PUSHED,
  );
});

test("a registry without the finder is drift, and says which module and which export", () => {
  assert.throws(
    () => sendDestinationChangeFromRuntime({ getSessions: () => [] }, {
      characterId: 90000001,
      destinationId: 30000142,
    }),
    (err) => {
      assert.ok(err instanceof GameModuleShapeError);
      assert.equal(err.moduleKey, "sessionRegistry");
      assert.equal(err.property, "findSessionByCharacterID");
      return true;
    },
  );
});

test("a session that is no longer a session is drift too, not a silent no-op", () => {
  // `routes/ui.js` turns this into `push-failed` and a `204`, which is D34's
  // answer, but it must arrive there as a throw with a stack, because a
  // notification quietly not sent is indistinguishable from one sent to a pilot
  // who had already logged out.
  assert.throws(
    () => sendDestinationChangeFromRuntime(registryDouble(90000001, { characterID: 90000001 }), {
      characterId: 90000001,
      destinationId: 30000142,
    }),
    (err) => {
      assert.ok(err instanceof GameModuleShapeError);
      assert.equal(err.property, "session.sendNotification");
      return true;
    },
  );
});

test("both ids are checked before anybody is looked up", () => {
  // The other order reports a bad destination as `NO_SESSION` half the time (when
  // the pilot happens to be offline), which is the kind of bug that only shows up
  // in the case nobody tested.
  const looked = [];
  const registry = {
    findSessionByCharacterID(id) {
      looked.push(id);
      return sessionDouble();
    },
  };

  for (const bad of [0, -1, 1.5, "90000001", null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(
      () => sendDestinationChangeFromRuntime(registry, { characterId: 90000001, destinationId: bad }),
      TypeError,
      `${JSON.stringify(String(bad))} should not reach game code as a destination`,
    );
  }
  assert.deepEqual(looked, [], "nothing was looked up for any of them");
});

test("sessionRegistry still exports findSessionByCharacterID, and it still takes a character", vendorOnly, () => {
  // Read as text rather than required: requiring the registry pulls in the chat
  // layer, and `GAME_MODULES` above only stats the file. The signature matters as
  // well as the name: the accessor passes one argument and relies on the default
  // for the options bag, so a drop that made options required would change what
  // "find a session" means.
  const file = path.join(REPO_ROOT, "server", "src", `${GAME_MODULES.sessionRegistry}.js`);
  const source = fs.readFileSync(file, "utf8");

  assert.match(
    source,
    /function\s+findSessionByCharacterID\s*\(\s*characterID\s*,\s*options\s*=\s*\{\}\s*\)/,
    "sessionRegistry.findSessionByCharacterID no longer has the (characterID, options) shape",
  );
  assert.match(source, /^\s*findSessionByCharacterID,\s*$/m, "and it is no longer exported");
});

test("a client session still takes (notifyType, idType, payloadTuple)", vendorOnly, () => {
  // The other half of the push, and the half that is not a module export at all:
  // `sendNotification` is a method on the session the registry hands back, so
  // nothing in `GAME_MODULES` covers it and this is the only check that would
  // notice it moving.
  const file = path.join(REPO_ROOT, "server", "src", "network", "clientSession.js");
  const source = fs.readFileSync(file, "utf8");

  assert.match(
    source,
    /sendNotification\s*\(\s*notifyType\s*,\s*idType\s*,\s*payloadTuple\s*=\s*\[\]\s*\)/,
    "clientSession.sendNotification no longer has the (notifyType, idType, payloadTuple) shape",
  );
  // It is still fire-and-forget: a destroyed socket is a ledger event and a bare
  // `return`, which is why `PUSHED` cannot mean delivered.
  assert.match(source, /this\.socket\.destroyed/, "the destroyed-socket guard is gone");
});

// Acceptance: nothing else touches game code

/**
 * The only subdirectory of `test/` that is part of the mod.
 *
 * `node --test` runs test files concurrently, and sibling suites create and
 * delete `fs.mkdtemp`-style scratch directories under `test/` while this walk is
 * running (the source-hash and health suites copy the mod into one). Those are
 * not mod sources: walking them races (a directory vanishes mid-`readdirSync`)
 * and would judge a transient copy of a file against an allow-list keyed on the
 * original's path.
 */
const SHIPPED_TEST_SUBDIRS = new Set(["fixtures"]);

/** Every `.js` file in the mod, minus VCS, dependency and scratch noise. */
function listModSources(dir, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    // A concurrent suite removed it between the parent listing and this call.
    return found;
  }

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === path.join(MOD_DIR, "test") && !SHIPPED_TEST_SUBDIRS.has(entry.name)) continue;
      listModSources(full, found);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * The two files permitted to name the vendor tree in a `require`, and why.
 *
 * An allow-list rather than a blanket exemption for `test/`, because a test that
 * quietly requires game code is the leak this check exists to catch: it would
 * boot the emulator inside `node --test` and make the suite depend on a game
 * server without anyone deciding that it should.
 */
const GAME_CODE_REQUIRERS = Object.freeze({
  "lib/runtimeAccess.js":
    "the module this whole rule is about: the single door to game code",
  "test/runtimeAccess.test.js":
    "one vendor-gated drift check requires gameStore/tableRepository to prove upstream "
    + "still refuses a mod:esiApi write; it injects a fake store, so no database opens",
});

test("no file outside lib/runtimeAccess.js requires anything from server/src", () => {
  // Checked mechanically rather than by review, because it is the property every
  // other module's testability rests on and it is one careless `require` away from
  // being false.
  //
  // The pattern is `require(` followed, before the call closes, by `server` and
  // `src` separated only by punctuation, which catches the literal
  // `"server/src/..."`, the Windows-slashed variant and the
  // `path.join(root, "server", "src", ...)` form alike. Prose mentioning
  // server/src does not match, because a `require(` is always closed on its own
  // expression, which is why this can be crude and still be right.
  const offender = /require\s*\([^)]{0,200}?\bserver\b[^A-Za-z0-9_]{1,8}\bsrc\b/;

  const sources = listModSources(MOD_DIR);
  assert.ok(sources.length > 0, "the source walk found nothing: it is checking the wrong tree");

  for (const file of sources) {
    const relative = path.relative(MOD_DIR, file).split(path.sep).join("/");
    if (Object.prototype.hasOwnProperty.call(GAME_CODE_REQUIRERS, relative)) continue;

    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (_) {
      continue; // Same race as the walk above.
    }
    assert.doesNotMatch(
      text,
      offender,
      `${relative} requires game code: only lib/runtimeAccess.js may`,
    );
  }
});

test("every allow-listed game-code requirer still exists and still says why", () => {
  // A stale exemption is a hole nobody can see: a deleted or renamed file leaves
  // an entry behind that pre-approves whatever takes its path next.
  //
  // Existence and a reason, not "does it still match the pattern": the owner
  // builds its paths from the resolved `server/src` rather than naming it
  // literally, so it does not match and never should.
  for (const [relative, reason] of Object.entries(GAME_CODE_REQUIRERS)) {
    const full = path.join(MOD_DIR, relative);
    assert.equal(fs.existsSync(full), true, `allow-listed file is gone: ${relative}`);
    assert.ok(reason.length > 0, `allow-listed file has no reason: ${relative}`);
  }
});
