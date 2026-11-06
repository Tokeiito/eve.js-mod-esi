/**
 * `GET /characters/{character_id}/industry/jobs/`: what a pilot is building.
 * Also the corporation twin and `GET /industry/systems/`.
 *
 * The character route does not paginate. CCP's document declares no `page`
 * parameter, so it declares no `pageSize` here and returns its whole
 * collection, like `/markets/prices/`. The 300-second `x-cache-age`, the
 * shortest on this family by a factor of twelve, bounds it, since a job's
 * status changes on a timer.
 *
 * `include_completed`: CCP's parameter is "Whether to retrieve completed
 * character industry jobs." eve.js's `listJobsByOwner` filters on
 * `status < INDUSTRY_STATUS.COMPLETED`, which keeps INSTALLED, PAUSED and
 * READY and drops DELIVERED, CANCELLED and REVERTED. The parameter maps onto
 * that boundary rather than a status list this file would keep in step.
 *
 * The document's other sentence, "Only includes jobs from the past 90 days",
 * is not implemented. eve.js's `industryJobs` table has no retention policy
 * (`deliverIndustryJob` marks a job DELIVERED and leaves the row), so
 * `include_completed=true` returns every finished job the server has run,
 * where CCP returns three months. Hiding rows the game still has would be the
 * more surprising behaviour.
 *
 * Booleans are `true` and `false` only, as in `routes/ui.js` `BOOLEAN_VALUES`:
 * `Boolean("false")` is `true`, and a lenient list would decide CCP accepts
 * `1`, `yes` and `on`. Unlike the waypoint write's two, this parameter is
 * optional, so absent is `false`: the document declares no `required` and no
 * `default`.
 *
 * Dates: three fields are timestamps, stored by eve.js as Windows FILETIME
 * ticks in a decimal string, except older rows, which hold Unix milliseconds
 * (upstream's `normalizeIndustryFileTime` accepts both). `lib/industryStore.js`
 * reproduces both branches; a reader taking only FILETIME would date legacy
 * rows to 1601 in a body that validates.
 *
 * Optional fields: `cost`, `licensed_runs`, `probability`, `product_type_id`
 * and `successful_runs` are columns eve.js writes on every job, so they are
 * sent whenever readable. A zero the game recorded is a fact, not an absence
 * (`routes/skills.js` takes the same position on `unallocated_sp`).
 * `completed_character_id` and `completed_date` are genuinely conditional:
 * `buildIndustryInstallJobRecord` writes `completedCharacterID: 0` on
 * installation, meaning nobody has completed it, so the field is omitted until
 * it is a real id. `pause_date` is written as `null` and omitted the same way.
 *
 * `GET /industry/systems/` is public (CCP's `Industry` tag). It publishes a
 * cost index per solar system per activity, and on this server every system
 * reports the same number for every activity. That is upstream's:
 * `services/industry/industrySystemCostIndex.js` is titled "Option A static
 * approximation of EVE's industry system cost index" and says the server does
 * not track the telemetry yet (`map.GetIndustryJobsOverLast24Hours` returns no
 * history), so a single configurable index stands in for the cluster.
 * `resolveSystemCostIndex(solarSystemID, activityID)` ignores both arguments
 * and returns `clampCostIndex(config.industrySystemCostIndex)`. Synthesising
 * per-system variation would disagree with what this server's job quotes
 * charge, and a tool would compute one build cost and be billed another.
 * `lib/runtimeAccess.js` `getIndustryCostIndex` keeps the two in step.
 *
 * Six activities, not ten. CCP's enum publishes `copying`, `duplicating`,
 * `invention`, `manufacturing`, `none`, `reaction`,
 * `researching_material_efficiency`, `researching_technology`,
 * `researching_time_efficiency` and `reverse_engineering`. eve.js implements
 * six (`services/industry/industryConstants.js` `INDUSTRY_ACTIVITY`), and a
 * system reports an index for those; this server has nothing to charge for the
 * other four.
 *
 * Cost, measured: 8,490 systems times six activities is 2.79 MB of JSON.
 * Building it takes 22 ms, once (see the memo below). Serialising takes 57 ms
 * and happens per request, twice: `lib/cache.js` turns the body into bytes to
 * digest it for the `Etag`, and `server.js` writes it. That is a real hitch on
 * a game tick, 2.5 times `/markets/prices/`, the largest body already served,
 * which shipped on the same reasoning (the collection is what CCP publishes
 * and the operation declares no `page`). Memoising the body's bytes beside its
 * rows is an open question; `server.js` already writes a Buffer body verbatim.
 */

"use strict";

const { RouteRefusal } = require("../lib/router");
const runtime = require("../lib/runtimeAccess");
const { coercionFailed, familyFor } = require("../lib/errors");
const { double, optional, projection } = require("../lib/serialize");
const { CHARACTER_ID_PARAM } = require("./characters");
const { corporationRoleSubject } = require("./roles");
const {
  CORPORATION_ID_PARAM,
  callerCharacterId,
  subjectCorporationId,
  unreadable,
} = require("./assets");

// The route

/** Canonical: no version prefix, no trailing slash. */
const CHARACTER_JOBS_PATH = "/characters/:character_id/industry/jobs";

/** `x-cache-age` in the pinned spec. `assertRouteMatchesSpec` holds it to that. */
const CHARACTER_JOBS_CACHE_TTL_SECONDS = 300;

/** The scope CCP publishes for this operation. */
const CHARACTER_JOBS_SCOPE = "esi-industry.read_character_jobs.v1";

/** 600 tokens per 15 minutes, the bucket `/blueprints/` shares. */
const CHARACTER_JOBS_RATE_LIMIT_GROUP = "char-industry";

/** One legal producer for a scoped route that sends JSON. */
const PRODUCER = "app";

/** CCP's own operationId, which is also this route's `name` and its log line. */
const CHARACTER_JOBS_OPERATION_ID = "GetCharactersCharacterIdIndustryJobs";

/** The family that producer's refusals take. Derived, never declared twice. */
const REFUSAL_FAMILY = familyFor(PRODUCER);

// The corporation twin, which paginates where the character one does not

/**
 * The asymmetry in this pair: `/corporations/{id}/industry/jobs/` declares a
 * `page` parameter and `/characters/{id}/industry/jobs/` does not. That is
 * CCP's document, not a judgement about size, so a corporation's jobs are
 * sliced and a character's are not.
 *
 * `test/industryContract.test.js` asserts both halves against the document.
 */
const CORPORATION_JOBS_PATH = "/corporations/:corporation_id/industry/jobs";
const CORPORATION_JOBS_CACHE_TTL_SECONDS = 300;
const CORPORATION_JOBS_SCOPE = "esi-industry.read_corporation_jobs.v1";
const CORPORATION_JOBS_RATE_LIMIT_GROUP = "corp-industry";
const CORPORATION_JOBS_OPERATION_ID = "GetCorporationsCorporationIdIndustryJobs";
const CORPORATION_JOBS_PAGE_SIZE = 1000;

/**
 * CCP's `x-required-roles`: `Factory_Manager`, not `Director`.
 *
 * The corporation asset and blueprint operations declare `Director` and this
 * one does not, CCP's split between who may see a corporation's property and
 * its production. Accepting `Director` here would widen a gate the document
 * narrows, as `routes/structures.js` declines to do for `Station_Manager`.
 */
const CORPORATION_JOBS_ROLES = Object.freeze(["Factory_Manager"]);

/** The optional query parameter, spelled as the document spells it. */
const INCLUDE_COMPLETED_PARAM = "include_completed";

/** The two spellings this replica accepts. See the header. */
const BOOLEAN_VALUES = Object.freeze({ true: true, false: false });

// GET /industry/systems/

const INDUSTRY_SYSTEMS_PATH = "/industry/systems";
const INDUSTRY_SYSTEMS_CACHE_TTL_SECONDS = 3600;
const INDUSTRY_SYSTEMS_RATE_LIMIT_GROUP = "industry";
const INDUSTRY_SYSTEMS_OPERATION_ID = "GetIndustrySystems";

/**
 * eve.js's `INDUSTRY_ACTIVITY` ids, paired with CCP's `activity` enum.
 *
 * Six rows. `test/industryContract.test.js` checks every name against the
 * published enum.
 *
 * Emitted alphabetically per system: the schema's `activity` enum is
 * alphabetical, as is every application body on this surface, and declaration
 * order is output order is bytes.
 */
const COST_INDEX_ACTIVITIES = Object.freeze([
  Object.freeze({ activityId: 5, activity: "copying" }),
  Object.freeze({ activityId: 8, activity: "invention" }),
  Object.freeze({ activityId: 1, activity: "manufacturing" }),
  Object.freeze({ activityId: 9, activity: "reaction" }),
  Object.freeze({ activityId: 4, activity: "researching_material_efficiency" }),
  Object.freeze({ activityId: 3, activity: "researching_time_efficiency" }),
]);

// Reading the request

/**
 * `include_completed`, or a thrown `RouteRefusal`.
 *
 * Absent is `false`. A third spelling gets the legacy family's coercion
 * refusal, the same bytes `routes/ui.js` sends for the same mistake: the
 * wording is `lib/errors.js` `coercionFailed`'s and is observed, unlike the
 * body refusals `routes/names.js` had to invent.
 */
function readIncludeCompleted(query) {
  const raw = query && Object.prototype.hasOwnProperty.call(query, INCLUDE_COMPLETED_PARAM)
    ? query[INCLUDE_COMPLETED_PARAM]
    : undefined;

  if (raw === undefined) return false;

  const value = BOOLEAN_VALUES[String(raw)];
  if (value === undefined) {
    throw new RouteRefusal(coercionFailed(REFUSAL_FAMILY, {
      parameter: INCLUDE_COMPLETED_PARAM,
      value: String(raw),
      where: "query",
      format: "boolean",
    }));
  }
  return value;
}

/** `deps.industry`, the store, or a throw naming what is missing. */
function readStore(deps) {
  const store = deps && typeof deps === "object" ? deps.industry : null;
  if (store === null || typeof store !== "object" || typeof store.jobsByOwner !== "function") {
    throw new Error(
      `ESI mod: ${CHARACTER_JOBS_OPERATION_ID} ran with no industry store. loader.js builds one `
        + "with lib/industryStore.js createIndustryStore() and hands it to the factory as "
        + "`industry`.",
    );
  }
  return store;
}

// Shaping

/** A required integer off a job row, or a refusal naming the field. */
function requiredInteger(ownerId, job, field, value) {
  const numeric = value === null || value === undefined || value === "" ? NaN : Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw unreadable(
      CHARACTER_JOBS_OPERATION_ID,
      ownerId,
      `the industryJobs row for job ${String(job.jobID)} carries no readable ${field}, and it is `
        + "required",
    );
  }
  return numeric;
}

/** An optional integer, or `null` for one the row does not carry. */
function optionalInteger(value) {
  const numeric = value === null || value === undefined || value === "" ? NaN : Number(value);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

/** An optional double, or `null`. `probability` and `cost` are the two. */
function optionalDouble(value) {
  const numeric = value === null || value === undefined || value === "" ? NaN : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * One job, in the schema's declaration order, which is alphabetical.
 *
 * Every optional field is a declared seat rather than a key left out of the
 * list (D37): a field this replica does not send shows as an `optional()` that
 * answered `null`, not as an absence a reader must notice.
 *
 * The two documents agree on every seat but one, and disagree on its name: the
 * character body says `station_id` where the corporation body says
 * `location_id`. They sort differently, so each projection passes its own key
 * to its own seat. The character spelling on a corporation body is a required
 * field missing and an undeclared one sent.
 */
const industryJobSeats = ({ beforeOutput = {}, afterStart = {} }) => ({
  activity_id: (job) => job.activityId,
  blueprint_id: (job) => job.blueprintId,
  blueprint_location_id: (job) => job.blueprintLocationId,
  blueprint_type_id: (job) => job.blueprintTypeId,
  completed_character_id: (job) => optional(job.completedCharacterId),
  completed_date: (job) => optional(job.completedDate),
  cost: (job) => (job.cost === null ? optional(null) : double(job.cost)),
  duration: (job) => job.duration,
  end_date: (job) => job.endDate,
  facility_id: (job) => job.facilityId,
  installer_id: (job) => job.installerId,
  job_id: (job) => job.jobId,
  licensed_runs: (job) => optional(job.licensedRuns),
  ...beforeOutput,
  output_location_id: (job) => job.outputLocationId,
  pause_date: (job) => optional(job.pauseDate),
  probability: (job) => (job.probability === null ? optional(null) : double(job.probability)),
  product_type_id: (job) => optional(job.productTypeId),
  runs: (job) => job.runs,
  start_date: (job) => job.startDate,
  ...afterStart,
  status: (job) => job.status,
  successful_runs: (job) => optional(job.successfulRuns),
});

const projectCharacterJob = projection(
  CHARACTER_JOBS_OPERATION_ID,
  industryJobSeats({ afterStart: { station_id: (job) => job.locationId } }),
);

const projectCorporationJob = projection(
  CORPORATION_JOBS_OPERATION_ID,
  industryJobSeats({ beforeOutput: { location_id: (job) => job.locationId } }),
);

/**
 * One owner's jobs. Shared with the corporation twin, which differs in the
 * gate, in which scope reaches it, and in what the document calls the job's
 * location: `project` and `locationField` carry that last difference.
 */
function buildIndustryJobs({ store, ownerId, includeCompleted, project, locationField }) {
  return store.jobsByOwner(ownerId, { includeCompleted }).map((job) => {
    const status = store.STATUS[Number(job.status)];
    if (status === undefined) {
      throw unreadable(
        CHARACTER_JOBS_OPERATION_ID,
        ownerId,
        `job ${String(job.jobID)} is in status ${String(job.status)}, which is not one of the six `
          + "INDUSTRY_STATUS values CCP's enum publishes: see lib/industryStore.js STATUS for why "
          + "UNSUBMITTED and COMPLETED are not among them",
      );
    }

    const startDate = store.toEsiTimestamp(store.epochMillisFromStored(job.startDate));
    const endDate = store.toEsiTimestamp(store.epochMillisFromStored(job.endDate));
    if (startDate === null || endDate === null) {
      throw unreadable(
        CHARACTER_JOBS_OPERATION_ID,
        ownerId,
        `job ${String(job.jobID)} carries no readable start_date or end_date, and both are `
          + "required",
      );
    }

    const required = (field, value) => requiredInteger(ownerId, job, field, value);

    return project({
      activityId: required("activity_id", job.activityID),
      blueprintId: required("blueprint_id", job.blueprintID),
      blueprintLocationId: required("blueprint_location_id", job.blueprintLocationID),
      blueprintTypeId: required("blueprint_type_id", job.blueprintTypeID),
      // `0` is "nobody has completed this", which the install writes: omitted until
      // it is a real id. See the header.
      completedCharacterId: optionalInteger(job.completedCharacterID) || null,
      completedDate: store.toEsiTimestamp(store.epochMillisFromStored(job.completedDate)),
      cost: optionalDouble(job.cost),
      duration: required("duration", job.timeInSeconds),
      endDate,
      facilityId: required("facility_id", job.facilityID),
      installerId: required("installer_id", job.installerID),
      jobId: required("job_id", job.jobID),
      licensedRuns: optionalInteger(job.licensedRuns),
      locationId: required(locationField, job.stationID),
      outputLocationId: required("output_location_id", job.outputLocationID),
      pauseDate: store.toEsiTimestamp(store.epochMillisFromStored(job.pauseDate)),
      probability: optionalDouble(job.probability),
      productTypeId: optionalInteger(job.productTypeID),
      runs: required("runs", job.runs),
      startDate,
      status,
      successfulRuns: optionalInteger(job.successfulRuns),
    });
  });
}

/** `GET /characters/{character_id}/industry/jobs/`. */
function buildCharacterIndustryJobs(params, deps) {
  return buildIndustryJobs({
    store: readStore(deps),
    ownerId: callerCharacterId(params),
    includeCompleted: readIncludeCompleted(params && params.query),
    project: projectCharacterJob,
    locationField: "station_id",
  });
}

/**
 * `GET /corporations/{corporation_id}/industry/jobs/`.
 *
 * The owner is the corporation: eve.js stamps `ownerID` with whoever a job was
 * installed for, so a job a member installs on the corporation's behalf carries
 * the corporation's id and one installed for themselves carries theirs.
 * `installer_id` stays the character either way, which is CCP's field for that
 * distinction.
 */
function buildCorporationIndustryJobs(params, deps) {
  return buildIndustryJobs({
    store: readStore(deps),
    ownerId: subjectCorporationId(params, CORPORATION_JOBS_OPERATION_ID),
    includeCompleted: readIncludeCompleted(params && params.query),
    project: projectCorporationJob,
    locationField: "location_id",
  });
}

// GET /industry/systems/: the body

/** One `{activity, cost_index}`. Two fields, both required. */
const projectCostIndex = projection(`${INDUSTRY_SYSTEMS_OPERATION_ID}CostIndex`, {
  activity: (row) => row.activity,
  cost_index: (row) => double(row.costIndex),
});

/** One system's row: its id and its indices, alphabetical by activity. */
const projectIndustrySystem = projection(INDUSTRY_SYSTEMS_OPERATION_ID, {
  cost_indices: (row) => row.costIndices.map((entry) => projectCostIndex(entry)),
  solar_system_id: (row) => row.solarSystemId,
});

/**
 * The memo. Both inputs are static while the process lives: the `solarSystems`
 * table is SDE-derived and regenerated only by an operator, and
 * `config.industrySystemCostIndex` is read when the game requires its config
 * module at boot. Changing either means a restart, which discards the memo.
 *
 * It matters here because this route does not paginate, so `lib/router.js`
 * `dispatchPaginated`'s per-window snapshot does not apply and the handler runs
 * on every request. Rebuilding 8,490 systems' rows per request is the blocking
 * work design constraint 2 forbids.
 */
let systemsBody = null;

/** `GET /industry/systems/`. */
function buildIndustrySystems(params, deps) {
  if (systemsBody !== null) return systemsBody;

  const store = deps && typeof deps === "object" ? deps.store : null;
  if (store === null || typeof store !== "object" || typeof store.systemIds !== "function") {
    throw new Error(
      `ESI mod: ${INDUSTRY_SYSTEMS_OPERATION_ID} ran with no universe store. loader.js passes the `
        + "one lib/universeStore.js createUniverseStore() built as `store`.",
    );
  }

  const readIndex = deps.costIndex === undefined ? runtime.getIndustryCostIndex : deps.costIndex;
  const costIndex = typeof readIndex === "function" ? readIndex() : readIndex;

  if (!Number.isFinite(costIndex)) {
    throw new Error(
      `ESI mod: ${INDUSTRY_SYSTEMS_OPERATION_ID} cannot read the game's `
        + "industrySystemCostIndex. Every cost index this route publishes is that one number, so "
        + "there is no honest substitute -- a body of zeroes would tell an industry tool that "
        + "every job on this server is free.",
    );
  }

  // One shared array of six, not one per system: the rows are identical by
  // construction, and 8,490 copies of six frozen objects is 50,940 allocations to
  // say the same thing. The projection reads them and keeps no reference.
  const costIndices = COST_INDEX_ACTIVITIES.map((row) => ({ activity: row.activity, costIndex }));

  // Sorted here and not only in the store. `lib/universeStore.js` `systemIds`
  // already answers ascending, but this body's order is bytes and the `Etag` is
  // computed from them, so the guarantee is this route's, not a collaborator's
  // that could be swapped. Once per process, over 8,490 integers.
  const ids = [...store.systemIds()].sort((left, right) => left - right);

  systemsBody = ids.map((solarSystemId) => projectIndustrySystem({ solarSystemId, costIndices }));

  return systemsBody;
}

/** For tests, and for a redeploy that changed the store under a live process. */
function clearIndustrySystemsCache() {
  systemsBody = null;
}

// The route descriptor

/**
 * No `pageSize`: the document declares no `page` parameter. No `subject`:
 * keyed by `:character_id` only. No `localizedBody`: ids, numbers, timestamps
 * and one enum string, with no name in the body.
 */
function createCharacterIndustryJobsRoute(deps) {
  return {
    method: "GET",
    path: CHARACTER_JOBS_PATH,
    name: CHARACTER_JOBS_OPERATION_ID,
    handler: (params) => buildCharacterIndustryJobs(params, deps),
    producer: PRODUCER,
    scope: CHARACTER_JOBS_SCOPE,
    cacheTtl: CHARACTER_JOBS_CACHE_TTL_SECONDS,
    rateLimitGroup: CHARACTER_JOBS_RATE_LIMIT_GROUP,
  };
}

/** The corporation twin declares a `pageSize` because CCP declares a `page`. */
function createCorporationIndustryJobsRoute(deps) {
  return {
    method: "GET",
    path: CORPORATION_JOBS_PATH,
    name: CORPORATION_JOBS_OPERATION_ID,
    handler: (params) => buildCorporationIndustryJobs(params, deps),
    producer: PRODUCER,
    scope: CORPORATION_JOBS_SCOPE,
    cacheTtl: CORPORATION_JOBS_CACHE_TTL_SECONDS,
    rateLimitGroup: CORPORATION_JOBS_RATE_LIMIT_GROUP,
    pageSize: CORPORATION_JOBS_PAGE_SIZE,
    subject: corporationRoleSubject({
      operationId: CORPORATION_JOBS_OPERATION_ID,
      roles: CORPORATION_JOBS_ROLES,
      param: CORPORATION_ID_PARAM,
      deps,
    }),
  };
}

/**
 * `GET /industry/systems/`: public, unpaginated, on the `industry` bucket.
 *
 * No `scope`, so no `subject`. No `pageSize`, because the document declares no
 * `page`. No `localizedBody`: an id, six enum strings and six numbers.
 */
function createIndustrySystemsRoute(deps) {
  return {
    method: "GET",
    path: INDUSTRY_SYSTEMS_PATH,
    name: INDUSTRY_SYSTEMS_OPERATION_ID,
    handler: (params) => buildIndustrySystems(params, deps),
    producer: PRODUCER,
    cacheTtl: INDUSTRY_SYSTEMS_CACHE_TTL_SECONDS,
    rateLimitGroup: INDUSTRY_SYSTEMS_RATE_LIMIT_GROUP,
  };
}

module.exports = Object.freeze({
  BOOLEAN_VALUES,
  COST_INDEX_ACTIVITIES,
  INDUSTRY_SYSTEMS_CACHE_TTL_SECONDS,
  INDUSTRY_SYSTEMS_OPERATION_ID,
  INDUSTRY_SYSTEMS_PATH,
  INDUSTRY_SYSTEMS_RATE_LIMIT_GROUP,
  buildIndustrySystems,
  clearIndustrySystemsCache,
  createIndustrySystemsRoute,
  projectCostIndex,
  projectIndustrySystem,
  CORPORATION_ID_PARAM,
  CORPORATION_JOBS_CACHE_TTL_SECONDS,
  CORPORATION_JOBS_OPERATION_ID,
  CORPORATION_JOBS_PAGE_SIZE,
  CORPORATION_JOBS_PATH,
  CORPORATION_JOBS_RATE_LIMIT_GROUP,
  CORPORATION_JOBS_ROLES,
  CORPORATION_JOBS_SCOPE,
  buildCorporationIndustryJobs,
  createCorporationIndustryJobsRoute,
  CHARACTER_ID_PARAM,
  CHARACTER_JOBS_CACHE_TTL_SECONDS,
  CHARACTER_JOBS_OPERATION_ID,
  CHARACTER_JOBS_PATH,
  CHARACTER_JOBS_RATE_LIMIT_GROUP,
  CHARACTER_JOBS_SCOPE,
  INCLUDE_COMPLETED_PARAM,
  PRODUCER,
  REFUSAL_FAMILY,
  buildCharacterIndustryJobs,
  buildIndustryJobs,
  createCharacterIndustryJobsRoute,
  projectCharacterJob,
  projectCorporationJob,
  readIncludeCompleted,
  readStore,
});
