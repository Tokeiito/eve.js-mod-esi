/**
 * `contract/spec.js`: can a test be written against an endpoint nobody has
 * implemented, and does it fail for the right reason?
 *
 * Run with: node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * That is the acceptance criterion for the contract harness, and it splits in
 * two. Reading the spec has to work (the descriptor carries the required keys,
 * the types, the status codes and the published cache TTL). Rejection has to
 * work too, the half that is easy to get wrong and impossible to notice: a
 * validator that accepts everything passes every test anyone writes with it.
 *
 * So most of this file feeds the walker bodies that are wrong in the specific
 * ways a plausible handler is wrong (an id serialised as a string, a field
 * quietly dropped, an extra field helpfully added, a `null` standing in for
 * "we don't know") and insists it says so, in a message naming the field.
 *
 * The suite reads the pinned document rather than a synthetic one wherever it
 * can. A harness proved only against a hand-written toy spec is proved against
 * the parts of OpenAPI we remembered to imagine.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const {
  SPEC_PATH,
  SpecContractError,
  assertBody,
  describeOperation,
  findBodyProblems,
  findSpecPath,
  loadProvenance,
  loadSpec,
  resolveSchema,
  toSpecPath,
} = require(path.join(__dirname, "../contract/spec"));

// A small spec of our own, for the shapes ESI's document happens not to use.
// Everything else in this file goes through the real one.
const TOY = {
  info: { version: "2020-01-01" },
  paths: {},
  components: {
    schemas: {
      Ref: { type: "integer" },
    },
  },
};

// The pin itself

test("the pinned spec is the 2020-01-01 surface", () => {
  const spec = loadSpec();

  assert.equal(spec.info.version, "2020-01-01", "D4's surface, and the tripwire in scripts/pin-spec.js");
  assert.equal(spec.openapi, "3.1.0");
  // `/sovereignty/map` exists on this surface and is absent from a spec fetched
  // at a modern compatibility date. Its presence is the cheapest proof that the
  // pin is the legacy document and not a current one that happens to parse.
  assert.ok("/sovereignty/map" in spec.paths, "a modern-date fetch would not have this path");
});

test("the pinned bytes are the bytes the provenance describes", () => {
  const provenance = loadProvenance();
  const onDisk = crypto.createHash("sha256").update(fs.readFileSync(SPEC_PATH, "utf8"), "utf8").digest("hex");

  assert.equal(
    onDisk,
    provenance.normalizedSha256,
    "contract/openapi.json has been edited by hand. It is a pin, not a source file: "
      + "re-pin with `node scripts/pin-spec.js`, and if the change is ours it belongs in contract/wire.js",
  );
  assert.match(provenance.retrievedAt, /^\d{4}-\d{2}-\d{2}T/, "a pin without a date is not a pin");
  assert.equal(provenance.compatibilityDate, "2020-01-01");
});

// Finding an operation from a wire path

test("wire paths are version-prefixed and slash-suffixed; spec paths are neither", () => {
  assert.equal(toSpecPath("/latest/status/"), "/status");
  assert.equal(toSpecPath("/v4/characters/90000001/"), "/characters/90000001");
  assert.equal(toSpecPath("/status"), "/status");
  // Not a version prefix, so nothing is stripped: a route that merely starts
  // with something version-shaped must not lose its first segment.
  assert.equal(toSpecPath("/v7/status/"), "/v7/status");
});

test("a concrete id resolves to its templated spec path", () => {
  assert.equal(findSpecPath("/latest/universe/systems/30000142/"), "/universe/systems/{system_id}");
  assert.equal(findSpecPath("/v5/corporations/98000001/"), "/corporations/{corporation_id}");
  assert.equal(
    findSpecPath("/latest/killmails/12345/abc0def/"),
    "/killmails/{killmail_id}/{killmail_hash}",
  );
});

test("an exact path is not shadowed by a templated sibling", () => {
  // `/characters/affiliation` and `/characters/{character_id}` are both real,
  // both one segment deep, and only one is right.
  assert.equal(findSpecPath("/latest/characters/affiliation/"), "/characters/affiliation");
});

test("an endpoint outside the spec says so, and says where its contract lives", () => {
  // `/ping` is real and documented nowhere. The message has to point at wire.js
  // rather than leave the reader thinking the pin is broken.
  assert.throws(
    () => describeOperation("get", "/ping"),
    (err) => err instanceof SpecContractError && /wire\.js/.test(err.message),
  );
});

test("a path that exists without the method asked for lists the methods it has", () => {
  assert.throws(
    () => describeOperation("get", "/latest/universe/names/"),
    (err) => err instanceof SpecContractError && /declares post/.test(err.message),
  );
});

// The descriptor

test("the descriptor carries the published cache TTL and rate-limit group", () => {
  const contract = describeOperation("get", "/latest/status/");

  assert.equal(contract.operationId, "GetStatus");
  assert.equal(contract.cacheAgeSeconds, 30, "clients poll on Expires; this is where that number comes from");
  assert.equal(contract.clientCacheTtlSeconds, 30);
  assert.deepEqual(contract.rateLimit, { group: "status", maxTokens: 600, windowSize: "15m" });
  assert.equal(contract.compatibilityDate, "2020-01-01");
  assert.deepEqual(contract.statuses, [200]);
  assert.equal(contract.successStatus, 200);
});

test("the descriptor carries required and optional keys separately", () => {
  const contract = describeOperation("get", "/latest/status/");

  assert.deepEqual(contract.requiredKeys.sort(), ["players", "server_version", "start_time", "vip"]);
  assert.deepEqual(contract.optionalKeys, [], "every field of Status is required");
});

test("an authenticated operation carries its scopes", () => {
  const contract = describeOperation("get", "/latest/characters/90000001/location/");

  assert.ok(
    contract.scopes.includes("esi-location.read_location.v1"),
    `expected the location scope, got ${JSON.stringify(contract.scopes)}`,
  );
});

// $ref

test("a $ref resolves, and a cycle is an error rather than a hang", () => {
  assert.deepEqual(resolveSchema(TOY, { $ref: "#/components/schemas/Ref" }), { type: "integer" });

  const looped = {
    ...TOY,
    components: { schemas: { A: { $ref: "#/components/schemas/B" }, B: { $ref: "#/components/schemas/A" } } },
  };
  assert.throws(() => resolveSchema(looped, { $ref: "#/components/schemas/A" }), SpecContractError);
});

// Rejection: the half that has to actually work

const STATUS = () => describeOperation("get", "/latest/status/");

const GOOD_STATUS = {
  server_version: "3475087",
  players: 27543,
  vip: false,
  start_time: "2026-08-21T11:03:14Z",
};

test("a body matching the spec passes", () => {
  assertBody(GOOD_STATUS, STATUS());
});

test("a missing required field is named", () => {
  const { vip, ...withoutVip } = GOOD_STATUS;

  assert.throws(
    () => assertBody(withoutVip, STATUS()),
    (err) => err instanceof SpecContractError && /body\.vip is required/.test(err.message),
  );
});

test("an id serialised as a string is a failure, not a value difference", () => {
  // The most common way a replica diverges: JSON.stringify on something that
  // was a string in the database. Clients that do arithmetic on it break.
  assert.throws(
    () => assertBody({ ...GOOD_STATUS, players: "27543" }, STATUS()),
    (err) => err instanceof SpecContractError && /body\.players: expected integer, got string/.test(err.message),
  );
});

test("a float where the spec says integer is a failure", () => {
  assert.throws(
    () => assertBody({ ...GOOD_STATUS, players: 27543.5 }, STATUS()),
    (err) => /body\.players: expected integer, got number/.test(err.message),
  );
});

test("an extra field is a failure", () => {
  assert.throws(
    () => assertBody({ ...GOOD_STATUS, players_online: 27543 }, STATUS()),
    (err) => err instanceof SpecContractError && /body\.players_online is not in the spec/.test(err.message),
  );
});

test("a null gets its own message, because nothing on this surface is nullable", () => {
  assert.throws(
    () => assertBody({ ...GOOD_STATUS, start_time: null }, STATUS()),
    (err) => err instanceof SpecContractError && /body\.start_time is null/.test(err.message),
  );
});

test("a timestamp in anything but ESI's rendering is a failure", () => {
  // The spec says `date-time`, which permits offsets and fractional seconds.
  // Every value ESI emits, and every `examples` entry in the pinned document, is
  // `...Z` with whole seconds, and clients string-slice it.
  for (const bad of ["2026-08-21T11:03:14.000Z", "2026-08-21T11:03:14+00:00", "2026-08-21 11:03:14Z"]) {
    assert.throws(
      () => assertBody({ ...GOOD_STATUS, start_time: bad }, STATUS()),
      (err) => /is not an ESI timestamp/.test(err.message),
      `${bad} should not have been accepted`,
    );
  }
});

test("every problem is reported at once, not just the first", () => {
  const wrong = { server_version: 3475087, players: "27543", start_time: "yesterday" };

  const problems = findBodyProblems(wrong, STATUS().schema, loadSpec());

  assert.equal(problems.length, 4, `expected four problems, got ${JSON.stringify(problems, null, 2)}`);
  assert.ok(problems.some((p) => /vip is required/.test(p)));
  assert.ok(problems.some((p) => /server_version: expected string/.test(p)));
});

// Nesting

test("a bad element inside an array is located by index", () => {
  const contract = describeOperation("get", "/latest/sovereignty/map/");

  const problems = findBodyProblems(
    [{ system_id: 30000001 }, { system_id: "30000002" }],
    contract.schema,
    contract.spec,
  );

  assert.ok(
    problems.some((p) => /body\[1\]\.system_id: expected integer, got string/.test(p)),
    `expected the index in the message, got ${JSON.stringify(problems)}`,
  );
});

test("a bare array body is validated as an array, not waved through", () => {
  const contract = describeOperation("get", "/latest/sovereignty/map/");

  assert.throws(
    () => assertBody({ items: [] }, contract),
    (err) => /body: expected array, got object/.test(err.message),
  );
});
