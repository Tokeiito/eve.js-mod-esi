/**
 * The four public entity lookups, against CCP's pinned spec, three recorded
 * bodies and the wire survey.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Field order is the main subject. Three of these operations answer with the
 * same kinds of things (a name, a ticker, some ids) in three different orders,
 * none of which is the pinned spec's, and declaration order in a projection is
 * output order is bytes. The tests that matter compare each projection's key
 * list against `contract/wire.js` `PUBLIC_ENTITY.fieldOrder`, the recording of
 * live ESI, and against the recorded bodies where one exists.
 *
 * The second subject is the `422` ladder. An id below its entity's range is not
 * a `404` and does not carry the same message as an unparseable one, and the
 * boundaries are CCP's own id-range starts to the unit. The spec publishes none
 * of that.
 *
 * Doubles: `security_status: 0.0`, `tax_rate: 0.000`, `size_factor: 5.0`. Each
 * is bytes that `JSON.stringify` gets wrong and a parsed comparison cannot see
 * (`0.0` and `0` parse to the same number), so they are asserted against the
 * serialized buffer.
 *
 * Nothing here boots eve.js. Every route takes its runtime through the factory's
 * closure, so the doubles are plain objects. The two tests that read the vendor
 * tree are marked `vendorOnly` and skip with a reason when there is no
 * checkout: the gender constant, and the accessor set `routes/entities.js`
 * duck-types.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const golden = require(path.join(__dirname, "../contract/golden"));
const {
  assertBody,
  assertRouteMatchesSpec,
  describeOperation,
} = require(path.join(__dirname, "../contract/spec"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const { REPO_ROOT, vendorOnly } = require(path.join(__dirname, "vendorTree"));
const {
  ALLIANCE_PATH,
  CHARACTER_PATH,
  CORPORATION_PATH,
  ENTITY_PRODUCER,
  FACTIONS_PATH,
  FACTIONS_PRODUCER,
  GENDER,
  ID_MINIMUM,
  OUT_OF_RANGE_MESSAGE,
  RATE_LIMIT_GROUP,
  buildFactions,
  createAlliancePublicRoute,
  createCharacterPublicRoute,
  createCorporationPublicRoute,
  createUniverseFactionsRoute,
  esiGender,
  projectAlliance,
  projectCharacter,
  projectCorporation,
  projectFaction,
} = require(path.join(__dirname, "../routes/entities"));

// Fixtures
//
// Ids are taken from the pinned spec's own published examples, which keeps this
// file free of anything naming a real pilot, corporation or alliance:
// `CharacterID` is 90000001, `CorporationID` is 98777771 and `AllianceID` is
// 99000001 in `contract/openapi.json`. They also clear the minimums the routes
// enforce, which a made-up small number would not.

const CHARACTER_ID = 90000001;
const CORPORATION_ID = 98777771;
const ALLIANCE_ID = 99000001;

/** A FILETIME, which is how eve.js stores every date. */
const BIRTHDAY_FILETIME = "126587952000000000";

const CHARACTER_RECORD = Object.freeze({
  allianceID: ALLIANCE_ID,
  bloodlineID: 1,
  characterName: "Fixture Pilot",
  corporationID: CORPORATION_ID,
  createDateTime: BIRTHDAY_FILETIME,
  description: "",
  gender: 1,
  raceID: 1,
  securityStatus: 0,
  title: "",
});

const CORPORATION_RECORD = Object.freeze({
  allianceID: ALLIANCE_ID,
  ceoID: CHARACTER_ID,
  corporationName: "Fixture Corporation",
  createdAt: BIRTHDAY_FILETIME,
  creatorID: CHARACTER_ID,
  description: "",
  memberCount: 3,
  shares: 1000,
  stationID: 60000001,
  taxRate: 0.05,
  tickerName: "FIXC",
  url: "",
});

const ALLIANCE_RECORD = Object.freeze({
  allianceName: "Fixture Alliance",
  createdAt: BIRTHDAY_FILETIME,
  creatorCorpID: CORPORATION_ID,
  creatorID: CHARACTER_ID,
  executorCorporationID: CORPORATION_ID,
  shortName: "FIXA",
});

const FACTION_ROWS = Object.freeze([
  Object.freeze({
    corporationID: 1000035,
    description: "A faction that owns stations.",
    factionID: 500001,
    militiaCorporationID: 1000180,
    name: "Fixture State",
    sizeFactor: 5,
    solarSystemID: 30000145,
    uniqueName: true,
  }),
  // The case CCP has four of: a faction that owns nothing. Both counts are
  // required, so it gets zeroes rather than losing the keys.
  Object.freeze({
    description: "A faction that owns nothing.",
    factionID: 500021,
    name: "Fixture Unknown",
    sizeFactor: 0,
    uniqueName: false,
  }),
]);

const STATION_COUNTS = new Map([[500001, Object.freeze({ stations: 7, systemCount: 4 })]]);

function runtimeDouble(overrides = {}) {
  return {
    peekCharacterRecord: (id, { project }) =>
      (id === CHARACTER_ID ? project({ ...CHARACTER_RECORD }) : null),
    getCorporationRecord: (id) => (id === CORPORATION_ID ? { ...CORPORATION_RECORD } : null),
    getAllianceRecord: (id) => (id === ALLIANCE_ID ? { ...ALLIANCE_RECORD } : null),
    listFactionRecords: () => FACTION_ROWS.map((row) => ({ ...row })),
    getFactionStationCounts: () => STATION_COUNTS,
    ...overrides,
  };
}

function entityRouter(overrides = {}) {
  const runtime = runtimeDouble(overrides);
  return createRouter([
    createCharacterPublicRoute({ runtime }),
    createCorporationPublicRoute({ runtime }),
    createAlliancePublicRoute({ runtime }),
    createUniverseFactionsRoute({ runtime }),
  ]);
}

const dispatch = (pathname, overrides) =>
  dispatchRequest(entityRouter(overrides), { method: "GET", pathname, query: {}, headers: {} });

/** The wire path of a live entity of each kind, under `/latest/`. */
const LIVE = Object.freeze({
  character: `/latest/characters/${CHARACTER_ID}/`,
  corporation: `/latest/corporations/${CORPORATION_ID}/`,
  alliance: `/latest/alliances/${ALLIANCE_ID}/`,
  factions: `/latest${FACTIONS_PATH}/`,
});

/** The spec path each route implements, for `describeOperation`. */
const SPEC_PATH = Object.freeze({
  GetCharactersCharacterId: CHARACTER_PATH,
  GetCorporationsCorporationId: CORPORATION_PATH,
  GetAlliancesAllianceId: ALLIANCE_PATH,
  GetUniverseFactions: FACTIONS_PATH,
});

// The pinned spec

test("all four route descriptors match CCP's published operation", () => {
  const runtime = runtimeDouble();

  for (const factory of [
    createCharacterPublicRoute,
    createCorporationPublicRoute,
    createAlliancePublicRoute,
    createUniverseFactionsRoute,
  ]) {
    const route = factory({ runtime });
    assertRouteMatchesSpec(route);
  }
});

test("every body satisfies the schema the spec publishes for it", async () => {
  for (const [name, pathname] of [
    ["GetCharactersCharacterId", LIVE.character],
    ["GetCorporationsCorporationId", LIVE.corporation],
    ["GetAlliancesAllianceId", LIVE.alliance],
    ["GetUniverseFactions", LIVE.factions],
  ]) {
    const result = await dispatch(pathname);
    const contract = describeOperation("get", SPEC_PATH[name]);

    assert.equal(result.status, contract.successStatus, name);
    // The serialized body, parsed back, rather than the handler's return value: a
    // field marked with `double()` is a marker object until `serializeBody` renders
    // it, so validating the object would ask the spec whether `security_status` is
    // a number and be told it is an object. What a client receives is what has to
    // satisfy the schema.
    assertBody(JSON.parse(serializeBody(result.body, result.producer)), contract);
  }
});

test("the factions route publishes no x-cache-age, and so declares none", () => {
  // The only operation this replica serves that publishes no TTL. It expires at
  // a wall-clock instant instead, which is `lib/staticSnapshot.js`'s business,
  // and `lib/router.js` refuses a route that claims both.
  const contract = describeOperation("get", FACTIONS_PATH);

  assert.equal(contract.cacheAgeSeconds, null);
  assert.equal(wire.FACTIONS.cacheAgeSeconds, null);
  assert.equal(createUniverseFactionsRoute({}).cacheTtl, null);
});

test("none of the four is rate-limited, because the spec gives none a group", () => {
  for (const specPath of Object.values(SPEC_PATH)) {
    assert.equal(describeOperation("get", specPath).rateLimit, null, specPath);
  }
  assert.equal(RATE_LIMIT_GROUP, null);
});

// Field order, which is bytes

test("each projection emits CCP's field order for its own operation", () => {
  // Three operations, three orders, and the tempting generalisation is wrong in
  // three directions at once. The lists come from `contract/wire.js`, the
  // recording; a literal retyped here could drift from the observation it came
  // from.
  const emitted = (project, record) => Object.keys(project(record));

  assert.deepEqual(
    emitted(projectCharacter, {
      birthday: "x", bloodlineId: 1, corporationId: 2, gender: "male", name: "n", raceId: 3,
      allianceId: 4, title: "t", description: "d", securityStatus: 0,
    }),
    // `faction_id` is an OMIT seat with no observed position, so it never reaches
    // a body. That is why this list is shorter than the recording's by exactly the
    // fields `unobservedFields` names.
    wire.PUBLIC_ENTITY.fieldOrder.character.filter(
      (field) => !wire.PUBLIC_ENTITY.unobservedFields.character.includes(field),
    ),
  );

  assert.deepEqual(
    emitted(projectCorporation, {
      name: "n", ticker: "t", description: "d", url: "u", dateFounded: "x", ceoId: 1,
      creatorId: 2, allianceId: 3, homeStationId: 4, memberCount: 5, taxRate: 0.1, shares: 6,
    }),
    wire.PUBLIC_ENTITY.fieldOrder.corporation.filter(
      (field) => !["faction_id", "war_eligible"].includes(field),
    ),
  );

  assert.deepEqual(
    emitted(projectAlliance, {
      creatorCorporationId: 1, creatorId: 2, dateFounded: "x", executorCorporationId: 3,
      name: "n", ticker: "t",
    }),
    wire.PUBLIC_ENTITY.fieldOrder.alliance.filter(
      (field) => !wire.PUBLIC_ENTITY.unobservedFields.alliance.includes(field),
    ),
  );

  assert.deepEqual(
    emitted(projectFaction, {
      corporationId: 1, description: "d", factionId: 2, isUnique: true,
      militiaCorporationId: 3, name: "n", sizeFactor: 1, solarSystemId: 4,
      stationCount: 5, stationSystemCount: 6,
    }),
    [...wire.FACTIONS.fieldOrder],
  );
});

test("the recorded bodies agree with the order the projections emit", () => {
  // The recordings are the evidence `contract/wire.js` was written from, so this
  // checks that the transcription into that file is faithful, a different
  // question from whether the projections match the transcription.
  // Spelled as two literal calls rather than a loop over names, because
  // `test/serialize.test.js` finds a recording's user by reading these sources
  // for `loadGolden("<name>"`, a crude device that a variable defeats.
  for (const [recorded, kind, name] of [
    [Object.keys(golden.loadGolden("GetCharactersCharacterId").value), "character", "GetCharactersCharacterId"],
    [Object.keys(golden.loadGolden("GetCorporationsCorporationId").value), "corporation", "GetCorporationsCorporationId"],
  ]) {
    const declared = wire.PUBLIC_ENTITY.fieldOrder[kind];

    // The recorded entity carries a subset (an NPC agent is in no alliance), so
    // this asserts the recorded keys appear in the declared relative order rather
    // than that the two lists are equal.
    assert.deepEqual(
      recorded,
      declared.filter((field) => recorded.includes(field)),
      `${name}'s recorded key order disagrees with contract/wire.js`,
    );
  }

  const factionRow = golden.loadGolden("GetUniverseFactions").value[0];
  const recordedFaction = Object.keys(factionRow);
  assert.deepEqual(
    recordedFaction,
    wire.FACTIONS.fieldOrder.filter((field) => recordedFaction.includes(field)),
  );
});

test("the recordings carry their producer's last byte", () => {
  const newline = 0x0a;

  for (const name of ["GetCharactersCharacterId", "GetCorporationsCorporationId"]) {
    const recorded = golden.loadGolden(name);
    assert.equal(recorded.entry.producer, ENTITY_PRODUCER);
    assert.equal(recorded.bytes[recorded.bytes.length - 1], newline, `${name} lost the newline`);
  }

  const factions = golden.loadGolden("GetUniverseFactions");
  assert.equal(factions.entry.producer, FACTIONS_PRODUCER);
  assert.notEqual(factions.bytes[factions.bytes.length - 1], newline, "the application writes none");
  assert.equal(factions.bytes.length, 22171);
  assert.equal(factions.value.length, wire.FACTIONS.rowCountObserved);
});

test("the alliance lookup is exempt from a recording, and says why", () => {
  // Every alliance on Tranquility is player-made, so there is no NPC entity to
  // record the way the other two use one. The exemption is the record.
  const exempt = golden.loadExemptions();

  assert.ok(exempt.GetAlliancesAllianceId, "the exemption entry is what stands in for the file");
  assert.equal(golden.hasGolden("GetAlliancesAllianceId"), false);
});

// The doubles, which a parsed comparison cannot see

test("a double reaches the wire with a decimal point", async () => {
  // `0.0` and `0` parse to the same number, so these are asserted against the
  // bytes. A replica writing `0` is short on content-length and sends a body
  // whose hash disagrees with CCP's.
  const character = await dispatch(LIVE.character);
  const characterBytes = serializeBody(character.body, character.producer).toString("utf8");
  assert.match(characterBytes, /"security_status":0\.0}/);

  const factions = await dispatch(LIVE.factions);
  const factionBytes = serializeBody(factions.body, factions.producer).toString("utf8");
  assert.match(factionBytes, /"size_factor":5\.0,/);
  assert.match(factionBytes, /"size_factor":0\.0,/, "the faction that owns nothing, too");
});

test("tax_rate is written at CCP's fixed scale, not the shortest form", async () => {
  const result = await dispatch(LIVE.corporation);
  const bytes = serializeBody(result.body, result.producer).toString("utf8");

  // The record holds 0.05. `String(0.05)` is "0.05"; CCP writes "0.050".
  assert.match(bytes, /"tax_rate":0\.050,/);
  assert.equal(wire.DOUBLE_RENDERING.fixed.tax_rate, 3);
});

test("the application escapes non-ASCII and the gateway does not", async () => {
  const dash = "Anoikis – W-space";

  const factions = await dispatch(LIVE.factions, {
    listFactionRecords: () => [{ ...FACTION_ROWS[0], description: dash }],
  });
  assert.match(
    serializeBody(factions.body, factions.producer).toString("utf8"),
    /Anoikis \\u2013 W-space/,
    "the application escapes",
  );

  const character = await dispatch(LIVE.character, {
    peekCharacterRecord: (id, { project }) =>
      project({ ...CHARACTER_RECORD, characterName: dash }),
  });
  assert.match(
    serializeBody(character.body, character.producer).toString("utf8"),
    /Anoikis – W-space/,
    "the gateway writes it raw",
  );

  assert.equal(wire.NON_ASCII_ESCAPING.byProducer.app, true);
  assert.equal(wire.NON_ASCII_ESCAPING.byProducer.gateway, false);
});

// The 422 ladder, which the spec publishes none of

test("an unparseable id is a 422 naming the parameter and keeping its string", async () => {
  for (const [pathname, parameter] of [
    ["/latest/characters/abc/", "character_id"],
    ["/latest/corporations/abc/", "corporation_id"],
    ["/latest/alliances/abc/", "alliance_id"],
  ]) {
    const result = await dispatch(pathname);

    assert.equal(result.status, 422, pathname);
    assert.deepEqual(result.body.details, [{
      message: "invalid integer",
      location: wire.DETAIL_LOCATION("path", parameter),
      value: "abc",
    }]);
  }

  // Byte-exact against the recorded refusal, for the one route it was captured
  // on. `details[].value` keeps the JSON type it arrived as, the half a client
  // reading `details` can see.
  const result = await dispatch("/latest/characters/abc/");
  assert.equal(
    serializeBody(result.body, "gateway").toString("utf8"),
    `${wire.ERROR_BYTES.validatedInvalidInteger}\n`,
  );
});

test("an id below its entity's range is a 422 that names the entity", async () => {
  for (const [pathname, parameter] of [
    [`/latest/characters/${ID_MINIMUM.character_id - 1}/`, "character_id"],
    [`/latest/corporations/${ID_MINIMUM.corporation_id - 1}/`, "corporation_id"],
    [`/latest/alliances/${ID_MINIMUM.alliance_id - 1}/`, "alliance_id"],
  ]) {
    const result = await dispatch(pathname);

    assert.equal(result.status, 422, pathname);
    assert.deepEqual(result.body.details, [{
      message: OUT_OF_RANGE_MESSAGE[parameter],
      location: wire.DETAIL_LOCATION("path", parameter),
      value: ID_MINIMUM[parameter] - 1,
    }], "and the value keeps its number type");
  }
});

test("the minimums and the wordings are the ones observed, to the unit", () => {
  // `routes/entities.js` may not require `contract/` (D20), so the numbers are
  // duplicated there. This keeps the copy honest: the boundaries were found by
  // bisecting live ESI and a drifted copy would refuse ids CCP accepts.
  assert.deepEqual({ ...ID_MINIMUM }, { ...wire.PUBLIC_ENTITY.idMinimum });
  assert.deepEqual({ ...OUT_OF_RANGE_MESSAGE }, { ...wire.PUBLIC_ENTITY.outOfRangeMessage });
});

test("an id at the boundary is answered, not refused", async () => {
  // The other half of a bisection: 2999999 is a 422 and 3000000 is a 404, so an
  // off-by-one in either direction is visible here rather than in a consumer.
  for (const [pathname, parameter] of [
    [`/latest/characters/${ID_MINIMUM.character_id}/`, "character_id"],
    [`/latest/corporations/${ID_MINIMUM.corporation_id}/`, "corporation_id"],
    [`/latest/alliances/${ID_MINIMUM.alliance_id}/`, "alliance_id"],
  ]) {
    const result = await dispatch(pathname);
    assert.equal(result.status, 404, `${parameter} at its minimum should reach the handler`);
  }
});

test("an id the game does not know is the validated family's 404", async () => {
  for (const pathname of [
    "/latest/characters/95000000/",
    "/latest/corporations/98777772/",
    "/latest/alliances/99000002/",
  ]) {
    const result = await dispatch(pathname);

    assert.equal(result.status, 404, pathname);
    assert.equal(
      serializeBody(result.body, "gateway").toString("utf8"),
      `${wire.ERROR_BYTES.validatedNotFound}\n`,
    );
  }
});

test("CCP's second 404 wording is recorded and deliberately not reproduced", () => {
  // A deleted character answers `Character has been deleted!`. This replica
  // answers the plain `Not Found` for every unknown character, and the
  // divergence is written down rather than half-implemented.
  assert.equal(wire.PUBLIC_ENTITY.deletedCharacter.reproduced, false);
  assert.equal(wire.PUBLIC_ENTITY.deletedCharacter.contentLength, 53);
  assert.equal(
    Buffer.byteLength(`${wire.PUBLIC_ENTITY.deletedCharacter.body}\n`, "utf8"),
    wire.PUBLIC_ENTITY.deletedCharacter.contentLength,
    "the recorded length is the body plus the gateway's newline",
  );
});

// Producers, and what follows from them

test("the three entity lookups are the gateway and factions is the application", async () => {
  assert.equal(wire.SUCCESS_KIND[CHARACTER_PATH], wire.KIND.GATEWAY_SUCCESS);
  assert.equal(wire.SUCCESS_KIND[CORPORATION_PATH], wire.KIND.GATEWAY_SUCCESS);
  assert.equal(wire.SUCCESS_KIND[ALLIANCE_PATH], wire.KIND.GATEWAY_SUCCESS);
  assert.equal(wire.SUCCESS_KIND[FACTIONS_PATH], wire.KIND.APP_SUCCESS);

  const router = entityRouter();
  for (const [wirePath, producer] of [
    [CHARACTER_PATH, ENTITY_PRODUCER],
    [CORPORATION_PATH, ENTITY_PRODUCER],
    [ALLIANCE_PATH, ENTITY_PRODUCER],
    [FACTIONS_PATH, FACTIONS_PRODUCER],
  ]) {
    assert.equal(router.resolve("GET", wirePath).route.producer, producer, wirePath);
  }

  // The error family follows from the producer rather than being declared twice.
  assert.equal(router.resolve("GET", CHARACTER_PATH).route.errorFamily, "validated");
  assert.equal(router.resolve("GET", FACTIONS_PATH).route.errorFamily, "legacy");
});

test("a gateway body ends with a newline and an application body does not", async () => {
  const character = await dispatch(LIVE.character);
  const factions = await dispatch(LIVE.factions);

  assert.equal(serializeBody(character.body, character.producer).at(-1), 0x0a);
  assert.notEqual(serializeBody(factions.body, factions.producer).at(-1), 0x0a);
});

test("the gateway lookups carry text and still declare the plain Vary", () => {
  // The counterexample behind the producer qualifier on the content rule: these
  // three bodies have a `name` in them and CCP sends three `Vary` lines, where
  // every application route with a name sends four.
  const router = entityRouter();

  for (const wirePath of [CHARACTER_PATH, CORPORATION_PATH, ALLIANCE_PATH]) {
    assert.equal(router.resolve("GET", wirePath).route.localizedBody, false, wirePath);
  }
  assert.equal(router.resolve("GET", FACTIONS_PATH).route.localizedBody, true);

  assert.deepEqual([...wire.VARY_LOCALIZED_SURVEY.plainDespiteText], [
    "/characters/{character_id}",
    "/corporations/{corporation_id}",
    "/alliances/{alliance_id}",
  ]);
  assert.ok(wire.VARY_LOCALIZED_SURVEY.localized.includes("/universe/factions"));
});

// Routing

test("each lookup answers under the prefix eve-nexum actually calls", async () => {
  // The version prefixes are not interchangeable here: eve-nexum calls
  // /v4/characters/, /v5/corporations/ and /v3/alliances/ at those specific
  // versions and the /latest/ variants of the same resources. This endpoint
  // proves the router serves all of them.
  for (const pathname of [
    `/v4/characters/${CHARACTER_ID}/`,
    `/v5/corporations/${CORPORATION_ID}/`,
    `/v3/alliances/${ALLIANCE_ID}/`,
    `/latest/corporations/${CORPORATION_ID}/`,
    `/latest/alliances/${ALLIANCE_ID}/`,
    `/latest${FACTIONS_PATH}/`,
  ]) {
    assert.equal((await dispatch(pathname)).status, 200, pathname);
  }
});

test("every version prefix reaches every one of the four", async () => {
  for (const prefix of wire.VERSION_PREFIXES) {
    for (const suffix of [
      `/characters/${CHARACTER_ID}/`,
      `/corporations/${CORPORATION_ID}/`,
      `/alliances/${ALLIANCE_ID}/`,
      `${FACTIONS_PATH}/`,
    ]) {
      const result = await dispatch(`/${prefix}${suffix}`);
      assert.equal(result.status, 200, `/${prefix}${suffix}`);
    }
  }
});

test("the public character route does not shadow its authenticated children", async () => {
  // `/characters/:character_id` and `/characters/:character_id/online` differ by
  // a segment, so this tests that the router matches on segment count: a matcher
  // that treated a trailing segment as optional would answer this route's body
  // for a scoped one.
  const router = entityRouter();

  assert.equal(router.resolve("GET", `/characters/${CHARACTER_ID}`).route.name, "GetCharactersCharacterId");
  assert.equal(
    router.resolve("GET", `/characters/${CHARACTER_ID}/online`).outcome,
    "not-found",
    "the scoped child is not in this table, and the parent must not answer for it",
  );
});

// Reading the game

test("the character route reads the record without writing to it", async () => {
  // `peekCharacterRecord` hands out the live object, so the projector has to
  // copy. A route that returned the record itself would hand a caller a reference
  // into the game's memory, and `getCharacterRecord`, the obvious alternative
  // accessor, writes.
  let projected = null;
  const live = { ...CHARACTER_RECORD };

  await dispatch(LIVE.character, {
    peekCharacterRecord: (_id, { project }) => {
      projected = project(live);
      return projected;
    },
  });

  assert.ok(projected, "the route asked for a projection");
  assert.notEqual(projected, live, "and got its own object back");
  projected.characterName = "mutated";
  assert.equal(live.characterName, CHARACTER_RECORD.characterName, "the live record is untouched");
});

test("a runtime that cannot read an entity at all is a 500, not a 404", async () => {
  // The distinction `routes/characters.js` already draws: "the game does not
  // have this corporation" and "this build cannot read corporations" must not be
  // the same answer, or a replica with a broken accessor looks like a replica
  // with no corporations.
  const result = await dispatch(LIVE.corporation, { getCorporationRecord: undefined });
  assert.equal(result.status, 500);

  const absent = await dispatch("/latest/corporations/98777772/");
  assert.equal(absent.status, 404);
});

test("a record missing a required field is a 500 rather than a plausible zero", async () => {
  const result = await dispatch(LIVE.alliance, {
    getAllianceRecord: () => ({ ...ALLIANCE_RECORD, creatorCorpID: 0 }),
  });

  assert.equal(result.status, 500, "creator_corporation_id is required and 0 is a claim");
});

test("an optional date is dropped and a required one is not", async () => {
  // The same unreadable FILETIME, on two routes, answered two ways, because
  // `date_founded` is optional on a corporation and required on an alliance.
  const corporation = await dispatch(LIVE.corporation, {
    getCorporationRecord: () => ({ ...CORPORATION_RECORD, createdAt: "not a filetime" }),
  });
  assert.equal(corporation.status, 200);
  assert.equal("date_founded" in corporation.body, false);

  const alliance = await dispatch(LIVE.alliance, {
    getAllianceRecord: () => ({ ...ALLIANCE_RECORD, createdAt: "not a filetime" }),
  });
  assert.equal(alliance.status, 500);
});

test("an empty description is sent and an empty title is omitted", async () => {
  // Both come out of eve.js as `""`. The recorded body carries
  // `"description":""` for a character with no bio and no `title` key at all,
  // so the two are treated differently on the strength of the recording.
  const result = await dispatch(LIVE.character);

  assert.equal(result.body.description, "");
  assert.equal("title" in result.body, false);

  const titled = await dispatch(LIVE.character, {
    peekCharacterRecord: (_id, { project }) => project({ ...CHARACTER_RECORD, title: "CEO" }),
  });
  assert.equal(titled.body.title, "CEO");
  assert.deepEqual(Object.keys(titled.body).slice(-4), [
    "alliance_id", "title", "description", "security_status",
  ], "and it lands in the seat the wire put it in");
});

test("an alliance-less character omits alliance_id rather than sending zero", async () => {
  // eve.js writes `0` for "no alliance" and the spec has no nullable field, so
  // the only faithful answer is to leave the key out.
  const result = await dispatch(LIVE.character, {
    peekCharacterRecord: (_id, { project }) => project({ ...CHARACTER_RECORD, allianceID: 0 }),
  });

  assert.equal("alliance_id" in result.body, false);
  assert.equal(wire.PUBLIC_ENTITY.omitsAbsentOptionalFields ?? true, true);
});

// Factions

test("the two counts the SDE does not carry are derived, not omitted", async () => {
  const result = await dispatch(LIVE.factions);
  const [owner, pauper] = result.body;

  assert.equal(owner.station_count, 7);
  assert.equal(owner.station_system_count, 4);
  // Both are required, so a faction with no bucket gets zeroes, which is what
  // CCP sends for the four factions that own nothing.
  assert.equal(pauper.station_count, 0);
  assert.equal(pauper.station_system_count, 0);
});

test("a runtime with no station counts still answers the roster", async () => {
  // The counts are two fields out of ten. A store that cannot be read costs them
  // their values, not the endpoint its body.
  const result = await dispatch(LIVE.factions, { getFactionStationCounts: undefined });

  assert.equal(result.status, 200);
  assert.equal(result.body.length, FACTION_ROWS.length);
  assert.equal(result.body[0].station_count, 0);
});

test("the roster is sorted by faction_id, which is not CCP's order", () => {
  // Order is bytes, so this is a real divergence rather than a tidy-up, and the
  // one place on this route where matching CCP is impossible: nothing in the
  // data derives their order.
  const recorded = golden.loadGolden("GetUniverseFactions").value.map((row) => row.faction_id);
  const sorted = [...recorded].sort((left, right) => left - right);

  assert.notDeepEqual(recorded, sorted, "CCP's recorded order is not ascending");
  assert.equal(wire.FACTIONS.sortedByFactionId, false);

  const ours = buildFactions({}, { runtime: runtimeDouble() }).map((row) => row.faction_id);
  assert.deepEqual(ours, [...ours].sort((left, right) => left - right));
});

test("an absent optional faction field is omitted rather than sent as null", async () => {
  const result = await dispatch(LIVE.factions);
  const pauper = result.body[1];

  for (const field of ["corporation_id", "militia_corporation_id", "solar_system_id"]) {
    assert.equal(field in pauper, false, `${field} should be absent`);
  }
  assert.equal(wire.FACTIONS.omitsAbsentOptionalFields, true);
});

test("the factions route takes the shared static snapshot when it is given one", () => {
  // One dump, one validator: a faction and a solar system fetched from this
  // replica carry the same `Etag`, as they do from CCP. Without a snapshot the
  // route still answers, since a dump with no provenance stamp should not cost
  // the roster.
  const facts = { etag: 'W/"abc"', lastModified: "2026-08-14T15:56:13.265Z", expires: 1 };
  const withSnapshot = createUniverseFactionsRoute({
    runtime: runtimeDouble(),
    // The same `(now) => facts` value `loader.js` hands the universe routes,
    // rather than a second construction that would have to agree with it.
    snapshot: () => facts,
  });

  assert.equal(typeof withSnapshot.snapshot, "function");
  assert.deepEqual(withSnapshot.snapshot(0), facts);
  assert.equal("snapshot" in createUniverseFactionsRoute({ runtime: runtimeDouble() }), false);
  assert.equal(wire.FACTIONS.expiresDailyAt.hour, 11);
  assert.equal(wire.FACTIONS.expiresDailyAt.minute, 5);
});

// Gender

test("eve.js's numeric gender becomes CCP's enum, and never a third value", () => {
  assert.equal(esiGender(0), "female");
  assert.equal(esiGender(1), "male");
  // eve.js normalises to 0, 1 or 2 and defaults anything else to 1. `gender` is
  // required, so there is no omission available and no third ESI value to map 2
  // onto. This replica sends what eve.js's own default resolves to, and the
  // divergence is written down.
  assert.equal(esiGender(2), "male");
  assert.equal(esiGender(undefined), "male");

  assert.deepEqual(Object.values(GENDER).sort(), [...wire.PUBLIC_ENTITY.genderValues].sort());
});

test("the gender constant is still what upstream says it is", vendorOnly, () => {
  // eve.js cites the client's own table for this and the citation is the
  // authority the mapping copies: a vendor drop that renumbers the constant has
  // to fail here rather than publish the wrong pronoun for every character on
  // the server.
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "server", "src", "space", "corpseUtils.js"),
    "utf8",
  );

  assert.match(source, /genderFemale\s*=\s*0/, "upstream's cited constant moved");
  assert.match(source, /genderMale\s*=\s*1/);
  assert.equal(GENDER[0], "female");
  assert.equal(GENDER[1], "male");
});

test("the accessors this file's routes duck-type still exist upstream", vendorOnly, () => {
  // `lib/runtimeAccess.js` names the modules; this checks that the functions on
  // them are still there. A missing one is a route answering 500 on every
  // request, which a drift test should turn into a red suite a release earlier.
  //
  // Read as source text rather than required. Both modules pull in
  // `server/src/gameStore`, which opens SQLite and needs eve.js's own
  // `node_modules`, so requiring one from the mod's test process fails for a
  // reason unrelated to drift. The export list is legible without loading
  // anything.
  const exportsOf = (...segments) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, "server", "src", ...segments), "utf8");
    const block = /module\.exports\s*=\s*\{([\s\S]*?)\n\};/.exec(source);
    assert.ok(block, `${segments.join("/")} has no readable module.exports block`);
    return block[1].split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
  };

  const corporationState = exportsOf("services", "corporation", "corporationState.js");
  const factionState = exportsOf("services", "faction", "factionState.js");

  for (const name of ["getAllianceRecord", "getCorporationRecord"]) {
    assert.ok(corporationState.includes(name), `corporationState no longer exports ${name}`);
  }
  assert.ok(factionState.includes("getAllFactionRecords"), "factionState no longer exports getAllFactionRecords");

  // The writing neighbours this mod refuses to reach for are still the ones it
  // named, so the refusal is about something that exists.
  assert.ok(corporationState.includes("setCorporationRecord"), "the writing neighbour moved");
});
