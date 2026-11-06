/**
 * `GET /corporations/{corporation_id}/structures/` and
 * `GET /universe/structures/{structure_id}/`: a corporation's Upwell structures,
 * and resolving one by id.
 *
 * Two routes in one file because they are one resource read two ways: the same
 * `structures` table in eve.js, the same record shape, the same `state`
 * vocabulary, the same reason a field is omitted. They are two operations with
 * two scopes, so two descriptors.
 *
 * The file is named `structures.js` rather than `universe*` on purpose.
 * `test/conditional.test.js` has a tripwire on that prefix: the static-data
 * routes share one etag, one `Last-Modified` and one `Expires`, and
 * `contract/wire.js` `CONDITIONAL_STATIC_DATA_EXCEPTION` records behaviour
 * nothing here implements. `/universe/structures/{id}/` is not in that
 * exception's path list; it is an authenticated per-entity read that happens to
 * live under `/universe/`.
 *
 * Producer. `/corporations/{corporation_id}/structures/` has an observed
 * producer although its success was never captured: the 2026-08-25 run reached
 * it and was refused for want of a corporation role, and that refusal is
 * `KIND.APP_ERROR` (`charset=UTF-8`, no trailing newline, an `X-Esi-Request-Id`,
 * no `nosniff`; `contract/wire.js` `REQUIRED_ROLE_REFUSAL`). `lib/router.js`
 * carries one producer per route because the two halves were checked against
 * each other six times and never disagreed, so an observed application error is
 * an observation of the producer. Nothing is borrowed from the gateway route
 * `/corporations/{corporation_id}/` one path level up.
 *
 * Every field name, type, required flag, TTL and scope comes from
 * `contract/openapi.json` and is asserted against it by
 * `test/structuresContract.test.js`. Three points where the obvious reading
 * is wrong:
 *
 *   - `name` and `owner_id` are required on `/universe/structures/{id}/`,
 *     alongside `solar_system_id`, not optional. eve.js can supply all three.
 *   - The corporation route requires six fields, not the three the consumer
 *     reads (`structure_id`, `system_id`, `type_id`): those plus
 *     `corporation_id`, `profile_id` and `state`.
 *   - A `403` is tolerated by the consumer on `/universe/structures/{id}/` only.
 *     On `/corporations/{id}/structures/` it makes eve-nexum report
 *     `needs_reauth` and abort the sync.
 *
 * The corporation route refuses twice, both captured on 2026-08-25:
 *
 *   403 {"error":"Character is not in the corporation"}       47 bytes
 *   403 {"error":"Character does not have required role(s)"}  52 bytes
 *
 * The `(s)` is CCP's and it is bytes.
 *
 * Both are made in `subject`, the route-table column `lib/router.js` provides
 * because a scope says the caller may read corporations' structures, never that
 * they may read this corporation's; a scoped route keyed by an entity id will
 * not compile without one. They are not thrown as `RouteRefusal`:
 * `gateRefusal` sends `X-Esi-Cache-Status` and `routedRefusal` does not, and
 * both refusals were observed carrying it, whereas `?page=0` was observed
 * without it.
 *
 * The membership refusal was observed on `/corporations/{id}/contacts/`
 * (`contract/wire.js` `CROSS_ENTITY_REFUSAL`) and travels because its wording
 * names the relationship, "is not in the corporation". It would not travel to an
 * alliance or a fleet.
 *
 * Role enforcement. `x-required-roles: ["Station_Manager"]` is on this operation
 * and 27 others in the pinned document. The refusal is observed, so not
 * enforcing it would grant access real ESI denies. `Director` is deliberately
 * not a second accepted role: the spec's gate names one, and "Station_Manager or
 * Director" is the consumer's rule. A director passes honestly anyway, since
 * eve.js gives bit 0 the full administrative mask, which contains bit 11.
 *
 * The gate reads `roles`, not the three locational masks. `Station_Manager` is
 * an administrative bit outside eve.js's `FULL_LOCATIONAL_ROLE_MASK`.
 * `contract/wire.js` `CHARACTER_ROLES` records that on both real characters
 * observed `roles[]` was empty and the locational arrays were populated; this
 * replica's data model puts the administrative bits in `roles`.
 *
 * What eve.js supplies. The six required corporation-structure fields and the
 * three required universe-structure fields are readable off
 * `normalizeStructureRecord` (`services/structure/structureState.js`), through
 * which every record in the cache and on disk passes. `name` is never absent (it
 * falls back to the type name, then to a synthetic `Structure <id>`).
 * `profile_id` is a real ACL profile id. `owner_id` and `corporation_id` are
 * both `ownerCorpID`, because eve.js has no character-owned structure model.
 *
 * Three optional fields are declared `OMIT` in their alphabetical seats so the
 * divergence is visible in the field list (as `last_login` and `logins` are in
 * `routes/characters.js`):
 *
 *   - `services`: eve.js names services with internal tokens (`docking`,
 *     `reprocessing`, `loyalty_store`) and CCP sends display strings ("Clone
 *     Bay", "Market Hub"). The spec puts no `enum` on `services[].name`, so any
 *     string validates, but a wrong string is still a wrong body. The mapping is
 *     32 rows with nothing to check it against, so it waits for a capture. Its
 *     `state` enum does match ESI's, and `cleanup` is declared upstream but
 *     unreachable because `normalizeServiceStates` collapses everything
 *     non-`ONLINE` to `OFFLINE`.
 *   - `position`: available, but defaulted to `{0, 0, 0}` by the game's own
 *     normaliser, which would publish a structure at the centre of its star.
 *     Optional, and eve-nexum never reads it.
 *   - `type_id` on `/universe/structures/{id}/` is the one optional field that
 *     is sent, because it is on the record.
 *
 * One state has no ESI name: eve.js's `FOB_INVULNERABLE` (118) maps to
 * `unknown`, which CCP's enum has for that value. Dropping the row would give a
 * consumer a structures table that silently loses structures.
 *
 * Pagination. The route declares `pageSize`, so `lib/router.js` asks the handler
 * for the whole collection once per cache window and slices it, keeping
 * `X-Pages` and the body consistent. That matters here because `listStructures`
 * deep-clones every structure on the server before the corporation filter runs.
 * `X-Pages` is sent even for a one-page collection: `contract/wire.js`
 * `AUTHENTICATED_PAGING` records it present with the value `1`, while
 * `/markets/prices/` (a large public collection) sends none.
 *
 * The page size is a choice. The pinned document publishes the `page` parameter
 * and `X-Pages` and no size. `contract/wire.js` `PAGINATION.pageSize` is 1000,
 * read off two market routes, and `CONTACTS.pageSize` shows it does not
 * generalise (the corporation contacts bucket returned exactly 200 rows with
 * `X-Pages: 2`, the alliance bucket 240 on `X-Pages: 1`). Settling this one needs
 * a corporation owning more than a page of structures. `PAGE_SIZE` is
 * `PAGINATION.pageSize` carried across, and `test/structuresContract.test.js`
 * asserts it against that constant. A private server's corporation will not own
 * a thousand structures, so every real response is one page under either number.
 *
 * `deps.runtime` is `lib/runtimeAccess.js` or a double. The accessors this file
 * duck-types (`listCorporationStructures`, `peekStructureRecord`, and the
 * corporation-role reads borrowed from `routes/roles.js`) throw naming
 * themselves when absent. Their implementations must:
 *
 *   - pass `{ refresh: false }`. `listStructures` and `getStructureByID`
 *     otherwise run `tickStructures(Date.now())` first, the fuel and state
 *     machine over every structure on the server, which may persist the whole
 *     table and fire notifications. A read endpoint must not, and the vendor
 *     tree uses `{ refresh: false }` for its own reads.
 *   - treat `getStructureByID`'s return as the live record. Unlike
 *     `listStructures` it returns the cached row without cloning, so it is
 *     `peekCharacterRecord`'s situation: project immediately, copy the fields,
 *     borrow nothing.
 */

"use strict";

const {
  OMIT,
  numberOrNull,
  optional,
  projection,
} = require("../lib/serialize");
const {
  MISSING_REQUIRED_ROLE,
  NOT_IN_CORPORATION,
  familyFor,
  missingRequiredRole,
  notInCorporation,
} = require("../lib/errors");
const { toEsiTimestamp } = require("./status");
const {
  CANONICAL_ID,
  CORP_ROLE_STATION_MANAGER,
  canonicalId,
  corporationRoleSubject,
  holdsRole,
  readCallerCorporationId,
  readCallerRoles,
  unreadable,
} = require("./roles");

// The two routes

const CORPORATION_STRUCTURES_PATH = "/corporations/:corporation_id/structures";
const UNIVERSE_STRUCTURE_PATH = "/universe/structures/:structure_id";

/**
 * The parameter spellings; both are load-bearing, as `character_id` is in
 * `routes/characters.js`.
 *
 * `lib/router.js` `compileRoute` decides a route needs a `subject` declaration
 * by looking for a path parameter ending in `_id` that is not `character_id`. A
 * parameter spelled `:id` or `:corporationId` would fail that heuristic and the
 * scope would be the only gate.
 */
const CORPORATION_ID_PARAM = "corporation_id";
const STRUCTURE_ID_PARAM = "structure_id";

/** `x-cache-age` in the pinned spec: an hour on both operations. */
const CORPORATION_STRUCTURES_CACHE_TTL_SECONDS = 3600;
const UNIVERSE_STRUCTURE_CACHE_TTL_SECONDS = 3600;

/** The scopes CCP publishes, one per operation. */
const CORPORATION_STRUCTURES_SCOPE = "esi-corporations.read_structures.v1";
const UNIVERSE_STRUCTURE_SCOPE = "esi-universe.read_structures.v1";

/**
 * `corp-structure`, 300 tokens per 15 minutes.
 *
 * `/universe/structures/{structure_id}` publishes no `x-rate-limit`, so its
 * group is `null` and it falls to the error limiter rather than a token bucket.
 * Consequence: eve-nexum resolves every structure's name with its own request in
 * a `Promise.all`, so a corporation whose structures are all unresolvable burns
 * one error-limit unit per structure per sync against a budget of 100 per 60
 * seconds, and eve-nexum blocks all ESI traffic when the remaining count hits
 * zero.
 */
const CORPORATION_STRUCTURES_RATE_LIMIT_GROUP = "corp-structure";
const UNIVERSE_STRUCTURE_RATE_LIMIT_GROUP = null;

/** The corporation route's producer: the application, from its observed refusal. */
const PRODUCER = "app";

/**
 * `app`, the only value `/universe/structures/{structure_id}` may legally
 * declare.
 *
 * `lib/router.js` `assertScope` refuses at construction to compile a route that
 * declares a scope and the gateway producer, because no authenticated gateway
 * route has been observed. For a scoped route that sends JSON the candidates are
 * gateway (a boot failure), `meta` (the `/meta/` surface, which this is not),
 * `null` (declares it sends no JSON) and `app`. The authenticated operations
 * observed so far are all `app`.
 *
 * Unobserved about this route: the field order of its success body, and its
 * refusals.
 */
const UNIVERSE_STRUCTURE_PRODUCER = "app";

/**
 * Items per page. `contract/wire.js` `PAGINATION.pageSize`, carried across
 * rather than read off this route; see the header.
 */
const PAGE_SIZE = 1000;

/**
 * Both are `routes/roles.js`'s now, moved there with `corporationRoleSubject`
 * when the corporation asset family needed the same gate. A second copy of "what
 * counts as an entity id in a path segment" must not drift, because two copies
 * disagreeing would manufacture a read of somebody else's corporation inside the
 * authorised path. Re-exported below because this module's contract test reads
 * it from here.
 */


// eve.js's structure-state vocabulary

/**
 * `STRUCTURE_STATE_NAME_BY_ID`, copied from
 * `services/structure/structureConstants.js`.
 *
 * Copied because only `lib/runtimeAccess.js` may require game code, and checked
 * against the vendor declaration by a drift test, as `lib/sessionIdentity.js`
 * does with the GM role bits.
 *
 * Fourteen states, thirteen of them ESI's enum verbatim, which is further
 * evidence that eve.js works from CCP's own vocabulary.
 */
const EVEJS_STRUCTURE_STATE_NAME_BY_ID = Object.freeze({
  0: "unknown",
  1: "unanchored",
  2: "anchoring",
  100: "online_deprecated",
  101: "fitting_invulnerable",
  102: "onlining_vulnerable",
  110: "shield_vulnerable",
  111: "armor_reinforce",
  112: "armor_vulnerable",
  113: "hull_reinforce",
  114: "hull_vulnerable",
  115: "anchor_vulnerable",
  116: "deploy_vulnerable",
  118: "fob_invulnerable",
});

/**
 * The one eve.js state ESI has no name for, and what it becomes.
 *
 * `fob_invulnerable` is a forward operating base, which CCP's Upwell enum
 * predates. `unknown` is what that enum has for it. Inventing a fourteenth enum
 * member fails `assertBody`, and dropping the structure silently loses rows.
 */
const STATE_WITHOUT_AN_ESI_NAME = Object.freeze({ fob_invulnerable: "unknown" });

/** ESI's `state`, from eve.js's integer. Never throws: `state` is required. */
function esiStructureState(value) {
  const stateId = numberOrNull(value);
  const evejsName = stateId === null
    ? undefined
    : EVEJS_STRUCTURE_STATE_NAME_BY_ID[stateId];

  if (evejsName === undefined) return "unknown";
  return STATE_WITHOUT_AN_ESI_NAME[evejsName] || evejsName;
}

// Timestamps

/**
 * Epoch milliseconds as an ESI timestamp, or `null`.
 *
 * eve.js stores these five fields as epoch milliseconds, not as the Windows
 * FILETIME `routes/characters.js` decodes (the character record's convention).
 * `0` and every non-positive value decode to `null`: the record's normalisers
 * write `null` or `0` for a timer that is not running, and 1970 is not a date to
 * publish.
 *
 * Second precision, through `routes/status.js`'s `toEsiTimestamp`:
 * `new Date(ms).toISOString()` is `...T12:28:43.000Z`, and no ESI response has
 * carried fractional seconds (`contract/spec.js` refuses one).
 */
function esiTimestampFromEpochMs(value) {
  const ms = numberOrNull(value);
  if (ms === null || ms <= 0) return null;

  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : toEsiTimestamp(date);
}

// Projections, in CCP's field order.
//
// Alphabetical on both, which is also the pinned document's declaration order
// for both (unlike `/ship/` in `routes/characters.js`, where the wire is
// alphabetical and the spec is not). The wire order for these two operations is
// unobserved: neither answered a success in the 2026-08-25 run. Alphabetical is
// a choice, taken because every observed body on this producer has used it.

/**
 * One row of `GET /corporations/{corporation_id}/structures/`.
 *
 * Six required fields and nine optional ones. `position` is not declared on this
 * operation at all (only on the universe route), so the omissions here are
 * `services` and every timer that is not running.
 *
 * `fuel_expires`, the four timer fields and `next_reinforce_hour` /
 * `reinforce_hour` are `optional()`: absent means the key is left out, never
 * `null` and never `0`. The pinned document declares no nullable field, so
 * omission is ESI's only way of saying "not applicable".
 */
const projectCorporationStructure = projection("GetCorporationsCorporationIdStructures", {
  corporation_id: (record) => record.corporationId,
  fuel_expires: (record) => optional(esiTimestampFromEpochMs(record.fuelExpiresAt)),
  // Never absent from a normalised eve.js record (it falls back to the type name,
  // then to a synthetic `Structure <id>`), but optional in the spec, so a record
  // with an empty name omits the key rather than sending `""`.
  name: (record) => optional(record.name === "" ? null : record.name),
  next_reinforce_apply: (record) => optional(esiTimestampFromEpochMs(record.nextReinforceApply)),
  next_reinforce_hour: (record) => optional(numberOrNull(record.nextReinforceHour)),
  profile_id: (record) => record.profileId,
  reinforce_hour: (record) => optional(numberOrNull(record.reinforceHour)),
  // Declared and always omitted: eve.js's service tokens are not CCP's display
  // strings and nothing checks a mapping (see the header). Written as an always
  // omitted field so that a capture lands as a reader in the seat the field
  // already occupies.
  services: () => OMIT,
  state: (record) => record.state,
  state_timer_end: (record) => optional(esiTimestampFromEpochMs(record.stateEndsAt)),
  state_timer_start: (record) => optional(esiTimestampFromEpochMs(record.stateStartedAt)),
  structure_id: (record) => record.structureId,
  system_id: (record) => record.systemId,
  type_id: (record) => record.typeId,
  unanchors_at: (record) => optional(esiTimestampFromEpochMs(record.unanchoring)),
});

/**
 * `GET /universe/structures/{structure_id}/`.
 *
 * Three required fields, with no `optional()` on them: a record that cannot
 * supply one is refused upstream of this projection rather than projected into a
 * body missing a required key.
 *
 * `owner_id` is a corporation id, the same `ownerCorpID` the route above
 * publishes as `corporation_id`. eve.js assigns `ownerCorpID` and `ownerID` the
 * same coalesced value, and there is no character-owned structure model.
 */
const projectUniverseStructure = projection("GetUniverseStructuresStructureId", {
  name: (record) => record.name,
  owner_id: (record) => record.ownerId,
  // Declared and always omitted. `normalizePosition` defaults an unset position to
  // `{0, 0, 0}`, so publishing it would put a structure at the centre of its own
  // star.
  position: () => OMIT,
  solar_system_id: (record) => record.solarSystemId,
  type_id: (record) => optional(numberOrNull(record.typeId)),
});

// Refusals

/**
 * The two `403`s this route makes, now `lib/errors.js`'s.
 *
 * The membership one was originally observed on `/corporations/{id}/contacts/`
 * (`contract/wire.js` `CROSS_ENTITY_REFUSAL`), so the bytes live in one place
 * and this file names which it sends. `test/structuresContract.test.js` compares
 * the two strings against `contract/wire.js`, so a tidied parenthetical fails a
 * test rather than a client.
 */
const REFUSAL_FAMILY = familyFor(PRODUCER);

// Who may read this entity

/**
 * `SUBJECT` for `/corporations/{corporation_id}/structures/`.
 *
 * Two questions, in the order CCP's statuses imply and cheapest first: is the
 * caller in this corporation, and do they hold the role the operation declares.
 * Both are refusals with observed bytes, so neither throws.
 *
 * A non-canonical `corporation_id` is answered as "not the caller's
 * corporation". That is a divergence: real ESI would refuse
 * `/corporations/abc/structures/` with a coercion `400` before asking who was
 * calling. `lib/errors.js` `coercionFailed` has the observed body, but every
 * observation of it is of a refusal made where `routedRefusal` dresses it,
 * without `X-Esi-Cache-Status`, and a gate refusal carries one. Observed bytes
 * attached to a true claim (the caller is not a member of a corporation that
 * cannot exist) beat inventing headers.
 *
 * @param {object} claims      the verified token's projection
 * @param {object} pathParams  the router's captures, as strings
 * @param {object} deps        `{ runtime }`
 */
function corporationStructuresSubject(claims, pathParams, deps) {
  return corporationRoleSubject({
    operationId: "GetCorporationsCorporationIdStructures",
  // The spec's `x-required-roles` on this operation, spelled as it spells it.
  // `Director` is deliberately not a second accepted role: the gate names one.
    roles: ["Station_Manager"],
    param: CORPORATION_ID_PARAM,
    deps,
  })(claims, pathParams);
}

/**
 * `SUBJECT` for `/universe/structures/{structure_id}/`, the one place in this
 * file that throws rather than refusing.
 *
 * ESI's ACL on this route is a viewing ACL: the operation's description says it
 * returns information "if you are on the ACL" and "Forbidden" for all other
 * inputs. eve.js has no viewing ACL. It has a docking policy (`accessProfile`,
 * `canCharacterDockAtStructure`) and per-profile access groups, which answer a
 * different question. The proxy is ownership: a caller may resolve a structure
 * their own corporation owns, and nothing else.
 *
 * The wire form of that refusal is unobserved. The spec declares only `200` and
 * `default`; whether a caller off the ACL gets a `403`, and whether a structure
 * id that does not exist gets a `403` or a `404` (and with which entity noun,
 * since `lib/errors.js` `notFound` refuses to build a legacy one without it) are
 * open. Two requests settle all of it:
 *
 *   curl -sD - -H "Authorization: Bearer <token>" \
 *     "https://esi.evetech.net/latest/universe/structures/1000000000001/"
 *   curl -sD - -H "Authorization: Bearer <token>" \
 *     "https://esi.evetech.net/v2/universe/structures/1000000000001/"
 *
 * Until then this throws, which `lib/router.js` `gateOrFail` turns into a logged
 * `500`: "the read is still refused, which is the property that matters, and the
 * status is loudly wrong rather than quietly invented."
 */
function universeStructureSubject(claims, pathParams, deps) {
  return structureOwnershipSubject({
    operationId: "GetUniverseStructuresStructureId",
    param: STRUCTURE_ID_PARAM,
    deps,
  })(claims, pathParams);
}

/**
 * The ownership ACL above, as a factory, so a second structure-keyed route can
 * take the same decision.
 *
 * `GET /markets/structures/{structure_id}/` is that route. Its ACL on real ESI is
 * market access rather than ownership; `routes/orders.js` says what that costs
 * and what would settle it. What is shared is that a caller whose corporation
 * does not own the structure does not get the read, and that the bytes CCP
 * refuses with are unobserved.
 *
 * @param {object} options
 * @param {string} options.operationId  CCP's, for the log line
 * @param {string} options.param        the path parameter holding the id
 * @param {object} options.deps         the route factory's, carrying `runtime`
 */
function structureOwnershipSubject({ operationId, param, deps }) {
  return function subject(claims, pathParams) {
    return ownershipCheck(operationId, param, deps, claims, pathParams);
  };
}

function ownershipCheck(operationId, param, deps, claims, pathParams) {
  const runtime = readRuntime(deps);
  const characterId = claims.characterId;

  const structureId = canonicalId(pathParams && pathParams[param]);
  // The corporation and not the roles: this route's ACL is about ownership, and
  // the spec declares no `x-required-roles` on it.
  const corporationId = readCallerCorporationId(runtime, operationId, characterId);

  const record = structureId === null
    ? null
    : peekStructure(runtime, operationId, characterId, structureId);

  if (record !== null && numberOrNull(record.ownerCorpID) === corporationId) return null;

  throw new Error(
    `ESI mod: ${operationId} refused structure ${structureId === null ? "<malformed>" : structureId} `
      + "for a caller whose corporation does not own it, and the refusal CCP sends for that has "
      + "never been observed: the spec declares only 200 and default, and whether a caller off "
      + "the ACL gets a 403, or a missing structure a 404 and with which entity noun, are open. "
      + "See routes/structures.js universeStructureSubject for the two requests that settle it. "
      + "The read is refused either way; only the status is wrong, and loudly.",
  );
}

// Reading the game

/** `deps.runtime`, or an empty object: the accessors are duck-typed below. */
function readRuntime(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  return d.runtime && typeof d.runtime === "object" ? d.runtime : {};
}

/**
 * Every structure a corporation owns, as already-cloned records.
 *
 * An absent accessor is a throw rather than an empty array, as in
 * `routes/characters.js`: an empty collection is a valid, complete, wrong
 * answer, and eve-nexum acts on it by deleting every structure it had recorded
 * for the corporation.
 */
function listCorporationStructures(runtime, operationId, characterId, corporationId) {
  if (typeof runtime.listCorporationStructures !== "function") {
    throw unreadable(
      operationId,
      characterId,
      "the runtime exposes no listCorporationStructures accessor. It must read with "
        + "{ refresh: false }, or every request runs the fuel and state machine over every "
        + "structure on the server",
    );
  }

  const rows = runtime.listCorporationStructures(corporationId);
  if (!Array.isArray(rows)) {
    throw unreadable(
      operationId,
      characterId,
      `listCorporationStructures answered with ${rows === null ? "null" : typeof rows} rather than `
        + "an array, and a paginated route must return its whole collection",
    );
  }

  return rows;
}

/**
 * One structure record, or `null`.
 *
 * `peekStructureRecord` rather than a plain getter, and the name is the warning:
 * eve.js's `getStructureByID` returns the live cached row without cloning, so
 * `peekCharacterRecord`'s rule applies: project immediately, copy the fields,
 * borrow nothing, and do not hold it across anything.
 */
function peekStructure(runtime, operationId, characterId, structureId) {
  if (typeof runtime.peekStructureRecord !== "function") {
    throw unreadable(
      operationId,
      characterId,
      "the runtime exposes no peekStructureRecord accessor. It must read with "
        + "{ refresh: false }, and its result is the live cached row rather than a clone",
    );
  }

  const record = runtime.peekStructureRecord(structureId);
  return record === null || typeof record !== "object" ? null : record;
}

// The two bodies

/**
 * The four ids a corporation-structure row cannot do without, read as positive
 * integers.
 *
 * `structure_id`, `type_id`, `system_id` and `profile_id` are required `int64`s,
 * and eve.js's normaliser writes `0` for one it could not coerce. Zero is not an
 * id, and a required field has no honest substitute, so it is a throw naming the
 * field, as `/ship/` does for an unreadable `shipName`.
 */
function requiredStructureId(operationId, characterId, structureId, field, value) {
  const id = numberOrNull(value);
  if (id === null || !Number.isSafeInteger(id) || id <= 0) {
    throw unreadable(
      operationId,
      characterId,
      `structure ${structureId} carries no readable ${field}, and it is required`,
    );
  }
  return id;
}

/**
 * `GET /corporations/{corporation_id}/structures/`.
 *
 * Returns the whole collection: `lib/router.js` slices it, computes `X-Pages`,
 * and calls this once per cache window.
 *
 * By the time this runs, `corporationStructuresSubject` has proved the caller is
 * a member of the corporation in the path and holds `Station_Manager`, so nothing
 * here re-checks it, as `routes/characters.js` relies on the cross-character
 * gate.
 */
function buildCorporationStructures(params, deps) {
  const operationId = "GetCorporationsCorporationIdStructures";
  const runtime = readRuntime(deps);
  const characterId = callerCharacterId(params, operationId);

  const corporationId = canonicalId(params.path[CORPORATION_ID_PARAM]);
  if (corporationId === null) {
    // Unreachable: the subject check refuses a non-canonical id before this runs.
    // Kept because a wrong "unreachable" would produce a body describing a
    // corporation nobody asked about.
    throw unreadable(
      operationId,
      characterId,
      `the path names corporation ${JSON.stringify(params.path[CORPORATION_ID_PARAM])}, which is `
        + "not a canonical positive integer, and the subject check should have refused it",
    );
  }

  return listCorporationStructures(runtime, operationId, characterId, corporationId)
    .map((record) => {
      const structureId = requiredStructureId(
        operationId, characterId, record.structureID, "structureID", record.structureID,
      );

      return projectCorporationStructure({
        // `ownerCorpID`, not the path's `corporation_id`: the row is the data and the
        // path is what was asked for. They agree (the accessor filters on this field),
        // and publishing the one that was read keeps that agreement checkable.
        corporationId: requiredStructureId(
          operationId, characterId, structureId, "ownerCorpID", record.ownerCorpID,
        ),
        fuelExpiresAt: record.fuelExpiresAt,
        name: typeof record.name === "string" ? record.name : null,
        nextReinforceApply: record.nextReinforceApply,
        nextReinforceHour: record.nextReinforceHour,
        profileId: requiredStructureId(
          operationId, characterId, structureId, "profileID", record.profileID,
        ),
        reinforceHour: record.reinforceHour,
        state: esiStructureState(record.state),
        stateEndsAt: record.stateEndsAt,
        stateStartedAt: record.stateStartedAt,
        structureId,
        systemId: requiredStructureId(
          operationId, characterId, structureId, "solarSystemID", record.solarSystemID,
        ),
        typeId: requiredStructureId(
          operationId, characterId, structureId, "typeID", record.typeID,
        ),
        unanchoring: record.unanchoring,
      });
    });
}

/**
 * `GET /universe/structures/{structure_id}/`.
 *
 * Exercised directly by `test/structuresContract.test.js`.
 *
 * All three required fields are read strictly. `name` is never absent from a
 * normalised record, but that is a property of upstream's normaliser, and a
 * required field with no honest value is a throw.
 */
function buildUniverseStructure(params, deps) {
  const operationId = "GetUniverseStructuresStructureId";
  const runtime = readRuntime(deps);
  const characterId = callerCharacterId(params, operationId);

  const structureId = canonicalId(params.path[STRUCTURE_ID_PARAM]);
  if (structureId === null) {
    throw unreadable(
      operationId,
      characterId,
      `the path names structure ${JSON.stringify(params.path[STRUCTURE_ID_PARAM])}, which is not a `
        + "canonical positive integer, and the subject check should have refused it",
    );
  }

  const record = peekStructure(runtime, operationId, characterId, structureId);
  if (record === null) {
    throw unreadable(
      operationId,
      characterId,
      `the game has no record for structure ${structureId}, and what CCP answers for a structure `
        + "that does not exist (a 403 hiding it, or a 404, and with which entity noun) has "
        + "never been observed",
    );
  }

  const name = typeof record.name === "string" && record.name !== "" ? record.name : null;
  if (name === null) {
    throw unreadable(
      operationId,
      characterId,
      `structure ${structureId} carries no readable name, and name is `
        + "required by the pinned spec",
    );
  }

  return projectUniverseStructure({
    name,
    ownerId: requiredStructureId(
      operationId, characterId, structureId, "ownerCorpID", record.ownerCorpID,
    ),
    solarSystemId: requiredStructureId(
      operationId, characterId, structureId, "solarSystemID", record.solarSystemID,
    ),
    typeId: record.typeID,
  });
}

/**
 * Who is asking, as a number that was signed. See `routes/roles.js`
 * `callerCharacterId`: the path segment is a string somebody typed and the claim
 * is a number this server signed.
 */
function callerCharacterId(params, operationId) {
  const credential = params && params.credential;
  const characterId = credential && credential.characterId;

  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new Error(
      `ESI mod: ${operationId} ran with no verified credential. Every route in this module `
        + "declares a scope, so lib/router.js authorise() should have refused the request before "
        + "the handler saw it.",
    );
  }

  return characterId;
}

// Route descriptors

/**
 * `/corporations/{corporation_id}/structures/`.
 *
 * `localizedBody: true` is a judgement rather than a reading.
 * `contract/wire.js` `VARY_LOCALIZED_SURVEY` lists this path under `localized`
 * because the observed role refusal sent the four-line `Vary` with
 * `Accept-Language` twice, and notes that the route's success column stays
 * unfilled because the success was never seen.
 *
 * Three things point the same way: the pinned document declares a
 * `Content-Language` response header on this operation's `200`; the rule
 * `test/varyLocalization.test.js` runs (does the `200` schema carry a
 * localizable `name` or `description` string) says yes, since a structure row has
 * a `name`; and `lib/router.js` can only express this per route, so `false`
 * would contradict the one response anybody has seen.
 */
function createCorporationStructuresRoute(deps) {
  return {
    method: "GET",
    path: CORPORATION_STRUCTURES_PATH,
    name: "GetCorporationsCorporationIdStructures",
    handler: (params) => buildCorporationStructures(params, deps),
    producer: PRODUCER,
    scope: CORPORATION_STRUCTURES_SCOPE,
    cacheTtl: CORPORATION_STRUCTURES_CACHE_TTL_SECONDS,
    rateLimitGroup: CORPORATION_STRUCTURES_RATE_LIMIT_GROUP,
    pageSize: PAGE_SIZE,
    localizedBody: true,
    // The router hands a `subject` function its own dispatch `deps`, which here is
    // `{ logError, now }` (`lib/pipeline.js` builds it) with no runtime. The runtime
    // is injected per route through this factory's closure, as for the handler
    // beside it, so the third argument is deliberately not taken: a check that read
    // the game through the dispatch deps would find nothing and refuse everybody.
    subject: (claims, pathParams) => corporationStructuresSubject(claims, pathParams, deps),
  };
}

/**
 * `/universe/structures/{structure_id}/`.
 *
 * The producer is `app`, the only legal value for a scoped route that sends JSON
 * (see `UNIVERSE_STRUCTURE_PRODUCER`). The access check is the ownership proxy
 * in `universeStructureSubject`.
 */
function createUniverseStructureRoute(deps) {

  return {
    method: "GET",
    path: UNIVERSE_STRUCTURE_PATH,
    name: "GetUniverseStructuresStructureId",
    handler: (params) => buildUniverseStructure(params, deps),
    producer: UNIVERSE_STRUCTURE_PRODUCER,
    scope: UNIVERSE_STRUCTURE_SCOPE,
    cacheTtl: UNIVERSE_STRUCTURE_CACHE_TTL_SECONDS,
    rateLimitGroup: UNIVERSE_STRUCTURE_RATE_LIMIT_GROUP,
    // A `name` in the body, so the four-line `Vary`.
    localizedBody: true,
    // The closure's deps, not the router's; see the note on the route above.
    subject: (claims, pathParams) => universeStructureSubject(claims, pathParams, deps),
  };
}

module.exports = Object.freeze({
  CANONICAL_ID,
  CORPORATION_ID_PARAM,
  CORPORATION_STRUCTURES_CACHE_TTL_SECONDS,
  CORPORATION_STRUCTURES_PATH,
  CORPORATION_STRUCTURES_RATE_LIMIT_GROUP,
  CORPORATION_STRUCTURES_SCOPE,
  EVEJS_STRUCTURE_STATE_NAME_BY_ID,
  MISSING_REQUIRED_ROLE,
  NOT_IN_CORPORATION,
  PAGE_SIZE,
  PRODUCER,
  STATE_WITHOUT_AN_ESI_NAME,
  STRUCTURE_ID_PARAM,
  UNIVERSE_STRUCTURE_CACHE_TTL_SECONDS,
  UNIVERSE_STRUCTURE_PATH,
  UNIVERSE_STRUCTURE_PRODUCER,
  UNIVERSE_STRUCTURE_RATE_LIMIT_GROUP,
  UNIVERSE_STRUCTURE_SCOPE,
  buildCorporationStructures,
  buildUniverseStructure,
  canonicalId,
  corporationStructuresSubject,
  createCorporationStructuresRoute,
  esiStructureState,
  esiTimestampFromEpochMs,
  projectCorporationStructure,
  projectUniverseStructure,
  universeStructureSubject,
  createUniverseStructureRoute,
  structureOwnershipSubject,
});
