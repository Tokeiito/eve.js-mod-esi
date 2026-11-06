/**
 * `POST /universe/names/` and `POST /universe/ids/` against CCP's pinned spec
 * and the recorded wire (D9, D45).
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * There is no capture of either operation's body. Every constraint is read out
 * of the pinned `2020-01-01` document (the two bodies' schemas, the request
 * bodies' bounds, the enums, the absent `x-cache-age` and the absent
 * `x-rate-limit`) and the handlers are asserted against those, not against
 * constants copied into a route. `contract/spec.js` makes that possible and
 * `assertRouteMatchesSpec` checks four of the columns in one line.
 *
 * Which of ESI's implementations answers is not in the document:
 * `contract/wire.js` `SUCCESS_KIND` recorded both as `APP_SUCCESS` in the
 * 2026-08-22 survey, and every wire assertion below reads through that record.
 *
 * The header wire is asserted through `lib/pipeline.js` `createEsiDispatch` and
 * a real listener, because these are the first public routes to declare a
 * `null` `cacheTtl` and the layer that turns that into "validators, no
 * freshness claim" is four deep. A test that built its own stack would test
 * only that stack.
 *
 * Static-data names are CCP's and used as such. The three categories eve.js
 * allocates (character, player corporation, alliance) use their allocator's
 * first id and an obviously synthetic name.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const {
  assertBody,
  assertRouteMatchesSpec,
  describeOperation,
} = require(path.join(__dirname, "../contract/spec"));
const spec = require(path.join(__dirname, "../contract/openapi.json"));
const { createEsiDispatch } = require(path.join(__dirname, "../lib/pipeline"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const { startServer, closeServer } = require(path.join(__dirname, "../server"));
const { createNameIndex } = require(path.join(__dirname, "../lib/nameIndex"));
const {
  IDS_MAX_NAMES,
  IDS_MAX_NAME_LENGTH,
  IDS_OPERATION_ID,
  IDS_PATH,
  NAMES_MAX_IDS,
  NAMES_OPERATION_ID,
  NAMES_PATH,
  PRODUCER,
  buildUniverseIds,
  buildUniverseNames,
  createUniverseIdsRoute,
  createUniverseNamesRoute,
} = require(path.join(__dirname, "../routes/names"));

/** Fixed, so nothing in the cache layer can move under a test. */
const NOW = Date.parse("2026-09-16T20:00:00Z");

// A small, real-shaped universe

const TABLES = {
  "itemTypes.types": [
    { typeID: 34, name: "Tritanium" },
    { typeID: 587, name: "Rifter" },
  ],
  "factions.records": { 500001: { factionID: 500001, name: "Caldari State" } },
  "corporations.records": {
    1000002: { corporationID: 1000002, corporationName: "CBD Corporation" },
    98000000: { corporationID: 98000000, corporationName: "Fixture Holdings" },
  },
  "agentAuthority.agentsByID": { 3008416: { agentID: 3008416, ownerName: "Fixture Agent" } },
  "characters./": { 90000021: { characterName: "Fixture Pilot" } },
  "alliances./": { 99000000: { allianceName: "Fixture Alliance" } },
  "solarSystems.solarSystems": [{ solarSystemID: 30000142, solarSystemName: "Jita" }],
  "stations.stations": [
    { stationID: 60003760, stationName: "Jita IV - Moon 4 - Caldari Navy Assembly Plant" },
  ],
};

const DUMPS = {
  "mapConstellations.jsonl": [{ _key: 20000020, name: { de: "Kimotoro", en: "Kimotoro" } }],
  "mapRegions.jsonl": [{ _key: 10000002, name: { de: "The Forge", en: "The Forge" } }],
};

function fixtureDeps(overrides = {}) {
  return {
    names: createNameIndex({
      onAmbiguous: overrides.onAmbiguous || null,
      readTable: (table, key) => ({ ...TABLES, ...(overrides.tables || {}) })[`${table}.${key}`],
      readSdeRecords: (file) => ({ ...DUMPS, ...(overrides.dumps || {}) })[file],
    }),
  };
}

const namesRouter = () =>
  createRouter([createUniverseNamesRoute(fixtureDeps()), createUniverseIdsRoute(fixtureDeps())]);

const dispatch = (request) =>
  dispatchRequest(namesRouter(), { method: "POST", query: {}, headers: {}, ...request });

/** The handler alone, which is where the refusals and the shaping are asserted. */
const names = (body, overrides) => buildUniverseNames({ body }, fixtureDeps(overrides));
const ids = (body, overrides) => buildUniverseIds({ body }, fixtureDeps(overrides));

// The route table against CCP's document

test("both descriptors agree with the pinned spec", () => {
  // scope, rateLimitGroup, cacheTtl and successStatus, one line each. Both
  // operations are public and publish neither a cache age nor a limiter group,
  // so this also asserts that the two `null`s are CCP's and not ours.
  assertRouteMatchesSpec(createUniverseNamesRoute(fixtureDeps()));
  assertRouteMatchesSpec(createUniverseIdsRoute(fixtureDeps()));
});

test("the operations are the ones the document names", () => {
  assert.equal(describeOperation("post", NAMES_PATH).operationId, NAMES_OPERATION_ID);
  assert.equal(describeOperation("post", IDS_PATH).operationId, IDS_OPERATION_ID);

  // Public: the document declares no security on either.
  assert.deepEqual(describeOperation("post", NAMES_PATH).scopes, []);
  assert.deepEqual(describeOperation("post", IDS_PATH).scopes, []);
});

test("the producer is the recorded one, not one derived from the path", () => {
  assert.equal(wire.SUCCESS_KIND["POST /universe/names"], wire.KIND.APP_SUCCESS);
  assert.equal(wire.SUCCESS_KIND["POST /universe/ids"], wire.KIND.APP_SUCCESS);
  assert.equal(PRODUCER, "app");
});

test("the request bounds are the document's, not this repository's", () => {
  const namesBody = spec.paths["/universe/names"].post.requestBody.content["application/json"].schema;
  assert.equal(namesBody.maxItems, NAMES_MAX_IDS);
  assert.equal(namesBody.minItems, 1);
  assert.equal(namesBody.uniqueItems, true);
  assert.equal(namesBody.items.type, "integer");
  assert.equal(namesBody.items.format, "int64");

  const idsBody = spec.paths["/universe/ids"].post.requestBody.content["application/json"].schema;
  assert.equal(idsBody.maxItems, IDS_MAX_NAMES);
  assert.equal(idsBody.minItems, 1);
  assert.equal(idsBody.uniqueItems, true);
  assert.equal(idsBody.items.maxLength, IDS_MAX_NAME_LENGTH);
  assert.equal(idsBody.items.minLength, 1);
});

// The bodies

test("a resolved name row satisfies the spec, and its keys are in the schema's order", () => {
  const body = names([30000142]);

  assertBody(body, describeOperation("post", NAMES_PATH));
  assert.deepEqual(body, [{ category: "solar_system", id: 30000142, name: "Jita" }]);
  // Declaration order is output order is bytes.
  assert.deepEqual(Object.keys(body[0]), ["category", "id", "name"]);
});

test("every category the index knows reaches a body with the right label", () => {
  const body = names([34, 500001, 1000002, 90000021, 99000000, 30000142, 60003760, 20000020, 10000002]);

  assert.deepEqual(
    body.map((row) => row.category),
    [
      "inventory_type",
      "faction",
      "corporation",
      "character",
      "alliance",
      "solar_system",
      "station",
      "constellation",
      "region",
    ],
  );
  assertBody(body, describeOperation("post", NAMES_PATH));
});

test("rows come back in the order they were asked about", () => {
  // Not sorted: a client walking its own request beside the answer is the
  // common shape, and the `Etag` needs the order to be stable either way.
  assert.deepEqual(names([60003760, 34, 30000142]).map((row) => row.id), [60003760, 34, 30000142]);
});

test("an id nobody has is absent, and the answer is still a 200 body", () => {
  const body = names([30000142, 30009999]);
  assert.deepEqual(body.map((row) => row.id), [30000142]);
  assertBody(body, describeOperation("post", NAMES_PATH));
});

test("an id no category claims at all resolves to an empty array, not a refusal", () => {
  const body = names([30009999]);
  assert.deepEqual(body, []);
  assertBody(body, describeOperation("post", NAMES_PATH));
});

test("an ambiguous id is absent too, and the collision reaches the log (D9)", () => {
  const collisions = [];
  const body = names([30000142], {
    onAmbiguous: (err) => collisions.push(err),
    tables: { "stations.stations": [{ stationID: 30000142, stationName: "Impossible Station" }] },
  });

  assert.deepEqual(body, []);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].name, "AmbiguousIdError");
});

test("an agent id comes back as a character, because the schema has no agent", () => {
  const body = names([3008416]);
  assert.deepEqual(body, [{ category: "character", id: 3008416, name: "Fixture Agent" }]);
  assertBody(body, describeOperation("post", NAMES_PATH));
});

// The id direction

test("a resolved id body satisfies the spec and groups by the schema's keys", () => {
  const body = ids(["Jita", "Tritanium", "The Forge"]);

  assertBody(body, describeOperation("post", IDS_PATH));
  assert.deepEqual(body, {
    inventory_types: [{ id: 34, name: "Tritanium" }],
    regions: [{ id: 10000002, name: "The Forge" }],
    systems: [{ id: 30000142, name: "Jita" }],
  });
  // Alphabetical, which is the schema's declaration order.
  assert.deepEqual(Object.keys(body), ["inventory_types", "regions", "systems"]);
});

test("a group that matched nothing is omitted rather than sent empty", () => {
  const body = ids(["Jita"]);
  assert.deepEqual(Object.keys(body), ["systems"]);
  // None of the ten is a required property, so this is a complete body.
  assertBody(body, describeOperation("post", IDS_PATH));
});

test("a request whose every name missed is an empty object", () => {
  const body = ids(["No Such Place At All"]);
  assert.deepEqual(body, {});
  assertBody(body, describeOperation("post", IDS_PATH));
});

test("an agent name comes back under agents, unlike its id under names", () => {
  const body = ids(["Fixture Agent"]);
  assert.deepEqual(body, { agents: [{ id: 3008416, name: "Fixture Agent" }] });
  assertBody(body, describeOperation("post", IDS_PATH));
});

test("the match folds case and answers with the store's spelling (D45)", () => {
  assert.deepEqual(ids(["jita"]), { systems: [{ id: 30000142, name: "Jita" }] });
  assert.deepEqual(ids(["THE FORGE"]), { regions: [{ id: 10000002, name: "The Forge" }] });
});

test("two matches in one group keep the request's order", () => {
  const body = ids(["Rifter", "Tritanium"]);
  assert.deepEqual(body.inventory_types.map((row) => row.name), ["Rifter", "Tritanium"]);
});

// The refusals

/** The refusal a handler threw, unwrapped from its `RouteRefusal`. */
function refusalOf(run) {
  try {
    run();
  } catch (err) {
    assert.equal(err.name, "RouteRefusal", `expected a RouteRefusal, got ${err.name}: ${err.message}`);
    return err.refusal;
  }
  assert.fail("expected a refusal and the handler returned a body");
  return null;
}

test("a body that is not an array is the legacy family's 400", () => {
  for (const body of [null, undefined, {}, "34", 34, true]) {
    const refusal = refusalOf(() => names(body));
    assert.equal(refusal.status, 400, `for ${JSON.stringify(body) ?? "undefined"}`);
    // The legacy family's bare `{error}`, and the application's content type.
    assert.deepEqual(Object.keys(refusal.body), ["error"]);
    assert.equal(refusal.producer, PRODUCER);
    assert.equal(refusal.headers["content-type"], wire.CONTENT_TYPE[wire.KIND.APP_ERROR]);
    // The application does not send nosniff, which is `SENDS_NOSNIFF`'s row.
    assert.equal(refusal.headers["x-content-type-options"], undefined);
  }
});

test("an empty array is refused, because the document says minItems 1", () => {
  assert.equal(refusalOf(() => names([])).status, 400);
  assert.equal(refusalOf(() => ids([])).status, 400);
});

test("one id over the published maximum is refused", () => {
  const atLimit = Array.from({ length: NAMES_MAX_IDS }, (_, i) => 30000142 + i);
  // The limit itself is accepted: an off-by-one here is a client that cannot
  // send the batch CCP documents.
  assert.deepEqual(names(atLimit).map((row) => row.id), [30000142]);
  assert.equal(refusalOf(() => names([...atLimit, 99999999])).status, 400);
});

test("one name over the published maximum is refused", () => {
  const atLimit = Array.from({ length: IDS_MAX_NAMES }, (_, i) => `Name ${i}`);
  assert.deepEqual(ids(atLimit), {});
  assert.equal(refusalOf(() => ids([...atLimit, "One More"])).status, 400);
});

test("a duplicate is refused, because the document says uniqueItems", () => {
  // Being more permissive than ESI is as much a fidelity failure as being less:
  // a client's tests would pass here and fail against Tranquility.
  assert.equal(refusalOf(() => names([30000142, 30000142])).status, 400);
  assert.equal(refusalOf(() => ids(["Jita", "Jita"])).status, 400);
});

test("an element that is not a positive safe integer is refused", () => {
  for (const bad of ["30000142", 1.5, -1, 0, null, {}, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(refusalOf(() => names([bad])).status, 400, `for ${JSON.stringify(bad)}`);
  }
});

test("a name outside the document's length bounds is refused", () => {
  assert.equal(refusalOf(() => ids([""])).status, 400);
  assert.equal(refusalOf(() => ids(["x".repeat(IDS_MAX_NAME_LENGTH + 1)])).status, 400);
  assert.equal(refusalOf(() => ids([34])).status, 400);
  // The bound itself is accepted.
  assert.deepEqual(ids(["x".repeat(IDS_MAX_NAME_LENGTH)]), {});
});

test("a source that cannot be read is a 500, never an empty answer", async () => {
  // D42's rule, one endpoint further on: "this server has no such type" and
  // "this build cannot see types at all" must not look alike.
  const broken = createRouter([
    createUniverseNamesRoute({
      names: createNameIndex({
        readTable: (table) => {
          if (table === "itemTypes") throw new Error("fixture: unreadable");
          return TABLES[`${table}./`] || [];
        },
        readSdeRecords: () => [],
      }),
    }),
  ]);

  const result = await dispatchRequest(
    broken,
    { method: "POST", pathname: NAMES_PATH, query: {}, headers: {}, body: [34] },
    { logError: () => {} },
  );
  assert.equal(result.status, 500);
});

// Through the router

test("both routes answer under every version prefix and the bare path", async () => {
  for (const prefix of ["", "/latest", "/v1", "/legacy", "/dev"]) {
    const result = await dispatch({ pathname: `${prefix}${NAMES_PATH}`, body: [30000142] });
    assert.equal(result.status, 200, `${prefix || "(bare)"}${NAMES_PATH}`);
    assert.equal(result.body[0].name, "Jita");
  }
});

test("a trailing slash is the same route", async () => {
  const result = await dispatch({ pathname: "/latest/universe/names/", body: [30000142] });
  assert.equal(result.status, 200);
});

test("GET is a 405 naming POST, not a 404", async () => {
  const result = await dispatch({ method: "GET", pathname: NAMES_PATH });
  assert.equal(result.status, 405);
  // The router carries `allow` as a list, which `server.js` joins on the way out.
  assert.deepEqual(result.headers.allow, ["POST"]);
});

// The wire, through the whole stack

async function listener(t) {
  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: createEsiDispatch(namesRouter(), { now: () => NOW }),
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));
  return handle;
}

const postTo = (handle, wirePath, body) =>
  fetch(`http://127.0.0.1:${handle.port}${wirePath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("the success is the application's, byte for byte", async (t) => {
  const handle = await listener(t);
  const response = await postTo(handle, `/latest${NAMES_PATH}/`, [30000142]);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), wire.CONTENT_TYPE[wire.KIND.APP_SUCCESS]);

  const text = await response.text();
  // The application writes no trailing newline, one byte of content-length on
  // every response.
  assert.equal(text.endsWith("\n"), false);
  assert.equal(
    text,
    serializeBody([{ category: "solar_system", id: 30000142, name: "Jita" }], PRODUCER).toString("utf8"),
  );
});

test("a route with no published TTL sends validators and no freshness claim", async (t) => {
  const handle = await listener(t);
  const response = await postTo(handle, `/latest${NAMES_PATH}/`, [30000142]);

  // `lib/cache.js`: a `null` cacheTtl on a public route is an `Etag` and a
  // `Last-Modified` with no `Cache-Control` and no `Expires`. These are the first
  // public routes to take that path; CCP publishes no `x-cache-age` for them.
  assert.notEqual(response.headers.get("etag"), null);
  assert.notEqual(response.headers.get("last-modified"), null);
  assert.equal(response.headers.get("cache-control"), null);
  assert.equal(response.headers.get("expires"), null);
});

test("the body's names are translated text, so the Vary carries the fourth line", async (t) => {
  const handle = await listener(t);
  const response = await postTo(handle, `/latest${NAMES_PATH}/`, [30000142]);

  assert.equal(
    response.headers.get("vary"),
    wire.VARY_LOCALIZED_BODY.join(", "),
    "an application route whose body carries translated text repeats Accept-Language",
  );
});

test("a refused body is the application's 400 on the wire", async (t) => {
  const handle = await listener(t);
  const response = await postTo(handle, `/latest${NAMES_PATH}/`, { not: "an array" });

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("content-type"), wire.CONTENT_TYPE[wire.KIND.APP_ERROR]);
  assert.equal(response.headers.get("x-content-type-options"), null);

  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["error"]);
});

test("a body that is not JSON at all is the same refusal, not a transport error", async (t) => {
  const handle = await listener(t);
  const response = await fetch(`http://127.0.0.1:${handle.port}/latest${IDS_PATH}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ this is not json",
  });

  // `server.js` parseJsonBody answers `null` and keeps the bytes, so that a
  // malformed body is the route's refusal rather than the transport's.
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("content-type"), wire.CONTENT_TYPE[wire.KIND.APP_ERROR]);
});
