/**
 * `GET /characters/{id}/`, `/corporations/{id}/`, `/alliances/{id}/` and
 * `/universe/factions/`: public information about a named thing.
 *
 * Four routes in one file because they answer one question: what is this entity
 * called, and what does it belong to. None needs a credential or declares a
 * scope, and all are on eve-nexum's critical path: `/v4/characters/{id}/` is on
 * the login path, where a non-2xx blocks login with `?error=corp_check_failed`.
 *
 * `/universe/factions/` lives here rather than with the universe topology routes
 * (`routes/universe.js`: systems, stars, constellations, stations). It is a
 * roster of entities with names, tickers and owning corporations, read to put a
 * name on an id. A route registered from two files is a boot failure, so this
 * file owns it.
 *
 * Three routes, three field orders, and none is the spec's:
 *
 *   alliance      plain alphabetical
 *   character     the six required fields alphabetically, then the optionals
 *                 in an order that is not alphabetical: `title` before
 *                 `description`
 *   corporation   neither; the legacy schema's own declaration order
 *
 * `contract/openapi.json` lists all three alphabetically, so the pinned
 * document agrees with exactly one. Declaration order is output order is bytes,
 * and `contract/wire.js` `PUBLIC_ENTITY.fieldOrder` is the recording these
 * projections are compared against.
 *
 * The three entity routes are the gateway, which is why they refuse in `422`.
 * Observed 2026-08-25: bare `application/json`, a body ending in a newline, a
 * weak 64-hex `Etag`, `Expires` measured from `Date`, and no
 * `X-Esi-Request-Id`. Their error family is `VALIDATED` (`{status, error,
 * details?}`), which the router derives from `producer`.
 *
 * `/universe/factions/` is the application: `charset=UTF-8`, no trailing
 * newline, and the four-line `Vary` that `localizedBody` produces. Its
 * refusals would be `LEGACY`, and it has none because it takes no parameters.
 *
 * The id range is not in the spec (D36). An id below its entity's range is not
 * a `404`: it is a `422` whose `details[].message` names the entity (`invalid
 * corporation ID`), and the boundary is CCP's id-range start to the unit:
 * 3000000, 1000000, 99000000. `contract/wire.js` `PUBLIC_ENTITY.idMinimum`
 * holds all three with the probes that found them. Reproducing the refusal
 * hides no entity, because eve.js allocates in CCP's ranges too
 * (`services/corporation/corporationIdRanges.js` starts player corporations at
 * 98000000 and alliances at 99000000).
 *
 * Omitted fields (D37). Every optional field this replica does not send is
 * declared as an `OMIT` seat in its projection, so the divergence is visible in
 * the field order. Two reasons:
 *
 *   No observed position: `faction_id` on all three. No captured body carried
 *   one next to the fields it would sit between (a militia corporation has a
 *   `faction_id` and no `alliance_id`, a player corporation the reverse, and no
 *   corporation both), so emitting it means choosing a byte offset nobody has
 *   seen. It stays out until a `curl` settles it (D31).
 *
 *   No source in eve.js: `war_eligible` on a corporation. The vendor's
 *   war-permit state is a different concept reached through a different
 *   module, and an invented boolean is worse than a missing optional key.
 *
 * `deps.runtime` is `lib/runtimeAccess.js` or a double, and `deps.snapshot` is
 * `lib/staticSnapshot.js`'s, shared with the universe routes (one dump, one
 * validator). Nothing in `routes/` requires either module, so all four
 * endpoints are testable with no eve.js checkout.
 */

"use strict";

const { OMIT, double, numberOrNull, optional, projection } = require("../lib/serialize");
const { FAMILY_BY_PRODUCER, coercionFailed, notFound } = require("../lib/errors");
const { RouteRefusal } = require("../lib/router");
const { esiTimestampFromFiletime } = require("./characters");

// The four routes

const CHARACTER_PATH = "/characters/:character_id";
const CORPORATION_PATH = "/corporations/:corporation_id";
const ALLIANCE_PATH = "/alliances/:alliance_id";
const FACTIONS_PATH = "/universe/factions";

/**
 * `x-cache-age` in the pinned spec, and `max-age` on the wire confirms both.
 * A character is a day and the other two are an hour. `/universe/factions/` has
 * none; see `FACTIONS_CACHE_TTL_SECONDS`.
 */
const CHARACTER_CACHE_TTL_SECONDS = 86400;
const CORPORATION_CACHE_TTL_SECONDS = 3600;
const ALLIANCE_CACHE_TTL_SECONDS = 3600;

/**
 * `null`, and it is the spec's answer.
 *
 * `GetUniverseFactions` publishes no `x-cache-age`, the only operation served
 * here that does not, because it expires at an instant rather than after a
 * window: "This route expires daily at 11:05" in the operation's description,
 * and `Expires: ... 11:05:00 GMT` on the wire to the second.
 * `lib/staticSnapshot.js` turns that into a header, and `lib/router.js` refuses
 * a route that declares both a snapshot and a TTL.
 */
const FACTIONS_CACHE_TTL_SECONDS = null;

/**
 * None of the four publishes an `x-rate-limit`, so none has a token bucket and
 * the error limiter answers for them.
 *
 * Declared as a constant so that "no group" is distinguishable from "not
 * looked at"; `contract/spec.js` checks it against the pinned document.
 */
const RATE_LIMIT_GROUP = null;

const ENTITY_PRODUCER = "gateway";
const FACTIONS_PRODUCER = "app";

const ENTITY_REFUSAL_FAMILY = FAMILY_BY_PRODUCER[ENTITY_PRODUCER];

// Path ids

/**
 * The lowest id each route accepts, from `contract/wire.js`
 * `PUBLIC_ENTITY.idMinimum`.
 *
 * Duplicated here as a frozen literal because `contract/` is test-only and never
 * deployed (D20), so `lib/` and `routes/` may not require it.
 * `test/entitiesContract.test.js` asserts the two agree, as `lib/serialize.js`
 * does with the producer table.
 */
const ID_MINIMUM = Object.freeze({
  character_id: 3000000,
  corporation_id: 1000000,
  alliance_id: 99000000,
});

/**
 * `details[].message` for an id that parsed and was out of range, per
 * parameter. CCP names the entity; an unparseable id gets `invalid integer`
 * on all three, which is `lib/errors.js`'s default.
 */
const OUT_OF_RANGE_MESSAGE = Object.freeze({
  character_id: "invalid character ID",
  corporation_id: "invalid corporation ID",
  alliance_id: "invalid alliance ID",
});

/**
 * A path id as a number, or a thrown `RouteRefusal` carrying CCP's `422`.
 *
 * Which of the two refusals a request gets turns on whether the segment was an
 * integer at all: `details[].value` keeps the JSON type it arrived as, a string
 * for an unparseable id and a number for an out-of-range one.
 *
 * `/^\d+$/` goes before `Number()`, which accepts `0123123`, `1.23123e5`,
 * `0x1e0f3`, whitespace and `""` (see `lib/router.js`'s gate); CCP would not
 * have parsed any of those.
 */
function parseEntityId(raw, parameter) {
  const text = String(raw);

  if (!/^\d+$/.test(text)) {
    throw new RouteRefusal(coercionFailed(ENTITY_REFUSAL_FAMILY, { parameter, value: text }));
  }

  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < ID_MINIMUM[parameter]) {
    throw new RouteRefusal(coercionFailed(ENTITY_REFUSAL_FAMILY, {
      parameter,
      value,
      message: OUT_OF_RANGE_MESSAGE[parameter],
    }));
  }

  return value;
}

function absent() {
  return new RouteRefusal(notFound(ENTITY_REFUSAL_FAMILY));
}

/** `deps.runtime`, or an empty object: the accessors are duck-typed below. */
function readRuntime(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  return d.runtime && typeof d.runtime === "object" ? d.runtime : {};
}

/**
 * The error a route raises when the runtime cannot answer at all.
 *
 * Distinct from `absent()`, as in `routes/characters.js`: "the game does not
 * have this entity" is a `404` a client should act on, and "this build of the
 * mod cannot read entities of this kind" is a `500` an operator should. A
 * replica that reports every corporation missing looks like one with none.
 */
function unreadable(operationId, detail) {
  return new Error(
    `ESI mod: ${operationId} cannot answer: ${detail}. This is a server-side inconsistency `
      + "rather than a client error: the request named an id in CCP's range and the game was "
      + "not able to say whether it exists.",
  );
}

/** A game text field as a string, or `""`. Never `null`; the spec has none. */
function text(value) {
  return typeof value === "string" ? value : "";
}

function idOrNull(value) {
  const numeric = numberOrNull(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

// Projections, in CCP's field order.
//
// Declaration order is output order is bytes. `contract/wire.js`
// `PUBLIC_ENTITY.fieldOrder` and `FACTIONS.fieldOrder` are the recordings;
// `test/entitiesContract.test.js` compares these lists against them.

/**
 * `GET /characters/{character_id}/`.
 *
 * The six required fields first, alphabetically, then the optionals in the
 * order the wire put them, which is not alphabetical: putting `title` and
 * `description` in alphabetical order changes every response.
 *
 * `faction_id` is an `OMIT` seat with no position of its own, declared last (see
 * the header).
 */
const projectCharacter = projection("GetCharactersCharacterId", {
  birthday: (record) => record.birthday,
  bloodline_id: (record) => record.bloodlineId,
  corporation_id: (record) => record.corporationId,
  gender: (record) => record.gender,
  name: (record) => record.name,
  race_id: (record) => record.raceId,
  alliance_id: (record) => optional(record.allianceId),
  title: (record) => optional(record.title),
  description: (record) => record.description,
  security_status: (record) => double(record.securityStatus),
  faction_id: () => OMIT,
});

/**
 * `GET /corporations/{corporation_id}/`.
 *
 * The legacy schema's declaration order, neither alphabetical nor
 * required-first: `name` and `ticker` lead, the two free-text fields follow,
 * then the ids.
 *
 * `tax_rate` is the one field on this surface CCP quantises (`0.000`, `0.050`,
 * `0.100`, never `0.05`), hence `{ places: 3 }`; `contract/wire.js`
 * `DOUBLE_RENDERING.fixed` is the table of record.
 *
 * `war_eligible` and `faction_id` are `OMIT` seats for the two reasons in the
 * header.
 */
const projectCorporation = projection("GetCorporationsCorporationId", {
  name: (record) => record.name,
  ticker: (record) => record.ticker,
  description: (record) => record.description,
  url: (record) => record.url,
  date_founded: (record) => optional(record.dateFounded),
  ceo_id: (record) => record.ceoId,
  creator_id: (record) => record.creatorId,
  alliance_id: (record) => optional(record.allianceId),
  home_station_id: (record) => optional(record.homeStationId),
  member_count: (record) => record.memberCount,
  tax_rate: (record) => double(record.taxRate, { places: 3 }),
  shares: (record) => optional(record.shares),
  war_eligible: () => OMIT,
  faction_id: () => OMIT,
});

/**
 * `GET /alliances/{alliance_id}/`.
 *
 * Alphabetical, and the only one of the three that is.
 */
const projectAlliance = projection("GetAlliancesAllianceId", {
  creator_corporation_id: (record) => record.creatorCorporationId,
  creator_id: (record) => record.creatorId,
  date_founded: (record) => record.dateFounded,
  executor_corporation_id: (record) => optional(record.executorCorporationId),
  name: (record) => record.name,
  ticker: (record) => record.ticker,
  faction_id: () => OMIT,
});

/**
 * One row of `GET /universe/factions/`.
 *
 * Alphabetical. `size_factor` is a `double` (CCP writes `5.0` where this dump
 * holds the integer 5), and the two counts are required, derived, and explained
 * on `lib/runtimeAccess.js` `readFactionStationCountsFromRuntime` (D38).
 */
const projectFaction = projection("GetUniverseFactions", {
  corporation_id: (row) => optional(row.corporationId),
  description: (row) => row.description,
  faction_id: (row) => row.factionId,
  is_unique: (row) => row.isUnique,
  militia_corporation_id: (row) => optional(row.militiaCorporationId),
  name: (row) => row.name,
  size_factor: (row) => double(row.sizeFactor),
  solar_system_id: (row) => optional(row.solarSystemId),
  station_count: (row) => row.stationCount,
  station_system_count: (row) => row.stationSystemCount,
});

// Gender

/**
 * eve.js stores gender as a number and CCP publishes an enum of two strings.
 *
 * The mapping comes from the client's own constant table, which eve.js cites in
 * `space/corpseUtils.js:14`: "carbon/common/lib/const.py: genderFemale = 0,
 * genderMale = 1". `test/entitiesContract.test.js` re-reads it out of the vendor
 * tree, as `routes/roles.js`'s contract test does for the corporation role
 * mask, so a vendor drop that renumbers the constant fails a test rather than
 * publishing the wrong pronoun for every character.
 *
 * eve.js normalises the field to `0`, `1` or `2` and defaults anything else to
 * `1`. There is no third ESI value for `2`, and `gender` is required so it
 * cannot be omitted. This replica sends `male`, which is what eve.js's default
 * resolves to. That divergence has nowhere better to go.
 */
const GENDER = Object.freeze({ 0: "female", 1: "male" });
const GENDER_FALLBACK = "male";

/** eve.js's numeric gender as CCP's enum. Never absent; the field is required. */
function esiGender(value) {
  const numeric = Number(value);
  return GENDER[numeric] === undefined ? GENDER_FALLBACK : GENDER[numeric];
}

// The four bodies

/**
 * `GET /characters/{character_id}/`.
 *
 * The login path: eve-nexum reads `corporation_id` here on every login and
 * admin recheck, and in restricted mode a non-2xx blocks the login. There are
 * exactly two failure modes: an id the game does not know is a `404`, and a
 * record that cannot supply a required field is a logged `500`. Neither is a
 * body with a plausible wrong number in it.
 *
 * `peekCharacterRecord` rather than `getCharacterRecord`, with a projector
 * (`lib/runtimeAccess.js` has the detail): the second deep-clones,
 * re-serializes and, when the normalised record differs from the stored one,
 * writes. A read endpoint must not write into the game. The cost of `peek` is
 * that the callback runs against the live record and copies every field it
 * wants rather than borrowing any.
 *
 * @param {object} params  the router's; `params.path.character_id` is a string
 * @param {object} [deps]  `{ runtime }`, from the factory's closure
 */
function buildCharacter(params, deps) {
  const operationId = "GetCharactersCharacterId";
  const characterId = parseEntityId(params.path.character_id, "character_id");
  const runtime = readRuntime(deps);

  if (typeof runtime.peekCharacterRecord !== "function") {
    throw unreadable(operationId, "the runtime exposes no peekCharacterRecord accessor");
  }

  const record = runtime.peekCharacterRecord(characterId, {
    project: (found) => ({
      allianceID: found.allianceID,
      bloodlineID: found.bloodlineID,
      characterName: found.characterName,
      corporationID: found.corporationID,
      createDateTime: found.createDateTime,
      description: found.description,
      gender: found.gender,
      raceID: found.raceID,
      securityStatus: found.securityStatus,
      title: found.title,
    }),
  });
  if (record === null || typeof record !== "object") throw absent();

  const birthday = esiTimestampFromFiletime(record.createDateTime);
  const bloodlineId = idOrNull(record.bloodlineID);
  const corporationId = idOrNull(record.corporationID);
  const raceId = idOrNull(record.raceID);
  const name = record.characterName;

  // Five required fields with no honest substitute. A record that cannot supply
  // one is this server's inconsistency, not the caller's mistake, as in
  // `routes/characters.js`.
  if (
    birthday === null
    || bloodlineId === null
    || corporationId === null
    || raceId === null
    || typeof name !== "string"
    || name === ""
  ) {
    throw unreadable(
      operationId,
      `the record for character ${characterId} carries no readable createDateTime, bloodlineID, `
        + "corporationID, raceID or characterName, and all five are required",
    );
  }

  return projectCharacter({
    birthday,
    bloodlineId,
    corporationId,
    gender: esiGender(record.gender),
    name,
    raceId,
    allianceId: idOrNull(record.allianceID),
    // Emitted only when the character has one. eve.js writes `""` for a pilot with
    // no corporation title, and the captured body for such a pilot had no key, so
    // an empty string is an absence here. What CCP does with a genuinely empty
    // title is unobservable, because a pilot cannot set one.
    title: text(record.title) === "" ? null : text(record.title),
    // Not `optional()`. The captured body carried `"description":""` for a
    // character with no bio, so the empty string is a value CCP sends and omitting
    // it would be a different response.
    description: text(record.description),
    securityStatus: numberOrNull(record.securityStatus) === null
      ? 0
      : numberOrNull(record.securityStatus),
  });
}

/**
 * `GET /corporations/{corporation_id}/`.
 *
 * `getCorporationRecord` is the non-writing getter: it reads the row,
 * deep-clones it, normalises the clone and counts members off an index without
 * writing back (`lib/runtimeAccess.js`).
 *
 * `member_count`, `tax_rate`, `ceo_id`, `creator_id`, `name` and `ticker` are
 * required. The realistically absent one is `ceoID`, for an NPC corporation
 * whose CEO is an agent the dump did not carry. It is still a `500` rather than
 * a `0`, because `ceo_id: 0` names a character that does not exist.
 */
function buildCorporation(params, deps) {
  const operationId = "GetCorporationsCorporationId";
  const corporationId = parseEntityId(params.path.corporation_id, "corporation_id");
  const runtime = readRuntime(deps);

  if (typeof runtime.getCorporationRecord !== "function") {
    throw unreadable(operationId, "the runtime exposes no getCorporationRecord accessor");
  }

  const record = runtime.getCorporationRecord(corporationId);
  if (record === null || typeof record !== "object") throw absent();

  const name = record.corporationName;
  const ticker = record.tickerName;
  const ceoId = idOrNull(record.ceoID);
  const creatorId = idOrNull(record.creatorID);
  const memberCount = numberOrNull(record.memberCount);
  const taxRate = numberOrNull(record.taxRate);

  if (
    typeof name !== "string" || name === ""
    || typeof ticker !== "string" || ticker === ""
    || ceoId === null
    || creatorId === null
    || memberCount === null
    || taxRate === null
  ) {
    throw unreadable(
      operationId,
      `the record for corporation ${corporationId} carries no readable corporationName, `
        + "tickerName, ceoID, creatorID, memberCount or taxRate, and all six are required",
    );
  }

  return projectCorporation({
    name,
    ticker,
    description: text(record.description),
    url: text(record.url),
    // eve.js writes this as a Windows FILETIME under either spelling. Optional in
    // the spec, so a record with neither loses the field rather than the response,
    // unlike the alliance below, where it is required.
    dateFounded: esiTimestampFromFiletime(record.createDate || record.createdAt),
    ceoId,
    creatorId,
    allianceId: idOrNull(record.allianceID),
    homeStationId: idOrNull(record.stationID),
    memberCount,
    taxRate,
    shares: numberOrNull(record.shares),
  });
}

/**
 * `GET /alliances/{alliance_id}/`.
 *
 * Five of its seven fields are required (all except `executor_corporation_id`
 * and `faction_id`), making this the strictest of the three. `date_founded` has
 * no honest substitute and is a `500` when the FILETIME cannot be read, where
 * the corporation simply drops the key.
 *
 * `creatorCharID` is read as a fallback for `creatorID`: eve.js writes both
 * from the same argument when an alliance is founded.
 */
function buildAlliance(params, deps) {
  const operationId = "GetAlliancesAllianceId";
  const allianceId = parseEntityId(params.path.alliance_id, "alliance_id");
  const runtime = readRuntime(deps);

  if (typeof runtime.getAllianceRecord !== "function") {
    throw unreadable(operationId, "the runtime exposes no getAllianceRecord accessor");
  }

  const record = runtime.getAllianceRecord(allianceId);
  if (record === null || typeof record !== "object") throw absent();

  const name = record.allianceName;
  const ticker = record.shortName;
  const creatorCorporationId = idOrNull(record.creatorCorpID);
  const creatorId = idOrNull(record.creatorID) === null
    ? idOrNull(record.creatorCharID)
    : idOrNull(record.creatorID);
  const dateFounded = esiTimestampFromFiletime(record.createDate || record.createdAt);

  if (
    typeof name !== "string" || name === ""
    || typeof ticker !== "string" || ticker === ""
    || creatorCorporationId === null
    || creatorId === null
    || dateFounded === null
  ) {
    throw unreadable(
      operationId,
      `the record for alliance ${allianceId} carries no readable allianceName, shortName, `
        + "creatorCorpID, creatorID or createDate, and all five are required",
    );
  }

  return projectAlliance({
    creatorCorporationId,
    creatorId,
    dateFounded,
    executorCorporationId: idOrNull(record.executorCorporationID),
    name,
    ticker,
  });
}

/**
 * `GET /universe/factions/`.
 *
 * The whole roster in one body: CCP sends 27 rows and no `X-Pages`, so this
 * route does not paginate.
 *
 * Sorted by `faction_id`, which is not CCP's order. Theirs arrives 500003,
 * 500010, 500017, 500024, 500004, ... a stride through some internal bucketing
 * that nothing in the data derives, so matching CCP is impossible here and
 * order is bytes. `contract/wire.js` `FACTIONS.sortedByFactionId` records it.
 * The sort itself is upstream's: `getAllFactionRecords` already returns rows in
 * `factionID` order.
 *
 * A faction that owns no station gets `0` for both counts, as CCP sends for the
 * four factions that own nothing.
 */
function buildFactions(_params, deps) {
  const operationId = "GetUniverseFactions";
  const runtime = readRuntime(deps);

  if (typeof runtime.listFactionRecords !== "function") {
    throw unreadable(operationId, "the runtime exposes no listFactionRecords accessor");
  }

  const counts = typeof runtime.getFactionStationCounts === "function"
    ? runtime.getFactionStationCounts()
    : new Map();

  return runtime.listFactionRecords().map((row) => {
    const factionId = idOrNull(row.factionID);
    if (factionId === null) {
      throw unreadable(operationId, "the faction table carries a row with no readable factionID");
    }

    const bucket = counts instanceof Map ? counts.get(factionId) : undefined;

    return projectFaction({
      corporationId: idOrNull(row.corporationID),
      description: text(row.description),
      factionId,
      // `uniqueName` upstream. A boolean either way, and the spec requires it, so a
      // row that lost the field is `false` rather than a missing key.
      isUnique: row.uniqueName === true,
      militiaCorporationId: idOrNull(row.militiaCorporationID),
      name: text(row.name),
      sizeFactor: numberOrNull(row.sizeFactor) === null ? 0 : numberOrNull(row.sizeFactor),
      solarSystemId: idOrNull(row.solarSystemID),
      stationCount: bucket === undefined ? 0 : bucket.stations,
      stationSystemCount: bucket === undefined ? 0 : bucket.systemCount,
    });
  });
}

// Route descriptors
//
// Four plain object literals, each callable as `factory({})`: deps are read
// inside the handler, never at construction, so `test/serialize.test.js` can
// walk `routes/` and ask every factory which operation it implements.
//
// None declares `scope`, `subject` or `errorFamily`. Public is the absence of
// the first two, and the third is derived from `producer`.

function createCharacterPublicRoute(deps) {
  return {
    method: "GET",
    path: CHARACTER_PATH,
    name: "GetCharactersCharacterId",
    handler: (params) => buildCharacter(params, deps),
    producer: ENTITY_PRODUCER,
    cacheTtl: CHARACTER_CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
    // The body carries a `name` and a `description` and CCP still sends the plain
    // three-line `Vary` (`contract/wire.js` `VARY_LOCALIZED_SURVEY.plainDespiteText`).
    // The content rule describes the application producer; this route is the
    // gateway.
    localizedBody: false,
  };
}

function createCorporationPublicRoute(deps) {
  return {
    method: "GET",
    path: CORPORATION_PATH,
    name: "GetCorporationsCorporationId",
    handler: (params) => buildCorporation(params, deps),
    producer: ENTITY_PRODUCER,
    cacheTtl: CORPORATION_CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
    localizedBody: false,
  };
}

function createAlliancePublicRoute(deps) {
  return {
    method: "GET",
    path: ALLIANCE_PATH,
    name: "GetAlliancesAllianceId",
    handler: (params) => buildAlliance(params, deps),
    producer: ENTITY_PRODUCER,
    cacheTtl: ALLIANCE_CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
    localizedBody: false,
  };
}

/**
 * `GET /universe/factions/`.
 *
 * The one route here that takes a second dependency. `deps.snapshot` is
 * `lib/staticSnapshot.js`'s `facts` bound as `(now) => facts`, the same value
 * `loader.js` hands the four universe routes, so two static-data bodies from
 * this replica carry one validator as they do from CCP. Without it the route
 * would send the application's per-body etag.
 *
 * It is optional at construction: a snapshot the store cannot stamp is `null`
 * all the way down, and a replica whose dump has no provenance should still
 * answer with the roster it has.
 */
function createUniverseFactionsRoute(deps) {
  // `(now) => ({ etag, lastModified, expires })`, the shape `lib/router.js`
  // validates and `loader.js` builds for the universe routes. Passing the same
  // function to every route is what makes "one dump, one validator" hold.
  const snapshot = deps && typeof deps === "object" ? deps.snapshot : null;

  return {
    method: "GET",
    path: FACTIONS_PATH,
    name: "GetUniverseFactions",
    handler: (params) => buildFactions(params, deps),
    producer: FACTIONS_PRODUCER,
    cacheTtl: FACTIONS_CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
    // `name` and `description` on every row, and CCP repeats `Vary: Accept-Language`
    // for it: the application producer, where the content rule holds.
    // `contract/wire.js` `VARY_LOCALIZED_SURVEY.localized` has this route in it.
    localizedBody: true,
    ...(typeof snapshot === "function" ? { snapshot } : {}),
  };
}

module.exports = Object.freeze({
  ALLIANCE_CACHE_TTL_SECONDS,
  ALLIANCE_PATH,
  CHARACTER_CACHE_TTL_SECONDS,
  CHARACTER_PATH,
  CORPORATION_CACHE_TTL_SECONDS,
  CORPORATION_PATH,
  ENTITY_PRODUCER,
  ENTITY_REFUSAL_FAMILY,
  FACTIONS_CACHE_TTL_SECONDS,
  FACTIONS_PATH,
  FACTIONS_PRODUCER,
  GENDER,
  GENDER_FALLBACK,
  ID_MINIMUM,
  OUT_OF_RANGE_MESSAGE,
  RATE_LIMIT_GROUP,
  buildAlliance,
  buildCharacter,
  buildCorporation,
  buildFactions,
  createAlliancePublicRoute,
  createCharacterPublicRoute,
  createCorporationPublicRoute,
  createUniverseFactionsRoute,
  esiGender,
  parseEntityId,
  projectAlliance,
  projectCharacter,
  projectCorporation,
  projectFaction,
});
