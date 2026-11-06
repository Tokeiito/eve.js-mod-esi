/**
 * eve.js-mod-esi: what a thing is called, in both directions (D9).
 *
 * `POST /universe/names/` turns ids into names and `POST /universe/ids/` turns
 * names into ids. This file is the index behind both: one index, read in two
 * directions.
 *
 * Ten categories come from two arms, the same two `lib/universeStore.js`
 * names: the gameStore tables that `tools/DatabaseCreator` generated, read
 * through the ownership-guarded read-only repository, and the extracted JSONL
 * dump for the two things the store does not carry.
 *
 *   inventory_type   itemTypes.types          52,590   name
 *   faction          factions.records             27   name
 *   corporation      corporations.records        283+   corporationName
 *   agent            agentAuthority.agentsByID 10,941   ownerName
 *   character        characters                    n   characterName
 *   alliance         alliances                     n   allianceName
 *   solar_system     solarSystems.solarSystems  8,490   solarSystemName
 *   station          stations.stations          5,210   stationName
 *   constellation    mapConstellations.jsonl    1,184   name.en   (dump)
 *   region           mapRegions.jsonl             114   name.en   (dump)
 *
 * Constellations and regions come from the dump for the reason
 * `lib/universeStore.js` records: their only names in the store are
 * denormalised onto the 5,210 station rows, so every constellation and region
 * with no station (all of wormhole space and the Jove regions) has no name
 * there. Reading them off `stations` would answer for Jita and not for a
 * wormhole constellation. Dump rows carry `name` as a dictionary of eight
 * languages; `.en` is taken because D27 settled that this replica answers
 * `en` only.
 *
 * An agent is a `character` one way and an `agent` the other. That asymmetry
 * is CCP's: the `/universe/names/` schema declares nine categories and `agent`
 * is not one, while the `/universe/ids/` schema declares ten groups and
 * `agents` is the first. An agent is an NPC character in CCP's id space (eve.js
 * allocates them at 3,008,416-3,020,257, inside the band CCP reserves for
 * characters), so an agent resolves as `character` from `/universe/names/` and
 * under `agents` from `/universe/ids/`.
 *
 * D9: there is no resolution order. The open question was which category wins
 * when an integer is a valid id for more than one kind (the nexumApi precedent
 * is character, then corporation, then alliance). Measured against this
 * install, every band is disjoint, because eve.js allocates into CCP's own
 * reserved ranges (`services/corporation/corporationIdRanges.js` starts player
 * corporations at 98,000,000 and alliances at 99,000,000,
 * `services/_shared/identityAllocator.js` starts characters at 140,000,001),
 * and `routes/entities.js` relies on the same fact for D36's id-range
 * refusals.
 *
 * So resolution is a lookup, and the check is per id, not per range: a
 * `corporation` is allocated from two bands (CCP's NPC corporations at
 * 1,000,00x and eve.js's player corporations from 98,000,000), so its lowest
 * and highest ids straddle `agent`, `region` and `solar_system` entirely, and a
 * range check would call that a collision. What is disjoint is the set of ids,
 * which `byId` tests as it inserts. Two categories claiming one id means this
 * install's id space is broken, and a name must not come back labelled with the
 * wrong kind, so an ambiguous id is omitted from the answer and reported, as
 * both endpoints already do for an unknown id. `bands()` reports the
 * measurement.
 *
 * Names (D45): `matchable()` is the key a name is indexed under, trimmed and
 * lowercased. CCP's document says "Only exact matches will be returned", which
 * settles substring versus whole-string and not case, so the case rule is this
 * replica's and is recorded as D45. EVE enforces case-insensitive uniqueness on
 * player-chosen names, so a case-folded index has one entry per name and
 * folding adds no ambiguity the exact index would not have. Where it does (two
 * static rows differing only in case) the collision is reported and the name is
 * omitted, as for an ambiguous id.
 *
 * Cost: the id index is about 69,000 entries and the name index the same
 * again, each built once and kept for the life of the process, because none of
 * the ten sources changes while it lives (nine are static tables the game
 * loaded at boot, the tenth is a dump on disk; the argument of
 * `lib/universeStore.js`'s memos). They are built separately and on demand:
 * `/universe/names/` never needs the name direction, so a first request for one
 * does not pay for the other. `itemTypes` is 52,590 of the entries and is not
 * split further, since resolving a type id is the common case.
 */

"use strict";

const path = require("node:path");

const runtime = require("./runtimeAccess");
const {
  UniverseDataError,
  SDE_FILES,
  readSdeRecordsFrom,
  readTableFromRepository,
} = require("./universeStore");


/**
 * The nine `category` values `POST /universe/names/` may send, plus `agent`.
 *
 * Spelled as CCP spells them, because they are bytes in a body.
 * `contract/spec.js` holds the projection to the schema's enum, which stops
 * this list drifting from the nine.
 *
 * `AGENT` is the tenth and is never sent as a `category`: see the header.
 */
const CATEGORY = Object.freeze({
  AGENT: "agent",
  ALLIANCE: "alliance",
  CHARACTER: "character",
  CONSTELLATION: "constellation",
  CORPORATION: "corporation",
  FACTION: "faction",
  INVENTORY_TYPE: "inventory_type",
  REGION: "region",
  SOLAR_SYSTEM: "solar_system",
  STATION: "station",
});

/**
 * What `POST /universe/names/` calls a category whose id it resolved.
 *
 * An agent resolves as a character there (see the header). Every other
 * category is itself.
 */
const NAMES_CATEGORY = Object.freeze({
  [CATEGORY.AGENT]: CATEGORY.CHARACTER,
  [CATEGORY.ALLIANCE]: CATEGORY.ALLIANCE,
  [CATEGORY.CHARACTER]: CATEGORY.CHARACTER,
  [CATEGORY.CONSTELLATION]: CATEGORY.CONSTELLATION,
  [CATEGORY.CORPORATION]: CATEGORY.CORPORATION,
  [CATEGORY.FACTION]: CATEGORY.FACTION,
  [CATEGORY.INVENTORY_TYPE]: CATEGORY.INVENTORY_TYPE,
  [CATEGORY.REGION]: CATEGORY.REGION,
  [CATEGORY.SOLAR_SYSTEM]: CATEGORY.SOLAR_SYSTEM,
  [CATEGORY.STATION]: CATEGORY.STATION,
});

/**
 * Which key of the `POST /universe/ids/` body a category's matches go under.
 *
 * The plurals are CCP's and two are not the plural of the category:
 * `inventory_type` goes under `inventory_types` but `solar_system` goes under
 * `systems`. The schema's ten properties are the authority and
 * `contract/spec.js` compares this table against them.
 */
const IDS_GROUP = Object.freeze({
  [CATEGORY.AGENT]: "agents",
  [CATEGORY.ALLIANCE]: "alliances",
  [CATEGORY.CHARACTER]: "characters",
  [CATEGORY.CONSTELLATION]: "constellations",
  [CATEGORY.CORPORATION]: "corporations",
  [CATEGORY.FACTION]: "factions",
  [CATEGORY.INVENTORY_TYPE]: "inventory_types",
  [CATEGORY.REGION]: "regions",
  [CATEGORY.SOLAR_SYSTEM]: "systems",
  [CATEGORY.STATION]: "stations",
});

/** The SDE dump file the two map categories are read from. */
const SDE_REGIONS_FILE = "mapRegions.jsonl";


/**
 * Two categories claim one id, or two rows claim one name.
 *
 * Never thrown out of a lookup: an ambiguous key is omitted from the answer
 * and this carries the detail to the log. D9 argues omitting beats picking: a
 * client that sees an id missing falls back to the raw number, and a client
 * that sees it labelled with the wrong kind does not know to.
 */
class AmbiguousIdError extends Error {
  constructor(message, { key, categories } = {}) {
    super(message);
    this.name = "AmbiguousIdError";
    this.key = key;
    this.categories = categories;
  }
}


/** An id from a row or a key, or `null`. Never `0`, never a bare string. */
function idOf(value) {
  const numeric = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

/**
 * A name from a row, or `null`.
 *
 * Two shapes, because the two arms disagree: the gameStore tables carry a
 * plain string and CCP's dump carries a dictionary of eight languages, from
 * which `.en` is taken (D27). Anything else (a number, an empty string, a
 * dictionary with no English) is `null`, which drops the row rather than
 * indexing a name no client can use.
 */
function nameOf(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (value !== null && typeof value === "object" && typeof value.en === "string") {
    const trimmed = value.en.trim();
    return trimmed === "" ? null : trimmed;
  }
  return null;
}

/**
 * The key a name is looked up under. See D45 in the header.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: the fold must be the same on
 * every machine, and the Turkish dotless i is the locale rule that would make
 * one deployment resolve a name another does not.
 */
function matchable(name) {
  return name.toLowerCase();
}

/**
 * Every `{ id, name }` in one source, as a flat array.
 *
 * Three row shapes appear across the ten sources: an array of rows with an id
 * field, a map of id to row, and a dump's array of rows keyed by `_key`.
 * `idField` names the id where the row carries one; otherwise the map's own
 * key is the id.
 */
function entriesOf(rows, { idField, nameField }) {
  const entries = [];

  const push = (rawId, row) => {
    if (row === null || typeof row !== "object") return;
    const id = idOf(idField !== null && row[idField] !== undefined ? row[idField] : rawId);
    if (id === null) return;
    const name = nameOf(row[nameField]);
    if (name === null) return;
    entries.push({ id, name });
  };

  if (Array.isArray(rows)) {
    for (const row of rows) push(null, row);
    return entries;
  }
  if (rows !== null && typeof rows === "object") {
    for (const [key, row] of Object.entries(rows)) push(key, row);
    return entries;
  }
  return entries;
}


/**
 * Both directions, with every source read on demand and kept.
 *
 * `readTable` and `readSdeRecords` are injected as `lib/universeStore.js`
 * injects its two arms, so this file is exercisable against object literals
 * with no eve.js checkout, database or dump. The defaults are resolved on first
 * use, never at construction: this module is reachable from preload, where
 * there is no game runtime to ask.
 *
 * `onAmbiguous` is where a collision goes. It defaults to nothing, since a
 * pure index has no opinion about logging; `loader.js` passes the mod's log.
 */
function createNameIndex({
  readTable = (table, key) => readTableFromRepository(runtime.getReadOnlyTableRepository(), table, key),
  readSdeRecords = null,
  onAmbiguous = null,
} = {}) {
  const memo = new Map();

  function once(key, build) {
    if (!memo.has(key)) memo.set(key, build());
    return memo.get(key);
  }

  /**
   * The dump arm's default, composed as `lib/universeStore.js` composes its own:
   * the directory name carries CCP's build number and is the only place it
   * survives, so the path is built from the build rather than globbed.
   */
  function sdeRecords(fileName) {
    if (typeof readSdeRecords === "function") return readSdeRecords(fileName);
    const { sdeRoot } = runtime.getStorePaths();
    const build = runtime.readSdeBuildFrom(sdeRoot);
    return readSdeRecordsFrom(
      build === null ? null : path.join(sdeRoot, `eve-online-static-data-${build}-jsonl`),
      fileName,
    );
  }

  /**
   * The ten sources, each as `() => [{ id, name }]`.
   *
   * A table rather than ten functions, so that `bands()` and both indexes walk
   * the same list and adding a category is one row.
   */
  const SOURCES = Object.freeze({
    [CATEGORY.INVENTORY_TYPE]: () =>
      entriesOf(readTable("itemTypes", "types"), { idField: "typeID", nameField: "name" }),
    [CATEGORY.FACTION]: () =>
      entriesOf(readTable("factions", "records"), { idField: "factionID", nameField: "name" }),
    [CATEGORY.CORPORATION]: () =>
      entriesOf(readTable("corporations", "records"), {
        idField: "corporationID",
        nameField: "corporationName",
      }),
    [CATEGORY.AGENT]: () =>
      entriesOf(readTable("agentAuthority", "agentsByID"), {
        idField: "agentID",
        nameField: "ownerName",
      }),
    [CATEGORY.CHARACTER]: () =>
      entriesOf(readTable("characters", "/"), { idField: null, nameField: "characterName" }),
    [CATEGORY.ALLIANCE]: () =>
      entriesOf(readTable("alliances", "/"), { idField: null, nameField: "allianceName" }),
    [CATEGORY.SOLAR_SYSTEM]: () =>
      entriesOf(readTable("solarSystems", "solarSystems"), {
        idField: "solarSystemID",
        nameField: "solarSystemName",
      }),
    [CATEGORY.STATION]: () =>
      entriesOf(readTable("stations", "stations"), {
        idField: "stationID",
        nameField: "stationName",
      }),
    [CATEGORY.CONSTELLATION]: () =>
      entriesOf(sdeRecords(SDE_FILES.constellations), { idField: "_key", nameField: "name" }),
    [CATEGORY.REGION]: () =>
      entriesOf(sdeRecords(SDE_REGIONS_FILE), { idField: "_key", nameField: "name" }),
  });

  /** One source's entries, memoised. A read that throws is not cached. */
  function entriesFor(category) {
    return once(`source:${category}`, SOURCES[category]);
  }

  /** Report a collision without failing the request that found it. */
  function reportAmbiguous(error) {
    if (typeof onAmbiguous === "function") onAmbiguous(error);
  }

  /**
   * `id -> { id, name, category }`, over all ten sources.
   *
   * Built in one pass with the disjointness check inline: the check is "did
   * anybody already claim this id", which is what the insert already asks.
   *
   * A colliding id stays in the map under the category that claimed it first,
   * marked, so that `resolveId` omits it rather than answering with whichever
   * source was read first. See D9.
   */
  function byId() {
    return once("byId", () => {
      const index = new Map();
      const ambiguous = new Set();

      for (const category of Object.keys(SOURCES)) {
        for (const { id, name } of entriesFor(category)) {
          const existing = index.get(id);
          if (existing !== undefined && existing.category !== category) {
            ambiguous.add(id);
            reportAmbiguous(
              new AmbiguousIdError(
                `ESI mod: id ${id} is claimed by both ${existing.category} and ${category}. `
                  + "D9 records that this install's id bands are disjoint; this one is not, so the "
                  + "id is omitted from name resolution rather than labelled with a guess.",
                { key: id, categories: [existing.category, category] },
              ),
            );
            continue;
          }
          if (existing === undefined) index.set(id, { id, name, category });
        }
      }

      return { index, ambiguous };
    });
  }

  /**
   * `matchable(name) -> { id, name, category }`, over all ten sources.
   *
   * Separate from `byId` and built separately: a deployment that never calls
   * `/universe/ids/` should not pay for it.
   *
   * The stored `name` is the source's own spelling, not the folded key, so a
   * client that asked for `jita` is answered with `Jita`.
   */
  function byName() {
    return once("byName", () => {
      const index = new Map();
      const ambiguous = new Set();

      for (const category of Object.keys(SOURCES)) {
        for (const { id, name } of entriesFor(category)) {
          const key = matchable(name);
          const existing = index.get(key);
          if (existing !== undefined && existing.id !== id) {
            ambiguous.add(key);
            reportAmbiguous(
              new AmbiguousIdError(
                `ESI mod: the name ${JSON.stringify(name)} resolves to both `
                  + `${existing.category} ${existing.id} and ${category} ${id}. It is omitted from `
                  + "id resolution rather than answered with one of them (D45).",
                { key, categories: [existing.category, category] },
              ),
            );
            continue;
          }
          if (existing === undefined) index.set(key, { id, name, category });
        }
      }

      return { index, ambiguous };
    });
  }

  return Object.freeze({
    AmbiguousIdError,
    CATEGORY,
    IDS_GROUP,
    NAMES_CATEGORY,
    UniverseDataError,

    /**
     * What each category actually indexed, for the disjointness argument D9 rests
     * on and for the test that keeps it honest.
     *
     * Reports the measurement rather than a stored constant: a band asserted from
     * a table that has since been regenerated observes nothing.
     */
    bands() {
      const out = [];
      for (const category of Object.keys(SOURCES)) {
        const entries = entriesFor(category);
        const ids = entries.map((entry) => entry.id);
        out.push({
          category,
          count: ids.length,
          min: ids.length === 0 ? null : Math.min(...ids),
          max: ids.length === 0 ? null : Math.max(...ids),
        });
      }
      return out;
    },

    /**
     * One id, or `null` for an id this server has never heard of. An ambiguous id
     * is also `null`, for a different reason, which is why the collision is logged
     * rather than returned.
     *
     * `category` is already `/universe/names/`'s spelling, so an agent comes back
     * as a `character`.
     */
    resolveId(id) {
      // Strict, unlike `idOf`, which accepts the string keys `Object.entries` hands
      // it when a source is a map. A caller here has parsed a JSON integer out of a
      // request body; a string arriving here is a route that skipped its own
      // validation, and coercing it would hide that.
      const key = Number.isSafeInteger(id) && id > 0 ? id : null;
      if (key === null) return null;

      const { index, ambiguous } = byId();
      if (ambiguous.has(key)) return null;

      const found = index.get(key);
      if (found === undefined) return null;
      return { id: found.id, name: found.name, category: NAMES_CATEGORY[found.category] };
    },

    /**
     * One name, or `null`. `group` is the key of the `/universe/ids/` body the
     * match belongs under, so an agent comes back under `agents`.
     */
    resolveName(name) {
      if (typeof name !== "string") return null;
      const trimmed = name.trim();
      if (trimmed === "") return null;

      const key = matchable(trimmed);
      const { index, ambiguous } = byName();
      if (ambiguous.has(key)) return null;

      const found = index.get(key);
      if (found === undefined) return null;
      return { id: found.id, name: found.name, group: IDS_GROUP[found.category] };
    },
  });
}

module.exports = Object.freeze({
  AmbiguousIdError,
  CATEGORY,
  IDS_GROUP,
  NAMES_CATEGORY,
  SDE_REGIONS_FILE,
  createNameIndex,
  entriesOf,
  idOf,
  matchable,
  nameOf,
});
