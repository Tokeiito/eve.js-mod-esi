/**
 * The three contact buckets: the contract.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Written from CCP's document before the handler, then from the 2026-08-25
 * capture for the half OpenAPI has no vocabulary for. There is no golden
 * recording: a recording of any of these bodies would be a real pilot's or
 * corporation's standings list, which is why `contract/golden/index.json`
 * carries all three in its `exempt` map rather than as files.
 *
 * The spec is authoritative for the bodies, and shows the three buckets do not
 * share one item schema. All three require the same three fields, and the
 * optional set shrinks as the owner gets larger: `is_blocked` exists on the
 * character bucket only, `is_watched` on the character and corporation buckets
 * only, and the alliance bucket has neither. A replica that projected one shape
 * three times would send the alliance bucket a field CCP does not declare.
 *
 * The wire is authoritative for what the spec cannot express: alphabetical
 * field order, that an inapplicable optional is omitted rather than sent as
 * `false`, that `X-Pages` is present even when the whole collection fits on one
 * page, and that the corporation bucket's page size is 200, not the 1000 the
 * market routes showed.
 *
 * The vendor tree is authoritative for two things neither of the others can
 * answer: eve.js's four owner `typeID`s, which are how a contact id becomes a
 * `contact_type`, and the three stores the rows come out of.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const spec = require(path.join(__dirname, "../contract/spec"));
const { SpecContractError, assertBody, describeOperation } = spec;
const wire = require(path.join(__dirname, "../contract/wire"));
const { SUBJECT, createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const { REPO_ROOT, vendorOnly } = require(path.join(__dirname, "vendorTree"));

const CONTACTS_ROUTE = path.join(__dirname, "..", "routes", "contacts.js");

/**
 * What the client receives, parsed back.
 *
 * `standing` is `format: double` and is marked with `double()`, so it is a
 * marker object on the handler's return value until `serializeBody` renders it.
 * Asking the spec whether that object is a number gets "no", and comparing it
 * to `5` gets "no" as well, so every schema check and value comparison below
 * reads the serialized body, as `test/entitiesContract.test.js` does for
 * `security_status`.
 *
 * A parse cannot see the point of the marking (`5` and `5.0` parse to the same
 * number), so the bytes have their own test at the bottom of this file.
 */
const wireBody = (result) => JSON.parse(serializeBody(result.body, result.producer));

/**
 * CCP's own `CharacterID`, `CorporationID` and `AllianceID` examples from the
 * pinned spec, not the entities the capture was taken against. These tests need
 * a character, a corporation and an alliance, and `contract/` holds nobody's
 * account data (D23).
 */
const CHARACTER_ID = 90000001;
const CORPORATION_ID = 98777771;
const ALLIANCE_ID = 99000001;

const CHARACTER_PATH = `/latest/characters/${CHARACTER_ID}/contacts/`;
const CORPORATION_PATH = `/latest/corporations/${CORPORATION_ID}/contacts/`;
const ALLIANCE_PATH = `/latest/alliances/${ALLIANCE_ID}/contacts/`;

const CHARACTER = () => describeOperation("get", CHARACTER_PATH);
const CORPORATION = () => describeOperation("get", CORPORATION_PATH);
const ALLIANCE = () => describeOperation("get", ALLIANCE_PATH);

const CHARACTER_SCOPE = "esi-characters.read_contacts.v1";
const CORPORATION_SCOPE = "esi-corporations.read_contacts.v1";
const ALLIANCE_SCOPE = "esi-alliances.read_contacts.v1";

/** The three buckets. */
const BUCKETS = [
  {
    bucket: "character",
    contract: CHARACTER,
    wirePath: "/characters/{character_id}/contacts",
    routePath: "/characters/:character_id/contacts",
    operationId: "GetCharactersCharacterIdContacts",
    requested: `/characters/${CHARACTER_ID}/contacts/`,
    scope: CHARACTER_SCOPE,
    group: "char-social",
    maxTokens: 600,
    optional: ["is_blocked", "is_watched", "label_ids"],
  },
  {
    bucket: "corporation",
    contract: CORPORATION,
    wirePath: "/corporations/{corporation_id}/contacts",
    routePath: "/corporations/:corporation_id/contacts",
    operationId: "GetCorporationsCorporationIdContacts",
    requested: `/corporations/${CORPORATION_ID}/contacts/`,
    scope: CORPORATION_SCOPE,
    group: "corp-social",
    maxTokens: 300,
    optional: ["is_watched", "label_ids"],
  },
  {
    bucket: "alliance",
    contract: ALLIANCE,
    wirePath: "/alliances/{alliance_id}/contacts",
    routePath: "/alliances/:alliance_id/contacts",
    operationId: "GetAlliancesAllianceIdContacts",
    requested: `/alliances/${ALLIANCE_ID}/contacts/`,
    scope: ALLIANCE_SCOPE,
    group: "alliance-social",
    maxTokens: 300,
    optional: ["label_ids"],
  },
];

/** The item schema of an array-bodied operation. */
const itemsOf = (contract) => contract.schema.items;

// What the spec says

test("all three buckets are arrays of objects requiring the same three fields", () => {
  for (const { bucket, contract } of BUCKETS) {
    const described = contract();
    assert.equal(described.schema.type, "array", `${bucket} is an array body`);

    const item = itemsOf(described);
    assert.equal(item.type, "object");
    assert.deepEqual(
      [...item.required].sort(),
      ["contact_id", "contact_type", "standing"],
      `${bucket} requires a different three`,
    );

    // The array-bodied operation's quirk: `requiredKeys` describes an object body
    // and there is none, so a test that read it would assert nothing.
    assert.deepEqual(described.requiredKeys, [], `${bucket} has no top-level object`);
  }
});

test("the optional set shrinks as the owner grows, and the alliance has no is_watched", () => {
  // The three buckets are not one shape, and this is the difference a replica
  // has to reproduce: projecting `is_watched` into an alliance body sends a field
  // CCP does not declare there.
  for (const { bucket, contract, optional } of BUCKETS) {
    const item = itemsOf(contract());
    const declared = Object.keys(item.properties)
      .filter((name) => !item.required.includes(name))
      .sort();

    assert.deepEqual(declared, optional, `${bucket}'s optional fields`);
  }

  assert.ok(!Object.keys(itemsOf(ALLIANCE()).properties).includes("is_watched"));
  assert.ok(!Object.keys(itemsOf(CORPORATION()).properties).includes("is_blocked"));
});

test("contact_type is one four-value enum, and `faction` is declared but unobserved", () => {
  const [first] = BUCKETS;
  const vocabulary = itemsOf(first.contract()).properties.contact_type.enum;

  assert.deepEqual(vocabulary, ["character", "corporation", "alliance", "faction"]);

  // One vocabulary, not three that happen to agree, so a re-pin cannot change it
  // for one bucket and not the others.
  for (const { bucket, contract } of BUCKETS) {
    assert.deepEqual(itemsOf(contract()).properties.contact_type.enum, vocabulary, bucket);
  }

  // Three of the four were seen on the wire. `faction` was not, and it is emitted
  // anyway: it is a declared member of CCP's own enum and eve.js can say when an
  // id is a faction, so withholding it would describe a faction contact as
  // nothing at all.
  assert.deepEqual(wire.CONTACTS.contactTypesObserved, ["character", "corporation", "alliance"]);
  assert.ok(vocabulary.includes("faction"));
});

test("standing is a double with no bounds, and contact_id an int64", () => {
  for (const { bucket, contract } of BUCKETS) {
    const { properties } = itemsOf(contract());

    assert.equal(properties.standing.type, "number", bucket);
    assert.equal(properties.standing.format, "double", bucket);
    assert.equal(properties.standing.minimum, undefined, "no floor, so no clamp to -10");
    assert.equal(properties.standing.maximum, undefined, "and no ceiling");

    assert.equal(properties.contact_id.type, "integer", bucket);
    assert.equal(properties.contact_id.format, "int64", bucket);
  }
});

test("the scopes, the buckets and the five-minute TTL", () => {
  for (const { bucket, contract, scope, group, maxTokens } of BUCKETS) {
    const described = contract();

    assert.deepEqual(described.scopes, [scope], bucket);
    assert.equal(described.cacheAgeSeconds, 300, `${bucket}: five minutes, not an hour`);
    assert.equal(described.clientCacheTtlSeconds, 300, bucket);
    assert.deepEqual(described.rateLimit, { group, maxTokens, windowSize: "15m" }, bucket);
    assert.deepEqual(described.statuses, [200], `${bucket} declares no error status`);
  }
});

test("no contacts operation declares x-required-roles", () => {
  // `/corporations/{id}/structures/` publishes `x-required-roles:
  // ["Station_Manager"]` and this replica enforces it. These three publish
  // nothing, so there is no role gate to enforce, and inventing one would refuse
  // callers CCP admits, even though eve-nexum's own source comments guess that
  // reading corporation contacts needs the Contact Manager role.
  const document = spec.loadSpec();
  for (const { bucket, wirePath } of BUCKETS) {
    assert.equal(document.paths[wirePath].get["x-required-roles"], undefined, bucket);
  }
});

test("every bucket declares ?page as an int32 with a minimum of 1, and X-Pages on the 200", () => {
  const document = spec.loadSpec();

  for (const { bucket, wirePath } of BUCKETS) {
    const operation = document.paths[wirePath].get;
    const page = operation.parameters.find((parameter) => parameter.name === "page");

    assert.ok(page, `${bucket} declares no page parameter`);
    assert.equal(page.in, "query");
    assert.equal(page.schema.type, "integer");
    assert.equal(page.schema.format, "int32");
    assert.equal(page.schema.minimum, 1);

    assert.ok(
      operation.responses["200"].headers["X-Pages"],
      `${bucket}'s 200 does not declare X-Pages`,
    );
  }
});

test("/v2/ is the prefix the consumer uses, and it is not a different operation", () => {
  // The /v2/ prefix resolves, and so do the other eight: every prefix pins to
  // 2020-01-01 (D4), so which one a client picks changes nothing about which
  // operation answers.
  for (const { operationId, requested } of BUCKETS) {
    for (const prefix of wire.VERSION_PREFIXES) {
      assert.equal(
        describeOperation("get", `/${prefix}${requested}`).operationId,
        operationId,
        `/${prefix}/ does not reach ${operationId}`,
      );
    }
  }
});

// What the wire says

test("all three buckets are the application, observed", () => {
  for (const { routePath } of BUCKETS) {
    assert.equal(wire.SUCCESS_KIND[routePath], wire.KIND.APP_SUCCESS, routePath);
  }
  assert.equal(wire.CONTENT_TYPE[wire.KIND.APP_SUCCESS], "application/json; charset=UTF-8");
  assert.equal(wire.TRAILING_NEWLINE[wire.KIND.APP_SUCCESS], false);
});

test("the field order is alphabetical, and the optional field is what proves it", () => {
  const order = wire.CONTACTS.fieldOrder;

  assert.deepEqual([...order].sort(), [...order]);

  // `is_watched` sits between `contact_type` and `standing` on the wire, which is
  // what alphabetical predicts and what the pinned document's declaration order
  // does not. The two orders are indistinguishable until an optional field lands
  // in the middle of them; this is that field.
  assert.equal(order.indexOf("is_watched"), 2);
  assert.deepEqual(wire.CONTACTS.required, ["contact_id", "contact_type", "standing"]);
});

test("an inapplicable optional is omitted, never sent as false", () => {
  assert.deepEqual(wire.CONTACTS.omittedWhenAbsent, ["is_watched"]);
  assert.deepEqual(wire.CONTACTS.neverObserved, ["label_ids"]);

  // The opposite rule, from the same capture and producer: an empty `roles[]` is
  // sent as `[]`. Both recorded, neither generalised.
  assert.equal(wire.CHARACTER_ROLES.emptyArrayIsSent, true);
});

test("X-Pages is sent on a single-page collection", () => {
  // Omitting `X-Pages` on a one-page body would be plausible, but it is not what
  // CCP does, and it was worth capturing rather than assuming:
  // /markets/prices/ is a large public collection that sends no X-Pages at all,
  // so "a one-page body omits it" was a live reading of this surface until the
  // 2026-08-25 run.
  assert.equal(wire.AUTHENTICATED_PAGING.sendsXPagesOnSinglePage, true);
  assert.equal(wire.AUTHENTICATED_PAGING.singlePageValue, "1");
});

test("the corporation bucket's page size is 200, and 200 is not the market constant", () => {
  const observed = wire.CONTACTS.pageSize["/corporations/{corporation_id}/contacts"];

  // 200 rows with X-Pages: 2: a full page with more behind it, which fixes the
  // size and cannot be read any other way.
  assert.equal(observed, 200);
  assert.notEqual(observed, wire.PAGINATION.pageSize, "1000 does not generalise");

  // The other two are lower bounds rather than values, which is why the route
  // declares its own number for them and says so.
  assert.equal(wire.CONTACTS.pageSize["/alliances/{alliance_id}/contacts"], null);
  assert.equal(wire.CONTACTS.pageSize["/characters/{character_id}/contacts"], null);
});

test("the wire and the spec agree about every bucket's rate-limit group", () => {
  for (const { bucket, contract, wirePath } of BUCKETS) {
    assert.equal(wire.CONTACTS.rateLimitGroup[wirePath], contract().rateLimit.group, bucket);
  }
});

test("the cross-entity refusal is this route's, and it names the relationship", () => {
  const refusal = wire.CROSS_ENTITY_REFUSAL;

  assert.equal(refusal.status, 403);
  assert.equal(refusal.body, "Character is not in the corporation");
  assert.equal(refusal.contentLength, 47);
  assert.equal(refusal.kind, wire.KIND.APP_ERROR);
  assert.equal(refusal.rateLimitGroup, "corp-social", "this route's own bucket");
  assert.equal(refusal.cost, 5);

  // It says "is not in the corporation", not "is not allowed". It is
  // corporation-shaped, which is why the alliance bucket cannot borrow it.
  assert.match(refusal.body, /in the corporation$/);
});

// What a plausible-but-wrong body does

test("a null standing is a contract failure, which is where the consumer breaks", () => {
  // eve-nexum inserts these with UNNEST($2::text[], $3::int[], $4::real[]), so a
  // null standing throws at the database layer and aborts the whole bucket's
  // transaction. There is no per-row tolerance downstream, so there is none here.
  assert.throws(
    () => assertBody(
      [{ contact_id: 90000002, contact_type: "character", standing: null }],
      CHARACTER(),
    ),
    (err) => err instanceof SpecContractError && /is null/.test(err.message),
  );
});

test("a missing required field is a contract failure on every bucket", () => {
  for (const { bucket, contract } of BUCKETS) {
    assert.throws(
      () => assertBody([{ contact_id: 90000002, standing: 5 }], contract()),
      (err) => /contact_type/.test(err.message),
      `${bucket} accepted a row with no contact_type`,
    );
  }
});

test("a contact_type outside the enum is a contract failure", () => {
  // The mistake the owner-type table exists to avoid: an id whose kind the game
  // could not name, published under a plausible-reading guess.
  assert.throws(
    () => assertBody([{ contact_id: 3019491, contact_type: "agent", standing: 0 }], CHARACTER()),
    (err) => /is not one of/.test(err.message),
  );
});

test("is_watched on an alliance row is a contract failure", () => {
  // eve.js carries `inWatchlist` on an alliance contact and CCP does not declare
  // it there, so the alliance projection drops a field it has.
  const row = {
    contact_id: 98000001, contact_type: "corporation", is_watched: true, standing: -10,
  };

  assertBody([row], CORPORATION());
  assert.throws(
    () => assertBody([row], ALLIANCE()),
    (err) => /is_watched is not in the spec/.test(err.message),
  );
});

test("helpfully adding the owner id to each row is rejected", () => {
  assert.throws(
    () => assertBody(
      [{
        contact_id: 90000002,
        contact_type: "character",
        corporation_id: CORPORATION_ID,
        standing: 0,
      }],
      CORPORATION(),
    ),
    (err) => /corporation_id is not in the spec/.test(err.message),
  );
});

// The route descriptors

test("each route descriptor agrees with the pinned spec", () => {
  const routes = require(CONTACTS_ROUTE);
  const built = [
    routes.createCharacterContactsRoute({}),
    routes.createCorporationContactsRoute({}),
    routes.createAllianceContactsRoute({}),
  ];

  built.forEach((route, index) => {
    const { bucket, operationId, group } = BUCKETS[index];
    const contract = spec.assertRouteMatchesSpec(route);

    assert.equal(route.name, contract.operationId, bucket);
    assert.equal(route.name, operationId, bucket);
    assert.equal(route.producer, "app", "observed: charset=UTF-8, no trailing newline");
    assert.equal(route.rateLimitGroup, group, bucket);
    assert.equal(route.cacheTtl, 300, bucket);
    assert.equal(route.localizedBody, undefined, "ids and numbers, so the three-line Vary");
  });
});

test("the corporation route paginates on the observed size and the other two say they chose", () => {
  const routes = require(CONTACTS_ROUTE);

  assert.equal(
    routes.createCorporationContactsRoute({}).pageSize,
    wire.CONTACTS.pageSize["/corporations/{corporation_id}/contacts"],
    "the corporation size is read off the wire, not chosen",
  );

  // The other two are this replica's declaration, and the constant is separate so
  // the difference between a measurement and a choice is visible in the route
  // table rather than only in a comment.
  assert.equal(routes.createCharacterContactsRoute({}).pageSize, routes.UNOBSERVED_PAGE_SIZE);
  assert.equal(routes.createAllianceContactsRoute({}).pageSize, routes.UNOBSERVED_PAGE_SIZE);
  assert.notEqual(routes.UNOBSERVED_PAGE_SIZE, routes.CORPORATION_CONTACTS_PAGE_SIZE);

  // It clears both lower bounds the capture established, which is all that is
  // known about the two unmeasured buckets.
  for (const bound of Object.values(wire.CONTACTS.pageSizeLowerBound)) {
    assert.ok(routes.UNOBSERVED_PAGE_SIZE >= bound, `${bound} rows would not have fitted`);
  }
});

test("the path parameters are spelled the way the subject heuristic reads them", () => {
  const routes = require(CONTACTS_ROUTE);

  assert.ok(routes.createCharacterContactsRoute({}).path.includes(`:${routes.CHARACTER_ID_PARAM}`));
  assert.ok(
    routes.createCorporationContactsRoute({}).path.includes(`:${routes.CORPORATION_ID_PARAM}`),
  );
  assert.ok(routes.createAllianceContactsRoute({}).path.includes(`:${routes.ALLIANCE_ID_PARAM}`));

  // `lib/router.js` decides a scoped route needs a `subject` by looking for a
  // path parameter ending in `_id` that is not `character_id`. A parameter
  // spelled `:id` would fail that heuristic and the route would compile with the
  // scope as its only gate: any holder of it reading any alliance's standings.
  assert.match(routes.ALLIANCE_ID_PARAM, /_id$/);
  assert.match(routes.CORPORATION_ID_PARAM, /_id$/);
});

test("the character bucket needs no subject and the other two declare one", () => {
  const routes = require(CONTACTS_ROUTE);
  const compiled = createRouter([
    routes.createCharacterContactsRoute({}),
    routes.createCorporationContactsRoute({}),
    routes.createAllianceContactsRoute({}),
  ]).routes;

  assert.equal(compiled[0].subject, SUBJECT.CALLER, "keyed by :character_id and nothing else");
  assert.equal(typeof compiled[1].subject, "function");
  assert.equal(typeof compiled[2].subject, "function");
  assert.equal(compiled[0].localizedBody, false);
});

// The handler
//
// Called through the router, which is how `loader.js` calls it and the only way
// that runs `authorise()` and the subject checks.

/** Contacts as eve.js stores them: keyed by id, and the id is only the key. */
function stored(rows) {
  const table = {};
  for (const [contactID, relationshipID, inWatchlist] of rows) {
    table[String(contactID)] = { relationshipID, labelMask: 0, inWatchlist: inWatchlist === true };
  }
  return table;
}

/** One of every contact type, as the game would store and resolve them. */
const OTHER_CHARACTER = 90000002;
const NPC_AGENT = 3019491;
const A_CORPORATION = 98000010;
const AN_ALLIANCE = 99000010;
const A_FACTION = 500001;

const KNOWN_OWNERS = {
  [NPC_AGENT]: 1373,
  [A_CORPORATION]: 2,
  [AN_ALLIANCE]: 16159,
  [A_FACTION]: 30,
};

/**
 * A `lib/runtimeAccess.js` double.
 *
 * `characters` is the set of ids the character table knows, which is what makes
 * a contact a `character`; `owners` maps every other id to the eve.js owner
 * `typeID` `getOwnerTypeId` would answer with. An id in neither is an id this
 * game cannot name.
 *
 * `getCharacterRecord` is present and throws. It would answer the personal
 * bucket in one call, and it writes the record back when normalisation drifts;
 * wiring it as a trap is how this suite asserts a negative.
 */
function runtimeDouble({
  record = { corporationID: CORPORATION_ID, personalContacts: {}, blockedOwners: {} },
  corporation = { ceoID: 0, allianceID: ALLIANCE_ID },
  corporationContacts = {},
  allianceContacts = {},
  characters = [CHARACTER_ID],
  owners = {},
  omit = [],
} = {}) {
  const runtime = {
    peekCharacterRecord: (characterId, options = {}) => {
      const found = characterId === CHARACTER_ID
        ? record
        : (characters.includes(characterId) ? {} : null);
      if (found === null) return null;
      return options.project ? options.project(found, characterId) : { ...found };
    },
    getOwnerTypeId: (ownerId) => (
      Object.prototype.hasOwnProperty.call(owners, String(ownerId))
        ? owners[String(ownerId)]
        : null
    ),
    getCorporationContacts: (corporationId) => (
      corporationId === CORPORATION_ID ? corporationContacts : null
    ),
    getAllianceContacts: (allianceId) => (allianceId === ALLIANCE_ID ? allianceContacts : null),
    getCorporationRecord: (corporationId) => (
      corporationId === CORPORATION_ID ? corporation : null
    ),
    getCharacterRecord: () => {
      throw new Error("a read endpoint called the accessor that writes");
    },
  };

  for (const accessor of omit) delete runtime[accessor];
  return runtime;
}

function contactsRouter(deps) {
  const routes = require(CONTACTS_ROUTE);
  return createRouter([
    routes.createCharacterContactsRoute(deps),
    routes.createCorporationContactsRoute(deps),
    routes.createAllianceContactsRoute(deps),
  ]);
}

/** A request carrying a verified credential for `CHARACTER_ID`. */
function authenticated(pathname, { scope, characterId = CHARACTER_ID, query = {} } = {}) {
  return {
    method: "GET",
    pathname,
    query,
    credential: {
      presented: true,
      claims: Object.freeze({ characterId, scopes: Object.freeze([scope]) }),
      refusal: null,
    },
  };
}

test("a personal contact list satisfies the contract, in CCP's field order", async () => {
  const router = contactsRouter({
    runtime: runtimeDouble({
      record: {
        corporationID: CORPORATION_ID,
        personalContacts: stored([[OTHER_CHARACTER, 10, true], [A_CORPORATION, -5, false]]),
        blockedOwners: {},
      },
      characters: [CHARACTER_ID, OTHER_CHARACTER],
      owners: KNOWN_OWNERS,
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(CHARACTER_PATH, { scope: CHARACTER_SCOPE }),
  );

  assert.equal(result.status, 200);
  const body = wireBody(result);
  assertBody(body, CHARACTER());
  assert.deepEqual(body, [
    { contact_id: OTHER_CHARACTER, contact_type: "character", is_watched: true, standing: 10 },
    { contact_id: A_CORPORATION, contact_type: "corporation", standing: -5 },
  ]);

  // Order is bytes, and the observed order is alphabetical.
  assert.deepEqual(
    Object.keys(body[0]),
    ["contact_id", "contact_type", "is_watched", "standing"],
  );
});

test("is_watched is omitted rather than sent as false, and so is is_blocked", async () => {
  const router = contactsRouter({
    runtime: runtimeDouble({
      record: {
        corporationID: CORPORATION_ID,
        personalContacts: stored([[OTHER_CHARACTER, 0, false], [NPC_AGENT, 5, false]]),
        blockedOwners: { [String(OTHER_CHARACTER)]: { senderID: OTHER_CHARACTER } },
      },
      characters: [CHARACTER_ID, OTHER_CHARACTER],
      owners: KNOWN_OWNERS,
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(CHARACTER_PATH, { scope: CHARACTER_SCOPE }),
  );

  const body = wireBody(result);
  assertBody(body, CHARACTER());
  assert.deepEqual(Object.keys(body[0]), ["contact_id", "contact_type", "standing"]);
  assert.deepEqual(
    body[1],
    { contact_id: OTHER_CHARACTER, contact_type: "character", is_blocked: true, standing: 0 },
  );
  assert.deepEqual(
    Object.keys(body[1]),
    ["contact_id", "contact_type", "is_blocked", "standing"],
    "is_blocked keeps its alphabetical seat",
  );
});

test("label_ids is never sent, on any bucket", async () => {
  // Declared optional by the spec and seen on no row across about 580 contacts in
  // three buckets. eve.js has the mask; a replica omitting the field is within
  // observed behaviour, and a decomposition nobody can check against CCP is not.
  const router = contactsRouter({
    runtime: runtimeDouble({
      record: {
        corporationID: CORPORATION_ID,
        personalContacts: {
          [String(OTHER_CHARACTER)]: { relationshipID: 5, labelMask: 12, inWatchlist: false },
        },
        blockedOwners: {},
      },
      characters: [CHARACTER_ID, OTHER_CHARACTER],
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(CHARACTER_PATH, { scope: CHARACTER_SCOPE }),
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(result.body[0], "label_ids"));
});

test("every contact_type the enum declares is reachable from the game", async () => {
  const router = contactsRouter({
    runtime: runtimeDouble({
      record: {
        corporationID: CORPORATION_ID,
        personalContacts: stored([
          [OTHER_CHARACTER, 10, false],
          [NPC_AGENT, 5, false],
          [A_CORPORATION, 0, false],
          [AN_ALLIANCE, -5, false],
          [A_FACTION, -10, false],
        ]),
        blockedOwners: {},
      },
      characters: [CHARACTER_ID, OTHER_CHARACTER],
      owners: KNOWN_OWNERS,
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(CHARACTER_PATH, { scope: CHARACTER_SCOPE }),
  );

  assertBody(wireBody(result), CHARACTER());
  // In ascending contact id, the order every bucket comes out in. See the test
  // below for why that is a decision rather than an accident.
  assert.deepEqual(result.body.map((row) => row.contact_type), [
    "faction",
    "character",
    "character",
    "corporation",
    "alliance",
  ]);
});

test("a bucket comes out in ascending contact id, which is what a sweep needs", () => {
  // The wire order within a page was not captured, so this order is ours. It has
  // to be total and stable: a paginated collection whose order depends on how
  // the underlying map was filled can hand a client a row on page 2 that it
  // already read on page 1, and a private server's contact table is written to
  // while a sweep is in flight.
  const { contactRowsOf } = require(CONTACTS_ROUTE);

  const rows = contactRowsOf(stored([
    [AN_ALLIANCE, 5, false], [A_FACTION, 0, false], [OTHER_CHARACTER, -5, false],
  ]));

  assert.deepEqual(rows.map((row) => row.contactId), [A_FACTION, OTHER_CHARACTER, AN_ALLIANCE]);
});

test("a contact the game cannot name is dropped, not published under a guess", async () => {
  // `contact_type` is a closed four-value enum and this replica cannot invent a
  // fifth. Both alternatives are worse: a guessed type is a wrong row a consumer
  // acts on, and throwing would turn one stale contact into a 500 for the whole
  // bucket, which for eve-nexum is a standings sync that never completes again.
  const router = contactsRouter({
    runtime: runtimeDouble({
      record: {
        corporationID: CORPORATION_ID,
        personalContacts: stored([[OTHER_CHARACTER, 10, false], [123456789, 5, false]]),
        blockedOwners: {},
      },
      characters: [CHARACTER_ID, OTHER_CHARACTER],
      owners: KNOWN_OWNERS,
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(CHARACTER_PATH, { scope: CHARACTER_SCOPE }),
  );

  assertBody(wireBody(result), CHARACTER());
  assert.deepEqual(result.body.map((row) => row.contact_id), [OTHER_CHARACTER]);
});

test("a contact id that is not a positive integer is dropped, as it is upstream", async () => {
  const router = contactsRouter({
    runtime: runtimeDouble({
      record: {
        corporationID: CORPORATION_ID,
        personalContacts: {
          "0": { relationshipID: 5, labelMask: 0, inWatchlist: false },
          "-1": { relationshipID: 5, labelMask: 0, inWatchlist: false },
          "not-an-id": { relationshipID: 5, labelMask: 0, inWatchlist: false },
          [String(OTHER_CHARACTER)]: { relationshipID: 5, labelMask: 0, inWatchlist: false },
        },
        blockedOwners: {},
      },
      characters: [CHARACTER_ID, OTHER_CHARACTER],
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(CHARACTER_PATH, { scope: CHARACTER_SCOPE }),
  );
  assert.deepEqual(result.body.map((row) => row.contact_id), [OTHER_CHARACTER]);
});

test("standing comes from relationshipID, and an unreadable one is the game's own zero", () => {
  const { toStanding } = require(CONTACTS_ROUTE);

  assert.equal(toStanding(10), 10);
  assert.equal(toStanding(-10), -10);
  assert.equal(toStanding(0), 0);
  assert.equal(toStanding("5"), 5, "a stored string is still a standing");

  // `normalizeInteger(value, 0)` is what every eve.js reader of this field does,
  // truncation included, and answering differently would make this replica
  // disagree with the game about what a contact's standing is.
  assert.equal(toStanding(4.7), 4);
  assert.equal(toStanding(-4.7), -4);
  for (const unreadable of [null, undefined, "", " ", "abc", {}, [], NaN, Infinity]) {
    assert.equal(toStanding(unreadable), 0, `${JSON.stringify(unreadable)} should read as zero`);
  }
});

test("a standing reaches the wire with a decimal point, on every bucket", async () => {
  // `standing` is `format: double` and `toStanding` truncates to an integer, so
  // every standing this replica serves is the case `JSON.stringify` gets wrong:
  // it writes `10` where CCP writes `10.0`. A parsed comparison cannot see it
  // (both parse to 10), nor can the schema, which asks only for a number, so this
  // is asserted against the bytes.
  //
  // The rule was read off `contract/golden/GetMarketsRegionIdOrders.json` rather
  // than a contacts capture: `contract/wire.js` `DOUBLE_RENDERING` has the rule
  // and names `standing` among the fields it is assumed to cover.
  const character = await dispatchRequest(
    contactsRouter({
      runtime: runtimeDouble({
        record: {
          corporationID: CORPORATION_ID,
          personalContacts: stored([[OTHER_CHARACTER, 10, false], [A_CORPORATION, -5, false]]),
          blockedOwners: {},
        },
        characters: [CHARACTER_ID, OTHER_CHARACTER],
        owners: KNOWN_OWNERS,
      }),
    }),
    authenticated(CHARACTER_PATH, { scope: CHARACTER_SCOPE }),
  );
  const characterBytes = serializeBody(character.body, character.producer).toString("utf8");
  assert.match(characterBytes, /"standing":10\.0}/);
  assert.match(characterBytes, /"standing":-5\.0}/, "a negative standing keeps its point too");
  assert.equal(characterBytes.includes('"standing":10,'), false, "and never the bare integer");

  const corporation = await dispatchRequest(
    contactsRouter({
      runtime: runtimeDouble({
        corporationContacts: stored([[A_FACTION, 0, false]]),
        owners: KNOWN_OWNERS,
      }),
    }),
    authenticated(CORPORATION_PATH, { scope: CORPORATION_SCOPE }),
  );
  assert.match(
    serializeBody(corporation.body, corporation.producer).toString("utf8"),
    /"standing":0\.0}/,
    "zero is the value the bug is least visible on and costs the same two bytes",
  );

  const alliance = await dispatchRequest(
    contactsRouter({
      runtime: runtimeDouble({
        allianceContacts: stored([[A_CORPORATION, 10, false]]),
        owners: KNOWN_OWNERS,
      }),
    }),
    authenticated(ALLIANCE_PATH, { scope: ALLIANCE_SCOPE }),
  );
  assert.match(
    serializeBody(alliance.body, alliance.producer).toString("utf8"),
    /"standing":10\.0}/,
  );
});

test("the corporation bucket answers for the caller's own corporation", async () => {
  const router = contactsRouter({
    runtime: runtimeDouble({
      corporationContacts: stored([[AN_ALLIANCE, 5, true], [A_FACTION, -10, false]]),
      owners: KNOWN_OWNERS,
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(CORPORATION_PATH, { scope: CORPORATION_SCOPE }),
  );

  assert.equal(result.status, 200);
  const body = wireBody(result);
  assertBody(body, CORPORATION());
  assert.deepEqual(body, [
    { contact_id: A_FACTION, contact_type: "faction", standing: -10 },
    { contact_id: AN_ALLIANCE, contact_type: "alliance", is_watched: true, standing: 5 },
  ]);
});

test("the alliance bucket drops is_watched, which the game has and CCP does not declare", async () => {
  const router = contactsRouter({
    runtime: runtimeDouble({
      allianceContacts: stored([[A_CORPORATION, 10, true]]),
      owners: KNOWN_OWNERS,
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(ALLIANCE_PATH, { scope: ALLIANCE_SCOPE }),
  );

  assert.equal(result.status, 200);
  const body = wireBody(result);
  assertBody(body, ALLIANCE());
  assert.deepEqual(
    body,
    [{ contact_id: A_CORPORATION, contact_type: "corporation", standing: 10 }],
  );
});

test("an empty bucket is an empty array, and it is a real answer", async () => {
  const router = contactsRouter({ runtime: runtimeDouble({}) });

  for (const [pathname, scope, contract] of [
    [CHARACTER_PATH, CHARACTER_SCOPE, CHARACTER],
    [CORPORATION_PATH, CORPORATION_SCOPE, CORPORATION],
    [ALLIANCE_PATH, ALLIANCE_SCOPE, ALLIANCE],
  ]) {
    const result = await dispatchRequest(router, authenticated(pathname, { scope }));
    assert.equal(result.status, 200, pathname);
    assert.deepEqual(result.body, []);
    assertBody(result.body, contract());
  }
});

test("a sweep is one X-Pages across every page, and the framework slices it", async () => {
  // The handler is asked for the whole collection once per cache window, so
  // X-Pages and the body cannot disagree, and a client sweeping a big alliance's
  // standings makes one read of the game's runtime rather than one per page.
  const routes = require(CONTACTS_ROUTE);
  const contacts = stored([
    [A_CORPORATION, 5, false], [AN_ALLIANCE, 0, false], [A_FACTION, -5, false],
  ]);
  const route = routes.createAllianceContactsRoute({
    runtime: runtimeDouble({ allianceContacts: contacts, owners: KNOWN_OWNERS }),
  });
  const router = createRouter([{ ...route, pageSize: 2 }]);

  const page1 = await dispatchRequest(
    router,
    authenticated(ALLIANCE_PATH, { scope: ALLIANCE_SCOPE, query: { page: "1" } }),
  );
  const page2 = await dispatchRequest(
    router,
    authenticated(ALLIANCE_PATH, { scope: ALLIANCE_SCOPE, query: { page: "2" } }),
  );

  assert.equal(page1.headers["x-pages"], "2");
  assert.equal(page2.headers["x-pages"], "2", "X-Pages moved mid-sweep");
  assert.equal(page1.body.length, 2);
  assert.equal(page2.body.length, 1);

  const swept = [...page1.body, ...page2.body].map((row) => row.contact_id);
  assert.equal(new Set(swept).size, 3, "a page boundary duplicated or dropped a contact");
});

test("X-Pages is sent even when everything fits on one page", async () => {
  const router = contactsRouter({
    runtime: runtimeDouble({
      allianceContacts: stored([[A_CORPORATION, 5, false]]),
      owners: KNOWN_OWNERS,
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(ALLIANCE_PATH, { scope: ALLIANCE_SCOPE }),
  );
  assert.equal(result.headers["x-pages"], wire.AUTHENTICATED_PAGING.singlePageValue);
});

// The two gates the scope cannot make

test("another corporation's contacts are the observed 403, to the byte", async () => {
  const router = contactsRouter({ runtime: runtimeDouble({}) });

  const result = await dispatchRequest(
    router,
    authenticated("/latest/corporations/98777772/contacts/", { scope: CORPORATION_SCOPE }),
  );

  assert.equal(result.status, wire.CROSS_ENTITY_REFUSAL.status);
  assert.deepEqual(result.body, { error: wire.CROSS_ENTITY_REFUSAL.body });
  assert.equal(result.producer, "app");
  assert.equal(
    Buffer.byteLength(JSON.stringify(result.body), "utf8"),
    wire.CROSS_ENTITY_REFUSAL.contentLength,
    "the refusal is 47 bytes and a tidied message is a different response",
  );
});

test("a malformed corporation id is answered as the membership refusal", async () => {
  // A divergence worth naming: real ESI refuses /corporations/abc/contacts/ with
  // a coercion 400 before it asks who is calling. Answering with observed bytes,
  // attached to a claim that is true (the caller is not a member of a corporation
  // that cannot exist), beats inventing the headers of a refusal made in a seat
  // nobody has captured.
  const router = contactsRouter({ runtime: runtimeDouble({}) });

  const result = await dispatchRequest(
    router,
    authenticated("/latest/corporations/0123/contacts/", { scope: CORPORATION_SCOPE }),
  );

  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: wire.CROSS_ENTITY_REFUSAL.body });
});

test("another alliance's contacts are refused, and the status is loudly wrong", async () => {
  // The refusal CCP sends here has never been observed. The corporation one
  // cannot travel: its wording names the relationship ("is not in the
  // corporation"), so it is corporation-shaped, and inventing an alliance wording
  // is the guess contract/wire.js exists to refuse. So the read is refused as a
  // logged 500 until somebody captures it: wrong status, right outcome, and
  // impossible to mistake for a working endpoint.
  const logged = [];
  const router = contactsRouter({ runtime: runtimeDouble({}) });

  const result = await dispatchRequest(
    router,
    authenticated("/latest/alliances/99000002/contacts/", { scope: ALLIANCE_SCOPE }),
    { logError: (message, err) => logged.push(err.message) },
  );

  assert.equal(result.status, 500);
  assert.match(logged[0], /never been observed/);
  assert.doesNotMatch(JSON.stringify(result.body), /99000002/, "and the client is told nothing");
});

test("an alliance-less caller cannot read any alliance's contacts", async () => {
  const logged = [];
  const router = contactsRouter({
    runtime: runtimeDouble({ corporation: { ceoID: 0, allianceID: null } }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(ALLIANCE_PATH, { scope: ALLIANCE_SCOPE }),
    { logError: (message, err) => logged.push(err.message) },
  );

  assert.equal(result.status, 500);
  assert.equal(logged.length, 1);
});

test("the gate refuses before the handler runs, on every bucket", async () => {
  let handlerRuns = 0;
  const routes = require(CONTACTS_ROUTE);
  const deps = { runtime: runtimeDouble({}) };
  const counted = (route) => ({
    ...route,
    handler: (params) => { handlerRuns += 1; return route.handler(params); },
  });
  const router = createRouter([
    counted(routes.createCharacterContactsRoute(deps)),
    counted(routes.createCorporationContactsRoute(deps)),
    counted(routes.createAllianceContactsRoute(deps)),
  ]);

  const noToken = await dispatchRequest(router, {
    method: "GET", pathname: CHARACTER_PATH, query: {},
  });
  assert.equal(noToken.status, 401, "no credential");

  const wrongScope = await dispatchRequest(
    router,
    authenticated(CHARACTER_PATH, { scope: CORPORATION_SCOPE }),
  );
  assert.equal(wrongScope.status, 401, "a verified token without this route's scope");

  const otherCharacter = await dispatchRequest(
    router,
    authenticated(CHARACTER_PATH, { scope: CHARACTER_SCOPE, characterId: CHARACTER_ID + 1 }),
  );
  assert.equal(otherCharacter.status, 403, "a token for somebody else");

  assert.equal(handlerRuns, 0, "the handler must not observe a request it was not allowed to see");
});

// What the game cannot produce

test("a missing accessor is a 500 naming it, never an empty bucket", async () => {
  // An empty collection is a valid, complete, wrong answer, and eve-nexum acts on
  // it: `replaceStandings` deletes every standing it had recorded for the owner
  // and inserts nothing. A build that cannot read contacts at all would erase a
  // corporation's standings rather than fail to refresh them.
  const cases = [
    [CHARACTER_PATH, CHARACTER_SCOPE, "peekCharacterRecord"],
    [CORPORATION_PATH, CORPORATION_SCOPE, "getCorporationContacts"],
    [ALLIANCE_PATH, ALLIANCE_SCOPE, "getAllianceContacts"],
    [CHARACTER_PATH, CHARACTER_SCOPE, "getOwnerTypeId"],
  ];

  for (const [pathname, scope, accessor] of cases) {
    const logged = [];
    const router = contactsRouter({
      runtime: runtimeDouble({
        record: {
          corporationID: CORPORATION_ID,
          personalContacts: stored([[A_CORPORATION, 5, false]]),
          blockedOwners: {},
        },
        corporationContacts: stored([[A_CORPORATION, 5, false]]),
        allianceContacts: stored([[A_CORPORATION, 5, false]]),
        owners: KNOWN_OWNERS,
        omit: [accessor],
      }),
    });

    const result = await dispatchRequest(
      router,
      authenticated(pathname, { scope }),
      { logError: (message, err) => logged.push(err.message) },
    );

    assert.equal(result.status, 500, `${accessor} was allowed to be missing`);
    assert.match(logged[0], new RegExp(accessor));
  }
});

test("a missing character record is a logged 500, not an empty contact list", async () => {
  const logged = [];
  const router = contactsRouter({ runtime: runtimeDouble({ record: null }) });

  const result = await dispatchRequest(
    router,
    authenticated(CHARACTER_PATH, { scope: CHARACTER_SCOPE }),
    { logError: (message, err) => logged.push(err.message) },
  );

  assert.equal(result.status, 500);
  assert.match(logged[0], new RegExp(String(CHARACTER_ID)), "and it names the character");
  assert.doesNotMatch(JSON.stringify(result.body), new RegExp(String(CHARACTER_ID)));
});

// The owner-type table, against the vendor tree

test("eve.js still declares the four owner types, and still keeps contacts where this reads them", vendorOnly, () => {
  const { OWNER_TYPES } = require(CONTACTS_ROUTE);

  const read = (relative) => {
    const file = path.join(REPO_ROOT, "server", "src", ...relative.split("/"));
    assert.equal(fs.existsSync(file), true, `${relative} has moved`);
    return fs.readFileSync(file, "utf8");
  };

  // 1. The four `typeID`s. Copied because only `lib/runtimeAccess.js` may
  //    require game code, the arrangement `routes/roles.js` has with the
  //    corporation role bits, checked the same way: by re-reading the
  //    declaration rather than trusting the copy.
  for (const { contactType, typeId, evejs, where } of OWNER_TYPES) {
    const source = read(where);
    const declaration = new RegExp(`\\bconst\\s+${evejs}\\s*=\\s*(\\d+)\\s*;`);
    const match = declaration.exec(source);

    assert.ok(match, `${evejs} is no longer declared in ${where}`);
    assert.equal(
      Number(match[1]),
      typeId,
      `${evejs} is ${match[1]} upstream and ${typeId} in routes/contacts.js, so every `
        + `${contactType} contact would be dropped as unnameable`,
    );
  }

  // 2. `getOwnerLookupRecord` still answers with a `typeID`, the field
  //    `getOwnerTypeId` narrows to.
  const corporationState = read("services/corporation/corporationState.js");
  assert.match(corporationState, /^\s*getOwnerLookupRecord,\s*$/m, "no longer exported");
  assert.match(corporationState, /typeID:\s*OWNER_TYPE_CORPORATION/, "an owner record has no typeID");

  // 3. The three stores. A rename upstream does not fail, it empties a bucket,
  //    silently, and eve-nexum acts on an empty bucket by deleting standings.
  const runtimeState = read("services/corporation/corporationRuntimeState.js");
  assert.match(runtimeState, /^\s*getCorporationRuntime,\s*$/m);
  assert.match(runtimeState, /^\s*getAllianceRuntime,\s*$/m);
  assert.match(runtimeState, /contacts:\s*\n?\s*base\.contacts/, "the runtime no longer holds contacts");

  const charMgr = read("services/character/charMgrService.js");
  assert.match(charMgr, /record\.personalContacts/, "personal contacts have moved off the record");
  assert.match(charMgr, /record\.blockedOwners/, "the blocked list has moved off the record");
  assert.match(charMgr, /inWatchlist:\s*normalizeBoolean/, "a contact no longer carries inWatchlist");
  assert.match(charMgr, /relationshipID:\s*normalizeInteger/, "a contact no longer carries relationshipID");
});
