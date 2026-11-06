/**
 * The three corporation routes of the asset family, and the gate that makes
 * them different from their character twins.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Most bodies are not under test here. They are `buildAssets`,
 * `buildBlueprints` and `buildIndustryJobs`, shared with the character routes
 * and covered in `test/assetsContract.test.js`,
 * `test/blueprintsContract.test.js` and `test/industryContract.test.js`. The
 * exception is where the two documents disagree: the character job body has
 * `station_id` where the corporation one has `location_id`.
 *
 * This file covers:
 *
 *   the gate       two refusals, three columns each: is the caller in this
 *                  corporation, and do they hold the role CCP's
 *                  `x-required-roles` declares. Both have observed bytes.
 *   the roles      read out of the pinned document rather than compared against
 *                  a copy, because a route gated on the wrong role is either
 *                  shut to everybody or open to the wrong people.
 *   the owner      a corporation route reads the path, where every character
 *                  route reads the claim. That is safe because of the gate,
 *                  not the parameter.
 *   the surfaces   a corporation body may carry `CorpSAG1`, which the character
 *                  enum does not publish, and may not carry `CorpseBay`: the
 *                  same flag reaches a corporation as `CrateLoot`, CCP's own
 *                  second name for the id (D46).
 *   pagination     the corporation industry route paginates and the character
 *                  one does not, per CCP's document.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const spec = require(path.join(__dirname, "../contract/openapi.json"));
const wire = require(path.join(__dirname, "../contract/wire"));
const {
  assertBody,
  assertRouteMatchesSpec,
  describeOperation,
} = require(path.join(__dirname, "../contract/spec"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const { createAssetStore } = require(path.join(__dirname, "../lib/assetStore"));
const { createIndustryStore } = require(path.join(__dirname, "../lib/industryStore"));
const { MISSING_REQUIRED_ROLE, NOT_IN_CORPORATION } = require(path.join(__dirname, "../lib/errors"));
const { roleBitFor } = require(path.join(__dirname, "../routes/roles"));
const {
  CORPORATION_ASSETS_OPERATION_ID,
  CORPORATION_ASSETS_PATH,
  CORPORATION_ASSETS_ROLES,
  CORPORATION_ASSETS_SCOPE,
  createCorporationAssetsRoute,
} = require(path.join(__dirname, "../routes/assets"));
const {
  CORPORATION_BLUEPRINTS_OPERATION_ID,
  CORPORATION_BLUEPRINTS_PATH,
  CORPORATION_BLUEPRINTS_ROLES,
  CORPORATION_BLUEPRINTS_SCOPE,
  createCorporationBlueprintsRoute,
} = require(path.join(__dirname, "../routes/blueprints"));
const {
  CORPORATION_JOBS_OPERATION_ID,
  CORPORATION_JOBS_PATH,
  CORPORATION_JOBS_ROLES,
  CORPORATION_JOBS_SCOPE,
  createCorporationIndustryJobsRoute,
} = require(path.join(__dirname, "../routes/industry"));

/** eve.js's own first allocated ids. Synthetic, and obviously so. */
const CALLER = 90000021;
const CORPORATION = 98000000;
const OTHER_CORPORATION = 98000001;
const STATION = 60003760;

const DIRECTOR = roleBitFor("Director");
const FACTORY_MANAGER = roleBitFor("Factory_Manager");

/** A corporation stack in hangar division 1, which is `CorpSAG1` (flag 115). */
const ITEMS = {
  1990000050: {
    itemID: 1990000050, typeID: 34, ownerID: CORPORATION, locationID: STATION,
    flagID: 115, quantity: 400, stacksize: 400, singleton: 0, categoryID: 4,
  },
  1990000051: {
    itemID: 1990000051, typeID: 691, ownerID: CORPORATION, locationID: STATION,
    flagID: 115, quantity: -1, stacksize: 1, singleton: 1, categoryID: 9,
  },
  // A member's own item, which is not the corporation's.
  1990000052: {
    itemID: 1990000052, typeID: 34, ownerID: CALLER, locationID: STATION,
    flagID: 4, quantity: 1, stacksize: 1, singleton: 0, categoryID: 4,
  },
};

const JOBS = {
  jobs: {
    500000010: {
      jobID: 500000010, ownerID: CORPORATION, installerID: CALLER, activityID: 1,
      blueprintID: 1990000051, blueprintTypeID: 691, blueprintLocationID: STATION,
      outputLocationID: STATION, facilityID: STATION, stationID: STATION,
      status: 1, runs: 5, licensedRuns: 10, successfulRuns: 0,
      cost: 500, probability: 1, productTypeID: 587, timeInSeconds: 3600,
      startDate: String(Date.parse("2026-09-16T08:00:00Z")),
      endDate: String(Date.parse("2026-09-16T09:00:00Z")),
      pauseDate: null, completedCharacterID: 0, completedDate: null,
    },
  },
};

const TABLES = {
  "items./": ITEMS,
  "stations.stations": [{ stationID: STATION }],
  "solarSystems.solarSystems": [],
  "industryBlueprintState./": { records: {} },
};

/**
 * A runtime double for the gate: the caller's corporation and their four role
 * masks, through the two non-writing accessors `routes/roles.js` composes.
 */
function fixtureRuntime({ corporationId = CORPORATION, roles = DIRECTOR } = {}) {
  return {
    peekCharacterRecord: (characterId, { project }) =>
      (characterId === CALLER ? project({ corporationID: corporationId }) : null),
    getCorporationMember: () => ({
      roles: String(roles),
      rolesAtBase: "0",
      rolesAtHQ: "0",
      rolesAtOther: "0",
    }),
    getCorporationRecord: () => ({ ceoID: 0 }),
  };
}

function deps(options = {}) {
  return {
    runtime: fixtureRuntime(options),
    assets: createAssetStore({
      readTable: (table, key) => {
        const slot = `${table}.${key}`;
        if (!(slot in TABLES)) throw new Error(`fixture: no ${slot}`);
        return TABLES[slot];
      },
    }),
    industry: createIndustryStore({ readTable: () => JOBS }),
  };
}

/** A verified credential, in the shape `lib/bearerCredential.js` builds. */
const verified = (scope) => ({
  presented: true,
  claims: Object.freeze({ characterId: CALLER, scopes: Object.freeze([scope]) }),
  refusal: null,
});

/** The three routes, as a table, so the gate runs where it really runs. */
const ROUTES = [
  {
    name: CORPORATION_ASSETS_OPERATION_ID,
    path: CORPORATION_ASSETS_PATH,
    scope: CORPORATION_ASSETS_SCOPE,
    roles: CORPORATION_ASSETS_ROLES,
    bit: DIRECTOR,
    factory: createCorporationAssetsRoute,
  },
  {
    name: CORPORATION_BLUEPRINTS_OPERATION_ID,
    path: CORPORATION_BLUEPRINTS_PATH,
    scope: CORPORATION_BLUEPRINTS_SCOPE,
    roles: CORPORATION_BLUEPRINTS_ROLES,
    bit: DIRECTOR,
    factory: createCorporationBlueprintsRoute,
  },
  {
    name: CORPORATION_JOBS_OPERATION_ID,
    path: CORPORATION_JOBS_PATH,
    scope: CORPORATION_JOBS_SCOPE,
    roles: CORPORATION_JOBS_ROLES,
    bit: FACTORY_MANAGER,
    factory: createCorporationIndustryJobsRoute,
  },
];

const wirePath = (route, corporationId) =>
  `/latest${route.path.replace(":corporation_id", String(corporationId))}`;

async function request(route, { corporationId = CORPORATION, options = {}, query = {} } = {}) {
  const router = createRouter([route.factory(deps(options))]);
  return dispatchRequest(
    router,
    {
      method: "GET",
      pathname: wirePath(route, corporationId),
      query,
      headers: {},
      credential: verified(route.scope),
    },
    { logError: () => {} },
  );
}

// The document

test("all three descriptors agree with the pinned spec", () => {
  for (const route of ROUTES) {
    const contract = assertRouteMatchesSpec(route.factory(deps()));
    assert.equal(contract.operationId, route.name);
    assert.deepEqual(contract.scopes, [route.scope]);
  }
});

test("each route's declared roles are CCP's x-required-roles, not a copy", () => {
  // A route gated on the wrong role is either shut to everybody or open to the
  // wrong people, and neither shows up in a body.
  for (const route of ROUTES) {
    const specPath = route.path.replace(":corporation_id", "{corporation_id}");
    const published = spec.paths[specPath].get["x-required-roles"];
    assert.deepEqual([...route.roles], published, `${route.name} declares the wrong roles`);
  }
});

test("the industry pair disagree about the location's key, and CCP is why", async () => {
  // Same row, same value, and a key the two documents spell differently:
  // `station_id` here would be a required field missing and an undeclared one
  // sent.
  const route = ROUTES.find((entry) => entry.name === CORPORATION_JOBS_OPERATION_ID);
  const result = await request(route, { options: { roles: FACTORY_MANAGER } });
  assert.equal(result.status, 200);

  const onTheWire = JSON.parse(serializeBody(result.body, "app").toString("utf8"));
  const contract = describeOperation("get", CORPORATION_JOBS_PATH);
  assertBody(onTheWire, contract);

  const [job] = onTheWire;
  assert.equal(job.location_id, STATION);
  assert.equal("station_id" in job, false);

  // Field order is output order, so the new key has to land in its own seat.
  assert.deepEqual(
    Object.keys(job),
    Object.keys(contract.schema.items.properties).filter((key) => key in job),
  );
});

test("the industry pair disagree about pagination, and CCP is why", () => {
  // The corporation operation declares a page parameter and the character one
  // does not.
  const corp = describeOperation("get", CORPORATION_JOBS_PATH);
  const char = describeOperation("get", "/characters/:character_id/industry/jobs");

  assert.notEqual(corp.queryParameters.page, undefined);
  assert.equal(char.queryParameters.page, undefined);
  assert.equal(createCorporationIndustryJobsRoute(deps()).pageSize, 1000);
});

test("assets and blueprints ask for Director, and jobs asks for Factory_Manager", () => {
  // Stated as a test because it is the one place the three routes differ in a
  // way that is invisible in every body they send.
  assert.deepEqual([...CORPORATION_ASSETS_ROLES], ["Director"]);
  assert.deepEqual([...CORPORATION_BLUEPRINTS_ROLES], ["Director"]);
  assert.deepEqual([...CORPORATION_JOBS_ROLES], ["Factory_Manager"]);
  assert.notEqual(DIRECTOR, FACTORY_MANAGER);
});

test("every route declares a subject, and would not compile without one", () => {
  for (const route of ROUTES) {
    const descriptor = route.factory(deps());
    assert.equal(typeof descriptor.subject, "function");

    const { subject, ...withoutSubject } = descriptor;
    assert.throws(
      () => createRouter([withoutSubject]),
      /says nothing about who may read that entity/,
      `${route.name} compiled with no subject`,
    );
  }
});

// The gate

test("a director of this corporation is let through", async () => {
  for (const route of ROUTES) {
    const result = await request(route, { options: { roles: route.bit } });
    assert.equal(result.status, 200, `${route.name} refused the role it asks for`);
  }
});

test("a caller in another corporation is refused, and the handler never runs", async () => {
  for (const route of ROUTES) {
    const result = await request(route, {
      corporationId: OTHER_CORPORATION,
      options: { roles: route.bit },
    });

    assert.equal(result.status, 403, route.name);
    assert.equal(result.body.error, NOT_IN_CORPORATION);
    // The application's error shape, which follows from the producer.
    assert.equal(result.headers["content-type"], wire.CONTENT_TYPE[wire.KIND.APP_ERROR]);
  }
});

test("a member without the role gets the role refusal, byte for byte", async () => {
  for (const route of ROUTES) {
    const result = await request(route, { options: { roles: 0n } });

    assert.equal(result.status, wire.REQUIRED_ROLE_REFUSAL.status, route.name);
    assert.equal(result.body.error, MISSING_REQUIRED_ROLE);
    assert.equal(result.body.error, wire.REQUIRED_ROLE_REFUSAL.body);
    // The `(s)` is CCP's and it is bytes: 40 characters, not "required roles".
    assert.equal(
      Buffer.byteLength(JSON.stringify(result.body)),
      wire.REQUIRED_ROLE_REFUSAL.contentLength,
    );
  }
});

test("a Factory_Manager does not get into the Director routes", async () => {
  // The gate is per role, not per corporation membership: holding one
  // operation's role is not holding another's.
  const assets = ROUTES.find((route) => route.name === CORPORATION_ASSETS_OPERATION_ID);
  const blueprints = ROUTES.find((route) => route.name === CORPORATION_BLUEPRINTS_OPERATION_ID);

  assert.equal((await request(assets, { options: { roles: FACTORY_MANAGER } })).status, 403);
  assert.equal((await request(blueprints, { options: { roles: FACTORY_MANAGER } })).status, 403);
});

test("a Director does get into the Factory_Manager route, and upstream is why", async () => {
  // Not a hole in the gate: `routes/roles.js` `readMemberRoles` reproduces
  // eve.js's own director short-circuit, which grants a director (and a CEO) the
  // full administrative mask at read time regardless of what is persisted.
  // Factory_Manager is in that mask, so a director does hold it, as in EVE, where
  // a director has every corporation role.
  //
  // Asserted explicitly because the opposite assertion is the intuitive one, and
  // writing it would "fix" a gate that is already faithful.
  const jobs = ROUTES.find((route) => route.name === CORPORATION_JOBS_OPERATION_ID);
  assert.equal((await request(jobs, { options: { roles: DIRECTOR } })).status, 200);
});

test("a malformed corporation id is answered as a corporation the caller is not in", async () => {
  // A divergence stated in routes/roles.js: real ESI refuses with a coercion 400
  // before asking who is calling, and this replica answers the membership 403
  // rather than inventing the headers of a refusal nobody has observed.
  for (const segment of ["abc", "0", "007", "1.5e3", "-1"]) {
    const result = await request(ROUTES[0], {
      corporationId: segment,
      options: { roles: DIRECTOR },
    });
    assert.equal(result.status, 403, `for ${JSON.stringify(segment)}`);
    assert.equal(result.body.error, NOT_IN_CORPORATION);
  }
});

test("the scope gate still runs in front of the subject check", async () => {
  // Whether a credential verifies is decided in front of the router, and whether
  // a route required one after it. A caller with the wrong scope must never reach
  // the role read.
  const route = ROUTES[0];
  const router = createRouter([route.factory(deps())]);
  const result = await dispatchRequest(
    router,
    {
      method: "GET",
      pathname: wirePath(route, CORPORATION),
      query: {},
      headers: {},
      credential: {
        presented: true,
        claims: Object.freeze({ characterId: CALLER, scopes: Object.freeze(["esi-wrong.scope.v1"]) }),
        refusal: null,
      },
    },
    { logError: () => {} },
  );

  // A 401, not a 403 (D31): a missing scope is "Unauthorized" and a wrong
  // character is the application's 403. The gate never ran, so the membership
  // refusal is not what comes back.
  assert.equal(result.status, 401);
  assert.notEqual(result.body.error, NOT_IN_CORPORATION, "the scope refusal, not the membership one");
});

// The bodies, only where they differ from the character twins

test("the corporation asset body carries a division flag the character enum lacks", async () => {
  const result = await request(ROUTES[0], { options: { roles: DIRECTOR } });

  assertBody(result.body, describeOperation("get", CORPORATION_ASSETS_PATH));
  const stack = result.body.find((row) => row.item_id === 1990000050);
  assert.equal(stack.location_flag, "CorpSAG1");
  assert.equal(stack.quantity, 400);
});

test("a member's own item is not the corporation's", async () => {
  const result = await request(ROUTES[0], { options: { roles: DIRECTOR } });
  const ids = result.body.map((row) => row.item_id);

  assert.ok(!ids.includes(1990000052), "a member's personal stack reached the corporation's assets");
  assert.deepEqual(ids, [1990000050, 1990000051]);
});

test("the corporation blueprint body uses the same enum as its assets body", async () => {
  // The corporation pair publish one 125-value enum between them, unlike the
  // character pair, which differ by thirteen.
  const result = await request(ROUTES[1], { options: { roles: DIRECTOR } });

  assertBody(result.body, describeOperation("get", CORPORATION_BLUEPRINTS_PATH));
  assert.equal(result.body[0].location_flag, "CorpSAG1");
});

test("a corporation job reports the corporation as owner and the member as installer", async () => {
  // CCP's `installer_id` is the field for exactly this distinction: eve.js
  // stamps `ownerID` with whoever the job was installed for.
  const result = await request(ROUTES[2], { options: { roles: FACTORY_MANAGER } });

  assert.equal(result.status, 200);
  assert.equal(result.body[0].job_id, 500000010);
  assert.equal(result.body[0].installer_id, CALLER);
});

test("X-Pages is sent on all three, including the industry one", async () => {
  // The character industry route sends none, because it does not paginate.
  for (const route of ROUTES) {
    const result = await request(route, { options: { roles: route.bit } });
    assert.equal(result.headers["x-pages"], "1", route.name);
  }
});
