/**
 * A paged sweep of the order book, against the recorded contract.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * `marketsContract.test.js` checks one response against CCP's pinned spec. This
 * file checks the property that only exists across responses: walking every page
 * of a region yields one coherent collection. It checks against
 * `contract/wire.js`, which records what was observed on real ESI.
 *
 * The Forge is 80 pages on this replica and 413 on Tranquility. Nothing about a
 * single page tells a client whether the eighty agree with each other. The sweep
 * contract is five properties:
 *
 *   `X-Pages` on every page          PAGINATION.alwaysSent
 *   one `Last-Modified` per resource PAGINATION.lastModifiedPerResource
 *   one `Etag` per page              PAGINATION.etagPerPage
 *   `Expires` from `Last-Modified`   EXPIRES_BASIS[appSuccess]
 *   `If-None-Match` -> 304, no body  CONDITIONAL[appSuccess]
 *
 * A replica that broke any of them would pass every per-response test and hand a
 * client a book assembled from two different moments. The page snapshot and the
 * single clock reading exist to prevent that, and no unit test of either sees it
 * on its own.
 *
 * This is a contract test, not an end-to-end run. It builds its own order book,
 * starts its own listener and talks to it with `fetch`, so it needs no game
 * server, market daemon or third-party tool and never skips. Running the real
 * `market-hub-seed` against a real replica is the acceptance run, done by
 * `scripts/market-canary.js` on a machine that has the tool and a book.
 *
 * The fixture book is 2,500 orders. The page size is 1,000, so 2,500 is the
 * smallest book that makes a sweep: three pages, an uneven last one, and two
 * page boundaries for the invariants to break at.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const wire = require(path.join(__dirname, "..", "contract", "wire"));
const { MARKET_SCHEMA } = require(path.join(__dirname, "marketFixture"));
const { closeMarketDb, openMarketDb } = require(path.join(__dirname, "..", "lib", "marketStore"));
const { createEsiDispatch } = require(path.join(__dirname, "..", "lib", "pipeline"));
const { createRouter } = require(path.join(__dirname, "..", "lib", "router"));
const { TENANT } = require(path.join(__dirname, "..", "lib", "tenant"));
const { todayAt } = require(path.join(__dirname, "..", "lib", "compatibility"));
const { closeServer, startServer } = require(path.join(__dirname, "..", "server"));
const {
  ORDERS_CACHE_TTL_SECONDS,
  ORDERS_PAGE_SIZE,
  PRICES_CACHE_TTL_SECONDS,
  createMarketPricesRoute,
  createMarketRegionOrdersRoute,
} = require(path.join(__dirname, "..", "routes", "markets"));

const REGION = 10000002;
const STATION = 60003760;
const SYSTEM = 30000142;
const CONSTELLATION = 20000020;

/** Three pages, and the last one short (see the header). */
const FIXTURE_ORDERS = 2500;
const EXPECTED_PAGES = Math.ceil(FIXTURE_ORDERS / ORDERS_PAGE_SIZE);

/**
 * One clock for both sides.
 *
 * The replica compares the client's `X-Compatibility-Date` against its own
 * reading of today in UTC-11, so a test that let the two drift would fail once a
 * day at 11:00Z for a reason unrelated to pagination.
 */
const NOW = Date.parse("2026-08-23T20:00:00Z");

const REQUEST = Object.freeze({
  headers: Object.freeze({
    Accept: "application/json",
    "X-Compatibility-Date": todayAt(NOW),
  }),
});

// The fixture, and a listener in front of it

/**
 * A book on disk with enough orders to paginate, installed the way production
 * installs one: `lib/marketStore.js` holds a single handle for the process and
 * the routes ask it with no arguments, so the fixture goes in through that same
 * door rather than a second one added for tests.
 */
function fixtureBook(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esi-sweep-"));
  const file = path.join(dir, "market.sqlite");

  const db = new DatabaseSync(file);
  db.exec(MARKET_SCHEMA);

  const order = db.prepare(
    "insert into seed_stock values (?, ?, ?, ?, ?, ?, ?, ?, 1, '2026-08-18T13:04:21.000Z')",
  );
  const type = db.prepare(
    "insert into market_types values (?, 18, 4, 1857, ?, 'Mineral', ?, 0.01, 1, 1)",
  );

  // One transaction: 2,500 individually committed inserts is seconds of disk
  // sync for a throwaway fixture.
  db.exec("begin");
  for (let i = 0; i < FIXTURE_ORDERS; i += 1) {
    const typeId = 34 + i;
    order.run(STATION, SYSTEM, CONSTELLATION, REGION, typeId, 5.5 + i, 100, 250);
    type.run(typeId, `Fixture ${typeId}`, 6.05);
  }
  db.exec("commit");
  db.close();

  openMarketDb({ path: file });
  t.after(() => {
    closeMarketDb();
    fs.rmSync(dir, { force: true, recursive: true });
  });
}

async function serve(t) {
  fixtureBook(t);

  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: createEsiDispatch(
      createRouter([createMarketPricesRoute(), createMarketRegionOrdersRoute()]),
      { now: () => NOW },
    ),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));

  return `http://127.0.0.1:${handle.port}`;
}

const ordersUrl = (base, page) =>
  `${base}/latest/markets/${REGION}/orders/?datasource=${TENANT}&order_type=all&page=${page}`;

/** Every page, in order, as a client walking `X-Pages` would fetch them. */
async function sweep(base, headersFor = () => ({})) {
  const first = await fetch(ordersUrl(base, 1), {
    headers: { ...REQUEST.headers, ...headersFor(1) },
  });
  const pages = Number(first.headers.get("x-pages"));
  const responses = [first];

  for (let page = 2; page <= pages; page += 1) {
    responses.push(await fetch(ordersUrl(base, page), {
      headers: { ...REQUEST.headers, ...headersFor(page) },
    }));
  }

  return responses;
}

// The sweep contract

test("every page carries X-Pages, and every page agrees about it", async (t) => {
  // `PAGINATION.alwaysSent`: absence is not how a client learns a route is
  // unpaginated, and a value that moves mid-sweep makes a downloaded book
  // incoherent. Real clients abort the whole run over it.
  const base = await serve(t);

  const responses = await sweep(base);

  assert.equal(responses.length, EXPECTED_PAGES);
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 200, `page ${index + 1} did not answer 200`);
    assert.equal(
      response.headers.get("x-pages"),
      String(EXPECTED_PAGES),
      `page ${index + 1} disagreed about how many pages there are`,
    );
  }
});

test("one Last-Modified for the resource, one Etag per page", async (t) => {
  // `PAGINATION.lastModifiedPerResource` and `PAGINATION.etagPerPage`: the etag
  // identifies the page, and the Last-Modified identifies the snapshot every page
  // came from.
  const base = await serve(t);

  const responses = await sweep(base);
  const lastModified = new Set(responses.map((r) => r.headers.get("last-modified")));
  const etags = new Set(responses.map((r) => r.headers.get("etag")));

  assert.equal(wire.PAGINATION.lastModifiedPerResource, true, "the contract this asserts");
  assert.equal(lastModified.size, 1, `the pages came from ${lastModified.size} different snapshots`);
  assert.ok([...lastModified][0], "and there is one to share");

  assert.equal(wire.PAGINATION.etagPerPage, true, "the contract this asserts");
  assert.equal(etags.size, EXPECTED_PAGES, "two pages of one resource shared an etag");
});

test("the pages are the whole book, once each, in one order", async (t) => {
  // What the page snapshot promises. A sweep that dropped or repeated an order
  // would still answer 200 on every page, and the loss would surface as a
  // client's wrong prices rather than as an error.
  const base = await serve(t);

  const responses = await sweep(base);
  const bodies = await Promise.all(responses.map((r) => r.json()));
  const orderIds = bodies.flat().map((order) => order.order_id);

  assert.deepEqual(
    bodies.map((page) => page.length),
    [ORDERS_PAGE_SIZE, ORDERS_PAGE_SIZE, FIXTURE_ORDERS - 2 * ORDERS_PAGE_SIZE],
    "the page sizes are the contract's, with the last page short",
  );
  assert.equal(orderIds.length, FIXTURE_ORDERS, "the sweep is missing orders");
  assert.equal(new Set(orderIds).size, FIXTURE_ORDERS, "the sweep saw an order twice");
  assert.deepEqual(orderIds, [...orderIds].sort((a, b) => a - b), "the order is total across pages");
});

test("Expires is measured from Last-Modified, on both market routes", async (t) => {
  // `EXPIRES_BASIS[appSuccess]`: an application route's window is anchored to
  // the data and shrinks as it ages, unlike the gateway's. A client polls on that
  // difference, and half this surface would be wrong if both were computed the
  // same way.
  const base = await serve(t);

  const routes = [
    [ordersUrl(base, 1), ORDERS_CACHE_TTL_SECONDS],
    [`${base}/latest/markets/prices/?datasource=${TENANT}`, PRICES_CACHE_TTL_SECONDS],
  ];

  assert.equal(wire.EXPIRES_BASIS[wire.KIND.APP_SUCCESS], "lastModified");

  for (const [url, ttl] of routes) {
    const response = await fetch(url, REQUEST);
    const lastModified = Date.parse(response.headers.get("last-modified"));
    const expires = Date.parse(response.headers.get("expires"));

    assert.equal(
      response.headers.get("cache-control"),
      wire.CACHE_CONTROL[wire.KIND.APP_SUCCESS](ttl),
      `${url} did not send the application's Cache-Control`,
    );
    assert.equal(expires - lastModified, ttl * 1000, `${url} measured Expires from something else`);
  }
});

test("a second sweep with the stored validators is 304s, every page", async (t) => {
  // A client that walked the book once and kept the etags re-walks it for free.
  // This is the property the acceptance run is written around, and every caching
  // client depends on it. `CONDITIONAL[appSuccess]`: the application compares
  // strongly, so what it gave us is what we send back.
  const base = await serve(t);

  const first = await sweep(base);
  const etags = first.map((response) => response.headers.get("etag"));

  const second = await sweep(base, (page) => ({ "If-None-Match": etags[page - 1] }));

  for (const [index, response] of second.entries()) {
    assert.equal(response.status, 304, `page ${index + 1} re-sent a body`);
    assert.equal(await response.text(), "", `page ${index + 1} sent bytes with its 304`);
  }
});

test("a 304 mid-sweep still says which snapshot it validated", async (t) => {
  // `NOT_MODIFIED_SENDS[appSuccess]`, header for header. RFC 9110 has a 304
  // update the stored response, so a client refreshing metadata from one that
  // dropped `Last-Modified` loses the field that ties its stored pages to one
  // snapshot.
  const base = await serve(t);

  const [page] = await sweep(base);
  const etag = page.headers.get("etag");

  const revalidated = await fetch(ordersUrl(base, 1), {
    headers: { ...REQUEST.headers, "If-None-Match": etag },
  });

  const sends = wire.NOT_MODIFIED_SENDS[wire.KIND.APP_SUCCESS];
  assert.equal(revalidated.status, 304);
  assert.equal(sends.etag && sends.lastModified, true, "the contract this asserts");
  assert.equal(revalidated.headers.get("etag"), etag, "the validator it matched");
  assert.equal(
    revalidated.headers.get("last-modified"),
    page.headers.get("last-modified"),
    "the snapshot the page came from",
  );
  assert.equal(
    revalidated.headers.get("cache-control"),
    wire.CACHE_CONTROL[wire.KIND.APP_SUCCESS](ORDERS_CACHE_TTL_SECONDS),
  );
  assert.ok(revalidated.headers.get("expires"), "recomputed, not echoed, but present");
  assert.equal(revalidated.headers.get("x-compatibility-date"), wire.COMPATIBILITY_DATE);

  // Settled against Tranquility on 2026-08-24. Both paginated routes send
  // `X-Pages` on a 304: `/markets/{region}/orders/` answered `X-Pages: 414`, and
  // `/contracts/public/` answered `35`. This replica used to drop it. A client
  // that keeps the page count in its cache entry refreshes it from a 304, so an
  // absent header is a sweep that stops after page one.
  assert.equal(sends.xPages, true, "the contract this asserts");
  assert.equal(
    revalidated.headers.get("x-pages"),
    String(EXPECTED_PAGES),
    "the 304 dropped X-Pages",
  );

  // Observed in the same two requests, and lost by the same rebuild.
  assert.equal(sends.contentLanguage, true);
  assert.equal(revalidated.headers.get("content-language"), wire.CONTENT_LANGUAGE);
});

test("the cache headers a sweep is walked on parse as a client parses them", async (t) => {
  // Deliberately mechanical: `max-age` is read with a regex and `Expires` with
  // `Date.parse`, as a client does. A header that is correct but unparseable
  // expires the entry on write, and the next run re-downloads the whole book
  // without reporting anything wrong.
  const base = await serve(t);

  const response = await fetch(ordersUrl(base, 1), REQUEST);
  const cacheControl = response.headers.get("cache-control");

  assert.ok(/^public(,|$)/.test(cacheControl), `unparseable Cache-Control: ${cacheControl}`);
  assert.ok(Number.isFinite(Date.parse(response.headers.get("expires"))), "Expires must parse");
  assert.ok(
    Number.isFinite(Date.parse(response.headers.get("last-modified"))),
    "Last-Modified must parse",
  );
  assert.match(response.headers.get("etag"), /^"[0-9a-f]{56}"$/, "the application's strong SHA-224");
});
