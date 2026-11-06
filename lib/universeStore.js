/**
 * eve.js-mod-esi: the static universe, read-only.
 *
 * Backs four endpoints (a solar system's celestials, a star's statistics, a
 * constellation, an NPC station) from the two places a private server keeps
 * CCP's static data.
 *
 * The gameStore arm is the game's own SDE-derived tables, read through
 * `lib/runtimeAccess.js`'s ownership-guarded repository. They are JSON loaded
 * into memory at game boot, so a read is a property access on a live object,
 * not a file or a query. Four tables:
 *
 *   solarSystems   8,490 rows   name, position, security, constellation, region
 *   celestials   461,881 rows   suns, planets, moons and belts, with orbitID
 *   stargates     13,978 rows   by system, and where each one goes
 *   stations       5,210 rows   the NPC stations, with their operation
 *
 * The SDE arm is the extracted dump those tables were generated from,
 * `<store>/../sde/eve-online-static-data-<build>-jsonl/`, read line by line. It
 * exists because the gameStore lacks three things:
 *
 *   mapConstellations.jsonl    1,184 rows    there is no constellations table,
 *                                            and the only constellation names in
 *                                            the store are on the 5,210 station
 *                                            rows, so a constellation with no
 *                                            station (most of wormhole space)
 *                                            has no name anywhere.
 *   mapStars.jsonl             8,089 rows    age, luminosity, spectral class and
 *                                            temperature. `grep -rl
 *                                            spectralClass` over the whole store
 *                                            matches nothing; the generator
 *                                            keeps a sun's id, type and radius.
 *   stationOperations.jsonl       68 rows    which services a station offers.
 *                                            The store keeps `operationID` and
 *                                            resolves it nowhere except for the
 *                                            two industry flags.
 *
 * Three of the four endpoints need both arms, so the SDE arm is a source, not a
 * fallback, and `UniverseDataError` says so when it is absent.
 *
 * An absent dump is a real state: `lib/runtimeAccess.js` `readSdeBuildFrom`
 * calls it normal for a half-built checkout, and `/status/`'s `server_version`
 * degrades on it (D12). The universe routes refuse loudly (D42): `services` is
 * required on a station body and an empty list claims Jita 4-4 has no market;
 * `name` is required on a constellation and eve-nexum reads it unguarded on any
 * 2xx. So a universe route with no dump answers a logged `500` rather than a
 * false body.
 *
 * Cost, measured: filtering the celestials table for one system takes 11 ms
 * across 461,881 rows, on the event loop the universe ticks on. eve-nexum's
 * `useEsiSystem` caches forever and runs 6 requests concurrently, so a first
 * visit to a region is dozens of those back to back. So the rows are grouped by
 * system once, on the first request that needs them: 26 ms for the whole table,
 * after which a lookup is a `Map.get` over about 50 rows. The index holds
 * references into the game's table (one array per system, no row copies), so it
 * is not a second copy of the universe.
 *
 * The index is lazy. The mod preloads into the game process before the game has
 * decided anything about load order (see `lib/runtimeAccess.js`), and indexing
 * at preload would charge 26 ms to every operator, including those who never
 * serve a universe request.
 *
 * Read-only by construction: every table read goes through
 * `getReadOnlyTableRepository()`, bound to `mod:esiApi`, which owns no table
 * and so cannot write one. The rows handed out are the game's own objects (the
 * repository's reads pass straight through without cloning), so nothing here or
 * above it may mutate one. The projections in `routes/universe.js` read fields
 * and build new objects, which makes the sharing safe.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const runtime = require("./runtimeAccess");

/** The gameStore tables this file reads, and the key each keeps its rows under. */
const TABLES = Object.freeze({
  solarSystems: "solarSystems",
  celestials: "celestials",
  stargates: "stargates",
  stations: "stations",
});

/** The dump files the SDE arm reads. All four are small; the big ones are not needed. */
const SDE_FILES = Object.freeze({
  constellations: "mapConstellations.jsonl",
  stars: "mapStars.jsonl",
  stationOperations: "stationOperations.jsonl",
});

/**
 * `celestials.kind`, upstream's own vocabulary for what a row is.
 *
 * Counted against the live table: 8,089 suns, 68,407 planets, 344,457 moons and
 * 40,928 asteroid belts, which is all 461,881 rows. A fifth value appearing
 * upstream would fall out of every bucket below rather than crash, and would
 * show as a system whose planet lost its moons, which is why
 * `test/universeContract.test.js` counts the kinds it saw.
 */
const KIND = Object.freeze({
  SUN: "sun",
  PLANET: "planet",
  MOON: "moon",
  ASTEROID_BELT: "asteroidBelt",
});

/**
 * A read that could not happen: a table the game does not have, a dump that is
 * not on disk, a row shape that changed.
 *
 * Distinct from "no such id", which is a `null` return and a `404`. This one
 * reaches the router as a throw and becomes a logged `500`, because the server
 * is wrong rather than the caller.
 */
class UniverseDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "UniverseDataError";
  }
}

// The two default arms

/**
 * Pure core: one gameStore table's contents, through the read-only repository.
 *
 * `repository` is anything exposing `read(table, path)`: the real one, or a
 * fixture double, so this file can be exercised with no eve.js checkout and no
 * database.
 */
function readTableFromRepository(repository, table, key) {
  const result = repository.read(table, key);
  if (!result || result.success !== true) {
    throw new UniverseDataError(
      `ESI mod: the game store has no readable "${table}.${key}" `
        + `(${(result && result.errorMsg) || "no answer"}). It is one of the SDE-derived tables `
        + "the static universe is served from: check the table name against the vendor tree.",
    );
  }
  return result.data;
}

/** Thin wrapper: the real repository, resolved on first use. */
function defaultReadTable(table, key) {
  return readTableFromRepository(runtime.getReadOnlyTableRepository(), table, key);
}

/**
 * Pure core: one JSONL file from an extracted dump, as an array of records.
 *
 * Read line by line because a dump file is one JSON object per line with no
 * outer array. Blank lines are skipped, and a line that does not parse fails
 * the whole read: a half-parsed constellation table would answer some ids and
 * 404 others.
 */
function readSdeRecordsFrom(sdeDir, fileName) {
  if (typeof sdeDir !== "string" || sdeDir === "") {
    throw new UniverseDataError(
      `ESI mod: ${fileName} is needed and no extracted SDE dump was found. It lives beside the `
        + "game store, in sde/eve-online-static-data-<build>-jsonl/, and CreateDatabase.bat is "
        + "what puts it there. See D42 for why this refuses rather than answering without it.",
    );
  }

  let raw;
  try {
    raw = fs.readFileSync(path.join(sdeDir, fileName), "utf8");
  } catch (err) {
    throw new UniverseDataError(
      `ESI mod: ${fileName} could not be read from ${sdeDir} (${err.code || err.message}).`,
    );
  }

  const records = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (err) {
      throw new UniverseDataError(
        `ESI mod: ${fileName} has a line that is not JSON (${err.message}).`,
      );
    }
  }
  return records;
}

/**
 * Thin wrapper: this install's dump directory, then the file inside it.
 *
 * The directory name carries CCP's build number and is the only place it
 * survives (see `lib/runtimeAccess.js` `readSdeBuildFrom`), so the path is
 * composed from the build rather than globbed for.
 */
function defaultReadSdeRecords(fileName) {
  const { sdeRoot } = runtime.getStorePaths();
  const build = runtime.readSdeBuildFrom(sdeRoot);
  return readSdeRecordsFrom(
    build === null ? null : path.join(sdeRoot, `eve-online-static-data-${build}-jsonl`),
    fileName,
  );
}

// Shaping helpers

/** An id from a row, or `null`. Never `0`, never a string that looked like one. */
function idOf(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Ascending, which is the order CCP sends every id list in and the dump is written in. */
function ascending(ids) {
  return ids.slice().sort((left, right) => left - right);
}

/**
 * The array a table keeps its rows under, or a throw naming the table.
 *
 * An upstream rename lands here rather than as an endpoint quietly serving an
 * empty universe.
 */
function rowsOf(table, key, data) {
  if (!Array.isArray(data)) {
    throw new UniverseDataError(
      `ESI mod: the game store's "${table}.${key}" is not an array (got `
        + `${data === null ? "null" : typeof data}). The table's shape changed upstream.`,
    );
  }
  return data;
}

/**
 * The store, with every index built on demand and kept.
 *
 * Both arms are injected, so a test builds a universe out of object literals
 * and never opens a database or looks for a dump. The defaults are resolved on
 * first use, never at construction, because this module loads at preload when
 * there is no game runtime to ask.
 */
function createUniverseStore({
  readTable = defaultReadTable,
  readSdeRecords = defaultReadSdeRecords,
} = {}) {
  // One memo per index. `undefined` is "not built yet". Failures are not cached,
  // so a dump that appears after a failed read is picked up by the next request,
  // not the next restart.
  const memo = new Map();

  function once(key, build) {
    if (!memo.has(key)) memo.set(key, build());
    return memo.get(key);
  }

  // The gameStore arm

  function systemsById() {
    return once("systems", () => {
      const rows = rowsOf(
        TABLES.solarSystems,
        "solarSystems",
        readTable(TABLES.solarSystems, "solarSystems"),
      );
      const index = new Map();
      for (const row of rows) {
        const id = idOf(row.solarSystemID);
        if (id !== null) index.set(id, row);
      }
      return index;
    });
  }

  /**
   * `{ bySystem, sunsById }` over the celestials table, in one pass.
   *
   * Grouped by system rather than split into four indexes by kind, because a
   * system body needs all four kinds together and 50 rows is cheap to walk. See
   * the header for the measurements.
   */
  function celestials() {
    return once("celestials", () => {
      const rows = rowsOf(
        TABLES.celestials,
        "celestials",
        readTable(TABLES.celestials, "celestials"),
      );
      const bySystem = new Map();
      const sunsById = new Map();
      for (const row of rows) {
        const systemId = idOf(row.solarSystemID);
        if (systemId !== null) {
          const group = bySystem.get(systemId);
          if (group === undefined) bySystem.set(systemId, [row]);
          else group.push(row);
        }
        if (row.kind === KIND.SUN) {
          const id = idOf(row.itemID);
          if (id !== null) sunsById.set(id, row);
        }
      }
      return { bySystem, sunsById };
    });
  }

  function stargatesBySystem() {
    return once("stargates", () => {
      const rows = rowsOf(TABLES.stargates, "stargates", readTable(TABLES.stargates, "stargates"));
      const index = new Map();
      for (const row of rows) {
        const systemId = idOf(row.solarSystemID);
        const id = idOf(row.itemID);
        if (systemId === null || id === null) continue;
        const group = index.get(systemId);
        if (group === undefined) index.set(systemId, [id]);
        else group.push(id);
      }
      return index;
    });
  }

  function stations() {
    return once("stations", () => {
      const rows = rowsOf(TABLES.stations, "stations", readTable(TABLES.stations, "stations"));
      const byId = new Map();
      const bySystem = new Map();
      for (const row of rows) {
        const id = idOf(row.stationID);
        if (id === null) continue;
        byId.set(id, row);
        const systemId = idOf(row.solarSystemID);
        if (systemId === null) continue;
        const group = bySystem.get(systemId);
        if (group === undefined) bySystem.set(systemId, [id]);
        else group.push(id);
      }
      return { byId, bySystem };
    });
  }

  // The SDE arm

  function constellationsById() {
    return once("constellations", () => {
      const index = new Map();
      for (const row of readSdeRecords(SDE_FILES.constellations)) {
        const id = idOf(row._key);
        if (id !== null) index.set(id, row);
      }
      return index;
    });
  }

  function starStatisticsById() {
    return once("starStatistics", () => {
      const index = new Map();
      for (const row of readSdeRecords(SDE_FILES.stars)) {
        const id = idOf(row._key);
        if (id !== null) index.set(id, row);
      }
      return index;
    });
  }

  /**
   * `operationID` -> the service ids it offers, ascending.
   *
   * Ascending because that is the order CCP sends `services` in, and it is not
   * the order the dump lists them: operation 14 carries
   * `[1,3,5,7,13,14,17,19,21,22,23,25,26,27,10]` and Jita 4-4's body puts
   * `cloning` (service 10) fifth rather than last.
   */
  function servicesByOperation() {
    return once("stationOperations", () => {
      const index = new Map();
      for (const row of readSdeRecords(SDE_FILES.stationOperations)) {
        const id = idOf(row._key);
        if (id === null) continue;
        const services = Array.isArray(row.services)
          ? ascending(row.services.map(idOf).filter((service) => service !== null))
          : [];
        index.set(id, services);
      }
      return index;
    });
  }

  // What the routes ask for

  return Object.freeze({
    UniverseDataError,

    /**
     * The dataset's identity and its real modification time, for the shared
     * static-data validator (D43), or `null` when the store cannot say.
     *
     * `source` is the stamp `tools/DatabaseCreator` writes into every table it
     * generates: which dump it read, CCP's build number, and when it ran. That is
     * what "which universe is this" means on a private server, and it changes only
     * when the operator rebuilds the store, the only event that can change any of
     * these four bodies.
     */
    identity() {
      let source;
      try {
        source = readTable(TABLES.solarSystems, "source");
      } catch (_) {
        return null;
      }
      if (source === null || typeof source !== "object") return null;

      const generatedAt = Date.parse(source.generatedAt);
      return {
        identity: [
          `authority:${source.authority}`,
          `build:${source.buildNumber}`,
          `generated:${source.generatedAt}`,
        ].join("\n"),
        generatedAt: Number.isFinite(generatedAt) ? generatedAt : Date.now(),
      };
    },

    /**
     * Every solar system id, ascending.
     *
     * For `GET /industry/systems/`, the one route that needs the set of systems.
     * Off the same memoised index `system()` reads. Ascending because the `Etag`
     * on an unpaginated body needs a stable order; a Map's insertion order over a
     * table the generator rewrites is not one.
     */
    systemIds() {
      return ascending([...systemsById().keys()]);
    },

    /**
     * One solar system, or `null`.
     *
     * The whole body comes from the gameStore arm: this is the one of the four
     * endpoints that needs no dump.
     */
    system(systemId) {
      const row = systemsById().get(systemId);
      if (row === undefined) return null;

      const { bySystem } = celestials();
      const rows = bySystem.get(systemId) || [];

      // Moons and belts are keyed by the planet they orbit, so the grouping is built
      // here rather than read from an index: `orbitID` on a moon row is its planet,
      // and on a planet row it is the sun.
      let starId = null;
      const planetIds = [];
      const moonsByPlanet = new Map();
      const beltsByPlanet = new Map();

      for (const celestial of rows) {
        const id = idOf(celestial.itemID);
        if (id === null) continue;
        if (celestial.kind === KIND.SUN) {
          starId = id;
        } else if (celestial.kind === KIND.PLANET) {
          planetIds.push(id);
        } else if (celestial.kind === KIND.MOON || celestial.kind === KIND.ASTEROID_BELT) {
          const orbit = idOf(celestial.orbitID);
          if (orbit === null) continue;
          const into = celestial.kind === KIND.MOON ? moonsByPlanet : beltsByPlanet;
          const group = into.get(orbit);
          if (group === undefined) into.set(orbit, [id]);
          else group.push(id);
        }
      }

      return {
        systemId,
        name: row.solarSystemName,
        constellationId: idOf(row.constellationID),
        position: row.position,
        securityStatus: row.security,
        securityClass: row.securityClass,
        starId,
        planets: ascending(planetIds).map((planetId) => ({
          planetId,
          moons: ascending(moonsByPlanet.get(planetId) || []),
          asteroidBelts: ascending(beltsByPlanet.get(planetId) || []),
        })),
        stargates: ascending(stargatesBySystem().get(systemId) || []),
        stations: ascending(stations().bySystem.get(systemId) || []),
      };
    },

    /**
     * One star, or `null`. Both arms are needed.
     *
     * The store knows a sun's id, name, type and radius; only the dump knows its
     * age, luminosity, temperature and class. A star id the store does not have is
     * a `404` before the dump is opened, so an unknown id never costs a file read.
     */
    star(starId) {
      const sun = celestials().sunsById.get(starId);
      if (sun === undefined) return null;

      const record = starStatisticsById().get(starId);
      if (record === undefined || record.statistics === null || typeof record.statistics !== "object") {
        throw new UniverseDataError(
          `ESI mod: star ${starId} is in the game store and not in ${SDE_FILES.stars}. The dump `
            + "and the store disagree about the universe, which means one of them is from another "
            + "build.",
        );
      }

      return {
        starId,
        name: sun.itemName,
        typeId: idOf(sun.typeID),
        radius: sun.radius,
        solarSystemId: idOf(sun.solarSystemID),
        age: record.statistics.age,
        luminosity: record.statistics.luminosity,
        spectralClass: record.statistics.spectralClass,
        temperature: record.statistics.temperature,
      };
    },

    /** One constellation, or `null`. The dump only: the store has no such table. */
    constellation(constellationId) {
      const row = constellationsById().get(constellationId);
      if (row === undefined) return null;

      return {
        constellationId,
        // `name` is a dictionary of eight languages in the dump and one string on the
        // wire: `lib/language.js` has why the answer is always `en`.
        name: row.name && typeof row.name === "object" ? row.name.en : null,
        position: row.position,
        regionId: idOf(row.regionID),
        systems: ascending((row.solarSystemIDs || []).map(idOf).filter((id) => id !== null)),
      };
    },

    /** One NPC station, or `null`. The store for the row, the dump for its services. */
    station(stationId) {
      const row = stations().byId.get(stationId);
      if (row === undefined) return null;

      const operationId = idOf(row.operationID);
      const services = operationId === null ? [] : servicesByOperation().get(operationId);
      if (services === undefined) {
        throw new UniverseDataError(
          `ESI mod: station ${stationId} declares operation ${operationId}, which is not in `
            + `${SDE_FILES.stationOperations}. The dump and the store are from different builds.`,
        );
      }

      return {
        stationId,
        name: row.stationName,
        typeId: idOf(row.stationTypeID),
        position: row.position,
        systemId: idOf(row.solarSystemID),
        owner: idOf(row.corporationID),
        raceId: idOf(row.stationRaceID),
        reprocessingEfficiency: row.reprocessingEfficiency,
        reprocessingStationsTake: row.reprocessingStationsTake,
        maxDockableShipVolume: row.maxShipVolumeDockable,
        officeRentalCost: row.officeRentalCost,
        serviceIds: services,
      };
    },
  });
}

module.exports = Object.freeze({
  KIND,
  SDE_FILES,
  TABLES,
  UniverseDataError,
  ascending,
  createUniverseStore,
  idOf,
  readSdeRecordsFrom,
  readTableFromRepository,
  rowsOf,
});
