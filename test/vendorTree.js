/**
 * eve.js-mod-esi: locating the eve.js vendor tree from a test
 *
 * Almost all of this suite loads no game code and needs nothing but Node. A
 * handful of tests are vendor-drift detectors: they read real files out of an
 * eve.js checkout to prove the mod's assumptions about upstream still hold,
 * above all that every path in `lib/runtimeAccess.js`'s `GAME_MODULES` still
 * names a file that exists.
 *
 * Those tests need a tree to read. The mod's source lives in its own repository
 * and is only deployed into `<eve.js tree>/mods/esiApi/`, so walking upward from this
 * file finds an eve.js checkout in a deployment and nothing in a source
 * checkout. Hence one explicit way to say where a tree is: `EVEJS_REPO_ROOT`,
 * pointing at the directory that contains `server/src` (`<eve.js tree>`, not
 * `<eve.js tree>/server/src`).
 *
 * Order, the same as `lib/runtimeAccess.js` uses at runtime, because it is that
 * module's own resolver:
 *
 *   1. `EVEJS_REPO_ROOT`, if it names a real eve.js tree.
 *   2. The upward walk, so a deployed copy still works with nothing set.
 *
 * Sharing the resolver means "is this an eve.js tree?" cannot answer
 * differently in a test than in production.
 *
 * When neither finds one, `REPO_ROOT` is null and the vendor-dependent tests
 * skip with a reason rather than failing or quietly passing. A machine with no
 * eve.js checkout runs the rest of the suite green; a machine with one still
 * catches drift. Do not "fix" a skip by weakening what a test asserts; point it
 * at a tree instead.
 *
 * A skipped drift check and a passing one both exit 0, so a run that checked
 * nothing looks like a run that checked everything. `ESI_MOD_REQUIRE_VENDOR=1`
 * buys the guarantee back for CI and release checks: it changes what no test
 * asserts, and makes the absence of a tree a failure, through the single guard
 * in `vendorPresence.test.js`.
 *
 * This file is shared: vendor-dependent tests import `vendorOnly` from here
 * rather than growing a second skip rule.
 */

"use strict";

const path = require("node:path");

const { findServerSrc } = require(path.join(__dirname, "..", "lib", "runtimeAccess"));

/** The mod's root: the directory this repository's contents get deployed as. */
const MOD_DIR = path.resolve(__dirname, "..");

// The same probe the mod uses at runtime. `findServerSrc` with an explicit
// second argument is the override-then-walk resolver; passing `MOD_DIR` rather
// than `__dirname` makes the walk start where a deployment starts it.
const SERVER_SRC = findServerSrc(MOD_DIR, process.env.EVEJS_REPO_ROOT);

/** `<root>` such that `<root>/server/src` is the vendor source, or `null`. */
const REPO_ROOT = SERVER_SRC ? path.resolve(SERVER_SRC, "..", "..") : null;

const SKIP_REASON =
  "no eve.js vendor tree found: set EVEJS_REPO_ROOT to an eve.js checkout "
  + "(the directory containing server/src) to run the vendor-drift checks";

/**
 * Spread into a `test()` call as its options argument: `{}` runs the test
 * normally, `{ skip: reason }` reports it as skipped and says why.
 *
 * `node:test` prints the reason beside the skipped test, which is how a
 * developer on a machine with no game server learns that something went
 * unchecked rather than assuming everything passed.
 */
const vendorOnly = REPO_ROOT ? {} : { skip: SKIP_REASON };

/**
 * Is this a run that refuses to skip the drift checks?
 *
 * Off by default, so the ordinary case (a machine that may or may not have a
 * game server on it) is unchanged. Set it where a green run is going to be
 * trusted: then a missing tree fails instead of skipping.
 *
 * Generous about what counts as "off", because getting this wrong is
 * asymmetric. Reading `ESI_MOD_REQUIRE_VENDOR=false` as true costs a confusing
 * failure on a machine that never wanted strictness; reading `=1` as false
 * silently costs the entire guarantee. So anything that plainly reads as off is
 * off, and everything else, including a bare `=1`, is on.
 */
const OFF = new Set(["", "0", "false", "no", "off"]);
const REQUIRE_VENDOR = !OFF.has(
  String(process.env.ESI_MOD_REQUIRE_VENDOR ?? "").trim().toLowerCase(),
);

module.exports = {
  MOD_DIR,
  REPO_ROOT,
  REQUIRE_VENDOR,
  SERVER_SRC,
  SKIP_REASON,
  vendorOnly,
};
