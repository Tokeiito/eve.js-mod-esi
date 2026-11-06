/**
 * `X-Compatibility-Date`: the echo, the `Vary`, and the three refusals (D11).
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * D11 recorded "real ESI pins legacy prefixes to `2020-01-01` and ignores the
 * header". Checking against the real client found the first half right and the
 * second wrong: the echo is always `2020-01-01` on `/latest/`, but the header
 * is validated, and three classes of value are refused before anything routes.
 *
 * This file asserts that behaviour against `contract/wire.js`, which holds the
 * probes that established it.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const { startServer, closeServer } = require(path.join(__dirname, "../server"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const { createEsiDispatch } = require(path.join(__dirname, "../lib/pipeline"));
const { createRouter } = require(path.join(__dirname, "../lib/router"));
const {
  COMPATIBILITY_DATE,
  ERRORS,
  OLDEST_SUPPORTED,
  TODAY_OFFSET_HOURS,
  VARY_EDGE,
  VARY_LOCALIZED_EXTRA,
  VARY_ROUTED,
  VARY_UNROUTED,
  createCompatibilityDispatch,
  isCalendarDate,
  readCompatibilityDate,
  todayAt,
} = require(path.join(__dirname, "../lib/compatibility"));

/** Fixed, and late enough in the UTC day to make the UTC-11 offset visible. */
const NOW = Date.parse("2026-08-23T20:00:00Z");

/** The bytes a refusal puts on the wire. */
const bytes = (result) => serializeBody(result.body, result.producer).toString("utf8");

/** The header spelling. `readQuery` below is the other one. */
const read = (value) =>
  readCompatibilityDate({ headers: { "x-compatibility-date": value } }, { now: NOW });

/** The query spelling, which is validated identically and beats the header. */
const readQuery = (value) =>
  readCompatibilityDate({ query: { compatibility_date: value } }, { now: NOW });

/** The composition `loader.js` builds, from the compatibility layer inward. */
/**
 * The real stack, from the one place that knows the order.
 *
 * `lib/pipeline.js` is the only construction, so a test here exercises what
 * ships. A test-local copy would let a correction to the real order change
 * nothing this file could see.
 */
function compose(routes = []) {
  return createEsiDispatch(createRouter(routes), { now: () => NOW });
}

const statusRoute = (producer = "gateway") => ({
  method: "GET",
  path: "/status",
  name: "GetStatus",
  handler: () => ({ players: 1 }),
  producer,
  cacheTtl: 30,
});

// The value we serve

test("the surface we serve is the one D4 pinned, and it is what we echo", () => {
  assert.equal(COMPATIBILITY_DATE, "2020-01-01");
  assert.equal(COMPATIBILITY_DATE, wire.COMPATIBILITY_DATE);
  assert.equal(OLDEST_SUPPORTED, wire.COMPATIBILITY_DATE_RULES.oldestSupported);
  assert.equal(TODAY_OFFSET_HOURS, wire.COMPATIBILITY_DATE_RULES.todayOffsetHours);
});

// Reading the header

test("an absent or empty header is no opinion at all", () => {
  // Observed: `X-Compatibility-Date:` with nothing after it is a 200, not a
  // format error. An empty header is the same request as no header.
  assert.deepEqual(readCompatibilityDate({ headers: {} }, { now: NOW }), { date: null });
  assert.deepEqual(readCompatibilityDate({}, { now: NOW }), { date: null }, "and no headers at all");
  assert.deepEqual(read(""), { date: null });
  assert.deepEqual(read(undefined), { date: null });
  assert.equal(wire.COMPATIBILITY_DATE_RULES.emptyHeaderIsAbsent, true);
});

test("a date this replica will serve comes back as itself", () => {
  assert.deepEqual(read("2020-01-01"), { date: "2020-01-01" });
  assert.deepEqual(read("2026-08-23"), { date: "2026-08-23" }, "today, in UTC-11");
});

test("a malformed date is refused, and a bad calendar date counts as malformed", () => {
  // `2026-13-01` and `2026-02-30` are format errors on the real surface, not
  // range errors: the check is that the value is a real date spelled
  // YYYY-MM-DD, and a month of 13 fails the spelling. A regex alone would let
  // February 30th through.
  for (const value of ["nope", "2026-8-1", "20260801", "2026-08-01T00:00:00Z", "2026-13-01", "2026-02-30"]) {
    const { refusal } = read(value);

    assert.equal(refusal.status, 400, `${value} was not refused`);
    assert.equal(JSON.parse(bytes(refusal)).error, wire.COMPATIBILITY_DATE_RULES.errors.badFormat);
    assert.equal(JSON.parse(bytes(refusal)).error, ERRORS.badFormat);
  }

  assert.equal(isCalendarDate("2026-02-28"), true);
  assert.equal(isCalendarDate("2026-02-30"), false, "Date.UTC rolls it to March, and the round-trip catches it");
  assert.equal(isCalendarDate("2024-02-29"), true, "a leap day is a real date");
  assert.equal(isCalendarDate("2026-02-29"), false, "and is not, in a common year");
});

test("a date older than the oldest surface is refused, naming the boundary", () => {
  for (const value of ["2019-12-31", "2015-01-01", "1999-01-01"]) {
    const { refusal } = read(value);

    assert.equal(refusal.status, 400);
    assert.equal(
      JSON.parse(bytes(refusal)).error,
      wire.COMPATIBILITY_DATE_RULES.errors.tooOld(value),
    );
  }

  assert.deepEqual(read("2020-01-01"), { date: "2020-01-01" }, "and the boundary itself is fine");
});

test("a future date is refused, and the message names the zone", () => {
  const { refusal } = read("2026-08-24");

  assert.equal(refusal.status, 400);
  assert.equal(
    JSON.parse(bytes(refusal)).error,
    "Compatibility date (2026-08-24) is in the future. Current date (UTC-11) is 2026-08-23.",
  );
  assert.equal(
    JSON.parse(bytes(refusal)).error,
    wire.COMPATIBILITY_DATE_RULES.errors.inFuture("2026-08-24", "2026-08-23"),
  );
});

test("today is evaluated in UTC-11, which is eleven hours of slack", () => {
  // The detail only shows because CCP puts the offset in the message. A replica
  // comparing against UTC would refuse a date for up to eleven hours after CCP
  // started accepting it: a 400 for a value the client had every reason to think
  // was valid.
  assert.equal(todayAt(Date.parse("2026-08-23T20:00:00Z")), "2026-08-23");
  assert.equal(todayAt(Date.parse("2026-08-24T05:00:00Z")), "2026-08-23", "still yesterday in UTC-11");
  assert.equal(todayAt(Date.parse("2026-08-24T11:00:00Z")), "2026-08-24", "and over the line at 11:00Z");

  // So a date that UTC already considers "today" is still refused as future.
  const atMidnightUtc = readCompatibilityDate(
    { headers: { "x-compatibility-date": "2026-08-24" } },
    { now: Date.parse("2026-08-24T00:30:00Z") },
  );
  assert.equal(atMidnightUtc.refusal.status, 400, "UTC says today; UTC-11 says tomorrow, and CCP follows UTC-11");
});

test("the refusals are edge refusals, byte for byte", () => {
  // Same family as `Invalid tenant`: written by the gateway, `nosniff`, and a
  // trailing newline, so the format refusal is 68 bytes and not the 67 its JSON
  // text weighs.
  const { refusal } = read("nope");

  assert.equal(refusal.headers["content-type"], "application/json");
  assert.equal(refusal.headers["x-content-type-options"], "nosniff");
  assert.equal(refusal.producer, "gateway");
  assert.equal(serializeBody(refusal.body, refusal.producer).length, 68, "observed Content-Length");
  assert.equal(bytes(refusal).endsWith("\n"), true);
});

// The layer

test("a refusal never reaches the router, and carries two Vary lines", async () => {
  let reached = false;
  const dispatch = createCompatibilityDispatch(() => { reached = true; return { status: 200 }; }, { now: () => NOW });

  const result = await dispatch({ method: "GET", pathname: "/latest/status/", headers: { "x-compatibility-date": "nope" } });

  assert.equal(result.status, 400);
  assert.equal(reached, false, "a date we will not serve is refused before anything routes");
  assert.deepEqual(result.headers.vary, [...VARY_EDGE]);
  assert.equal(result.headers.vary.length, 2, "not three: the answer cannot depend on a date we rejected");
});

test("anything with an acceptable date passes straight through", async () => {
  const seen = [];
  const dispatch = createCompatibilityDispatch((request) => { seen.push(request.headers); return { status: 200 }; }, { now: () => NOW });

  for (const headers of [{}, { "x-compatibility-date": "" }, { "x-compatibility-date": "2020-01-01" }, { "x-compatibility-date": "2026-08-23" }]) {
    assert.equal((await dispatch({ method: "GET", pathname: "/latest/status/", headers })).status, 200);
  }
  assert.equal(seen.length, 4);
});

test("createCompatibilityDispatch refuses to be built without something to wrap", () => {
  assert.throws(() => createCompatibilityDispatch(), TypeError);
});

// The echo, and who gets it

test("a route's response echoes the surface that answered", async () => {
  const dispatch = compose([statusRoute()]);

  const result = await dispatch({ method: "GET", pathname: "/latest/status/", query: {}, headers: {} });

  assert.equal(result.headers["x-compatibility-date"], "2020-01-01");
  assert.equal(wire.ECHOES_COMPATIBILITY_DATE[wire.KIND.GATEWAY_SUCCESS], true);
});

test("the echo is 2020-01-01 whatever the client asked for", async () => {
  // Observed: `X-Compatibility-Date: 2026-08-01` against `/latest/status/` still
  // comes back `2020-01-01`. We serve one surface (D4) and say so.
  const dispatch = compose([statusRoute()]);

  const result = await dispatch({
    method: "GET",
    pathname: "/latest/status/",
    query: {},
    headers: { "x-compatibility-date": "2026-08-01" },
  });

  assert.equal(result.status, 200);
  assert.equal(result.headers["x-compatibility-date"], "2020-01-01");
});

test("routing that found nothing carries the Vary but not the echo", async () => {
  // The pair that makes the rule legible: both reached routing, so the answer
  // would have depended on the date, and neither was produced by a route, so
  // neither says which surface answered.
  const dispatch = compose([statusRoute()]);

  const unrouted = await dispatch({ method: "GET", pathname: "/nope/", query: {}, headers: {} });
  const refused = await dispatch({ method: "DELETE", pathname: "/latest/status/", query: {}, headers: {} });

  for (const [label, result] of [["unrouted 404", unrouted], ["405", refused]]) {
    assert.equal(result.headers["x-compatibility-date"], undefined, `${label} echoed a surface`);
    assert.deepEqual(result.headers.vary, [...VARY_UNROUTED], `${label} has the wrong Vary`);
  }

  assert.equal(wire.ECHOES_COMPATIBILITY_DATE[wire.KIND.UNROUTED], false, "the observation this rests on");
});

test("the routed Vary is three lines, and both producers agree about that", async () => {
  // The application sends three `Vary` lines, not four. A fourth was once
  // generalised from `/universe/factions/`, wrongly: `/markets/prices/`,
  // `/markets/{region}/orders/`, `/incursions/`, `/alliances/`, `/wars/` and
  // `/contracts/public/{region}/` all send three.
  const gateway = await compose([statusRoute("gateway")])({ method: "GET", pathname: "/latest/status/", query: {}, headers: {} });
  const app = await compose([statusRoute("app")])({ method: "GET", pathname: "/latest/status/", query: {}, headers: {} });

  assert.deepEqual(gateway.headers.vary, [...VARY_ROUTED.gateway]);
  assert.deepEqual(app.headers.vary, [...VARY_ROUTED.app]);
  assert.equal(app.headers.vary.filter((v) => v === "Accept-Language").length, 1);
  assert.equal(gateway.headers.vary.filter((v) => v === "Accept-Language").length, 1);

  assert.deepEqual([...wire.VARY_BY_KIND[wire.KIND.APP_SUCCESS]], [...VARY_ROUTED.app], "lib/ and contract/ agree");
  assert.deepEqual([...wire.VARY_BY_KIND[wire.KIND.GATEWAY_SUCCESS]], [...VARY_ROUTED.gateway]);
});

test("a route whose body carries names repeats Accept-Language", async () => {
  // The fourth line is the route's, not the producer's. Both producers can have
  // it, and a client splitting `Vary` on commas sees `Accept-Language` twice.
  for (const producer of ["gateway", "app"]) {
    const localized = await compose([{ ...statusRoute(producer), localizedBody: true }])(
      { method: "GET", pathname: "/latest/status/", query: {}, headers: {} },
    );

    assert.deepEqual(
      localized.headers.vary,
      [...VARY_ROUTED[producer], VARY_LOCALIZED_EXTRA],
      `${producer} did not add the localized line`,
    );
    assert.equal(localized.headers.vary.filter((v) => v === "Accept-Language").length, 2);
  }

  const app = await compose([{ ...statusRoute("app"), localizedBody: true }])(
    { method: "GET", pathname: "/latest/status/", query: {}, headers: {} },
  );
  assert.deepEqual([...app.headers.vary], [...wire.VARY_LOCALIZED_BODY], "lib/ and contract/ agree");
});

test("/ping carries neither, because it carries nothing", () => {
  assert.deepEqual([...wire.VARY_BY_KIND[wire.KIND.PING]], []);
  assert.equal(wire.ECHOES_COMPATIBILITY_DATE[wire.KIND.PING], false);
});

// On a socket

test("the header set reaches the client, in CCP's casing and as repeated lines", async (t) => {
  // `Vary` goes out as separate lines, never comma-joined: some intermediaries
  // fold them, and the folded form is a different string to anything keying a
  // cache on it. Read off the raw socket, because `fetch` joins them on the way
  // in and would pass whatever we sent.
  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: compose([statusRoute()]),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));

  const http = require("node:http");
  const head = await new Promise((resolve, reject) => {
    const socket = http.globalAgent.createConnection({ host: "127.0.0.1", port: handle.port });
    let raw = "";
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("end", () => resolve(raw.split("\r\n\r\n")[0]));
    socket.on("error", reject);
    socket.write("GET /latest/status/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  });

  assert.match(head, /\r\nX-Compatibility-Date: 2020-01-01\r\n/, "and title-cased, as CCP spells it");
  assert.equal((head.match(/\r\nVary: /g) || []).length, 3, "three lines, not one comma-joined header");
  assert.match(head, /\r\nVary: X-Compatibility-Date\r\n/);
});

test("a refused date carries CORS, which is why the layer sits inside them", async (t) => {
  // These refusals carry `Access-Control-*`, like the other gateway errors. Two
  // curls on 2026-08-23 showed it for both refusals, and `contract/wire.js` has
  // `SENDS_CORS[GATEWAY_ERROR] = true`. An earlier version of this test asserted
  // the opposite ("the same shape as Invalid tenant") because that row of the
  // table had no assertion.
  //
  // If it is wrong, a browser tool sending a malformed date gets an opaque
  // network error instead of a 400 it can read and act on.
  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: compose([statusRoute()]),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));

  const response = await fetch(`http://127.0.0.1:${handle.port}/latest/status/`, {
    headers: { "X-Compatibility-Date": "nope", Origin: "https://x.test" },
  });

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("access-control-allow-origin"), wire.ALLOW_ORIGIN);
  assert.equal(response.headers.get("access-control-expose-headers"), wire.EXPOSE_HEADERS);
  assert.equal(
    wire.SENDS_CORS[wire.KIND.GATEWAY_ERROR],
    true,
    "the recorded row this rests on, which nothing used to assert",
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  // The other half of the same correction: the refusal is the error limiter's
  // and it spends a unit, even though /latest/status/ publishes a rate-limit
  // group, because the request never reached the route that owns the bucket.
  assert.equal(response.headers.get("x-esi-error-limit-remain"), String(wire.ERROR_LIMIT.maxErrors - 1));
  assert.ok(response.headers.get("x-esi-error-limit-reset"));
  assert.equal(response.headers.get("x-ratelimit-group"), null, "a pre-routing refusal has no bucket");
  assert.equal(await response.text(), '{"error":"Invalid compatibility date format. Expected YYYY-MM-DD."}\n');
});

// The other way to ask

test("?compatibility_date= is validated exactly as the header is", () => {
  // D11 recorded the query spelling in one parenthesis and described only the
  // header, so a client that appends `?compatibility_date=` to a base URL could
  // get a 200 for a value CCP refuses. Same three refusals, same messages, same
  // edge shape.
  assert.equal(wire.COMPATIBILITY_DATE_RULES.queryParameter, "compatibility_date");

  assert.deepEqual(readQuery("2020-01-01"), { date: "2020-01-01" });

  const format = readQuery("nope").refusal;
  assert.equal(format.status, 400);
  assert.equal(JSON.parse(bytes(format)).error, ERRORS.badFormat);

  const old = readQuery("2019-12-31").refusal;
  assert.equal(JSON.parse(bytes(old)).error, ERRORS.tooOld("2019-12-31"));

  const future = readQuery("2026-08-24").refusal;
  assert.equal(JSON.parse(bytes(future)).error, ERRORS.inFuture("2026-08-24", "2026-08-23"));
});

test("the query parameter wins outright, and both directions were checked", () => {
  // The two rows where "validate whichever is present" and "validate both"
  // disagree, and they disagree by a whole status code:
  //
  //   -H "X-Compatibility-Date: nope"        ?compatibility_date=2020-01-01  200
  //   -H "X-Compatibility-Date: 2020-01-01"  ?compatibility_date=nope        400
  const goodQuery = readCompatibilityDate(
    { headers: { "x-compatibility-date": "nope" }, query: { compatibility_date: "2020-01-01" } },
    { now: NOW },
  );
  assert.deepEqual(goodQuery, { date: "2020-01-01" }, "a bad header is not even looked at");

  const badQuery = readCompatibilityDate(
    { headers: { "x-compatibility-date": "2020-01-01" }, query: { compatibility_date: "nope" } },
    { now: NOW },
  );
  assert.equal(badQuery.refusal.status, 400, "and a good header does not rescue a bad one");

  assert.equal(wire.COMPATIBILITY_DATE_RULES.queryWins, true);
});

test("an empty query parameter hands the question back to the header", () => {
  // The one interaction between "the query wins" and "empty is absent", and the
  // row that says which of the two rules is on top:
  //
  //   -H "X-Compatibility-Date: nope"  ?compatibility_date=   ->  400, from the header
  const refused = readCompatibilityDate(
    { headers: { "x-compatibility-date": "nope" }, query: { compatibility_date: "" } },
    { now: NOW },
  );
  assert.equal(refused.refusal.status, 400, "empty is absent, so the header is read");

  assert.deepEqual(readQuery(""), { date: null });
  assert.equal(wire.COMPATIBILITY_DATE_RULES.emptyQueryIsAbsent, true);
});

test("a bad query parameter is refused on the wire, before anything routes", async () => {
  let reached = false;
  const dispatch = compose([statusRoute()]);
  const probe = createCompatibilityDispatch(() => { reached = true; return { status: 200 }; }, { now: () => NOW });

  await probe({ method: "GET", pathname: "/latest/status/", query: { compatibility_date: "nope" }, headers: {} });
  assert.equal(reached, false, "the layer reads the query, not just the headers");

  const result = await dispatch({
    method: "GET",
    pathname: "/latest/status/",
    query: { compatibility_date: "2019-12-31" },
    headers: {},
  });

  assert.equal(result.status, 400);
  assert.deepEqual(result.headers.vary, [...VARY_EDGE]);
  assert.equal(JSON.parse(bytes(result)).error, ERRORS.tooOld("2019-12-31"));
});

test("a bad query parameter comes back on the error limiter, like the header", async () => {
  // Same rule, asserted through the whole stack rather than at the layer:
  // `groupFor` has to read the query too, or a request refused in front of
  // routing would be charged to the bucket it never reached.
  const dispatch = compose([statusRoute()]);

  const result = await dispatch({
    method: "GET",
    pathname: "/latest/status/",
    query: { compatibility_date: "nope" },
    headers: {},
  });

  assert.equal(result.status, 400);
  assert.equal(result.headers["x-esi-error-limit-remain"], String(wire.ERROR_LIMIT.maxErrors - 1));
  assert.equal(result.headers["x-ratelimit-group"], undefined, "a pre-routing refusal has no bucket");
});

// The limit we are choosing to have

test("surface selection is recorded and deliberately not implemented", () => {
  // A valid in-range date selects a surface, and the header beats the path
  // prefix: `/latest/sovereignty/map/` with 2026-08-01 is a 404, because that
  // route does not exist on the modern surface. Reproducing it needs a
  // date-versioned route table, and D4 scoped this replica to 2020-01-01 alone.
  // So an in-range date is served from the one surface there is.
  assert.deepEqual(read("2026-08-01"), { date: "2026-08-01" }, "accepted, not refused");

  const rules = wire.COMPATIBILITY_DATE_RULES;
  assert.ok(rules.errors.badFormat && rules.errors.tooOld && rules.errors.inFuture);
  assert.equal(
    rules.oldestSupported,
    COMPATIBILITY_DATE,
    "the oldest surface CCP serves is the one we serve, which is why the limit costs so little",
  );
});
