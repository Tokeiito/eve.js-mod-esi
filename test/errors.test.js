/**
 * `lib/errors.js`: are our refusals byte-identical to CCP's?
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * There is a test per status code asserting the exact body bytes: the
 * assertions compare serialized output against strings copied out of `curl`,
 * held in `contract/wire.js`. Key order is part of byte-exactness, which is why
 * the builders assemble their objects in CCP's order.
 *
 * So is the last byte. Go's encoder ends every body it writes with a newline,
 * so the `401` CCP sends is 45 bytes, not the 44 of `JSON.stringify`. `json()`
 * below is the text a client parses and `onTheWire()` is what goes down the
 * socket; assertions use the first where the point is the wording and the
 * second where the point is the length.
 *
 * There is no single ESI error shape. The `2020-01-01` surface is two
 * implementations behind one hostname, and which one answers is a property of
 * the route:
 *
 *   GET /latest/universe/systems/abc/    400  {"error":"failed to coerce ..."}
 *   GET /latest/characters/abc/          422  {"status":422,"error":"validation failed","details":[...]}
 *
 * Same mistake, different status, different body, different `content-type`.
 * Universe and static routes are on the older one; character, corporation and
 * alliance routes have been migrated. This mod's endpoints straddle the line,
 * so a route declares its family the way it declares its cache TTL, and every
 * assertion below is written per family rather than per status.
 *
 * The third family is the edge (401 and `Invalid tenant`), which happens before
 * a route is reached and belongs to no route.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const {
  FAMILY,
  MISSING_REQUIRED_ROLE,
  NOT_IN_CORPORATION,
  coercionFailed,
  internalServerError,
  invalidTenant,
  methodNotAllowed,
  missingRequiredRole,
  notFound,
  notInCorporation,
  unauthorized,
  unrouted,
} = require(path.join(__dirname, "../lib/errors"));

/** The JSON text of a refusal: what a client parses, without the newline. */
const json = (result) => JSON.stringify(result.body);

/** What goes down the socket, newline and all, as `server.js` writes it. */
const onTheWire = (result) => serializeBody(result.body, result.producer);

// The families are the ones that were observed

test("the families and their content types match what was observed", () => {
  // lib/ cannot import contract/ (test-only, never deployed, D20), so the values
  // are duplicated and this test checks that they agree.
  assert.deepEqual(Object.values(FAMILY).sort(), Object.values(wire.ERROR_FAMILY).sort());

  for (const family of Object.values(FAMILY)) {
    const observed = wire.ERROR_SHAPE[family];
    const produced = notFound(family, { entity: "Region" });

    assert.equal(
      produced.headers["content-type"],
      observed.contentType,
      `${family} sends the wrong content-type`,
    );
    assert.equal(
      produced.headers["x-content-type-options"],
      observed.nosniff ? "nosniff" : undefined,
      `${family} disagrees with the observed nosniff behaviour`,
    );
    assert.equal(
      onTheWire(produced).toString("utf8").endsWith("\n"),
      observed.trailingNewline,
      `${family} disagrees with the observed trailing newline`,
    );
  }
});

test("a refusal weighs what CCP's weighs, to the byte", () => {
  // `content-length` counted from our own bytes against the `Content-Length`
  // observed on the real response. Off by one is not cosmetic: it is the number
  // a proxy frames the response by. It would have caught a missing newline.
  //
  //   curl -sD - https://esi.evetech.net/latest/characters/{character_id}/mail/
  //   curl -sD - -H 'Authorization: Bearer not-a-token' \
  //              https://esi.evetech.net/latest/characters/{character_id}/location/
  //   curl -sD - 'https://esi.evetech.net/latest/status/?datasource=bogus'
  //   curl -sD - https://esi.evetech.net/latest/universe/regions/99999999/
  //   curl -sD - https://esi.evetech.net/latest/characters/abc/
  const observed = [
    [45, unauthorized("no-token")],
    // The shorter of the two: observed on the same route with an
    // `Authorization: Bearer not-a-token` header, which is what earns this wording
    // rather than the one above.
    [41, unauthorized("invalid-token")],
    [27, invalidTenant()],
    [28, notFound(FAMILY.LEGACY, { entity: "Region" })],
    [130, coercionFailed(FAMILY.VALIDATED, { parameter: "character_id", value: "abc" })],
  ];

  for (const [contentLength, result] of observed) {
    assert.equal(
      onTheWire(result).length,
      contentLength,
      `${result.status} is ${onTheWire(result).length} bytes; CCP sent ${contentLength}`,
    );
  }
});

test("the newline belongs to the producer, not to the shape", () => {
  // Two 404s, same status, same job, one byte apart, because one is written by
  // Go and the other by the application. A rule keyed on the status code, or on
  // "errors", would get one of them wrong.
  const legacy = notFound(FAMILY.LEGACY, { entity: "Region" });
  const validated = notFound(FAMILY.VALIDATED);

  assert.equal(onTheWire(legacy).toString("utf8").endsWith("\n"), false);
  assert.equal(onTheWire(validated).toString("utf8").endsWith("\n"), true);
  assert.equal(json(legacy), wire.ERROR_BYTES.legacyNotFound, "the text is unchanged by any of this");
  assert.equal(json(validated), wire.ERROR_BYTES.validatedNotFound);
});

// 401

test("401 with no token is the exact string clients match on", () => {
  const result = unauthorized("no-token");

  assert.equal(result.status, 401);
  assert.equal(json(result), wire.ERROR_BYTES.unauthorizedNoToken);
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(result.headers["x-content-type-options"], "nosniff", "an edge refusal carries it");
});

test("401 with a bad token is a different exact string", () => {
  // Two distinct strings, and libraries branch on them. Collapsing both into
  // one "Unauthorized" would be invisible to us and visible to a client.
  assert.equal(JSON.parse(json(unauthorized("invalid-token"))).error, "Unauthorized - Invalid token");
  assert.notEqual(json(unauthorized("invalid-token")), json(unauthorized("no-token")));
});

test("an unknown reason is a programming error, not a vague 401", () => {
  assert.throws(() => unauthorized("because"), /unauthorized reason/);
});

// 400

test("400 Invalid tenant is the exact string", () => {
  const result = invalidTenant();

  assert.equal(result.status, 400);
  assert.equal(json(result), wire.ERROR_BYTES.invalidTenant);
  assert.equal(result.headers["x-content-type-options"], "nosniff");
});

// Path-parameter failures, per family

test("a legacy route fails coercion with a 400 and the exact message", () => {
  const result = coercionFailed(FAMILY.LEGACY, { parameter: "system_id", value: "abc" });

  assert.equal(result.status, 400);
  assert.equal(json(result), wire.ERROR_BYTES.legacyCoercion);
  assert.equal(result.headers["content-type"], "application/json; charset=UTF-8", "capitalised, and present");
});

test("a validated route fails the same input with a 422 and a details array", () => {
  const result = coercionFailed(FAMILY.VALIDATED, { parameter: "character_id", value: "abc" });

  assert.equal(result.status, 422);
  assert.equal(json(result), wire.ERROR_BYTES.validatedInvalidInteger);
  assert.equal(result.headers["content-type"], "application/json", "no charset on this family");
});

test("details[].value keeps the JSON type of what was sent", () => {
  // `"abc"` stayed a string above; an in-range-looking integer stays a number.
  // A validator that stringified everything would be visibly wrong to a client
  // that reads `details`.
  const result = coercionFailed(FAMILY.VALIDATED, {
    parameter: "character_id",
    value: 999999999999,
    message: "invalid character ID",
  });

  assert.equal(json(result), wire.ERROR_BYTES.validatedOutOfRange);
  assert.equal(typeof result.body.details[0].value, "number");
});

test("details[].location is path.<name>", () => {
  const result = coercionFailed(FAMILY.VALIDATED, { parameter: "corporation_id", value: "abc" });

  assert.equal(result.body.details[0].location, "path.corporation_id");
  assert.equal(
    coercionFailed(FAMILY.VALIDATED, { parameter: "page", value: "abc", where: "query" })
      .body.details[0].location,
    "query.page",
  );
});

test("the edge family cannot produce a parameter failure, because it never sees one", () => {
  assert.throws(() => coercionFailed(FAMILY.EDGE, { parameter: "x", value: "y" }), /edge/);
});

// 404, per family

test("a legacy route's 404 names the entity, in CCP's wording", () => {
  const result = notFound(FAMILY.LEGACY, { entity: "Region" });

  assert.equal(result.status, 404);
  assert.equal(json(result), wire.ERROR_BYTES.legacyNotFound);
  // Lowercase `not found`, capitalised entity: `Region not found`, not
  // `Region Not Found` and not `region not found`.
  assert.equal(JSON.parse(json(result)).error, wire.LEGACY_NOT_FOUND("Region"));
});

test("a validated route's 404 names nothing and carries its status", () => {
  const result = notFound(FAMILY.VALIDATED, { entity: "Character" });

  assert.equal(result.status, 404);
  assert.equal(json(result), wire.ERROR_BYTES.validatedNotFound, "the entity is deliberately dropped");
  assert.equal(result.body.status, 404, "this family repeats the status in the body");
});

test("a legacy 404 without an entity name is a programming error", () => {
  // `{"error":"undefined not found"}` shipped to a client is worse than a
  // failure at the call site.
  assert.throws(() => notFound(FAMILY.LEGACY, {}), /entity/);
});

// Key order is part of the bytes

test("the validated family puts status first, then error, then details", () => {
  const result = coercionFailed(FAMILY.VALIDATED, { parameter: "character_id", value: "abc" });

  assert.deepEqual(Object.keys(result.body), ["status", "error", "details"]);
  assert.deepEqual(Object.keys(notFound(FAMILY.VALIDATED, {}).body), ["status", "error"]);
  assert.deepEqual(Object.keys(notFound(FAMILY.LEGACY, { entity: "System" }).body), ["error"]);
});

// The two that belong to no family

test("an unrouted path is Go's plain text, byte for byte", () => {
  const result = unrouted();

  assert.equal(result.status, wire.UNROUTED_404.status);
  assert.equal(result.body, wire.UNROUTED_404.body);
  assert.equal(result.headers["content-type"], wire.UNROUTED_404.contentType);
  assert.equal(result.headers["x-content-type-options"], "nosniff");
  assert.equal(Buffer.byteLength(result.body, "utf8"), 19, "the trailing newline is what makes it 19");
});

test("a 405 has no body and no content-type at all", () => {
  const result = methodNotAllowed(["GET", "HEAD"]);

  assert.equal(result.status, 405);
  assert.equal(result.body, undefined, "not the JSON error shape: nothing at all");
  assert.equal(result.headers["content-type"], undefined);
  assert.deepEqual(result.headers.allow, ["GET", "HEAD"]);
  assert.deepEqual(methodNotAllowed(null).headers, {}, "answering a HEAD, CCP sends no Allow");
});

// 500

test("a 500 is opaque, and says where the detail went", () => {
  // Not observed (inducing a 500 on live ESI is not something to go looking
  // for), so this is ours, shaped like the family CCP uses for everything else.
  const result = internalServerError();

  assert.equal(result.status, 500);
  assert.deepEqual(Object.keys(result.body), ["error"]);
  assert.match(result.body.error, /server log/);
});

// The nexumApi envelope is gone

test("no envelope, no error codes", () => {
  // nexumApi answered `{ok:false, error:"BAD_REQUEST", message}` with its own
  // code vocabulary. Real ESI has neither, and a client that sees `ok` sees a
  // replica.
  for (const result of [
    unauthorized("no-token"),
    invalidTenant(),
    notFound(FAMILY.LEGACY, { entity: "System" }),
    coercionFailed(FAMILY.VALIDATED, { parameter: "character_id", value: "abc" }),
    internalServerError(),
  ]) {
    assert.equal("ok" in result.body, false);
    assert.equal("message" in result.body, false);
    assert.equal(typeof result.body.error, "string", "`error` is always present and always a string");
  }
});

test("every recorded refusal's body and its byte count agree", () => {
  // Both halves are transcribed by hand from a capture, and they can disagree
  // silently: a body edited for tidiness keeps the old `contentLength`, and the
  // replica then sends bytes that do not match the number this file asserts.
  //
  // The `(s)` in "required role(s)" is CCP's. It looks like a typo, and it is
  // one byte.
  const recorded = {
    FLEET_ABSENT: wire.FLEET_ABSENT,
    REQUIRED_ROLE_REFUSAL: wire.REQUIRED_ROLE_REFUSAL,
    CROSS_ENTITY_REFUSAL: wire.CROSS_ENTITY_REFUSAL,
    CHARACTER_MISMATCH: wire.CHARACTER_MISMATCH,
  };

  for (const [name, refusal] of Object.entries(recorded)) {
    assert.equal(
      Buffer.byteLength(JSON.stringify({ error: refusal.body })),
      refusal.contentLength,
      `${name}: the body and contentLength disagree`,
    );
  }
});

test("the three entity refusals are distinct answers, not one shape reused", () => {
  // D31 found that two refusals which obviously shared a body did not. These
  // three are the same hazard one level along: a missing scope, a character
  // mismatch, a corporation the caller is not in, and a role they do not hold
  // are four different conditions, and only the last two share a status.
  const bodies = [
    wire.FLEET_ABSENT.body,
    wire.REQUIRED_ROLE_REFUSAL.body,
    wire.CROSS_ENTITY_REFUSAL.body,
    wire.CHARACTER_MISMATCH.body,
  ];

  assert.equal(new Set(bodies).size, bodies.length, "no two of them are the same string");
  assert.equal(wire.FLEET_ABSENT.status, 404, "absence of a fleet is a 404");
  assert.equal(wire.REQUIRED_ROLE_REFUSAL.status, 403);
  assert.equal(wire.CROSS_ENTITY_REFUSAL.status, 403);
});

test("the corporation refusal's wording is not reused for another entity kind (D35)", () => {
  // `CROSS_ENTITY_REFUSAL` names the relationship ("is not in the
  // corporation"), so it is corporation-shaped. The alliance, fleet and
  // structure-ACL refusals are unobserved, and substituting the noun would ship
  // a sentence CCP has never sent. D31 records what that costs: two refusals
  // that obviously shared a body did not, and the guess was wrong in status,
  // family, producer, content-type and last byte simultaneously.
  //
  // Comments are stripped before scanning, and that is not a loophole. A route's
  // header may say, correctly, that the alliance form might be
  // `{"error":"Character is not in the alliance"}`, some other wording, or a
  // 404 (the posture D35 asks for, written where a reader needs it). A test that
  // cannot tell a sentence being emitted from one being ruled out would punish
  // that documentation. What is forbidden is the string reaching a response, so
  // what is scanned is the code that could put it there.
  const fs = require("node:fs");
  const dir = path.join(__dirname, "../routes");

  const stem = wire.CROSS_ENTITY_REFUSAL.body.replace(/corporation$/, "");
  assert.equal(stem, "Character is not in the ", "the recorded string changed shape; re-read this test");

  const forbidden = ["alliance", "fleet", "structure"].map((noun) => stem + noun);

  // Block comments, and whole-line `//` comments. Not trailing `//`, because a
  // URL in a string literal would truncate the line and hide a real violation on
  // it: a false negative is the one direction this must not fail in.
  const codeOf = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const code = codeOf(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const sentence of forbidden) {
      assert.ok(
        !code.includes(sentence),
        `routes/${file} emits ${JSON.stringify(sentence)}, which nobody has observed. `
          + "See D35: the corporation refusal does not generalise by swapping the noun. "
          + "Discussing it in a comment is fine and expected; returning it is not.",
      );
    }
  }

  // And the scan still bites where it should: the same sentence in code fails.
  const planted = codeOf('const refusal = "' + forbidden[0] + '";');
  assert.ok(planted.includes(forbidden[0]), "stripping comments must not strip code");
});

test("the two entity 403s are built here, and only for the family they were seen in", () => {
  // They lived in `routes/structures.js` while it was the only file that made
  // them. A second route needed them (and is where the membership one was
  // captured), so this is the pair, asserted against the recorded bytes rather
  // than a copy of themselves.
  assert.equal(NOT_IN_CORPORATION, wire.CROSS_ENTITY_REFUSAL.body);
  assert.equal(MISSING_REQUIRED_ROLE, wire.REQUIRED_ROLE_REFUSAL.body);
  assert.match(MISSING_REQUIRED_ROLE, /role\(s\)$/, "the parenthetical is CCP's and it is bytes");

  for (const [build, observed] of [
    [notInCorporation, wire.CROSS_ENTITY_REFUSAL],
    [missingRequiredRole, wire.REQUIRED_ROLE_REFUSAL],
  ]) {
    const refusal = build(FAMILY.LEGACY);

    assert.equal(refusal.status, observed.status);
    assert.deepEqual(refusal.body, { error: observed.body });
    assert.equal(refusal.producer, "app");
    assert.equal(refusal.headers["content-type"], observed.contentType);
    assert.equal(refusal.headers["x-content-type-options"], undefined, "the application sends no nosniff");
    assert.equal(Buffer.byteLength(json(refusal), "utf8"), observed.contentLength);

    // The other two families were never observed making either refusal, and a
    // derivation is not an observation: `characterMismatch`'s rule, applied to its
    // two new neighbours.
    for (const family of Object.values(FAMILY).filter((f) => f !== FAMILY.LEGACY)) {
      assert.throws(() => build(family), /never been observed/, family);
    }
  }
});

test("only the corporation gate answers; the other entity gates refuse by throwing (D35)", () => {
  // The shipped shape of D35, asserted where it can be seen at a glance rather
  // than only inside each route's own suite. A throw is a wrong status on a
  // request that is refused anyway (the gate runs before the handler, so nothing
  // is read either way), and a logged 500 is loud where an invented 403 is a
  // line nobody looks at twice.
  const structures = require(path.join(__dirname, "../routes/structures"));
  const fleets = require(path.join(__dirname, "../routes/fleets"));
  const contacts = require(path.join(__dirname, "../routes/contacts"));

  // Observed, so it answers, and it is `lib/errors.js`'s builder rather than a
  // string in whichever route needed it first. `routes/contacts.js` is where it
  // was captured; `routes/structures.js` borrowed it.
  assert.equal(wire.CROSS_ENTITY_REFUSAL.status, 403);
  assert.equal(NOT_IN_CORPORATION, wire.CROSS_ENTITY_REFUSAL.body);
  assert.equal(structures.NOT_IN_CORPORATION, wire.CROSS_ENTITY_REFUSAL.body);
  assert.deepEqual(
    notInCorporation(FAMILY.LEGACY).body,
    { error: wire.CROSS_ENTITY_REFUSAL.body },
  );
  assert.equal(typeof contacts.createCorporationContactsRoute({}).subject, "function");

  // Unobserved, so they throw. All three are reached through the route's
  // `subject`, which `lib/router.js` gateOrFail turns into a logged 500.
  assert.equal(typeof structures.createUniverseStructureRoute({}).subject, "function");
  assert.equal(typeof fleets.createFleetMembersRoute({}).subject, "function");
  assert.equal(typeof contacts.createAllianceContactsRoute({}).subject, "function");

  // The alliance gate is the newest of the three and the one D35's wording rule
  // bites hardest on, because "Character is not in the alliance" is a single
  // noun away from a sentence that was observed. It throws, and the throw says
  // which capture would end it.
  assert.throws(
    () => contacts.allianceContactsSubject(
      { characterId: 90000001 },
      { alliance_id: "99000001" },
      {
        runtime: {
          peekCharacterRecord: (id, options) => options.project({ corporationID: 98777771 }, id),
          getCorporationRecord: () => ({ allianceID: 99000002 }),
        },
      },
    ),
    (err) => /never been observed/.test(err.message) && !/is not in the alliance/.test(err.message),
  );
});
