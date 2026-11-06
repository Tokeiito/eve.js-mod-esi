/**
 * `X-Esi-Request-Id`: the application's stamp, and only the application's.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Observed: the header exists and belongs to one producer.
 * `contract/wire.js` `APP_SUCCESS_HEADERS` has it and `GATEWAY_SUCCESS_HEADERS`
 * does not, one piece of evidence that ESI is two implementations behind one
 * hostname. Claimed, not observed: that the value is a UUID, marked as a claim
 * in `INFRASTRUCTURE` beside the request that would settle it. This file
 * asserts the first strictly and the second as the shape chosen.
 *
 * Boundaries checked: a per-response id must never be shared by two responses.
 * The 304 is where that would happen. The layer that builds it rebuilds its
 * headers from a named list, so an id written inside it is dropped, and an id
 * carried across that list is the previous response's. Both are asserted.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const { createEsiDispatch } = require(path.join(__dirname, "../lib/pipeline"));
const { createRouter } = require(path.join(__dirname, "../lib/router"));
const { PRODUCER } = require(path.join(__dirname, "../lib/serialize"));
const { notFound } = require(path.join(__dirname, "../lib/errors"));
const {
  HEADER,
  STAMPED_BY,
  createRequestIdDispatch,
  newRequestId,
} = require(path.join(__dirname, "../lib/requestId"));

const NOW = Date.parse("2026-08-23T10:00:00Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const route = (producer, overrides = {}) => ({
  method: "GET",
  path: "/status",
  name: "GetStatus",
  handler: () => ({ players: 1 }),
  producer,
  cacheTtl: 30,
  ...overrides,
});

/** The real stack, from the one place that knows the order. */
function compose(routes) {
  return createEsiDispatch(createRouter(routes), { now: () => NOW });
}

const get = (dispatch, headers = {}) =>
  dispatch({ method: "GET", pathname: "/latest/status/", query: {}, headers });

// Which producer stamps one

test("the split is the observed one: the application stamps, the gateway does not", () => {
  assert.deepEqual([...STAMPED_BY], [PRODUCER.APP]);

  assert.ok(wire.APP_SUCCESS_HEADERS.includes(HEADER), "observed on the application's 2XX");
  assert.ok(!wire.GATEWAY_SUCCESS_HEADERS.includes(HEADER), "and on none of the gateway's");

  assert.deepEqual([...wire.INFRASTRUCTURE.requestId.producers], [...STAMPED_BY]);
  assert.equal(wire.INFRASTRUCTURE.requestId.header, HEADER);
});

test("the format is a UUID, and the file says so is a claim rather than an observation", () => {
  // The header's presence can be re-established with one curl; its value cannot
  // be checked until somebody records a real response.
  assert.equal(wire.INFRASTRUCTURE.requestId.format, "uuid");
  assert.equal(wire.INFRASTRUCTURE.requestId.formatObserved, false);
  assert.match(newRequestId(), UUID);
});

test("an application response carries one and a gateway response carries none", async () => {
  const app = await get(compose([route(PRODUCER.APP)]));
  const gateway = await get(compose([route(PRODUCER.GATEWAY)]));

  assert.match(app.headers[HEADER], UUID);
  assert.equal(gateway.headers[HEADER], undefined);
});

// One per response, not one per representation

test("two requests for the same unchanged body get two different ids", async () => {
  // The body, the `Etag` and the `Last-Modified` are identical inside a cache
  // window, deliberately, so a paged sweep agrees. The id must differ.
  const dispatch = compose([route(PRODUCER.APP)]);

  const first = await get(dispatch);
  const second = await get(dispatch);

  assert.equal(first.headers.etag, second.headers.etag, "same window, same representation");
  assert.notEqual(first.headers[HEADER], second.headers[HEADER]);
});

test("a 304 gets its own id, and not the one from the 200 it stands in for", async () => {
  // `notModifiedResult` names the headers that survive, so an id written any
  // deeper is dropped and the 304 goes out without one; an id added to that list
  // is the previous response's, which is worse than absent.
  const dispatch = compose([route(PRODUCER.APP)]);

  const first = await get(dispatch);
  const again = await get(dispatch, { "if-none-match": first.headers.etag });

  assert.equal(again.status, 304);
  assert.match(again.headers[HEADER], UUID);
  assert.notEqual(again.headers[HEADER], first.headers[HEADER]);
});

test("a gateway 304 stays bare, the same way its 200 does", async () => {
  const dispatch = compose([route(PRODUCER.GATEWAY)]);

  const first = await get(dispatch);
  const again = await get(dispatch, { "if-none-match": first.headers.etag });

  assert.equal(again.status, 304);
  assert.equal(again.headers[HEADER], undefined);
});

// Refusals

test("an application 404 carries one", async () => {
  const dispatch = compose([route(PRODUCER.APP, {
    handler: () => { throw Object.assign(new Error("unused"), {}); },
  })]);

  // A refusal the route produced rather than one the framework invented: the
  // handler returns lib/errors.js's own 404 shape.
  const refusal = notFound("legacy", { entity: "Region" });
  assert.equal(refusal.producer, PRODUCER.APP, "the family's producer, which is what gets stamped");

  const stamped = await createRequestIdDispatch(async () => refusal)({});
  assert.match(stamped.headers[HEADER], UUID);

  // The framework's own 500 for a throwing handler is the gateway's, so it gets
  // no id. This follows from the producer test, not from a separate rule.
  const thrown = await get(dispatch);
  assert.equal(thrown.status, 500);
  assert.equal(thrown.headers[HEADER], undefined);
});

test("a refusal made before routing carries none, because it is the gateway's", async () => {
  // The compatibility-date layer sits outside this one because its refusals are
  // `FAMILY.EDGE`, which is the gateway; an id on one would claim the application
  // answered a request that never reached it.
  const result = await get(compose([route(PRODUCER.APP)]), { "x-compatibility-date": "nope" });

  assert.equal(result.status, 400);
  assert.equal(result.headers[HEADER], undefined);
});

test("the unrouted 404 carries none, because Go wrote it", async () => {
  const result = await compose([route(PRODUCER.APP)])({
    method: "GET",
    pathname: "/nope/",
    query: {},
    headers: {},
  });

  assert.equal(result.status, 404);
  assert.equal(result.headers[HEADER], undefined);
});

// The layer itself

test("a result that already carries one keeps it", async () => {
  // Same rule as lib/cors.js: two spellings of one header go out as two lines or
  // one comma-joined value, and neither is a UUID.
  const dispatch = createRequestIdDispatch(
    async () => ({ status: 200, producer: PRODUCER.APP, headers: { "X-Esi-Request-Id": "kept" } }),
  );

  assert.deepEqual((await dispatch({})).headers, { "X-Esi-Request-Id": "kept" });
});

test("the id source is injectable, so a test can hold it still", async () => {
  const dispatch = createRequestIdDispatch(
    async () => ({ status: 200, producer: PRODUCER.APP }),
    { newId: () => "fixed" },
  );

  assert.equal((await dispatch({})).headers[HEADER], "fixed");
});

test("wrapping something that is not a dispatch fails at construction", () => {
  assert.throws(() => createRequestIdDispatch(null), TypeError);
});
