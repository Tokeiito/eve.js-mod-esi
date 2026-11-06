/**
 * `GET /characters/{character_id}/online|location|ship/`: the contract.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * These are the first authenticated endpoints on this replica, and the first
 * suite whose subject is a body CCP only sends to a token holder. There is no
 * golden recording to diff against, because a recording of these bodies would be
 * a real pilot's location committed to this repository. `contract/golden/`'s own
 * note says "public, unauthenticated endpoints only", and the three operations
 * are carried in that file's `exempt` map instead.
 *
 * The observed bytes live in `contract/wire.js` `CHARACTER_LOCATION`, and every
 * claim this suite makes about them is read from there rather than retyped. A
 * literal copied into a test can drift from the capture it came from, and then
 * the test agrees with itself forever.
 *
 * How the two sources divide (D22). The spec is authoritative for the bodies and
 * for the numbers a client polls on: which keys exist, which are required, that
 * `online` is a boolean and `solar_system_id` an integer, the three scopes, the
 * `char-location` bucket, and the cache ages (60 s for `/online/` and 5 s for
 * the other two). The wire is authoritative for what the spec has no vocabulary
 * for, which is most of what makes these endpoints distinctive: which
 * implementation answers them, the alphabetical field order, and the rule that an
 * absent optional field is omitted rather than sent as `null`.
 *
 * `contract/spec.js` has carried `assertRouteMatchesSpec` since the router
 * landed, but it had only been called on route literals typed into
 * `test/router.test.js`, which proves the function works and nothing about any
 * route this server serves. Below it is called on the three descriptors
 * `routes/characters.js` actually hands `loader.js`. That makes a wrong TTL or a
 * wrong scope on an authenticated route a test failure rather than an
 * authentication bug.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const spec = require(path.join(__dirname, "../contract/spec"));
const { SpecContractError, assertBody, describeOperation } = spec;
const wire = require(path.join(__dirname, "../contract/wire"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));

const CHARACTERS_ROUTE = path.join(__dirname, "..", "routes", "characters.js");

/**
 * The subject of every token below.
 *
 * CCP's own `CharacterID` example from the pinned spec, deliberately, and not
 * the pilot the capture was taken with: these tests need a character id, and
 * `contract/` holds nobody's character data (D23). The observation is cited by
 * its protocol facts in `contract/wire.js` `CHARACTER_LOCATION`, which is what
 * the assertions below read.
 */
const CHARACTER_ID = 90000001;

/** The wire paths, not the spec paths. `/v1/.../online/` is the same operation. */
const ONLINE_PATH = `/latest/characters/${CHARACTER_ID}/online/`;
const LOCATION_PATH = `/latest/characters/${CHARACTER_ID}/location/`;
const SHIP_PATH = `/latest/characters/${CHARACTER_ID}/ship/`;

const ONLINE = () => describeOperation("get", ONLINE_PATH);
const LOCATION = () => describeOperation("get", LOCATION_PATH);
const SHIP = () => describeOperation("get", SHIP_PATH);

// What the spec says

test("/online/ requires one field of four, and three of them are optional", () => {
  const contract = ONLINE();

  assert.deepEqual(contract.requiredKeys, ["online"]);
  assert.deepEqual(contract.optionalKeys.sort(), ["last_login", "last_logout", "logins"]);
  assert.equal(contract.schema.properties.online.type, "boolean");
  assert.equal(contract.schema.properties.logins.type, "integer");
  assert.equal(contract.schema.properties.last_login.format, "date-time");
  assert.equal(contract.schema.properties.last_logout.format, "date-time");
});

test("/location/ requires the system and nothing else", () => {
  const contract = LOCATION();

  assert.deepEqual(contract.requiredKeys, ["solar_system_id"]);
  assert.deepEqual(contract.optionalKeys.sort(), ["station_id", "structure_id"]);
  for (const field of ["solar_system_id", "station_id", "structure_id"]) {
    assert.equal(contract.schema.properties[field].type, "integer", `${field} is an integer`);
  }
});

test("/ship/ requires all three of its fields", () => {
  const contract = SHIP();

  // The strictest of the three, and the reason `routes/characters.js` has a
  // refusal on this route where `/online/` has an omission: there is no field here
  // it is allowed to leave out.
  assert.deepEqual(contract.requiredKeys.sort(), ["ship_item_id", "ship_name", "ship_type_id"]);
  assert.deepEqual(contract.optionalKeys, []);
  assert.equal(contract.schema.properties.ship_item_id.type, "integer");
  assert.equal(contract.schema.properties.ship_name.type, "string");
  assert.equal(contract.schema.properties.ship_type_id.type, "integer");
});

test("the three scopes, one per operation", () => {
  // A wrong scope on an authenticated route is a route nobody can reach with the
  // token they were told to ask for.
  assert.deepEqual(ONLINE().scopes, ["esi-location.read_online.v1"]);
  assert.deepEqual(LOCATION().scopes, ["esi-location.read_location.v1"]);
  assert.deepEqual(SHIP().scopes, ["esi-location.read_ship_type.v1"]);
});

test("the numbers clients poll on, and the one the issue got wrong", () => {
  // A 5 s TTL on all three would be wrong. CCP publishes 60 for `/online/`, so
  // 5 would have a client polling twelve times more often than it needs to
  // against the game's own event loop. `x-cache-age` is also what `Expires` is
  // computed from, so the two would disagree with each other as well.
  assert.equal(ONLINE().cacheAgeSeconds, 60, "not the 5 the issue asks for");
  assert.equal(LOCATION().cacheAgeSeconds, 5);
  assert.equal(SHIP().cacheAgeSeconds, 5);

  // One bucket for all three, which is why `routes/characters.js` has one
  // `RATE_LIMIT_GROUP` constant rather than three.
  for (const contract of [ONLINE(), LOCATION(), SHIP()]) {
    assert.deepEqual(contract.rateLimit, {
      group: "char-location",
      maxTokens: 1200,
      windowSize: "15m",
    });
    assert.deepEqual(contract.statuses, [200], "the spec declares no error status");
  }
});

test("the version prefix does not change the operation", () => {
  for (const prefix of ["/latest", "/v1", "/v2"]) {
    assert.equal(
      describeOperation("get", `${prefix}/characters/${CHARACTER_ID}/online/`).operationId,
      "GetCharactersCharacterIdOnline",
    );
  }
});

// What the wire says

test("all three are the application, so no body ends with a newline", () => {
  // Captured rather than derived: the parent route `GET /characters/{id}` is the
  // gateway, so the sibling path is evidence of nothing, and a route that
  // inherited from it would be off by one in content-length on every response.
  for (const specPath of [
    "/characters/:character_id/online",
    "/characters/:character_id/location",
    "/characters/:character_id/ship",
  ]) {
    assert.equal(wire.SUCCESS_KIND[specPath], wire.KIND.APP_SUCCESS);
  }

  assert.equal(wire.SUCCESS_KIND["/characters/:character_id"], wire.KIND.GATEWAY_SUCCESS);
  assert.equal(wire.CONTENT_TYPE[wire.KIND.APP_SUCCESS], "application/json; charset=UTF-8");
  assert.equal(wire.TRAILING_NEWLINE[wire.KIND.APP_SUCCESS], false);
});

test("field order is alphabetical, and order is bytes", () => {
  // A projection declares its fields in an order rather than as a set because a
  // body that carries the right fields in the wrong order is different bytes, a
  // different Etag, and a different response.
  const order = wire.CHARACTER_LOCATION.fieldOrder;

  for (const [operation, fields] of Object.entries(order)) {
    assert.deepEqual([...fields].sort(), [...fields], `${operation} is not alphabetical`);
  }

  // The spec's declaration order is not the source of it: `/ship/` is where the
  // two part company, which is what makes this an observation.
  assert.deepEqual(Object.keys(SHIP().schema.properties), [
    "ship_item_id",
    "ship_name",
    "ship_type_id",
  ]);
  assert.deepEqual(SHIP().requiredKeys, ["ship_type_id", "ship_item_id", "ship_name"]);
});

test("an absent optional field is omitted, never null and never zero", () => {
  // The captured pilot was docked in a station, so `structure_id` was absent from
  // the body entirely. Sending `null` would be wrong: three sources say otherwise,
  // and the third is `contract/spec.js` itself (see the next section).
  assert.equal(wire.CHARACTER_LOCATION.omitsAbsentOptionalFields, true);

  // The omitted field really is one the spec allows to be left out. The rule is
  // only available on an optional field, which is why `/ship/` gets a refusal
  // below where `/location/` gets an omission.
  assert.ok(LOCATION().optionalKeys.includes("structure_id"));
});

test("the wire and the spec agree about the TTLs and the bucket", () => {
  // Two independent sources, `x-cache-age` in CCP's document and the `Expires`
  // offsets in the capture, and they agree. If they ever disagree, the route table
  // has to pick one on purpose.
  assert.deepEqual(wire.CHARACTER_LOCATION.cacheTtlSeconds, {
    online: ONLINE().cacheAgeSeconds,
    location: LOCATION().cacheAgeSeconds,
    ship: SHIP().cacheAgeSeconds,
  });
  assert.equal(wire.CHARACTER_LOCATION.rateLimitGroup, ONLINE().rateLimit.group);
});

test("an authenticated route sends private where the same producer sends public", () => {
  // Not a fact about the body, and not something this module decides, but it is
  // what makes these routes different from every route before them, and
  // `lib/router.js` carries `authenticated` off the route's `scope` to reach it.
  // `public` on a response carrying one pilot's location is an invitation to a
  // shared cache to hand it to the next pilot.
  assert.equal(wire.AUTHENTICATED_CACHE_CONTROL, "private");
  assert.equal(wire.CACHE_CONTROL[wire.KIND.APP_SUCCESS](5), "public");
});

test("two fields have no source in eve.js, and that is written down", () => {
  // The knowing divergence: this replica answers `/online/` with two of the four
  // fields CCP answers with. Both are optional, so the body stays valid, but a
  // consumer reading `logins` gets nothing, and it should find out here rather
  // than in production.
  assert.deepEqual(wire.CHARACTER_LOCATION.unavailableFromGame, ["last_login", "logins"]);

  for (const field of wire.CHARACTER_LOCATION.unavailableFromGame) {
    assert.ok(
      ONLINE().optionalKeys.includes(field),
      `${field} would have to be invented if the spec required it`,
    );
  }
});

// What a plausible-but-wrong body does

test("a null structure_id is a contract failure", () => {
  // `structure_id` must not serialize as null, 0, or omitted-when-present. The
  // pinned document declares no nullable field anywhere, so the validator has a
  // message of its own for this.
  assert.throws(
    () => assertBody({ solar_system_id: 30002634, station_id: 60014740, structure_id: null }, LOCATION()),
    (err) => err instanceof SpecContractError
      && /body\.structure_id is null, and the .* spec declares no nullable fields/.test(err.message),
  );
});

test("a solar_system_id that arrives as a string is rejected", () => {
  // The shape of the mistake: `params.path.character_id` is a string, and a
  // handler that read ids off the path rather than out of the record produces
  // exactly this.
  assert.throws(
    () => assertBody({ solar_system_id: "30002634" }, LOCATION()),
    (err) => /body\.solar_system_id: expected integer, got string/.test(err.message),
  );
});

test("a last_logout that went through toISOString is rejected", () => {
  // `new Date(ms).toISOString()` is `...T12:28:43.000Z`, which is what a straight
  // FILETIME conversion produces if nobody trims it, and no ESI response has ever
  // carried fractional seconds.
  assert.throws(
    () => assertBody(
      { last_logout: new Date("2026-08-16T12:28:43Z").toISOString(), online: false },
      ONLINE(),
    ),
    (err) => /is not an ESI timestamp/.test(err.message),
  );
});

test("an online flag that arrives as a string is rejected", () => {
  // A truthiness test hands you this failure: `"false"` is truthy, and a snapshot
  // that came back with a string would otherwise publish a logged-out pilot as
  // flying.
  assert.throws(
    () => assertBody({ online: "false" }, ONLINE()),
    (err) => /body\.online: expected boolean, got string/.test(err.message),
  );
});

test("a ship body missing ship_name is rejected", () => {
  // The plausible first implementation: two ids the record obviously has, and a
  // name nobody thought about. All three are required.
  assert.throws(
    () => assertBody({ ship_item_id: 1051678121885, ship_type_id: 89240 }, SHIP()),
    (err) => /body\.ship_name is required by the spec and is missing/.test(err.message),
  );
});

test("helpfully adding the character's own id is rejected", () => {
  // eve.js knows which character this is (the token said so), and passing it
  // along reads as a courtesy. A field CCP does not send is exactly as visible to
  // a client as one it does.
  assert.throws(
    () => assertBody(
      { solar_system_id: 30002634, station_id: 60014740, character_id: CHARACTER_ID },
      LOCATION(),
    ),
    (err) => /body\.character_id is not in the spec/.test(err.message),
  );
});

// The handlers.
//
// Called through the router, which is how `loader.js` calls them and the only
// way that answers all nine version prefixes. On these routes it is also the
// only way that runs `authorise()`: a handler called directly would be tested
// with the gate switched off.

/** The endpoint as it actually runs: a one-route table and the real router. */
function characterRouter(factoryName, deps) {
  const factory = require(CHARACTERS_ROUTE)[factoryName];
  return createRouter([factory(deps)]);
}

/**
 * A `lib/runtimeAccess.js` double.
 *
 * The contract is a property of the response shape, not of a running game, so
 * nothing here boots one. `record` is the shape `peekCharacterRecord` projects
 * from (the game's own field names, `solarSystemID` and friends), and `null` is
 * the character the game does not know.
 */
function runtimeDouble({ record = null, online = false, omitOnlineAccessor = false } = {}) {
  const runtime = {
    peekCharacterRecord: (characterId, options = {}) => {
      if (record === null || characterId !== CHARACTER_ID) return null;
      const project = options.project;
      return project ? project(record, characterId) : { ...record };
    },
  };

  // The accessor `routes/characters.js` duck-types. Left off deliberately in one
  // test below.
  if (!omitOnlineAccessor) {
    runtime.getCharacterOnlineSnapshot = (characterId) =>
      (characterId === CHARACTER_ID ? { online } : null);
  }

  return runtime;
}

/**
 * A request carrying a verified credential for `CHARACTER_ID`.
 *
 * The shape `lib/bearerCredential.js` builds and `lib/router.js` reads:
 * `presented` is about the header, `claims` is the projection
 * `lib/bearerToken.js` made of a token that verified. Nothing here signs
 * anything: the gate's inputs are the credential and the route, and both are
 * present.
 */
function authenticated(pathname, { scopes, characterId = CHARACTER_ID } = {}) {
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

/** The record the 2026-08-25 capture's pilot would have had on this server. */
const DOCKED_RECORD = Object.freeze({
  solarSystemID: 30002634,
  stationID: 60014740,
  structureID: null,
  shipID: 1051678121885,
  shipName: "Sunset",
  shipTypeID: 89240,
  // 2026-08-16T12:28:43Z as a Windows FILETIME decimal string, which is how eve.js
  // stores it. Computed rather than typed, so the test cannot be satisfied by a
  // conversion that is wrong in the same direction twice.
  logoffDate: String(BigInt(Date.parse("2026-08-16T12:28:43Z")) * 10000n + 116444736000000000n),
});

test("the three route descriptors agree with the pinned spec", () => {
  // `assertRouteMatchesSpec` on a real route, rather than on literals typed into
  // test/router.test.js.
  const routes = require(CHARACTERS_ROUTE);

  for (const factoryName of [
    "createCharacterOnlineRoute",
    "createCharacterLocationRoute",
    "createCharacterShipRoute",
  ]) {
    // `factory({})`: deps are read inside the handler, never at construction, which
    // is also what test/serialize.test.js relies on when it walks `routes/` from
    // disk.
    const route = routes[factoryName]({});
    const contract = spec.assertRouteMatchesSpec(route);

    assert.equal(route.name, contract.operationId, "the route's name is the spec's operationId");
    assert.equal(route.producer, "app", "observed: charset=UTF-8, no trailing newline");
    assert.equal(route.rateLimitGroup, wire.CHARACTER_LOCATION.rateLimitGroup);
  }
});

test("the path parameter is spelled the way the cross-character gate reads it", () => {
  // Load-bearing, and silently so: `lib/router.js` `authorise()` compares the
  // token's subject against the path parameter named `character_id`. Any other
  // spelling leaves it with nothing to compare and disables the gate on a route
  // that otherwise looks like it works.
  const routes = require(CHARACTERS_ROUTE);

  for (const factoryName of [
    "createCharacterOnlineRoute",
    "createCharacterLocationRoute",
    "createCharacterShipRoute",
  ]) {
    const { path: routePath } = routes[factoryName]({});
    assert.match(routePath, /^\/characters\/:character_id\//);
    assert.ok(routePath.includes(`:${routes.CHARACTER_ID_PARAM}`));
  }
});

test("routes/characters.js satisfies the /online/ contract", async () => {
  const router = characterRouter("createCharacterOnlineRoute", {
    runtime: runtimeDouble({ record: DOCKED_RECORD, online: true }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(ONLINE_PATH, { scopes: ["esi-location.read_online.v1"] }),
  );

  assert.equal(result.status, ONLINE().successStatus);
  assertBody(result.body, ONLINE());

  // Field order, not just field presence: order is bytes.
  assert.deepEqual(Object.keys(result.body), ["last_logout", "online"]);
  assert.equal(result.body.online, true);
  assert.equal(result.body.last_logout, "2026-08-16T12:28:43Z", "the FILETIME, converted");
});

test("/online/ omits the two fields eve.js has no source for", async () => {
  const router = characterRouter("createCharacterOnlineRoute", {
    runtime: runtimeDouble({ record: DOCKED_RECORD, online: false }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(ONLINE_PATH, { scopes: ["esi-location.read_online.v1"] }),
  );

  for (const field of wire.CHARACTER_LOCATION.unavailableFromGame) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(result.body, field),
      `${field} was invented; contract/wire.js says there is no source for it`,
    );
  }

  // Omitted, not null, not zero: the same rule the wire records for
  // `structure_id`, applied to the fields this replica is the one omitting.
  assertBody(result.body, ONLINE());
});

test("routes/characters.js satisfies the /location/ contract, and omits structure_id", async () => {
  const router = characterRouter("createCharacterLocationRoute", {
    runtime: runtimeDouble({ record: DOCKED_RECORD }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(LOCATION_PATH, { scopes: ["esi-location.read_location.v1"] }),
  );

  assert.equal(result.status, 200);
  assertBody(result.body, LOCATION());

  // The captured body's field set and order, for a pilot docked in a station.
  assert.deepEqual(Object.keys(result.body), ["solar_system_id", "station_id"]);
  assert.deepEqual(result.body, { solar_system_id: 30002634, station_id: 60014740 });
});

test("a pilot docked in a structure omits station_id instead", async () => {
  // The other side of the mutually exclusive pair, which the capture could not
  // show because the pilot was in a station.
  const router = characterRouter("createCharacterLocationRoute", {
    runtime: runtimeDouble({
      record: { ...DOCKED_RECORD, stationID: null, structureID: 1035466617946 },
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(LOCATION_PATH, { scopes: ["esi-location.read_location.v1"] }),
  );

  assert.deepEqual(Object.keys(result.body), ["solar_system_id", "structure_id"]);
  assertBody(result.body, LOCATION());
});

test("a pilot in space carries the system and nothing else", async () => {
  const router = characterRouter("createCharacterLocationRoute", {
    runtime: runtimeDouble({ record: { ...DOCKED_RECORD, stationID: "", structureID: null } }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(LOCATION_PATH, { scopes: ["esi-location.read_location.v1"] }),
  );

  // `""` is what the record holds for an id that is not set, and `Number("")` is
  // `0`: a claim that the character is docked at station 0.
  assert.deepEqual(result.body, { solar_system_id: 30002634 });
  assertBody(result.body, LOCATION());
});

test("routes/characters.js satisfies the /ship/ contract", async () => {
  const router = characterRouter("createCharacterShipRoute", {
    runtime: runtimeDouble({ record: DOCKED_RECORD }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(SHIP_PATH, { scopes: ["esi-location.read_ship_type.v1"] }),
  );

  assert.equal(result.status, 200);
  assertBody(result.body, SHIP());

  // Alphabetical, which is not the spec's declaration order for this one.
  assert.deepEqual(Object.keys(result.body), wire.CHARACTER_LOCATION.fieldOrder.ship);
  assert.deepEqual(result.body, {
    ship_item_id: 1051678121885,
    ship_name: "Sunset",
    ship_type_id: 89240,
  });
});

test("every version prefix reaches the handler, and reports the application", async () => {
  const router = characterRouter("createCharacterShipRoute", {
    runtime: runtimeDouble({ record: DOCKED_RECORD }),
  });

  for (const prefix of wire.VERSION_PREFIXES) {
    const result = await dispatchRequest(
      router,
      authenticated(`/${prefix}/characters/${CHARACTER_ID}/ship/`, {
        scopes: ["esi-location.read_ship_type.v1"],
      }),
    );
    assert.equal(result.status, 200, `/${prefix}/…/ship/ did not reach the handler`);
    assert.equal(result.producer, "app");
    assert.equal(result.authenticated, true, "the route declares a scope");
  }
});

// The gate, which these handlers do not implement

test("the gate refuses before the handler runs, and the handler never sees it", async () => {
  // Not this module's code, but it is this module's contract: the three refusals
  // `lib/router.js` makes are why the handlers below can assume
  // `params.credential` is a verified token for the character in the path.
  let handlerRuns = 0;
  const routes = require(CHARACTERS_ROUTE);
  const route = routes.createCharacterLocationRoute({
    runtime: runtimeDouble({ record: DOCKED_RECORD }),
  });
  const router = createRouter([{
    ...route,
    handler: (params) => { handlerRuns += 1; return route.handler(params); },
  }]);

  const noToken = await dispatchRequest(router, { method: "GET", pathname: LOCATION_PATH, query: {} });
  assert.equal(noToken.status, 401, "no credential");

  const wrongScope = await dispatchRequest(
    router,
    authenticated(LOCATION_PATH, { scopes: ["esi-location.read_online.v1"] }),
  );
  assert.equal(wrongScope.status, 401, "a verified token without this route's scope");
  assert.match(JSON.stringify(wrongScope.body), /esi-location\.read_location\.v1/);

  const otherCharacter = await dispatchRequest(
    router,
    authenticated(LOCATION_PATH, {
      scopes: ["esi-location.read_location.v1"],
      characterId: CHARACTER_ID + 1,
    }),
  );
  assert.equal(otherCharacter.status, 403, "a token for somebody else");

  assert.equal(handlerRuns, 0, "the handler must not observe a request it was not allowed to see");
});

// A character the game cannot produce

test("/online/ still answers for a character with no record", async () => {
  // The one route here whose required field does not come from the record. A
  // character the game has no record of is certainly not connected, so `false`
  // with `last_logout` omitted is a complete and honest body, and a 500 here would
  // take down the endpoint a client polls to decide whether to poll the other
  // two.
  const router = characterRouter("createCharacterOnlineRoute", {
    runtime: runtimeDouble({ record: null, online: false }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(ONLINE_PATH, { scopes: ["esi-location.read_online.v1"] }),
  );

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { online: false });
  assertBody(result.body, ONLINE());
});

test("/online/ answers before its accessor exists, rather than failing", async () => {
  // `getCharacterOnlineSnapshot` is `lib/runtimeAccess.js`'s and this route
  // duck-types it, the same concession `routes/status.js` `readPlayers` makes for
  // a game that is not up.
  const router = characterRouter("createCharacterOnlineRoute", {
    runtime: runtimeDouble({ record: DOCKED_RECORD, omitOnlineAccessor: true }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(ONLINE_PATH, { scopes: ["esi-location.read_online.v1"] }),
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.online, false);
  assertBody(result.body, ONLINE());
});

test("a missing record on /location/ is a logged 500, not an invented system", async () => {
  // `solar_system_id` is required and there is no honest substitute: the spec has
  // no nullable field to reach for and `0` is a system a client would act on. It
  // is not a 404 either: the token proves this server minted a credential for that
  // character, so the record was readable then and is not now.
  const logged = [];
  const router = characterRouter("createCharacterLocationRoute", {
    runtime: runtimeDouble({ record: null }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(LOCATION_PATH, { scopes: ["esi-location.read_location.v1"] }),
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, 500);
  assert.equal(logged.length, 1, "the reason goes to the game server log");
  assert.match(logged[0][1], new RegExp(String(CHARACTER_ID)), "and names the character");
  assert.doesNotMatch(
    JSON.stringify(result.body),
    new RegExp(String(CHARACTER_ID)),
    "and not to the client",
  );
});

test("a record that cannot supply a required ship field is a logged 500", async () => {
  // The strictest route: no omission is available, so an unreadable field is a
  // refusal naming it in the log rather than a body missing a required key or
  // carrying a synthesised one.
  const logged = [];
  const router = characterRouter("createCharacterShipRoute", {
    runtime: runtimeDouble({ record: { ...DOCKED_RECORD, shipName: undefined } }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(SHIP_PATH, { scopes: ["esi-location.read_ship_type.v1"] }),
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, 500);
  assert.match(logged[0][1], /shipName/);
});

test("a runtime with no character accessor at all is a 500 on the two that need it", async () => {
  // "The game does not have this character" and "this build cannot read
  // characters at all" are different failures, and answering the second as the
  // first would report every pilot as missing.
  for (const [factoryName, wirePath, scope] of [
    ["createCharacterLocationRoute", LOCATION_PATH, "esi-location.read_location.v1"],
    ["createCharacterShipRoute", SHIP_PATH, "esi-location.read_ship_type.v1"],
  ]) {
    const router = characterRouter(factoryName, { runtime: {} });
    const result = await dispatchRequest(
      router,
      authenticated(wirePath, { scopes: [scope] }),
      { logError: () => {} },
    );
    assert.equal(result.status, 500, `${factoryName} answered without a runtime`);
  }
});

// FILETIME

test("last_logout is a FILETIME converted to second precision", () => {
  const { esiTimestampFromFiletime, filetimeToEpochMs } = require(CHARACTERS_ROUTE);

  // The observed value, round-tripped: the capture's `last_logout` was
  // 2026-08-16T12:28:43Z.
  const ms = Date.parse("2026-08-16T12:28:43Z");
  const filetime = String(BigInt(ms) * 10000n + 116444736000000000n);

  assert.equal(filetimeToEpochMs(filetime), ms);
  assert.equal(esiTimestampFromFiletime(filetime), "2026-08-16T12:28:43Z");
});

test("a FILETIME is past the range Number counts exactly, which is why this is BigInt", () => {
  // 1.34e17 against a safe-integer ceiling of 9.0e15 is fifteen times over, so
  // integer arithmetic on it in a `Number` is no longer exact and adjacent
  // FILETIMEs collapse onto the same double.
  //
  // Stated no more strongly than that. At this magnitude the collapse is a few
  // hundred nanoseconds, which would survive a division to second precision, so
  // the claim is not that Number gets the wrong answer today but that the answer
  // would be right by an accident of magnitude rather than by the arithmetic.
  // BigInt costs one conversion per response on a path that runs once per
  // response.
  const ms = Date.parse("2026-08-16T12:28:43Z");
  const filetime = BigInt(ms) * 10000n + 116444736000000000n;

  assert.ok(filetime > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(
    Number(filetime),
    Number(filetime + 1n),
    "two different FILETIMEs, one double: exactness is already gone",
  );
});

test("an unreadable logoffDate omits the field rather than sending 1601", () => {
  const { esiTimestampFromFiletime } = require(CHARACTERS_ROUTE);

  for (const value of [null, undefined, "", "not-a-number", "-1", "1.5", 0, "0", {}]) {
    assert.equal(
      esiTimestampFromFiletime(value),
      null,
      `${JSON.stringify(value)} should not decode to a timestamp`,
    );
  }
});

test("a character who has never logged out still reports a logoffDate", async () => {
  // Documented rather than defended against: eve.js seeds `logoffDate` to the
  // character's creation time rather than leaving it unset, so this endpoint
  // reports a plausible-looking wrong answer and nothing on the record
  // distinguishes the two. It is a valid body, which is the problem.
  const created = Date.parse("2020-03-01T09:00:00Z");
  const router = characterRouter("createCharacterOnlineRoute", {
    runtime: runtimeDouble({
      record: {
        ...DOCKED_RECORD,
        logoffDate: String(BigInt(created) * 10000n + 116444736000000000n),
      },
      online: true,
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(ONLINE_PATH, { scopes: ["esi-location.read_online.v1"] }),
  );

  assert.equal(result.body.last_logout, "2020-03-01T09:00:00Z");
  assertBody(result.body, ONLINE(), "valid, and wrong: see contract/wire.js CHARACTER_LOCATION");
});
