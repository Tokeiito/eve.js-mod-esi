/**
 * `POST /ui/autopilot/waypoint/`: the contract.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Written from CCP's document before the handler. The document settles most of
 * this operation: there is no success body, so no field order to observe and no
 * golden to record (`contract/golden/index.json` says so in its `exempt` map).
 * What is left is three query parameters, one status, and a decision about what
 * "it worked" means.
 *
 * The spec is authoritative for the whole request contract: three query
 * parameters, their types, formats and required-ness, what the two booleans
 * default to, the scope, the `ui` bucket, and the `204`, which it declares
 * alongside `default` and no numeric error status at all.
 *
 * The wire contributes one general rule, not a capture of this operation:
 * `VALIDATES_DECLARED_QUERY_PARAMS`, the observation that a declared parameter
 * is validated and an undeclared one ignored. The `--write` probe in
 * `scripts/observe-authed.js` has never been run (it sets a real pilot's route
 * in the real game), so nothing about this operation's own bytes has been seen,
 * and the tests assert that rather than work around it.
 *
 * The vendor tree is authoritative for the push: which registry knows which
 * session, and the shape of the call that reaches a client. Those assertions
 * live in `test/runtimeAccess.test.js` beside the accessor they cover.
 *
 * Three things are easy to get wrong once and impossible to notice afterwards,
 * because a `204` looks identical either way:
 *
 *   1. The `204` is bodiless on the wire: no body, and no `Content-Length`
 *      framing one.
 *   2. The character acted on is the token's subject and never anything the
 *      caller typed.
 *   3. A push that did not happen still answers `204`, and says which of three
 *      things happened in the log and nowhere else.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const spec = require(path.join(__dirname, "../contract/spec"));
const { describeOperation } = spec;
const wire = require(path.join(__dirname, "../contract/wire"));
const { SUBJECT, createRouter, dispatchRequest } = require(path.join(__dirname, "../lib/router"));

const ui = require(path.join(__dirname, "..", "routes", "ui.js"));

/**
 * CCP's own examples from the pinned document: Jita's solar system id, and
 * `contract/` holds nobody's account data (D23).
 */
const CHARACTER_ID = 90000001;
const DESTINATION_ID = 30000142;

const WAYPOINT_PATH = "/latest/ui/autopilot/waypoint/";
const WAYPOINT = () => describeOperation("post", WAYPOINT_PATH);

// What the document says

test("the operation declares 204, and no numeric error status at all", () => {
  const contract = WAYPOINT();

  assert.equal(contract.operationId, ui.OPERATION_ID);
  assert.equal(contract.successStatus, ui.SUCCESS_STATUS);
  assert.deepEqual(contract.statuses, [204]);

  // The other response is `default`, which is not a status. This is D34's
  // premise: there is no refusal on this operation to be faithful to, so every
  // candidate (404, 409, a 5xx) would be invented.
  assert.equal(contract.schema, null, "a 204 declares no JSON body to validate");
});

test("the three query parameters are the entire request contract", () => {
  const contract = WAYPOINT();

  assert.deepEqual(Object.keys(contract.queryParameters).sort(), [
    ui.ADD_TO_BEGINNING_PARAM,
    ui.CLEAR_OTHER_WAYPOINTS_PARAM,
    ui.DESTINATION_ID_PARAM,
  ].sort());

  const destination = contract.queryParameters[ui.DESTINATION_ID_PARAM];
  assert.equal(destination.required, true);
  assert.equal(destination.type, "integer");
  // int64, not int32: this parameter takes a station or structure id as readily
  // as a solar system id, and structure ids are above the int32 ceiling. The
  // coercion message the route sends interpolates this exact token.
  assert.equal(destination.format, ui.DESTINATION_FORMAT);
  assert.equal(destination.default, undefined, "no default: its absence is uncovered");
});

test("both booleans are required AND carry a default, which is not a contradiction", () => {
  // A client is told to send them, and CCP still says what an absent one means.
  // That lets this replica answer the absent case from the document, and is why
  // `destination_id` (required, no default) is the one parameter whose absence
  // has no published answer.
  for (const name of [ui.ADD_TO_BEGINNING_PARAM, ui.CLEAR_OTHER_WAYPOINTS_PARAM]) {
    const parameter = WAYPOINT().queryParameters[name];
    assert.equal(parameter.required, true, `${name} is required`);
    assert.equal(parameter.type, "boolean");
    assert.equal(parameter.default, false, `${name} defaults to false`);
  }
});

test("the scope, the bucket and the absent cache age are the document's", () => {
  const contract = WAYPOINT();

  assert.deepEqual(contract.scopes, [ui.SCOPE]);
  assert.equal(contract.rateLimit.group, ui.RATE_LIMIT_GROUP);
  assert.equal(contract.rateLimit.maxTokens, 900);
  assert.equal(contract.rateLimit.windowSize, wire.TOKEN_BUCKET.windowSize);

  // No `x-cache-age`, the only sensible thing to publish for a write: there is
  // nothing to cache and nothing for a client to poll.
  assert.equal(contract.cacheAgeSeconds, null);
});

test("nothing about this operation's own bytes has been observed, and the record says so", () => {
  // The `--write` probe sets a real pilot's route in the real game, so it is off
  // by default and has never been run. `contract/wire.js` carries that as a row
  // rather than as silence, because silence lets a later reader assume this
  // `204` looks like the CORS preflight's, which has a different producer, a
  // different six headers, and no route behind it.
  assert.equal(wire.WAYPOINT_WRITE.observed, false);
  assert.equal(wire.WAYPOINT_WRITE.kind, null, "`null` is nobody has looked, not `absent`");
  assert.equal(wire.WAYPOINT_WRITE.successStatus, WAYPOINT().successStatus);
  assert.deepEqual(wire.WAYPOINT_WRITE.declaredErrorStatuses, []);
  assert.equal(wire.WAYPOINT_WRITE.rateLimitGroup, WAYPOINT().rateLimit.group);

  // A route whose success kind was never seen gets no `SUCCESS_KIND` row, rather
  // than one derived from the authenticated reads beside it.
  assert.equal(wire.SUCCESS_KIND[ui.WAYPOINT_PATH], undefined);
  assert.equal(wire.SUCCESS_KIND[`POST ${ui.WAYPOINT_PATH}`], undefined);
});

// The route descriptor

test("the route descriptor agrees with the pinned spec", () => {
  const route = ui.createSetWaypointRoute({});
  const contract = spec.assertRouteMatchesSpec(route);

  assert.equal(route.name, contract.operationId);
  assert.equal(route.method, "POST");
  assert.equal(route.path, ui.WAYPOINT_PATH);
  assert.equal(route.successStatus, 204);
  assert.equal(route.cacheTtl, null);
  assert.equal(route.pageSize, undefined, "a 204 has no body to paginate");
});

test("the producer is `app`, because for a scoped route it is the only legal value", () => {
  // The route sends no JSON on success, which makes `null` look honest. It is
  // not: the route's refusals are JSON and `errorFamily` is derived from this
  // field, so a `null` producer would leave the coercion refusal with no family
  // to be built in. `assertScope` refuses the gateway for a scoped route, and
  // `meta` is a surface this is not.
  const [compiled] = createRouter([ui.createSetWaypointRoute({})]).routes;

  assert.equal(compiled.producer, "app");
  assert.equal(compiled.errorFamily, wire.ERROR_FAMILY.LEGACY);
  assert.equal(compiled.localizedBody, false, "there is no body, translated or otherwise");
});

test("a scoped route on the gateway producer would not compile", () => {
  assert.throws(
    () => createRouter([{ ...ui.createSetWaypointRoute({}), producer: "gateway" }]),
    /no authenticated gateway route has ever been observed/,
  );
});

test("the route is keyed by no entity, so the scope and the token are the whole gate", () => {
  // There is no `:character_id` to compare a token against (the character this
  // acts on is the token's subject), so `lib/router.js` asks for no `subject`
  // declaration and its default comparison finds nothing to compare.
  const [compiled] = createRouter([ui.createSetWaypointRoute({})]).routes;

  assert.equal(compiled.subject, SUBJECT.CALLER);
  assert.deepEqual(
    compiled.segments.filter((segment) => segment.param !== undefined),
    [],
    "no path parameters at all",
  );
});

test("the bucket this route declares is one the limiter knows, checked at boot", () => {
  // `createEsiDispatch` asserts every route's group against `GROUP_LIMITS`, so a
  // route declaring a group CCP does not publish fails at construction naming the
  // route rather than going unmetered. This asserts the route is inside that
  // guarantee, and exercises the nine-layer stack's construction with a POST
  // route in the table for the first time.
  const { createEsiDispatch } = require(path.join(__dirname, "../lib/pipeline"));
  const router = createRouter([ui.createSetWaypointRoute({})]);

  assert.equal(typeof createEsiDispatch(router, {}), "function");
  assert.equal(router.rateLimitGroupFor("POST", WAYPOINT_PATH), ui.RATE_LIMIT_GROUP);
});

// Doubles

/** A request carrying a verified credential for `CHARACTER_ID`. */
function authenticated(query = {}, { scopes = [ui.SCOPE], characterId = CHARACTER_ID } = {}) {
  return {
    method: "POST",
    pathname: WAYPOINT_PATH,
    query,
    credential: {
      presented: true,
      claims: Object.freeze({ characterId, scopes: Object.freeze([...scopes]) }),
      refusal: null,
    },
  };
}

/** The query eve-nexum sends: all three parameters, all as strings. */
function nexumQuery(overrides = {}) {
  return {
    add_to_beginning: "false",
    clear_other_waypoints: "true",
    destination_id: String(DESTINATION_ID),
    ...overrides,
  };
}

/**
 * A router around the route, with a recording runtime and a recording log.
 *
 * `sendDestinationChange` answers `outcome` unless it is an `Error`, in which
 * case it throws it, the shape of a game module that changed underneath us.
 */
function harness({ outcome = "pushed", runtime } = {}) {
  const calls = [];
  const lines = [];
  const errors = [];

  const double = runtime === undefined
    ? {
      sendDestinationChange(request) {
        calls.push(request);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    }
    : runtime;

  const router = createRouter([
    ui.createSetWaypointRoute({
      runtime: double,
      log: (line) => lines.push(line),
    }),
  ]);

  return {
    calls,
    lines,
    errors,
    dispatch: (request) => dispatchRequest(router, request, {
      logError: (message, err) => errors.push({ message, err }),
    }),
  };
}

// The success, which is a status and nothing else

test("a waypoint eve-nexum could have sent is a 204 with no body", async () => {
  const h = harness();
  const result = await h.dispatch(authenticated(nexumQuery()));

  assert.equal(result.status, 204);
  // `null`, not `undefined`: `lib/router.js` sets the field so that "this status
  // carries no body" is a fact on the result, and `server.js` reads the status
  // either way.
  assert.equal(result.body, null);
  assert.equal(result.producer, "app");
  assert.equal(result.authenticated, true);
  assert.equal(result.cacheTtl, null);
});

test("the push carries the token's character, the id and both flags", async () => {
  const h = harness();
  await h.dispatch(authenticated(nexumQuery()));

  assert.deepEqual(h.calls, [{
    characterId: CHARACTER_ID,
    destinationId: DESTINATION_ID,
    clearOtherWaypoints: true,
    addToBeginning: false,
  }]);
  assert.deepEqual(h.lines, [`${ui.OPERATION_ID}: ${ui.OUTCOME.PUSHED}`]);
});

test("the character is the token's subject, never anything the caller typed", async () => {
  // A write endpoint that took the character from the request would let any
  // holder of the scope move any pilot. This operation has no `character_id`
  // parameter, so one sent anyway is undeclared, which `contract/wire.js` records
  // the real surface as ignoring.
  const h = harness();
  await h.dispatch(authenticated(nexumQuery({ character_id: "12345678" })));

  assert.equal(h.calls[0].characterId, CHARACTER_ID);
  assert.equal(wire.VALIDATES_UNDECLARED_QUERY_PARAMS, false);
});

test("absent booleans take the document's own defaults", async () => {
  const contract = WAYPOINT();
  const h = harness();

  await h.dispatch(authenticated({ destination_id: String(DESTINATION_ID) }));

  assert.equal(
    h.calls[0].clearOtherWaypoints,
    contract.queryParameters[ui.CLEAR_OTHER_WAYPOINTS_PARAM].default,
  );
  assert.equal(
    h.calls[0].addToBeginning,
    contract.queryParameters[ui.ADD_TO_BEGINNING_PARAM].default,
  );
});

test("`true` and `false` are the two spellings, and they are read as written", async () => {
  const h = harness();

  await h.dispatch(authenticated(nexumQuery({ add_to_beginning: "true", clear_other_waypoints: "false" })));

  // `Boolean("false")` is `true`; this asserts that bug is absent.
  assert.equal(h.calls[0].addToBeginning, true);
  assert.equal(h.calls[0].clearOtherWaypoints, false);
});

// The four outcomes, none of which the caller can see

test("a pilot with no session is still a 204, and says so in the log", async () => {
  // Not "the pilot is offline": a browser pilot flying right now has no session
  // in that registry either, and this replica cannot tell the two apart. D34
  // turns on that fact.
  const h = harness({ outcome: ui.OUTCOME.NO_SESSION });
  const result = await h.dispatch(authenticated(nexumQuery()));

  assert.equal(result.status, 204);
  assert.deepEqual(h.lines, [`${ui.OPERATION_ID}: ${ui.OUTCOME.NO_SESSION}`]);
});

test("a game module that changed shape is a 204, a log line and a stack", async () => {
  // The `204` is not conditional on the push working. It is the answer because
  // this replica cannot report on the push. The drift is visible in `logError`,
  // and `test/runtimeAccess.test.js`'s vendor checks catch it a release earlier.
  const boom = new Error("sessionRegistry has no callable \"findSessionByCharacterID\"");
  const h = harness({ outcome: boom });

  const result = await h.dispatch(authenticated(nexumQuery()));

  assert.equal(result.status, 204);
  assert.deepEqual(h.lines, [`${ui.OPERATION_ID}: ${ui.OUTCOME.PUSH_FAILED}`]);
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].err, boom);
});

test("the push is unconditional: there is no switch left to turn it off", () => {
  // The notification name was confirmed against a live client on 2026-08-25, so a
  // `disabled` outcome is not something this route can produce and
  // `deps.pushEnabled` is not something it reads. Asserted because a flag would
  // not show on the wire: the route answers `204` either way.
  const route = ui.createSetWaypointRoute({ runtime: {}, log: () => {} });

  assert.equal(Object.values(ui.OUTCOME).includes("disabled"), false);
  assert.doesNotMatch(route.handler.toString(), /pushEnabled/);
});

test("a runtime without the accessor is a failed push, not a crash", async () => {
  const h = harness({ runtime: {} });
  const result = await h.dispatch(authenticated(nexumQuery()));

  assert.equal(result.status, 204);
  assert.deepEqual(h.lines, [`${ui.OPERATION_ID}: ${ui.OUTCOME.PUSH_FAILED}`]);
});

test("the log names the operation and the outcome, and nothing about the pilot", async () => {
  // An operator debugging "the button does nothing" needs one of four answers. A
  // log recording where every pilot went would be a movement log for the whole
  // server.
  for (const outcome of Object.values(ui.OUTCOME)) {
    const h = harness({ outcome });
    await h.dispatch(authenticated(nexumQuery()));

    assert.equal(h.lines.length, 1);
    assert.doesNotMatch(h.lines[0], new RegExp(String(CHARACTER_ID)));
    assert.doesNotMatch(h.lines[0], new RegExp(String(DESTINATION_ID)));
  }
});

// A destination this replica cannot deliver to

test("a destination outside JavaScript's integer range is undeliverable, not malformed", async () => {
  // The document's `int64` is wider than eve.js's ids and than a JavaScript
  // integer, so a value can be a good `destination_id` and still one this server
  // could not deliver to anybody. Refusing it with a coercion body would claim
  // CCP refuses it; it is the undeliverable case, reported like every other
  // undeliverable.
  const beyond = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const h = harness();

  const result = await h.dispatch(authenticated(nexumQuery({ destination_id: beyond.toString() })));

  assert.equal(result.status, 204);
  assert.deepEqual(h.calls, [], "nothing is handed to game code");
  assert.deepEqual(h.lines, [`${ui.OPERATION_ID}: ${ui.OUTCOME.PUSH_FAILED}`]);
});

test("deliverableId draws the line where the game can still hold the number", () => {
  assert.equal(ui.deliverableId(BigInt(DESTINATION_ID)), DESTINATION_ID);
  assert.equal(ui.deliverableId(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(ui.deliverableId(BigInt(Number.MAX_SAFE_INTEGER) + 1n), null);
  assert.equal(ui.deliverableId(0n), null);
  assert.equal(ui.deliverableId(-1n), null);
});

// The one refusal with observed bytes

test("a destination_id that is not an integer is CCP's coercion 400", async () => {
  // `VALIDATES_DECLARED_QUERY_PARAMS`: a declared parameter is validated.
  // `lib/errors.js` holds the observed body for exactly this, in exactly this
  // seat (a refusal a handler produced), and the only part this route supplies is
  // the `format` token, which comes from the document's own schema for the
  // parameter.
  assert.equal(wire.VALIDATES_DECLARED_QUERY_PARAMS, true);

  const h = harness();
  const result = await h.dispatch(authenticated(nexumQuery({ destination_id: "abc" })));

  assert.equal(result.status, 400);
  assert.deepEqual(result.body, {
    error: "failed to coerce value 'abc' into type integer (format: int64)",
  });
  assert.equal(result.producer, "app");
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.lines, [], "a request that was refused was never an attempt to push");
});

test("the coercion refusal is dressed as a routed refusal on an authenticated route", async () => {
  const h = harness();
  const result = await h.dispatch(authenticated(nexumQuery({ destination_id: "abc" })));

  assert.equal(result.headers["x-compatibility-date"], wire.COMPATIBILITY_DATE);
  assert.equal(result.headers["content-language"], wire.CONTENT_LANGUAGE);
  assert.deepEqual(result.headers.vary, [...wire.VARY]);
  // Observed five times across the authenticated captures: every refusal from an
  // authenticated route carried it.
  assert.equal(result.headers["x-esi-cache-status"], "MISS");
});

test("the forms Number() would have accepted are coercion failures, as on the real surface", async () => {
  // `1e3`, `0x2` and a bare space are all numbers to `Number()` and all refusals
  // to CCP. A leading plus and leading zeros are accepted.
  for (const raw of ["1e3", "0x2", " ", "3.5", "30000142 ", "١٢٣"]) {
    const h = harness();
    const result = await h.dispatch(authenticated(nexumQuery({ destination_id: raw })));
    assert.equal(result.status, 400, `${JSON.stringify(raw)} should not coerce`);
    assert.match(result.body.error, /failed to coerce value/);
  }

  for (const raw of ["+30000142", "030000142"]) {
    const h = harness();
    const result = await h.dispatch(authenticated(nexumQuery({ destination_id: raw })));
    assert.equal(result.status, 204, `${JSON.stringify(raw)} is an integer to CCP`);
    assert.equal(h.calls[0].destinationId, DESTINATION_ID);
  }
});

test("a value past the int64 ceiling never became an int64, so it is a coercion failure", async () => {
  // The rule one width up from `?page=2147483648`, which CCP answers as a
  // coercion failure rather than a range error: "outside the declared width"
  // reads as "it never became that type".
  const h = harness();
  const result = await h.dispatch(authenticated(nexumQuery({
    destination_id: (ui.INT64_MAX + 1n).toString(),
  })));

  assert.equal(result.status, 400);
  assert.match(result.body.error, /into type integer \(format: int64\)/);
});

// The two refusals this replica will not invent

test("an empty destination_id is the same request as sending none", async () => {
  // `lib/pagination.js`'s rule for `?page=`, and the only rule this mod has for
  // an empty query value. A space is different: CCP was observed refusing
  // `?page=%20` as a coercion failure, and it is refused as one above.
  const h = harness();
  const result = await h.dispatch(authenticated(nexumQuery({ destination_id: "" })));

  assert.equal(result.status, 500);
  assert.equal(h.errors[0].err.name, "UnobservedRefusal");
});

test("an absent destination_id is a logged 500, not an invented 400", async () => {
  // The document declares it required, publishes no default and no numeric error
  // status, and CCP's refusal for an absent required query parameter has never
  // been observed on any route. D31 records what a guessed refusal is worth:
  // wrong in status, family, producer, content-type and last byte at once.
  // Loudly wrong beats quietly invented, and one curl settles it.
  const h = harness();
  const result = await h.dispatch(authenticated({ clear_other_waypoints: "true", add_to_beginning: "false" }));

  assert.equal(result.status, 500);
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].err.name, "UnobservedRefusal");
  assert.match(h.errors[0].err.message, /has never been observed/);
  assert.deepEqual(h.calls, []);
});

test("a boolean spelled a third way is a logged 500 for the same reason", async () => {
  for (const raw of ["1", "0", "yes", "TRUE", "True", "on"]) {
    const h = harness();
    const result = await h.dispatch(authenticated(nexumQuery({ add_to_beginning: raw })));

    assert.equal(result.status, 500, `${JSON.stringify(raw)} is not one of CCP's two spellings`);
    assert.equal(h.errors[0].err.name, "UnobservedRefusal");
    assert.deepEqual(h.calls, []);
  }
});

test("the refusal to guess is a class, so a real handler fault is still distinguishable", () => {
  // A `TypeError` from a handler that fell over and a deliberate "this refusal
  // has never been seen" are the same 500 on the wire and must not be the same
  // in the log.
  assert.ok(new ui.UnobservedRefusal("x") instanceof Error);
  assert.equal(new ui.UnobservedRefusal("x").name, "UnobservedRefusal");

  assert.throws(() => ui.readWaypointRequest({}), ui.UnobservedRefusal);
  assert.throws(
    () => ui.readWaypointRequest({ destination_id: "1", add_to_beginning: "1" }),
    ui.UnobservedRefusal,
  );
});

// The gate

test("the write is refused without a token, and with a token that lacks the scope", async () => {
  const h = harness();

  const noToken = await h.dispatch({ method: "POST", pathname: WAYPOINT_PATH, query: nexumQuery() });
  assert.equal(noToken.status, 401);

  const wrongScope = await h.dispatch(authenticated(nexumQuery(), {
    scopes: ["esi-characters.read_contacts.v1"],
  }));
  assert.equal(wrongScope.status, 401);
  assert.match(wrongScope.body.error, new RegExp(ui.SCOPE.replace(/\./g, "\\.")));

  assert.deepEqual(h.calls, [], "a refused request never reaches the game");
  assert.deepEqual(h.lines, []);
});

test("a GET is a 405, because this operation is a POST and only a POST", async () => {
  const h = harness();
  const result = await h.dispatch({ method: "GET", pathname: WAYPOINT_PATH, query: nexumQuery() });

  assert.equal(result.status, 405);
  assert.deepEqual(result.headers.allow, ["POST"]);
});

// The module

test("the module's exports are frozen, and so are its constant tables", () => {
  assert.ok(Object.isFrozen(ui));
  assert.ok(Object.isFrozen(ui.OUTCOME));
  assert.ok(Object.isFrozen(ui.BOOLEAN_VALUES));
});

test("the outcomes are D34's three, and only those", () => {
  assert.deepEqual(Object.values(ui.OUTCOME).sort(), [
    "no-session",
    "push-failed",
    "pushed",
  ]);
});
