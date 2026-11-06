/**
 * `routes/health.js`: does the diagnostic answer when things are broken?
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Health is read when things are broken, so it has to answer then. A health
 * endpoint that works on a healthy server and 500s on a sick one turns the
 * diagnostic into a second outage and sends the operator looking in the wrong
 * place.
 *
 * The game runtime is therefore a double, and most doubles here are broken on
 * purpose: one that throws, one that returns nonsense, one that is absent. The
 * absent case is real: the loader preloads into every node process in the
 * container, including eve.js's healthcheck process and its forked edge
 * workers, none of which have game state.
 *
 * Nothing here requires `config.js` or `lib/runtimeAccess.js`. The suite must
 * pass with no eve.js checkout present and nothing booted, which is possible
 * because every dependency arrives through `deps`.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { HEALTH_PATH, buildHealthReport, createHealthDispatch } = require(
  path.join(__dirname, "../routes/health"),
);
const { shortSourceHash } = require(path.join(__dirname, "../lib/sourceHash"));

// Fixtures
//
// Temp trees live under `test/` and are removed in `t.after`, so debris from a
// failing run lands beside the test that made it rather than in a shared
// system folder.

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(__dirname, "health-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, relPath, content) {
  const abs = path.join(dir, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** A stand-in for `lib/runtimeAccess.js`, working unless told otherwise. */
function makeRuntime(options = {}) {
  const {
    gameStoreRoot = null,
    sdeRoot = null,
    reachable = true,
    reason = null,
    calls = null,
  } = options;

  return {
    getStorePaths() {
      if (calls) calls.storePaths += 1;
      return { gameStoreRoot, sdeRoot };
    },
    isRuntimeReachable() {
      if (calls) calls.reachable += 1;
      return { reachable, reason };
    },
  };
}

const FIXED_NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const clock = (ms) => () => ms;

// The happy path, in full

test("the report carries every contracted field, with the contracted types", (t) => {
  const dir = makeDir(t);
  const gameStoreRoot = path.join(dir, "gameStore");
  const sdeRoot = path.join(dir, "sde");
  fs.mkdirSync(gameStoreRoot);
  fs.mkdirSync(sdeRoot);

  const report = buildHealthReport({
    config: { modVersion: "0.1.0" },
    runtime: makeRuntime({ gameStoreRoot, sdeRoot }),
    modDir: dir,
    startedAt: FIXED_NOW - 90_000,
    now: clock(FIXED_NOW),
  });

  assert.equal(report.status, "ok");
  assert.equal(report.modVersion, "0.1.0");
  assert.equal(typeof report.sourceHash, "string");
  assert.equal(report.startedAt, new Date(FIXED_NOW - 90_000).toISOString());
  assert.equal(report.uptimeSeconds, 90);

  assert.deepEqual(report.gameStore, { path: gameStoreRoot, readable: true, error: null });
  assert.deepEqual(report.sde, { path: sdeRoot, readable: true, error: null });
  assert.deepEqual(report.runtimeReachable, { reachable: true, reason: null });

  // The field list is fixed by docs/module-contracts.md, so an extra key here
  // is a contract change, not an improvement.
  assert.deepEqual(Object.keys(report).sort(), [
    "gameStore",
    "modVersion",
    "runtimeReachable",
    "sde",
    "sourceHash",
    "startedAt",
    "status",
    "uptimeSeconds",
  ]);
});

// Reporting rather than judging

test("status stays ok when the game runtime is unreachable", (t) => {
  const dir = makeDir(t);

  const report = buildHealthReport({
    config: { modVersion: "0.1.0" },
    runtime: makeRuntime({ reachable: false, reason: "game runtime has not booted" }),
    modDir: dir,
  });

  // The listener is up and it answered. That the game behind it is still
  // booting is a fact about the game; a health check that went red for it would
  // make every normal startup look like a dead mod.
  assert.equal(report.status, "ok");
  assert.equal(report.runtimeReachable.reachable, false);
  assert.equal(report.runtimeReachable.reason, "game runtime has not booted");
});

test("a resolved path that is simply not there is a fact, not an error", (t) => {
  const dir = makeDir(t);
  const gameStoreRoot = path.join(dir, "gameStore-that-was-never-generated");

  const report = buildHealthReport({
    runtime: makeRuntime({ gameStoreRoot, sdeRoot: path.join(dir, "sde-missing") }),
    modDir: dir,
  });

  // `path` set, `readable` false, `error` null. "The mod is looking in the wrong
  // place" and "the mod cannot look" need different fixes, and these three
  // fields exist to keep them apart.
  assert.equal(report.gameStore.path, gameStoreRoot);
  assert.equal(report.gameStore.readable, false);
  assert.equal(report.gameStore.error, null);
  assert.equal(report.sde.readable, false);
  assert.equal(report.sde.error, null);
});

test("a path that exists but is a file, not a directory, is not readable", (t) => {
  const dir = makeDir(t);
  const notADir = write(dir, "gameStore", "this is a file\n");

  const report = buildHealthReport({ runtime: makeRuntime({ gameStoreRoot: notADir }), modDir: dir });

  assert.equal(report.gameStore.path, notADir);
  assert.equal(report.gameStore.readable, false);
  assert.equal(report.gameStore.error, null);
});

test("a runtime that resolves no path at all says so", (t) => {
  const dir = makeDir(t);

  const report = buildHealthReport({
    runtime: { getStorePaths: () => ({}), isRuntimeReachable: () => ({ reachable: true }) },
    modDir: dir,
  });

  assert.equal(report.gameStore.path, null);
  assert.equal(report.gameStore.readable, false);
  assert.equal(report.gameStore.error, "no path resolved");
});

// Never throws

test("a runtime whose accessors throw still produces a report", (t) => {
  const dir = makeDir(t);
  const boom = () => {
    throw new Error("Cannot find module 'gameStore/storeRoot'");
  };

  const report = buildHealthReport({
    runtime: { getStorePaths: boom, isRuntimeReachable: boom },
    modDir: dir,
  });

  assert.equal(report.status, "ok");
  assert.match(report.gameStore.error, /storeRoot/);
  assert.match(report.sde.error, /storeRoot/);
  assert.equal(report.runtimeReachable.reachable, false);
  assert.match(report.runtimeReachable.reason, /storeRoot/);
});

test("a failure message is bounded before it reaches the body", (t) => {
  const dir = makeDir(t);
  const boom = () => {
    throw new Error("x".repeat(5000));
  };

  const report = buildHealthReport({
    runtime: { getStorePaths: boom, isRuntimeReachable: boom },
    modDir: dir,
  });

  // Unbounded, this message would be copied verbatim into every health response
  // for as long as the fault lasted, and faults that produce 5 KB messages are
  // the ones that last.
  assert.ok(report.gameStore.error.length < 300);
  assert.ok(report.runtimeReachable.reason.length < 300);
});

test("no runtime at all (the healthcheck process) still gets an answer", (t) => {
  const dir = makeDir(t);

  const report = buildHealthReport({ config: { modVersion: "0.1.0" }, modDir: dir });

  assert.equal(report.status, "ok");
  assert.equal(report.modVersion, "0.1.0");
  assert.equal(report.runtimeReachable.reachable, false);
  assert.equal(report.runtimeReachable.reason, "runtime unavailable");
  assert.equal(report.gameStore.error, "runtime unavailable");
  assert.equal(report.sde.error, "runtime unavailable");
});

test("a runtime that answers reachability with nonsense is not believed", (t) => {
  const dir = makeDir(t);

  const report = buildHealthReport({
    runtime: { getStorePaths: () => ({}), isRuntimeReachable: () => "yes, definitely" },
    modDir: dir,
  });

  assert.equal(report.runtimeReachable.reachable, false);
  assert.equal(typeof report.runtimeReachable.reason, "string");
});

test("buildHealthReport called with nothing at all does not throw", () => {
  // The shape of "the loader failed before it could wire anything up", the case
  // where the caller most needs an answer.
  let report;
  assert.doesNotThrow(() => {
    report = buildHealthReport();
  });

  assert.equal(report.status, "ok");
  assert.equal(report.modVersion, "unknown");
  assert.equal(report.uptimeSeconds, 0);
  // No modDir given, so it falls back to this mod's own root, which is real.
  assert.match(report.sourceHash, /^[0-9a-f]{12}$/);
});

// The clock

test("uptime is clamped at zero when the clock runs backwards", (t) => {
  const dir = makeDir(t);

  const report = buildHealthReport({
    modDir: dir,
    startedAt: FIXED_NOW + 60_000,
    now: clock(FIXED_NOW),
  });

  // NTP stepping the container's clock backwards is the realistic cause. A
  // negative uptime is of no use to anyone.
  assert.equal(report.uptimeSeconds, 0);
});

test("an injected clock that throws falls back to the real one", (t) => {
  const dir = makeDir(t);

  const report = buildHealthReport({
    modDir: dir,
    now: () => {
      throw new Error("clock failure");
    },
  });

  assert.equal(report.status, "ok");
  assert.match(report.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(report.uptimeSeconds, 0);
});

test("with no startedAt, uptime is zero rather than an epoch-sized number", (t) => {
  const dir = makeDir(t);

  const report = buildHealthReport({ modDir: dir, now: clock(FIXED_NOW) });

  assert.equal(report.startedAt, new Date(FIXED_NOW).toISOString());
  assert.equal(report.uptimeSeconds, 0);
});

// Build identity

test("the source hash is computed from modDir when the caller does not supply one", (t) => {
  const dir = makeDir(t);
  write(dir, "lib/thing.js", "module.exports = 1;\n");

  const report = buildHealthReport({ modDir: dir });

  assert.equal(report.sourceHash, shortSourceHash(dir));
  assert.match(report.sourceHash, /^[0-9a-f]{12}$/);
});

test("a modDir with no runtime files reports an unknown build rather than failing", (t) => {
  const dir = makeDir(t);
  write(dir, "README.md", "# not a mod\n");

  assert.equal(buildHealthReport({ modDir: dir }).sourceHash, "unknown");
});

test("a caller-supplied source hash wins, so the loader can pass the one it already computed", (t) => {
  const dir = makeDir(t);
  write(dir, "lib/thing.js", "module.exports = 1;\n");

  const report = buildHealthReport({ modDir: dir, sourceHash: "abcdef012345" });

  assert.equal(report.sourceHash, "abcdef012345");
});

test("the hash is computed once per directory and does not follow later edits", (t) => {
  const dir = makeDir(t);
  write(dir, "lib/thing.js", "module.exports = 1;\n");

  const first = buildHealthReport({ modDir: dir }).sourceHash;
  write(dir, "lib/thing.js", "module.exports = 2;\n");
  const second = buildHealthReport({ modDir: dir }).sourceHash;

  // Deliberate (see routes/health.js): the question is which build this process
  // is running, and the process loaded its code once. Re-reading per request
  // would report a file that is on disk and provably not running, the confusion
  // the hash exists to end.
  assert.equal(second, first);
});

// Cost

test("each runtime accessor is called exactly once per report", (t) => {
  const dir = makeDir(t);
  const calls = { storePaths: 0, reachable: 0 };

  buildHealthReport({ runtime: makeRuntime({ calls }), modDir: dir });

  // This runs on the game's single event loop every time a monitor polls, so the
  // work is one question to the runtime and two stats. No table is opened and
  // nothing is parsed.
  assert.equal(calls.storePaths, 1);
  assert.equal(calls.reachable, 1);
});

// The path

test("the path sits outside anything ESI could ever route", () => {
  assert.equal(HEALTH_PATH, "/_mod/health");

  // Real ESI has no /health, and its /ping must stay byte-exact, so the
  // diagnostic goes where CCP's namespace cannot grow into it. Every ESI path
  // begins with a version, "latest", "legacy", "dev" or "meta".
  assert.ok(HEALTH_PATH.startsWith("/_mod/"));
  for (const prefix of ["/v", "/latest", "/legacy", "/dev", "/meta", "/ping"]) {
    assert.ok(!HEALTH_PATH.startsWith(prefix), `must not collide with ${prefix}`);
  }
});

// The dispatch wrapper

test("GET the health path returns 200, an uncacheable JSON body, and the report", (t) => {
  const dir = makeDir(t);
  const dispatch = createHealthDispatch({
    config: { modVersion: "0.1.0" },
    runtime: makeRuntime(),
    modDir: dir,
  });

  const result = dispatch({ method: "GET", pathname: HEALTH_PATH });

  assert.equal(result.status, 200);
  // uptimeSeconds changes every second and the endpoint reports the state now: a
  // cached health response is not stale, it is wrong.
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.body.status, "ok");
  assert.equal(result.body.modVersion, "0.1.0");
});

test("any other path is a 404, so the ESI router can fall through to it", (t) => {
  const dir = makeDir(t);
  const dispatch = createHealthDispatch({ modDir: dir });

  assert.deepEqual(dispatch({ method: "GET", pathname: "/latest/status/" }), { status: 404 });
  assert.deepEqual(dispatch({ method: "GET", pathname: "/_mod/health/extra" }), { status: 404 });
  assert.deepEqual(dispatch({ method: "GET", pathname: "/_mod/" }), { status: 404 });
});

test("a non-GET method on the health path is 405, not 404", (t) => {
  const dir = makeDir(t);
  const dispatch = createHealthDispatch({ modDir: dir });

  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
    const result = dispatch({ method, pathname: HEALTH_PATH });
    assert.equal(result.status, 405, `${method} must not be served`);
  }
});

test("the dispatch never throws, whatever it is handed", (t) => {
  const dir = makeDir(t);
  const dispatch = createHealthDispatch({ modDir: dir });

  // server.js turns a throwing dispatch into a 500 and logs it, but an unhandled
  // rejection is treated as fatal by eve.js's ProcessLifecycle. This is the
  // cheapest place to be sure.
  for (const request of [undefined, null, {}, "not a request", 42, { pathname: HEALTH_PATH }]) {
    assert.doesNotThrow(() => dispatch(request));
  }
});

// Exports

test("the module exports exactly what the contract names, and nothing mutable", () => {
  const mod = require(path.join(__dirname, "../routes/health"));

  assert.deepEqual(Object.keys(mod).sort(), [
    "HEALTH_PATH",
    "buildHealthReport",
    "createHealthDispatch",
  ]);
  assert.ok(Object.isFrozen(mod));
});
