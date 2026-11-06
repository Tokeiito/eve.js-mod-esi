/**
 * `GET /characters/{character_id}/assets/` against CCP's pinned spec, and
 * `lib/assetStore.js` against the `items` table's three-valued `singleton`.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * The fixture transcribes the table's own conventions. The failure no schema
 * check would catch is in the `singleton` / `quantity` / `stacksize` triple,
 * because eve.js writes the three together and they are never independent:
 *
 *   singleton 0   quantity units   stacksize units   a stack
 *   singleton 1   quantity -1      stacksize 1       an assembled singleton
 *   singleton 2   quantity -2      stacksize 1       a blueprint copy
 *
 * `services/inventory/itemStore.js` `normalizeInventoryItem` writes exactly
 * that, and its comment on `isBlueprintCopyInventoryItem` states the third row
 * in words. So the fixture carries all three shapes, with the negative
 * quantities spelled out, because a row invented as `{quantity: 1, singleton:
 * 1}` would pass every assertion here and exist nowhere in the game.
 *
 * The owner is `CHARACTER_ID_FLOOR`, eve.js's own first allocated character id,
 * and the item ids are `ITEM_ID_FLOOR`-shaped. Station and system ids are CCP's
 * published static data.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const {
  assertBody,
  assertRouteMatchesSpec,
  describeOperation,
} = require(path.join(__dirname, "../contract/spec"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const { createAssetStore, LOCATION_TYPE } = require(path.join(__dirname, "../lib/assetStore"));
const {
  ASSETS_PAGE_SIZE,
  CHARACTER_ASSETS_OPERATION_ID,
  CHARACTER_ASSETS_PATH,
  CHARACTER_ASSETS_SCOPE,
  PRODUCER,
  buildCharacterAssets,
  createCharacterAssetsRoute,
} = require(path.join(__dirname, "../routes/assets"));

/** eve.js's `CHARACTER_ID_FLOOR`. Synthetic. */
const OWNER = 90000021;
const OTHER_OWNER = 90000022;

/** Jita 4-4 and Jita, CCP's static data. */
const STATION = 60003760;
const SYSTEM = 30000142;

const SHIP = 1990000001;
const CONTAINER = 1990000002;
const STRUCTURE = 1035466617946;

/**
 * The `items` table, in its three shapes plus the ones that exercise
 * `location_type`.
 */
const ITEMS = {
  // A stack in a station hangar.
  1990000010: {
    itemID: 1990000010, typeID: 34, ownerID: OWNER, locationID: STATION,
    flagID: 4, quantity: 5000, stacksize: 5000, singleton: 0, categoryID: 4,
  },
  // An assembled ship in the same hangar: quantity -1, stacksize 1.
  [SHIP]: {
    itemID: SHIP, typeID: 587, ownerID: OWNER, locationID: STATION,
    flagID: 4, quantity: -1, stacksize: 1, singleton: 1, categoryID: 6,
  },
  // A module fitted to that ship: located in an item.
  1990000011: {
    itemID: 1990000011, typeID: 578, ownerID: OWNER, locationID: SHIP,
    flagID: 27, quantity: -1, stacksize: 1, singleton: 1, categoryID: 7,
  },
  // A blueprint copy: singleton 2, quantity -2.
  1990000012: {
    itemID: 1990000012, typeID: 691, ownerID: OWNER, locationID: STATION,
    flagID: 4, quantity: -2, stacksize: 1, singleton: 2, categoryID: 9,
  },
  // A can floating in space: located in a solar system.
  1990000013: {
    itemID: 1990000013, typeID: 23, ownerID: OWNER, locationID: SYSTEM,
    flagID: 5, quantity: 1, stacksize: 1, singleton: 0, categoryID: 2,
  },
  // In an Upwell structure, which is none of the three and therefore `other`.
  1990000014: {
    itemID: 1990000014, typeID: 34, ownerID: OWNER, locationID: STRUCTURE,
    flagID: 4, quantity: 10, stacksize: 10, singleton: 0, categoryID: 4,
  },
  // Somebody else's, which must never appear in this owner's list.
  1990000020: {
    itemID: 1990000020, typeID: 34, ownerID: OTHER_OWNER, locationID: STATION,
    flagID: 4, quantity: 1, stacksize: 1, singleton: 0, categoryID: 4,
  },
  [CONTAINER]: {
    itemID: CONTAINER, typeID: 3465, ownerID: OTHER_OWNER, locationID: STATION,
    flagID: 4, quantity: -1, stacksize: 1, singleton: 1, categoryID: 2,
  },
};

const TABLES = {
  "items./": ITEMS,
  "stations.stations": [{ stationID: STATION }],
  "solarSystems.solarSystems": [{ solarSystemID: SYSTEM }],
  "industryBlueprintState./": { records: {} },
};

function fixtureStore(overrides = {}) {
  const tables = { ...TABLES, ...overrides };
  return createAssetStore({
    readTable: (table, key) => {
      const slot = `${table}.${key}`;
      if (!(slot in tables)) throw new Error(`fixture: no ${slot}`);
      return tables[slot];
    },
  });
}

const deps = (overrides) => ({ assets: fixtureStore(overrides) });

const assets = (overrides) =>
  buildCharacterAssets({ credential: { characterId: OWNER } }, deps(overrides));

/**
 * A verified credential for `OWNER`, in the shape `lib/bearerCredential.js`
 * builds and `lib/router.js` reads. Nothing here signs anything: the gate's
 * inputs are the credential and the route, and both are present.
 */
function verified({ characterId = OWNER, scopes = [CHARACTER_ASSETS_SCOPE] } = {}) {
  return {
    presented: true,
    claims: Object.freeze({ characterId, scopes: Object.freeze([...scopes]) }),
    refusal: null,
  };
}

// The route table against CCP's document

test("the descriptor agrees with the pinned spec", () => {
  // scope, rateLimitGroup, cacheTtl and successStatus in one line.
  const contract = assertRouteMatchesSpec(createCharacterAssetsRoute(deps()));
  assert.equal(contract.operationId, CHARACTER_ASSETS_OPERATION_ID);
  assert.deepEqual(contract.scopes, [CHARACTER_ASSETS_SCOPE]);
});

test("the producer is the only one a scoped JSON route may have", () => {
  // `lib/router.js` assertScope refuses to compile a scoped gateway route at
  // all, so this is a constraint rather than an observation.
  assert.equal(PRODUCER, "app");
  assert.throws(
    () => createRouter([{ ...createCharacterAssetsRoute(deps()), producer: "gateway" }]),
    /no authenticated gateway route has ever been observed/,
  );
});

test("the page size is the one recorded on the public surface", () => {
  assert.equal(ASSETS_PAGE_SIZE, wire.PAGINATION.pageSize);
});

test("the operation publishes a page parameter, which is why it paginates", () => {
  const contract = describeOperation("get", CHARACTER_ASSETS_PATH);
  assert.notEqual(contract.queryParameters.page, undefined);
});

// The body

test("the list satisfies the spec and is in the schema's key order", () => {
  const body = assets();

  assertBody(body, describeOperation("get", CHARACTER_ASSETS_PATH));
  // Declaration order is output order is bytes, and alphabetical is what the
  // document declares. `is_blueprint_copy` is omitted where it is not true, so
  // the common row starts at `is_singleton`.
  assert.deepEqual(Object.keys(body[0]), [
    "is_singleton",
    "item_id",
    "location_flag",
    "location_id",
    "location_type",
    "quantity",
    "type_id",
  ]);
});

test("only this owner's items are listed", () => {
  const ids = assets().map((row) => row.item_id);
  assert.ok(!ids.includes(1990000020), "another character's stack reached this pilot's assets");
  assert.ok(!ids.includes(CONTAINER));
  assert.equal(ids.length, 6);
});

test("rows are in ascending item_id, which is stable across two identical reads", () => {
  const ids = assets().map((row) => row.item_id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  // Stability is what the Etag and a paginated sweep need; an object's key
  // order over a table the game rewrites is not stable.
  assert.deepEqual(assets().map((r) => r.item_id), ids);
});

test("an owner with nothing gets an empty list, not a refusal", () => {
  const body = buildCharacterAssets({ credential: { characterId: 140000009 } }, deps());
  assert.deepEqual(body, []);
  assertBody(body, describeOperation("get", CHARACTER_ASSETS_PATH));
});

// The three-valued singleton

test("a stack reports its units, a singleton reports one", () => {
  const by = new Map(assets().map((row) => [row.item_id, row]));

  assert.equal(by.get(1990000010).quantity, 5000);
  assert.equal(by.get(1990000010).is_singleton, false);

  // quantity -1 in the table, and a client must never see that here.
  assert.equal(by.get(SHIP).quantity, 1);
  assert.equal(by.get(SHIP).is_singleton, true);
});

test("a blueprint copy is a singleton and says so, and nothing else does", () => {
  const by = new Map(assets().map((row) => [row.item_id, row]));
  const copy = by.get(1990000012);

  assert.equal(copy.is_blueprint_copy, true);
  assert.equal(copy.is_singleton, true);
  // quantity -2 in the table; a count here.
  assert.equal(copy.quantity, 1);

  // Optional, and sent only where it is true (see the route header).
  for (const [id, row] of by) {
    if (id === 1990000012) continue;
    assert.ok(
      !Object.prototype.hasOwnProperty.call(row, "is_blueprint_copy"),
      `item ${id} carries is_blueprint_copy and is not one`,
    );
  }
});

test("no row ever reports a negative quantity", () => {
  // The failure a client would act on: the table's -1 and -2 are a convention
  // belonging to the blueprints endpoint.
  for (const row of assets()) assert.ok(row.quantity >= 1, `item ${row.item_id} reports ${row.quantity}`);
});

test("a stack carrying no readable quantity is refused, not reported as zero", () => {
  assert.throws(
    () => assets({
      "items./": {
        1990000010: {
          itemID: 1990000010, typeID: 34, ownerID: OWNER, locationID: STATION,
          flagID: 4, quantity: 0, stacksize: 0, singleton: 0, categoryID: 4,
        },
      },
    }),
    /carrying no readable quantity/,
  );
});

// location_type, all four branches

test("all four of CCP's location types are reachable and correct", () => {
  const by = new Map(assets().map((row) => [row.item_id, row]));

  assert.equal(by.get(1990000010).location_type, LOCATION_TYPE.STATION);
  assert.equal(by.get(1990000013).location_type, LOCATION_TYPE.SOLAR_SYSTEM);
  assert.equal(by.get(1990000011).location_type, LOCATION_TYPE.ITEM, "a fitted module is in a ship");
  assert.equal(by.get(1990000014).location_type, LOCATION_TYPE.OTHER, "an Upwell structure");
});

test("an item inside somebody else's container is still located in an item", () => {
  // The `itemIds` set is the whole table's, not the owner's, for this reason.
  const body = assets({
    "items./": {
      ...ITEMS,
      1990000015: {
        itemID: 1990000015, typeID: 34, ownerID: OWNER, locationID: CONTAINER,
        flagID: 4, quantity: 3, stacksize: 3, singleton: 0, categoryID: 4,
      },
    },
  });
  const row = body.find((entry) => entry.item_id === 1990000015);
  assert.equal(row.location_type, LOCATION_TYPE.ITEM);
});

// location_flag

test("flags are named from the character enum", () => {
  const by = new Map(assets().map((row) => [row.item_id, row]));
  assert.equal(by.get(1990000010).location_flag, "Hangar");
  assert.equal(by.get(1990000011).location_flag, "HiSlot0");
  assert.equal(by.get(1990000013).location_flag, "Cargo");
});

test("a flag this replica cannot name is a refusal naming the flag", () => {
  // Never a dropped row: an asset list that is quietly short is one an
  // industry tool reconciles against a build plan and blames itself for.
  assert.throws(
    () => assets({
      "items./": {
        1990000010: {
          itemID: 1990000010, typeID: 34, ownerID: OWNER, locationID: STATION,
          flagID: 4242, quantity: 1, stacksize: 1, singleton: 0, categoryID: 4,
        },
      },
    }),
    /flagID 4242/,
  );
});

test("a corporation-only flag on a character's item is refused too", () => {
  // `CorpSAG1` is not in the character enum, so sending it would be a body a
  // strict client rejects as hard as a missing field.
  assert.throws(
    () => assets({
      "items./": {
        1990000010: {
          itemID: 1990000010, typeID: 34, ownerID: OWNER, locationID: STATION,
          flagID: 115, quantity: 1, stacksize: 1, singleton: 0, categoryID: 4,
        },
      },
    }),
    /flagID 115/,
  );
});

// The gate, and what the handler refuses to run without

test("the handler refuses to run without a verified credential", () => {
  assert.throws(() => buildCharacterAssets({}, deps()), /no verified credential/);
});

test("the owner is the token's subject, never the path segment", () => {
  // The path says one thing and the claim says another; the claim wins, and the
  // gate has already proved they agree before a handler runs.
  const body = buildCharacterAssets(
    { credential: { characterId: OWNER }, path: { character_id: "90000022" } },
    deps(),
  );
  assert.equal(body.length, 6, "the path segment must not select the owner");
});

test("a missing store is a programming error naming what to inject", () => {
  assert.throws(() => buildCharacterAssets({ credential: { characterId: OWNER } }, {}), /asset store/);
});

test("an unreadable items table is a 500, never an empty list", async () => {
  // D42's rule again: "this pilot owns nothing" and "this build cannot read the
  // inventory" must not look alike.
  const router = createRouter([
    createCharacterAssetsRoute({
      assets: createAssetStore({
        readTable: (table) => {
          if (table === "items") throw new Error("fixture: unreadable");
          return TABLES[`${table}.${table === "stations" ? "stations" : "solarSystems"}`] || [];
        },
      }),
    }),
  ]);

  const result = await dispatchRequest(
    router,
    {
      method: "GET",
      pathname: `/latest${CHARACTER_ASSETS_PATH.replace(":character_id", String(OWNER))}`,
      query: {},
      headers: {},
      credential: verified(),
    },
    { logError: () => {} },
  );
  assert.equal(result.status, 500);
});

// Pagination, through the router

test("the collection is sliced by the framework and X-Pages is sent", async () => {
  const many = {};
  for (let i = 0; i < ASSETS_PAGE_SIZE + 5; i += 1) {
    const id = 1990100000 + i;
    many[id] = {
      itemID: id, typeID: 34, ownerID: OWNER, locationID: STATION,
      flagID: 4, quantity: 1, stacksize: 1, singleton: 0, categoryID: 4,
    };
  }

  const router = createRouter([createCharacterAssetsRoute(deps({ "items./": many }))]);
  const request = (page) => ({
    method: "GET",
    pathname: `/latest${CHARACTER_ASSETS_PATH.replace(":character_id", String(OWNER))}`,
    query: page === null ? {} : { page: String(page) },
    headers: {},
    credential: verified(),
  });

  const first = await dispatchRequest(router, request(null), { logError: () => {} });
  assert.equal(first.status, 200);
  assert.equal(first.body.length, ASSETS_PAGE_SIZE);
  assert.equal(first.headers["x-pages"], "2");

  const second = await dispatchRequest(router, request(2), { logError: () => {} });
  assert.equal(second.body.length, 5);
  assert.equal(second.headers["x-pages"], "2");

  // A page past the end is the legacy family's 404, not an empty array.
  const third = await dispatchRequest(router, request(3), { logError: () => {} });
  assert.equal(third.status, 404);
});
