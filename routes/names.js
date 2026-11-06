/**
 * `POST /universe/names/` and `POST /universe/ids/`: the two resolvers every
 * tool in the ecosystem leans on (D9, D45).
 *
 * One file, because they are one index read two ways: `lib/nameIndex.js` has
 * the ten sources and the argument for them.
 *
 * These are the only routes that read a request body. `POST
 * /ui/autopilot/waypoint/` takes its input in the query string. `server.js`
 * drains and bounds the body on every method (its cap comment names `POST
 * /latest/universe/names/` as the largest legitimate one), and `lib/router.js`
 * carries `body` through to handlers. `lib/errors.js` `invalidBody` holds the
 * refusal bytes, and notes that the wording is this replica's and not a capture.
 *
 * The constraints are CCP's. The document declares:
 *
 *   /universe/names   array of int64    minItems 1  maxItems 1000  unique
 *   /universe/ids     array of string   minItems 1  maxItems  500  unique
 *                                       minLength 1  maxLength 100
 *
 * `contract/spec.js` reads them out of the pinned document in the contract test
 * rather than this file asserting its own copy, as for `cacheTtl` and
 * `rateLimitGroup`.
 *
 * Neither operation declares an `x-cache-age` or an `x-rate-limit`:
 *
 *   cacheTtl        `null`, so `lib/cache.js` sends the validators and no
 *                   freshness claim: an `Etag` and a `Last-Modified`, no
 *                   `Cache-Control` and no `Expires`. These are the first
 *                   public routes to take that path.
 *   rateLimitGroup  `null`, which puts both routes on the error budget rather
 *                   than the token bucket, as `/markets/prices/` is
 *                   (`routes/markets.js`).
 *
 * The producer is the application, and it is not derived from the path:
 * `contract/wire.js` `SUCCESS_KIND` records `POST /universe/names` and
 * `POST /universe/ids` as `APP_SUCCESS`, from the 2026-08-22 survey. Its header
 * records that `GET /characters/{id}/` is the gateway while `POST
 * /characters/affiliation/` is the application, so path shape is no guide. That
 * one declaration gives `charset=UTF-8`, no trailing newline, a strong `Etag`
 * and the `LEGACY` error family.
 *
 * Field order is the schema's, alphabetical at both levels: `category, id,
 * name` for a name row and `id, name` for an id row, and the ten groups of the
 * `/universe/ids/` body from `agents` to `systems`. The document's order and the
 * wire's coincide here, though they have differed elsewhere. Declaration order
 * is output order is bytes.
 *
 * An id or a name nobody knows is absent from the answer, and the response is
 * still a `200`. For ids, unknown ones are simply absent and eve-nexum falls
 * back to raw ids. For names, `/universe/ids/`'s response object declares no
 * required property, so a request whose every name missed is `{}`, a complete
 * body.
 *
 * An ambiguous key is absent too, for a different cause (D9). Two categories
 * claiming one id means this install's id space is broken, and answering with
 * whichever source was indexed first would put a wrong `category` on a real
 * name that a client cannot tell from a right one. `lib/nameIndex.js` reports
 * the collision to the log.
 *
 * A source that cannot be read is not an id nobody has. `lib/nameIndex.js`
 * lets that throw and this file does not catch it, so it reaches the router as
 * a logged `500`. The reasoning is `lib/universeStore.js`'s under D42: an index
 * missing its `itemTypes` table would answer "no such type" for all 52,590 of
 * them, and a client acts on that answer.
 */

"use strict";

const { RouteRefusal } = require("../lib/router");
const { familyFor, invalidBody } = require("../lib/errors");
const { optional, projection } = require("../lib/serialize");

// The two routes

const NAMES_PATH = "/universe/names";
const IDS_PATH = "/universe/ids";

/** CCP's `operationId`s, which are also these routes' `name`s and log lines. */
const NAMES_OPERATION_ID = "PostUniverseNames";
const IDS_OPERATION_ID = "PostUniverseIds";

const PRODUCER = "app";

const REFUSAL_FAMILY = familyFor(PRODUCER);

const CACHE_TTL_SECONDS = null;

const RATE_LIMIT_GROUP = null;

// The bounds, from the document

/**
 * `POST /universe/names/`'s body: `maxItems: 1000`, `minItems: 1`,
 * `uniqueItems: true`, over `int64`.
 *
 * Transcribed from the pinned spec and compared back against it by
 * `test/namesContract.test.js`, so a re-pin that moved a bound fails the suite.
 */
const NAMES_MAX_IDS = 1000;

/** `POST /universe/ids/`'s: 500 names, each 1 to 100 characters. */
const IDS_MAX_NAMES = 500;
const IDS_MAX_NAME_LENGTH = 100;

// Reading a body

/**
 * The array a body has to be, or a thrown `RouteRefusal`.
 *
 * `server.js` `parseJsonBody` answers `null` for anything that is not JSON and
 * keeps the bytes on `rawBody`, so a malformed body is the route's refusal to
 * make. `null` therefore arrives here for no body, a body that is not JSON, and
 * the literal `null`; all three are the same refusal.
 */
function readArrayBody(body, { operation, maxItems, what }) {
  if (!Array.isArray(body)) {
    throw new RouteRefusal(
      invalidBody(REFUSAL_FAMILY, `${operation} requires a JSON array of ${what}.`),
    );
  }
  if (body.length === 0) {
    throw new RouteRefusal(
      invalidBody(REFUSAL_FAMILY, `${operation} requires at least one ${what.replace(/s$/, "")}.`),
    );
  }
  if (body.length > maxItems) {
    throw new RouteRefusal(
      invalidBody(
        REFUSAL_FAMILY,
        `${operation} accepts at most ${maxItems} ${what} per request, and this one has `
          + `${body.length}.`,
      ),
    );
  }
  return body;
}

/**
 * The ids of a `/universe/names/` body, validated.
 *
 * `uniqueItems: true` is enforced because the document declares it: accepting
 * duplicates would be more permissive than ESI, which is as much a fidelity
 * failure as being less.
 *
 * `int64` is the declared format and `Number` cannot hold all of it, so the
 * check is on what JSON delivered: an integer, safe, and positive. An id beyond
 * `Number.MAX_SAFE_INTEGER` has already lost precision by `JSON.parse`, and a
 * silently rounded id would resolve to the wrong entity or to nothing.
 */
function readIds(body) {
  const ids = readArrayBody(body, {
    operation: NAMES_OPERATION_ID,
    maxItems: NAMES_MAX_IDS,
    what: "ids",
  });

  const seen = new Set();
  for (const value of ids) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RouteRefusal(
        invalidBody(
          REFUSAL_FAMILY,
          `${NAMES_OPERATION_ID} requires every element to be a positive integer id, and `
            + `${JSON.stringify(value)} is not one.`,
        ),
      );
    }
    if (seen.has(value)) {
      throw new RouteRefusal(
        invalidBody(REFUSAL_FAMILY, `${NAMES_OPERATION_ID} requires unique ids, and ${value} repeats.`),
      );
    }
    seen.add(value);
  }

  return [...seen];
}

/** The names of a `/universe/ids/` body, validated. Same rules, two more bounds. */
function readNames(body) {
  const names = readArrayBody(body, {
    operation: IDS_OPERATION_ID,
    maxItems: IDS_MAX_NAMES,
    what: "names",
  });

  const seen = new Set();
  for (const value of names) {
    if (typeof value !== "string" || value.length < 1 || value.length > IDS_MAX_NAME_LENGTH) {
      throw new RouteRefusal(
        invalidBody(
          REFUSAL_FAMILY,
          `${IDS_OPERATION_ID} requires every element to be a string of 1 to `
            + `${IDS_MAX_NAME_LENGTH} characters, and ${JSON.stringify(value)} is not one.`,
        ),
      );
    }
    if (seen.has(value)) {
      throw new RouteRefusal(
        invalidBody(
          REFUSAL_FAMILY,
          `${IDS_OPERATION_ID} requires unique names, and ${JSON.stringify(value)} repeats.`,
        ),
      );
    }
    seen.add(value);
  }

  return [...seen];
}

function readIndex(deps) {
  const index = deps && typeof deps === "object" ? deps.names : null;
  if (
    index === null
    || typeof index !== "object"
    || typeof index.resolveId !== "function"
    || typeof index.resolveName !== "function"
  ) {
    throw new Error(
      "ESI mod: a name-resolution route ran with no index. loader.js builds one with "
        + "lib/nameIndex.js createNameIndex() and hands it to both factories as `names`.",
    );
  }
  return index;
}

// The bodies

/**
 * One row of `POST /universe/names/`.
 *
 * Alphabetical, the schema's declaration order. All three fields are required,
 * so there is no `optional()`.
 */
const projectResolvedName = projection(NAMES_OPERATION_ID, {
  category: (row) => row.category,
  id: (row) => row.id,
  name: (row) => row.name,
});

/** One row of a `POST /universe/ids/` group. Two fields, both always sent. */
const projectResolvedId = projection(`${IDS_OPERATION_ID}Match`, {
  id: (row) => row.id,
  name: (row) => row.name,
});

/**
 * The `/universe/ids/` envelope: ten groups, alphabetical, each omitted when it
 * matched nothing.
 *
 * Omitted rather than sent empty: none of the ten is a required property, and
 * ten empty arrays would claim that this server has no agents, alliances or
 * regions, where the truth is that the names asked about were none of those.
 *
 * `optional()` turns the `null` into the omission; `arrayOf` is not used
 * because the value is already an array and the choice is whether the key
 * appears.
 */
const projectResolvedIds = projection(IDS_OPERATION_ID, {
  agents: (groups) => optional(groups.agents),
  alliances: (groups) => optional(groups.alliances),
  characters: (groups) => optional(groups.characters),
  constellations: (groups) => optional(groups.constellations),
  corporations: (groups) => optional(groups.corporations),
  factions: (groups) => optional(groups.factions),
  inventory_types: (groups) => optional(groups.inventory_types),
  regions: (groups) => optional(groups.regions),
  stations: (groups) => optional(groups.stations),
  systems: (groups) => optional(groups.systems),
});

/**
 * `POST /universe/names/`.
 *
 * Row order is the request's: ids that resolved keep the order they were asked
 * in. Sorting would break the pairing for a client that walks the answer beside
 * its request. The order is also stable, which the `Etag` needs: an order
 * derived from a Map's insertion would move if the index were built in a
 * different order.
 */
function buildUniverseNames(params, deps) {
  const index = readIndex(deps);
  const ids = readIds(params && params.body);

  const rows = [];
  for (const id of ids) {
    const found = index.resolveId(id);
    if (found !== null) rows.push(projectResolvedName(found));
  }
  return rows;
}

/**
 * `POST /universe/ids/`.
 *
 * Within a group, matches keep the request's order. The groups are in the
 * projection's order, the schema's.
 */
function buildUniverseIds(params, deps) {
  const index = readIndex(deps);
  const names = readNames(params && params.body);

  const groups = {};
  for (const name of names) {
    const found = index.resolveName(name);
    if (found === null) continue;
    if (groups[found.group] === undefined) groups[found.group] = [];
    groups[found.group].push(projectResolvedId(found));
  }

  return projectResolvedIds(groups);
}

// The route descriptors

/**
 * Shared columns, so the two descriptors cannot drift apart.
 *
 * `localizedBody: true` on both. `contract/wire.js` `VARY_LOCALIZED_SURVEY`
 * records the rule: an application route whose body carries translated text
 * sends the four-line `Vary`, a gateway route never does. Every name in either
 * body is published by CCP in eight languages in the dump these are read from,
 * which is what puts `/universe/constellations/{id}/` and
 * `/universe/regions/{id}/` in the `localized` column.
 *
 * No `subject` and no `scope`: both operations are public.
 */
const SHARED_COLUMNS = Object.freeze({
  method: "POST",
  producer: PRODUCER,
  cacheTtl: CACHE_TTL_SECONDS,
  rateLimitGroup: RATE_LIMIT_GROUP,
  localizedBody: true,
});

function createUniverseNamesRoute(deps) {
  return {
    ...SHARED_COLUMNS,
    path: NAMES_PATH,
    name: NAMES_OPERATION_ID,
    handler: (params) => buildUniverseNames(params, deps),
  };
}

function createUniverseIdsRoute(deps) {
  return {
    ...SHARED_COLUMNS,
    path: IDS_PATH,
    name: IDS_OPERATION_ID,
    handler: (params) => buildUniverseIds(params, deps),
  };
}

module.exports = Object.freeze({
  CACHE_TTL_SECONDS,
  IDS_MAX_NAMES,
  IDS_MAX_NAME_LENGTH,
  IDS_OPERATION_ID,
  IDS_PATH,
  NAMES_MAX_IDS,
  NAMES_OPERATION_ID,
  NAMES_PATH,
  PRODUCER,
  RATE_LIMIT_GROUP,
  REFUSAL_FAMILY,
  buildUniverseIds,
  buildUniverseNames,
  createUniverseIdsRoute,
  createUniverseNamesRoute,
  projectResolvedId,
  projectResolvedName,
  projectResolvedIds,
  readIds,
  readNames,
});
