/**
 * Is the market daemon's schema still what the mod assumes?
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * `lib/marketStore.js` reads a database that belongs to a sibling service (D29),
 * not to this repository or the eve.js source tree. Game modules have a drift
 * detector for the same class of assumption (`test/runtimeAccess.test.js`).
 *
 * The other tests cannot see this drift. `test/marketsContract.test.js` builds
 * its fixture from a `create table` transcribed by hand out of
 * `pragma table_info` on the live database, so the fixture and the code drift
 * together. Renaming `quantity` to `volume_remaining` upstream would leave all
 * fourteen of those tests passing while production serves an empty book or an
 * error on every request. This file compares against the real database when it
 * is reachable, and skips with a reason when it is not.
 *
 * Columns: `REQUIRED_COLUMNS` in `lib/marketStore.js` is the module's own list of
 * what it reads, `where` clauses included. Every one has to exist.
 *
 * The seeded primary key is `(station_id, type_id)`, which the `order_id`
 * synthesis rests on. It is asserted as the declared key rather than counted
 * over the rows: a daemon that started storing one row per price level would
 * have to change the key, and this fails then, not when two orders collide in a
 * client's cache.
 *
 * Values, not just names: the `state` spellings, `bid` in 0/1, `published` in
 * 0/1. A rename is loud, but a re-spelling of `'active'` puts cancelled orders
 * on the market and looks normal. The `state` check asks whether every spelling
 * present is one this repository knows, not whether an active order exists.
 * This server holds one player order and it is cancelled, which is a quiet
 * market rather than a broken one.
 *
 * The region indexes are not about correctness: D29's ~198 ms budget assumes
 * them, and losing one turns a region sweep into a full scan on the event loop
 * the universe ticks on (design constraint 2).
 *
 * The gate is not `EVEJS_REPO_ROOT`. That variable points at a source checkout,
 * and this database lives in the data directory (`/var/lib/evejs/market/
 * market.sqlite` in a container, `_local/market/` on a host), so a dev box
 * routinely has the tree and not the book. `lib/runtimeAccess.js`
 * `getMarketDbPath()` resolves it as a sibling of the store root, and
 * `ESI_MOD_MARKET_DB` overrides that where the running database is inside a
 * Docker volume.
 *
 * Copy the sidecars too. The daemon runs in WAL mode, so recent writes live in
 * `market.sqlite-wal` until a checkpoint folds them in. Copying the main file
 * alone gives the last checkpoint, and every row written since is invisible:
 * the test does not fail, it checks less.
 *
 *   docker cp evejs-server-1:/var/lib/evejs/market/market.sqlite     %TEMP%\market.sqlite
 *   docker cp evejs-server-1:/var/lib/evejs/market/market.sqlite-wal %TEMP%\market.sqlite-wal
 *   docker cp evejs-server-1:/var/lib/evejs/market/market.sqlite-shm %TEMP%\market.sqlite-shm
 *   set ESI_MOD_MARKET_DB=%TEMP%\market.sqlite
 *
 * A copy is otherwise enough: this reads schema and a few `distinct` values,
 * never bulk data, and it opens read-only.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  RANGE_BY_VALUE,
  REQUIRED_COLUMNS,
  SCHEMA_ASSUMPTIONS,
} = require(path.join(__dirname, "..", "lib", "marketStore"));
const { MARKET_DB_ENV, MARKET_SCHEMA, findMarketDb } = require(
  path.join(__dirname, "marketFixture"),
);

// The resolver is shared with `vendorPresence.test.js`, which refuses a strict
// run that would skip these, so the gate and the guard cannot disagree about
// whether a book is reachable.
const MARKET_DB = findMarketDb();

const SKIP_REASON =
  "no market database found: set " + MARKET_DB_ENV + " to one (a copy is fine; this reads "
  + "schema, not data) to run the market schema-drift checks";

const marketOnly = MARKET_DB ? {} : { skip: SKIP_REASON };

/** Read-only, and lazily, so a machine without `node:sqlite` skips rather than throws. */
function openLiveDb(t) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(MARKET_DB, { readOnly: true });
  t.after(() => db.close());
  return db;
}

const columnsOf = (db, table) =>
  db.prepare(`pragma table_info(${table})`).all().map((column) => column.name);

// Columns

test("every column lib/marketStore.js reads still exists upstream", marketOnly, (t) => {
  const db = openLiveDb(t);
  const missing = [];

  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const live = new Set(columnsOf(db, table));

    if (live.size === 0) {
      missing.push(`  ${table}: the table itself is gone`);
      continue;
    }
    for (const column of columns) {
      if (!live.has(column)) missing.push(`  ${table}.${column}`);
    }
  }

  // The whole list at once: a drift is usually a rename of several columns, and
  // finding them one failing run apiece is the difference between an afternoon
  // and a minute.
  assert.deepEqual(
    missing,
    [],
    `the market daemon's schema has moved under lib/marketStore.js (${MARKET_DB}):\n`
    + `${missing.join("\n")}\n\n`
    + "Every one of those is read by a query in that file. Fix the queries, then "
    + "update the transcription in test/marketFixture.js so the mapping tests "
    + "describe the same database.",
  );
});

test("the fixture transcription is still the shape of the real tables", marketOnly, (t) => {
  // Every mapping test stands on the transcription, and nothing else compares it
  // to its source. Column order matters as well as membership:
  // `test/marketsContract.test.js` inserts with positional
  // `insert into seed_stock values (...)`, so a column added upstream in the
  // middle would shift every value in those fixtures one place to the left.
  const db = openLiveDb(t);

  for (const table of Object.keys(REQUIRED_COLUMNS)) {
    const declared = MARKET_SCHEMA.match(
      new RegExp(`create table ${table}\\s*\\(([^;]*)\\)`, "i"),
    );
    assert.ok(declared, `test/marketFixture.js has no create table for ${table}`);

    const transcribed = declared[1]
      .split(",")
      .map((column) => column.trim().split(/\s+/)[0])
      .filter(Boolean);

    assert.deepEqual(
      transcribed,
      columnsOf(db, table),
      `test/marketFixture.js's ${table} no longer matches the live database. Every mapping `
      + "test builds on that transcription, so they are all describing a database that no "
      + "longer exists: re-transcribe it from `pragma table_info`.",
    );
  }
});

// The key the order_id synthesis rests on

test("(station_id, type_id) is still the primary key of both seeded tables", marketOnly, (t) => {
  // `lib/marketStore.js` synthesises `order_id` from this pair. If the daemon
  // ever stores one row per price level, two seeded orders share an id, and a
  // client keying on `order_id` (market-hub-seed does) corrupts its own cache
  // silently. The key is what would have to change first.
  const db = openLiveDb(t);

  for (const table of ["seed_stock", "seed_buy_orders"]) {
    const unique = db.prepare(`pragma index_list(${table})`).all()
      .filter((index) => index.unique && index.origin === "pk");

    assert.equal(unique.length, 1, `${table} has no declared primary key any more`);

    const key = db.prepare(`pragma index_info(${unique[0].name})`).all().map((c) => c.name);
    assert.deepEqual(
      key,
      [...SCHEMA_ASSUMPTIONS.seededKey],
      `${table}'s primary key is now ${JSON.stringify(key)}. The order_id synthesis in `
      + "lib/marketStore.js assumes one seeded row per (station_id, type_id) per side; "
      + "with this key it can produce two orders with the same id.",
    );
  }
});

test("no two seeded rows share a synthesised order_id, on the real book", marketOnly, (t) => {
  // The key says it cannot happen. This says it has not: cheap on an indexed
  // pair, and it survives someone dropping the key and adding a plain index.
  const db = openLiveDb(t);

  for (const table of ["seed_stock", "seed_buy_orders"]) {
    const [{ rows, keys }] = db.prepare(
      `select count(*) rows, count(distinct station_id || ':' || type_id) keys from ${table}`,
    ).all();

    assert.equal(
      keys,
      rows,
      `${table} has ${rows - keys} row(s) that would collide on a synthesised order_id`,
    );
  }
});

// Values

test("the values lib/marketStore.js branches on are still the values stored", marketOnly, (t) => {
  const db = openLiveDb(t);
  const distinct = (table, column) =>
    db.prepare(`select distinct ${column} v from ${table}`).all().map((row) => row.v);
  const problems = [];

  // Collected rather than asserted one at a time: a daemon that changed how it
  // spells things changed several of them, and reporting only the first sends
  // someone to fix one branch and rediscover the rest on the next run.

  // `state = 'active'` is the filter that keeps cancelled and filled orders off
  // the market, and a re-spelling of any state breaks it in one of two directions
  // without looking broken.
  //
  // Asserted: every spelling present is one this repository knows. Not asserted:
  // that an active order exists. This server holds one player order and it is
  // cancelled, which is a quiet market, not drift. "No active orders" and "the
  // word for active changed" give the same empty result, so only the vocabulary
  // separates them.
  const unknownStates = distinct("market_orders", "state")
    .filter((state) => !SCHEMA_ASSUMPTIONS.knownStates.includes(state));
  if (unknownStates.length > 0) {
    problems.push(
      `  market_orders.state holds ${JSON.stringify(unknownStates)}, which is not one of `
      + `${JSON.stringify(SCHEMA_ASSUMPTIONS.knownStates)}: readRegionOrders filters on `
      + `"${SCHEMA_ASSUMPTIONS.activeState}", so an unknown spelling either hides live orders `
      + "or puts dead ones on the market",
    );
  }

  const unexpectedBids = distinct("market_orders", "bid")
    .filter((bid) => !SCHEMA_ASSUMPTIONS.bidValues.includes(bid));
  if (unexpectedBids.length > 0) {
    problems.push(
      `  market_orders.bid holds ${JSON.stringify(unexpectedBids)}, which is not 0/1: `
      + "is_buy_order compares against 1 and reads anything else as a sell order",
    );
  }

  const unexpectedPublished = distinct("market_types", "published")
    .filter((published) => !SCHEMA_ASSUMPTIONS.publishedValues.includes(published));
  if (unexpectedPublished.length > 0) {
    problems.push(
      `  market_types.published holds ${JSON.stringify(unexpectedPublished)}, and `
      + "/markets/prices/ gates on `published = 1`: anything else silently drops types",
    );
  }

  assert.deepEqual(
    problems,
    [],
    `the market daemon still has the columns, and stores different things in them:\n${problems.join("\n")}`,
  );
});

test("every range_value in the book maps to an ESI range string", marketOnly, (t) => {
  // The two sentinels (-1, 32767) are confirmed against the vendor tree. The
  // intermediate jump ranges in RANGE_BY_VALUE are extrapolated from EVE
  // convention and unverified: the daemon writes only the sentinels at the call
  // sites surveyed, and market_orders is empty on a server nobody has played on.
  // The first player-placed order with a jump range is the first real
  // observation, and this test notices it arriving.
  const db = openLiveDb(t);

  const values = db.prepare("select distinct range_value v from market_orders").all()
    .map((row) => row.v);
  const unmapped = values.filter((value) => RANGE_BY_VALUE[String(value)] === undefined);

  assert.deepEqual(
    unmapped,
    [],
    `market_orders holds range_value ${JSON.stringify(unmapped)}, which RANGE_BY_VALUE does not `
    + "map. placedOrder falls back to \"station\" for those, which is a wrong answer that looks "
    + "like an answer: check what the client shows for that order and record it.",
  );
});

// The performance assumption D29 rests on

test("the region indexes D29's 198 ms budget assumes are still there", marketOnly, (t) => {
  const db = openLiveDb(t);

  const present = new Set(
    db.prepare("select name from sqlite_master where type = 'index'").all().map((r) => r.name),
  );
  const gone = SCHEMA_ASSUMPTIONS.regionIndexes.filter((index) => !present.has(index));

  assert.deepEqual(
    gone,
    [],
    `these indexes are gone: ${gone.join(", ")}. A region sweep reads every order in the region `
    + "in one query, on the event loop the universe ticks on: without the region index that is "
    + "a full scan of ~970,000 rows per cache window (design constraint 2).",
  );
});
