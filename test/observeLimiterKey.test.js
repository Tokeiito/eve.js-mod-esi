/**
 * `scripts/observe-limiter-key.js`: does the capture refuse to conclude more
 * than it saw, and does it keep the token out of its own transcript?
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Nothing here touches the network. This pins the pure half: the argument
 * parser, the pre-flight guard, the two interpreters, and `scrub`.
 *
 * The interpreters matter most. This repository does not permit a guessed wire
 * fact, and a guess gets in when a probe that could not distinguish two answers
 * reports the likelier one. So inconclusive is asserted as a first-class
 * outcome in every shape it comes in: a reading that never arrived, a window
 * that rolled, a matrix whose cells cannot tell two candidate keys apart, and a
 * set of readings no candidate predicts at all. A suite that only checked the
 * three happy verdicts would pass on a classifier that never says "I cannot
 * tell".
 *
 * Every id is ESI's own published example (`90000001`) or an obvious invention,
 * and every fingerprint is a made-up hex string. Nothing came off a live
 * account.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  CELLS,
  ERROR_LIMIT_MAX,
  KEY_CANDIDATES,
  MIN_ERROR_BUDGET,
  USAGE,
  applicationOf,
  bucketNameFor,
  characterOf,
  checkBudget,
  checkMatrixConsistency,
  classifyMatrix,
  contaminationOf,
  countersOf,
  fingerprint,
  headerLines,
  interpretCounter,
  maxFromLimit,
  missingCells,
  parseArgs,
  render,
  scrub,
} = require(path.join(__dirname, "../scripts/observe-limiter-key"));

/** A JWT-shaped string that is not a token and never was. */
const FAKE_TOKEN = [
  "eyJhbGciOiJSUzI1NiIsImtpZCI6IkpXVC1TaWduYXR1cmUtS2V5In0",
  "eyJzdWIiOiJDSEFSQUNURVI6RVZFOjkwMDAwMDAxIiwiYXpwIjoiZXhhbXBsZS1jbGllbnQifQ",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
].join(".");

// Arguments

test("a bare run with no cell is refused, because there is nothing to authorise", () => {
  // Prevents a consent screen burned on a probe that measures nothing.
  assert.throws(() => parseArgs(["--client-id", "app-a"]), /no --cell was given/);
});

test("the a cells need application A and the b cells need a SECOND application", () => {
  assert.throws(() => parseArgs(["--cell", "a1"]), /cells a1 and a2 need --client-id/);
  assert.throws(
    () => parseArgs(["--client-id", "app-a", "--cell", "b1"]),
    /SECOND registered application/,
  );

  const ok = parseArgs(["--client-id", "app-a", "--client-id-b", "app-b", "--cell", "b1"]);
  assert.deepEqual(ok.cells, ["b1"]);
});

test("two names for one application is refused, because the b cells would move no axis", () => {
  // The silent failure: cells b1 and b2 recorded as a second application when
  // they are the first one again, which looks exactly like "the application half
  // does not matter".
  assert.throws(
    () => parseArgs(["--client-id", "same", "--client-id-b", "same", "--cell", "a1", "--cell", "b1"]),
    /the same application/,
  );
});

test("the full matrix parses, and the cells come back in fire order whatever order they arrived in", () => {
  // Order is not cosmetic: the classifier replays charges in this sequence and
  // compares each reading against what a candidate predicts.
  const args = parseArgs([
    "--client-id", "app-a",
    "--client-id-b", "app-b",
    "--cell", "b2",
    "--cell", "a2",
    "--cell", "b1",
    "--cell", "a1",
  ]);

  assert.deepEqual(args.cells, ["a1", "a2", "b1", "b2"]);
  assert.deepEqual(args.cells, [...CELLS]);
});

test("a cell named twice is refused, and so is a cell that is not a cell", () => {
  assert.throws(
    () => parseArgs(["--client-id", "app-a", "--cell", "a1", "--cell", "a1"]),
    /was given twice/,
  );
  assert.throws(() => parseArgs(["--client-id", "app-a", "--cell", "c3"]), /--cell must be one of/);
});

test("--show, --forget and --help skip every requirement, because none of them spends anything", () => {
  // Each is a read of state or of this file. Demanding a client id for them
  // would demand an application to be told which cells are missing.
  assert.equal(parseArgs(["--show"]).show, true);
  assert.equal(parseArgs(["--forget"]).forget, true);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("no identifier has a default, and the paths and floor do", () => {
  // The rule `observe-authed.js` states for --other-corporation: an id names a
  // real person's property, so the operator supplies it and this file does not
  // carry it. The probe paths are protocol and are carried.
  const args = parseArgs(["--client-id", "app-a", "--cell", "a1"]);

  assert.equal(args.clientIdB, null, "no default second application");
  assert.equal(args.minBudget, MIN_ERROR_BUDGET);
  assert.match(args.errorPath, /^\//);
  assert.match(args.bucketPath, /^\//);
  assert.match(args.baselinePath, /^\//);
});

test("an unknown flag and a flag with no value are both refused rather than ignored", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["--client-id"]), /needs a value/);
  assert.throws(() => parseArgs(["--cell", "--client-id", "x"]), /needs a value/);
});

test("the usage block states the cost before the operator commits to it", () => {
  // A capture that spends from a stranger's limiter has to say how much on the
  // way in, not in a summary afterwards.
  assert.match(USAGE, /6 error units of 100/);
  assert.match(USAGE, /12 tokens of the status group/);
  assert.match(USAGE, new RegExp(String(MIN_ERROR_BUDGET)));
});

test("usage names what only the operator can supply", () => {
  assert.match(USAGE, /second registered application/);
  assert.match(USAGE, /second character/);
});

// The pre-flight guard

test("a healthy budget is allowed and says how much is left", () => {
  const verdict = checkBudget({ remain: 100 });

  assert.equal(verdict.ok, true);
  assert.match(verdict.why, /100 of 100/);
});

test("a depleted budget is refused rather than pushed toward the limit", () => {
  const verdict = checkBudget({ remain: MIN_ERROR_BUDGET - 1 });

  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /moving baseline/);
});

test("the floor is exclusive at the boundary and honours --min-budget", () => {
  assert.equal(checkBudget({ remain: MIN_ERROR_BUDGET }).ok, true, "exactly the floor is enough");
  assert.equal(checkBudget({ remain: 60, minBudget: 90 }).ok, false, "a raised floor refuses more");
});

test("a budget that could not be read is refused, not assumed fine", () => {
  // Catches a route that stopped sending the header, read as an empty counter
  // and then spent against.
  assert.equal(checkBudget({ remain: null }).ok, false);
  assert.match(checkBudget({ remain: null }).why, /spending blind/);
  assert.equal(checkBudget({ remain: Number.NaN }).ok, false);
});

// The counter interpreter

test("a counter that continued means one budget", () => {
  const verdict = interpretCounter({ before: 98, after: 97, cost: 1, max: ERROR_LIMIT_MAX });

  assert.equal(verdict.verdict, "shared");
  assert.match(verdict.why, /one budget/);
});

test("a counter that read a full budget minus its own charge means two", () => {
  // The authenticated probe finding 99 after the unauthenticated pair left the
  // address budget at 98: it was charged somewhere nothing had spent from.
  const verdict = interpretCounter({ before: 98, after: 99, cost: 1, max: ERROR_LIMIT_MAX });

  assert.equal(verdict.verdict, "separate");
});

test("a counter that did not move at all is INCONCLUSIVE, not shared", () => {
  // "Nothing was charged here" and "a second budget paid" are different
  // findings. A classifier that folded them would report the key question
  // answered by a probe that never reached the limiter.
  const verdict = interpretCounter({ before: 98, after: 98, cost: 1, max: ERROR_LIMIT_MAX });

  assert.equal(verdict.verdict, "inconclusive");
  assert.match(verdict.why, /not charged to this limiter at all/);
});

test("a rolled window is INCONCLUSIVE even when the numbers would have read cleanly", () => {
  // 98 -> 99 across a rollover is a refilled counter, not a second budget, and
  // the arithmetic cannot tell. The reset countdown can, so it decides.
  const verdict = interpretCounter({
    before: 98, after: 99, cost: 1, max: ERROR_LIMIT_MAX, windowRolled: true,
  });

  assert.equal(verdict.verdict, "inconclusive");
  assert.match(verdict.why, /window rolled/);
});

test("a reading that never arrived is INCONCLUSIVE", () => {
  assert.equal(interpretCounter({ before: null, after: 97, cost: 1 }).verdict, "inconclusive");
  assert.equal(interpretCounter({ before: 98, after: null, cost: 1 }).verdict, "inconclusive");
  assert.match(interpretCounter({ before: 98, after: null, cost: 1 }).why, /not sent/);
});

test("a charge that could not be read is INCONCLUSIVE, because neither outcome is predictable", () => {
  const verdict = interpretCounter({ before: 600, after: 598, cost: null });

  assert.equal(verdict.verdict, "inconclusive");
  assert.match(verdict.why, /charge for the second request could not be read/);
});

test("a move that matches neither prediction is INCONCLUSIVE rather than rounded to the nearer one", () => {
  const verdict = interpretCounter({ before: 98, after: 93, cost: 1, max: ERROR_LIMIT_MAX });

  assert.equal(verdict.verdict, "inconclusive");
  assert.match(verdict.why, /neither the amount a shared budget predicts/);
});

test("the token bucket's larger costs are read the same way", () => {
  // `Used: 2` on a 200, from wire.js TOKEN_BUCKET. The interpreter takes the
  // cost from the response rather than assuming one.
  assert.equal(interpretCounter({ before: 596, after: 594, cost: 2, max: 600 }).verdict, "shared");
  assert.equal(interpretCounter({ before: 596, after: 598, cost: 2, max: 600 }).verdict, "separate");
});

// The matrix

/**
 * The observed sequence a candidate key would produce, for building fixtures.
 *
 * Written out longhand rather than by calling the script's own simulator: a
 * test that generated its expectations from the code under test would pass for
 * any consistent nonsense.
 */
const FULL = Object.freeze({
  // The address budget sat at 98 after the unauthenticated pair.
  sourceAddress: [97, 96, 95, 94],
  applicationAndCharacter: [99, 99, 99, 99],
  characterOnly: [99, 99, 98, 98],
  applicationOnly: [99, 98, 99, 98],
});

function eventsFor(sequence, cells = CELLS) {
  return cells.map((cell, index) => ({ cell, after: sequence[index], cost: 1 }));
}

test("a complete matrix names exactly one key, for each of the four candidates", () => {
  // The 2x2 rests on this: all four candidates are distinguished by these cells,
  // and by no smaller set. If two of these sequences were ever equal the matrix
  // would be decorative.
  for (const candidate of KEY_CANDIDATES) {
    const outcome = classifyMatrix({
      events: eventsFor(FULL[candidate]),
      max: ERROR_LIMIT_MAX,
      addressAfter: 98,
      ran: [...CELLS],
    });

    assert.equal(outcome.verdict, candidate, `the full matrix should read ${candidate}`);
    assert.deepEqual(outcome.survivors, [candidate]);
    assert.deepEqual(outcome.missing, []);
  }
});

test("the four predicted sequences are all different, which is why four cells are needed", () => {
  const rendered = KEY_CANDIDATES.map((candidate) => FULL[candidate].join(","));

  assert.equal(new Set(rendered).size, 4, "no two candidates predict the same readings");
});

test("a1 and a2 alone cannot tell the pair from application-alone, and say so", () => {
  // The two predict the character half moving the budget differently, and the
  // cells that could split them are the b ones. Any single pair splits one axis
  // and leaves the other unobserved.
  const outcome = classifyMatrix({
    events: eventsFor([99, 99], ["a1", "a2"]),
    max: ERROR_LIMIT_MAX,
    addressAfter: 98,
    ran: ["a1", "a2"],
  });

  assert.equal(outcome.verdict, "inconclusive", "a half matrix must not pick");
  assert.ok(outcome.survivors.length > 1);
  assert.ok(
    outcome.survivors.includes("applicationAndCharacter") && outcome.survivors.includes("characterOnly"),
    "the two the character axis alone cannot separate are both still standing",
  );
  assert.deepEqual(outcome.missing, ["b1", "b2"]);
});

test("an inconclusive matrix names the cell that would split what is left", () => {
  const outcome = classifyMatrix({
    events: eventsFor([99, 99], ["a1", "a2"]),
    max: ERROR_LIMIT_MAX,
    addressAfter: 98,
    ran: ["a1", "a2"],
  });

  assert.ok(Array.isArray(outcome.splitters) && outcome.splitters.length > 0);
  assert.ok(
    outcome.splitters.some((entry) => entry.cell === "b1"),
    "b1 is a cell that moves the application axis and therefore splits the survivors",
  );
  assert.ok(outcome.splitters.every((entry) => typeof entry.settles === "string" && entry.settles.length > 0));
});

test("one cell alone is inconclusive, however clean its reading", () => {
  const outcome = classifyMatrix({
    events: eventsFor([99], ["a1"]),
    max: ERROR_LIMIT_MAX,
    addressAfter: 98,
    ran: ["a1"],
  });

  assert.equal(outcome.verdict, "inconclusive");
  assert.equal(outcome.survivors.includes("sourceAddress"), false, "97 was predicted and 99 was seen");
  assert.deepEqual(outcome.missing, ["a2", "b1", "b2"]);
});

test("readings no candidate predicts are INCONCLUSIVE with zero survivors, not the nearest fit", () => {
  // If CCP does something none of the four describes, that is a finding worth
  // recording verbatim. It is not one of the four answers, and the classifier
  // must not round it into one.
  const outcome = classifyMatrix({
    events: eventsFor([42, 17, 3, 91]),
    max: ERROR_LIMIT_MAX,
    addressAfter: 98,
    ran: [...CELLS],
  });

  assert.equal(outcome.verdict, "inconclusive");
  assert.deepEqual(outcome.survivors, []);
  assert.match(outcome.why, /no candidate key predicts these readings/);
  assert.equal(outcome.rejected.length, KEY_CANDIDATES.length, "every candidate is reported with where it broke");
});

test("a rejected candidate reports where it broke, so the transcript can be read by hand", () => {
  const outcome = classifyMatrix({
    events: eventsFor(FULL.applicationOnly),
    max: ERROR_LIMIT_MAX,
    addressAfter: 98,
    ran: [...CELLS],
  });

  const pair = outcome.rejected.find((entry) => entry.candidate === "applicationAndCharacter");
  assert.ok(pair, "the pair candidate was ruled out");
  assert.equal(pair.at, "a2", "and a2 is the cell that ruled it out");
  assert.equal(pair.predicted, 99);
  assert.equal(pair.observed, 98);
});

test("the matrix works on the token bucket's numbers too, with its own maximum", () => {
  // The two limiters may not agree, so the classifier must not be wired to the
  // error limiter's 100.
  const outcome = classifyMatrix({
    events: [
      { cell: "a1", after: 598, cost: 2 },
      { cell: "a2", after: 598, cost: 2 },
      { cell: "b1", after: 598, cost: 2 },
      { cell: "b2", after: 598, cost: 2 },
    ],
    max: 600,
    addressAfter: 596,
    ran: [...CELLS],
  });

  assert.equal(outcome.verdict, "applicationAndCharacter");
});

test("bucket names collapse exactly the cells a candidate says share a budget", () => {
  assert.equal(bucketNameFor("sourceAddress", "a1"), bucketNameFor("sourceAddress", "b2"));
  assert.equal(bucketNameFor("characterOnly", "a1"), bucketNameFor("characterOnly", "b1"));
  assert.notEqual(bucketNameFor("characterOnly", "a1"), bucketNameFor("characterOnly", "a2"));
  assert.equal(bucketNameFor("applicationOnly", "a1"), bucketNameFor("applicationOnly", "a2"));
  assert.notEqual(bucketNameFor("applicationOnly", "a1"), bucketNameFor("applicationOnly", "b1"));
  assert.equal(new Set(CELLS.map((cell) => bucketNameFor("applicationAndCharacter", cell))).size, 4);
});

test("a cell is read as an application letter and a character digit", () => {
  assert.equal(applicationOf("b2"), "B");
  assert.equal(characterOf("b2"), "2");
});

// Did the operator move the axis they said they moved

test("two cells that claim different characters but share one are caught", () => {
  // The silent failure: a2 authorised by the same pilot as a1 looks exactly like
  // "the character half does not matter".
  const problems = checkMatrixConsistency({
    a1: { applicationFingerprint: "aaaaaaaaaaaa", characterFingerprint: "111111111111" },
    a2: { applicationFingerprint: "aaaaaaaaaaaa", characterFingerprint: "111111111111" },
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0], /SAME character/);
});

test("two cells that claim different applications but share one are caught", () => {
  const problems = checkMatrixConsistency({
    a1: { applicationFingerprint: "aaaaaaaaaaaa", characterFingerprint: "111111111111" },
    b1: { applicationFingerprint: "aaaaaaaaaaaa", characterFingerprint: "111111111111" },
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0], /SAME application/);
});

test("a cell pair that should share a character but does not is caught too", () => {
  const problems = checkMatrixConsistency({
    a1: { applicationFingerprint: "aaaaaaaaaaaa", characterFingerprint: "111111111111" },
    b1: { applicationFingerprint: "bbbbbbbbbbbb", characterFingerprint: "222222222222" },
  });

  assert.equal(problems.length, 1);
  assert.match(problems[0], /DIFFERENT characters/);
});

test("a correctly authorised matrix reports no problems", () => {
  const problems = checkMatrixConsistency({
    a1: { applicationFingerprint: "aaaaaaaaaaaa", characterFingerprint: "111111111111" },
    a2: { applicationFingerprint: "aaaaaaaaaaaa", characterFingerprint: "222222222222" },
    b1: { applicationFingerprint: "bbbbbbbbbbbb", characterFingerprint: "111111111111" },
    b2: { applicationFingerprint: "bbbbbbbbbbbb", characterFingerprint: "222222222222" },
  });

  assert.deepEqual(problems, []);
});

// Contamination

test("a preamble that stepped down cleanly is not contaminated", () => {
  assert.deepEqual(
    contaminationOf([
      { after: 100, reset: 58, cost: 0 },
      { after: 99, reset: 57, cost: 1 },
      { after: 98, reset: 56, cost: 1 },
    ]),
    [],
  );
});

test("a counter that skipped a step is reported as contaminated, not averaged", () => {
  // Somebody else on this address charged the same budget in between, which
  // makes every delta below it a delta against a moving baseline.
  const problems = contaminationOf([
    { after: 100, reset: 58, cost: 0 },
    { after: 94, reset: 57, cost: 1 },
  ]);

  assert.equal(problems.length, 1);
  assert.match(problems[0], /something else spent from this budget/);
});

test("a Reset that counted up is reported, because it only does that when the window rolls", () => {
  const problems = contaminationOf([
    { after: 99, reset: 3, cost: 1 },
    { after: 98, reset: 59, cost: 1 },
  ]);

  assert.ok(problems.some((problem) => /window rolls/.test(problem)));
});

test("a missing counter in the preamble is a problem in its own right", () => {
  const problems = contaminationOf([
    { after: 99, reset: 57, cost: 1 },
    { after: null, reset: null, cost: 1 },
  ]);

  assert.ok(problems.some((problem) => /carried no counter/.test(problem)));
});

// Reading the wire

test("both limiters' counters are read off one response, each independently nullable", () => {
  // Reported separately rather than resolved into "which limiter charged this":
  // a response carrying both would be a finding, and a function that picked one
  // would hide it.
  const both = countersOf([
    "X-Esi-Error-Limit-Remain", "97",
    "X-Esi-Error-Limit-Reset", "41",
    "X-Ratelimit-Group", "status",
    "X-Ratelimit-Limit", "600/15m",
    "X-Ratelimit-Remaining", "596",
    "X-Ratelimit-Used", "2",
  ]);

  assert.deepEqual(both, {
    errorRemain: 97, errorReset: 41, group: "status", limit: "600/15m", remaining: 596, used: 2,
  });

  const neither = countersOf(["Content-Type", "application/json"]);
  assert.equal(neither.errorRemain, null);
  assert.equal(neither.group, null);
  assert.equal(neither.remaining, null);
});

test("the limit header's max is read and its window half is not guessed at", () => {
  assert.equal(maxFromLimit("600/15m"), 600);
  assert.equal(maxFromLimit(null), null);
  assert.equal(maxFromLimit("nonsense"), null);
});

test("headers are rendered in wire order with duplicates intact", () => {
  // The rule contract/wire.js states: three `Vary` lines are not one
  // comma-joined line, and a transcript that cannot tell them apart is not an
  // observation of this surface.
  assert.deepEqual(
    headerLines(["Vary", "X-Tenant", "Vary", "Accept-Language"]),
    ["    Vary: X-Tenant", "    Vary: Accept-Language"],
  );
});

// The token never reaches the terminal

test("scrub removes a token it was told about", () => {
  assert.equal(scrub(`before ${FAKE_TOKEN} after`, [FAKE_TOKEN]).includes(FAKE_TOKEN), false);
  assert.match(scrub(`before ${FAKE_TOKEN} after`, [FAKE_TOKEN]), /\[token redacted\]/);
});

test("scrub removes a JWT-shaped string it was NOT told about", () => {
  // An upstream diagnostic header echoing an Authorization back. The secret list
  // would not contain it if the value had been mangled, so the shape is caught as
  // well as the string.
  const out = scrub(`Some-Header: ${FAKE_TOKEN}`, []);

  assert.equal(out.includes(FAKE_TOKEN), false);
  assert.match(out, /\[token redacted\]/);
});

test("scrub leaves ordinary output alone, so a redactor does not eat the observation", () => {
  const line = "X-Esi-Error-Limit-Remain: 97   Reset 41   group status 600/15m";

  assert.equal(scrub(line, []), line);
});

test("a rendered probe cannot carry the token, even when the response echoes one", () => {
  // `render` never takes a token as an argument, which is the first defence.
  // `scrub` is the second, and this asserts the pair rather than either alone.
  const rendered = render("AUTHENTICATED error · cell a1", "GET", "/latest/universe/systems/99/", {
    status: 404,
    authenticated: true,
    rawHeaders: [
      "Content-Type", "application/json",
      "X-Esi-Error-Limit-Remain", "99",
      "X-Esi-Error-Limit-Reset", "56",
      "X-Echoed-Authorization", `Bearer ${FAKE_TOKEN}`,
    ],
    body: Buffer.from('{"error":"Not found"}'),
  });

  assert.match(rendered, /Remain 99/, "the observation survives");
  assert.match(rendered, /Bearer …/, "and the request line says a credential was sent without showing it");
  assert.equal(scrub(rendered, [FAKE_TOKEN]).includes(FAKE_TOKEN), false, "and the token does not");
});

test("an unauthenticated probe says so in its own request line", () => {
  const rendered = render("unauthenticated error 1", "GET", "/latest/universe/systems/99/", {
    status: 404,
    authenticated: false,
    rawHeaders: ["X-Esi-Error-Limit-Remain", "99"],
    body: Buffer.alloc(0),
  });

  assert.match(rendered, /no Authorization header/);
  assert.match(rendered, /0 bytes/);
});

// Identifiers

test("a fingerprint identifies without naming", () => {
  // Enough to prove a1 and a2 were two different characters, not enough to say
  // which two. The transcript and the state file are both written to that rule.
  const one = fingerprint("90000001");
  const two = fingerprint("90000002");

  assert.equal(one.length, 12);
  assert.match(one, /^[0-9a-f]{12}$/);
  assert.notEqual(one, two);
  assert.equal(one.includes("90000001"), false);
  assert.equal(fingerprint("90000001"), one, "and it is stable across calls");
});

test("the script file carries no identifier of its own", () => {
  // Asserted rather than trusted: a client id or a character id baked into a
  // default would travel into the repository the first time somebody ran this and
  // pasted the transcript.
  const fs = require("node:fs");
  const source = fs.readFileSync(path.join(__dirname, "../scripts/observe-limiter-key.js"), "utf8");

  // ESI's documented example is allowed. A nine- or ten-digit id that is not it
  // is the shape a real character or corporation id has.
  const suspicious = (source.match(/\b\d{8,12}\b/g) || []).filter((value) => value !== "90000001");
  assert.deepEqual(suspicious, [], "no bare account-shaped id appears anywhere in the script");
});

// State bookkeeping

test("missing cells are reported from what has been visited, across runs", () => {
  assert.deepEqual(missingCells({ runs: [] }), [...CELLS]);
  assert.deepEqual(missingCells({ runs: [{ cells: ["a1"] }, { cells: ["b1"] }] }), ["a2", "b2"]);
  assert.deepEqual(missingCells({ runs: [{ cells: ["a1", "a2", "b1", "b2"] }] }), []);
});
