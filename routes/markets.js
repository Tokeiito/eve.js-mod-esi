/**
 * `GET /markets/prices/` and `GET /markets/{region_id}/orders/`: the two
 * endpoints market-hub-seed reads.
 *
 * Both are the application producer, observed: `application/json;
 * charset=UTF-8`, no trailing newline, a strong SHA-224 `Etag`, bare `public`
 * `Cache-Control`, and `Expires` measured from `Last-Modified` rather than from
 * `Date`.
 *
 *   curl -sD - .../latest/markets/prices/
 *     Cache-Control: public          Etag: "cde17ddc..."  (56 hex, strong)
 *     Last-Modified: 19:48:46        Expires: 20:48:46  (lm + 3600)
 *     (no X-Ratelimit-*, so the error limiter answers)
 *
 *   curl -sD - ".../latest/markets/10000002/orders/?order_type=all&page=1"
 *     Cache-Control: public          Last-Modified: 19:50:30
 *     Expires: 19:55:30              (lm + 300)
 *     X-Pages: 413                   X-Ratelimit-Group: market-order
 *
 * The two routes differ in which limiter answers, as the pinned spec says:
 * `/markets/prices` publishes no `x-rate-limit`, so the error limiter answers,
 * and `/markets/{region_id}/orders` publishes `market-order` at 12000/15m. The
 * route table states the group and `lib/pipeline.js` does the rest.
 *
 * Pagination: 1000 orders per page, counted off page 1 of The Forge, where CCP
 * reported `X-Pages: 413`. The spec does not publish a page size, so it is an
 * observation. The framework slices, so `X-Pages` and the body cannot disagree.
 * The handler is asked for the whole region once per cache window: 79,147
 * orders and ~198 ms for The Forge, measured. That is a hitch on the universe
 * tick, once per 300 s rather than once per request.
 *
 * `order_type` is required, and that is the route's only refusal. The spec
 * marks it required with an enum of three. A missing or unknown value gets the
 * coercion status of this route's own error family; a query-parameter refusal
 * has not been observed on this endpoint specifically, and `lib/errors.js` owns
 * the shape.
 *
 * `adjusted_price` is the SDE's `base_price` and `average_price` is the mean
 * best ask across regions. A type with no source for one omits it, because both
 * are optional in the spec and `0` is a price a client would act on.
 * `lib/marketStore.js` has the reasoning and the `order_id` synthesis.
 *
 * Doubles: `price`, `adjusted_price` and `average_price` are `format: double`,
 * and CCP writes a double with a decimal point whatever its value:
 * `contract/golden/GetMarketsRegionIdOrders.json` carries prices such as
 * `"price":170000000.0`. That golden's diff kind is `shape`, which compares the
 * field set, key order and last byte but no values, and `0` and `0.0` parse to
 * the same number, so only a byte comparison sees it. `contract/wire.js`
 * `DOUBLE_RENDERING` is the finding and `markOrderDoubles`/`markPriceDoubles`
 * below apply it.
 */

"use strict";

const { readPrices, readRegionOrders } = require("../lib/marketStore");
const { double } = require("../lib/serialize");

const PRICES_PATH = "/markets/prices";
const REGION_ORDERS_PATH = "/markets/:region_id/orders";

const PRICES_CACHE_TTL_SECONDS = 3600;
const ORDERS_CACHE_TTL_SECONDS = 300;

const PRICES_RATE_LIMIT_GROUP = null;
const ORDERS_RATE_LIMIT_GROUP = "market-order";

const PRODUCER = "app";

/** Counted off page 1 of The Forge, where CCP reported `X-Pages: 413`. */
const ORDERS_PAGE_SIZE = 1000;

const ORDER_TYPES = Object.freeze(["buy", "sell", "all"]);

/**
 * A region id that is not a positive integer.
 *
 * The legacy family's coercion message, which this producer sends for a path
 * parameter it cannot read. `lib/errors.js` owns the wording.
 */
function parseRegionId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseTypeId(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (!/^\d+$/.test(String(raw))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

// The wire form of a price

/**
 * `price` on every order, marked as the double the spec declares.
 *
 * `lib/marketStore.js` returns plain JavaScript numbers; how a number reaches
 * the wire is this file's business, as it is in `routes/universe.js`.
 *
 * Marked in place rather than into a copy: `seededOrder` and `placedOrder`
 * build a fresh object per row on every read, and cloning The Forge's 79,147
 * orders is not worth it.
 *
 * `double()` passes `null` and `undefined` through, so a row without a price
 * serialises as before instead of throwing inside a handler.
 */
function markOrderDoubles(orders) {
  for (const order of orders) order.price = double(order.price);
  return orders;
}

/**
 * The same, for the two optional fields on a price row.
 *
 * Guarded on presence rather than `optional(double(x))`: `readPrices` omits the
 * key for a type it has no number for, while `optional()` is for a field that is
 * present and `null`.
 */
function markPriceDoubles(prices) {
  for (const price of prices) {
    if (price.adjusted_price !== undefined) price.adjusted_price = double(price.adjusted_price);
    if (price.average_price !== undefined) price.average_price = double(price.average_price);
  }
  return prices;
}

/**
 * `GET /markets/prices/`.
 *
 * Not paginated: CCP sends all 15,817 rows in one body, with no `X-Pages`, so
 * this route declares no `pageSize` and returns the whole collection.
 */
function buildPrices() {
  return markPriceDoubles(readPrices().prices);
}

/**
 * `GET /markets/{region_id}/orders/`.
 *
 * Returns the whole region; the framework slices it into pages and holds one
 * snapshot per cache window, which keeps `X-Pages` and `Last-Modified` stable
 * across a sweep. market-hub-seed hard-fails a run when either moves between
 * pages, so that property is the endpoint's contract.
 */
function buildRegionOrders(params) {
  const regionId = parseRegionId(params.path.region_id);
  if (regionId === null) return [];

  const orderType = ORDER_TYPES.includes(params.query.order_type)
    ? params.query.order_type
    : "all";

  return markOrderDoubles(readRegionOrders(regionId, {
    orderType,
    typeId: parseTypeId(params.query.type_id),
  }).orders);
}

function createMarketPricesRoute() {
  return {
    method: "GET",
    path: PRICES_PATH,
    name: "GetMarketsPrices",
    handler: () => buildPrices(),
    producer: PRODUCER,
    cacheTtl: PRICES_CACHE_TTL_SECONDS,
    rateLimitGroup: PRICES_RATE_LIMIT_GROUP,
  };
}

function createMarketRegionOrdersRoute() {
  return {
    method: "GET",
    path: REGION_ORDERS_PATH,
    name: "GetMarketsRegionIdOrders",
    handler: (params) => buildRegionOrders(params),
    producer: PRODUCER,
    cacheTtl: ORDERS_CACHE_TTL_SECONDS,
    rateLimitGroup: ORDERS_RATE_LIMIT_GROUP,
    pageSize: ORDERS_PAGE_SIZE,
  };
}

module.exports = Object.freeze({
  ORDERS_CACHE_TTL_SECONDS,
  ORDERS_PAGE_SIZE,
  ORDERS_RATE_LIMIT_GROUP,
  ORDER_TYPES,
  PRICES_CACHE_TTL_SECONDS,
  PRICES_PATH,
  PRICES_RATE_LIMIT_GROUP,
  PRODUCER,
  REGION_ORDERS_PATH,
  buildPrices,
  buildRegionOrders,
  createMarketPricesRoute,
  createMarketRegionOrdersRoute,
  markOrderDoubles,
  markPriceDoubles,
  parseRegionId,
  parseTypeId,
});
