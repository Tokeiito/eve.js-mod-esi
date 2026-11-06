/**
 * `GET /characters/{character_id}/roles/`: the contract.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Written from CCP's document before the handler, then from the 2026-08-25
 * capture for the half OpenAPI has no vocabulary for. There is no golden
 * recording: a recording of this body would be a real pilot's corporation
 * authority, the same reason `contract/golden/` carries the three contacts
 * operations in its `exempt` map rather than as files.
 *
 * The spec is authoritative for the body: four optional array properties, one
 * shared 54-value enum, `uniqueItems`, the scope, the `char-detail` bucket and
 * the 3600-second TTL.
 *
 * The wire is authoritative for what the spec cannot express: that all four
 * arrays are sent even when empty, that an empty one is `[]` rather than an
 * omitted key, and which of ESI's two implementations answers.
 *
 * The vendor tree is authoritative for the bit table, which is where most of
 * the assertions go. `routes/roles.js` owns a mapping from eve.js's 64-bit
 * corporation-role mask to CCP's 54 names because eve.js has no such table and
 * it cannot be imported. It is checked three ways: against the spec's enum
 * (every name it emits is a name CCP publishes), against itself (46 named plus
 * 9 dropped accounts for all 55 bits, disjointly), and against the vendor
 * declarations themselves.
 *
 * The third check stands between `roles[]` and
 * `services/account/accountRoleProfiles.js`, which declares a different 64-bit
 * namespace over the same numeric values: `4503599627370496` is `ROLE_QA` there
 * and `Junior_Accountant` here.
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
const { REPO_ROOT, vendorOnly } = require(path.join(__dirname, "vendorTree"));

const ROLES_ROUTE = path.join(__dirname, "..", "routes", "roles.js");

/**
 * CCP's own `CharacterID` and `CorporationID` examples from the pinned spec, not
 * the pilots the capture was taken with. These tests need a character and a
 * corporation, and `contract/` holds nobody's account data (D23).
 */
const CHARACTER_ID = 90000001;
const CORPORATION_ID = 98777771;

const ROLES_PATH = `/latest/characters/${CHARACTER_ID}/roles/`;
const ROLES = () => describeOperation("get", ROLES_PATH);

const SCOPE = "esi-characters.read_corporation_roles.v1";

// What the spec says

test("/roles/ requires nothing, and all four properties are role arrays", () => {
  const contract = ROLES();

  // `required` is absent from the schema entirely, so `{}` is a valid body. That
  // makes "all four arrays are always sent" a wire fact the document could not
  // have told us.
  assert.deepEqual(contract.requiredKeys, []);
  assert.deepEqual(contract.optionalKeys.sort(), [
    "roles",
    "roles_at_base",
    "roles_at_hq",
    "roles_at_other",
  ]);

  for (const field of contract.optionalKeys) {
    const property = contract.schema.properties[field];
    assert.equal(property.type, "array", `${field} is an array`);
    assert.equal(property.uniqueItems, true, `${field} declares uniqueItems`);
    assert.equal(property.items.type, "string");
  }
});

test("the four arrays share one 54-name enum, and it has both roles the consumer needs", () => {
  const contract = ROLES();
  const { enum: roleNames } = contract.schema.properties.roles.items;

  assert.equal(roleNames.length, 54);
  assert.ok(roleNames.includes("Director"), "the consumer's gate");
  assert.ok(roleNames.includes("Station_Manager"), "the spec's own gate on the corp route");

  // One enum, not four that happen to agree, so a re-pin cannot change the
  // vocabulary for one array and not the others.
  for (const field of ["roles_at_base", "roles_at_hq", "roles_at_other"]) {
    assert.deepEqual(contract.schema.properties[field].items.enum, roleNames, field);
  }
});

test("the enum is already alphabetical, which is what makes the output order checkable", () => {
  // `routes/roles.js` sorts each array on the ESI name and says in its header
  // that the choice is ours, because the wire order is unobserved. This makes
  // "ours" mean something: the order it produces is the order CCP writes the
  // vocabulary in, so if the two part company this test says so rather than a
  // client.
  const roleNames = ROLES().schema.properties.roles.items.enum;
  assert.deepEqual([...roleNames].sort(), roleNames);
});

test("the scope, the bucket and the TTL", () => {
  const contract = ROLES();

  assert.deepEqual(contract.scopes, [SCOPE]);
  assert.equal(contract.cacheAgeSeconds, 3600, "an hour, not five seconds");
  assert.deepEqual(contract.rateLimit, {
    group: "char-detail",
    maxTokens: 600,
    windowSize: "15m",
  });

  // Not `char-location`, which is why this is not a fourth descriptor in
  // routes/characters.js.
  assert.notEqual(contract.rateLimit.group, wire.CHARACTER_LOCATION.rateLimitGroup);
  assert.deepEqual(contract.statuses, [200], "the spec declares no error status");
});

test("the version prefix does not change the operation", () => {
  for (const prefix of ["/latest", "/v1", "/v2"]) {
    assert.equal(
      describeOperation("get", `${prefix}/characters/${CHARACTER_ID}/roles/`).operationId,
      "GetCharactersCharacterIdRoles",
    );
  }
});

// What the wire says

test("it is the application, observed, and not inherited from the parent path", () => {
  assert.equal(wire.SUCCESS_KIND["/characters/:character_id/roles"], wire.KIND.APP_SUCCESS);

  // The reason that row had to be captured: the parent is the gateway, so a
  // sibling path is evidence of nothing (the same finding as for the contacts
  // routes, one path level up).
  assert.equal(wire.SUCCESS_KIND["/characters/:character_id"], wire.KIND.GATEWAY_SUCCESS);
  assert.equal(wire.CONTENT_TYPE[wire.KIND.APP_SUCCESS], "application/json; charset=UTF-8");
  assert.equal(wire.TRAILING_NEWLINE[wire.KIND.APP_SUCCESS], false);
});

test("an empty array is sent, which is the opposite of the omit rule beside it", () => {
  // On the same capture, on the same producer: `/contacts/`'s `is_watched` is
  // omitted when it does not apply and an empty `roles` is sent as `[]`. Both
  // recorded, neither generalised, which is why `routes/roles.js` has no
  // `optional()` in its projection and `routes/structures.js` has seven.
  assert.equal(wire.CHARACTER_ROLES.emptyArrayIsSent, true);
  assert.deepEqual(wire.CONTACTS.omittedWhenAbsent, ["is_watched"]);
});

test("the field order is alphabetical, and order is bytes", () => {
  const order = wire.CHARACTER_ROLES.fieldOrder;

  assert.deepEqual([...order].sort(), [...order]);

  const { projectCharacterRoles } = require(ROLES_ROUTE);
  assert.deepEqual([...projectCharacterRoles.fields], [...order]);
});

test("the wire and the spec agree about the bucket", () => {
  assert.equal(wire.CHARACTER_ROLES.rateLimitGroup, ROLES().rateLimit.group);
});

test("CCP's own roles[] was empty on both characters observed", () => {
  // Recorded because a consumer may expect `roles[]` to carry `Station_Manager`
  // or `Director`, and on two of two real characters that array was the empty one
  // while the three locational arrays were populated.
  //
  // This replica does not reproduce that, and cannot: eve.js keeps the
  // administrative bits in the member record's `roles` field. The divergence is
  // between CCP's data and this game's data model, and the test that matters is
  // the one below showing a director's `roles[]` is populated here.
  assert.equal(wire.CHARACTER_ROLES.rolesWasEmptyOnEveryObservation, true);
  assert.equal(wire.CHARACTER_ROLES.observations, 2);
});

// What a plausible-but-wrong body does

test("a role name outside CCP's enum is a contract failure", () => {
  // The mistake this bit table exists to avoid: a bit matched by elimination,
  // emitted under a name that reads plausibly.
  assert.throws(
    () => assertBody({ roles: ["Starbase_Caretaker"] }, ROLES()),
    (err) => err instanceof SpecContractError && /is not one of/.test(err.message),
  );
});

test("a duplicated role name is a contract failure, not a cosmetic one", () => {
  // `uniqueItems` is enforced by contract/spec.js, so a decode that emitted a
  // name twice (two bits mapped to one name, which the 55-vs-54 count invites)
  // fails here.
  assert.throws(
    () => assertBody({ roles: ["Director", "Director"] }, ROLES()),
    (err) => /uniqueItems is set, and there are duplicates/.test(err.message),
  );
});

test("a null array is a contract failure, so 'no roles' cannot be null", () => {
  assert.throws(
    () => assertBody({ roles: null }, ROLES()),
    (err) => /body\.roles is null, and the .* spec declares no nullable fields/.test(err.message),
  );
});

test("helpfully adding the corporation id is rejected", () => {
  // The body says nothing about which corporation these roles are in, and the
  // handler knows. A field CCP does not send is as visible as one it does.
  assert.throws(
    () => assertBody({ roles: [], corporation_id: CORPORATION_ID }, ROLES()),
    (err) => /body\.corporation_id is not in the spec/.test(err.message),
  );
});

// The bit table, against the spec

test("every name the bit table can emit is a name CCP publishes", () => {
  const { CORPORATION_ROLE_BITS } = require(ROLES_ROUTE);
  const roleNames = ROLES().schema.properties.roles.items.enum;

  for (const { role } of CORPORATION_ROLE_BITS) {
    assert.ok(roleNames.includes(role), `${role} is not in CCP's 54-name enum`);
  }
  assert.equal(CORPORATION_ROLE_BITS.length, 46);
});

test("no name is claimed twice, and no bit is", () => {
  const { CORPORATION_ROLE_BITS } = require(ROLES_ROUTE);

  const names = CORPORATION_ROLE_BITS.map((entry) => entry.role);
  const bits = CORPORATION_ROLE_BITS.map((entry) => entry.bit);

  assert.equal(new Set(names).size, names.length, "a name mapped from two bits would duplicate");
  assert.equal(new Set(bits.map(String)).size, bits.length);

  // Each is a single bit, not a mask: a composite would decode as one role and be
  // set by any of several.
  for (const { role, bit } of CORPORATION_ROLE_BITS) {
    assert.equal(bit & (bit - 1n), 0n, `${role} is not a single bit`);
  }
});

test("the table is in ascending bit order, which is how it was read", () => {
  const { CORPORATION_ROLE_BITS } = require(ROLES_ROUTE);

  for (let i = 1; i < CORPORATION_ROLE_BITS.length; i += 1) {
    assert.ok(
      CORPORATION_ROLE_BITS[i].bit > CORPORATION_ROLE_BITS[i - 1].bit,
      `${CORPORATION_ROLE_BITS[i].role} is out of bit order`,
    );
  }
});

test("46 named plus 9 dropped accounts for all 55 bits, disjointly", () => {
  // The arithmetic the decision rests on: eve.js enumerates 55 bits and CCP names
  // 54, so at least one bit maps to nothing. This asserts that the omission is a
  // recorded set rather than an absence: a bit that fell out of the table by
  // accident would fail here rather than silently stop being reported.
  const {
    CORPORATION_ROLE_BITS,
    EVEJS_ALL_CORPORATION_ROLE_MASK,
    UNMAPPED_ROLE_BITS,
  } = require(ROLES_ROUTE);

  const named = CORPORATION_ROLE_BITS.map((entry) => entry.bit);
  const dropped = UNMAPPED_ROLE_BITS.map((entry) => entry.bit);

  assert.equal(named.length + dropped.length, 55);
  assert.equal(
    new Set([...named, ...dropped].map(String)).size,
    55,
    "a bit cannot be both named and dropped",
  );

  const union = [...named, ...dropped].reduce((mask, bit) => mask | bit, 0n);
  assert.equal(union, EVEJS_ALL_CORPORATION_ROLE_MASK, "the two sets are not the whole mask");
});

test("nine bits compete for eight names, which is why the near-matches are dropped", () => {
  const { CORPORATION_ROLE_BITS, UNMAPPED_ROLE_BITS } = require(ROLES_ROUTE);
  const roleNames = ROLES().schema.properties.roles.items.enum;

  const claimed = new Set(CORPORATION_ROLE_BITS.map((entry) => entry.role));
  const unclaimed = roleNames.filter((role) => !claimed.has(role));

  assert.equal(unclaimed.length, 8);
  assert.equal(UNMAPPED_ROLE_BITS.length, 9);

  // Every candidate a near-match would have taken is one of the eight, so the
  // dropped set competes for exactly these names and no others.
  for (const { bit, candidate } of UNMAPPED_ROLE_BITS) {
    if (candidate === null) continue;
    assert.ok(unclaimed.includes(candidate), `${candidate} (bit ${bit}) is already claimed`);
  }

  // Four bits carry no eve.js corporation-role name at all, which is where the
  // surplus lands.
  assert.equal(UNMAPPED_ROLE_BITS.filter((entry) => entry.evejs === null).length, 4);
});

test("neither role the consumer depends on is in the dropped set", () => {
  const {
    CORP_ROLE_DIRECTOR,
    CORP_ROLE_STATION_MANAGER,
    UNMAPPED_ROLE_BITS,
    decodeRoleMask,
  } = require(ROLES_ROUTE);

  const dropped = new Set(UNMAPPED_ROLE_BITS.map((entry) => String(entry.bit)));
  assert.ok(!dropped.has(String(CORP_ROLE_DIRECTOR)));
  assert.ok(!dropped.has(String(CORP_ROLE_STATION_MANAGER)));

  assert.deepEqual(decodeRoleMask(CORP_ROLE_DIRECTOR), ["Director"]);
  assert.deepEqual(decodeRoleMask(CORP_ROLE_STATION_MANAGER), ["Station_Manager"]);
});

test("the administrative and locational masks partition the named table", () => {
  // eve.js's own split (everything outside `FULL_LOCATIONAL_ROLE_MASK` is
  // administrative) is ESI's `roles` versus `roles_at_*` split, the strongest
  // reason to decompose the real mask rather than synthesise an answer.
  const {
    EVEJS_FULL_ADMIN_ROLE_MASK,
    EVEJS_FULL_LOCATIONAL_ROLE_MASK,
    decodeRoleMask,
  } = require(ROLES_ROUTE);

  const admin = decodeRoleMask(EVEJS_FULL_ADMIN_ROLE_MASK);
  const locational = decodeRoleMask(EVEJS_FULL_LOCATIONAL_ROLE_MASK);

  assert.equal(admin.length + locational.length, 46);
  assert.deepEqual(admin.filter((role) => locational.includes(role)), []);

  // `Station_Manager` is administrative, which is why the structures gate reads
  // `roles` and not the three locational arrays.
  assert.ok(admin.includes("Station_Manager"));
  assert.ok(admin.includes("Director"));
  assert.ok(locational.includes("Hangar_Take_1"));
});

test("a decoded mask comes out in CCP's own enum order", () => {
  const { EVEJS_FULL_ADMIN_ROLE_MASK, decodeRoleMask } = require(ROLES_ROUTE);
  const roleNames = ROLES().schema.properties.roles.items.enum;

  const decoded = decodeRoleMask(EVEJS_FULL_ADMIN_ROLE_MASK);
  const inEnumOrder = roleNames.filter((role) => decoded.includes(role));

  assert.deepEqual(decoded, inEnumOrder);
  assertBody({ roles: decoded }, ROLES());
});

test("a bit outside the corporation mask decodes to nothing", () => {
  // The guard that keeps `services/account/accountRoleProfiles.js` out of
  // `roles[]`. That module declares a different 64-bit namespace over the same
  // numeric values, so membership in `ALL_CORPORATION_ROLE_MASK` is the only
  // mechanical separation.
  const { EVEJS_ALL_CORPORATION_ROLE_MASK, decodeRoleMask } = require(ROLES_ROUTE);

  const outside = 1n << 63n;
  assert.equal(outside & EVEJS_ALL_CORPORATION_ROLE_MASK, 0n, "the probe bit must be outside");
  assert.deepEqual(decodeRoleMask(outside), []);
  assert.deepEqual(decodeRoleMask(outside | 1n), ["Director"]);
});

test("a mask is read as BigInt, because Number would lose whole roles", () => {
  const { EVEJS_FULL_ADMIN_ROLE_MASK, decodeRoleMask, toRoleMask } = require(ROLES_ROUTE);

  // 9.2e18 against a safe-integer ceiling of 9.0e15 is a thousand times over, so
  // this is not the marginal precision argument that applies to FILETIME. Two
  // masks differing by a whole role collapse onto one double, and the smallest
  // difference a double can represent up here is 2048, which is
  // `Station_Manager` exactly, so every bit below it is invisible.
  assert.ok(EVEJS_FULL_ADMIN_ROLE_MASK > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(Number(EVEJS_FULL_ADMIN_ROLE_MASK + 2048n) - Number(EVEJS_FULL_ADMIN_ROLE_MASK), 2048);
  assert.equal(
    Number(EVEJS_FULL_ADMIN_ROLE_MASK),
    Number(EVEJS_FULL_ADMIN_ROLE_MASK - 256n),
    "Accountant is invisible to a double at this magnitude",
  );
  assert.equal(
    Number(EVEJS_FULL_ADMIN_ROLE_MASK),
    Number(EVEJS_FULL_ADMIN_ROLE_MASK - 1n),
    "and so is Director, the one a consumer gates on",
  );

  // eve.js persists the mask as a decimal string, which is what has to be read.
  assert.equal(toRoleMask(EVEJS_FULL_ADMIN_ROLE_MASK.toString()), EVEJS_FULL_ADMIN_ROLE_MASK);
  assert.ok(decodeRoleMask(toRoleMask(EVEJS_FULL_ADMIN_ROLE_MASK.toString())).includes("Station_Manager"));
});

test("an unreadable mask is null rather than zero", () => {
  const { toRoleMask } = require(ROLES_ROUTE);

  // `null` and `0n` are different answers: "this field is not what this code
  // thinks it is" against "this member holds no roles". `numberOrNull` draws the
  // same distinction for an id.
  for (const value of [null, undefined, "", " ", "-1", "1.5", "0x10", "1e3", {}, [], true]) {
    assert.equal(toRoleMask(value), null, `${JSON.stringify(value)} should not read as a mask`);
  }
  assert.equal(toRoleMask("0"), 0n);
  assert.equal(toRoleMask(0), 0n);
});

// The bit table, against the vendor tree

test("every mapped bit is still declared upstream with that value", vendorOnly, () => {
  // Protocol constants copied because only `lib/runtimeAccess.js` may require
  // game code, the arrangement `lib/sessionIdentity.js` has with the GM role bits,
  // asserted the same way: by re-reading the declaration.
  //
  // The check is membership rather than equality because three of the four
  // families are declared as composites: `CORP_ROLE_CONTAINER_CAN_TAKE_ALL` is
  // seven literals ORed together and eve.js never names the members
  // individually. Membership is what was read, so membership is what is
  // asserted.
  const {
    CORPORATION_ROLE_BITS,
    EVEJS_ALL_CORPORATION_ROLE_MASK,
    EVEJS_FULL_LOCATIONAL_ROLE_MASK,
  } = require(ROLES_ROUTE);

  const sourceOf = new Map();
  const read = (relative) => {
    if (!sourceOf.has(relative)) {
      const file = path.join(REPO_ROOT, "server", "src", ...relative.split("/"));
      assert.equal(fs.existsSync(file), true, `${relative} has moved`);
      sourceOf.set(relative, fs.readFileSync(file, "utf8"));
    }
    return sourceOf.get(relative);
  };

  /** Every BigInt literal in `const NAME = …;`, as a Set of strings. */
  const literalsOf = (source, name) => {
    const declaration = new RegExp(`\\bconst\\s+${name}\\s*=\\s*([^;]+);`);
    const match = declaration.exec(source);
    assert.ok(match, `${name} is no longer declared upstream`);
    return new Set((match[1].match(/\d+n/g) || []).map((literal) => literal.slice(0, -1)));
  };

  for (const { role, bit, where } of CORPORATION_ROLE_BITS) {
    const split = where.lastIndexOf(" ");
    const literals = literalsOf(read(where.slice(0, split)), where.slice(split + 1));
    assert.ok(
      literals.has(String(bit)),
      `${role} is ${bit}n in routes/roles.js and no longer appears in ${where}`,
    );
  }

  // The two masks the file copies wholesale. `ALL_CORPORATION_ROLE_MASK` is an
  // array literal reduced with `|`, so its members are read the same way.
  const runtimeState = read("services/corporation/corporationRuntimeState.js");
  const orOf = (name) => [...literalsOf(runtimeState, name)]
    .reduce((mask, literal) => mask | BigInt(literal), 0n);

  assert.equal(
    orOf("ALL_CORPORATION_ROLE_MASK"),
    EVEJS_ALL_CORPORATION_ROLE_MASK,
    "upstream added or removed a corporation role bit",
  );
  assert.equal(
    orOf("CORP_ROLE_DELIVERIES_ALL")
      | orOf("CORP_ROLE_HANGAR_CAN_TAKE_ALL")
      | orOf("CORP_ROLE_HANGAR_CAN_QUERY_ALL")
      | orOf("CORP_ROLE_CONTAINER_CAN_TAKE_ALL"),
    EVEJS_FULL_LOCATIONAL_ROLE_MASK,
    "upstream changed which bits are locational, which is ESI's roles/roles_at_* split",
  );

  // Every named bit is a corporation role bit. This keeps the identically
  // numbered GM namespace out of a body.
  for (const { role, bit } of CORPORATION_ROLE_BITS) {
    assert.notEqual(bit & EVEJS_ALL_CORPORATION_ROLE_MASK, 0n, `${role} is not a corporation role`);
  }
});

// The route descriptor

test("the route descriptor agrees with the pinned spec", () => {
  const routes = require(ROLES_ROUTE);

  // `factory({})`: deps are read inside the handler, never at construction.
  const route = routes.createCharacterRolesRoute({});
  const contract = spec.assertRouteMatchesSpec(route);

  assert.equal(route.name, contract.operationId);
  assert.equal(route.producer, "app", "observed: charset=UTF-8, no trailing newline");
  assert.equal(route.rateLimitGroup, wire.CHARACTER_ROLES.rateLimitGroup);
  assert.equal(route.cacheTtl, routes.ROLES_CACHE_TTL_SECONDS);
  assert.equal(route.pageSize, undefined, "this collection is not paginated");
});

test("the path parameter is spelled the way the cross-character gate reads it", () => {
  const routes = require(ROLES_ROUTE);
  const { path: routePath } = routes.createCharacterRolesRoute({});

  assert.match(routePath, /^\/characters\/:character_id\//);
  assert.ok(routePath.includes(`:${routes.CHARACTER_ID_PARAM}`));
});

test("the route needs no subject, and gets the caller comparison by default", () => {
  // Keyed by `:character_id` and nothing else, so `lib/router.js` does not demand
  // a `subject`, and the default is the cross-character check rather than an
  // omission. The two routes in routes/structures.js are the opposite case.
  const routes = require(ROLES_ROUTE);
  const [compiled] = createRouter([routes.createCharacterRolesRoute({})]).routes;

  assert.equal(compiled.subject, SUBJECT.CALLER);
  assert.equal(compiled.localizedBody, false, "enum strings, so the three-line Vary");
});

// The handler
//
// Called through the router, which is how `loader.js` calls it and the only way
// that runs `authorise()`. A handler called directly would be tested with the
// gate switched off.

function rolesRouter(deps) {
  const { createCharacterRolesRoute } = require(ROLES_ROUTE);
  return createRouter([createCharacterRolesRoute(deps)]);
}

/**
 * A `lib/runtimeAccess.js` double.
 *
 * `member` is the shape `getCorporationMember` clones out of the corporation
 * runtime (the game's own field names, masks as decimal strings), and `null` is
 * a character the corporation runtime has never seen.
 *
 * `getCorporationSessionRoleState` is present and throws. It would answer this
 * whole question in one call, but its first statement persists a default member
 * record, so a read endpoint that used it would write into the game on the
 * first request from an unseen pilot. Wiring it as a trap is how this suite
 * asserts a negative.
 */
function runtimeDouble({
  record = { corporationID: CORPORATION_ID },
  member = null,
  corporation = { ceoID: 0 },
  omit = [],
} = {}) {
  const runtime = {
    peekCharacterRecord: (characterId, options = {}) => {
      if (record === null || characterId !== CHARACTER_ID) return null;
      const { project } = options;
      return project ? project(record, characterId) : { ...record };
    },
    getCorporationMember: (corporationId, characterId) =>
      (corporationId === CORPORATION_ID && characterId === CHARACTER_ID ? member : null),
    getCorporationRecord: (corporationId) =>
      (corporationId === CORPORATION_ID ? corporation : null),
    getCorporationSessionRoleState: () => {
      throw new Error("a read endpoint called the accessor that writes");
    },
  };

  for (const accessor of omit) delete runtime[accessor];
  return runtime;
}

/** A request carrying a verified credential for `CHARACTER_ID`. */
function authenticated(pathname, { scopes = [SCOPE], characterId = CHARACTER_ID } = {}) {
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

/** A member record with the masks eve.js would persist for the given masks. */
function memberWith({ roles = 0n, atBase = 0n, atHq = 0n, atOther = 0n, isCEO = false } = {}) {
  return {
    characterID: CHARACTER_ID,
    corporationID: CORPORATION_ID,
    roles: roles.toString(),
    grantableRoles: "0",
    rolesAtHQ: atHq.toString(),
    rolesAtBase: atBase.toString(),
    rolesAtOther: atOther.toString(),
    isCEO,
  };
}

test("routes/roles.js satisfies the contract for a member with real masks", async () => {
  const { CORP_ROLE_STATION_MANAGER } = require(ROLES_ROUTE);

  const router = rolesRouter({
    runtime: runtimeDouble({
      member: memberWith({
        roles: CORP_ROLE_STATION_MANAGER | 256n, // Station_Manager, Accountant
        atHq: 8192n | 1048576n, // Hangar_Take_1, Hangar_Query_1
        atBase: 2n, // Deliveries_Take
      }),
    }),
  });

  const result = await dispatchRequest(router, authenticated(ROLES_PATH));

  assert.equal(result.status, ROLES().successStatus);
  assertBody(result.body, ROLES());

  // Field order, not just field presence: order is bytes.
  assert.deepEqual(Object.keys(result.body), wire.CHARACTER_ROLES.fieldOrder);
  assert.deepEqual(result.body, {
    roles: ["Accountant", "Station_Manager"],
    roles_at_base: ["Deliveries_Take"],
    roles_at_hq: ["Hangar_Query_1", "Hangar_Take_1"],
    roles_at_other: [],
  });
});

test("a pilot with no roles gets four empty arrays, not an empty object", async () => {
  const router = rolesRouter({ runtime: runtimeDouble({ member: memberWith({}) }) });
  const result = await dispatchRequest(router, authenticated(ROLES_PATH));

  assert.deepEqual(result.body, {
    roles: [],
    roles_at_base: [],
    roles_at_hq: [],
    roles_at_other: [],
  });
  assertBody(result.body, ROLES());

  // `{}` would also satisfy the spec, and it is not what CCP sends.
  assert.equal(Object.keys(result.body).length, 4);
});

test("a character the corporation runtime has never seen answers empty, without writing", async () => {
  // `getCorporationSessionRoleState` would answer this in one call and persist a
  // default member record doing it. The double throws if reached, so this test
  // passing asserts that the read does not write.
  const router = rolesRouter({ runtime: runtimeDouble({ member: null }) });
  const result = await dispatchRequest(router, authenticated(ROLES_PATH), { logError: () => {} });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.roles, []);
  assertBody(result.body, ROLES());
});

test("the CEO gets the full administrative mask even with no member record", async () => {
  // eve.js's own short-circuit, reproduced: a CEO or a bit-0 holder is given the
  // full admin mask and all three locational masks at read time regardless of
  // what is persisted. That makes a missing member record answerable rather than
  // a reason to call the accessor that creates one.
  const router = rolesRouter({
    runtime: runtimeDouble({ member: null, corporation: { ceoID: CHARACTER_ID } }),
  });

  const result = await dispatchRequest(router, authenticated(ROLES_PATH));

  assertBody(result.body, ROLES());
  assert.ok(result.body.roles.includes("Director"));
  assert.ok(result.body.roles.includes("Station_Manager"), "which is what a consumer turns on");
  assert.deepEqual(result.body.roles_at_hq, result.body.roles_at_base);
  assert.ok(result.body.roles_at_other.includes("Hangar_Take_7"));
});

test("a director who is not the CEO gets the same expansion", async () => {
  const { CORP_ROLE_DIRECTOR } = require(ROLES_ROUTE);
  const router = rolesRouter({
    runtime: runtimeDouble({ member: memberWith({ roles: CORP_ROLE_DIRECTOR }) }),
  });

  const result = await dispatchRequest(router, authenticated(ROLES_PATH));

  assertBody(result.body, ROLES());
  assert.ok(result.body.roles.includes("Station_Manager"));
  assert.equal(result.body.roles.length, 23, "every administrative bit this table names");
});

test("a stale isCEO flag on the member record still expands", async () => {
  // `isCEO` is stamped when the record is built and does not follow a later
  // change of CEO, so the corporation record is asked and the flag is taken as a
  // second way to say yes. Neither alone is trusted.
  const router = rolesRouter({
    runtime: runtimeDouble({ member: memberWith({ isCEO: true }), corporation: { ceoID: 0 } }),
  });

  const result = await dispatchRequest(router, authenticated(ROLES_PATH));
  assert.ok(result.body.roles.includes("Director"));
});

test("a mask carrying a dropped bit reports the named roles and nothing else", async () => {
  // Bit 51 is `ROLE_FACTORY_SCIENCE` upstream and the candidate name
  // `Rent_Research_Facility` in CCP's enum: a near match, dropped, because nine
  // bits compete for eight names and at least one of the nine is wrong before
  // anybody argues about which.
  const router = rolesRouter({
    runtime: runtimeDouble({ member: memberWith({ roles: 2251799813685248n | 256n }) }),
  });

  const result = await dispatchRequest(router, authenticated(ROLES_PATH));

  assert.deepEqual(result.body.roles, ["Accountant"]);
  assert.ok(!result.body.roles.includes("Rent_Research_Facility"));
  assertBody(result.body, ROLES());
});

test("every version prefix reaches the handler, and reports the application", async () => {
  const router = rolesRouter({ runtime: runtimeDouble({ member: memberWith({}) }) });

  for (const prefix of wire.VERSION_PREFIXES) {
    const result = await dispatchRequest(
      router,
      authenticated(`/${prefix}/characters/${CHARACTER_ID}/roles/`),
    );
    assert.equal(result.status, 200, `/${prefix}/…/roles/ did not reach the handler`);
    assert.equal(result.producer, "app");
    assert.equal(result.authenticated, true, "the route declares a scope");
  }
});

// The gate, which this handler does not implement

test("the gate refuses before the handler runs, and the handler never sees it", async () => {
  let handlerRuns = 0;
  const routes = require(ROLES_ROUTE);
  const route = routes.createCharacterRolesRoute({
    runtime: runtimeDouble({ member: memberWith({}) }),
  });
  const router = createRouter([{
    ...route,
    handler: (params) => { handlerRuns += 1; return route.handler(params); },
  }]);

  const noToken = await dispatchRequest(router, { method: "GET", pathname: ROLES_PATH, query: {} });
  assert.equal(noToken.status, 401, "no credential");

  const wrongScope = await dispatchRequest(
    router,
    authenticated(ROLES_PATH, { scopes: ["esi-location.read_online.v1"] }),
  );
  assert.equal(wrongScope.status, 401, "a verified token without this route's scope");
  assert.match(JSON.stringify(wrongScope.body), new RegExp(SCOPE.replace(/\./g, "\\.")));

  const otherCharacter = await dispatchRequest(
    router,
    authenticated(ROLES_PATH, { characterId: CHARACTER_ID + 1 }),
  );
  assert.equal(otherCharacter.status, 403, "a token for somebody else");

  assert.equal(handlerRuns, 0, "the handler must not observe a request it was not allowed to see");
});

// A character the game cannot produce

test("a missing character record is a logged 500, not four empty arrays", async () => {
  // Four empty arrays is a valid, complete, wrong body, and eve-nexum reads an
  // empty `roles[]` as `no_role` and stops syncing, cleanly and silently. A pilot
  // who commands a corporation would look like one who does not. A 500 makes the
  // same consumer report `error` and abort.
  const logged = [];
  const router = rolesRouter({ runtime: runtimeDouble({ record: null }) });

  const result = await dispatchRequest(
    router,
    authenticated(ROLES_PATH),
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

test("a record with no corporation is a logged 500", async () => {
  const logged = [];
  const router = rolesRouter({ runtime: runtimeDouble({ record: { corporationID: null } }) });

  const result = await dispatchRequest(
    router,
    authenticated(ROLES_PATH),
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, 500);
  assert.match(logged[0][1], /corporationID/);
});

test("a missing accessor is a 500 naming it, never an empty answer", async () => {
  // "The corporation runtime has no member for this character" and "this build
  // cannot read corporation members at all" are different failures, and
  // answering the second as the first would report every pilot as roleless.
  for (const accessor of ["peekCharacterRecord", "getCorporationMember", "getCorporationRecord"]) {
    const logged = [];
    const router = rolesRouter({
      runtime: runtimeDouble({ member: memberWith({}), omit: [accessor] }),
    });

    const result = await dispatchRequest(
      router,
      authenticated(ROLES_PATH),
      { logError: (message, err) => logged.push(err.message) },
    );

    assert.equal(result.status, 500, `${accessor} was allowed to be missing`);
    assert.match(logged[0], new RegExp(accessor));
  }
});
