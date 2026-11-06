/**
 * `lib/router.js`: does `method + path` reach the right handler, and do the
 * three ways of not reaching one answer the way CCP answers them?
 *
 * Run with: node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * The assertions come from `contract/wire.js`, which is observation of live
 * ESI. The pinned spec describes bodies and says nothing about which prefixes
 * resolve or what an unrouted path answers, so the router's whole contract is
 * wire behaviour. Where a value is duplicated into `lib/router.js` (the prefix
 * list is, because `contract/` is test-only and never deployed), a test checks
 * that the two agree. Drift is detected rather than prevented, as in D21.
 *
 * The three outcomes are matched, method-not-allowed and not-found.
 * `/v99/status/` and `/nope/` are both 404 and byte-identical, while
 * `POST /status/` is a 405 whose `Allow` header is the only thing telling a
 * client what to do instead.
 *
 * The HEAD behaviour looks like a bug and is reproduced deliberately: CCP
 * advertises `Allow: HEAD` and then answers `HEAD /status/` with a 405 that
 * carries no `Allow` at all (design constraint 3).
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const spec = require(path.join(__dirname, "../contract/spec"));
const { startServer, closeServer } = require(path.join(__dirname, "../server"));
const {
  COMPATIBILITY_DATE,
  RouteRefusal,
  RouteTableError,
  SUBJECT,
  VERSION_PREFIXES,
  createRouter,
  dispatchRequest,
  splitPath,
} = require(path.join(__dirname, "../lib/router"));

// A table small enough to read, covering every dimension the router has: a
// literal, a `:param`, a sibling that must not shadow it, a second method on
// one path, and the one unversioned route.
//
// `producer` is required, so every row carries one, and the values are the
// observed ones from `wire.SUCCESS_KIND`: `/status` and
// `GET /characters/:character_id` are the gateway while
// `POST /characters/affiliation` is the application, and a fixture that
// flattened that would stop the router's tests exercising the distinction.
// `/ping` declares `null`: it sends two bytes of text and no JSON at all.
function table() {
  return [
    { method: "GET", path: "/status", name: "GetStatus", rateLimitGroup: "status", cacheTtl: 30, producer: "gateway" },
    { method: "GET", path: "/universe/systems/:system_id", name: "GetUniverseSystemsSystemId", cacheTtl: null, producer: "app" },
    { method: "POST", path: "/universe/names", name: "PostUniverseNames", cacheTtl: null, producer: "app" },
    { method: "GET", path: "/characters/affiliation", name: "literal-sibling", producer: "app" },
    { method: "POST", path: "/characters/affiliation", name: "PostCharactersAffiliation", producer: "app" },
    { method: "GET", path: "/characters/:character_id", name: "GetCharactersCharacterId", producer: "gateway" },
    { method: "GET", path: "/ping", name: "GetPing", versioned: false, producer: null },
  ].map((route) => ({ ...route, handler: () => ({ name: route.name }) }));
}

const router = () => createRouter(table());

// The version dimension

test("every version prefix resolves to the same route", () => {
  const r = router();

  for (const prefix of wire.VERSION_PREFIXES) {
    const resolution = r.resolve("GET", `/${prefix}/status/`);

    assert.equal(resolution.outcome, "matched", `/${prefix}/status/ did not resolve`);
    assert.equal(resolution.route.name, "GetStatus");
    assert.equal(resolution.prefix, prefix);
    assert.equal(resolution.compatibilityDate, "2020-01-01", "every prefix pins to the legacy surface");
  }
});

test("the prefix list is nine, and matches what was observed", () => {
  // Nine prefixes: three names and six numbers.
  assert.equal(VERSION_PREFIXES.length, 9);
  assert.deepEqual([...VERSION_PREFIXES].sort(), [...wire.VERSION_PREFIXES].sort());
  assert.deepEqual(
    [...VERSION_PREFIXES].sort(),
    [...spec.VERSION_PREFIXES].sort(),
    "lib/router.js and contract/spec.js each keep their own copy: contract/ is not deployed. "
      + "They must agree.",
  );
});

test("a prefix outside the range is not a prefix, it is a 404", () => {
  const r = router();

  // `/v6/` resolves and `/v7/` does not: the numbered range is closed, and an
  // unknown prefix falls through to the same answer as a path nobody routed.
  assert.equal(r.resolve("GET", "/v6/status/").outcome, "matched");
  assert.equal(r.resolve("GET", "/v7/status/").outcome, "not-found");
  assert.equal(r.resolve("GET", "/v99/status/").outcome, "not-found");
});

test("a prefix is optional, and so is the trailing slash", () => {
  const r = router();

  for (const pathname of ["/status", "/status/", "/latest/status", "/latest/status/"]) {
    const resolution = r.resolve("GET", pathname);
    assert.equal(resolution.outcome, "matched", `${pathname} did not resolve`);
    assert.equal(resolution.route.name, "GetStatus");
  }

  assert.equal(r.resolve("GET", "/status").prefix, null, "bare means no prefix, not a default one");
});

test("an unversioned route is unreachable through a prefix", () => {
  const r = router();

  // `/ping` answers; `/latest/ping` is a 404.
  assert.equal(r.resolve("GET", "/ping").outcome, "matched");
  assert.equal(r.resolve("GET", "/latest/ping").outcome, "not-found");
  assert.ok(wire.UNVERSIONED_PATHS.includes("/ping"), "the observation this rests on");
});

// Matching

test("a :param captures, and is percent-decoded", () => {
  const r = router();

  const resolution = r.resolve("GET", "/latest/universe/systems/30000142/");

  assert.equal(resolution.outcome, "matched");
  assert.deepEqual(resolution.pathParams, { system_id: "30000142" });
  assert.deepEqual(
    r.resolve("GET", "/characters/Jita%20IV/").pathParams,
    { character_id: "Jita IV" },
  );
});

test("a literal segment beats a :param at the same depth", () => {
  const r = router();

  // `/characters/affiliation` and `/characters/{character_id}` are both real
  // ESI routes, both one segment deep, and only one is right. Table order must
  // not decide it: the literal wins wherever it sits.
  assert.equal(r.resolve("GET", "/latest/characters/affiliation/").route.name, "literal-sibling");
  assert.equal(r.resolve("GET", "/latest/characters/90000001/").route.name, "GetCharactersCharacterId");

  const reversed = createRouter(table().reverse());
  assert.equal(reversed.resolve("GET", "/characters/affiliation").route.name, "literal-sibling");
});

test("splitPath collapses empty segments, so a joined URL still routes", () => {
  assert.deepEqual(splitPath("/a//b/"), ["a", "b"]);
  assert.deepEqual(splitPath("/"), []);
  assert.deepEqual(splitPath(undefined), []);
});

test("a malformed percent-escape does not match, and does not throw", () => {
  const r = router();

  assert.equal(r.resolve("GET", "/characters/%E0%A4%A/").outcome, "not-found");
});

// Method not allowed

test("a path that exists with another method is a 405 carrying Allow", () => {
  const r = router();

  const resolution = r.resolve("DELETE", "/latest/characters/affiliation/");

  assert.equal(resolution.outcome, "method-not-allowed");
  assert.deepEqual(resolution.allow, ["GET", "HEAD", "POST"], "sorted by the router; the wire order varies");
});

test("Allow advertises HEAD wherever GET is allowed, exactly as CCP's does", () => {
  const r = router();

  const resolution = r.resolve("POST", "/status/");

  assert.deepEqual([...resolution.allow], [...wire.METHOD_NOT_ALLOWED.allow].sort());
});

test("HEAD is refused even though Allow advertises it, and that 405 carries no Allow", () => {
  const r = router();

  const resolution = r.resolve("HEAD", "/status/");

  assert.equal(resolution.outcome, "method-not-allowed");
  assert.equal(resolution.status, wire.METHOD_NOT_ALLOWED.status);
  assert.equal(
    resolution.allow,
    null,
    "observed: a 405 answering HEAD sends no Allow, while a 405 answering POST does",
  );
  assert.equal(wire.METHOD_NOT_ALLOWED.sendsAllowAnsweringHead, false, "the observation this rests on");
});

test("a method nobody declares on a path nobody has is not-found, not 405", () => {
  const r = router();

  assert.equal(r.resolve("DELETE", "/nope/").outcome, "not-found");
});

// The route table is validated at construction

test("a duplicate method and path throws at construction", () => {
  const routes = table();
  routes.push({ method: "GET", path: "/status", producer: "gateway", handler: () => ({}) });

  assert.throws(() => createRouter(routes), RouteTableError);
});

test("a duplicate that differs only by prefix or slash still collides", () => {
  // `/status`, `/status/` and `/latest/status` are one route. Declaring two of
  // them is the same mistake as declaring the same string twice, and it must
  // fail at construction rather than resolve by table order at request time.
  for (const path_ of ["/status/", "/latest/status"]) {
    const routes = table();
    routes.push({ method: "GET", path: path_, producer: "gateway", handler: () => ({}) });
    assert.throws(() => createRouter(routes), RouteTableError, `${path_} did not collide with /status`);
  }
});

test("a route with no handler, no method or a relative path throws, naming itself", () => {
  assert.throws(() => createRouter([{ method: "GET", path: "/x" }]), /handler/);
  assert.throws(() => createRouter([{ path: "/x", handler: () => ({}) }]), /method/);
  assert.throws(() => createRouter([{ method: "GET", path: "x", handler: () => ({}) }]), /must start with/);
  assert.throws(() => createRouter("not a table"), RouteTableError);
});

test("a route path carrying a version prefix throws", () => {
  // The prefix is a dimension of the router, not part of any route's path.
  // Writing `/latest/status` in the table would work for one prefix and fail
  // for the other eight.
  assert.throws(
    () => createRouter([{ method: "GET", path: "/latest/status", handler: () => ({}) }]),
    /version prefix/,
  );
});

test("a route declaring a scope keeps it, and a public route says so explicitly", () => {
  const r = createRouter([
    // `app` is what the route really is (observed 2026-08-25). `gateway` here was
    // harmless while nothing read the pair and is now a boot error: see the test
    // below.
    { method: "GET", path: "/characters/:character_id/location", scope: "esi-location.read_location.v1", producer: "app", handler: () => ({}) },
    { method: "GET", path: "/status", producer: "gateway", handler: () => ({}) },
  ]);

  assert.equal(r.resolve("GET", "/characters/1/location").route.scope, "esi-location.read_location.v1");
  assert.equal(r.resolve("GET", "/status").route.scope, null, "public is null, not undefined");
});

test("a scope on the gateway producer is refused at boot, because nobody has seen one", () => {
  // Two things downstream refuse to guess at an authenticated gateway route:
  // `lib/errors.js` will not build its 403 and `lib/cache.js` will not pick its
  // `Cache-Control`. Both throw at request time. Catching it here turns a pair
  // of logged 500s on whichever request lands first into one boot failure
  // naming the route.
  assert.throws(
    () => createRouter([{
      method: "GET",
      path: "/characters/:character_id/location",
      scope: "esi-location.read_location.v1",
      producer: "gateway",
      handler: () => ({}),
    }]),
    /no authenticated gateway route has ever been observed/,
  );

  // The public half of the same producer is untouched.
  assert.equal(
    createRouter([{ method: "GET", path: "/status", producer: "gateway", handler: () => ({}) }])
      .routes[0].scope,
    null,
  );
});

test("the error family is derived from the producer, never declared beside it", () => {
  // The same malformed id is a 400 on /universe/systems/ and a 422 on
  // /characters/. That is not a second thing a route knows about itself:
  // fetching a success and a refusal from the same route, six routes over, gave
  // six agreements. A route belongs to one implementation and that
  // implementation answers all of it.
  const r = createRouter([
    { method: "GET", path: "/universe/systems/:system_id", producer: "app", handler: () => ({}) },
    { method: "GET", path: "/characters/:character_id", producer: "gateway", handler: () => ({}) },
    { method: "GET", path: "/ping", versioned: false, producer: null, handler: () => "ok" },
  ]);

  assert.equal(r.resolve("GET", "/universe/systems/1").route.errorFamily, "legacy");
  assert.equal(r.resolve("GET", "/characters/1").route.errorFamily, "validated");
  assert.equal(
    r.resolve("GET", "/ping").route.errorFamily,
    null,
    "a route that sends no JSON sends no JSON errors either",
  );
});

test("a table cannot state a producer and an error family that disagree", () => {
  // The second field is gone rather than merely redundant: two fields can be
  // set to a combination that does not exist on the real surface, and a route
  // table is where somebody would eventually do it. There is no field to set.
  const r = createRouter([
    { method: "GET", path: "/status", producer: "gateway", errorFamily: "legacy", handler: () => ({}) },
  ]);

  assert.equal(
    r.resolve("GET", "/status").route.errorFamily,
    "validated",
    "the producer decides; a stray errorFamily on the descriptor is ignored, not honoured",
  );
});

test("an invented producer throws at construction", () => {
  assert.throws(
    () => createRouter([{ method: "GET", path: "/status", producer: "whatever", handler: () => ({}) }]),
    /producer/,
  );
});

test("a route carries which implementation writes its successes, and must say", () => {
  // This is required where errorFamily is not: an error family is only
  // consulted when something goes wrong, but the success producer decides the
  // content-type and the trailing newline of every 2XX the route sends. No
  // value is right for both halves of ESI's surface, so there is no default.
  const r = createRouter([
    { method: "GET", path: "/status", producer: "gateway", handler: () => ({}) },
    { method: "GET", path: "/universe/regions/:region_id", producer: "app", handler: () => ({}) },
    { method: "GET", path: "/ping", versioned: false, producer: null, handler: () => "ok" },
  ]);

  assert.equal(r.resolve("GET", "/status").route.producer, "gateway");
  assert.equal(r.resolve("GET", "/universe/regions/1").route.producer, "app");
  assert.equal(
    r.resolve("GET", "/ping").route.producer,
    null,
    "null is a declaration (this route sends no JSON), not an omission",
  );

  // The two the table observed agree with the survey.
  assert.equal(wire.SUCCESS_KIND["/status"], wire.KIND.GATEWAY_SUCCESS);
  assert.equal(wire.SUCCESS_KIND["/universe/regions/:region_id"], wire.KIND.APP_SUCCESS);
});

test("a route that does not declare a success producer throws at construction", () => {
  // Not on the one request that reaches it, and not as a body already parsed by
  // a client: at server start, naming the route.
  assert.throws(
    () => createRouter([{ method: "GET", path: "/status", handler: () => ({}) }]),
    (err) => err instanceof RouteTableError && /producer/.test(err.message)
      && /GET \/status/.test(err.message),
  );
  assert.throws(
    () => createRouter([{ method: "GET", path: "/status", producer: "go", handler: () => ({}) }]),
    /producer/,
  );
});

test("the rate-limit group and cache TTL travel with the route", () => {
  // Not used by the router itself. They make Expires and the limiter
  // table-driven rather than per-handler, and let a test check them against the
  // pinned spec.
  const resolution = router().resolve("GET", "/status/");

  assert.equal(resolution.route.rateLimitGroup, "status");
  assert.equal(resolution.route.cacheTtl, 30);
});

// The table against the pinned spec

test("a route table's declared TTL, group and scope are checked against CCP's spec", () => {
  // These three columns are published by CCP, so the table must not drift from
  // them. A route whose declared scope disagrees with the spec is a bug best
  // found here.
  spec.assertRouteMatchesSpec({ method: "GET", path: "/status", rateLimitGroup: "status", cacheTtl: 30 });

  assert.throws(
    () => spec.assertRouteMatchesSpec({ method: "GET", path: "/status", cacheTtl: 300 }),
    /cacheTtl 300, and the spec publishes 30/,
  );
  assert.throws(
    () => spec.assertRouteMatchesSpec({ method: "GET", path: "/status", rateLimitGroup: "universe" }),
    /rateLimitGroup/,
  );
  assert.throws(
    () => spec.assertRouteMatchesSpec({
      method: "GET",
      path: "/characters/:character_id/location",
      scope: null,
    }),
    /scope/,
  );
});

test("a :param path is translated to the spec's {brace} form", () => {
  const contract = spec.assertRouteMatchesSpec({ method: "GET", path: "/universe/systems/:system_id" });

  assert.equal(contract.operationId, "GetUniverseSystemsSystemId", "the route notation reached the spec's");
});

test("not every operation publishes a TTL or a group, and null is the honest answer", () => {
  // `/universe/systems/{system_id}` publishes neither x-cache-age nor a
  // rate-limit group, while `/sovereignty/map` publishes 3600 and `sovereignty`.
  // This is what the cross-check is for: a plausible 3600 invented for the
  // first would look right and be wrong.
  spec.assertRouteMatchesSpec({ method: "GET", path: "/universe/systems/:system_id", cacheTtl: null, rateLimitGroup: null });
  spec.assertRouteMatchesSpec({ method: "GET", path: "/sovereignty/map", cacheTtl: 3600, rateLimitGroup: "sovereignty" });

  assert.throws(
    () => spec.assertRouteMatchesSpec({ method: "GET", path: "/universe/systems/:system_id", cacheTtl: 3600 }),
    /the spec publishes null/,
  );
});

// Dispatch

test("a matched handler is called with params and deps, and never sees req or res", async () => {
  let seen = null;
  const r = createRouter([
    {
      method: "GET",
      path: "/universe/systems/:system_id",
      producer: "app",
      handler: (params, deps) => {
        seen = { params, deps };
        return { system_id: Number(params.path.system_id) };
      },
    },
  ]);

  const result = await dispatchRequest(r, {
    method: "GET",
    pathname: "/latest/universe/systems/30000142/",
    query: { datasource: "tranquility" },
  }, { marker: "deps" });

  // `producer` rides on the result because `server.js` cannot tell from a body
  // which implementation is supposed to have written it. The headers are the
  // ones only a route can carry: the compatibility-date echo, the producer's own
  // Vary (the application repeats Accept-Language, D11) and the two that answer
  // the `Vary` rather than decorate it. The cache status is a MISS because this
  // route holds no snapshot: the handler ran.
  assert.deepEqual(result, {
    status: 200,
    body: { system_id: 30000142 },
    producer: "app",
    cacheTtl: null,
    // Public: `lib/cache.js` reads this to pick `public` over `private`.
    authenticated: false,
    // No static-data dump behind this route, so no shared validator to carry.
    // `null` rather than absent, for the same reason `scope` is.
    snapshot: null,
    headers: {
      "content-language": "en",
      "x-compatibility-date": "2020-01-01",
      "x-esi-cache-status": "MISS",
      // Three lines: this route declares no `localizedBody`, and the fourth is a
      // property of the route's content rather than of its producer.
      vary: ["X-Tenant", "Accept-Language", "X-Compatibility-Date"],
    },
  });
  assert.equal(seen.deps.marker, "deps");
  assert.deepEqual(seen.params.path, { system_id: "30000142" });
  assert.equal(seen.params.prefix, "latest");
  assert.equal(seen.params.compatibilityDate, COMPATIBILITY_DATE);
  assert.equal("errorFamily" in seen.params, true, "a handler needs it to shape its own 404");
  assert.deepEqual(seen.params.query, { datasource: "tranquility" });
  assert.equal("req" in seen.params, false);
  assert.equal("res" in seen.params, false);
});

test("an unknown query parameter is passed through, not rejected", () => {
  // nexumApi's assertKnownQueryKeys is deliberately dropped: real ESI ignores
  // unknown query params, and fidelity wins over the house rule.
  assert.equal(wire.IGNORES_UNKNOWN_QUERY_PARAMS, true);

  const r = router();
  assert.equal(r.resolve("GET", "/status/?nonsense=1").outcome, "matched");
});

test("an unrouted path is Go's plain-text 404, byte for byte", async () => {
  const r = router();

  const result = await dispatchRequest(r, { method: "GET", pathname: "/nope/" });

  assert.equal(result.status, wire.UNROUTED_404.status);
  assert.equal(result.body, wire.UNROUTED_404.body);
  assert.equal(result.headers["content-type"], wire.UNROUTED_404.contentType);
  assert.equal(result.headers["x-content-type-options"], "nosniff", "the unrouted 404 is one that carries it");
  assert.equal(Buffer.byteLength(result.body, "utf8"), 19);
});

test("an unknown version prefix produces that same 404, not a JSON one", async () => {
  const r = router();

  const unrouted = await dispatchRequest(r, { method: "GET", pathname: "/nope/" });
  const badVersion = await dispatchRequest(r, { method: "GET", pathname: "/v99/status/" });

  assert.deepEqual(badVersion, unrouted, "observed: the two are indistinguishable");
});

test("a 405 is bodiless, with no content-type, and Allow on separate lines", async () => {
  const r = router();

  const result = await dispatchRequest(r, { method: "DELETE", pathname: "/latest/status/" });

  assert.equal(result.status, 405);
  assert.equal(result.body, undefined, "the 405 body is empty, not the JSON error shape");
  assert.equal(result.headers["content-type"], undefined);
  assert.ok(Array.isArray(result.headers.allow), "an array is how Node writes repeated header lines");
  assert.deepEqual(result.headers.allow.slice().sort(), ["GET", "HEAD"]);
});

test("a HEAD 405 carries no Allow header at all", async () => {
  const r = router();

  const result = await dispatchRequest(r, { method: "HEAD", pathname: "/status/" });

  assert.equal(result.status, 405);
  assert.equal(result.headers.allow, undefined);
});

test("a handler that throws is a logged 500, and the stack does not reach the client", async () => {
  const logged = [];
  const r = createRouter([
    { method: "GET", path: "/status", name: "GetStatus", producer: "gateway", handler: () => { throw new Error("game store said no"); } },
  ]);

  const result = await dispatchRequest(r, { method: "GET", pathname: "/status/" }, {
    logError: (message, err) => logged.push([message, err.message]),
  });

  assert.equal(result.status, 500);
  assert.doesNotMatch(JSON.stringify(result.body), /game store said no/);
  assert.deepEqual(logged, [['route "GetStatus" threw', "game store said no"]]);
});

test("a handler that rejects is the same, because a promise is not a special case", async () => {
  const r = createRouter([
    { method: "GET", path: "/status", producer: "gateway", handler: async () => { throw new Error("later"); } },
  ]);

  const result = await dispatchRequest(r, { method: "GET", pathname: "/status/" }, { logError: () => {} });

  assert.equal(result.status, 500);
});

test("a handler returning a promise is awaited", async () => {
  const r = createRouter([
    { method: "GET", path: "/status", producer: "gateway", handler: async () => ({ players: 1 }) },
  ]);

  assert.deepEqual(await dispatchRequest(r, { method: "GET", pathname: "/status/" }), {
    status: 200,
    body: { players: 1 },
    producer: "gateway",
    // Carried out to lib/cache.js, which needs it for max-age and Expires.
    cacheTtl: null,
    // Public: `lib/cache.js` reads this to pick `public` over `private`.
    authenticated: false,
    snapshot: null,
    headers: {
      "content-language": "en",
      "x-compatibility-date": "2020-01-01",
      "x-esi-cache-status": "MISS",
      vary: ["X-Tenant", "Accept-Language", "X-Compatibility-Date"],
    },
  });
});

// Behind the real listener

test("the router behind server.js puts the right bytes on a socket", async (t) => {
  // The seam to get right: server.js JSON-encodes an object body, and the two
  // responses the router produces itself are not objects. Encoding the
  // plain-text 404 as JSON would put quotes around it and change its byte count,
  // which is all that endpoint is.
  const r = createRouter([
    { method: "GET", path: "/status", producer: "gateway", handler: () => ({ players: 1 }) },
  ]);

  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: (request) => dispatchRequest(r, request),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));
  const url = `http://127.0.0.1:${handle.port}`;

  const missing = await fetch(`${url}/nope/`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), wire.UNROUTED_404.contentType);
  assert.equal(missing.headers.get("content-length"), "19");
  assert.equal(await missing.text(), wire.UNROUTED_404.body);

  const ok = await fetch(`${url}/v3/status/`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), wire.CONTENT_TYPE[wire.KIND.GATEWAY_SUCCESS]);
  assert.deepEqual(await ok.json(), { players: 1 });

  const refused = await fetch(`${url}/status/`, { method: "DELETE" });
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.get("content-length"), "0");
  assert.equal(refused.headers.get("content-type"), null);
  // fetch reports repeated header lines comma-joined; the wire carries two.
  assert.equal(refused.headers.get("allow"), "GET, HEAD");
});

// The success status
//
// Every route once answered `200`, and the dispatch said so in a literal.
// `POST /ui/autopilot/waypoint/` answers `204` with no body, so the status is a
// route fact. These assertions are about the framework column rather than
// that endpoint: what the value may be, what it does, and what happens when a
// route and its handler disagree about whether there is a body.

test("a route that declares no successStatus answers 200, exactly as it always did", async () => {
  const r = createRouter([
    { method: "GET", path: "/status", producer: "gateway", handler: () => ({ ok: true }) },
  ]);

  const result = await dispatchRequest(r, { method: "GET", pathname: "/status/" });

  assert.equal(result.status, 200, "the default is the status every route had before the column existed");
  assert.deepEqual(result.body, { ok: true });
});

test("a declared 204 dispatches as 204 and carries no body", async () => {
  const r = createRouter([
    {
      method: "POST",
      path: "/ui/autopilot/waypoint",
      producer: "app",
      scope: "esi-ui.write_waypoint.v1",
      successStatus: 204,
      handler: () => undefined,
    },
  ]);

  const result = await dispatchRequest(r, {
    method: "POST",
    pathname: "/latest/ui/autopilot/waypoint/",
    credential: { presented: true, claims: { characterId: 90000001, scopes: ["esi-ui.write_waypoint.v1"] } },
  });

  assert.equal(result.status, 204);
  assert.equal(result.body, null, "null rather than undefined, so `server.js` sees one absent-body shape");
  // The route still declares a producer, because a `204` carries the producer's
  // headers even though it carries none of its JSON.
  assert.equal(result.producer, "app");
});

test("a 204 route whose handler returns a body is a 500, not a silently dropped body", async () => {
  // This refuses a write endpoint that reports its result in a body nobody
  // transmits: `server.js` omits the body for a 204, so the handler author
  // would see a passing 204 and never learn the payload went nowhere.
  const logged = [];
  const r = createRouter([
    {
      method: "POST",
      path: "/ui/autopilot/waypoint",
      producer: "app",
      successStatus: 204,
      handler: () => ({ delivered: false, reason: "offline" }),
    },
  ]);

  const result = await dispatchRequest(
    r,
    { method: "POST", pathname: "/latest/ui/autopilot/waypoint/" },
    { logError: (message, err) => logged.push({ message, err }) },
  );

  assert.equal(result.status, 500);
  assert.equal(logged.length, 1, "the reason reaches the game server's log");
  assert.match(logged[0].err.message, /returned a body/);
});

test("a successStatus this replica has never sent is refused at boot", () => {
  // The set widens by an observation, never by a caller passing a number: a
  // status nobody has seen is one whose headers and cache behaviour nobody has
  // recorded either.
  assert.throws(
    () => createRouter([
      { method: "POST", path: "/thing", producer: "app", successStatus: 201, handler: () => null },
    ]),
    (err) => err instanceof RouteTableError && /successStatus 201/.test(err.message),
  );
});

test("a 204 route that also paginates is refused at boot", () => {
  assert.throws(
    () => createRouter([
      {
        method: "POST",
        path: "/thing",
        producer: "app",
        successStatus: 204,
        pageSize: 100,
        cacheTtl: 300,
        handler: () => [],
      },
    ]),
    (err) => err instanceof RouteTableError && /carries no body, so there is nothing to paginate/.test(err.message),
  );
});

// Who may read this entity
//
// The scope check says the caller may read fleets, not that they may read that
// fleet. `authorise()` compared the token's subject against a path parameter
// literally named `character_id`, and a route keyed by any other id fell
// through with the scope as its only guard.
//
// These assertions are mostly about the construction-time half, which stops
// the hole reopening: a route author who forgets is not trusted to remember,
// and the table refuses to compile.

test("a scoped route keyed by an entity that is not the caller must say who may read it", () => {
  // The shape that would otherwise ship: a scope, an entity id in the path, and
  // no statement about ownership.
  assert.throws(
    () => createRouter([
      {
        method: "GET",
        path: "/fleets/:fleet_id/members",
        producer: "app",
        scope: "esi-fleets.read_fleet.v1",
        handler: () => [],
      },
    ]),
    (err) => err instanceof RouteTableError
      && /keyed by fleet_id/.test(err.message)
      && /never that they may read this one/.test(err.message),
  );
});

test("the refusal names every entity parameter the route is keyed by", () => {
  assert.throws(
    () => createRouter([
      {
        method: "GET",
        path: "/corporations/:corporation_id/structures/:structure_id",
        producer: "app",
        scope: "esi-corporations.read_structures.v1",
        handler: () => [],
      },
    ]),
    /keyed by corporation_id, structure_id/,
  );
});

test("a route keyed only by character_id still compiles, and still makes the old comparison", async () => {
  // The rule is deliberately narrow: it bites for entity kinds that had no
  // check and leaves the character check as it was. That is why the earlier
  // character routes needed no edit.
  const r = createRouter([
    {
      method: "GET",
      path: "/characters/:character_id/online",
      producer: "app",
      scope: "esi-location.read_online.v1",
      handler: () => ({ online: true }),
    },
  ]);

  const mine = await dispatchRequest(r, {
    method: "GET",
    pathname: "/latest/characters/90000001/online/",
    credential: { presented: true, claims: { characterId: 90000001, scopes: ["esi-location.read_online.v1"] } },
  });
  assert.equal(mine.status, 200);

  const theirs = await dispatchRequest(r, {
    method: "GET",
    pathname: "/latest/characters/90000002/online/",
    credential: { presented: true, claims: { characterId: 90000001, scopes: ["esi-location.read_online.v1"] } },
  });
  assert.equal(theirs.status, 403, "a token for one character still cannot read another's");
});

test("a public route keyed by an entity id is never asked, because there is no caller", () => {
  // `/markets/:region_id/orders` and friends: the gate is about who is asking,
  // and a public route has no answer to that and needs none.
  const r = createRouter([
    { method: "GET", path: "/markets/:region_id/orders", producer: "app", handler: () => [] },
  ]);

  assert.equal(r.routes.length, 1);
});

test("SUBJECT.SCOPE_ONLY is a declaration, and it lets the request through", async () => {
  // The constant records that "we considered this entity and the scope really
  // is the whole gate", reviewable, rather than being indistinguishable from
  // nobody having considered it.
  const r = createRouter([
    {
      method: "GET",
      path: "/fleets/:fleet_id/members",
      producer: "app",
      scope: "esi-fleets.read_fleet.v1",
      subject: SUBJECT.SCOPE_ONLY,
      handler: () => [{ character_id: 90000001 }],
    },
  ]);

  const result = await dispatchRequest(r, {
    method: "GET",
    pathname: "/latest/fleets/123/members/",
    credential: { presented: true, claims: { characterId: 90000001, scopes: ["esi-fleets.read_fleet.v1"] } },
  });

  assert.equal(result.status, 200);
});

test("a subject function decides, and its refusal wears the route's headers", async () => {
  const asked = [];
  const r = createRouter([
    {
      method: "GET",
      path: "/fleets/:fleet_id/members",
      producer: "app",
      scope: "esi-fleets.read_fleet.v1",
      subject: (claims, pathParams) => {
        asked.push({ characterId: claims.characterId, fleetId: pathParams.fleet_id });
        return pathParams.fleet_id === "123"
          ? null
          : { status: 403, body: { error: "Forbidden" }, headers: {} };
      },
      handler: () => [{ character_id: 90000001 }],
    },
  ]);

  const credential = {
    presented: true,
    claims: { characterId: 90000001, scopes: ["esi-fleets.read_fleet.v1"] },
  };

  const allowed = await dispatchRequest(r, {
    method: "GET", pathname: "/latest/fleets/123/members/", credential,
  });
  assert.equal(allowed.status, 200);

  const denied = await dispatchRequest(r, {
    method: "GET", pathname: "/latest/fleets/456/members/", credential,
  });
  assert.equal(denied.status, 403);
  // The route's headers, not a bare refusal: a gate refusal was observed
  // carrying the compatibility-date echo and the cache status, as
  // `characterMismatch` does.
  assert.equal(denied.headers["x-compatibility-date"], "2020-01-01");
  assert.equal(denied.headers["x-esi-cache-status"], "MISS");

  assert.deepEqual(asked, [
    { characterId: 90000001, fleetId: "123" },
    { characterId: 90000001, fleetId: "456" },
  ]);
});

test("a subject check that throws refuses the read and logs, rather than answering it", async () => {
  // The honest state while the real refusal is unobserved: the read does not
  // happen, which is the property that matters, and the status is loudly wrong
  // rather than quietly invented. `lib/errors.js` makes the same choice when it
  // refuses to build a 403 for a family nobody has captured.
  const logged = [];
  let handlerRan = false;
  const r = createRouter([
    {
      method: "GET",
      path: "/corporations/:corporation_id/contacts",
      producer: "app",
      scope: "esi-corporations.read_contacts.v1",
      subject: () => {
        throw new Error("the corporation-mismatch refusal has never been observed");
      },
      handler: () => {
        handlerRan = true;
        return [];
      },
    },
  ]);

  const result = await dispatchRequest(
    r,
    {
      method: "GET",
      pathname: "/latest/corporations/98777771/contacts/",
      credential: {
        presented: true,
        claims: { characterId: 90000001, scopes: ["esi-corporations.read_contacts.v1"] },
      },
    },
    { logError: (message, err) => logged.push({ message, err }) },
  );

  assert.equal(result.status, 500);
  assert.equal(handlerRan, false, "the contacts were never read");
  assert.equal(logged.length, 1);
  assert.match(logged[0].message, /could not be authorised/);
});

test("a subject declared beside no scope is refused at boot", () => {
  assert.throws(
    () => createRouter([
      {
        method: "GET",
        path: "/fleets/:fleet_id/members",
        producer: "app",
        subject: SUBJECT.CALLER,
        handler: () => [],
      },
    ]),
    /no caller to compare against on a public route/,
  );
});

test("a subject that is neither constant nor function is refused at boot", () => {
  assert.throws(
    () => createRouter([
      {
        method: "GET",
        path: "/fleets/:fleet_id/members",
        producer: "app",
        scope: "esi-fleets.read_fleet.v1",
        subject: "whatever",
        handler: () => [],
      },
    ]),
    /which is not caller, scope-only, or a function/,
  );
});

// A refusal the handler meant

test("a handler's RouteRefusal is answered as that refusal, and is not logged", async () => {
  // Not every refusal can be made in the gate. "Is this caller in the fleet
  // whose roster they asked for" needs game state the handler has and
  // `authorise()` does not, and it must be asked before the roster is read.
  const logged = [];
  const r = createRouter([
    {
      method: "GET",
      path: "/fleets/:fleet_id/members",
      producer: "app",
      scope: "esi-fleets.read_fleet.v1",
      subject: SUBJECT.SCOPE_ONLY,
      handler: () => {
        throw new RouteRefusal({ status: 404, body: { error: "Not Found" }, headers: {} });
      },
    },
  ]);

  const result = await dispatchRequest(
    r,
    {
      method: "GET",
      pathname: "/latest/fleets/123/members/",
      credential: {
        presented: true,
        claims: { characterId: 90000001, scopes: ["esi-fleets.read_fleet.v1"] },
      },
    },
    { logError: (message, err) => logged.push({ message, err }) },
  );

  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { error: "Not Found" });
  assert.equal(logged.length, 0, "the gate working is not an error, and must not fill the log");
  // A route-produced refusal carries the echo and, on an authenticated route,
  // the cache status too. This assertion once said `undefined`, on the strength
  // of a public `?page=0` observation; later captures found five authenticated
  // refusals that all carried it, including the page-past-the-end 404 that rule
  // was built on. See `routedRefusal`.
  assert.equal(result.headers["x-compatibility-date"], "2020-01-01");
  assert.equal(result.headers["x-esi-cache-status"], "MISS");
});

test("an ordinary throw from a handler is still an opaque, logged 500", async () => {
  const logged = [];
  const r = createRouter([
    {
      method: "GET",
      path: "/status",
      producer: "gateway",
      handler: () => {
        throw new Error("the session registry changed shape");
      },
    },
  ]);

  const result = await dispatchRequest(
    r,
    { method: "GET", pathname: "/status/" },
    { logError: (message, err) => logged.push({ message, err }) },
  );

  assert.equal(result.status, 500);
  assert.equal(logged.length, 1);
  assert.match(logged[0].err.message, /session registry/);
  assert.doesNotMatch(JSON.stringify(result.body), /session registry/, "the stack never reaches the client");
});

test("a route's successStatus is checked against the spec, not just against itself", () => {
  // The column is a route fact, and CCP publishes it per operation, so the same
  // cross-check that stops a TTL or a scope drifting stops this one. A route
  // that omits the column is checked as the 200 `lib/router.js` reads it as,
  // which stops silence from passing on an operation that answers 204.
  spec.assertRouteMatchesSpec({ method: "POST", path: "/ui/autopilot/waypoint", successStatus: 204 });

  assert.throws(
    () => spec.assertRouteMatchesSpec({ method: "POST", path: "/ui/autopilot/waypoint", successStatus: 200 }),
    /declares successStatus 200, and the spec publishes 204/,
  );
  assert.throws(
    () => spec.assertRouteMatchesSpec({ method: "GET", path: "/status", successStatus: 204 }),
    /declares successStatus 204, and the spec publishes 200/,
  );
});

test("an authenticated route's refusal carries X-Esi-Cache-Status; a public one's does not", async () => {
  // Captures of authenticated routes falsified the old blanket rule: five
  // refusals carried the header, including the page-past-the-end 404 the rule
  // was written around. The public observation behind the subtraction has not
  // been re-run, so both halves are reproduced rather than one being
  // generalised over the other. See `routedRefusal`.
  const handler = () => {
    throw new RouteRefusal({ status: 404, body: { error: "Not Found" }, headers: {} });
  };

  const authed = createRouter([
    {
      method: "GET",
      path: "/fleets/:fleet_id/members",
      producer: "app",
      scope: "esi-fleets.read_fleet.v1",
      subject: SUBJECT.SCOPE_ONLY,
      handler,
    },
  ]);
  const authedResult = await dispatchRequest(authed, {
    method: "GET",
    pathname: "/latest/fleets/123/members/",
    credential: { presented: true, claims: { characterId: 90000001, scopes: ["esi-fleets.read_fleet.v1"] } },
  });
  assert.equal(authedResult.headers["x-esi-cache-status"], "MISS");

  const publicRouter = createRouter([
    { method: "GET", path: "/markets/:region_id/orders", producer: "app", handler },
  ]);
  const publicResult = await dispatchRequest(publicRouter, {
    method: "GET",
    pathname: "/latest/markets/10000002/orders/",
  });
  assert.equal(publicResult.headers["x-esi-cache-status"], undefined);
});
