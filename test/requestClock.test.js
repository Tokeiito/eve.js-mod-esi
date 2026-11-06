/**
 * One clock reading per request, and the torn sweep it prevents.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * The defect: `lib/router.js` chose a page snapshot's window from one reading of
 * the clock, and `lib/cache.js` floored `Last-Modified` from another, taken after
 * the handler returned. Tests that hold the clock still always see equal
 * readings, so the bug was invisible. These are the first tests where the clock
 * moves while the handler runs, which is the only condition under which the two
 * readings differ. Production meets it routinely: a region of market orders
 * takes about 198 ms to materialise, so any request arriving within 198 ms of a
 * TTL boundary crosses one.
 *
 * A torn sweep is not an error to the client. `market-hub-seed` aborts a run
 * when `Last-Modified` differs between order pages. The failure guarded here is
 * the opposite: two pages carrying the same `Last-Modified` and describing
 * different collections. The detector stays quiet and the run completes with
 * mixed data.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { httpDate, windowStart } = require(path.join(__dirname, "../lib/cache"));
const { createEsiDispatch } = require(path.join(__dirname, "../lib/pipeline"));
const { createRouter } = require(path.join(__dirname, "../lib/router"));
const {
  RECEIVED_AT,
  createRequestClockDispatch,
  readingFor,
} = require(path.join(__dirname, "../lib/requestClock"));

const TTL = 30;

/** A boundary, and an arrival 10 ms before it. */
const BOUNDARY = Math.floor(Date.parse("2026-08-23T20:00:00Z") / (TTL * 1000)) * TTL * 1000 + TTL * 1000;
const ARRIVES_AT = BOUNDARY - 10;

/**
 * A clock that jumps forward the first time the handler asks for data.
 *
 * `advanceBy` is generous on purpose: any handler slow enough to cross a
 * boundary reproduces this, and the market route's 198 ms clears 40 ms four
 * times over.
 */
function movingClock({ start = ARRIVES_AT, advanceBy = 40 } = {}) {
  let at = start;
  return {
    now: () => at,
    advance: () => { at += advanceBy; },
    get value() { return at; },
  };
}

function sweepRouter(clock, items) {
  return createRouter([{
    method: "GET",
    path: "/markets/:region_id/orders",
    name: "GetMarketsRegionIdOrders",
    // The handler is where time passes in production: it does the real work.
    handler: () => { clock.advance(); return items; },
    producer: "app",
    cacheTtl: TTL,
    rateLimitGroup: "market-order",
    pageSize: 2,
  }]);
}

const page = (dispatch, n) => dispatch({
  method: "GET",
  pathname: "/latest/markets/10000002/orders/",
  query: { order_type: "all", page: String(n) },
  headers: {},
});

// The reading itself

test("a stamped request answers with its own reading, not a fresh one", () => {
  assert.equal(readingFor({ [RECEIVED_AT]: 1234 }, () => 9999), 1234);
});

test("an unstamped request falls back, because a layer must work alone", () => {
  // `test/cache.test.js` builds a cache dispatch with no pipeline around it and
  // `routes/health.js` never enters the stack at all. A missing stamp means no
  // stack, not an error.
  assert.equal(readingFor({}, () => 9999), 9999);
  assert.equal(readingFor(undefined, () => 9999), 9999);
});

test("a value that is not a finite number is not a reading", () => {
  // Flooring a NaN into a cache window produces `Invalid Date` in a header
  // rather than an error that traces back to here.
  for (const bad of ["2026-08-23", new Date(), null, NaN, Infinity]) {
    assert.equal(readingFor({ [RECEIVED_AT]: bad }, () => 42), 42, `${String(bad)} was taken as a reading`);
  }
});

test("the layer stamps once and does not re-stamp a request that has one", async () => {
  let calls = 0;
  const seen = [];
  const dispatch = createRequestClockDispatch(
    (request) => { seen.push(request[RECEIVED_AT]); return { status: 200 }; },
    { now: () => { calls += 1; return 500; } },
  );

  await dispatch({ method: "GET", pathname: "/latest/status/" });
  await dispatch({ method: "GET", pathname: "/latest/status/", [RECEIVED_AT]: 700 });

  assert.deepEqual(seen, [500, 700], "an existing stamp survives");
  assert.equal(calls, 1, "and the clock is not read for a request that already has one");
});

test("the request object the caller passed is not mutated", async () => {
  const request = { method: "GET", pathname: "/latest/status/" };
  await createRequestClockDispatch(() => ({ status: 200 }), { now: () => 500 })(request);

  assert.equal(RECEIVED_AT in request, false, "server.js owns the object it built");
});

test("createRequestClockDispatch refuses to be built without something to wrap", () => {
  assert.throws(() => createRequestClockDispatch(), TypeError);
});

// The regression

test("a handler that crosses a TTL boundary does not tear the response", async () => {
  // Without the fix, the router picks window N before the handler runs, the
  // handler crosses into N+1, and the cache layer floors `Last-Modified` to N+1.
  // The body is N's and the header is N+1's.
  const clock = movingClock();
  const dispatch = createEsiDispatch(sweepRouter(clock, ["a", "b", "c", "d"]), { now: clock.now });

  const result = await page(dispatch, 1);

  assert.equal(result.status, 200);
  assert.ok(clock.value >= BOUNDARY, "the handler did not actually cross the boundary");
  assert.equal(
    result.headers["last-modified"],
    httpDate(windowStart(ARRIVES_AT, TTL)),
    "Last-Modified describes the window the body was chosen from, not the one the handler ended in",
  );
});

test("a sweep that straddles a boundary reports the straddle instead of hiding it", async () => {
  // A sweep may cross a boundary (`lib/cache.js` says so, and one against real
  // ESI can too). What must never happen is crossing it invisibly. The defect
  // produced exactly that: page 1 carried window N's body under window N+1's
  // `Last-Modified`, and page 2 carried N+1's body under the same header, so the
  // pages agreed on the timestamp, disagreed about their contents, and the
  // client's torn-read detector stayed quiet.
  //
  // Fixed, each page is internally consistent, so the pages differ. That
  // difference is the signal: market-hub-seed aborts the run and retries.
  const clock = movingClock();
  const router = sweepRouter(clock, ["a", "b", "c", "d"]);
  const dispatch = createEsiDispatch(router, { now: clock.now });

  const page1 = await page(dispatch, 1);
  const page2 = await page(dispatch, 2);

  assert.equal(page1.headers["last-modified"], httpDate(windowStart(ARRIVES_AT, TTL)));
  assert.equal(page2.headers["last-modified"], httpDate(windowStart(clock.value, TTL)));
  assert.notEqual(
    page1.headers["last-modified"],
    page2.headers["last-modified"],
    "the straddle has to be visible: a shared timestamp across two windows is the bug",
  );
});

test("a sweep inside one window is one snapshot and one timestamp", async () => {
  // The ordinary case: when the clock does not cross a boundary, every page is
  // the same snapshot under the same header, which an 80-page sweep depends on.
  const clock = movingClock({ advanceBy: 0 });
  const items = ["a", "b", "c", "d"];
  const dispatch = createEsiDispatch(sweepRouter(clock, items), { now: clock.now });

  const page1 = await page(dispatch, 1);
  const page2 = await page(dispatch, 2);

  assert.equal(page1.headers["last-modified"], page2.headers["last-modified"], "one sweep, one timestamp");
  assert.equal(page1.headers["x-pages"], page2.headers["x-pages"]);
  assert.deepEqual([...page1.body, ...page2.body], items, "and one collection behind both pages");

  // Page 2 comes out of the snapshot page 1 filled, so the two pages are the
  // same collection rather than two independent queries.
  assert.equal(page1.headers["x-esi-cache-status"], "MISS");
  assert.equal(page2.headers["x-esi-cache-status"], "HIT");
});

test("the next window is a new snapshot, so this is not just a frozen clock", async () => {
  // Guard against overcorrecting: pinning every request to one reading forever
  // would also make the header stable, and would be wrong. A request that
  // arrives in the next window must see the next window.
  const clock = movingClock({ start: ARRIVES_AT, advanceBy: 0 });
  const router = sweepRouter(clock, ["a", "b"]);
  const dispatch = createEsiDispatch(router, { now: clock.now });

  const before = await page(dispatch, 1);
  clock.advance();
  // Arrive well inside the next window.
  const laterClock = movingClock({ start: BOUNDARY + TTL * 1000, advanceBy: 0 });
  const later = await createEsiDispatch(router, { now: laterClock.now })({
    method: "GET",
    pathname: "/latest/markets/10000002/orders/",
    query: { order_type: "all", page: "1" },
    headers: {},
  });

  assert.notEqual(
    before.headers["last-modified"],
    later.headers["last-modified"],
    "a later window must report a later Last-Modified",
  );
  assert.equal(later.headers["last-modified"], httpDate(windowStart(BOUNDARY + TTL * 1000, TTL)));
});

test("an unpaginated route crossing a boundary is consistent too", async () => {
  // Same two readings, same race, without the snapshot: the Etag is computed
  // from the body and `Last-Modified` from the clock, and they must describe one
  // instant. Narrower blast radius, identical cause.
  const clock = movingClock();
  const router = createRouter([{
    method: "GET",
    path: "/status",
    name: "GetStatus",
    handler: () => { clock.advance(); return { players: 1 }; },
    producer: "gateway",
    cacheTtl: TTL,
    rateLimitGroup: "status",
  }]);

  const result = await createEsiDispatch(router, { now: clock.now })({
    method: "GET",
    pathname: "/latest/status/",
    query: {},
    headers: {},
  });

  assert.equal(result.headers["last-modified"], httpDate(windowStart(ARRIVES_AT, TTL)));
  // The gateway measures Expires from `Date`, which is the same reading too.
  assert.equal(result.headers.expires, httpDate(ARRIVES_AT + TTL * 1000));
});
