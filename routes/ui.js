/**
 * `POST /ui/autopilot/waypoint/`: the one write endpoint, and the only route on
 * this surface that changes anything in the game.
 *
 *   POST /latest/ui/autopilot/waypoint/?add_to_beginning=false
 *        &clear_other_waypoints=true&destination_id=30000142
 *   Authorization: Bearer <token with esi-ui.write_waypoint.v1>
 *   -> 204, no body, no Content-Length
 *
 * There is no success body, so the file is about three query parameters and
 * what "it worked" means.
 *
 * D34: `204`, always. The pinned document declares `204` and `default` on this
 * operation and no numeric error status, so there is no refusal to be faithful
 * to. What settles the semantics is a fact about this server: it cannot tell
 * "offline" from "online and unreachable", and cannot know whether anything was
 * delivered even when it finds a session. `sessionRegistry` derives presence
 * through `characterControlRuntime` so browser-pilot leases never need fake
 * sessions, so a pilot flying through the browser has no session here,
 * indistinguishably from one who logged out. A found session is no guarantee
 * either: `clientSession.sendNotification` checks `socket.destroyed`, records a
 * `packet.dropped` ledger event and returns. `204` is the only answer whose
 * correctness does not depend on a distinction this replica cannot compute. A
 * `200 {delivered:false, reason:"offline"}` envelope was rejected: its `reason`
 * is false for a browser pilot, and any body contradicts the `204`.
 *
 * Cost: a consumer shows "Destination set" whether or not anything happened.
 * For a pilot who is not logged in that matches real ESI; for a pilot logged in
 * through the browser it is a divergence. `OUTCOME` below is the operability
 * answer: one log line per attempt naming which of three things happened,
 * carrying the operation and never the character id.
 *
 * The push: the notification the client listens for was inferred from decompiled
 * client code and confirmed against a live client on 2026-08-25. It is
 * unconditional, with no flag. `lib/runtimeAccess.js` has what was seen.
 *
 * The three parameters: the document declares all three `required` and gives
 * the two booleans a `default`, so a client is told to send them and CCP still
 * says what an absent boolean means. Absence is answered from the document for
 * the booleans. `destination_id` has no default and its absence is not covered.
 *
 * Two refusals CCP would make have never been observed on any route, and
 * neither is invented: a required query parameter that is absent, and a boolean
 * that is neither `true` nor `false`. The spec declares no numeric error status
 * here, and D31 records what a guessed refusal is worth (wrong in status,
 * family, producer, content-type and last byte at once). Both throw, which
 * `lib/router.js` turns into a logged `500`: loudly wrong rather than quietly
 * invented, the bargain `routes/structures.js` takes for its unseen ACL
 * refusal. Two requests settle both:
 *
 *   curl -sD - -X POST -H "Authorization: Bearer <token>" \
 *     "https://esi.evetech.net/latest/ui/autopilot/waypoint/?clear_other_waypoints=true&add_to_beginning=false"
 *   curl -sD - -X POST -H "Authorization: Bearer <token>" \
 *     "https://esi.evetech.net/latest/ui/autopilot/waypoint/?destination_id=30000142&clear_other_waypoints=true&add_to_beginning=1"
 *
 * A `destination_id` that is not an integer is refused with observed bytes.
 * `contract/wire.js` `VALIDATES_DECLARED_QUERY_PARAMS` is the rule (a declared
 * parameter is validated, an undeclared one ignored), and `lib/errors.js`
 * `coercionFailed` holds the observed body for this seat: a refusal a handler
 * produced, dressed by `routedRefusal`. The only part this route supplies is
 * the `format` token, from the document's schema for the parameter (`int64`).
 *
 * Everything is injected: `runtime` is `lib/runtimeAccess.js` or a double, and
 * `log` is the loader's. The endpoint, push included, is testable with no eve.js
 * checkout.
 */

"use strict";

const { RouteRefusal } = require("../lib/router");
const { coercionFailed, familyFor } = require("../lib/errors");

/** The wire path, canonical: no version prefix, no trailing slash. */
const WAYPOINT_PATH = "/ui/autopilot/waypoint";

/** The spec's `operationId`, which is also what the log lines name. */
const OPERATION_ID = "PostUiAutopilotWaypoint";

/** CCP's scope for this operation, spelled exactly as the document spells it. */
const SCOPE = "esi-ui.write_waypoint.v1";

/** The spec's `x-rate-limit` group: 900 tokens per 15m. */
const RATE_LIMIT_GROUP = "ui";

/**
 * `204`, from the document. See the header.
 *
 * `lib/router.js` carries this as a route-table column, and refuses at
 * construction to compile a `204` route that paginates, and at dispatch a `204`
 * handler that returned a body: `server.js` would drop those bytes silently, and
 * a write endpoint reporting its result in a body nobody transmits looks like
 * it works.
 */
const SUCCESS_STATUS = 204;

/**
 * `app`, the only value this route may legally declare.
 *
 * The route sends no JSON on success, which makes `null` look right, but its
 * refusals are JSON, `errorFamily` is derived from this field, and a `null`
 * producer would leave `coercionFailed` with no family.
 *
 * `lib/router.js` `assertScope` refuses to compile a scoped route on the
 * gateway (no authenticated gateway route has been observed), and `meta` is the
 * `/meta/` surface. That leaves `app`, which every authenticated operation
 * observed so far turned out to be.
 *
 * Unobserved: the header set on the `204` itself (the `--write` probe in
 * `scripts/observe-authed.js` is off by default and has not been run). That is
 * not this file's decision: the framework writes those headers for an
 * authenticated `app` route as for any other, and `lib/cache.js` leaves a
 * bodiless response alone.
 */
const PRODUCER = "app";

/** The family this route's refusals are built in. Derived, never declared. */
const REFUSAL_FAMILY = familyFor(PRODUCER);

/** The three query parameters, named as the document names them. */
const DESTINATION_ID_PARAM = "destination_id";
const CLEAR_OTHER_WAYPOINTS_PARAM = "clear_other_waypoints";
const ADD_TO_BEGINNING_PARAM = "add_to_beginning";

/**
 * The document's own `format` for `destination_id`, carried into the coercion
 * message. `int64` and not `int32`: the parameter takes a station or structure
 * id as readily as a solar system id, and structure ids exceed the int32
 * ceiling.
 */
const DESTINATION_FORMAT = "int64";

/**
 * What CCP accepts as an integer, which is not what `Number()` accepts.
 *
 * `lib/pagination.js`'s rule: a strict decimal literal with an optional sign
 * and any number of leading zeros. `1e3`, `0x2` and a bare space are coercion
 * failures on the real surface and numbers to `Number()`.
 */
const DECIMAL_INTEGER = /^[+-]?\d+$/;

/**
 * The int64 range, as bounds an integer literal can be compared against.
 *
 * `2147483648`, one past the int32 top, is a coercion failure rather than a
 * range error on `?page=`, so CCP treats "outside the declared width" as "it
 * never became that type". This is the same rule one width up.
 *
 * `BigInt` because `Number` cannot make the comparison at the boundary:
 * `9223372036854775807` and `9223372036854775808` are the same double.
 */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/**
 * The two spellings of a boolean this route accepts, which are the document's.
 *
 * Anything else throws (see the header). Not `Boolean(value)`, which makes
 * `"false"` true, and not a lenient list, which would decide CCP accepts `1`,
 * `yes` and `on` when nobody has asked it.
 */
const BOOLEAN_VALUES = Object.freeze({ true: true, false: false });

/**
 * What one request did, for the log and nothing else.
 *
 * D34's three. None reaches the client, since every one is a `204`: the
 * outcome is an operator's fact, because the caller could not act on it and
 * real ESI does not tell them either.
 */
const OUTCOME = Object.freeze({
  PUSHED: "pushed",
  NO_SESSION: "no-session",
  PUSH_FAILED: "push-failed",
});

/**
 * A parameter absent, or a boolean spelled a third way: the two refusals this
 * route will not invent.
 *
 * Its own class so the `500` it becomes is greppable and a test can assert it
 * is a deliberate refusal to guess, not a `TypeError`.
 */
class UnobservedRefusal extends Error {
  constructor(message) {
    super(`ESI mod: ${message}`);
    this.name = "UnobservedRefusal";
  }
}

/**
 * `?add_to_beginning=false` -> `false`, absent -> the document's default.
 *
 * The default is passed in rather than assumed `false` for both, so if CCP
 * publishes a different one for one of them the change is local.
 */
function readBoolean(query, name, fallback) {
  const raw = query && Object.prototype.hasOwnProperty.call(query, name) ? query[name] : undefined;
  if (raw === undefined || raw === "") return fallback;

  const value = BOOLEAN_VALUES[String(raw)];
  if (value === undefined) {
    throw new UnobservedRefusal(
      `${OPERATION_ID} was sent ${name}=${JSON.stringify(String(raw))}, which is neither `
        + "\"true\" nor \"false\". CCP refuses this and the refusal has never been observed ("
        + "the spec declares no numeric error status on this operation), so this replica "
        + "answers a logged 500 rather than inventing one. One curl settles it: see routes/ui.js.",
    );
  }
  return value;
}

/**
 * `{ destinationId }`, or a thrown `RouteRefusal` carrying CCP's coercion body.
 *
 * `destinationId` is a `BigInt`, the width the document declares, which a
 * `Number` cannot hold the top of. Whether the game can use the value is asked
 * at the push and answered in the log: a destination id nothing in this
 * universe answers to is the "undeliverable" case D34 settled, not a malformed
 * request.
 */
function readDestinationId(query) {
  const present = query && Object.prototype.hasOwnProperty.call(query, DESTINATION_ID_PARAM);
  const raw = present ? String(query[DESTINATION_ID_PARAM]) : "";

  // `?destination_id=` is the same request as sending nothing, which is
  // `lib/pagination.js`'s rule for `?page=` and the mod's only rule for an empty
  // query value. One answer to "what is an empty parameter", and the uncertain
  // case goes to the loud path below. It is narrower than it looks:
  // `?destination_id=%20` is a space, which CCP was observed refusing as a
  // coercion failure on `?page=`, and it falls through.
  if (raw === "") {
    throw new UnobservedRefusal(
      `${OPERATION_ID} was sent no ${DESTINATION_ID_PARAM}. The document declares it required `
        + "and publishes no default and no numeric error status, and CCP's refusal for an absent "
        + "required query parameter has never been observed on any route, so this replica "
        + "answers a logged 500 rather than inventing one. One curl settles it: see routes/ui.js.",
    );
  }

  const coerced = DECIMAL_INTEGER.test(raw) ? BigInt(raw) : null;

  if (coerced === null || coerced < INT64_MIN || coerced > INT64_MAX) {
    throw new RouteRefusal(coercionFailed(REFUSAL_FAMILY, {
      parameter: DESTINATION_ID_PARAM,
      value: raw,
      where: "query",
      format: DESTINATION_FORMAT,
    }));
  }

  return coerced;
}

/**
 * The three parameters, read the way the document describes them.
 *
 * Separate from the handler so a test can exercise the request contract
 * without a runtime or a session.
 */
function readWaypointRequest(query) {
  return {
    destinationId: readDestinationId(query),
    clearOtherWaypoints: readBoolean(query, CLEAR_OTHER_WAYPOINTS_PARAM, false),
    addToBeginning: readBoolean(query, ADD_TO_BEGINNING_PARAM, false),
  };
}

/**
 * An id the game can be handed, or `null`.
 *
 * The document's `int64` is wider than eve.js's ids and a JavaScript integer,
 * so a value can be a good `destination_id` and still undeliverable. That is
 * not a malformed request (a coercion body would claim CCP refuses it): it is
 * reported like every other undeliverable, `204` and `push-failed` in the log.
 */
function deliverableId(destinationId) {
  if (destinationId <= 0n || destinationId > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(destinationId);
}

/**
 * Push the notification, and answer with which of the three things happened.
 *
 * Every failure is caught: a game module that changed shape and game code that
 * threw both become `PUSH_FAILED` and a `204`, because D34's `204` is the answer
 * precisely because this replica cannot report on the push. The log line and
 * `logError`'s stack show the failure, and `test/runtimeAccess.test.js`'s
 * vendor-drift checks catch the shape change a release earlier.
 */
function pushWaypoint(request, { runtime, logError }) {
  const destinationId = deliverableId(request.destinationId);
  if (destinationId === null) return OUTCOME.PUSH_FAILED;

  const send = runtime && typeof runtime.sendDestinationChange === "function"
    ? runtime.sendDestinationChange
    : null;
  if (send === null) return OUTCOME.PUSH_FAILED;

  try {
    const outcome = send.call(runtime, {
      characterId: request.characterId,
      destinationId,
      clearOtherWaypoints: request.clearOtherWaypoints,
      addToBeginning: request.addToBeginning,
    });
    // The accessor's own vocabulary only: anything else is a module that is not the
    // one this route thinks it holds, a failed push and not an absent pilot.
    if (outcome === OUTCOME.PUSHED) return OUTCOME.PUSHED;
    return outcome === OUTCOME.NO_SESSION ? OUTCOME.NO_SESSION : OUTCOME.PUSH_FAILED;
  } catch (err) {
    if (typeof logError === "function") {
      logError(`${OPERATION_ID} could not push the waypoint`, err);
    }
    return OUTCOME.PUSH_FAILED;
  }
}

/**
 * The route descriptor, for the table `loader.js` builds.
 *
 * No `subject`. The path names no entity, because the character acted on is the
 * token's subject, read from `params.credential`. `lib/router.js` asks for a
 * `subject` only where a scoped route is keyed by an entity id, so the scope
 * plus the token's own identity is the whole gate.
 *
 * @param {object}   deps
 * @param {object}   [deps.runtime]  `lib/runtimeAccess.js`, or a double
 * @param {function} [deps.log]      the loader's logger
 */
function createSetWaypointRoute(deps = {}) {
  const runtime = deps.runtime && typeof deps.runtime === "object" ? deps.runtime : null;
  const log = typeof deps.log === "function" ? deps.log : () => {};

  return {
    method: "POST",
    path: WAYPOINT_PATH,
    name: OPERATION_ID,
    scope: SCOPE,
    producer: PRODUCER,
    successStatus: SUCCESS_STATUS,
    rateLimitGroup: RATE_LIMIT_GROUP,
    // The document publishes no `x-cache-age` for this operation: nothing to cache
    // and nothing to poll on a write.
    cacheTtl: null,
    handler: (params, dispatchDeps) => {
      const request = readWaypointRequest(params.query);

      // The token's subject, never a path segment or query parameter: a write
      // endpoint taking the character from the request would let any holder of the
      // scope move any pilot.
      request.characterId = params.credential ? params.credential.characterId : null;

      const outcome = pushWaypoint(request, {
        runtime,
        logError: dispatchDeps && dispatchDeps.logError,
      });

      // All an operator gets: which operation, and which of three things happened. No
      // character id and no destination, since a log recording where every pilot
      // went would be a movement log for the whole server.
      log(`${OPERATION_ID}: ${outcome}`);

      // Nothing. A `204` carries no body, and `lib/router.js` throws rather than let
      // one be returned and dropped.
      return undefined;
    },
  };
}

module.exports = Object.freeze({
  ADD_TO_BEGINNING_PARAM,
  BOOLEAN_VALUES,
  CLEAR_OTHER_WAYPOINTS_PARAM,
  DESTINATION_FORMAT,
  DESTINATION_ID_PARAM,
  INT64_MAX,
  INT64_MIN,
  OPERATION_ID,
  OUTCOME,
  PRODUCER,
  RATE_LIMIT_GROUP,
  SCOPE,
  SUCCESS_STATUS,
  UnobservedRefusal,
  WAYPOINT_PATH,
  createSetWaypointRoute,
  deliverableId,
  readWaypointRequest,
});
