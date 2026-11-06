/**
 * `GET /ping`: two bytes, and the absence of everything else.
 *
 * Run with: node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Almost every assertion here is about something not being sent, which is the
 * correct shape for this endpoint. `/ping` is a liveness probe: tools call it
 * to decide whether ESI is up, and what makes it usable for that is that it is
 * cheap and completely undecorated. A replica that answered it through the
 * normal pipeline would be right about the body and wrong about everything
 * around it.
 *
 * The claims come from `contract/wire.js` (observation of live ESI), not from
 * this repository's opinion of what a ping should look like.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const { startServer, closeServer } = require(path.join(__dirname, "../server"));
const { createCorsDispatch } = require(path.join(__dirname, "../lib/cors"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const {
  PING_BODY,
  PING_CONTENT_TYPE,
  PING_PATH,
  createPingDispatch,
} = require(path.join(__dirname, "../routes/ping"));

/** The composition `loader.js` builds: ping in front, then CORS, then the router. */
function compose(routes = []) {
  const router = createRouter(routes);
  return createPingDispatch(
    createCorsDispatch((request) => dispatchRequest(router, request, { logError: () => {} })),
  );
}

/** That composition behind the real listener. */
async function serve(t, routes = []) {
  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: compose(routes),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));
  return `http://127.0.0.1:${handle.port}`;
}

// The two bytes

test("the body is exactly `ok`, and the observation says so", () => {
  assert.equal(PING_BODY, "ok");
  assert.equal(PING_BODY, wire.PING.body, "lib/ and contract/ keep separate copies (D20); they must agree");
  assert.equal(PING_CONTENT_TYPE, wire.PING.contentType);
  assert.equal(wire.PING.status, 200);
});

test("two bytes on the wire, and no trailing newline", async (t) => {
  // The one endpoint whose entire content is its byte count. `text/plain` is
  // written verbatim by server.js (JSON-encoding it would add quotes and make it
  // four), and it is not one of the bodies Go's encoder writes, so there is no
  // newline.
  const url = await serve(t);

  const response = await fetch(`${url}/ping`);
  const body = Buffer.from(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(body.length, 2);
  assert.equal(body.toString("utf8"), "ok");
  assert.equal(response.headers.get("content-length"), "2");
  assert.equal(response.headers.get("content-type"), "text/plain");
});

// The absence of everything else

test("no CORS headers, because CCP sends none on this path", async (t) => {
  // Not stripped afterwards, never added. `loader.js` composes ping ahead of the
  // CORS layer, so nothing downstream sees the request at all.
  const url = await serve(t);

  const response = await fetch(`${url}/ping`, { headers: { Origin: "https://example.com" } });

  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-expose-headers"), null);
  assert.equal(wire.SENDS_CORS[wire.KIND.PING], false, "the observation this rests on");
  assert.equal(wire.SENDS_CORS[wire.KIND.GATEWAY_SUCCESS], true, "and it really is the exception");
});

test("none of the ESI response furniture either", async (t) => {
  const url = await serve(t);

  const response = await fetch(`${url}/ping`);

  for (const name of [
    "x-compatibility-date",
    "cache-control",
    "etag",
    "expires",
    "vary",
    "x-content-type-options",
    "x-esi-error-limit-remain",
    "x-ratelimit-limit",
  ]) {
    assert.equal(response.headers.get(name), null, `/ping sent ${name}, and CCP's does not`);
  }
});

// It is not versioned

test("a prefixed /latest/ping is the unrouted 404, not a ping", async (t) => {
  // Falls straight through: this dispatch matches the bare path only and the
  // router has no /ping route, so the answer is Go's plain-text 404, the same one
  // any unrouted path gets, which is what CCP gives it.
  const url = await serve(t);

  const response = await fetch(`${url}/latest/ping`);
  const body = await response.text();

  assert.equal(response.status, 404);
  assert.equal(body, wire.UNROUTED_404.body);
  assert.equal(response.headers.get("content-type"), wire.UNROUTED_404.contentType);
  assert.ok(wire.UNVERSIONED_PATHS.includes("/ping"), "the observation this rests on");
});

test("a POST to /ping is handed on rather than answered 405", async () => {
  // /ping is not a route in the table either, so a non-GET gets the unrouted
  // 404. Answering 405 would invent a shape for a path CCP does not route.
  let reached = null;
  const dispatch = createPingDispatch((request) => {
    reached = request;
    return { status: 404 };
  });

  const result = await dispatch({ method: "POST", pathname: PING_PATH });

  assert.equal(result.status, 404);
  assert.equal(reached.method, "POST", "the fall-through saw the request");
});

test("anything that is not /ping is handed straight on", async () => {
  const seen = [];
  const dispatch = createPingDispatch((request) => {
    seen.push(request.pathname);
    return { status: 200, body: {}, producer: "app" };
  });

  for (const pathname of ["/status/", "/ping/", "/pingx", "/_mod/health"]) {
    await dispatch({ method: "GET", pathname });
  }

  assert.deepEqual(seen, ["/status/", "/ping/", "/pingx", "/_mod/health"]);
});

test("createPingDispatch refuses to be built without something to fall through to", () => {
  // A ping layer with no `next` would answer /ping and swallow the rest of the
  // surface.
  assert.throws(() => createPingDispatch(), TypeError);
});
