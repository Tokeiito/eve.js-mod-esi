/**
 * `GET /characters/{character_id}/blueprints/` against CCP's pinned spec, and
 * the non-writing door to `industryBlueprintState`.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Two things here no schema check would catch.
 *
 * `quantity` is CCP's convention, not a count. The same `items` column that the
 * assets endpoint turns into a count is passed through untouched here, and the
 * document says so in words: -1 original, -2 copy, positive for a stack of
 * unresearched originals. A handler that "fixed" the negatives would produce a
 * body that validates against the schema (there is no minimum on `quantity`)
 * and tells every industry tool that every blueprint is one copy.
 *
 * The read must not write. `getBlueprintState` seeds and persists a record for
 * a blueprint it has not seen, so the route reads the table directly and
 * synthesises the same default. The fixture's store has no write path at all,
 * and one test asserts that a blueprint with no state row still answers, which
 * is the case the seeding existed for.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  assertBody,
  assertRouteMatchesSpec,
  describeOperation,
} = require(path.join(__dirname, "../contract/spec"));
const spec = require(path.join(__dirname, "../contract/openapi.json"));
const { createAssetStore, UNRESEARCHED_BLUEPRINT } = require(path.join(__dirname, "../lib/assetStore"));
const {
  CHARACTER_BLUEPRINTS_OPERATION_ID,
  CHARACTER_BLUEPRINTS_PATH,
  CHARACTER_BLUEPRINTS_SCOPE,
  buildCharacterBlueprints,
  createCharacterBlueprintsRoute,
} = require(path.join(__dirname, "../routes/blueprints"));

const OWNER = 90000021;
const STATION = 60003760;

/** Three blueprints in the three shapes, plus one non-blueprint item. */
const ITEMS = {
  // An assembled original with a researched state row.
  1990000030: {
    itemID: 1990000030, typeID: 691, ownerID: OWNER, locationID: STATION,
    flagID: 4, quantity: -1, stacksize: 1, singleton: 1, categoryID: 9,
  },
  // A copy: singleton 2, quantity -2, with runs remaining.
  1990000031: {
    itemID: 1990000031, typeID: 691, ownerID: OWNER, locationID: STATION,
    flagID: 4, quantity: -2, stacksize: 1, singleton: 2, categoryID: 9,
  },
  // An assembled original with NO state row: the case getBlueprintState seeds
  // for, and the one this replica answers without writing.
  1990000032: {
    itemID: 1990000032, typeID: 1010, ownerID: OWNER, locationID: STATION,
    flagID: 4, quantity: -1, stacksize: 1, singleton: 1, categoryID: 9,
  },
  // A stack of unresearched originals from the market. eve.js's own blueprint
  // list omits these; CCP's document says they are rows. See the route header.
  1990000033: {
    itemID: 1990000033, typeID: 1011, ownerID: OWNER, locationID: STATION,
    flagID: 4, quantity: 7, stacksize: 7, singleton: 0, categoryID: 9,
  },
  // Not a blueprint, and must never appear.
  1990000034: {
    itemID: 1990000034, typeID: 34, ownerID: OWNER, locationID: STATION,
    flagID: 4, quantity: 100, stacksize: 100, singleton: 0, categoryID: 4,
  },
};

const BLUEPRINT_STATE = {
  records: {
    1990000030: { itemID: 1990000030, materialEfficiency: 10, timeEfficiency: 20, original: true, runsRemaining: -1 },
    1990000031: { itemID: 1990000031, materialEfficiency: 2, timeEfficiency: 4, original: false, runsRemaining: 37 },
  },
};

const TABLES = {
  "items./": ITEMS,
  "stations.stations": [{ stationID: STATION }],
  "solarSystems.solarSystems": [],
  "industryBlueprintState./": BLUEPRINT_STATE,
};

function deps(overrides = {}) {
  const tables = { ...TABLES, ...overrides };
  return {
    assets: createAssetStore({
      readTable: (table, key) => {
        const slot = `${table}.${key}`;
        if (!(slot in tables)) throw new Error(`fixture: no ${slot}`);
        return tables[slot];
      },
    }),
  };
}

const blueprints = (overrides) =>
  buildCharacterBlueprints({ credential: { characterId: OWNER } }, deps(overrides));

const by = (overrides) => new Map(blueprints(overrides).map((row) => [row.item_id, row]));

// The document

test("the descriptor agrees with the pinned spec", () => {
  const contract = assertRouteMatchesSpec(createCharacterBlueprintsRoute(deps()));
  assert.equal(contract.operationId, CHARACTER_BLUEPRINTS_OPERATION_ID);
  assert.deepEqual(contract.scopes, [CHARACTER_BLUEPRINTS_SCOPE]);
  // char-industry, and emphatically not char-asset's 1800.
  assert.equal(contract.rateLimit.group, "char-industry");
  assert.equal(contract.rateLimit.maxTokens, 600);
});

function resolveRef(node) {
  return node && node.$ref ? spec.components.schemas[node.$ref.split("/").pop()] : node;
}

test("CCP's own description is what this route's quantity implements", () => {
  // Asserted against the document rather than quoted in a comment, so that a
  // re-pin that changed the convention fails here.
  const schema = resolveRef(
    spec.paths["/characters/{character_id}/blueprints"].get
      .responses["200"].content["application/json"].schema,
  );
  const description = resolveRef(schema.items).properties.quantity.description;

  assert.match(description, /-1 is an original/);
  assert.match(description, /-2 is a copy/);
  assert.match(description, /positive integer/);
});

// The body

test("the list satisfies the spec and is in the schema's key order", () => {
  const body = blueprints();

  assertBody(body, describeOperation("get", CHARACTER_BLUEPRINTS_PATH));
  assert.deepEqual(Object.keys(body[0]), [
    "item_id",
    "location_flag",
    "location_id",
    "material_efficiency",
    "quantity",
    "runs",
    "time_efficiency",
    "type_id",
  ]);
});

test("only blueprints are listed", () => {
  const ids = blueprints().map((row) => row.item_id);
  assert.ok(!ids.includes(1990000034), "a Tritanium stack reached the blueprint list");
  assert.deepEqual(ids, [1990000030, 1990000031, 1990000032, 1990000033]);
});

test("quantity carries CCP's convention through untouched", () => {
  const rows = by();

  assert.equal(rows.get(1990000030).quantity, -1, "an original is -1");
  assert.equal(rows.get(1990000031).quantity, -2, "a copy is -2");
  assert.equal(rows.get(1990000033).quantity, 7, "a market stack is its count");
});

test("a researched original reports its research and -1 runs", () => {
  const row = by().get(1990000030);
  assert.equal(row.material_efficiency, 10);
  assert.equal(row.time_efficiency, 20);
  assert.equal(row.runs, -1);
});

test("a copy reports its remaining runs", () => {
  const row = by().get(1990000031);
  assert.equal(row.runs, 37);
  assert.equal(row.material_efficiency, 2);
});

// The read that must not write

test("a blueprint with no state row answers with the seed's numbers", () => {
  // getBlueprintState would write exactly this record and persist the table.
  // The values are reproduced; the write is not.
  const row = by().get(1990000032);

  assert.equal(row.material_efficiency, UNRESEARCHED_BLUEPRINT.materialEfficiency);
  assert.equal(row.time_efficiency, UNRESEARCHED_BLUEPRINT.timeEfficiency);
  assert.equal(row.runs, UNRESEARCHED_BLUEPRINT.runsRemaining);
  assert.equal(row.quantity, -1, "and it is still an original");
});

test("a market stack with no state row is unresearched, which is what it is", () => {
  const row = by().get(1990000033);
  assert.equal(row.material_efficiency, 0);
  assert.equal(row.time_efficiency, 0);
  assert.equal(row.runs, -1);
});

test("the store is handed no write path at all", () => {
  // The structural half of the claim: nothing on the store can write, so the
  // route physically cannot seed the table however it is called.
  const store = deps().assets;
  for (const [name, value] of Object.entries(store)) {
    if (typeof value !== "function") continue;
    assert.ok(
      !/^(write|persist|set|save|ensure|initialize|seed)/i.test(name),
      `lib/assetStore.js exposes ${name}, which reads like a write`,
    );
  }
});

test("an empty state table is not an error, and every blueprint still answers", () => {
  const rows = by({ "industryBlueprintState./": { records: {} } });
  assert.equal(rows.size, 4);
  for (const row of rows.values()) {
    assert.equal(row.material_efficiency, 0);
    assert.equal(row.runs, -1);
  }
});

// Refusals

test("a state row with an unreadable number is refused, not defaulted", () => {
  // Defaulting would report a researched blueprint as unresearched, and a
  // client would quote a build cost off the wrong material multiplier.
  assert.throws(
    () => blueprints({
      "industryBlueprintState./": {
        records: {
          1990000030: { itemID: 1990000030, materialEfficiency: null, timeEfficiency: 20, runsRemaining: -1 },
        },
      },
    }),
    /no readable materialEfficiency/,
  );
});

test("a quantity outside CCP's range is refused", () => {
  assert.throws(
    () => blueprints({
      "items./": {
        1990000030: {
          itemID: 1990000030, typeID: 691, ownerID: OWNER, locationID: STATION,
          flagID: 4, quantity: -3, stacksize: 1, singleton: 1, categoryID: 9,
        },
      },
    }),
    /CCP's range is -2, -1, or a positive stack count/,
  );
});

test("a flag the blueprints enum does not publish is refused", () => {
  // 176 is BoosterBay: in the assets enum, not in the blueprints one. A
  // blueprint cannot be in a booster bay, so this is the game being wrong, and
  // sending the name anyway would be a body a strict client rejects.
  assert.throws(
    () => blueprints({
      "items./": {
        1990000030: {
          itemID: 1990000030, typeID: 691, ownerID: OWNER, locationID: STATION,
          flagID: 176, quantity: -1, stacksize: 1, singleton: 1, categoryID: 9,
        },
      },
    }),
    /blueprints enum does not publish it/,
  );
});

test("an owner with no blueprints gets an empty list", () => {
  const body = buildCharacterBlueprints({ credential: { characterId: 140000009 } }, deps());
  assert.deepEqual(body, []);
  assertBody(body, describeOperation("get", CHARACTER_BLUEPRINTS_PATH));
});

test("the handler refuses to run without a verified credential", () => {
  assert.throws(() => buildCharacterBlueprints({}, deps()), /no verified credential/);
});
