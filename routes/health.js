/**
 * `GET /_mod/health`: the one endpoint that is not ESI.
 *
 * The mod must be indistinguishable from CCP's ESI to a third-party tool
 * (design constraint 3). Real ESI has no `/health`, so neither does this
 * mod's ESI surface. It has a `/ping`, which must stay byte-exact (2 bytes,
 * `text/plain`, no trailing newline) because tools use it as a liveness probe.
 *
 * The diagnostic therefore lives where ESI cannot grow: no ESI route, present
 * or future, begins with `/_mod/`. CCP's paths are `/v{n}/...`, `/latest/...`,
 * `/legacy/...`, `/dev/...` and `/meta/...`. A root `/health` would be hostage
 * to the next ESI release adding one.
 *
 * Health is what someone reads when things are broken, which decides three
 * rules:
 *
 *   1. It never throws. Every failure, including "the game module that
 *      resolves the store root would not load", is caught and reported as a
 *      field. A health endpoint that 500s because the game is not up is a
 *      second outage.
 *   2. It is cheap: two `stat` calls and no reads. It runs on the game
 *      server's single event loop (design constraint 2), so a monitor
 *      may poll it freely. Nothing is proportional to game state.
 *   3. It reports, it does not judge. `status` is `"ok"` whenever this code ran
 *      and produced an answer. An unreachable game runtime is a field in the
 *      body, not an error status: the listener is up, and a check that went red
 *      for a game still booting would make a normal startup look like a dead
 *      mod.
 *
 * Everything is injected: `config`, `runtime`, `modDir`, `startedAt` and `now`
 * arrive in `deps`. Nothing here requires `../config` or
 * `../lib/runtimeAccess`, so the suite runs with no eve.js checkout, and the
 * "game is unreachable" path can be tested with a double that throws.
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");

const { shortSourceHash } = require("../lib/sourceHash");

/** Outside the ESI namespace by construction: see the header. */
const HEALTH_PATH = "/_mod/health";

/**
 * How much of a failure message is copied into the body.
 *
 * Bounded because an unbounded message is copied into every health response for
 * as long as the condition lasts, and the conditions that produce long messages
 * (a require stack, a JSON parse failure) are the ones that last. An 8 KB
 * response repeated once a second loses the operator.
 */
const MAX_REPORTED_ERROR = 200;

/**
 * The mod directory, when the caller did not say.
 *
 * `routes/health.js` is one level down, so `..` is the mod root both here and in
 * the deployed copy at `<eve.js tree>/mods/esiApi/`. The loader passes `modDir`
 * explicitly; the default keeps the report correct if a caller forgets, rather
 * than reporting `"unknown"` for the field hardest to notice is wrong.
 */
const DEFAULT_MOD_DIR = path.resolve(__dirname, "..");

// The source hash is computed once, not per request.
//
// It is cheap: hashing the runtime tree is a dozen small synchronous reads,
// which once is nothing and once per poll on the game's event loop is a cost
// this endpoint promised not to have.
//
// It is also honest: the question is which build this process is running, and
// the process loaded its code once, at preload. Re-reading per request would
// report files edited after boot, which are on disk and demonstrably not
// running. One entry, because a live process has one mod directory; a test that
// points at a second recomputes.
let cachedHashDir = null;
let cachedHash = null;

function memoizedShortSourceHash(modDir) {
  if (modDir !== cachedHashDir) {
    cachedHash = shortSourceHash(modDir);
    cachedHashDir = modDir;
  }
  return cachedHash;
}

/** An error's message, bounded, or a stand-in: never a stack, never a throw. */
function failureText(err) {
  const message = err && typeof err.message === "string" ? err.message : "";
  if (message === "") return "unavailable";
  return message.length > MAX_REPORTED_ERROR
    ? `${message.slice(0, MAX_REPORTED_ERROR)}…`
    : message;
}

/**
 * Milliseconds now, from the injected clock, defensively.
 *
 * `now` is injected so tests can pin uptime. If it throws or returns something
 * that is not a finite number, this falls back rather than propagating (rule 1).
 */
function resolveNow(deps) {
  if (typeof deps.now === "function") {
    try {
      const value = deps.now();
      if (typeof value === "number" && Number.isFinite(value)) return value;
    } catch {
      /* fall through to the real clock */
    }
  }
  return Date.now();
}

/**
 * One directory, described: is it there, and where did we look?
 *
 * A path that resolves to nothing is `readable: false` with `error: null`:
 * nothing failed, it is not there. That separates "the mod is looking in the
 * wrong place" from "the mod cannot look", which have different fixes.
 */
function describeDir(dirPath) {
  const described = { path: null, readable: false, error: null };

  if (typeof dirPath !== "string" || dirPath === "") {
    // The runtime answered, but not with a path. That is a shape problem, not a
    // filesystem one, and stating it beats reporting an ENOENT for "".
    described.error = "no path resolved";
    return described;
  }

  described.path = dirPath;

  try {
    described.readable = fs.statSync(dirPath).isDirectory();
  } catch (err) {
    // ENOENT is the "not there" case above and stays out of `error`. Anything else
    // (EACCES, ELOOP, EPERM in a container with an odd mount) is a real failure and
    // is named.
    if (!err || err.code !== "ENOENT") described.error = failureText(err);
  }

  return described;
}

/**
 * Where this process thinks the game's data lives, and whether it is there.
 *
 * `getStorePaths()` reaches game code, so it is the likeliest call here to
 * fail: when the mod is preloaded into a process with no game in it (the
 * healthcheck process, an edge worker), or when an upstream drop moves
 * `gameStore/storeRoot`. One try/catch covers it, and both directories report
 * the same reason because they came from the same failed question.
 */
function inspectStorePaths(runtime) {
  let paths;

  try {
    paths = runtime.getStorePaths();
  } catch (err) {
    const reason = failureText(err);
    return {
      gameStore: { path: null, readable: false, error: reason },
      sde: { path: null, readable: false, error: reason },
    };
  }

  const resolved = paths && typeof paths === "object" ? paths : {};

  // Exactly two stats, one per directory. See rule 2 in the header.
  return {
    gameStore: describeDir(resolved.gameStoreRoot),
    sde: describeDir(resolved.sdeRoot),
  };
}

/**
 * Is the game runtime reachable, and if not, why not?
 *
 * `lib/runtimeAccess.js` promises `isRuntimeReachable()` never throws, and this
 * still wraps it: the endpoint has to answer while the module is half-written,
 * wired to a stub, or missing because the loader installed nothing.
 */
function inspectRuntimeReachable(runtime) {
  try {
    const result = runtime.isRuntimeReachable();
    if (result && typeof result === "object") {
      return {
        reachable: result.reachable === true,
        reason: typeof result.reason === "string" ? result.reason : null,
      };
    }
    return { reachable: false, reason: "runtime reported no reachability" };
  } catch (err) {
    return { reachable: false, reason: failureText(err) };
  }
}

/**
 * The health report body. Never throws.
 *
 * @param {object} [deps]
 * @param {object} [deps.config]     frozen config from `config.js`; `modVersion` is read
 * @param {object} [deps.runtime]    `lib/runtimeAccess.js`, or a double
 * @param {string} [deps.modDir]     mod root, for the source hash
 * @param {number} [deps.startedAt]  epoch ms the listener came up
 * @param {Function} [deps.now]      injected clock, `() => epoch ms`
 * @param {string} [deps.sourceHash] precomputed short hash, if the caller has one
 * @returns {{
 *   status: string,
 *   modVersion: string,
 *   sourceHash: string,
 *   startedAt: string,
 *   uptimeSeconds: number,
 *   gameStore: { path: string|null, readable: boolean, error: string|null },
 *   sde: { path: string|null, readable: boolean, error: string|null },
 *   runtimeReachable: { reachable: boolean, reason: string|null },
 * }}
 */
function buildHealthReport(deps) {
  // `deps` itself is optional: a caller that passes nothing is the shape of "the
  // loader failed before it could wire anything up", and needs an answer most.
  const d = deps && typeof deps === "object" ? deps : {};

  const now = resolveNow(d);
  const startedAt =
    typeof d.startedAt === "number" && Number.isFinite(d.startedAt) ? d.startedAt : now;

  const config = d.config && typeof d.config === "object" ? d.config : {};
  const runtime = d.runtime && typeof d.runtime === "object" ? d.runtime : {};

  const modDir = typeof d.modDir === "string" && d.modDir !== "" ? d.modDir : DEFAULT_MOD_DIR;
  const sourceHash =
    typeof d.sourceHash === "string" && d.sourceHash !== ""
      ? d.sourceHash
      : memoizedShortSourceHash(modDir);

  const store =
    typeof runtime.getStorePaths === "function"
      ? inspectStorePaths(runtime)
      : {
          gameStore: { path: null, readable: false, error: "runtime unavailable" },
          sde: { path: null, readable: false, error: "runtime unavailable" },
        };

  const runtimeReachable =
    typeof runtime.isRuntimeReachable === "function"
      ? inspectRuntimeReachable(runtime)
      : { reachable: false, reason: "runtime unavailable" };

  return {
    // Always "ok" when this code ran (rule 3).
    status: "ok",
    modVersion: typeof config.modVersion === "string" ? config.modVersion : "unknown",
    sourceHash,
    // ISO 8601 rather than epoch ms, because the audience is a person reading a
    // console. `uptimeSeconds` beside it is the machine-comparable form, clamped at
    // zero: a `now` behind `startedAt` means the clock moved.
    startedAt: new Date(startedAt).toISOString(),
    uptimeSeconds: Math.max(0, Math.round((now - startedAt) / 1000)),
    gameStore: store.gameStore,
    sde: store.sde,
    // An object, not a bare boolean, so the reason survives: "the game has not
    // booted yet" and "the module path moved in the last vendor drop" are the
    // answers an operator wants. Read `.reachable`; the object is always truthy.
    runtimeReachable,
  };
}

/**
 * A `dispatch`-compatible handler for `server.js`.
 *
 * `server.js`'s contract is `dispatch(request) -> { status, headers?, body? }`
 * with an unknown path resolving to `{ status: 404 }`, so this returns 404 for
 * anything that is not its own path. That makes it composable: the ESI router
 * can try this first and fall through, without this file knowing the router
 * exists.
 *
 * @param {object} deps  as `buildHealthReport`, bound once at wiring time
 * @returns {(request: object) => { status: number, headers?: object, body?: object }}
 */
function createHealthDispatch(deps) {
  return function healthDispatch(request) {
    const req = request && typeof request === "object" ? request : {};

    if (req.pathname !== HEALTH_PATH) return { status: 404 };

    // GET only: an endpoint that accepted POST would invite scanners to probe for
    // side effects, and there are none. 405 rather than 404 because the path does
    // exist, and `/_mod/health` already admits this is the mod.
    if (req.method !== "GET") return { status: 405, body: { error: "Method not allowed" } };

    return {
      status: 200,
      headers: {
        // Never cached, at any layer. `uptimeSeconds` changes every second and the
        // endpoint reports the state now; a cached response is a wrong answer.
        "cache-control": "no-store",
      },
      body: buildHealthReport(deps),
    };
  };
}

module.exports = Object.freeze({
  HEALTH_PATH,
  buildHealthReport,
  createHealthDispatch,
});
