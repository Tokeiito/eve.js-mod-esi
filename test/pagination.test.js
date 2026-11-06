/**
 * `lib/pagination.js`: `?page=N`, `X-Pages`, and the snapshot behind them.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Two acceptance claims:
 *
 *   - A multi-page resource sweeps cleanly with stable `X-Pages` and
 *     `Last-Modified` under concurrent game-state mutation. Asserted against a
 *     handler whose collection changes between every single request.
 *   - Page 0 and negative pages are rejected the way ESI rejects them, byte
 *     for byte, against the strings in `contract/wire.js`.
 *
 * One expectation was wrong: a page beyond `X-Pages` does not return an empty
 * array. It returns a `404` carrying `{"error":"Requested page does not
 * exist!"}`, so a client expecting `[]` gets an object. Observed on both
 * publicly reachable paginated routes, and recorded in `contract/wire.js`
 * `PAGINATION_ERRORS`.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const { FAMILY } = require(path.join(__dirname, "../lib/errors"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const { CACHE_STATUS, createCacheDispatch } = require(path.join(__dirname, "../lib/cache"));
const { createEsiDispatch } = require(path.join(__dirname, "../lib/pipeline"));
const {
  MINIMUM_PAGE,
  PAGE_PARAM,
  createSnapshotCache,
  pageCount,
  parsePage,
  slicePage,
  snapshotKey,
} = require(path.join(__dirname, "../lib/pagination"));

const PAGE_SIZE = 1000;
const TTL = 1800;
const WIRE_PATH = "/latest/contracts/public/10000002/";

/** A paginated route over `items`, counting how often it is asked. */
function paginatedRouter(items, { pageSize = PAGE_SIZE, cacheTtl = TTL, localizedBody } = {}) {
  const calls = { count: 0 };
  const router = createRouter([{
    method: "GET",
    path: "/contracts/public/:region_id",
    name: "GetContractsPublicRegionId",
    handler: () => {
      calls.count += 1;
      return typeof items === "function" ? items() : items;
    },
    producer: "app",
    cacheTtl,
    pageSize,
    ...(localizedBody === undefined ? {} : { localizedBody }),
  }]);
  return { router, calls };
}

const get = (router, query, now) =>
  dispatchRequest(router, { method: "GET", pathname: WIRE_PATH, query }, { now });

/** The bytes a refusal would put on the wire. */
const bytes = (result) => serializeBody(result.body, result.producer).toString("utf8");

// Reading the parameter

test("the parameter, its minimum and its page size are the observed ones", () => {
  // lib/ cannot import contract/ (D20); this test checks that they agree.
  assert.equal(PAGE_PARAM, wire.PAGINATION.parameter);
  assert.equal(MINIMUM_PAGE, wire.PAGINATION.minimum);
  assert.equal(PAGE_SIZE, wire.PAGINATION.pageSize, "1000 on both routes observed");
});

test("an absent page is page 1, not the whole collection", () => {
  // A paginated route has no unpaginated form. `?page` missing is the same
  // request as `?page=1`, down to the X-Pages header.
  assert.deepEqual(parsePage({}, { family: FAMILY.LEGACY }), { page: 1 });
  assert.deepEqual(parsePage({ page: "" }, { family: FAMILY.LEGACY }), { page: 1 });
  assert.deepEqual(parsePage(undefined, { family: FAMILY.LEGACY }), { page: 1 });
  assert.equal(wire.PAGINATION.defaultsToFirstPage, true);
});

test("a page that is not an int32 fails coercion before anything checks its range", () => {
  // CCP's order, and the reason `abc` and `2147483648` get the same message
  // while `0` gets a different one: a value that never became an integer is
  // never compared against a minimum.
  for (const value of ["abc", "1.5", "2147483648", "1e3", " ", "0x2"]) {
    const { refusal } = parsePage({ page: value }, { family: FAMILY.LEGACY });
    assert.equal(refusal.status, wire.PAGINATION_ERRORS.notAnInteger.status, `page=${value}`);
    assert.equal(
      JSON.parse(bytes(refusal)).error,
      wire.PAGINATION_ERRORS.notAnInteger.template(value),
      `page=${value} has the wrong message`,
    );
  }
});

test("what counts as an integer is CCP's rule, not JavaScript's", () => {
  // Reaching for `Number()` accepts two of these by luck and three by accident,
  // and turns `?page=%20` into the wrong error: `Number(" ")` is 0, so it would
  // come back "0 does not meet minimum of 1" rather than a coercion failure.
  // Observed against /latest/contracts/public/10000002/.
  const page = (value) => parsePage({ page: value }, { family: FAMILY.LEGACY }).page;

  assert.equal(page("+1"), 1, "a leading plus is accepted");
  assert.equal(page("01"), 1, "and so are leading zeros");
  assert.equal(page("2147483647"), 2147483647, "the top of int32 is in range");

  for (const refused of ["1e3", "0x2", " "]) {
    assert.equal(page(refused), undefined, `${JSON.stringify(refused)} is a number to JavaScript only`);
  }

  // And the boundary is int32, not "a big number": one past the top fails
  // coercion rather than being clamped or reported as out of range.
  assert.equal(page("2147483648"), undefined);
});

test("a repeated ?page is refused, and rendered the way CCP renders it", () => {
  // `?page=1&page=2` arrives as an array. CCP echoes it into the message as a
  // Python list. Matching the refusal is what matters; the rendering is
  // reproduced because it is free and it is what a log would show.
  const { refusal } = parsePage({ page: ["1", "2"] }, { family: FAMILY.LEGACY });

  assert.equal(refusal.status, 400);
  assert.equal(
    JSON.parse(bytes(refusal)).error,
    "failed to coerce value '['1', '2']' into type integer (format: int32)",
  );
});

test("the query coercion message is shorter than the path one", () => {
  // A path parameter names itself (`, 'system_id' is required`). A query
  // parameter is optional by construction, so there is nothing to say it is
  // required of, and CCP does not say it. lib/errors.js was written against the
  // path form and had to learn the difference.
  const { refusal } = parsePage({ page: "abc" }, { family: FAMILY.LEGACY });

  assert.equal(
    JSON.parse(bytes(refusal)).error,
    "failed to coerce value 'abc' into type integer (format: int32)",
  );
  assert.doesNotMatch(bytes(refusal), /is required/);
});

test("page 0 and negative pages are refused the way ESI refuses them", () => {
  // The second acceptance criterion, byte for byte.
  for (const value of ["0", "-1", "-99"]) {
    const { refusal } = parsePage({ page: value }, { family: FAMILY.LEGACY });

    assert.equal(refusal.status, wire.PAGINATION_ERRORS.belowMinimum.status);
    assert.equal(
      JSON.parse(bytes(refusal)).error,
      wire.PAGINATION_ERRORS.belowMinimum.template(value),
    );
    assert.equal(bytes(refusal).endsWith("\n"), false, "the application appends no newline");
  }

  assert.equal(bytes(parsePage({ page: "0" }, { family: FAMILY.LEGACY }).refusal).length, 40, "observed");
  assert.equal(bytes(parsePage({ page: "-1" }, { family: FAMILY.LEGACY }).refusal).length, 41, "observed");
});

// Counting and slicing

test("an empty collection is one empty page, never zero pages", () => {
  // `X-Pages: 0` would tell a client there is no page 1 to fetch. CCP sends 1,
  // and a single-page resource does carry the header: region 10000070's
  // contracts answer `X-Pages: 1` rather than omitting it.
  assert.equal(pageCount(0, PAGE_SIZE), 1);
  assert.equal(pageCount(1, PAGE_SIZE), 1);
  assert.equal(wire.PAGINATION.alwaysSent, true);
});

test("the page count is the ceiling, and the last page is the remainder", () => {
  assert.equal(pageCount(1000, PAGE_SIZE), 1);
  assert.equal(pageCount(1001, PAGE_SIZE), 2);
  assert.equal(pageCount(33168, PAGE_SIZE), 34, "The Forge's contracts, as observed");

  const items = Array.from({ length: 2500 }, (_, i) => i);
  assert.equal(slicePage(items, 1, PAGE_SIZE).length, 1000);
  assert.equal(slicePage(items, 3, PAGE_SIZE).length, 500);
  assert.deepEqual(slicePage(items, 2, PAGE_SIZE)[0], 1000, "page 2 starts where page 1 stopped");
});

test("a page size that is not a positive integer is a programming error", () => {
  for (const bad of [0, -1, null, "1000"]) {
    assert.throws(() => pageCount(10, bad), TypeError, `pageCount accepted ${JSON.stringify(bad)}`);
  }
});

// The route descriptor

test("a paginated route must declare a positive pageSize and a cacheTtl", () => {
  // The TTL is the window a snapshot is held for, so a paginated route without
  // one has no way to keep X-Pages stable across a sweep. Caught at server
  // start, naming the route, rather than on the request that reaches it.
  const base = {
    method: "GET",
    path: "/contracts/public/:region_id",
    handler: () => [],
    producer: "app",
  };

  assert.throws(() => createRouter([{ ...base, pageSize: 0, cacheTtl: 300 }]), /pageSize/);
  assert.throws(() => createRouter([{ ...base, pageSize: "1000", cacheTtl: 300 }]), /pageSize/);
  assert.throws(() => createRouter([{ ...base, pageSize: 1000 }]), /cacheTtl/);
  assert.throws(() => createRouter([{ ...base, pageSize: 1000, cacheTtl: null }]), /cacheTtl/);

  // And a route that does not paginate needs neither.
  assert.doesNotThrow(() => createRouter([base]));
});

test("a paginated handler that does not return an array is a 500, and says why", async () => {
  const { router } = paginatedRouter(() => ({ contracts: [] }));

  const result = await dispatchRequest(
    router,
    { method: "GET", pathname: WIRE_PATH, query: {} },
    { logError: () => {} },
  );

  assert.equal(result.status, 500, "the framework does the slicing; a handler must hand it a list");
});

// Dispatch

test("every page carries X-Pages, and it is the framework's number", async () => {
  const { router } = paginatedRouter(Array.from({ length: 2500 }, (_, i) => i));
  const now = () => Date.parse("2026-08-22T12:00:00Z");

  for (const [page, size] of [["1", 1000], ["2", 1000], ["3", 500]]) {
    const result = await get(router, { page }, now);

    assert.equal(result.status, 200);
    assert.equal(result.headers["x-pages"], "3");
    assert.equal(result.body.length, size);
  }
});

test("a one-page collection still says X-Pages: 1", async () => {
  const { router } = paginatedRouter([1, 2, 3]);
  const result = await get(router, {}, () => Date.parse("2026-08-22T12:00:00Z"));

  assert.equal(result.headers["x-pages"], "1");
  assert.deepEqual(result.body, [1, 2, 3]);
});

test("an empty collection is a 200 with an empty page, not a 404", async () => {
  const { router } = paginatedRouter([]);
  const result = await get(router, {}, () => Date.parse("2026-08-22T12:00:00Z"));

  assert.equal(result.status, 200);
  assert.equal(result.headers["x-pages"], "1");
  assert.deepEqual(result.body, []);
});

test("a page beyond the last is a 404 with a body, not an empty array", async () => {
  // An empty array for an out-of-range page is the natural expectation and is
  // wrong: the wire says 404 with an object.
  const { router } = paginatedRouter(Array.from({ length: 2500 }, (_, i) => i));
  const now = () => Date.parse("2026-08-22T12:00:00Z");

  const result = await get(router, { page: "4" }, now);

  assert.equal(result.status, wire.PAGINATION_ERRORS.beyondLastPage.status);
  assert.equal(bytes(result), wire.PAGINATION_ERRORS.beyondLastPage.body);
  assert.notDeepEqual(result.body, [], "an empty array is what the issue predicted and not what CCP sends");
  assert.equal(result.headers["x-pages"], undefined, "and a refusal carries no X-Pages");
});

test("a refusal does not resolve the collection", async () => {
  // On a route whose collection is thirty thousand objects, `?page=0` must not
  // cost a market's worth of work to answer with forty bytes.
  const { router, calls } = paginatedRouter(Array.from({ length: 2500 }, (_, i) => i));
  const now = () => Date.parse("2026-08-22T12:00:00Z");

  await get(router, { page: "0" }, now);
  await get(router, { page: "abc" }, now);

  assert.equal(calls.count, 0, "the handler ran for a request that could never be answered");
});

// A refusal is still an answer from the route

/**
 * The whole stack, so the headers asserted below are the ones a client gets
 * rather than the ones the router happened to hand upwards. Every test in this
 * section goes through it: `dispatchRequest` alone cannot see missing headers,
 * because they are missing there too and the tests only read the body bytes
 * back.
 */
const through = (router, query, now) => createEsiDispatch(router, { now })({
  method: "GET",
  pathname: WIRE_PATH,
  query,
  headers: {},
  remoteAddress: "203.0.113.7",
});

const NOW_FN = () => Date.parse("2026-08-22T12:00:00Z");

test("a ?page=0 refusal carries the routed headers a success from that route carries", async () => {
  // Route-level refusals must carry the same `Vary` and compatibility-date echo
  // as the `200` beside them. `contract/wire.js` says so on both counts:
  // `ECHOES_COMPATIBILITY_DATE[APP_ERROR]` is `true`, and
  // `VARY_BY_KIND[APP_ERROR]` is the same three lines as the success.
  const { router } = paginatedRouter(Array.from({ length: 2500 }, (_, i) => i));

  const refused = await through(router, { page: "0" }, NOW_FN);
  const served = await through(router, { page: "1" }, NOW_FN);

  assert.equal(refused.status, wire.PAGINATION_ERRORS.belowMinimum.status);
  assert.deepEqual(refused.headers.vary, [...wire.VARY_BY_KIND[wire.KIND.APP_ERROR]]);
  assert.equal(refused.headers["x-compatibility-date"], wire.COMPATIBILITY_DATE);
  assert.equal(wire.ECHOES_COMPATIBILITY_DATE[wire.KIND.APP_ERROR], true, "and that is the observation");

  assert.deepEqual(refused.headers.vary, served.headers.vary, "the route's Vary, not the kind's");
  assert.equal(refused.headers["x-compatibility-date"], served.headers["x-compatibility-date"]);
  assert.equal(refused.headers["content-language"], served.headers["content-language"]);
});

test("and so does the 404 past the last page", async () => {
  // The other refusal `dispatchPaginated` produces, reached from the far side of
  // the snapshot rather than in front of it. The headers do not depend on which.
  const { router } = paginatedRouter(Array.from({ length: 2500 }, (_, i) => i));

  const result = await through(router, { page: "4" }, NOW_FN);

  assert.equal(result.status, wire.PAGINATION_ERRORS.beyondLastPage.status);
  assert.deepEqual(result.headers.vary, [...wire.VARY_BY_KIND[wire.KIND.APP_ERROR]]);
  assert.equal(result.headers["x-compatibility-date"], wire.COMPATIBILITY_DATE);
});

test("the fourth Vary line follows the route onto its refusals too", async () => {
  // The `Vary` rule is the route's, not the status's. The survey is the
  // evidence that it reaches refusals at all: `VARY_LOCALIZED_SURVEY.plain`
  // lists the `400 ?page=0` on `/markets/{region_id}/orders/` by name, so that
  // exact refusal was surveyed and sent the one-line form, which it could only
  // do by sending `Vary`.
  assert.ok(
    wire.VARY_LOCALIZED_SURVEY.plain.includes("/markets/{region_id}/orders"),
    "the surveyed refusal, and the reason this is a rule rather than a guess",
  );

  const plain = paginatedRouter(Array.from({ length: 2500 }, (_, i) => i)).router;
  const localized = paginatedRouter(
    Array.from({ length: 2500 }, (_, i) => i),
    { localizedBody: true },
  ).router;

  assert.deepEqual(
    (await through(plain, { page: "0" }, NOW_FN)).headers.vary,
    [...wire.VARY_BY_KIND[wire.KIND.APP_ERROR]],
    "a body of ids and numbers sends three lines",
  );
  assert.deepEqual(
    (await through(localized, { page: "0" }, NOW_FN)).headers.vary,
    [...wire.VARY_LOCALIZED_BODY],
    "and a body with translated text in it repeats Accept-Language",
  );
});

test("a refusal reports no cache status, because that header is a 2XX's", async () => {
  // The one routed header a refusal does not inherit. `X-Esi-Cache-Status` has
  // been observed on the 2XX of both producers and nowhere else, and `?page=0`
  // is refused before the snapshot is looked up, so there is no hit or miss for
  // it to report.
  const { router } = paginatedRouter(Array.from({ length: 2500 }, (_, i) => i));

  const refused = await through(router, { page: "0" }, NOW_FN);
  const served = await through(router, { page: "1" }, NOW_FN);

  assert.equal(refused.headers["x-esi-cache-status"], undefined);
  assert.equal(served.headers["x-esi-cache-status"], CACHE_STATUS.MISS, "and the success still reports one");
  assert.deepEqual([...wire.INFRASTRUCTURE.cacheStatus.producers], ["gateway", "app"], "on their 2XX");
});

// First acceptance: a sweep under mutation

test("a sweep sees one X-Pages while the game moves underneath it", async () => {
  // The collection here changes between every request (a page is added and one
  // removed), which is the only version of this test that proves anything.
  let items = Array.from({ length: 2500 }, (_, i) => i);
  const { router, calls } = paginatedRouter(() => items.slice());

  let clock = Date.parse("2026-08-22T12:00:00Z");
  const pages = [];

  for (let page = 1; page <= 3; page += 1) {
    items = [...items.slice(1), 90000 + page];
    clock += 1500;
    pages.push(await get(router, { page: String(page) }, () => clock));
  }

  assert.equal(new Set(pages.map((p) => p.headers["x-pages"])).size, 1, "X-Pages moved mid-sweep");
  assert.equal(calls.count, 1, "the collection was resolved once, and sliced three times");
  assert.deepEqual(pages.map((p) => p.body.length), [1000, 1000, 500]);

  // And the pages really are one collection: page 2 continues page 1.
  assert.equal(pages[1].body[0], pages[0].body[999] + 1);
});

test("a sweep sees one Last-Modified, because the snapshot and the window are the same window", async () => {
  // Last-Modified is floored to the route's TTL and the snapshot is keyed on
  // the same value, so the two cannot disagree. That makes the header
  // trustworthy as a torn-read detector.
  let items = Array.from({ length: 2500 }, (_, i) => i);
  const { router } = paginatedRouter(() => items.slice());

  let clock = Date.parse("2026-08-22T12:00:00Z");
  const cached = createCacheDispatch(
    (request) => dispatchRequest(router, request, { now: () => clock, logError: () => {} }),
    { now: () => clock },
  );

  const seen = new Set();
  for (let page = 1; page <= 3; page += 1) {
    items = [...items.slice(1), 90000 + page];
    clock += 1500;
    const result = await cached({ method: "GET", pathname: WIRE_PATH, query: { page: String(page) }, headers: {} });
    seen.add(`${result.headers["last-modified"]} | ${result.headers["x-pages"]}`);
  }

  assert.equal(seen.size, 1, `a sweep saw ${seen.size} (Last-Modified, X-Pages) pairs: ${[...seen]}`);
});

test("each page has its own Etag, because each page is its own representation", async () => {
  // The other half of the observed split: one Last-Modified per resource, one
  // Etag per page. A sweep that saw one etag for three different pages would be
  // a different bug, and a client revalidating page 2 would get page 1.
  const { router } = paginatedRouter(Array.from({ length: 2500 }, (_, i) => i));
  const clock = Date.parse("2026-08-22T12:00:00Z");
  const cached = createCacheDispatch(
    (request) => dispatchRequest(router, request, { now: () => clock, logError: () => {} }),
    { now: () => clock },
  );

  const etags = [];
  for (const page of ["1", "2", "3"]) {
    const result = await cached({ method: "GET", pathname: WIRE_PATH, query: { page }, headers: {} });
    etags.push(result.headers.etag);
  }

  assert.equal(new Set(etags).size, 3, "two pages shared an etag");
  assert.equal(wire.PAGINATION.etagPerPage, true, "the observation this rests on");
  assert.equal(wire.PAGINATION.lastModifiedPerResource, true);
});

test("the snapshot is re-resolved once the window rolls over", async () => {
  // It has to be: a snapshot that outlived its window would serve a body older
  // than the `Expires` on the same response.
  let items = Array.from({ length: 2500 }, (_, i) => i);
  const { router, calls } = paginatedRouter(() => items.slice());

  let clock = Date.parse("2026-08-22T12:00:00Z");
  await get(router, { page: "1" }, () => clock);
  assert.equal(calls.count, 1);

  items = Array.from({ length: 4000 }, (_, i) => i);
  clock += TTL * 1000;
  const after = await get(router, { page: "1" }, () => clock);

  assert.equal(calls.count, 2, "a new window is a new snapshot");
  assert.equal(after.headers["x-pages"], "4", "and it sees the collection that exists now");
});

// X-Esi-Cache-Status

test("the snapshot is the one cache a client is told about, and it is told the truth", async () => {
  // `X-Esi-Cache-Status` reports on a server-side cache, and this store is the
  // only one this replica has. Page 1 resolves the collection and is a miss;
  // every other page of that sweep is answered out of the snapshot. That is what
  // the header exists to say, and the same fact that makes the sweep consistent.
  const { router, calls } = paginatedRouter(Array.from({ length: 2500 }, (_, i) => i));
  const now = () => Date.parse("2026-08-22T12:00:00Z");

  const first = await get(router, { page: "1" }, now);
  const second = await get(router, { page: "2" }, now);
  const again = await get(router, { page: "1" }, now);

  assert.equal(calls.count, 1, "one resolution, three responses");
  assert.equal(first.headers["x-esi-cache-status"], CACHE_STATUS.MISS);
  assert.equal(second.headers["x-esi-cache-status"], CACHE_STATUS.HIT);
  assert.equal(again.headers["x-esi-cache-status"], CACHE_STATUS.HIT);
});

test("a new window is a miss again, because the snapshot did not answer", async () => {
  const { router } = paginatedRouter(Array.from({ length: 2500 }, (_, i) => i));

  let clock = Date.parse("2026-08-22T12:00:00Z");
  await get(router, { page: "1" }, () => clock);
  const hit = await get(router, { page: "2" }, () => clock);

  clock += TTL * 1000;
  const rolled = await get(router, { page: "2" }, () => clock);

  assert.equal(hit.headers["x-esi-cache-status"], CACHE_STATUS.HIT);
  assert.equal(rolled.headers["x-esi-cache-status"], CACHE_STATUS.MISS);
});

// The snapshot store itself

test("the snapshot key ignores page and nothing else", () => {
  // Two pages of one resource are one snapshot; a different region, or a
  // different filter, is a different collection.
  const key = (query, pathParams = { region_id: "10000002" }) =>
    snapshotKey("GetContractsPublicRegionId", pathParams, query);

  assert.equal(key({ page: "1" }), key({ page: "9" }), "page is not part of the resource");
  assert.equal(key({ a: "1", b: "2" }), key({ b: "2", a: "1" }), "order is not either");
  assert.notEqual(key({}), key({}, { region_id: "10000043" }), "but the region is");
  assert.notEqual(key({ type_id: "34" }), key({ type_id: "35" }), "and so is every other parameter");
});

test("a snapshot belongs to one window and is not visible from another", () => {
  const cache = createSnapshotCache();
  cache.set("k", 1000, [1, 2, 3]);

  assert.deepEqual(cache.get("k", 1000), [1, 2, 3]);
  assert.equal(cache.get("k", 2000), undefined, "a later window is a different snapshot");
  assert.equal(cache.get("other", 1000), undefined);
});

test("the store is bounded, and evicts the least recently used", () => {
  // The snapshot holds a resolved collection in the game server's own heap.
  // Bounded deliberately small: the access pattern is a sweep, one resource at a
  // time.
  const cache = createSnapshotCache({ maxEntries: 2 });

  cache.set("a", 1, ["a"]);
  cache.set("b", 1, ["b"]);
  cache.get("a", 1);           // touch: "b" is now the coldest
  cache.set("c", 1, ["c"]);

  assert.equal(cache.size, 2);
  assert.deepEqual(cache.get("a", 1), ["a"], "the touched one survived");
  assert.equal(cache.get("b", 1), undefined, "the coldest was evicted");
  assert.deepEqual(cache.get("c", 1), ["c"]);
});

test("a table with no paginated route holds no snapshots", async () => {
  // The store exists on every router and costs nothing on the tables that do
  // not use it.
  const router = createRouter([{
    method: "GET", path: "/status", name: "GetStatus", handler: () => ({ players: 1 }),
    producer: "gateway", cacheTtl: 30,
  }]);

  await dispatchRequest(router, { method: "GET", pathname: "/latest/status/", query: {} });

  assert.equal(router.snapshots.size, 0);
});
