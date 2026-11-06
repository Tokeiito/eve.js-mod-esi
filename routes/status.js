/**
 * `GET /status/`.
 *
 * Four fields, all required:
 *
 *   {"server_version":"3396210","players":3,"vip":false,"start_time":"2026-08-21T11:03:14Z"}
 *
 * `test/statusContract.test.js` derives the contract from CCP's pinned spec and
 * observed wire behaviour, and `contract/golden/GetStatus.json` checks it byte
 * for byte.
 *
 * `server_version` (D12) has no obvious analogue on a private server. Real ESI
 * reports a seven-digit TQ build number, never semver, so eve.js's own version
 * (`0.12.6`) would look malformed to a tool that parses it, and a synthetic
 * constant carries no information. This file reports CCP's static-data build
 * number (`3396210`), read from the name of the directory `CreateDatabase.bat`
 * extracted (`eve-online-static-data-<build>-jsonl`), the only place the number
 * survives; see `lib/runtimeAccess.js` `readSdeBuildFrom`. Replicas built from
 * different dumps report different numbers, as the field does on TQ.
 *
 * `UNKNOWN_BUILD` covers an install whose dump cannot be read. The field is
 * required and a string, so it cannot be omitted. `"0"` is well formed, no real
 * dump carries it, and a client comparing builds sees it as older than
 * everything.
 *
 * `players` is connected clients from the game's session registry, which is what
 * CCP's number counts. Limits, documented on the accessor: a browser pilot holds
 * a control lease rather than a session and is not counted, and a client in
 * character selection is. A game that is not up yet reports `0`: during the
 * ~2 minutes eve.js takes to boot, the listener already answers and the true
 * count is zero. A registry that changed shape throws, the router logs a 500,
 * and the vendor-drift test catches it a release earlier.
 *
 * `runtime` is `lib/runtimeAccess.js` or a double, injected as in
 * `routes/health.js`. Nothing here requires it, so the endpoint is testable
 * with no eve.js checkout.
 */

"use strict";

const { OMIT, projection } = require("../lib/serialize");

const STATUS_PATH = "/status";

const CACHE_TTL_SECONDS = 30;

/** The spec's `x-ratelimit-group`. */
const RATE_LIMIT_GROUP = "status";

/**
 * Which of ESI's two implementations answers this route.
 *
 * Observed: `GET /latest/status/` is bare `application/json` and its body ends
 * with a newline (93 bytes for 92 bytes of JSON). The error shape,
 * `Cache-Control` form, `Expires` basis and conditional-request handling all
 * follow from the producer.
 */
const PRODUCER = "gateway";

/** No dump, no build. Required, string, and deliberately low. */
const UNKNOWN_BUILD = "0";

const VIP = false;

/**
 * CCP sends second precision (`2026-08-21T11:03:14Z`, not `...:14.000Z`).
 *
 * `toISOString()` adds three characters of milliseconds, which change
 * `content-length` and may fail a strict `date-time` check.
 */
function toEsiTimestamp(date) {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * The projection, in CCP's field order. Declaration order is output order: the
 * recorded body opens with `server_version`.
 */
const projectStatus = projection("GetStatus", {
  server_version: (record) => record.serverVersion,
  players: (record) => record.players,
  vip: (record) => record.vip,
  // Never absent: the listener cannot answer before it started. `OMIT` makes a
  // double that forgets `startedAt` produce a body missing a field, which the spec
  // check catches, rather than a projection throw.
  start_time: (record) => (record.startTime === null ? OMIT : record.startTime),
});

/**
 * How many clients are attached, or `0` when the game is not up.
 *
 * An unreachable runtime is a normal state with a correct answer. A registry
 * that no longer exports `getSessions` is upstream drift and must throw:
 * swallowing it would report zero players forever with no explanation.
 */
function readPlayers(runtime) {
  if (typeof runtime.countPlayers !== "function") return 0;

  if (typeof runtime.isRuntimeReachable === "function") {
    const reachable = runtime.isRuntimeReachable();
    if (!reachable || reachable.reachable !== true) return 0;
  }

  return runtime.countPlayers();
}

function readServerVersion(runtime) {
  if (typeof runtime.getSdeBuild !== "function") return UNKNOWN_BUILD;
  const build = runtime.getSdeBuild();
  return typeof build === "string" && build !== "" ? build : UNKNOWN_BUILD;
}

/**
 * The body, projected and owned.
 *
 * @param {object}   deps
 * @param {object}   [deps.runtime]    `lib/runtimeAccess.js`, or a double
 * @param {number}   [deps.startedAt]  epoch ms the listener came up
 */
function buildStatus(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  const runtime = d.runtime && typeof d.runtime === "object" ? d.runtime : {};

  return projectStatus({
    serverVersion: readServerVersion(runtime),
    players: readPlayers(runtime),
    vip: VIP,
    startTime: typeof d.startedAt === "number" ? toEsiTimestamp(new Date(d.startedAt)) : null,
  });
}

/**
 * The route descriptor, for the table `loader.js` builds.
 *
 * One `producer` and no separate error family: the error shape is derived from
 * the producer (`lib/errors.js` `familyFor`).
 */
function createStatusRoute(deps) {
  return {
    method: "GET",
    path: STATUS_PATH,
    name: "GetStatus",
    handler: () => buildStatus(deps),
    producer: PRODUCER,
    errorFamily: null,
    cacheTtl: CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
  };
}

// There is no `createStatusDispatch`, unlike `routes/health.js`.
//
// A standalone dispatch would have to answer `/status/`, `/latest/status/`,
// `/legacy/status`, `/v1/status/` and six more. The version prefix is a
// dimension of `lib/router.js`, so a second dispatch would reimplement prefix
// stripping or answer only the bare path.
//
// `/_mod/health` keeps its own dispatch because it is not an ESI path, takes no
// prefix, and must answer while the router is producing 404s. This endpoint is
// routed, so the route descriptor is all it needs, in `loader.js` and in tests.

module.exports = Object.freeze({
  CACHE_TTL_SECONDS,
  RATE_LIMIT_GROUP,
  STATUS_PATH,
  PRODUCER,
  UNKNOWN_BUILD,
  VIP,
  buildStatus,
  createStatusRoute,
  projectStatus,
  toEsiTimestamp,
});
