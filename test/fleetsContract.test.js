/**
 * `GET /characters/{character_id}/fleet/` and `GET /fleets/{fleet_id}/members/`:
 * the contract.
 *
 * Run with: node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Written from CCP's pinned document and from `contract/wire.js`, with no
 * golden recording to diff against: a recording of either body would be a real
 * pilot's fleet committed to this repository. `contract/golden/` holds public,
 * unauthenticated endpoints only.
 *
 * The two operations are in three different states, and this suite keeps the
 * claims apart:
 *
 *   1. Observed. The `404` for a pilot who is not in a fleet, captured across
 *      three live runs and recorded as `contract/wire.js` `FLEET_ABSENT`.
 *      Claims about those bytes are read from that module rather than retyped,
 *      so the test cannot agree with a drifted copy.
 *
 *   2. Spec-derived. The `200` on `/characters/{id}/fleet/`. No available
 *      character was in a fleet across those runs, so the success body is
 *      built from the pinned spec (D23), which is authoritative for the
 *      body's possibility space and silent about field order. The order
 *      assertions say they assert a pattern (the three application routes
 *      observed earlier were all alphabetical), not a reading.
 *
 *   3. Blocked. `/fleets/{id}/members/` in its entirety. Its producer has
 *      never been observed and `lib/router.js` makes a wrong one a boot
 *      failure, so `routes/fleets.js` refuses to hand out a descriptor for it.
 *      `role_name` is required and localized, with no source in eve.js and no
 *      observation, so the route refuses to invent one. Both refusals are
 *      asserted here.
 *
 * The last section covers access, not bodies. `/fleets/{fleet_id}/members/` is
 * keyed by a fleet id, and the router's cross-character gate only fired on a
 * path parameter named `character_id`, so a route of this shape was gated by
 * its scope alone. A scope says the caller may read fleet rosters, not that
 * they may read that one. The section asserts that the route does not compile
 * without a `subject` declaration, that a non-member is refused before the
 * handler runs, and that a `fleet_id` spelled `"1.2e7"` does not authorise a
 * read of fleet 12000000.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const spec = require(path.join(__dirname, "../contract/spec"));
const { SpecContractError, assertBody, describeOperation } = spec;
const wire = require(path.join(__dirname, "../contract/wire"));
const {
  RouteTableError,
  createRouter,
  dispatchRequest,
} = require(path.join(__dirname, "../lib/router"));

const FLEETS_ROUTE = path.join(__dirname, "..", "routes", "fleets.js");
const fleets = require(FLEETS_ROUTE);

/**
 * Every id below is synthetic.
 *
 * `CHARACTER_ID` is CCP's documented `CharacterID` example from the pinned
 * spec, not any pilot a capture was taken with; `contract/` holds nobody's
 * character data (D23). The fleet, wing and squad ids are shaped the way
 * eve.js allocates them (`node * 10_000_000 + serial * 10_000`, then
 * `+ 20_000 + n` for a wing and `+ 30_000 + n` for a squad) without being
 * anyone's.
 */
const CHARACTER_ID = 90000001;
const OTHER_CHARACTER_ID = 90000002;
const FLEET_ID = 10020000;
const WING_ID = FLEET_ID + 20001;
const SQUAD_ID = FLEET_ID + 30001;

/** The wire paths, not the spec paths. `/v1/.../fleet/` is the same operation. */
const CHARACTER_FLEET_PATH = `/latest/characters/${CHARACTER_ID}/fleet/`;
const FLEET_MEMBERS_PATH = `/latest/fleets/${FLEET_ID}/members/`;

const FLEET = () => describeOperation("get", CHARACTER_FLEET_PATH);
const MEMBERS = () => describeOperation("get", FLEET_MEMBERS_PATH);

/** The item schema of the members array (see the harness note in its test). */
const MEMBER_ITEM = () => MEMBERS().schema.items;

// What the spec says

test("/characters/{id}/fleet/ requires all five of its fields and offers none optional", () => {
  const contract = FLEET();

  // The issue that specified this endpoint shows a four-field body (`fleet_id`,
  // `wing_id`, `squad_id`, `role`), but `fleet_boss_id` is required, so that
  // body is not a valid response.
  assert.deepEqual(
    [...contract.requiredKeys].sort(),
    ["fleet_boss_id", "fleet_id", "role", "squad_id", "wing_id"],
  );
  assert.deepEqual(contract.optionalKeys, [], "nothing here may be omitted");

  for (const field of ["fleet_boss_id", "fleet_id", "squad_id", "wing_id"]) {
    assert.equal(contract.schema.properties[field].type, "integer", `${field} is an integer`);
    assert.equal(contract.schema.properties[field].format, "int64");
  }
  assert.equal(contract.schema.properties.role.type, "string");
});

test("/fleets/{id}/members/ is an array, and station_id is its only optional field", () => {
  const contract = MEMBERS();

  // Harness limitation: `describeOperation` populates `requiredKeys` and
  // `optionalKeys` only for a schema whose `type` is `object`, and this one is
  // an array. Both come back empty and mean nothing here; the real answer is
  // one level down.
  assert.equal(contract.schema.type, "array");
  assert.deepEqual(contract.requiredKeys, [], "empty because the schema is an array, not evidence");
  assert.deepEqual(contract.optionalKeys, []);

  const item = MEMBER_ITEM();
  assert.deepEqual([...item.required].sort(), [
    "character_id",
    "join_time",
    "role",
    "role_name",
    "ship_type_id",
    "solar_system_id",
    "squad_id",
    "takes_fleet_warp",
    "wing_id",
  ]);

  // Ten properties, nine required, so exactly one may be left out.
  const optional = Object.keys(item.properties).filter((key) => !item.required.includes(key));
  assert.deepEqual(optional, ["station_id"]);
  assert.equal(Object.keys(item.properties).length, 10);

  assert.equal(item.properties.join_time.format, "date-time");
  assert.equal(item.properties.takes_fleet_warp.type, "boolean");
  assert.equal(item.properties.role_name.type, "string");
  for (const field of ["character_id", "ship_type_id", "solar_system_id", "squad_id", "station_id", "wing_id"]) {
    assert.equal(item.properties[field].type, "integer", `${field} is an integer`);
  }
});

test("one scope for both operations, spelled CCP's way", () => {
  assert.deepEqual(FLEET().scopes, ["esi-fleets.read_fleet.v1"]);
  assert.deepEqual(MEMBERS().scopes, ["esi-fleets.read_fleet.v1"]);
  assert.equal(fleets.SCOPE, FLEET().scopes[0]);
});

test("the numbers clients poll on, and the one bucket behind both", () => {
  // 60 on the fleet lookup and 5 on the roster, a twelvefold difference.
  // `x-cache-age` is what `Expires` is computed from, so a wrong value here is a
  // client polling twelve times harder than needed against the game's own event
  // loop.
  assert.equal(FLEET().cacheAgeSeconds, 60);
  assert.equal(MEMBERS().cacheAgeSeconds, 5);
  assert.equal(fleets.CHARACTER_FLEET_CACHE_TTL_SECONDS, FLEET().cacheAgeSeconds);
  assert.equal(fleets.FLEET_MEMBERS_CACHE_TTL_SECONDS, MEMBERS().cacheAgeSeconds);

  for (const contract of [FLEET(), MEMBERS()]) {
    assert.deepEqual(contract.rateLimit, { group: "fleet", maxTokens: 1800, windowSize: "15m" });
    assert.deepEqual(contract.statuses, [200], "the spec declares no error status at all");
  }
  assert.equal(fleets.RATE_LIMIT_GROUP, FLEET().rateLimit.group);
});

test("the role enum is the same four strings on both, whatever order they are declared in", () => {
  // The two schemas spell the enum in different orders (one alphabetical, one
  // rank-ordered). Enum order is not semantic, and `contract/spec.js` checks
  // membership.
  const fleetRoles = [...FLEET().schema.properties.role.enum].sort();
  const memberRoles = [...MEMBER_ITEM().properties.role.enum].sort();

  assert.deepEqual(fleetRoles, memberRoles);
  assert.deepEqual(fleetRoles, [
    "fleet_commander",
    "squad_commander",
    "squad_member",
    "wing_commander",
  ]);

  // `fleet_commander` by name: it is the exact string the one consumer of this
  // endpoint gates on before it asks for the roster.
  assert.ok(fleetRoles.includes("fleet_commander"));

  // The module's map lands on exactly that set, from eve.js's four integers.
  // Total in both directions, which is the next test's subject.
  assert.deepEqual([...new Set(Object.values(fleets.ROLE_BY_FLEET_ROLE))].sort(), fleetRoles);
});

test("the version prefix does not change either operation", () => {
  for (const prefix of ["/latest", "/v1", "/v6"]) {
    assert.equal(
      describeOperation("get", `${prefix}/characters/${CHARACTER_ID}/fleet/`).operationId,
      "GetCharactersCharacterIdFleet",
    );
    assert.equal(
      describeOperation("get", `${prefix}/fleets/${FLEET_ID}/members/`).operationId,
      "GetFleetsFleetIdMembers",
    );
  }
});

// What the wire says

test("the 404 this replica sends is the one that was observed, byte for byte", () => {
  // The answer for a pilot who is not in a fleet, the common case on this
  // server because fleet state is in-memory and destroyed on disconnect. Read
  // from `contract/wire.js` rather than retyped: `routes/fleets.js` has to carry
  // the string because `contract/` is test-only and never deployed (D20), and
  // this check stops the copy drifting.
  const observed = wire.FLEET_ABSENT;

  assert.equal(fleets.NOT_IN_A_FLEET, observed.body);
  assert.equal(fleets.NOT_IN_A_FLEET_STATUS, observed.status);
  assert.equal(fleets.RATE_LIMIT_GROUP, observed.rateLimitGroup);

  // Its shape, as the module builds it. The `content-type` and the absence of
  // `nosniff` are what make it the application's refusal rather than the
  // gateway's.
  const refusal = fleets.notInFleet();
  assert.equal(refusal.status, observed.status);
  assert.deepEqual(refusal.body, { error: observed.body });
  assert.equal(refusal.headers["content-type"], observed.contentType);
  assert.equal(refusal.headers["x-content-type-options"], undefined, "observed without nosniff");
  assert.equal(observed.sendsNosniff, false);
  assert.equal(observed.trailingNewline, false, "the application does not end a body with one");

  // Charged to the token bucket at the 4XX price, not to the error limiter. A
  // consumer polling this endpoint gets the 404 three times a minute per
  // unfleeted pilot.
  assert.equal(observed.limiter, wire.LIMITER.TOKEN_BUCKET);
  assert.equal(observed.cost, 5);
});

test("the 404 settles the producer, which a sibling path could not", () => {
  // `KIND.APP_ERROR` on the refusal records which of ESI's two implementations
  // owns the route. That one fact decides the success content-type, the
  // trailing byte, the error family and the cache headers.
  //
  // It had to be captured: the parent route `GET /characters/{character_id}` is
  // the gateway while `/characters/{character_id}/online/` beside it is the
  // application, so inheriting from a neighbour would be off by one in
  // content-length on every response.
  assert.equal(wire.FLEET_ABSENT.kind, wire.KIND.APP_ERROR);
  assert.equal(wire.FLEET_ABSENT.contentType, wire.CONTENT_TYPE[wire.KIND.APP_SUCCESS]);
  assert.equal(fleets.CHARACTER_FLEET_PRODUCER, "app");
  assert.equal(wire.SUCCESS_KIND["/characters/:character_id"], wire.KIND.GATEWAY_SUCCESS);
});

test("a scoped route has exactly one legal producer, and that is not a guess", () => {
  // Neither fleet path has a `SUCCESS_KIND` row, because no success has been
  // captured on this family. That does not mean the producer is unknown and the
  // route unregistrable. `lib/router.js` `assertScope` refuses at construction
  // to compile a route that declares a scope and the gateway producer, because
  // no authenticated gateway route has ever been observed. For a scoped route
  // that sends JSON the field can hold: gateway (a boot failure), `meta` (the
  // `/meta/` surface), `null` (claims it sends no JSON) or `app`. One survives.
  //
  // Every authenticated operation observed so far (eight or more) is `app`.
  assert.equal(wire.SUCCESS_KIND["/characters/:character_id/fleet"], undefined);
  assert.equal(wire.SUCCESS_KIND["/fleets/:fleet_id/members"], undefined);

  assert.equal(fleets.FLEET_MEMBERS_PRODUCER, "app");
  assert.equal(fleets.CHARACTER_FLEET_PRODUCER, "app");

  // The router agrees: declaring the alternative is what fails, not declaring
  // this.
  const { createRouter, RouteTableError } = require(path.join(__dirname, "../lib/router"));
  assert.throws(
    () => createRouter([{
      method: "GET",
      path: "/fleets/:fleet_id/members",
      producer: "gateway",
      scope: "esi-fleets.read_fleet.v1",
      subject: "scope-only",
      handler: () => [],
    }]),
    (err) => err instanceof RouteTableError && /no authenticated gateway route/.test(err.message),
  );
});

test("the refusal carries a cache status, which the framework's blanket rule omits", () => {
  // Two observations, both true, disagree about one header. `lib/router.js`
  // `routedRefusal` leaves `X-Esi-Cache-Status` off a route-produced refusal on
  // the evidence that `?page=0` was seen without one; `FLEET_ABSENT` was seen
  // with one. Until the router is corrected the route supplies it, which works
  // because a refusal's own headers win that merge.
  assert.equal(wire.FLEET_ABSENT.sendsCacheStatus, true);
  assert.equal(fleets.notInFleet().headers["x-esi-cache-status"], "MISS");

  // The producer rides along, which earns the response the `X-Esi-Request-Id`
  // the capture also recorded.
  assert.equal(fleets.notInFleet().producer, "app");
  assert.equal(wire.FLEET_ABSENT.sendsRequestId, true);
});

// What a plausible-but-wrong body does

test("the issue's four-field example is a contract failure", () => {
  // The issue's example body, verbatim in shape: it omits `fleet_boss_id`,
  // which is required. A handler written from the issue would have shipped
  // this.
  assert.throws(
    () => assertBody({ fleet_id: FLEET_ID, wing_id: -1, squad_id: -1, role: "fleet_commander" }, FLEET()),
    (err) => err instanceof SpecContractError
      && /body\.fleet_boss_id is required by the spec and is missing/.test(err.message),
  );
});

test("a wing_id of null instead of -1 is rejected", () => {
  // The sentinel is `-1` and it is CCP's own, stated in prose on four separate
  // properties. `null` is the obvious alternative, and the pinned surface
  // declares no nullable field anywhere.
  assert.throws(
    () => assertBody(
      { fleet_boss_id: OTHER_CHARACTER_ID, fleet_id: FLEET_ID, role: "squad_member", squad_id: -1, wing_id: null },
      FLEET(),
    ),
    (err) => /body\.wing_id is null, and the .* spec declares no nullable fields/.test(err.message),
  );
  assert.equal(fleets.NOT_APPLICABLE, -1);
});

test("a role that is not one of the four strings is rejected, integer included", () => {
  // Three shapes of the same mistake: the enum tidied, the enum shouted, and
  // eve.js's raw integer passed straight through.
  for (const role of ["fleetcommander", "FLEET_COMMANDER", 1]) {
    assert.throws(
      () => assertBody(
        { fleet_boss_id: CHARACTER_ID, fleet_id: FLEET_ID, role, squad_id: -1, wing_id: -1 },
        FLEET(),
      ),
      (err) => /body\.role/.test(err.message),
      `role ${JSON.stringify(role)} should not be accepted`,
    );
  }
});

test("a member row carrying eve.js's extra fields is rejected", () => {
  // eve.js keeps `job`, `skills`, `clientID`, `corpID`, `allianceID`,
  // `warFactionID`, `securityStatus` and `shipID` on a member record. A field
  // CCP does not send is as visible to a client as one it does.
  const row = {
    ...VALID_MEMBER_ROW(),
    job: 2,
    corpID: 1000001,
    securityStatus: 0.5,
  };

  assert.throws(
    () => assertBody([row], MEMBERS()),
    (err) => /body\[0\]\.job is not in the spec/.test(err.message),
  );
});

test("a join_time that went through toISOString is rejected", () => {
  // `new Date(ms).toISOString()` gives `...T09:00:00.000Z`, which a straight
  // FILETIME conversion produces if nobody trims it. No ESI response has ever
  // carried fractional seconds.
  const row = { ...VALID_MEMBER_ROW(), join_time: new Date("2026-08-25T09:00:00Z").toISOString() };

  assert.throws(
    () => assertBody([row], MEMBERS()),
    (err) => /is not an ESI timestamp/.test(err.message),
  );
});

test("an empty member array is a valid body", () => {
  // A fleet whose members are all mid-disconnect produces this; it is not a
  // 404 and not a refusal.
  assert.doesNotThrow(() => assertBody([], MEMBERS()));
});

/**
 * One member row that satisfies the spec, for the negative tests above.
 *
 * `role_name` is a placeholder and not a claim about what CCP sends (see the
 * blocker section at the bottom of this file). The schema requires the key,
 * and the tests above are about other fields.
 */
function VALID_MEMBER_ROW() {
  return {
    character_id: CHARACTER_ID,
    join_time: "2026-08-25T09:00:00Z",
    role: "squad_member",
    role_name: "unobserved",
    ship_type_id: 670,
    solar_system_id: 30000142,
    squad_id: SQUAD_ID,
    station_id: 60003760,
    takes_fleet_warp: true,
    wing_id: WING_ID,
  };
}

// The descriptors

test("the /characters/{id}/fleet/ descriptor agrees with the pinned spec", () => {
  const route = fleets.createCharacterFleetRoute({});
  const contract = spec.assertRouteMatchesSpec(route);

  assert.equal(route.name, contract.operationId, "the route's name is the spec's operationId");
  assert.equal(route.producer, "app", "observed through FLEET_ABSENT's kind");
  assert.equal(route.rateLimitGroup, wire.FLEET_ABSENT.rateLimitGroup);
  assert.equal(route.scope, contract.scopes[0]);
});

test("the character path parameter is spelled the way the cross-character gate reads it", () => {
  // `authorise()` compares the token's subject against the path parameter named
  // `character_id`, and any other spelling leaves it nothing to compare on a
  // route that still looks like it works.
  const { path: routePath } = fleets.createCharacterFleetRoute({});

  assert.equal(routePath, `/characters/:${fleets.CHARACTER_ID_PARAM}/fleet`);
  assert.equal(fleets.CHARACTER_ID_PARAM, "character_id");

  // The other route is spelled so that the opposite protection fires: an entity
  // id that is not `character_id` makes a `subject` declaration compulsory. See
  // the access section.
  assert.equal(fleets.FLEET_MEMBERS_PATH, `/fleets/:${fleets.FLEET_ID_PARAM}/members`);
  assert.match(fleets.FLEET_ID_PARAM, /_id$/, "the heuristic compileRoute keys the rule on");
});

// The handler, through the router
//
// Called through the router, as `loader.js` calls it. That is the only way to
// cover all nine version prefixes and, on a scoped route, the only way that
// runs `authorise()`. A handler called directly is tested with the gate
// switched off.

/** The endpoint as it actually runs: a one-route table and the real router. */
function fleetRouter(deps) {
  return createRouter([fleets.createCharacterFleetRoute(deps)]);
}

/**
 * A `lib/runtimeAccess.js` double.
 *
 * `fleet` is the shape the accessors project from: the game's own field names,
 * a `Map` of member records keyed by character id, which is what a `peek`
 * accessor hands its projector. `null` is a character the game has in no
 * fleet, the ordinary case on this server.
 *
 * `omitFleetAccessor` is the state of a build that cannot read fleets at all,
 * and it must not look like the ordinary case.
 */
function runtimeDouble({ fleet = null, records = {}, omitFleetAccessor = false, omitCharacterAccessor = false } = {}) {
  const runtime = {};

  if (!omitFleetAccessor) {
    runtime.peekFleetForCharacter = (characterId, options = {}) => {
      if (fleet === null || !fleet.members.has(characterId)) return null;
      return options.project ? options.project(fleet, characterId) : fleet;
    };
    runtime.peekFleetById = (fleetId, options = {}) => {
      if (fleet === null || fleet.fleetID !== fleetId) return null;
      return options.project ? options.project(fleet, fleetId) : fleet;
    };
  }

  if (!omitCharacterAccessor) {
    runtime.peekCharacterRecord = (characterId, options = {}) => {
      const record = records[characterId];
      if (!record) return null;
      return options.project ? options.project(record, characterId) : { ...record };
    };
  }

  return runtime;
}

/** A FILETIME decimal string for an instant, the way eve.js stores one. */
function filetime(iso) {
  return String(BigInt(Date.parse(iso)) * 10000n + 116444736000000000n);
}

/**
 * A member record shaped the way `buildMemberSnapshot` builds one.
 *
 * `job` and `role` are separate arguments because they are eve.js's two
 * notions of "in charge" and the tests below turn on their divergence.
 */
function memberRecord({ charID, role = 4, job = 0, wingID = -1, squadID = -1, joinedAt = "2026-08-25T09:00:00Z", acceptsFleetWarp = true }) {
  return {
    charID,
    role,
    job,
    wingID,
    squadID,
    timestamp: filetime(joinedAt),
    memberOptOuts: { acceptsConduitJumps: true, acceptsFleetRegroups: true, acceptsFleetWarp },
    // Fields eve.js carries and ESI does not. Present so that a projection that
    // leaked them is caught by `assertBody`'s closed-world rule.
    skills: [0, 0, 0],
    corpID: 1000001,
    securityStatus: 0.5,
    shipID: 90000003,
  };
}

/** A fleet the caller commands a wing of, whose boss is somebody else. */
function fleetRecord(members) {
  return { fleetID: FLEET_ID, members: new Map(members.map((m) => [m.charID, m])) };
}

/** A request carrying a verified credential for `characterId`. */
function authenticated(pathname, { scopes = [fleets.SCOPE], characterId = CHARACTER_ID } = {}) {
  return {
    method: "GET",
    pathname,
    query: {},
    credential: {
      presented: true,
      claims: Object.freeze({ characterId, scopes: Object.freeze([...scopes]) }),
      refusal: null,
    },
  };
}

test("a pilot who is not in a fleet gets the observed 404, and it is not logged", async () => {
  // The consumer reads this status as "this pilot is not in a fleet". On this
  // server it is the majority answer because fleet state is in-memory and
  // destroyed on disconnect.
  const logged = [];
  const router = fleetRouter({ runtime: runtimeDouble({ fleet: null }) });

  const result = await dispatchRequest(
    router,
    authenticated(CHARACTER_FLEET_PATH),
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, wire.FLEET_ABSENT.status);
  assert.deepEqual(result.body, { error: wire.FLEET_ABSENT.body });
  assert.equal(result.producer, "app");

  // A refusal the route meant is an answer, not a fault. Logging it would fill
  // the game server's log with the ordinary case three times a minute per
  // unfleeted pilot.
  assert.deepEqual(logged, [], "a RouteRefusal is deliberately not logged");

  // Dressed as a routed answer: the route's Content-Language, its three Vary
  // lines, the compatibility-date echo, and the cache status the capture
  // recorded, but no Cache-Control, which `lib/cache.js` attaches only to a 2XX.
  assert.equal(result.headers["content-language"], "en");
  assert.deepEqual(result.headers.vary, [...wire.FLEET_ABSENT.vary]);
  assert.equal(result.headers["x-compatibility-date"], "2020-01-01");
  assert.equal(result.headers["x-esi-cache-status"], "MISS");
  assert.equal(result.headers["cache-control"], undefined);
  assert.equal(wire.FLEET_ABSENT.sendsCacheControl, false);
});

test("routes/fleets.js satisfies the /characters/{id}/fleet/ contract", async () => {
  const router = fleetRouter({
    runtime: runtimeDouble({
      fleet: fleetRecord([
        memberRecord({ charID: CHARACTER_ID, role: 2, wingID: WING_ID, squadID: -1 }),
        memberRecord({ charID: OTHER_CHARACTER_ID, role: 1, job: fleets.FLEET_JOB_CREATOR, wingID: WING_ID, squadID: SQUAD_ID }),
      ]),
    }),
  });

  const result = await dispatchRequest(router, authenticated(CHARACTER_FLEET_PATH));

  assert.equal(result.status, FLEET().successStatus);
  assertBody(result.body, FLEET());

  assert.deepEqual(result.body, {
    fleet_boss_id: OTHER_CHARACTER_ID,
    fleet_id: FLEET_ID,
    role: "wing_commander",
    squad_id: -1,
    wing_id: WING_ID,
  });
});

test("the 200's field order is derived from the alphabetical pattern, not observed", () => {
  // Order is bytes: five right fields in a different order is a different
  // response and a different Etag. Nobody has seen this body, so the order is a
  // pattern: three application routes were captured earlier and all three were
  // alphabetical, including /ship/, where alphabetical disagrees with the
  // spec's own declaration order. If a capture lands and disagrees, this test
  // names the decision rather than the handler.
  assert.deepEqual([...fleets.projectCharacterFleet.fields].sort(), [...fleets.projectCharacterFleet.fields]);
  assert.deepEqual([...fleets.projectFleetMember.fields].sort(), [...fleets.projectFleetMember.fields]);

  // The spec's declaration order is not what produced it: the required list is
  // in neither alphabetical nor property order.
  assert.deepEqual(FLEET().requiredKeys, ["fleet_id", "wing_id", "squad_id", "role", "fleet_boss_id"]);
  assert.deepEqual(fleets.projectCharacterFleet.fields, [
    "fleet_boss_id",
    "fleet_id",
    "role",
    "squad_id",
    "wing_id",
  ]);
});

test("fleet_boss_id comes from the job bit, not from role === 1", async () => {
  // eve.js has two notions that both read as "in charge":
  // `member.role === FLEET_ROLE_LEADER` and `member.job & FLEET_JOB_CREATOR`.
  // They are set together at fleet creation and diverge afterwards (boss
  // reassignment on disconnect mutates `job` alone). That is the state of a
  // fleet that has lost its founder, and it decides whether a consumer goes on
  // to ask for the roster.
  const router = fleetRouter({
    runtime: runtimeDouble({
      fleet: fleetRecord([
        // Still carries the command rank, is no longer the boss.
        memberRecord({ charID: CHARACTER_ID, role: 1, job: 0, wingID: WING_ID, squadID: SQUAD_ID }),
        // Promoted by a `job` mutation, still an ordinary squad member by rank.
        memberRecord({ charID: OTHER_CHARACTER_ID, role: 4, job: fleets.FLEET_JOB_CREATOR, wingID: WING_ID, squadID: SQUAD_ID }),
      ]),
    }),
  });

  const result = await dispatchRequest(router, authenticated(CHARACTER_FLEET_PATH));

  assert.equal(result.body.role, "fleet_commander", "the caller's rank is theirs");
  assert.equal(result.body.fleet_boss_id, OTHER_CHARACTER_ID, "and the boss is somebody else");
  assertBody(result.body, FLEET());
});

test("the -1 sentinel passes through as itself", async () => {
  // eve.js uses ESI's own value, so this is a passthrough, not a conversion.
  // The failure modes guarded against are `null` (which the pinned surface
  // declares nowhere) and `0` (a real wing id).
  const router = fleetRouter({
    runtime: runtimeDouble({
      fleet: fleetRecord([
        memberRecord({ charID: CHARACTER_ID, role: 1, job: fleets.FLEET_JOB_CREATOR, wingID: -1, squadID: -1 }),
      ]),
    }),
  });

  const result = await dispatchRequest(router, authenticated(CHARACTER_FLEET_PATH));

  assert.equal(result.body.wing_id, -1);
  assert.equal(result.body.squad_id, -1);
  assertBody(result.body, FLEET());
});

test("the role map is total, and an unknown integer is not silently a squad member", () => {
  for (const [integer, string] of Object.entries(fleets.ROLE_BY_FLEET_ROLE)) {
    assert.equal(fleets.roleFor("GetCharactersCharacterIdFleet", "a test", Number(integer)), string);
  }

  // A fifth integer from a future eve.js must not become "squad_member": that
  // would demote a fleet commander in a way nothing would report.
  for (const bad of [0, 5, -1, null, undefined, "fleet_commander"]) {
    assert.throws(
      () => fleets.roleFor("GetCharactersCharacterIdFleet", "a test", bad),
      /which is not one of eve\.js's four/,
      `role ${JSON.stringify(bad)} should not map`,
    );
  }
});

test("every version prefix reaches the handler and reports the application", async () => {
  const router = fleetRouter({
    runtime: runtimeDouble({
      fleet: fleetRecord([
        memberRecord({ charID: CHARACTER_ID, role: 1, job: fleets.FLEET_JOB_CREATOR }),
      ]),
    }),
  });

  for (const prefix of wire.VERSION_PREFIXES) {
    const result = await dispatchRequest(
      router,
      authenticated(`/${prefix}/characters/${CHARACTER_ID}/fleet/`),
    );
    assert.equal(result.status, 200, `/${prefix}/…/fleet/ did not reach the handler`);
    assert.equal(result.producer, "app");
    assert.equal(result.authenticated, true, "the route declares a scope");
  }
});

// The failures that must not be answered as a 404

test("a build that cannot read fleets is a logged 500, never 'not in a fleet'", async () => {
  // "The game has no fleet for this pilot" is a 404 a consumer treats as
  // normal, so collapsing "this build cannot read fleets at all" into it would
  // report every pilot as unfleeted forever with nothing saying why.
  const logged = [];
  const router = fleetRouter({ runtime: runtimeDouble({ omitFleetAccessor: true }) });

  const result = await dispatchRequest(
    router,
    authenticated(CHARACTER_FLEET_PATH),
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, 500);
  assert.notEqual(result.status, 404, "the two failures must not look alike");
  assert.equal(logged.length, 1, "the reason goes to the game server log");
  assert.match(logged[0][1], /peekFleetForCharacter/);
  assert.doesNotMatch(
    JSON.stringify(result.body),
    /peekFleetForCharacter/,
    "and not to the client",
  );
});

test("a fleet with no boss is a logged 500, not a body inventing one", async () => {
  // `fleet_boss_id` is required and there is no honest substitute: `0` is what
  // eve.js's own helper returns for a fleet with no creator-job member, and a
  // consumer would read it as a character id.
  const logged = [];
  const router = fleetRouter({
    runtime: runtimeDouble({
      fleet: fleetRecord([memberRecord({ charID: CHARACTER_ID, role: 1, job: 0 })]),
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(CHARACTER_FLEET_PATH),
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, 500);
  assert.match(logged[0][1], /fleet_boss_id is required/);
});

test("an index that says 'in a fleet' with no member record is a 500, not a 404", async () => {
  // The game's character-to-fleet index and the fleet's own member map
  // disagree. That is not "not in a fleet" (the index says otherwise), and
  // `role`, `wing_id` and `squad_id` are all required with nothing to read.
  const logged = [];
  const fleet = fleetRecord([memberRecord({ charID: OTHER_CHARACTER_ID, job: fleets.FLEET_JOB_CREATOR })]);
  const runtime = {
    // A double that answers "yes, in this fleet" for a character the fleet does
    // not list, which reproduces the inconsistency.
    peekFleetForCharacter: (characterId, options) => options.project(fleet, characterId),
  };

  const result = await dispatchRequest(
    fleetRouter({ runtime }),
    authenticated(CHARACTER_FLEET_PATH),
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, 500);
  assert.match(logged[0][1], /holds no member record/);
});

// The gate

test("the gate refuses before the handler runs, and the handler never sees it", async () => {
  let handlerRuns = 0;
  const route = fleets.createCharacterFleetRoute({ runtime: runtimeDouble({ fleet: null }) });
  const router = createRouter([{
    ...route,
    handler: (params) => { handlerRuns += 1; return route.handler(params); },
  }]);

  const noToken = await dispatchRequest(router, { method: "GET", pathname: CHARACTER_FLEET_PATH, query: {} });
  assert.equal(noToken.status, 401, "no credential");

  const wrongScope = await dispatchRequest(
    router,
    authenticated(CHARACTER_FLEET_PATH, { scopes: ["esi-location.read_location.v1"] }),
  );
  assert.equal(wrongScope.status, 401, "a verified token without this route's scope");
  assert.match(JSON.stringify(wrongScope.body), /esi-fleets\.read_fleet\.v1/);

  const otherCharacter = await dispatchRequest(
    router,
    authenticated(CHARACTER_FLEET_PATH, { characterId: OTHER_CHARACTER_ID }),
  );
  assert.equal(otherCharacter.status, 403, "a token for somebody else");

  assert.equal(handlerRuns, 0, "the handler must not observe a request it was not allowed to see");
});

// Who may read this fleet
//
// `/fleets/{fleet_id}/members/` is keyed by a fleet id, and the router's only
// cross-entity check fired on a path parameter literally named `character_id`.
// A route of this shape was therefore gated by its scope alone, which does not
// distinguish one fleet from another, and fleet ids are a small, dense,
// enumerable space.
//
// The route cannot be registered today (its producer is unobserved), so the
// tests below exercise the gate through a scaffold: a route literal that
// borrows the real path, scope, subject predicate and handler and declares a
// producer only so the table compiles. Nothing here asserts which producer
// answers the real endpoint, and the scaffold is deliberately not the module's
// factory: `createFleetMembersRouteOnceObserved` refuses, and working around
// that refusal in a test would delete it.

/**
 * A compilable stand-in for the members route.
 *
 * `producer: "app"` is a scaffold value with no evidence behind it, present
 * only because `compileRoute` requires the column. See the block comment above.
 */
function membersScaffold(deps, { subject } = {}) {
  const runtime = deps && deps.runtime;
  return {
    method: "GET",
    path: fleets.FLEET_MEMBERS_PATH,
    name: "GetFleetsFleetIdMembers",
    handler: (params) => fleets.buildFleetMembers(params, deps),
    producer: "app",
    scope: fleets.SCOPE,
    subject: subject === undefined
      ? (claims, pathParams) => fleets.fleetMembersSubject(claims, pathParams, { runtime })
      : subject,
    cacheTtl: fleets.FLEET_MEMBERS_CACHE_TTL_SECONDS,
    rateLimitGroup: fleets.RATE_LIMIT_GROUP,
  };
}

test("a scoped route keyed by fleet_id does not compile without saying who may read it", () => {
  // The framework half of the fix, which stops the next differently-keyed
  // authenticated route from inheriting the hole silently. A false positive
  // costs one explicit declaration; a false negative is the silent hole itself.
  assert.throws(
    () => createRouter([membersScaffold({ runtime: runtimeDouble({}) }, { subject: null })]),
    (err) => err instanceof RouteTableError
      && /is keyed by fleet_id, but says nothing about who may read that entity/.test(err.message),
  );

  // With the declaration it compiles.
  assert.doesNotThrow(() => createRouter([membersScaffold({ runtime: runtimeDouble({}) })]));
});

test("a correctly-scoped token for somebody else's fleet is refused, and the handler never runs", async () => {
  // Before `SUBJECT`, this request reached the handler and returned the roster
  // (character ids, ship types and current solar systems) for a fleet the caller
  // has nothing to do with.
  //
  // The refusal CCP sends is unobserved, so the predicate throws and
  // `gateOrFail` answers the observed 500. The read does not happen, which is
  // the property that matters, and the status is loudly wrong rather than
  // quietly invented. `CROSS_ENTITY_REFUSAL` is a 403 whose wording is about a
  // corporation and says itself it cannot be reused for a fleet; a 404 hiding
  // the fleet's existence is the other guess.
  let handlerRuns = 0;
  const logged = [];
  const runtime = runtimeDouble({ fleet: null });
  const scaffold = membersScaffold({ runtime });
  const router = createRouter([{
    ...scaffold,
    handler: (params) => { handlerRuns += 1; return scaffold.handler(params); },
  }]);

  const result = await dispatchRequest(
    router,
    authenticated(FLEET_MEMBERS_PATH),
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, 500, "refused; the status is unobserved and deliberately not invented");
  assert.equal(handlerRuns, 0, "the roster was not read, which is the property that matters");
  assert.equal(logged.length, 1);
  assert.match(logged[0][1], /not a member of/);
  assert.match(logged[0][1], /CROSS_ENTITY_REFUSAL/, "and names why no refusal was invented");

  // The reason reaches the game server's log, never the client.
  assert.doesNotMatch(JSON.stringify(result.body), /fleet/i);
});

test("a member of the fleet is let through by the same predicate", () => {
  // Asserted on the predicate directly: `null` is "allow", and the only value
  // this function ever returns.
  const fleet = fleetRecord([memberRecord({ charID: CHARACTER_ID, job: fleets.FLEET_JOB_CREATOR })]);
  const runtime = runtimeDouble({ fleet });

  assert.equal(
    fleets.fleetMembersSubject({ characterId: CHARACTER_ID }, { fleet_id: String(FLEET_ID) }, { runtime }),
    null,
  );

  // Gated on membership rather than on being the boss. CCP's spec declares
  // neither, and the boss-only claim is a third party's rather than an
  // observation. This is the narrower of "any token holder" and "any member",
  // and `fleetMembersSubject` is the single place to narrow further if an
  // observation says so.
  const memberFleet = fleetRecord([
    memberRecord({ charID: CHARACTER_ID, role: 4 }),
    memberRecord({ charID: OTHER_CHARACTER_ID, role: 1, job: fleets.FLEET_JOB_CREATOR }),
  ]);
  assert.equal(
    fleets.fleetMembersSubject(
      { characterId: CHARACTER_ID },
      { fleet_id: String(FLEET_ID) },
      { runtime: runtimeDouble({ fleet: memberFleet }) },
    ),
    null,
    "a non-boss member is allowed today; see the note above",
  );
});

test("a fleet_id spelled six other ways does not authorise a read of that fleet", async () => {
  // `Number()` alone accepts every one of these as the same id, so a gate that
  // leaned on it would say "this is fleet N" and hand the handler a string a
  // `parseInt` reads as something else: a cross-entity read manufactured inside
  // the authorised path. `lib/router.js` makes the same argument about
  // `character_id`.
  const fleet = fleetRecord([memberRecord({ charID: CHARACTER_ID, job: fleets.FLEET_JOB_CREATOR })]);
  let handlerRuns = 0;
  const scaffold = membersScaffold({ runtime: runtimeDouble({ fleet }) });
  const router = createRouter([{
    ...scaffold,
    handler: (params) => { handlerRuns += 1; return scaffold.handler(params); },
  }]);

  const spellings = ["1.002e7", "0x98F340", "%2010020000%20", "010020000", "+10020000", "10020000%0A"];
  for (const spelling of spellings) {
    const result = await dispatchRequest(
      router,
      authenticated(`/latest/fleets/${spelling}/members/`),
      { logError: () => {} },
    );
    assert.equal(result.status, 500, `${spelling} was not refused`);
  }

  assert.equal(handlerRuns, 0, "none of them reached the roster");

  // The canonical spelling gets through the same gate, so the test above is not
  // passing by refusing everything.
  const ok = await dispatchRequest(router, authenticated(FLEET_MEMBERS_PATH), { logError: () => {} });
  assert.notEqual(ok.status, 200, "blocked further on, by role_name (see below)");
  assert.equal(handlerRuns, 1, "but it did reach the handler");
});

test("entityId refuses everything Number() would have accepted", () => {
  assert.equal(fleets.entityId(String(FLEET_ID)), FLEET_ID);
  assert.equal(fleets.entityId("1"), 1);

  for (const value of ["0", "01", "1.2e7", "0x1e0f3", "+123", " 123 ", "123\n", "", "-1", null, undefined, "abc"]) {
    assert.equal(fleets.entityId(value), null, `${JSON.stringify(value)} is not a canonical id`);
  }
});

// The two blockers, asserted so nobody quietly removes them

test("/fleets/{id}/members/ is registrable, and its subject gate is what guards it", () => {
  // It was withheld from the route table on the grounds that its producer was
  // unobserved; that was wrong (see the test above).
  //
  // What is still unobserved is real and lives inside the route: the field order
  // of the roster body, `role_name`, and what a non-member is told. None of that
  // justifies an unrouted 404 for an implemented endpoint, and the last item is
  // handled by a gate that refuses.
  const descriptor = fleets.createFleetMembersRoute({});

  assert.equal(descriptor.method, "GET");
  assert.equal(descriptor.path, fleets.FLEET_MEMBERS_PATH);
  assert.equal(descriptor.producer, "app");
  assert.equal(descriptor.scope, fleets.SCOPE);
  assert.equal(typeof descriptor.subject, "function", "keyed by a fleet id, so the scope cannot be the whole gate");
});

test("role_name is required, localized, and has no source, so it throws", () => {
  // The second blocker, behind the first. eve.js stores no display name for a
  // role in any form, `OMIT` is legal only on an optional field, and the four
  // English strings CCP sends are unobserved. There is nothing to read and
  // nothing to leave out.
  assert.ok(MEMBER_ITEM().required.includes("role_name"));
  assert.match(MEMBER_ITEM().properties.role_name.description, /Localized/);

  for (const role of Object.keys(fleets.ROLE_BY_FLEET_ROLE)) {
    assert.throws(
      () => fleets.roleNameFor(Number(role)),
      (err) => err instanceof fleets.UnobservedWireFactError
        && /Accept-Language/.test(err.message),
    );
  }

  // This is why `/fleets/{id}/members/` declares `Content-Language` on its 200
  // while `/characters/{id}/fleet/` does not: CCP says which of the two carries
  // translated text.
  const headers = MEMBERS().spec.paths["/fleets/{fleet_id}/members"].get.responses["200"].headers;
  assert.ok(Object.keys(headers).some((name) => name.toLowerCase() === "content-language"));
  const fleetHeaders = FLEET().spec.paths["/characters/{character_id}/fleet"].get.responses["200"].headers;
  assert.ok(!Object.keys(fleetHeaders).some((name) => name.toLowerCase() === "content-language"));
});

test("everything behind the two blockers is finished, and the projection proves it", () => {
  // The roster projection, fed the record a working `roleNameFor` would have
  // completed: ten fields in the derived order, and a body the spec accepts.
  // `"unobserved"` stands in for the string nobody has captured. It is a
  // test placeholder, never a value this replica sends, because `roleNameFor`
  // throws first.
  const row = fleets.projectFleetMember({
    characterId: CHARACTER_ID,
    joinTime: "2026-08-25T09:00:00Z",
    role: "squad_member",
    roleName: "unobserved",
    shipTypeId: 670,
    solarSystemId: 30000142,
    squadId: SQUAD_ID,
    stationId: 60003760,
    takesFleetWarp: true,
    wingId: WING_ID,
  });

  assert.deepEqual(Object.keys(row), [
    "character_id",
    "join_time",
    "role",
    "role_name",
    "ship_type_id",
    "solar_system_id",
    "squad_id",
    "station_id",
    "takes_fleet_warp",
    "wing_id",
  ]);
  assertBody([row], MEMBERS());

  // `station_id` is the only field on either operation that may be omitted; a
  // pilot in space omits it rather than sending null or 0.
  const inSpace = fleets.projectFleetMember({
    characterId: CHARACTER_ID,
    joinTime: "2026-08-25T09:00:00Z",
    role: "fleet_commander",
    roleName: "unobserved",
    shipTypeId: 670,
    solarSystemId: 30000142,
    squadId: -1,
    stationId: "",
    takesFleetWarp: false,
    wingId: -1,
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(inSpace, "station_id"), "omitted, not 0");
  assertBody([inSpace], MEMBERS());
});

test("a member in abyssal space is a 500 before role_name is even reached", async () => {
  // eve.js scrubs `solarSystemID` to `null` for a pilot in abyssal space, on
  // both ingest and emit. `solar_system_id` is required and the pinned surface
  // has no nullable field, so the answer is the same as for the characters
  // `/location/` route: a logged 500 rather than a body claiming system 0.
  //
  // It is reached before the `role_name` blocker, which is what lets this path
  // be tested today.
  const logged = [];
  const fleet = fleetRecord([memberRecord({ charID: CHARACTER_ID, job: fleets.FLEET_JOB_CREATOR })]);
  const runtime = runtimeDouble({
    fleet,
    records: { [CHARACTER_ID]: { solarSystemID: null, stationID: null, shipTypeID: 670 } },
  });
  const router = createRouter([membersScaffold({ runtime })]);

  const result = await dispatchRequest(
    router,
    authenticated(FLEET_MEMBERS_PATH),
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, 500);
  assert.match(logged[0][1], /abyssal space/);
});

test("member positions come from the live character record, not the join-time snapshot", async () => {
  // Deliberate divergence from the member record. Its location fields are a
  // snapshot taken at join time that nothing refreshes when a pilot jumps a
  // gate, and placing fleet-mates where they joined is the failure the one
  // consumer of this endpoint would show on a map. So the roster comes from the
  // member record and the position from `peekCharacterRecord`.
  //
  // Asserted by starving the handler of the character accessor while the member
  // record is complete: if the snapshot were read, this would succeed.
  const logged = [];
  const fleet = fleetRecord([memberRecord({ charID: CHARACTER_ID, job: fleets.FLEET_JOB_CREATOR })]);
  fleet.members.get(CHARACTER_ID).solarSystemID = 30000142;
  fleet.members.get(CHARACTER_ID).shipTypeID = 670;

  const router = createRouter([membersScaffold({
    runtime: runtimeDouble({ fleet, omitCharacterAccessor: true }),
  })]);

  const result = await dispatchRequest(
    router,
    authenticated(FLEET_MEMBERS_PATH),
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, 500);
  assert.match(logged[0][1], /peekCharacterRecord/);
  assert.match(logged[0][1], /rather than from the member snapshot/);
});

test("join_time is a FILETIME converted to second precision", async () => {
  // Reused from `routes/characters.js` rather than rewritten: `member.timestamp`
  // comes from the same `currentFileTime()` family as `logoffDate`, and two
  // copies of "CCP sends second precision, not milliseconds" are two places for
  // the `.000Z` to come back.
  const { esiTimestampFromFiletime } = require(path.join(__dirname, "..", "routes", "characters.js"));

  assert.equal(esiTimestampFromFiletime(filetime("2026-08-25T09:00:00Z")), "2026-08-25T09:00:00Z");

  // An unreadable one is a 500 rather than a body carrying 1601, because
  // `join_time` is required.
  const logged = [];
  const fleet = fleetRecord([memberRecord({ charID: CHARACTER_ID, job: fleets.FLEET_JOB_CREATOR })]);
  fleet.members.get(CHARACTER_ID).timestamp = "not-a-filetime";

  const router = createRouter([membersScaffold({
    runtime: runtimeDouble({
      fleet,
      records: { [CHARACTER_ID]: { solarSystemID: 30000142, stationID: null, shipTypeID: 670 } },
    }),
  })]);

  const result = await dispatchRequest(
    router,
    authenticated(FLEET_MEMBERS_PATH),
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, 500);
  assert.match(logged[0][1], /join_time is required/);
});

test("takes_fleet_warp follows eve.js's opt-out normalisation, not a truthiness test", () => {
  // eve.js's own `buildMemberOptOuts` is `overrides.acceptsFleetWarp !== false`:
  // the field defaults to accepting, and only an explicit `false` opts out. A
  // truthiness test would publish an absent opt-out record as opted out, the
  // opposite of what the game means.
  const fleet = fleetRecord([memberRecord({ charID: CHARACTER_ID, acceptsFleetWarp: false })]);
  assert.equal(fleet.members.get(CHARACTER_ID).memberOptOuts.acceptsFleetWarp, false);

  const optedIn = fleetRecord([memberRecord({ charID: CHARACTER_ID })]);
  assert.equal(optedIn.members.get(CHARACTER_ID).memberOptOuts.acceptsFleetWarp, true);
});
