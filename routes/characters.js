/**
 * `GET /characters/{character_id}/online/`, `/location/` and `/ship/`: the
 * first authenticated ESI endpoints on this replica.
 *
 * Three route descriptors (CCP publishes three operations with three scopes)
 * sharing one scope family, one rate-limit bucket and one producer.
 *
 * Observed 2026-08-25 against live ESI with a real token, one `GET` each. The
 * field order and omission rule are recorded in `contract/wire.js`
 * `CHARACTER_LOCATION`; the bodies are not, because `contract/` holds nobody's
 * character data (D23). `test/charactersContract.test.js` reads the recording
 * from that module rather than copying literals.
 *
 *   1. All three are the application producer: `application/json;
 *      charset=UTF-8`, no trailing newline, a strong 56-hex `Etag`, and an
 *      `X-Esi-Request-Id`. The parent route `GET /characters/{character_id}` is
 *      the gateway, so a sibling path is no evidence. `contract/wire.js`
 *      `SUCCESS_KIND` carries all three rows.
 *
 *   2. Field order is alphabetical on all three, and order is bytes. It agrees
 *      with the pinned spec's declaration order on two of the three and not on
 *      `/ship/`, where the spec lists `ship_type_id` first: the spec's key
 *      order is not evidence and the wire is.
 *
 *   3. An absent optional field is omitted, never `null` and never `0`. The
 *      captured pilot was docked in a station, so `station_id` was present and
 *      `structure_id` absent from the body. `contract/spec.js` refuses `null`
 *      anywhere because the pinned document declares nothing nullable.
 *
 * TTLs: CCP publishes `x-cache-age: 60` for `/online/` and 5 for the other two.
 * `contract/spec.js` `assertRouteMatchesSpec` is the check.
 *
 * CCP answers `/online/` with four fields; this replica answers with two.
 * `last_login` and `logins` have no source in eve.js (no login timestamp or
 * counter is persisted). Both are optional in the pinned spec, so they are
 * omitted rather than invented, declared as `OMIT` in their alphabetical seats
 * so the divergence is visible in the field list. `contract/wire.js`
 * `CHARACTER_LOCATION.unavailableFromGame` records it.
 *
 * `last_logout` is available as `logoffDate` on the character record, a Windows
 * FILETIME decimal string (hence `filetimeToEpochMs`). Caveat: eve.js seeds
 * `logoffDate` to the character's creation time rather than leaving it unset,
 * so a character who has never logged out reports a plausible wrong answer. The
 * record cannot tell the two apart.
 *
 * A missing record is a `500`. `peekCharacterRecord` returns `null` for a
 * character the game does not know. By the time a handler runs, `lib/router.js`
 * `authorise()` has proved a credential was presented, verifies, carries this
 * route's scope, and has a subject equal to the path `:character_id`. A
 * credential exists only because `loader.js`'s minter read that character's
 * record at token time and refused to sign otherwise. So a `null` record means
 * the character existed at mint time and does not now: this server's
 * inconsistency, not the caller's mistake, matching how `routes/oauthToken.js`
 * turns an unusable mint into `server_error` rather than `invalid_grant`.
 *
 *   - `/online/` needs nothing from the record. `online` comes from the session
 *     side, and a character the game has no record of is not connected, so the
 *     answer is `{"online":false}` with `last_logout` omitted, at `200`.
 *
 *   - `/location/` requires `solar_system_id` and `/ship/` requires all three of
 *     its fields. There is no honest value and the spec has no nullable field,
 *     so the handler throws. The router logs it against the route name and
 *     answers the observed `500`; the reason reaches the game server's log and
 *     never the client. This is the distinction `routes/status.js` draws
 *     between "nobody is connected" and "the session registry changed shape".
 *
 * An offline character is not this case: eve.js persists records in the
 * `characters` table, so a pilot who logged out still has one with where they
 * left off, which is also what CCP answers. Only a character with no record
 * reaches the throw.
 *
 * A podded pilot still has a ship name. `/ship/` requires `ship_name`, and
 * eve.js does not leave it unset for a capsule: `buildCapsuleTypeDescriptor`
 * (`services/inventory/itemStore.js:6723`) names the capsule from its item
 * metadata, falling back to `"Capsule"` (or `"Capsule - Genolution 'Auroral'
 * 197-variant"` for the golden one). `syncCapsuleItemToType` (`:6758`) writes
 * that onto `itemName` and `shipName`, and every seeded character record
 * carries `shipName: "Capsule"`. The throw is therefore unreachable in the
 * ordinary case; it stays because a required field with no honest substitute
 * must not be invented.
 *
 * `deps.runtime` is `lib/runtimeAccess.js` or a double, taken through the
 * factory's closure as `routes/status.js` takes it. Nothing in `routes/`
 * requires that module, so all three endpoints are testable with no eve.js
 * checkout.
 *
 * `toEsiTimestamp` comes from `routes/status.js` so the second-precision rule
 * ("not `.000Z`") lives in one place.
 */

"use strict";

const { OMIT, numberOrNull, optional, projection } = require("../lib/serialize");
const { toEsiTimestamp } = require("./status");

// The three routes

const ONLINE_PATH = "/characters/:character_id/online";
const LOCATION_PATH = "/characters/:character_id/location";
const SHIP_PATH = "/characters/:character_id/ship";

/**
 * The parameter's spelling is load-bearing.
 *
 * `lib/router.js` `authorise()` enforces "a token for character A must not read
 * character B" by comparing the token's subject against the path parameter
 * named `character_id`. Any other spelling (`characterId`, `:id`) leaves it
 * nothing to compare and silently disables the cross-character gate.
 */
const CHARACTER_ID_PARAM = "character_id";

/**
 * `x-cache-age` in the pinned spec, and the `Expires` offsets confirm them:
 * `/online/` is 60 and the other two are 5. `contract/spec.js`
 * `assertRouteMatchesSpec` checks it against CCP's document.
 */
const ONLINE_CACHE_TTL_SECONDS = 60;
const LOCATION_CACHE_TTL_SECONDS = 5;
const SHIP_CACHE_TTL_SECONDS = 5;

/** The scopes CCP publishes, one per operation. */
const ONLINE_SCOPE = "esi-location.read_online.v1";
const LOCATION_SCOPE = "esi-location.read_location.v1";
const SHIP_SCOPE = "esi-location.read_ship_type.v1";

/** One bucket for all three, 1200 tokens per 15 minutes, and a 200 costs 2. */
const RATE_LIMIT_GROUP = "char-location";

/**
 * All three are the application (`contract/wire.js` `SUCCESS_KIND`):
 * `charset=UTF-8` and no trailing newline, the opposite of `/status/`.
 */
const PRODUCER = "app";

// Windows FILETIME

/**
 * 100-nanosecond ticks between 1601-01-01 and the Unix epoch, and ticks per
 * millisecond. eve.js stores `logoffDate` as `BigInt(ms) * 10000n +
 * 116444736000000000n`, rendered as a decimal string.
 *
 * `BigInt`, not `Number`: a FILETIME in this decade is around 1.34e17, fifteen
 * times past `Number.MAX_SAFE_INTEGER`, so double arithmetic on it is not
 * exact. The lost precision is a few hundred nanoseconds and would survive the
 * division to seconds, so `Number` would be right by accident of magnitude
 * rather than by the arithmetic. One `BigInt` conversion per response is cheap.
 */
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;

/**
 * A FILETIME decimal string as epoch milliseconds, or `null`.
 *
 * `null` for anything that is not a run of digits, and for a value that decodes
 * to a moment before the Unix epoch (zero-initialised storage or a misread
 * field). The caller omits the field rather than sending 1601.
 */
function filetimeToEpochMs(value) {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return null;
  }
  const digits = String(value).trim();
  if (!/^\d+$/.test(digits)) return null;

  const ticks = BigInt(digits);
  if (ticks < FILETIME_EPOCH_OFFSET) return null;

  const ms = (ticks - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MS;
  const milliseconds = Number(ms);
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

/** A FILETIME as an ESI timestamp, or `null` for one that cannot be read. */
function esiTimestampFromFiletime(value) {
  const ms = filetimeToEpochMs(value);
  if (ms === null) return null;

  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : toEsiTimestamp(date);
}

// Projections, in CCP's field order.
//
// Alphabetical on all three, as observed. `contract/wire.js`
// `CHARACTER_LOCATION.fieldOrder` is the recording, and
// `test/charactersContract.test.js` compares these lists against it.

/**
 * `/online/`.
 *
 * Two of CCP's four fields. `last_login` and `logins` always `OMIT` (see the
 * header), so that when a source appears the change is a reader in the seat the
 * field already occupies.
 */
const projectCharacterOnline = projection("GetCharactersCharacterIdOnline", {
  last_login: () => OMIT,
  last_logout: (record) => optional(record.lastLogout),
  logins: () => OMIT,
  online: (record) => record.online,
});

/**
 * `/location/`.
 *
 * `station_id` and `structure_id` are optional and mutually exclusive in
 * practice (docked at one, the other, or neither); an absent one is omitted.
 * `numberOrNull` goes before `optional` because the record holds `null` or `""`
 * for an unset id, and `Number("")` is `0`, a claim of being docked at
 * station 0.
 */
const projectCharacterLocation = projection("GetCharactersCharacterIdLocation", {
  solar_system_id: (record) => record.solarSystemId,
  station_id: (record) => optional(numberOrNull(record.stationId)),
  structure_id: (record) => optional(numberOrNull(record.structureId)),
});

/**
 * `/ship/`.
 *
 * All three fields are required by the spec, so there is no `optional`: a
 * record that cannot supply one is refused upstream of this projection.
 */
const projectCharacterShip = projection("GetCharactersCharacterIdShip", {
  ship_item_id: (record) => record.shipItemId,
  ship_name: (record) => record.shipName,
  ship_type_id: (record) => record.shipTypeId,
});

// Reading the game

/**
 * The error a route raises when it cannot answer for a character its own gate
 * has already vouched for.
 *
 * The router turns this into the observed `500` and logs it against the route
 * name; the message names the character and the field and goes to the game
 * server's log, not to the client.
 */
function unreadable(operationId, characterId, detail) {
  return new Error(
    `ESI mod: ${operationId} cannot answer for character ${characterId}: ${detail}. `
      + "A token for that character was minted by this server, so the record was readable then "
      + "and is not now: this is a server-side inconsistency, not a client error.",
  );
}

/**
 * Who is asking, as a number that was signed.
 *
 * `params.credential.characterId`, never `params.path.character_id`: the path
 * segment is a string typed by the requester, and `lib/router.js`'s gate
 * documents what `Number()` accepts for one. The gate has already proved the
 * two agree; this reads the half that cannot be wrong.
 *
 * A handler on a scoped route reached with no credential means the gate did not
 * run. That is a framework bug, hence a throw and a 500.
 */
function callerCharacterId(params) {
  const credential = params && params.credential;
  const characterId = credential && credential.characterId;

  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new Error(
      "ESI mod: a character route ran with no verified credential. Every route in this module "
        + "declares a scope, so lib/router.js authorise() should have refused the request before "
        + "the handler saw it.",
    );
  }

  return characterId;
}

/** `deps.runtime`, or an empty object: the accessors are duck-typed below. */
function readRuntime(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  return d.runtime && typeof d.runtime === "object" ? d.runtime : {};
}

/**
 * Is this character connected?
 *
 * Duck-typed as `routes/status.js` `readPlayers` is: an accessor that is not
 * there yet has a correct answer, and one that throws is upstream drift and
 * must not be swallowed into a permanent `false`.
 *
 * An absent accessor is `false` ("no way to know anyone is connected"), the
 * same concession `readPlayers` makes for a game that is not up.
 * `snapshot.online === true` rather than a truthiness test, because the spec
 * field is a boolean.
 */
function readOnline(runtime, characterId) {
  if (typeof runtime.getCharacterOnlineSnapshot !== "function") return false;

  const snapshot = runtime.getCharacterOnlineSnapshot(characterId);
  if (snapshot === null || typeof snapshot !== "object") return false;

  return snapshot.online === true;
}

/**
 * A projection of the live character record, or `null` for a character the game
 * does not know.
 *
 * The `project` callback runs against the live in-memory record (what
 * `peekCharacterRecord` buys by not cloning), so it copies the fields it wants
 * and the plain object it returns is what leaves. Nothing holds the record
 * across an `await`; the game may move the character between ticks, and a body
 * assembled from two halves of a record is a torn read.
 *
 * An absent accessor throws rather than returning `null`: "the game does not
 * have this character" and "this build of the mod cannot read characters" are
 * different failures.
 */
function peekRecord(runtime, operationId, characterId, project) {
  if (typeof runtime.peekCharacterRecord !== "function") {
    throw unreadable(
      operationId,
      characterId,
      "the runtime exposes no peekCharacterRecord accessor",
    );
  }

  const record = runtime.peekCharacterRecord(characterId, { project });
  return record === null || typeof record !== "object" ? null : record;
}

// The three bodies

/**
 * `GET /characters/{character_id}/online/`.
 *
 * The one route here that cannot fail for want of game state: its only required
 * field comes from the session side, so a missing record costs `last_logout`
 * and nothing else.
 *
 * @param {object} params  the router's, with `credential` already verified
 * @param {object} [deps]  `{ runtime }`, from the factory's closure
 */
function buildCharacterOnline(params, deps) {
  const characterId = callerCharacterId(params);
  const runtime = readRuntime(deps);

  // Read before the record, so the answer to "is this pilot connected" is the
  // same whether or not the record read below finds anything.
  const online = readOnline(runtime, characterId);

  // Guarded rather than left to `peekRecord`'s own refusal: `last_logout` is
  // optional, so a runtime that cannot read characters at all costs this endpoint
  // a field rather than its answer.
  let lastLogout = null;
  if (typeof runtime.peekCharacterRecord === "function") {
    const record = peekRecord(
      runtime,
      "GetCharactersCharacterIdOnline",
      characterId,
      (found) => ({ logoffDate: found.logoffDate }),
    );
    if (record !== null) lastLogout = esiTimestampFromFiletime(record.logoffDate);
  }

  return projectCharacterOnline({ lastLogout, online });
}

/**
 * `GET /characters/{character_id}/location/`.
 *
 * `solar_system_id` is required and has no honest substitute, so a character
 * the game cannot produce is a `500` rather than a body claiming system 0.
 */
function buildCharacterLocation(params, deps) {
  const characterId = callerCharacterId(params);
  const runtime = readRuntime(deps);
  const operationId = "GetCharactersCharacterIdLocation";

  const record = peekRecord(runtime, operationId, characterId, (found) => ({
    solarSystemID: found.solarSystemID,
    stationID: found.stationID,
    structureID: found.structureID,
  }));

  if (record === null) {
    throw unreadable(operationId, characterId, "the game has no record for that character");
  }

  const solarSystemId = numberOrNull(record.solarSystemID);
  if (solarSystemId === null) {
    throw unreadable(
      operationId,
      characterId,
      "the record carries no readable solarSystemID, and solar_system_id is required",
    );
  }

  return projectCharacterLocation({
    solarSystemId,
    stationId: record.stationID,
    structureId: record.structureID,
  });
}

/**
 * `GET /characters/{character_id}/ship/`.
 *
 * All three fields are required, so any one unreadable is a `500` naming the
 * field in the log. `shipID` is the record's name for what CCP calls
 * `ship_item_id`, the item id of this particular hull.
 */
function buildCharacterShip(params, deps) {
  const characterId = callerCharacterId(params);
  const runtime = readRuntime(deps);
  const operationId = "GetCharactersCharacterIdShip";

  const record = peekRecord(runtime, operationId, characterId, (found) => ({
    shipID: found.shipID,
    shipName: found.shipName,
    shipTypeID: found.shipTypeID,
  }));

  if (record === null) {
    throw unreadable(operationId, characterId, "the game has no record for that character");
  }

  const shipItemId = numberOrNull(record.shipID);
  const shipTypeId = numberOrNull(record.shipTypeID);
  const shipName = record.shipName;

  if (shipItemId === null || shipTypeId === null || typeof shipName !== "string") {
    throw unreadable(
      operationId,
      characterId,
      "the record carries no readable shipID, shipName or shipTypeID, and all three of "
        + "ship_item_id, ship_name and ship_type_id are required",
    );
  }

  return projectCharacterShip({ shipItemId, shipName, shipTypeId });
}

// Route descriptors
//
// Plain object literals; each factory is callable as `factory({})`, with deps
// read inside the handler and never at construction, so
// `test/serialize.test.js` can walk `routes/` and ask every factory which
// operation it implements.
//
// No `errorFamily` is declared: `lib/router.js` derives it from `producer`,
// which makes the `403` in the gate above these handlers the application's
// `LEGACY` refusal.

function createCharacterOnlineRoute(deps) {
  return {
    method: "GET",
    path: ONLINE_PATH,
    name: "GetCharactersCharacterIdOnline",
    handler: (params) => buildCharacterOnline(params, deps),
    producer: PRODUCER,
    scope: ONLINE_SCOPE,
    cacheTtl: ONLINE_CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
  };
}

function createCharacterLocationRoute(deps) {
  return {
    method: "GET",
    path: LOCATION_PATH,
    name: "GetCharactersCharacterIdLocation",
    handler: (params) => buildCharacterLocation(params, deps),
    producer: PRODUCER,
    scope: LOCATION_SCOPE,
    cacheTtl: LOCATION_CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
  };
}

function createCharacterShipRoute(deps) {
  return {
    method: "GET",
    path: SHIP_PATH,
    name: "GetCharactersCharacterIdShip",
    handler: (params) => buildCharacterShip(params, deps),
    producer: PRODUCER,
    scope: SHIP_SCOPE,
    cacheTtl: SHIP_CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
  };
}

module.exports = Object.freeze({
  CHARACTER_ID_PARAM,
  FILETIME_EPOCH_OFFSET,
  FILETIME_TICKS_PER_MS,
  LOCATION_CACHE_TTL_SECONDS,
  LOCATION_PATH,
  LOCATION_SCOPE,
  ONLINE_CACHE_TTL_SECONDS,
  ONLINE_PATH,
  ONLINE_SCOPE,
  PRODUCER,
  RATE_LIMIT_GROUP,
  SHIP_CACHE_TTL_SECONDS,
  SHIP_PATH,
  SHIP_SCOPE,
  buildCharacterLocation,
  buildCharacterOnline,
  buildCharacterShip,
  createCharacterLocationRoute,
  createCharacterOnlineRoute,
  createCharacterShipRoute,
  esiTimestampFromFiletime,
  filetimeToEpochMs,
  projectCharacterLocation,
  projectCharacterOnline,
  projectCharacterShip,
});
