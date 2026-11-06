/**
 * `GET /characters/{character_id}/skills/`: every skill a pilot has trained.
 *
 * It has its own file because it is a different scope family (`esi-skills`), a
 * different bucket (`char-detail`, not `char-location`) and a different
 * question from `routes/characters.js`, and CCP files it under its own `Skills`
 * tag. `routes/roles.js` is the precedent.
 *
 * CCP's other `Skills` operation, `/skillqueue/`, is not implemented. CCP's
 * description of this route leans on it: skills here "can be out-of-date if the
 * character hasn't logged in since one or more skills completed training", and
 * a client applies the queue's past-dated entries on top. The same caveat
 * holds here for the same reason.
 *
 * Nothing about this route was observed. The 2026-08-25 captures that settled
 * `/online/`, `/location/`, `/ship/`, `/roles/` and the contacts family did not
 * include it, so `contract/wire.js` has no `CHARACTER_SKILLS` record (that file
 * is observations, and a constant written from reasoning would be
 * indistinguishable from one written from a `curl`). Unobserved choices live
 * here, argued, as in `routes/structures.js` and `routes/fleets.js`.
 *
 * Settled from the pinned spec and facts about this route's class:
 *
 *   - The producer is `app`. For a route that declares a scope and sends JSON
 *     it is the only legal producer: `lib/router.js` `assertScope` refuses to
 *     compile a scoped route on the gateway, `meta` is the `/meta/` surface, and
 *     `null` claims the route sends no JSON. That one declaration decides the
 *     content type, the absent trailing newline, the strong SHA-224 `Etag`,
 *     `Expires` measured from `Last-Modified`, the `LEGACY` error family and
 *     the application's conditional-request rules.
 *   - `Cache-Control: private`, because the route requires a credential
 *     (`contract/wire.js` `AUTHENTICATED_CACHE_CONTROL`, observed on all three
 *     `/characters/{id}/` application routes captured, and not a function of
 *     the producer). A `public` would let a shared cache hand one character's
 *     training to the next caller.
 *   - 60 seconds, from `x-cache-age` in CCP's document;
 *     `contract/spec.js` `assertRouteMatchesSpec` holds the constant to it.
 *
 * Field order is a choice: alphabetical at both levels, as every authenticated
 * application body observed so far (including `/roles/`). Order is bytes, and
 * a different order is a different `Etag`. The pinned document's declaration
 * order happens to agree but is not evidence: `/ship/` showed the wire
 * alphabetical and the spec not, and here `CharactersSkillsSkill` lists
 * properties alphabetically but its `required` array in another order
 * (`skill_id`, `trained_skill_level`, `active_skill_level`,
 * `skillpoints_in_skill`).
 *
 * The row order of `skills[]` is unobserved as well, and is ascending
 * `skill_id`, the order `skillState`'s own reads sort into. That is the game's
 * answer, not a hash order that would move the `Etag` between identical
 * requests.
 *
 * Data source: `lib/runtimeAccess.js` `listCharacterSkills` reads the `skills`
 * table through the read-only handle instead of calling `skillState`. Every
 * public `skillState` read funnels through `ensureCharacterSkills`, which seeds
 * a skill set for a character who has none, re-normalises and persists the
 * table, and writes the recomputed total onto the character record. A `GET`
 * that did that would hand pilots skills because somebody polled an API.
 *
 *   skill_id             typeID
 *   trained_skill_level  trainedSkillLevel
 *   active_skill_level   effectiveSkillLevel
 *   skillpoints_in_skill skillPoints
 *
 * `active_skill_level` is what CCP describes as the level that "can differ from
 * trained due to alpha status and/or active expert systems"; eve.js's
 * `effectiveSkillLevel` is that idea, and `normalizeSkillRecord` keeps the two
 * apart.
 *
 * Divergence: the expert-system overlay is not applied. eve.js projects active
 * expert systems onto the records at read time, inside the `skillState` call
 * this route refuses to make, so levels here are the persisted ones. A pilot
 * flying an active expert system reports their trained level where CCP reports
 * the boosted one. Reproducing it would need `expertSystemProjection` and
 * `expertSystemState` in `GAME_MODULES` for a feature a private server may
 * never enable, and `lib/runtimeAccess.js` treats a speculative path in that
 * table as a liability. The change would be one accessor.
 *
 * `total_sp` is summed from the rows, not read off the character record's
 * `skillPoints`. That copy is denormalised and refreshed only by
 * `syncCharacterSkillPoints`, which only `ensureCharacterSkills` calls, so it
 * can be stale, and a total that disagrees with the sum of its own rows is
 * visibly wrong. CCP defines the field as "the total Skill Points spent on
 * skills". `unallocated_sp` is `freeSkillPoints` on the character record,
 * through `peekCharacterRecord`; it is the operation's one optional field.
 *
 * Two kinds of empty. A character with no row in the `skills` table gets
 * `{"skills":[],"total_sp":0}`, a complete and honest body: eve.js seeds skills
 * lazily, so an unseeded character has none, and this route must not change
 * that. A table that cannot be read is not an answer: `skills` and `total_sp`
 * are required, so the handler throws and `lib/router.js` answers the observed
 * `500` with the reason in the game server's log. As for `/location/` in
 * `routes/characters.js`, a credential exists only because the minter read that
 * character's record, so an unreadable table is this server's inconsistency,
 * never a `404`.
 */

"use strict";

const { optional, projection } = require("../lib/serialize");
const { CHARACTER_ID_PARAM } = require("./characters");

// The route

/** Canonical: no version prefix, no trailing slash. */
const SKILLS_PATH = "/characters/:character_id/skills";

/** `x-cache-age` in the pinned spec. `assertRouteMatchesSpec` holds it to that. */
const SKILLS_CACHE_TTL_SECONDS = 60;

/** The scope CCP publishes for this operation. */
const SKILLS_SCOPE = "esi-skills.read_skills.v1";

/**
 * 600 tokens per 15 minutes: the bucket `/roles/` charges, not the more
 * generous `char-location` of `/characters/{id}/`.
 */
const RATE_LIMIT_GROUP = "char-detail";

/** See the header: the one legal producer for a scoped route that sends JSON. */
const PRODUCER = "app";

/** CCP's own operationId, which is also this route's `name` and its log line. */
const OPERATION_ID = "GetCharactersCharacterIdSkills";

// Reading the game

/**
 * The error this route raises when it cannot answer for a character its own
 * gate has already vouched for. As `unreadable` in `routes/characters.js` and
 * `routes/roles.js`: a logged `500`, never a `404`, with the reason going to the
 * game server's log rather than the client.
 */
function unreadable(characterId, detail) {
  return new Error(
    `ESI mod: ${OPERATION_ID} cannot answer for character ${characterId}: ${detail}. `
      + "A token for that character was minted by this server, so the record was readable then "
      + "and is not now. This is a server-side inconsistency, not a client error.",
  );
}

/** `deps.runtime`, or an empty object. The accessors are duck-typed below. */
function readRuntime(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  return d.runtime && typeof d.runtime === "object" ? d.runtime : {};
}

/**
 * Who is asking, as a number that was signed.
 *
 * `params.credential.characterId`, never `params.path.character_id`; see
 * `callerCharacterId` in `routes/characters.js`. The path segment is a string
 * the requester typed, the claim is a number this server signed, and the gate
 * has proved they agree.
 */
function callerCharacterId(params) {
  const credential = params && params.credential;
  const characterId = credential && credential.characterId;

  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new Error(
      "ESI mod: a skills route ran with no verified credential. Every route in this module "
        + "declares a scope, so lib/router.js authorise() should have refused the request before "
        + "the handler saw it.",
    );
  }

  return characterId;
}

/**
 * The persisted skill rows, or a throw.
 *
 * `null` from the accessor is "the table could not be read" and `[]` is "this
 * character has no row in a table that could be". Only the first is a refusal.
 *
 * An absent accessor throws rather than returning an empty list, as
 * `peekRecord` in `routes/characters.js` does: "the game has no skills for this
 * character" and "this build cannot read skills at all" are different
 * failures, and the second answered as the first would report every pilot as
 * having trained nothing.
 */
function readSkillRows(runtime, characterId) {
  if (typeof runtime.listCharacterSkills !== "function") {
    throw unreadable(characterId, "the runtime exposes no listCharacterSkills accessor");
  }

  const rows = runtime.listCharacterSkills(characterId);
  if (rows === null || rows === undefined) {
    throw unreadable(
      characterId,
      "the skills table could not be read, and both skills and total_sp are required",
    );
  }
  if (!Array.isArray(rows)) {
    throw unreadable(
      characterId,
      `listCharacterSkills answered ${typeof rows} rather than an array of skill rows`,
    );
  }

  return rows;
}

/**
 * One row's four numbers, or a throw naming the row.
 *
 * Every field of a skill entry is required by the spec, so there is nothing to
 * omit: a row that cannot supply one is a refusal, as `/ship/` does for its
 * three required fields. Dropping the row would silently subtract its points
 * from `total_sp` and hand a fitting tool a pilot who cannot fly the ship they
 * sit in.
 *
 * Such a row is corruption, not a state the game produces:
 * `normalizeSkillRecord` writes clamped integer levels and a `Math.round`ed
 * point total on every write path.
 */
function skillNumbers(characterId, row) {
  const numbers = {
    skillId: Number(row.typeID),
    trainedSkillLevel: Number(row.trainedSkillLevel),
    activeSkillLevel: Number(row.effectiveSkillLevel),
    skillpointsInSkill: Number(row.skillPoints),
  };

  for (const [field, value] of Object.entries(numbers)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw unreadable(
        characterId,
        `the skills table row for type ${String(row.typeID)} carries no readable ${field}, and `
          + "every field of a skill entry is required",
      );
    }
  }

  return numbers;
}

/**
 * Unallocated skill points, or `null` for a record that cannot supply them.
 *
 * `freeSkillPoints` is eve.js's name for CCP's `unallocated_sp`, and
 * `characterState` normalises it to an integer on every record it writes, so a
 * readable record always has one and `0` is a value, not an absence. `null`
 * means a record the game does not have or a non-number field, which
 * `optional()` turns into an omitted key.
 *
 * Through `peekCharacterRecord` with a `project` callback, like every other
 * character route: the callback runs against the live in-memory object, copies
 * the one field it wants and borrows nothing.
 *
 * A runtime with no character accessor costs this route the optional field and
 * not its answer (the concession `/online/` makes for `last_logout`), so this
 * one is guarded rather than throwing.
 */
function readUnallocatedSp(runtime, characterId) {
  if (typeof runtime.peekCharacterRecord !== "function") return null;

  const record = runtime.peekCharacterRecord(characterId, {
    project: (found) => ({ freeSkillPoints: found.freeSkillPoints }),
  });
  if (record === null || typeof record !== "object") return null;

  const free = Number(record.freeSkillPoints);
  return Number.isSafeInteger(free) && free >= 0 ? free : null;
}

// The body

/**
 * One entry of `skills[]`.
 *
 * Alphabetical, and all four fields are required, so no `optional()`. A row
 * that cannot fill one was refused upstream by `skillNumbers`.
 *
 * Named for the schema it projects, `CharactersSkillsSkill`, as
 * `routes/universe.js` names `GetUniverseSystemsSystemIdPlanet`.
 */
const projectCharacterSkill = projection(`${OPERATION_ID}Skill`, {
  active_skill_level: (skill) => skill.activeSkillLevel,
  skill_id: (skill) => skill.skillId,
  skillpoints_in_skill: (skill) => skill.skillpointsInSkill,
  trained_skill_level: (skill) => skill.trainedSkillLevel,
});

/**
 * The envelope.
 *
 * Alphabetical, which is also the pinned document's declaration order (not the
 * reason; see the header).
 *
 * `unallocated_sp` is the only optional field, sent whenever the record could be
 * read, `0` included. `0` is a fact eve.js records, and omitting it would hide
 * the field on most servers, where nobody has been granted free SP. What CCP
 * does with a zero here is unobserved. `OMIT` is reserved for a record this
 * replica cannot read.
 */
const projectCharacterSkills = projection(OPERATION_ID, {
  skills: (body) => body.skills.map((skill) => projectCharacterSkill(skill)),
  total_sp: (body) => body.totalSp,
  unallocated_sp: (body) => optional(body.unallocatedSp),
});

/**
 * `GET /characters/{character_id}/skills/`.
 *
 * @param {object} params  the router's, with `credential` already verified
 * @param {object} [deps]  `{ runtime }`, from the factory's closure
 */
function buildCharacterSkills(params, deps) {
  const characterId = callerCharacterId(params);
  const runtime = readRuntime(deps);

  const rows = readSkillRows(runtime, characterId);
  const skills = rows.map((row) => skillNumbers(characterId, row));

  // Ascending skill_id: the order `skillState`'s own reads sort into, and stable,
  // which an object's key order over a rewritten table is not. An unstable order
  // would move the `Etag` between identical requests.
  skills.sort((left, right) => left.skillId - right.skillId);

  // Summed, never read off the character record's stale denormalised copy. See
  // the header. `Number.isSafeInteger` held every addend, so the sum is exact up
  // to a total no pilot approaches.
  const totalSp = skills.reduce((sum, skill) => sum + skill.skillpointsInSkill, 0);

  return projectCharacterSkills({
    skills,
    totalSp,
    unallocatedSp: readUnallocatedSp(runtime, characterId),
  });
}

// The route descriptor

/**
 * Callable as `factory({})`: the deps are read inside the handler, never at
 * construction, so `test/serialize.test.js` can walk `routes/` from disk and ask
 * which operation this file implements without booting anything.
 *
 * No `subject`: keyed by `:character_id` only, so `compileRoute` does not demand
 * one and the default `SUBJECT.CALLER` (the cross-character comparison) is the
 * right check.
 *
 * No `localizedBody`: four numbers per row and two totals, no name or
 * description, so it sends the three-line `Vary`.
 *
 * No `errorFamily`: `lib/router.js` derives it from `producer`, which for `app`
 * is `LEGACY`. It is not `VALIDATED`, the gateway's shape, and `assertScope`
 * refuses to compile a scoped route on the gateway at all.
 */
function createCharacterSkillsRoute(deps) {
  return {
    method: "GET",
    path: SKILLS_PATH,
    name: OPERATION_ID,
    handler: (params) => buildCharacterSkills(params, deps),
    producer: PRODUCER,
    scope: SKILLS_SCOPE,
    cacheTtl: SKILLS_CACHE_TTL_SECONDS,
    rateLimitGroup: RATE_LIMIT_GROUP,
  };
}

module.exports = Object.freeze({
  CHARACTER_ID_PARAM,
  OPERATION_ID,
  PRODUCER,
  RATE_LIMIT_GROUP,
  SKILLS_CACHE_TTL_SECONDS,
  SKILLS_PATH,
  SKILLS_SCOPE,
  buildCharacterSkills,
  createCharacterSkillsRoute,
  projectCharacterSkill,
  projectCharacterSkills,
  readSkillRows,
  readUnallocatedSp,
  skillNumbers,
  unreadable,
});
