/**
 * `lib/cache.js`: do the four cache headers say what CCP's say?
 *
 * Run with: node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * The acceptance is two claims:
 *
 *   - Every implemented route carries all four headers. Enumerated at the
 *     bottom of this file against the real route table.
 *   - A paged sweep returns one consistent `Last-Modified`. `market-hub-seed`
 *     aborts an entire run when it differs between pages, so this is a hard
 *     constraint. It is met structurally: the clock is floored to the route's
 *     TTL, so every request in a window agrees without any snapshot being
 *     held.
 *
 * The producer split applies here as it does to content-type and error
 * bodies. The gateway sends `public, max-age=<ttl>, must-revalidate,
 * stale-if-error=900` and measures `Expires` from `Date`; the application
 * sends a bare `public` with no `max-age` and measures `Expires` from
 * `Last-Modified`. It is a property of which implementation answers the route.
 *
 * Everything asserted here about CCP comes from `contract/wire.js`.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const { startServer, closeServer } = require(path.join(__dirname, "../server"));
const { PRODUCER, serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const { createCorsDispatch } = require(path.join(__dirname, "../lib/cors"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const {
  CACHE_POLICY,
  CACHE_STATUS,
  CacheError,
  cacheControlFor,
  cacheHeaders,
  createCacheDispatch,
  etagFor,
  httpDate,
  policyFor,
  windowStart,
} = require(path.join(__dirname, "../lib/cache"));

/** A fixed instant, so every expectation below is arithmetic. */
const NOW = Date.parse("2026-08-22T10:31:35Z");

const seconds = (n) => n * 1000;

/** The layer under test, over a table, with a clock that does not move. */
function cached(routes, { now = () => NOW } = {}) {
  const router = createRouter(routes);
  return createCacheDispatch((request) => dispatchRequest(router, request, { logError: () => {} }), { now });
}

/** A route that answers `body` and nothing else. */
function route({ producer = PRODUCER.GATEWAY, cacheTtl = 30, body = { players: 1 } } = {}) {
  return {
    method: "GET",
    path: "/status",
    name: "GetStatus",
    handler: () => body,
    producer,
    cacheTtl,
  };
}

// The policy is the observed one

test("both producers' Cache-Control is the one that was observed", () => {
  // lib/ cannot import contract/ (test-only, never deployed, D20), so the
  // values are duplicated and this test checks that they agree.
  for (const ttl of [30, 300, 3600]) {
    assert.equal(
      policyFor(PRODUCER.GATEWAY).cacheControl(ttl),
      wire.CACHE_CONTROL[wire.KIND.GATEWAY_SUCCESS](ttl),
    );
    assert.equal(
      policyFor(PRODUCER.APP).cacheControl(ttl),
      wire.CACHE_CONTROL[wire.KIND.APP_SUCCESS](ttl),
    );
  }

  assert.equal(
    policyFor(PRODUCER.GATEWAY).cacheControl(30),
    "public, max-age=30, must-revalidate, stale-if-error=900",
  );
  assert.equal(policyFor(PRODUCER.APP).cacheControl(30), "public", "no max-age at all, observed");
});

test("the application really does send no max-age, which is why Expires matters", () => {
  // The half of the surface where a client has nothing else to sleep on. If
  // this ever carries max-age, `Expires` stops being load-bearing and the
  // comment in lib/cache.js explaining why should go with it.
  assert.doesNotMatch(policyFor(PRODUCER.APP).cacheControl(3600), /max-age/);
  assert.match(policyFor(PRODUCER.GATEWAY).cacheControl(3600), /max-age=3600/);
});

test("Expires is measured from a different instant per producer", () => {
  assert.equal(policyFor(PRODUCER.GATEWAY).expiresFrom, wire.EXPIRES_BASIS[wire.KIND.GATEWAY_SUCCESS]);
  assert.equal(policyFor(PRODUCER.APP).expiresFrom, wire.EXPIRES_BASIS[wire.KIND.APP_SUCCESS]);
  assert.equal(policyFor(PRODUCER.GATEWAY).expiresFrom, "date");
  assert.equal(policyFor(PRODUCER.APP).expiresFrom, "lastModified");
});

test("the etag digest and strength are the producer's", () => {
  for (const [producer, kind] of [
    [PRODUCER.GATEWAY, wire.KIND.GATEWAY_SUCCESS],
    [PRODUCER.APP, wire.KIND.APP_SUCCESS],
  ]) {
    assert.deepEqual({ ...policyFor(producer).etag }, { ...wire.ETAG[kind] });
  }

  // 64 hex is SHA-256, 56 is SHA-224. 56 is not a length anyone picks by
  // accident, so it is reproduced rather than rounded to the obvious.
  const gateway = etagFor(Buffer.from("{}"), PRODUCER.GATEWAY);
  const app = etagFor(Buffer.from("{}"), PRODUCER.APP);

  assert.match(gateway, /^W\/"[0-9a-f]{64}"$/, "weak, SHA-256");
  assert.match(app, /^"[0-9a-f]{56}"$/, "strong, SHA-224");
});

test("the etag is a digest of the bytes that go on the wire", () => {
  // Not of the object behind them. The producer's trailing newline is part of
  // what the client received, so it is part of what was hashed: the same body
  // under the two producers is two different responses and two different etags.
  const body = { players: 1 };
  const gatewayBytes = serializeBody(body, PRODUCER.GATEWAY);
  const appBytes = serializeBody(body, PRODUCER.APP);

  assert.equal(
    etagFor(gatewayBytes, PRODUCER.GATEWAY),
    `W/"${crypto.createHash("sha256").update(gatewayBytes).digest("hex")}"`,
  );
  assert.notEqual(gatewayBytes.length, appBytes.length, "the newline is the difference");
});

test("a producer nobody has a policy for is a throw, not a guess", () => {
  assert.throws(() => policyFor("go"), CacheError);
  assert.throws(() => cacheHeaders({ producer: undefined, payload: Buffer.from("{}") }), CacheError);
});

// Authenticated routes send `private`

/** The scope the three character reads were captured with. */
const SCOPE = "esi-location.read_location.v1";
/** CCP's `CharacterID` example. A fixture wants a number, not a pilot. */
const CHARACTER_ID = 90000001;

/**
 * A route that requires a credential, and one that does not, on the producer
 * the observation was taken on.
 */
function securedRoute({ cacheTtl = 5 } = {}) {
  return {
    method: "GET",
    path: "/characters/:character_id/online",
    name: "GetCharactersCharacterIdOnline",
    scope: SCOPE,
    producer: PRODUCER.APP,
    cacheTtl,
    handler: () => ({ last_logout: "2026-08-16T12:28:43Z", online: false }),
  };
}

/**
 * A verified credential, hand-built.
 *
 * `lib/bearerCredential.js` makes the real one and is not under test here. This
 * file needs a request the router lets through to a secured route, so that the
 * `authenticated` flag on the result is the router's own and not a value this
 * test wrote.
 */
function asCharacter(id = CHARACTER_ID) {
  return { presented: true, claims: { characterId: id, scopes: [SCOPE] } };
}

test("an authenticated route's Cache-Control is `private`, and it is the observed one", () => {
  // The same duplication rule as the two public forms above: lib/ cannot import
  // contract/ (D20), so this test checks the copy against the capture.
  assert.equal(
    cacheControlFor(PRODUCER.APP, 5, { authenticated: true }),
    wire.AUTHENTICATED_CACHE_CONTROL,
  );
  assert.equal(cacheControlFor(PRODUCER.APP, 5, { authenticated: true }), "private");

  // Bare, on every TTL: no `max-age`, as this producer's `public` has none. If
  // that changes, `Expires` stops being the only freshness signal on the
  // authenticated half too.
  for (const ttl of [5, 30, 300, 3600]) {
    assert.equal(cacheControlFor(PRODUCER.APP, ttl, { authenticated: true }), "private");
  }
});

test("a public route on the same producer still sends bare `public`", () => {
  // The substitution is per response, not per producer, and `/markets/prices/`
  // is on the same implementation as the three character reads. Easy to break.
  assert.equal(cacheControlFor(PRODUCER.APP, 300), wire.CACHE_CONTROL[wire.KIND.APP_SUCCESS](300));
  assert.equal(cacheControlFor(PRODUCER.APP, 300), "public");
  assert.equal(cacheControlFor(PRODUCER.APP, 300, { authenticated: false }), "public");
});

test("a public gateway route still sends its full form, max-age and all", () => {
  assert.equal(
    cacheControlFor(PRODUCER.GATEWAY, 30),
    wire.CACHE_CONTROL[wire.KIND.GATEWAY_SUCCESS](30),
  );
  assert.equal(
    cacheControlFor(PRODUCER.GATEWAY, 30),
    "public, max-age=30, must-revalidate, stale-if-error=900",
  );
});

test("an authenticated gateway route throws, because nobody has ever seen one", () => {
  // No gateway route on the 2020-01-01 surface requires a credential, so there
  // was no request to make. The two candidate forms (this producer's shape with
  // `private` substituted, or the bare `private` the application sends) are
  // both guesses about the one header that decides whether a shared cache may
  // keep a pilot's data. Same refusal as lib/errors.js `characterMismatch`.
  assert.throws(() => cacheControlFor(PRODUCER.GATEWAY, 30, { authenticated: true }), CacheError);
  assert.throws(() => cacheControlFor(PRODUCER.META, 600, { authenticated: true }), CacheError);
  assert.throws(
    () => cacheHeaders({ producer: PRODUCER.GATEWAY, payload: Buffer.from("{}"), cacheTtl: 30, now: NOW, authenticated: true }),
    /never been observed/,
  );

  // The refusal is a row in the table rather than a special case in the code:
  // the producer whose form was observed has one, the two that were not hold
  // `null`.
  assert.equal(CACHE_POLICY[PRODUCER.GATEWAY].authenticatedCacheControl, null);
  assert.equal(CACHE_POLICY[PRODUCER.META].authenticatedCacheControl, null);
  assert.equal(typeof CACHE_POLICY[PRODUCER.APP].authenticatedCacheControl, "function");
});

test("only Cache-Control moves: everything else is still the producer's", () => {
  // The claim the capture supports. `/characters/{id}/online/` came back with
  // `Expires: <Date + x-cache-age>`, a strong 56-hex `Etag` and a
  // `Last-Modified`, which is the application's policy unchanged. So the two
  // header sets must differ in exactly one key.
  const shared = {
    producer: PRODUCER.APP,
    payload: Buffer.from('{"online":false}'),
    cacheTtl: 5,
    now: NOW,
    lastModified: NOW,
  };

  const open = cacheHeaders(shared);
  const secured = cacheHeaders({ ...shared, authenticated: true });

  assert.equal(open["cache-control"], "public");
  assert.equal(secured["cache-control"], wire.AUTHENTICATED_CACHE_CONTROL);

  assert.deepEqual(Object.keys(secured).sort(), Object.keys(open).sort());
  for (const header of ["etag", "last-modified", "expires"]) {
    assert.equal(secured[header], open[header], `${header} changed, and only Cache-Control may`);
  }
  assert.match(secured.etag, /^"[0-9a-f]{56}"$/, "still the strong sha224");
  assert.equal(secured.expires, httpDate(NOW + seconds(5)), "still measured from Last-Modified");
});

test("an authenticated route with no published TTL still refuses to be shared", () => {
  // Derived, not observed: every authenticated route captured publishes an
  // `x-cache-age`, so no request settles this pairing. `private` is a storage
  // directive rather than a freshness claim, true with or without a window, and
  // leaving it off is the one failure the header exists to prevent. The public
  // route's output on this path is untouched.
  const secured = cacheHeaders({
    producer: PRODUCER.APP, payload: Buffer.from("{}"), cacheTtl: null, now: NOW, authenticated: true,
  });
  const open = cacheHeaders({
    producer: PRODUCER.APP, payload: Buffer.from("{}"), cacheTtl: null, now: NOW,
  });

  assert.equal(secured["cache-control"], "private");
  assert.equal(secured.expires, undefined, "still no freshness claim it cannot make");
  assert.equal(open["cache-control"], undefined, "and a public route is exactly as it was");
});

test("the flag is the router's, and it reaches the header on a real dispatch", async () => {
  const dispatch = cached([securedRoute(), route({ producer: PRODUCER.APP, cacheTtl: 300 })]);

  const secured = await dispatch({
    method: "GET",
    pathname: `/latest/characters/${CHARACTER_ID}/online/`,
    query: {},
    headers: {},
    credential: asCharacter(),
  });
  const open = await dispatch({ method: "GET", pathname: "/latest/status/", query: {}, headers: {} });

  assert.equal(secured.status, 200);
  assert.equal(secured.headers["cache-control"], wire.AUTHENTICATED_CACHE_CONTROL);
  assert.equal(secured.headers["x-esi-cache-status"], CACHE_STATUS.MISS, "and the rest is unchanged");
  assert.match(secured.headers.etag, /^"[0-9a-f]{56}"$/);

  assert.equal(open.status, 200);
  assert.equal(open.headers["cache-control"], "public", "the same producer, one route over");
});

test("a result with no `authenticated` field is public, not an accident", async () => {
  // A dispatch that is not the router sends no such field. `undefined` has to
  // read as the public form, or a layer starts sending `private` the day
  // somebody forgets to carry the flag.
  const dispatch = createCacheDispatch(
    () => ({ status: 200, body: { a: 1 }, producer: PRODUCER.APP, cacheTtl: 300 }),
    { now: () => NOW },
  );

  const result = await dispatch({ method: "GET", pathname: "/x" });

  assert.equal(result.headers["cache-control"], "public");
});

test("an authenticated 304 carries `private` too", async () => {
  // Unobserved: the 2026-08-25 capture is three `200`s, and nobody re-fetched
  // one with an `If-None-Match`. Carried forward because the application's `304`
  // sends the same `Cache-Control` as its `200` on every public route that was
  // observed, and because a `304` that dropped it would let a cache refresh a
  // stored private response into a public one (RFC 9110 has a `304` update the
  // stored headers, which is how the `Vary` bug worked).
  const dispatch = cached([securedRoute()]);
  const as = () => ({
    method: "GET",
    pathname: `/latest/characters/${CHARACTER_ID}/online/`,
    query: {},
    credential: asCharacter(),
  });

  const first = await dispatch({ ...as(), headers: {} });
  const again = await dispatch({ ...as(), headers: { "if-none-match": first.headers.etag } });

  assert.equal(again.status, 304);
  assert.equal(again.headers["cache-control"], wire.AUTHENTICATED_CACHE_CONTROL);
  // The producer's own `304` rules are untouched: the application keeps both
  // validators where the gateway drops them.
  assert.equal(again.headers.etag, first.headers.etag);
  assert.equal(again.headers["last-modified"], first.headers["last-modified"]);
  assert.equal(wire.NOT_MODIFIED_SENDS[wire.KIND.APP_SUCCESS].cacheControl, true);
});

// The arithmetic

test("a gateway response promises a full window from now", () => {
  // Observed: date 10:31:35, expires 10:32:05, max-age 30.
  const headers = cacheHeaders({
    producer: PRODUCER.GATEWAY,
    payload: Buffer.from("{}"),
    cacheTtl: 30,
    now: NOW,
  });

  assert.equal(headers.expires, httpDate(NOW + seconds(30)));
  assert.equal(headers["cache-control"], "public, max-age=30, must-revalidate, stale-if-error=900");
});

test("an application response's window is anchored to the data, and can arrive expired", () => {
  // Observed: /incursions/ last-modified 10:30:16, expires 10:35:16, ttl 300,
  // measured from the data, not from the response. A client fetching it at
  // 10:36 gets an Expires already in the past, which is CCP's behaviour.
  const lastModified = Date.parse("2026-08-22T10:30:16Z");
  const headers = cacheHeaders({
    producer: PRODUCER.APP,
    payload: Buffer.from("{}"),
    cacheTtl: 300,
    now: NOW,
    lastModified,
  });

  assert.equal(headers["last-modified"], httpDate(lastModified));
  assert.equal(headers.expires, httpDate(lastModified + seconds(300)));
  assert.notEqual(headers.expires, httpDate(NOW + seconds(300)), "not measured from now");
});

test("the dates are IMF-fixdate, which is the one format HTTP will not forgive", () => {
  // `toISOString()` is the obvious thing to reach for and is wrong here.
  assert.equal(httpDate(NOW), "Sat, 22 Aug 2026 10:31:35 GMT");
  assert.match(
    cacheHeaders({ producer: PRODUCER.GATEWAY, payload: Buffer.from("{}"), cacheTtl: 30, now: NOW }).expires,
    /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
  );
});

test("a route with no published TTL gets validators but no freshness claim", () => {
  // Etag and Last-Modified are still true; max-age and Expires would be
  // inventions. contract/spec.js publishes x-cache-age for every operation that
  // has one, so a null TTL is a route with its homework undone.
  const headers = cacheHeaders({ producer: PRODUCER.GATEWAY, payload: Buffer.from("{}"), cacheTtl: null, now: NOW });

  assert.ok(headers.etag);
  assert.ok(headers["last-modified"]);
  assert.equal(headers["cache-control"], undefined);
  assert.equal(headers.expires, undefined);
});

// The hard constraint: one Last-Modified per sweep

test("every instant inside one window floors to the same Last-Modified", () => {
  // The property market-hub-seed's torn-read detection depends on, obtained
  // without holding a snapshot: page 1 and page 40 of a sweep are seconds apart,
  // and seconds apart inside a 3600 s window is the same window.
  const base = Date.parse("2026-08-22T10:00:00Z");

  for (const offset of [0, 1, 59, 600, 3599]) {
    assert.equal(
      windowStart(base + seconds(offset), 3600),
      base,
      `${offset}s into the window did not floor to its start`,
    );
  }

  assert.equal(windowStart(base + seconds(3600), 3600), base + seconds(3600), "and the next one is next");
});

test("a paged sweep sees one Last-Modified and one Etag across every page", async () => {
  // The acceptance criterion as a sweep rather than arithmetic: forty pages
  // fetched over a simulated minute, all inside one 3600 s window.
  let clock = Date.parse("2026-08-22T10:00:00Z");
  const pages = [];

  const dispatch = cached(
    [{ ...route({ cacheTtl: 3600 }), path: "/wars", handler: (params) => [Number(params.query.page || 1)] }],
    { now: () => clock },
  );

  for (let page = 1; page <= 40; page += 1) {
    // Each page a second and a half later, as a real sweep would be.
    clock += 1500;
    pages.push(await dispatch({ method: "GET", pathname: "/latest/wars/", query: { page: String(page) } }));
  }

  const lastModified = new Set(pages.map((p) => p.headers["last-modified"]));
  assert.equal(lastModified.size, 1, `a sweep saw ${lastModified.size} Last-Modified values: ${[...lastModified]}`);
  assert.equal(new Set(pages.map((p) => p.headers["cache-control"])).size, 1);

  // The bodies differ per page, so the etags must too: one etag for forty
  // different pages would be a different bug.
  assert.equal(new Set(pages.map((p) => p.headers.etag)).size, 40);
});

test("the same body in the same window is byte-identical, etag included", async () => {
  // This makes a 304 possible at all: two polls inside one window have to
  // produce the same validator, or If-None-Match never matches and the caching
  // is decorative.
  const dispatch = cached([route({ cacheTtl: 30 })]);

  const first = await dispatch({ method: "GET", pathname: "/latest/status/", query: {} });
  const second = await dispatch({ method: "GET", pathname: "/latest/status/", query: {} });

  assert.equal(first.headers.etag, second.headers.etag);
  assert.equal(first.headers["last-modified"], second.headers["last-modified"]);
});

// X-Esi-Cache-Status

test("the header's presence is observed and its two values are not", () => {
  // That CCP sends the header is in both observed 2XX header sets, so omitting
  // it is a difference a header diff finds. What it says was never recorded, so
  // HIT and MISS are an unobserved claim, marked as one beside the request that
  // would settle it.
  assert.ok(wire.GATEWAY_SUCCESS_HEADERS.includes("x-esi-cache-status"));
  assert.ok(wire.APP_SUCCESS_HEADERS.includes("x-esi-cache-status"));

  assert.deepEqual(Object.values(CACHE_STATUS), [...wire.INFRASTRUCTURE.cacheStatus.values]);
  assert.equal(wire.INFRASTRUCTURE.cacheStatus.valuesObserved, false);
  assert.deepEqual(
    [...wire.INFRASTRUCTURE.cacheStatus.producers],
    [PRODUCER.GATEWAY, PRODUCER.APP],
    "both producers, unlike the request id",
  );
});

test("a route that recomputes its body reports a miss, on both producers", async () => {
  // The honest answer for everything this replica serves today: there is no
  // snapshot behind an unpaginated route, so the handler ran, so the cache did
  // not answer. Reporting a hit because the response would have been identical
  // would describe the window rather than the cache.
  for (const producer of [PRODUCER.GATEWAY, PRODUCER.APP]) {
    const dispatch = cached([{ method: "GET", path: "/status", producer, cacheTtl: 30, handler: () => ({ players: 1 }) }]);

    const first = await dispatch({ method: "GET", pathname: "/latest/status/", query: {}, headers: {} });
    const second = await dispatch({ method: "GET", pathname: "/latest/status/", query: {}, headers: {} });

    assert.equal(first.headers["x-esi-cache-status"], CACHE_STATUS.MISS);
    assert.equal(second.headers["x-esi-cache-status"], CACHE_STATUS.MISS, "still a miss inside the window");
    assert.equal(first.headers.etag, second.headers.etag, "and the representation is still stable");
  }
});

test("a 304 carries no cache status, because nothing observed says it does", async () => {
  // NOT_MODIFIED_SENDS lists what survives the rebuild, and this header is not
  // on it: not as a "no", but as a question nobody asked CCP. Inventing an
  // answer would repeat the mistake that lost Vary from the 304.
  const dispatch = cached([{ method: "GET", path: "/status", producer: PRODUCER.GATEWAY, cacheTtl: 30, handler: () => ({ players: 1 }) }]);

  const first = await dispatch({ method: "GET", pathname: "/latest/status/", query: {}, headers: {} });
  const again = await dispatch({
    method: "GET",
    pathname: "/latest/status/",
    query: {},
    headers: { "if-none-match": first.headers.etag },
  });

  assert.equal(again.status, 304);
  assert.equal(again.headers["x-esi-cache-status"], undefined);
  assert.equal(
    "cacheStatus" in wire.NOT_MODIFIED_SENDS[wire.KIND.GATEWAY_SUCCESS],
    false,
    "the recording has no field for it, which is what absence has to mean here",
  );
});

// What does not get cache headers

test("a refusal carries none of the four", async () => {
  // Observed: a 401, a 422 and an unrouted 404 carry no Cache-Control, no
  // Expires, no Etag and no Last-Modified.
  const dispatch = cached([route()]);

  const unrouted = await dispatch({ method: "GET", pathname: "/nope/", query: {} });
  const refused = await dispatch({ method: "DELETE", pathname: "/latest/status/", query: {} });

  for (const result of [unrouted, refused]) {
    for (const header of ["cache-control", "expires", "etag", "last-modified"]) {
      assert.equal((result.headers || {})[header], undefined, `${result.status} carried ${header}`);
    }
  }

  assert.equal(wire.SENDS_CACHE_HEADERS[wire.KIND.UNROUTED], false, "the observation this rests on");
  assert.equal(wire.SENDS_CACHE_HEADERS[wire.KIND.GATEWAY_ERROR], false);
  assert.equal(wire.SENDS_CACHE_HEADERS[wire.KIND.PING], false);
});

test("a result the layer does not understand passes through untouched", async () => {
  // A dispatch that is not the router has no producer to build a policy from.
  // Inventing one would put a wrong Cache-Control on somebody else's response.
  const dispatch = createCacheDispatch(() => ({ status: 200, body: { a: 1 } }), { now: () => NOW });

  const result = await dispatch({ method: "GET", pathname: "/whatever" });

  assert.deepEqual(result, { status: 200, body: { a: 1 } });
});

test("a verbatim body is left alone, because its bytes are already decided", async () => {
  const dispatch = createCacheDispatch(
    () => ({ status: 200, body: "ok", headers: { "content-type": "text/plain" } }),
    { now: () => NOW },
  );

  const result = await dispatch({ method: "GET", pathname: "/ping" });

  assert.equal(result.headers.etag, undefined);
  assert.equal(result.body, "ok");
});

test("a result that set its own cache header keeps it", async () => {
  // `/_mod/health` is `no-store`, because a cached health response is not stale
  // data but a wrong answer. It is dispatched outside this layer, but the
  // precedence rule is the one lib/cors.js follows and is worth pinning.
  const dispatch = createCacheDispatch(
    () => ({ status: 200, body: { a: 1 }, producer: PRODUCER.GATEWAY, cacheTtl: 30, headers: { "cache-control": "no-store" } }),
    { now: () => NOW },
  );

  const result = await dispatch({ method: "GET", pathname: "/x" });

  assert.equal(result.headers["cache-control"], "no-store");
  assert.ok(result.headers.etag, "the ones it did not set are still added");
});

// The payload rides along

test("the bytes the etag was computed over are the bytes that get written", async () => {
  // The layer has to serialize to digest. Handing the result on rather than
  // letting server.js repeat the work saves two full passes over an 8000-element
  // array on the game's own event loop, and guarantees the etag describes the
  // body the client received.
  const body = { systems: [30000001, 30000002] };
  const dispatch = cached([{ ...route(), handler: () => body }]);

  const result = await dispatch({ method: "GET", pathname: "/latest/status/", query: {} });

  assert.ok(Buffer.isBuffer(result.payload));
  assert.deepEqual(result.payload, serializeBody(body, PRODUCER.GATEWAY));
  assert.equal(result.headers.etag, etagFor(result.payload, PRODUCER.GATEWAY));
});

// End to end, on a socket

test("all four headers reach the client, spelled the way CCP spells them", async (t) => {
  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: createCorsDispatch(cached([route({ cacheTtl: 30 })])),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));

  const response = await fetch(`http://127.0.0.1:${handle.port}/latest/status/`);
  const body = Buffer.from(await response.arrayBuffer());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=30, must-revalidate, stale-if-error=900");
  assert.match(response.headers.get("etag"), /^W\/"[0-9a-f]{64}"$/);
  assert.ok(response.headers.get("expires"));
  assert.ok(response.headers.get("last-modified"));

  // `Etag`, not `ETag`. The pinned spec says the latter and CCP does not (D23).
  assert.equal(wire.HEADER_CASE.etag, "Etag");

  // The body still went out intact, with its producer's trailing newline and a
  // content-length that counts it.
  assert.equal(body.toString("utf8"), '{"players":1}\n');
  assert.equal(response.headers.get("content-length"), "14");
  assert.equal(response.headers.get("content-type"), "application/json");
});

// Acceptance, against the real table

test("every implemented route carries all four headers", async () => {
  // Enumerated from the routes that exist, so the day one lands without a TTL
  // (and so without Cache-Control and Expires) this fails rather than a client
  // noticing the omission.
  const { createStatusRoute } = require(path.join(__dirname, "../routes/status"));
  const {
    createCharacterLocationRoute,
    createCharacterOnlineRoute,
    createCharacterShipRoute,
  } = require(path.join(__dirname, "../routes/characters"));

  // The three character reads use live character state, so they get a double:
  // the four headers are a property of the cache layer and the route's declared
  // TTL, not of a running game.
  const CHARACTER_ID = 90000021;
  const runtime = {
    getCharacterOnlineSnapshot: () => ({ online: true }),
    peekCharacterRecord: (id, options) => options.project({
      solarSystemID: 30000142,
      stationID: 60003760,
      structureID: null,
      shipTypeID: 670,
      shipName: "Capsule",
      shipID: 100090000021,
      logoffDate: "133000000000000000",
    }, id),
  };

  const routes = [
    createStatusRoute({
      runtime: { countPlayers: () => 1, getSdeBuild: () => "3396210", isRuntimeReachable: () => ({ reachable: true }) },
      startedAt: NOW,
    }),
    createCharacterOnlineRoute({ runtime }),
    createCharacterLocationRoute({ runtime }),
    createCharacterShipRoute({ runtime }),
  ];

  const dispatch = cached(routes);

  // The gate refuses a scoped route before the handler runs, so a route that
  // requires a scope is asked with a credential. Built here rather than minted:
  // the gate reads `claims`, and this test is about headers rather than tokens.
  const credential = {
    presented: true,
    refusal: null,
    claims: { characterId: CHARACTER_ID, scopes: [
      "esi-location.read_online.v1",
      "esi-location.read_location.v1",
      "esi-location.read_ship_type.v1",
    ] },
  };

  for (const declared of routes) {
    const pathname = declared.path.replace(":character_id", String(CHARACTER_ID));
    const request = { method: declared.method, pathname, query: {} };
    if (declared.scope) request.credential = credential;

    const result = await dispatch(request);

    assert.equal(result.status, 200, `${declared.name} did not answer 200`);
    for (const header of ["cache-control", "expires", "etag", "last-modified"]) {
      assert.ok(result.headers[header], `${declared.name} is missing ${header}`);
    }

    // Two forms, and which applies is not the producer's business: an
    // authenticated route sends `private` where the same producer sends `public`
    // on a public one. `public` on a body carrying one pilot's location is what
    // this branch exists to stop.
    const expected = declared.scope
      ? wire.AUTHENTICATED_CACHE_CONTROL
      : wire.CACHE_CONTROL[wire.SUCCESS_KIND[declared.path]](declared.cacheTtl);

    assert.equal(
      result.headers["cache-control"],
      expected,
      `${declared.name}'s Cache-Control is not the one observed for its kind`,
    );
  }
});
