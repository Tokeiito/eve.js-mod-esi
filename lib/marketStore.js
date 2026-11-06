/**
 * eve.js-mod-esi: the market daemon's order book, read-only
 *
 * The one place this mod opens a database that is not the game store, and the
 * only place it reaches a sibling service's private storage rather than a game
 * module. The coupling is deliberate; this file keeps its cost in one place.
 *
 * Why not the daemon's RPC: `services/market/marketDaemonClient.js` speaks a TCP
 * RPC whose `GetOrders` takes `{region_id, type_id}`, per type. ESI's
 * `/markets/{region_id}/orders/` returns every order in a region, so serving it
 * through that RPC means 52,590 calls per region sweep on the event loop the
 * universe ticks on (design constraint 2). A region-wide RPC in the daemon
 * would need a vendor-tree change, which D5 forbids.
 *
 * So the SQLite the daemon already writes is read, read-only, with the region
 * indexes it already maintains. One query, ~198 ms for The Forge's 79,147
 * orders, amortised across a 300-second cache window by the router's page
 * snapshot. That is a measured hitch on a game tick.
 *
 * Not `services/market/marketState.js`: its `getOrders` fabricates two sell
 * orders from `basePrice * 1.08` and `* 1.12` for a resolved ship type, so a
 * replica built on it would serve two synthetic orders per type.
 *
 * Three tables, one collection:
 *
 *   market_orders     player-placed orders. Every ESI field, near 1:1.
 *   seed_stock        the seeded sell side.  715,061 rows.
 *   seed_buy_orders   the seeded buy side.   255,510 rows.
 *
 * The seeded tables are the market on a private server (`market_orders` is empty
 * until somebody plays) and lack four of ESI's twelve required order fields:
 * `order_id`, `duration`, `min_volume` and `range`. Three have an honest
 * constant. `order_id` does not.
 *
 * Synthesising `order_id`. A client may key on it, and market-hub-seed sweeps
 * hundreds of pages, so it must be stable across a sweep and unique across the
 * region. `(station_id, type_id)` is the primary key of both seeded tables (both
 * `WITHOUT ROWID` on that pair, checked against the live database, which has
 * 970,571 rows), so the id is a pure function of it:
 *
 *   sell:  SEEDED_SELL_BASE + station_id * TYPE_SPACE + type_id
 *   buy:   SEEDED_BUY_BASE  + station_id * TYPE_SPACE + type_id
 *
 * Deterministic, so it survives a restart, a reseed and a cache window, with no
 * allocator to persist. The bases sit far above any id the game allocates (TQ's
 * real order ids are around 7.4e9) and the space stays under
 * `Number.MAX_SAFE_INTEGER`. A player-placed order keeps its real `order_id`,
 * which is why the bases are offset: both id spaces share one response.
 */

"use strict";

const { getMarketDbPath } = require("./runtimeAccess");

/** `station_id * TYPE_SPACE + type_id`, and `TYPE_SPACE` bounds `type_id`. */
const TYPE_SPACE = 1_000_000;

/**
 * Where synthetic ids start, per side.
 *
 * Far above anything the game allocates and far below `MAX_SAFE_INTEGER`
 * (9.007e15): the largest id this can produce is
 * `2e15 + 60_015_262 * 1e6 + 95_395`, about 2.06e15.
 */
const SEEDED_SELL_BASE = 1_000_000_000_000_000;
const SEEDED_BUY_BASE = 2_000_000_000_000_000;

/**
 * The three fields the seeded tables do not carry, and the value for each.
 *
 * `duration: 90` is the maximum a real order can be listed for. `min_volume: 1`
 * is the value on every order that does not set one. `range` is the reach of a
 * buy order and meaningless on a sell order, where ESI still sends `region`;
 * both observed on live ESI's own rows.
 */
const SEEDED_DURATION_DAYS = 90;
const SEEDED_MIN_VOLUME = 1;
const SEEDED_SELL_RANGE = "region";
const SEEDED_BUY_RANGE = "station";

/**
 * `range_value` on a player order is an integer; ESI's is an enum of strings.
 *
 * The numeric jump ranges spell themselves; `-1` and `32767` are the sentinels
 * for station and region.
 */
const RANGE_BY_VALUE = Object.freeze({
  "-1": "station",
  0: "solarsystem",
  1: "1",
  2: "2",
  3: "3",
  4: "4",
  5: "5",
  10: "10",
  20: "20",
  30: "30",
  40: "40",
  32767: "region",
});

/** A market read that could not happen. Never thrown at a client. */
class MarketStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "MarketStoreError";
  }
}

// The handle

let cached = null;

/**
 * The read-only database, or `null` with a reason.
 *
 * Opened once and kept: opening a 195 MB SQLite per request would cost more than
 * the query. `readOnly` makes it structural that this mod cannot write to the
 * daemon's book.
 *
 * `node:sqlite` is required lazily and inside the try, so a Node without it, or a
 * deployment with no market daemon, reports the market absent rather than failing
 * to load the mod.
 */
function openMarketDb({ path: dbPath = null } = {}) {
  if (cached) return cached;

  const resolved = dbPath || getMarketDbPath();
  if (!resolved) {
    cached = { db: null, path: null, reason: "the game store root could not be resolved" };
    return cached;
  }

  try {
    const { DatabaseSync } = require("node:sqlite");
    cached = { db: new DatabaseSync(resolved, { readOnly: true }), path: resolved, reason: null };
  } catch (err) {
    cached = { db: null, path: resolved, reason: `${resolved}: ${err.message}` };
  }
  return cached;
}

/** Drop the handle. For tests, and for a redeploy that moved the file. */
function closeMarketDb() {
  if (cached && cached.db) {
    try {
      cached.db.close();
    } catch (_) {
      // A handle that will not close is a handle we are dropping anyway.
    }
  }
  cached = null;
}

// Row to ESI order

/** `2026-08-18T13:04:21.322138519Z` -> `2026-08-18T13:04:21Z`, CCP's precision. */
function toEsiTimestamp(value) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return `${new Date(parsed).toISOString().slice(0, 19)}Z`;
}

/**
 * One seeded row as an ESI order.
 *
 * Field order is CCP's (alphabetical, as its serializer emits), and therefore
 * the order of the bytes.
 */
function seededOrder(row, isBuy) {
  const base = isBuy ? SEEDED_BUY_BASE : SEEDED_SELL_BASE;

  return {
    duration: SEEDED_DURATION_DAYS,
    is_buy_order: isBuy,
    issued: toEsiTimestamp(row.updated_at),
    location_id: row.station_id,
    min_volume: SEEDED_MIN_VOLUME,
    order_id: base + row.station_id * TYPE_SPACE + row.type_id,
    price: row.price,
    range: isBuy ? SEEDED_BUY_RANGE : SEEDED_SELL_RANGE,
    system_id: row.solar_system_id,
    type_id: row.type_id,
    volume_remain: row.quantity,
    volume_total: row.initial_quantity,
  };
}

/** One player-placed row as an ESI order. Every field is real. */
function placedOrder(row) {
  return {
    duration: row.duration_days,
    is_buy_order: row.bid === 1,
    issued: toEsiTimestamp(row.issued_at),
    location_id: row.station_id,
    min_volume: row.min_volume,
    order_id: row.order_id,
    price: row.price,
    range: RANGE_BY_VALUE[String(row.range_value)] || "station",
    system_id: row.solar_system_id,
    type_id: row.type_id,
    volume_remain: row.vol_remaining,
    volume_total: row.vol_entered,
  };
}

// Queries

const SEEDED_COLUMNS =
  "station_id, solar_system_id, type_id, price, quantity, initial_quantity, updated_at";

/**
 * The player-order columns, named rather than `select *`.
 *
 * `select *` is the one shape here where a renamed column is silent: every other
 * query names its columns, so a rename raises a SQLite error and fails loudly.
 * Picking fields off a whole row in `placedOrder` would turn a rename into
 * `undefined`, which serialises as a missing field on an order ESI requires, so
 * a client gets a spec-invalid order rather than an error.
 */
const PLACED_COLUMNS =
  "order_id, station_id, solar_system_id, type_id, price, vol_entered, vol_remaining, "
  + "min_volume, bid, range_value, duration_days, issued_at";

/**
 * The columns an owner's orders need: the placed ones plus four.
 *
 * `/characters/{id}/orders/` publishes `region_id`, `escrow` and
 * `is_corporation` where `/markets/{region_id}/orders/` publishes `system_id` and
 * none of the three, so the bodies are different projections of one row, and
 * this is the wider read.
 *
 * Named for the same reason as `PLACED_COLUMNS`: a `select *` turns a renamed
 * column into a missing key on a field ESI declares required.
 */
const OWNER_COLUMNS =
  "order_id, owner_id, is_corp, station_id, solar_system_id, region_id, type_id, price, "
  + "vol_entered, vol_remaining, min_volume, bid, range_value, duration_days, escrow, issued_at";

/**
 * Every column this module reads, per table, including the ones that appear only
 * in a `where` clause.
 *
 * Stated as data because `test/marketSchemaDrift.test.js` checks it against a
 * real database. The fixture in `test/marketFixture.js` is a transcription and
 * cannot notice the daemon renaming something: the fixture and the code drift
 * together and every mapping test stays green. This is the list that must still
 * exist upstream.
 */
const REQUIRED_COLUMNS = Object.freeze({
  seed_stock: Object.freeze([
    "station_id", "solar_system_id", "region_id", "type_id",
    "price", "quantity", "initial_quantity", "updated_at",
  ]),
  seed_buy_orders: Object.freeze([
    "station_id", "solar_system_id", "region_id", "type_id",
    "price", "quantity", "initial_quantity", "updated_at",
  ]),
  market_orders: Object.freeze([
    "order_id", "station_id", "solar_system_id", "region_id", "type_id", "price",
    "vol_entered", "vol_remaining", "min_volume", "bid", "range_value",
    "duration_days", "state", "issued_at",
    // The four an owner's own order list needs and a region sweep does not.
    "owner_id", "is_corp", "escrow", "wallet_division",
  ]),
  market_types: Object.freeze(["type_id", "base_price", "published"]),
  region_summaries: Object.freeze(["region_id", "type_id", "best_ask_price"]),
});

/**
 * The assumptions that are not about column names, and are worse.
 *
 * A rename produces an error or a null; these produce plausible wrong data. They
 * are stated so the drift test can check them against a real database.
 */
const SCHEMA_ASSUMPTIONS = Object.freeze({
  /**
   * `(station_id, type_id)` identifies one seeded row per table.
   *
   * The `order_id` synthesis rests on it. It is the primary key of both tables, so
   * a daemon that started storing per-price-level rows would have to change the
   * schema, which a test can see coming.
   */
  seededKey: Object.freeze(["station_id", "type_id"]),
  /** A row that is on the market. Any other spelling puts dead orders on it. */
  activeState: "active",
  /**
   * Every spelling the daemon writes, from `services/market/marketProxyService.js`:
   * `"active"`, `"filled"`, and the terminal labels `"cancelled"` and `"expired"`.
   *
   * The useful check is not "is there an active order": a server nobody has traded
   * on can hold one cancelled order and nothing else, which is healthy. Drift is a spelling nobody here knows:
   * `state = 'active'` then filters out orders that are on the market, or stops
   * filtering out ones that are not, and both look like a quiet market.
   */
  knownStates: Object.freeze(["active", "cancelled", "expired", "filled"]),
  /** `bid` is 0/1 and becomes `is_buy_order`. */
  bidValues: Object.freeze([0, 1]),
  /** `published` gates what `/markets/prices/` reports at all. */
  publishedValues: Object.freeze([0, 1]),
  /**
   * The region indexes D29's ~198 ms budget assumes.
   *
   * Not correctness: losing one turns a region sweep into a full scan on the event
   * loop the universe ticks on (design constraint 2).
   */
  regionIndexes: Object.freeze([
    "idx_seed_stock_region_type_price",
    "idx_seed_buy_orders_region_type_price",
    "idx_market_orders_region_type_bid_state_price",
  ]),
});

/**
 * Every order in a region, as ESI describes one.
 *
 * `orderType` is `buy`, `sell` or `all`, already validated by the route (the
 * spec requires it and CCP refuses anything else), so an unknown value here is a
 * bug.
 *
 * The ordering is explicit and total: a paginated sweep must see one collection
 * in one order across every page. `order_id` last makes it total, since the two
 * seeded tables can otherwise tie on every other column.
 */
function readRegionOrders(regionId, { orderType = "all", typeId = null, db = null } = {}) {
  const handle = db ? { db, reason: null } : openMarketDb();
  if (!handle.db) return { orders: [], reason: handle.reason };

  const wantSell = orderType === "all" || orderType === "sell";
  const wantBuy = orderType === "all" || orderType === "buy";
  const typeFilter = typeId === null ? "" : " and type_id = ?";

  const args = (extra) => (typeId === null ? [regionId] : [regionId, typeId]).concat(extra || []);
  const orders = [];

  if (wantSell) {
    for (const row of handle.db
      .prepare(`select ${SEEDED_COLUMNS} from seed_stock where region_id = ?${typeFilter}`)
      .all(...args())) {
      orders.push(seededOrder(row, false));
    }
  }
  if (wantBuy) {
    for (const row of handle.db
      .prepare(`select ${SEEDED_COLUMNS} from seed_buy_orders where region_id = ?${typeFilter}`)
      .all(...args())) {
      orders.push(seededOrder(row, true));
    }
  }

  // Player orders, when there are any. `state = 'active'` because a cancelled or
  // filled row stays in the table but is not on the market.
  const placedBid = wantSell && wantBuy ? "" : ` and bid = ${wantBuy ? 1 : 0}`;
  for (const row of handle.db
    .prepare(
      `select ${PLACED_COLUMNS} from market_orders where region_id = ?${typeFilter}`
        + ` and state = 'active'${placedBid}`,
    )
    .all(...args())) {
    orders.push(placedOrder(row));
  }

  orders.sort((a, b) => a.order_id - b.order_id);
  return { orders, reason: null };
}

/**
 * One player-placed row as a neutral order, for the three endpoints whose bodies
 * are not `/markets/{region_id}/orders/`'s.
 *
 * `placedOrder` returns an ESI-shaped object for its one caller. These rows feed
 * three projections (a character's orders, a corporation's, a structure's book)
 * that agree on eleven fields and differ on five, so shaping is the route's and
 * this is camelCase and complete.
 *
 * `range` is translated here rather than in a route: it is an integer in the
 * table and an enum of strings on every ESI body, and `RANGE_BY_VALUE` is the
 * one table pairing them.
 */
function ownerOrder(row) {
  return {
    orderId: row.order_id,
    ownerId: row.owner_id,
    isCorporation: row.is_corp === 1,
    locationId: row.station_id,
    systemId: row.solar_system_id,
    regionId: row.region_id,
    typeId: row.type_id,
    price: row.price,
    volumeTotal: row.vol_entered,
    volumeRemain: row.vol_remaining,
    minVolume: row.min_volume,
    isBuyOrder: row.bid === 1,
    range: RANGE_BY_VALUE[String(row.range_value)] || "station",
    duration: row.duration_days,
    escrow: row.escrow,
    issued: toEsiTimestamp(row.issued_at),
  };
}

/**
 * Every active order one owner has on the book.
 *
 * `isCorp` is part of the key, as upstream's
 * `idx_market_orders_owner_state` is `(owner_id, is_corp, state, updated_at)`: a
 * character and a corporation sharing an id (which cannot occur here, D9) would
 * be two owners to the daemon, and asking for one must never return the other's.
 *
 * Seeded orders are not included and cannot be: `seed_stock` and
 * `seed_buy_orders` have no owner, which is why `order_id` is synthesised for
 * them. A pilot's order list is exactly the rows they placed, as CCP's is.
 *
 * Ascending `order_id`: stable across identical requests, which the `Etag` needs.
 */
function readOwnerOrders(ownerId, { isCorp = false, db = null } = {}) {
  const handle = db ? { db, reason: null } : openMarketDb();
  if (!handle.db) return { orders: [], reason: handle.reason };

  const rows = handle.db
    .prepare(
      `select ${OWNER_COLUMNS} from market_orders where owner_id = ? and is_corp = ?`
        + ` and state = '${SCHEMA_ASSUMPTIONS.activeState}'`,
    )
    .all(ownerId, isCorp ? 1 : 0);

  const orders = rows.map((row) => ownerOrder(row));
  orders.sort((a, b) => a.orderId - b.orderId);
  return { orders, reason: null };
}

/**
 * Every active order at one location, which for `/markets/structures/{id}/` is an
 * Upwell structure.
 *
 * `station_id` holds a structure id as readily as a station one:
 * `services/market/marketProxyService.js` places a structure order through the
 * same field and charges the structure's owner a broker fee. So this is one
 * indexed query (`idx_market_orders_station_type_bid_state_price`), not a scan.
 *
 * The seeded tables are not consulted. They are keyed by `station_id` too, but a
 * private server's seeded liquidity is NPC-station stock, and a structure with
 * seeded rows would be a market CCP's structure endpoint would not show.
 */
function readStructureOrders(structureId, { db = null } = {}) {
  const handle = db ? { db, reason: null } : openMarketDb();
  if (!handle.db) return { orders: [], reason: handle.reason };

  const rows = handle.db
    .prepare(
      `select ${OWNER_COLUMNS} from market_orders where station_id = ?`
        + ` and state = '${SCHEMA_ASSUMPTIONS.activeState}'`,
    )
    .all(structureId);

  const orders = rows.map((row) => ownerOrder(row));
  orders.sort((a, b) => a.orderId - b.orderId);
  return { orders, reason: null };
}

/**
 * `GET /markets/prices/`: one row per type, with two optional fields.
 *
 * `adjusted_price` is the SDE's `base_price`, CCP's own number for the type.
 *
 * `average_price` is the mean of the best ask across every region that has one.
 * Both are optional in the spec, and a type with no source for one omits it
 * rather than reporting zero: a client reading `average_price: 0` would price
 * something at nothing.
 */
function readPrices({ db = null } = {}) {
  const handle = db ? { db, reason: null } : openMarketDb();
  if (!handle.db) return { prices: [], reason: handle.reason };

  const averages = new Map();
  for (const row of handle.db
    .prepare(
      "select type_id, avg(best_ask_price) a from region_summaries"
        + " where best_ask_price is not null and best_ask_price > 0 group by type_id",
    )
    .all()) {
    averages.set(row.type_id, row.a);
  }

  const prices = [];
  for (const row of handle.db
    .prepare("select type_id, base_price from market_types where published = 1")
    .all()) {
    const price = { type_id: row.type_id };
    if (row.base_price > 0) price.adjusted_price = row.base_price;
    const average = averages.get(row.type_id);
    if (average !== undefined) price.average_price = average;
    prices.push(price);
  }

  prices.sort((a, b) => a.type_id - b.type_id);
  return { prices, reason: null };
}

module.exports = {
  MarketStoreError,
  REQUIRED_COLUMNS,
  SCHEMA_ASSUMPTIONS,
  RANGE_BY_VALUE,
  SEEDED_BUY_BASE,
  SEEDED_BUY_RANGE,
  SEEDED_DURATION_DAYS,
  SEEDED_MIN_VOLUME,
  SEEDED_SELL_BASE,
  SEEDED_SELL_RANGE,
  TYPE_SPACE,
  OWNER_COLUMNS,
  closeMarketDb,
  openMarketDb,
  ownerOrder,
  placedOrder,
  readOwnerOrders,
  readPrices,
  readRegionOrders,
  readStructureOrders,
  seededOrder,
  toEsiTimestamp,
};
