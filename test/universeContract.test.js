/**
 * The four static-universe endpoints, against CCP's pinned spec, four recorded
 * bodies, and a fixture universe.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Two of the four recordings are byte diffs. Every earlier golden was either
 * CCP's own body from a route this replica serves identically (`/status/`) or a
 * recording whose values a private server cannot have (an order book, a
 * compatibility-date list). A star and a constellation are neither: their
 * values are CCP's static data and a private server has the same dump, so the
 * bytes are reproducible field for field, including the `.0` on an integral
 * double and the shortest-round-trip digits under it.
 * `contract/golden/GetUniverseStarsStarId.json` (174 bytes) and
 * `contract/golden/GetUniverseConstellationsConstellationId.json` (231) are
 * diffed whole.
 *
 * The other two cannot be, for reasons no code here can fix:
 *
 *   security_status     CCP's is a float32 of a value with more precision than
 *                       `mapSolarSystems.jsonl` publishes.
 *   office_rental_cost  a live number on Tranquility, a static one in the store.
 *
 * Two fixtures are literal rows out of `mapStars.jsonl` and
 * `mapConstellations.jsonl`, because a byte diff needs the exact inputs CCP
 * served from. The rest is a small invented universe: a system with two planets,
 * one of them with moons and a belt, two stargates and two stations. It is
 * invented because it tests the shaping (which ids hang off which planet, what
 * is omitted when a collection is empty, what order things come out in), and 42
 * real Jita rows would say no more than six made-up ones.
 *
 * Rows are handed to the store out of order on purpose. The dump happens to be
 * written in ascending id order, so a projection that never sorted would pass
 * every test against real data and reorder somebody's moons the first time
 * upstream regenerated the tables.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const golden = require(path.join(__dirname, "../contract/golden"));
const wire = require(path.join(__dirname, "../contract/wire"));
const { assertBody, describeOperation } = require(path.join(__dirname, "../contract/spec"));
const spec = require(path.join(__dirname, "../contract/openapi.json"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const { createCacheDispatch } = require(path.join(__dirname, "../lib/cache"));
const { PRODUCER, serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const {
  ETAG_ALGORITHM,
  ETAG_WEAK_PREFIX,
  EXPIRY_UTC,
  createStaticSnapshot,
  nextExpiry,
} = require(path.join(__dirname, "../lib/staticSnapshot"));
const {
  UniverseDataError,
  createUniverseStore,
} = require(path.join(__dirname, "../lib/universeStore"));
const {
  ENTITY,
  SECONDS_PER_JULIAN_YEAR,
  SERVICE_BY_ID,
  buildConstellation,
  buildStar,
  buildStation,
  buildSystem,
  createUniverseConstellationRoute,
  createUniverseStarRoute,
  createUniverseStationRoute,
  createUniverseSystemRoute,
  parseId,
} = require(path.join(__dirname, "../routes/universe"));

// The fixture universe

/** `tools/DatabaseCreator`'s stamp, which is what the shared etag is built on. */
const SOURCE = Object.freeze({
  provider: "CCP public static-data JSONL",
  authority: "eve-online-static-data-3396210-jsonl",
  buildNumber: 3396210,
  releaseDate: "2026-06-16T12:43:42Z",
  generatedAt: "2026-08-14T15:56:13.265Z",
  generatedBy: "tools/DatabaseCreator",
});

const JITA = 30000142;
const JITA_STAR = 40009076;
const KIMOTORO = 20000020;
const INVENTED = 30009000;

/**
 * `mapStars.jsonl`'s row for Jita's star, and the celestial the store keeps for
 * the same object, transcribed.
 *
 * The split is the endpoint's shape: the store has the name, the type and the
 * radius; only the dump has how old, how bright, how hot and what class.
 */
const JITA_STAR_CELESTIAL = Object.freeze({
  itemID: JITA_STAR,
  kind: "sun",
  solarSystemID: JITA,
  itemName: "Jita - Star",
  typeID: 3796,
  radius: 513100000,
});

const JITA_STAR_DUMP = Object.freeze({
  _key: JITA_STAR,
  radius: 513100000,
  solarSystemID: JITA,
  typeID: 3796,
  statistics: Object.freeze({
    age: 2.1750000002269184e+16,
    life: 1.0809999751328563e+17,
    luminosity: 1.692,
    spectralClass: "F1 V",
    temperature: 7305.0,
  }),
});

/** `mapConstellations.jsonl`'s row for Kimotoro, transcribed but for the seven other languages. */
const KIMOTORO_DUMP = Object.freeze({
  _key: KIMOTORO,
  name: Object.freeze({ en: "Kimotoro", de: "Kimotoro", ja: "キモトロ" }),
  position: Object.freeze({
    x: -134996400468185440,
    y: 64999452632293260,
    z: 103325617317521340,
  }),
  regionID: 10000002,
  solarSystemIDs: Object.freeze([
    30000139, 30000140, 30000141, 30000142, 30000143, 30000144, 30000145,
  ]),
});

/** Ascending everywhere in the real dump, so the fixture hands them over reversed. */
const reversed = (rows) => rows.slice().reverse();

/**
 * An invented system: planet 1 with two moons and a belt, planet 2 with
 * neither, two gates, two stations.
 */
const INVENTED_CELESTIALS = [
  { itemID: 40009300, kind: "sun", solarSystemID: INVENTED, itemName: "Nowhere - Star", typeID: 45041, radius: 63350000 },
  { itemID: 40009301, kind: "planet", solarSystemID: INVENTED, orbitID: 40009300 },
  { itemID: 40009302, kind: "moon", solarSystemID: INVENTED, orbitID: 40009301 },
  { itemID: 40009303, kind: "moon", solarSystemID: INVENTED, orbitID: 40009301 },
  { itemID: 40009304, kind: "asteroidBelt", solarSystemID: INVENTED, orbitID: 40009301 },
  { itemID: 40009305, kind: "planet", solarSystemID: INVENTED, orbitID: 40009300 },
];

const TABLES = {
  solarSystems: {
    source: SOURCE,
    solarSystems: [
      {
        solarSystemID: INVENTED,
        solarSystemName: "Nowhere",
        constellationID: KIMOTORO,
        regionID: 10000002,
        position: { x: -1e17, y: 2.5, z: 0 },
        security: 0.5,
        securityClass: "B",
        sunTypeID: 45041,
      },
      // The wormhole case: no security class, no stargates, no stations.
      {
        solarSystemID: 31009000,
        solarSystemName: "J000000",
        constellationID: 21000001,
        regionID: 11000001,
        position: { x: 1, y: 2, z: 3 },
        security: -0.99,
        securityClass: "",
      },
    ],
  },
  celestials: { celestials: reversed([...INVENTED_CELESTIALS, JITA_STAR_CELESTIAL]) },
  stargates: {
    stargates: reversed([
      { itemID: 50009001, solarSystemID: INVENTED },
      { itemID: 50009002, solarSystemID: INVENTED },
    ]),
  },
  stations: {
    stations: reversed([
      {
        stationID: 60009001,
        stationName: "Nowhere I - Moon 1 - Test Assembly Plant",
        stationTypeID: 1531,
        solarSystemID: INVENTED,
        corporationID: 1000002,
        stationRaceID: 1,
        operationID: 14,
        maxShipVolumeDockable: 50000000,
        officeRentalCost: 10000,
        reprocessingEfficiency: 0.5,
        reprocessingStationsTake: 0.05,
        position: { x: -107303362560, y: -18744975360, z: 436489052160 },
      },
      {
        stationID: 60009002,
        stationName: "Nowhere II - Test Storage",
        stationTypeID: 1531,
        solarSystemID: INVENTED,
        corporationID: 1000002,
        operationID: 99,
        maxShipVolumeDockable: 50000000,
        officeRentalCost: 10000,
        reprocessingEfficiency: 0.5,
        reprocessingStationsTake: 0.05,
        position: { x: 1, y: 2, z: 3 },
      },
    ]),
  },
};

const SDE = {
  "mapConstellations.jsonl": [KIMOTORO_DUMP],
  "mapStars.jsonl": [JITA_STAR_DUMP],
  // Operation 14 as the dump has it: unsorted, with `cloning` last. Operation 99
  // is invented, and carries a service id the 2020-01-01 enum has no name for.
  "stationOperations.jsonl": [
    { _key: 14, services: [1, 3, 5, 7, 13, 14, 17, 19, 21, 22, 23, 25, 26, 27, 10] },
    { _key: 99, services: [7, 999] },
  ],
};

/** A store over the fixture, counting what it read so laziness can be asserted. */
function fixtureStore({ tables = TABLES, sde = SDE } = {}) {
  const reads = [];
  const store = createUniverseStore({
    readTable(table, key) {
      reads.push(`${table}.${key}`);
      const held = tables[table];
      if (held === undefined || held[key] === undefined) {
        throw new UniverseDataError(`fixture has no ${table}.${key}`);
      }
      return held[key];
    },
    readSdeRecords(file) {
      reads.push(file);
      const held = sde[file];
      if (held === undefined) throw new UniverseDataError(`fixture has no dump file ${file}`);
      return held;
    },
  });
  return { store, reads };
}

const at = (id) => ({ path: { system_id: id, star_id: id, constellation_id: id, station_id: id } });

/** A projected body as the client parses it: through the application's bytes. */
const onTheWire = (body) => JSON.parse(serializeBody(body, PRODUCER.APP).toString());

// The spec

test("all four routes agree with the pinned spec about scope, TTL and limiter", () => {
  const { store } = fixtureStore();
  const routes = [
    [createUniverseSystemRoute({ store }), "/universe/systems/30000142/"],
    [createUniverseStarRoute({ store }), "/universe/stars/40009076/"],
    [createUniverseConstellationRoute({ store }), "/universe/constellations/20000020/"],
    [createUniverseStationRoute({ store }), "/universe/stations/60003760/"],
  ];

  for (const [route, wirePath] of routes) {
    const contract = describeOperation("get", wirePath);

    // No `x-cache-age` and no `x-rate-limit` on any of them. What CCP publishes
    // instead is one sentence of prose, and `lib/staticSnapshot.js` is what this
    // replica does with it.
    assert.equal(contract.cacheAgeSeconds, null, `${route.name} publishes an x-cache-age after all`);
    assert.equal(contract.rateLimit, null, `${route.name} publishes a rate-limit group after all`);
    assert.equal(route.cacheTtl, undefined);
    assert.equal(route.rateLimitGroup, null);
    assert.equal(route.scope, undefined, `${route.name} is public`);
    assert.deepEqual(contract.scopes, [], `${route.name} is public`);

    // What CCP publishes instead of a TTL, on each of the four: one sentence of
    // prose. It is the second source for 11:05 (the first is the wire), and it is
    // why `lib/staticSnapshot.js` treats that instant as a constant.
    assert.match(
      spec.paths[contract.specPath].get.description,
      /expires daily at 11:05/,
      `${route.name} no longer says when it expires`,
    );
  }
});

test("each body satisfies its operation's schema, every required field present", () => {
  const { store } = fixtureStore();

  // Checked as the client receives it. A field marked `double()` is a marker
  // object until the producer's serializer writes it, so a spec check run on the
  // projection's own output would see an object where the schema says number.
  // Round-tripping through the wire bytes is also the only thing that proves
  // `50000000.0` parses back as a number rather than as a string somebody
  // spelled with digits.
  assertBody(onTheWire(buildSystem(at("30009000"), store)), describeOperation("get", "/universe/systems/30009000/"));
  assertBody(onTheWire(buildStar(at("40009076"), store)), describeOperation("get", "/universe/stars/40009076/"));
  assertBody(
    onTheWire(buildConstellation(at("20000020"), store)),
    describeOperation("get", "/universe/constellations/20000020/"),
  );
  assertBody(
    onTheWire(buildStation(at("60009001"), store)),
    describeOperation("get", "/universe/stations/60009001/"),
  );
});

test("the service vocabulary is CCP's enum, id for id", () => {
  // `stationServices.jsonl` numbers its 27 services 1..27 and the spec's enum has
  // 27 members in that order, which is what makes a table keyed by id legitimate
  // rather than a coincidence.
  const enumerated = spec.components.schemas.UniverseStationsStationIdGet
    .properties.services.items.enum;

  assert.deepEqual(Object.values(SERVICE_BY_ID), enumerated);

  // The two typos survive, because a slugifier would quietly fix them and every
  // client matching the enum would stop finding those services.
  assert.equal(SERVICE_BY_ID[2], "assasination-missions");
  assert.equal(SERVICE_BY_ID[15], "labratory");
});

// The recordings

test("a star serializes to the bytes CCP sent, all 174 of them", () => {
  const { store } = fixtureStore();
  golden.assertGolden("GetUniverseStarsStarId", buildStar(at("40009076"), store));
});

test("a constellation serializes to the bytes CCP sent, all 231 of them", () => {
  const { store } = fixtureStore();
  const body = buildConstellation(at("20000020"), store);
  // On one line, and it has to be: `test/serialize.test.js` finds the callers of
  // a recording by reading these sources for the literal call.
  golden.assertGolden("GetUniverseConstellationsConstellationId", body);
});

test("a system's recording is matched on its field set, key order and last byte", () => {
  // It cannot be an `assertGolden` diff, because of one field:
  // `security_status`. CCP sends `0.9459131360054016` for Jita and
  // `mapSolarSystems.jsonl` publishes `0.945913`, a six-decimal rounding of a
  // float32, so the wire value is not recoverable from the dump.
  // `Math.fround(0.945913)` is `0.9459130167961121`, which is near it and is not
  // it, and manufacturing that noise would be worse than serving the number the
  // dump has.
  const { bytes, value } = golden.loadGolden("GetUniverseSystemsSystemId");
  const { store } = fixtureStore({ tables: systemTablesFrom(value) });
  const ours = buildSystem(at(String(value.system_id)), store);

  assert.deepEqual(Object.keys(ours), Object.keys(value), "field set and order");
  assert.deepEqual(Object.keys(ours.planets[3]), Object.keys(value.planets[3]), "a planet's fields");

  const wire = onTheWire(ours);
  for (const [field, recorded] of Object.entries(value)) {
    if (field === "security_status") continue;
    assert.deepEqual(wire[field], recorded, `${field} does not match the recording`);
  }

  // The last byte is the producer's and is part of the recording: an application
  // body does not end with a newline.
  assert.notEqual(bytes[bytes.length - 1], 0x0a);
  const produced = serializeBody(ours, PRODUCER.APP);
  assert.notEqual(produced[produced.length - 1], 0x0a);

  // The one field that differs really is the only one: same length but for that
  // value's digits.
  assert.equal(
    produced.toString().replace(/"security_status":[^,]+/, ""),
    bytes.toString().replace(/"security_status":[^,]+/, ""),
  );
});

test("a station's recording is matched on everything but the rent", () => {
  // `office_rental_cost` is a live, moving number on Tranquility (8,675,313,605
  // ISK at Jita 4-4 on the day of the recording) and a static 10,000 in the
  // store. Everything else, including the fifteen service strings and their
  // order, comes out of the dump.
  const { entry, value } = golden.loadGolden("GetUniverseStationsStationId");
  assert.equal(entry.diff, "shape");

  const { store } = fixtureStore();
  const ours = buildStation(at("60009001"), store);

  assert.deepEqual(Object.keys(ours), Object.keys(value), "field set and order");
  assert.deepEqual(ours.services, value.services, "the service list, ascending by service id");
  assert.deepEqual(Object.keys(onTheWire(ours).position), ["x", "y", "z"]);
});

/**
 * The gameStore tables a recorded system body describes.
 *
 * Built from the recording so the ids are CCP's rather than invented, and handed
 * over reversed so nothing here can pass by accident of ordering.
 */
function systemTablesFrom(body) {
  const celestials = [];
  if (body.star_id !== undefined) {
    celestials.push({
      itemID: body.star_id,
      kind: "sun",
      solarSystemID: body.system_id,
      itemName: `${body.name} - Star`,
      typeID: 3796,
      radius: 513100000,
    });
  }
  for (const planet of body.planets || []) {
    celestials.push({ itemID: planet.planet_id, kind: "planet", solarSystemID: body.system_id });
    for (const moon of planet.moons || []) {
      celestials.push({
        itemID: moon, kind: "moon", solarSystemID: body.system_id, orbitID: planet.planet_id,
      });
    }
    for (const belt of planet.asteroid_belts || []) {
      celestials.push({
        itemID: belt, kind: "asteroidBelt", solarSystemID: body.system_id, orbitID: planet.planet_id,
      });
    }
  }

  return {
    solarSystems: {
      source: SOURCE,
      solarSystems: [{
        solarSystemID: body.system_id,
        solarSystemName: body.name,
        constellationID: body.constellation_id,
        position: body.position,
        security: body.security_status,
        securityClass: body.security_class,
      }],
    },
    celestials: { celestials: reversed(celestials) },
    stargates: {
      stargates: reversed((body.stargates || []).map((itemID) => ({
        itemID, solarSystemID: body.system_id,
      }))),
    },
    stations: {
      stations: reversed((body.stations || []).map((stationID) => ({
        stationID, solarSystemID: body.system_id, operationID: 14,
      }))),
    },
  };
}

// Shaping

test("moons and belts hang off the planet they orbit, and everything comes out ascending", () => {
  const { store } = fixtureStore();
  const body = buildSystem(at(String(INVENTED)), store);

  assert.deepEqual(body.planets, [
    { asteroid_belts: [40009304], moons: [40009302, 40009303], planet_id: 40009301 },
    { planet_id: 40009305 },
  ]);
  assert.deepEqual(body.stargates, [50009001, 50009002]);
  assert.deepEqual(body.stations, [60009001, 60009002]);
  assert.equal(body.star_id, 40009300);
});

test("an empty collection is an absent key, not an empty array", () => {
  // Thera has no stargates and CCP sends no `stargates`, rather than `[]`. A
  // client testing `"stargates" in body` and one testing `body.stargates.length`
  // both get the right answer only if the key is gone.
  const { store } = fixtureStore();
  const body = buildSystem(at("31009000"), store);

  assert.ok(!("stargates" in body));
  assert.ok(!("stations" in body));
  assert.ok(!("planets" in body));
  assert.ok(!("star_id" in body));
});

test("an empty security class is an absence, and the only field where that is true", () => {
  // 3,297 of the store's 8,490 systems carry `securityClass: ""` and CCP omits the
  // key on every one of them: `/universe/systems/30000253/` sends no
  // `security_class` where Jita sends `"B"`. `optional()` keeps `""` on purpose,
  // which is why this field does not use it.
  const { store } = fixtureStore();

  assert.ok(!("security_class" in buildSystem(at("31009000"), store)));
  assert.equal(buildSystem(at(String(INVENTED)), store).security_class, "B");
});

test("a service id the enum cannot name is dropped, not guessed at", () => {
  const { store } = fixtureStore();
  // Operation 99 carries service 999, which no ESI enum member names.
  assert.deepEqual(buildStation(at("60009002"), store).services, ["market"]);
});

test("a star's age is seconds to years, truncated, over a Julian year", () => {
  const { store } = fixtureStore();
  const body = buildStar(at("40009076"), store);

  assert.equal(SECONDS_PER_JULIAN_YEAR, 31_557_600);
  assert.equal(body.age, Math.floor(JITA_STAR_DUMP.statistics.age / SECONDS_PER_JULIAN_YEAR));
  // Truncated rather than rounded, which Tanoo settles: 14262808228.65 years on
  // the wire is 14262808228.
  assert.equal(Math.floor(4.500999969565573e+17 / SECONDS_PER_JULIAN_YEAR), 14262808228);
  // The dump's `life` is not a field ESI publishes.
  assert.ok(!("life" in body));
});

test("luminosity is decoded as the float32 the dump printed, not left as written", () => {
  const { store } = fixtureStore();
  // `1.692` in the dump is the shortest decimal that round-trips CCP's float32,
  // so reading it back as one recovers the exact value CCP sends. The star
  // recording is the proof; this is the mechanism.
  assert.equal(onTheWire(buildStar(at("40009076"), store)).luminosity, Math.fround(1.692));
  assert.notEqual(Math.fround(1.692), 1.692);
});

// Not found, and the two kinds of failure

test("each endpoint's 404 names its own entity, in CCP's words", async () => {
  const { store } = fixtureStore();
  const cases = [
    [createUniverseSystemRoute({ store }), "/latest/universe/systems/30099999/", "System not found"],
    [createUniverseStarRoute({ store }), "/latest/universe/stars/40999999/", "Star not found"],
    [
      createUniverseConstellationRoute({ store }),
      "/latest/universe/constellations/20099999/",
      "Constellation not found",
    ],
    [
      createUniverseStationRoute({ store }),
      "/latest/universe/stations/60999999/",
      "Station not found",
    ],
  ];

  for (const [route, pathname, message] of cases) {
    const router = createRouter([route]);
    const result = await dispatchRequest(router, { method: "GET", pathname, query: {}, headers: {} });

    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: message });
    // The legacy family's shape: an entity noun, and no `status` field.
    assert.ok(!("status" in result.body));
  }
});

test("an id that is not a number is that same 404, not a coercion refusal", async () => {
  const { store } = fixtureStore();
  const router = createRouter([createUniverseSystemRoute({ store })]);
  const result = await dispatchRequest(
    router,
    { method: "GET", pathname: "/latest/universe/systems/abc/", query: {}, headers: {} },
  );

  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { error: "System not found" });
  assert.equal(parseId("abc"), null);
  assert.equal(parseId("0"), null);
  assert.equal(parseId("-1"), null);
  assert.equal(parseId("30000142"), 30000142);
});

test("a missing dump is a 500 and not a false body", async () => {
  // D42. `services` is required on a station and `name` on a constellation, and
  // eve-nexum reads that name unguarded on any 2xx, so an empty list and an absent
  // name are both worse than a refusal.
  const { store } = fixtureStore({ sde: {} });

  assert.throws(() => buildConstellation(at("20000020"), store), UniverseDataError);
  assert.throws(() => buildStar(at("40009076"), store), UniverseDataError);
  assert.throws(() => buildStation(at("60009001"), store), UniverseDataError);

  // The one endpoint that does not need the dump keeps working: a half-built
  // checkout still serves the system panel's spine.
  assert.equal(buildSystem(at(String(INVENTED)), store).name, "Nowhere");

  const router = createRouter([createUniverseConstellationRoute({ store })]);
  const result = await dispatchRequest(
    router,
    { method: "GET", pathname: "/latest/universe/constellations/20000020/", query: {}, headers: {} },
    { logError: () => {} },
  );
  assert.equal(result.status, 500);
});

test("a table the store does not have is a failure, not an empty universe", () => {
  const { store } = fixtureStore({ tables: {} });
  assert.throws(() => buildSystem(at("30000142"), store), UniverseDataError);
});

test("every index is built once, however many requests arrive", () => {
  const { store, reads } = fixtureStore();

  buildSystem(at(String(INVENTED)), store);
  buildSystem(at(String(INVENTED)), store);
  buildSystem(at("31009000"), store);

  assert.deepEqual(
    reads.filter((read) => read === "celestials.celestials").length,
    1,
    "the 461,881-row table was grouped more than once",
  );

  // Nothing was read that the answer did not need: a system body needs no dump
  // at all.
  assert.deepEqual(reads.filter((read) => read.endsWith(".jsonl")), []);
});

// The shared snapshot (D43)

/** The four routes, behind the cache layer, sharing one snapshot. */
function surface(now) {
  const { store } = fixtureStore();
  const snapshot = createStaticSnapshot({ readIdentity: () => store.identity(), build: BUILD });
  const deps = { store, snapshot: (reading) => snapshot.facts(reading) };
  const router = createRouter([
    createUniverseSystemRoute(deps),
    createUniverseStarRoute(deps),
    createUniverseConstellationRoute(deps),
    createUniverseStationRoute(deps),
  ]);
  return createCacheDispatch(
    (request) => dispatchRequest(router, request, { logError: () => {}, now: () => now }),
    { now: () => now },
  );
}

const NOW = Date.parse("2026-08-25T18:41:20Z");

/** A mod build, the shape `lib/sourceHash.js` `shortSourceHash` returns. */
const BUILD = "14b09c025db2";

test("all four answer with one etag, one Last-Modified and one Expires", async () => {
  const dispatch = surface(NOW);
  const paths = [
    `/latest/universe/systems/${INVENTED}/`,
    "/latest/universe/stars/40009076/",
    "/latest/universe/constellations/20000020/",
    "/latest/universe/stations/60009001/",
  ];

  const seen = [];
  for (const pathname of paths) {
    const result = await dispatch({ method: "GET", pathname, query: {}, headers: {} });
    assert.equal(result.status, 200, pathname);
    seen.push({
      etag: result.headers.etag,
      lastModified: result.headers["last-modified"],
      expires: result.headers.expires,
      cacheControl: result.headers["cache-control"],
    });
  }

  // One dump, one validator. A client fetching two of them can see this, and it
  // is why this is not a per-body digest.
  for (const answer of seen) assert.deepEqual(answer, seen[0]);

  // Weak, SHA-224, and CCP's own shape: `W/"<56 hex>"`.
  assert.match(seen[0].etag, /^W\/"[0-9a-f]{56}"$/);
  // Bare `public`, like every other application route.
  assert.equal(seen[0].cacheControl, "public");
  // The dump's real modification time, not this morning's rebuild: a private
  // server's static data changed when the operator built it.
  assert.equal(seen[0].lastModified, "Fri, 14 Aug 2026 15:56:13 GMT");
  // The next 11:05 UTC, which is the cadence CCP's clients are written against
  // and the spec states in prose.
  assert.equal(seen[0].expires, "Wed, 26 Aug 2026 11:05:00 GMT");
  assert.equal(nextExpiry(NOW), Date.parse("2026-08-26T11:05:00Z"));
});

test("the etag moves when the dump does, and only then", () => {
  const identity = (generatedAt, build = BUILD) => createStaticSnapshot({
    readIdentity: () => ({ identity: `generated:${generatedAt}`, generatedAt: 0 }),
    build,
  }).facts(NOW).etag;

  assert.equal(identity("2026-08-14T15:56:13.265Z"), identity("2026-08-14T15:56:13.265Z"));
  assert.notEqual(identity("2026-08-14T15:56:13.265Z"), identity("2026-08-15T09:00:00.000Z"));
});

test("the etag moves when the mod does, which the dump cannot say", () => {
  // Found on the wire: redeploying build 14b09c025db2 as 286250a07449 over an
  // unchanged store left the validator untouched, so a client holding a body built
  // by the old projection had no way to learn the new one existed until 11:05. The
  // dump is one of the two things that decide these bodies; this mod is the other.
  const etagFor = (build) => createStaticSnapshot({
    readIdentity: () => ({
      identity: ["authority:x", "build:1", "generated:2026-08-14"].join("\n"),
      generatedAt: 0,
    }),
    build,
  }).facts(NOW).etag;

  assert.notEqual(etagFor("14b09c025db2"), etagFor("286250a07449"));
  assert.equal(etagFor("14b09c025db2"), etagFor("14b09c025db2"));
});

test("a snapshot with no build is refused at construction, not silently unversioned", () => {
  // A default here would be a stale body nobody can see, so the parameter is
  // required. `lib/sourceHash.js` `shortSourceHash` answers `"unknown"` rather
  // than null when it cannot read the tree, so the loader always has one to pass
  // and this can never fire in production.
  assert.throws(
    () => createStaticSnapshot({ readIdentity: () => null }),
    /needs the mod's build/,
  );
  assert.throws(
    () => createStaticSnapshot({ readIdentity: () => null, build: "" }),
    /needs the mod's build/,
  );
});

test("11:05 is a boundary, so a request at it is told about tomorrow", () => {
  assert.equal(nextExpiry(Date.parse("2026-08-25T11:04:59Z")), Date.parse("2026-08-25T11:05:00Z"));
  assert.equal(nextExpiry(Date.parse("2026-08-25T11:05:00Z")), Date.parse("2026-08-26T11:05:00Z"));
  assert.equal(nextExpiry(Date.parse("2026-08-25T00:00:00Z")), Date.parse("2026-08-25T11:05:00Z"));
});

test("a static-data 404 carries the etag, and carries nothing else", async () => {
  // `contract/wire.js` SENDS_CACHE_HEADERS records this as the one refusal on
  // the surface that carries a cache header at all.
  const dispatch = surface(NOW);
  const result = await dispatch({
    method: "GET",
    pathname: "/latest/universe/systems/30099999/",
    query: {},
    headers: {},
  });

  assert.equal(result.status, 404);
  assert.match(result.headers.etag, /^W\/"[0-9a-f]{56}"$/);
  assert.ok(!("cache-control" in result.headers));
  assert.ok(!("expires" in result.headers));
  assert.ok(!("last-modified" in result.headers));
});

test("a snapshot route and a cacheTtl together is a boot failure", () => {
  assert.throws(
    () => createRouter([{
      method: "GET",
      path: "/universe/systems/:system_id",
      name: "GetUniverseSystemsSystemId",
      handler: () => ({}),
      producer: PRODUCER.APP,
      cacheTtl: 86400,
      snapshot: () => ({ etag: 'W/"x"', lastModified: 0, expires: 0 }),
    }]),
    /snapshot and cacheTtl/,
  );
});

// Vary, which splits these four in half

test("a translated name repeats Accept-Language and a composed one does not", async () => {
  const dispatch = surface(NOW);
  const varyFor = async (pathname) => (await dispatch({
    method: "GET", pathname, query: {}, headers: {},
  })).headers.vary;

  const four = ["X-Tenant", "Accept-Language", "X-Compatibility-Date", "Accept-Language"];
  const three = ["X-Tenant", "Accept-Language", "X-Compatibility-Date"];

  // A system's and a constellation's `name` is a translated string in the dump.
  assert.deepEqual(await varyFor(`/latest/universe/systems/${INVENTED}/`), four);
  assert.deepEqual(await varyFor("/latest/universe/constellations/20000020/"), four);
  // A star's and a station's is composed: "Jita - Star", "Nowhere I - Moon 1 ...".
  assert.deepEqual(await varyFor("/latest/universe/stars/40009076/"), three);
  assert.deepEqual(await varyFor("/latest/universe/stations/60009001/"), three);
});

// lib/ and contract/ have to be saying the same thing

test("the snapshot's constants are the ones that were observed", () => {
  // `lib/` cannot import `contract/` (it is test-only and never deployed, D20), so
  // the values are duplicated and this test checks that they agree. The same
  // bargain `test/cache.test.js` takes for the producer policies.
  assert.deepEqual({ ...EXPIRY_UTC }, { ...wire.STATIC_DATA.expiresAt });
  assert.equal(ETAG_ALGORITHM, wire.STATIC_DATA.etag.algorithm);
  assert.equal(ETAG_WEAK_PREFIX === "W/", wire.STATIC_DATA.etag.weak);

  // The digest length follows from the algorithm rather than from a regex
  // somebody wrote down: 56 hex characters is 224 bits.
  const facts = createStaticSnapshot({
    readIdentity: () => ({ identity: "x", generatedAt: 0 }),
    build: BUILD,
  }).facts(NOW);
  assert.equal(facts.etag.length, ETAG_WEAK_PREFIX.length + 2 + 56);
});

test("each 404's noun and byte count are the ones CCP sent", async () => {
  const { store } = fixtureStore();
  const routes = {
    "/universe/systems/:system_id":
      [createUniverseSystemRoute({ store }), "/latest/universe/systems/30099999/"],
    "/universe/stars/:star_id":
      [createUniverseStarRoute({ store }), "/latest/universe/stars/40999999/"],
    "/universe/constellations/:constellation_id":
      [createUniverseConstellationRoute({ store }), "/latest/universe/constellations/20099999/"],
    "/universe/stations/:station_id":
      [createUniverseStationRoute({ store }), "/latest/universe/stations/60999999/"],
  };

  assert.deepEqual(Object.keys(routes).sort(), Object.keys(wire.UNIVERSE_NOT_FOUND).sort());
  assert.deepEqual(
    Object.values(wire.UNIVERSE_NOT_FOUND).map((observed) => observed.entity).sort(),
    Object.values(ENTITY).slice().sort(),
  );

  for (const [specPath, [route, pathname]] of Object.entries(routes)) {
    const observed = wire.UNIVERSE_NOT_FOUND[specPath];
    const result = await dispatchRequest(
      createRouter([route]),
      { method: "GET", pathname, query: {}, headers: {} },
    );

    assert.deepEqual(result.body, { error: `${observed.entity} not found` });
    // The refusal's bytes, counted the way `content-length` counts them. The
    // application sends no trailing newline, so the body is the whole of it.
    assert.equal(
      serializeBody(result.body, PRODUCER.APP).length,
      observed.contentLength,
      `${specPath} refuses in a different number of bytes than CCP did`,
    );
  }
});
