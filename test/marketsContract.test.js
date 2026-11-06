/**
 * The two market endpoints, against CCP's pinned spec and a fixture order book.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * The fixture follows the daemon's schema. `lib/marketStore.js` reads a database
 * this repository does not own, so the thing under test is the mapping, and a
 * fixture shaped like the real tables is the only way to test it without a
 * market daemon. The column names and types are `pragma table_info` output from
 * the live `market.sqlite`, transcribed in `test/marketFixture.js`. If the
 * daemon renames a column, these tests keep passing and production breaks.
 * `test/marketSchemaDrift.test.js` bounds that: it compares this transcription,
 * and the columns `lib/marketStore.js` reads, against a real database when one
 * is reachable.
 *
 * ESI requires twelve fields on an order and the seeded tables carry eight.
 * `order_id` is the one that matters, because a client keys on it and
 * market-hub-seed sweeps hundreds of pages, so it has its own tests for
 * stability and for not colliding with a player-placed order's real id.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const wire = require(path.join(__dirname, "../contract/wire"));
const { assertBody, describeOperation } = require(path.join(__dirname, "../contract/spec"));
const golden = require(path.join(__dirname, "../contract/golden"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const {
  SEEDED_BUY_BASE,
  SEEDED_SELL_BASE,
  readPrices,
  readRegionOrders,
} = require(path.join(__dirname, "../lib/marketStore"));
const {
  ORDERS_CACHE_TTL_SECONDS,
  ORDERS_PAGE_SIZE,
  ORDERS_RATE_LIMIT_GROUP,
  PRICES_CACHE_TTL_SECONDS,
  PRICES_RATE_LIMIT_GROUP,
  PRODUCER,
  createMarketPricesRoute,
  createMarketRegionOrdersRoute,
  markOrderDoubles,
  markPriceDoubles,
  parseRegionId,
  parseTypeId,
} = require(path.join(__dirname, "../routes/markets"));

const REGION = 10000002;
const OTHER_REGION = 10000033;

/**
 * The daemon's schema, transcribed from `pragma table_info`. It is shared
 * because `marketSweepContract.test.js` and `marketSchemaDrift.test.js` need the
 * same tables, and two transcriptions of a schema none of them owns would be two
 * things to update.
 */
const { MARKET_SCHEMA: SCHEMA } = require(path.join(__dirname, "marketFixture"));

/** A fixture book on disk, torn down with the test. */
function fixtureDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esi-market-"));
  const file = path.join(dir, "market.sqlite");
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  db.exec(`
    insert into seed_stock values
      (60003760, 30000142, 20000020, ${REGION}, 34, 5.5, 100, 250, 1, '2026-08-18T13:04:21.322138519Z'),
      (60003760, 30000142, 20000020, ${REGION}, 35, 9.0, 10, 10, 1, '2026-08-18T13:04:21.000Z'),
      (60000004, 30002780, 20000407, ${OTHER_REGION}, 34, 3.75, 7, 7, 1, '2026-08-18T13:04:21.000Z');
    insert into seed_buy_orders values
      (60003760, 30000142, 20000020, ${REGION}, 34, 4.1, 60, 60, 1, '2026-08-18T13:04:21.000Z');
    insert into market_orders values
      (7401897984, 90001, 0, 0, 60003760, 30000142, 20000020, ${REGION}, 34, 250000.0,
       1000, 900, 1, 0, 32767, 90, 0, 'active', 'player', '2026-08-16T14:07:04Z',
       '2026-08-16T14:07:04Z', '2026-08-16T14:07:04Z'),
      (7401897985, 90001, 0, 0, 60003760, 30000142, 20000020, ${REGION}, 34, 1.0,
       5, 5, 1, 0, -1, 30, 0, 'cancelled', 'player', '2026-08-16T14:07:04Z',
       '2026-08-16T14:07:04Z', '2026-08-16T14:07:04Z');
    insert into market_types values
      (34, 18, 4, 1857, 'Tritanium', 'Mineral', 6.05, 0.01, 1, 1),
      (35, 18, 4, 1857, 'Pyerite', 'Mineral', 0, 0.01, 1, 1),
      (36, 18, 4, 1857, 'Unpublished', 'Mineral', 1.0, 0.01, 1, 0),
      -- Both of this one's numbers are whole, which is the case the wire cares
      -- about: an appended .0 is the whole difference between our bytes and
      -- CCP's, and Tritanium's 6.05 and 4.5 would render the same either way.
      (37, 18, 4, 1857, 'Isogen', 'Mineral', 100, 0.01, 1, 1);
    insert into region_summaries values
      (${REGION}, 34, 5.5, 100, 60003760, 4.1, 60, 60003760, '2026-08-18T13:04:21.000Z'),
      (${REGION}, 37, 8.0, 3, 60003760, null, 0, null, '2026-08-18T13:04:21.000Z'),
      (${OTHER_REGION}, 34, 3.5, 7, 60000004, null, 0, null, '2026-08-18T13:04:21.000Z');
  `);

  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

const ordersOf = (db, opts) => readRegionOrders(REGION, { db, ...opts }).orders;

// The contract

test("an order satisfies the spec, every required field present", (t) => {
  const db = fixtureDb(t);
  const orders = ordersOf(db);

  assertBody(orders, describeOperation("get", "/markets/10000002/orders/"));
  assert.ok(orders.length > 0, "the fixture produced no orders to check");
});

test("a price row satisfies the spec, and omits what it cannot know", (t) => {
  const db = fixtureDb(t);
  const { prices } = readPrices({ db });

  assertBody(prices, describeOperation("get", "/markets/prices/"));

  const tritanium = prices.find((p) => p.type_id === 34);
  assert.equal(tritanium.adjusted_price, 6.05, "the SDE's base_price");
  assert.equal(tritanium.average_price, 4.5, "mean best ask across two regions");

  const pyerite = prices.find((p) => p.type_id === 35);
  assert.equal("adjusted_price" in pyerite, false, "base_price 0 is not a price, so it is omitted");
  assert.equal("average_price" in pyerite, false, "and no region quotes it");

  assert.equal(prices.find((p) => p.type_id === 36), undefined, "unpublished types are not on the market");
});

test("the routes declare the TTL, group and producer the spec and the wire say", () => {
  const prices = createMarketPricesRoute();
  const orders = createMarketRegionOrdersRoute();

  assert.equal(prices.cacheTtl, describeOperation("get", "/markets/prices/").cacheAgeSeconds);
  assert.equal(prices.cacheTtl, PRICES_CACHE_TTL_SECONDS);
  assert.equal(prices.rateLimitGroup, PRICES_RATE_LIMIT_GROUP);
  assert.equal(prices.rateLimitGroup, null, "no x-rate-limit in the spec, so the error limiter answers");

  assert.equal(orders.cacheTtl, describeOperation("get", "/markets/10000002/orders/").cacheAgeSeconds);
  assert.equal(orders.cacheTtl, ORDERS_CACHE_TTL_SECONDS);
  assert.equal(orders.rateLimitGroup, ORDERS_RATE_LIMIT_GROUP);
  assert.equal(orders.pageSize, wire.PAGINATION.pageSize, "1000, counted off page 1 of The Forge");

  for (const route of [prices, orders]) {
    assert.equal(route.producer, "app");
  }
  assert.equal(wire.SUCCESS_KIND["/markets/prices"], wire.KIND.APP_SUCCESS);
  assert.equal(wire.SUCCESS_KIND["/markets/:region_id/orders"], wire.KIND.APP_SUCCESS);
});

// The mapping

test("a seeded sell row becomes an ESI order", (t) => {
  const db = fixtureDb(t);
  // By id band, not by type: the fixture's player order is also a type-34 sell,
  // and picking the first match found that one instead. A client keying on
  // (station, type) would hit the same ambiguity.
  const order = ordersOf(db, { orderType: "sell" })
    .find((o) => o.type_id === 34 && o.order_id > SEEDED_SELL_BASE);

  assert.deepEqual(order, {
    duration: 90,
    is_buy_order: false,
    issued: "2026-08-18T13:04:21Z",
    location_id: 60003760,
    min_volume: 1,
    order_id: SEEDED_SELL_BASE + 60003760 * 1_000_000 + 34,
    price: 5.5,
    range: "region",
    system_id: 30000142,
    type_id: 34,
    volume_remain: 100,
    volume_total: 250,
  });
  assert.equal(order.issued.endsWith("Z"), true, "seconds, not the daemon's nanoseconds");
});

test("our orders carry CCP's fields, in CCP's order, against CCP's own bytes", (t) => {
  // The recording is Derelik, one type, six orders (three buy, three sell). It
  // cannot be an `assertGolden` diff: a private server's order book is not CCP's
  // and no fixture reproduces those values. It can be compared on the part that
  // is not values: the field set and the order the keys come out in, which is
  // what a client parsing the bytes sees. `test/serialize.test.js` fails if a
  // recording goes unread.
  const { bytes, entry, value: recordedOrders } = golden.loadGolden("GetMarketsRegionIdOrders");
  const db = fixtureDb(t);

  assert.ok(Array.isArray(recordedOrders) && recordedOrders.length > 0, "the recording is a list");
  assertBody(recordedOrders, describeOperation("get", "/markets/10000002/orders/"));

  const recordedBuy = recordedOrders.find((order) => order.is_buy_order === true);
  const recordedSell = recordedOrders.find((order) => order.is_buy_order === false);
  assert.ok(recordedBuy && recordedSell, "the recording has both sides");

  const ours = ordersOf(db);
  const ourBuy = ours.find((order) => order.is_buy_order === true);
  const ourSell = ours.find((order) => order.is_buy_order === false);

  // Key order, not just membership: `lib/serialize.js` emits keys in insertion
  // order, so a field built in the wrong place moves a byte in every order of
  // every page while every schema check still passes.
  assert.deepEqual(Object.keys(ourSell), Object.keys(recordedSell), "sell side");
  assert.deepEqual(Object.keys(ourBuy), Object.keys(recordedBuy), "buy side");
  assert.deepEqual(
    Object.keys(recordedSell),
    [...Object.keys(recordedSell)].sort(),
    "CCP's serializer emits them alphabetically, which is why ours builds them that way",
  );

  // The last byte is the producer's signature: the application sends no
  // trailing newline.
  assert.equal(entry.producer, "app");
  assert.notEqual(bytes[bytes.length - 1], 0x0a);
});

// The doubles, which a parsed comparison cannot see

test("CCP's own recording writes every price with a decimal point", () => {
  // `GetMarketsRegionIdOrders`'s diff kind is `shape` (field set, key order,
  // last byte), so no golden diff looks at a value, and `JSON.parse` flattens the
  // difference anyway: `170000000.0` and `170000000` are the same number.
  //
  // Read off the bytes, and as a rule over all six orders rather than one
  // hard-coded price, so a re-recording keeps proving it.
  const { bytes } = golden.loadGolden("GetMarketsRegionIdOrders");
  const prices = bytes.toString("utf8").match(/"price":[^,}]+/g);

  assert.equal(prices.length, 6, "the recording is six orders");
  for (const price of prices) {
    assert.match(price, /^"price":-?\d+\.\d/, `${price} reached the wire without a point`);
  }
  assert.equal(wire.DOUBLE_RENDERING.observed.includes("price"), true);
  assert.equal(wire.DOUBLE_RENDERING.minimumDecimals, 1);
  assert.equal("price" in wire.DOUBLE_RENDERING.fixed, false, "shortest form, not a fixed scale");
});

test("an order's price reaches the wire with a decimal point", (t) => {
  const db = fixtureDb(t);
  const bytes = serializeBody(markOrderDoubles(ordersOf(db)), PRODUCER).toString("utf8");

  // The fixture's three prices: one whole, one fractional, one large and whole.
  assert.match(bytes, /"price":9\.0,/, "a whole price gains the point CCP writes");
  assert.match(bytes, /"price":250000\.0,/, "and so does a large one");
  assert.match(bytes, /"price":5\.5,/, "a fractional price is already shortest-form");
  assert.equal(bytes.includes('"price":9,'), false, "never the bare integer");

  // Marking must not move a key. `price` sits between `order_id` and `range`,
  // where CCP's alphabetical serializer puts it.
  assert.match(bytes, /"order_id":\d+,"price":[\d.]+,"range":/);
});

test("both price fields on a price row reach the wire as doubles", (t) => {
  const db = fixtureDb(t);
  const rows = markPriceDoubles(readPrices({ db }).prices);
  const bytes = serializeBody(rows, PRODUCER).toString("utf8");

  // Type 37 is the row whose base_price and only best ask are both whole.
  assert.match(bytes, /"adjusted_price":100\.0,/);
  assert.match(bytes, /"average_price":8\.0}/);
  // Tritanium's two, which the marking must leave alone.
  assert.match(bytes, /"adjusted_price":6\.05,/);
  assert.match(bytes, /"average_price":4\.5}/);

  // An omitted optional stays omitted: marking a field that is not there would
  // put `null` on a row for a type this replica has no number for.
  const pyerite = JSON.parse(bytes).find((row) => row.type_id === 35);
  assert.deepEqual(Object.keys(pyerite), ["type_id"]);

  // The serialized body is still the body the spec describes: a marker object is
  // not a number until `serializeBody` renders it, which is why this parses
  // first, as test/entitiesContract.test.js does.
  assertBody(JSON.parse(bytes), describeOperation("get", "/markets/prices/"));
});

test("a player order keeps its real id and its own range and duration", (t) => {
  const db = fixtureDb(t);
  const placed = ordersOf(db).find((o) => o.order_id === 7401897984);

  assert.equal(placed.range, "region", "range_value 32767");
  assert.equal(placed.duration, 90);
  assert.equal(placed.volume_remain, 900);
  assert.equal(placed.volume_total, 1000);
  assert.equal(placed.is_buy_order, false, "bid = 0, like the sample row CCP served");
});

test("a cancelled order is not on the market", (t) => {
  const db = fixtureDb(t);
  assert.equal(ordersOf(db).some((o) => o.order_id === 7401897985), false);
});

// order_id

test("order_id is stable, unique, and does not collide with a real one", (t) => {
  const db = fixtureDb(t);
  const orders = ordersOf(db);
  const ids = orders.map((o) => o.order_id);

  assert.equal(new Set(ids).size, ids.length, "two orders shared an id");
  assert.deepEqual(ids, ordersOf(db).map((o) => o.order_id), "and the ids move between reads");

  // The buy and sell sides of the same (station, type) are different orders and
  // must not share an id, which is why there are two bases.
  const sell = orders.find((o) => o.type_id === 34 && !o.is_buy_order && o.order_id > SEEDED_SELL_BASE);
  const buy = orders.find((o) => o.type_id === 34 && o.is_buy_order && o.order_id > SEEDED_SELL_BASE);
  assert.notEqual(sell.order_id, buy.order_id);
  assert.ok(buy.order_id > SEEDED_BUY_BASE, "and the buy side is in its own band");

  for (const id of ids) {
    assert.ok(Number.isSafeInteger(id), `${id} does not survive JSON`);
  }
  assert.ok(Math.max(...ids) < Number.MAX_SAFE_INTEGER);
});

// Filtering

test("order_type selects a side, and all is both plus the player orders", (t) => {
  const db = fixtureDb(t);

  assert.equal(ordersOf(db, { orderType: "sell" }).every((o) => !o.is_buy_order), true);
  assert.equal(ordersOf(db, { orderType: "buy" }).every((o) => o.is_buy_order), true);
  assert.equal(
    ordersOf(db, { orderType: "all" }).length,
    ordersOf(db, { orderType: "sell" }).length + ordersOf(db, { orderType: "buy" }).length,
  );
});

test("type_id narrows, and another region's orders never appear", (t) => {
  const db = fixtureDb(t);

  assert.equal(ordersOf(db, { typeId: 34 }).every((o) => o.type_id === 34), true);
  assert.equal(ordersOf(db, { typeId: 35 }).length, 1);
  assert.equal(
    readRegionOrders(OTHER_REGION, { db }).orders.every((o) => o.system_id === 30002780),
    true,
    "the other region's one row, and nothing from The Forge",
  );
});

test("the collection has one total order, so a sweep sees one sequence", (t) => {
  const db = fixtureDb(t);
  const ids = ordersOf(db).map((o) => o.order_id);

  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "not whatever SQLite happened to return");
});

// Refusals and absence

test("a region id that is not a positive integer is refused before any query", () => {
  for (const bad of ["abc", "-1", "0", "1.5", "", "1e5"]) {
    assert.equal(parseRegionId(bad), null, `${JSON.stringify(bad)} parsed`);
  }
  assert.equal(parseRegionId("10000002"), 10000002);

  assert.equal(parseTypeId(undefined), null, "absent is not a filter");
  assert.equal(parseTypeId("abc"), null, "and an unusable one is ignored, not refused");
  assert.equal(parseTypeId("34"), 34);
});

test("no market daemon is an empty market with a reason, never a throw", () => {
  const missing = readRegionOrders(REGION, { db: null, path: "/nowhere/market.sqlite" });
  assert.deepEqual(missing.orders, []);
  assert.ok(typeof missing.reason === "string" && missing.reason.length > 0);
});

// Through the router

test("the region route paginates through the framework, not the handler", async (t) => {
  const db = fixtureDb(t);
  const route = createMarketRegionOrdersRoute();
  // Page size of two, so three orders make two pages without a fixture of 1001.
  // Goes through `markOrderDoubles`, as `buildRegionOrders` does: the marking is
  // what the framework then slices, and a marker that did not survive the slice
  // would be a page of orders serialized as strings rather than numbers.
  const router = createRouter([
    { ...route, pageSize: 2, handler: () => markOrderDoubles(ordersOf(db)) },
  ]);

  const page1 = await dispatchRequest(router, {
    method: "GET",
    pathname: "/latest/markets/10000002/orders/",
    query: { order_type: "all", page: "1" },
  });
  const page2 = await dispatchRequest(router, {
    method: "GET",
    pathname: "/latest/markets/10000002/orders/",
    query: { order_type: "all", page: "2" },
  });

  assert.equal(page1.status, 200);
  assert.equal(page1.headers["x-pages"], "2");
  assert.equal(page2.headers["x-pages"], "2", "X-Pages agrees across the sweep");
  assert.equal(page1.body.length, 2);
  assert.equal(page1.producer, "app");

  const swept = [...page1.body, ...page2.body].map((o) => o.order_id);
  assert.equal(new Set(swept).size, swept.length, "a page boundary duplicated an order");

  assert.match(
    serializeBody(page1.body, page1.producer).toString("utf8"),
    /"price":\d+\.\d/,
    "and the price still reaches the wire as a double",
  );
});

test("every version prefix reaches both routes", async () => {
  const router = createRouter([createMarketPricesRoute(), createMarketRegionOrdersRoute()]);

  for (const prefix of wire.VERSION_PREFIXES) {
    assert.equal(
      router.resolve("GET", `/${prefix}/markets/prices/`).outcome,
      "matched",
      `/${prefix}/markets/prices/ did not resolve`,
    );
    assert.equal(
      router.resolve("GET", `/${prefix}/markets/10000002/orders/`).outcome,
      "matched",
    );
  }
  assert.deepEqual(
    router.resolve("GET", "/latest/markets/10000002/orders/").pathParams,
    { region_id: "10000002" },
  );
});
