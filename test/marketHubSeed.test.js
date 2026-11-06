/**
 * `market-hub-seed` against this replica: the request shape the tool sends
 * and the caching contract it depends on.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * The tool's full run (two consecutive runs, the second hitting its cache) needs
 * `/markets/prices/` and `/markets/{region_id}/orders/`, which are not covered
 * here. Stubbing the market endpoints would test the stub. What is held here:
 * the request shape the tool sends is one this replica accepts, and the caching
 * contract still works underneath it. Both could break because two validators
 * (`datasource` and `X-Compatibility-Date`) sit in front of every request.
 * Both are asserted against `/status/`, a real gateway route with a real TTL
 * and a real `Etag`.
 *
 * What the tool does, read out of
 * `EveJS-Relaunch-Market-Tool/tools/market-hub-seed/` on 2026-08-23:
 * `esi-cache-client.js` keys its on-disk cache on
 * `SHA-256(compatibilityDate + "\n" + url)`, where `compatibilityDate` is
 * `currentCompatibilityDate()` (its own clock, shifted to UTC-11), the same
 * string it puts in the request header. It never reads our
 * `X-Compatibility-Date` response header. Our echo of `2020-01-01` and its key
 * of today's date never meet, so a mismatch cannot invalidate its cache.
 *
 * The real exposure is the other direction. The tool sends
 * `X-Compatibility-Date: <today in UTC-11>` and `?datasource=tranquility` on
 * every request. This replica validates both, so a wrong rule would 400 every
 * request of every run rather than degrade quietly. The first test covers that.
 *
 * Clock-skew window: the tool computes today in UTC-11 from its own clock and
 * the server compares against its own. A client a few seconds ahead of the
 * server across the 11:00Z boundary computes tomorrow's date and gets a 400 for
 * the whole run. Real ESI has the identical window (the comparison is the same
 * and CCP names the zone in the message), so widening it here would hide from a
 * tool author a failure they would then meet on Tranquility. It is reproduced.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const { startServer, closeServer } = require(path.join(__dirname, "../server"));
const { COMPATIBILITY_DATE, todayAt } = require(path.join(__dirname, "../lib/compatibility"));
const { createEsiDispatch } = require(path.join(__dirname, "../lib/pipeline"));
const { createRouter } = require(path.join(__dirname, "../lib/router"));
const { TENANT } = require(path.join(__dirname, "../lib/tenant"));

/** Fixed, and late enough in the UTC day that the UTC-11 shift is visible. */
const NOW = Date.parse("2026-08-23T20:00:00Z");

/**
 * `currentCompatibilityDate()`, copied from the tool.
 *
 * Eleven hours back and then the UTC date, the same arithmetic
 * `lib/compatibility.js` `todayAt` does, arrived at independently: the tool and
 * the replica agree about what day it is because they agree about the zone.
 */
const clientCompatibilityDate = (now) =>
  new Date(now - 11 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** `cacheFilePath()`, copied from the tool. Its key, in one line. */
const clientCacheKey = (compatibilityDate, url) =>
  crypto.createHash("sha256").update(`${compatibilityDate}\n${url}`).digest("hex");

/** `cacheExpiry()`'s `max-age` regex, copied from the tool. */
const CLIENT_MAX_AGE = /(?:^|,)\s*max-age=(\d+)/i;

const statusRoute = () => ({
  method: "GET",
  path: "/status",
  name: "GetStatus",
  handler: () => ({ server_version: "3396210", players: 3, vip: false }),
  producer: "gateway",
  cacheTtl: 30,
  rateLimitGroup: "status",
});

async function serve(t, now = () => NOW) {
  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: createEsiDispatch(createRouter([statusRoute()]), { now }),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));
  return `http://127.0.0.1:${handle.port}`;
}

/** The request the tool makes, header for header. */
const seedRequest = (now = NOW) => ({
  headers: {
    Accept: "application/json",
    "User-Agent": "market-hub-seed",
    "X-Compatibility-Date": clientCompatibilityDate(now),
  },
});

// The two validators, on the request the tool sends

test("the request shape market-hub-seed sends is one this replica accepts", async (t) => {
  // The tool sends `?datasource=tranquility` on every URL it builds and a
  // `X-Compatibility-Date` of today. A replica that refused either would 400
  // every request of every run.
  const url = await serve(t);

  const response = await fetch(`${url}/latest/status/?datasource=${TENANT}`, seedRequest());

  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"server_version":"3396210","players":3,"vip":false}\n');
});

test("today, and not 2020-01-01, is what it sends, and that is accepted", async (t) => {
  // The tool never sends the surface date. It sends its own clock's date, and an
  // implementation that accepted only the date it echoes would refuse every
  // request from every client of this shape.
  const url = await serve(t);
  const sent = clientCompatibilityDate(NOW);

  assert.equal(sent, "2026-08-23");
  assert.notEqual(sent, COMPATIBILITY_DATE, "the two are never the same string");
  assert.equal(sent, todayAt(NOW), "and the tool's zone is the one we compare in");

  const response = await fetch(`${url}/latest/status/?datasource=${TENANT}`, seedRequest());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-compatibility-date"), COMPATIBILITY_DATE, "we still echo the surface");
});

test("its cache key is its own date, so our echo cannot invalidate it", async () => {
  // `cacheFilePath()` hashes `options.compatibilityDate`, the value it sent; the
  // response header is never read into it. The two strings differ on every
  // request and the cache is keyed on only one of them.
  const url = "http://host.local:26005/markets/prices/?datasource=tranquility";

  const keyedOnWhatItSent = clientCacheKey(clientCompatibilityDate(NOW), url);
  const keyedOnWhatWeEcho = clientCacheKey(COMPATIBILITY_DATE, url);

  assert.notEqual(keyedOnWhatItSent, keyedOnWhatWeEcho, "which is exactly why it matters that it is the first");
  assert.equal(keyedOnWhatItSent, clientCacheKey("2026-08-23", url), "stable across a run");
});

// The caching contract two consecutive runs rest on

test("the first run's response is one the tool can put in its cache", async (t) => {
  // `cacheExpiry()` reads `max-age` off `Cache-Control` with its own regex and
  // falls back to `Expires`. Both have to be present and parse, or the entry is
  // treated as expired on write and the second run is a full refetch, with no
  // error.
  const url = await serve(t);

  const response = await fetch(`${url}/latest/status/?datasource=${TENANT}`, seedRequest());

  const cacheControl = response.headers.get("cache-control");
  const maxAge = CLIENT_MAX_AGE.exec(cacheControl);
  assert.ok(maxAge, `the tool's own regex found no max-age in ${JSON.stringify(cacheControl)}`);
  assert.equal(Number(maxAge[1]), 30, "the route's published TTL");

  assert.ok(Number.isFinite(Date.parse(response.headers.get("expires"))), "and the fallback parses too");
  assert.ok(response.headers.get("etag"), "the validator the second run sends back");
});

test("the second run revalidates to a 304, a conditional-cache hit", async (t) => {
  // The tool counts a 304 as `conditionalCacheHits` and reuses the stored body.
  // This reproduces "cache actually hitting" on the one gateway route there is,
  // with the tool's own request shape in front of it, including the two
  // validators, which a 304 has to survive.
  const url = await serve(t);

  const first = await fetch(`${url}/latest/status/?datasource=${TENANT}`, seedRequest());
  const etag = first.headers.get("etag");

  const second = await fetch(`${url}/latest/status/?datasource=${TENANT}`, {
    headers: { ...seedRequest().headers, "If-None-Match": etag },
  });

  assert.equal(second.status, 304);
  assert.equal(await second.text(), "", "and no body, so the run gets cheaper as well as faster");
  assert.equal(second.headers.get("x-compatibility-date"), COMPATIBILITY_DATE, "the 304 still says which surface");
});

// The window we are choosing to keep

test("a client whose clock is over the UTC-11 line is refused, exactly as CCP refuses it", async (t) => {
  // Reproduced rather than defended against. The tool computes today from its
  // own clock; a client a few seconds ahead of the server across 11:00Z asks for
  // tomorrow and loses the whole run. Real ESI has the identical window, so
  // widening ours would hide a failure the tool would then meet on Tranquility.
  const url = await serve(t);
  const aheadOfUs = Date.parse("2026-08-24T11:00:01Z");

  assert.equal(clientCompatibilityDate(aheadOfUs), "2026-08-24", "the client thinks it is tomorrow");
  assert.equal(todayAt(NOW), "2026-08-23", "and the server does not");

  const response = await fetch(`${url}/latest/status/?datasource=${TENANT}`, seedRequest(aheadOfUs));

  assert.equal(response.status, 400);
  assert.equal(
    (await response.json()).error,
    wire.COMPATIBILITY_DATE_RULES.errors.inFuture("2026-08-24", "2026-08-23"),
  );
});
