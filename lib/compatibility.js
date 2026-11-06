/**
 * eve.js-mod-esi: `X-Compatibility-Date`
 *
 * The header on every routed ESI response. `market-hub-seed` keys its cache on
 * `SHA-256(compatibilityDate + url)`, so a replica that never says which
 * surface answered leaves that client hashing `undefined` into every key.
 *
 * D11 assumed the header is ignored. It is validated. The echo is always
 * `2020-01-01` on `/latest/`, but three classes of value are refused before
 * anything routes:
 *
 *   X-Compatibility-Date: nope        400  Invalid compatibility date format. Expected YYYY-MM-DD.
 *   X-Compatibility-Date: 2019-12-31  400  Compatibility date (…) is before the oldest supported date: 2020-01-01.
 *   X-Compatibility-Date: 2026-08-24  400  Compatibility date (…) is in the future. Current date (UTC-11) is …
 *
 * All three are `EDGE` refusals: bare `application/json`, `nosniff`, and a
 * two-line `Vary` with no echo, because the answer cannot depend on a
 * compatibility date when the request was refused for having a bad one.
 *
 * They carry CORS headers, unlike `Invalid tenant`:
 *
 *   curl -sD - -H "X-Compatibility-Date: nope" .../latest/status/
 *   curl -sD - ".../latest/status/?datasource=nope"
 *     Access-Control-Allow-Origin: *
 *     Access-Control-Expose-Headers: Etag, Retry-After, …
 *
 * This matches `contract/wire.js` `SENDS_CORS[GATEWAY_ERROR] = true`, so the
 * layer sits inside `lib/cors.js`. A browser tool sending a malformed date must
 * see a readable `400`, not an opaque network error.
 *
 * They also carry `X-Esi-Error-Limit-Remain`/`-Reset` and spend a unit, even on
 * a route the token bucket owns: `/latest/status/` publishes the group `status`,
 * and a bad date on it comes back on the error limiter because the request never
 * reached the route that owns the bucket. So this layer sits inside both
 * limiters, and `loader.js` asks `groupFor` about the request rather than the
 * path alone.
 *
 * `2026-13-01` and `2026-02-30` are format errors, not range errors: the value
 * must be a real calendar date spelled `YYYY-MM-DD`. An empty header is accepted
 * and treated as absent.
 *
 * There are two ways to ask, and the query one wins. `?compatibility_date=` is
 * validated identically, with the same three messages, and beats the header
 * rather than filling in for it:
 *
 *   -H "X-Compatibility-Date: nope"  ?compatibility_date=2020-01-01  ->  200
 *   -H "X-Compatibility-Date: 2020-01-01"  ?compatibility_date=nope  ->  400
 *
 * A replica reading only the header would serve the first as a `200` for the
 * wrong reason and refuse nothing CCP refuses on the second. See
 * `requestedCompatibilityDate`.
 *
 * Today is in UTC-11. A date is in the future only once it is past today in the
 * most westerly zone. CCP puts the offset in the message. Comparing against UTC
 * would refuse a date for up to eleven hours after CCP started accepting it.
 *
 * Not reproduced: a valid in-range date selects a surface, and the header beats
 * the path prefix:
 *
 *   GET /latest/sovereignty/map/  X-Compatibility-Date: 2026-08-01
 *     404 {"error":"Page not found"}
 *
 * because `/sovereignty/map` does not exist on the modern surface (the fact that
 * made pinning the default spec fetch correct, D22). That needs a date-versioned
 * route table, and D4 scoped this replica to the `2020-01-01` surface alone. An
 * in-range date is served from that surface and echoed as `2020-01-01`, which is
 * what CCP does for every route that exists on both.
 */

"use strict";

const { edgeRefusal } = require("./errors");

/** The surface this replica serves, and the value it echoes (D4). */
const COMPATIBILITY_DATE = "2020-01-01";

/** Nothing older is a compatibility date at all. */
const OLDEST_SUPPORTED = "2020-01-01";

/**
 * The zone "today" is evaluated in, and the one CCP names in its message.
 *
 * Eleven hours west of UTC, so a date becomes acceptable eleven hours later than
 * a UTC comparison would allow.
 */
const TODAY_OFFSET_HOURS = -11;

/** Exactly `YYYY-MM-DD`. A shorter month or a stray suffix is a format error. */
const DATE_SPELLING = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The header spelling. Lowercase, because that is how Node hands headers over. */
const COMPATIBILITY_DATE_HEADER = "x-compatibility-date";

/**
 * The query spelling, recorded in D11.
 *
 * Validated exactly as the header is (same three refusals, same messages), and
 * it beats the header. A replica reading only the header would answer `200` to a
 * request CCP refuses.
 */
const COMPATIBILITY_DATE_QUERY = "compatibility_date";

const ERRORS = Object.freeze({
  badFormat: "Invalid compatibility date format. Expected YYYY-MM-DD.",
  tooOld: (value) =>
    `Compatibility date (${value}) is before the oldest supported date: ${OLDEST_SUPPORTED}.`,
  inFuture: (value, today) =>
    `Compatibility date (${value}) is in the future. Current date (UTC-11) is ${today}.`,
});

// Reading the header

/**
 * `YYYY-MM-DD` in CCP's zone, for `now`.
 *
 * Shifting the instant and then reading the UTC date: no local time is involved,
 * so the result does not depend on where the game server runs.
 */
function todayAt(now, offsetHours = TODAY_OFFSET_HOURS) {
  return new Date(new Date(now).getTime() + offsetHours * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Is this a real calendar date spelled `YYYY-MM-DD`?
 *
 * The round-trip rejects `2026-02-30`: `Date.UTC` rolls it forward to March 2nd,
 * which no longer matches the input. A month range check alone would let it
 * through, and CCP calls it a format error.
 */
function isCalendarDate(value) {
  const match = DATE_SPELLING.exec(value);
  if (!match) return false;

  const [, year, month, day] = match;
  const stamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return new Date(stamp).toISOString().slice(0, 10) === value;
}

/**
 * The value this request asked for, or `null` for "no opinion".
 *
 * `?compatibility_date=` wins outright; it does not merely fill in for an absent
 * header:
 *
 *   -H "X-Compatibility-Date: nope"  ?compatibility_date=2020-01-01  ->  200
 *   -H "X-Compatibility-Date: 2020-01-01"  ?compatibility_date=nope  ->  400
 *
 * "Validate whichever is present" and "validate both" differ only on those two
 * rows, by a status code. An empty value on either side is absent, so an empty
 * query parameter falls through to the header rather than shadowing it:
 *
 *   -H "X-Compatibility-Date: nope"  ?compatibility_date=  ->  400, from the header
 *
 * Same precedence and empty-is-absent rule as `lib/tenant.js`.
 */
function requestedCompatibilityDate(request) {
  const query = (request && request.query) || {};
  const headers = (request && request.headers) || {};

  const fromQuery = query[COMPATIBILITY_DATE_QUERY];
  if (fromQuery !== undefined && fromQuery !== null && fromQuery !== "") {
    return String(fromQuery);
  }

  const fromHeader = headers[COMPATIBILITY_DATE_HEADER];
  if (fromHeader !== undefined && fromHeader !== null && fromHeader !== "") {
    return String(fromHeader);
  }

  return null;
}

/**
 * `{ date }` for a date this replica will serve, or `{ refusal }` carrying the
 * `400` CCP would have sent.
 *
 * Takes the whole request (`{ headers, query }`) because the client may ask
 * either way and the query parameter wins; see `requestedCompatibilityDate`.
 *
 * An absent or empty value is `{ date: null }`. A valid in-range date is also
 * served, and is not returned as a surface to use: see the file header.
 */
function readCompatibilityDate(request, { now = Date.now() } = {}) {
  const value = requestedCompatibilityDate(request);
  if (value === null) return { date: null };

  if (!isCalendarDate(value)) {
    return { refusal: edgeRefusal(400, ERRORS.badFormat) };
  }
  if (value < OLDEST_SUPPORTED) {
    return { refusal: edgeRefusal(400, ERRORS.tooOld(value)) };
  }

  const today = todayAt(now);
  if (value > today) {
    return { refusal: edgeRefusal(400, ERRORS.inFuture(value, today)) };
  }

  return { date: value };
}

// Vary

/**
 * `Vary`, per producer, in CCP's order and multiplicity.
 *
 * Sent as repeated header lines, never comma-joined: a folded form is a
 * different string to anything keying a cache on it. `server.js` writes an array
 * as repeated lines.
 *
 * The two producers agree; the table stays per-producer because every other
 * header on this surface splits by producer.
 */
const VARY_ROUTED = Object.freeze({
  gateway: Object.freeze(["X-Tenant", "Accept-Language", "X-Compatibility-Date"]),
  app: Object.freeze(["X-Tenant", "Accept-Language", "X-Compatibility-Date"]),
});

/**
 * The fourth line, for a route whose body carries translated text.
 *
 * `Accept-Language` again: the same header name twice, which is what CCP sends.
 * It is a property of the route, not of the producer or the status:
 * `/universe/regions/{id}/` repeats it on a `404` and `/markets/{region}/orders/`
 * does not repeat it on a `200`. Surveyed across eighteen routes; the survey and
 * the rule that predicts it are in `contract/wire.js` `VARY_LOCALIZED_BODY`.
 *
 * A route declares `localizedBody: true` and `lib/router.js` appends this.
 * Nothing served today declares it (`/status/`, `/markets/prices/` and
 * `/markets/{region}/orders/` send numbers and ids), so it exists for the
 * universe endpoints, which carry names.
 *
 * A `Vary` value CCP does not send widens the cache key: a shared cache
 * fragments on a header CCP's does not, costing hit rate silently.
 */
const VARY_LOCALIZED_EXTRA = "Accept-Language";

/**
 * `Vary` for a request that reached routing and found nothing: the unrouted
 * `404` and the `405`.
 *
 * Still three lines: routing happened, so the answer depends on the
 * compatibility date even though no route produced it.
 */
const VARY_UNROUTED = Object.freeze(["X-Tenant", "Accept-Language", "X-Compatibility-Date"]);

/**
 * `Vary` on a refusal made before routing.
 *
 * Two lines, not three: the answer cannot depend on a compatibility date when
 * the request was rejected for having a bad one. Observed on exactly this
 * refusal; `Invalid tenant` carries no `Vary` at all.
 */
const VARY_EDGE = Object.freeze(["X-Tenant", "Accept-Language"]);

// The layer

/**
 * Refuse a compatibility date this replica will not serve, and pass everything
 * else through untouched.
 *
 * Composed inside `lib/cors.js` and inside both limiters, because these refusals
 * carry the CORS pair and the error-limit pair (see the file header). It stays
 * outside `lib/cache.js` and the router, because it refuses before anything
 * routes.
 *
 * The echo and the routed `Vary` are not added here. They belong to responses a
 * route produced; the router attaches them, which also makes the `405` and the
 * unrouted `404` come out right without a special case.
 *
 * `lib/tenant.js` sits in front of this layer. A request wrong about both gets
 * `Invalid tenant`, not a date refusal; that ordering is observed, not chosen.
 */
function createCompatibilityDispatch(next, { now = () => Date.now() } = {}) {
  if (typeof next !== "function") {
    throw new TypeError("ESI mod: createCompatibilityDispatch needs a dispatch function to wrap.");
  }

  return async function compatibilityDispatch(request) {
    const { refusal } = readCompatibilityDate(request, { now: now() });
    if (refusal) return { ...refusal, headers: { ...refusal.headers, vary: [...VARY_EDGE] } };

    return next(request);
  };
}

module.exports = {
  COMPATIBILITY_DATE,
  COMPATIBILITY_DATE_HEADER,
  COMPATIBILITY_DATE_QUERY,
  DATE_SPELLING,
  ERRORS,
  OLDEST_SUPPORTED,
  TODAY_OFFSET_HOURS,
  VARY_EDGE,
  VARY_LOCALIZED_EXTRA,
  VARY_ROUTED,
  VARY_UNROUTED,
  createCompatibilityDispatch,
  isCalendarDate,
  readCompatibilityDate,
  requestedCompatibilityDate,
  todayAt,
};
