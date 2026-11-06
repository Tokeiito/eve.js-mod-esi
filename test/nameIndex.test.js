/**
 * `lib/nameIndex.js`: both directions, the ten sources, and D9's disjointness
 * check.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * The fixture is ten sources in their three real row shapes (an array with an
 * id field, a map keyed by id, and a dump keyed by `_key` with an
 * eight-language `name`). All must arrive in one index with the right category
 * on each entry, so the fixture reproduces each shape as its source writes it,
 * with field names transcribed from the live tables, and every id placed
 * inside the band D9 measured for its category.
 *
 * Nothing here names a real character, corporation or alliance. The three
 * player-allocated categories use their allocator's first id and an obviously
 * synthetic name; an id of 90000021 is `CHARACTER_ID_FLOOR`.
 *
 * Two tables in `lib/nameIndex.js` are claims about CCP's document and not
 * about eve.js: the nine `category` values `/universe/names/` may send, and the
 * ten group keys `/universe/ids/` sends its matches under. Both are read out of
 * the pinned spec here, because a literal copied into a module drifts from its
 * document. `systems` is the kind of key somebody corrects to `solar_systems`.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const spec = require(path.join(__dirname, "../contract/openapi.json"));
const {
  CATEGORY,
  IDS_GROUP,
  NAMES_CATEGORY,
  createNameIndex,
  matchable,
  nameOf,
} = require(path.join(__dirname, "../lib/nameIndex"));

// The fixture, in each source's own shape

/** `itemTypes.types`: an array, id on the row, a plain string name. */
const ITEM_TYPES = [
  { typeID: 34, name: "Tritanium" },
  { typeID: 587, name: "Rifter" },
  // A row with no usable name, which the index drops rather than indexes.
  { typeID: 999, name: "" },
];

/** `factions.records`: a map keyed by id, id repeated on the row. */
const FACTIONS = {
  500001: { factionID: 500001, name: "Caldari State" },
  500002: { factionID: 500002, name: "Minmatar Republic" },
};

/** `corporations.records`: NPC rows plus the first player-allocated one. */
const CORPORATIONS = {
  1000002: { corporationID: 1000002, corporationName: "CBD Corporation" },
  98000000: { corporationID: 98000000, corporationName: "Fixture Holdings" },
};

/** `agentAuthority.agentsByID`: the name field is `ownerName`, not `name`. */
const AGENTS = {
  3008416: { agentID: 3008416, ownerName: "Fixture Agent" },
};

/** `characters`: a flat map at the table root, no id field on the row. */
const CHARACTERS = {
  90000021: { characterName: "Fixture Pilot" },
};

/** `alliances`: the same flat shape, empty on a fresh install. */
const ALLIANCES = {
  99000000: { allianceName: "Fixture Alliance" },
};

/** `solarSystems.solarSystems`: an array, and the name field is prefixed. */
const SOLAR_SYSTEMS = [
  { solarSystemID: 30000142, solarSystemName: "Jita" },
  { solarSystemID: 31000001, solarSystemName: "J164710" },
];

/** `stations.stations`: an array, and the longest names on the surface. */
const STATIONS = [
  { stationID: 60003760, stationName: "Jita IV - Moon 4 - Caldari Navy Assembly Plant" },
];

/** `mapConstellations.jsonl`: `_key`, and `name` is eight languages. */
const CONSTELLATIONS = [
  { _key: 20000020, name: { de: "Kimotoro", en: "Kimotoro", ja: "キモトロ" } },
];

/** `mapRegions.jsonl`: the same dump shape. */
const REGIONS = [
  { _key: 10000002, name: { de: "The Forge", en: "The Forge", ja: "ザ・フォージ" } },
];

/**
 * A store double: `read(table, key)` over the fixture, in the shape
 * `lib/universeStore.js` `readTableFromRepository` unwraps.
 *
 * `missing` takes one source away, which separates "the index cannot be built"
 * from "this server has none of that kind".
 */
function fixtureIndex({ missing = null, onAmbiguous = null, overrides = {} } = {}) {
  const tables = {
    "itemTypes.types": ITEM_TYPES,
    "factions.records": FACTIONS,
    "corporations.records": CORPORATIONS,
    "agentAuthority.agentsByID": AGENTS,
    "characters./": CHARACTERS,
    "alliances./": ALLIANCES,
    "solarSystems.solarSystems": SOLAR_SYSTEMS,
    "stations.stations": STATIONS,
    ...overrides,
  };

  const dumps = {
    "mapConstellations.jsonl": CONSTELLATIONS,
    "mapRegions.jsonl": REGIONS,
    ...(overrides.dumps || {}),
  };

  return createNameIndex({
    onAmbiguous,
    readTable: (table, key) => {
      const slot = `${table}.${key}`;
      if (slot === missing) throw new Error(`fixture: ${slot} is unreadable`);
      return tables[slot];
    },
    readSdeRecords: (fileName) => {
      if (fileName === missing) throw new Error(`fixture: ${fileName} is unreadable`);
      return dumps[fileName];
    },
  });
}

/**
 * Every id one category contributes, read out of the fixture directly.
 *
 * The index does not expose its per-category membership, so the
 * set-disjointness test reads the sources the way `entriesOf` does rather than
 * being handed the answer by the thing it checks.
 */
function idsOf(category) {
  const sources = {
    [CATEGORY.INVENTORY_TYPE]: ITEM_TYPES.filter((row) => row.name !== "").map((row) => row.typeID),
    [CATEGORY.FACTION]: Object.keys(FACTIONS).map(Number),
    [CATEGORY.CORPORATION]: Object.keys(CORPORATIONS).map(Number),
    [CATEGORY.AGENT]: Object.keys(AGENTS).map(Number),
    [CATEGORY.CHARACTER]: Object.keys(CHARACTERS).map(Number),
    [CATEGORY.ALLIANCE]: Object.keys(ALLIANCES).map(Number),
    [CATEGORY.SOLAR_SYSTEM]: SOLAR_SYSTEMS.map((row) => row.solarSystemID),
    [CATEGORY.STATION]: STATIONS.map((row) => row.stationID),
    [CATEGORY.CONSTELLATION]: CONSTELLATIONS.map((row) => row._key),
    [CATEGORY.REGION]: REGIONS.map((row) => row._key),
  };
  return sources[category];
}

// The two tables that are claims about CCP's document

function resolveRef(node) {
  return node && node.$ref ? spec.components.schemas[node.$ref.split("/").pop()] : node;
}

test("the category values are exactly the nine POST /universe/names/ publishes", () => {
  const schema = resolveRef(
    spec.paths["/universe/names"].post.responses["200"].content["application/json"].schema,
  );
  const item = resolveRef(schema.items);
  const published = [...item.properties.category.enum].sort();

  const sent = [...new Set(Object.values(NAMES_CATEGORY))].sort();
  assert.deepEqual(sent, published);

  // `agent` is the tenth category and must never reach a body as one.
  assert.ok(!published.includes(CATEGORY.AGENT));
  assert.equal(NAMES_CATEGORY[CATEGORY.AGENT], CATEGORY.CHARACTER);
});

test("the group keys are exactly the ten POST /universe/ids/ publishes", () => {
  const schema = resolveRef(
    spec.paths["/universe/ids"].post.responses["200"].content["application/json"].schema,
  );
  const published = Object.keys(schema.properties).sort();

  assert.deepEqual(Object.values(IDS_GROUP).sort(), published);
  // Not the plural of its category, which is why this test reads the document
  // instead of trusting the table.
  assert.equal(IDS_GROUP[CATEGORY.SOLAR_SYSTEM], "systems");
});

// Reading the ten sources

test("every category resolves an id to its own name and category", () => {
  const index = fixtureIndex();

  assert.deepEqual(index.resolveId(34), { id: 34, name: "Tritanium", category: "inventory_type" });
  assert.deepEqual(index.resolveId(500001), {
    id: 500001,
    name: "Caldari State",
    category: "faction",
  });
  assert.deepEqual(index.resolveId(1000002), {
    id: 1000002,
    name: "CBD Corporation",
    category: "corporation",
  });
  assert.deepEqual(index.resolveId(98000000), {
    id: 98000000,
    name: "Fixture Holdings",
    category: "corporation",
  });
  assert.deepEqual(index.resolveId(90000021), {
    id: 90000021,
    name: "Fixture Pilot",
    category: "character",
  });
  assert.deepEqual(index.resolveId(99000000), {
    id: 99000000,
    name: "Fixture Alliance",
    category: "alliance",
  });
  assert.deepEqual(index.resolveId(30000142), {
    id: 30000142,
    name: "Jita",
    category: "solar_system",
  });
  assert.deepEqual(index.resolveId(60003760), {
    id: 60003760,
    name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
    category: "station",
  });
  assert.deepEqual(index.resolveId(20000020), {
    id: 20000020,
    name: "Kimotoro",
    category: "constellation",
  });
  assert.deepEqual(index.resolveId(10000002), {
    id: 10000002,
    name: "The Forge",
    category: "region",
  });
});

test("an agent id resolves as a character, and an agent name under agents", () => {
  const index = fixtureIndex();

  assert.deepEqual(index.resolveId(3008416), {
    id: 3008416,
    name: "Fixture Agent",
    category: "character",
  });
  assert.deepEqual(index.resolveName("Fixture Agent"), {
    id: 3008416,
    name: "Fixture Agent",
    group: "agents",
  });
});

test("a dump name is read from its English entry and nowhere else", () => {
  assert.equal(nameOf({ de: "Kimotoro", en: "Kimotoro" }), "Kimotoro");
  // No English is no name: a body carrying a German constellation would be a
  // different answer for a client that asked in the only language D27 serves.
  assert.equal(nameOf({ de: "Kimotoro" }), null);
  assert.equal(nameOf(""), null);
  assert.equal(nameOf(34), null);
});

test("an id this server has never heard of resolves to null, not a throw", () => {
  const index = fixtureIndex();
  assert.equal(index.resolveId(30000999), null);
  assert.equal(index.resolveId(0), null);
  assert.equal(index.resolveId(-1), null);
  assert.equal(index.resolveId(1.5), null);
  // A string that looks like an id is not one. The route parses JSON integers
  // out of the body, so a string arriving here is a route that skipped its own
  // validation, and coercing it would hide that.
  assert.equal(index.resolveId("30000142"), null);
});

test("a row with no usable name is dropped rather than indexed", () => {
  const index = fixtureIndex();
  assert.equal(index.resolveId(999), null);
});

// The name direction, and D45's case rule

test("a name resolves to its id under the group the spec declares", () => {
  const index = fixtureIndex();

  assert.deepEqual(index.resolveName("Jita"), { id: 30000142, name: "Jita", group: "systems" });
  assert.deepEqual(index.resolveName("Tritanium"), {
    id: 34,
    name: "Tritanium",
    group: "inventory_types",
  });
  assert.deepEqual(index.resolveName("The Forge"), {
    id: 10000002,
    name: "The Forge",
    group: "regions",
  });
});

test("the match is case-insensitive and the answer keeps the source's spelling", () => {
  const index = fixtureIndex();

  for (const spelling of ["Jita", "jita", "JITA", "  jItA  "]) {
    assert.deepEqual(
      index.resolveName(spelling),
      { id: 30000142, name: "Jita", group: "systems" },
      `${JSON.stringify(spelling)} should resolve, and answer with the store's own spelling`,
    );
  }
});

test("the fold is locale-independent", () => {
  // The Turkish dotless i would make one deployment resolve a name another does
  // not, which is why `matchable` is not `toLocaleLowerCase`.
  assert.equal(matchable("INTAKI"), "intaki");
  assert.equal(matchable("Iteration"), "iteration");
});

test("a name nobody has is null, and so is an empty one", () => {
  const index = fixtureIndex();
  assert.equal(index.resolveName("No Such Place"), null);
  assert.equal(index.resolveName(""), null);
  assert.equal(index.resolveName("   "), null);
  assert.equal(index.resolveName(null), null);
  assert.equal(index.resolveName(34), null);
});

// D9: the disjointness the design rests on

test("bands() reports what was indexed, per category", () => {
  const bands = fixtureIndex().bands();
  const by = new Map(bands.map((band) => [band.category, band]));

  assert.equal(by.get(CATEGORY.SOLAR_SYSTEM).count, 2);
  assert.equal(by.get(CATEGORY.SOLAR_SYSTEM).min, 30000142);
  assert.equal(by.get(CATEGORY.SOLAR_SYSTEM).max, 31000001);
  // The dropped unnamed type is not in the band, because it is not in the index.
  assert.equal(by.get(CATEGORY.INVENTORY_TYPE).count, 2);
});

test("an empty category reports a band of nothing rather than failing", () => {
  const index = fixtureIndex({ overrides: { "alliances./": {} } });
  const band = index.bands().find((entry) => entry.category === CATEGORY.ALLIANCE);

  assert.equal(band.count, 0);
  assert.equal(band.min, null);
  assert.equal(band.max, null);
  // The rest of the index is unaffected: a server with no alliances is the
  // ordinary state of a fresh install, not a broken one.
  assert.equal(index.resolveId(30000142).name, "Jita");
});

test("no id is claimed by two categories, which is what D9 actually claims", () => {
  // Set-disjointness, not interval-disjointness. See the next test for why the
  // stronger-sounding claim is false and would refuse most of New Eden.
  const index = fixtureIndex();
  const seen = new Map();

  for (const { category } of index.bands()) {
    for (const id of idsOf(category)) {
      const owner = seen.get(id);
      assert.ok(
        owner === undefined,
        `id ${id} is claimed by both ${owner} and ${category}: D9 records the id sets as disjoint`,
      );
      seen.set(id, category);
    }
  }

  // Every one of them resolves, the same claim from the other end: an ambiguous
  // id would have come back null.
  for (const [id] of seen) assert.notEqual(index.resolveId(id), null);
});

test("a category's range may straddle another's, and that is why the check is per id", () => {
  // `corporation` is allocated from two bands (CCP's NPC corporations at
  // 1,000,00x and eve.js's player corporations from 98,000,000), so its lowest
  // and highest ids enclose `agent` entirely. An implementation that checked
  // ranges rather than ids would call this a collision and refuse to resolve
  // every agent, region, constellation and solar system on the server.
  const bands = new Map(fixtureIndex().bands().map((band) => [band.category, band]));
  const corporation = bands.get(CATEGORY.CORPORATION);
  const agent = bands.get(CATEGORY.AGENT);

  assert.ok(corporation.min < agent.min && agent.max < corporation.max);
  // Both still resolve, each as itself.
  assert.equal(fixtureIndex().resolveId(agent.min).category, CATEGORY.CHARACTER);
  assert.equal(fixtureIndex().resolveId(corporation.min).category, CATEGORY.CORPORATION);
});

test("an id two categories claim is omitted from both, and reported", () => {
  const collisions = [];
  // A station id that is also a solar system id: the id space broken in the one
  // way D9 says must never be answered with a guess.
  const index = fixtureIndex({
    onAmbiguous: (err) => collisions.push(err),
    overrides: {
      "stations.stations": [{ stationID: 30000142, stationName: "Impossible Station" }],
    },
  });

  assert.equal(index.resolveId(30000142), null);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].name, "AmbiguousIdError");
  assert.equal(collisions[0].key, 30000142);
  assert.deepEqual(collisions[0].categories.slice().sort(), ["solar_system", "station"]);
});

test("a name two ids claim is omitted from both, and reported", () => {
  const collisions = [];
  const index = fixtureIndex({
    onAmbiguous: (err) => collisions.push(err),
    overrides: {
      // A type named the same as a system, differing only in case: the shape D45's
      // fold could introduce, and the reason it is checked.
      "itemTypes.types": [{ typeID: 34, name: "jita" }],
    },
  });

  assert.equal(index.resolveName("Jita"), null);
  assert.equal(index.resolveName("jita"), null);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].name, "AmbiguousIdError");

  // The id direction is untouched: two ids with one name is not two categories
  // with one id, and only the second is a broken id space.
  assert.equal(index.resolveId(30000142).name, "Jita");
  assert.equal(index.resolveId(34).name, "jita");
});

// What an unreadable source does

test("a source that cannot be read fails the lookup rather than answering short", () => {
  // "This server has none of that kind" is an answer and "this build cannot see
  // that kind at all" is not. An index that swallowed the second would report
  // every type on the server as having no name, a body a client acts on.
  const index = fixtureIndex({ missing: "itemTypes.types" });
  assert.throws(() => index.resolveId(30000142), /itemTypes\.types is unreadable/);
});

test("a missing dump fails the same way, and D42 is why", () => {
  const index = fixtureIndex({ missing: "mapRegions.jsonl" });
  assert.throws(() => index.resolveId(30000142), /mapRegions\.jsonl is unreadable/);
});

// The memo

test("each source is read once, however many ids are resolved", () => {
  const reads = [];
  const index = createNameIndex({
    readTable: (table, key) => {
      reads.push(`${table}.${key}`);
      return {
        "itemTypes.types": ITEM_TYPES,
        "factions.records": FACTIONS,
        "corporations.records": CORPORATIONS,
        "agentAuthority.agentsByID": AGENTS,
        "characters./": CHARACTERS,
        "alliances./": ALLIANCES,
        "solarSystems.solarSystems": SOLAR_SYSTEMS,
        "stations.stations": STATIONS,
      }[`${table}.${key}`];
    },
    readSdeRecords: (fileName) =>
      ({ "mapConstellations.jsonl": CONSTELLATIONS, "mapRegions.jsonl": REGIONS }[fileName]),
  });

  for (let i = 0; i < 50; i += 1) index.resolveId(30000142);
  const afterIds = reads.length;
  assert.equal(afterIds, 8, "eight gameStore tables, read once each");

  // The name direction reuses the same memoised sources rather than re-reading
  // them: the two indexes are separate, the reads behind them are not.
  for (let i = 0; i < 50; i += 1) index.resolveName("Jita");
  assert.equal(reads.length, afterIds);
});
