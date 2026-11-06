/**
 * `GET /characters/{character_id}/blueprints/`: what a pilot can build from.
 * Also the corporation twin.
 *
 * It has its own file, not a second route in `routes/assets.js`, for the reason
 * `routes/skills.js` gives. The two read the same table through the same store,
 * but are a different scope family (`esi-characters.read_blueprints`, not
 * `esi-assets.read_assets`), a different bucket (`char-industry`, not
 * `char-asset`), a different `location_flag` enum and a different question.
 * CCP files them under different tags.
 *
 * `quantity` is CCP's convention and eve.js already holds it: a 1:1 with no
 * mapping, which looks like a bug. CCP: "A range of numbers with a minimum of
 * -2 and no maximum value where -1 is an original and -2 is a copy. It can be a
 * positive integer if it is a stack of blueprint originals fresh from the
 * market." `normalizeInventoryItem` in `services/inventory/itemStore.js` writes
 * `-1` for an assembled singleton, `-2` for a blueprint copy (`singleton === 2`)
 * and the unit count for a stack. This route passes the column through
 * untouched; `routes/assets.js`, where the same column means a count, does the
 * work. Changing one route to match the other breaks the other, so each file
 * says what its `quantity` is.
 *
 * `runs` is `-1` for an original and the remaining runs for a copy. eve.js
 * keeps it in `industryBlueprintState`, owned by
 * `services/industry/industryRuntimeState.js` and read through
 * `getBlueprintState`, which seeds and persists a default record for any
 * blueprint it has not seen. That is the `ensureCharacterSkills` shape: a `GET`
 * built on it would write blueprint state into the game on the first request.
 * `lib/assetStore.js` reads the table through the read-only handle and
 * synthesises the same default (ME 0, TE 0, runs -1, original) for a blueprint
 * with no row. `UNRESEARCHED_BLUEPRINT` holds the numbers beside the function
 * they are copied from.
 *
 * One deliberate divergence from eve.js, in ESI's favour. eve.js's own list
 * (`listBlueprintInstancesByOwner`, which the EVE client reads) shows only
 * blueprints whose `singleton` is 1 or 2, because `getBlueprintState` returns
 * `null` otherwise, so a stack of unresearched originals bought off the market
 * never appears in the client's blueprint window. CCP's document says that
 * stack is a blueprint row (the sentence quoted above), so this route lists it
 * with the stack's quantity and the unresearched defaults. Fidelity is to what
 * ESI does (design constraint 3), and the client is not ESI.
 *
 * The enum is not the assets one: 76 values here against 89 there.
 * `lib/locationFlags.js` `CHARACTER_BLUEPRINT` is the surface and has the
 * thirteen-value subtraction. The corporation pair publish one enum for both
 * bodies, which is checked rather than assumed.
 */

"use strict";

const { locationFlagFor, CHARACTER_BLUEPRINT, CORPORATION_BLUEPRINT } = require("../lib/locationFlags");
const { projection } = require("../lib/serialize");
const { CHARACTER_ID_PARAM } = require("./characters");
const { corporationRoleSubject } = require("./roles");
const {
  CORPORATION_ID_PARAM,
  callerCharacterId,
  readStore,
  subjectCorporationId,
  unreadable,
} = require("./assets");

// The route

/** Canonical: no version prefix, no trailing slash. */
const CHARACTER_BLUEPRINTS_PATH = "/characters/:character_id/blueprints";

/** `x-cache-age` in the pinned spec. `assertRouteMatchesSpec` holds this to it. */
const CHARACTER_BLUEPRINTS_CACHE_TTL_SECONDS = 3600;

/** The scope CCP publishes for this operation. */
const CHARACTER_BLUEPRINTS_SCOPE = "esi-characters.read_blueprints.v1";

/** 600 tokens per 15 minutes, not `char-asset`'s 1800. */
const CHARACTER_BLUEPRINTS_RATE_LIMIT_GROUP = "char-industry";

/** One legal producer for a scoped route that sends JSON. */
const PRODUCER = "app";

/** `contract/wire.js` `PAGINATION.pageSize`. See `routes/assets.js`. */
const BLUEPRINTS_PAGE_SIZE = 1000;

/** CCP's own operationId, which is also this route's `name` and its log line. */
const CHARACTER_BLUEPRINTS_OPERATION_ID = "GetCharactersCharacterIdBlueprints";

// The corporation twin

const CORPORATION_BLUEPRINTS_PATH = "/corporations/:corporation_id/blueprints";
const CORPORATION_BLUEPRINTS_CACHE_TTL_SECONDS = 3600;
const CORPORATION_BLUEPRINTS_SCOPE = "esi-corporations.read_blueprints.v1";
const CORPORATION_BLUEPRINTS_RATE_LIMIT_GROUP = "corp-industry";
const CORPORATION_BLUEPRINTS_OPERATION_ID = "GetCorporationsCorporationIdBlueprints";

/** CCP's `x-required-roles`, spelled as the document spells it. */
const CORPORATION_BLUEPRINTS_ROLES = Object.freeze(["Director"]);

// The body

/**
 * One blueprint, in the schema's declaration order, which is alphabetical.
 *
 * All eight fields are required, so nothing is optional or omitted: a blueprint
 * that could not fill one was refused upstream rather than projected with a
 * required key missing.
 */
const projectBlueprint = projection(CHARACTER_BLUEPRINTS_OPERATION_ID, {
  item_id: (row) => row.itemId,
  location_flag: (row) => row.locationFlag,
  location_id: (row) => row.locationId,
  material_efficiency: (row) => row.materialEfficiency,
  quantity: (row) => row.quantity,
  runs: (row) => row.runs,
  time_efficiency: (row) => row.timeEfficiency,
  type_id: (row) => row.typeId,
});

/**
 * One owner's blueprints, as the array `dispatchPaginated` slices.
 *
 * Shared with the corporation twin, which differs in the gate and the surface.
 *
 * `quantity` is passed through from the row. It is already CCP's `-1` / `-2` /
 * positive convention, and coercing it would be the bug.
 */
function buildBlueprints({ store, ownerId, surface, operationId }) {
  return store.ownedBlueprints(ownerId).map((row) => {
    let locationFlag;
    try {
      locationFlag = locationFlagFor(row.flagID, surface);
    } catch (err) {
      throw unreadable(
        operationId,
        ownerId,
        `blueprint ${row.itemID} carries ${err.message.replace(/^ESI mod: /, "")}`,
      );
    }

    const state = store.blueprintStateOf(row.itemID);
    const numbers = {
      materialEfficiency: state.materialEfficiency,
      timeEfficiency: state.timeEfficiency,
      runs: state.runsRemaining,
    };

    for (const [field, value] of Object.entries(numbers)) {
      if (!Number.isSafeInteger(value)) {
        throw unreadable(
          operationId,
          ownerId,
          `the industryBlueprintState row for blueprint ${row.itemID} carries no readable `
            + `${field}, and every field of a blueprint row is required`,
        );
      }
    }

    if (!Number.isSafeInteger(row.quantity) || row.quantity < -2 || row.quantity === 0) {
      throw unreadable(
        operationId,
        ownerId,
        `the items row for blueprint ${row.itemID} carries quantity ${String(row.quantity)}, and `
          + "CCP's range is -2, -1, or a positive stack count",
      );
    }

    return projectBlueprint({
      itemId: row.itemID,
      locationFlag,
      locationId: row.locationID,
      quantity: row.quantity,
      typeId: row.typeID,
      ...numbers,
    });
  });
}

/** `GET /characters/{character_id}/blueprints/`. */
function buildCharacterBlueprints(params, deps) {
  const operationId = CHARACTER_BLUEPRINTS_OPERATION_ID;
  return buildBlueprints({
    store: readStore(deps, operationId),
    ownerId: callerCharacterId(params),
    surface: CHARACTER_BLUEPRINT,
    operationId,
  });
}

/**
 * `GET /corporations/{corporation_id}/blueprints/`.
 *
 * `CORPORATION_BLUEPRINT` is `CORPORATION`: the two corporation bodies publish
 * one 125-value enum between them, unlike the character pair, which differ by
 * thirteen. `lib/locationFlags.js` re-points the name rather than duplicating
 * the surface so the two cannot drift, and `test/locationFlags.test.js` asserts
 * the document still agrees.
 */
function buildCorporationBlueprints(params, deps) {
  const operationId = CORPORATION_BLUEPRINTS_OPERATION_ID;
  return buildBlueprints({
    store: readStore(deps, operationId),
    ownerId: subjectCorporationId(params, operationId),
    surface: CORPORATION_BLUEPRINT,
    operationId,
  });
}

// The route descriptor

/**
 * No `subject`: keyed by `:character_id` only, so the default cross-character
 * comparison is the right check. No `localizedBody`: eight numbers and one enum
 * string, with no name in the body.
 */
function createCharacterBlueprintsRoute(deps) {
  return {
    method: "GET",
    path: CHARACTER_BLUEPRINTS_PATH,
    name: CHARACTER_BLUEPRINTS_OPERATION_ID,
    handler: (params) => buildCharacterBlueprints(params, deps),
    producer: PRODUCER,
    scope: CHARACTER_BLUEPRINTS_SCOPE,
    cacheTtl: CHARACTER_BLUEPRINTS_CACHE_TTL_SECONDS,
    rateLimitGroup: CHARACTER_BLUEPRINTS_RATE_LIMIT_GROUP,
    pageSize: BLUEPRINTS_PAGE_SIZE,
  };
}

function createCorporationBlueprintsRoute(deps) {
  return {
    method: "GET",
    path: CORPORATION_BLUEPRINTS_PATH,
    name: CORPORATION_BLUEPRINTS_OPERATION_ID,
    handler: (params) => buildCorporationBlueprints(params, deps),
    producer: PRODUCER,
    scope: CORPORATION_BLUEPRINTS_SCOPE,
    cacheTtl: CORPORATION_BLUEPRINTS_CACHE_TTL_SECONDS,
    rateLimitGroup: CORPORATION_BLUEPRINTS_RATE_LIMIT_GROUP,
    pageSize: BLUEPRINTS_PAGE_SIZE,
    subject: corporationRoleSubject({
      operationId: CORPORATION_BLUEPRINTS_OPERATION_ID,
      roles: CORPORATION_BLUEPRINTS_ROLES,
      param: CORPORATION_ID_PARAM,
      deps,
    }),
  };
}

module.exports = Object.freeze({
  BLUEPRINTS_PAGE_SIZE,
  CORPORATION_BLUEPRINTS_CACHE_TTL_SECONDS,
  CORPORATION_BLUEPRINTS_OPERATION_ID,
  CORPORATION_BLUEPRINTS_PATH,
  CORPORATION_BLUEPRINTS_RATE_LIMIT_GROUP,
  CORPORATION_BLUEPRINTS_ROLES,
  CORPORATION_BLUEPRINTS_SCOPE,
  CORPORATION_ID_PARAM,
  buildCorporationBlueprints,
  createCorporationBlueprintsRoute,
  CHARACTER_BLUEPRINTS_CACHE_TTL_SECONDS,
  CHARACTER_BLUEPRINTS_OPERATION_ID,
  CHARACTER_BLUEPRINTS_PATH,
  CHARACTER_BLUEPRINTS_RATE_LIMIT_GROUP,
  CHARACTER_BLUEPRINTS_SCOPE,
  CHARACTER_ID_PARAM,
  PRODUCER,
  buildBlueprints,
  buildCharacterBlueprints,
  createCharacterBlueprintsRoute,
  projectBlueprint,
});
