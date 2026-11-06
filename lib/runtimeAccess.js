/**
 * eve.js-mod-esi: runtime access.
 *
 * This is the only module in the mod allowed to `require()` eve.js game code.
 * Everything else takes what it needs as an argument, so a test exercises every
 * behaviour with a fixture double and `node --test` never boots the emulator,
 * opens the game store or needs a generated database.
 *
 * The shape mirrors the game's own runtime modules
 * (`server/src/services/exploration/wormholes/wormholeRuntime.js`), which split
 * a pure `xFromTable(table, options)` core from a thin `x(options)` wrapper
 * supplying `getStateView()`. Here the injected dependency is the game module:
 *
 *   peekCharacterRecordFromRuntime(characterState, characterID)   pure, injectable
 *   peekCharacterRecord(characterID)                              supplies the real module
 *
 * Every accessor follows that pattern. One that cannot be written as a pure core
 * plus a two-line wrapper is doing too much and belongs in a module above this.
 *
 * Game modules are required lazily, on first use. Requiring them from
 * `loader.js`'s preload would pull game code in ahead of the server's own
 * initialisation order, since `--require` runs before the game server has
 * decided anything about load order.
 *
 * Cost-aware accessors. This mod shares the game's event loop, and a blocking
 * read stalls the universe. Three measured hazards, documented upstream and in
 * `docs/architecture.md` "Hazards in eve.js", shape what this file exposes:
 *
 *   - `characterState.getCharacterRecord()` deep-clones the record, ensures
 *     skills, resolves the active ship, re-derives standings and employment
 *     history, and writes the record back when normalisation drifts. A read that
 *     writes is disqualifying for a read-only replica. Use `peekCharacterRecord`.
 *   - `killmailState.getAllKillmailRecords()` deep-clones every killmail: about
 *     1 s of blocked loop at 100k records, a hard `RangeError` past about 25k fat
 *     records. It is not reachable through this file and must not become so
 *     without a streaming replacement.
 *   - `mapTelemetryState.*` has no non-cloning door: every export goes through
 *     `readState()`, which deep-copies the whole `mapTelemetry` table including
 *     the never-pruned `visitsByCharacterID` (1.7 s at 1.5 M entries, then
 *     `RangeError`). Anything needing that data reads the raw table through
 *     `getReadOnlyTableRepository()`.
 *
 * Read-only by construction. Raw table reads go through `gameStore/tableRepository`'s
 * `createTableRepository("mod:esiApi", { strict: true, allowSharedWrites: false })`.
 * Reads pass through; writes throw `OwnershipViolationError`. A replica of a
 * read API should be physically unable to write game tables, not merely
 * disciplined about it.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Mod-local, not game code: the rule at the top of this file is about
// `require()`ing the vendor tree. `lib/exportProbe.js` requires nothing, and
// every probe of a game export in this file goes through it.
const { exportHas } = require("./exportProbe");

// The game modules this mod is allowed to reach for.
// Paths are relative to `server/src`, without the `.js` extension. One frozen
// table keeps the blast radius of an upstream file move to this object, and
// `test/runtimeAccess.test.js` asserts every path here still resolves in the
// vendor tree through this file's own `gameModuleFilenameIn`, which resolves
// and never requires, so the drift check boots no game code.
//
// Upstream ships periodic distribution zips with no git history, and v0.12.6
// touched 9 of 11 files a patched checkout had changed: assume game internals
// move every drop. Every entry added must arrive with its own reason and is
// covered by the same stat test. A speculative path is a liability: it turns a
// green drift check red for a module nothing uses.
const GAME_MODULES = Object.freeze({
  // Where this install keeps its runtime data. Never hardcode the game store or
  // SDE directories: `resolveDataDir()` has three branches
  // (`EVEJS_GAMESTORE_DATA_DIR`, then `<root>/_local/gameStore/data`, then the
  // in-tree seed), and a containerised deployment takes the first while a host
  // checkout takes the second. nexumApi reimplemented the middle branch and
  // shipped two routes that answered "static data unavailable" on the only
  // environment that mattered. Ask the module: it is the game's single answer to
  // "where does this install keep its runtime data?".
  //
  // It is dependency-free upstream (its own header: fs + path only, because
  // `server/src/gameStore` opens SQLite and cannot be required from a node:test
  // process). That makes it the one entry in this table that is safe to require
  // outside a running game process, which lets `getStorePaths()` answer from the
  // health endpoint even when the game runtime is not up.
  gameStoreRoot: "gameStore/storeRoot",

  // The ownership-guarded door to raw tables. Its own header: "READS:
  // unrestricted and pass straight through", while writes are checked against
  // `tableOwnership.js` and throw `OwnershipViolationError` for a domain that
  // does not own the table. `mod:esiApi` owns nothing, by construction.
  //
  // The module is cheap to require: the gameStore is pulled in lazily, inside
  // `createTableRepository` (`options.store || require("./index")`). Calling the
  // factory is what opens SQLite, so nothing on the health path may call it. See
  // `getReadOnlyTableRepository()`.
  gameStoreTableRepository: "gameStore/tableRepository",

  // Owns the `characters` table and exports the non-cloning
  // `peekCharacterRecord` this mod's character reads are built on.
  characterState: "services/character/characterState",

  // The live set of connected transports, and the only thing on this server that
  // knows how many people are playing (D12). Upstream's header calls it "the
  // source of truth for connected retail transports".
  //
  // `getSessions()` already filters to live sessions (a socket that exists, is not
  // destroyed, and has not been marked character-control-disconnected), so the
  // count is of clients actually attached. That filtering is upstream's, which is
  // the reason to ask this module rather than count something ourselves.
  sessionRegistry: "services/chat/sessionRegistry",

  // Authoritative character control, and therefore the only correct answer to
  // "is this character online?". `sessionRegistry` is the wrong place to ask, for
  // the reason the note on `countPlayersFromRuntime` gives: a browser pilot never
  // enters that registry, so a server whose only users are browser pilots would
  // report every one of them offline.
  //
  // Upstream says the same twice. `services/chat/sessionRegistry.js:1-4` opens
  // with "Character control and online presence are derived through
  // online/characterControlRuntime so browser-pilot leases never need fake
  // sessions in this registry", and the game's online-status service is built on
  // the call this mod makes: `services/online/onlineStatusRuntime.js:73-75` is
  // `characterControlRuntime.getCharacterControlSnapshot(id).online`.
  //
  // Cheap enough to sit on the event loop, which was established rather than
  // assumed: see `getCharacterOnlineSnapshotFromRuntime` near the bottom of this
  // file for what one call does.
  characterControlRuntime: "services/online/characterControlRuntime",

  // Where a character's membership of a corporation lives, and therefore where
  // corporation roles live. Not on the character record:
  // `runtime.members[String(characterID)]` in the `corporationRuntime` table
  // carries `roles`, `rolesAtBase`, `rolesAtHQ` and `rolesAtOther` as decimal
  // strings, which is what `/characters/{id}/roles/` decomposes.
  //
  // The getter that writes: use `getCorporationMember`, never
  // `getCorporationSessionRoleState`. The second is the obvious accessor
  // (title-aware, applies the CEO/director short-circuit, returns the four masks
  // resolved) and it is a read that writes: for a character who belongs to that
  // corporation it calls `ensureCharacterMemberState`, which calls
  // `updateCorporationRuntime` and persists a default member record if the
  // corporation runtime has not seen them. A `GET` built on it writes into the
  // game the first time a new pilot asks about their own roles.
  //
  // That is the same disqualification this file applies to `getCharacterRecord`,
  // with the same remedy: `getCorporationMember` is the non-writing neighbour,
  // and `getCorporationMemberFromRuntime` composes it with `corporationState`'s
  // `ceoID` so the short-circuit is reproduced rather than borrowed. The cost is
  // under-reporting title-granted bits, which `routes/roles.js` states.
  //
  // Nothing in this file may reach for the writing getter, nor for
  // `ensureCharacterMemberState` or `updateCorporationRuntime`, which are how it
  // writes. `test/runtimeAccess.test.js` scans this source to keep it that way,
  // as it does for chatHub's broadcast exports.
  //
  // The same table holds `contacts` on its corporation and alliance entries,
  // which is why `/corporations/{id}/contacts/` and `/alliances/{id}/contacts/`
  // are one module apart. (`standingData` exists nowhere upstream.) Both getters clone the whole owner runtime to hand back
  // one map; that cost is bounded by the route paginating, not by anything here.
  //
  // Requires `server/src/gameStore` at module scope, so it opens SQLite on load:
  // world process only, never the health path.
  corporationRuntimeState: "services/corporation/corporationRuntimeState",

  // The corporation records themselves, reached for exactly one field: `ceoID`.
  //
  // It is the half of the director short-circuit a member record cannot answer.
  // eve.js grants a CEO the full administrative and locational masks at read time
  // regardless of what is persisted, so a CEO has the roles whether or not the
  // runtime has built them a member record. A missing member record is therefore
  // answerable from `ceoID` alone, instead of tempting a caller back to the
  // writing getter above.
  //
  // `getCorporationRecord` reads the row, deep-clones it, normalises the clone and
  // counts members off an index. It does not write the normalised record back,
  // which separates it from `getCharacterRecord` and is the reason it is
  // reachable here at all.
  //
  // Also reached for `getOwnerLookupRecord`, which makes a contact id a
  // `contact_type`: it is eve.js's own "what kind of thing is this id" and stamps
  // a `typeID` for a corporation, an alliance, a faction or an NPC character.
  // Player characters are `characterState`'s, so `getOwnerTypeId` is the second
  // question `routes/contacts.js` asks and never the first.
  //
  // Opens SQLite on load, like its neighbour.
  corporationState: "services/corporation/corporationState",

  // Owns the `structures` table and both reads `/corporations/{id}/structures/`
  // and `/universe/structures/{id}/` are built on: `listOwnedStructures` and
  // `getStructureByID`.
  //
  // Both reads run the world unless told not to. `getStructureByID(id, options)`
  // and `listStructures(options)` (which `listOwnedStructures` filters) both open
  // with
  //
  //     if (options.refresh !== false) { tickStructures(Date.now()); }
  //
  // and `tickStructures` is the fuel and state machine over every structure on
  // the server: flex-fuel cycles, auto-moon fuel, reinforcement timing, lifecycle
  // transitions, notifications, ending in `persistStructures(...)` when anything
  // changed. A `GET` that omits the option is an HTTP read that mutates and
  // persists game state and burns the loop the universe ticks on.
  //
  // So the option is not left to a call site. `readStructureState()` below is the
  // only place either function is invoked and it supplies `STRUCTURE_READ_OPTIONS`
  // itself; a caller cannot pass options in and therefore cannot omit them.
  //
  // The two differ in what they hand back: `listStructures` maps `cloneValue`
  // over its rows, so the list is owned; `getStructureByID` returns the cached row
  // by reference, which is `peekCharacterRecord`'s situation and carries its two
  // rules.
  //
  // Opens SQLite on load.
  structureState: "services/structure/structureState",

  // Fleets, and the one module in this table that owns no table at all.
  //
  // `runtimeState` is three module-scope `Map`s (`fleets`, `characterToFleet`,
  // `invitesByCharacter`), built in memory and never persisted, so a fleet exists
  // for as long as the process does and is destroyed when its members disconnect.
  // Nothing here can be read from the store, which is why both accessors are
  // `peek`-shaped: `getFleetByID` and `getFleetForCharacter` are one `Map.get`
  // each and return the live fleet object the game is mutating, with its
  // `members` `Map` hanging off it.
  //
  // `getBossCharacterID` is defined upstream and not exported, which is why
  // `routes/fleets.js` derives `fleet_boss_id` with the same `job`-bit scan.
  //
  // Cheap to call, expensive to require: the module pulls in
  // `services/character/characterSettingsState`, which calls
  // `createTableRepository` at module scope and so opens SQLite. World process
  // only, like the three above.
  fleetRuntime: "services/fleets/fleetRuntime",

  // The only way to say anything to a player in game, and the mod's one write into
  // the game (D3). The `/esi <code>` bind command must answer on every path: a
  // silent no-op leaves the player watching a browser that will never advance, and
  // there is no other channel to a logged-in character from inside this process.
  //
  // Narrow on purpose: `sendSystemMessage(session, message, specificChannel)`
  // addresses the session that ran the command and nothing else. The rest of this
  // module's exports (`broadcastLocalMessage`, `joinLocalChannel`,
  // `moveLocalSession`) stay out of reach, because a replica of a read API has no
  // business writing into other people's chat. See the accessor near the bottom of
  // this file for why it is one function rather than a handle.
  //
  // The 27 factions, and the one module in this table whose whole export surface
  // is reads. `getAllFactionRecords` normalises every row, clones it, and sorts by
  // `factionID`, so there is no live reference to protect and no writing neighbour
  // to refuse.
  //
  // It does not carry `station_count` and `station_system_count`, which
  // `/universe/factions/` requires. Those are derived from the `stations` and
  // `corporations` tables through the read-only repository: see
  // `readFactionStationCountsFromRuntime` near the bottom of this file for the
  // two-hop group-by and why its answer is a reading of CCP's rule rather than an
  // approximation of it.
  //
  // Requires `server/src/gameStore` at module scope, so it opens SQLite on load:
  // world process only, like its corporation neighbours.
  factionState: "services/faction/factionState",

  chatHub: "services/chat/chatHub",

  // Named here, never required through here.
  // These two are modules the mod patches on load rather than calls into:
  // `loader.js`'s bind hooks wrap `slashService`'s prototype and append to
  // `chatCommands`' command list, both from inside `Module._load`, so neither
  // passes through `getGameModule`.
  //
  // They are in this table for the same reason `wormholeRuntimeState` is: a hook
  // keyed on a string literal that upstream renames does not fail, it never
  // fires, and a bind flow whose slash command silently stopped existing looks
  // like a player typing the code wrong. Listing them puts both paths under the
  // vendor-drift check, which turns that silence into a failing test.
  slashService: "services/admin/slashService",
  chatCommands: "services/chat/chatCommands",

  // Readiness probe only: this mod never reads wormhole state. It needs one game
  // module that is loaded early in the world process and not loaded in any of the
  // other processes `NODE_OPTIONS` preloads the mod into (eve.js forks about 5
  // edge processes plus a healthcheck). `wormholeRuntimeState` is the module
  // `loader.js` keys its `gameRuntimeReady` hook on, and naming it here means both
  // sides of that decision read the same table entry.
  //
  // `isRuntimeReachable()` probes it for `mutateState`, the export the loader hook
  // matches on, without requiring it; see that function.
  wormholeRuntimeState: "services/exploration/wormholes/wormholeRuntimeState",

  // The game's own resolved configuration, for exactly one value:
  // `industrySystemCostIndex`, which is what `GET /industry/systems/` publishes.
  //
  // Reading the game's number rather than adding a mod-side knob matters: that
  // value is what `services/industry/industrySystemCostIndex.js`
  // `resolveSystemCostIndex` feeds into every job quote this server makes, so a
  // replica publishing a different one would tell an industry tool a job costs
  // something the game will not charge.
  //
  // Safe to require: it is the module `resolveServerSrcFrom` already probes to
  // decide whether a candidate directory is an eve.js tree at all, so it is plain
  // and dependency-light.
  config: "config",
});

// The ownership domain every table handle this mod opens is bound to. Fixed by
// docs/module-contracts.md; it must match the string `loader.js` and every
// route use, because ownership is keyed on it verbatim.
const TABLE_REPOSITORY_OWNER = "mod:esiApi";

/**
 * The options every table handle this mod opens is built with. Named, frozen
 * and exported so the vendor-drift test can build a repository from the real
 * `tableRepository` with these exact options and an injected fake store, and
 * prove upstream still refuses the write. A test that retyped the options would
 * check its own copy of the policy.
 *
 * See `getReadOnlyTableRepositoryFromRuntime` for why both flags are set.
 */
const READ_ONLY_REPOSITORY_OPTIONS = Object.freeze({
  strict: true,
  allowSharedWrites: false,
});

/**
 * The options every structure read this mod makes is built with, and the only
 * reason `readStructureState()` exists as a separate function.
 *
 * `{ refresh: false }` is not a tuning knob. Without it `getStructureByID` and
 * `listStructures` each begin with `tickStructures(Date.now())`, the fuel and
 * state machine over every structure on the server, which fires notifications
 * and calls `persistStructures` when anything changed. An HTTP `GET` that ran it
 * would mutate and persist game state on the event loop the universe ticks on.
 *
 * Named, frozen and exported like `READ_ONLY_REPOSITORY_OPTIONS`:
 * `test/runtimeAccess.test.js` asserts what reaches the vendor function against
 * this object rather than a retyped copy.
 */
const STRUCTURE_READ_OPTIONS = Object.freeze({ refresh: false });

// `CreateDatabase.bat` extracts CCP's public JSONL dump to a sibling of the
// store root in every layout: `/var/lib/evejs/sde` beside
// `/var/lib/evejs/gameStore` in a container, `_local/sde` beside
// `_local/gameStore` on a host checkout.
const SDE_DIR_NAME = "sde";

// The market daemon keeps its order book in another sibling of the store root
// (`/var/lib/evejs/market/market.sqlite` in a container, `_local/market/...` on
// a host checkout). The game server and the market daemon reach it through the
// same mounted volume, which is what makes it readable from here at all. It is
// resolved from the store root for the same reason the SDE dir is: the data dir
// has three resolution branches upstream, and reimplementing them on this side
// is the bug this section exists to not repeat.
const MARKET_DIR_NAME = "market";
const MARKET_DB_NAME = "market.sqlite";

// The SSO signing key is a third sibling of the store root:
// `/var/lib/evejs/sso/signing-key.pem` in a container,
// `_local/sso/signing-key.pem` on a host checkout (D8). Never hardcode these,
// for the same reason as the two above, plus one of its own: the key must
// outlive both the mod directory and the container. `<eve.js tree>/mods/esiApi/` is a
// copy a deploy replaces wholesale (D21), and a container is rebuilt on every
// image change, so the only place a key survives both is the volume the store
// root already sits in. Deriving from the store root puts it there in every
// layout without this file knowing which layout it is in.
//
// It has a directory of its own, beside `sde/` and `market/`, because the
// siblings are one directory per service and a directory is what a `chmod 700`
// can hold once (see `lib/signingKey.js`), rather than a permission re-argued
// per file.
const SSO_DIR_NAME = "sso";
const SIGNING_KEY_FILE_NAME = "signing-key.pem";

// The refresh token store is the second thing in that directory. Same argument,
// plus one: the container mounts the mod tree read-only and the store root is a
// writable volume, so this is the only writable location that survives a
// redeploy.
//
// `.jsonl` because it is one JSON object per line, a header and then a record
// each. The extension is for the operator who finds the file before they find
// `lib/refreshTokens.js`.
const REFRESH_TOKEN_STORE_FILE_NAME = "refresh-tokens.jsonl";

// The third: the salt the access token's `owner` claim is derived through. An
// account id is a small integer, so an unsalted `owner` is a reversible
// encoding, not an opaque one: anyone holding a token walks the account space in
// milliseconds and reads out the id the claim exists to hide. The salt makes it
// opaque, so losing it is not a degraded mode: every `owner` claim on the server
// moves at once, and a client reads a changed `owner` as a character transfer.
// That is a fleet-wide re-authorisation, worse than losing the refresh token
// store beside it, which is why the salt is durable state in the volume and not
// derived at boot.
//
// It is not derived from the signing key (D8): that would make a key rotation
// move every `owner` claim, repealing D8's promise that a rotation costs a
// client one failed request and one refresh. `lib/accessToken.js` owns that
// argument; this table owns only the location, which survives a redeploy (D21)
// and a container rebuild.
//
// `.txt` because a salt is small enough to be text and an operator should be
// able to `cat` it, back it up and recognise a restore, the argument D8 makes
// for PEM over DER. The encoding inside is `lib/accessToken.js`'s to choose.
const OWNER_SALT_FILE_NAME = "owner-salt.txt";

// How far up from this file to look for `server/src` before giving up. The
// deployed layout is `<eve.js tree>/mods/esiApi/lib/runtimeAccess.js`, so four levels
// suffice; ten leaves room for a deeper deployment without turning the walk into
// an unbounded filesystem crawl on a machine that has no tree at all, which is
// the normal case for this repo's own test runs.
const SERVER_SRC_SEARCH_DEPTH = 10;

/**
 * Thrown when a game export is missing the member an accessor duck-typed for.
 *
 * Named, and carrying the module key and property as fields, so an upstream drop
 * that moves a function breaks loudly in one identifiable place rather than as a
 * `TypeError: x is not a function` twelve frames deep in a request handler.
 * `loader.js` logs it; `routes/health.js` reports it.
 */
class GameModuleShapeError extends Error {
  constructor(moduleKey, property) {
    super(
      `[EsiApiMod] ${moduleKey} has no callable "${property}": the game module `
      + `changed shape. Check GAME_MODULES.${moduleKey} against the vendor tree.`,
    );
    this.name = "GameModuleShapeError";
    this.moduleKey = moduleKey;
    this.property = property;
  }
}

// Own-property duck typing, delegated to `lib/exportProbe.js` so there is exactly
// one answer in this mod to "does this export own this member?". A plain
// `exports.foo` miss on a module Node is satisfying from a half-built circular
// require reaches the warning proxy Node installs as its prototype, and eve.js's
// ProcessLifecycle logs that warning with a full stack and a heap snapshot.
// `hasOwnProperty` answers the same question without touching the prototype.

/** The own callable at `property`, or `null`. Never throws, never warns. */
function readOwnCallable(value, property) {
  return exportHas(value, property, "function") ? value[property] : null;
}

/**
 * The own callable at `property`, or a `GameModuleShapeError`.
 *
 * Use this in a pure core that has a real job to do: a missing method there
 * means the accessor cannot produce an answer, and pretending otherwise hides a
 * drop. Use `readOwnCallable` where the caller's job is to report rather than
 * compute; `isRuntimeReachable` and `getStorePaths` are the two.
 */
function requireOwnCallable(value, property, moduleKey) {
  const fn = readOwnCallable(value, property);
  if (!fn) throw new GameModuleShapeError(moduleKey, property);
  return fn;
}


let serverSrcResolved = false;
let cachedServerSrc = null;
const gameModuleCache = new Map();

/** `require.resolve` as a boolean, for probing a candidate tree. */
function moduleResolves(candidate) {
  try {
    require.resolve(candidate);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Pure core: walk up from `startDir` asking `moduleExists` about each candidate
 * `<dir>/server/src`. Injectable so a test can drive it over a made-up tree with
 * no filesystem.
 *
 * The probe is `<candidate>/config`, not the candidate itself: a directory that
 * happens to be called `server/src` is not an eve.js tree, and answering "found"
 * for one would send `getGameModule` off to require paths that do not exist and
 * blame upstream.
 */
function resolveServerSrcFrom(startDir, moduleExists = moduleResolves) {
  if (typeof startDir !== "string" || startDir.trim() === "") return null;
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < SERVER_SRC_SEARCH_DEPTH; depth += 1) {
    const candidate = path.join(dir, "server", "src");
    if (moduleExists(path.join(candidate, "config"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root; the walk is over
    dir = parent;
  }
  return null;
}

/** Pure core: an explicit repo root -> its `server/src`, or null. Same probe. */
function resolveServerSrcFromEnv(envRoot, moduleExists = moduleResolves) {
  if (typeof envRoot !== "string") return null;
  const trimmed = envRoot.trim();
  if (trimmed === "") return null;
  const candidate = path.join(path.resolve(trimmed), "server", "src");
  return moduleExists(path.join(candidate, "config")) ? candidate : null;
}

/**
 * Pure core: the explicit override first, then discovery. `null` when neither
 * finds a tree: a caller that wants to know whether a tree exists (a test
 * deciding whether to skip, the health endpoint deciding what to report) must
 * see that null rather than a plausible-looking guess.
 *
 * The contract documents this as `findServerSrc(startDir)`; the second and third
 * parameters are optional injection seams defaulting to "no override, real
 * resolver", so the one-argument call is the pure walk-up.
 */
function findServerSrc(startDir, envRoot, moduleExists = moduleResolves) {
  return (
    resolveServerSrcFromEnv(envRoot, moduleExists)
    || resolveServerSrcFrom(startDir, moduleExists)
  );
}

/**
 * Thin wrapper: this file's location, the environment, the real resolver.
 * Memoised, including the `null`, because the walk touches the filesystem
 * `SERVER_SRC_SEARCH_DEPTH` times and the health endpoint may be polled.
 *
 * `EVEJS_REPO_ROOT` exists because this mod's source does not live inside the
 * tree it attaches to: it is developed in its own repository and deployed into
 * `<eve.js tree>/mods/esiApi/`, so the upward walk (still the default in a deployment)
 * finds nothing when the tests run from the source checkout. Tests only. Nothing
 * in production sets it, and a deployed copy behaves identically whether it
 * exists or not.
 *
 * There is no "assume the documented layout" fallback. Returning
 * `<...>/server/src` for a directory with no such thing would turn a clean "no
 * vendor tree" into a `MODULE_NOT_FOUND` naming a path nobody chose, and
 * `routes/health.js` reports rather than judges: it needs the honest null.
 */
function resolveServerSrc() {
  if (serverSrcResolved) return cachedServerSrc;
  cachedServerSrc = findServerSrc(__dirname, process.env.EVEJS_REPO_ROOT);
  serverSrcResolved = true;
  return cachedServerSrc;
}


/**
 * Pure core: `loader` receives the `server/src`-relative path and returns the
 * module. A test passes a fake loader and never loads game code.
 */
function loadGameModuleWith(loader, moduleKey) {
  if (!Object.prototype.hasOwnProperty.call(GAME_MODULES, moduleKey)) {
    throw new Error(
      `[EsiApiMod] unknown game module "${moduleKey}". Known keys: `
      + `${Object.keys(GAME_MODULES).join(", ")}.`,
    );
  }

  const relativePath = GAME_MODULES[moduleKey];

  let loaded;
  try {
    loaded = loader(relativePath);
  } catch (err) {
    // Wrapped rather than rethrown: the bare require error names a path deep in the
    // vendor tree and says nothing about which accessor wanted it, the one fact that
    // shortens the fix after an upstream drop.
    const wrapped = new Error(
      `[EsiApiMod] failed to load game module "${moduleKey}" (${relativePath}): `
      + `${err && err.message ? err.message : String(err)}`,
    );
    wrapped.cause = err;
    throw wrapped;
  }

  if (loaded === null || (typeof loaded !== "object" && typeof loaded !== "function")) {
    throw new Error(
      `[EsiApiMod] game module "${moduleKey}" (${relativePath}) did not export an object.`,
    );
  }

  return loaded;
}

/**
 * Pure core: the absolute filename `moduleKey` resolves to inside `serverSrc`,
 * or `null`. Resolves, never loads: `require.resolve` finds the file that
 * `realGameModuleLoader`'s `require` would read and stops there, so this answers
 * "does this module exist?" without executing game code.
 *
 * Taking the tree as an argument lets the vendor-drift check in
 * `test/runtimeAccess.test.js` ask that question with the mod's own probe. A
 * `stat` of `<path>.js` would be a narrower probe and is wrong: upstream turned
 * `config.js` into the package directory `config/index.js`, which is the same
 * module to every `require` in this file, so a stat reports drift where there is
 * none. The rule is the one `test/vendorTree.js` states for `findServerSrc`: a
 * question the mod answers at runtime must not be able to answer differently in
 * a test.
 */
function gameModuleFilenameIn(serverSrc, moduleKey) {
  if (typeof serverSrc !== "string" || serverSrc.trim() === "") return null;
  if (!Object.prototype.hasOwnProperty.call(GAME_MODULES, moduleKey)) return null;
  try {
    return require.resolve(path.join(serverSrc, GAME_MODULES[moduleKey]));
  } catch (_) {
    return null;
  }
}

/** Thin wrapper: the same question, about the tree this install resolved. */
function realGameModuleFilename(moduleKey) {
  return gameModuleFilenameIn(resolveServerSrc(), moduleKey);
}

function realGameModuleLoader(relativePath) {
  const serverSrc = resolveServerSrc();
  if (!serverSrc) {
    throw new Error(
      "no eve.js vendor tree found above this mod (and EVEJS_REPO_ROOT is unset)",
    );
  }
  return require(path.join(serverSrc, relativePath));
}

/**
 * Lazy, memoised require of a game module.
 *
 * Node's own module cache covers the `require`, but not the `resolveServerSrc`
 * walk or the shape check, and this is called per request.
 */
function getGameModule(moduleKey) {
  const cached = gameModuleCache.get(moduleKey);
  if (cached) return cached;
  const loaded = loadGameModuleWith(realGameModuleLoader, moduleKey);
  gameModuleCache.set(moduleKey, loaded);
  return loaded;
}

/**
 * Pure core of "is this game module already loaded in this process?".
 *
 * `resolveFilename(moduleKey)` yields an absolute filename or `null`;
 * `moduleCache` is `require.cache`-shaped. Nothing here loads anything.
 */
function peekGameModuleWith(resolveFilename, moduleCache, moduleKey) {
  let filename;
  try {
    filename = resolveFilename(moduleKey);
  } catch (_) {
    return null;
  }
  if (typeof filename !== "string" || filename === "") return null;
  if (moduleCache === null || typeof moduleCache !== "object") return null;
  if (!Object.prototype.hasOwnProperty.call(moduleCache, filename)) return null;

  const entry = moduleCache[filename];
  if (entry === null || typeof entry !== "object") return null;
  // `exports` is an own property of a Module instance, so this is a safe read even
  // mid-circular-require, and a mid-require module's `exports` is the half-built
  // object the probes above are designed to survive.
  if (!Object.prototype.hasOwnProperty.call(entry, "exports")) return null;
  const exported = entry.exports;
  return exported === null || typeof exported !== "object" ? null : exported;
}

/**
 * The game module's exports if the game has already loaded it, else `null`.
 *
 * Never requires. `wormholeRuntimeState` requires `server/src/gameStore` at
 * module scope, which opens SQLite. Doing that from a health check, which runs
 * in eve.js's forked healthcheck process (the mod is preloaded there too,
 * because `NODE_OPTIONS` applies to every node process in the container), would
 * open the game's database from a process that has no business touching it.
 *
 * Inside the world process the module is already in `require.cache` by the time
 * the readiness hook fires, so the cheap answer and the expensive one agree.
 */
function peekGameModule(moduleKey) {
  const memoised = gameModuleCache.get(moduleKey);
  if (memoised) return memoised;
  return peekGameModuleWith(realGameModuleFilename, require.cache, moduleKey);
}

/**
 * Test seam: drop every memoised require and the resolved `server/src`.
 *
 * Also the only way to make `resolveServerSrc()` notice a changed
 * `EVEJS_REPO_ROOT`, since the `null` result is memoised too.
 */
function clearGameModuleCache() {
  gameModuleCache.clear();
  cachedServerSrc = null;
  serverSrcResolved = false;
}

// Readiness: is the game runtime reachable?
//
// Consumed by `routes/health.js`, which must get a useful answer when the
// runtime is not reachable, the interesting case rather than an error case. So
// this never throws, and the `reason` is a short stable token a human can act
// on, not a message that changes with the vendor drop.

/** Pure core. `runtimeStateModule` is whatever the readiness key resolved to. */
function isRuntimeReachableFromRuntime(runtimeStateModule) {
  if (runtimeStateModule === null || runtimeStateModule === undefined) {
    return { reachable: false, reason: "game runtime module not loaded" };
  }
  // The same export `loader.js`'s `gameRuntimeReady` hook matches on, probed the
  // same way, so "ready" cannot mean two things in one mod.
  if (!readOwnCallable(runtimeStateModule, "mutateState")) {
    return {
      reachable: false,
      reason: `${GAME_MODULES.wormholeRuntimeState} has no callable "mutateState"`,
    };
  }
  return { reachable: true, reason: null };
}

/**
 * Thin wrapper. Never throws, never requires game code, never opens SQLite.
 *
 * `reachable: false` with a reason is a normal result: it is what a fresh
 * checkout with no vendor tree reports, what the healthcheck process reports,
 * and what the world process reports before the readiness hook fires.
 */
function isRuntimeReachable() {
  try {
    if (!resolveServerSrc()) {
      return { reachable: false, reason: "no eve.js vendor tree found" };
    }
    return isRuntimeReachableFromRuntime(peekGameModule("wormholeRuntimeState"));
  } catch (err) {
    // Belt and braces: a health endpoint that throws is worse than one that reports
    // a failure, and this is the path that answers "why is the mod unhappy?".
    return {
      reachable: false,
      reason: `runtime probe failed: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

// Store paths.
//
// Never hardcode these. See the note on `GAME_MODULES.gameStoreRoot`: the data
// dir has three resolution branches upstream and a container takes a different
// one from a host checkout. Reimplementing the resolver on this side of the
// boundary is the bug this accessor exists to not repeat.

/** Pure core: `<...>/gameStore` -> `<...>/market/market.sqlite`. */
function marketDbPathFromGameStoreRoot(gameStoreRoot) {
  if (typeof gameStoreRoot !== "string" || gameStoreRoot.trim() === "") return null;
  return path.join(
    path.dirname(path.resolve(gameStoreRoot)),
    MARKET_DIR_NAME,
    MARKET_DB_NAME,
  );
}

/**
 * Where the market daemon's order book is, or `null`.
 *
 * Separate from `getStorePaths` because that result is on `/_mod/health` and
 * adding a key changes a published shape for every caller to answer a question
 * only the market routes ask.
 */
function getMarketDbPath() {
  return marketDbPathFromGameStoreRoot(getStorePaths().gameStoreRoot);
}

/** Pure core: `<...>/gameStore` -> `<...>/sso`. */
function ssoDirFromGameStoreRoot(gameStoreRoot) {
  if (typeof gameStoreRoot !== "string" || gameStoreRoot.trim() === "") return null;
  return path.join(path.dirname(path.resolve(gameStoreRoot)), SSO_DIR_NAME);
}

/**
 * Pure core: an `sso/` directory -> the three credential paths inside it.
 *
 * `null` for anything that is not a usable directory string, the same shape the
 * derivations below answer with.
 *
 * The one place the three file names are joined onto a directory, so a caller
 * that was told where the directory is (`ESI_MOD_SSO_STATE_DIR`, which
 * `loader.js` applies) and a caller that derived it from the game store cannot
 * disagree about what lives in it. The three `...FromGameStoreRoot` functions
 * below are the derived case; both go through here.
 *
 * This is not a configuration read. The directory arrives as `gameStoreRoot`
 * does, and this answers "what is inside an sso directory", a statement of
 * layout like `SSO_DIR_NAME`. Deciding which directory is the caller's, for the
 * reason `getSigningKeyPath` gives below.
 */
function ssoPathsFromDir(ssoDir) {
  if (typeof ssoDir !== "string" || ssoDir.trim() === "") return null;

  const resolved = path.resolve(ssoDir);
  return Object.freeze({
    ssoDir: resolved,
    signingKeyPath: path.join(resolved, SIGNING_KEY_FILE_NAME),
    ownerSaltPath: path.join(resolved, OWNER_SALT_FILE_NAME),
    refreshTokenStorePath: path.join(resolved, REFRESH_TOKEN_STORE_FILE_NAME),
  });
}

/** Pure core: `<...>/gameStore` -> `<...>/sso/signing-key.pem` (D8). */
function signingKeyPathFromGameStoreRoot(gameStoreRoot) {
  const paths = ssoPathsFromDir(ssoDirFromGameStoreRoot(gameStoreRoot));
  return paths === null ? null : paths.signingKeyPath;
}

/**
 * Where the SSO signing key lives by default, as `{ path, reason }`.
 *
 * `{ path: null, reason }` when no store root can be resolved, never a throw:
 * the same shape and promise as `getStorePaths()`. An unlocatable signing key is
 * not a degraded mode the way an absent market is (`lib/marketStore.js` answers
 * an empty book and moves on): the SSO listener has nothing to sign with and
 * declines to start, so the reason is the only useful output, and dropping it as
 * `getMarketDbPath()` does would leave an operator with a silent refusal.
 *
 * This is the default, with two overrides above it: `ESI_MOD_SIGNING_KEY_PATH`
 * names this file, and `ESI_MOD_SSO_STATE_DIR` names the directory it and its
 * two siblings live in (`config.js` parses and validates both). The caller
 * picks (configured file, else `ssoPathsFromDir` of the configured directory,
 * else this) in `loader.js`. Deciding that precedence here would put a config
 * read inside the module forbidden to have opinions about configuration.
 */
function getSigningKeyPath() {
  const { gameStoreRoot, reason } = getStorePaths();
  const resolved = signingKeyPathFromGameStoreRoot(gameStoreRoot);
  if (resolved) return { path: resolved, reason: null };
  return {
    path: null,
    reason: reason || "the game store root could not be resolved",
  };
}

/** Pure core: `<...>/gameStore` -> `<...>/sso/refresh-tokens.jsonl` (D8). */
function refreshTokenStorePathFromGameStoreRoot(gameStoreRoot) {
  const paths = ssoPathsFromDir(ssoDirFromGameStoreRoot(gameStoreRoot));
  return paths === null ? null : paths.refreshTokenStorePath;
}

/**
 * Where the refresh token store lives, as `{ path, reason }`.
 *
 * The same shape and promise as `getSigningKeyPath()`, for the same reason: a
 * store path that cannot be resolved is not a degradation the SSO listener can
 * serve through, since every token it issued would die at the next restart. It
 * declines to start, and this `reason` is the only output an operator gets.
 *
 * Unlike the signing key there is no override naming this file: the only reason
 * to move a refresh token store is to move the whole `sso/` directory. D30
 * named the shape of any override ("one knob over the directory rather than a
 * second over a file inside it") and `ESI_MOD_SSO_STATE_DIR` is that knob. This
 * is still the derivation; the caller reconciles it with the directory, for all
 * three files at once, through `ssoPathsFromDir`.
 */
function getRefreshTokenStorePath() {
  const { gameStoreRoot, reason } = getStorePaths();
  const resolved = refreshTokenStorePathFromGameStoreRoot(gameStoreRoot);
  if (resolved) return { path: resolved, reason: null };
  return {
    path: null,
    reason: reason || "the game store root could not be resolved",
  };
}

/** Pure core: `<...>/gameStore` -> `<...>/sso/owner-salt.txt` (D8). */
function ownerSaltPathFromGameStoreRoot(gameStoreRoot) {
  const paths = ssoPathsFromDir(ssoDirFromGameStoreRoot(gameStoreRoot));
  return paths === null ? null : paths.ownerSaltPath;
}

/**
 * Where the `owner`-claim salt lives, as `{ path, reason }`.
 *
 * The third of three, and the one whose absence costs the most: without the
 * salt the token endpoint must either refuse to serve or issue tokens whose
 * `owner` claim is a reversible encoding of an account id. Neither is a
 * degradation to paper over with a null, so the reason travels, as it does for
 * the signing key and the refresh token store.
 *
 * Named for the salt rather than the token that uses it, so the filename does
 * stays accurate if a second claim ever needs the same secret.
 */
function getOwnerSaltPath() {
  const { gameStoreRoot, reason } = getStorePaths();
  const resolved = ownerSaltPathFromGameStoreRoot(gameStoreRoot);
  if (resolved) return { path: resolved, reason: null };
  return {
    path: null,
    reason: reason || "the game store root could not be resolved",
  };
}

/** Pure core: `<...>/gameStore` -> `<...>/sde`. */
function sdeRootFromGameStoreRoot(gameStoreRoot) {
  if (typeof gameStoreRoot !== "string" || gameStoreRoot.trim() === "") return null;
  return path.join(path.dirname(path.resolve(gameStoreRoot)), SDE_DIR_NAME);
}

/**
 * Pure core. `storeRootModule` is whatever exposes `resolveStoreRoot`.
 *
 * Call `resolveStoreRoot()`, not `path.dirname(resolveDataDir())`. They are the
 * same directory (upstream's `resolveStoreRoot` is `path.resolve(resolveDataDir(),
 * "..")`), which is why the game's own name for it is the one to call: a second
 * copy of a one-line rule that already has an owner is how the two drift apart.
 *
 * The SDE root is derived rather than asked for because no upstream module owns
 * it: `storeRoot.js` knows only the store, and the running server never reopens
 * the extracted dump once the store is generated. In every layout
 * `CreateDatabase.bat` extracts it beside the store.
 *
 * This core throws `GameModuleShapeError` when the module changed shape.
 * `getStorePaths()` below turns that into a reportable field, because health
 * reports rather than judges.
 */
function getStorePathsFromRuntime(storeRootModule) {
  const resolveStoreRoot = requireOwnCallable(
    storeRootModule,
    "resolveStoreRoot",
    "gameStoreRoot",
  );
  const root = resolveStoreRoot.call(storeRootModule);
  if (typeof root !== "string" || root.trim() === "") {
    throw new GameModuleShapeError("gameStoreRoot", "resolveStoreRoot");
  }
  const gameStoreRoot = path.resolve(root);
  return { gameStoreRoot, sdeRoot: sdeRootFromGameStoreRoot(gameStoreRoot), reason: null };
}

/**
 * Thin wrapper. Never throws; `{ gameStoreRoot: null, sdeRoot: null, reason }`
 * when the paths cannot be determined.
 *
 * This is the one accessor that requires game code outside a running game
 * process. That is safe because `gameStore/storeRoot` is dependency-free
 * upstream (fs + path only, so admin tooling and `node:test` can ask without
 * pulling in SQLite). Do not extend this function to reach for any other
 * module: the property that makes it safe belongs to that file.
 */
function getStorePaths() {
  try {
    return getStorePathsFromRuntime(getGameModule("gameStoreRoot"));
  } catch (err) {
    return {
      gameStoreRoot: null,
      sdeRoot: null,
      reason: err && err.message ? err.message : String(err),
    };
  }
}


/**
 * Pure core. `tableRepositoryModule` is whatever exposes
 * `createTableRepository`.
 *
 * Two options, and both matter:
 *
 *   `strict: true`: a disallowed mutation throws `OwnershipViolationError`
 *   rather than being reported and let through. `mod:esiApi` is not the
 *   classified owner of any table in `tableOwnership.js`, so every
 *   `write`/`remove`/`ensureTable` through this handle throws.
 *
 *   `allowSharedWrites: false`: not the upstream default, which is `true`. The
 *   "shared" seam is a dormant capability upstream: no table is classified
 *   shared today, so the default changes nothing. But classifying one is an
 *   upstream opt-in to multi-writer access, and the day that happens a
 *   `{ strict: true }`-only handle would quietly begin permitting writes to it.
 *   "Physically unable to write" has to survive a vendor drop the mod is not
 *   told about, so it opts out in advance.
 *
 * Reads (`read`, `tableExists`) pass straight through, unguarded, as upstream's
 * header says.
 */
function getReadOnlyTableRepositoryFromRuntime(tableRepositoryModule) {
  const createTableRepository = requireOwnCallable(
    tableRepositoryModule,
    "createTableRepository",
    "gameStoreTableRepository",
  );
  // Spread rather than passed by reference: upstream reads the object but has
  // never promised not to keep it, and a frozen object reaching a mutator would
  // turn a vendor change into a TypeError from inside game code.
  return createTableRepository.call(tableRepositoryModule, TABLE_REPOSITORY_OWNER, {
    ...READ_ONLY_REPOSITORY_OPTIONS,
  });
}

/**
 * Thin wrapper supplying the real module.
 *
 * Never call this outside the game's world process. `createTableRepository`
 * defaults its backend to `require("./index")`, and `server/src/gameStore`
 * opens SQLite on load. Nothing on the health path may reach here, which is why
 * `getStorePaths()` goes to `storeRoot` instead. It has no never-throws wrapper:
 * a caller in the wrong process should find out immediately, not receive a null.
 */
function getReadOnlyTableRepository() {
  return getReadOnlyTableRepositoryFromRuntime(getGameModule("gameStoreTableRepository"));
}

// Worked accessor: a character record.
//
// The proving accessor for the injection design and the cost rule.
//
// Use `peekCharacterRecord`, never `getCharacterRecord`. Upstream's comment on
// the former explains the cost of the latter: it deep-clones the record on every
// call, double-`JSON.stringify`s it on a cache miss to detect normalisation
// drift, and keys its cache on a global `itemMutationVersion` that routine
// per-tick item writes bump, so a hot read-only caller pays a full
// clone-plus-serialize every tick. Worse for a read API: when the normalised
// record differs from the stored one, `getCharacterRecord` calls
// `writeCharacterRecord`. A read that writes cannot appear anywhere in this mod.
//
// The cost of `peek` is that the record comes back by reference: it is the live
// in-memory object the game is mutating. Two rules follow, and they are why this
// accessor projects rather than returning the record:
//
//   1. Nothing above this line may mutate what it receives.
//   2. Nothing above this line may hold it across an await. The game may have
//      moved the character by the time the handler resumes, and a response
//      assembled from a half-updated record is a torn read.
//
// So the pure core takes a projector and hands out a plain, owned object.

/**
 * Pure core. `characterStateModule` is whatever exposes `peekCharacterRecord`.
 *
 * `project(record, characterID)` is applied to the live record and must return a
 * value that borrows nothing from it. It defaults to a shallow copy, which
 * satisfies rule 1 for a flat record and no more: a nested object is still
 * shared, so a projector that needs nested fields copies them itself.
 *
 * An unknown character is `null`, not a throw. "No such character" is an answer,
 * and `routes/` decides whether that is a 404.
 */
function peekCharacterRecordFromRuntime(characterStateModule, characterID, options = {}) {
  const peek = requireOwnCallable(
    characterStateModule,
    "peekCharacterRecord",
    "characterState",
  );
  const record = peek.call(characterStateModule, characterID);
  if (record === null || typeof record !== "object") return null;

  const project = readOwnCallable(options, "project");
  return project ? project(record, characterID) : { ...record };
}

/** Thin wrapper supplying the real module. */
function peekCharacterRecord(characterID, options = {}) {
  return peekCharacterRecordFromRuntime(
    getGameModule("characterState"),
    characterID,
    options,
  );
}

// A character's trained skills.
//
// The cost rule from the top of this file, reached through a different door,
// with no `peek` on the other side of it.
//
// `services/skills/skillState` has five public reads of a character's skills:
// `getCharacterSkills`, `getCharacterBaseSkills`, `getCharacterSkillMap`,
// `getCachedCharacterSkillMap` and `getCharacterSkillPointTotal`. Every one
// funnels through `ensureCharacterSkills`, which writes three times over:
//
//   1. `bootstrapCharacterSkillsIfMissing` seeds a starter set (or every
//      published skill, under `devBootstrapPublishedSkills`) for a character
//      with no row, so a `GET` would give a pilot skills they never trained.
//   2. It re-normalises every existing row and persists the whole table when
//      any one differs by a `JSON.stringify` comparison.
//   3. `syncCharacterSkillPoints` then writes the recomputed total back onto the
//      character record.
//
// A read that creates game state as a side effect of somebody polling an API is
// the worst shape of a read that writes. So there is no `skillState` entry in
// `GAME_MODULES`: the mod reads the table `skillState` owns directly, through
// the read-only handle that cannot write it, and sums itself.
//
// The rows read here are the persisted ones. The expert-system overlay
// `skillState` applies at read time (`applyExpertSystemProjection`, which lifts
// `effectiveSkillLevel` above `trainedSkillLevel` for a pilot running an active
// expert system) is not in them. `routes/skills.js` documents what that means
// for CCP's `active_skill_level` and why the overlay was not chased through two
// more game modules.

const SKILLS_TABLE = "skills";

/**
 * Pure core. `repository` is a read-only table handle: anything with a
 * `read(table, pointer)` that answers `{ success, data }`.
 *
 * `null` for a table that cannot be read, and `[]` for a character with no row
 * in one that can. Two kinds of empty on purpose: collapsing them would answer
 * "this pilot has trained nothing" for "this build cannot see skills at all",
 * and the difference reaches a client as `total_sp: 0`, a number a tool acts on.
 *
 * An empty row is ordinary: eve.js seeds a character's skills lazily, on the
 * first call through `ensureCharacterSkills`, so a character who has not been
 * through one has a row of `{}` or no row, and this accessor does not change
 * that.
 *
 * Rows come back as owned plain objects in the game's own spelling. `read`
 * hands back the live stored object as `peekCharacterRecord` does, so the four
 * fields are copied out as numbers and the record is dropped. A row that is not
 * an object, or whose `typeID` is not a positive safe integer, is skipped: it is
 * not a skill, and a `skill_id` of `0` is a body a client cannot use.
 */
function listCharacterSkillsFromRuntime(repository, characterID) {
  const read = requireOwnCallable(repository, "read", "gameStoreTableRepository");

  const result = read.call(repository, SKILLS_TABLE, "/");
  if (!result || !result.success || !result.data || typeof result.data !== "object") return null;

  const row = result.data[String(characterID)];
  if (row === null || row === undefined || typeof row !== "object") return [];

  const skills = [];
  for (const record of Object.values(row)) {
    if (record === null || typeof record !== "object") continue;

    const typeId = Number(record.typeID);
    if (!Number.isSafeInteger(typeId) || typeId <= 0) continue;

    skills.push({
      typeID: typeId,
      // Left as whatever the row holds when it is not a number: deciding what an
      // unreadable level means is the route's call, and `null` here would be
      // indistinguishable from a stored level of zero.
      trainedSkillLevel: Number(record.trainedSkillLevel),
      effectiveSkillLevel: Number(record.effectiveSkillLevel),
      skillPoints: Number(record.skillPoints),
    });
  }

  return skills;
}

/**
 * Thin wrapper supplying the real repository.
 *
 * Not memoised, unlike `getFactionStationCounts`: that one walks a static dump,
 * and this one reads a table the game rewrites whenever anybody finishes
 * training anything.
 */
function listCharacterSkills(characterID) {
  return listCharacterSkillsFromRuntime(getReadOnlyTableRepository(), characterID);
}


/**
 * Pure core. `sessionRegistryModule` is whatever exposes `getSessions`.
 *
 * A count, never the sessions. A session object is a live socket with the
 * game's own state hanging off it, and handing one above this line is the
 * torn-read hazard `peekCharacterRecord` documents, with a file descriptor
 * attached.
 *
 * It counts connected clients, which is what CCP's `players` counts: a client in
 * character selection is logged in and is one of them. A browser pilot is not
 * (control leases live in `services/online/characterControlRuntime` and never
 * enter this registry), so a server whose only users are browser pilots reports
 * zero. That is a real limitation and the right one for now: the number should
 * mean "clients attached to the game", and adding leases would make it mean
 * something CCP's number does not.
 *
 * Throws `GameModuleShapeError` if the export is gone, which is drift rather
 * than an absence of players; `routes/status.js` decides what a caller sees.
 */
function countPlayersFromRuntime(sessionRegistryModule) {
  const getSessions = requireOwnCallable(
    sessionRegistryModule,
    "getSessions",
    "sessionRegistry",
  );
  const sessions = getSessions.call(sessionRegistryModule);
  if (!Array.isArray(sessions)) {
    throw new GameModuleShapeError("sessionRegistry", "getSessions");
  }
  return sessions.length;
}

/** Thin wrapper supplying the real module. */
function countPlayers() {
  return countPlayersFromRuntime(getGameModule("sessionRegistry"));
}

// Is this character online?
//
// `/characters/{id}/online/`, and the one accessor whose source had to be
// argued rather than looked up. `sessionRegistry` is the wrong source, as the
// note on `countPlayersFromRuntime` explains and upstream says at
// `services/chat/sessionRegistry.js:1-4`: "Character control and online presence
// are derived through online/characterControlRuntime so browser-pilot leases
// never need fake sessions in this registry". A browser pilot is online and not
// in that registry, so an `/online/` built on it answers `false` to a player who
// is flying.
//
// The game's own online-status service is built on the call below.
// `services/online/onlineStatusRuntime.js:73-75`:
//
//     return characterControlRuntime.getCharacterControlSnapshot(
//       normalizedTargetID,
//     ).online;
//
// That is what `OnlineStatusService.Handle_GetOnlineStatus` returns
// (`services/online/onlineStatusService.js:57-65`), what one player's client is
// told about another's presence. Asking the same function makes this endpoint
// agree with the game.
//
// What one call costs. The three hazards at the top of this file are
// clone-or-scan-the-table costs; this is not one, established by reading
// `services/online/characterControlRuntime.js:272-290` and following every call
// out of it:
//
//   - `normalizeCharacterID` (L39-42): two numeric predicates.
//   - `expireIfNeeded` (L265-270): `browserLeases.get(id)`, one Map get, and one
//     `nowMs() >= lease.expiresAtMs` compare.
//   - `findRetailSession(id)`, which the shipped runtime binds to
//     `sessionRegistry.findSessionByCharacterID(id, { includeClosing: true })`
//     (L513-524): an indexed `sessionsByCharacterID.get(id)` Map get over a
//     bucket of one character's sessions (`sessionRegistry.js:185-196`). The
//     fallback at L198-208, taken when the bucket is empty (the normal path for
//     a character who is not connected), copies the session Set and walks it.
//   - `makeSnapshot` (L74-90): builds and freezes a five-key object.
//
// The worst case is one array copy plus one linear pass over the connected
// sessions: bounded by concurrent players, with no clone, table read or SQLite.
// It is the same work `countPlayers()` already does on every `/status/` request,
// since `getSessions()` is `Array.from(sessions).filter(isLiveSession)`
// (`sessionRegistry.js:85-87`). Safe on the loop the universe ticks on.
//
// It is not quite a pure read. `expireIfNeeded` can expire a lease: it deletes
// the entry, remembers it in the expired-lease history and calls
// `notifyTransition`, which reaches `onlineStatusRuntime`'s subscriber
// (`onlineStatusRuntime.js:135-144`) and sends `OnContactLoggedOff` to watching
// sessions. It survives the suspicion this file gives `getCharacterRecord`
// because the branch only fires for a lease whose expiry has already passed, and
// `scheduleExpiry` (L226-245) has a timer armed for that moment. The outcome is
// the same either way (this only brings an already-due expiry forward by however
// late the timer was) and nothing is persisted. `getCharacterRecord`, by
// contrast, writes a record back to the store on a normalisation difference that
// would otherwise never have been written.

/**
 * Pure core. `characterControlModule` is whatever exposes
 * `getCharacterControlSnapshot`.
 *
 * Returns `{ online }`, a plain frozen object of this mod's own making, or
 * `null`.
 *
 * Not the vendor's snapshot object. Upstream's is frozen too
 * (`characterControlRuntime.js:74-90`), but frozen is not owned: returning it
 * would put four fields of the game's internal control vocabulary on this mod's
 * side of the boundary, where a route can start depending on them. The real
 * shape is
 *
 *     { characterID, online, controlState, transport, leaseExpiresAt }
 *
 * and `/online/`'s body is `{ online, last_login, last_logout, logins }`, whose
 * last three fields come from the character record. Exactly one of the five is
 * wanted, and the other four are withheld on purpose:
 *
 *   - `characterID` is the value the caller just passed in, normalised. Echoing
 *     it invites a route to trust this module's normalisation in place of its
 *     own validation.
 *   - `controlState` (`"offline"` / `"retail_client"` / `"browser_pilot"`,
 *     L8-12) and `transport` (`"tcp"` / `"web"`, L14-17) are how this server
 *     implements presence. CCP's `/online/` has no such concept, and a private
 *     server inventing fields breaks clients that trust the spec.
 *   - `leaseExpiresAt` is a browser-pilot lease deadline: internal, and it tells
 *     a reader of the response that the pilot is browser-controlled.
 *
 * Never throws for a bad character id. `getCharacterControlSnapshot` normalises
 * anything that is not a positive safe integer to `0` and then throws
 * `CharacterControlError(CHARACTER_CONTROL_UNAVAILABLE, ..., 503)` (L272-276
 * into L118-124). It throws the same error when a character holds both a retail
 * session and a browser lease (L280-282). A game-code throw reaching a route
 * handler becomes a logged 500, and "who is this?" is not a server fault, so
 * both become `null` here.
 *
 * The catch is deliberately broad rather than `instanceof CharacterControlError`:
 * nothing from inside game code may reach the handler, and narrowing it would
 * let the next vendor drop's `TypeError` through. It cannot swallow the one
 * error that must escape, because `requireOwnCallable` runs before the `try`: a
 * missing export is drift, a `GameModuleShapeError`, and `routes/health.js`
 * reports it. This is the distinction `countPlayersFromRuntime` draws between
 * "no players" and "the export is gone".
 *
 * `null` means "the game declined to answer for this id", not "no such
 * character". `characterControlRuntime` knows leases and sessions, not who
 * exists: it answers `offlineSnapshot(characterID)` (L289) for any well-formed
 * id it has never heard of. A caller that must tell an unknown character from an
 * offline one asks `peekCharacterRecord`, which it does anyway, since
 * `last_login`, `last_logout` and `logins` live on the record.
 */
function getCharacterOnlineSnapshotFromRuntime(characterControlModule, characterId) {
  const getCharacterControlSnapshot = requireOwnCallable(
    characterControlModule,
    "getCharacterControlSnapshot",
    "characterControlRuntime",
  );

  let snapshot;
  try {
    snapshot = getCharacterControlSnapshot.call(characterControlModule, characterId);
  } catch (_) {
    return null;
  }
  if (snapshot === null || typeof snapshot !== "object") return null;

  // `=== true`, not a coercion. `online` is upstream's field and is a boolean
  // today (`characterControlRuntime.js:78`, `controlState !== OFFLINE`); a drop
  // that turned it into a string, a lease object or `undefined` must not start
  // reporting a player as flying. `false` is the safe side: presence should not be
  // over-reported.
  return Object.freeze({ online: snapshot.online === true });
}

/** Thin wrapper supplying the real module. */
function getCharacterOnlineSnapshot(characterId) {
  return getCharacterOnlineSnapshotFromRuntime(
    getGameModule("characterControlRuntime"),
    characterId,
  );
}

// Corporation membership, without creating one.
//
// `/characters/{character_id}/roles/`, and the gate on
// `/corporations/{corporation_id}/structures/`.
//
// Two accessors, because the question has two halves and the single upstream
// function that answers both is disqualified. See
// `GAME_MODULES.corporationRuntimeState`: `getCorporationSessionRoleState` calls
// `ensureCharacterMemberState` for a member, which persists a default member
// record, so a read endpoint built on it writes into the game on the first
// request from a pilot the corporation runtime has never seen. Neither name
// appears in this file except in prose warnings, and a test enforces that.
//
// Composed instead: the non-writing member read here, plus `ceoID` from the
// corporation record below. `routes/roles.js` reproduces the director
// short-circuit from the two and states what that costs.

/**
 * A deep, owned copy of a value that came out of game code.
 *
 * Both corporation accessors use it. Upstream clones in both today, and the
 * vendor-drift check reads their source to say so, but ownership must not rest
 * on a vendor property this file merely observed: a drop that turned either
 * read into a live-object read would move a mutable game record above this line
 * without a call site changing, the failure `peekCharacterRecord` exists to make
 * visible.
 *
 * Affordable exactly here: these two feed a route with a one-hour TTL and a
 * `char-detail` bucket, and are one small record each. It is not a tool for hot
 * paths: the three hazards at the top of this file are deep clones of whole
 * tables, and adding a fourth would be the same mistake.
 *
 * `structuredClone` rather than a spread because a member record nests
 * (`memberOptOuts`, title state), and rather than JSON because it does not
 * silently drop what it cannot represent. Both records are store-persisted JSON
 * (upstream's `cloneValue` is `JSON.parse(JSON.stringify(value))`), so nothing
 * in them is refused by `structuredClone`.
 */
function cloneOwned(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

/**
 * Pure core. `corporationRuntimeStateModule` is whatever exposes
 * `getCorporationMember`.
 *
 * The member record for a character's membership of a corporation, deep-copied,
 * or `null` for a character that corporation's runtime has never seen.
 *
 * `null` is an answer, not a failure, and must not tempt a caller back to
 * `getCorporationSessionRoleState`. A pilot with no member record still has
 * roles if they are the CEO (eve.js grants those at read time), so
 * `routes/roles.js` answers from `ceoID` rather than using the accessor that
 * would create the record in order to read it.
 *
 * Throws `GameModuleShapeError` if the export is gone: an absent member and a
 * missing export are different failures, as in `countPlayersFromRuntime`, and
 * collapsing them would report a director as holding nothing.
 */
function getCorporationMemberFromRuntime(
  corporationRuntimeStateModule,
  corporationId,
  characterId,
) {
  const get = requireOwnCallable(
    corporationRuntimeStateModule,
    "getCorporationMember",
    "corporationRuntimeState",
  );
  const member = get.call(corporationRuntimeStateModule, corporationId, characterId);
  return member === null || typeof member !== "object" ? null : cloneOwned(member);
}

/** Thin wrapper supplying the real module. */
function getCorporationMember(corporationId, characterId) {
  return getCorporationMemberFromRuntime(
    getGameModule("corporationRuntimeState"),
    corporationId,
    characterId,
  );
}

/**
 * Pure core. `corporationStateModule` is whatever exposes
 * `getCorporationRecord`.
 *
 * The corporation record, deep-copied, or `null`. Reached for `ceoID`, the half
 * of the director short-circuit a member record cannot answer, and returned
 * whole rather than narrowed: unlike `getCharacterOnlineSnapshot` there is no
 * private presence vocabulary to withhold. It is the object the
 * `/corporations/` routes project.
 *
 * `isCEO` on the member record is not a substitute: it is stamped when the
 * record is built and does not follow a later change of CEO. `routes/roles.js`
 * asks this and takes the member's flag only as a second way to say yes.
 */
function getCorporationRecordFromRuntime(corporationStateModule, corporationId) {
  const get = requireOwnCallable(
    corporationStateModule,
    "getCorporationRecord",
    "corporationState",
  );
  const record = get.call(corporationStateModule, corporationId);
  return record === null || typeof record !== "object" ? null : cloneOwned(record);
}

/** Thin wrapper supplying the real module. */
function getCorporationRecord(corporationId) {
  return getCorporationRecordFromRuntime(getGameModule("corporationState"), corporationId);
}

// Contacts: the three standings buckets.
//
// `/characters/{id}/contacts/` needs nothing here: personal contacts are a field
// on the character record that `peekCharacterRecord` reaches with a projector,
// which keeps the live record from being borrowed. The other two buckets are
// `contacts` on the corporation and alliance entries of `corporationRuntime`,
// reached through the module the role masks come from.
//
// Both reads deep-clone the whole owner runtime (members, titles, bulletins,
// applications, role history), because `getCorporationRuntime` and
// `getAllianceRuntime` are the only exported doors and neither takes a
// projection. What bounds the cost is the route: `routes/contacts.js` paginates,
// so `lib/router.js` asks its handler for the whole collection once per
// five-minute cache window rather than once per page.
//
// `updateCorporationRuntime` is the writing neighbour and is refused here by
// name, with the rest of that module's writers. These are the plain getters, and
// each returns `null` for an owner the runtime has never seen, which is an
// answer rather than a failure.

/**
 * Pure core. `corporationRuntimeStateModule` is whatever exposes
 * `getCorporationRuntime`.
 *
 * A corporation's contact table, deep-copied, `{ "<contact id>": {
 * relationshipID, labelMask, inWatchlist } }`, or `null` for a corporation with
 * no runtime entry.
 *
 * The rows carry no id inside them: for a corporation contact the id is the key
 * and only the key, which is how eve.js's own `buildContactKeyVal` reads them,
 * and `routes/contacts.js` `contactRowsOf` takes it from there.
 *
 * `null` is deliberately not `{}`. "This corporation has no contacts" and "this
 * corporation is not in the runtime table" are different answers, and the route
 * treats the second as this server disagreeing with itself, since the subject
 * check has already proved the caller is a member of it.
 */
function getCorporationContactsFromRuntime(corporationRuntimeStateModule, corporationId) {
  const get = requireOwnCallable(
    corporationRuntimeStateModule,
    "getCorporationRuntime",
    "corporationRuntimeState",
  );
  const runtime = get.call(corporationRuntimeStateModule, corporationId);
  if (runtime === null || typeof runtime !== "object") return null;

  const contacts = runtime.contacts;
  return contacts === null || typeof contacts !== "object" ? null : cloneOwned(contacts);
}

/** Thin wrapper supplying the real module. */
function getCorporationContacts(corporationId) {
  return getCorporationContactsFromRuntime(
    getGameModule("corporationRuntimeState"),
    corporationId,
  );
}

/**
 * Pure core. `corporationRuntimeStateModule` is whatever exposes
 * `getAllianceRuntime`.
 *
 * The alliance half of the pair above, in the same table and module
 * (`corporationRuntime` holds both), with the same `null`.
 */
function getAllianceContactsFromRuntime(corporationRuntimeStateModule, allianceId) {
  const get = requireOwnCallable(
    corporationRuntimeStateModule,
    "getAllianceRuntime",
    "corporationRuntimeState",
  );
  const runtime = get.call(corporationRuntimeStateModule, allianceId);
  if (runtime === null || typeof runtime !== "object") return null;

  const contacts = runtime.contacts;
  return contacts === null || typeof contacts !== "object" ? null : cloneOwned(contacts);
}

/** Thin wrapper supplying the real module. */
function getAllianceContacts(allianceId) {
  return getAllianceContactsFromRuntime(getGameModule("corporationRuntimeState"), allianceId);
}

/**
 * Pure core. `corporationStateModule` is whatever exposes
 * `getOwnerLookupRecord`.
 *
 * What kind of thing an id is, as eve.js's own owner `typeID`, or `null` for an
 * id the game cannot name. This is how a stored contact, which is an id and
 * nothing else, becomes ESI's `contact_type`.
 *
 * `getOwnerLookupRecord` answers for corporations, alliances, factions and NPC
 * characters, in that order, and not for player characters: those are the
 * `characters` table's, so `routes/contacts.js` asks `peekCharacterRecord`
 * first and falls through to here. That is upstream's division.
 *
 * Narrowed to the `typeID` rather than passing the record up, for
 * `getCharacterOnlineSnapshot`'s reason: an owner record also carries
 * `ownerName`, and a route that only needs to know what an id is has no
 * business being handed what somebody called it. The four `typeID` values are
 * named in `routes/contacts.js` `OWNER_TYPES` and re-read out of the vendor tree
 * by its contract test, as `routes/roles.js` handles the corporation role bits.
 */
function getOwnerTypeIdFromRuntime(corporationStateModule, ownerId) {
  const get = requireOwnCallable(
    corporationStateModule,
    "getOwnerLookupRecord",
    "corporationState",
  );
  const record = get.call(corporationStateModule, ownerId);
  if (record === null || typeof record !== "object") return null;

  const typeId = Number(record.typeID);
  return Number.isSafeInteger(typeId) && typeId > 0 ? typeId : null;
}

/** Thin wrapper supplying the real module. */
function getOwnerTypeId(ownerId) {
  return getOwnerTypeIdFromRuntime(getGameModule("corporationState"), ownerId);
}

// The public entity lookups.
//
// `/characters/{id}/`, `/corporations/{id}/` and `/alliances/{id}/` are three
// public reads that need one accessor between them that did not already exist.
// `peekCharacterRecord` answers the first and `getCorporationRecord` the second;
// alliances had no door. An alliance is `corporationState`'s second table,
// reached through the same module, which is why this sits under the corporation
// accessors.

/**
 * Pure core. `corporationStateModule` is whatever exposes `getAllianceRecord`.
 *
 * `getAllianceRecord` is the non-writing getter, checked rather than assumed: it
 * reads the row, `cloneValue`s it, and computes `memberCorporationIDs` and a
 * `memberCount` off the corporations index, writing nothing back. The table's
 * initialiser can write (`ensureAlliancesInitialized` rewrites the table once if
 * `_meta.nextCustomAllianceID` normalises to a different value), but that is a
 * one-time repair on the first read of a malformed `_meta`, long done before an
 * HTTP request arrives on a running server.
 *
 * Cloned again on the way out (`cloneOwned`), as every accessor here does:
 * upstream's clone is upstream's promise, and ownership must not depend on a
 * vendor drop keeping a `JSON.parse(JSON.stringify(...))` in place.
 *
 * `null` for an alliance the game does not know, an answer rather than a
 * failure: `routes/entities.js` turns it into the validated family's 404.
 */
function getAllianceRecordFromRuntime(corporationStateModule, allianceId) {
  const get = requireOwnCallable(
    corporationStateModule,
    "getAllianceRecord",
    "corporationState",
  );
  const record = get.call(corporationStateModule, allianceId);
  return record === null || typeof record !== "object" ? null : cloneOwned(record);
}

/** Thin wrapper supplying the real module. */
function getAllianceRecord(allianceId) {
  return getAllianceRecordFromRuntime(getGameModule("corporationState"), allianceId);
}


/**
 * Pure core. `factionStateModule` is whatever exposes `getAllFactionRecords`.
 *
 * The whole roster, 27 rows on this dump, normalised and already sorted by
 * `factionID` by upstream. That is the order `/universe/factions/` answers in,
 * and deliberately not CCP's (see `contract/wire.js` `FACTIONS`).
 *
 * `getAllFactionRecords` clones every row on the way out, so there is no live
 * reference to protect and no projector to thread. It reads one table and
 * touches nothing else, so unlike the structure reads it cannot run the world.
 */
function listFactionRecordsFromRuntime(factionStateModule) {
  const list = requireOwnCallable(
    factionStateModule,
    "getAllFactionRecords",
    "factionState",
  );
  const records = list.call(factionStateModule);
  return Array.isArray(records) ? records.filter((row) => row && typeof row === "object") : [];
}

/** Thin wrapper supplying the real module. */
function listFactionRecords() {
  return listFactionRecordsFromRuntime(getGameModule("factionState"));
}

/**
 * The two tables the station counts are derived from, and the fields read off
 * each. Named so `test/runtimeAccess.test.js` can assert them against a real
 * dump.
 */
const STATIONS_TABLE = "stations";
const CORPORATIONS_TABLE = "corporations";

/**
 * `{ [factionId]: { stations, systems } }`, derived, because `station_count` and
 * `station_system_count` are required on `/universe/factions/` and appear on no
 * faction record anywhere in the vendor tree.
 *
 * The derivation is a two-hop group-by: a station row names its owning
 * corporation and its solar system, and a corporation row names its faction. It
 * reproduces CCP's own published numbers exactly, all 27 pairs, on the dump this
 * install carries (Amarr 1041/515, Caldari 1535/534, and the four factions that
 * own nothing at 0/0), so it reads the same rule rather than approximating it.
 *
 * Four stations on this dump have an owning corporation with no `factionID` and
 * belong to no bucket. They are dropped rather than assigned somewhere, and
 * CCP's totals agree.
 *
 * Memoised: 5,210 station rows and 283 corporation rows, walked once, about a
 * millisecond on the game's event loop. Both tables are the static-data dump and
 * do not change while the process lives. Player structures are a different table
 * and never enter this one.
 *
 * The cache is keyed on nothing, because there is one dump.
 * `clearFactionStationCountsCache()` exists for tests that swap the repository
 * under it and is not called in production, like `clearGameModuleCache`.
 */
let factionStationCountsCache = null;

/**
 * Pure core. `repository` is a read-only table handle: anything with a
 * `read(table, pointer)` that answers `{ success, data }`.
 *
 * A table that is missing or unreadable yields an empty map, not a throw. The
 * alternative is refusing to answer `/universe/factions/` at all, and the counts
 * are two fields out of ten on a roster whose other eight are fine.
 * `routes/entities.js` sends `0` for a faction with no bucket, which is also
 * what it sends for the four factions that own nothing, so a missing table
 * degrades to a body that is wrong in two numeric fields rather than no body.
 */
function readFactionStationCountsFromRuntime(repository) {
  const read = requireOwnCallable(repository, "read", "gameStoreTableRepository");

  const table = (name) => {
    const result = read.call(repository, name, "/");
    return result && result.success && result.data && typeof result.data === "object"
      ? result.data
      : null;
  };

  const stationTable = table(STATIONS_TABLE);
  const corporationTable = table(CORPORATIONS_TABLE);
  if (stationTable === null || corporationTable === null) return new Map();

  // Both tables are written with their rows under a key rather than at the root,
  // and the keys differ: the SDE-derived station dump says `stations` and the
  // corporation table says `records`. Falling back to the object itself covers a
  // shape that keeps neither.
  const stationRows = stationTable.stations || stationTable.records || stationTable;
  const corporationRows = corporationTable.records || corporationTable;
  if (typeof stationRows !== "object" || typeof corporationRows !== "object") return new Map();

  const factionOfCorporation = new Map();
  for (const row of Object.values(corporationRows)) {
    if (row === null || typeof row !== "object") continue;
    const corporationId = Number(row.corporationID);
    const factionId = Number(row.factionID);
    if (!Number.isSafeInteger(corporationId) || !Number.isSafeInteger(factionId)) continue;
    if (corporationId <= 0 || factionId <= 0) continue;
    factionOfCorporation.set(corporationId, factionId);
  }

  const counts = new Map();
  for (const row of Object.values(stationRows)) {
    if (row === null || typeof row !== "object") continue;
    const factionId = factionOfCorporation.get(Number(row.corporationID));
    if (factionId === undefined) continue;

    let bucket = counts.get(factionId);
    if (bucket === undefined) {
      bucket = { stations: 0, systems: new Set() };
      counts.set(factionId, bucket);
    }
    bucket.stations += 1;

    const solarSystemId = Number(row.solarSystemID);
    if (Number.isSafeInteger(solarSystemId) && solarSystemId > 0) bucket.systems.add(solarSystemId);
  }

  // The Sets never leave: a caller wants two numbers, and handing out a live Set
  // from a memoised map would make the cache mutable from a route.
  return new Map(
    [...counts].map(([factionId, bucket]) => [
      factionId,
      Object.freeze({ stations: bucket.stations, systemCount: bucket.systems.size }),
    ]),
  );
}

/** Thin wrapper supplying the real repository, memoised. See above. */
function getFactionStationCounts() {
  if (factionStationCountsCache === null) {
    factionStationCountsCache = readFactionStationCountsFromRuntime(getReadOnlyTableRepository());
  }
  return factionStationCountsCache;
}

/** Tests only, like `clearGameModuleCache`. Never called in production. */
function clearFactionStationCountsCache() {
  factionStationCountsCache = null;
}


/** The table this mod asks for the dump's stamp. Any static one would do. */
const FACTIONS_TABLE = "factions";

/**
 * Pure core: the static-data dump's own provenance stamp, or `null`.
 *
 * Every SDE-derived table in the store carries the identical `source` object
 * (`provider`, `authority`, `buildNumber`, `sdeUrl`, `releaseDate`,
 * `generatedAt`, `generatedBy`), because `tools/DatabaseCreator` writes them all
 * in one pass from one extraction. The stamp belongs to the dump, so which table
 * this asks is an implementation detail.
 *
 * It is the identity `lib/staticSnapshot.js` needs: the validator every
 * static-data route shares must move when, and only when, the operator rebuilds
 * the store, and `generatedAt` is the moment they did. `buildNumber` alone is
 * not enough: two builds of the same CCP dump are different datasets if the
 * extractor changed between them.
 *
 * `null` for a table that cannot be read or carries no stamp, which
 * `createStaticSnapshot` propagates: no stamp, no snapshot headers, and the
 * route's own failure is what a caller sees rather than a validator over a
 * guess.
 */
function readStaticDataStampFromRuntime(repository, tableName = FACTIONS_TABLE) {
  const read = requireOwnCallable(repository, "read", "gameStoreTableRepository");

  const result = read.call(repository, tableName, "/");
  const data = result && result.success && result.data && typeof result.data === "object"
    ? result.data
    : null;
  const source = data && data.source && typeof data.source === "object" ? data.source : null;
  if (source === null) return null;

  const authority = typeof source.authority === "string" ? source.authority : null;
  const generatedAt = typeof source.generatedAt === "string" ? source.generatedAt : null;
  if (authority === null || generatedAt === null) return null;

  return Object.freeze({
    authority,
    generatedAt,
    buildNumber: Number.isSafeInteger(Number(source.buildNumber)) ? Number(source.buildNumber) : null,
  });
}

/** Thin wrapper supplying the real repository. */
function getStaticDataStamp(tableName = FACTIONS_TABLE) {
  return readStaticDataStampFromRuntime(getReadOnlyTableRepository(), tableName);
}

// Structures, without running the world to read them.
//
// `/corporations/{corporation_id}/structures/` and
// `/universe/structures/{structure_id}/`.
//
// The design is the paragraph on `GAME_MODULES.structureState`: both vendor
// reads run `tickStructures` (the fuel and state machine over every structure on
// the server, ending in a `persistStructures`) unless `options.refresh ===
// false`. A `GET` must not.

/**
 * The only place either structure read is invoked, and the mechanism that makes
 * `{ refresh: false }` unomittable.
 *
 * There is no options parameter for a caller to forget, get wrong or override:
 * the option is supplied here, from the one frozen constant, for every read. The
 * two accessors below are the only callers and neither can pass anything in.
 *
 * Spread rather than passed by reference, for `getReadOnlyTableRepository`'s
 * reason: upstream reads the object but has never promised not to keep it, and a
 * frozen object reaching a mutator would turn a vendor change into a `TypeError`
 * thrown from inside game code.
 */
function readStructureState(structureStateModule, property, id) {
  const read = requireOwnCallable(structureStateModule, property, "structureState");
  return read.call(structureStateModule, id, { ...STRUCTURE_READ_OPTIONS });
}

/**
 * Pure core. `structureStateModule` is whatever exposes `listOwnedStructures`.
 *
 * Every non-destroyed structure a corporation owns, as records upstream has
 * already cloned (`listStructures` maps `cloneValue` over its rows), so unlike
 * `peekStructureRecord` below nothing live is in the result.
 *
 * Not an empty array when the export is gone. `routes/structures.js` refuses
 * that collapse, and the consequence is concrete: eve-nexum reads an empty
 * collection as authoritative and deletes every structure it had recorded for
 * the corporation. An empty array is a valid, complete, wrong answer; a
 * `GameModuleShapeError` is drift, and `routes/health.js` reports it. A non-array
 * return is drift too, and is not normalised into "no structures".
 */
function listCorporationStructuresFromRuntime(structureStateModule, corporationId) {
  const rows = readStructureState(structureStateModule, "listOwnedStructures", corporationId);
  if (!Array.isArray(rows)) {
    throw new GameModuleShapeError("structureState", "listOwnedStructures");
  }
  return rows;
}

/** Thin wrapper supplying the real module. */
function listCorporationStructures(corporationId) {
  return listCorporationStructuresFromRuntime(getGameModule("structureState"), corporationId);
}

/**
 * Pure core. `structureStateModule` is whatever exposes `getStructureByID`.
 *
 * One structure record by reference, or `null`. `peek` in the name is the
 * warning and the whole difference from the accessor above: `getStructureByID`
 * returns the cached row without cloning it, so this carries
 * `peekCharacterRecord`'s two rules (nothing above this line may mutate it, and
 * nothing may hold it across an await).
 *
 * There is no projector, unlike `peekCharacterRecord`. Its caller
 * (`routes/structures.js`) reads a dozen fields off the row through its own
 * required-field checks and refusals, and a projector would either duplicate
 * those here or hand the live row to a callback that looks owned. The caller
 * sees `peek`, and the rules attach to that word everywhere in this file.
 *
 * An unknown structure is `null`, not a throw; whether it is a 404 is
 * `routes/`'s decision.
 */
function peekStructureRecordFromRuntime(structureStateModule, structureId) {
  const record = readStructureState(structureStateModule, "getStructureByID", structureId);
  return record === null || typeof record !== "object" ? null : record;
}

/** Thin wrapper supplying the real module. */
function peekStructureRecord(structureId) {
  return peekStructureRecordFromRuntime(getGameModule("structureState"), structureId);
}

// Fleets, which exist only in memory.
//
// `/characters/{character_id}/fleet/` and `/fleets/{fleet_id}/members/`.
//
// Both accessors are shaped like `peekCharacterRecord`: a projector applied to
// the live record, returning a plain owned object. `fleetRuntime` keeps its
// fleets in three module-scope `Map`s, `getFleetByID` and `getFleetForCharacter`
// are one `Map.get` each, and what they return is the live fleet object the game
// is mutating, with its `members` `Map` hanging off it. There is no cloning door
// and nothing in the store to fall back on: a fleet is created in memory and
// destroyed when its members disconnect.
//
// The same two rules apply, and the `Map` sharpens the second: a `members` `Map`
// borrowed out of a projector is a handle onto a collection the game adds to and
// deletes from. Project, copy what is wanted, borrow nothing.
//
// `null` means "not in a fleet" or "no such fleet", the ordinary answer for
// these routes, which is why the routes duck-type these names and throw when
// they are absent instead of reporting every pilot as unfleeted.

/**
 * Pure core. `fleetRuntimeModule` is whatever exposes `getFleetForCharacter`.
 *
 * `project(fleet, characterID)` runs against the live fleet and must return a
 * value that borrows nothing from it. It defaults to a shallow copy, which for a
 * fleet is not sufficient (`members`, `wings` and the advert are nested), so
 * every real caller passes a projector.
 *
 * `null` for a character in no fleet, which is `/characters/{id}/fleet/`'s 404
 * and its most common answer.
 */
function peekFleetForCharacterFromRuntime(fleetRuntimeModule, characterId, options = {}) {
  const peek = requireOwnCallable(
    fleetRuntimeModule,
    "getFleetForCharacter",
    "fleetRuntime",
  );
  const fleet = peek.call(fleetRuntimeModule, characterId);
  if (fleet === null || typeof fleet !== "object") return null;

  const project = readOwnCallable(options, "project");
  return project ? project(fleet, characterId) : { ...fleet };
}

/** Thin wrapper supplying the real module. */
function peekFleetForCharacter(characterId, options = {}) {
  return peekFleetForCharacterFromRuntime(
    getGameModule("fleetRuntime"),
    characterId,
    options,
  );
}

/**
 * Pure core. `fleetRuntimeModule` is whatever exposes `getFleetByID`.
 *
 * The same shape and rules as `peekFleetForCharacterFromRuntime`, one key over:
 * `getFleetForCharacter` is `getFleetByID` of a `characterToFleet` lookup, so
 * the two return the same live object and neither may be handed upward.
 *
 * `null` for a fleet the runtime no longer holds. On `/fleets/{id}/members/` the
 * caller treats that as this server's race rather than a client's mistake,
 * because the gate proved the caller was in that fleet one call earlier.
 */
function peekFleetByIdFromRuntime(fleetRuntimeModule, fleetId, options = {}) {
  const peek = requireOwnCallable(fleetRuntimeModule, "getFleetByID", "fleetRuntime");
  const fleet = peek.call(fleetRuntimeModule, fleetId);
  if (fleet === null || typeof fleet !== "object") return null;

  const project = readOwnCallable(options, "project");
  return project ? project(fleet, fleetId) : { ...fleet };
}

/** Thin wrapper supplying the real module. */
function peekFleetById(fleetId, options = {}) {
  return peekFleetByIdFromRuntime(getGameModule("fleetRuntime"), fleetId, options);
}

// Saying one thing to one player.
//
// The mod's first write into the game (D3); the autopilot push below is the
// second. It is the narrowest thing that discharges the obligation: the
// `/esi <code>` bind command has to answer the player on every path, including
// failures, or they sit watching a browser that will never advance.
//
// One function rather than a chat handle, for the reason `countPlayers` returns
// a number rather than the sessions: a live chat object above this line would
// put `broadcastLocalMessage` and the channel-management exports within reach of
// a module that has no business with them. A replica of a read API should be
// unable to shout at the server, the argument `getReadOnlyTableRepository` makes
// about tables.
//
// Cheap by inspection: `sendSystemMessage` resolves the session's channel and
// hands one line to the XMPP layer, with no clone or table scan, so it is safe
// on the event loop the universe ticks on.

/**
 * Pure core. `chatHubModule` is whatever exposes `sendSystemMessage`.
 *
 * The game's signature is `(session, message, specificChannel = null)`, and
 * `null` means "wherever this session is listening", which is what a reply to a
 * slash command wants: the player typed into some channel and expects the answer
 * there.
 *
 * `String(message)` because this is the boundary: a `sendSystemMessage` handed a
 * non-string fails inside game code rather than ours, and the conversion is one
 * call.
 *
 * Throws `GameModuleShapeError` when the export is gone. That is drift, and the
 * slash patch's own try/catch turns it into a caught log line and one lost reply
 * rather than a broken command system.
 */
function sendChatSystemMessageFromRuntime(chatHubModule, session, message, channel = null) {
  const sendSystemMessage = requireOwnCallable(
    chatHubModule,
    "sendSystemMessage",
    "chatHub",
  );
  sendSystemMessage.call(chatHubModule, session, String(message), channel);
  return true;
}

/** Thin wrapper supplying the real module. */
function sendChatSystemMessage(session, message, channel = null) {
  return sendChatSystemMessageFromRuntime(
    getGameModule("chatHub"),
    session,
    message,
    channel,
  );
}

// Setting one pilot's autopilot route.
//
// The mod's second write into the game (D34), and the first that is not a reply
// to something a player typed. `POST /ui/autopilot/waypoint/` is the one write
// endpoint in scope, and this is all it reaches for: find the character's live
// session, hand it one notification, and say which of two things happened.
//
// The notification name is observed. Confirmed against a live client on
// 2026-08-25: two clicks in eve-nexum, against a connected retail client, both
// of which did in the game what the button said:
//
//   "set destination"    clear_other_waypoints=true   add_to_beginning=false
//   "add to waypoints"   clear_other_waypoints=false  add_to_beginning=false
//
// The two requests differ in exactly one argument and the game's behaviour
// differed with it. The notification is `OnDestinationChange`, `clientID` is an
// idType that reaches that pilot's own client, payload position 1 is the
// destination, and position 2 is `clear_other_waypoints`, which the client
// honours. That rules out the transposed reading `[id, first, clear]`, under
// which "set destination" would have sent first=true / clear=false and
// prepended rather than replaced.
//
// Position 3 is still an inference and nothing has exercised it. eve-nexum
// hardcodes `addToBeginning: false` at its only call site
// (`web/src/api/waypoint.ts`), so no request this replica has served has carried
// `add_to_beginning=true`. It is third, and the case for its meaning is below.
// One request with `add_to_beginning=true` against a pilot who already has a
// route settles it: the waypoint appears first or last.
//
// Where the name came from, before it was seen. Position 3 still rests on this.
// The case is `mods/nexumApi`'s: its `lib/runtimeAccess.js` records that the
// client's `StarMapSvc.__notifyevents__` decompiles to bare integers `[1..9]`
// (an uncompyle6 artifact on interned constants), so the name could not be read
// off a string literal, and four things pointed at `OnDestinationChange`. The
// class defines exactly nine `On*` methods to match the nine placeholders;
// `OnDestinationChange` is defined and never called anywhere in that tree; its
// body opens with `SetOff('Waypoints set remotely.')`; and its three arguments
// map 1:1 onto ESI's `destination_id` / `clear_other_waypoints` /
// `add_to_beginning`. nexumApi still gates this behind a config flag and has
// never had the confirmation. This mod had one and removed its flag with it.
//
// What this does not do: no queue, no retry, no server-side route state. eve.js
// has no autopilot, destination or route subsystem at all (`setDestination` and
// `activateAutopilot` appear in the vendor tree only as client-originated
// achievement counters), so anything durable here would be this replica
// inventing a game system, which D34 refuses. The push is fire-and-forget
// because the layer beneath it is: `sendNotification` opens by checking
// `this.socket.destroyed`, records a `packet.dropped` ledger event with
// `reason: "socket-closed"`, and returns.
//
// Cheap on the event loop, the same work `/status/` does per request:
// `findSessionByCharacterID` is an indexed `Map` get over one character's
// bucket, with a copy-and-scan of the live session set as the fallback for a
// character who is not connected. No clone, table read or SQLite.

/**
 * The notification the client is told about, and the id kind it is addressed
 * by.
 *
 * `"clientID"` is the `idType` every per-client notification in the game uses
 * (`walletState`'s `OnAccountChange`, `pvpFilamentMgrService`, and others), so
 * this half was read rather than inferred even before the pair was observed
 * working together.
 */
const DESTINATION_NOTIFICATION = "OnDestinationChange";
const DESTINATION_ID_TYPE = "clientID";

/**
 * What one push attempt did, in the vocabulary D34 named.
 *
 * `PUSH_FAILED` is for the caller that logs it and is never returned from this
 * module: a push fails by throwing (a game module that changed shape, or game
 * code that raised), and returning it would let a caller ignore a vendor drift
 * by accident. `routes/ui.js` is where the throw becomes the third log line.
 *
 * `PUSHED` does not mean delivered. `sendNotification` returns nothing and drops
 * the packet with a ledger event when the socket is already closing, so the
 * strongest true statement is "the game accepted the call". Reporting delivery
 * would promise more than the layer beneath does, which is why
 * `POST /ui/autopilot/waypoint/` answers `204` and never a body (D34).
 */
const PUSH_OUTCOME = Object.freeze({
  PUSHED: "pushed",
  NO_SESSION: "no-session",
  PUSH_FAILED: "push-failed",
});

/**
 * An id this module will hand to game code, or a throw.
 *
 * Shared by the two so "what counts as an id" cannot drift between the
 * character being addressed and the destination being sent. Neither value should
 * be able to fail here (`routes/ui.js` refuses a malformed `destination_id` with
 * CCP's own coercion body, and the character id is the subject of a verified
 * token), so this is an assertion rather than a parser. A throw becomes
 * `PUSH_FAILED` in the route's log, the loud direction.
 */
function requirePositiveId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(
      `ESI mod: ${label} must be a positive safe integer before it reaches game code, got `
        + `${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * Pure core. `sessionRegistryModule` is whatever exposes
 * `findSessionByCharacterID`.
 *
 * Returns `PUSH_OUTCOME.PUSHED` or `PUSH_OUTCOME.NO_SESSION`. Throws
 * `GameModuleShapeError` when either half of the vendor shape is gone, and
 * whatever game code throws when it throws.
 *
 * `NO_SESSION` is not "the pilot is offline", which is why this returns the
 * registry's own answer rather than a claim about presence.
 * `services/chat/sessionRegistry.js` says that character control and online
 * presence are derived through `characterControlRuntime` "so browser-pilot
 * leases never need fake sessions in this registry", so a pilot flying right now
 * through the browser is `NO_SESSION` here, indistinguishable from one who
 * logged out an hour ago. A caller that wants presence asks
 * `getCharacterOnlineSnapshot`.
 *
 * `sendNotification` is checked on the prototype chain rather than through
 * `readOwnCallable`, the one place in this file that does. Elsewhere a game
 * module is an object literal of exports, so an inherited `getSessions` would be
 * something other than the export the accessor means. A session is a class
 * instance and every method it has lives on `ClientSession.prototype`, so
 * own-property duck typing would reject the genuine article and accept nothing.
 *
 * Both ids are checked before the session is looked up, so a malformed request
 * reads as malformed whether or not the pilot is connected. The other order
 * reports a bad destination as `NO_SESSION` half the time.
 */
function sendDestinationChangeFromRuntime(sessionRegistryModule, request = {}) {
  const findSession = requireOwnCallable(
    sessionRegistryModule,
    "findSessionByCharacterID",
    "sessionRegistry",
  );

  const characterId = requirePositiveId(request.characterId, "characterId");
  const destinationId = requirePositiveId(request.destinationId, "destinationId");

  const session = findSession.call(sessionRegistryModule, characterId);
  if (session === null || typeof session !== "object") return PUSH_OUTCOME.NO_SESSION;

  const send = typeof session.sendNotification === "function" ? session.sendNotification : null;
  if (send === null) throw new GameModuleShapeError("sessionRegistry", "session.sendNotification");

  // Argument order is the contract, not the argument names: the client reads the
  // three positionally out of the notification payload tuple, so a reordering is a
  // pilot sent somewhere they did not ask to go, with their route silently
  // cleared. The first two positions are observed (see the header comment); the
  // third still stands on the decompiled reading.
  send.call(session, DESTINATION_NOTIFICATION, DESTINATION_ID_TYPE, [
    destinationId,
    request.clearOtherWaypoints === true,
    request.addToBeginning === true,
  ]);

  return PUSH_OUTCOME.PUSHED;
}

/** Thin wrapper supplying the real module. */
function sendDestinationChange(request = {}) {
  return sendDestinationChangeFromRuntime(getGameModule("sessionRegistry"), request);
}


/**
 * CCP's build number for the static data this install was built from, as a
 * string (`"3396210"`), or `null` when it cannot be read.
 *
 * `CreateDatabase.bat` extracts CCP's public dump to a directory named
 * `eve-online-static-data-<build>-jsonl`, and that name is the only place the
 * number survives: nothing in the generated store records it, and the running
 * server never reopens the dump. So this reads a directory name.
 *
 * This is `/status/`'s `server_version` (D12). It is a real CCP build number in
 * CCP's format, and answers the question a client displaying that field is
 * asking, which universe it is talking to, which neither eve.js's semver nor a
 * synthetic constant does.
 */
function readSdeBuildFrom(sdeRoot) {
  if (typeof sdeRoot !== "string" || sdeRoot === "") return null;

  let entries;
  try {
    entries = fs.readdirSync(sdeRoot, { withFileTypes: true });
  } catch (_) {
    // Unreadable, absent, or not a directory. An absent dump is a normal state for a
    // half-built checkout, not an error to propagate out of a status endpoint.
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^eve-online-static-data-(\d+)-jsonl$/.exec(entry.name);
    if (match) return match[1];
  }

  return null;
}


/**
 * Pure core: the configured system cost index, or `null`.
 *
 * `null` for a config that does not carry the key or carries something that is
 * not a number in `[0, 1]`, the range
 * `services/industry/industrySystemCostIndex.js` `clampCostIndex` enforces on
 * every read. Clamping is reproduced rather than borrowed because only this
 * module may require game code and the clamp is three lines, but the bounds are
 * upstream's and a value outside them is upstream drift rather than something
 * to silently correct.
 */
function readIndustryCostIndexFrom(config) {
  if (config === null || typeof config !== "object") return null;

  const value = Number(config.industrySystemCostIndex);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}

/** Thin wrapper supplying the real config module. */
function getIndustryCostIndex() {
  return readIndustryCostIndexFrom(getGameModule("config"));
}

/** Thin wrapper: the SDE root this install actually uses, then the build in it. */
function getSdeBuild() {
  return readSdeBuildFrom(getStorePaths().sdeRoot);
}

module.exports = Object.freeze({
  GAME_MODULES,
  getIndustryCostIndex,
  readIndustryCostIndexFrom,
  OWNER_SALT_FILE_NAME,
  READ_ONLY_REPOSITORY_OPTIONS,
  REFRESH_TOKEN_STORE_FILE_NAME,
  SDE_DIR_NAME,
  SERVER_SRC_SEARCH_DEPTH,
  SIGNING_KEY_FILE_NAME,
  SSO_DIR_NAME,
  STRUCTURE_READ_OPTIONS,
  TABLE_REPOSITORY_OWNER,
  GameModuleShapeError,

  findServerSrc,
  resolveServerSrcFrom,
  resolveServerSrcFromEnv,
  resolveServerSrc,

  gameModuleFilenameIn,
  getGameModule,
  loadGameModuleWith,
  peekGameModule,
  peekGameModuleWith,
  clearGameModuleCache,

  readOwnCallable,
  requireOwnCallable,

  isRuntimeReachable,
  isRuntimeReachableFromRuntime,

  getStorePaths,
  getStorePathsFromRuntime,
  sdeRootFromGameStoreRoot,
  getMarketDbPath,
  marketDbPathFromGameStoreRoot,
  ssoDirFromGameStoreRoot,
  ssoPathsFromDir,
  getSigningKeyPath,
  signingKeyPathFromGameStoreRoot,
  getRefreshTokenStorePath,
  refreshTokenStorePathFromGameStoreRoot,
  getOwnerSaltPath,
  ownerSaltPathFromGameStoreRoot,

  getReadOnlyTableRepository,
  getReadOnlyTableRepositoryFromRuntime,

  peekCharacterRecord,
  peekCharacterRecordFromRuntime,

  SKILLS_TABLE,
  listCharacterSkills,
  listCharacterSkillsFromRuntime,

  countPlayers,
  countPlayersFromRuntime,

  getCharacterOnlineSnapshot,
  getCharacterOnlineSnapshotFromRuntime,

  getCorporationMember,
  getCorporationMemberFromRuntime,

  getCorporationRecord,
  getCorporationRecordFromRuntime,

  getCorporationContacts,
  getCorporationContactsFromRuntime,

  getAllianceContacts,
  getAllianceContactsFromRuntime,

  getOwnerTypeId,
  getOwnerTypeIdFromRuntime,

  getAllianceRecord,
  getAllianceRecordFromRuntime,

  listFactionRecords,
  listFactionRecordsFromRuntime,

  CORPORATIONS_TABLE,
  FACTIONS_TABLE,
  STATIONS_TABLE,
  clearFactionStationCountsCache,
  getFactionStationCounts,
  getStaticDataStamp,
  readFactionStationCountsFromRuntime,
  readStaticDataStampFromRuntime,

  listCorporationStructures,
  listCorporationStructuresFromRuntime,

  peekStructureRecord,
  peekStructureRecordFromRuntime,

  peekFleetForCharacter,
  peekFleetForCharacterFromRuntime,

  peekFleetById,
  peekFleetByIdFromRuntime,

  sendChatSystemMessage,
  sendChatSystemMessageFromRuntime,

  DESTINATION_NOTIFICATION,
  DESTINATION_ID_TYPE,
  PUSH_OUTCOME,
  sendDestinationChange,
  sendDestinationChangeFromRuntime,

  getSdeBuild,
  readSdeBuildFrom,
});
