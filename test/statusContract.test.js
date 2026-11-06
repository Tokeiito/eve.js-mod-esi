/**
 * `GET /status/`: the contract, written before the handler.
 *
 * Run with: node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * This is the worked example the contract harness exists to make possible. It
 * was written while `routes/status.js` did not exist, as the specification the
 * handler implements against: everything above the handler section is derived
 * from CCP's pinned `2020-01-01` spec, from observed wire behaviour, and from a
 * body CCP served, and none of it from anything we wrote. The handler had to
 * satisfy it unchanged.
 *
 * How the two sources divide (D22): the spec is authoritative for the body
 * (four fields, all required, `players` an integer and not a string) and for
 * the numbers a client polls on (30 s cache age, rate-limit group `status` at
 * 600 tokens per 15 minutes).
 *
 * The wire is authoritative for everything else, and disagrees with the spec
 * where they overlap. The spec calls the header `ETag`; CCP sends `Etag`. The
 * spec says nothing about `HEAD`, which is a 405. The spec describes a
 * `content-type` of `application/json` with no charset parameter only because
 * that is what was observed; OpenAPI cannot state it.
 *
 * The suite is green with no handler because the acceptance criterion was that
 * a contract test can be written for an endpoint that does not exist and fail
 * for the right reason. A permanently red suite is one people learn to ignore.
 * So the rejection half is proved against the bodies a plausible first
 * implementation would return (eve.js has no `server_version`, so the naive
 * handler omits it; `players` comes out of a registry as whatever type the
 * registry holds).
 *
 * The handler is now called the way it is really called, through a one-route
 * table. The assertions are the ones written first; only the way the handler is
 * reached changed.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { SpecContractError, assertBody, describeOperation } = require(
  path.join(__dirname, "../contract/spec"),
);
const wire = require(path.join(__dirname, "../contract/wire"));
const golden = require(path.join(__dirname, "../contract/golden"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));

const STATUS_ROUTE = path.join(__dirname, "..", "routes", "status.js");

// The wire path, not the spec path. `/v1/status/` is the same operation.
const WIRE_PATH = "/latest/status/";

// What the spec says

test("the body is four required fields, and players is an integer", () => {
  const contract = describeOperation("get", WIRE_PATH);

  assert.deepEqual(contract.requiredKeys.sort(), ["players", "server_version", "start_time", "vip"]);
  assert.deepEqual(contract.optionalKeys, []);
  assert.equal(contract.schema.properties.players.type, "integer");
  assert.equal(contract.schema.properties.server_version.type, "string", "a string, though it holds digits");
  assert.equal(contract.schema.properties.vip.type, "boolean");
  assert.equal(contract.schema.properties.start_time.format, "date-time");
});

test("the numbers clients poll on", () => {
  const contract = describeOperation("get", WIRE_PATH);

  // 30 s is what goes in `Cache-Control: max-age` and what `Expires` is
  // computed from. Get it wrong and eve-nexum's toolbar either polls in a tight
  // loop against the game's own event loop, or shows a stale player count.
  assert.equal(contract.cacheAgeSeconds, 30);
  assert.deepEqual(contract.rateLimit, { group: "status", maxTokens: 600, windowSize: "15m" });
  assert.deepEqual(contract.statuses, [200], "the spec declares no error status for this operation");
});

test("the version prefix does not change the operation", () => {
  // eve-nexum calls `/latest/`; other consumers call `/v1/`. Same contract.
  for (const prefix of ["/latest", "/v1", "/v2"]) {
    assert.equal(describeOperation("get", `${prefix}/status/`).operationId, "GetStatus");
  }
});

// What the wire says

test("a 200 from this endpoint carries no charset and no nosniff", () => {
  // Both observed, both against the grain of what a careful implementer writes
  // by default. `application/json; charset=utf-8` and a blanket nosniff are the
  // hygienic choices; CCP makes neither on a 2XX, and design constraint 3 is that
  // fidelity wins.
  assert.equal(wire.CONTENT_TYPE[wire.KIND.GATEWAY_SUCCESS], "application/json");
  assert.equal(wire.SENDS_NOSNIFF[wire.KIND.GATEWAY_SUCCESS], false);
});

test("this endpoint is answered by the gateway, so its body ends with a newline", () => {
  // The half of the producer split no header shows, and the reason `/status/` is
  // 93 bytes for 92 bytes of JSON. The handler declares `producer: "gateway"` in
  // the route table; getting that wrong is a content-length one short on every
  // response this endpoint sends.
  assert.equal(wire.SUCCESS_KIND["/status"], wire.KIND.GATEWAY_SUCCESS);
  assert.equal(wire.TRAILING_NEWLINE[wire.KIND.GATEWAY_SUCCESS], true);

  const recorded = golden.loadGolden("GetStatus");
  assert.equal(recorded.entry.producer, "gateway");
  assert.equal(recorded.bytes.length, 93);
  assert.equal(recorded.bytes.subarray(-1).toString("utf8"), "\n");
});

test("HEAD is a 405, so the framework must not answer it from the GET handler", () => {
  // Node's http server responds to HEAD out of the GET route by default, which
  // is the helpful behaviour and the wrong one.
  assert.equal(wire.HEAD_STATUS, 405);
});

// What a naive handler returns, and why it fails

const CONTRACT = () => describeOperation("get", WIRE_PATH);

test("D12's open question is a contract failure until it is answered", () => {
  // `server_version` has no eve.js analogue (D12, still open). A handler that
  // ships without deciding omits the field, and this test stops that being a
  // silent divergence.
  assert.throws(
    () => assertBody({ players: 12, vip: false, start_time: "2026-08-21T11:03:14Z" }, CONTRACT()),
    (err) => err instanceof SpecContractError && /body\.server_version is required/.test(err.message),
  );
});

test("a player count that arrives as a string is rejected", () => {
  assert.throws(
    () => assertBody(
      { server_version: "1", players: "12", vip: false, start_time: "2026-08-21T11:03:14Z" },
      CONTRACT(),
    ),
    (err) => /body\.players: expected integer, got string/.test(err.message),
  );
});

test("a Date that went through JSON.stringify is rejected", () => {
  // `new Date().toISOString()` is `...T11:03:14.000Z`. It is the obvious way to
  // produce `start_time`, it looks right, and no ESI response has ever carried
  // fractional seconds.
  assert.throws(
    () => assertBody(
      { server_version: "1", players: 12, vip: false, start_time: new Date("2026-08-21T11:03:14Z").toISOString() },
      CONTRACT(),
    ),
    (err) => /is not an ESI timestamp/.test(err.message),
  );
});

test("helpfully adding a field is rejected", () => {
  // eve.js knows things CCP does not, and the temptation to pass them along is
  // real. A field CCP does not send is as visible to a client as one it does,
  // and is the field some tool will start depending on.
  assert.throws(
    () => assertBody(
      {
        server_version: "1",
        players: 12,
        vip: false,
        start_time: "2026-08-21T11:03:14Z",
        server_name: "myserver",
      },
      CONTRACT(),
    ),
    (err) => /body\.server_name is not in the spec/.test(err.message),
  );
});

// The handler
//
// Called through the router, as `loader.js` calls it, which is the only way to
// cover all nine version prefixes. A standalone `createStatusDispatch(deps)`
// mirroring `routes/health.js` would be the wrong shape; see the note at the
// bottom of `routes/status.js` for why a routed endpoint does not get a second
// standalone entry point.

/** The endpoint as it actually runs: a one-route table and the real router. */
function statusRouter(deps) {
  const { createStatusRoute } = require(STATUS_ROUTE);
  return createRouter([createStatusRoute(deps)]);
}

/** A `lib/runtimeAccess.js` double. The contract is a property of the response
 *  shape, not of a running game, so nothing here boots one. */
function runtimeDouble({ players = 0, build = null, reachable = true } = {}) {
  return {
    countPlayers: () => players,
    getSdeBuild: () => build,
    isRuntimeReachable: () => ({ reachable, reason: reachable ? null : "double says no" }),
  };
}

test("routes/status.js satisfies the contract", async () => {
  const router = statusRouter({
    runtime: runtimeDouble({ players: 10, build: "3396210" }),
    startedAt: Date.parse("2026-08-21T11:03:14Z"),
  });

  const result = await dispatchRequest(router, { method: "GET", pathname: WIRE_PATH, query: {} });

  assert.equal(result.status, describeOperation("get", WIRE_PATH).successStatus);
  assertBody(result.body, describeOperation("get", WIRE_PATH));
});

test("routes/status.js reproduces the recorded body byte for byte", async () => {
  // One golden diff per implemented endpoint, for the endpoint that landed
  // first. Separate from the spec check above because the two fail for different
  // reasons: the spec says the body is allowed, the golden says it is the bytes
  // CCP sent. Field order and the trailing newline live only in the second.
  const recorded = golden.loadGolden("GetStatus");

  const router = statusRouter({
    runtime: runtimeDouble({
      players: recorded.value.players,
      build: recorded.value.server_version,
    }),
    startedAt: Date.parse(recorded.value.start_time),
  });

  const result = await dispatchRequest(router, { method: "GET", pathname: WIRE_PATH, query: {} });

  golden.assertGolden("GetStatus", result.body);
});

test("the route declares the producer, TTL and group the observations say it has", async () => {
  const router = statusRouter({ runtime: runtimeDouble(), startedAt: 0 });
  const route = router.resolve("GET", WIRE_PATH).route;

  assert.equal(route.producer, "gateway", "observed: bare application/json, body ends with a newline");
  assert.equal(route.cacheTtl, describeOperation("get", WIRE_PATH).cacheAgeSeconds);
  assert.equal(route.rateLimitGroup, "status");

  // It reaches the handler through every prefix, not just the bare path, which
  // is why this endpoint has no standalone dispatch.
  for (const prefix of wire.VERSION_PREFIXES) {
    const result = await dispatchRequest(router, { method: "GET", pathname: `/${prefix}/status/`, query: {} });
    assert.equal(result.status, 200, `/${prefix}/status/ did not reach the handler`);
    assert.equal(result.producer, "gateway");
  }
});

test("a status body is still produced when the game is not up", async () => {
  // The listener answers for the two minutes eve.js takes to boot, and during
  // them the true number of connected clients is zero. A 500 here would show
  // eve-nexum an "ESI offline" pill for a replica that is working.
  const router = statusRouter({
    runtime: runtimeDouble({ players: 99, build: "3396210", reachable: false }),
    startedAt: Date.parse("2026-08-21T11:03:14Z"),
  });

  const result = await dispatchRequest(router, { method: "GET", pathname: WIRE_PATH, query: {} });

  assert.equal(result.status, 200);
  assert.equal(result.body.players, 0, "not the 99 the registry would have claimed");
  assertBody(result.body, describeOperation("get", WIRE_PATH));
});

test("upstream drift in the session registry is a 500, not a quiet zero", async () => {
  // "Nobody is connected" and "sessionRegistry no longer exports getSessions"
  // must not be the same answer, or the replica reports zero players forever
  // with nothing saying why.
  const logged = [];
  const router = statusRouter({
    runtime: {
      isRuntimeReachable: () => ({ reachable: true, reason: null }),
      getSdeBuild: () => "3396210",
      countPlayers: () => { throw new Error("game module `sessionRegistry` changed shape"); },
    },
    startedAt: 0,
  });

  const result = await dispatchRequest(
    router,
    { method: "GET", pathname: WIRE_PATH, query: {} },
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, 500);
  assert.equal(logged.length, 1, "the reason goes to the game server log");
  assert.match(logged[0][1], /sessionRegistry/);
  assert.doesNotMatch(JSON.stringify(result.body), /sessionRegistry/, "and not to the client");
});

test("server_version falls back to a well-formed build nobody has", async () => {
  // The field is required and must be a string, so an unreadable dump has no
  // option of omission. "0" is older than every real build, the safe direction
  // for "we do not know".
  const { UNKNOWN_BUILD } = require(STATUS_ROUTE);
  const router = statusRouter({
    runtime: runtimeDouble({ build: null }),
    startedAt: Date.parse("2026-08-21T11:03:14Z"),
  });

  const result = await dispatchRequest(router, { method: "GET", pathname: WIRE_PATH, query: {} });

  assert.equal(result.body.server_version, UNKNOWN_BUILD);
  assert.equal(UNKNOWN_BUILD, "0");
  assertBody(result.body, describeOperation("get", WIRE_PATH), "still a valid body");
});

test("start_time carries seconds, not milliseconds", async () => {
  // toISOString() gives `.000Z`, which is three bytes of content-length CCP does
  // not send and a string a strict client may reject.
  const router = statusRouter({
    runtime: runtimeDouble({ build: "3396210" }),
    startedAt: Date.parse("2026-08-21T11:03:14.567Z"),
  });

  const result = await dispatchRequest(router, { method: "GET", pathname: WIRE_PATH, query: {} });

  assert.equal(result.body.start_time, "2026-08-21T11:03:14Z");
});
