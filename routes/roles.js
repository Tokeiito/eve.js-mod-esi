/**
 * `GET /characters/{character_id}/roles/`: what corporation authority a pilot
 * holds.
 *
 * It has its own file because little is shared with `routes/characters.js`: a
 * different scope family, a different rate-limit bucket (`char-detail`, not
 * `char-location`), a TTL three orders of magnitude longer, and a body built
 * from a corporation record. It is keyed by `:character_id` only, so it needs
 * no `subject` declaration and gets `lib/router.js`'s cross-character
 * comparison.
 *
 * Observed 2026-08-25 against live ESI with a real token, on two characters
 * (`contract/wire.js` `CHARACTER_ROLES`; `test/rolesContract.test.js` reads it
 * from there):
 *
 *   1. All four arrays are present, and an empty one is sent as `[]`, not
 *      omitted. This is the opposite of what the same capture found for
 *      `/contacts/`'s `is_watched` and what `station_id` shows on the same
 *      producer, so neither was generalised into a house rule. The spec
 *      declares all four properties optional, and the projection has no
 *      `optional()`.
 *   2. `roles` was empty on both characters while `roles_at_base`,
 *      `roles_at_hq` and `roles_at_other` were populated. An empty `roles[]` is
 *      therefore ordinary on the real surface. This replica does not reproduce
 *      that: eve.js keeps the corporation-wide administrative bits in the member
 *      record's `roles` field and the hangar/container bits in the three
 *      locational fields, so a pilot with authority presents it in `roles[]`.
 *
 * The producer is the application: `contract/wire.js` `SUCCESS_KIND` carries
 * the row for this exact path from that capture, not an inference from
 * `/characters/{character_id}` (the gateway).
 *
 * Where the roles live: eve.js keeps corporation roles on a corporation
 * membership record, `runtime.members[String(characterID)]` in the
 * `corporationRuntime` table, with masks persisted as decimal strings
 * (`buildDefaultMemberState`, `services/corporation/corporationRuntimeState.js`,
 * `roles: roleMask.toString()`). Hence `BigInt` throughout: the admin mask is
 * `9222811354509877121`, about a thousand times `Number.MAX_SAFE_INTEGER`, so a
 * `Number` round trip loses whole roles.
 *
 * `getCorporationSessionRoleState` is deliberately not used. For a member of
 * the corporation it calls `ensureCharacterMemberState`, which calls
 * `updateCorporationRuntime` and persists a default member record for a
 * character that has none, so a read endpoint built on it would write into the
 * game on the first request from an unseen pilot. This file reads through
 * `getCorporationMember` (a clone-and-return) and `getCorporationRecord` (for
 * `ceoID`) and reproduces only the short-circuit, as `routes/characters.js`
 * does with `peekCharacterRecord` versus `getCharacterRecord`.
 *
 * Divergences from the game, accepted:
 *
 *   1. Title-granted role bits are missed. eve.js lets a corporation grant
 *      roles through a title, but the accessor that ORs them in,
 *      `getEffectiveMemberRoleMask`, is not exported. Re-deriving it here would
 *      be a silently drifting copy of vendor logic. A pilot whose authority
 *      comes only from a title reports fewer roles than the game grants.
 *   2. Nine of eve.js's 55 role bits are never emitted (see the table).
 *   3. `grantableRoles` and its locational equivalents have no ESI property
 *      and are not projected.
 *   4. Array order is ours: the wire order is unobserved. Arrays are sorted on
 *      the ESI name, which is the order CCP's `enum` is written in
 *      (`test/rolesContract.test.js` asserts the enum is sorted).
 *
 * The bit table: eve.js implements CCP's 64-bit corporation-role mask (its own
 * comment cites V24.01 `appConst.py`), and its split between the
 * administrative mask and the three locational masks is ESI's split between
 * `roles` and `roles_at_*`. It is not a bijection. `ALL_CORPORATION_ROLE_MASK`
 * has 55 bits and CCP's enum has 54 names, and the document does not say which
 * bit is unnamed. The bits divide three ways:
 *
 *   - 46 read: the eve.js constant's name is the ESI name
 *     (`CORP_ROLE_DIRECTOR` / `Director`, `CORP_ROLE_STATION_MANAGER` /
 *     `Station_Manager`, `ROLE_HANGAR_TAKE_1..7` / `Hangar_Take_1..7`, ...).
 *     These are `CORPORATION_ROLE_BITS`, each checked against the vendor tree.
 *   - 5 near-matches: an eve.js constant merely close to an unassigned ESI
 *     name (`CORP_ROLE_CHAT_MANAGER` and `Communications_Officer`,
 *     `ROLE_FACTORY_MANUFACTURING` and `Rent_Factory_Facility`, and three more).
 *   - 4 unnamed: no corporation-role name anywhere in the vendor tree.
 *
 * The last two groups are dropped, not emitted under a plausible name: nine
 * bits compete for eight remaining names, so at least one is wrong.
 * Under-reporting a capability is the direction this replica already chose for
 * `last_login` and `logins`; over-reporting makes a client attempt something
 * the character cannot do. `Director` and `Station_Manager` are not in the
 * dropped set.
 *
 * Hazard: `services/account/accountRoleProfiles.js` declares a different
 * 64-bit namespace over the same numeric values (`4503599627370496` is
 * `ROLE_QA` there and `CORP_ROLE_JUNIOR_ACCOUNTANT` here; `2251799813685248` is
 * `ROLE_PROGRAMMER` there and `ROLE_FACTORY_SCIENCE` in industry's table). A
 * lookup that reached the wrong module would publish a GM flag as a corporation
 * role. Membership in `ALL_CORPORATION_ROLE_MASK` keeps them apart, which is
 * why that mask is copied below and checked against the vendor tree by a test.
 * eve.js has no bit-to-display-name table (`roleName`, `ROLE_NAMES` and the
 * literal `"Director"` as a role name all come up empty), so the mapping is
 * this module's to own and can only be checked, not imported.
 *
 * Everything is injected: `deps.runtime` is `lib/runtimeAccess.js` or a
 * double, taken through the factory's closure as in `routes/characters.js`.
 * The accessors duck-typed here (`peekCharacterRecord`, `getCorporationMember`,
 * `getCorporationRecord`) may be missing from `lib/runtimeAccess.js`, and an
 * absent one is a throw naming it, not an empty `roles[]` (see
 * `readMemberRoles`).
 */

"use strict";

const { projection } = require("../lib/serialize");
const {
  familyFor,
  missingRequiredRole,
  notInCorporation,
} = require("../lib/errors");
const { CHARACTER_ID_PARAM } = require("./characters");

// The route

/** Canonical path: no version prefix, no trailing slash. */
const ROLES_PATH = "/characters/:character_id/roles";

/** `x-cache-age` in the pinned spec: an hour, and `x-client-cache-ttl` agrees. */
const ROLES_CACHE_TTL_SECONDS = 3600;

/** The scope CCP publishes for this operation. */
const ROLES_SCOPE = "esi-characters.read_corporation_roles.v1";

/**
 * `char-detail`, 600 tokens per 15 minutes, not the `char-location` bucket of
 * `routes/characters.js`.
 */
const RATE_LIMIT_GROUP = "char-detail";

/**
 * The application, observed. `contract/wire.js` `SUCCESS_KIND` carries the row
 * for `/characters/:character_id/roles` from the 2026-08-25 capture.
 */
const PRODUCER = "app";

// eve.js's corporation-role vocabulary

/**
 * `ALL_CORPORATION_ROLE_MASK`, copied from
 * `services/corporation/corporationRuntimeState.js`.
 *
 * Copied because only `lib/runtimeAccess.js` may require game code (as
 * `lib/sessionIdentity.js` does with the GM role bits), and checked by a
 * vendor-drift test that re-reads the declaration upstream.
 *
 * 55 bits. It decides "is this a corporation role bit at all", which keeps the
 * identically-numbered GM namespace out of `roles[]`.
 */
const EVEJS_ALL_CORPORATION_ROLE_MASK = 9223369906550996879n;

/**
 * `FULL_LOCATIONAL_ROLE_MASK`, copied from the same module: deliveries, the
 * seven hangar-take bits, the seven hangar-query bits and the seven
 * container-take bits.
 *
 * Its complement is what eve.js calls "administrative", which is ESI's `roles`
 * versus `roles_at_*` split. The director short-circuit needs both halves.
 */
const EVEJS_FULL_LOCATIONAL_ROLE_MASK = 558552041119758n;

/**
 * `FULL_ADMIN_ROLE_MASK`, derived as upstream derives it (`ALL & ~LOCATIONAL`)
 * rather than copied as a third literal, so a drift in either input moves it
 * too.
 */
const EVEJS_FULL_ADMIN_ROLE_MASK =
  EVEJS_ALL_CORPORATION_ROLE_MASK & ~EVEJS_FULL_LOCATIONAL_ROLE_MASK;

/**
 * Bit 0. A director holds every administrative role in the game's own
 * reading; `readMemberRoles` reproduces that short-circuit.
 */
const CORP_ROLE_DIRECTOR = 1n;

/**
 * Bit 11, the one `/corporations/{id}/structures/` is gated on
 * (`x-required-roles: ["Station_Manager"]`).
 *
 * Exported for `routes/structures.js`, so the gate and the body a client reads
 * to predict it agree about which bit this is. eve.js does not export it (only
 * `CORP_ROLE_DIRECTOR` and the four masks), so the constant is this module's,
 * under the same drift test as the table.
 */
const CORP_ROLE_STATION_MANAGER = 2048n;

/**
 * The 46 bits whose eve.js constant name is the ESI role name, in ascending
 * bit order.
 *
 * Ascending order matches the vendor declarations and keeps the three
 * seven-bit families legible. Output order is imposed separately by sorting on
 * the name, in `decodeRoleMask`.
 *
 * `where` names the vendor declaration each mapping was read from, relative to
 * `server/src`.
 *
 * `Container_Take_1..7` is a reading of a set: eve.js declares them only as
 * the seven members of `CORP_ROLE_CONTAINER_CAN_TAKE_ALL`, so the index within
 * the family follows ascending bit order. That is the order the families eve.js
 * does name individually (`Hangar_Take_1..7`, `Account_Take_1..7`) show, and
 * upstream's comment ties the ascending `Account_Take` bits to wallet
 * divisions 1000..1006 in order.
 */
const CORPORATION_ROLE_BITS = Object.freeze([
  Object.freeze({ role: "Director", bit: 1n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_DIRECTOR" }),
  Object.freeze({ role: "Deliveries_Take", bit: 2n, where: "services/industry/industryConstants.js ROLE_DELIVERIES_TAKE" }),
  Object.freeze({ role: "Deliveries_Query", bit: 4n, where: "services/industry/industryConstants.js ROLE_DELIVERIES_QUERY" }),
  Object.freeze({ role: "Personnel_Manager", bit: 128n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_PERSONNEL_MANAGER" }),
  Object.freeze({ role: "Accountant", bit: 256n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_ACCOUNTANT" }),
  Object.freeze({ role: "Factory_Manager", bit: 1024n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_FACTORY_MANAGER" }),
  Object.freeze({ role: "Station_Manager", bit: 2048n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_STATION_MANAGER" }),
  Object.freeze({ role: "Auditor", bit: 4096n, where: "services/corporation/corpmgrService.js CORP_ROLE_AUDITOR" }),
  Object.freeze({ role: "Hangar_Take_1", bit: 8192n, where: "services/industry/industryConstants.js ROLE_HANGAR_TAKE_1" }),
  Object.freeze({ role: "Hangar_Take_2", bit: 16384n, where: "services/industry/industryConstants.js ROLE_HANGAR_TAKE_2" }),
  Object.freeze({ role: "Hangar_Take_3", bit: 32768n, where: "services/industry/industryConstants.js ROLE_HANGAR_TAKE_3" }),
  Object.freeze({ role: "Hangar_Take_4", bit: 65536n, where: "services/industry/industryConstants.js ROLE_HANGAR_TAKE_4" }),
  Object.freeze({ role: "Hangar_Take_5", bit: 131072n, where: "services/industry/industryConstants.js ROLE_HANGAR_TAKE_5" }),
  Object.freeze({ role: "Hangar_Take_6", bit: 262144n, where: "services/industry/industryConstants.js ROLE_HANGAR_TAKE_6" }),
  Object.freeze({ role: "Hangar_Take_7", bit: 524288n, where: "services/industry/industryConstants.js ROLE_HANGAR_TAKE_7" }),
  Object.freeze({ role: "Hangar_Query_1", bit: 1048576n, where: "services/industry/industryConstants.js ROLE_HANGAR_QUERY_1" }),
  Object.freeze({ role: "Hangar_Query_2", bit: 2097152n, where: "services/industry/industryConstants.js ROLE_HANGAR_QUERY_2" }),
  Object.freeze({ role: "Hangar_Query_3", bit: 4194304n, where: "services/industry/industryConstants.js ROLE_HANGAR_QUERY_3" }),
  Object.freeze({ role: "Hangar_Query_4", bit: 8388608n, where: "services/industry/industryConstants.js ROLE_HANGAR_QUERY_4" }),
  Object.freeze({ role: "Hangar_Query_5", bit: 16777216n, where: "services/industry/industryConstants.js ROLE_HANGAR_QUERY_5" }),
  Object.freeze({ role: "Hangar_Query_6", bit: 33554432n, where: "services/industry/industryConstants.js ROLE_HANGAR_QUERY_6" }),
  Object.freeze({ role: "Hangar_Query_7", bit: 67108864n, where: "services/industry/industryConstants.js ROLE_HANGAR_QUERY_7" }),
  Object.freeze({ role: "Account_Take_1", bit: 134217728n, where: "services/industry/industryConstants.js ROLE_ACCOUNT_TAKE_1" }),
  Object.freeze({ role: "Account_Take_2", bit: 268435456n, where: "services/industry/industryConstants.js ROLE_ACCOUNT_TAKE_2" }),
  Object.freeze({ role: "Account_Take_3", bit: 536870912n, where: "services/industry/industryConstants.js ROLE_ACCOUNT_TAKE_3" }),
  Object.freeze({ role: "Account_Take_4", bit: 1073741824n, where: "services/industry/industryConstants.js ROLE_ACCOUNT_TAKE_4" }),
  Object.freeze({ role: "Account_Take_5", bit: 2147483648n, where: "services/industry/industryConstants.js ROLE_ACCOUNT_TAKE_5" }),
  Object.freeze({ role: "Account_Take_6", bit: 4294967296n, where: "services/industry/industryConstants.js ROLE_ACCOUNT_TAKE_6" }),
  Object.freeze({ role: "Account_Take_7", bit: 8589934592n, where: "services/industry/industryConstants.js ROLE_ACCOUNT_TAKE_7" }),
  Object.freeze({ role: "Diplomat", bit: 17179869184n, where: "services/corporation/allianceRegistryRuntime.js CORP_ROLE_DIPLOMAT" }),
  Object.freeze({ role: "Brand_Manager", bit: 34359738368n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_BRAND_MANAGER" }),
  Object.freeze({ role: "Config_Equipment", bit: 2199023255552n, where: "services/inventory/invBroker/secureContainers.js CORP_ROLE_EQUIPMENT_CONFIG" }),
  Object.freeze({ role: "Container_Take_1", bit: 4398046511104n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_CONTAINER_CAN_TAKE_ALL" }),
  Object.freeze({ role: "Container_Take_2", bit: 8796093022208n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_CONTAINER_CAN_TAKE_ALL" }),
  Object.freeze({ role: "Container_Take_3", bit: 17592186044416n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_CONTAINER_CAN_TAKE_ALL" }),
  Object.freeze({ role: "Container_Take_4", bit: 35184372088832n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_CONTAINER_CAN_TAKE_ALL" }),
  Object.freeze({ role: "Container_Take_5", bit: 70368744177664n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_CONTAINER_CAN_TAKE_ALL" }),
  Object.freeze({ role: "Container_Take_6", bit: 140737488355328n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_CONTAINER_CAN_TAKE_ALL" }),
  Object.freeze({ role: "Container_Take_7", bit: 281474976710656n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_CONTAINER_CAN_TAKE_ALL" }),
  Object.freeze({ role: "Rent_Office", bit: 562949953421312n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_CAN_RENT_OFFICE" }),
  Object.freeze({ role: "Junior_Accountant", bit: 4503599627370496n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_JUNIOR_ACCOUNTANT" }),
  Object.freeze({ role: "Trader", bit: 18014398509481984n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_TRADER" }),
  Object.freeze({ role: "Contract_Manager", bit: 72057594037927936n, where: "services/contracts/contractRuntimeState.js CORP_ROLE_CONTRACT_MANAGER" }),
  Object.freeze({ role: "Fitting_Manager", bit: 576460752303423488n, where: "_secondary/fitting/fittingStore.js CORP_ROLE_FITTING_MANAGER" }),
  Object.freeze({ role: "Project_Manager", bit: 1152921504606846976n, where: "services/corporation/corporationRuntimeState.js CORP_ROLE_PROJECT_MANAGER" }),
  Object.freeze({ role: "Skill_Plan_Manager", bit: 4611686018427387904n, where: "_secondary/express/gatewayServices/corpSkillPlanGatewayService.js CORP_ROLE_SKILL_PLAN_MANAGER" }),
]);

/**
 * The nine bits this replica never emits, as a recorded set.
 *
 * Five carry an eve.js name merely near an unassigned ESI name; four carry no
 * corporation-role name in the vendor tree. `candidate` is the ESI name a
 * near-match would take, so settling one (CCP publishing a mapping, or eve.js
 * gaining a display-name table) is a one-line change in the table above.
 *
 * `null` means no candidate. After the five are set aside, three ESI names are
 * unassigned: `Config_Starbase_Equipment`, `Security_Officer` and
 * `Starbase_Defense_Operator`. Nine bits, eight names.
 */
const UNMAPPED_ROLE_BITS = Object.freeze([
  Object.freeze({ bit: 8n, evejs: "unnamed; only inside CORP_ROLE_DELIVERIES_ALL", candidate: "Deliveries_Container_Take" }),
  Object.freeze({ bit: 512n, evejs: null, candidate: null }),
  Object.freeze({ bit: 1125899906842624n, evejs: "ROLE_FACTORY_MANUFACTURING", candidate: "Rent_Factory_Facility" }),
  Object.freeze({ bit: 2251799813685248n, evejs: "ROLE_FACTORY_SCIENCE", candidate: "Rent_Research_Facility" }),
  Object.freeze({ bit: 9007199254740992n, evejs: null, candidate: null }),
  Object.freeze({ bit: 36028797018963968n, evejs: "CORP_ROLE_CHAT_MANAGER", candidate: "Communications_Officer" }),
  Object.freeze({ bit: 144115188075855872n, evejs: null, candidate: null }),
  Object.freeze({ bit: 288230376151711744n, evejs: "CORP_ROLE_STARBASE_CARETAKER", candidate: "Starbase_Fuel_Technician" }),
  Object.freeze({ bit: 2305843009213693952n, evejs: null, candidate: null }),
]);

// Reading a mask

/** A run of decimal digits, and nothing else. Masks are stored as strings. */
const DECIMAL_MASK = /^\d+$/;

/**
 * A persisted role mask as a `BigInt`, or `null` for a value that cannot be
 * read as one.
 *
 * `null` rather than `0n`, so a caller can tell "this member holds no roles"
 * from "this field is not what this code thinks it is". A negative or
 * non-decimal value is unreadable: eve.js writes `roleMask.toString()` on an
 * unsigned mask, so anything else is drift.
 */
function toRoleMask(value) {
  if (typeof value === "bigint") return value < 0n ? null : value;
  if (typeof value !== "string" && typeof value !== "number") return null;

  const digits = String(value).trim();
  if (!DECIMAL_MASK.test(digits)) return null;

  return BigInt(digits);
}

/**
 * The ESI role names a mask carries, sorted.
 *
 * Masked against `EVEJS_ALL_CORPORATION_ROLE_MASK` first: a bit outside it is
 * not a corporation role (the identically-numbered GM namespace is what this
 * guards). A bit inside it that the table does not name is dropped
 * (`UNMAPPED_ROLE_BITS`).
 *
 * The sort is `Array.prototype.sort()` on the name and is ours, since the wire
 * order is unobserved. It agrees with the order CCP writes the enum in, which
 * `test/rolesContract.test.js` checks.
 */
function decodeRoleMask(mask) {
  if (typeof mask !== "bigint" || mask <= 0n) return [];

  const corporationBits = mask & EVEJS_ALL_CORPORATION_ROLE_MASK;
  return CORPORATION_ROLE_BITS
    .filter((entry) => (corporationBits & entry.bit) !== 0n)
    .map((entry) => entry.role)
    .sort();
}

/** Does this mask carry this bit? The gate `routes/structures.js` asks. */
function holdsRole(mask, bit) {
  return typeof mask === "bigint" && typeof bit === "bigint" && (mask & bit) !== 0n;
}

// Reading the game

/**
 * The error a route here raises when it cannot answer for a character its own
 * gate has already vouched for.
 *
 * As `unreadable` in `routes/characters.js`: `lib/router.js` has proved a
 * credential was presented, verifies, carries this route's scope and names this
 * character, and a credential exists only because the minter read that
 * character's record. An unreadable record is therefore this server's
 * inconsistency, a logged `500` rather than a `404`.
 */
function unreadable(operationId, characterId, detail) {
  return new Error(
    `ESI mod: ${operationId} cannot answer for character ${characterId}: ${detail}. `
      + "A token for that character was minted by this server, so the record was readable then "
      + "and is not now: this is a server-side inconsistency, not a client error.",
  );
}

/** `deps.runtime`, or an empty object: the accessors are duck-typed below. */
function readRuntime(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  return d.runtime && typeof d.runtime === "object" ? d.runtime : {};
}

/**
 * Who is asking, as a number that was signed.
 *
 * `params.credential.characterId`, never `params.path.character_id`; see
 * `callerCharacterId` in `routes/characters.js`. The path segment is a string
 * the requester typed, the claim is a number this server signed, and the gate
 * has already proved they agree.
 */
function callerCharacterId(params) {
  const credential = params && params.credential;
  const characterId = credential && credential.characterId;

  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new Error(
      "ESI mod: a corporation-role route ran with no verified credential. Every route in this "
        + "module declares a scope, so lib/router.js authorise() should have refused the request "
        + "before the handler saw it.",
    );
  }

  return characterId;
}

/**
 * Which corporation a character belongs to, from the live character record.
 *
 * Through `peekCharacterRecord` with a `project` callback, as
 * `routes/characters.js` reads location and ship: the callback runs against the
 * live in-memory record, copies the one field it wants and borrows nothing,
 * and there is no `await` to hold a record across.
 *
 * A missing accessor and a missing record both throw. Reporting "no
 * corporation, therefore no roles" would be a body consumers act on: one
 * consumer reads an empty `roles[]` as `no_role` and stops syncing cleanly and
 * silently, so a real commander would look like a pilot with no authority. A
 * logged `500` makes it report an error and abort.
 */
function readCallerCorporationId(runtime, operationId, characterId) {
  if (typeof runtime.peekCharacterRecord !== "function") {
    throw unreadable(operationId, characterId, "the runtime exposes no peekCharacterRecord accessor");
  }

  const record = runtime.peekCharacterRecord(characterId, {
    project: (found) => ({ corporationID: found.corporationID }),
  });
  if (record === null || typeof record !== "object") {
    throw unreadable(operationId, characterId, "the game has no record for that character");
  }

  const corporationId = Number(record.corporationID);
  if (!Number.isSafeInteger(corporationId) || corporationId <= 0) {
    throw unreadable(
      operationId,
      characterId,
      "the record carries no readable corporationID, and corporation roles live on a "
        + "corp-membership record rather than on the character",
    );
  }

  return corporationId;
}

/**
 * The four role masks for a character's membership of a corporation, as
 * `BigInt`s, without writing anything into the game.
 *
 * Composed from two exported, non-mutating accessors that replace
 * `getCorporationSessionRoleState`:
 *
 *   1. `getCorporationMember`: a clone-and-return of the member record, or
 *      `null` for a character the corporation runtime has never seen.
 *   2. `getCorporationRecord`: for `ceoID`, which the member record cannot
 *      answer on its own.
 *
 * Director short-circuit: eve.js gives a CEO, or any holder of bit 0, the full
 * administrative mask and all three locational masks at read time, regardless
 * of what is persisted on the member record. That is what the game authorises
 * with, so omitting it would describe a pilot as less able than every other
 * subsystem treats them, and directors are exactly who is expected to read a
 * corporation's structures.
 *
 * It also makes a missing member record answerable: `buildDefaultMemberState`
 * would give a non-CEO `"0"` and the CEO the full masks, so the answer follows
 * from `ceoID` alone. Computing it avoids calling the accessor that creates the
 * record.
 *
 * `isCEO` on the member record is not trusted alone: it is stamped when the
 * record is built and does not follow a later change of CEO. The corporation
 * record is asked, and the member flag is a second way to say yes.
 */
function readMemberRoles(runtime, operationId, characterId, corporationId) {
  if (typeof runtime.getCorporationMember !== "function") {
    throw unreadable(
      operationId,
      characterId,
      "the runtime exposes no getCorporationMember accessor. It must be the clone-and-return "
        + "read, never getCorporationSessionRoleState, which persists a default member "
        + "record for a member the runtime has not seen",
    );
  }
  if (typeof runtime.getCorporationRecord !== "function") {
    throw unreadable(
      operationId,
      characterId,
      "the runtime exposes no getCorporationRecord accessor, and ceoID is what decides the "
        + "director short-circuit for a character with no member record",
    );
  }

  const member = runtime.getCorporationMember(corporationId, characterId);
  const corporation = runtime.getCorporationRecord(corporationId);

  const ceoId = corporation === null || typeof corporation !== "object"
    ? null
    : Number(corporation.ceoID);
  const isCeo = Number.isSafeInteger(ceoId) && ceoId > 0 && ceoId === characterId;

  const found = member !== null && typeof member === "object" ? member : {};

  // `null` from `toRoleMask` is an unreadable field, treated as empty on
  // purpose: a member record whose `roles` is not a decimal string is upstream
  // drift, which the drift test finds. Failing the request would turn a vendor
  // rename into an outage on a route whose worst honest answer is four empty
  // arrays.
  const persisted = {
    roles: toRoleMask(found.roles) || 0n,
    rolesAtBase: toRoleMask(found.rolesAtBase) || 0n,
    rolesAtHq: toRoleMask(found.rolesAtHQ) || 0n,
    rolesAtOther: toRoleMask(found.rolesAtOther) || 0n,
  };

  if (isCeo || found.isCEO === true || holdsRole(persisted.roles, CORP_ROLE_DIRECTOR)) {
    return {
      roles: EVEJS_FULL_ADMIN_ROLE_MASK,
      rolesAtBase: EVEJS_FULL_LOCATIONAL_ROLE_MASK,
      rolesAtHq: EVEJS_FULL_LOCATIONAL_ROLE_MASK,
      rolesAtOther: EVEJS_FULL_LOCATIONAL_ROLE_MASK,
    };
  }

  return persisted;
}

/**
 * The four masks for whoever is asking: the composition this route and the
 * role gate of `/corporations/{id}/structures/` both need.
 *
 * Exported so `routes/structures.js` asks the same question the same way; the
 * body a client reads to predict the gate and the gate must not disagree.
 */
function readCallerRoles(runtime, operationId, characterId) {
  const corporationId = readCallerCorporationId(runtime, operationId, characterId);
  return {
    corporationId,
    masks: readMemberRoles(runtime, operationId, characterId, corporationId),
  };
}

// The corporation gate, shared

/**
 * A path segment this replica will treat as an entity id: digits, no leading
 * zero, nothing else.
 *
 * The same round trip `lib/router.js` `SUBJECT_SEGMENT` applies to
 * `character_id`, needed here because the router applies it to that parameter
 * only. `Number()` alone accepts `0123123`, `1.23123e5`, `0x1e0f3`, `+123123`
 * and `" 123123 "` as 123123, so a comparison built on it would authorise
 * "corporation 123123" and hand the handler `"1.23123e5"`, which `parseInt`
 * reads as 1: a read of somebody else's corporation inside the authorised path.
 */
const CANONICAL_ID = /^[1-9][0-9]*$/;

/** A path parameter as a positive integer, or `null` for anything else. */
function canonicalId(value) {
  const segment = String(value === undefined || value === null ? "" : value);
  if (!CANONICAL_ID.test(segment)) return null;

  const id = Number(segment);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The bit CCP's role name stands for, or a throw naming the name.
 *
 * Routes declare roles as the document spells them in `x-required-roles`
 * (`"Director"`, `"Factory_Manager"`) and this resolves them through
 * `CORPORATION_ROLE_BITS`, the one table that ties an ESI role name to an
 * eve.js bit. A route holding the bit itself would be a second place the
 * pairing lives.
 *
 * It throws at construction rather than returning `null` at request time: a
 * route declaring a role this table cannot name has a gate that never opens,
 * which should be a boot failure naming the route.
 */
function roleBitFor(name) {
  const row = CORPORATION_ROLE_BITS.find((entry) => entry.role === name);
  if (row === undefined) {
    throw new Error(
      `ESI mod: no corporation role bit for ${JSON.stringify(name)}. Spell it as CCP's `
        + "x-required-roles spells it, and check CORPORATION_ROLE_BITS: a role eve.js does not "
        + "implement has no bit here and a route gated on one could never be entered.",
    );
  }
  return row.bit;
}

/**
 * A `subject` for a route keyed by `:corporation_id` and gated on a role.
 *
 * Two questions, in the order CCP's statuses imply and cheapest first: is the
 * caller in this corporation at all, and do they hold one of the roles the
 * operation declares. Both refusals have observed bytes
 * (`contract/wire.js` `REQUIRED_ROLE_REFUSAL`), so neither throws.
 *
 * The role list is read as "any of". Every operation declares either one role
 * or the pair `["Accountant", "Trader"]` on the two corporation market
 * operations, which CCP documents as an alternative. Requiring both would lock
 * out a trader who is not an accountant.
 *
 * A non-canonical `corporation_id` is answered as "not the caller's
 * corporation". Real ESI would refuse `/corporations/abc/assets/` with a
 * coercion `400` before asking who was calling; this replica answers the
 * membership `403`. `lib/errors.js` `coercionFailed` has the observed body, but
 * every observation of it is of a refusal dressed by `routedRefusal` without
 * `X-Esi-Cache-Status`, and a gate refusal carries one. Observed bytes attached
 * to a true claim (the caller is not a member of a corporation that cannot
 * exist) beat invented headers.
 *
 * `deps` is the factory's, closed over, and that is required. `lib/router.js`
 * hands a `subject` function the dispatch deps (`now`, `logError`), not the
 * route factory's, so a gate reading `runtime` off its third argument would
 * log a `500` on every request while passing every unit test of the gate
 * itself. The third argument is deliberately not read.
 *
 * @param {object} options
 * @param {string} options.operationId  CCP's, for the log line on an unreadable record
 * @param {string[]} options.roles      role names as `x-required-roles` spells them
 * @param {object} options.deps         the route factory's, carrying `runtime`
 * @param {string} [options.param]      the path parameter, `corporation_id`
 * @returns {Function} `(claims, pathParams) => refusal | null`
 */
function corporationRoleSubject({ operationId, roles, deps, param = "corporation_id" }) {
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error(
      `ESI mod: ${operationId} declares no corporation role. Pass the operation's `
        + "x-required-roles, or use SUBJECT.SCOPE_ONLY and say why the scope is the whole gate.",
    );
  }

  // Resolved now, so a misspelled role is a boot failure naming the route rather
  // than a gate that never opens.
  const bits = roles.map((name) => roleBitFor(name));
  const family = familyFor(PRODUCER);

  return function subject(claims, pathParams) {
    const runtime = deps && typeof deps === "object" && deps.runtime && typeof deps.runtime === "object"
      ? deps.runtime
      : {};
    const characterId = claims.characterId;

    const requested = canonicalId(pathParams && pathParams[param]);
    const { corporationId, masks } = readCallerRoles(runtime, operationId, characterId);

    if (requested === null || requested !== corporationId) {
      return notInCorporation(family);
    }

    if (!bits.some((bit) => holdsRole(masks.roles, bit))) {
      return missingRequiredRole(family);
    }

    return null;
  };
}

// The body

/**
 * The projection, in CCP's field order.
 *
 * Alphabetical: `contract/wire.js` `CHARACTER_ROLES.fieldOrder`, which here
 * also matches the spec's declaration order (unlike `/ship/`).
 *
 * No `optional()`: all four properties are declared optional by the spec and
 * were observed present, an empty one as `[]`. Omitting empty arrays would
 * change the body for every character with no roles, which on a fresh server
 * is everybody but the CEO.
 */
const projectCharacterRoles = projection("GetCharactersCharacterIdRoles", {
  roles: (masks) => decodeRoleMask(masks.roles),
  roles_at_base: (masks) => decodeRoleMask(masks.rolesAtBase),
  roles_at_hq: (masks) => decodeRoleMask(masks.rolesAtHq),
  roles_at_other: (masks) => decodeRoleMask(masks.rolesAtOther),
});

/**
 * `GET /characters/{character_id}/roles/`.
 *
 * @param {object} params  the router's, with `credential` already verified
 * @param {object} [deps]  `{ runtime }`, from the factory's closure
 */
function buildCharacterRoles(params, deps) {
  const characterId = callerCharacterId(params);
  const runtime = readRuntime(deps);
  const { masks } = readCallerRoles(runtime, "GetCharactersCharacterIdRoles", characterId);

  return projectCharacterRoles(masks);
}

// The route descriptor

/**
 * Callable as `factory({})`: the deps are read inside the handler, never at
 * construction.
 *
 * No `subject`: the route is keyed by `:character_id` only, so `compileRoute`
 * does not demand one and the default `SUBJECT.CALLER` (the cross-character
 * comparison) is the right check. The two routes in `routes/structures.js` are
 * the opposite case and say so.
 *
 * No `localizedBody`: the body is enum strings from a fixed vocabulary, with no
 * `name` or `description`, so it sends the three-line `Vary`.
 * `test/varyLocalization.test.js` checks that against the spec's `200` schema.
 *
 * No `errorFamily`: `lib/router.js` derives it from `producer`.
 */
function createCharacterRolesRoute(deps) {
  return {
    method: "GET",
    path: ROLES_PATH,
    name: "GetCharactersCharacterIdRoles",
    handler: (params) => buildCharacterRoles(params, deps),
    producer: PRODUCER,
    scope: ROLES_SCOPE,
    cacheTtl: ROLES_CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
  };
}

module.exports = Object.freeze({
  CANONICAL_ID,
  CHARACTER_ID_PARAM,
  CORPORATION_ROLE_BITS,
  CORP_ROLE_DIRECTOR,
  CORP_ROLE_STATION_MANAGER,
  EVEJS_ALL_CORPORATION_ROLE_MASK,
  EVEJS_FULL_ADMIN_ROLE_MASK,
  EVEJS_FULL_LOCATIONAL_ROLE_MASK,
  PRODUCER,
  RATE_LIMIT_GROUP,
  ROLES_CACHE_TTL_SECONDS,
  ROLES_PATH,
  ROLES_SCOPE,
  UNMAPPED_ROLE_BITS,
  buildCharacterRoles,
  canonicalId,
  corporationRoleSubject,
  createCharacterRolesRoute,
  decodeRoleMask,
  holdsRole,
  projectCharacterRoles,
  readCallerCorporationId,
  readCallerRoles,
  readMemberRoles,
  roleBitFor,
  toRoleMask,
  unreadable,
});
