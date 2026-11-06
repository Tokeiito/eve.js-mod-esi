/**
 * Conditional requests: `If-None-Match`, `If-Modified-Since`, and the `304`.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Neither producer follows the RFC, and they fail differently. This is the
 * fourth thing that splits by producer, after the content type, the trailing
 * newline and the cache headers. RFC 9110 §13.1.2 says `If-None-Match` is a
 * comma-separated list, that `*` matches any existing representation, and that
 * the comparison is weak so `W/"x"` and `"x"` are the same validator. Between
 * them the two producers implement all three, and neither implements more than
 * one:
 *
 *                          gateway   application
 *   exact etag               304        304
 *   `W/"x"` sent for `"x"`   304        200
 *   `If-None-Match: *`       200        304
 *   `"other", "ours"`        200        200
 *   `If-Modified-Since`      304        200
 *
 * Reproduced in both directions. Being more correct than ESI is the failure
 * mode: a client that discovers our `*` works on a gateway route writes code
 * that silently stops working against CCP, and a replica that answers `304`
 * where ESI answers `200` hands an empty body to a client that needed one.
 *
 * Everything asserted about CCP comes from `contract/wire.js` (`CONDITIONAL`
 * and `NOT_MODIFIED_SENDS`), established 2026-08-22 against three gateway
 * routes and three application routes, each probe re-fetching the current etag
 * first so a rotated validator could not be mistaken for a rule.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const { startServer, closeServer } = require(path.join(__dirname, "../server"));
const { PRODUCER } = require(path.join(__dirname, "../lib/serialize"));
const { createCorsDispatch } = require(path.join(__dirname, "../lib/cors"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const {
  createCacheDispatch,
  httpDate,
  isNotModified,
  policyFor,
  stripWeak,
} = require(path.join(__dirname, "../lib/cache"));

const NOW = Date.parse("2026-08-22T11:00:00Z");
const PATHNAME = "/latest/status/";

/**
 * The static-data snapshot a shared-snapshot route carries, frozen in time.
 *
 * The etag is not a digest of the body (that is what makes these routes
 * different), so it is written here rather than computed.
 */
const SNAPSHOT = () => ({
  etag: 'W/"a3cbe689cb47e4053e2cc66a2aeb133118f235186aa60a00ceecaa7a"',
  lastModified: Date.parse("2026-08-14T15:56:13.265Z"),
  expires: Date.parse("2026-08-23T11:05:00Z"),
});

/** One route, behind the cache layer, with a clock that does not move. */
function cached({ producer = PRODUCER.GATEWAY, cacheTtl = 30, snapshot = null } = {}) {
  const router = createRouter([{
    method: "GET",
    path: "/status",
    name: "GetStatus",
    handler: () => ({ players: 1 }),
    producer,
    cacheTtl,
    snapshot,
  }]);
  return createCacheDispatch(
    (request) => dispatchRequest(router, request, { logError: () => {} }),
    { now: () => NOW },
  );
}

/** The unconditional response, then the conditional one. */
async function revalidate(dispatch, headers) {
  const first = await dispatch({ method: "GET", pathname: PATHNAME, query: {}, headers: {} });
  const again = await dispatch({ method: "GET", pathname: PATHNAME, query: {}, headers });
  return { first, again };
}

/** The etag this dispatch answers with, for a conditional request to carry back. */
async function etagOf(dispatch) {
  const first = await dispatch({ method: "GET", pathname: PATHNAME, query: {}, headers: {} });
  return first.headers.etag;
}

/** `W/"x"` <-> `"x"`, whichever it was not. */
const flip = (etag) => (etag.startsWith("W/") ? etag.slice(2) : `W/${etag}`);

// The rules are the observed ones

test("the conditional policy matches what was observed, per producer", () => {
  // lib/ cannot import contract/ (test-only, never deployed, D20), so the values
  // are duplicated and this test checks that they agree.
  for (const [producer, kind] of [
    [PRODUCER.GATEWAY, wire.KIND.GATEWAY_SUCCESS],
    [PRODUCER.APP, wire.KIND.APP_SUCCESS],
  ]) {
    assert.deepEqual({ ...policyFor(producer).conditional }, { ...wire.CONDITIONAL[kind] });

    // Derived from the recording rather than hand-listed. A hand-listed set of
    // four fields would let `vary` and `compatibilityDate` be added to the
    // observation and dropped by the policy while this test stayed green (which is
    // how the `304` once lost both). Now a field added to the recording is a field
    // the policy must answer for.
    const observed = wire.NOT_MODIFIED_SENDS[kind];
    const policy = policyFor(producer).notModified;

    // The two `server.js` owns: a `304` has no body, so it has no framing headers
    // to keep or drop, and the policy deliberately has no opinion.
    assert.equal(observed.contentType, false);
    assert.equal(observed.contentLength, false);

    const expected = { ...observed };
    delete expected.contentType;
    delete expected.contentLength;

    assert.deepEqual({ ...policy }, expected);
  }
});

test("stripWeak takes the prefix off a weak validator and leaves a strong one", () => {
  assert.equal(stripWeak('W/"abc"'), '"abc"');
  assert.equal(stripWeak('"abc"'), '"abc"');
  assert.equal(stripWeak("*"), "*");
});

// What matches

test("an exact etag is a 304 on both producers", async () => {
  for (const producer of [PRODUCER.GATEWAY, PRODUCER.APP]) {
    const dispatch = cached({ producer });

    const plain = await revalidate(dispatch, {});
    assert.equal(plain.again.status, 200, "no condition, no 304");

    const matched = await revalidate(dispatch, { "if-none-match": plain.first.headers.etag });
    assert.equal(matched.again.status, 304, `${producer} did not honour its own etag`);
    assert.equal(matched.again.body, undefined, "a 304 has no body");
  }
});

test("an etag that matches nothing is a 200, with the body", async () => {
  for (const producer of [PRODUCER.GATEWAY, PRODUCER.APP]) {
    const { again } = await revalidate(cached({ producer }), { "if-none-match": '"deadbeef"' });

    assert.equal(again.status, 200);
    assert.ok(again.body, "and the client gets what it asked for");
  }
});

test("weak comparison is the gateway's rule and not the application's", async () => {
  // The RFC says `W/"x"` and `"x"` are the same validator here. The gateway
  // agrees; the application compares the string it was handed. Implementing the
  // RFC on both would make the application half answer 304 where CCP answers
  // 200: an empty body to a client that needed one.
  const gateway = cached({ producer: PRODUCER.GATEWAY });
  const gatewayEtag = (await revalidate(gateway, {})).first.headers.etag;
  const gatewayFlipped = await revalidate(gateway, { "if-none-match": flip(gatewayEtag) });
  assert.equal(gatewayFlipped.again.status, 304, "the gateway strips W/ before comparing");

  const app = cached({ producer: PRODUCER.APP });
  const appEtag = (await revalidate(app, {})).first.headers.etag;
  const appFlipped = await revalidate(app, { "if-none-match": flip(appEtag) });
  assert.equal(appFlipped.again.status, 200, "and being right here would be wrong");
});

test("If-None-Match: * is the application's rule and not the gateway's", async () => {
  const gateway = await revalidate(cached({ producer: PRODUCER.GATEWAY }), { "if-none-match": "*" });
  assert.equal(gateway.again.status, 200, "observed: the gateway ignores it");

  const app = await revalidate(cached({ producer: PRODUCER.APP }), { "if-none-match": "*" });
  assert.equal(app.again.status, 304);
});

test("neither producer parses a comma-separated list", async () => {
  // A client sending two cached validators gets a 200 and a full body from
  // both. That is CCP's answer, and a cache has to be able to live with it.
  for (const producer of [PRODUCER.GATEWAY, PRODUCER.APP]) {
    const dispatch = cached({ producer });
    const etag = (await revalidate(dispatch, {})).first.headers.etag;
    const { again } = await revalidate(dispatch, { "if-none-match": `"other", ${etag}` });

    assert.equal(again.status, 200, `${producer} parsed a list, and CCP does not`);
  }
});

test("If-Modified-Since is the gateway's rule, and it is real date comparison", async () => {
  const dispatch = cached({ producer: PRODUCER.GATEWAY });
  const lastModified = (await revalidate(dispatch, {})).first.headers["last-modified"];

  const own = await revalidate(dispatch, { "if-modified-since": lastModified });
  assert.equal(own.again.status, 304);

  const future = await revalidate(dispatch, { "if-modified-since": httpDate(NOW + 86400 * 1000) });
  assert.equal(future.again.status, 304);

  // Not a blanket answer: a date from before the data changed is a 200.
  const past = await revalidate(dispatch, { "if-modified-since": httpDate(0) });
  assert.equal(past.again.status, 200);

  const nonsense = await revalidate(dispatch, { "if-modified-since": "not a date" });
  assert.equal(nonsense.again.status, 200, "an unparseable date is not a match");
});

test("the application ignores If-Modified-Since entirely", async () => {
  const dispatch = cached({ producer: PRODUCER.APP });
  const lastModified = (await revalidate(dispatch, {})).first.headers["last-modified"];

  const { again } = await revalidate(dispatch, { "if-modified-since": lastModified });

  assert.equal(again.status, 200, "observed: it does not implement it, so neither do we");
});

test("a present If-None-Match ends it, even beside an If-Modified-Since that would match", async () => {
  // RFC 9110 says a present If-None-Match makes If-Modified-Since inapplicable,
  // and this is the one rule all three agree on.
  const dispatch = cached({ producer: PRODUCER.GATEWAY });
  const lastModified = (await revalidate(dispatch, {})).first.headers["last-modified"];

  const { again } = await revalidate(dispatch, {
    "if-none-match": '"deadbeef"',
    "if-modified-since": lastModified,
  });

  assert.equal(again.status, 200);
});

test("isNotModified reads the request rather than guessing", () => {
  // The unit underneath, so a failure above says which half broke.
  const validators = { etag: 'W/"abc"', lastModified: httpDate(NOW) };

  assert.equal(isNotModified({ headers: {} }, validators, PRODUCER.GATEWAY), false, "no condition, no match");
  assert.equal(isNotModified({}, validators, PRODUCER.GATEWAY), false, "and no headers at all is not a match");
  assert.equal(
    isNotModified({ headers: { "if-none-match": 'W/"abc"' } }, validators, PRODUCER.GATEWAY),
    true,
  );
});

// What the 304 carries

test("the gateway's 304 drops both validators and keeps its max-age", async () => {
  // Contrary to what the RFC suggests: a client refreshing its cache metadata
  // from a gateway 304 gets neither an Etag nor a Last-Modified back.
  const dispatch = cached({ producer: PRODUCER.GATEWAY, cacheTtl: 30 });
  const first = (await revalidate(dispatch, {})).first;
  const { again } = await revalidate(dispatch, { "if-none-match": first.headers.etag });

  assert.equal(again.status, 304);
  assert.equal(again.headers.etag, undefined);
  assert.equal(again.headers["last-modified"], undefined);
  assert.equal(again.headers["cache-control"], "public, max-age=30, must-revalidate, stale-if-error=900");
  assert.ok(again.headers.expires);
});

test("the application's 304 keeps both, and its bare public is not a collapse", async () => {
  // The application's bare `public` on a 304 is not Cache-Control "collapsing,
  // losing max-age": that producer's 200 sends bare `public` too, and the
  // producer that does send max-age keeps it.
  const dispatch = cached({ producer: PRODUCER.APP, cacheTtl: 300 });
  const first = (await revalidate(dispatch, {})).first;
  const { again } = await revalidate(dispatch, { "if-none-match": first.headers.etag });

  assert.equal(again.status, 304);
  assert.equal(again.headers.etag, first.headers.etag);
  assert.equal(again.headers["last-modified"], first.headers["last-modified"]);
  assert.equal(again.headers["cache-control"], "public");
  assert.equal(first.headers["cache-control"], "public", "the 200 says the same thing");
});

test("a 304 carries no content-type, no content-length and no bytes", async () => {
  const dispatch = cached({ producer: PRODUCER.GATEWAY });
  const first = (await revalidate(dispatch, {})).first;
  const { again } = await revalidate(dispatch, { "if-none-match": first.headers.etag });

  assert.equal(again.body, undefined);
  assert.equal(again.payload, undefined, "and no buffer riding along to be written by accident");
  assert.equal(again.headers["content-type"], undefined);
  assert.equal(again.headers["content-length"], undefined);
});

// The acceptance round-trip, on a socket

test("GET, capture the Etag, re-GET with If-None-Match, get an empty 304", async (t) => {
  // End to end, which is also the only way to prove the 304 leaves with no body
  // and no content-length, rather than merely being shaped that way in an
  // object.
  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: createCorsDispatch(cached({ producer: PRODUCER.GATEWAY, cacheTtl: 30 })),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));

  const url = `http://127.0.0.1:${handle.port}${PATHNAME}`;

  const first = await fetch(url);
  const etag = first.headers.get("etag");
  assert.equal(first.status, 200);
  assert.match(etag, /^W\/"[0-9a-f]{64}"$/);

  const second = await fetch(url, { headers: { "If-None-Match": etag } });
  const body = Buffer.from(await second.arrayBuffer());

  assert.equal(second.status, 304);
  assert.equal(body.length, 0, "a 304 has no body");
  assert.equal(second.headers.get("content-length"), null, "and RFC 9110 forbids the header");
  assert.equal(second.headers.get("cache-control"), "public, max-age=30, must-revalidate, stale-if-error=900");
  assert.ok(second.headers.get("expires"));

  // "The full header set" includes the two the router attached, including
  // `X-Compatibility-Date`. `notModifiedResult` rebuilds the headers, the router
  // runs inside the layer that does it, and both were once dropped because
  // nothing said to keep them.
  //
  // `fetch` comma-joins repeated lines, which is why this reads as one string
  // where the wire carries three; `test/serverHeaders.test.js` asserts the line
  // count.
  assert.equal(second.headers.get("x-compatibility-date"), "2020-01-01");
  assert.equal(
    second.headers.get("vary"),
    wire.VARY_BY_KIND[wire.KIND.GATEWAY_SUCCESS].join(", "),
    "a 304 that drops Vary lets a cache lose the variance key it was stored under",
  );

  // CORS still applies. The cache layer sits inside it so that a browser
  // revalidating cross-origin can read the 304 at all.
  assert.equal(second.headers.get("access-control-allow-origin"), "*");
});

test("the 304 keeps the router's Vary and echo, in the producer's own multiplicity", async () => {
  // The application repeats `Accept-Language` and the gateway does not, on the
  // 200 and therefore on the 304. That is why `notModifiedResult` carries the
  // header across rather than rebuilding it from a rule of its own.
  for (const [producer, kind] of [
    [PRODUCER.GATEWAY, wire.KIND.GATEWAY_SUCCESS],
    [PRODUCER.APP, wire.KIND.APP_SUCCESS],
  ]) {
    const dispatch = cached({ producer });
    const { first } = await revalidate(dispatch, {});
    const { again } = await revalidate(dispatch, { "if-none-match": first.headers.etag });

    assert.equal(again.status, 304);
    assert.deepEqual(again.headers.vary, [...wire.VARY_BY_KIND[kind]]);
    assert.deepEqual(again.headers.vary, first.headers.vary, "the 304 and the 200 tell one story");
    assert.equal(again.headers["x-compatibility-date"], wire.COMPATIBILITY_DATE);
  }
});

test("both etag strengths round-trip through a socket", async (t) => {
  // The producers issue different strengths and each has to come back
  // recognised as the form it was sent in.
  for (const [producer, shape] of [[PRODUCER.GATEWAY, /^W\/"/], [PRODUCER.APP, /^"/]]) {
    const handle = await startServer({
      config: { esiBindHost: "127.0.0.1", esiPort: 0 },
      dispatch: cached({ producer }),
      log: () => {},
      logError: () => {},
    });
    t.after(() => closeServer(handle));

    const url = `http://127.0.0.1:${handle.port}${PATHNAME}`;
    const etag = (await fetch(url)).headers.get("etag");

    assert.match(etag, shape, `${producer} issued the wrong etag strength`);
    assert.equal((await fetch(url, { headers: { "If-None-Match": etag } })).status, 304);
  }
});

// The one case this deliberately does not model

test("the static-data exception is what a snapshot route gets, and only a snapshot route", async () => {
  // `/universe/regions/`, `/universe/types/` and the rest of the shared-snapshot
  // set do parse lists and do compare weakly, unlike every other application
  // route. Very likely a cache in front of them rather than the application
  // itself, but that is inference and `contract/wire.js` records observations.
  //
  // On this replica the exception is load-bearing rather than cosmetic: our
  // static-data etag is weak, so a client that stores `W/"x"` and sends `"x"`
  // back (RFC 9110's own advice) would never see a `304` under the application's
  // strong comparison.
  const exception = wire.CONDITIONAL_STATIC_DATA_EXCEPTION;

  assert.ok(exception.paths.length > 0);
  assert.equal(exception.list, true);
  assert.equal(exception.weakComparison, true);
  assert.notEqual(
    exception.list,
    wire.CONDITIONAL[wire.KIND.APP_SUCCESS].list,
    "if these ever agree, the exception has stopped being one and this test should go",
  );

  // The same producer, the same body, the same request: the only difference is
  // whether the route carries a snapshot. So the exception is read off what a
  // route declares rather than off its path.
  for (const [snapshot, expected] of [[SNAPSHOT, 304], [null, 200]]) {
    const dispatch = cached({ producer: PRODUCER.APP, cacheTtl: snapshot ? null : 30, snapshot });
    const { first, again } = await revalidate(dispatch, { "if-none-match": flip(await etagOf(dispatch)) });

    assert.equal(first.status, 200);
    assert.equal(again.status, expected, `a weak/strong flip on a ${snapshot ? "snapshot" : "plain"} app route`);
  }

  // And a list, which the application does not parse and this set does.
  const dispatch = cached({ producer: PRODUCER.APP, cacheTtl: null, snapshot: SNAPSHOT });
  const { again } = await revalidate(dispatch, {
    "if-none-match": `"somebody else's", ${await etagOf(dispatch)}`,
  });
  assert.equal(again.status, 304);
});
