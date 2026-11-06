/**
 * The four static-universe reads eve-nexum's system panel and map are built on:
 * a solar system, its star, its constellation, and an NPC station.
 *
 * All four are the application producer and all four are one snapshot of one
 * static dump. Observed 2026-08-25:
 *
 *   curl -sD - .../latest/universe/systems/30000142/
 *     Cache-Control: public              Etag: W/"a3cbe689..."  (56 hex, weak)
 *     Last-Modified: Mon, 24 Aug 11:03   Expires: Wed, 26 Aug 11:05:00
 *     Vary: X-Tenant / Accept-Language / X-Compatibility-Date / Accept-Language
 *     (no X-Ratelimit-*, so the error limiter answers)
 *
 *   curl -sD - .../latest/universe/stations/60003760/
 *     the same Etag, the same Expires, three Vary lines instead of four
 *
 * The etag is the same on all four, and on `/universe/types/` and
 * `/universe/regions/` too: they are one dump. `lib/staticSnapshot.js` is that
 * mechanism and D43 is the decision.
 *
 * No `cacheTtl`: none of the four publishes an `x-cache-age`. The pinned spec
 * gives one sentence of prose on each ("This route expires daily at 11:05"),
 * and `contract/spec.js` refuses a `cacheTtl` for that reason. `Expires` is an
 * instant, not a window, so `lib/router.js` refuses a route that declares both.
 *
 * The fourth `Vary` line splits the four. A system and a constellation carry a
 * `name` that is a translated string in the dump (eight languages, of which this
 * replica serves `en`) and repeat `Accept-Language`. A star and a station carry
 * a `name` that is composed ("Jita - Star", "Jita IV - Moon 4 - Caldari Navy
 * Assembly Plant") and do not. The content rule is "the application repeats it
 * iff the `200` schema carries a `name` or `description` string", and all four
 * schemas carry a `name`, so the rule does not hold for the composed pair. The
 * spec cannot tell a translated name from a composed one but the dump can:
 * `mapSolarSystems.jsonl` and `mapConstellations.jsonl` carry a `name`
 * dictionary of eight languages, `mapStars.jsonl` and `npcStations.jsonl` carry
 * no name. So the wire follows the dump, and `contract/wire.js`
 * `VARY_LOCALIZED_SURVEY.plainDespiteComposedName` holds the two
 * counter-examples. `localizedBody` is declared per route because on these four
 * it cannot be derived.
 *
 * Values come from `lib/universeStore.js` (D42): the gameStore's SDE-derived
 * tables, plus a second arm reading the extracted dump for constellation names,
 * star statistics and station services.
 *
 * Two of the four bodies are `contract/golden/` byte diffs: a constellation and
 * a star come out of the dump digit for digit (231 and 174 bytes). Two fields
 * cannot match:
 *
 *   security_status  CCP's is a `float32` of a value with more precision than
 *                    the dump publishes. Jita is `0.9459131360054016` on the
 *                    wire and `0.945913` in `mapSolarSystems.jsonl`, and
 *                    `Math.fround(0.945913)` is `0.9459130167961121`. This
 *                    serves the dump's number rather than manufacturing
 *                    float32 noise around it.
 *   office_rental_cost  a live, moving number on Tranquility (8,675,313,605 ISK
 *                    at Jita 4-4 on the day of the recording) and a static
 *                    10,000 in the store. A private server's is its own.
 *
 * `luminosity` and `radius` differ: the dump prints them as the shortest decimal
 * that round-trips a float32 (`1.692`, where CCP sends `1.6920000314712524`),
 * so `Math.fround` decodes the exact stored value, and the star recording
 * matches byte for byte. `securityStatus` is a six-decimal rounding that no
 * function can undo.
 */

"use strict";

const { notFound } = require("../lib/errors");
const { RouteRefusal } = require("../lib/router");
const {
  OMIT, SerializationError, double, optional, projection,
} = require("../lib/serialize");

const SYSTEM_PATH = "/universe/systems/:system_id";
const STAR_PATH = "/universe/stars/:star_id";
const CONSTELLATION_PATH = "/universe/constellations/:constellation_id";
const STATION_PATH = "/universe/stations/:station_id";

const PRODUCER = "app";

/** None of the four publishes an `x-rate-limit`, so the error budget answers. */
const RATE_LIMIT_GROUP = null;

/**
 * The entity noun each `404` names, observed one by one on 2026-08-25.
 *
 * The legacy family words a not-found as `<Entity> not found`, and the noun is
 * not derivable from the operation, schema, parameter or tag: the body says
 * `System`, not `Solar system`. Four `curl`s, four nouns, 28/26/35/29 bytes:
 *
 *   GET /latest/universe/systems/30099999/         {"error":"System not found"}
 *   GET /latest/universe/stars/40999999/           {"error":"Star not found"}
 *   GET /latest/universe/constellations/20099999/  {"error":"Constellation not found"}
 *   GET /latest/universe/stations/60999999/        {"error":"Station not found"}
 */
const ENTITY = Object.freeze({
  SYSTEM: "System",
  STAR: "Star",
  CONSTELLATION: "Constellation",
  STATION: "Station",
});

/**
 * A star's `age` is in years and the dump keeps seconds, over a 365.25-day
 * year, truncated.
 *
 * Jita's star is `2.1750000002269184e16` seconds in `mapStars.jsonl` and
 * `689215910` years on the wire, which is 31,557,600 seconds each (the Julian
 * year). Tanoo's settles truncation over rounding: `14262808228.65` years, and
 * CCP sends `14262808228`.
 */
const SECONDS_PER_JULIAN_YEAR = 31_557_600;

/**
 * `serviceID` -> the string CCP publishes. This is a table and not a slugifier.
 *
 * The dump names services in prose ("Assassination Missions", "Laboratory",
 * "Security Office") and the wire spells three differently:
 * `assasination-missions` with one `s`, `labratory` with no `o`, and
 * `security-offices` in the plural. Two are CCP's own typos and are reproduced;
 * a slugifier would fix them and clients matching the enum would stop finding
 * those services.
 *
 * `stationServices.jsonl` has 27 rows numbered 1..27 and the pinned spec's
 * `services` enum has 27 members in that order.
 * `test/universeContract.test.js` asserts this table against the enum, so a
 * spec re-pin that adds a service fails there.
 */
const SERVICE_BY_ID = Object.freeze({
  1: "bounty-missions",
  2: "assasination-missions",
  3: "courier-missions",
  4: "interbus",
  5: "reprocessing-plant",
  6: "refinery",
  7: "market",
  8: "black-market",
  9: "stock-exchange",
  10: "cloning",
  11: "surgery",
  12: "dna-therapy",
  13: "repair-facilities",
  14: "factory",
  15: "labratory",
  16: "gambling",
  17: "fitting",
  18: "paintshop",
  19: "news",
  20: "storage",
  21: "insurance",
  22: "docking",
  23: "office-rental",
  24: "jump-clone-facility",
  25: "loyalty-point-store",
  26: "navy-offices",
  27: "security-offices",
});

/**
 * A path id: digits, positive, safe.
 *
 * A malformed one is a `404` and not a `422`, for the reason `routes/markets.js`
 * gives: a validated coercion on these routes is unobserved, and the endpoint's
 * own `404` is observed. `/universe/systems/abc/` names no system.
 */
function parseId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function absent(entity) {
  return new RouteRefusal(notFound("legacy", { entity }));
}

/**
 * `{x, y, z}` as three doubles, and a throw for a row that has none.
 *
 * `position` is required on all three bodies that carry it, and a missing
 * coordinate would otherwise vanish (`{x: undefined}` serializes as `{}`).
 * Nothing in the dump lacks one, so this fires only if a table changed shape.
 */
function position(value) {
  const point = value === null || typeof value !== "object" ? {} : value;
  for (const axis of ["x", "y", "z"]) {
    if (typeof point[axis] !== "number") {
      throw new SerializationError(
        `ESI mod: a universe position has no numeric ${axis} (${JSON.stringify(point[axis])}). `
          + "The static-data row's shape changed.",
      );
    }
  }
  return { x: double(point.x), y: double(point.y), z: double(point.z) };
}

/**
 * A list, or `OMIT` when it is empty.
 *
 * Every id list on these bodies is optional in the spec and omitted on the
 * wire: Thera has no stargates and no `stargates` key, rather than an empty
 * array.
 */
function idsOrOmit(ids) {
  return Array.isArray(ids) && ids.length > 0 ? ids : OMIT;
}

// The four projections

/**
 * A planet, and the two collections that hang off it.
 *
 * Alphabetical inside the object (`asteroid_belts`, `moons`, `planet_id`),
 * which is CCP's order; a byte diff of Tanoo's body fails otherwise.
 */
const projectPlanet = projection("GetUniverseSystemsSystemIdPlanet", {
  asteroid_belts: (planet) => idsOrOmit(planet.asteroidBelts),
  moons: (planet) => idsOrOmit(planet.moons),
  planet_id: (planet) => planet.planetId,
});

const projectSystem = projection("GetUniverseSystemsSystemId", {
  constellation_id: (system) => system.constellationId,
  name: (system) => system.name,
  planets: (system) => idsOrOmit(system.planets.map((planet) => projectPlanet(planet))),
  position: (system) => position(system.position),
  // An empty string is an absence here, so `optional()`, which keeps `""` on
  // purpose, is the wrong helper. 3,297 of the store's 8,490 systems carry
  // `securityClass: ""`, and CCP omits the key on every one of them:
  // `/universe/systems/30000253/` sends no `security_class`, where Jita sends
  // `"B"`.
  security_class: (system) => (
    typeof system.securityClass === "string" && system.securityClass !== ""
      ? system.securityClass
      : OMIT
  ),
  security_status: (system) => double(system.securityStatus),
  star_id: (system) => optional(system.starId),
  stargates: (system) => idsOrOmit(system.stargates),
  stations: (system) => idsOrOmit(system.stations),
  system_id: (system) => system.systemId,
});

const projectStar = projection("GetUniverseStarsStarId", {
  age: (star) => Math.floor(star.age / SECONDS_PER_JULIAN_YEAR),
  luminosity: (star) => double(Math.fround(star.luminosity)),
  name: (star) => star.name,
  // `int64` in the spec, and a `float32` in the dump: J015092's star is
  // 1,230,605,103 there and 1,230,605,056 on the wire, which is that number
  // rounded to the nearest float32. Jita's 513,100,000 is exact in both.
  radius: (star) => Math.trunc(Math.fround(star.radius)),
  solar_system_id: (star) => star.solarSystemId,
  spectral_class: (star) => star.spectralClass,
  // Also `int64` and fractional in the dump (10173.957031), and also truncated
  // rather than rounded on the wire.
  temperature: (star) => Math.trunc(star.temperature),
  type_id: (star) => star.typeId,
});

const projectConstellation = projection("GetUniverseConstellationsConstellationId", {
  constellation_id: (constellation) => constellation.constellationId,
  name: (constellation) => constellation.name,
  position: (constellation) => position(constellation.position),
  region_id: (constellation) => constellation.regionId,
  systems: (constellation) => constellation.systems,
});

const projectStation = projection("GetUniverseStationsStationId", {
  max_dockable_ship_volume: (station) => double(station.maxDockableShipVolume),
  name: (station) => station.name,
  office_rental_cost: (station) => double(station.officeRentalCost),
  owner: (station) => optional(station.owner),
  position: (station) => position(station.position),
  race_id: (station) => optional(station.raceId),
  reprocessing_efficiency: (station) => double(station.reprocessingEfficiency),
  reprocessing_stations_take: (station) => double(station.reprocessingStationsTake),
  // A service id this replica cannot name is dropped rather than guessed at:
  // `services` is a closed enum, and under-reporting is the direction
  // `routes/roles.js` and `routes/contacts.js` chose.
  services: (station) => station.serviceIds
    .map((id) => SERVICE_BY_ID[id])
    .filter((service) => service !== undefined),
  station_id: (station) => station.stationId,
  system_id: (station) => station.systemId,
  type_id: (station) => station.typeId,
});

// The handlers

/**
 * One shape for all four: parse the id, ask the store, refuse or project.
 *
 * A `null` from the store is "no such id" and becomes the endpoint's own `404`.
 * Anything the store throws (a missing table, a dump not on disk) is not caught
 * here: `lib/router.js` logs it and answers a `500` (D42, refuse loudly).
 */
function readOne(store, method, entity, rawId, project) {
  const id = parseId(rawId);
  const record = id === null ? null : store[method](id);
  if (record === null) throw absent(entity);
  return project(record);
}

function buildSystem(params, store) {
  return readOne(store, "system", ENTITY.SYSTEM, params.path.system_id, projectSystem);
}

function buildStar(params, store) {
  return readOne(store, "star", ENTITY.STAR, params.path.star_id, projectStar);
}

function buildConstellation(params, store) {
  return readOne(
    store,
    "constellation",
    ENTITY.CONSTELLATION,
    params.path.constellation_id,
    projectConstellation,
  );
}

function buildStation(params, store) {
  return readOne(store, "station", ENTITY.STATION, params.path.station_id, projectStation);
}

// The route table's four rows

/**
 * `store` is `lib/universeStore.js`'s, and `snapshot` is
 * `lib/staticSnapshot.js`'s `facts`, the same on all four. Both are injected
 * and neither is touched at construction, so `test/serialize.test.js` can build
 * every route with `{}` to read its operation name.
 */
function createUniverseSystemRoute({ store, snapshot } = {}) {
  return {
    method: "GET",
    path: SYSTEM_PATH,
    name: "GetUniverseSystemsSystemId",
    handler: (params) => buildSystem(params, store),
    producer: PRODUCER,
    rateLimitGroup: RATE_LIMIT_GROUP,
    // The name is CCP's, translated, and a client asking in German gets the same
    // `en` this replica gives everyone. The fourth `Vary` line is what CCP sends and
    // the client's only way to know the body could vary.
    localizedBody: true,
    snapshot,
  };
}

function createUniverseStarRoute({ store, snapshot } = {}) {
  return {
    method: "GET",
    path: STAR_PATH,
    name: "GetUniverseStarsStarId",
    handler: (params) => buildStar(params, store),
    producer: PRODUCER,
    rateLimitGroup: RATE_LIMIT_GROUP,
    // "Jita - Star" is composed from a system name, not translated, and CCP's three
    // `Vary` lines agree.
    snapshot,
  };
}

function createUniverseConstellationRoute({ store, snapshot } = {}) {
  return {
    method: "GET",
    path: CONSTELLATION_PATH,
    name: "GetUniverseConstellationsConstellationId",
    handler: (params) => buildConstellation(params, store),
    producer: PRODUCER,
    rateLimitGroup: RATE_LIMIT_GROUP,
    localizedBody: true,
    snapshot,
  };
}

function createUniverseStationRoute({ store, snapshot } = {}) {
  return {
    method: "GET",
    path: STATION_PATH,
    name: "GetUniverseStationsStationId",
    handler: (params) => buildStation(params, store),
    producer: PRODUCER,
    rateLimitGroup: RATE_LIMIT_GROUP,
    snapshot,
  };
}

module.exports = Object.freeze({
  CONSTELLATION_PATH,
  ENTITY,
  PRODUCER,
  RATE_LIMIT_GROUP,
  SECONDS_PER_JULIAN_YEAR,
  SERVICE_BY_ID,
  STAR_PATH,
  STATION_PATH,
  SYSTEM_PATH,
  buildConstellation,
  buildStar,
  buildStation,
  buildSystem,
  createUniverseConstellationRoute,
  createUniverseStarRoute,
  createUniverseStationRoute,
  createUniverseSystemRoute,
  parseId,
  projectConstellation,
  projectPlanet,
  projectStar,
  projectStation,
  projectSystem,
});
