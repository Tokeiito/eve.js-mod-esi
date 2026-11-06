/**
 * `GET /characters/{character_id}/industry/jobs/` against CCP's pinned spec,
 * and the two clocks a stored job date can be in.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * `services/industry/industryRuntimeState.js` stores `startDate`, `endDate`
 * and `pauseDate` as decimal strings, and upstream's `normalizeIndustryFileTime`
 * reads a value at or below 9,999,999,999,999 as Unix milliseconds and anything
 * larger as Windows FILETIME. A reader implementing only the second branch
 * would date every legacy row to 1601 in a body that still validates against
 * the schema, so the fixture carries a job in each encoding and asserts they
 * land on the same instant.
 *
 * The FILETIME values are computed from the epoch offset:
 * `(millis * 10000) + 116444736000000000`.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  assertBody,
  assertRouteMatchesSpec,
  describeOperation,
} = require(path.join(__dirname, "../contract/spec"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const {
  FILETIME_EPOCH_OFFSET,
  FILETIME_TICKS_PER_MILLISECOND,
  LEGACY_UNIX_MS_MAX,
  createIndustryStore,
  epochMillisFromStored,
  toEsiTimestamp,
} = require(path.join(__dirname, "../lib/industryStore"));
const {
  CHARACTER_JOBS_OPERATION_ID,
  CHARACTER_JOBS_PATH,
  CHARACTER_JOBS_SCOPE,
  buildCharacterIndustryJobs,
  createCharacterIndustryJobsRoute,
  readIncludeCompleted,
} = require(path.join(__dirname, "../routes/industry"));

const OWNER = 90000021;
const OTHER_OWNER = 90000022;

const START_MS = Date.parse("2026-09-16T08:00:00Z");
const END_MS = Date.parse("2026-09-16T20:30:45Z");

/** Milliseconds as FILETIME ticks, the way upstream writes them. */
const filetime = (millis) =>
  String(BigInt(millis) * FILETIME_TICKS_PER_MILLISECOND + FILETIME_EPOCH_OFFSET);

/**
 * Four jobs: one running in FILETIME, one running in the legacy Unix-ms
 * encoding, one delivered, and one belonging to somebody else.
 */
const JOBS = {
  jobs: {
    500000001: {
      jobID: 500000001, ownerID: OWNER, installerID: OWNER, activityID: 1,
      blueprintID: 1990000030, blueprintTypeID: 691, blueprintLocationID: 60003760,
      outputLocationID: 60003760, facilityID: 60003760, stationID: 60003760,
      status: 1, runs: 10, licensedRuns: 300, successfulRuns: 0,
      cost: 12345.67, probability: 1, productTypeID: 587, timeInSeconds: 45045,
      startDate: filetime(START_MS), endDate: filetime(END_MS), pauseDate: null,
      completedCharacterID: 0, completedDate: null,
    },
    // The legacy encoding: the same two instants, written as Unix ms.
    500000002: {
      jobID: 500000002, ownerID: OWNER, installerID: OWNER, activityID: 5,
      blueprintID: 1990000031, blueprintTypeID: 691, blueprintLocationID: 60003760,
      outputLocationID: 60003760, facilityID: 60003760, stationID: 60003760,
      status: 3, runs: 1, licensedRuns: 1, successfulRuns: 0,
      cost: 0, probability: 1, productTypeID: 691, timeInSeconds: 3600,
      startDate: String(START_MS), endDate: String(END_MS), pauseDate: null,
      completedCharacterID: 0, completedDate: null,
    },
    // Delivered: dropped unless include_completed says otherwise.
    500000003: {
      jobID: 500000003, ownerID: OWNER, installerID: OWNER, activityID: 1,
      blueprintID: 1990000032, blueprintTypeID: 1010, blueprintLocationID: 60003760,
      outputLocationID: 60003760, facilityID: 60003760, stationID: 60003760,
      status: 101, runs: 2, licensedRuns: 10, successfulRuns: 2,
      cost: 99.5, probability: 1, productTypeID: 588, timeInSeconds: 600,
      startDate: filetime(START_MS), endDate: filetime(END_MS), pauseDate: null,
      completedCharacterID: OWNER, completedDate: filetime(END_MS),
    },
    500000009: {
      jobID: 500000009, ownerID: OTHER_OWNER, installerID: OTHER_OWNER, activityID: 1,
      blueprintID: 1990000040, blueprintTypeID: 691, blueprintLocationID: 60003760,
      outputLocationID: 60003760, facilityID: 60003760, stationID: 60003760,
      status: 1, runs: 1, licensedRuns: 1, successfulRuns: 0,
      cost: 1, probability: 1, productTypeID: 587, timeInSeconds: 60,
      startDate: filetime(START_MS), endDate: filetime(END_MS), pauseDate: null,
      completedCharacterID: 0, completedDate: null,
    },
  },
};

function deps(table = JOBS) {
  return {
    industry: createIndustryStore({
      readTable: (name, key) => {
        if (name !== "industryJobs" || key !== "/") throw new Error(`fixture: no ${name}.${key}`);
        return table;
      },
    }),
  };
}

const jobs = (query = {}, table) =>
  buildCharacterIndustryJobs({ credential: { characterId: OWNER }, query }, deps(table));

/**
 * The body as a client receives it.
 *
 * `cost` and `probability` are `format: double`, and `lib/serialize.js` carries
 * a double as a marker object until the bytes are written, which is what lets
 * an integral double reach the wire as `0.0` rather than `0`. A spec check
 * therefore looks at the parsed bytes and not at the projection, as
 * `test/marketsContract.test.js` does for the two price fields.
 */
const onTheWire = (query, table) =>
  JSON.parse(serializeBody(jobs(query, table), "app").toString("utf8"));

// The document

test("the descriptor agrees with the pinned spec", () => {
  const contract = assertRouteMatchesSpec(createCharacterIndustryJobsRoute(deps()));
  assert.equal(contract.operationId, CHARACTER_JOBS_OPERATION_ID);
  assert.deepEqual(contract.scopes, [CHARACTER_JOBS_SCOPE]);
  assert.equal(contract.cacheAgeSeconds, 300);
});

test("the operation declares no page parameter, which is why it does not paginate", () => {
  const contract = describeOperation("get", CHARACTER_JOBS_PATH);
  assert.equal(contract.queryParameters.page, undefined);
  assert.equal(createCharacterIndustryJobsRoute(deps()).pageSize, undefined);
  // It declares the one parameter this route reads.
  assert.notEqual(contract.queryParameters.include_completed, undefined);
  assert.equal(contract.queryParameters.include_completed.type, "boolean");
});

// The body

test("the list satisfies the spec and is in the schema's key order", () => {
  const body = jobs();

  assertBody(onTheWire(), describeOperation("get", CHARACTER_JOBS_PATH));
  // Alphabetical, with the optional fields that answered null omitted.
  assert.deepEqual(Object.keys(body[0]), [
    "activity_id",
    "blueprint_id",
    "blueprint_location_id",
    "blueprint_type_id",
    "cost",
    "duration",
    "end_date",
    "facility_id",
    "installer_id",
    "job_id",
    "licensed_runs",
    "output_location_id",
    "probability",
    "product_type_id",
    "runs",
    "start_date",
    "station_id",
    "status",
    "successful_runs",
  ]);
});

test("only this owner's jobs are listed, in ascending job_id", () => {
  const ids = jobs().map((row) => row.job_id);
  assert.deepEqual(ids, [500000001, 500000002]);
  assert.ok(!ids.includes(500000009));
});

test("an owner with no jobs gets an empty list", () => {
  const body = buildCharacterIndustryJobs(
    { credential: { characterId: 140000009 }, query: {} },
    deps(),
  );
  assert.deepEqual(body, []);
  assertBody([], describeOperation("get", CHARACTER_JOBS_PATH));
});

// The two clocks

test("a FILETIME date and a legacy Unix-ms date land on the same instant", () => {
  // Both jobs carry the same two instants in the two encodings upstream
  // accepts, and both must come out identical.
  const [filetimeJob, legacyJob] = jobs();

  assert.equal(filetimeJob.start_date, "2026-09-16T08:00:00Z");
  assert.equal(legacyJob.start_date, filetimeJob.start_date);
  assert.equal(legacyJob.end_date, filetimeJob.end_date);
  assert.equal(filetimeJob.end_date, "2026-09-16T20:30:45Z");
});

test("the threshold between the encodings is upstream's and does not overlap", () => {
  // 9,999,999,999,999 ms is 2286, and the smallest FILETIME a job can hold is
  // far above it, so no date a job could carry is ambiguous.
  assert.equal(epochMillisFromStored(String(LEGACY_UNIX_MS_MAX)), Number(LEGACY_UNIX_MS_MAX));
  assert.equal(epochMillisFromStored(filetime(START_MS)), START_MS);
  assert.ok(BigInt(filetime(0)) > LEGACY_UNIX_MS_MAX);
});

test("a timestamp carries no fraction, which is what the contract's pattern requires", () => {
  // `toISOString()` writes milliseconds and contract/spec.js DATE_TIME rejects
  // them, so the fraction is cut rather than rounded.
  assert.equal(toEsiTimestamp(Date.parse("2026-09-16T08:00:00.999Z")), "2026-09-16T08:00:00Z");
  assert.match(jobs()[0].start_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("a date that cannot be read is a refusal, not an epoch", () => {
  const broken = { jobs: { 1: { ...JOBS.jobs[500000001], startDate: "not a number" } } };
  assert.throws(() => jobs({}, broken), /no readable start_date or end_date/);
});

// include_completed

test("a delivered job is dropped by default and kept when asked for", () => {
  assert.deepEqual(jobs().map((r) => r.job_id), [500000001, 500000002]);
  assert.deepEqual(
    jobs({ include_completed: "true" }).map((r) => r.job_id),
    [500000001, 500000002, 500000003],
  );
});

test("the parameter is absent-is-false, and only two spellings are accepted", () => {
  assert.equal(readIncludeCompleted({}), false);
  assert.equal(readIncludeCompleted({ include_completed: "true" }), true);
  assert.equal(readIncludeCompleted({ include_completed: "false" }), false);
});

test("a third spelling is the legacy family's coercion refusal", () => {
  // Never `Boolean(value)`, which makes "false" true, and never a lenient list
  // that would make this replica decide CCP accepts 1, yes and on.
  for (const bad of ["1", "yes", "on", "TRUE", ""]) {
    let refusal = null;
    try {
      readIncludeCompleted({ include_completed: bad });
    } catch (err) {
      refusal = err;
    }
    assert.equal(refusal && refusal.name, "RouteRefusal", `for ${JSON.stringify(bad)}`);
    assert.equal(refusal.refusal.status, 400);
    assert.deepEqual(Object.keys(refusal.refusal.body), ["error"]);
  }
});

// status

test("the six statuses that map come out as CCP's enum", () => {
  const contract = describeOperation("get", CHARACTER_JOBS_PATH);
  const published = contract.schema.items.properties
    ? contract.schema.items.properties.status.enum
    : null;

  const seen = new Set();
  for (const status of [1, 2, 3, 101, 102, 103]) {
    const table = { jobs: { 1: { ...JOBS.jobs[500000001], jobID: 1, status } } };
    const [row] = jobs({ include_completed: "true" }, table);
    seen.add(row.status);
    if (published) assert.ok(published.includes(row.status), `${row.status} is not in the enum`);
  }
  assert.equal(seen.size, 6, "six distinct statuses, so none of them collides");
});

test("a status upstream never persists is refused rather than mapped to a seventh value", () => {
  // UNSUBMITTED (0) is getJobStatus(null)'s answer and COMPLETED (100) is a
  // threshold rather than a state. Neither is written to a row.
  for (const status of [0, 100, 42]) {
    const table = { jobs: { 1: { ...JOBS.jobs[500000001], jobID: 1, status } } };
    assert.throws(() => jobs({ include_completed: "true" }, table), /is not one of the six/);
  }
});

// The optional fields

test("completed_character_id is omitted while it is the install's zero", () => {
  const running = jobs()[0];
  assert.ok(!Object.prototype.hasOwnProperty.call(running, "completed_character_id"));
  assert.ok(!Object.prototype.hasOwnProperty.call(running, "completed_date"));
  assert.ok(!Object.prototype.hasOwnProperty.call(running, "pause_date"));
});

test("a delivered job carries the two completion fields", () => {
  const delivered = jobs({ include_completed: "true" }).find((r) => r.job_id === 500000003);
  assert.equal(delivered.completed_character_id, OWNER);
  assert.equal(delivered.completed_date, "2026-09-16T20:30:45Z");
  assert.equal(delivered.status, "delivered");
});

test("a zero cost is sent, because a zero the game recorded is a fact", () => {
  // routes/skills.js takes the same position on unallocated_sp.
  const legacy = onTheWire()[1];
  assert.equal(legacy.cost, 0);
  assert.ok(Object.prototype.hasOwnProperty.call(legacy, "cost"));
});

test("cost and probability reach the wire as doubles, not as integers", () => {
  // `format: double` with an integral value, which JSON.stringify would write
  // as `0` and CCP writes as `0.0`.
  const bytes = serializeBody(jobs(), "app").toString("utf8");
  assert.match(bytes, /"cost":0\.0/);
  assert.match(bytes, /"probability":1\.0/);
});

test("a paused job reports when it was paused", () => {
  const table = {
    jobs: { 1: { ...JOBS.jobs[500000001], jobID: 1, status: 2, pauseDate: filetime(END_MS) } },
  };
  const [row] = jobs({}, table);
  assert.equal(row.status, "paused");
  assert.equal(row.pause_date, "2026-09-16T20:30:45Z");
});

// Refusals

test("a row missing a required id is refused, not sent short", () => {
  const table = { jobs: { 1: { ...JOBS.jobs[500000001], jobID: 1, facilityID: null } } };
  assert.throws(() => jobs({}, table), /no readable facility_id/);
});

test("a job mid-installation is not a job yet", () => {
  const table = {
    jobs: { 1: { ...JOBS.jobs[500000001], jobID: 1, installationPending: true } },
  };
  assert.deepEqual(jobs({}, table), []);
});

test("the handler refuses to run without a verified credential", () => {
  assert.throws(() => buildCharacterIndustryJobs({ query: {} }, deps()), /no verified credential/);
});

test("a missing store is a programming error naming what to inject", () => {
  assert.throws(
    () => buildCharacterIndustryJobs({ credential: { characterId: OWNER }, query: {} }, {}),
    /industry store/,
  );
});
