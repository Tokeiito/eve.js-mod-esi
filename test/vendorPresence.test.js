/**
 * eve.js-mod-esi: a skipped drift check must not read as a passing one
 *
 * Run with: node --test "test/**\/*.test.js"   (from the mod directory)
 *
 * The vendor-drift tests skip when there is no eve.js checkout to read, which
 * keeps the suite green on a machine with no game server. That is the right
 * default, since requiring a multi-gigabyte game install to run a unit suite
 * would be a worse trade. It has one consequence: both states exit 0.
 *
 *   tests 59 / pass 59 / fail 0 / skipped 0     <- drift actually checked
 *   tests 59 / pass 55 / fail 0 / skipped 4     <- drift checked nothing
 *
 * The counts differ but the exit code does not, and automation reads the exit
 * code. So a run whose result is going to be trusted sets
 * `ESI_MOD_REQUIRE_VENDOR=1`, and the absence of a tree becomes a failure here.
 *
 * This adds no assertion about upstream and weakens none. A skip is never
 * "fixed" by making a test ask for less; this file asserts only that the
 * conditions for those tests to run were met. The drift tests remain the only
 * thing that knows what drift is.
 *
 * This file is shared infrastructure: new vendor-gated tests add a row to
 * `GATED` below rather than inventing a second strictness mechanism.
 *
 * Only checks that read this install (a real eve.js tree, a real deployment)
 * belong here. A suite check must not depend on somebody else's software, or a
 * green run means "their software was installed" as much as "our contract
 * holds". Running `market-hub-seed` for real is end-to-end acceptance and lives
 * in `scripts/market-canary.js`, outside this suite; the contract it stands in
 * for is asserted from the pinned spec and the recorded wire survey in
 * `marketSweepContract.test.js`, which needs nothing but this repository.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { REPO_ROOT, REQUIRE_VENDOR } = require(path.join(__dirname, "vendorTree"));
const { findMarketDb } = require(path.join(__dirname, "marketFixture"));
const { findClientConst } = require(path.join(__dirname, "clientConstants"));

// The tests that go quiet when there is no tree, so the failure below can say
// what was lost rather than "some tests skipped". Counts are the per-file
// totals gated on the named gate.
//
// A gate may be stricter than "is there a tree": `deployDrift.test.js` also
// stands down when a tree exists but the mod has never been deployed into it.
// A strict run should not fail on that: there is nothing to compare, and it is
// the state of every tree before the first deploy. `node scripts/deploy-mod.js
// --check` is the form that exits non-zero on it, and a release step runs it.
const GATED = [
  {
    file: "rolesContract.test.js",
    count: 1,
    gate: "vendorOnly",
    needs: "vendor-tree",
    what: "that routes/roles.js CORPORATION_ROLE_BITS still matches the corporation role "
      + "constants eve.js declares. The mapping is 46 bits whose eve.js constant name *is* "
      + "CCP's role name, and it is exactly the kind of table that rots silently: a bit "
      + "renamed upstream stops being emitted, and a bit *added* upstream in the "
      + "identically-numbered GM namespace would start being emitted as a corporation role "
      + "if the walk stopped checking. UNMAPPED_ROLE_BITS is the other half: nine bits this "
      + "replica deliberately never emits (D32), and a test that stopped running would let "
      + "one of them quietly acquire a name.",
  },
  {
    file: "structuresContract.test.js",
    count: 1,
    gate: "vendorOnly",
    needs: "vendor-tree",
    what: "that eve.js's structure-state vocabulary still says what routes/structures.js maps "
      + "onto CCP's `state` enum. The success body of this endpoint has never been observed ("
      + "three capture runs hit the role refusal), so the vendor tree is the only thing this "
      + "mapping can be checked against at all, which makes the check load-bearing rather "
      + "than a nicety.",
  },
  {
    file: "contactsContract.test.js",
    count: 1,
    gate: "vendorOnly",
    needs: "vendor-tree",
    what: "that eve.js still declares the four owner typeIDs routes/contacts.js maps onto CCP's "
      + "contact_type enum, and still keeps contacts where the three buckets read them. Both "
      + "halves fail silently rather than loudly if they drift: a changed typeID drops every "
      + "contact of that kind as unnameable, and a renamed store empties a bucket outright, "
      + "which eve-nexum acts on by deleting every standing it holds for that owner. Nothing "
      + "else in the suite can notice either, because the doubles supply the shape.",
  },
  {
    file: "entitiesContract.test.js",
    count: 2,
    gate: "vendorOnly",
    needs: "vendor-tree",
    what: "that eve.js still numbers gender the way routes/entities.js maps it onto CCP's "
      + "two-value enum, and still exports the three accessors the four public entity lookups "
      + "read. The gender one is the sharper of the pair: 0 and 1 are female and male on the "
      + "authority of a comment eve.js carries citing the client's own constant table, and a "
      + "vendor drop that renumbered them would publish the wrong pronoun for every character "
      + "on the server with nothing else in the suite able to notice, because the doubles "
      + "supply whatever number the test hands them. The accessor check reads the export lists "
      + "as source text rather than requiring the modules, which both pull in the gameStore and "
      + "open SQLite, so a missing getAllianceRecord shows up here as drift rather than as "
      + "every alliance lookup answering 500 in production.",
  },
  {
    file: "runtimeAccess.test.js",
    count: 13,
    gate: "vendorOnly",
    needs: "vendor-tree",
    what: "every path in GAME_MODULES still existing upstream; that isRuntimeReachable() "
      + "probes without loading the game runtime module; that gameStore/storeRoot still "
      + "answers where this install keeps its data, and where the three durable SSO "
      + "credentials derived from it go: the signing key (D8), the refresh token "
      + "store (D30) and the owner-claim salt; that "
      + "services/chat/chatHub still takes the arity the bind reply passes it; that "
      + "gameStore/tableRepository still throws OwnershipViolationError on a "
      + "mod:esiApi write; that online/characterControlRuntime still answers with the "
      + "snapshot shape /characters/{id}/online/ reads, still throws rather than answering "
      + "falsy for a bad id, and is still what the game's own presence check derives from;"
      + " that structureState still runs tickStructures (and still persists) unless "
      + "refresh is false, which is the whole reason STRUCTURE_READ_OPTIONS exists, and "
      + "still clones its list rows while handing back the by-id row live; that "
      + "corporationRuntimeState.getCorporationMember and corporationState.getCorporationRecord "
      + "are still the non-writing pair the roles route is composed from, while "
      + "getCorporationSessionRoleState still takes its member from the ensureCharacterMemberState that "
      + "persists a default member record (the check that keeps the refusal to use it from "
      + "going stale); and that fleetRuntime still keeps fleets in memory and hands out "
      + "the live object both peek accessors project from, with getBossCharacterID still "
      + "unexported; and that the two halves of the waypoint push are still where the "
      + "accessor reaches for them: chat/sessionRegistry still exporting "
      + "findSessionByCharacterID with the (characterID, options) shape, and clientSession "
      + "still defining sendNotification(notifyType, idType, payloadTuple) with the "
      + "destroyed-socket guard that is why a push can never report delivery (D34). "
      + "That second one is the only vendor check in this suite covering something that is "
      + "not a module export at all: sendNotification is a method on the session the "
      + "registry hands back, so GAME_MODULES cannot see it move",
  },
  {
    file: "sessionIdentity.test.js",
    count: 2,
    gate: "vendorOnly",
    needs: "vendor-tree",
    what: "whether the session-field alias lists lib/sessionIdentity.js reads through still "
      + "appear upstream, and whether the copied GM role bits still match the vendor's own "
      + "literals: the two checks standing between a bind code and a token minted for the "
      + "wrong character, or for nobody",
  },
  {
    file: "configLayers.test.js",
    count: 1,
    gate: "vendorOnly",
    needs: "vendor-tree",
    what: "whether config.js's reserved list still covers every port eve.js's Dockerfile "
      + "and compose.yaml declare: the check that keeps a mis-set port from stopping the game",
  },
  {
    file: "deployDrift.test.js",
    count: 1,
    gate: "deployedOnly",
    needs: "vendor-tree",
    what: "whether <eve.js tree>/mods/esiApi is still this source: the check that catches an "
      + "edit that never reached the server that loads it",
  },
  {
    file: "marketSchemaDrift.test.js",
    count: 7,
    gate: "marketOnly",
    needs: "market-db",
    what: "whether the market daemon's schema is still the one lib/marketStore.js reads: the "
      + "columns, the (station_id, type_id) primary key the order_id synthesis rests on, the "
      + "values it branches on, and the region indexes D29's 198 ms budget assumes",
  },
  {
    file: "locationFlags.test.js",
    count: 7,
    gate: "clientOnly",
    needs: "client-const",
    what: "lib/locationFlags.js against CCP's own flagXxx = <id> table, read out of a "
      + "decompiled client (D46). This is the only check of the *id* half of that join: the "
      + "document is authoritative for the names and eve.js declares only the ids it happens "
      + "to use, so a row for a flag eve.js never writes (flag 0, which is every container's "
      + "contents, is exactly that) has nothing else standing behind it. It is also what "
      + "keeps two arguments from going stale: that 0 is AutoFit because CCP gives the id "
      + "those two names and publishes one of them, and that 134's derivation still empties "
      + "both sets",
  },
];

/** Rows whose gate waits on one dependency. */
const gatedOn = (needs) => GATED.filter((row) => row.needs === needs);

/** "3 checks would not have run:" and the list of what they were. */
function lostDescription(rows) {
  const total = rows.reduce((n, row) => n + row.count, 0);
  const lost = rows.map((row) => `  - ${row.file} (${row.count}): ${row.what}`).join("\n");
  return `${total} checks would not have run:\n${lost}`;
}

test("a run that demands the drift checks has a vendor tree to run them against", () => {
  if (!REQUIRE_VENDOR) {
    // Not a strict run. Skipping is permitted here and says so in the reason
    // printed beside each skipped test; there is nothing to prove.
    return;
  }

  if (REPO_ROOT) return;

  assert.fail(
    "ESI_MOD_REQUIRE_VENDOR is set, but no eve.js vendor tree was found, so the "
    + "vendor-drift checks would have skipped and this run would have reported "
    + `success without checking anything.\n\n`
    + `${lostDescription(gatedOn("vendor-tree"))}\n\n`
    + "Set EVEJS_REPO_ROOT to an eve.js checkout (the directory containing "
    + "server/src) or unset ESI_MOD_REQUIRE_VENDOR to allow a run that skips them.",
  );
});

test("a run that demands the drift checks has the market book to run them against", () => {
  // The same argument, one dependency over, and a different dependency.
  // `EVEJS_REPO_ROOT` names a source checkout; the daemon's database lives in
  // the data directory, so a dev box routinely has the tree and not the book.
  // Folded into the same flag, because "this run is going to be trusted" is one
  // fact about a run: a strict run that skipped this exited 0 having never
  // compared the mod's assumptions to the database they are about.
  if (!REQUIRE_VENDOR) return;
  if (findMarketDb()) return;

  assert.fail(
    "ESI_MOD_REQUIRE_VENDOR is set, but no market database was found, so the schema-drift "
    + `checks would have skipped and this run would have reported success without them.\n\n`
    + `${lostDescription(gatedOn("market-db"))}\n\n`
    + "Set ESI_MOD_MARKET_DB to a market.sqlite: a copy is fine, this reads schema and a "
    + "few distinct values, never bulk data. On a Docker install the running one is inside "
    + "the volume:\n"
    + "  docker cp evejs-server-1:/var/lib/evejs/market/market.sqlite <somewhere>\n\n"
    + "Copy the -wal and -shm sidecars beside it: the daemon runs in WAL mode, so the main "
    + "file alone is the last checkpoint and every row written since is invisible.",
  );
});

test("a run that demands the drift checks has CCP's flag table to run them against", () => {
  // The same argument again, one dependency further out: a decompiled client
  // belongs to neither repository and is nobody's build artifact. It is still
  // folded into the one flag, because "this run is going to be trusted" remains
  // one fact about a run, and because these checks stand over a table whose id
  // half nothing else can see.
  if (!REQUIRE_VENDOR) return;
  if (findClientConst()) return;

  assert.fail(
    "ESI_MOD_REQUIRE_VENDOR is set, but no decompiled client was found, so the flag-table "
    + `checks would have skipped and this run would have reported success without them.\n\n`
    + `${lostDescription(gatedOn("client-const"))}\n\n`
    + "Set ESI_MOD_CLIENT_ROOT to the root of a client dump: the directory containing "
    + "inventorycommon/const.py, matched to this install's build, which is the build "
    + "/status/ reports as server_version (D12). Or unset ESI_MOD_REQUIRE_VENDOR to allow a "
    + "run that skips them.",
  );
});

/**
 * The list above is a claim about other files, so it can rot, invisibly: a
 * wrong count only appears inside a failure message nobody sees on a healthy
 * run, and a strict run then understates its own gap.
 *
 * So count the gates in the sources. Not every mention of the name (a file
 * that explains its gate in its header would count one too many, and
 * subtracting known mentions is the same rot one level down), but the only
 * position that gates anything: the options argument of a `test(...)` call,
 * immediately before the test body.
 *
 * Crude, and it only has to fail when someone adds a gated test and leaves
 * this table alone.
 */

/**
 * The counts above are one half of the claim. The other half is that the table
 * names every file there is.
 *
 * `sessionIdentity.test.js` once arrived with two vendor-gated tests and no
 * row, and the loop below could not notice: it iterates `GATED`, so a file
 * nobody listed is a file nobody counts. That is the same rot one level up from
 * a wrong number, failing in the same direction.
 *
 * So the sources are the authority for which files gate, as they already are
 * for how many.
 */
test("every test file that gates on a vendor dependency has a row in GATED", () => {
  const listed = new Set(GATED.map((row) => row.file));
  const gates = [...new Set(GATED.map((row) => row.gate))];

  // This file is skipped over itself: it describes the gates rather than using
  // them, so the worked example in the comment below (a `test(...)` call with
  // `vendorOnly` in the options position) matches the pattern this scan looks
  // for. That is the hazard the loop below already names, a file that explains
  // its gate counting one too many.
  const self = path.basename(__filename);

  const unlisted = fs.readdirSync(__dirname)
    .filter((file) => file.endsWith(".test.js") && file !== self && !listed.has(file))
    .filter((file) => {
      const source = fs.readFileSync(path.join(__dirname, file), "utf8");
      return gates.some((gate) =>
        new RegExp(`\\b${gate}\\s*,\\s*(?:async\\s+)?(?:\\(|function\\b)`).test(source));
    });

  assert.deepEqual(
    unlisted,
    [],
    "these test files gate tests on a vendor dependency and are not in the GATED table, so a "
    + "strict run would not report them as unchecked: " + unlisted.join(", "),
  );
});

test("the list of vendor-gated tests matches what the test files actually gate", () => {
  for (const { file, count: expected, gate } of GATED) {
    const full = path.join(__dirname, file);
    assert.equal(fs.existsSync(full), true, `GATED names a missing file: ${file}`);

    const source = fs.readFileSync(full, "utf8");
    // `test("name", vendorOnly, () => {` / `..., vendorOnly, async () => {` /
    // `..., vendorOnly, function () {`
    const asTestOption = new RegExp(`\\b${gate}\\s*,\\s*(?:async\\s+)?(?:\\(|function\\b)`, "g");
    const gated = (source.match(asTestOption) ?? []).length;

    assert.equal(
      gated,
      expected,
      `${file} gates ${gated} test(s) on ${gate}, but vendorPresence.test.js says `
      + `${expected}. Update the GATED table there: its counts are what a strict `
      + "run reports as unchecked, and a wrong count understates the gap.",
    );
  }
});
