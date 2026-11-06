/**
 * `GET /meta/compatibility-dates`: the contract, and the third producer.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * This is the one endpoint whose golden cannot be a diff. Every other
 * endpoint's last test is `assertGolden`: serialize what the handler produced
 * and compare it byte for byte with what CCP sent. CCP publishes fourteen
 * compatibility dates and this replica serves one (D4), so a body identical to
 * CCP's would be a false answer to the question this endpoint asks.
 *
 * The recording is still made and used for the parts that are about the wire
 * rather than CCP's list: the key name, the spelling of an item, and the last
 * byte. What the recording cannot say, the pinned spec says:
 * `MetaCompatibilityDates` is an object with one required array property, and
 * `assertBody` checks ours against it.
 *
 * Stating which half of the evidence each assertion stands on is the point of
 * the split (D23), and this is the endpoint where the split is unavoidable.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const golden = require(path.join(__dirname, "../contract/golden"));
const wire = require(path.join(__dirname, "../contract/wire"));
const { assertBody, describeOperation } = require(path.join(__dirname, "../contract/spec"));
const { COMPATIBILITY_DATE } = require(path.join(__dirname, "../lib/compatibility"));
const { createEsiDispatch } = require(path.join(__dirname, "../lib/pipeline"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const { startServer, closeServer } = require(path.join(__dirname, "../server"));
const {
  CACHE_TTL_SECONDS,
  COMPATIBILITY_DATES,
  META_COMPATIBILITY_DATES_PATH,
  PRODUCER,
  RATE_LIMIT_GROUP,
  buildCompatibilityDates,
  createMetaCompatibilityDatesRoute,
} = require(path.join(__dirname, "../routes/meta"));

const WIRE_PATH = META_COMPATIBILITY_DATES_PATH;

/** Fixed, so `Expires` and the cache window cannot move under a test. */
const NOW = Date.parse("2026-08-23T20:00:00Z");

const metaRouter = () => createRouter([createMetaCompatibilityDatesRoute()]);

const dispatch = (request) =>
  dispatchRequest(metaRouter(), { query: {}, headers: {}, ...request });

// The contract

test("the body satisfies the pinned spec", async () => {
  const result = await dispatch({ method: "GET", pathname: WIRE_PATH });

  assert.equal(result.status, describeOperation("get", WIRE_PATH).successStatus);
  assertBody(result.body, describeOperation("get", WIRE_PATH));
});

test("the recording proves the shape, and deliberately not the list", () => {
  // CCP publishes fourteen dates; we serve one. So `assertGolden` is the wrong
  // tool here (an identical body would be a false statement about which surfaces
  // exist), and these three claims are what the recording can still settle.
  const recorded = golden.loadGolden("GetMetaCompatibilityDates");

  assert.deepEqual(Object.keys(recorded.value), [wire.META.bodyKey], "one key, and this is its name");
  assert.ok(recorded.value.compatibility_dates.includes(COMPATIBILITY_DATE), "the date we serve is one of CCP's");
  assert.equal(recorded.bytes[recorded.bytes.length - 1], 0x0a, "the producer's newline");
  assert.equal(recorded.bytes.length, 208, "208 for 207 of JSON");

  assert.equal(recorded.entry.producer, PRODUCER);
  assert.ok(recorded.value.compatibility_dates.length > COMPATIBILITY_DATES.length, "and CCP's list is longer");
});

test("we publish the one surface we serve, and derive it rather than repeat it", async () => {
  // A separately-written "2020-01-01" here would be a second place to change
  // when D4 is revisited, and the failure would be a replica advertising a
  // surface it does not serve.
  const result = await dispatch({ method: "GET", pathname: WIRE_PATH });

  assert.deepEqual(result.body, { compatibility_dates: [COMPATIBILITY_DATE] });
  assert.deepEqual([...COMPATIBILITY_DATES], [...wire.META.ours]);
});

test("the handler cannot be made to hand out the constant", () => {
  const first = buildCompatibilityDates();
  first.compatibility_dates.push("2026-01-01");

  assert.deepEqual(buildCompatibilityDates().compatibility_dates, [COMPATIBILITY_DATE]);
  assert.deepEqual([...COMPATIBILITY_DATES], [COMPATIBILITY_DATE]);
});

test("the route declares the producer, TTL and group the observations say it has", () => {
  const route = metaRouter().resolve("GET", WIRE_PATH).route;

  assert.equal(route.producer, "meta");
  assert.equal(route.cacheTtl, describeOperation("get", WIRE_PATH).cacheAgeSeconds);
  assert.equal(route.cacheTtl, CACHE_TTL_SECONDS);
  assert.equal(route.rateLimitGroup, RATE_LIMIT_GROUP);
  assert.equal(route.rateLimitGroup, wire.META.rateLimitGroup);
  // No route-level error is observable on this surface (no meta operation
  // declares a parameter), so the family is null rather than guessed from the
  // bytes resembling the gateway's.
  assert.equal(route.errorFamily, null);
});

// Unversioned

test("it answers bare and 404s under every prefix", async () => {
  assert.equal((await dispatch({ method: "GET", pathname: WIRE_PATH })).status, 200);
  assert.equal((await dispatch({ method: "GET", pathname: `${WIRE_PATH}/` })).status, 200, "trailing slash");

  for (const prefix of wire.VERSION_PREFIXES) {
    const result = await dispatch({ method: "GET", pathname: `/${prefix}${WIRE_PATH}` });
    assert.equal(result.status, 404, `/${prefix}${WIRE_PATH} resolved and should not`);
    assert.equal(result.body, wire.UNROUTED_404.body, "and it is Go's plain-text 404");
  }

  assert.ok(wire.UNVERSIONED_PATHS.includes(WIRE_PATH));
});

// The producer that exists because of the cache headers

test("it sends Cache-Control and Expires and no validators at all", async (t) => {
  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: createEsiDispatch(metaRouter(), { now: () => NOW }),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));

  const response = await fetch(`http://127.0.0.1:${handle.port}${WIRE_PATH}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), wire.CONTENT_TYPE[wire.KIND.META_SUCCESS]);
  assert.equal(
    response.headers.get("cache-control"),
    wire.CACHE_CONTROL[wire.KIND.META_SUCCESS](CACHE_TTL_SECONDS),
  );
  assert.equal(response.headers.get("expires"), new Date(NOW + CACHE_TTL_SECONDS * 1000).toUTCString());

  // The three absences that made this a producer rather than a route on the
  // gateway. The pinned spec declares ETag and Last-Modified on this operation
  // and CCP sends neither: observation wins (D23).
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("last-modified"), null);
  assert.equal(response.headers.get("x-esi-cache-status"), null);
  assert.equal(wire.ETAG[wire.KIND.META_SUCCESS], null);
  assert.equal(wire.META.sendsValidators, false);

  // And the ones it does send, like every other routed response.
  assert.equal(response.headers.get("x-compatibility-date"), COMPATIBILITY_DATE);
  assert.equal(response.headers.get("x-ratelimit-group"), RATE_LIMIT_GROUP);
});

test("a conditional request gets a 200, because there is no validator to match", async () => {
  // Not "it happens to return false": a surface that sends no `Etag` can never
  // have produced the one a client is offering, so the 304 is unreachable rather
  // than merely unlikely.
  const stack = createEsiDispatch(metaRouter(), { now: () => NOW });

  for (const ifNoneMatch of ['W/"anything"', '"anything"', "*"]) {
    const result = await stack({
      method: "GET",
      pathname: WIRE_PATH,
      query: {},
      headers: { "if-none-match": ifNoneMatch },
    });
    assert.equal(result.status, 200, `If-None-Match: ${ifNoneMatch} produced a ${result.status}`);
  }
});

test("the bytes end with the producer's newline", async () => {
  const result = await dispatch({ method: "GET", pathname: WIRE_PATH });
  const payload = serializeBody(result.body, result.producer);

  assert.equal(payload.toString("utf8"), '{"compatibility_dates":["2020-01-01"]}\n');
  assert.equal(payload.length, 39, "38 of JSON plus the newline");
  assert.equal(wire.TRAILING_NEWLINE[wire.KIND.META_SUCCESS], true);
});
