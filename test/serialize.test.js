/**
 * `lib/serialize.js`: is the body bare, snake_case, and the bytes CCP sends?
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Three claims, asserted against sources outside this repository's own opinion
 * wherever one exists:
 *
 *   - No envelope. No body anywhere carries `ok`, `apiVersion` or `source` as
 *     a top-level key. nexumApi puts all three on every success; inheriting
 *     that would break every ESI client.
 *   - snake_case everywhere. The regex is checked against all 531 property
 *     names in the pinned `contract/openapi.json`, so a name it rejects is a
 *     name CCP does not use.
 *   - A golden-file diff per implemented endpoint. The last section walks
 *     `routes/` and demands a recording for every ESI endpoint it finds. Two
 *     recordings exist, one per producer, so the harness's success path is
 *     proved against bytes CCP served.
 *
 * There is no single success shape. `GET /status/` and
 * `GET /universe/regions/10000002/` are both plain successes and they disagree
 * about the `content-type` and about whether the body ends with a newline,
 * because two different implementations wrote them. The producer table has
 * three rows (gateway, app, meta) and the assertions below are per producer.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const spec = require(path.join(__dirname, "../contract/spec"));
const golden = require(path.join(__dirname, "../contract/golden"));
const wire = require(path.join(__dirname, "../contract/wire"));
const { sendJson } = require(path.join(__dirname, "../server"));
const {
  ENVELOPE_KEYS,
  OMIT,
  PRODUCER,
  PRODUCER_WIRE,
  SNAKE_CASE,
  SerializationError,
  arrayOf,
  contentTypeFor,
  findEnvelopeKeys,
  findNonSnakeCaseKeys,
  numberOrNull,
  optional,
  producerWire,
  projection,
  serializeBody,
} = require(path.join(__dirname, "../lib/serialize"));

// The application's producer is the default for these assertions because its
// bytes are just the JSON, nothing appended, which keeps each test about the
// thing it tests. The producers themselves, and the byte the other one adds,
// have their own section at the end.
const text = (body, producer = PRODUCER.APP) => serializeBody(body, producer).toString("utf8");

/** Every property name declared anywhere in the pinned spec. */
function specPropertyNames() {
  const document = spec.loadSpec();
  const names = new Set();

  const walk = (node) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.type === "object" && node.properties && typeof node.properties === "object") {
      for (const name of Object.keys(node.properties)) names.add(name);
    }
    for (const key of Object.keys(node)) walk(node[key]);
  };

  walk(document.components && document.components.schemas);
  walk(document.paths);
  return [...names];
}

/** A `ServerResponse` stand-in that records what was written. */
function captureResponse() {
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    status: null,
    headers: null,
    payload: null,
    writeHead: (status, headers) => {
      res.status = status;
      res.headers = headers;
      res.headersSent = true;
    },
    end: (payload) => {
      res.payload = payload;
      res.writableEnded = true;
    },
  };
  return res;
}

// No envelope

test("a bare array serializes bare, with nothing wrapped around it", () => {
  // GET /latest/universe/systems/ is an array of ids and nothing else. A client
  // iterating the parsed body gets a TypeError the moment we wrap it.
  assert.equal(text([30000001, 30000002]), "[30000001,30000002]");
  assert.deepEqual(findEnvelopeKeys([30000001]), []);
});

test("the envelope keys are exactly nexumApi's three", () => {
  assert.deepEqual([...ENVELOPE_KEYS], ["ok", "apiVersion", "source"]);
});

test("findEnvelopeKeys names every envelope key a body carries at the top level", () => {
  assert.deepEqual(findEnvelopeKeys({ ok: true, apiVersion: 1, source: "nexum-mod", players: 1 }), [
    "ok",
    "apiVersion",
    "source",
  ]);
  assert.deepEqual(findEnvelopeKeys({ players: 1, server_version: "1" }), []);
});

test("findEnvelopeKeys looks only at the top level, because `source` is a real ESI field", () => {
  // A killmail attacker has a `source`. Banning the name everywhere would be a
  // rule endpoints had to fight rather than one that catches the mistake.
  assert.deepEqual(findEnvelopeKeys({ items: [{ source: "kill" }] }), []);
});

test("a projection cannot declare an envelope key", () => {
  for (const key of ENVELOPE_KEYS) {
    assert.throws(
      () => projection("GetStatus", { [key]: () => 1 }),
      (err) => err instanceof SerializationError && err.message.includes(key),
      `projection() accepted the envelope key ${key}`,
    );
  }
});

// snake_case

test("the snake_case rule accepts every property name in the pinned spec", () => {
  // The regex is not a house rule. If this fails, either CCP published a name
  // in another convention (the regex is wrong and fidelity wins) or the spec was
  // re-pinned and nobody looked.
  const names = specPropertyNames();
  assert.ok(names.length > 500, `expected the pinned spec to declare hundreds of fields, found ${names.length}`);

  const rejected = names.filter((name) => !SNAKE_CASE.test(name));
  assert.deepEqual(rejected, [], `SNAKE_CASE rejects field names CCP actually publishes: ${rejected.join(", ")}`);
});

test("the snake_case rule rejects what nexumApi would have handed us", () => {
  for (const name of ["characterID", "solarSystemID", "ShipTypeId", "start-time", "_private", "id_", "2fa"]) {
    assert.equal(SNAKE_CASE.test(name), false, `SNAKE_CASE accepted ${name}`);
  }
});

test("a projection cannot declare a camelCase field", () => {
  assert.throws(
    () => projection("GetCharactersCharacterIdLocation", { solarSystemID: (r) => r.solarSystemID }),
    (err) => err instanceof SerializationError && err.message.includes("solarSystemID"),
  );
});

test("findNonSnakeCaseKeys names the path to every offending key, at any depth", () => {
  assert.deepEqual(
    findNonSnakeCaseKeys({ characters: [{ character_id: 1, shipTypeID: 2 }] }),
    ["body.characters[0].shipTypeID"],
  );
  assert.deepEqual(findNonSnakeCaseKeys([{ system_id: 1 }, { system_id: 2 }]), []);
});

// Absence: null, omitted, and the bug

test("numberOrNull passes finite numbers through and turns everything else to null", () => {
  // Ported from nexumApi, semantics unchanged.
  assert.equal(numberOrNull(5), 5);
  assert.equal(numberOrNull("5"), 5);
  assert.equal(numberOrNull(null), null);
  assert.equal(numberOrNull(undefined), null);
  assert.equal(numberOrNull(""), null);
  assert.equal(numberOrNull("not-a-number"), null);
  assert.equal(numberOrNull(NaN), null);
  assert.equal(numberOrNull(Infinity), null);
});

test("an unset id becomes null, not 0: the difference is a claim about where a character is", () => {
  // `Number("") === 0` and `Number(null) === 0`, so the obvious coercion turns
  // "this character is not docked" into "this character is at station 0".
  assert.equal(numberOrNull(""), null);
  assert.notEqual(numberOrNull(""), 0);
  assert.equal(text({ station_id: numberOrNull(null) }), '{"station_id":null}');
});

test("a null a projection returns is serialized as null, not dropped", () => {
  const project = projection("GetCharactersCharacterIdLocation", {
    solar_system_id: (record) => numberOrNull(record.solarSystemID),
    station_id: (record) => numberOrNull(record.stationID),
  });

  assert.equal(
    text(project({ solarSystemID: 30000142, stationID: null })),
    '{"solar_system_id":30000142,"station_id":null}',
  );
});

test("OMIT leaves the key out entirely", () => {
  const project = projection("GetStatus", {
    players: (record) => record.players,
    vip: (record) => optional(record.vip),
  });

  assert.equal(text(project({ players: 12, vip: true })), '{"players":12,"vip":true}');
  assert.equal(text(project({ players: 12, vip: null })), '{"players":12}');
});

test("optional treats 0, empty string and false as values, not absences", () => {
  // An `is_online: false` that vanished because someone reached for a falsy
  // test is a bug with a very long tail.
  assert.equal(optional(0), 0);
  assert.equal(optional(""), "");
  assert.equal(optional(false), false);
  assert.equal(optional(null), OMIT);
  assert.equal(optional(undefined), OMIT);
});

test("undefined from a projection throws rather than silently dropping the field", () => {
  const project = projection("GetStatus", {
    players: (record) => record.players,
    server_version: (record) => record.serverVersion,
  });

  assert.throws(
    () => project({ players: 12 }),
    (err) => err instanceof SerializationError && err.message.includes("server_version"),
    "a renamed game-store field must not become a missing key nobody notices",
  );
});

test("the pinned spec has no nullable field, which is why omission is the common case", () => {
  // 202 schemas, 531 properties, and none may be null: everything ESI cannot
  // say, it says by leaving the key out. When CCP publishes a nullable field
  // this fails, and lib/serialize.js's note about it gets revisited.
  const document = spec.loadSpec();
  const nullable = [];

  const walk = (node, at) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    if (node.nullable === true) nullable.push(`${at} (nullable: true)`);
    if (Array.isArray(node.type) && node.type.includes("null")) nullable.push(`${at} (type includes null)`);
    for (const key of Object.keys(node)) walk(node[key], `${at}.${key}`);
  };

  walk(document.components && document.components.schemas, "schemas");
  assert.deepEqual(nullable, []);
});

// Sets

test("a Set serializes as an array, not as the empty object JSON.stringify would give", () => {
  // JSON.stringify(new Set([1,2])) is "{}" and it does not warn. The game's
  // stores hand out Sets for exactly the things ESI publishes as id arrays.
  assert.equal(JSON.stringify(new Set([1, 2])), "{}", "the behaviour this exists to prevent");
  assert.equal(text(new Set([1, 2])), "[1,2]");
  assert.equal(text({ systems: new Set([30000001, 30000002]) }), '{"systems":[30000001,30000002]}');
  assert.equal(text([new Set([1]), new Set([2])]), "[[1],[2]]");
});

test("arrayOf flattens a Set, keeps an array, and does not explode a string", () => {
  assert.deepEqual(arrayOf(new Set([1, 2])), [1, 2]);
  assert.deepEqual(arrayOf([1, 2]), [1, 2]);
  assert.deepEqual(arrayOf("Jita"), ["Jita"], "spreading a string would give one entry per character");
  assert.deepEqual(arrayOf(new Map([["a", 1]]).keys()), ["a"]);
  assert.deepEqual(arrayOf(7), [7]);
});

test("an absent collection is an empty list, because the spec has no nullable array", () => {
  assert.deepEqual(arrayOf(null), []);
  assert.deepEqual(arrayOf(undefined), []);
});

// Bytes

test("field order on the wire is the order the projection declared", () => {
  // Golden files are compared as bytes, so declaration order is protocol.
  const project = projection("GetStatus", {
    players: () => 12345,
    server_version: () => "1132976",
    start_time: () => "2017-01-02T12:34:56Z",
  });

  assert.deepEqual([...project.fields], ["players", "server_version", "start_time"]);
  assert.equal(
    text(project({})),
    '{"players":12345,"server_version":"1132976","start_time":"2017-01-02T12:34:56Z"}',
  );
});

test("the byte count is bytes, not characters", () => {
  // A corporation ticker or a system name puts multi-byte UTF-8 in a body, and
  // a content-length counted in characters is a truncated response.
  //
  // The two producers disagree about what those bytes are. The gateway writes
  // the character raw (two bytes for `Ä`, one character) and the application
  // escapes it to six ASCII bytes. So `Buffer.byteLength(JSON.stringify(body))`
  // is right for one of them and wrong for the other, and this test asserts the
  // escaped count for the application.
  const body = { name: "Ärger" };

  const gateway = serializeBody(body, PRODUCER.GATEWAY);
  assert.ok(Buffer.isBuffer(gateway));
  assert.equal(gateway.length, Buffer.byteLength(`${JSON.stringify(body)}\n`, "utf8"));
  assert.notEqual(gateway.length, `${JSON.stringify(body)}\n`.length, "characters would be one short");

  const app = serializeBody(body, PRODUCER.APP);
  assert.equal(app.toString("utf8"), '{"name":"\\u00c4rger"}');
  // Escaped, so every byte is ASCII and the count is longer than the raw form
  // rather than merely different from the character count.
  assert.equal(app.length, app.toString("utf8").length, "an escaped body is all ASCII");
  assert.ok(app.length > Buffer.byteLength(JSON.stringify(body), "utf8"));
});

test("the trailing newline is the producer's, and nexumApi's was neither", () => {
  // nexumApi appended a newline to everything. Real ESI appends one to the half
  // of its surface Go writes and none to the half the application writes, so
  // "real ESI does not" is as wrong as nexumApi, in the other direction.
  assert.equal(text({ players: 1 }, PRODUCER.APP).endsWith("\n"), false);
  assert.equal(text({ players: 1 }, PRODUCER.GATEWAY).endsWith("\n"), true);
  assert.equal(text([1, 2], PRODUCER.APP), "[1,2]");
  assert.equal(text([1, 2], PRODUCER.GATEWAY), "[1,2]\n");
});

test("an undefined body becomes null rather than a throw", () => {
  // JSON.stringify(undefined) is undefined, and Buffer.from(undefined) throws:
  // a handler that fell off the end of a function must not take the socket too.
  assert.equal(text(undefined, PRODUCER.APP), "null");
  assert.equal(text(undefined, PRODUCER.GATEWAY), "null\n");
});

test("a body that cannot be serialized throws, which is what server.js turns into a 500", () => {
  const circular = { a: 1 };
  circular.self = circular;
  assert.throws(() => serializeBody(circular, PRODUCER.APP), TypeError);
});

// What server.js writes

test("every success producer agrees with what was observed on the wire", () => {
  // `application/json; charset=utf-8` on everything, and a bare
  // `application/json` on everything, are each wrong: the `/meta/` surface
  // joined the gateway and application rows, so the table has three. lib/ cannot
  // import contract/ (D20), so the values are duplicated and this test checks
  // that they agree.
  assert.deepEqual(Object.values(PRODUCER).sort(), ["app", "gateway", "meta"]);

  for (const [producer, kind] of [
    [PRODUCER.GATEWAY, wire.KIND.GATEWAY_SUCCESS],
    [PRODUCER.APP, wire.KIND.APP_SUCCESS],
    [PRODUCER.META, wire.KIND.META_SUCCESS],
  ]) {
    assert.equal(contentTypeFor(producer), wire.CONTENT_TYPE[kind], `${producer} content-type`);
    assert.equal(producerWire(producer).trailingNewline, wire.TRAILING_NEWLINE[kind], `${producer} newline`);
  }

  assert.notEqual(contentTypeFor(PRODUCER.GATEWAY), contentTypeFor(PRODUCER.APP), "the whole point");

  // And the meta surface's bytes are the gateway's, exactly. That is the
  // observation rather than a shortcut, and it is why the two producers had to
  // be told apart one table over, in lib/cache.js, rather than here.
  assert.equal(contentTypeFor(PRODUCER.META), contentTypeFor(PRODUCER.GATEWAY));
  assert.equal(
    producerWire(PRODUCER.META).trailingNewline,
    producerWire(PRODUCER.GATEWAY).trailingNewline,
  );
});

test("the content-type and the newline are one fact, not two", () => {
  // They correlate exactly on every endpoint surveyed (bare `application/json`
  // ends with a newline, `; charset=UTF-8` does not), so they live in one row
  // and are handed out together. Split into two independent settings they drift
  // into the four combinations, three of which CCP never sends.
  for (const row of Object.values(PRODUCER_WIRE)) {
    assert.equal(
      row.trailingNewline,
      row.contentType === "application/json",
      `${row.contentType} disagrees with its own newline rule`,
    );
  }
});

test("a body cannot be serialized without saying who is supposed to have written it", () => {
  // No default. The common producer is the wrong one for /status/, so a
  // missing producer is a question nobody asked rather than a value to guess.
  assert.throws(() => serializeBody({ players: 1 }), SerializationError);
  assert.throws(
    () => serializeBody({ players: 1 }, "go"),
    (err) => err instanceof SerializationError && /gateway, app/.test(err.message),
  );
});

test("sendJson writes the producer's bytes, and a content-length that counts them", () => {
  const res = captureResponse();
  const body = { systems: new Set([30000001]), name: "Ärger" };

  sendJson(res, 200, body, undefined, PRODUCER.APP);

  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], contentTypeFor(PRODUCER.APP));
  assert.deepEqual(res.payload, serializeBody(body, PRODUCER.APP));
  assert.equal(res.headers["Content-Length"], String(serializeBody(body, PRODUCER.APP).length));
  // Escaped, because the application producer does. The gateway writes the
  // same body raw; `sendJson takes the header and the last byte from the same
  // producer` below asserts the pair together.
  assert.equal(res.payload.toString("utf8"), '{"systems":[30000001],"name":"\\u00c4rger"}');

  const gateway = captureResponse();
  sendJson(gateway, 200, body, undefined, PRODUCER.GATEWAY);
  assert.equal(gateway.payload.toString("utf8"), '{"systems":[30000001],"name":"Ärger"}\n');
});

test("sendJson takes the header and the last byte from the same producer", () => {
  // The failure this guards against is a response carrying one producer's
  // content-type and the other's byte count: a combination CCP never sends and
  // the one a two-setting design produces first.
  const gateway = captureResponse();
  sendJson(gateway, 200, { players: 1 }, undefined, PRODUCER.GATEWAY);

  assert.equal(gateway.headers["Content-Type"], "application/json");
  assert.equal(gateway.payload.toString("utf8"), '{"players":1}\n');
  assert.equal(gateway.headers["Content-Length"], "14", "13 bytes of JSON and the newline");

  const app = captureResponse();
  sendJson(app, 200, { players: 1 }, undefined, PRODUCER.APP);

  assert.equal(app.headers["Content-Type"], "application/json; charset=UTF-8");
  assert.equal(app.payload.toString("utf8"), '{"players":1}');
  assert.equal(app.headers["Content-Length"], "13");
});

test("a route that never declared a producer is a 500, not a wrong-looking 200", () => {
  // `null` is a declaration ("this route sends no JSON"), so an object body
  // arriving with it is a bug behind dispatch. Answering it as somebody's JSON
  // would put a body on the wire that no client can trust the length of.
  const res = captureResponse();
  sendJson(res, 200, { players: 1 }, undefined, null);

  assert.equal(res.status, 500);
  assert.equal(JSON.parse(res.payload.toString("utf8")).error, "The response body could not be serialised.");
  assert.equal(res.headers["Content-Length"], String(res.payload.length));
});

// The golden harness

test("every golden file has provenance, and every provenance entry has a file", () => {
  // Both directions: an entry with no file is a recording nobody made, a file
  // with no entry is bytes nobody can trace back to a request.
  assert.deepEqual(golden.findIndexProblems(), []);
});

test("assertGolden refuses a body it has no recording for, and says what is missing", () => {
  assert.throws(
    () => golden.assertGolden("GetNothingAtAll", { players: 1 }),
    (err) => err instanceof golden.GoldenError && err.message.includes("index.json"),
  );
});

test("assertGolden reports a key-order difference as a key-order difference", () => {
  // The one difference a deepEqual would pass and a byte comparison catches.
  const reasons = golden.describeDifference(
    serializeBody({ server_version: "1", players: 2 }, PRODUCER.APP),
    serializeBody({ players: 2, server_version: "1" }, PRODUCER.APP),
  );
  assert.ok(
    reasons.some((line) => line.includes("key order")),
    `expected a key-order explanation, got:\n${reasons.join("\n")}`,
  );
});

test("the goldens listed are the ones with both a file and an entry", () => {
  assert.deepEqual(golden.listGoldens(), Object.keys(golden.loadIndex()).filter(golden.hasGolden).sort());
});

// The golden harness, against bytes CCP actually sent
//
// A harness whose success path never runs is the failure `contract/spec.js`'s
// own tests warn about: a validator that accepts everything passes every test
// written with it. So both rows of the producer table are proved here against
// real recordings rather than buffers this file made up.

test("a projection reproduces GET /status/ byte for byte, newline included", () => {
  // The gateway row. 93 recorded bytes, of which 92 are JSON. If serializeBody
  // stopped appending the newline, or the projection declared its fields in the
  // order that reads best rather than the order CCP sends them, this fails.
  const recorded = golden.loadGolden("GetStatus");

  const projectStatus = projection("GetStatus", {
    server_version: (r) => String(r.build),
    players: (r) => r.players,
    vip: (r) => r.vip,
    start_time: (r) => r.startedAt,
  });

  const body = projectStatus({
    build: 3475087,
    players: 23245,
    vip: false,
    startedAt: "2026-08-21T11:03:14Z",
  });

  golden.assertGolden("GetStatus", body);
  assert.equal(recorded.bytes.length, 93);
  assert.equal(recorded.bytes[recorded.bytes.length - 1], 0x0a, "the byte an earlier build shipped without");
});

test("a projection reproduces an application 2XX byte for byte, without one", () => {
  // The app row, recorded as the counterpart to GetStatus: same surface, other
  // implementation, so no newline and a charset parameter on the content-type.
  const recorded = golden.loadGolden("GetUniverseRegionsRegionId");

  const projectRegion = projection("GetUniverseRegionsRegionId", {
    constellations: (r) => arrayOf(r.constellations),
    description: (r) => r.description,
    name: (r) => r.name,
    region_id: (r) => r.regionID,
  });

  const body = projectRegion({
    // A Set, because that is what a game store hands out for a list of ids, and
    // what JSON.stringify would otherwise turn into `{}`.
    constellations: new Set(recorded.value.constellations),
    description: recorded.value.description,
    name: "The Forge",
    regionID: 10000002,
  });

  golden.assertGolden("GetUniverseRegionsRegionId", body);
  assert.equal(recorded.bytes.length, 270);
  assert.notEqual(recorded.bytes[recorded.bytes.length - 1], 0x0a);
});

test("the two recordings are one per producer, and each carries the other's byte count", () => {
  // Serialized as the wrong producer, each golden misses by exactly one byte.
  for (const [name, wrong] of [["GetStatus", PRODUCER.APP], ["GetUniverseRegionsRegionId", PRODUCER.GATEWAY]]) {
    const recorded = golden.loadGolden(name);

    assert.throws(
      () => golden.assertGolden(name, recorded.value, { producer: wrong }),
      (err) => err instanceof golden.GoldenError && /length: produced \d+ bytes, recorded \d+/.test(err.message),
      `${name} serialized as ${wrong} should not have matched`,
    );
  }
});

test("a recording whose last byte disagrees with its producer is reported as mis-recorded", () => {
  // An editor that terminates text files would otherwise rewrite the contract
  // silently, and the handler would then be written to satisfy the edit.
  for (const name of golden.listGoldens()) {
    const { entry, bytes } = golden.loadGolden(name);
    assert.equal(
      bytes[bytes.length - 1] === 0x0a,
      producerWire(entry.producer).trailingNewline,
      `contract/golden/${name}.json disagrees with its declared producer`,
    );
  }
});

// Every endpoint has a golden

test("every implemented ESI endpoint has a golden recording", async (t) => {
  // A golden-file test per implemented endpoint dies quietly: an endpoint lands,
  // nobody records a body for it, and a suite that never enumerated the
  // endpoints stays green. So it is enumerated.
  //
  // Three exclusions, each a claim rather than a convenience:
  //
  //   health.js  is not ESI. Real ESI has no /health, which is why it lives
  //              under /_mod/: there is no CCP body to diff against.
  //   ping.js    is ESI, but its body is two bytes of text/plain. A golden is a
  //              JSON recording and this harness parses one, so /ping's bytes
  //              are pinned in contract/wire.js PING and asserted by
  //              test/ping.test.js.
  //   oauth*.js  are the SSO surface, not ESI. They answer on the other
  //              listener, at the root of the other origin (D6), and serve
  //              login.eveonline.com's documents rather than
  //              esi.evetech.net's, so there is no CCP ESI body to record.
  //              Their bytes are pinned in contract/sso.js and asserted by
  //              test/jwksContract.test.js and test/discoveryContract.test.js.
  //              They also break this harness's assumption that a factory does
  //              not touch its dependencies at construction:
  //              createOauthDiscoveryRoute refuses an absent issuer there,
  //              deliberately, because every absolute URL in the document is
  //              built from it and a boot-time refusal beats a document full of
  //              "undefined".
  const fs = require("node:fs");
  const routesDir = path.join(__dirname, "../routes");
  const NOT_JSON_ENDPOINTS = new Set(["health.js", "ping.js"]);

  // Named one by one rather than matched on an `oauth` prefix, so the next SSO
  // route has to make the claim above on purpose rather than inherit it from its
  // filename.
  const NOT_ESI_SURFACE = new Set([
    "oauthDiscovery.js",
    "oauthJwks.js",
    "oauthAuthorize.js",
    "oauthToken.js",
    "oauthVerify.js",
    "oauthRevoke.js",
  ]);

  const implemented = fs.readdirSync(routesDir)
    .filter((file) => file.endsWith(".js")
      && !NOT_JSON_ENDPOINTS.has(file)
      && !NOT_ESI_SURFACE.has(file))
    .map((file) => file.slice(0, -".js".length));

  if (implemented.length === 0) {
    t.todo(
      "no ESI endpoint has landed yet. This test starts running unedited "
        + "when routes/status.js appears, and fails until contract/golden/GetStatus.json is "
        + "listed against it.",
    );
    return;
  }

  // Matched on the operationId, which each route declares as its `name`
  // (`GetStatus` for `routes/status.js`), and compared by equality.
  //
  // Substring matching on the module's basename would be too loose: a future
  // `routes/universe.js` would be satisfied by `GetUniverseRegionsRegionId`, a
  // producer-coverage recording belonging to no implemented route, so the first
  // universe endpoint could ship with no golden of its own. `markets.js` is the
  // live case: it carries two operations.
  //
  // So the unit is the operation, not the file. A module that exports no route
  // factory fails here too: an endpoint the router never sees is not an
  // implemented endpoint.
  const operations = [];
  for (const module of implemented) {
    const exported = require(path.join(routesDir, `${module}.js`));
    const factories = Object.entries(exported)
      .filter(([name, value]) => /^create.*Route$/.test(name) && typeof value === "function");

    assert.notEqual(
      factories.length,
      0,
      `routes/${module}.js exports no create…Route factory, so nothing here can tell which `
      + "ESI operation it implements, and its golden, if any, is unmatched",
    );

    for (const [, factory] of factories) {
      // The factories take their dependencies but do not touch them at
      // construction; only the handler does, and no handler runs here.
      operations.push({ module, name: factory({}).name });
    }
  }

  const recorded = new Set(golden.listGoldens());
  const exempt = golden.loadExemptions();

  const missing = operations
    .filter(({ name }) => !recorded.has(name) && !Object.prototype.hasOwnProperty.call(exempt, name))
    .map(({ module, name }) => `${name} (routes/${module}.js)`);

  assert.deepEqual(
    missing,
    [],
    "these operations have no recorded ESI body and no exemption saying why: "
    + `${missing.join(", ")}. Record one (contract/golden.js says how) or add an entry to `
    + "the \"exempt\" map in contract/golden/index.json with the reason there is none.",
  );
});

test("every recording is used the way its entry says it is", () => {
  // The test above requires a recording to exist; this one requires something
  // to compare against it, because a golden nobody opens is a file, not a
  // contract.
  //
  // Two ways a recording is used, declared per entry:
  //
  //   bytes   assertGolden("<name>", ...): the whole body, diffed
  //   shape   loadGolden("<name>"): the values are ours and cannot match, so a
  //           test stands on the field set, the key order and the last byte
  //
  // Found by reading the test sources, the same crude device
  // test/vendorPresence.test.js uses to keep its own table honest: it only needs
  // to fail when a recording stops being looked at.
  const fs = require("node:fs");
  const sources = fs.readdirSync(__dirname)
    .filter((file) => file.endsWith(".test.js"))
    .map((file) => fs.readFileSync(path.join(__dirname, file), "utf8"))
    .join("\n");

  const unused = [];
  for (const [name, entry] of Object.entries(golden.loadIndex())) {
    const call = entry.diff === "bytes" ? "assertGolden" : "loadGolden";
    if (!sources.includes(`${call}("${name}"`)) {
      unused.push(`${name}: declared diff "${entry.diff}" but no test calls ${call}("${name}", …)`);
    }
  }

  assert.deepEqual(
    unused,
    [],
    `these recordings are not compared against by anything:\n  ${unused.join("\n  ")}`,
  );
});

test("no golden recording carries an envelope key, which is where the claim is enforced", () => {
  // No response body anywhere contains ok, apiVersion or source as a top-level
  // key.
  //
  // A byte diff is impossible for two of the recordings (a private server's
  // order book is not CCP's), so the two tests above enforce that every
  // implemented operation has a recording or a reasoned exemption, and that every
  // recording is compared against by something, in the way its entry declares.
  //
  // The envelope claim rests on that plus `assertGolden`'s own refusal, and on
  // this: the base case, CCP's own bodies.
  for (const name of golden.listGoldens()) {
    assert.deepEqual(findEnvelopeKeys(golden.loadGolden(name).value), [], `${name} carries an envelope key`);
    assert.deepEqual(findNonSnakeCaseKeys(golden.loadGolden(name).value), []);
  }
});
