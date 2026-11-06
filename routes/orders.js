/**
 * `GET /characters/{character_id}/orders/` and
 * `GET /markets/structures/{structure_id}/`: a pilot's own orders, and the
 * book inside a player-owned structure.
 *
 * Both read the market daemon's `market_orders` table, so they share a file as
 * the two `/markets/` reads do. Neither is a filter over
 * `/markets/{region_id}/orders/`: that body carries `system_id` and these do
 * not, a character's carries `region_id`, `escrow` and `is_corporation`, and a
 * structure's declares `min_volume` and `is_buy_order` required where a
 * character's declares both optional. `lib/marketStore.js` `ownerOrder` is the
 * neutral shape all three projections sit on.
 *
 * Seeded liquidity is nobody's. `seed_stock` and `seed_buy_orders` have no
 * owner column (which is why `lib/marketStore.js` synthesises an `order_id` for
 * them), so a pilot's order list is exactly the rows they placed, as CCP's is.
 * The structure book omits them by choice: the seeded tables are keyed by
 * `station_id` and would answer a structure id as readily as a station id, but
 * they are NPC-station stock, and serving them under a structure would invent
 * a market CCP's endpoint would not show.
 *
 * `escrow`, `is_buy_order` and `min_volume` are optional on the character body.
 * All three are columns with a value on every row, so they are sent whenever
 * readable, as `routes/skills.js` does for `unallocated_sp` and
 * `routes/industry.js` does for `cost`. The alternative is that CCP omits them
 * on a sell order. That is unobserved, and the worse failure: a client reading
 * `order.escrow` on a sell order gets `0` here and `undefined` from a replica
 * that omitted it. One `curl` with a token against a character holding one sell
 * order settles it, and nothing else in this file depends on the answer.
 *
 * The market database may be absent. `lib/marketStore.js` answers
 * `{ orders: [], reason }` when it cannot open the daemon's SQLite (no market
 * daemon, a Node without `node:sqlite`, a moved file). `/markets/prices/` treats
 * that as an empty collection, which is indistinguishable from a server with no
 * market. These two routes do not: a pilot's own `[]` reads as "no orders", and
 * a trading tool then places duplicates. A `reason` is therefore a logged `500`
 * here, the same distinction `routes/skills.js` draws for an unreadable
 * `skills` table.
 */

"use strict";

const { double, optional, projection } = require("../lib/serialize");
const { CHARACTER_ID_PARAM } = require("./characters");
const { callerCharacterId } = require("./assets");
const { canonicalId } = require("./roles");
const { structureOwnershipSubject } = require("./structures");

// A pilot's own orders

const CHARACTER_ORDERS_PATH = "/characters/:character_id/orders";

/** `x-cache-age` in the pinned spec: twenty minutes. */
const CHARACTER_ORDERS_CACHE_TTL_SECONDS = 1200;

const CHARACTER_ORDERS_SCOPE = "esi-markets.read_character_orders.v1";

/**
 * No rate-limit group.
 *
 * The document publishes `market-order` on `/markets/{region_id}/orders/` and
 * nothing on this operation, so it falls to the error budget rather than a
 * token bucket, as `/markets/prices/` does (`routes/markets.js` declares its
 * `null` explicitly).
 */
const CHARACTER_ORDERS_RATE_LIMIT_GROUP = null;

const PRODUCER = "app";

const CHARACTER_ORDERS_OPERATION_ID = "GetCharactersCharacterIdOrders";

// A structure's book

const STRUCTURE_ORDERS_PATH = "/markets/structures/:structure_id";
const STRUCTURE_ORDERS_CACHE_TTL_SECONDS = 300;
const STRUCTURE_ORDERS_SCOPE = "esi-markets.structure_markets.v1";
const STRUCTURE_ORDERS_RATE_LIMIT_GROUP = null;
const STRUCTURE_ORDERS_OPERATION_ID = "GetMarketsStructuresStructureId";
const STRUCTURE_ORDERS_PAGE_SIZE = 1000;

/**
 * The parameter spelling is load-bearing, as `corporation_id` is:
 * `lib/router.js` `compileRoute` decides a route needs a `subject` by looking
 * for a path parameter ending in `_id` that is not `character_id`.
 */
const STRUCTURE_ID_PARAM = "structure_id";

// Reading the store

function readStore(deps, operationId) {
  const store = deps && typeof deps === "object" ? deps.market : null;
  if (store === null || typeof store !== "object") {
    throw new Error(
      `ESI mod: ${operationId} ran with no market store. loader.js passes lib/marketStore.js's `
        + "readers as `market`.",
    );
  }
  return store;
}

/**
 * The orders, or a throw carrying the store's own reason.
 *
 * An absent market database is a `500` on these two routes and an empty
 * collection on `/markets/prices/`; see the header.
 */
function ordersOrThrow(result, operationId, subject) {
  if (result.reason !== null && result.reason !== undefined) {
    throw new Error(
      `ESI mod: ${operationId} cannot answer for ${subject}: the market daemon's order book `
        + `could not be read (${result.reason}). An empty order list would be read as "there are `
        + 'none", so this is a refusal rather than an answer.',
    );
  }
  return result.orders;
}

// The bodies

/**
 * One of a pilot's own orders, in the schema's declaration order (alphabetical,
 * as every application body on this surface).
 *
 * `price` and `escrow` are `format: double` and go through `double()`, so an
 * integral price reaches the wire as `100.0` rather than `100`
 * (`contract/wire.js` `DOUBLE_RENDERING`).
 */
const projectCharacterOrder = projection(CHARACTER_ORDERS_OPERATION_ID, {
  duration: (order) => order.duration,
  escrow: (order) => (order.escrow === null ? optional(null) : double(order.escrow)),
  is_buy_order: (order) => optional(order.isBuyOrder),
  is_corporation: (order) => order.isCorporation,
  issued: (order) => order.issued,
  location_id: (order) => order.locationId,
  min_volume: (order) => optional(order.minVolume),
  order_id: (order) => order.orderId,
  price: (order) => double(order.price),
  range: (order) => order.range,
  region_id: (order) => order.regionId,
  type_id: (order) => order.typeId,
  volume_remain: (order) => order.volumeRemain,
  volume_total: (order) => order.volumeTotal,
});

/**
 * One order in a structure's book.
 *
 * Eleven fields, all required: `min_volume` and `is_buy_order` are not optional
 * here as they are on the character body, which is CCP's document. No `escrow`
 * (the owner's business), no `region_id`, no `system_id`.
 */
const projectStructureOrder = projection(STRUCTURE_ORDERS_OPERATION_ID, {
  duration: (order) => order.duration,
  is_buy_order: (order) => order.isBuyOrder,
  issued: (order) => order.issued,
  location_id: (order) => order.locationId,
  min_volume: (order) => order.minVolume,
  order_id: (order) => order.orderId,
  price: (order) => double(order.price),
  range: (order) => order.range,
  type_id: (order) => order.typeId,
  volume_remain: (order) => order.volumeRemain,
  volume_total: (order) => order.volumeTotal,
});

function assertComplete(order, operationId, subject, fields) {
  for (const field of fields) {
    const value = order[field];
    if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error(
        `ESI mod: ${operationId} cannot answer for ${subject}: order ${String(order.orderId)} `
          + `carries no readable ${field}, and it is required. This is a server-side `
          + "inconsistency, not a client error.",
      );
    }
  }
  return order;
}

const REQUIRED_FIELDS = Object.freeze([
  "orderId", "typeId", "locationId", "price", "range",
  "volumeTotal", "volumeRemain", "duration", "issued",
]);

function buildCharacterOrders(params, deps) {
  const operationId = CHARACTER_ORDERS_OPERATION_ID;
  const store = readStore(deps, operationId);
  const characterId = callerCharacterId(params);

  const orders = ordersOrThrow(
    store.readOwnerOrders(characterId, { isCorp: false }),
    operationId,
    `character ${characterId}`,
  );

  return orders.map((order) => {
    assertComplete(order, operationId, `character ${characterId}`, [...REQUIRED_FIELDS, "regionId"]);
    return projectCharacterOrder(order);
  });
}

/**
 * The structure this request is about, as a number.
 *
 * Re-validated rather than trusted, as `subjectCorporationId` is: the subject
 * check refuses a non-canonical segment before a handler runs, but that
 * assumption stops holding when a second way in is added.
 */
function subjectStructureId(params, operationId) {
  const structureId = canonicalId(params && params.path && params.path[STRUCTURE_ID_PARAM]);
  if (structureId === null) {
    throw new Error(
      `ESI mod: ${operationId} ran with a structure_id that is not a canonical positive integer. `
        + "The subject check refuses one before the handler is reached, so this is unreachable "
        + "and means the route lost its subject.",
    );
  }
  return structureId;
}

function buildStructureOrders(params, deps) {
  const operationId = STRUCTURE_ORDERS_OPERATION_ID;
  const store = readStore(deps, operationId);
  const structureId = subjectStructureId(params, operationId);

  const orders = ordersOrThrow(
    store.readStructureOrders(structureId),
    operationId,
    `structure ${structureId}`,
  );

  return orders.map((order) => {
    assertComplete(order, operationId, `structure ${structureId}`, [...REQUIRED_FIELDS, "minVolume"]);
    return projectStructureOrder(order);
  });
}

// The route descriptors

/**
 * `GET /characters/{character_id}/orders/`.
 *
 * No `pageSize`: the document declares no `page` parameter on this operation,
 * and declares one on its corporation twin (the same asymmetry as the industry
 * pair).
 *
 * No `subject`: keyed by `:character_id` only, so the default cross-character
 * comparison is the right check. No `localizedBody`: the body has no name.
 */
function createCharacterOrdersRoute(deps) {
  return {
    method: "GET",
    path: CHARACTER_ORDERS_PATH,
    name: CHARACTER_ORDERS_OPERATION_ID,
    handler: (params) => buildCharacterOrders(params, deps),
    producer: PRODUCER,
    scope: CHARACTER_ORDERS_SCOPE,
    cacheTtl: CHARACTER_ORDERS_CACHE_TTL_SECONDS,
    rateLimitGroup: CHARACTER_ORDERS_RATE_LIMIT_GROUP,
  };
}

/**
 * `GET /markets/structures/{structure_id}/`.
 *
 * The ACL is `routes/structures.js` `structureOwnershipSubject`, shared with
 * `/universe/structures/{structure_id}/`. It is ownership, and CCP's is market
 * access. Real ESI answers for anybody who can reach the structure's market,
 * which means docking access: a public Upwell market is readable by a trader
 * who has never heard of the corporation that anchored it. This replica answers
 * only for a caller whose own corporation owns the structure. That is narrower,
 * and on a server with more than one corporation a trading tool cannot see a
 * market it should. Narrower was chosen deliberately: a too-tight gate refuses
 * a legitimate read visibly, a too-loose one hands one corporation another's
 * book silently.
 *
 * The fix is eve.js's own docking check, in
 * `services/structure/structureDockingService.js` `canCharacterDockAtStructure`
 * and the per-profile access groups behind it. Using it needs a new
 * `GAME_MODULES` entry and proof that the call does not write:
 * `routes/structures.js` records that eve.js's structure reads have a
 * `refresh: false` mode because the default one runs the fuel and state machine.
 *
 * The refusal is a logged `500`, not a `403`, as for
 * `/universe/structures/{id}/`: CCP's spec declares only `200` and `default`
 * here, so whether a caller off the ACL gets a `403`, and whether a structure
 * that does not exist gets a `403` or a `404`, are both unobserved.
 */
function createStructureOrdersRoute(deps) {
  return {
    method: "GET",
    path: STRUCTURE_ORDERS_PATH,
    name: STRUCTURE_ORDERS_OPERATION_ID,
    handler: (params) => buildStructureOrders(params, deps),
    producer: PRODUCER,
    scope: STRUCTURE_ORDERS_SCOPE,
    cacheTtl: STRUCTURE_ORDERS_CACHE_TTL_SECONDS,
    rateLimitGroup: STRUCTURE_ORDERS_RATE_LIMIT_GROUP,
    pageSize: STRUCTURE_ORDERS_PAGE_SIZE,
    subject: structureOwnershipSubject({
      operationId: STRUCTURE_ORDERS_OPERATION_ID,
      param: STRUCTURE_ID_PARAM,
      deps,
    }),
  };
}

module.exports = Object.freeze({
  createCharacterOrdersRoute,
  createStructureOrdersRoute,
  subjectStructureId,
  CHARACTER_ID_PARAM,
  CHARACTER_ORDERS_CACHE_TTL_SECONDS,
  CHARACTER_ORDERS_OPERATION_ID,
  CHARACTER_ORDERS_PATH,
  CHARACTER_ORDERS_RATE_LIMIT_GROUP,
  CHARACTER_ORDERS_SCOPE,
  PRODUCER,
  REQUIRED_FIELDS,
  STRUCTURE_ID_PARAM,
  STRUCTURE_ORDERS_CACHE_TTL_SECONDS,
  STRUCTURE_ORDERS_OPERATION_ID,
  STRUCTURE_ORDERS_PAGE_SIZE,
  STRUCTURE_ORDERS_PATH,
  STRUCTURE_ORDERS_RATE_LIMIT_GROUP,
  STRUCTURE_ORDERS_SCOPE,
  assertComplete,
  buildCharacterOrders,
  buildStructureOrders,
  ordersOrThrow,
  projectCharacterOrder,
  projectStructureOrder,
  readStore,
});
