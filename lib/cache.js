/**
 * eve.js-mod-esi: caching headers
 *
 * `Cache-Control`, `Expires`, `Last-Modified` and `Etag`, on every 2XX and on
 * nothing else.
 *
 * A `no-store` policy with no `Etag` would cost the game: a client that cannot
 * tell a fresh response from a stale one polls as fast as it can, and every
 * request lands on the event loop the universe ticks on (design constraint
 * 2). `market-hub-seed` sends `If-None-Match` and treats a `304` as a cache hit;
 * eve-nexum's toolbar sleeps until `Expires`.
 *
 * The cache headers split by producer, like the `content-type` and the trailing
 * newline. A single `Cache-Control` on every route would be:
 *
 *   Cache-Control: public, max-age=<ttl>, must-revalidate, stale-if-error=900
 *
 * That is the gateway's. The application sends a bare `public` with no `max-age`,
 * and the two do not measure `Expires` from the same instant:
 *
 *   gateway:  Expires = Date + ttl            a full window from now
 *   app:      Expires = Last-Modified + ttl   a window anchored to the data
 *
 * So on half the surface `Expires` is the only freshness signal a client gets,
 * and it can arrive already expired. Computing both the same way would change how
 * often every polling client comes back.
 *
 * The observations and their `curl` invocations are in `contract/wire.js`; the
 * duplication is deliberate because `contract/` is test-only and never deployed
 * (D20), and `test/cache.test.js` asserts the two agree.
 *
 * `Cache-Control` is not a function of the producer alone. An authenticated route
 * sends `private` where the same producer sends `public` on a public one.
 * Observed 2026-08-25 with a real token on `/characters/{id}/online|location|ship/`,
 * all application routes, which would otherwise have spelled bare `public`:
 *
 *   Cache-Control: private
 *   Expires: <Date + x-cache-age>   Etag: "<56 hex>"   Last-Modified: <Date>
 *   X-Esi-Cache-Status: MISS
 *
 * Little else moves: `Expires` is still measured from `Last-Modified`, the `Etag`
 * is still the application's strong SHA-224, the cache status is still there and
 * the conditional-request rules are unchanged. So this is one substitution inside
 * a producer's policy, not a fourth policy row. It is also not cosmetic: `public`
 * on a response carrying one pilot's location invites a shared cache to hand it
 * to the next pilot who asks.
 *
 * Whether a credential was required is the router's fact: `route.scope !== null`,
 * carried on the dispatch result as `authenticated` beside `producer` and
 * `cacheTtl`.
 *
 * One `Last-Modified` per sweep. `market-hub-seed` aborts an entire run when
 * `Last-Modified` differs between pages of one paginated resource, since a
 * difference is how it detects a torn read. A per-request timestamp fails that
 * immediately. `windowStart` floors the clock to the route's TTL, so every request
 * inside one window (every page of a sweep, every poll in between) gets the
 * identical `Last-Modified` and `Etag`, with no snapshot to hold and no state
 * that could disagree between pages. A sweep can still straddle a boundary; so
 * can one against real ESI, and the client's retry handles it.
 *
 * A route may supply `lastModified` per request, and a route reading a dataset
 * with a real modification time should. The floor is the default for data that
 * changes continuously.
 *
 * Etag. Computed over the bytes as they go on the wire, the only definition that
 * cannot disagree with what the client received, including the producer's
 * trailing newline. The digest and strength are the producer's too: the gateway
 * sends a weak SHA-256 and the application a strong SHA-224. 56 hex characters
 * and the `W/` prefix are both visible to a client doing `If-None-Match`.
 *
 * `Etag` is spelled `Etag`. The pinned spec calls it `ETag`; CCP does not, and
 * observation wins (D23). Header names are case-insensitive, but clients that
 * string-compare are worth matching.
 */

"use strict";

const crypto = require("node:crypto");

const { PRODUCER, serializeBody } = require("./serialize");
const { readingFor } = require("./requestClock");

// The per-producer policy

/**
 * Everything about one producer's cache headers, in one row, in the same shape as
 * `lib/serialize.js`'s `PRODUCER_WIRE`.
 *
 * `expiresFrom` names the instant the window is measured from: `"date"` is the
 * response's own `Date`, `"lastModified"` is the data's. A named basis keeps the
 * difference between producers a line of data instead of a branch someone can
 * forget.
 *
 * `authenticatedCacheControl` is the same row read for a route that required a
 * credential. `null` there is not "the same as the public one": it is a
 * combination nobody has observed, and `cacheControlFor` refuses to serve it.
 */
const CACHE_POLICY = Object.freeze({
  [PRODUCER.GATEWAY]: Object.freeze({
    cacheControl: (ttlSeconds) =>
      `public, max-age=${ttlSeconds}, must-revalidate, stale-if-error=900`,
    // Unobserved, deliberately. No gateway route on the `2020-01-01` surface requires
    // a credential, so there was no request to make, and the two guesses are both
    // plausible and incompatible: `private, max-age=…, must-revalidate,
    // stale-if-error=900` keeps this producer's shape, bare `private` matches the
    // only capture there is. Refusing is what `lib/errors.js` `characterMismatch`
    // does for the error family nobody has captured: a marked guess that reaches the
    // wire is indistinguishable from an observation.
    authenticatedCacheControl: null,
    expiresFrom: "date",
    etag: Object.freeze({ algorithm: "sha256", weak: true }),
    // Reports a server-side cache. See `sendsCacheStatus`.
    cacheStatus: true,
    // How this producer answers a conditional request. Observed, and not what RFC
    // 9110 says; see `isNotModified`.
    conditional: Object.freeze({
      star: false,
      list: false,
      weakComparison: true,
      ifModifiedSince: true,
    }),
    // What its `304` carries. The gateway drops both validators, the opposite of
    // what the RFC would suggest.
    notModified: Object.freeze({
      etag: false,
      lastModified: false,
      cacheControl: true,
      expires: true,
      vary: true,
      compatibilityDate: true,
      contentLanguage: true,
    }),
  }),
  [PRODUCER.APP]: Object.freeze({
    // No `max-age`. Observed, and the reason `Expires` is load-bearing on these
    // routes.
    cacheControl: () => "public",
    // And `private` when the route required a credential: bare, with no `max-age`,
    // as its `public` has none. Observed 2026-08-25 on all three character reads;
    // `contract/wire.js` `AUTHENTICATED_CACHE_CONTROL` holds the capture and
    // `test/cache.test.js` asserts this agrees with it. It ignores the TTL because
    // this producer has no `max-age` to put one in.
    authenticatedCacheControl: () => "private",
    expiresFrom: "lastModified",
    etag: Object.freeze({ algorithm: "sha224", weak: false }),
    cacheStatus: true,
    conditional: Object.freeze({
      star: true,
      list: false,
      weakComparison: false,
      ifModifiedSince: false,
    }),
    notModified: Object.freeze({
      etag: true,
      lastModified: true,
      cacheControl: true,
      expires: true,
      vary: true,
      compatibilityDate: true,
      contentLanguage: true,
      // The paginated routes are both on this producer, and a `304` from one carries
      // the page count. A client that stores it beside the body refreshes it from here.
      xPages: true,
    }),
  }),
  /**
   * The `/meta/` surface, the producer that exists because of this row.
   *
   * `public, max-age=<ttl>` and nothing else: no `must-revalidate`, no
   * `stale-if-error`. And `etag: null`: the surface sends no validators at all, so
   * there is no digest to compute, nothing for a conditional request to match, and
   * no `304` it can produce.
   *
   *   curl -sD - https://esi.evetech.net/meta/compatibility-dates
   *   curl -sD - https://esi.evetech.net/meta/openapi.json
   *     Cache-Control: public, max-age=600
   *     Expires: Date + 600
   *     (no Etag, no Last-Modified, no X-Esi-Cache-Status)
   *
   * The pinned spec declares `ETag` and `Last-Modified` on both operations' `200`.
   * CCP sends neither (D23: observation wins).
   *
   * `conditional` and `notModified` are all-false rather than absent, so a request
   * with `If-None-Match` gets a plain `200`.
   */
  [PRODUCER.META]: Object.freeze({
    cacheControl: (ttlSeconds) => `public, max-age=${ttlSeconds}`,
    // The same refusal as the gateway's, and easier to justify: this surface says
    // which compatibility dates exist, which no credential could change. Nothing here
    // takes one, so nothing here was observed sending `private`.
    authenticatedCacheControl: null,
    // The only basis available: there is no `Last-Modified` to measure from, and
    // `Date + ttl` is what the wire shows.
    expiresFrom: "date",
    etag: null,
    // No `X-Esi-Cache-Status` either: the same absence as the validators, observed
    // in the same two responses. See `sendsCacheStatus`.
    cacheStatus: false,
    conditional: Object.freeze({
      star: false,
      list: false,
      weakComparison: false,
      ifModifiedSince: false,
    }),
    notModified: Object.freeze({
      etag: false,
      lastModified: false,
      cacheControl: false,
      expires: false,
      vary: false,
      compatibilityDate: false,
      contentLanguage: false,
      xPages: false,
    }),
  }),
});

/**
 * `X-Esi-Cache-Status`, which both producers send on every 2XX.
 *
 * It reports on a server-side cache, and CCP's is described per operation in the
 * pinned spec: `x-server-cache-mode` is `ttl-based` or `event-based`, with
 * `x-server-cache-ttl` its window. The one server-side cache this replica has is
 * the paginated snapshot store, so a request answered out of it is a `HIT` and
 * everything else is a `MISS` (D28).
 *
 * That is a worse hit rate than CCP's and it is the true one. `Last-Modified` and
 * `Etag` are still stable across a window because they are floored to it rather
 * than remembered, so a route can be answered fresh every time and still
 * revalidate to a `304`.
 *
 * The two values are a claim, not an observation: `contract/wire.js`
 * `INFRASTRUCTURE` marks them as such, beside the request that would settle them.
 */
const CACHE_STATUS = Object.freeze({
  HIT: "HIT",
  MISS: "MISS",
});

/**
 * Does this producer tell a client anything about a server-side cache?
 *
 * Both route-serving implementations do; the `/meta/` surface does not, and sends
 * no `Etag` and no `Last-Modified` either. One row decides both, because they are
 * one absence: a second list of producers in `lib/router.js` could disagree with
 * this one, and the disagreement would appear as a header on a `200` that nobody
 * was asserting.
 */
function sendsCacheStatus(producer) {
  return policyFor(producer).cacheStatus !== false;
}

/** A cache policy asked for in terms of something that is not a producer. */
class CacheError extends Error {
  constructor(message) {
    super(message);
    this.name = "CacheError";
  }
}

function policyFor(producer) {
  const policy = CACHE_POLICY[producer];
  if (policy === undefined) {
    throw new CacheError(
      `ESI mod: no cache policy for producer ${JSON.stringify(producer)}: expected one of `
        + `${Object.values(PRODUCER).join(", ")}. Which implementation answers a route decides its `
        + "Cache-Control, what Expires is measured from, and how its Etag is built.",
    );
  }
  return policy;
}

/**
 * The `Cache-Control` for one response: the producer's, or the one it sends when
 * the route required a credential.
 *
 * A function rather than two call sites reading the policy, because the choice
 * between the two forms is where a replica would quietly send `public` on a
 * pilot's location. The substitution happens once, and the unobserved case throws
 * here rather than falling back to the public form.
 *
 * Why the unobserved half throws: falling back to the gateway's
 * `public, max-age=…` on an authenticated gateway route is a guess, invisible,
 * and about the header that decides whether a shared cache may keep one pilot's
 * data. Falling back to bare `private` is a better-behaved guess but still a wire
 * fact this repository has not established. So it throws, as `lib/errors.js`
 * `characterMismatch` does for the error family nobody has captured. No gateway
 * route declares a scope today, so the cost is a `500` on a route that does not
 * exist yet, and adding one cannot be done silently. `server.js` turns the throw
 * into a logged `500`, and the message names the observation that would settle
 * it.
 *
 * A better check is at route registration, where a gateway route declaring a scope
 * would fail at boot. That belongs in `lib/router.js`'s table validation, beside
 * `assertScope`.
 */
function cacheControlFor(producer, ttlSeconds, { authenticated = false } = {}) {
  const policy = policyFor(producer);
  if (!authenticated) return policy.cacheControl(ttlSeconds);

  const form = policy.authenticatedCacheControl;
  if (!form) {
    throw new CacheError(
      `ESI mod: the ${producer} producer's Cache-Control on an authenticated route has never been `
        + "observed: only the application's has, as bare `private` on the three character reads "
        + "of 2026-08-25. See contract/wire.js AUTHENTICATED_CACHE_CONTROL, and "
        + "scripts/observe-403.js --success for the run that established it. A route that needs "
        + "this row needs the curl first: `public` here would let a shared cache hand one pilot's "
        + "response to the next.",
    );
  }
  return form(ttlSeconds);
}

// Time

/**
 * RFC 7231 IMF-fixdate, e.g. `Sat, 22 Aug 2026 10:31:35 GMT`.
 *
 * `toUTCString()` is exactly that format in every Node release. `toISOString`
 * would silently get it wrong.
 */
function httpDate(date) {
  return new Date(date).toUTCString();
}

/**
 * The start of the cache window `at` falls in, as epoch milliseconds.
 *
 * Flooring the clock to the TTL gives every request inside one window the same
 * `Last-Modified` and `Etag`, the property a paged sweep needs, without holding a
 * snapshot. Second resolution, because `Last-Modified` has no sub-second form and
 * a surviving millisecond would put two pages in different windows for reasons no
 * header could show.
 *
 * A TTL of `0` or `null` means "no window": the answer is the second `at` falls
 * in, the most stability a route with no published TTL can claim.
 */
function windowStart(at, ttlSeconds) {
  const seconds = Math.floor(new Date(at).getTime() / 1000);
  if (!Number.isFinite(seconds)) {
    throw new CacheError(`ESI mod: cannot compute a cache window from ${JSON.stringify(at)}.`);
  }
  if (!ttlSeconds || ttlSeconds <= 0) return seconds * 1000;
  return Math.floor(seconds / ttlSeconds) * ttlSeconds * 1000;
}

// Etag

/**
 * The `Etag` for these bytes under this producer.
 *
 * Over the payload as written, not the object behind it: two bodies that
 * serialize identically are the same response to a client, and key order (fixed
 * by `JSON.stringify`, not necessarily by a re-walk) is part of what was hashed.
 */
function etagFor(payload, producer) {
  const spec = policyFor(producer).etag;
  // `null` is a producer that sends no validator: the `/meta/` surface. Not an
  // omission to fill with a default: an invented `Etag` would invite an
  // `If-None-Match` that CCP never answers with a `304`.
  if (spec === null) return null;

  const { algorithm, weak } = spec;
  const digest = crypto.createHash(algorithm).update(payload).digest("hex");
  return `${weak ? "W/" : ""}"${digest}"`;
}

// The headers

/**
 * The four cache headers for one 2XX response.
 *
 * @param {object} options
 * @param {string} options.producer      which implementation is being imitated
 * @param {Buffer|string} options.payload the body exactly as it goes on the wire
 * @param {number} [options.cacheTtl]    the route's published TTL in seconds
 * @param {number|Date} [options.now]    the response's `Date`
 * @param {number|Date} [options.lastModified] when the data changed, if known
 * @param {boolean} [options.authenticated] did the route require a credential
 * @returns {object} lowercase header names, ready to merge
 *
 * A route with no TTL gets `Etag` and `Last-Modified` but no `Cache-Control` and
 * no `Expires`, because there is no window to describe. `contract/spec.js` will
 * have said so, since CCP publishes `x-cache-age` for every operation that has
 * one.
 *
 * `authenticated` changes exactly one header: not the `Etag`, not what `Expires`
 * is measured from, not the validators. That is what the 2026-08-25 capture
 * shows, and one substitution rather than a second policy row keeps it so.
 */
function cacheHeaders({
  producer,
  payload,
  cacheTtl = null,
  now = Date.now(),
  lastModified,
  authenticated = false,
  snapshot = null,
} = {}) {
  const policy = policyFor(producer);
  const ttl = Number.isFinite(cacheTtl) && cacheTtl > 0 ? cacheTtl : null;

  // The static-data routes, which are one dump and not N bodies.
  //
  // Every header here comes from the snapshot rather than from this body: a shared
  // weak validator, the dump's own modification time, and an `Expires` that is a
  // wall-clock instant rather than a window. `lib/staticSnapshot.js` has the
  // capture and the reasoning. `Cache-Control` stays the producer's, the one cache
  // header these routes agree with the rest of the application about.
  if (snapshot !== null) {
    return {
      etag: snapshot.etag,
      "last-modified": httpDate(new Date(snapshot.lastModified).getTime()),
      "cache-control": cacheControlFor(producer, ttl, { authenticated }),
      expires: httpDate(new Date(snapshot.expires).getTime()),
    };
  }

  const modifiedAt = lastModified === undefined || lastModified === null
    ? windowStart(now, ttl)
    : new Date(lastModified).getTime();

  const etag = etagFor(payload, producer);

  // A producer with no validator sends neither header: they travel together on
  // every producer observed, so one row decides both and cannot drift into a
  // `Last-Modified` with no `Etag`.
  const headers = etag === null
    ? {}
    : { etag, "last-modified": httpDate(modifiedAt) };

  if (ttl === null) {
    // A route with no published TTL makes no freshness claim, but `private` is a
    // storage directive, not a freshness one, and is as true without a window as with
    // one. Derived rather than observed: every authenticated route seen publishes an
    // `x-cache-age`, so no capture settles the pairing. Omitting it is the failure
    // this header exists to prevent, and a public route's output on this path is
    // unchanged.
    if (authenticated) headers["cache-control"] = cacheControlFor(producer, ttl, { authenticated });
    return headers;
  }

  headers["cache-control"] = cacheControlFor(producer, ttl, { authenticated });

  const basis = policy.expiresFrom === "date" ? new Date(now).getTime() : modifiedAt;
  headers.expires = httpDate(basis + ttl * 1000);

  return headers;
}

// Conditional requests

/**
 * Does this request already have the representation we were about to send?
 *
 * The two producers disagree about almost every rule. RFC 9110 section 13.1.2
 * says `If-None-Match` is a comma-separated list, that `*` matches any existing
 * representation, and that the comparison is weak (`W/"x"` and `"x"` are the same
 * validator). Neither producer implements all three, and they fail differently:
 *
 *                          gateway   application
 *   exact etag               304        304
 *   `W/"x"` vs `"x"`         304        200      weak comparison
 *   `If-None-Match: *`       200        304
 *   `"other", "ours"`        200        200      neither parses a list
 *   `If-Modified-Since`      304        200
 *
 * Reproduced as observed, in both directions. Being more correct than ESI is the
 * failure mode: a client that finds our `*` works on a gateway route writes code
 * that silently stops working against CCP, and answering `304` where ESI answers
 * `200` hands an empty body to a client that needed one.
 *
 * The exception is the static-data-backed application routes
 * (`/universe/regions/`, `/universe/types/`, the ones sharing a single etag).
 * They parse lists and compare weakly, unlike every other application route,
 * likely because of a cache in front of them. A route that carries a snapshot
 * gets the exception and every other route is untouched, so the rule is read off
 * something a route declares rather than its path. It is load-bearing here: our
 * static-data etag is weak, so a client that stores `W/"x"` and sends `"x"` back,
 * as the RFC advises, would never see a `304` without weak comparison.
 */
function isNotModified(request, { etag, lastModified }, producer, { staticData = false } = {}) {
  const policy = policyFor(producer);
  // `contract/wire.js` `CONDITIONAL_STATIC_DATA_EXCEPTION` is the survey behind
  // these two substitutions: on the static-data routes a comma-separated list
  // matches and a weak/strong flip matches, neither of which works on
  // `/incursions/` or `/markets/prices/`. Which routes those are is not guessed
  // here: a route carries a snapshot or it does not.
  const conditional = staticData
    ? { ...policy.conditional, list: true, weakComparison: true }
    : policy.conditional;
  const headers = (request && request.headers) || {};

  // A producer that sends no validator can never answer a `304`: there is nothing
  // for the client's `If-None-Match` to have come from. Stated rather than left to
  // fall out of the `false`s below, because "happens to return false" and "cannot
  // be true" are different claims.
  if (policy.etag === null) return false;

  const ifNoneMatch = headers["if-none-match"];
  if (typeof ifNoneMatch === "string" && ifNoneMatch !== "") {
    const candidate = ifNoneMatch.trim();

    if (candidate === "*") return conditional.star;

    // Neither producer splits on commas, so neither does this: a list arrives as one
    // string, matches nothing, and is a 200. That is CCP's answer.
    //
    // The static-data routes are the exception, and there the list is parsed as RFC
    // 9110 section 13.1.2 describes: split on commas, trimmed, any member matching is
    // a match. A bare comma split is safe because every etag on this surface is
    // `"<hex>"` or `W/"<hex>"`, with no comma inside.
    const candidates = conditional.list
      ? candidate.split(",").map((member) => member.trim()).filter((member) => member !== "")
      : [candidate];

    for (const member of candidates) {
      if (member === etag) return true;
      if (conditional.weakComparison && stripWeak(member) === stripWeak(etag)) return true;
    }

    // An `If-None-Match` that does not match is the end of it. RFC 9110 says a
    // present `If-None-Match` makes `If-Modified-Since` inapplicable, and both
    // producers agree.
    return false;
  }

  if (!conditional.ifModifiedSince) return false;

  const since = Date.parse(headers["if-modified-since"]);
  if (!Number.isFinite(since)) return false;

  // Second resolution on both sides: `Last-Modified` has no sub-second form, so
  // comparing a floored value against a parsed header cannot report a change no
  // header could show.
  return Math.floor(new Date(lastModified).getTime() / 1000) <= Math.floor(since / 1000);
}

/** `W/"x"` -> `"x"`. Leaves a strong validator alone. */
function stripWeak(validator) {
  return typeof validator === "string" && validator.startsWith("W/")
    ? validator.slice(2)
    : validator;
}

/**
 * The `304`, carrying what this producer carries and nothing else.
 *
 * The gateway drops both validators (no `Etag`, no `Last-Modified`), which is not
 * what the RFC would produce. The application keeps both. Its `Cache-Control`
 * looks like it collapses to bare public, but bare `public` is what that producer
 * sends on a `200` as well.
 *
 * `Expires` is recomputed rather than echoed, so it moves forward on every
 * conditional request. Observed on the gateway, where a client polling a `304`
 * every few seconds is told a fresh full window each time.
 *
 * No body, and `server.js` writes no `content-length` for a `304` because RFC 9110
 * forbids one and CCP sends none.
 *
 * This rebuilds the header set rather than subtracting from the `200`'s, because a
 * `304` carries a smaller set that differs by producer. The cost is that anything
 * not named is lost, which is what once happened to `Vary` and
 * `X-Compatibility-Date`: the router attaches both (`routedHeaders`) inside this
 * layer, and this function discarded them. Live ESI sends both on both producers.
 * They are read from `merged` rather than recomputed, which keeps the `304` and
 * the `200` telling one story: the application's `Vary` repeats `Accept-Language`
 * and the gateway's does not, and neither fact is this function's to know.
 */
function notModifiedResult(headers, producer) {
  const { notModified } = policyFor(producer);
  const out = {};

  if (notModified.etag && headers.etag) out.etag = headers.etag;
  if (notModified.lastModified && headers["last-modified"]) {
    out["last-modified"] = headers["last-modified"];
  }
  // Whatever the `200` was going to send, `private` included. A `304` on an
  // authenticated route is unobserved: the 2026-08-25 capture is three `200`s and
  // nobody re-fetched one with an `If-None-Match`. Carrying it forward is the
  // consistent and only safe option: the application's `304` sends the same
  // `Cache-Control` as its `200` on every public route observed, and a `304` that
  // dropped `private` would let a shared cache refresh a stored private response
  // into a public one (RFC 9110 has a `304` update the stored headers). The value
  // is read from the `200`'s headers rather than recomputed.
  if (notModified.cacheControl && headers["cache-control"]) {
    out["cache-control"] = headers["cache-control"];
  }
  if (notModified.expires && headers.expires) out.expires = headers.expires;
  // The router's four, each of which was lost here once. A `Vary` that disappears
  // on a `304` is a cache-poisoning bug: a cache that refreshes from ours loses the
  // variance key. `X-Pages` is the same loss one field along: a client that keeps
  // the page count beside the body refreshes it from here, and a sweep that read an
  // absent header as "one page" would stop after the first.
  if (notModified.vary && headers.vary) out.vary = headers.vary;
  if (notModified.compatibilityDate && headers["x-compatibility-date"]) {
    out["x-compatibility-date"] = headers["x-compatibility-date"];
  }
  if (notModified.contentLanguage && headers["content-language"]) {
    out["content-language"] = headers["content-language"];
  }
  if (notModified.xPages && headers["x-pages"]) out["x-pages"] = headers["x-pages"];

  // Carried, not written: `producer` decides whether the application's
  // `X-Esi-Request-Id` gets stamped on the way out (`lib/requestId.js`), and a
  // `304` is a response the application produced like any other. Every header it
  // sends is named above; this is not one.
  return { status: 304, headers: out, producer };
}

// The layer

/**
 * Add the cache headers to every 2XX with a JSON body, and to nothing else.
 *
 * Composed as `lib/cors.js` is, and inside it: a `304` is decided from the
 * validators this layer computes, so whatever adds the CORS headers has to sit
 * outside whatever computes the `Etag`.
 *
 * The payload comes back on the result. An `Etag` digests the bytes, so this layer
 * serializes the body, and `server.js` would serialize it a second time to write
 * it: two full passes over an 8000-element array on the event loop the universe
 * ticks on. The bytes ride on `result.payload` and `sendResult` writes those. The
 * coupling is one documented field.
 *
 * Left alone: a refusal, a bodiless response, and a verbatim string or Buffer
 * body. CCP sends no cache headers on a `401`, a `422` or `GET /ping`, so neither
 * does this. A result that set a cache header itself keeps it: `/_mod/health` is
 * `no-store` because a cached health response is a wrong answer, not stale data,
 * and it is dispatched outside this layer anyway.
 */
function createCacheDispatch(next, { now = () => Date.now() } = {}) {
  if (typeof next !== "function") {
    throw new CacheError("ESI mod: createCacheDispatch needs a dispatch function to wrap.");
  }

  return async function cacheDispatch(request) {
    const result = await next(request);

    if (!result || typeof result !== "object") return result;
    if (result.status < 200 || result.status >= 300) return result;
    // A bodiless 2XX, or bytes whose shape is already decided (`/ping`, and Go's
    // plain-text bodies). Nothing to digest and nothing CCP would describe.
    if (result.body === undefined || result.body === null) return result;
    if (typeof result.body === "string" || Buffer.isBuffer(result.body)) return result;
    // A dispatch that is not the router (a test double, a future layer) has no
    // producer to build a policy from. Passing it through unchanged is better than
    // inventing one.
    if (!CACHE_POLICY[result.producer]) return result;

    const payload = serializeBody(result.body, result.producer);
    const headers = cacheHeaders({
      producer: result.producer,
      payload,
      cacheTtl: result.cacheTtl,
      // The request's reading, not a fresh one. This runs after `await next(request)`,
      // so a fresh `now()` here would floor `Last-Modified` to a window the handler may
      // already have crossed while the body came from the window chosen before it ran.
      // Two pages of one sweep could then share a `Last-Modified` and disagree about
      // their contents, the torn read that header exists to reveal. One reading per
      // request makes a second one impossible to write.
      now: readingFor(request, now),
      lastModified: result.lastModified,
      // The router's answer to "did this route require a credential", carried on the
      // result beside `producer` and `cacheTtl`. Compared against `true` rather than
      // trusted for truthiness: a dispatch that is not the router sends no such field,
      // and `undefined` there has to mean the public form.
      authenticated: result.authenticated === true,
      // The static-data snapshot, when the route carries one. `null` on every other
      // route, which keeps this one branch rather than a second policy row: a snapshot
      // route agrees with its producer about `Cache-Control` and disagrees about the
      // three headers that describe this body rather than the dump behind it.
      snapshot: result.snapshot || null,
    });

    // The result's own headers win, the same rule `lib/cors.js` follows.
    const merged = { ...headers, ...(result.headers || {}) };

    // Decided here because this is where the validators exist, and decided before
    // the CORS layer sees the result: a 304 carries the CORS headers like any other
    // response, which is why that layer wraps this one.
    //
    // The body is dropped rather than left for `server.js` to skip: a 304 with a body
    // attached would put bytes on the wire the moment anything downstream stopped
    // checking the status.
    if (isNotModified(
      request,
      { etag: merged.etag, lastModified: merged["last-modified"] },
      result.producer,
      { staticData: result.snapshot != null },
    )) {
      return notModifiedResult(merged, result.producer);
    }

    return { ...result, payload, headers: merged };
  };
}

module.exports = {
  CACHE_POLICY,
  CACHE_STATUS,
  CacheError,
  cacheControlFor,
  cacheHeaders,
  createCacheDispatch,
  etagFor,
  httpDate,
  isNotModified,
  notModifiedResult,
  policyFor,
  sendsCacheStatus,
  stripWeak,
  windowStart,
};
