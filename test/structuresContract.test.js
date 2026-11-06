/**
 * `GET /corporations/{corporation_id}/structures/` and
 * `GET /universe/structures/{structure_id}/`: the contract.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Written from CCP's document. An informal description of what a consumer
 * needs from these routes disagrees with that document three times, and three
 * assertions below turn each disagreement into a named failure rather than a
 * body somebody has to notice:
 *
 *   - the description calls `name` and `owner_id` optional on
 *     `/universe/structures/{id}/`; the spec requires both.
 *   - it names three consumed fields on the corporation route; the spec
 *     requires six.
 *   - it says a `403` on the structure lookups is tolerated; it is tolerated
 *     on one of the two, and on the other it aborts the consumer's sync.
 *
 * `test/charactersContract.test.js` does the same job for a `null
 * structure_id` and a five-second TTL. This is why a contract test is written
 * from the spec before the handler rather than from a description.
 *
 * One of the two routes is deliberately not registrable.
 * `/universe/structures/{structure_id}/` has no observed producer, and
 * `lib/router.js` `assertScope` makes a wrong guess a boot failure rather than
 * a wrong header. Its projection, handler and subject check are all written
 * and exercised here, and `createUniverseStructureRoute` refuses to build a
 * descriptor, with a test asserting the refusal and naming what would end it.
 * `lib/errors.js` `characterMismatch` and `notFound` follow the same register:
 * a builder that will not build a shape nobody has seen.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const spec = require(path.join(__dirname, "../contract/spec"));
const { SpecContractError, assertBody, describeOperation, loadSpec, resolveSchema } = spec;
const wire = require(path.join(__dirname, "../contract/wire"));
const {
  RouteTableError,
  SUBJECT,
  createRouter,
  dispatchRequest,
} = require(path.join(__dirname, "../lib/router"));
const { REPO_ROOT, vendorOnly } = require(path.join(__dirname, "vendorTree"));

const STRUCTURES_ROUTE = path.join(__dirname, "..", "routes", "structures.js");

/**
 * CCP's own `CharacterID` and `CorporationID` examples from the pinned spec,
 * and an obviously synthetic structure id. `contract/` holds nobody's account
 * data (D23), and a structure id names somebody's staging system.
 */
const CHARACTER_ID = 90000001;
const CORPORATION_ID = 98777771;
const OTHER_CORPORATION_ID = 98000000;
const STRUCTURE_ID = 1000000000001;

const CORPORATION_STRUCTURES_PATH = `/latest/corporations/${CORPORATION_ID}/structures/`;
const UNIVERSE_STRUCTURE_PATH = `/latest/universe/structures/${STRUCTURE_ID}/`;

const CORPORATION_STRUCTURES = () => describeOperation("get", CORPORATION_STRUCTURES_PATH);
const UNIVERSE_STRUCTURE = () => describeOperation("get", UNIVERSE_STRUCTURE_PATH);

const CORPORATION_STRUCTURES_SCOPE = "esi-corporations.read_structures.v1";

/** The item schema of the corporation route, which `describeOperation` cannot unpack. */
function structureItem() {
  // `requiredKeys`/`optionalKeys` are `[]` for this operation because its schema
  // is `type: array` and `contract/spec.js` only unpacks objects. The item is
  // reached directly; `assertBody` handles arrays correctly.
  const contract = CORPORATION_STRUCTURES();
  return resolveSchema(contract.spec, contract.schema.items);
}

// What the spec says

test("the corporation route requires six fields, not the three a consumer names", () => {
  const item = structureItem();

  assert.equal(CORPORATION_STRUCTURES().schema.type, "array");
  assert.deepEqual(item.required.sort(), [
    "corporation_id",
    "profile_id",
    "state",
    "structure_id",
    "system_id",
    "type_id",
  ]);

  // The three fields the description names are a strict subset, so a body built
  // from that list is missing half of what CCP requires.
  for (const field of ["structure_id", "system_id", "type_id"]) {
    assert.ok(item.required.includes(field), field);
  }
  assert.equal(item.required.length, 6);

  assert.deepEqual(Object.keys(item.properties).sort(), Object.keys(item.properties));
  assert.equal(Object.keys(item.properties).length, 15);
});

test("the universe route requires name, solar_system_id and owner_id", () => {
  // Makes the two contradictions explicit failures. The description calls `name`
  // optional on `/universe/structures/{id}/` and `owner_id` optional on
  // `/v2/universe/structures/{id}/`; the pinned document puts both in `required`,
  // and there is only one operation behind the two prefixes.
  const contract = UNIVERSE_STRUCTURE();

  assert.deepEqual(contract.requiredKeys.sort(), ["name", "owner_id", "solar_system_id"]);
  assert.deepEqual(contract.optionalKeys.sort(), ["position", "type_id"]);

  assert.equal(contract.schema.properties.name.type, "string");
  assert.equal(contract.schema.properties.owner_id.type, "integer");
  assert.equal(contract.schema.properties.solar_system_id.type, "integer");

  const position = resolveSchema(contract.spec, contract.schema.properties.position);
  assert.deepEqual(position.required, ["x", "y", "z"]);
});

test("/latest/ and /v2/ are one operation, not two response shapes", () => {
  // The two prefixes suggest the router's version dimension is not optional. That
  // is right about the consumer (eve-nexum calls both) and wrong about the
  // contract: the pinned surface has one path and one operation, so the two
  // prefixes must return byte-identical bodies.
  const latest = describeOperation("get", `/latest/universe/structures/${STRUCTURE_ID}/`);
  const v2 = describeOperation("get", `/v2/universe/structures/${STRUCTURE_ID}/`);

  assert.equal(latest.operationId, v2.operationId);
  assert.equal(latest.specPath, v2.specPath);
  assert.deepEqual(latest.scopes, v2.scopes);
  assert.equal(latest.cacheAgeSeconds, v2.cacheAgeSeconds);
  assert.deepEqual(latest.requiredKeys, v2.requiredKeys);
});

test("state has thirteen values, and a services entry needs both of its fields", () => {
  const item = structureItem();
  const contract = CORPORATION_STRUCTURES();

  const state = resolveSchema(contract.spec, item.properties.state);
  assert.equal(state.enum.length, 13);
  assert.ok(state.enum.includes("unknown"), "which is where eve.js's fourteenth state goes");
  assert.ok(!state.enum.includes("fob_invulnerable"));

  const services = resolveSchema(contract.spec, item.properties.services);
  const service = resolveSchema(contract.spec, services.items);
  assert.deepEqual(service.required.sort(), ["name", "state"]);
  assert.deepEqual(
    resolveSchema(contract.spec, service.properties.state).enum,
    ["online", "offline", "cleanup"],
  );
  // No `enum` on the name, so any string validates. That is why a guessed
  // mapping from eve.js's internal tokens would not be caught here.
  assert.equal(resolveSchema(contract.spec, service.properties.name).enum, undefined);
});

test("the two scopes, one per operation", () => {
  assert.deepEqual(CORPORATION_STRUCTURES().scopes, [CORPORATION_STRUCTURES_SCOPE]);
  assert.deepEqual(UNIVERSE_STRUCTURE().scopes, ["esi-universe.read_structures.v1"]);
});

test("the numbers clients poll on, and the route that publishes no bucket at all", () => {
  assert.equal(CORPORATION_STRUCTURES().cacheAgeSeconds, 3600);
  assert.equal(UNIVERSE_STRUCTURE().cacheAgeSeconds, 3600);

  assert.deepEqual(CORPORATION_STRUCTURES().rateLimit, {
    group: "corp-structure",
    maxTokens: 300,
    windowSize: "15m",
  });

  // `null` here is a reading of the document rather than an omission: the
  // operation carries no `x-rate-limit` key, so this route falls to the error
  // limiter. That matters because eve-nexum resolves every structure's name with
  // its own request, and an unresolvable corporation burns one error-limit unit
  // per structure per sync.
  const universe = UNIVERSE_STRUCTURE();
  assert.equal(universe.rateLimit, null);
  assert.equal(
    universe.spec.paths[universe.specPath].get["x-rate-limit"],
    undefined,
    "absent, not merely empty",
  );

  assert.deepEqual(CORPORATION_STRUCTURES().statuses, [200], "the spec declares no error status");
  assert.deepEqual(UNIVERSE_STRUCTURE().statuses, [200]);
});

test("x-required-roles names Station_Manager, and does not name Director", () => {
  // The consumer needs `Station_Manager` or `Director`. That rule is
  // eve-nexum's; CCP's document declares one role on this operation, and it is
  // the one `routes/structures.js` enforces.
  const contract = CORPORATION_STRUCTURES();
  const roles = contract.spec.paths[contract.specPath].get["x-required-roles"];

  assert.deepEqual(roles, ["Station_Manager"]);
  assert.ok(!roles.includes("Director"));

  // Neither of the other two operations declares one.
  const universe = UNIVERSE_STRUCTURE();
  assert.equal(universe.spec.paths[universe.specPath].get["x-required-roles"], undefined);
});

test("only the corporation route paginates, and only it declares Content-Language", () => {
  const contract = CORPORATION_STRUCTURES();
  const operation = contract.spec.paths[contract.specPath].get;

  const page = operation.parameters.find((parameter) => parameter.name === "page");
  assert.equal(page.in, "query");
  assert.equal(page.schema.minimum, wire.PAGINATION.minimum);
  assert.equal(page.schema.format, "int32");

  const headers = Object.keys(operation.responses["200"].headers);
  assert.ok(headers.includes("X-Pages"));

  // The one signal in the document that this route's body carries translated
  // text, which is what `localizedBody` claims (see the route descriptor test
  // below). The other two operations declare no Content-Language.
  assert.ok(headers.includes("Content-Language"));

  const universe = UNIVERSE_STRUCTURE();
  const universeHeaders = Object.keys(
    universe.spec.paths[universe.specPath].get.responses["200"].headers,
  );
  assert.ok(!universeHeaders.includes("Content-Language"));
  assert.ok(!universeHeaders.includes("X-Pages"));
});

// What the wire says

test("neither success was captured, and the producer comes from a refusal", () => {
  // The honest state, recorded as such: the 2026-08-25 run reached the
  // corporation route and was refused for want of a role, so `SUCCESS_KIND`
  // carries no row for it. Deriving one from the three siblings that did answer
  // is the reasoning `/characters/:character_id` disproves one path level up.
  assert.equal(wire.SUCCESS_KIND["/corporations/:corporation_id/structures"], undefined);
  assert.equal(wire.SUCCESS_KIND["/universe/structures/:structure_id"], undefined);

  // What was captured is the refusal, and it is the application's. A route
  // carries one producer in `lib/router.js` because the success and error halves
  // were checked against each other six times and never disagreed, so an
  // observed application error on this route is an observation of the
  // implementation that answers all of it.
  assert.equal(wire.REQUIRED_ROLE_REFUSAL.kind, wire.KIND.APP_ERROR);
  assert.equal(wire.REQUIRED_ROLE_REFUSAL.rateLimitGroup, CORPORATION_STRUCTURES().rateLimit.group);
  assert.equal(wire.REQUIRED_ROLE_REFUSAL.contentType, wire.CONTENT_TYPE[wire.KIND.APP_ERROR]);
  assert.equal(wire.ERROR_SHAPE[wire.ERROR_FAMILY.LEGACY].contentType, wire.REQUIRED_ROLE_REFUSAL.contentType);

  // That is the family `lib/errors.js` derives from the application producer, so
  // declaring `producer: "app"` on this route and observing an application
  // refusal on it are the same claim rather than two.
  const { FAMILY, familyFor } = require(path.join(__dirname, "../lib/errors"));
  assert.equal(familyFor(require(STRUCTURES_ROUTE).PRODUCER), FAMILY.LEGACY);

  // The universe route has neither half: no captured success and no captured
  // refusal of its own. It is registered anyway, for the same reason that
  // settles this route: `assertScope` forbids the gateway producer on a scoped
  // route, so `app` is not the likeliest of several candidates, it is the only
  // legal value. What stays unobserved is the field order and the ACL refusal,
  // both of which are notes inside the route rather than reasons to leave an
  // implemented endpoint answering an unrouted 404.
  const { UNIVERSE_STRUCTURE_PRODUCER } = require(STRUCTURES_ROUTE);
  assert.equal(UNIVERSE_STRUCTURE_PRODUCER, "app");
});

test("the two refusal strings are CCP's, byte for byte", () => {
  const { MISSING_REQUIRED_ROLE, NOT_IN_CORPORATION } = require(STRUCTURES_ROUTE);

  assert.equal(MISSING_REQUIRED_ROLE, wire.REQUIRED_ROLE_REFUSAL.body);
  assert.equal(NOT_IN_CORPORATION, wire.CROSS_ENTITY_REFUSAL.body);

  // The `(s)` is CCP's and it is bytes: a replica that tidies the parenthetical
  // sends a different response. Checked as a length rather than as prose, because
  // `{"error":"..."}` is nine characters of envelope around it.
  assert.equal(MISSING_REQUIRED_ROLE.length, 40);
  assert.equal(
    JSON.stringify({ error: MISSING_REQUIRED_ROLE }).length,
    wire.REQUIRED_ROLE_REFUSAL.contentLength,
  );
  assert.equal(
    JSON.stringify({ error: NOT_IN_CORPORATION }).length,
    wire.CROSS_ENTITY_REFUSAL.contentLength,
  );

  // Both are the application's refusal shape: no trailing newline, no nosniff.
  for (const refusal of [wire.REQUIRED_ROLE_REFUSAL, wire.CROSS_ENTITY_REFUSAL]) {
    assert.equal(refusal.status, 403);
    assert.equal(refusal.trailingNewline, false);
    assert.equal(refusal.sendsNosniff, false);
    assert.equal(refusal.sendsCacheStatus, true, "which is why these are gate refusals");
  }
});

test("the membership refusal is corporation-shaped, and says so", () => {
  // It was observed on `/corporations/{id}/contacts/` rather than here, and it
  // travels because its wording names the relationship. It would not travel to an
  // alliance or a fleet, and nothing in this file reuses it for one.
  assert.match(wire.CROSS_ENTITY_REFUSAL.body, /corporation/);
  assert.equal(wire.CROSS_ENTITY_REFUSAL.rateLimitGroup, "corp-social");
});

test("X-Pages is sent on a one-page authenticated collection", () => {
  // Worth capturing rather than assuming: `/markets/prices/` is a large public
  // collection that sends no `X-Pages` at all, so "a single-page body omits it"
  // was a live reading of the surface until this run.
  assert.equal(wire.AUTHENTICATED_PAGING.sendsXPagesOnSinglePage, true);
  assert.equal(wire.AUTHENTICATED_PAGING.singlePageValue, "1");
});

test("the page size is carried across, not read, and the carry is visible", () => {
  // The pinned document publishes the `page` parameter and the `X-Pages` header
  // and no page size anywhere, and this one is unobservable without a
  // corporation owning more than a page of structures.
  //
  // So `PAGE_SIZE` is asserted against `PAGINATION.pageSize` rather than a
  // literal: the day somebody reads this route's real size, this test fails and
  // says where the number came from.
  const { PAGE_SIZE } = require(STRUCTURES_ROUTE);
  assert.equal(PAGE_SIZE, wire.PAGINATION.pageSize);

  // That carry is a choice rather than a rule: the corporation contacts bucket
  // returned exactly 200 rows with `X-Pages: 2`, which fixes its size at 200 and
  // cannot be read any other way, while the alliance bucket returned 240 on one
  // page. One number does not fit the surface.
  assert.equal(wire.CONTACTS.pageSize["/corporations/{corporation_id}/contacts"], 200);
  assert.notEqual(
    wire.CONTACTS.pageSize["/corporations/{corporation_id}/contacts"],
    wire.PAGINATION.pageSize,
  );
});

test("the corporation route is in the localized column of the Vary survey", () => {
  assert.ok(
    wire.VARY_LOCALIZED_SURVEY.localized.includes("/corporations/{corporation_id}/structures"),
  );
  assert.equal(wire.REQUIRED_ROLE_REFUSAL.vary, wire.VARY_LOCALIZED_BODY);
  assert.equal(wire.VARY_LOCALIZED_BODY.length, 4);
  assert.equal(wire.CROSS_ENTITY_REFUSAL.vary, wire.VARY);
});

// What a plausible-but-wrong body does

test("a three-field structure row is a contract failure", () => {
  // The body the description gives, exactly: three of the six required fields.
  assert.throws(
    () => assertBody(
      [{ structure_id: STRUCTURE_ID, system_id: 30000142, type_id: 35832 }],
      CORPORATION_STRUCTURES(),
    ),
    (err) => err instanceof SpecContractError
      && /body\[0\]\.corporation_id is required/.test(err.message)
      && /body\[0\]\.profile_id is required/.test(err.message)
      && /body\[0\]\.state is required/.test(err.message),
  );
});

test("eve.js's fourteenth state is a contract failure if it is passed through", () => {
  assert.throws(
    () => assertBody(
      [{
        corporation_id: CORPORATION_ID,
        profile_id: 1,
        state: "fob_invulnerable",
        structure_id: STRUCTURE_ID,
        system_id: 30000142,
        type_id: 35832,
      }],
      CORPORATION_STRUCTURES(),
    ),
    (err) => /body\[0\]\.state: "fob_invulnerable" is not one of/.test(err.message),
  );
});

test("a services entry missing its state is a contract failure", () => {
  assert.throws(
    () => assertBody(
      [{
        corporation_id: CORPORATION_ID,
        profile_id: 1,
        services: [{ name: "docking" }],
        state: "shield_vulnerable",
        structure_id: STRUCTURE_ID,
        system_id: 30000142,
        type_id: 35832,
      }],
      CORPORATION_STRUCTURES(),
    ),
    (err) => /body\[0\]\.services\[0\]\.state is required/.test(err.message),
  );
});

test("a fuel_expires that went through toISOString is rejected", () => {
  // `new Date(ms).toISOString()` is `...T12:28:43.000Z`, which is what a straight
  // epoch conversion produces if nobody trims it, and no ESI response has ever
  // carried fractional seconds.
  assert.throws(
    () => assertBody(
      [{
        corporation_id: CORPORATION_ID,
        fuel_expires: new Date("2026-09-01T12:28:43Z").toISOString(),
        profile_id: 1,
        state: "shield_vulnerable",
        structure_id: STRUCTURE_ID,
        system_id: 30000142,
        type_id: 35832,
      }],
      CORPORATION_STRUCTURES(),
    ),
    (err) => /is not an ESI timestamp/.test(err.message),
  );
});

test("a universe body with a null name is a contract failure", () => {
  // The description says `name` is optional and degrades to blank. The pinned
  // surface declares no nullable field anywhere, so `null` has its own message.
  assert.throws(
    () => assertBody({ name: null, owner_id: CORPORATION_ID, solar_system_id: 30000142 }, UNIVERSE_STRUCTURE()),
    (err) => /body\.name is null, and the .* spec declares no nullable fields/.test(err.message),
  );
});

test("a universe body without owner_id is a contract failure", () => {
  assert.throws(
    () => assertBody({ name: "Synthetic Citadel", solar_system_id: 30000142 }, UNIVERSE_STRUCTURE()),
    (err) => /body\.owner_id is required by the spec and is missing/.test(err.message),
  );
});

test("a position missing z is a contract failure, which is why it is omitted", () => {
  assert.throws(
    () => assertBody(
      {
        name: "Synthetic Citadel",
        owner_id: CORPORATION_ID,
        position: { x: 0, y: 0 },
        solar_system_id: 30000142,
      },
      UNIVERSE_STRUCTURE(),
    ),
    (err) => /body\.position\.z is required by the spec and is missing/.test(err.message),
  );
});

// The state table

test("every ESI state is produced by some eve.js state", () => {
  const { EVEJS_STRUCTURE_STATE_NAME_BY_ID, esiStructureState } = require(STRUCTURES_ROUTE);
  const declared = new Set(resolveSchema(
    CORPORATION_STRUCTURES().spec,
    structureItem().properties.state,
  ).enum);

  const produced = new Set(
    Object.keys(EVEJS_STRUCTURE_STATE_NAME_BY_ID).map((id) => esiStructureState(Number(id))),
  );

  for (const state of declared) {
    assert.ok(produced.has(state), `no eve.js state produces ${state}`);
  }
  for (const state of produced) {
    assert.ok(declared.has(state), `${state} is not in CCP's enum`);
  }
  assert.equal(Object.keys(EVEJS_STRUCTURE_STATE_NAME_BY_ID).length, 14, "one more than ESI's 13");
});

test("the state ESI has no name for becomes unknown, and nothing is dropped", () => {
  const { STATE_WITHOUT_AN_ESI_NAME, esiStructureState } = require(STRUCTURES_ROUTE);

  assert.deepEqual(STATE_WITHOUT_AN_ESI_NAME, { fob_invulnerable: "unknown" });
  assert.equal(esiStructureState(118), "unknown");

  // A state integer nobody has seen is `unknown` too, rather than a throw or a
  // dropped row: `state` is required, and a consumer's structures table that
  // silently loses rows is worse than one carrying an honest `unknown`.
  for (const value of [999, -1, null, undefined, "", "abc", {}]) {
    assert.equal(esiStructureState(value), "unknown", JSON.stringify(value));
  }
  assert.equal(esiStructureState(110), "shield_vulnerable");
  assert.equal(esiStructureState("110"), "shield_vulnerable", "the record may hold a string");
});

test("the state table still matches the vendor declaration", vendorOnly, () => {
  // A protocol constant copied because only `lib/runtimeAccess.js` may require
  // game code, checked the way `lib/sessionIdentity.js`'s GM role bits are.
  const { EVEJS_STRUCTURE_STATE_NAME_BY_ID } = require(STRUCTURES_ROUTE);
  const file = path.join(
    REPO_ROOT, "server", "src", "services", "structure", "structureConstants.js",
  );
  assert.equal(fs.existsSync(file), true, `structureConstants.js has moved: ${file}`);
  const source = fs.readFileSync(file, "utf8");

  const block = /const\s+STRUCTURE_STATE\s*=\s*Object\.freeze\(\{([^}]+)\}\)/.exec(source);
  assert.ok(block, "STRUCTURE_STATE is no longer declared upstream");

  const upstream = {};
  for (const [, name, id] of block[1].matchAll(/(\w+)\s*:\s*(\d+)\s*,/g)) {
    upstream[id] = name.toLowerCase();
  }

  assert.deepEqual(
    upstream,
    { ...EVEJS_STRUCTURE_STATE_NAME_BY_ID },
    "upstream changed the structure state vocabulary",
  );
});

// The route descriptors

test("the corporation route descriptor agrees with the pinned spec", () => {
  const routes = require(STRUCTURES_ROUTE);
  const route = routes.createCorporationStructuresRoute({});
  const contract = spec.assertRouteMatchesSpec(route);

  assert.equal(route.name, contract.operationId);
  assert.equal(route.producer, "app", "established from the observed refusal");
  assert.equal(route.pageSize, wire.PAGINATION.pageSize);
  assert.equal(route.cacheTtl, 3600, "and a paginated route without one would not compile");
  assert.equal(route.localizedBody, true);
});

test("the path parameters are spelled the way the subject heuristic reads them", () => {
  // `lib/router.js` decides a route needs a `subject` by looking for a path
  // parameter ending in `_id` that is not `character_id`. A parameter spelled
  // `:id` would fail that and the route would compile with the scope as its only
  // gate, the hole SUBJECT was introduced to close.
  const routes = require(STRUCTURES_ROUTE);

  assert.ok(routes.CORPORATION_STRUCTURES_PATH.includes(`:${routes.CORPORATION_ID_PARAM}`));
  assert.ok(routes.UNIVERSE_STRUCTURE_PATH.includes(`:${routes.STRUCTURE_ID_PARAM}`));
  assert.match(routes.CORPORATION_ID_PARAM, /_id$/);
  assert.match(routes.STRUCTURE_ID_PARAM, /_id$/);
  assert.notEqual(routes.CORPORATION_ID_PARAM, "character_id");
});

test("the corporation route declares a subject, and would not compile without one", () => {
  const routes = require(STRUCTURES_ROUTE);
  const route = routes.createCorporationStructuresRoute({});

  assert.equal(typeof route.subject, "function", "not SUBJECT.CALLER: the caller is not the entity");
  assert.notEqual(route.subject, SUBJECT.SCOPE_ONLY);

  const { subject, ...withoutSubject } = route;
  assert.throws(
    () => createRouter([withoutSubject]),
    (err) => err instanceof RouteTableError
      && /says nothing about who may read that entity/.test(err.message),
  );
});

test("the universe structure route builds a descriptor, and says what it still cannot know", () => {
  // An earlier version asserted the opposite: that the factory throws while its
  // producer is unobserved. `assertScope` does turn a wrong producer into a boot
  // failure, which is exactly why there is nothing to guess: it forbids the
  // gateway on a scoped route, `meta` is another surface and `null` claims no
  // JSON, so `app` is the only value the field can legally hold here.
  const routes = require(STRUCTURES_ROUTE);

  assert.equal(routes.UNIVERSE_STRUCTURE_PRODUCER, "app");

  const descriptor = routes.createUniverseStructureRoute({});
  assert.equal(descriptor.path, "/universe/structures/:structure_id");
  assert.equal(descriptor.producer, "app");
  assert.equal(typeof descriptor.subject, "function", "keyed by a structure id, not by the caller");

  // The unobserved facts are unchanged: no success has been captured for this
  // operation, so its field order and its ACL refusal remain spec-derived. That
  // is a note inside the route, not a reason to withhold the route.
  assert.equal(wire.SUCCESS_KIND["/universe/structures/:structure_id"], undefined);
});

test("the file is not named for the static-data tripwire it would trigger", () => {
  // `test/conditional.test.js` fails the moment a file in `routes/` starts with
  // `universe`, because `contract/wire.js` CONDITIONAL_STATIC_DATA_EXCEPTION
  // records shared-etag behaviour nothing here implements. This route lives under
  // `/universe/` and is not one of those routes, so the file is named for the
  // resource instead.
  assert.ok(!path.basename(STRUCTURES_ROUTE).startsWith("universe"));
  assert.ok(
    !wire.CONDITIONAL_STATIC_DATA_EXCEPTION.paths.includes("/universe/structures/:structure_id"),
  );
});

// The handler

function structuresRouter(deps) {
  const { createCorporationStructuresRoute } = require(STRUCTURES_ROUTE);
  return createRouter([createCorporationStructuresRoute(deps)]);
}

/**
 * A structure record in eve.js's own field names, as
 * `normalizeStructureRecord` writes them.
 *
 * The timer fields are epoch milliseconds (the structure record's convention,
 * not the character record's Windows FILETIME), and `null` for a timer that is
 * not running.
 */
function structureRecord(overrides = {}) {
  return {
    structureID: STRUCTURE_ID,
    typeID: 35832,
    name: "Synthetic Citadel",
    ownerCorpID: CORPORATION_ID,
    ownerID: CORPORATION_ID,
    solarSystemID: 30000142,
    position: { x: 0, y: 0, z: 0 },
    state: 110, // SHIELD_VULNERABLE
    stateStartedAt: null,
    stateEndsAt: null,
    reinforceHour: 18,
    nextReinforceHour: null,
    nextReinforceApply: null,
    profileID: 1,
    serviceStates: { 1: 1 },
    fuelExpiresAt: null,
    unanchoring: null,
    ...overrides,
  };
}

/**
 * A `lib/runtimeAccess.js` double.
 *
 * `getCorporationSessionRoleState` throws, as it does in
 * `test/rolesContract.test.js`: it would answer the role question in one call
 * and persists a default member record doing it.
 */
function runtimeDouble({
  structures = [structureRecord()],
  corporationID = CORPORATION_ID,
  member = { roles: "2048", rolesAtHQ: "0", rolesAtBase: "0", rolesAtOther: "0" },
  corporation = { ceoID: 0 },
  omit = [],
} = {}) {
  const runtime = {
    peekCharacterRecord: (characterId, options = {}) => {
      if (characterId !== CHARACTER_ID) return null;
      const record = { corporationID };
      return options.project ? options.project(record, characterId) : record;
    },
    getCorporationMember: (corporationId, characterId) =>
      (corporationId === corporationID && characterId === CHARACTER_ID ? member : null),
    getCorporationRecord: (corporationId) =>
      (corporationId === corporationID ? corporation : null),
    listCorporationStructures: (corporationId) =>
      structures.filter((row) => row.ownerCorpID === corporationId),
    peekStructureRecord: (structureId) =>
      structures.find((row) => row.structureID === structureId) || null,
    getCorporationSessionRoleState: () => {
      throw new Error("a read endpoint called the accessor that writes");
    },
  };

  for (const accessor of omit) delete runtime[accessor];
  return runtime;
}

function authenticated(pathname, {
  scopes = [CORPORATION_STRUCTURES_SCOPE],
  characterId = CHARACTER_ID,
  query = {},
} = {}) {
  return {
    method: "GET",
    pathname,
    query,
    credential: {
      presented: true,
      claims: Object.freeze({ characterId, scopes: Object.freeze([...scopes]) }),
      refusal: null,
    },
  };
}

test("routes/structures.js satisfies the corporation contract", async () => {
  const router = structuresRouter({ runtime: runtimeDouble() });
  const result = await dispatchRequest(router, authenticated(CORPORATION_STRUCTURES_PATH));

  assert.equal(result.status, CORPORATION_STRUCTURES().successStatus);
  assertBody(result.body, CORPORATION_STRUCTURES());

  // Field order, not just field presence: order is bytes.
  assert.deepEqual(Object.keys(result.body[0]), [
    "corporation_id",
    "name",
    "profile_id",
    "reinforce_hour",
    "state",
    "structure_id",
    "system_id",
    "type_id",
  ]);
  assert.deepEqual(result.body[0], {
    corporation_id: CORPORATION_ID,
    name: "Synthetic Citadel",
    profile_id: 1,
    reinforce_hour: 18,
    state: "shield_vulnerable",
    structure_id: STRUCTURE_ID,
    system_id: 30000142,
    type_id: 35832,
  });
});

test("services and every timer that is not running are omitted, never null", async () => {
  const router = structuresRouter({ runtime: runtimeDouble() });
  const result = await dispatchRequest(router, authenticated(CORPORATION_STRUCTURES_PATH));

  // `services` is the declared divergence: eve.js's internal tokens are not CCP's
  // display strings and there is nothing to check a mapping against. The record
  // handed in carries `serviceStates`, so this is an omission taken rather than a
  // field that happened to be absent.
  for (const field of [
    "services",
    "fuel_expires",
    "next_reinforce_apply",
    "next_reinforce_hour",
    "state_timer_end",
    "state_timer_start",
    "unanchors_at",
  ]) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(result.body[0], field),
      `${field} should be omitted`,
    );
  }
  assertBody(result.body, CORPORATION_STRUCTURES());
});

test("the timers that are running are second-precision ESI timestamps", async () => {
  const fuel = Date.parse("2026-09-01T12:28:43Z");
  const router = structuresRouter({
    runtime: runtimeDouble({
      structures: [structureRecord({
        state: 111, // ARMOR_REINFORCE
        fuelExpiresAt: fuel,
        stateStartedAt: Date.parse("2026-08-30T09:00:00Z"),
        stateEndsAt: Date.parse("2026-08-31T09:00:00Z"),
        nextReinforceApply: Date.parse("2026-09-05T00:00:00Z"),
        nextReinforceHour: 20,
        unanchoring: Date.parse("2026-10-01T00:00:00Z"),
      })],
    }),
  });

  const result = await dispatchRequest(router, authenticated(CORPORATION_STRUCTURES_PATH));
  assertBody(result.body, CORPORATION_STRUCTURES());

  assert.equal(result.body[0].fuel_expires, "2026-09-01T12:28:43Z");
  assert.equal(result.body[0].state_timer_start, "2026-08-30T09:00:00Z");
  assert.equal(result.body[0].state_timer_end, "2026-08-31T09:00:00Z");
  assert.equal(result.body[0].next_reinforce_apply, "2026-09-05T00:00:00Z");
  assert.equal(result.body[0].state, "armor_reinforce");
  assert.deepEqual(Object.keys(result.body[0]).slice(0, 2), ["corporation_id", "fuel_expires"]);
});

test("a zero timer is omitted rather than published as 1970", async () => {
  const { esiTimestampFromEpochMs } = require(STRUCTURES_ROUTE);

  for (const value of [0, -1, null, undefined, "", "abc", {}]) {
    assert.equal(esiTimestampFromEpochMs(value), null, JSON.stringify(value));
  }

  const router = structuresRouter({
    runtime: runtimeDouble({ structures: [structureRecord({ fuelExpiresAt: 0 })] }),
  });
  const result = await dispatchRequest(router, authenticated(CORPORATION_STRUCTURES_PATH));

  assert.ok(!Object.prototype.hasOwnProperty.call(result.body[0], "fuel_expires"));
});

test("a structure in eve.js's fourteenth state is served as unknown, not dropped", async () => {
  const router = structuresRouter({
    runtime: runtimeDouble({ structures: [structureRecord({ state: 118 })] }),
  });

  const result = await dispatchRequest(router, authenticated(CORPORATION_STRUCTURES_PATH));

  assert.equal(result.body.length, 1, "the row survives");
  assert.equal(result.body[0].state, "unknown");
  assertBody(result.body, CORPORATION_STRUCTURES());
});

test("a corporation with no structures answers with an empty array", async () => {
  const router = structuresRouter({ runtime: runtimeDouble({ structures: [] }) });
  const result = await dispatchRequest(router, authenticated(CORPORATION_STRUCTURES_PATH));

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, []);
  assertBody(result.body, CORPORATION_STRUCTURES());
  assert.equal(result.headers["x-pages"], wire.AUTHENTICATED_PAGING.singlePageValue);
});

test("X-Pages is sent on the only page of a one-page collection", async () => {
  const router = structuresRouter({ runtime: runtimeDouble() });
  const result = await dispatchRequest(router, authenticated(CORPORATION_STRUCTURES_PATH));

  assert.equal(result.headers["x-pages"], "1");
});

test("the page refusals are the observed ones", async () => {
  const router = structuresRouter({ runtime: runtimeDouble() });

  const belowMinimum = await dispatchRequest(
    router,
    authenticated(CORPORATION_STRUCTURES_PATH, { query: { page: "0" } }),
  );
  assert.equal(belowMinimum.status, wire.PAGINATION_ERRORS.belowMinimum.status);
  assert.equal(belowMinimum.body.error, wire.PAGINATION_ERRORS.belowMinimum.template(0));

  const beyondEnd = await dispatchRequest(
    router,
    authenticated(CORPORATION_STRUCTURES_PATH, { query: { page: "2" } }),
  );
  assert.equal(beyondEnd.status, wire.PAGINATION_ERRORS.beyondLastPage.status);
  assert.equal(
    JSON.stringify(beyondEnd.body),
    wire.PAGINATION_ERRORS.beyondLastPage.body,
  );

  const notAnInteger = await dispatchRequest(
    router,
    authenticated(CORPORATION_STRUCTURES_PATH, { query: { page: "1e3" } }),
  );
  assert.equal(notAnInteger.status, 400);
  assert.equal(notAnInteger.body.error, wire.PAGINATION_ERRORS.notAnInteger.template("1e3"));
});

test("every version prefix reaches the handler, and reports the application", async () => {
  const router = structuresRouter({ runtime: runtimeDouble() });

  for (const prefix of wire.VERSION_PREFIXES) {
    const result = await dispatchRequest(
      router,
      authenticated(`/${prefix}/corporations/${CORPORATION_ID}/structures/`),
    );
    assert.equal(result.status, 200, `/${prefix}/…/structures/ did not reach the handler`);
    assert.equal(result.producer, "app");
    assert.equal(result.authenticated, true);
  }
});

// The two refusals the subject makes

test("a caller in another corporation is refused, and the handler never runs", async () => {
  let handlerRuns = 0;
  const routes = require(STRUCTURES_ROUTE);
  const route = routes.createCorporationStructuresRoute({
    runtime: runtimeDouble({ corporationID: OTHER_CORPORATION_ID }),
  });
  const router = createRouter([{
    ...route,
    handler: (params) => { handlerRuns += 1; return route.handler(params); },
  }]);

  const result = await dispatchRequest(router, authenticated(CORPORATION_STRUCTURES_PATH));

  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: wire.CROSS_ENTITY_REFUSAL.body });
  assert.equal(result.headers["content-type"], wire.CONTENT_TYPE[wire.KIND.APP_ERROR]);
  assert.equal(result.headers["x-content-type-options"], undefined, "the application sends none");
  assert.equal(result.headers["x-esi-cache-status"], "MISS", "a gate refusal reports the cache");
  assert.equal(result.headers["x-compatibility-date"], wire.COMPATIBILITY_DATE);

  assert.equal(handlerRuns, 0, "the read must not happen before the check that forbids it");
});

test("a member without Station_Manager gets the role refusal", async () => {
  const router = structuresRouter({
    runtime: runtimeDouble({
      member: { roles: "256", rolesAtHQ: "0", rolesAtBase: "0", rolesAtOther: "0" },
    }),
  });

  const result = await dispatchRequest(router, authenticated(CORPORATION_STRUCTURES_PATH));

  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: wire.REQUIRED_ROLE_REFUSAL.body });

  // The four-line `Vary` the refusal was observed carrying, which is what
  // `localizedBody: true` on this route buys.
  assert.deepEqual(result.headers.vary, [...wire.VARY_LOCALIZED_BODY]);
});

test("a director passes the gate by holding the bit, not by a special case", async () => {
  // The spec's gate names one role, not "Station_Manager or Director". eve.js
  // gives bit 0 the full administrative mask, which contains bit 11, so the check
  // finds the bit it is looking for.
  const { CORP_ROLE_DIRECTOR } = require(path.join(__dirname, "..", "routes", "roles.js"));
  const router = structuresRouter({
    runtime: runtimeDouble({
      member: {
        roles: CORP_ROLE_DIRECTOR.toString(),
        rolesAtHQ: "0",
        rolesAtBase: "0",
        rolesAtOther: "0",
      },
    }),
  });

  const result = await dispatchRequest(router, authenticated(CORPORATION_STRUCTURES_PATH));
  assert.equal(result.status, 200);
});

test("the CEO passes with no member record at all", async () => {
  const router = structuresRouter({
    runtime: runtimeDouble({ member: null, corporation: { ceoID: CHARACTER_ID } }),
  });

  const result = await dispatchRequest(router, authenticated(CORPORATION_STRUCTURES_PATH));
  assert.equal(result.status, 200);
  assertBody(result.body, CORPORATION_STRUCTURES());
});

test("a malformed corporation id is answered as a corporation the caller is not in", async () => {
  // A divergence, named: real ESI refuses `/corporations/abc/structures/` with a
  // coercion 400 before it asks who is calling. This replica answers the
  // membership 403, because the only observed dressing of a coercion refusal is
  // the one `routedRefusal` gives it, without `X-Esi-Cache-Status`, and a gate
  // refusal carries one. Bytes that were observed, attached to a claim that is
  // true, beat the headers of bytes that were not.
  const router = structuresRouter({ runtime: runtimeDouble() });

  for (const segment of ["0" + CORPORATION_ID, "9.8777771e7", "+98777771", "0x5e33aab"]) {
    const result = await dispatchRequest(
      router,
      authenticated(`/latest/corporations/${segment}/structures/`),
    );
    assert.equal(result.status, 403, segment);
    assert.deepEqual(result.body, { error: wire.CROSS_ENTITY_REFUSAL.body });
  }
});

test("the scope gate still runs in front of the subject check", async () => {
  const router = structuresRouter({ runtime: runtimeDouble() });

  const noToken = await dispatchRequest(
    router,
    { method: "GET", pathname: CORPORATION_STRUCTURES_PATH, query: {} },
  );
  assert.equal(noToken.status, 401);

  const wrongScope = await dispatchRequest(
    router,
    authenticated(CORPORATION_STRUCTURES_PATH, { scopes: ["esi-universe.read_structures.v1"] }),
  );
  assert.equal(wrongScope.status, 401, "a missing scope is a 401, not the subject's 403");
  assert.match(JSON.stringify(wrongScope.body), /esi-corporations\.read_structures\.v1/);
});

// A record the game cannot produce

test("a row missing a required id is a logged 500, not a body missing a key", async () => {
  const logged = [];
  const router = structuresRouter({
    runtime: runtimeDouble({ structures: [structureRecord({ profileID: 0 })] }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(CORPORATION_STRUCTURES_PATH),
    { logError: (message, err) => logged.push(err.message) },
  );

  assert.equal(result.status, 500);
  assert.match(logged[0], /profileID/);
});

test("a missing accessor is a 500 naming it, never an empty collection", async () => {
  // An empty collection is a valid, complete, wrong answer, and eve-nexum acts on
  // it by deleting every structure it had recorded for the corporation.
  const logged = [];
  const router = structuresRouter({
    runtime: runtimeDouble({ omit: ["listCorporationStructures"] }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(CORPORATION_STRUCTURES_PATH),
    { logError: (message, err) => logged.push(err.message) },
  );

  assert.equal(result.status, 500);
  assert.match(logged[0], /listCorporationStructures/);
  assert.match(logged[0], /refresh: false/, "and says why the accessor must not tick the game");
});

// The route that cannot be registered, exercised anyway

test("buildUniverseStructure satisfies the contract it cannot yet be served under", () => {
  // The handler is written before the producer is known so that, the day a
  // capture arrives, what ships is a route-table entry and not an unread body.
  const { buildUniverseStructure } = require(STRUCTURES_ROUTE);

  const body = buildUniverseStructure(
    {
      path: { structure_id: String(STRUCTURE_ID) },
      credential: { characterId: CHARACTER_ID },
    },
    { runtime: runtimeDouble() },
  );

  assertBody(body, UNIVERSE_STRUCTURE());
  assert.deepEqual(Object.keys(body), ["name", "owner_id", "solar_system_id", "type_id"]);
  assert.deepEqual(body, {
    name: "Synthetic Citadel",
    // A corporation id: eve.js has no character-owned structure model, and
    // `ownerCorpID` and `ownerID` are the same coalesced value.
    owner_id: CORPORATION_ID,
    solar_system_id: 30000142,
    type_id: 35832,
  });
});

test("position is omitted rather than published as the centre of the star", () => {
  // Available, and defaulted to `{0, 0, 0}` by eve.js's own normaliser. The
  // record handed in carries exactly that, so this is an omission taken rather
  // than a field that happened to be absent.
  const { buildUniverseStructure } = require(STRUCTURES_ROUTE);

  const body = buildUniverseStructure(
    { path: { structure_id: String(STRUCTURE_ID) }, credential: { characterId: CHARACTER_ID } },
    { runtime: runtimeDouble() },
  );

  assert.ok(!Object.prototype.hasOwnProperty.call(body, "position"));
  assert.ok(UNIVERSE_STRUCTURE().optionalKeys.includes("position"), "so omitting it is allowed");
});

test("a structure with no name is a throw, because the description is wrong about name", () => {
  const { buildUniverseStructure } = require(STRUCTURES_ROUTE);

  assert.throws(
    () => buildUniverseStructure(
      { path: { structure_id: String(STRUCTURE_ID) }, credential: { characterId: CHARACTER_ID } },
      { runtime: runtimeDouble({ structures: [structureRecord({ name: "" })] }) },
    ),
    (err) => /name is required/.test(err.message),
  );
});

test("the universe subject refuses a structure the caller's corporation does not own", () => {
  // It refuses by throwing, which `lib/router.js` turns into a logged 500, the
  // router's documented bargain while the real refusal is unobserved: the read
  // is still refused, and the status is loudly wrong rather than quietly
  // invented. The message carries the requests that would end it.
  const { universeStructureSubject } = require(STRUCTURES_ROUTE);
  const claims = { characterId: CHARACTER_ID, scopes: ["esi-universe.read_structures.v1"] };

  assert.throws(
    () => universeStructureSubject(
      claims,
      { structure_id: String(STRUCTURE_ID) },
      { runtime: runtimeDouble({ corporationID: OTHER_CORPORATION_ID }) },
    ),
    (err) => /never been observed/.test(err.message) && /403/.test(err.message),
  );

  // A structure id nobody has ever issued refuses the same way, because whether
  // that is a 403 hiding it or a 404 naming an entity noun is the same open
  // question.
  assert.throws(
    () => universeStructureSubject(
      claims,
      { structure_id: "1000000000002" },
      { runtime: runtimeDouble() },
    ),
    (err) => /never been observed/.test(err.message),
  );

  // A caller whose corporation does own it is allowed through.
  assert.equal(
    universeStructureSubject(
      claims,
      { structure_id: String(STRUCTURE_ID) },
      { runtime: runtimeDouble() },
    ),
    null,
  );
});

test("both routes read ids the way the cross-character gate does", () => {
  // `Number()` alone accepts `0123123`, `1.23123e5`, `0x1e0f3`, `+123123` and
  // `" 123123 "` as character 123123, and `parseInt("9e7")` is 9. That is a
  // cross-entity read manufactured inside the authorised path, which
  // `lib/router.js` refuses for `character_id` and `canonicalId` refuses here for
  // the two entity kinds the router does not cover.
  const { canonicalId } = require(STRUCTURES_ROUTE);

  for (const segment of ["0123123", "1.23123e5", "0x1e0f3", "+123123", " 123123 ", "0", "-1", ""]) {
    assert.equal(canonicalId(segment), null, JSON.stringify(segment));
  }
  assert.equal(canonicalId("123123"), 123123);
  assert.equal(canonicalId(String(STRUCTURE_ID)), STRUCTURE_ID);
});

// The spec is loaded once, and it is the pinned one

test("every assertion above is against the same pinned document", () => {
  assert.equal(loadSpec().info.version, CORPORATION_STRUCTURES().compatibilityDate);
  assert.equal(loadSpec().info.version, wire.COMPATIBILITY_DATE);
});
