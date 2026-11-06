/**
 * `scripts/observe-authed.js`: does the capture keep the operator's data out of
 * its own transcript?
 *
 * Run with: node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * `shapeOf` stands between a live authenticated response and the terminal, and
 * the script's claim that its output is safe to paste into an issue rests on
 * that function being correct. A redactor nobody tests leaks the first time
 * somebody adds a branch to it, silently: the transcript still looks fine, it
 * just has a pilot's name in it.
 *
 * The assertions are written the way a redactor has to be reasoned about: not
 * "does it strip the fields we thought of", but "is there any value on the
 * other side that we did not explicitly ask for". The bodies are synthetic and
 * shaped like the real ones: `contact_id` where a real contact id would be, a
 * `name` where a structure's name would be.
 *
 * The ids are ESI's published example (`90000001`) and obvious inventions.
 * Nothing here came off a live account.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  SCOPES,
  headerLines,
  producerEvidence,
  shapeOf,
} = require(path.join(__dirname, "../scripts/observe-authed"));

const NOTHING_REVEALED = new Set();

/**
 * Every scalar in a rendered shape, flattened.
 *
 * The test's own reading of "what would reach the terminal": whatever this
 * returns is what an operator, or whoever they paste the transcript to, can
 * see. An assertion against the JSON text would pass for a value that merely
 * happened not to appear as a substring.
 */
function scalars(shape, found = []) {
  if (shape === null || typeof shape !== "object") {
    found.push(shape);
    return found;
  }
  for (const value of Object.values(shape)) scalars(value, found);
  return found;
}

// The redaction

test("a contacts body keeps its field order and loses every value", () => {
  // An array of three-field objects, where all three fields are somebody's real
  // standing toward somebody real.
  const body = [
    { contact_id: 90000001, contact_type: "character", standing: 5.0 },
    { contact_id: 90000002, contact_type: "corporation", standing: -7.5 },
  ];

  const shape = shapeOf(body, NOTHING_REVEALED);

  assert.equal(shape.array, 2, "the length is protocol and survives");
  assert.deepEqual(
    Object.keys(shape.of),
    ["contact_id", "contact_type", "standing"],
    "field order is bytes, and is the whole point of the capture",
  );
  assert.deepEqual(shape.of, { contact_id: "number", contact_type: "string", standing: "number" });

  const leaked = scalars(shape).filter((value) => value === 90000001 || value === -7.5);
  assert.deepEqual(leaked, [], "no contact id and no standing reached the output");
});

test("a structure body loses its name, which is the value that names a real place", () => {
  const body = { name: "Some Real Citadel Nobody Should Read Here", owner_id: 98777771, solar_system_id: 30000142 };

  const shape = shapeOf(body, NOTHING_REVEALED);

  assert.deepEqual(Object.keys(shape), ["name", "owner_id", "solar_system_id"]);
  assert.equal(shape.name, "string", "the type survives, the name does not");
  assert.doesNotMatch(JSON.stringify(shape), /Citadel/);
});

test("--reveal opts a named field back in, and only that field", () => {
  // `contact_type` is a four-value enum from the spec: protocol, not data.
  // `contact_id` beside it is a real person and stays redacted.
  const shape = shapeOf(
    [{ contact_id: 90000001, contact_type: "character", standing: 5.0 }],
    new Set(["contact_type"]),
  );

  assert.equal(shape.of.contact_type, "character", "the revealed field shows its value");
  assert.equal(shape.of.contact_id, "number", "its neighbour does not");
  assert.equal(shape.of.standing, "number");
});

test("an absent optional field is absent from the shape, which is how omit-vs-null is read", () => {
  // ESI omits an optional field rather than sending null. The capture has to be
  // able to show that, so presence is a fact the shape carries and the
  // difference between the two must survive redaction.
  const docked = shapeOf({ solar_system_id: 1, station_id: 2 }, NOTHING_REVEALED);
  const inSpace = shapeOf({ solar_system_id: 1 }, NOTHING_REVEALED);
  const nulled = shapeOf({ solar_system_id: 1, station_id: null }, NOTHING_REVEALED);

  assert.deepEqual(Object.keys(docked), ["solar_system_id", "station_id"]);
  assert.deepEqual(Object.keys(inSpace), ["solar_system_id"]);
  assert.equal(nulled.station_id, "null", "a null is reported as one, not folded into absent");
});

test("elements that disagree on shape are flagged rather than averaged away", () => {
  // One element in a long array carrying a field the others do not is a finding
  // that would otherwise vanish into a haystack.
  const shape = shapeOf(
    [
      { structure_id: 1, state: "shield_vulnerable" },
      { structure_id: 2, state: "shield_vulnerable", unanchors_at: "2026-01-01T00:00:00Z" },
    ],
    NOTHING_REVEALED,
  );

  assert.equal(shape.array, 2);
  assert.match(shape.WARNING, /2 distinct element shapes/);
});

test("an empty collection is reported as one, because zero is an answer", () => {
  const shape = shapeOf([], NOTHING_REVEALED);

  assert.deepEqual(shape, { array: 0, of: null });
});

test("nesting is bounded, so a cyclic-looking body cannot run the redactor away", () => {
  let deep = { value: 1 };
  for (let i = 0; i < 20; i += 1) deep = { nested: deep };

  const shape = shapeOf(deep, NOTHING_REVEALED);

  assert.match(JSON.stringify(shape), /…/, "the walk stops and says so");
});

test("a string body that is not an object still loses its content", () => {
  assert.equal(shapeOf("a pilot's name", NOTHING_REVEALED), "string");
  assert.equal(shapeOf(90000001, NOTHING_REVEALED), "number");
  assert.equal(shapeOf(null, NOTHING_REVEALED), "null");
});

// The evidence the capture exists to collect

test("producer evidence reads the four signals separately, and never the JSON", () => {
  // Collapsing these into one verdict is what the script must not do: if they
  // disagree, the disagreement is the finding. `contract/wire.js` SUCCESS_KIND
  // is what this feeds.
  const appLike = producerEvidence(
    [
      "Content-Type", "application/json; charset=UTF-8",
      "X-Esi-Request-Id", "00000000-0000-0000-0000-000000000000",
      "X-Pages", "3",
    ],
    Buffer.from('[{"contact_id":1}]'),
  );

  assert.equal(appLike.contentType, "application/json; charset=UTF-8");
  assert.equal(appLike.trailingNewline, false);
  assert.equal(appLike.xEsiRequestId, "present");
  assert.equal(appLike.xPages, "3");

  const gatewayLike = producerEvidence(
    ["Content-Type", "application/json", "X-Content-Type-Options", "nosniff"],
    Buffer.from('{"players":1}\n'),
  );

  assert.equal(gatewayLike.contentType, "application/json");
  assert.equal(gatewayLike.trailingNewline, true, "the newline is a byte fact and is read from the bytes");
  assert.equal(gatewayLike.xContentTypeOptions, "nosniff");
  assert.equal(gatewayLike.xEsiRequestId, "absent");
  assert.equal(gatewayLike.xPages, "absent", "absent is distinct from a value, and says so");
});

test("headers are rendered in wire order with duplicates intact", () => {
  // The rule `contract/wire.js` states: three `Vary` lines are not one
  // comma-joined line, and a transcript that cannot tell them apart is not an
  // observation of this surface.
  const lines = headerLines(["Vary", "X-Tenant", "Vary", "Accept-Language", "Vary", "X-Compatibility-Date"]);

  assert.deepEqual(lines, [
    "    Vary: X-Tenant",
    "    Vary: Accept-Language",
    "    Vary: X-Compatibility-Date",
  ]);
});

// The scope set

test("the requested scopes are exactly the eight the four issues need", () => {
  // A scope missing here is a hole in the transcript that only shows up as a
  // 401 halfway through a run that needed a human at a consent screen.
  assert.deepEqual([...SCOPES].sort(), [
    "esi-alliances.read_contacts.v1",
    "esi-characters.read_contacts.v1",
    "esi-characters.read_corporation_roles.v1",
    "esi-corporations.read_contacts.v1",
    "esi-corporations.read_structures.v1",
    "esi-fleets.read_fleet.v1",
    "esi-ui.write_waypoint.v1",
    "esi-universe.read_structures.v1",
  ].sort());
});

test("every distinct element shape is reported, with how many rows carry it", () => {
  // The first live run reported "2 distinct element shapes" and showed one of
  // them. An optional field omitted on some rows and present on others is the
  // observation, and it is invisible if the odd row is the one dropped.
  const shape = shapeOf(
    [
      { contact_id: 1, contact_type: "character", standing: 1 },
      { contact_id: 2, contact_type: "character", standing: 1 },
      { contact_id: 3, contact_type: "character", standing: 1, is_watched: true },
    ],
    NOTHING_REVEALED,
  );

  assert.equal(shape.array, 3);
  assert.equal(shape.shapes.length, 2, "both shapes survive, not just the first");
  assert.deepEqual(shape.shapes.map((s) => s.count), [2, 1], "and how many rows carry each");
  assert.deepEqual(
    Object.keys(shape.shapes[1].shape),
    ["contact_id", "contact_type", "standing", "is_watched"],
    "the rarer shape is the one that names the optional field",
  );
  // Still no values, on either shape.
  assert.deepEqual(scalars(shape).filter((v) => v === true), []);
});

test("an error body is printed without --reveal, because the string is the contract", () => {
  // The first live run captured the "not in a fleet" 404 and redacted the one
  // part worth having. `contract/wire.js` records these strings verbatim (the
  // literal message is what a client depends on), so a capture that reports
  // `{"error": "string"}` records that an error happened and discards what it
  // said.
  const { parseArgs } = require(path.join(__dirname, "../scripts/observe-authed"));
  const args = parseArgs(["--client-id", "x"]);

  assert.ok(args.reveal.has("error"), "error is revealed with no flag at all");

  const shape = shapeOf({ error: "Character not in a fleet" }, args.reveal);
  assert.equal(shape.error, "Character not in a fleet");
});

test("--reveal adds to the protocol fields rather than replacing them", () => {
  const { parseArgs } = require(path.join(__dirname, "../scripts/observe-authed"));
  const args = parseArgs(["--client-id", "x", "--reveal", "contact_type"]);

  assert.ok(args.reveal.has("error"), "still there");
  assert.ok(args.reveal.has("contact_type"), "and the requested one too");
  assert.equal(shapeOf({ name: "a pilot" }, args.reveal).name, "string", "and nothing else changed");
});

test("the D35 probes are optional, carry no defaults, and add to the others", () => {
  // No defaults, for the reason `--other-corporation` has none: each names a
  // real entity somebody owns, and this file does not carry one. A run without
  // them skips those rows and says which decision stays open.
  const { parseArgs } = require(path.join(__dirname, "../scripts/observe-authed"));

  const bare = parseArgs(["--client-id", "x"]);
  assert.equal(bare.otherAlliance, null, "no default alliance");
  assert.equal(bare.otherFleet, null, "no default fleet");

  const full = parseArgs([
    "--client-id", "x",
    "--other-corporation", "1000035",
    "--other-alliance", "99000000",
    "--other-fleet", "10020000",
  ]);
  assert.equal(full.otherCorporation, 1000035);
  assert.equal(full.otherAlliance, 99000000);
  assert.equal(full.otherFleet, 10020000);

  // They did not disturb the redaction defaults.
  assert.ok(full.reveal.has("error"), "error is still revealed without a flag");
  assert.equal(full.write, false, "the mutating probe is still off");
});
