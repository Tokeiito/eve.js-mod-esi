/**
 * eve.js-mod-esi: what an owner has, and where it is, read-only.
 *
 * The `items` table is eve.js's whole inventory, keyed by `itemID` and stamped
 * with an `ownerID`. `GET /characters/{id}/assets/`, `/blueprints/` and their
 * corporation twins are all views of it, so this file is the one door all four
 * go through, as `lib/marketStore.js` is for the order book and
 * `lib/universeStore.js` for the static universe.
 *
 * Why not `itemStore.listOwnedItems`: it is a read that writes, the shape
 * `lib/runtimeAccess.js` has refused twice. Every public read in
 * `services/inventory/itemStore.js` begins with `ensureMigrated()`, which on an
 * already-migrated table still runs `repairOversizedStackableItems` over every
 * row and, when any row is oversized, rewrites and persists the whole table
 * (logging `[ItemStore] Repaired oversized stack item=...`). A `GET` built on
 * it would reshape a pilot's stacks because somebody polled an API. The remedy
 * is the one `ensureCharacterSkills` got: read the table through the
 * ownership-guarded handle that cannot write it, and shape the rows here.
 *
 * `singleton` is the discriminator and has three values. The columns are
 * written together by `services/inventory/itemStore.js`:
 *
 *   singleton  quantity   stacksize   what it is
 *   0          units      units       a stack
 *   1          -1         1           an assembled singleton
 *   2          -2         1           a blueprint copy
 *
 * Upstream's comment on `isBlueprintCopyInventoryItem` says the same:
 * "singleton 2 marks a blueprint copy. The row carries quantity -2 and
 * stacksize 1, and its runs/ME/TE live in industryBlueprintState keyed by
 * itemID".
 *
 *   is_singleton        `singleton !== 0`. Both 1 and 2 are singletons.
 *   is_blueprint_copy   `singleton === 2`, natively.
 *
 * `quantity` is two different fields on the two endpoints, which is why this
 * file exposes the raw row rather than one "quantity":
 *
 *   assets      a count. A singleton is `1`; a stack is its units. A `-1` on
 *               an assets body would read as "minus one Rifter".
 *   blueprints  CCP's `-1` original / `-2` copy / positive stack convention,
 *               documented in the operation's description and identical to
 *               what `items.quantity` holds, so it passes through untouched.
 *
 * `location_type`: CCP's enum has four values and eve.js stores none of them,
 * only a `locationID`. The resolution is the one
 * `services/industry/industryRuntimeState.js` `resolveLocationType` makes,
 * reproduced here because that module requires the game store at load and
 * pulls in characterState, skillState, walletState, corpWalletState,
 * structureState and worldData, which this mod's one-module-may-touch-the-game
 * rule exists to avoid.
 *
 *   station        the id is a row in the `stations` table (NPC stations)
 *   solar_system   the id is a row in `solarSystems` (an item floating in space)
 *   item           the id is another row in `items` (a container, or a ship)
 *   other          anything else, which on this server is an Upwell structure
 *
 * The order matters, and `other` is the fallback rather than a lookup against
 * `structures`: a structure unanchored between the item being written and the
 * request being served would otherwise have no answer, and `other` is also
 * what CCP uses for a location it cannot classify.
 *
 * Cost: one pass over the whole `items` table per call, because the read-only
 * handle has no by-owner index (`itemStore` keeps one, in the module that may
 * not be called). The table is the live inventory, so unlike
 * `lib/universeStore.js` it cannot be memoised. Both asset routes publish a
 * 3600-second `x-cache-age` and declare a `pageSize`, so `lib/router.js`
 * `dispatchPaginated` snapshots the collection once per cache window per
 * caller: one pass per owner per hour, as `lib/marketStore.js` does for its
 * 198 ms region sweep.
 */

"use strict";

const runtime = require("./runtimeAccess");

/** The three tables this file reads, all through the read-only handle. */
const ITEMS_TABLE = "items";
const BLUEPRINT_STATE_TABLE = "industryBlueprintState";
const STATIONS_TABLE = "stations";
const SOLAR_SYSTEMS_TABLE = "solarSystems";

/** CCP's `location_type` enum, spelled as the document spells it. */
const LOCATION_TYPE = Object.freeze({
  STATION: "station",
  SOLAR_SYSTEM: "solar_system",
  ITEM: "item",
  OTHER: "other",
});

/**
 * eve.js's `singleton`, named.
 *
 * Three values. See the header for the table tying them to `quantity` and
 * `stacksize`; collapsing them to a boolean loses a field CCP publishes.
 */
const SINGLETON = Object.freeze({
  STACK: 0,
  ASSEMBLED: 1,
  BLUEPRINT_COPY: 2,
});

/** `services/inventory/itemStore.js` `BLUEPRINT_CATEGORY_ID`. */
const BLUEPRINT_CATEGORY_ID = 9;

/**
 * The defaults `services/industry/industryRuntimeState.js` `getBlueprintState`
 * would have persisted for a blueprint it has never seen.
 *
 * Reproduced as values and never as a write. That function's second half seeds
 * exactly this record into the table and calls `persistBlueprintStateTable`,
 * so a `GET` going through it would write a blueprint state row the first time
 * anybody asked about a pilot's blueprints. The row is synthesised here with
 * the same numbers and nothing is persisted.
 */
const UNRESEARCHED_BLUEPRINT = Object.freeze({
  materialEfficiency: 0,
  timeEfficiency: 0,
  runsRemaining: -1,
  original: true,
});

/**
 * A read that could not happen: a table this build cannot see, or one whose
 * shape changed upstream.
 *
 * Distinct from "this owner has nothing", which is an empty array. A client
 * cannot tell an empty asset list from a broken one, and it acts on both
 * (`routes/skills.js` states the same rule).
 */
class AssetDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssetDataError";
  }
}

/**
 * A number, or `NaN` for anything that is not one.
 *
 * `Number(null)`, `Number("")` and `Number([])` are all `0`, and a `0` from an
 * absence is indistinguishable downstream from a stored `0`. On every field
 * this is used on, that difference reaches a client as a number it acts on, so
 * absences become `NaN` and the callers' `Number.isSafeInteger` check refuses
 * them.
 *
 * Narrower than `lib/serialize.js` `numberOrNull`, which answers `null` for the
 * same inputs: a `null` here would still have to be checked, and `NaN` fails
 * the check the callers already make.
 */
function strictNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return NaN;
  return Number(value);
}

/** An id from a row or a key, or `null`. Never `0`, never a bare string. */
function idOf(value) {
  const numeric = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

/** `read(table, pointer)` through the repository, or a throw naming the table. */
function readTableFromRepository(repository, table, key) {
  const read = repository && repository.read;
  if (typeof read !== "function") {
    throw new AssetDataError(
      "ESI mod: the game store's table repository exposes no read(). Check "
        + "GAME_MODULES.gameStoreTableRepository against the vendor tree.",
    );
  }

  const result = read.call(repository, table, key);
  if (!result || result.success !== true || !result.data || typeof result.data !== "object") {
    throw new AssetDataError(
      `ESI mod: the game store has no readable "${table}.${key}" `
        + `(${(result && result.errorMsg) || "no answer"}).`,
    );
  }
  return result.data;
}

/**
 * The store, with the static indexes memoised and the live table never.
 *
 * `readTable` is injected as `lib/universeStore.js` injects its arms, so every
 * consumer is testable against object literals with no eve.js checkout and no
 * database. The default is resolved on first use, never at construction: this
 * module is reachable from preload.
 */
function createAssetStore({ readTable = null } = {}) {
  const read = typeof readTable === "function"
    ? readTable
    : (table, key) => readTableFromRepository(runtime.getReadOnlyTableRepository(), table, key);

  const memo = new Map();

  function once(key, build) {
    if (!memo.has(key)) memo.set(key, build());
    return memo.get(key);
  }

  /**
   * Station ids, as a Set.
   *
   * Static for the life of the process (SDE-derived NPC stations, the claim
   * `lib/universeStore.js` memoises on), so built once.
   */
  function stationIds() {
    return once("stations", () => {
      const rows = read(STATIONS_TABLE, "stations");
      if (!Array.isArray(rows)) {
        throw new AssetDataError(
          `ESI mod: the game store's "${STATIONS_TABLE}.stations" is not an array. The table's `
            + "shape changed upstream.",
        );
      }
      const ids = new Set();
      for (const row of rows) {
        const id = idOf(row && row.stationID);
        if (id !== null) ids.add(id);
      }
      return ids;
    });
  }

  /** Solar system ids, as a Set. Static for the same reason. */
  function solarSystemIds() {
    return once("solarSystems", () => {
      const rows = read(SOLAR_SYSTEMS_TABLE, "solarSystems");
      if (!Array.isArray(rows)) {
        throw new AssetDataError(
          `ESI mod: the game store's "${SOLAR_SYSTEMS_TABLE}.solarSystems" is not an array. The `
            + "table's shape changed upstream.",
        );
      }
      const ids = new Set();
      for (const row of rows) {
        const id = idOf(row && row.solarSystemID);
        if (id !== null) ids.add(id);
      }
      return ids;
    });
  }

  /**
   * The live `items` table, as the stored object.
   *
   * Never memoised, because the game rewrites it whenever anything moves. Never
   * cloned, because a clone of the whole inventory is the one thing on this path
   * that could hurt the event loop; nothing above this line keeps a reference,
   * since `ownedItems` copies the fields it wants out of each row and drops the
   * row.
   */
  function items() {
    return read(ITEMS_TABLE, "/");
  }

  /**
   * One owner's rows, projected to the eight fields the asset endpoints use.
   *
   * Copied field by field, for the reason `lib/runtimeAccess.js`
   * `peekCharacterRecord` gives about the live store: a reference into the
   * game's own object invites a projection to mutate the universe by accident.
   *
   * Ascending `itemID`, which is the order `industryRuntimeState`'s blueprint
   * list sorts into and is stable. An object's key order over a table the game
   * rewrites is not, and an unstable order moves the `Etag` between identical
   * requests and breaks a paginated sweep.
   */
  function ownedItems(ownerId, { categoryID = null } = {}) {
    const owner = idOf(ownerId);
    if (owner === null) return [];

    const table = items();
    const rows = [];

    for (const row of Object.values(table)) {
      if (row === null || typeof row !== "object") continue;
      if (idOf(row.ownerID) !== owner) continue;
      if (categoryID !== null && Number(row.categoryID) !== categoryID) continue;

      const itemId = idOf(row.itemID);
      const typeId = idOf(row.typeID);
      const locationId = idOf(row.locationID);
      if (itemId === null || typeId === null || locationId === null) continue;

      rows.push({
        itemID: itemId,
        typeID: typeId,
        locationID: locationId,
        flagID: Number(row.flagID),
        quantity: Number(row.quantity),
        stacksize: Number(row.stacksize),
        singleton: Number(row.singleton),
        categoryID: Number(row.categoryID),
      });
    }

    rows.sort((left, right) => left.itemID - right.itemID);
    return rows;
  }

  return Object.freeze({
    AssetDataError,
    BLUEPRINT_CATEGORY_ID,
    LOCATION_TYPE,
    SINGLETON,
    UNRESEARCHED_BLUEPRINT,

    ownedItems,

    /** One owner's blueprints: `ownedItems` narrowed to CCP's category 9. */
    ownedBlueprints(ownerId) {
      return ownedItems(ownerId, { categoryID: BLUEPRINT_CATEGORY_ID });
    },

    /**
     * Which of CCP's four kinds of place a `locationID` names.
     *
     * See the header for the order and for why `other` is the fallback.
     *
     * The `item` branch is the only one that touches the live table, and it takes
     * the table it was handed rather than reading it again: classifying 400 rows
     * would otherwise read the whole inventory 400 times.
     */
    locationTypeOf(locationId, { itemIds = null } = {}) {
      const id = idOf(locationId);
      if (id === null) return LOCATION_TYPE.OTHER;

      if (stationIds().has(id)) return LOCATION_TYPE.STATION;
      if (solarSystemIds().has(id)) return LOCATION_TYPE.SOLAR_SYSTEM;

      const known = itemIds === null ? null : itemIds;
      if (known !== null && known.has(id)) return LOCATION_TYPE.ITEM;
      if (known === null && Object.prototype.hasOwnProperty.call(items(), String(id))) {
        return LOCATION_TYPE.ITEM;
      }

      return LOCATION_TYPE.OTHER;
    },

    /**
     * Every `itemID` in the table, for the `item` branch above.
     *
     * A caller classifying a whole asset list builds this once and passes it to
     * every `locationTypeOf` call. It is the whole table's keys, not the owner's:
     * an item can sit inside a container somebody else owns, and the location is
     * an item either way.
     */
    itemIds() {
      const ids = new Set();
      for (const key of Object.keys(items())) {
        const id = idOf(key);
        if (id !== null) ids.add(id);
      }
      return ids;
    },

    /**
     * One blueprint's research state, or the unresearched default.
     *
     * Never `null` for a blueprint that exists: one with no row in
     * `industryBlueprintState` is an unresearched original, which is what
     * `getBlueprintState` would have persisted. See `UNRESEARCHED_BLUEPRINT`.
     *
     * A table that cannot be read throws instead, because `material_efficiency`,
     * `time_efficiency` and `runs` are required on a blueprint row, and reporting a
     * researched blueprint as unresearched is a wrong answer that looks right: a
     * client would quote a build cost off the wrong material multiplier.
     */
    blueprintStateOf(itemId) {
      const id = idOf(itemId);
      if (id === null) return { ...UNRESEARCHED_BLUEPRINT };

      const table = read(BLUEPRINT_STATE_TABLE, "/");
      const records = table && typeof table.records === "object" && table.records !== null
        ? table.records
        : {};

      const stored = records[String(id)];
      if (stored === null || stored === undefined || typeof stored !== "object") {
        return { ...UNRESEARCHED_BLUEPRINT };
      }

      // `strictNumber` and not `Number`: `Number(null)` and `Number("")` are `0`, so
      // a state row with a null `materialEfficiency` would coerce to a valid
      // "researched to zero". `lib/serialize.js` `numberOrNull` refuses the same
      // coercion.
      return {
        materialEfficiency: strictNumber(stored.materialEfficiency),
        timeEfficiency: strictNumber(stored.timeEfficiency),
        runsRemaining: strictNumber(stored.runsRemaining),
        original: stored.original === true,
      };
    },
  });
}

module.exports = Object.freeze({
  AssetDataError,
  BLUEPRINT_CATEGORY_ID,
  BLUEPRINT_STATE_TABLE,
  ITEMS_TABLE,
  LOCATION_TYPE,
  SINGLETON,
  SOLAR_SYSTEMS_TABLE,
  STATIONS_TABLE,
  UNRESEARCHED_BLUEPRINT,
  createAssetStore,
  idOf,
  readTableFromRepository,
  strictNumber,
});
