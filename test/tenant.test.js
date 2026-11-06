/**
 * `?datasource=` and `X-Tenant:`: one value, two spellings, and the refusal
 * that is emptier than every other response on the surface (D26).
 *
 * Run with: node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * `?datasource=tranquility` is on the end of nearly every URL the ecosystem
 * sends. Ignoring an unknown query parameter is right
 * (`IGNORES_UNKNOWN_QUERY_PARAMS`), and this is the single observed exception:
 * a recognised parameter whose value the gateway refuses before anything
 * routes.
 *
 * Three things are one-request-wide and invisible to a test that only checks
 * "good value passes, bad value fails": the query parameter beats the header,
 * the tenant is checked before the compatibility date, and the refusal carries
 * no `Vary` at all where the neighbouring refusal carries two.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const { startServer, closeServer } = require(path.join(__dirname, "../server"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const { createEsiDispatch, createGroupFor } = require(path.join(__dirname, "../lib/pipeline"));
const { createRouter } = require(path.join(__dirname, "../lib/router"));
const {
  TENANT,
  TENANT_HEADER,
  TENANT_QUERY,
  createTenantDispatch,
  readTenant,
  requestedTenant,
} = require(path.join(__dirname, "../lib/tenant"));

/** Fixed, so the compatibility layer downstream cannot move under a test. */
const NOW = Date.parse("2026-08-23T20:00:00Z");

/** The bytes a refusal puts on the wire. */
const bytes = (result) => serializeBody(result.body, result.producer).toString("utf8");

/** The real stack, from the one place that knows the order. */
function compose(routes = []) {
  return createEsiDispatch(createRouter(routes), { now: () => NOW });
}

const statusRoute = () => ({
  method: "GET",
  path: "/status",
  name: "GetStatus",
  handler: () => ({ players: 1 }),
  producer: "gateway",
  cacheTtl: 30,
  rateLimitGroup: "status",
});

const withQuery = (value) => ({ query: { [TENANT_QUERY]: value } });
const withHeader = (value) => ({ headers: { [TENANT_HEADER]: value } });

// The value

test("one tenant, and it is CCP's rather than this server's name (D26)", () => {
  assert.equal(TENANT, "tranquility");
  assert.equal(TENANT, wire.TENANT.value);
  assert.equal(TENANT_QUERY, wire.TENANT.queryParameter);
  assert.equal(TENANT_HEADER, wire.TENANT.header);
});

test("singularity is refused, which is why we did not add a name of our own", () => {
  // The set of valid datasources is shrinking (`singularity` was valid for a
  // decade and is now a 400), so a replica answering to its own name would not be more
  // permissive than CCP but differently shaped from it, and a client library
  // with a datasource enum would need a case for us alone.
  assert.equal(readTenant(withQuery("singularity")).refusal.status, 400);
  assert.equal(readTenant(withQuery("myserver")).refusal.status, 400);
});

// Reading it

test("no opinion is the overwhelming majority of requests", () => {
  assert.deepEqual(readTenant({}), { tenant: null });
  assert.deepEqual(readTenant({ headers: {}, query: {} }), { tenant: null });
  assert.equal(requestedTenant({}), null);
});

test("an empty value on either spelling is absent, not malformed", () => {
  assert.deepEqual(readTenant(withQuery("")), { tenant: null });
  assert.deepEqual(readTenant(withHeader("")), { tenant: null });
  assert.equal(wire.TENANT.emptyIsAbsent, true);
});

test("either spelling carries it", () => {
  assert.deepEqual(readTenant(withQuery("tranquility")), { tenant: TENANT });
  assert.deepEqual(readTenant(withHeader("tranquility")), { tenant: TENANT });
});

test("the comparison is case-insensitive, which is the forgiving bit", () => {
  assert.deepEqual(readTenant(withQuery("TRANQUILITY")), { tenant: TENANT });
  assert.deepEqual(readTenant(withHeader("Tranquility")), { tenant: TENANT });
  assert.equal(wire.TENANT.caseInsensitive, true);
});

test("the query parameter wins outright, and both directions were checked", () => {
  // "The header is a fallback for the query parameter" and "either one being bad
  // is a refusal" agree on every other row and differ on these two, by a status
  // code. Observed both ways round rather than inferred from one.
  const badHeaderGoodQuery = readTenant({
    headers: { [TENANT_HEADER]: "nope" },
    query: { [TENANT_QUERY]: "tranquility" },
  });
  assert.deepEqual(badHeaderGoodQuery, { tenant: TENANT }, "a bad header is not even looked at");

  const goodHeaderBadQuery = readTenant({
    headers: { [TENANT_HEADER]: "tranquility" },
    query: { [TENANT_QUERY]: "nope" },
  });
  assert.equal(goodHeaderBadQuery.refusal.status, 400, "and a good header does not rescue a bad one");

  assert.equal(wire.TENANT.queryWins, true);
});

test("an empty query parameter hands the question back to the header", () => {
  const refused = readTenant({
    headers: { [TENANT_HEADER]: "nope" },
    query: { [TENANT_QUERY]: "" },
  });
  assert.equal(refused.refusal.status, 400, "empty is absent, so the header is read");
});

// The refusal

test("the refusal is Invalid tenant, byte for byte", () => {
  const { refusal } = readTenant(withQuery("nope"));

  assert.equal(refusal.status, 400);
  assert.equal(bytes(refusal), `${wire.TENANT.refusal.body}\n`, "Go's newline: 27 bytes, not 26");
  assert.equal(serializeBody(refusal.body, refusal.producer).length, 27, "observed Content-Length");
  assert.equal(refusal.headers["content-type"], "application/json");
  assert.equal(refusal.headers["x-content-type-options"], "nosniff");
  assert.equal(refusal.producer, "gateway");
});

test("it carries no Vary at all, not even the two the date refusal sends", async () => {
  // The emptiest response on the surface, and not derivable from the response
  // kind: both refusals are GATEWAY_ERROR, one sends two lines and this one sends
  // none. `contract/wire.js` records it on TENANT.refusal for that reason, and
  // this assertion keeps the two in step.
  const dispatch = compose([statusRoute()]);

  const result = await dispatch({
    method: "GET",
    pathname: "/latest/status/",
    query: { [TENANT_QUERY]: "nope" },
    headers: {},
  });

  assert.equal(result.status, 400);
  assert.equal(result.headers.vary, undefined);
  assert.deepEqual([...wire.TENANT.refusal.vary], []);
  assert.equal(result.headers["x-compatibility-date"], undefined, "no route answered");
  assert.equal(result.headers["content-language"], undefined, "and no Content-Language either");
});

// The layer, and where it sits

test("a bad tenant never reaches the router", async () => {
  let reached = false;
  const dispatch = createTenantDispatch(() => { reached = true; return { status: 200 }; });

  const result = await dispatch({ method: "GET", pathname: "/nope/", query: { [TENANT_QUERY]: "nope" } });

  assert.equal(result.status, 400);
  assert.equal(reached, false);
});

test("an unrouted path with a bad tenant is the tenant refusal, not the 404", async () => {
  // The observable half of "before routing": two answers were available and CCP
  // gives this one.
  const dispatch = compose([statusRoute()]);

  const result = await dispatch({
    method: "GET",
    pathname: "/nope/",
    query: { [TENANT_QUERY]: "nope" },
    headers: {},
  });

  assert.equal(result.status, 400);
  assert.equal(bytes(result), `${wire.TENANT.refusal.body}\n`);
});

test("the tenant is checked before the compatibility date", async () => {
  // Two refusals were available, both 400, both edge, both on the error limiter,
  // and CCP picks this one. Which body comes back is the only thing that
  // distinguishes the order of the two layers, so it is the whole assertion.
  const dispatch = compose([statusRoute()]);

  const result = await dispatch({
    method: "GET",
    pathname: "/latest/status/",
    query: { [TENANT_QUERY]: "nope" },
    headers: { "x-compatibility-date": "nope" },
  });

  assert.equal(JSON.parse(bytes(result)).error, "Invalid tenant");
  assert.equal(wire.TENANT.checkedBeforeCompatibilityDate, true);
});

test("anything with an acceptable tenant passes straight through", async () => {
  let seen = 0;
  const dispatch = createTenantDispatch(() => { seen += 1; return { status: 200 }; });

  for (const request of [{}, withQuery(""), withQuery("tranquility"), withHeader("TRANQUILITY")]) {
    assert.equal((await dispatch({ method: "GET", pathname: "/latest/status/", ...request })).status, 200);
  }
  assert.equal(seen, 4);
});

test("createTenantDispatch refuses to be built without something to wrap", () => {
  assert.throws(() => createTenantDispatch(), TypeError);
});

// Which limiter answers

test("a bad tenant has no bucket, even on a route that owns one", () => {
  // `/status/` publishes a rate-limit group, and a request refused in front of
  // routing never reached the route that owns it. `groupFor` has to answer `null`
  // before the router is asked, or the token bucket would charge for a request
  // it never saw.
  const groupFor = createGroupFor(createRouter([statusRoute()]), { now: () => NOW });

  assert.equal(groupFor({ method: "GET", pathname: "/latest/status/", headers: {}, query: {} }), "status");
  assert.equal(
    groupFor({ method: "GET", pathname: "/latest/status/", headers: {}, query: { [TENANT_QUERY]: "nope" } }),
    null,
  );
  assert.equal(
    groupFor({ method: "GET", pathname: "/latest/status/", headers: { [TENANT_HEADER]: "nope" }, query: {} }),
    null,
  );
});

// On a socket

test("the refusal reaches a browser, and spends a unit of the error limit", async (t) => {
  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: compose([statusRoute()]),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));

  const response = await fetch(`http://127.0.0.1:${handle.port}/latest/status/?datasource=nope`, {
    headers: { Origin: "https://x.test" },
  });

  assert.equal(response.status, 400);
  // Without these a browser tool sending the wrong datasource sees an opaque
  // network error rather than a 400 it can read.
  assert.equal(response.headers.get("access-control-allow-origin"), wire.ALLOW_ORIGIN);
  assert.equal(response.headers.get("access-control-expose-headers"), wire.EXPOSE_HEADERS);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("vary"), null, "no Vary at all");
  assert.equal(response.headers.get("content-length"), "27");

  assert.equal(response.headers.get("x-esi-error-limit-remain"), String(wire.ERROR_LIMIT.maxErrors - 1));
  assert.equal(response.headers.get("x-ratelimit-group"), null, "a pre-routing refusal has no bucket");
  assert.equal(await response.text(), `${wire.TENANT.refusal.body}\n`);
});

test("the tenant every tool actually sends is served", async (t) => {
  // D26 in one request: `?datasource=tranquility` is what every consumer in the
  // ecosystem appends, and it has to be a 200.
  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: compose([statusRoute()]),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));

  const response = await fetch(`http://127.0.0.1:${handle.port}/latest/status/?datasource=tranquility`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-compatibility-date"), "2020-01-01");
  assert.deepEqual(await response.json(), { players: 1 });
});

test("/ping is outside this layer, as it is outside every other one", async (t) => {
  const { createPingDispatch } = require(path.join(__dirname, "../routes/ping"));
  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: createPingDispatch(compose([statusRoute()])),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));

  const response = await fetch(`http://127.0.0.1:${handle.port}/ping?datasource=nope`);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});
