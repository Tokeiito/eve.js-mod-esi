/**
 * `GET /characters/{character_id}/fleet/` and `GET /fleets/{fleet_id}/members/`.
 *
 * Both share one scope (`esi-fleets.read_fleet.v1`) and one rate-limit bucket
 * (`fleet`, 1800 tokens per 15 minutes), so shared facts are written once, as
 * in `routes/characters.js`.
 *
 * `/characters/{id}/fleet/`: the `404` is observed. Three live capture runs
 * settled `contract/wire.js` `FLEET_ABSENT`:
 *
 *     404  {"error":"Character is not in a fleet"}   39 bytes
 *
 * It is the application producer: `application/json; charset=UTF-8`, no
 * trailing newline, no `nosniff`, the three-line `VARY`, the compatibility-date
 * echo, `X-Esi-Cache-Status`, `X-Esi-Request-Id`, no `Cache-Control`, charged
 * to the token bucket at the usual 4XX cost of 5 rather than to the error
 * limiter. The producer had to be captured: the parent route
 * `GET /characters/{character_id}` is the gateway, so a sibling path is no
 * evidence. The 404 is also the common real answer, not a stub: fleet state is
 * in memory and destroyed on disconnect (`services/fleets/fleetRuntime.js`
 * `handleSessionDisconnected`), so an offline pilot is never in a fleet.
 *
 * The `200` is not observed (no available character was in a fleet across
 * three runs). Per D23 the pinned spec is authoritative for which keys exist,
 * which are required and their types; the spec cannot say field order, which is
 * bytes. See `projectCharacterFleet`.
 *
 * `/fleets/{id}/members/`: built, but every request currently ends in a
 * logged `500`. Two things are unobserved: the shape of the refusal for a
 * non-member (the subject check throws), and `role_name`, which the spec
 * requires as a localized display string while eve.js stores only a bare
 * integer role (`OMIT` is illegal on a required field, so `roleNameFor`
 * throws).
 *
 * The route is keyed by a fleet id, not a character id. The router's
 * cross-character gate fires only on a parameter named `character_id`, so a
 * scope alone would let any token holding `esi-fleets.read_fleet.v1` enumerate
 * every fleet (ids are `PROXY_NODE_ID * 10_000_000 + serial * 10_000`, a small
 * dense space). `lib/router.js` `SUBJECT` now makes a scoped route keyed by any
 * other entity id fail to compile unless it says who may read that entity.
 * This route does so with a function ("the token's subject is a member of this
 * fleet"), since that needs game state.
 *
 * The non-member refusal is unobserved, so the check throws and `gateOrFail`
 * turns that into a logged `500`: the read does not happen and the status is
 * loudly wrong rather than invented. `CROSS_ENTITY_REFUSAL` is
 * corporation-shaped (`contract/wire.js` says it cannot be reused for a fleet),
 * and D31 is the precedent for what an invented `403` costs.
 *
 * Divergences from CCP:
 *   - Member positions are fresher than eve.js's own fleet payload. A member
 *     record's `solarSystemID`/`shipTypeID`/`stationID` are a join-time
 *     snapshot that nothing refreshes on a jump. The roster fields
 *     (`character_id`, `role`, `wing_id`, `squad_id`, `join_time`,
 *     `takes_fleet_warp`) come from the member record and the three location
 *     fields from `peekCharacterRecord`.
 *   - `/fleets/{id}/members/` is gated on fleet membership, not on being the
 *     boss. A third-party source claims CCP restricts it to the boss; that is
 *     unobserved. `fleetMembersSubject` is the single place to narrow it.
 *
 * Everything is injected. `deps.runtime` is `lib/runtimeAccess.js` or a double,
 * taken through the factory's closure as in `routes/characters.js`, and nothing
 * in `routes/` requires that module. Two accessors do not exist yet:
 * `peekFleetForCharacter(characterId, { project })` and
 * `peekFleetById(fleetId, { project })`, shaped like `peekCharacterRecord`
 * (a projector applied to the live record, returning a plain owned object,
 * borrowing nothing, held across no `await`). Until then the duck-type check
 * fails and the route logs it instead of reporting every pilot as unfleeted:
 * a 404 is the normal answer here, so a build that could not read fleets would
 * otherwise report an empty fleet for everyone, forever.
 *
 * The subject predicate takes the factory's `deps`, not the dispatcher's.
 * `dispatchRequest` is called with `{ logError, now }`, which has no `runtime`,
 * and that object is the third argument `lib/router.js` hands a subject
 * function.
 */

"use strict";

const { PRODUCER: PRODUCERS, contentTypeFor, numberOrNull, optional, projection } = require("../lib/serialize");
const { CACHE_STATUS } = require("../lib/cache");
const { RouteRefusal, SUBJECT } = require("../lib/router");
const { esiTimestampFromFiletime } = require("./characters");

// The two routes

/** Canonical paths: no version prefix, no trailing slash. */
const CHARACTER_FLEET_PATH = "/characters/:character_id/fleet";
const FLEET_MEMBERS_PATH = "/fleets/:fleet_id/members";

/**
 * The two path parameters. Both spellings matter, in opposite directions.
 *
 * `character_id` is the name `lib/router.js` `authorise()` compares against the
 * token's subject. Any other spelling on `/characters/{id}/fleet/` leaves the
 * cross-character gate with nothing to compare, silently.
 *
 * `fleet_id` is what makes `/fleets/{id}/members/` fail to compile without a
 * `subject` declaration: `compileRoute`'s `ENTITY_PARAM` heuristic is `_id$`.
 * Renaming it without the suffix would reopen the hole.
 */
const CHARACTER_ID_PARAM = "character_id";
const FLEET_ID_PARAM = "fleet_id";

/**
 * `x-cache-age` in the pinned spec: 60 on `/characters/{id}/fleet/` and 5 on
 * `/fleets/{id}/members/`. `contract/spec.js` `assertRouteMatchesSpec` settles
 * both, and `test/fleetsContract.test.js` calls it on the descriptors this
 * module hands `loader.js`.
 */
const CHARACTER_FLEET_CACHE_TTL_SECONDS = 60;
const FLEET_MEMBERS_CACHE_TTL_SECONDS = 5;

/** One scope for both operations, exactly as CCP spells it. */
const SCOPE = "esi-fleets.read_fleet.v1";

/** One bucket for both, 1800 tokens per 15 minutes, and a refusal costs 5. */
const RATE_LIMIT_GROUP = "fleet";

/**
 * `/characters/{id}/fleet/` is the application producer, observed.
 *
 * Taken from `contract/wire.js` `FLEET_ABSENT` (`KIND.APP_ERROR`:
 * `application/json; charset=UTF-8`, no trailing newline, no `nosniff`), not
 * from the sibling path or the spec. The error family is derived by
 * `lib/router.js` from the producer.
 */
const CHARACTER_FLEET_PRODUCER = PRODUCERS.APP;

/**
 * `/fleets/{id}/members/`'s producer: `app`, the only value this scoped,
 * JSON-sending route may legally declare.
 *
 * `lib/router.js` `assertScope` refuses at construction to compile a scoped
 * route with the gateway producer, because no authenticated gateway route has
 * ever been observed. The other candidates are `meta` (not this surface) and
 * `null` (declares it sends no JSON). Every authenticated operation observed
 * so far is `app`.
 *
 * Still unobserved and handled inside the route: the field order of the
 * success body and its refusals.
 */
const FLEET_MEMBERS_PRODUCER = PRODUCERS.APP;

/**
 * The `404` body, verbatim: the one place this module restates observed bytes.
 *
 * It lives here because `contract/` is test-only and never deployed (D20), the
 * same bargain `lib/errors.js` takes with `CHARACTER_MISMATCH` and the two
 * `401` wordings. `test/fleetsContract.test.js` asserts this string, status and
 * producer against `contract/wire.js` `FLEET_ABSENT`.
 *
 * `lib/errors.js` has no builder for it: `notFound()` writes
 * `"<Entity> not found"`, a different sentence.
 */
const NOT_IN_A_FLEET = "Character is not in a fleet";
const NOT_IN_A_FLEET_STATUS = 404;

// eve.js's fleet model

/**
 * `member.job & FLEET_JOB_CREATOR` makes a member the fleet boss. It is not
 * the same as `member.role === FLEET_ROLE_LEADER`.
 *
 * eve.js sets both when a fleet is created and they diverge afterwards: boss
 * reassignment on disconnect mutates `job` only, leaving the departed
 * founder's `role`. ESI has one notion per field (`role` is the command rank,
 * `fleet_boss_id` the boss), so reading either for both is wrong once a fleet
 * loses its founder.
 *
 * The value is eve.js's, from `services/fleets/fleetConstants.js`, copied
 * because a route may not require a game module. It is a game constant, so the
 * drift risk is upstream's; `test/fleetsContract.test.js` states it.
 */
const FLEET_JOB_CREATOR = 2;

/**
 * eve.js's four role integers onto CCP's four role strings, 1:1 and total.
 *
 * `services/fleets/fleetConstants.js`: `FLEET_ROLE_LEADER` 1,
 * `FLEET_ROLE_WING_COMMANDER` 2, `FLEET_ROLE_SQUAD_COMMANDER` 3,
 * `FLEET_ROLE_MEMBER` 4. eve.js enforces at most one role-1 per fleet, one
 * role-2 per wing and one role-3 per squad, which is ESI's own invariant.
 *
 * An unknown integer throws rather than defaulting to `squad_member`, which
 * would silently demote a fleet commander.
 */
const ROLE_BY_FLEET_ROLE = Object.freeze({
  1: "fleet_commander",
  2: "wing_commander",
  3: "squad_commander",
  4: "squad_member",
});

/**
 * The value `wing_id` and `squad_id` carry when they do not apply.
 *
 * CCP's spec says "If not applicable, will be set to -1" on four properties,
 * and eve.js uses the same sentinel, so this is a passthrough. It is neither
 * `null` (the pinned surface declares no nullable field) nor `0` (a real wing
 * id).
 */
const NOT_APPLICABLE = -1;

/**
 * A path segment this replica will treat as an entity id: digits, no leading
 * zero, nothing else.
 *
 * The same round trip `lib/router.js` applies to `character_id`, for `fleet_id`.
 * `Number()` alone accepts `0123`, `1.23e7`, `0x1e0f3`, `+123`, `" 123 "` and a
 * trailing newline as the same id, so a gate that authorised fleet 12340000
 * could hand the handler `"1.234e7"` and a `parseInt` would read a different
 * fleet.
 *
 * `lib/router.js` does not export its copy; once it does, this one goes.
 */
const ENTITY_ID_SEGMENT = /^[1-9][0-9]*$/;

// Projections

/**
 * `GET /characters/{character_id}/fleet/`.
 *
 * Five fields, all required, so there is no `OMIT`. A four-field body without
 * `fleet_boss_id` is a contract failure (`test/fleetsContract.test.js` checks
 * against the spec).
 *
 * Field order is derived, not observed: the 200 was never captured. The
 * application producer was alphabetical on all three routes captured so far,
 * including `/ship/`, where alphabetical disagrees with the spec's declaration
 * order, so this is alphabetical. Order is bytes (and `Etag`), so one `curl`
 * from inside a fleet would settle it.
 */
const projectCharacterFleet = projection("GetCharactersCharacterIdFleet", {
  fleet_boss_id: (fleet) => fleet.fleetBossId,
  fleet_id: (fleet) => fleet.fleetId,
  role: (fleet) => fleet.role,
  squad_id: (fleet) => fleet.squadId,
  wing_id: (fleet) => fleet.wingId,
});

/**
 * One item of `GET /fleets/{fleet_id}/members/`.
 *
 * Ten fields, nine required. `station_id` is the only optional one, so the
 * omit-rather-than-null device is legal only there: a pilot in space omits it,
 * never `null` (declared nowhere on the pinned surface) and never `0` (a claim
 * about a station).
 *
 * Field order is derived, not observed, as above. `role_name` sits in its
 * alphabetical seat and is fed by `roleNameFor`, which throws.
 */
const projectFleetMember = projection("GetFleetsFleetIdMembers", {
  character_id: (member) => member.characterId,
  join_time: (member) => member.joinTime,
  role: (member) => member.role,
  role_name: (member) => member.roleName,
  ship_type_id: (member) => member.shipTypeId,
  solar_system_id: (member) => member.solarSystemId,
  squad_id: (member) => member.squadId,
  station_id: (member) => optional(numberOrNull(member.stationId)),
  takes_fleet_warp: (member) => member.takesFleetWarp,
  wing_id: (member) => member.wingId,
});

// Failures that are this server's rather than the caller's

/**
 * An unobserved wire fact standing between this module and a response.
 *
 * Its own class so a test can assert the kind of refusal, and so a reader
 * knows nothing is broken: the code is declining to invent bytes. Each
 * instance carries the request that would settle it.
 */
class UnobservedWireFactError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnobservedWireFactError";
  }
}

/**
 * The error a route raises when it cannot answer for a caller its own gate has
 * already vouched for.
 *
 * Same reasoning as `unreadable` in `routes/characters.js`. By the time a
 * handler runs, `authorise()` has proved a credential was presented, verifies,
 * carries this route's scope and names a subject entitled to the path. A
 * credential exists only because the minter read that character's record, so a
 * failure to read now is this server's inconsistency: a `500` whose reason
 * reaches the game server's log and never the client, not a `404` that would
 * say the pilot is simply not in a fleet.
 */
function unreadable(operationId, subject, detail) {
  return new Error(
    `ESI mod: ${operationId} cannot answer for ${subject}: ${detail}. `
      + "The gate above this handler already vouched for the caller, so this is a server-side "
      + "inconsistency rather than a client error, and on this endpoint it must not be reported "
      + "as a 404, which a consumer reads as 'this pilot is not in a fleet'.",
  );
}

/**
 * `404 {"error":"Character is not in a fleet"}`, as a refusal the handler
 * meant.
 *
 * Thrown as a `RouteRefusal`, which `dispatchRequest` dresses with the route's
 * headers and does not log: a pilot not in a fleet is a correct answer, and
 * logging it would flood the game log.
 *
 * One header must be supplied here. `routedRefusal` attaches `Content-Language`,
 * the three `Vary` lines and the compatibility-date echo, and leaves off
 * `X-Esi-Cache-Status` because `?page=0` was observed without one.
 * `FLEET_ABSENT` was observed with one, so the blanket rule is wrong for at
 * least this refusal. `lib/router.js` is not this file's to change, so the
 * route supplies it (a refusal's own headers win the merge). `MISS` is the
 * constant the success path defaults to and is what happened: no snapshot
 * answered, the handler ran.
 *
 * `producer` rides along as on every refusal in `lib/errors.js`: the last byte
 * of the body is not decidable from the body, and `lib/requestId.js` reads it
 * to give this response an `X-Esi-Request-Id`, which the observation shows it
 * has.
 */
function notInFleet() {
  return {
    status: NOT_IN_A_FLEET_STATUS,
    headers: {
      "content-type": contentTypeFor(CHARACTER_FLEET_PRODUCER),
      "x-esi-cache-status": CACHE_STATUS.MISS,
    },
    body: { error: NOT_IN_A_FLEET },
    producer: CHARACTER_FLEET_PRODUCER,
  };
}

// Reading the game

/** `deps.runtime`, or an empty object: every accessor is duck-typed below. */
function readRuntime(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  return d.runtime && typeof d.runtime === "object" ? d.runtime : {};
}

/**
 * Who is asking, as a number that was signed.
 *
 * `params.credential.characterId`, never `params.path.character_id`: the path
 * segment is a string typed by the requester, and the credential is the number
 * the gate already compared against it. Restated from `routes/characters.js`
 * because that module does not export it.
 */
function callerCharacterId(params) {
  const credential = params && params.credential;
  const characterId = credential && credential.characterId;

  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new Error(
      "ESI mod: a fleet route ran with no verified credential. Both routes in this module declare "
        + "a scope, so lib/router.js authorise() should have refused the request before the "
        + "handler saw it.",
    );
  }

  return characterId;
}

/**
 * A path segment as an entity id, or `null` for one this replica will not treat
 * as canonical. See `ENTITY_ID_SEGMENT`. `null` rather than a throw: the gate
 * refuses, and the handler has nothing to look up.
 */
function entityId(segment) {
  if (segment === null || segment === undefined) return null;
  const text = String(segment);
  if (!ENTITY_ID_SEGMENT.test(text)) return null;

  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The caller's fleet, projected, or `null` for a caller who is not in one.
 *
 * `peekFleetForCharacter` is duck-typed, and an absent accessor throws rather
 * than returning `null`. `null` means "not in a fleet", a `404` consumers treat
 * as normal, so a build that could not read fleets would report every pilot as
 * unfleeted forever.
 *
 * The projector runs against the live in-memory fleet (a `peek` accessor does
 * not clone), so it copies what it wants and borrows nothing. There is no
 * `await` on this path to hold a reference across.
 */
function peekFleet(runtime, operationId, characterId, project) {
  if (typeof runtime.peekFleetForCharacter !== "function") {
    throw unreadable(
      operationId,
      `character ${characterId}`,
      "the runtime exposes no peekFleetForCharacter accessor, so this build cannot read fleets at "
        + "all, which is a different failure from the pilot not being in one",
    );
  }

  const fleet = runtime.peekFleetForCharacter(characterId, { project });
  return fleet === null || fleet === undefined || typeof fleet !== "object" ? null : fleet;
}

/**
 * The fleet a member record belongs to, read out of the live fleet object.
 *
 * A projector, because the fleet is the game's own mutable object: everything
 * needed is copied out in one synchronous pass and a plain owned object leaves.
 *
 * `fleet_boss_id` is derived by scanning for the `job` bit, because eve.js
 * exports no `getBossCharacterID`; it is the test the game's `getBossMember`
 * makes. See `FLEET_JOB_CREATOR` for why it is not `role === 1`.
 */
function projectFleetForCaller(fleet, characterId) {
  const members = fleet && fleet.members;
  const member = members && typeof members.get === "function" ? members.get(characterId) : null;

  let bossCharacterId = null;
  if (members && typeof members.values === "function") {
    for (const candidate of members.values()) {
      if (candidate && (Number(candidate.job) & FLEET_JOB_CREATOR) !== 0) {
        bossCharacterId = numberOrNull(candidate.charID);
        break;
      }
    }
  }

  return {
    fleetId: numberOrNull(fleet && fleet.fleetID),
    bossCharacterId,
    role: member ? member.role : null,
    wingId: member ? member.wingID : null,
    squadId: member ? member.squadID : null,
  };
}

/**
 * eve.js's role integer as CCP's role string. Total over the four eve.js
 * defines, and a throw otherwise; see `ROLE_BY_FLEET_ROLE`.
 */
function roleFor(operationId, subject, role) {
  const mapped = ROLE_BY_FLEET_ROLE[String(role)];
  if (mapped === undefined) {
    throw unreadable(
      operationId,
      subject,
      `the member record carries role ${JSON.stringify(role)}, which is not one of eve.js's four `
        + `(${Object.keys(ROLE_BY_FLEET_ROLE).join(", ")}), and role is a required enumerated field`,
    );
  }
  return mapped;
}

/**
 * `role_name`, which this replica cannot send: the second blocker on
 * `/fleets/{id}/members/`.
 *
 * The spec requires it ("Localized role names"). eve.js stores no display name
 * for a role (`member.role` is a bare integer), and because the field is
 * required it cannot be omitted. The four English strings CCP sends are
 * unobserved, and an unobserved wire fact waits for a real `curl`:
 *
 *     curl -sD - -H "Authorization: Bearer <token in a fleet>" \
 *          -H "Accept-Language: en" \
 *       https://esi.evetech.net/latest/fleets/<that fleet>/members/
 *
 * The route also fails on the unobserved refusal shape, so throwing here
 * costs nothing.
 *
 * For whoever captures it: `/fleets/{id}/members/` declares `Content-Language`
 * on its 200 and `/characters/{id}/fleet/` does not, so this field is likely
 * why. Take the reading in more than one language; `route.localizedBody` will
 * probably need to be `true` on this route and false on the other.
 */
function roleNameFor(role) {
  throw new UnobservedWireFactError(
    `ESI mod: GetFleetsFleetIdMembers cannot send role_name for role ${JSON.stringify(role)}. `
      + "The field is required and localized, eve.js stores no display name for a role in any "
      + "form, and the four strings CCP sends have never been observed, so there is nothing to "
      + "read and, the field being required, nothing to omit. Capture them with "
      + "`curl -sD - -H \"Authorization: Bearer <token in a fleet>\" -H \"Accept-Language: en\" "
      + "https://esi.evetech.net/latest/fleets/<that fleet>/members/`, record them in "
      + "contract/wire.js beside FLEET_ABSENT, and read them here.",
  );
}

// The bodies

/**
 * `GET /characters/{character_id}/fleet/`.
 *
 * Three outcomes:
 *
 *   - the caller is in a fleet         -> `200`, the five-field body
 *   - the caller is not in a fleet     -> the observed `404`, thrown as a
 *                                         `RouteRefusal` so it is answered
 *                                         rather than logged
 *   - the fleet cannot be read at all  -> a logged `500`, because "this build
 *                                         cannot read fleets" must not be
 *                                         answered as "this pilot has none"
 *
 * @param {object} params  the router's, with `credential` already verified
 * @param {object} [deps]  `{ runtime }`, from the factory's closure
 */
function buildCharacterFleet(params, deps) {
  const operationId = "GetCharactersCharacterIdFleet";
  const characterId = callerCharacterId(params);
  const runtime = readRuntime(deps);

  const fleet = peekFleet(runtime, operationId, characterId, projectFleetForCaller);

  // The common answer on this server. Fleet state is in memory and destroyed on
  // disconnect, so every offline pilot arrives here, correctly.
  if (fleet === null || fleet.fleetId === null) throw new RouteRefusal(notInFleet());

  // In a fleet, but with no member record for the caller: the game's
  // character-to-fleet index and the fleet's member map disagree. That is not
  // "not in a fleet", and there is no honest value for `role`, `wing_id` or
  // `squad_id`, all required.
  if (fleet.role === null || fleet.role === undefined) {
    throw unreadable(
      operationId,
      `character ${characterId}`,
      `the game indexes them into fleet ${fleet.fleetId} and that fleet holds no member record `
        + "for them, so role, wing_id and squad_id, all required, have no honest value",
    );
  }

  // Derived from the `job` bit, not `role`. A fleet whose founder disconnected
  // has its boss reassigned by mutating `job` alone, so this is the field that
  // goes wrong first if the two notions are confused.
  if (fleet.bossCharacterId === null) {
    throw unreadable(
      operationId,
      `character ${characterId}`,
      `fleet ${fleet.fleetId} has no member carrying the creator job bit, and fleet_boss_id is `
        + "required",
    );
  }

  // `-1` passes through unchanged: CCP's "not applicable" and eve.js's too.
  const wingId = numberOrNull(fleet.wingId);
  const squadId = numberOrNull(fleet.squadId);
  if (wingId === null || squadId === null) {
    throw unreadable(
      operationId,
      `character ${characterId}`,
      `the member record carries wingID ${JSON.stringify(fleet.wingId)} and squadID `
        + `${JSON.stringify(fleet.squadId)}, and both wing_id and squad_id are required: the `
        + `sentinel for "not applicable" is ${NOT_APPLICABLE}, never null and never 0`,
    );
  }

  return projectCharacterFleet({
    fleetBossId: fleet.bossCharacterId,
    fleetId: fleet.fleetId,
    role: roleFor(operationId, `character ${characterId}`, fleet.role),
    squadId,
    wingId,
  });
}

/**
 * One member of a fleet, from the roster plus a live character record.
 *
 * The roster fields come from the fleet member record and the three location
 * fields from `peekCharacterRecord`, because the member record's copies are a
 * join-time snapshot that nothing refreshes when a pilot jumps.
 *
 * One `peekCharacterRecord` per member, synchronously, with no `await` between
 * them (the torn-read rule the accessor documents).
 */
function buildFleetMember(runtime, operationId, fleetId, member) {
  const subject = `fleet ${fleetId}`;
  const characterId = numberOrNull(member && member.charID);

  if (characterId === null) {
    throw unreadable(operationId, subject, "a member record carries no readable charID");
  }

  if (typeof runtime.peekCharacterRecord !== "function") {
    throw unreadable(
      operationId,
      subject,
      "the runtime exposes no peekCharacterRecord accessor, and solar_system_id and ship_type_id "
        + "are read from the live character record rather than from the member snapshot",
    );
  }

  const record = runtime.peekCharacterRecord(characterId, {
    project: (found) => ({
      solarSystemID: found.solarSystemID,
      stationID: found.stationID,
      shipTypeID: found.shipTypeID,
    }),
  }) || {};

  const solarSystemId = numberOrNull(record.solarSystemID);
  const shipTypeId = numberOrNull(record.shipTypeID);

  // Both required, and the surface has no nullable field. The case that produces
  // this is a pilot in abyssal space, whose `solarSystemID` eve.js scrubs to
  // `null` by design; `/location/` answers it with a 500 rather than a body
  // claiming system 0.
  if (solarSystemId === null || shipTypeId === null) {
    throw unreadable(
      operationId,
      subject,
      `character ${characterId} has no readable solarSystemID or shipTypeID, and both `
        + "solar_system_id and ship_type_id are required (a pilot in abyssal space has the first "
        + "scrubbed to null by eve.js, and there is no honest substitute)",
    );
  }

  const joinTime = esiTimestampFromFiletime(member.timestamp);
  if (joinTime === null) {
    throw unreadable(
      operationId,
      subject,
      `character ${characterId} has an unreadable member timestamp `
        + `(${JSON.stringify(member.timestamp)}), and join_time is required`,
    );
  }

  const wingId = numberOrNull(member.wingID);
  const squadId = numberOrNull(member.squadID);
  if (wingId === null || squadId === null) {
    throw unreadable(
      operationId,
      subject,
      `character ${characterId} carries wingID ${JSON.stringify(member.wingID)} and squadID `
        + `${JSON.stringify(member.squadID)}, and the sentinel for "not applicable" is `
        + `${NOT_APPLICABLE}`,
    );
  }

  const optOuts = member.memberOptOuts || {};

  return projectFleetMember({
    characterId,
    joinTime,
    role: roleFor(operationId, subject, member.role),
    // Throws today. See `roleNameFor`: the field is required and localized, with
    // no source in eve.js and no observation.
    roleName: roleNameFor(member.role),
    shipTypeId,
    solarSystemId,
    squadId,
    // The only optional field on either operation: a pilot in space omits it
    // rather than sending null or 0.
    stationId: record.stationID,
    // `!== false`, matching how eve.js normalises its opt-out record: the field
    // defaults to accepting fleet warps and only an explicit `false` opts out. A
    // truthiness test would publish `undefined` as opted out.
    takesFleetWarp: optOuts.acceptsFleetWarp !== false,
    wingId,
  });
}

/**
 * `GET /fleets/{fleet_id}/members/`.
 *
 * The whole roster in the fleet's own member iteration order; CCP's spec
 * declares none and no real ordering has been observed.
 *
 * An empty array is a valid body (a fleet whose members are all mid-disconnect),
 * not a 404 or a refusal.
 *
 * The route's `subject` predicate has already proved the caller is a member of
 * this fleet (`fleetMembersSubject`), so nothing here checks it again.
 */
function buildFleetMembers(params, deps) {
  const operationId = "GetFleetsFleetIdMembers";
  const runtime = readRuntime(deps);

  // Canonical before use, for the reason `ENTITY_ID_SEGMENT` gives. The gate
  // applied the same rule; repeating it keeps the handler correct if something
  // other than that gate calls it.
  const fleetId = entityId(params && params.path && params.path[FLEET_ID_PARAM]);
  if (fleetId === null) {
    throw unreadable(
      operationId,
      "the request",
      `the ${FLEET_ID_PARAM} path segment is not a canonical positive integer, and the gate that `
        + "should have refused it let it through",
    );
  }

  if (typeof runtime.peekFleetById !== "function") {
    throw unreadable(
      operationId,
      `fleet ${fleetId}`,
      "the runtime exposes no peekFleetById accessor, so this build cannot read fleets at all",
    );
  }

  // One synchronous projection off the live fleet, copying the roster fields out
  // and borrowing nothing, as `projectFleetForCaller` does.
  const roster = runtime.peekFleetById(fleetId, {
    project: (fleet) => {
      const members = fleet && fleet.members;
      const out = [];
      if (members && typeof members.values === "function") {
        for (const member of members.values()) {
          out.push({
            charID: member.charID,
            role: member.role,
            wingID: member.wingID,
            squadID: member.squadID,
            timestamp: member.timestamp,
            memberOptOuts: { acceptsFleetWarp: member.memberOptOuts && member.memberOptOuts.acceptsFleetWarp },
          });
        }
      }
      return out;
    },
  });

  // The gate proved the caller is in this fleet, so a fleet that is gone by now
  // is this server's race, not a client mistake. A `404` would tell a consumer
  // the fleet never existed.
  if (!Array.isArray(roster)) {
    throw unreadable(
      operationId,
      `fleet ${fleetId}`,
      "the game no longer holds that fleet, although the gate one call earlier found the caller "
        + "in it",
    );
  }

  return roster.map((member) => buildFleetMember(runtime, operationId, fleetId, member));
}

// Who may read this fleet

/**
 * `lib/router.js` `SUBJECT`'s function form, for `/fleets/{fleet_id}/members/`.
 *
 * Returns `null` to let the request through and throws to stop it, because the
 * refusal is unobserved: `gateOrFail` catches the throw, logs it against the
 * route name and answers a `500`. The read does not happen, and the status is
 * loudly wrong rather than invented.
 *
 * It never returns a refusal object. `CROSS_ENTITY_REFUSAL` is a `403` worded
 * for a corporation and `contract/wire.js` says it cannot be reused for a
 * fleet. A `404` hiding the fleet's existence is no more observed. D31 is the
 * precedent: a `403` reasoned out for another route would have been wrong in
 * six dimensions.
 *
 *     curl -sD - -H "Authorization: Bearer <token for a character in no fleet>" \
 *       https://esi.evetech.net/latest/fleets/<some other fleet>/members/
 *     curl -sD - -H "Authorization: Bearer <token for a non-boss fleet member>" \
 *       https://esi.evetech.net/latest/fleets/<that fleet>/members/
 *
 * The second also settles whether CCP's predicate is membership or boss-only.
 * This module gates on membership, the question a fleet id can be checked
 * against and strictly narrower than "any token holder". If CCP refuses a
 * non-boss member, this function is the one place to narrow.
 *
 * @param {object} claims       the verified token's projection
 * @param {object} pathParams   the router's captures, strings
 * @param {object} [deps]       `{ runtime }`, from the factory's closure, not
 *                              the dispatcher's, which carries no runtime
 */
function fleetMembersSubject(claims, pathParams, deps) {
  const runtime = readRuntime(deps);
  const characterId = claims && claims.characterId;
  const fleetId = entityId(pathParams && pathParams[FLEET_ID_PARAM]);

  // A segment this replica will not treat as canonical is refused before any
  // lookup. `Number("1.234e7")` and `Number("0x1e0f3")` are both integers, and a
  // gate that accepted either would authorise a read of a different fleet than
  // the one it checked.
  if (fleetId === null) {
    throw new UnobservedWireFactError(
      `ESI mod: GetFleetsFleetIdMembers refused a ${FLEET_ID_PARAM} segment `
        + `(${JSON.stringify(pathParams && pathParams[FLEET_ID_PARAM])}) that is not a canonical `
        + "positive integer, and the refusal CCP sends for it has never been observed. The read "
        + "did not happen; the status is a 500 because inventing one would be worse.",
    );
  }

  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new Error(
      "ESI mod: the fleet-members subject check ran with no verified credential. The route "
        + "declares a scope, so lib/router.js authorise() reaches this only after a token "
        + "verified and carried it.",
    );
  }

  // The same accessor the other route uses, projected to the one field needed.
  // An absent accessor throws rather than refusing: "this build cannot read
  // fleets" must not be answered as "you are not in this fleet".
  if (typeof runtime.peekFleetForCharacter !== "function") {
    throw unreadable(
      "GetFleetsFleetIdMembers",
      `character ${characterId}`,
      "the runtime exposes no peekFleetForCharacter accessor, so whether they are in this fleet "
        + "cannot be decided, and an undecidable gate must refuse rather than default",
    );
  }

  const fleet = runtime.peekFleetForCharacter(characterId, {
    project: (found) => ({ fleetID: found && found.fleetID }),
  });

  if (fleet && numberOrNull(fleet.fleetID) === fleetId) return null;

  throw new UnobservedWireFactError(
    `ESI mod: GetFleetsFleetIdMembers refused character ${characterId} a read of fleet ${fleetId}, `
      + "which they are not a member of. That refusal is correct and its *bytes* are unobserved: "
      + "contract/wire.js CROSS_ENTITY_REFUSAL is corporation-shaped and says itself that it "
      + "cannot be reused for a fleet, and a 404 hiding the fleet's existence is the other guess. "
      + "So this throws, gateOrFail answers the observed 500, and the roster is not read, which "
      + "is the property that matters. Settle it with `curl -sD - -H \"Authorization: Bearer "
      + "<token for a character in no fleet>\" https://esi.evetech.net/latest/fleets/<a fleet "
      + "they are not in>/members/`.",
  );
}

// Route descriptors
//
// Plain object literals, and the factory is callable as `factory({})`: deps are
// read inside the handler and the subject predicate, never at construction, so
// `test/serialize.test.js` can walk `routes/` from disk and ask a factory which
// operation it implements without booting anything.
//
// No `errorFamily` is declared. `lib/router.js` derives it from `producer`.

/**
 * `GET /characters/{character_id}/fleet/`: registrable.
 *
 * `subject: SUBJECT.CALLER` is the router's default, written out to contrast
 * with the function form on the sibling route. A route keyed only by
 * `character_id` gets the comparison `authorise()` always made; a route keyed
 * by anything else has to say.
 */
function createCharacterFleetRoute(deps) {
  return {
    method: "GET",
    path: CHARACTER_FLEET_PATH,
    name: "GetCharactersCharacterIdFleet",
    handler: (params) => buildCharacterFleet(params, deps),
    producer: CHARACTER_FLEET_PRODUCER,
    scope: SCOPE,
    subject: SUBJECT.CALLER,
    cacheTtl: CHARACTER_FLEET_CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
  };
}

/**
 * `GET /fleets/{fleet_id}/members/`.
 *
 * The projection, roster read, role map, location hybrid and `subject`
 * predicate are finished and tested. Requests end in a logged `500` until the
 * observations named in the header exist: the non-member refusal shape
 * (`fleetMembersSubject` throws) and `role_name` (see `roleNameFor`), which
 * is a blocker independent of the refusal.
 */
function createFleetMembersRoute(deps) {

  return {
    method: "GET",
    path: FLEET_MEMBERS_PATH,
    name: "GetFleetsFleetIdMembers",
    handler: (params) => buildFleetMembers(params, deps),
    producer: FLEET_MEMBERS_PRODUCER,
    scope: SCOPE,
    // The function form of `SUBJECT`: a scoped route keyed by `fleet_id` will not
    // compile without saying who may read that fleet. It closes over the
    // factory's `deps` because the router's third argument is the dispatcher's
    // deps, which carry no runtime.
    subject: (claims, pathParams) => fleetMembersSubject(claims, pathParams, deps),
    cacheTtl: FLEET_MEMBERS_CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
  };
}

module.exports = Object.freeze({
  CHARACTER_FLEET_CACHE_TTL_SECONDS,
  CHARACTER_FLEET_PATH,
  CHARACTER_FLEET_PRODUCER,
  CHARACTER_ID_PARAM,
  ENTITY_ID_SEGMENT,
  FLEET_ID_PARAM,
  FLEET_JOB_CREATOR,
  FLEET_MEMBERS_CACHE_TTL_SECONDS,
  FLEET_MEMBERS_PATH,
  FLEET_MEMBERS_PRODUCER,
  NOT_APPLICABLE,
  NOT_IN_A_FLEET,
  NOT_IN_A_FLEET_STATUS,
  RATE_LIMIT_GROUP,
  ROLE_BY_FLEET_ROLE,
  SCOPE,
  UnobservedWireFactError,
  buildCharacterFleet,
  buildFleetMember,
  buildFleetMembers,
  createCharacterFleetRoute,
  createFleetMembersRoute,
  entityId,
  fleetMembersSubject,
  notInFleet,
  projectCharacterFleet,
  projectFleetForCaller,
  projectFleetMember,
  roleFor,
  roleNameFor,
});
