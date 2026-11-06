/**
 * `lib/cors.js`: can a browser on a foreign origin read `X-Pages`?
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * The question is not rhetorical: vanilla eve-nexum's front-end calls this API
 * directly from the browser, and without `Access-Control-Expose-Headers` a page
 * can read neither `X-Pages` nor `Etag` no matter what we send. eve-nexum's
 * HTTP client then sees error-limit headers it cannot read as missing and
 * globally self-throttles. So the list is protocol, and its exact contents are
 * asserted against `contract/wire.js` rather than against what our own code
 * produces.
 *
 * The preflight is a separate response path. It does not route. `OPTIONS /nope/`
 * and `OPTIONS /ping` answer `204` exactly as `OPTIONS /status/` does, so an
 * implementation that answered preflights from the router would 404 the first
 * two. That is why this is a wrapper around `dispatch` and not a route.
 *
 * The trigger is `Access-Control-Request-Method`, not `Origin`, checked in both
 * directions.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const {
  EXEMPT_PATHS,
  EXPOSE_HEADERS,
  corsHeaders,
  createCorsDispatch,
  isPreflight,
} = require(path.join(__dirname, "../lib/cors"));

/** A dispatch that records what reached it, so "never routed" is testable. */
function spy(result = { status: 200, body: { ok: true } }) {
  const calls = [];
  const dispatch = (request) => {
    calls.push(request);
    return result;
  };
  dispatch.calls = calls;
  return dispatch;
}

const request = (overrides = {}) => ({
  method: "GET",
  pathname: "/latest/status/",
  query: {},
  headers: {},
  ...overrides,
});

const preflightRequest = (headers = {}) => request({
  method: "OPTIONS",
  headers: { "access-control-request-method": "GET", ...headers },
});

// The expose list

test("the expose list is CCP's ten names, in CCP's order and casing", () => {
  // lib/ cannot import contract/ (D20), so the string is duplicated and this
  // test checks that the copies agree, down to the separator, since this goes on
  // the wire as one string.
  assert.equal(EXPOSE_HEADERS, wire.EXPOSE_HEADERS);
  assert.equal(EXPOSE_HEADERS.split(", ").length, 10);
  assert.ok(EXPOSE_HEADERS.startsWith("Etag, "), "Etag, not ETag, matching the header CCP sends");
  assert.ok(EXPOSE_HEADERS.includes("X-Pages"), "the one eve-nexum's pagination depends on");
});

test("a normal response carries allow-origin and the expose list", async () => {
  const dispatch = createCorsDispatch(spy());

  const result = await dispatch(request());

  assert.equal(result.headers["access-control-allow-origin"], "*");
  assert.equal(result.headers["access-control-expose-headers"], wire.EXPOSE_HEADERS);
});

test("the headers are unconditional: there is no per-origin logic", async () => {
  // `Allow-Origin: *` is sent whether or not the request carried an Origin, so
  // there is nothing to vary on and no origin list to maintain.
  const dispatch = createCorsDispatch(spy());

  const withOrigin = await dispatch(request({ headers: { origin: "https://example.com" } }));
  const without = await dispatch(request());

  assert.deepEqual(corsHeaders(), {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": wire.EXPOSE_HEADERS,
  });
  assert.equal(withOrigin.headers["access-control-allow-origin"], without.headers["access-control-allow-origin"]);
});

test("allow-credentials is never sent, on any response", async () => {
  // It could not be: `Allow-Origin: *` and credentials mode are mutually
  // exclusive, and a browser rejects the pair. Adding it is a plausible
  // "improvement" that would break every browser-based consumer at once.
  const dispatch = createCorsDispatch(spy());

  for (const result of [await dispatch(request()), await dispatch(preflightRequest())]) {
    for (const name of wire.NEVER_SENT) {
      assert.equal(name in result.headers, false, `${name} must never be sent`);
    }
  }
});

test("an error response gets the CORS headers too", async () => {
  // A browser that cannot read a 404 reports a network error instead of the
  // status. Every kind except /ping carries them.
  const dispatch = createCorsDispatch(spy({ status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "404 page not found\n" }));

  const result = await dispatch(request({ pathname: "/nope/" }));

  assert.equal(result.status, 404);
  assert.equal(result.headers["access-control-allow-origin"], "*");
  assert.equal(result.headers["content-type"], "text/plain; charset=utf-8", "the route's own headers survive");
});

test("a route's own header wins over ours, and is not duplicated", async () => {
  const dispatch = createCorsDispatch(spy({
    status: 200,
    headers: { "Access-Control-Allow-Origin": "https://nexum.local" },
    body: {},
  }));

  const result = await dispatch(request());
  const names = Object.keys(result.headers).map((n) => n.toLowerCase());

  assert.equal(names.filter((n) => n === "access-control-allow-origin").length, 1, "not both casings");
  assert.equal(result.headers["Access-Control-Allow-Origin"], "https://nexum.local");
});

// /ping

test("/ping carries no CORS headers at all", async () => {
  // Two bytes, and observably outside every pipeline: no CORS, no cache, no
  // rate-limit headers. The exemption is a fact about ESI, not a shortcut.
  const dispatch = createCorsDispatch(spy({ status: 200, headers: { "content-type": "text/plain" }, body: "ok" }));

  const result = await dispatch(request({ pathname: "/ping" }));

  assert.deepEqual(result.headers, { "content-type": "text/plain" });
  // These two lists overlap on one entry and were once asserted equal, which
  // read as a shared rule and was a coincidence: `/meta/compatibility-dates` is
  // unversioned too and carries CORS like every other routed response. "Outside
  // every pipeline" and "not under a version prefix" are different facts, and
  // only the first takes the CORS headers away.
  assert.deepEqual(EXEMPT_PATHS, ["/ping"]);
  assert.equal(wire.SENDS_CORS[wire.KIND.PING], false, "the observation this rests on");
  assert.equal(wire.SENDS_CORS[wire.KIND.META_SUCCESS], true, "and the one that separates the lists");
});

// The preflight

test("Access-Control-Request-Method is the trigger, not Origin", () => {
  assert.equal(isPreflight(preflightRequest()), true);
  assert.equal(
    isPreflight(request({ method: "OPTIONS", headers: { origin: "https://example.com" } })),
    false,
    "Origin alone is an ordinary OPTIONS: CCP answers it 405",
  );
  assert.equal(isPreflight(request({ method: "OPTIONS" })), false);
  assert.equal(
    isPreflight(request({ headers: { "access-control-request-method": "GET" } })),
    false,
    "and it has to be an OPTIONS",
  );
  assert.equal(wire.PREFLIGHT.trigger, "access-control-request-method", "the observation this rests on");
});

test("a preflight is 204 with five headers of its own and no body", async () => {
  const dispatch = createCorsDispatch(spy());

  const result = await dispatch(preflightRequest({ "access-control-request-headers": "authorization,if-none-match" }));

  assert.equal(result.status, 204);
  assert.equal(result.body, undefined);
  assert.deepEqual(Object.keys(result.headers).sort(), [
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-origin",
    "access-control-max-age",
    "vary",
  ], "no expose-headers, no content-language, no content-length");
});

test("allow-headers echoes what was asked for, verbatim", async () => {
  // A mirror, not a list CCP maintains, including the client's own spacing.
  const dispatch = createCorsDispatch(spy());

  const echoed = await dispatch(preflightRequest({ "access-control-request-headers": "authorization,if-none-match" }));
  assert.equal(echoed.headers["access-control-allow-headers"], "authorization,if-none-match");

  const spaced = await dispatch(preflightRequest({ "access-control-request-headers": "X-Thing, Other" }));
  assert.equal(spaced.headers["access-control-allow-headers"], "X-Thing, Other");
});

test("allow-headers is * when the client asked for nothing", async () => {
  const dispatch = createCorsDispatch(spy());

  const result = await dispatch(preflightRequest());

  assert.equal(result.headers["access-control-allow-headers"], wire.PREFLIGHT.defaultAllowHeaders);
});

test("allow-methods is a fixed four, not derived from the route", async () => {
  // `/status/` accepts only GET and still advertises four. OPTIONS, PATCH and
  // HEAD are all missing, which no correct derivation would produce.
  const dispatch = createCorsDispatch(spy());

  const result = await dispatch(preflightRequest());

  assert.equal(result.headers["access-control-allow-methods"], "GET, POST, PUT, DELETE");
  assert.equal(result.headers["access-control-max-age"], "86400");
});

test("the preflight's Vary is one line, not the usual three", async () => {
  const dispatch = createCorsDispatch(spy());

  const result = await dispatch(preflightRequest());

  assert.equal(result.headers.vary, "Access-Control-Request-Headers");
  assert.deepEqual(wire.VARY.length, 3, "what a normal response carries instead");
});

test("a preflight never reaches the router, so an unrouted path still gets 204", async () => {
  // The one that would be wrong if this were a route: OPTIONS /nope/ and
  // OPTIONS /ping both answer 204 on live ESI.
  const dispatch = createCorsDispatch(spy({ status: 404, body: "404 page not found\n" }));

  for (const pathname of ["/nope/", "/ping", "/v99/status/"]) {
    const result = await dispatch({ ...preflightRequest(), pathname });
    assert.equal(result.status, 204, `${pathname} should preflight`);
  }
});

test("the wrapped dispatch is not called at all for a preflight", async () => {
  const inner = spy();
  const dispatch = createCorsDispatch(inner);

  await dispatch(preflightRequest());
  assert.deepEqual(inner.calls, [], "no routing, no handler, no game state touched");

  await dispatch(request());
  assert.equal(inner.calls.length, 1);
});

// Behind the real listener

test("a browser could read X-Pages off a real response", async (t) => {
  const { startServer, closeServer } = require(path.join(__dirname, "../server"));

  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: createCorsDispatch(() => ({ status: 200, headers: { "X-Pages": "3" }, body: [] })),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));

  const response = await fetch(`http://127.0.0.1:${handle.port}/latest/universe/system_kills/`, {
    headers: { origin: "https://nexum.local" },
  });

  // As close to the browser acceptance case as a test without a browser gets:
  // the header is present, and the expose list names it.
  assert.equal(response.headers.get("x-pages"), "3");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.ok(
    response.headers.get("access-control-expose-headers").split(", ").includes("X-Pages"),
    "without this the browser hides the header it just received",
  );
});

test("the preflight on the wire carries no content-length", async (t) => {
  // A 204 must not carry Content-Length, and CCP's does not: its preflight is
  // seven header lines and `Content-Length` is not among them. Node does not
  // strip it, so this assertion catches us sending `content-length: 0`.
  const net = require("node:net");
  const { startServer, closeServer } = require(path.join(__dirname, "../server"));

  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: createCorsDispatch(() => ({ status: 404 })),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));

  const head = await new Promise((resolve, reject) => {
    const socket = net.connect(handle.port, "127.0.0.1");
    let raw = "";
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("end", () => resolve(raw.split("\r\n\r\n")[0]));
    socket.on("error", reject);
    socket.write("OPTIONS /status/ HTTP/1.1\r\nHost: x\r\nAccess-Control-Request-Method: GET\r\nConnection: close\r\n\r\n");
  });

  assert.match(head, /^HTTP\/1\.1 204 /);
  assert.doesNotMatch(head, /content-length/i);
  assert.match(head, /access-control-max-age: 86400/i);
});
