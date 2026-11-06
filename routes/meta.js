/**
 * `GET /meta/compatibility-dates`: the surface, describing itself.
 *
 *   {"compatibility_dates":["2020-01-01"]}
 *
 * The only endpoint whose content is a statement about this replica rather than
 * the game. CCP's list is fourteen dates; this one has one, because D4 scoped
 * this replica to the `2020-01-01` surface. A client that asks which dates are
 * served learns in one request what would otherwise surface as a `400` on its
 * fifth endpoint. A client that keys an on-disk cache on
 * `SHA-256(compatibilityDate + url)` can discover the date to key on.
 *
 * It is unversioned:
 *
 *   GET /meta/compatibility-dates          200
 *   GET /latest/meta/compatibility-dates   404 page not found   (Go's, 19 bytes)
 *
 * This is the second entry in `contract/wire.js` `UNVERSIONED_PATHS`, after
 * `/ping`, reproduced by `versioned: false` on the descriptor: the router
 * already knows an unversioned route is reachable bare and nowhere else, so a
 * prefixed request falls through to the unrouted `404`. A route that answers
 * "which surfaces exist" cannot sit inside one.
 *
 * `producer: "meta"` is a third producer, not the gateway, however much the
 * bytes look like it. Same `content-type`, same trailing newline, and then:
 *
 *   Cache-Control: public, max-age=600      (no must-revalidate, no stale-if-error)
 *   Expires: Date + 600
 *   (no Etag, no Last-Modified, no X-Esi-Cache-Status)
 *
 * `/meta/openapi.json` agrees. The pinned spec declares `ETag` and
 * `Last-Modified` on the `200`; CCP sends neither, and D23 says observation
 * wins. `lib/cache.js` `CACHE_POLICY` holds the row and `contract/wire.js`
 * `META` the probes.
 *
 * Nothing is injected: no runtime, config or clock. What it serves is a
 * property of the code, so it imports the constant from `lib/compatibility.js`
 * and cannot disagree with it about which surface this is.
 */

"use strict";

const { COMPATIBILITY_DATE } = require("../lib/compatibility");
const { projection } = require("../lib/serialize");

/** The wire path, canonical. Unversioned, so this is the only spelling. */
const META_COMPATIBILITY_DATES_PATH = "/meta/compatibility-dates";

/** CCP publishes 600 s (`x-cache-age`), and `contract/spec.js` asserts it. */
const CACHE_TTL_SECONDS = 600;

/** The spec's `x-rate-limit`: group `meta`, 150 tokens per 15 minutes. */
const RATE_LIMIT_GROUP = "meta";

/** The `/meta/` surface. See the file header: it is not the gateway. */
const PRODUCER = "meta";

/**
 * Every compatibility date this replica serves, newest first.
 *
 * One, and derived: `COMPATIBILITY_DATE` is the value echoed on every routed
 * response, so a separately written `"2020-01-01"` would be a second place to
 * change if D4 is revisited, and the failure would be advertising a surface not
 * served, which is worse than serving one not advertised.
 *
 * CCP orders its fourteen newest-first. With one entry the order is not
 * observable; it is stated so a second entry lands in the right place.
 */
const COMPATIBILITY_DATES = Object.freeze([COMPATIBILITY_DATE]);

/**
 * The projection. One field, and still a projection.
 *
 * `MetaCompatibilityDates` in the pinned spec is an object with one required
 * property, so this catches a handler returning the bare array, the obvious
 * mistake and a different body.
 */
const projectCompatibilityDates = projection("GetMetaCompatibilityDates", {
  compatibility_dates: (record) => record.dates,
});

/** The body. Fresh array per call, so no caller can mutate the constant. */
function buildCompatibilityDates() {
  return projectCompatibilityDates({ dates: [...COMPATIBILITY_DATES] });
}

/**
 * The route descriptor, for the table `loader.js` builds.
 *
 * No `deps`, unlike every other route factory here. It is still a factory so the
 * table reads uniformly and adding a dependency later does not change how
 * `loader.js` calls it.
 */
function createMetaCompatibilityDatesRoute() {
  return {
    method: "GET",
    path: META_COMPATIBILITY_DATES_PATH,
    name: "GetMetaCompatibilityDates",
    handler: () => buildCompatibilityDates(),
    producer: PRODUCER,
    cacheTtl: CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
    // Bare only. `/latest/meta/compatibility-dates` is the unrouted 404.
    versioned: false,
  };
}

module.exports = Object.freeze({
  CACHE_TTL_SECONDS,
  COMPATIBILITY_DATES,
  META_COMPATIBILITY_DATES_PATH,
  PRODUCER,
  RATE_LIMIT_GROUP,
  buildCompatibilityDates,
  createMetaCompatibilityDatesRoute,
  projectCompatibilityDates,
});
