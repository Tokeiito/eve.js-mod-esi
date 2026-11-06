/**
 * The market daemon's schema, transcribed once.
 *
 * `lib/marketStore.js` reads a database this repository does not own, so tests
 * of it use a fixture shaped like the real tables. The column names and types
 * below are `pragma table_info` output from the live `market.sqlite`.
 *
 * It is shared by `marketsContract.test.js`, `marketSweepContract.test.js` and
 * `marketSchemaDrift.test.js`, so a schema change in the daemon is one update.
 *
 * Rows are not here. Each test owns its fixture data: the mapping tests want
 * three orders of known shape, the sweep wants enough to paginate.
 *
 * A fixture cannot notice the daemon renaming a column: the transcription and
 * the code drift together and the mapping tests stay green. `marketSchemaDrift.test.js`
 * is the guard. It compares this transcription, and `lib/marketStore.js`'s own
 * list of the columns it reads, against a real database when one is reachable
 * (see `findMarketDb` below). With no database the drift check skips and this
 * transcription is the only description there is.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { getMarketDbPath } = require(path.join(__dirname, "..", "lib", "runtimeAccess"));

/**
 * Where a real market database is, for the drift checks, or `null`.
 *
 * `EVEJS_REPO_ROOT` cannot answer this: it names a source checkout, and the
 * daemon's database lives in the data directory
 * (`/var/lib/evejs/market/market.sqlite` in a container, `_local/market/` on a
 * host). The mod's own resolver knows where it would be; `ESI_MOD_MARKET_DB`
 * overrides it when the running database is inside a Docker volume.
 *
 * Shared between `marketSchemaDrift.test.js`, which uses it to gate, and
 * `vendorPresence.test.js`, which uses it to refuse a strict run that would
 * skip, so the gate and the guard agree on whether a database is reachable.
 */
const MARKET_DB_ENV = "ESI_MOD_MARKET_DB";

function findMarketDb(env = process.env) {
  const override = String(env[MARKET_DB_ENV] ?? "").trim();
  if (override) return fs.existsSync(override) ? path.resolve(override) : null;

  const derived = getMarketDbPath();
  return derived && fs.existsSync(derived) ? derived : null;
}

/** `pragma table_info`, transcribed from the live market.sqlite. */
const MARKET_SCHEMA = `
  create table seed_stock (station_id integer, solar_system_id integer,
    constellation_id integer, region_id integer, type_id integer, price real,
    quantity integer, initial_quantity integer, price_version integer, updated_at text);
  create table seed_buy_orders (station_id integer, solar_system_id integer,
    constellation_id integer, region_id integer, type_id integer, price real,
    quantity integer, initial_quantity integer, price_version integer, updated_at text);
  create table market_orders (order_id integer, owner_id integer, is_corp integer,
    wallet_division integer, station_id integer, solar_system_id integer,
    constellation_id integer, region_id integer, type_id integer, price real,
    vol_entered integer, vol_remaining integer, min_volume integer, bid integer,
    range_value integer, duration_days integer, escrow real, state text, source text,
    issued_at text, last_state_change_at text, updated_at text);
  create table market_types (type_id integer, group_id integer, category_id integer,
    market_group_id integer, name text, group_name text, base_price real, volume real,
    portion_size integer, published integer);
  create table region_summaries (region_id integer, type_id integer, best_ask_price real,
    total_ask_quantity integer, best_ask_station_id integer, best_bid_price real,
    total_bid_quantity integer, best_bid_station_id integer, updated_at text);
`;

module.exports = Object.freeze({ MARKET_DB_ENV, MARKET_SCHEMA, findMarketDb });
