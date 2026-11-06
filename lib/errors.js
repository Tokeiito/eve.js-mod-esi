/**
 * eve.js-mod-esi: refusals
 *
 * Every non-success response this replica gives, in the exact bytes CCP gives
 * them. Many ESI client libraries read `body.error` on any status of 400 or
 * above, and several match the strings literally, so the error shape is protocol.
 *
 * There is no single ESI error shape. The `2020-01-01` surface is two
 * implementations behind one hostname, and which one answers is a property of
 * the route, not of the failure. The same mistake against two routes gets
 * different status codes, body shapes and `content-type` headers:
 *
 *   GET /latest/universe/systems/abc/   400  {"error":"failed to coerce value 'abc' …"}
 *                                            application/json; charset=UTF-8
 *   GET /latest/characters/abc/         422  {"status":422,"error":"validation failed",
 *                                             "details":[{"message":"invalid integer", …}]}
 *                                            application/json
 *
 * Universe and static routes are on the older implementation; character,
 * corporation and alliance routes are on a newer validator. Our 35 endpoints
 * straddle that line.
 *
 * A route does not declare its error family. It declares the implementation that
 * answers it (one fact, from observation) and the family follows. Fetching a
 * success and a refusal from the same route, six times, gave six agreements:
 * `LEGACY` is the application's refusals and `VALIDATED` the gateway's. See
 * `familyFor` and `contract/wire.js` for the pairs.
 *
 * A third family, `EDGE`, is the gateway's own refusal: `401` and `400 Invalid
 * tenant`. It is the only family that sends `x-content-type-options: nosniff`,
 * consistent with sharing a producer with the 2XX path and inconsistent with
 * what a security scanner would advise. Design constraint 3: fidelity beats
 * hygiene.
 *
 * `EDGE` is not "refusals made before any route is reached". The no-token `401`
 * is decided after routing: it carries the resolved route's rate-limit group,
 * its three `Vary` lines and `Content-Language: en`, and an unrouted path with no
 * credential is a `404`. So the family says who wrote the bytes, not how far the
 * request got. `contract/wire.js` `BEARER` has the survey.
 *
 * Byte-exactness. Key order is part of the bytes, so the builders assemble
 * objects in CCP's order (`status`, `error`, `details`). The exact strings are in
 * `contract/wire.js`; the duplication is deliberate because `contract/` is
 * test-only and never deployed (D20), and `test/errors.test.js` asserts the two
 * agree.
 *
 * So is the last byte. Go's encoder ends every body with a newline and the
 * application's does not, so a `401` is 45 bytes and a
 * `404 {"error":"Region not found"}` is 28. That belongs to the producer: each
 * family names one and `lib/serialize.js` turns it into bytes. Nothing here
 * appends a newline by hand.
 *
 * Two refusals belong to no family because no route produced them: the unrouted
 * `404`, which is Go's own handler and leaves JSON entirely, and the `405`,
 * which has no body and no `content-type`.
 */

"use strict";

const { PRODUCER, contentTypeFor } = require("./serialize");

// Families

const FAMILY = Object.freeze({
  /** Universe and static routes. Bare `{error}`, with a charset parameter. */
  LEGACY: "legacy",
  /** Character, corporation and alliance routes. `{status, error, details?}`. */
  VALIDATED: "validated",
  /** Refusals made before a route is reached. Never declared by a route. */
  EDGE: "edge",
});

/**
 * Which of the two implementations writes each family's body.
 *
 * The same producer split `lib/serialize.js` uses for successes, so the
 * `content-type` and trailing newline are not decided separately here: the legacy
 * family is the application, the validated and edge families are Go.
 *
 * A `401` is 45 bytes on the wire, not the 44 its JSON text weighs, because Go's
 * encoder ends every body with a newline. See `contract/wire.js`
 * `TRAILING_NEWLINE`.
 */
const SHAPE = Object.freeze({
  [FAMILY.LEGACY]: Object.freeze({ producer: PRODUCER.APP, nosniff: false }),
  [FAMILY.VALIDATED]: Object.freeze({ producer: PRODUCER.GATEWAY, nosniff: false }),
  [FAMILY.EDGE]: Object.freeze({ producer: PRODUCER.GATEWAY, nosniff: true }),
});

/**
 * The error family a route gets, from the implementation that answers it.
 *
 * A route does not choose its error shape any more than its `content-type`: both
 * come from which of ESI's two implementations owns it. Fetching a success and a
 * refusal from the same route, six times, gave six agreements and no
 * exceptions: `/alliances/{id}/` is the gateway on both halves,
 * `/universe/regions/{id}/` the application on both.
 *
 * It is a derivation rather than a second field to declare, because two fields
 * can be set to a combination that does not exist.
 *
 * `EDGE` is not derivable and is not here: there is no route to derive it from.
 */
const FAMILY_BY_PRODUCER = Object.freeze({
  [PRODUCER.APP]: FAMILY.LEGACY,
  [PRODUCER.GATEWAY]: FAMILY.VALIDATED,
  /**
   * `null`, and it is the observed value rather than a gap.
   *
   * The `/meta/` surface has no route-level error to observe: none of its
   * operations declares a path or query parameter, so nothing can be sent that a
   * route would refuse. Its `404` is the unrouted one and its `405` is the
   * router's; neither belongs to a family.
   *
   * Do not guess `VALIDATED` because the bytes look like the gateway's. If a meta
   * route ever takes a parameter, one `curl` settles it.
   */
  [PRODUCER.META]: null,
});

/**
 * The error family for a route answered by `producer`, or `null` for a producer
 * with no observed error shape.
 */
function familyFor(producer) {
  const family = FAMILY_BY_PRODUCER[producer];
  if (family === undefined) {
    throw new Error(
      `ESI mod: no error family for producer ${JSON.stringify(producer)}: expected one of `
        + `${Object.values(PRODUCER).join(", ")}. A route's error shape follows the implementation `
        + "that answers it; it is not declared separately.",
    );
  }
  return family;
}

/** The two 401 bodies, verbatim. Clients branch on the difference. */
const UNAUTHORIZED_REASONS = Object.freeze({
  "no-token": "Unauthorized - No token provided",
  "invalid-token": "Unauthorized - Invalid token",
});

const INVALID_TENANT = "Invalid tenant";

/** The `403`, verbatim. See `characterMismatch`. */
const CHARACTER_MISMATCH = "Character ID mismatch between request path and auth token";

/**
 * The two entity `403`s, verbatim. Observed 2026-08-25. The `(s)` in the second
 * is CCP's: 40 characters, not 39 and not "required roles".
 *
 * They first lived in `routes/structures.js`, with a note that the right home was
 * a pair of builders here once more than one route needed them.
 * `routes/contacts.js` is the second, and is where the membership one was
 * captured.
 */
const NOT_IN_CORPORATION = "Character is not in the corporation";
const MISSING_REQUIRED_ROLE = "Character does not have required role(s)";

/** Go's `http.NotFound`. The trailing newline is what makes it 19 bytes. */
const UNROUTED_BODY = "404 page not found\n";
const UNROUTED_CONTENT_TYPE = "text/plain; charset=utf-8";

function assertFamily(family, what) {
  if (!Object.prototype.hasOwnProperty.call(SHAPE, family)) {
    throw new Error(`ESI mod: ${what} for unknown error family ${JSON.stringify(family)}.`);
  }
}

/**
 * `{ status, headers, body, producer }`, with the family's headers already on it.
 *
 * `producer` rides along because the body's last byte is not decidable from the
 * body: `server.js` must know which implementation it imitates before it can
 * turn `{error: …}` into bytes.
 */
function build(family, status, body) {
  const shape = SHAPE[family];
  const headers = { "content-type": contentTypeFor(shape.producer) };
  if (shape.nosniff) headers["x-content-type-options"] = "nosniff";
  return { status, headers, body, producer: shape.producer };
}

// Edge refusals

/**
 * `401`, in one of exactly two wordings.
 *
 * An unrecognised reason throws rather than inventing a third string: a client
 * matching on the two known ones would silently stop recognising us.
 */
function unauthorized(reason) {
  const message = UNAUTHORIZED_REASONS[reason];
  if (message === undefined) {
    throw new Error(
      `ESI mod: unauthorized reason must be one of ${Object.keys(UNAUTHORIZED_REASONS).join(", ")}, `
        + `got ${JSON.stringify(reason)}.`,
    );
  }
  return build(FAMILY.EDGE, 401, { error: message });
}

/**
 * `401`, for a token that verified and does not carry the route's scope (D31).
 *
 * The third 401 wording, and its own builder rather than a member of
 * `UNAUTHORIZED_REASONS`, because it names the scope it wanted, so the bytes are
 * the route's.
 *
 *   curl -H "Authorization: Bearer <token without the scope>" \
 *        https://esi.evetech.net/latest/characters/<id>/wallet/
 *     401 {"error":"Unauthorized - Token is not valid for any required scope:
 *          esi-wallet.read_character_wallet.v1"}
 *
 * It is a `401`, not a `403`, contrary to what the original request for this
 * gate assumed and to eve-nexum's `401 = token invalid/no scopes, 403 = token
 * valid but scope missing`. Both were checked: a token with no scopes and a
 * token with a different scope produce the same bytes. `contract/wire.js`
 * `SCOPE_REFUSAL` has the survey.
 *
 * `EDGE`, like its two siblings: the gateway refuses this one, and it carries
 * `nosniff` and the trailing newline.
 */
function unauthorizedScope(scope) {
  if (typeof scope !== "string" || scope === "") {
    throw new Error(
      "ESI mod: a scope refusal must name the scope it wanted: CCP's wording interpolates it, "
        + "so a blank one would send different bytes from the observed refusal.",
    );
  }
  return build(FAMILY.EDGE, 401, {
    error: `Unauthorized - Token is not valid for any required scope: ${scope}`,
  });
}

/**
 * `403`, for a token whose subject is not the character the path names (D31).
 *
 * The one refusal on this surface that really is a `403`, and it is the
 * application's, not the gateway's. Observed carrying
 * `application/json; charset=UTF-8`, no trailing newline, no `nosniff`, and an
 * `X-Esi-Request-Id`: `KIND.APP_ERROR`. So it takes a family and derives, as a
 * `404` does, rather than being `EDGE`.
 *
 *   curl -H "Authorization: Bearer <token for character A>" \
 *        https://esi.evetech.net/latest/characters/<B>/online/
 *     403 {"error":"Character ID mismatch between request path and auth token"}
 *
 * `VALIDATED` throws rather than guessing. The observation is from a `LEGACY`
 * route; what a gateway-producer route says for the same mistake would be
 * `{"status":403,"error":…,"details":[…]}` if the family rule holds, which is a
 * derivation, and `contract/wire.js` does not hold derivations. No route needs
 * it today; the day one does, it arrives with a `curl`.
 */
function characterMismatch(family) {
  assertFamily(family, "a character mismatch");

  if (family !== FAMILY.LEGACY) {
    throw new Error(
      `ESI mod: the ${family} 403 for a character mismatch has never been observed: only the `
        + "legacy one has. See contract/wire.js CHARACTER_MISMATCH, and scripts/observe-403.js "
        + "for the request that would settle it.",
    );
  }

  return build(family, 403, { error: CHARACTER_MISMATCH });
}

/**
 * `403 {"error":"Character is not in the corporation"}`, 47 bytes (D35).
 *
 * The refusal a scoped route keyed by an entity makes when the caller has no
 * claim on it: the token is right, the scope is held, and the caller is not a
 * member. Observed on `/corporations/{id}/contacts/` against an NPC corporation
 * (so the probe named no player's corporation), and reused by
 * `/corporations/{id}/structures/`, since its wording names the relationship
 * rather than the permission.
 *
 * That is also its limit. It is corporation-shaped, so an alliance or fleet
 * refusal cannot be spelled from it, and neither has been observed;
 * `routes/contacts.js` `allianceContactsSubject` throws rather than inventing the
 * alliance wording, and carries the `curl` that would settle it.
 *
 * `VALIDATED` throws, as `characterMismatch` does and for the same reason.
 */
function notInCorporation(family) {
  assertFamily(family, "a corporation membership refusal");

  if (family !== FAMILY.LEGACY) {
    throw new Error(
      `ESI mod: the ${family} 403 for a caller outside the corporation has never been observed `
        + "(only the legacy one has). See contract/wire.js CROSS_ENTITY_REFUSAL.",
    );
  }

  return build(family, 403, { error: NOT_IN_CORPORATION });
}

/**
 * `403 {"error":"Character does not have required role(s)"}`, 52 bytes.
 *
 * What `x-required-roles` produces, a third thing beside the two refusals D31
 * settled: the token is right, the scope is held, the caller is who they say,
 * and the game says no. Observed on `/corporations/{id}/structures/`, whose
 * operation declares `["Station_Manager"]`.
 *
 * The parenthetical is bytes. Tidying it to "required roles" sends a different
 * response.
 */
function missingRequiredRole(family) {
  assertFamily(family, "a corporation role refusal");

  if (family !== FAMILY.LEGACY) {
    throw new Error(
      `ESI mod: the ${family} 403 for a missing corporation role has never been observed: only `
        + "the legacy one has. See contract/wire.js REQUIRED_ROLE_REFUSAL.",
    );
  }

  return build(family, 403, { error: MISSING_REQUIRED_ROLE });
}

/** `400 {"error":"Invalid tenant"}`: a recognised `datasource` with a bad value. */
function invalidTenant() {
  return build(FAMILY.EDGE, 400, { error: INVALID_TENANT });
}

/**
 * An edge refusal whose message belongs to whoever observed it.
 *
 * This file owns the shape of a refusal (written by the gateway, `nosniff`,
 * trailing newline), which every edge refusal shares and which is easy to get
 * subtly wrong. The string belongs with the code that established it:
 * `lib/compatibility.js` keeps the three compatibility-date messages beside the
 * probes that found them.
 *
 * It is not a licence to invent a refusal. Every caller's string is observed
 * verbatim from live ESI, and a new one arrives with the `curl` that produced
 * it, the standard `unauthorized` enforces by refusing an unrecognised reason.
 *
 * Two exceptions. The `420` in `lib/errorLimiter.js` and the `429` in
 * `lib/rateLimiter.js` have strings that were never observed: the `curl` that
 * would produce one deliberately exhausts a third party's limiter. CCP publishes
 * the two statuses and neither body, and the pinned spec documents no `420` or
 * `429` response at all.
 *
 * A limiter that never refuses is not a limiter, so the choice was these
 * placeholders or no limiter. The weakness is kept findable: the strings are
 * boring placeholders, duplicated in `contract/wire.js` under
 * `LIMITER_UNOBSERVED` rather than beside the observed values, and each module's
 * test compares its copy against that one. An observation is then a single edit
 * that fails a test naming the file to change.
 *
 * Two, and no more. A third caller that cannot name its `curl` has not looked
 * hard enough.
 */
function edgeRefusal(status, message) {
  if (!Number.isInteger(status) || status < 400) {
    throw new Error(`ESI mod: an edge refusal needs a 4xx or 5xx status, got ${JSON.stringify(status)}.`);
  }
  if (typeof message !== "string" || message === "") {
    throw new Error("ESI mod: an edge refusal needs the message CCP sends, verbatim.");
  }
  return build(FAMILY.EDGE, status, { error: message });
}

// Path-parameter failures

/**
 * A path parameter that could not be used, in the family's own terms.
 *
 * `LEGACY` is a `400` whose message names the parameter and the int32 format it
 * failed; `VALIDATED` is a `422` carrying `details[]`. `value` keeps the JSON
 * type it arrived as (the string `"abc"` when unparseable, the number when it
 * parsed and was out of range), because a client reading `details` can see the
 * difference.
 *
 * A query parameter is validated only where the route declares one (`?page=abc`
 * is a 200 on a route that does not paginate and a 400 on one that does), and
 * then the message is shorter. A path parameter names itself:
 *
 *   path   400 failed to coerce value 'abc' into type integer (format: int32), 'system_id' is required
 *   query  400 failed to coerce value 'abc' into type integer (format: int32)
 *
 * The `, '<name>' is required` clause is the path form's: a segment the route
 * cannot do without. A query parameter is optional by construction, and CCP does
 * not say it is required.
 */
function coercionFailed(family, { parameter, value, message, where = "path", format = "int32" } = {}) {
  assertFamily(family, "a parameter failure");

  if (family === FAMILY.EDGE) {
    throw new Error("ESI mod: the edge family never sees a path parameter: it refuses before routing.");
  }
  if (typeof parameter !== "string" || parameter === "") {
    throw new Error("ESI mod: a parameter failure must name the parameter.");
  }

  if (family === FAMILY.LEGACY) {
    const coercion = `failed to coerce value '${value}' into type integer (format: ${format})`;
    return build(family, 400, {
      error: where === "query" ? coercion : `${coercion}, '${parameter}' is required`,
    });
  }

  return build(family, 422, {
    status: 422,
    error: "validation failed",
    details: [
      {
        message: message || "invalid integer",
        location: `${where}.${parameter}`,
        value,
      },
    ],
  });
}

// Pagination refusals

/**
 * `400 {"error":"0 does not meet minimum of 1"}`: a page number below one.
 *
 * The value is interpolated verbatim, so `-1` reports `-1`. Observed on both
 * public paginated routes, both application routes; no publicly reachable
 * gateway route paginates, so `LEGACY` is the only family this has been seen in
 * and the only one offered.
 */
function pageBelowMinimum(family, { value, minimum = 1 } = {}) {
  assertFamily(family, "a pagination refusal");
  if (family !== FAMILY.LEGACY) {
    throw new Error(
      `ESI mod: the ${family} family's pagination refusals have never been observed: both `
        + "paginated routes on the public surface are legacy. Observe one before inventing it.",
    );
  }
  return build(family, 400, { error: `${value} does not meet minimum of ${minimum}` });
}

/**
 * `404 {"error":"Requested page does not exist!"}`: past the last page.
 *
 * It is a `404` with a body, exclamation mark included, not the empty array one
 * might expect, and a client expecting `[]` gets an object.
 */
function pageBeyondEnd(family) {
  assertFamily(family, "a pagination refusal");
  if (family !== FAMILY.LEGACY) {
    throw new Error(
      `ESI mod: the ${family} family's pagination refusals have never been observed: both `
        + "paginated routes on the public surface are legacy. Observe one before inventing it.",
    );
  }
  return build(family, 404, { error: "Requested page does not exist!" });
}

// Request bodies

/**
 * `400` for a request body that does not satisfy the operation's schema.
 *
 * The one refusal here about a body rather than a path segment or query value:
 * `POST /universe/names/` and `POST /universe/ids/` are the only routes that read
 * one (the waypoint write, the only other POST, takes its input in the query
 * string).
 *
 * The wording is this replica's, not a capture. CCP's document declares the
 * constraints a body must satisfy (`minItems`, `maxItems`, `uniqueItems`,
 * `maxLength`) and publishes no example of the response to a body that breaks
 * one. It is kept here with the observed refusals because a refusal's bytes are
 * a contract even when they are ours, and one place to change them makes them
 * replaceable once a capture settles it.
 *
 * What is taken from observation is everything around the string: the status is
 * the legacy family's `400`, the shape its bare `{error}`, and the producer
 * decides the content type and the absent trailing newline, all from `SHAPE` as
 * `coercionFailed`'s do.
 *
 * `LEGACY` only. The validated family's body refusal would be a `422` whose
 * `details[]` names the offending element, and inventing that is a larger
 * fabrication; no gateway route on this surface reads a body.
 */
function invalidBody(family, message) {
  assertFamily(family, "a body refusal");

  if (family !== FAMILY.LEGACY) {
    throw new Error(
      `ESI mod: the ${family} family has no observed body refusal, and no route on this surface `
        + "reads a body outside the legacy family. Observe one before inventing it.",
    );
  }
  if (typeof message !== "string" || message === "") {
    throw new Error("ESI mod: a body refusal must say what is wrong with the body.");
  }

  return build(family, 400, { error: message });
}

// Not found

/**
 * `404` for a well-formed id that does not exist.
 *
 * The families word it differently: a legacy route names the entity
 * (`Region not found`, capitalised entity, lowercase `not found`), a validated
 * route says `Not Found` and names nothing. A legacy 404 without an entity
 * throws, because `{"error":"undefined not found"}` reaching a client is worse
 * than a failure at the call site.
 */
function notFound(family, { entity } = {}) {
  assertFamily(family, "a not-found");

  if (family === FAMILY.LEGACY) {
    if (typeof entity !== "string" || entity === "") {
      throw new Error("ESI mod: a legacy 404 must name the entity: CCP's wording is `<Entity> not found`.");
    }
    return build(family, 404, { error: `${entity} not found` });
  }

  if (family === FAMILY.VALIDATED) {
    return build(family, 404, { status: 404, error: "Not Found" });
  }

  return build(family, 404, { error: "Not Found" });
}

// The two that belong to no family

/**
 * A path no route matched, and an unknown version prefix, which are the same
 * answer: Go's default handler, plain text, 19 bytes, and one of the few
 * responses that carries `nosniff`.
 */
function unrouted() {
  return {
    status: 404,
    headers: {
      "content-type": UNROUTED_CONTENT_TYPE,
      "x-content-type-options": "nosniff",
    },
    body: UNROUTED_BODY,
  };
}

/**
 * `405`, with no body and no `content-type`, not the JSON error shape.
 *
 * `allow` becomes repeated header lines, as CCP sends them. `null` means no
 * `Allow` at all, which is what CCP does when the request was a HEAD.
 */
function methodNotAllowed(allow) {
  return {
    status: 405,
    headers: allow === null || allow === undefined ? {} : { allow: [...allow] },
  };
}

// 500

/**
 * Not observed: inducing a 500 on live ESI is not something to look for. Shaped
 * like the family CCP uses for everything else, and deliberately opaque: the
 * stack goes to the game server's log, never to a client.
 */
function internalServerError() {
  return build(FAMILY.EDGE, 500, { error: "Internal server error. See the server log." });
}

module.exports = {
  FAMILY,
  FAMILY_BY_PRODUCER,
  CHARACTER_MISMATCH,
  INVALID_TENANT,
  MISSING_REQUIRED_ROLE,
  NOT_IN_CORPORATION,
  SHAPE,
  UNAUTHORIZED_REASONS,
  UNROUTED_BODY,
  UNROUTED_CONTENT_TYPE,
  coercionFailed,
  edgeRefusal,
  familyFor,
  internalServerError,
  invalidBody,
  invalidTenant,
  methodNotAllowed,
  missingRequiredRole,
  notInCorporation,
  notFound,
  pageBelowMinimum,
  pageBeyondEnd,
  characterMismatch,
  unauthorized,
  unauthorizedScope,
  unrouted,
};
