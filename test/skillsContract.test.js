/**
 * `GET /characters/{character_id}/skills/`: the contract.
 *
 * Run with: node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Written before the handler, as `contract/spec.js` insists, and read the same
 * way as `test/charactersContract.test.js`: the spec is authoritative for the
 * body and for the numbers a client polls on, and `contract/wire.js` for what
 * the spec has no vocabulary for.
 *
 * There is no capture of this operation. It was not in the 2026-08-25 runs, so
 * `contract/wire.js` has no `CHARACTER_SKILLS` record, and adding one derived
 * from reasoning would put reasoning into the file that holds observations.
 * Two consequences shape what is asserted:
 *
 *   1. This route's wire behaviour is known by class rather than by route: it
 *      declares a scope and sends JSON, so its producer has exactly one legal
 *      value, and that one declaration decides the content type, the trailing
 *      newline, the etag strength, the `Expires` basis, the error family and
 *      the conditional-request rules. Those are asserted against the
 *      producer's rows, which are observed, rather than a row for this path.
 *
 *   2. The field order, the row order and the zero-`unallocated_sp` question
 *      are choices `routes/skills.js` argues. The suite pins them as choices
 *      so they cannot drift silently, and says in each case that a capture
 *      would outrank it.
 *
 * The suite asserts that `wire.SUCCESS_KIND` has no entry for this path. A
 * future capture will add one, and that assertion then sends a reader here to
 * reconcile the two.
 *
 * The last section covers a read that could not be done as intended.
 * `services/skills/skillState` has no non-writing door: all five of its public
 * character reads funnel through `ensureCharacterSkills`, which seeds a skill
 * set for a character who has none. So the numbers come off the `skills` table
 * through the read-only handle, and that section is about the two kinds of
 * empty this produces: a character with no row, which is an answer, and a
 * table that cannot be read, which is not.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const spec = require(path.join(__dirname, "../contract/spec"));
const { SpecContractError, assertBody, describeOperation } = spec;
const wire = require(path.join(__dirname, "../contract/wire"));
const { createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));
const { createCacheDispatch } = require(path.join(__dirname, "../lib/cache"));

const SKILLS_ROUTE = path.join(__dirname, "..", "routes", "skills.js");

/**
 * The subject of every token below.
 *
 * CCP's `CharacterID` example from the pinned spec, which is documented,
 * synthetic and nobody's: `contract/` and this suite hold no real character's
 * data (D23).
 */
const CHARACTER_ID = 90000001;

/** The wire path, not the spec path. `/v1/.../skills/` is the same operation. */
const SKILLS_PATH = `/latest/characters/${CHARACTER_ID}/skills/`;

const SKILLS = () => describeOperation("get", SKILLS_PATH);

const SCOPE = "esi-skills.read_skills.v1";

// What the spec says

test("the envelope requires the list and the total, and nothing else", () => {
  const contract = SKILLS();

  assert.deepEqual(contract.requiredKeys, ["skills", "total_sp"]);
  assert.deepEqual(contract.optionalKeys, ["unallocated_sp"]);
  assert.equal(contract.schema.properties.skills.type, "array");
  assert.equal(contract.schema.properties.total_sp.type, "integer");
  assert.equal(contract.schema.properties.unallocated_sp.type, "integer");
});

test("every field of a skill entry is required, and all four are int64", () => {
  // This is why `routes/skills.js` refuses a row it cannot read rather than
  // omitting a field from it: there is no optional field here to omit.
  const item = spec.resolveSchema(SKILLS().spec, SKILLS().schema.properties.skills.items);

  assert.deepEqual(
    [...item.required].sort(),
    ["active_skill_level", "skill_id", "skillpoints_in_skill", "trained_skill_level"],
  );
  assert.deepEqual(Object.keys(item.properties).sort(), [...item.required].sort());

  for (const [field, schema] of Object.entries(item.properties)) {
    assert.equal(schema.type, "integer", `${field} is an integer`);
    assert.equal(schema.format, "int64", `${field} is int64`);
  }
});

test("the scope, and it is the skills family rather than location's", () => {
  // A wrong scope on an authenticated route is a route nobody can reach with the
  // token they were told to ask for.
  assert.deepEqual(SKILLS().scopes, [SCOPE]);
});

test("the numbers a client polls on", () => {
  const contract = SKILLS();

  assert.equal(contract.cacheAgeSeconds, 60);
  // `char-detail`, which is half of the `char-location` allowance of
  // `/characters/{id}/online|location|ship`. A route that declared the wrong
  // bucket would spend somebody else's budget and refuse at the wrong rate.
  assert.deepEqual(contract.rateLimit, {
    group: "char-detail",
    maxTokens: 600,
    windowSize: "15m",
  });
  assert.deepEqual(contract.statuses, [200], "the spec declares no error status");
  assert.equal(contract.successStatus, 200);
});

test("the version prefix does not change the operation", () => {
  for (const prefix of ["/latest", "/v1", "/v4"]) {
    assert.equal(
      describeOperation("get", `${prefix}/characters/${CHARACTER_ID}/skills/`).operationId,
      "GetCharactersCharacterIdSkills",
    );
  }
});

// What is known by class, because nothing was captured

test("this operation has no wire record, and that is asserted rather than assumed", () => {
  // The 2026-08-25 runs did not include it. `contract/wire.js` holds
  // observations; a CHARACTER_SKILLS constant derived from reasoning would be
  // indistinguishable from one derived from a `curl`, which is the confusion
  // that file exists to prevent.
  //
  // When a capture lands, this assertion fails and sends whoever recorded it
  // here to reconcile the choices below with it.
  assert.equal(wire.SUCCESS_KIND["/characters/:character_id/skills"], undefined);
  assert.equal(wire.CHARACTER_SKILLS, undefined);

  // The sibling paths that were captured still are, so the absence above is
  // this operation's and not a broken lookup.
  assert.equal(wire.SUCCESS_KIND["/characters/:character_id/roles"], wire.KIND.APP_SUCCESS);
});

test("the producer has one legal value, which is why it is not a guess", () => {
  // A scoped route that sends JSON cannot be the gateway (`lib/router.js`
  // `assertScope` refuses to compile one), is not the `/meta/` surface, and
  // does not send `null`. So `app` is derived from the route's own declaration
  // rather than inferred from a sibling path: the parent `GET /characters/{id}/`
  // is the gateway.
  const route = require(SKILLS_ROUTE).createCharacterSkillsRoute({});
  assert.equal(route.producer, "app");
  assert.equal(wire.SUCCESS_KIND["/characters/:character_id"], wire.KIND.GATEWAY_SUCCESS);

  // What that one declaration decides, off rows that were observed.
  assert.equal(wire.CONTENT_TYPE[wire.KIND.APP_SUCCESS], "application/json; charset=UTF-8");
  assert.equal(wire.TRAILING_NEWLINE[wire.KIND.APP_SUCCESS], false);
  assert.deepEqual(wire.ETAG[wire.KIND.APP_SUCCESS], { algorithm: "sha224", weak: false });
  assert.equal(wire.EXPIRES_BASIS[wire.KIND.APP_SUCCESS], "lastModified");
});

test("an authenticated route sends private where the same producer sends public", () => {
  // Not this module's code, but the fact that matters most about it: a shared
  // cache handed one pilot's skill sheet to the next caller is what `public` on
  // this route would invite.
  assert.equal(wire.AUTHENTICATED_CACHE_CONTROL, "private");
  assert.equal(wire.CACHE_CONTROL[wire.KIND.APP_SUCCESS](60), "public");
});

// What a plausible-but-wrong body does

test("a body missing total_sp is rejected", () => {
  // The plausible first implementation: the list is the interesting part and
  // the total looks derivable, so nobody sends it.
  assert.throws(
    () => assertBody({ skills: [] }, SKILLS()),
    (err) => err instanceof SpecContractError
      && /body\.total_sp is required by the spec and is missing/.test(err.message),
  );
});

test("a skill entry missing active_skill_level is rejected", () => {
  // The mistake this endpoint invites: eve.js stores `trainedSkillLevel` and
  // `effectiveSkillLevel`, they are equal on almost every row, and sending one
  // of them looks like enough.
  assert.throws(
    () => assertBody(
      { skills: [{ skill_id: 3300, trained_skill_level: 5, skillpoints_in_skill: 256000 }], total_sp: 256000 },
      SKILLS(),
    ),
    (err) => /body\.skills\[0\]\.active_skill_level is required by the spec and is missing/
      .test(err.message),
  );
});

test("a null unallocated_sp is a contract failure, not an absence", () => {
  // The pinned document declares no nullable field anywhere, so a pilot with no
  // free SP is a number or an omitted key and never a `null`.
  assert.throws(
    () => assertBody({ skills: [], total_sp: 0, unallocated_sp: null }, SKILLS()),
    (err) => /body\.unallocated_sp is null, and the .* spec declares no nullable fields/
      .test(err.message),
  );
});

test("skill points that arrive as a string are rejected", () => {
  assert.throws(
    () => assertBody(
      {
        skills: [{
          active_skill_level: 5,
          skill_id: 3300,
          skillpoints_in_skill: "256000",
          trained_skill_level: 5,
        }],
        total_sp: 256000,
      },
      SKILLS(),
    ),
    (err) => /body\.skills\[0\]\.skillpoints_in_skill: expected integer, got string/.test(err.message),
  );
});

test("helpfully adding the character's own id is rejected", () => {
  // The token said which character this is, and passing it along reads as a
  // courtesy. A field CCP does not send is as visible as one it does.
  assert.throws(
    () => assertBody({ skills: [], total_sp: 0, character_id: CHARACTER_ID }, SKILLS()),
    (err) => /body\.character_id is not in the spec/.test(err.message),
  );
});

test("eve.js's own skill-record field names are rejected", () => {
  // The failure a handler returning the store row would produce. The projection
  // in `routes/skills.js` exists to make it impossible.
  assert.throws(
    () => assertBody(
      { skills: [{ typeID: 3300, skillLevel: 5, skillPoints: 256000 }], total_sp: 256000 },
      SKILLS(),
    ),
    (err) => /body\.skills\[0\]\.typeID is not in the spec/.test(err.message),
  );
});

// The handler
//
// Called through the router, as `loader.js` calls it. That is the only way to
// cover all nine version prefixes and the only way that runs `authorise()`. A
// handler called directly is tested with the gate switched off.

/** The endpoint as it actually runs: a one-route table and the real router. */
function skillsRouter(deps) {
  const { createCharacterSkillsRoute } = require(SKILLS_ROUTE);
  return createRouter([createCharacterSkillsRoute(deps)]);
}

/**
 * A `lib/runtimeAccess.js` double.
 *
 * `rows` is the shape `listCharacterSkills` returns, in the game's own
 * spelling (`typeID`, `effectiveSkillLevel` and so on), and `null` is a read
 * that could not be done, which is a different thing from `[]`.
 */
function runtimeDouble({
  rows = [],
  freeSkillPoints = 0,
  record = true,
  omitSkillsAccessor = false,
  omitRecordAccessor = false,
} = {}) {
  const runtime = {};

  if (!omitSkillsAccessor) {
    runtime.listCharacterSkills = (characterId) => (
      characterId === CHARACTER_ID ? rows : null
    );
  }

  if (!omitRecordAccessor) {
    runtime.peekCharacterRecord = (characterId, options = {}) => {
      if (!record || characterId !== CHARACTER_ID) return null;
      const source = { freeSkillPoints };
      return options.project ? options.project(source, characterId) : { ...source };
    };
  }

  return runtime;
}

/**
 * A request carrying a verified credential for `CHARACTER_ID`.
 *
 * The shape `lib/bearerCredential.js` builds and `lib/router.js` reads.
 * Nothing here signs anything: the gate's inputs are the credential and the
 * route.
 */
function authenticated(pathname, { scopes = [SCOPE], characterId = CHARACTER_ID, headers = {} } = {}) {
  return {
    method: "GET",
    pathname,
    query: {},
    headers,
    credential: {
      presented: true,
      claims: Object.freeze({ characterId, scopes: Object.freeze([...scopes]) }),
      refusal: null,
    },
  };
}

/**
 * Two skills, both invented.
 *
 * The type ids are real published SDE skills (`3300` is Gunnery and `3327`
 * Spaceship Command), which are static data and name nobody. The levels and
 * point totals are made up.
 *
 * `3327` is trained to 3 and active at 4, which is the case CCP's
 * `active_skill_level` description exists for and the case a handler mapping
 * both fields off `trainedSkillLevel` gets wrong on every row.
 */
const ROWS = Object.freeze([
  Object.freeze({ typeID: 3327, trainedSkillLevel: 3, effectiveSkillLevel: 4, skillPoints: 8000 }),
  Object.freeze({ typeID: 3300, trainedSkillLevel: 5, effectiveSkillLevel: 5, skillPoints: 256000 }),
]);

test("the route descriptor agrees with the pinned spec", () => {
  const routes = require(SKILLS_ROUTE);
  const route = routes.createCharacterSkillsRoute({});
  const contract = spec.assertRouteMatchesSpec(route);

  assert.equal(route.name, contract.operationId, "the route's name is the spec's operationId");
  assert.equal(route.cacheTtl, contract.cacheAgeSeconds);
  assert.equal(route.rateLimitGroup, contract.rateLimit.group);
  assert.equal(route.scope, contract.scopes[0]);
});

test("the path parameter is spelled the way the cross-character gate reads it", () => {
  // `lib/router.js` `authorise()` compares the token's subject against the path
  // parameter named `character_id`. Any other spelling leaves it nothing to
  // compare and disables the gate on a route that otherwise looks like it works.
  const routes = require(SKILLS_ROUTE);
  const { path: routePath } = routes.createCharacterSkillsRoute({});

  assert.equal(routePath, "/characters/:character_id/skills");
  assert.ok(routePath.includes(`:${routes.CHARACTER_ID_PARAM}`));
});

test("routes/skills.js satisfies the contract", async () => {
  const router = skillsRouter({ runtime: runtimeDouble({ rows: ROWS, freeSkillPoints: 12500 }) });

  const result = await dispatchRequest(router, authenticated(SKILLS_PATH));

  assert.equal(result.status, 200);
  assertBody(result.body, SKILLS());

  // Sorted by `skill_id`, which is not the order `ROWS` declares them in. See
  // the row-order test below.
  assert.deepEqual(result.body, {
    skills: [
      { active_skill_level: 5, skill_id: 3300, skillpoints_in_skill: 256000, trained_skill_level: 5 },
      { active_skill_level: 4, skill_id: 3327, skillpoints_in_skill: 8000, trained_skill_level: 3 },
    ],
    total_sp: 264000,
    unallocated_sp: 12500,
  }, "and the two levels are not the same field read twice");
});

test("field order is alphabetical at both levels, and order is bytes", () => {
  // A choice rather than a reading (see the header). Pinned so it cannot drift
  // silently; a capture would outrank it.
  const { projectCharacterSkill, projectCharacterSkills } = require(SKILLS_ROUTE);

  assert.deepEqual([...projectCharacterSkills.fields], ["skills", "total_sp", "unallocated_sp"]);
  assert.deepEqual([...projectCharacterSkill.fields], [
    "active_skill_level",
    "skill_id",
    "skillpoints_in_skill",
    "trained_skill_level",
  ]);

  for (const fields of [projectCharacterSkills.fields, projectCharacterSkill.fields]) {
    assert.deepEqual([...fields].sort(), [...fields], "not alphabetical");
  }

  // The pinned document carries two orders for the entry, so its key order
  // cannot be the evidence: `properties` is alphabetical and `required` is not.
  // `/ship/` shows the same the other way round.
  const item = spec.resolveSchema(SKILLS().spec, SKILLS().schema.properties.skills.items);
  assert.deepEqual(item.required, [
    "skill_id",
    "trained_skill_level",
    "active_skill_level",
    "skillpoints_in_skill",
  ]);
  assert.notDeepEqual(item.required, Object.keys(item.properties));
});

test("rows come back sorted by skill_id, whatever order the table held them in", async () => {
  // Unobserved, and a stable order rather than a hash order: two identical
  // requests must not produce two different bodies, because that is two
  // different etags and a client revalidating forever.
  const router = skillsRouter({ runtime: runtimeDouble({ rows: ROWS }) });

  const first = await dispatchRequest(router, authenticated(SKILLS_PATH));
  const second = await dispatchRequest(router, authenticated(SKILLS_PATH));

  assert.deepEqual(first.body.skills.map((skill) => skill.skill_id), [3300, 3327]);
  assert.deepEqual(first.body, second.body);
});

test("total_sp is summed from the rows rather than trusted from the record", async () => {
  // The character record's `skillPoints` is a denormalised copy that only
  // `syncCharacterSkillPoints` refreshes, and only `ensureCharacterSkills` calls
  // that, which is the write this replica refuses to make. So the record may say
  // anything; the body's total must agree with the body's own rows.
  const router = skillsRouter({
    runtime: {
      listCharacterSkills: () => ROWS,
      peekCharacterRecord: (characterId, options) => options.project(
        { freeSkillPoints: 0, skillPoints: 999999999 },
        characterId,
      ),
    },
  });

  const result = await dispatchRequest(router, authenticated(SKILLS_PATH));

  assert.equal(result.body.total_sp, 264000);
  assert.equal(
    result.body.total_sp,
    result.body.skills.reduce((sum, skill) => sum + skill.skillpoints_in_skill, 0),
  );
});

test("every version prefix reaches the handler, and reports the application", async () => {
  const router = skillsRouter({ runtime: runtimeDouble({ rows: ROWS }) });

  for (const prefix of wire.VERSION_PREFIXES) {
    const result = await dispatchRequest(
      router,
      authenticated(`/${prefix}/characters/${CHARACTER_ID}/skills/`),
    );
    assert.equal(result.status, 200, `/${prefix}/…/skills/ did not reach the handler`);
    assert.equal(result.producer, "app");
    assert.equal(result.authenticated, true, "the route declares a scope");
  }
});

// unallocated_sp, the one optional field

test("a zero unallocated_sp is sent, because zero is something eve.js knows", async () => {
  // The choice, on unobserved ground, argued in routes/skills.js:
  // `characterState` normalises `freeSkillPoints` to an integer on every record
  // it writes, so `0` is a fact rather than an absence, and omitting it would
  // mean the field never appeared on a server where nobody has been granted
  // free SP, which is most of them.
  const router = skillsRouter({ runtime: runtimeDouble({ rows: ROWS, freeSkillPoints: 0 }) });

  const result = await dispatchRequest(router, authenticated(SKILLS_PATH));

  assert.equal(result.body.unallocated_sp, 0);
  assert.deepEqual(Object.keys(result.body), ["skills", "total_sp", "unallocated_sp"]);
  assertBody(result.body, SKILLS());
});

test("an unreadable record omits unallocated_sp rather than sending a zero", async () => {
  // The other side, and the reason `optional()` is still there: a record the
  // game does not have is an absence, and an absent optional field is omitted
  // rather than sent as `null` or as a `0` a client would act on.
  for (const runtime of [
    runtimeDouble({ rows: ROWS, record: false }),
    runtimeDouble({ rows: ROWS, omitRecordAccessor: true }),
    runtimeDouble({ rows: ROWS, freeSkillPoints: "not a number" }),
  ]) {
    const result = await dispatchRequest(skillsRouter({ runtime }), authenticated(SKILLS_PATH));

    assert.equal(result.status, 200, "a missing optional field costs a field, not the answer");
    assert.deepEqual(Object.keys(result.body), ["skills", "total_sp"]);
    assertBody(result.body, SKILLS());
  }
});

// The gate, which this handler does not implement

test("the gate refuses before the handler runs, and the handler never sees it", async () => {
  // Not this module's code, but its contract: these three refusals are why the
  // handler can assume `params.credential` is a verified token carrying this
  // scope for the character in the path.
  let handlerRuns = 0;
  const route = require(SKILLS_ROUTE).createCharacterSkillsRoute({
    runtime: runtimeDouble({ rows: ROWS }),
  });
  const router = createRouter([{
    ...route,
    handler: (params) => { handlerRuns += 1; return route.handler(params); },
  }]);

  const noToken = await dispatchRequest(router, {
    method: "GET",
    pathname: SKILLS_PATH,
    query: {},
    headers: {},
  });
  assert.equal(noToken.status, 401, "no credential");

  const wrongScope = await dispatchRequest(
    router,
    authenticated(SKILLS_PATH, { scopes: ["esi-skills.read_skillqueue.v1"] }),
  );
  assert.equal(wrongScope.status, 401, "a verified token without this route's scope");
  assert.match(
    JSON.stringify(wrongScope.body),
    /esi-skills\.read_skills\.v1/,
    "and the refusal names the scope the caller should have asked for",
  );

  const otherCharacter = await dispatchRequest(
    router,
    authenticated(SKILLS_PATH, { characterId: CHARACTER_ID + 1 }),
  );
  assert.equal(otherCharacter.status, 403, "a token for somebody else");

  assert.equal(handlerRuns, 0, "the handler must not observe a request it was not allowed to see");
});

test("the sibling skills scope does not open this route", async () => {
  // `/skillqueue/` is the other operation under CCP's Skills tag and this
  // replica does not implement it, but its scope exists, a token can carry it,
  // and a gate that matched on the scope family would let it through.
  const router = skillsRouter({ runtime: runtimeDouble({ rows: ROWS }) });

  const result = await dispatchRequest(
    router,
    authenticated(SKILLS_PATH, { scopes: ["esi-skills.read_skillqueue.v1"] }),
  );

  assert.equal(result.status, 401);
});

// Two kinds of empty, and only one of them is an answer

test("a character with no skills row answers with an empty list, not a refusal", async () => {
  // eve.js seeds skills lazily, on the first call through
  // `ensureCharacterSkills` (the call this replica refuses to make), so a
  // character who has not been through one has none. `[]` with a total of `0` is
  // complete and honest, and this route deliberately does not change it.
  const router = skillsRouter({ runtime: runtimeDouble({ rows: [] }) });

  const result = await dispatchRequest(router, authenticated(SKILLS_PATH));

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { skills: [], total_sp: 0, unallocated_sp: 0 });
  assertBody(result.body, SKILLS());
});

test("a skills table that cannot be read is a logged 500, not an empty pilot", async () => {
  // `skills` and `total_sp` are both required and there is no honest
  // substitute. `total_sp: 0` is a number a fitting tool acts on: it would
  // report that the pilot can fly nothing. It is not a 404 either: the token
  // proves this server minted a credential for that character.
  const logged = [];
  const router = skillsRouter({
    runtime: { listCharacterSkills: () => null, peekCharacterRecord: () => null },
  });

  const result = await dispatchRequest(
    router,
    authenticated(SKILLS_PATH),
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

test("a runtime with no skills accessor at all is a 500, not an empty pilot", async () => {
  // "The game has no skills for this character" and "this build of the mod
  // cannot read skills at all" are different failures, and answering the second
  // as the first would report every pilot on the server as untrained.
  const router = skillsRouter({ runtime: runtimeDouble({ omitSkillsAccessor: true }) });

  const result = await dispatchRequest(
    router,
    authenticated(SKILLS_PATH),
    { logError: () => {} },
  );

  assert.equal(result.status, 500);
});

test("a row that cannot supply a required field is a logged 500 naming it", async () => {
  // No omission is available on a skill entry, so an unreadable row is a
  // refusal rather than a body missing a required key, and rather than a
  // dropped row, which would silently subtract that skill's points from
  // `total_sp` and hand a client a pilot who cannot fly their own ship.
  const logged = [];
  const router = skillsRouter({
    runtime: runtimeDouble({
      rows: [{ typeID: 3300, trainedSkillLevel: 5, effectiveSkillLevel: 5, skillPoints: NaN }],
    }),
  });

  const result = await dispatchRequest(
    router,
    authenticated(SKILLS_PATH),
    { logError: (message, err) => logged.push([message, err.message]) },
  );

  assert.equal(result.status, 500);
  assert.match(logged[0][1], /skillpointsInSkill/);
  assert.match(logged[0][1], /3300/, "and names the row");
});

// The headers, and the 304
//
// Through `lib/cache.js`'s real layer rather than by asserting a table, as
// `test/universeContract.test.js` does for snapshot behaviour: what a client
// sees is what the layer computes over this route's own body.
//
// The mechanism is the subject of `test/conditional.test.js` and
// `test/cache.test.js` and is not re-proved here. This route's business is
// that it arrives at that layer declaring the right three things (the
// application producer, a 60 s TTL and a credential requirement) and so comes
// out with the private, application-shaped header set.

const NOW = Date.parse("2026-09-10T11:00:00Z");

/** The endpoint behind the cache layer, with a clock that does not move. */
function cachedSkills(runtime) {
  const router = skillsRouter({ runtime });
  return createCacheDispatch(
    (request) => dispatchRequest(router, request, { logError: () => {}, now: () => NOW }),
    { now: () => NOW },
  );
}

test("the header set is the application's, with private for the credential", async () => {
  const dispatch = cachedSkills(runtimeDouble({ rows: ROWS, freeSkillPoints: 12500 }));

  const result = await dispatch(authenticated(SKILLS_PATH));

  assert.equal(result.status, 200);

  // `private`, not the bare `public` this producer sends on a public route. The
  // header is all that stops a shared cache handing one pilot's skill sheet to
  // the next caller.
  assert.equal(result.headers["cache-control"], wire.AUTHENTICATED_CACHE_CONTROL);

  // Strong SHA-224 (56 hex, no `W/`): the application's etag, not the
  // gateway's weak SHA-256.
  assert.match(result.headers.etag, /^"[0-9a-f]{56}"$/);

  // `Expires` is measured from `Last-Modified` on this producer, not from
  // `Date`: the window shrinks as the body ages rather than being renewed on
  // every request.
  const lastModified = Date.parse(result.headers["last-modified"]);
  assert.equal(Date.parse(result.headers.expires) - lastModified, 60 * 1000);

  // No trailing newline: the application does not write one, so 60 bytes of
  // JSON is 60 bytes on the wire.
  assert.equal(result.payload[result.payload.length - 1] === 0x0a, false);
});

test("a matching If-None-Match is a 304 with no body", async () => {
  const dispatch = cachedSkills(runtimeDouble({ rows: ROWS, freeSkillPoints: 12500 }));

  const first = await dispatch(authenticated(SKILLS_PATH));
  assert.equal(first.status, 200);

  const second = await dispatch(
    authenticated(SKILLS_PATH, { headers: { "if-none-match": first.headers.etag } }),
  );

  assert.equal(second.status, 304);
  assert.equal(second.body, undefined, "a 304 carries no bytes");
  assert.equal(second.headers.etag, first.headers.etag);
  // The application keeps both validators on its 304 and keeps `private` with
  // them, which concerns the credential rather than the producer.
  assert.equal(second.headers["last-modified"], first.headers["last-modified"]);
  assert.equal(second.headers["cache-control"], wire.AUTHENTICATED_CACHE_CONTROL);
});

test("an If-None-Match that matches nothing is a 200 with the body", async () => {
  const dispatch = cachedSkills(runtimeDouble({ rows: ROWS }));

  const result = await dispatch(
    authenticated(SKILLS_PATH, { headers: { "if-none-match": `"${"0".repeat(56)}"` } }),
  );

  assert.equal(result.status, 200);
  assertBody(result.body, SKILLS());
});

test("the etag follows the body, so a trained level moves it", async () => {
  // What a client's revalidation depends on: if the digest did not move when a
  // skill finished training, every cache on the path would keep serving the old
  // sheet until the 60 s window ran out.
  const before = await cachedSkills(runtimeDouble({ rows: ROWS }))(authenticated(SKILLS_PATH));
  const after = await cachedSkills(runtimeDouble({
    rows: [{ typeID: 3300, trainedSkillLevel: 5, effectiveSkillLevel: 5, skillPoints: 256000 },
      { typeID: 3327, trainedSkillLevel: 4, effectiveSkillLevel: 4, skillPoints: 45255 }],
  }))(authenticated(SKILLS_PATH));

  assert.notEqual(before.headers.etag, after.headers.etag);
});
