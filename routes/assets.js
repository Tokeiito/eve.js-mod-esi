/**
 * `GET /characters/{character_id}/assets/`: everything a pilot owns and where
 * it is. Also the corporation twin.
 *
 * CCP files this under an `Assets` tag, and the corporation twin is the same
 * body from the same table with a different gate, so both live here rather than
 * in `routes/corporations.js`. `lib/assetStore.js` is the shared read; it reads
 * the `items` table directly instead of through `itemStore`, whose every
 * public read can rewrite and persist the table.
 *
 * `pageSize` is `1000`. The document does not publish one (no ESI operation
 * does); `contract/wire.js` `PAGINATION.pageSize` records 1000 as observed on
 * `/markets/{region_id}/orders/`, confirmed a third time when The Forge
 * reported `X-Pages: 413` for 412,000-odd orders. Every paginated route on the
 * public surface agrees. `routes/contacts.js` is the exception, because it had
 * an observation of 200 on one bucket to reconcile; assets has no
 * counter-observation. The 3600-second `x-cache-age` and the `pageSize` bound
 * the read cost: `lib/router.js` `dispatchPaginated` takes one snapshot of the
 * whole collection per cache window per caller and slices pages from it, so a
 * pilot with 4,000 items costs one pass over `items` an hour, not one per page.
 *
 * `quantity` is a count here: `1` for a singleton, the stack size for a stack.
 * On `/blueprints/` the same column is CCP's `-1` original / `-2` copy
 * convention, passed through untouched. They are two fields that share a name.
 * `lib/assetStore.js` exposes the row rather than "a quantity" so neither route
 * can send the other's. A `-1` in an assets body would read as "minus one
 * Rifter", so the coercion is explicit and asserted, not left to a `Math.max`.
 *
 * `is_blueprint_copy` is native: eve.js's `singleton` has three values and `2`
 * means blueprint copy (upstream's comment on `isBlueprintCopyInventoryItem`;
 * the row carries `quantity: -2` beside it). It is sent only when true. The
 * field is optional, and `false` on every non-blueprint row would add a key to
 * each of thousands of assets to say what `type_id` already implies.
 * `routes/entities.js` D37 is the precedent for declaring an omission
 * deliberately.
 *
 * Two enum values can never be sent: `Implant` and `Skill`. eve.js keeps
 * implants as an array on the character record and skills in their own table,
 * so neither is an `items` row with a `flagID`, and a pilot's implants are
 * absent where CCP would list them. `lib/locationFlags.js` states it and
 * `test/locationFlags.test.js` asserts it.
 *
 * A flag with no name is a refusal. `location_flag` is required and out of a
 * closed enum, so a row whose flag cannot be named cannot be built. It answers
 * a logged `500` naming the flag rather than dropping the row, as
 * `routes/skills.js` does for a skill: a quietly short asset list is one an
 * industry tool reconciles against a build plan, blaming its own arithmetic.
 */

"use strict";

const { locationFlagFor, CHARACTER, CORPORATION } = require("../lib/locationFlags");
const { optional, projection } = require("../lib/serialize");
const { CHARACTER_ID_PARAM } = require("./characters");
const { canonicalId, corporationRoleSubject } = require("./roles");

// The route

/** Canonical: no version prefix, no trailing slash. */
const CHARACTER_ASSETS_PATH = "/characters/:character_id/assets";

/** `x-cache-age` in the pinned spec. `assertRouteMatchesSpec` holds this to it. */
const CHARACTER_ASSETS_CACHE_TTL_SECONDS = 3600;

/** The scope CCP publishes for this operation. */
const CHARACTER_ASSETS_SCOPE = "esi-assets.read_assets.v1";

/** 1800 tokens per 15 minutes, the most generous bucket on the surface. */
const CHARACTER_ASSETS_RATE_LIMIT_GROUP = "char-asset";

/** One legal producer for a scoped route that sends JSON. See `assertScope`. */
const PRODUCER = "app";

/** `contract/wire.js` `PAGINATION.pageSize`. See the header. */
const ASSETS_PAGE_SIZE = 1000;

/** CCP's own operationId, which is also this route's `name` and its log line. */
const CHARACTER_ASSETS_OPERATION_ID = "GetCharactersCharacterIdAssets";

// The corporation twin

/**
 * The parameter spelling is load-bearing, as in `routes/structures.js`:
 * `lib/router.js` `compileRoute` decides a route needs a `subject` by looking
 * for a path parameter ending in `_id` that is not `character_id`. A parameter
 * spelled `:id` would fail that heuristic and the route would compile with the
 * scope as its only gate.
 */
const CORPORATION_ID_PARAM = "corporation_id";

const CORPORATION_ASSETS_PATH = "/corporations/:corporation_id/assets";
const CORPORATION_ASSETS_CACHE_TTL_SECONDS = 3600;
const CORPORATION_ASSETS_SCOPE = "esi-assets.read_corporation_assets.v1";
const CORPORATION_ASSETS_RATE_LIMIT_GROUP = "corp-asset";
const CORPORATION_ASSETS_OPERATION_ID = "GetCorporationsCorporationIdAssets";

/**
 * The roles CCP's `x-required-roles` declares on this operation.
 *
 * Spelled as the document spells them and resolved to an eve.js bit by
 * `routes/roles.js` `roleBitFor`, so the pairing lives in one table.
 * `test/assetsContract.test.js` asserts this array against the document.
 */
const CORPORATION_ASSETS_ROLES = Object.freeze(["Director"]);

// Reading the game

/**
 * The error this route raises when it cannot answer for a character its own
 * gate has already vouched for.
 *
 * As `unreadable` in `routes/characters.js` and the copies in `routes/roles.js`
 * and `routes/skills.js`: a logged `500`, never a `404`, with the reason going
 * to the game server's log. The gate has proved a credential was presented,
 * verifies, carries this scope and names this character, and a credential
 * exists only because the minter read that character's record, so an
 * unreadable inventory is this server's inconsistency.
 */
function unreadable(operationId, ownerId, detail) {
  return new Error(
    `ESI mod: ${operationId} cannot answer for owner ${ownerId}: ${detail}. `
      + "This is a server-side inconsistency, not a client error.",
  );
}

/** `deps.assets`, the store, or a throw naming what is missing. */
function readStore(deps, operationId) {
  const store = deps && typeof deps === "object" ? deps.assets : null;
  if (store === null || typeof store !== "object" || typeof store.ownedItems !== "function") {
    throw new Error(
      `ESI mod: ${operationId} ran with no asset store. loader.js builds one with `
        + "lib/assetStore.js createAssetStore() and hands it to the factory as `assets`.",
    );
  }
  return store;
}

/**
 * Who is asking, as a number that was signed.
 *
 * `params.credential.characterId`, never `params.path.character_id`; see
 * `callerCharacterId` in `routes/characters.js`. The path segment is a string
 * the requester typed, the claim is a number this server signed, and the gate
 * has proved they agree.
 */
function callerCharacterId(params) {
  const credential = params && params.credential;
  const characterId = credential && credential.characterId;

  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new Error(
      "ESI mod: an assets route ran with no verified credential. Every route in this module "
        + "declares a scope, so lib/router.js authorise() should have refused the request before "
        + "the handler saw it.",
    );
  }

  return characterId;
}

// Shaping one row

/**
 * ESI's `quantity` for an assets row: a count, never a convention.
 *
 * A singleton (assembled or a blueprint copy) is one thing, so `1`. A stack is
 * its units; eve.js writes them into `quantity` and `stacksize` together, and
 * `stacksize` is the second choice because upstream's
 * `getStackableItemQuantity` reads `quantity` first.
 *
 * A stack row with neither is corruption and a refusal: `quantity` is
 * required, and `0` would tell a client a pilot owns none of something in their
 * hangar.
 */
function assetQuantity(operationId, ownerId, row) {
  if (row.singleton !== 0) return 1;

  const units = Number.isSafeInteger(row.quantity) && row.quantity > 0
    ? row.quantity
    : row.stacksize;

  if (!Number.isSafeInteger(units) || units <= 0) {
    throw unreadable(
      operationId,
      ownerId,
      `the items row for item ${row.itemID} is a stack carrying no readable quantity, and `
        + "quantity is required",
    );
  }

  return units;
}

/**
 * One asset, in the schema's declaration order, which is alphabetical.
 *
 * Declaration order is output order is bytes. Alphabetical is what the pinned
 * document declares and what every application body observed has used, as
 * `routes/skills.js` concluded with no capture to read.
 *
 * `is_blueprint_copy` is the only optional field and is sent only when true.
 * See the header.
 */
const projectAsset = projection(CHARACTER_ASSETS_OPERATION_ID, {
  is_blueprint_copy: (asset) => optional(asset.isBlueprintCopy ? true : null),
  is_singleton: (asset) => asset.isSingleton,
  item_id: (asset) => asset.itemId,
  location_flag: (asset) => asset.locationFlag,
  location_id: (asset) => asset.locationId,
  location_type: (asset) => asset.locationType,
  quantity: (asset) => asset.quantity,
  type_id: (asset) => asset.typeId,
});

/**
 * One owner's whole asset list, as the array `dispatchPaginated` slices.
 *
 * Shared by the character route and its corporation twin, which differ in the
 * gate and in which `location_flag` enum is legal. `surface` carries the
 * latter.
 *
 * The `itemIds` set is built once and handed to every classification, because
 * the `item` branch of `location_type` is a membership test against the whole
 * inventory, and doing it per row would read the table once per asset.
 */
function buildAssets({ store, ownerId, surface, operationId }) {
  const rows = store.ownedItems(ownerId);
  const itemIds = store.itemIds();

  return rows.map((row) => {
    let locationFlag;
    try {
      locationFlag = locationFlagFor(row.flagID, surface);
    } catch (err) {
      throw unreadable(
        operationId,
        ownerId,
        `item ${row.itemID} carries ${err.message.replace(/^ESI mod: /, "")}`,
      );
    }

    return projectAsset({
      isBlueprintCopy: row.singleton === 2,
      isSingleton: row.singleton !== 0,
      itemId: row.itemID,
      locationFlag,
      locationId: row.locationID,
      locationType: store.locationTypeOf(row.locationID, { itemIds }),
      quantity: assetQuantity(operationId, ownerId, row),
      typeId: row.typeID,
    });
  });
}

/** `GET /characters/{character_id}/assets/`. */
function buildCharacterAssets(params, deps) {
  const operationId = CHARACTER_ASSETS_OPERATION_ID;
  return buildAssets({
    store: readStore(deps, operationId),
    ownerId: callerCharacterId(params),
    surface: CHARACTER,
    operationId,
  });
}

/**
 * Who the corporation routes are asking about.
 *
 * The path, unlike every character route here. On a character route the claim
 * (a number this server signed) wins over the path segment. On a corporation
 * route the token names a character, not a corporation, so the gate stands in:
 * `corporationRoleSubject` reads the caller's corporation off their own record
 * and refuses unless it equals this segment, so by the time a handler runs the
 * segment is proved to be the caller's own corporation.
 *
 * Re-validated here rather than trusted, since "the gate already checked" stops
 * being true when someone adds a second way to reach the handler.
 */
function subjectCorporationId(params, operationId) {
  const corporationId = canonicalId(params && params.path && params.path[CORPORATION_ID_PARAM]);
  if (corporationId === null) {
    throw new Error(
      `ESI mod: ${operationId} ran with a corporation_id that is not a canonical positive `
        + "integer. routes/roles.js corporationRoleSubject refuses one before the handler is "
        + "reached, so this is unreachable and means the route lost its subject.",
    );
  }
  return corporationId;
}

/** `GET /corporations/{corporation_id}/assets/`. */
function buildCorporationAssets(params, deps) {
  const operationId = CORPORATION_ASSETS_OPERATION_ID;
  return buildAssets({
    store: readStore(deps, operationId),
    ownerId: subjectCorporationId(params, operationId),
    surface: CORPORATION,
    operationId,
  });
}

// The route descriptor

/**
 * No `subject`: keyed by `:character_id` only, so `compileRoute` does not
 * demand one and the default `SUBJECT.CALLER` (the cross-character comparison)
 * is the right check.
 *
 * No `localizedBody`: ids, two booleans and two enum strings from closed sets,
 * with no name or description, so it sends the three-line `Vary`.
 * `routes/roles.js` makes the same call.
 */
function createCharacterAssetsRoute(deps) {
  return {
    method: "GET",
    path: CHARACTER_ASSETS_PATH,
    name: CHARACTER_ASSETS_OPERATION_ID,
    handler: (params) => buildCharacterAssets(params, deps),
    producer: PRODUCER,
    scope: CHARACTER_ASSETS_SCOPE,
    cacheTtl: CHARACTER_ASSETS_CACHE_TTL_SECONDS,
    rateLimitGroup: CHARACTER_ASSETS_RATE_LIMIT_GROUP,
    pageSize: ASSETS_PAGE_SIZE,
  };
}

/**
 * `GET /corporations/{corporation_id}/assets/`.
 *
 * The same body from the same table as the character route, differing in three
 * columns and one gate. A corporation's assets are readable by a `Director` of
 * that corporation and nobody else, and `corporationRoleSubject` makes both
 * halves a refusal with the bytes `contract/wire.js` recorded rather than a
 * throw.
 *
 * It takes `runtime` as well as `assets`, which no character route in this
 * family does: the gate reads the caller's corporation and role masks off the
 * game, and the store cannot.
 */
function createCorporationAssetsRoute(deps) {
  return {
    method: "GET",
    path: CORPORATION_ASSETS_PATH,
    name: CORPORATION_ASSETS_OPERATION_ID,
    handler: (params) => buildCorporationAssets(params, deps),
    producer: PRODUCER,
    scope: CORPORATION_ASSETS_SCOPE,
    cacheTtl: CORPORATION_ASSETS_CACHE_TTL_SECONDS,
    rateLimitGroup: CORPORATION_ASSETS_RATE_LIMIT_GROUP,
    pageSize: ASSETS_PAGE_SIZE,
    subject: corporationRoleSubject({
      operationId: CORPORATION_ASSETS_OPERATION_ID,
      roles: CORPORATION_ASSETS_ROLES,
      param: CORPORATION_ID_PARAM,
      deps,
    }),
  };
}

module.exports = Object.freeze({
  ASSETS_PAGE_SIZE,
  CORPORATION_ASSETS_CACHE_TTL_SECONDS,
  CORPORATION_ASSETS_OPERATION_ID,
  CORPORATION_ASSETS_PATH,
  CORPORATION_ASSETS_RATE_LIMIT_GROUP,
  CORPORATION_ASSETS_ROLES,
  CORPORATION_ASSETS_SCOPE,
  CORPORATION_ID_PARAM,
  buildCorporationAssets,
  createCorporationAssetsRoute,
  subjectCorporationId,
  CHARACTER_ASSETS_CACHE_TTL_SECONDS,
  CHARACTER_ASSETS_OPERATION_ID,
  CHARACTER_ASSETS_PATH,
  CHARACTER_ASSETS_RATE_LIMIT_GROUP,
  CHARACTER_ASSETS_SCOPE,
  CHARACTER_ID_PARAM,
  PRODUCER,
  assetQuantity,
  buildAssets,
  buildCharacterAssets,
  callerCharacterId,
  createCharacterAssetsRoute,
  projectAsset,
  readStore,
  unreadable,
});
