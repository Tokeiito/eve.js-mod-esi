/**
 * `GET /characters/{character_id}/orders/`,
 * `GET /markets/structures/{structure_id}/` and `GET /industry/systems/`
 * against CCP's pinned spec.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * The three order bodies are not one body with a filter. A character's orders,
 * a structure's book and `/markets/{region_id}/orders/` are not one projection
 * with different `where` clauses, and the document is explicit: the region
 * body carries `system_id`, the character body carries `region_id`, `escrow`
 * and `is_corporation`, and the structure body carries none of those four.
 * `min_volume` and `is_buy_order` are required on the structure body and
 * optional on the character one.
 *
 * So the field sets are read out of the spec here and compared against each
 * other, rather than each projection being checked in isolation against its
 * own schema: a handler that sent the region body under the structure path
 * would satisfy its own field list and still be wrong.
 *
 * The owner is `CHARACTER_ID_FLOOR`, the station is Jita 4-4 and the region is
 * The Forge, both CCP's published static data. The order ids and prices are
 * this test's.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const spec = require(path.join(__dirname, "../contract/openapi.json"));
const {
  assertBody,
  assertRouteMatchesSpec,
  describeOperation,
} = require(path.join(__dirname, "../contract/spec"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const { ownerOrder } = require(path.join(__dirname, "../lib/marketStore"));
const {
  CHARACTER_ORDERS_OPERATION_ID,
  CHARACTER_ORDERS_PATH,
  CHARACTER_ORDERS_SCOPE,
  STRUCTURE_ORDERS_OPERATION_ID,
  STRUCTURE_ORDERS_PATH,
  STRUCTURE_ORDERS_SCOPE,
  buildCharacterOrders,
  buildStructureOrders,
  createCharacterOrdersRoute,
  createStructureOrdersRoute,
} = require(path.join(__dirname, "../routes/orders"));

const OWNER = 90000021;
const STATION = 60003760;
const REGION = 10000002;
const SYSTEM = 30000142;
const STRUCTURE = 1035466617946;

/** Two rows in the daemon's own column spelling: one buy, one sell. */
const ROWS = [
  {
    order_id: 5000000001, owner_id: OWNER, is_corp: 0, station_id: STATION,
    solar_system_id: SYSTEM, region_id: REGION, type_id: 34, price: 5.5,
    vol_entered: 1000, vol_remaining: 750, min_volume: 1, bid: 1,
    range_value: -1, duration_days: 90, escrow: 4125,
    issued_at: "2026-09-16T08:00:00Z",
  },
  {
    order_id: 5000000002, owner_id: OWNER, is_corp: 0, station_id: STATION,
    solar_system_id: SYSTEM, region_id: REGION, type_id: 587, price: 100,
    vol_entered: 3, vol_remaining: 3, min_volume: 1, bid: 0,
    range_value: 32767, duration_days: 30, escrow: 0,
    issued_at: "2026-09-16T09:30:15Z",
  },
];

const ORDERS = ROWS.map((row) => ownerOrder(row));

function marketDouble({ reason = null, orders = ORDERS } = {}) {
  return {
    readOwnerOrders: () => ({ orders, reason }),
    readStructureOrders: () => ({ orders, reason }),
  };
}

const deps = (options) => ({ market: marketDouble(options), runtime: {} });

const characterOrders = (options) =>
  buildCharacterOrders({ credential: { characterId: OWNER } }, deps(options));

const structureOrders = (options) =>
  buildStructureOrders({ path: { structure_id: String(STRUCTURE) } }, deps(options));

const onTheWire = (body) => JSON.parse(serializeBody(body, "app").toString("utf8"));

function resolveRef(node) {
  return node && node.$ref ? spec.components.schemas[node.$ref.split("/").pop()] : node;
}

function fieldsOf(specPath) {
  const schema = resolveRef(
    spec.paths[specPath].get.responses["200"].content["application/json"].schema,
  );
  const item = resolveRef(schema.items);
  return { all: Object.keys(item.properties), required: new Set(item.required || []) };
}

// The three bodies are genuinely different

test("the three order bodies disagree about four fields, and the document says so", () => {
  const character = fieldsOf("/characters/{character_id}/orders");
  const structure = fieldsOf("/markets/structures/{structure_id}");
  const region = fieldsOf("/markets/{region_id}/orders");

  // The region body is the only one with system_id.
  assert.ok(region.all.includes("system_id"));
  assert.ok(!character.all.includes("system_id"));
  assert.ok(!structure.all.includes("system_id"));

  // The character body is the only one with these three.
  for (const field of ["region_id", "escrow", "is_corporation"]) {
    assert.ok(character.all.includes(field), `character body should carry ${field}`);
    assert.ok(!structure.all.includes(field), `structure body should not carry ${field}`);
  }

  // And the two disagree about which fields are required.
  assert.ok(structure.required.has("min_volume") && structure.required.has("is_buy_order"));
  assert.ok(!character.required.has("min_volume") && !character.required.has("is_buy_order"));
});

// The route table

test("both descriptors agree with the pinned spec", () => {
  const character = assertRouteMatchesSpec(createCharacterOrdersRoute(deps()));
  assert.equal(character.operationId, CHARACTER_ORDERS_OPERATION_ID);
  assert.deepEqual(character.scopes, [CHARACTER_ORDERS_SCOPE]);

  const structure = assertRouteMatchesSpec(createStructureOrdersRoute(deps()));
  assert.equal(structure.operationId, STRUCTURE_ORDERS_OPERATION_ID);
  assert.deepEqual(structure.scopes, [STRUCTURE_ORDERS_SCOPE]);
});

test("neither publishes a rate-limit group, so both are on the error budget", () => {
  // market-order is published on /markets/{region_id}/orders/ and on neither of
  // these, which is a reading of the document rather than an omission.
  for (const p of ["/characters/{character_id}/orders", "/markets/structures/{structure_id}"]) {
    assert.equal(spec.paths[p].get["x-rate-limit"], undefined);
  }
  assert.equal(createCharacterOrdersRoute(deps()).rateLimitGroup, null);
  assert.equal(createStructureOrdersRoute(deps()).rateLimitGroup, null);
});

test("the character route does not paginate and the structure route does", () => {
  // The same asymmetry the industry pair has, in the same direction.
  assert.equal(describeOperation("get", CHARACTER_ORDERS_PATH).queryParameters.page, undefined);
  assert.notEqual(describeOperation("get", STRUCTURE_ORDERS_PATH).queryParameters.page, undefined);

  assert.equal(createCharacterOrdersRoute(deps()).pageSize, undefined);
  assert.equal(createStructureOrdersRoute(deps()).pageSize, 1000);
});

// A pilot's own orders

test("the character body satisfies the spec and is in the schema's key order", () => {
  const body = characterOrders();

  assertBody(onTheWire(body), describeOperation("get", CHARACTER_ORDERS_PATH));
  assert.deepEqual(Object.keys(body[0]), [
    "duration",
    "escrow",
    "is_buy_order",
    "is_corporation",
    "issued",
    "location_id",
    "min_volume",
    "order_id",
    "price",
    "range",
    "region_id",
    "type_id",
    "volume_remain",
    "volume_total",
  ]);
});

test("a buy order reports its range, escrow and remaining volume", () => {
  const [buy] = characterOrders();

  assert.equal(buy.order_id, 5000000001);
  assert.equal(buy.is_buy_order, true);
  assert.equal(buy.is_corporation, false);
  // range_value -1 is CCP's sentinel for a station-range buy order.
  assert.equal(buy.range, "station");
  assert.equal(buy.volume_remain, 750);
  assert.equal(buy.volume_total, 1000);
  assert.equal(buy.region_id, REGION);
});

test("a sell order reports region range and a zero escrow rather than omitting it", () => {
  // A declared optional field carrying a stored value is not a fabrication, and
  // a client reading order.escrow gets a number rather than undefined (see the
  // route header).
  const sell = characterOrders()[1];

  assert.equal(sell.is_buy_order, false);
  assert.equal(sell.range, "region");
  assert.equal(onTheWire(characterOrders())[1].escrow, 0);
  assert.ok(Object.prototype.hasOwnProperty.call(sell, "min_volume"));
});

test("prices reach the wire as doubles, even when they are integral", () => {
  const bytes = serializeBody(characterOrders(), "app").toString("utf8");
  // The sell order's price is exactly 100, which JSON.stringify writes as 100
  // and CCP writes as 100.0.
  assert.match(bytes, /"price":100\.0/);
  assert.match(bytes, /"escrow":0\.0/);
});

test("the issued timestamp is second-precision, with no fraction", () => {
  for (const order of characterOrders()) {
    assert.match(order.issued, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }
});

test("a pilot with no orders gets an empty list", () => {
  const body = characterOrders({ orders: [] });
  assert.deepEqual(body, []);
  assertBody(body, describeOperation("get", CHARACTER_ORDERS_PATH));
});

test("an unreadable order book is a refusal, never an empty list", () => {
  // A pilot reading [] for their own orders acts on it, and a trading tool
  // places duplicates (see the route header).
  assert.throws(
    () => characterOrders({ reason: "no market database" }),
    /could not be read/,
  );
});

test("the handler refuses to run without a verified credential", () => {
  assert.throws(() => buildCharacterOrders({}, deps()), /no verified credential/);
});

// A structure's book

test("the structure body satisfies the spec and carries eleven fields", () => {
  const body = structureOrders();

  assertBody(onTheWire(body), describeOperation("get", STRUCTURE_ORDERS_PATH));
  assert.deepEqual(Object.keys(body[0]), [
    "duration",
    "is_buy_order",
    "issued",
    "location_id",
    "min_volume",
    "order_id",
    "price",
    "range",
    "type_id",
    "volume_remain",
    "volume_total",
  ]);
});

test("the structure body carries none of the character body's four extras", () => {
  const row = structureOrders()[0];
  for (const field of ["region_id", "escrow", "is_corporation", "system_id"]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(row, field), `carries ${field}`);
  }
});

test("min_volume and is_buy_order are always present, because they are required here", () => {
  for (const row of structureOrders()) {
    assert.equal(typeof row.min_volume, "number");
    assert.equal(typeof row.is_buy_order, "boolean");
  }
});

test("a structure id that is not canonical is unreachable, and says so", () => {
  // The subject check refuses one before a handler runs; this asserts the
  // handler does not quietly proceed if it ever stops doing that.
  assert.throws(
    () => buildStructureOrders({ path: { structure_id: "abc" } }, deps()),
    /lost its subject/,
  );
});

// The ACL, through the router

test("a caller whose corporation owns the structure is let through", async () => {
  const runtime = {
    peekCharacterRecord: (id, { project }) => project({ corporationID: 98000000 }),
    peekStructureRecord: () => ({ ownerCorpID: 98000000 }),
    listCorporationStructures: () => [],
  };

  const router = createRouter([
    createStructureOrdersRoute({ market: marketDouble(), runtime }),
  ]);
  const result = await dispatchRequest(
    router,
    {
      method: "GET",
      pathname: `/latest${STRUCTURE_ORDERS_PATH.replace(":structure_id", String(STRUCTURE))}`,
      query: {},
      headers: {},
      credential: {
        presented: true,
        claims: Object.freeze({ characterId: OWNER, scopes: Object.freeze([STRUCTURE_ORDERS_SCOPE]) }),
        refusal: null,
      },
    },
    { logError: () => {} },
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers["x-pages"], "1");
});

test("a caller whose corporation does not own it is refused, loudly", async () => {
  // A logged 500 rather than a 403, the same bargain /universe/structures/{id}/
  // takes: the read is refused either way, and only the status is wrong,
  // because CCP's refusal has never been seen.
  const runtime = {
    peekCharacterRecord: (id, { project }) => project({ corporationID: 98000000 }),
    peekStructureRecord: () => ({ ownerCorpID: 98000999 }),
    listCorporationStructures: () => [],
  };

  const logged = [];
  const router = createRouter([
    createStructureOrdersRoute({ market: marketDouble(), runtime }),
  ]);
  const result = await dispatchRequest(
    router,
    {
      method: "GET",
      pathname: `/latest${STRUCTURE_ORDERS_PATH.replace(":structure_id", String(STRUCTURE))}`,
      query: {},
      headers: {},
      credential: {
        presented: true,
        claims: Object.freeze({ characterId: OWNER, scopes: Object.freeze([STRUCTURE_ORDERS_SCOPE]) }),
        refusal: null,
      },
    },
    { logError: (message) => logged.push(message) },
  );

  assert.equal(result.status, 500);
  assert.equal(logged.length, 1, "and the operator sees why");
});

// GET /industry/systems/

const {
  COST_INDEX_ACTIVITIES,
  INDUSTRY_SYSTEMS_OPERATION_ID,
  INDUSTRY_SYSTEMS_PATH,
  buildIndustrySystems,
  clearIndustrySystemsCache,
  createIndustrySystemsRoute,
} = require(path.join(__dirname, "../routes/industry"));

/** The flat index `config/mining.json` ships with. */
const COST_INDEX = 0.04;

const systemsDeps = (options = {}) => ({
  store: { systemIds: () => options.ids || [30000142, 30000144, 31000001] },
  costIndex: options.costIndex === undefined ? () => COST_INDEX : options.costIndex,
});

function industrySystems(options) {
  // The route memoises for the life of the process, so every test starts clean.
  clearIndustrySystemsCache();
  return buildIndustrySystems({}, systemsDeps(options));
}

test("the industry systems descriptor agrees with the pinned spec", () => {
  clearIndustrySystemsCache();
  const contract = assertRouteMatchesSpec(createIndustrySystemsRoute(systemsDeps()));

  assert.equal(contract.operationId, INDUSTRY_SYSTEMS_OPERATION_ID);
  assert.deepEqual(contract.scopes, [], "public");
  assert.equal(contract.cacheAgeSeconds, 3600);
  assert.equal(contract.rateLimit.group, "industry");
});

test("it declares no page parameter, so it returns the whole cluster", () => {
  assert.equal(describeOperation("get", INDUSTRY_SYSTEMS_PATH).queryParameters.page, undefined);
  clearIndustrySystemsCache();
  assert.equal(createIndustrySystemsRoute(systemsDeps()).pageSize, undefined);
});

test("the body satisfies the spec and is in the schema's key order", () => {
  const body = industrySystems();

  assertBody(onTheWire(body), describeOperation("get", INDUSTRY_SYSTEMS_PATH));
  assert.deepEqual(Object.keys(body[0]), ["cost_indices", "solar_system_id"]);
  assert.deepEqual(Object.keys(body[0].cost_indices[0]), ["activity", "cost_index"]);
});

test("every activity name is one CCP publishes, and there are six of them", () => {
  // The pairing of an eve.js activity id to an ESI name is what
  // COST_INDEX_ACTIVITIES is for, so it is checked against the document.
  const schema = resolveRef(
    spec.paths["/industry/systems"].get.responses["200"].content["application/json"].schema,
  );
  const item = resolveRef(schema.items);
  const published = resolveRef(resolveRef(item.properties.cost_indices).items)
    .properties.activity.enum;

  assert.equal(COST_INDEX_ACTIVITIES.length, 6);
  for (const row of COST_INDEX_ACTIVITIES) {
    assert.ok(published.includes(row.activity), `${row.activity} is not in CCP's enum`);
  }

  // And the four this server has no activity for are absent on purpose.
  const sent = new Set(COST_INDEX_ACTIVITIES.map((row) => row.activity));
  const missing = published.filter((name) => !sent.has(name)).sort();
  assert.deepEqual(missing, [
    "duplicating",
    "none",
    "researching_technology",
    "reverse_engineering",
  ]);
});

test("the activity ids are eve.js's six INDUSTRY_ACTIVITY values", () => {
  assert.deepEqual(
    COST_INDEX_ACTIVITIES.map((row) => row.activityId).sort((a, b) => a - b),
    [1, 3, 4, 5, 8, 9],
  );
});

test("activities come out alphabetically, which is the enum's own order", () => {
  const names = industrySystems()[0].cost_indices.map((row) => row.activity);
  assert.deepEqual(names, [...names].sort());
});

test("every system reports the game's configured index, and that is the divergence", () => {
  // Upstream's own header calls this an "Option A static approximation" and its
  // resolveSystemCostIndex ignores both of its arguments. Publishing anything
  // else would disagree with what this server's job quotes actually charge.
  const body = industrySystems();

  assert.equal(body.length, 3);
  for (const system of body) {
    for (const entry of system.cost_indices) {
      assert.equal(onTheWire(body)[0].cost_indices[0].cost_index, COST_INDEX);
      assert.equal(entry.cost_index[Object.getOwnPropertySymbols(entry.cost_index)[0]], COST_INDEX);
    }
  }
});

test("systems come out ascending, which the Etag needs to be stable", () => {
  const ids = industrySystems({ ids: [31000001, 30000142, 30000144] }).map((s) => s.solar_system_id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});

test("the cost index reaches the wire as a double", () => {
  clearIndustrySystemsCache();
  const bytes = serializeBody(industrySystems(), "app").toString("utf8");
  assert.match(bytes, /"cost_index":0\.04/);

  // And an integral one is not written as an integer.
  clearIndustrySystemsCache();
  const whole = serializeBody(industrySystems({ costIndex: () => 1 }), "app").toString("utf8");
  assert.match(whole, /"cost_index":1\.0/);
});

test("an index the game cannot supply is a refusal, never a body of zeroes", () => {
  // A zero everywhere would tell an industry tool that every job is free.
  assert.throws(
    () => industrySystems({ costIndex: () => null }),
    /cannot read the game's industrySystemCostIndex/,
  );
});

test("a missing universe store is a programming error naming what to inject", () => {
  clearIndustrySystemsCache();
  assert.throws(() => buildIndustrySystems({}, {}), /no universe store/);
});

test("the body is built once and reused", () => {
  clearIndustrySystemsCache();
  let reads = 0;
  const deps = { store: { systemIds: () => { reads += 1; return [30000142]; } }, costIndex: () => COST_INDEX };

  for (let i = 0; i < 20; i += 1) buildIndustrySystems({}, deps);
  assert.equal(reads, 1, "8,490 systems must not be rebuilt per request");

  clearIndustrySystemsCache();
  buildIndustrySystems({}, deps);
  assert.equal(reads, 2, "and clearing the memo rebuilds it");
});
