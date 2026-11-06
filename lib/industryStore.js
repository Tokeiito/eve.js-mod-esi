/**
 * eve.js-mod-esi: industry jobs, read-only, and the two clocks behind them
 *
 * `services/industry/industryRuntimeState.js` owns the `industryJobs` table and
 * offers `listJobsByOwner`, which does not write (unlike `getBlueprintState`
 * beside it and `itemStore`'s reads). This mod still does not use it: the module
 * requires `server/src/gameStore` at load and pulls in `characterState`,
 * `skillState`, `walletState`, `corpWalletState`, `structureState` and
 * `worldData` behind it, to read one table of plain records.
 * `lib/runtimeAccess.js` treats a speculative entry in `GAME_MODULES` as a
 * liability, and six transitive ones to avoid a fifteen-line projection is the
 * same trade the other way. The table is read through the read-only handle, as
 * `listCharacterSkills` reads `skills`.
 *
 * That means reproducing `normalizeIndustryJobRecord`, which does two things.
 *
 * Two clocks. `startDate`, `endDate` and `pauseDate` are stored as decimal
 * strings of Windows FILETIME ticks (100-nanosecond intervals since
 * 1601-01-01), which is what the EVE client speaks. ESI sends ISO-8601, so every
 * date here is a conversion; `FILETIME_EPOCH_OFFSET` is the 11,644,473,600
 * seconds between the epochs.
 *
 * Upstream's `normalizeIndustryFileTime` accepts either encoding. A stored value
 * at or below `LEGACY_UNIX_MS_MAX` (9,999,999,999,999) is Unix milliseconds and
 * is converted up; anything larger is already FILETIME. Older rows were written
 * in Unix ms, and a reader that skipped the branch would date them to 1601. The
 * threshold does not overlap: 9,999,999,999,999 ms is 2286-11-20, and the
 * smallest FILETIME this table can hold is far above it.
 *
 * `status` is six values, not eight. `services/industry/industryConstants.js`
 * `INDUSTRY_STATUS` declares eight and CCP's enum publishes six. The other two:
 *
 *   UNSUBMITTED (0)  `getJobStatus(null)`'s answer for a job that is not there.
 *                    No persisted row carries it.
 *   COMPLETED (100)  a threshold, not a state. Every assignment in that module
 *                    writes INSTALLED, PAUSED, READY, DELIVERED, CANCELLED or
 *                    REVERTED; `COMPLETED` appears only in
 *                    `>= INDUSTRY_STATUS.COMPLETED` comparisons.
 *
 * A row carrying either is one upstream does not produce, and this file refuses
 * it rather than inventing a seventh enum value.
 */

"use strict";

const runtime = require("./runtimeAccess");

/** The table `services/industry/industryRuntimeState.js` owns. */
const INDUSTRY_JOBS_TABLE = "industryJobs";

/**
 * The two constants `normalizeIndustryFileTime` is built on, transcribed from
 * `services/industry/industryRuntimeState.js`.
 *
 * `BigInt`, as upstream keeps them: a FILETIME is around 1.3e17, past
 * `Number.MAX_SAFE_INTEGER`, so doubles would lose the low digits.
 */
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MILLISECOND = 10000n;

/** Upstream's own threshold between the two encodings. See the header. */
const LEGACY_UNIX_MS_MAX = 9999999999999n;

/**
 * `INDUSTRY_STATUS` to CCP's enum, for the six that map.
 *
 * Keyed by upstream's number so a value not in this table is visibly absent
 * rather than falling through to a default.
 */
const STATUS = Object.freeze({
  1: "active", // INSTALLED
  2: "paused", // PAUSED
  3: "ready", // READY
  101: "delivered", // DELIVERED
  102: "cancelled", // CANCELLED
  103: "reverted", // REVERTED
});

/**
 * `INDUSTRY_STATUS.COMPLETED`: the boundary `include_completed` is about, not a
 * status.
 *
 * `listJobsByOwner`'s filter is `includeCompleted || status < COMPLETED`, which
 * keeps INSTALLED, PAUSED and READY and drops DELIVERED, CANCELLED and REVERTED.
 * That is what CCP's parameter describes, so the route reuses the number.
 */
const COMPLETED_THRESHOLD = 100;

/** A read that could not happen, as distinct from an owner with no jobs. */
class IndustryDataError extends Error {
  constructor(message) {
    super(message);
    this.name = "IndustryDataError";
  }
}

/**
 * A stored date, as epoch milliseconds, or `null`.
 *
 * Reproduces `normalizeIndustryFileTime` including its legacy branch. `null` for
 * an absent or unparseable value, which the route turns into an omitted
 * optional field or a refusal depending on whether CCP requires it.
 */
function epochMillisFromStored(value) {
  if (value === null || value === undefined || value === "") return null;

  let ticks;
  try {
    ticks = typeof value === "bigint" ? value : BigInt(String(value).trim());
  } catch (_) {
    return null;
  }
  if (ticks <= 0n) return null;

  // The legacy branch: a value this small is Unix milliseconds, not FILETIME.
  const filetime = ticks <= LEGACY_UNIX_MS_MAX
    ? ticks * FILETIME_TICKS_PER_MILLISECOND + FILETIME_EPOCH_OFFSET
    : ticks;

  const millis = (filetime - FILETIME_EPOCH_OFFSET) / FILETIME_TICKS_PER_MILLISECOND;
  const asNumber = Number(millis);
  return Number.isSafeInteger(asNumber) ? asNumber : null;
}

/**
 * CCP's `date-time`: `YYYY-MM-DDTHH:MM:SSZ`, no fraction.
 *
 * `contract/spec.js` `DATE_TIME` is the pattern every body is checked against,
 * and `toISOString()` carries milliseconds, which it rejects. The fraction is
 * cut rather than rounded: a job started at `…:07.999Z` reports `…:07Z`.
 */
function toEsiTimestamp(millis) {
  if (millis === null) return null;
  return `${new Date(millis).toISOString().slice(0, 19)}Z`;
}

/** `read(table, pointer)` through the repository, or a throw naming the table. */
function readTableFromRepository(repository, table, key) {
  const read = repository && repository.read;
  if (typeof read !== "function") {
    throw new IndustryDataError(
      "ESI mod: the game store's table repository exposes no read(). Check "
        + "GAME_MODULES.gameStoreTableRepository against the vendor tree.",
    );
  }

  const result = read.call(repository, table, key);
  if (!result || result.success !== true || !result.data || typeof result.data !== "object") {
    throw new IndustryDataError(
      `ESI mod: the game store has no readable "${table}.${key}" `
        + `(${(result && result.errorMsg) || "no answer"}).`,
    );
  }
  return result.data;
}

/**
 * The store. `readTable` is injected exactly as the other stores inject theirs,
 * and the default is resolved on first use rather than at construction.
 */
function createIndustryStore({ readTable = null } = {}) {
  const read = typeof readTable === "function"
    ? readTable
    : (table, key) => readTableFromRepository(runtime.getReadOnlyTableRepository(), table, key);

  /**
   * One owner's jobs, projected to the fields the endpoints use.
   *
   * Never memoised: a job's status changes on a timer and its `endDate` passes, so
   * a long-lived index would report finished jobs as running. The route's
   * 300-second `x-cache-age` bounds the cost.
   *
   * `installationPending` rows are dropped, as upstream's first filter in
   * `listJobsByOwner` does: a job mid-installation is not a job yet, and CCP has
   * no status for one.
   *
   * Ascending `jobID`, which is what `listJobsByOwner` sorts into and is stable.
   * An object's key order over a table the game rewrites is not, and an unstable
   * order moves the `Etag` between two identical requests.
   */
  function jobsByOwner(ownerId, { includeCompleted = false } = {}) {
    const owner = Number(ownerId);
    if (!Number.isSafeInteger(owner) || owner <= 0) return [];

    const payload = read(INDUSTRY_JOBS_TABLE, "/");
    const jobs = payload && typeof payload.jobs === "object" && payload.jobs !== null
      ? payload.jobs
      : {};

    const rows = [];
    for (const job of Object.values(jobs)) {
      if (job === null || typeof job !== "object") continue;
      if (job.installationPending === true) continue;
      if (Number(job.ownerID) !== owner) continue;

      const status = Number(job.status);
      if (!includeCompleted && status >= COMPLETED_THRESHOLD) continue;

      rows.push(job);
    }

    rows.sort((left, right) => Number(left.jobID) - Number(right.jobID));
    return rows;
  }

  return Object.freeze({
    COMPLETED_THRESHOLD,
    IndustryDataError,
    STATUS,
    epochMillisFromStored,
    jobsByOwner,
    toEsiTimestamp,
  });
}

module.exports = Object.freeze({
  COMPLETED_THRESHOLD,
  FILETIME_EPOCH_OFFSET,
  FILETIME_TICKS_PER_MILLISECOND,
  INDUSTRY_JOBS_TABLE,
  IndustryDataError,
  LEGACY_UNIX_MS_MAX,
  STATUS,
  createIndustryStore,
  epochMillisFromStored,
  readTableFromRepository,
  toEsiTimestamp,
});
