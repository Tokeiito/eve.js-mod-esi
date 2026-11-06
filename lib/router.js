/**
 * eve.js-mod-esi: router.
 *
 * Maps `method + path` to a plain function. A route handler never sees `req` or
 * `res`:
 *
 *   handler(params, deps) -> data            (or a promise of data)
 *
 * `params` is everything the request said, already parsed. `deps` is everything
 * the handler may reach: the config, a logger, and the runtime accessors. A
 * handler that needs game data asks `deps` and does not require it, the
 * injection rule `lib/runtimeAccess.js` is built on. Every endpoint is
 * testable by calling a function with two object literals: no socket, no port,
 * no game.
 *
 * Ported from `nexumApi/lib/router.js`. Kept: `(params, deps)` handlers,
 * three-outcome resolution, construction-time validation, `:name` params and
 * nothing more expressive. Dropped: `assertKnownQueryKeys`, because real ESI
 * ignores unknown query parameters and fidelity beats the house rule.
 *
 * Version dimension: a route's path is written once, canonically, with no
 * version prefix and no trailing slash (`/status`,
 * `/universe/systems/:system_id`), matching how CCP's spec names it. Nine
 * prefixes are a dimension of the router:
 *
 *   /status/  /latest/status/  /legacy/status/  /dev/status/  /v1/ .. /v6/
 *
 * All reach the same handler and all pin to compatibility date `2020-01-01`
 * (D4). The prefix is optional, the trailing slash is irrelevant, and `/v7/` is
 * not a prefix: it is a 404, identical to a path nobody routed. Writing a prefix
 * into a route's path is a construction error, because it would work for one
 * prefix and fail for the other eight.
 *
 * Other dimensions: each route declares its OAuth `scope` (`null` for public),
 * `rateLimitGroup`, `cacheTtl` in seconds, and `producer`. The router mostly
 * carries these so that scope enforcement, the token-bucket limiter and
 * `Expires` are table-driven rather than reimplemented per handler.
 *
 * `successStatus` is the status a successful dispatch carries. Dispatch
 * hardcoded `200` until `POST /ui/autopilot/waypoint/` needed a bare `204`, so
 * "every route answers 200" is not a property of ESI.
 *
 * `subject` makes an ownership question compulsory. A `scope` says the caller
 * may read fleets, not that they may read that fleet. The router once asked the
 * second question only of a path parameter literally named `character_id`, so
 * `/corporations/:corporation_id/contacts` and `/fleets/:fleet_id/members` would
 * have been gated by the scope alone. `compileRoute` refuses to compile a scoped
 * route keyed by an entity that says nothing about who may read it. See
 * `SUBJECT`.
 *
 * `rateLimitGroup` is needed before the handler runs. `cacheTtl` and `producer`
 * ride out on the result, because the layers that want them decorate an existing
 * response. A limiter refuses a request without answering it, so it must know
 * the bucket before dispatch, and `rateLimitGroupFor` asks the route table
 * directly. Putting it on the result as well would declare one route fact twice.
 *
 * One implementation per route: ESI is two implementations behind one hostname,
 * and a route belongs to one of them. That single fact decides its success
 * `content-type` and trailing newline, its error shape and status codes, its
 * `Cache-Control` form and what `Expires` is measured from, and how it answers a
 * conditional request and what its `304` carries. The table states the cause
 * (`producer`) and derives the rest.
 *
 * It was two fields (`successProducer` and `errorFamily`) until fetching a
 * success and a refusal from the same route, six routes over, gave six
 * agreements and no exceptions. The apparent independence came from comparing
 * one route's success with another's error (`/alliances/` and
 * `/alliances/{alliance_id}/` are different routes). Two fields could be set to a
 * combination that does not exist on the real surface.
 *
 * `scope`, `rateLimitGroup` and `cacheTtl` are published in CCP's pinned spec,
 * so the table must not drift from them: `contract/spec.js` has
 * `assertRouteMatchesSpec`. `producer` is in no spec (OpenAPI has no vocabulary
 * for it), so it comes from observation, and `contract/wire.js` holds the
 * survey. All are declared here rather than read at runtime because `contract/`
 * is test-only and never deployed (D20).
 *
 * Pagination: a route that paginates declares `pageSize`, and then its handler
 * is asked for the whole collection rather than a page (the framework slices, so
 * `X-Pages` and the body cannot disagree), and once per cache window rather than
 * once per request, because a client sweeping 34 pages against a live game
 * server needs those responses to describe one collection. This lives in the
 * router rather than a wrapping layer because pagination decides which handler
 * call happens at all. `lib/pagination.js` owns the mechanics; the router owns
 * which route it applies to.
 *
 * HEAD: reproduced from observation, and it looks like a bug because it is
 * CCP's. `Allow` advertises `HEAD` alongside `GET`, and `HEAD /status/` is
 * answered `405` anyway; that 405 carries no `Allow` header, while a 405
 * answering a `POST` does. Design constraint 3: fidelity beats hygiene. Node
 * answers HEAD from the GET handler by default, so refusing it is something this
 * file has to do.
 */

"use strict";

const {
  familyFor,
  internalServerError,
  methodNotAllowed,
  pageBeyondEnd,
  characterMismatch,
  unauthorized,
  unauthorizedScope,
  unrouted,
} = require("./errors");
const { PRODUCER } = require("./serialize");
const { CACHE_STATUS, sendsCacheStatus, windowStart } = require("./cache");
const {
  createSnapshotCache,
  pageCount,
  parsePage,
  slicePage,
  snapshotKey,
} = require("./pagination");
const {
  COMPATIBILITY_DATE,
  VARY_LOCALIZED_EXTRA,
  VARY_ROUTED,
  VARY_UNROUTED,
} = require("./compatibility");
const { contentLanguageFor } = require("./language");
const { readingFor } = require("./requestClock");

// Constants

/**
 * The prefixes that resolve, observed against live ESI. Nine: three names and
 * six numbers. `/v6/` resolves, `/v7/` does not: the numbered range is closed.
 *
 * `contract/spec.js` keeps its own copy for mapping a wire path onto a spec
 * path, because `contract/` cannot be imported from deployed code.
 * `test/router.test.js` asserts the two agree.
 */
const VERSION_PREFIXES = Object.freeze([
  "latest",
  "legacy",
  "dev",
  "v1",
  "v2",
  "v3",
  "v4",
  "v5",
  "v6",
]);

const PREFIX_SET = new Set(VERSION_PREFIXES);

// `COMPATIBILITY_DATE` is `lib/compatibility.js`'s, imported above. Every prefix
// pins to it (D4). The header a client sends is not ignored, contrary to what
// D11 assumed.

/** A malformed route table. Thrown at construction, never at request time. */
class RouteTableError extends Error {
  constructor(message) {
    super(message);
    this.name = "RouteTableError";
  }
}

/**
 * A refusal a handler decided on, as a throw.
 *
 * A handler once returned only a body, so the only status it could produce was
 * `200`; the one refusal a route could make (`?page=0`) was made by `parsePage`
 * before the handler ran. That stops working when a question needs game state:
 * "is this caller a member of the corporation whose contacts they ask for?"
 * cannot be asked in `authorise()` where the other gates live, and must not be
 * asked after the body is built, because a handler that reads a corporation's
 * contacts and then decides whether the caller was allowed has already done the
 * read. The handler asks first and throws this to refuse.
 *
 * A throw rather than a returned wrapper, because a wrapper makes every
 * handler's return type a union, and a handler that forgets returns its refusal
 * as a body: a `200` whose JSON is an error object. A throw cannot be mistaken
 * for a body.
 *
 * `dispatchRequest` catches it and dresses it with `routedRefusal`. It is
 * deliberately not logged: unlike every other throw on that path, it is an
 * answer the route meant to give.
 */
class RouteRefusal extends Error {
  constructor(refusal) {
    super(`ESI mod: route refused with ${refusal && refusal.status}`);
    this.name = "RouteRefusal";
    this.refusal = refusal;
  }
}

/**
 * How a scoped route decides the caller may read this entity.
 *
 * Distinct from the scope check: a scope says "this token may read fleet
 * rosters", not "this token may read that fleet's roster". The router once asked
 * the second question only of a path parameter literally named `character_id`,
 * so a route keyed by any other id (`/corporations/:corporation_id/contacts`,
 * `/fleets/:fleet_id/members`) fell through with the scope check as its only
 * guard, and any token bearing the scope could read any corporation's contacts
 * or any fleet's roster.
 *
 * That was the default for a route shape nobody had written, not a decision.
 * The fix is to make the absence of a check impossible to leave implicit:
 * `compileRoute` refuses to compile a scoped route keyed by an entity that says
 * nothing about who may read it. The same bargain `producer` and `pageSize`
 * take: a boot failure naming the route, rather than a silent wrong answer on
 * the one request that reaches it.
 */
const SUBJECT = Object.freeze({
  /**
   * The caller is the entity: the token's subject must equal the path's
   * `character_id`.
   *
   * The default for a route keyed by `character_id` and nothing else, so
   * `routes/characters.js` needs no declaration; the rule below only bites for
   * entity kinds that had no check.
   */
  CALLER: "caller",

  /**
   * The scope is the whole gate, deliberately and on the record.
   *
   * For a route where every holder of the scope may read every instance. It makes
   * "we thought about this entity and the scope is enough" reviewable, rather than
   * indistinguishable from "nobody thought about it".
   */
  SCOPE_ONLY: "scope-only",
});

/**
 * Path parameters that name an entity somebody could be denied access to.
 *
 * The heuristic is `_id`, deliberately broad: a false positive costs a route one
 * explicit `subject` declaration, while a false negative is the silent hole this
 * mechanism closes. A public route is never asked; the rule applies only where a
 * scope is declared, so `/markets/:region_id/orders` is unaffected.
 */
const ENTITY_PARAM = /_id$/;

/**
 * The statuses a route may declare as its success.
 *
 * `200` and `204`, the two this replica has been observed sending.
 * `server.js` `BODILESS_STATUSES` is the other half of the `204`: it already
 * omits the body and the `Content-Length`, so nothing below the router needs
 * teaching.
 */
const SUCCESS_STATUSES = new Set([200, 204]);

// Path patterns

/**
 * `/universe/systems/:system_id` -> [{ literal: "universe" }, ..., { param: "system_id" }]
 *
 * Empty segments are dropped, so `/a//b/` and `/a/b` are the same path: a client
 * that builds a URL by joining strings should not get a 404 for it.
 */
function compilePathPattern(pattern) {
  if (typeof pattern !== "string" || !pattern.startsWith("/")) {
    throw new RouteTableError(`ESI mod: route path must start with "/", got ${JSON.stringify(pattern)}.`);
  }

  const segments = pattern.split("/").filter((segment) => segment !== "");

  if (segments.length > 0 && PREFIX_SET.has(segments[0])) {
    throw new RouteTableError(
      `ESI mod: route path "${pattern}" starts with the version prefix "${segments[0]}". `
        + "The prefix is a dimension of the router, not part of a path: write the canonical path "
        + "and every prefix will reach it.",
    );
  }

  return segments.map((segment) =>
    segment.startsWith(":")
      ? { param: segment.slice(1) }
      : { literal: decodeURIComponent(segment) });
}

/** Split a request path into segments, dropping empties. */
function splitPath(pathname) {
  return String(pathname === undefined || pathname === null ? "/" : pathname)
    .split("/")
    .filter((segment) => segment !== "");
}

/**
 * Match one compiled pattern against a split path. Returns the captured
 * parameters, or null for no match.
 *
 * Captures are percent-decoded, because a caller that puts a name in a path
 * segment escaped it. A malformed escape does not match: whether it deserves a
 * 400 is not the router's decision, and the 404 that results is the answer CCP
 * gives for a path it cannot parse.
 */
function matchPathPattern(segments, actual) {
  if (segments.length !== actual.length) return null;

  const captured = {};
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];

    let decoded;
    try {
      decoded = decodeURIComponent(actual[index]);
    } catch (_) {
      return null;
    }

    if (segment.param !== undefined) {
      captured[segment.param] = decoded;
      continue;
    }
    if (decoded !== segment.literal) return null;
  }

  return captured;
}

/** Is this pattern all literals? Used to sort literals ahead of `:param`s. */
function specificity(segments) {
  return segments.filter((segment) => segment.param !== undefined).length;
}

// The route table

function compileRoute(route, index) {
  if (route === null || typeof route !== "object") {
    throw new RouteTableError(`ESI mod: route #${index} is not an object.`);
  }
  if (typeof route.method !== "string" || route.method === "") {
    throw new RouteTableError(`ESI mod: route #${index} has no method.`);
  }
  if (typeof route.handler !== "function") {
    throw new RouteTableError(
      `ESI mod: route "${route.method} ${route.path}" has no handler function.`,
    );
  }

  const segments = compilePathPattern(route.path);

  // The one thing a route must say about itself: which of ESI's two
  // implementations answers it. Everything else that splits by producer follows
  // from it (the success content-type and trailing newline, the error shape and
  // status codes, the cache headers, the conditional-request rules), because on
  // the real surface they are one fact and not five. Required, because no value is
  // right for both halves, so a missing one is an observation nobody made rather
  // than a default; and it is one `curl -sD -` away.
  if (route.producer === undefined) {
    throw new RouteTableError(
      `ESI mod: route "${route.method} ${route.path}" does not declare producer. `
        + `It is ${Object.values(PRODUCER).join(" or ")}: observe which one answers the real `
        + "endpoint (contract/wire.js SUCCESS_KIND), or null for a route that sends no JSON.",
    );
  }
  if (route.producer !== null && !Object.values(PRODUCER).includes(route.producer)) {
    throw new RouteTableError(
      `ESI mod: route "${route.method} ${route.path}" declares producer `
        + `${JSON.stringify(route.producer)}, which is not one of `
        + `${Object.values(PRODUCER).join(", ")}.`,
    );
  }

  // A paginated route declares its page size here so the framework computes
  // `X-Pages`. A handler that computed it could disagree with the slice it
  // returned, and `X-Pages` disagreeing with the body is the one failure a
  // sweeping client cannot recover from.
  if (route.pageSize !== undefined && route.pageSize !== null) {
    if (!Number.isInteger(route.pageSize) || route.pageSize <= 0) {
      throw new RouteTableError(
        `ESI mod: route "${route.method} ${route.path}" declares pageSize `
          + `${JSON.stringify(route.pageSize)}, which is not a positive integer. Omit it for a `
          + "route that does not paginate.",
      );
    }
    if (route.cacheTtl === undefined || route.cacheTtl === null || route.cacheTtl <= 0) {
      throw new RouteTableError(
        `ESI mod: route "${route.method} ${route.path}" paginates but declares no cacheTtl. The `
          + "TTL is the window a page snapshot is held for, so a paginated route without one has "
          + "no way to keep X-Pages stable across a sweep.",
      );
    }
  }

  // The success status
  //
  // `200` for every route until the waypoint write, hardcoded in the dispatch
  // below. `POST /ui/autopilot/waypoint/` answers `204` with no body, so the
  // status is a route fact like the columns above it.
  //
  // Two values, not "any integer". A status the mod has never sent is one whose
  // headers, body rule and cache behaviour nobody has observed, and the set is
  // widened by an observation rather than by a caller passing a number.
  // `server.js` BODILESS_STATUSES knows `204` and `304`; `304` is `lib/cache.js`'s
  // to send on a conditional request and is never a route's declared success,
  // which is why it is not here.
  if (route.successStatus !== undefined && route.successStatus !== null) {
    if (!SUCCESS_STATUSES.has(route.successStatus)) {
      throw new RouteTableError(
        `ESI mod: route "${route.method} ${route.path}" declares successStatus `
          + `${JSON.stringify(route.successStatus)}, and this replica has only ever been observed `
          + `sending ${[...SUCCESS_STATUSES].join(" or ")} as a route's success. Omit it for 200.`,
      );
    }
    // A page is a slice of a body, and a `204` has no body to slice. The two columns
    // cannot both be meant, and letting pagination win would answer a write endpoint
    // with an empty JSON array.
    if (route.successStatus === 204 && route.pageSize !== undefined && route.pageSize !== null) {
      throw new RouteTableError(
        `ESI mod: route "${route.method} ${route.path}" declares both successStatus 204 and a `
          + "pageSize. A 204 carries no body, so there is nothing to paginate.",
      );
    }
  }

  // Who may read this entity
  //
  // See `SUBJECT`. A scoped route keyed by an entity id must say how the caller is
  // checked against that entity, because the scope only says they may read
  // entities of that kind. The rule is narrow on purpose: it asks nothing of a
  // public route, and a route keyed only by `character_id` keeps the comparison
  // `authorise()` always made.
  const entityParams = segments
    .filter((segment) => segment.param !== undefined)
    .map((segment) => segment.param)
    .filter((name) => ENTITY_PARAM.test(name));
  const needsSubject = entityParams.some((name) => name !== "character_id");

  if (route.subject !== undefined && route.subject !== null) {
    const declared = route.subject;
    const known = declared === SUBJECT.CALLER
      || declared === SUBJECT.SCOPE_ONLY
      || typeof declared === "function";
    if (!known) {
      throw new RouteTableError(
        `ESI mod: route "${route.method} ${route.path}" declares subject `
          + `${JSON.stringify(declared)}, which is not ${SUBJECT.CALLER}, ${SUBJECT.SCOPE_ONLY}, `
          + "or a function (claims, pathParams, deps) => refusal or null.",
      );
    }
    // Both spellings of public, exactly as `assertScope` reads them: a route that
    // omits `scope` and one that declares `null` are the same route.
    if (declared !== SUBJECT.SCOPE_ONLY && (route.scope === undefined || route.scope === null)) {
      throw new RouteTableError(
        `ESI mod: route "${route.method} ${route.path}" declares a subject and no scope. There is `
          + "no caller to compare against on a public route.",
      );
    }
  } else if (route.scope !== undefined && route.scope !== null && needsSubject) {
    throw new RouteTableError(
      `ESI mod: route "${route.method} ${route.path}" declares a scope and is keyed by `
        + `${entityParams.filter((name) => name !== "character_id").join(", ")}, but says nothing `
        + "about who may read that entity. A scope says the caller may read entities of this "
        + "kind, never that they may read this one (see SUBJECT). Declare SUBJECT.CALLER, a "
        + "check function, or SUBJECT.SCOPE_ONLY if the scope really is the whole gate.",
    );
  }

  // A route whose body carries translated text says so, because the `Vary` it
  // sends depends on it and nothing else can tell: the pinned spec declares the
  // `AcceptLanguage` parameter on every operation, `/status/` included, so it
  // cannot be derived from there.
  if (route.localizedBody !== undefined && typeof route.localizedBody !== "boolean") {
    throw new RouteTableError(
      `ESI mod: route "${route.method} ${route.path}" declares localizedBody `
        + `${JSON.stringify(route.localizedBody)}, which is not a boolean. Omit it for a route `
        + "whose body carries no translated text.",
    );
  }

  // A route whose body is one row of a static dump rather than a thing that
  // changes. It declares a function, not a value: the `Expires` in the snapshot is
  // a wall-clock instant that moves at 11:05 every day, so it is read per request,
  // and the etag and `Last-Modified` behind it are memoized by
  // `lib/staticSnapshot.js` rather than by the route table.
  if (route.snapshot !== undefined && route.snapshot !== null && typeof route.snapshot !== "function") {
    throw new RouteTableError(
      `ESI mod: route "${route.method} ${route.path}" declares snapshot `
        + `${JSON.stringify(route.snapshot)}, which is not a function. It is `
        + "`(now) => ({ etag, lastModified, expires })` (see lib/staticSnapshot.js) or absent "
        + "for a route whose body is not part of a shared dump.",
    );
  }

  // A snapshot supplies `Expires` itself, so a TTL beside it is two answers to one
  // question. `contract/spec.js` insists on the same independently: none of these
  // operations publishes an `x-cache-age`, because there is no window to publish
  // (they expire at an instant).
  if (route.snapshot && route.cacheTtl !== undefined && route.cacheTtl !== null) {
    throw new RouteTableError(
      `ESI mod: route "${route.method} ${route.path}" declares both a snapshot and cacheTtl `
        + `${JSON.stringify(route.cacheTtl)}. A snapshot route expires at a wall-clock instant `
        + "rather than after a window, and CCP publishes no x-cache-age for one.",
    );
  }

  return Object.freeze({
    method: route.method.toUpperCase(),
    path: route.path,
    // The spec's operationId is the natural name (`GetStatus`), which makes a log
    // line and a spec lookup the same string.
    name: typeof route.name === "string" && route.name !== "" ? route.name : `${route.method} ${route.path}`,
    segments: Object.freeze(segments),
    handler: route.handler,
    // Public is `null`, never `undefined`: "nobody decided" and "no scope required"
    // must not look alike in a table that gates authentication.
    scope: assertScope(route, route.producer),
    rateLimitGroup: route.rateLimitGroup === undefined ? null : route.rateLimitGroup,
    cacheTtl: route.cacheTtl === undefined ? null : route.cacheTtl,
    // Which of ESI's two implementations answers this route. Validated just above,
    // so `null` here means "declared as sending no JSON" rather than "nobody said".
    producer: route.producer,
    // Derived, never declared: the error shape follows the implementation, and two
    // fields could be set to a combination that does not exist. `null` for a route
    // that sends no JSON and therefore no JSON errors.
    errorFamily: route.producer === null ? null : familyFor(route.producer),
    // Items per page, or `null` for a route that returns its whole collection.
    // Validated just above; a route with one has a `cacheTtl` too.
    pageSize: route.pageSize === undefined ? null : route.pageSize,
    // Does this route's body carry translated text? Decides the fourth `Vary` line.
    // `false` rather than `null`: a body either has names in it or it does not, and
    // every route this replica serves today does not.
    localizedBody: route.localizedBody === true,
    // `/ping` is the only one: it answers bare and 404s under every prefix.
    versioned: route.versioned !== false,
    // The status a successful dispatch carries. `200` unless the route said
    // otherwise.
    successStatus: route.successStatus === undefined || route.successStatus === null
      ? 200
      : route.successStatus,
    // How the caller is checked against the entity in the path. `SUBJECT.CALLER` by
    // default, the comparison `authorise()` made before this column existed; the
    // validation above stops that default from silently covering an entity kind it
    // cannot check.
    subject: route.subject === undefined || route.subject === null
      ? SUBJECT.CALLER
      : route.subject,
    // `(now) => { etag, lastModified, expires }` for a route whose body is one row of
    // a shared static dump, else `null`. Validated just above.
    snapshot: route.snapshot === undefined ? null : route.snapshot,
  });
}

/**
 * The canonical form of a route's path, for collision detection.
 *
 * `/status`, `/status/` and `/latest/status` are one route, so declaring two of
 * them is the same mistake as declaring the same string twice, and must fail at
 * construction rather than resolve by table order on the one request that
 * reaches it. A `:param`'s name does not matter to matching, so
 * `/characters/:id` and `/characters/:character_id` collide too.
 */
function canonicalKey(route) {
  const shape = route.segments
    .map((segment) => (segment.param !== undefined ? ":" : segment.literal))
    .join("/");
  return `${route.method} /${shape}${route.versioned ? "" : " (unversioned)"}`;
}

/**
 * Build a router from a route table.
 *
 * Validation happens here, at construction, so a malformed table fails at server
 * start with a named route rather than on the one request that reaches it. A
 * duplicate is an error rather than last-wins, so two routes adding the same
 * endpoint collide loudly.
 */
function createRouter(routes) {
  if (!Array.isArray(routes)) {
    throw new RouteTableError("ESI mod: the route table must be an array.");
  }

  const compiled = routes.map(compileRoute);

  const seen = new Map();
  for (const route of compiled) {
    const key = canonicalKey(route);
    if (seen.has(key)) {
      throw new RouteTableError(
        `ESI mod: duplicate route "${route.method} ${route.path}": it is the same route as `
          + `"${seen.get(key).method} ${seen.get(key).path}" once the version prefix and trailing `
          + "slash are taken off.",
      );
    }
    seen.set(key, route);
  }

  // Literals ahead of `:param`s, so `/characters/affiliation` cannot be shadowed
  // by `/characters/:character_id` sitting earlier in the table. Sorting here
  // rather than at match time keeps resolution a single pass and makes table order
  // irrelevant, so a merge cannot silently change which handler answers.
  const ordered = Object.freeze([...compiled].sort((a, b) => specificity(a.segments) - specificity(b.segments)));

  return Object.freeze({
    routes: ordered,
    resolve: (method, pathname) => resolveRoute(ordered, method, pathname),
    // Which token bucket a request would be charged to, answered without
    // dispatching it. A limiter that only learns the group from the result has
    // already done the work it was supposed to refuse, so the layer asks first and
    // the router is the only thing that can answer.
    rateLimitGroupFor: (method, pathname) => resolveRoute(ordered, method, pathname).rateLimitGroup,
    // One store per router, because a snapshot is a property of the surface rather
    // than of a request. Empty and free for a table with no paginated route.
    snapshots: createSnapshotCache(),
  });
}

// Resolution

/**
 * Strip a version prefix, if the first segment is one.
 *
 * An unrecognised first segment is left alone and treated as a literal, which
 * makes `/v7/status/` a 404 rather than a special case: no route is called
 * `/v7/status`, so nothing matches.
 */
function stripPrefix(segments) {
  if (segments.length > 0 && PREFIX_SET.has(segments[0])) {
    return { prefix: segments[0], rest: segments.slice(1) };
  }
  return { prefix: null, rest: segments };
}

/**
 * Three-outcome resolution. Path is matched first and method second, which makes
 * an honest 405 possible.
 *
 *   { outcome: "matched", route, pathParams, prefix, compatibilityDate }
 *   { outcome: "method-not-allowed", status: 405, allow: string[] | null }
 *   { outcome: "not-found" }
 *
 * `allow` is `null` (send no Allow header) when the request was a HEAD, because
 * that is what CCP does.
 */
function resolveRoute(routes, method, pathname) {
  const wanted = String(method || "").toUpperCase();
  const { prefix, rest } = stripPrefix(splitPath(String(pathname || "/").split("?")[0]));

  const allowed = [];
  let headCandidate = null;
  let headCandidateParams = null;
  for (const route of routes) {
    // An unversioned route is reachable only bare: `/latest/ping` is a 404.
    if (prefix !== null && !route.versioned) continue;

    const captured = matchPathPattern(route.segments, rest);
    if (!captured) continue;

    // HEAD never matches, even where GET does. See the file header.
    if (route.method === wanted && wanted !== "HEAD") {
      return Object.freeze({
        outcome: "matched",
        route,
        pathParams: captured,
        prefix,
        compatibilityDate: COMPATIBILITY_DATE,
        rateLimitGroup: route.rateLimitGroup,
      });
    }

    allowed.push(route.method);
    // CCP advertises HEAD wherever GET is allowed, and then refuses it.
    if (route.method === "GET") {
      allowed.push("HEAD");
      if (headCandidate === null) {
        headCandidate = route;
        headCandidateParams = captured;
      }
    }
  }

  if (allowed.length > 0) {
    return Object.freeze({
      outcome: "method-not-allowed",
      status: 405,
      allow: wanted === "HEAD" ? null : Object.freeze([...new Set(allowed)].sort()),
      // The 405 that refuses a HEAD is made where the route is known, and the one that
      // refuses anything else is made in front of it. Both are observable: the POST
      // refusal carries `Allow` and the HEAD refusal does not, and the HEAD refusal
      // carries the route's rate-limit headers while the POST refusal falls back to
      // the error limiter (contract/wire.js METHOD_NOT_ALLOWED_LIMITER). One quirk, so
      // it is read off one condition rather than two that could drift apart.
      rateLimitGroup: wanted === "HEAD" && headCandidate ? headCandidate.rateLimitGroup : null,
      // Same condition, same reason, and the second consequence of that quirk: the
      // HEAD refusal knows its route, so a route that requires a credential refuses a
      // HEAD before the 405. Observed, and byte-identical to the GET refusal:
      //
      //   curl -sI https://esi.evetech.net/latest/characters/{character_id}/location/
      //     401, 45 bytes, Vary x3, Content-Language: en,
      //     X-Ratelimit-Group: char-location, Used: 5
      //
      // while a POST to the same path is a 405 carrying `Allow` and the error limiter,
      // credential or no credential.
      route: wanted === "HEAD" && headCandidate ? headCandidate : null,
      pathParams: wanted === "HEAD" && headCandidate ? headCandidateParams : null,
    });
  }

  return Object.freeze({ outcome: "not-found", rateLimitGroup: null });
}

// Dispatch

/**
 * Run a request against a router and return `{ status, headers?, body? }`, the
 * shape `server.js` expects from an injected `dispatch`.
 *
 * `request` is `{ method, pathname, query, body }`, a plain object. Nothing here
 * knows about sockets, so the whole request path is testable without opening a
 * port.
 *
 * The three refusals it can produce (the unrouted 404, the 405 and the 500
 * behind a throwing handler) come from `lib/errors.js`, which owns every
 * non-success response shape. Caching and CORS headers belong to layers that
 * wrap this.
 */
/**
 * The headers that say a route answered, and nothing about how it went.
 *
 * The echo says which surface answered, so it appears exactly when a route
 * answered: not on the unrouted `404` and not on the `405`, both of which
 * reached routing and found nothing. `Vary` is the producer's, because the
 * application repeats `Accept-Language` and the gateway does not.
 *
 * `Content-Language` is here for the same reason: `Vary: Accept-Language` claims
 * the answer depends on what the client asked for, and a response that varies on
 * a header without saying what it settled on tells a client to cache under a key
 * it cannot read back. It is always `en` today; `lib/language.js` has why that is
 * a decision and not a constant (D27).
 *
 * All three are a property of having been answered by this route rather than of
 * having succeeded, so this is its own function: a refusal the route produced
 * carries exactly this set (`routedRefusal`), and the success path is this set
 * plus one (`routedHeaders`). Written once so the two cannot drift; they did, and
 * route-level refusals went out bare.
 */
function routedAnswerHeaders(route, request) {
  return {
    "content-language": contentLanguageFor(request),
    "x-compatibility-date": COMPATIBILITY_DATE,
    // The fourth `Vary` line is the route's, not the producer's: a body with
    // translated text repeats `Accept-Language` and a body of ids and numbers does
    // not, on both producers and on errors as well as successes. Appended here
    // rather than baked into `VARY_ROUTED`, because that table is per-producer and
    // this is not a producer's property.
    vary: [
      ...(VARY_ROUTED[route.producer] || VARY_UNROUTED),
      ...(route.localizedBody ? [VARY_LOCALIZED_EXTRA] : []),
    ],
  };
}

/**
 * The headers a success produced by a route carries: the set above, plus the one
 * header that reports on the cache in front of the body.
 *
 * `X-Esi-Cache-Status` is passed in because only the caller knows whether a
 * snapshot answered. `MISS` is the default because a route that recomputes its
 * body is what a miss is (D28).
 */
function routedHeaders(route, request, cacheStatus = CACHE_STATUS.MISS) {
  const headers = routedAnswerHeaders(route, request);

  // Both of ESI's route-serving implementations report a server-side cache; the
  // `/meta/` surface reports none, and sends no `Etag` and no `Last-Modified`.
  // Read off the same policy row that decides those, rather than a second list of
  // producers that could disagree: "no validators" and "no cache status" are one
  // fact about that surface.
  if (sendsCacheStatus(route.producer)) {
    headers["x-esi-cache-status"] = cacheStatus;
  }

  return headers;
}

/** Add `Vary` to a refusal that came from `lib/errors.js` without one. */
function withVary(result, vary) {
  return { ...result, headers: { ...(result.headers || {}), vary: [...vary] } };
}

/**
 * A refusal a route produced, wearing that route's headers.
 *
 * A route-level refusal is still an answer from the route, and CCP dresses it as
 * one: `contract/wire.js` records `ECHOES_COMPATIBILITY_DATE[APP_ERROR]` as
 * `true` (a `404 {"error":"Region not found"}` carries the echo just as the
 * `200` beside it does) and `VARY_BY_KIND[APP_ERROR]` as the same three lines a
 * success gets. The fourth line follows the route the same way, observed: the
 * `VARY_LOCALIZED_SURVEY` `plain` column lists `400 ?page=0 on
 * /markets/{id}/orders/` by name, so that exact refusal was surveyed and sent the
 * one-line-`Accept-Language` form.
 *
 * `X-Esi-Cache-Status`: this was `routedHeaders` minus that header on every
 * route, because the header had been seen only on the 2XX of both producers, and
 * `?page=0` is refused before the snapshot is looked up. Captures of
 * authenticated routes falsified the general form. Across two runs on
 * 2026-08-25, every refusal from an authenticated route carried
 * `X-Esi-Cache-Status: MISS`: the `403` for a corporation the caller is not in,
 * the `403` for a missing role, the `404` for a pilot in no fleet, and the `404`
 * for a page past the end, which is the same pagination refusal the old rule was
 * written around.
 *
 * So the split is drawn where the evidence is, and no wider. An authenticated
 * route's refusal carries the header (seen five times). A public route's keeps
 * the subtraction, because the one observation behind it (`400 ?page=0` on
 * `/markets/{region_id}/orders`) was a public route and has not been re-run.
 *
 * This is not a tidy rule. The two observations differ in status,
 * authentication and route at once, so which is load-bearing is unknown. One
 * re-capture of `?page=9999` against a public paginated route would collapse it
 * to a single rule; until then this reproduces both halves.
 *
 * The refusal's own headers win the merge, because the shape of a refusal is
 * `lib/errors.js`'s: its `content-type` and `nosniff` come from the error
 * family, not the route.
 *
 * The edge refusals (`FAMILY.EDGE`) are deliberately not routed through here.
 * They are made before a route answered, and `contract/wire.js` records the
 * `401` as carrying no echo at all.
 */
function routedRefusal(refusal, route, request) {
  // See above: observed on authenticated routes, unobserved on public ones.
  const base = route.scope === null
    ? routedAnswerHeaders(route, request)
    : routedHeaders(route, request);

  return {
    ...refusal,
    headers: { ...base, ...staticEtagHeader(route, request), ...(refusal.headers || {}) },
  };
}

/**
 * The one refusal on this surface that carries a cache header.
 *
 * `contract/wire.js` `SENDS_CACHE_HEADERS` records it as the exception to its
 * own rule: a static-data route's `404` carries the snapshot's `Etag` and
 * nothing else (no `Cache-Control`, no `Expires`, no `Last-Modified`).
 *
 *   GET /latest/universe/systems/30099999/
 *   404 {"error":"System not found"}   Etag: W/"a3cbe689..."   X-Esi-Cache-Status: MISS
 *
 * It looks like the snapshot's validator leaking onto a refusal from a
 * static-backed route. Reproducing it means putting it here rather than in
 * `lib/cache.js`, which never sees a non-2XX. It is harmless to a client (an
 * `If-None-Match` carrying it is answered `404` again, since the refusal is not
 * a 2XX for the conditional layer to short-circuit) and is reproduced because it
 * is visible.
 */
function staticEtagHeader(route, request) {
  if (typeof route.snapshot !== "function") return {};
  const facts = route.snapshot(readingFor(request, Date.now));
  return facts === null ? {} : { etag: facts.etag };
}

/**
 * One page of a paginated route.
 *
 * The handler is asked for the whole collection, once per cache window, and
 * every page in that window is a slice of the same array. That keeps `X-Pages`
 * from moving under a client mid-sweep: page 1 and page 34 are two views of one
 * snapshot, not two queries against a game that has moved on.
 *
 * The window is the route's own `cacheTtl`, floored from the request's clock
 * reading (`request.receivedAt`, stamped once at the top of the stack), the same
 * reading `lib/cache.js` floors `Last-Modified` to. That makes the snapshot and
 * the `Last-Modified` describing it unable to disagree; the guarantee comes from
 * there being one reading, not from the two layers using the same formula. When
 * each layer called the clock itself, with the whole handler between the calls, a
 * request that crossed a TTL boundary mid-flight got window N's body under window
 * N+1's `Last-Modified`.
 *
 * `page` is read before the handler runs. A refusal then costs only the parse,
 * which matters on a route whose collection is thirty thousand objects:
 * `?page=0` should not resolve a market's worth of orders to answer with forty
 * bytes.
 */
async function dispatchPaginated(router, request, resolution, params, deps) {
  const { route } = resolution;

  const { page, refusal } = parsePage(params.query, { family: route.errorFamily });
  // `lib/pagination.js` builds the body and `lib/errors.js` the family's shape;
  // neither knows which route asked, so the routed headers are attached here.
  if (refusal) return routedRefusal(refusal, route, request);

  // The request's own reading, the same one `lib/cache.js` floors `Last-Modified`
  // to. See `lib/requestClock.js` for why a second clock call here cost a sweep
  // its consistency.
  const now = readingFor(request, typeof deps.now === "function" ? deps.now : Date.now);
  const window = windowStart(now, route.cacheTtl);
  const key = snapshotKey(route.name, params.path, params.query);

  let items = router.snapshots.get(key, window);
  // The one cache this replica has that a client could be told about: a page
  // served out of a snapshot taken earlier in this window was not recomputed. Read
  // before the fill, because after it every request looks like a hit.
  const cacheStatus = items === undefined ? CACHE_STATUS.MISS : CACHE_STATUS.HIT;
  if (items === undefined) {
    items = await route.handler(params, deps);
    if (!Array.isArray(items)) {
      throw new TypeError(
        `ESI mod: paginated route "${route.name}" must return the whole collection as an array, `
          + `got ${items === null ? "null" : typeof items}. The framework does the slicing.`,
      );
    }
    router.snapshots.set(key, window, items);
  }

  const pages = pageCount(items.length, route.pageSize);
  if (page > pages) return routedRefusal(pageBeyondEnd(route.errorFamily), route, request);

  return {
    status: 200,
    body: slicePage(items, page, route.pageSize),
    producer: route.producer,
    cacheTtl: route.cacheTtl,
    authenticated: route.scope !== null,
    // Sent on every page, including the only page of a one-page collection: a client
    // cannot tell "not paginated" from "one page" by absence, so neither can we.
    headers: { "x-pages": String(pages), ...routedHeaders(route, request, cacheStatus) },
  };
}

/**
 * `scope`, validated now that something reads it.
 *
 * A typo'd scope on a route that requires one is a route nobody can reach, and a
 * non-string is a comparison that silently never matches. Both would boot clean
 * and fail on the one request that mattered. Same bargain as `producer` and
 * `pageSize` above: the table is checked where it is built.
 */
/**
 * A `character_id` path segment this replica will compare against a token's
 * subject: digits, no leading zero, nothing else.
 *
 * The same round trip `lib/bearerToken.js`'s `projectClaims` applies to `sub`,
 * for the same reason: two spellings of one id must not both be that id.
 */
const SUBJECT_SEGMENT = /^[1-9][0-9]*$/;

function assertScope(route, producer) {
  if (route.scope === undefined || route.scope === null) return null;

  // An authenticated route on the gateway has never been observed, and two things
  // downstream refuse to guess at one: `lib/errors.js` will not build its `403`
  // for a character mismatch, and `lib/cache.js` will not pick its
  // `Cache-Control`. Both throw at request time, which would turn an unobservable
  // route into a pair of logged 500s on whichever request hits them first.
  // Refusing here makes it a boot failure naming the route, the same bargain
  // `producer` and `pageSize` take.
  if (producer === PRODUCER.GATEWAY) {
    throw new RouteTableError(
      `route "${route.name || route.path}" declares a scope and the gateway producer, and no `
        + "authenticated gateway route has ever been observed. Its 403 and its Cache-Control "
        + "would both be guesses: see contract/wire.js CHARACTER_MISMATCH and "
        + "AUTHENTICATED_CACHE_CONTROL, and scripts/observe-403.js for the run that would "
        + "settle them.",
    );
  }

  if (typeof route.scope !== "string" || route.scope === "") {
    throw new RouteTableError(
      `route "${route.name || route.path}" declares a scope that is not a non-empty string `
        + `(${JSON.stringify(route.scope)}). Public routes declare no scope at all; a route that `
        + "requires one names it exactly as CCP's spec does.",
    );
  }

  return route.scope;
}

/**
 * The post-routing half of the credential gate, and the half that needs a route.
 *
 * `lib/bearerCredential.js` has decided whether what the client presented
 * verifies. This decides whether this route needed one, which cannot be asked
 * before routing, and the wire agrees: an unrouted path with no credential is a
 * `404` and not a `401`, and a secured route with a bad `datasource` and no
 * credential is a `400 Invalid tenant`. Both refusals this one loses to are made
 * in front of the router.
 *
 * The refusal is `EDGE`: the gateway's bytes, `nosniff`, bare `application/json`,
 * 45 bytes with the trailing newline, carrying the route's `Content-Language` and
 * three `Vary` lines, and neither the compatibility-date echo nor a cache status.
 * That is why `routedHeaders` is not reused: it is right about two of those four
 * and wrong about the other two, and an `EDGE` refusal is not a routed result
 * with a different status.
 *
 *   curl -sD - https://esi.evetech.net/latest/characters/{character_id}/location/
 *     401, Vary x3, Content-Language: en, X-Ratelimit-Group: char-location,
 *     X-Ratelimit-Used: 5, no X-Compatibility-Date, no X-Esi-Cache-Status
 */
function credentialRequired(request) {
  const refusal = unauthorized("no-token");
  return {
    ...refusal,
    headers: {
      // The family's own headers first: the bare `application/json` and the `nosniff`
      // that make it an `EDGE` refusal. Spreading `refusal` and then assigning a fresh
      // `headers` object dropped both, which `lib/errors.js` builds them to prevent.
      ...refusal.headers,
      "content-language": contentLanguageFor(request),
      vary: [...VARY_UNROUTED],
    },
  };
}

/**
 * `401`, for a verified token that does not carry this route's scope.
 *
 * Wears the same headers as the no-credential refusal above, because it is the
 * same kind of refusal in the same seat: the gateway's bytes, decided after
 * routing, so it can name the route's `Vary` and `Content-Language` and cannot
 * echo the compatibility date or report a cache it never consulted.
 *
 *   curl -H "Authorization: Bearer <token without the scope>" https://esi.evetech.net/latest/characters/<id>/wallet/
 *     401, 106 bytes, Vary x3, Content-Language: en,
 *     X-Ratelimit-Group: char-wallet, Used: 5, no X-Compatibility-Date,
 *     no X-Esi-Cache-Status, no X-Esi-Request-Id
 */
function scopeRefused(route, request) {
  const refusal = unauthorizedScope(route.scope);
  return {
    ...refusal,
    headers: {
      ...refusal.headers,
      "content-language": contentLanguageFor(request),
      vary: [...VARY_UNROUTED],
    },
  };
}

/**
 * `403`, for a token whose subject is not the character the path names.
 *
 * The odd one out, and the only real `403` in the gate: it is the application's
 * refusal rather than the gateway's, so it derives its family from the route and
 * wears a routed answer's headers, the compatibility-date echo and a cache status
 * included, both of which the two `401`s beside it lack.
 *
 * That is `routedHeaders` rather than `routedRefusal`, and the difference is one
 * header decided by observation. `routedRefusal` leaves `X-Esi-Cache-Status` off
 * on the argument that it has been seen nowhere but a 2XX; this refusal sends it:
 *
 *   curl -H "Authorization: Bearer <token for character A>" https://esi.evetech.net/latest/characters/<B>/online/
 *     403 {"error":"Character ID mismatch between request path and auth token"}
 *     Content-Type: application/json; charset=UTF-8   (no trailing newline)
 *     X-Compatibility-Date: 2020-01-01
 *     X-Esi-Cache-Status: MISS
 *     X-Esi-Request-Id: <uuid>
 *     X-Ratelimit-Group: char-location, Used: 5
 *
 * The request id is not attached here: `lib/requestId.js` stamps it for an
 * application producer, and this refusal has one, so that layer needs no rule
 * for it.
 */
/**
 * A gate refusal wearing the route's headers.
 *
 * The merge `characterMismatched` has always done, extracted because a
 * route-supplied `subject` check produces the same kind of thing and must not
 * grow a second, subtly different, way of dressing it. The refusal's own headers
 * win: its `content-type` and `nosniff` are the error family's, not the route's.
 *
 * Distinct from `routedRefusal` in `X-Esi-Cache-Status`. It rides on a gate
 * refusal because `characterMismatch` was observed carrying it
 * (`contract/wire.js` `CHARACTER_MISMATCH`), and is absent from a route-produced
 * refusal because `?page=0` was observed without it. Two captures, two
 * behaviours, neither derived from the other.
 */
function gateRefusal(refusal, route, request) {
  return {
    ...refusal,
    headers: { ...routedHeaders(route, request), ...refusal.headers },
  };
}

function characterMismatched(route, request) {
  return gateRefusal(characterMismatch(route.errorFamily), route, request);
}

/**
 * `null` to let the request through, or the refusal that stops it.
 *
 * Three questions, in the order they can be answered: does this route require a
 * credential at all, was one presented, and does it authorise this request. All
 * three have observed answers: the scope refusal is a `401` naming the scope and
 * the character mismatch is the application's `403`. `contract/wire.js`
 * `SCOPE_REFUSAL` and `CHARACTER_MISMATCH` hold the captures, and
 * `scripts/observe-403.js` is the run that produced them.
 */
function authorise(route, request, pathParams, deps) {
  if (route.scope === null) return null;

  const credential = request.credential || null;
  if (credential === null || credential.presented !== true) return credentialRequired(request);

  // Presented and verified: `lib/bearerCredential.js` refused it four layers up
  // otherwise, so a merely bad token never reaches this line.
  const claims = credential.claims;

  // A `401`, not a `403` as one might expect, and not eve-nexum's assumed `401 = no
  // scopes, 403 = scope missing`: both a scopeless token and a wrongly-scoped one
  // come back `401`, byte for byte the same. `contract/wire.js` `SCOPE_REFUSAL` has
  // the two captures.
  if (!claims.scopes.includes(route.scope)) return scopeRefused(route, request);

  // A token for character A must not read character B's data.
  //
  // The comparison is spelled as `projectClaims` spells the same one: it requires
  // the path segment to be a canonical positive integer before comparing, rather
  // than leaning on `Number()`. `Number()` alone accepts `0123123`, `1.23123e5`,
  // `0x1e0f3`, `+123123`, `" 123123 "` and a trailing newline as character 123123,
  // so the gate would say "this is character 123123" and hand the handler
  // `"1.23123e5"`. A handler doing `parseInt(params.path.character_id)` then reads
  // character 1, and at EVE id scale `parseInt("9e7")` is 9: a cross-character read
  // manufactured inside the authorised path.
  //
  // `params.credential` below is the other half of the fix: a handler should never
  // reach for the path string to learn who is asking.
  //
  // Which entity is being asked for, and may this caller have it? See `SUBJECT`.
  // The scope check above said the caller may read fleets; this says whether they
  // may read the one in the path.
  //
  // `SCOPE_ONLY` returns without asking. It is a route author's declaration, not a
  // default: `compileRoute` refuses to compile an entity-keyed scoped route that
  // left this unsaid.
  if (route.subject === SUBJECT.SCOPE_ONLY) return null;

  if (typeof route.subject === "function") {
    // The route's own check, for an entity whose ownership needs game state and
    // therefore cannot be answered here. It returns `null` to allow, a refusal to
    // deny, and it may throw, which `gateOrFail` turns into a logged `500`. That is
    // the honest answer while the real refusal is unobserved: the read is still
    // refused, and the status is loudly wrong rather than quietly invented.
    const refusal = route.subject(claims, pathParams, deps);
    return refusal === null || refusal === undefined
      ? null
      : gateRefusal(refusal, route, request);
  }

  // `SUBJECT.CALLER`: the caller is the entity, and this is the original
  // comparison.
  const declared = pathParams && pathParams.character_id;
  if (declared !== undefined) {
    const canonical = SUBJECT_SEGMENT.test(String(declared));
    if (!canonical || Number(declared) !== claims.characterId) {
      return characterMismatched(route, request);
    }
  }

  return null;
}

/**
 * `authorise`, with its deliberate throw contained.
 *
 * Nothing in `authorise` throws deliberately any more; it did while the `403` was
 * unobserved, and this wrapper turned that into a `500` rather than a rejection
 * escaping the router. It stays because the reason generalises:
 * `characterMismatch` refuses to build a family nobody has observed, so a route
 * table that grows a `VALIDATED` route with a `:character_id` throws here rather
 * than on the socket.
 *
 * Both call sites go through it so the containment cannot be present on one path
 * and missing on the other. It is not the only thing between this module and an
 * unhandled rejection: `server.js` catches what escapes the whole stack, which is
 * what satisfies design constraint 2. This keeps the refusal's shape right:
 * `internalServerError()`'s observed body rather than the listener's generic one.
 */
function gateOrFail(route, request, pathParams, deps) {
  try {
    return authorise(route, request, pathParams, deps);
  } catch (err) {
    if (typeof deps.logError === "function") {
      deps.logError(`route "${route.name}" could not be authorised`, err);
    }
    return internalServerError();
  }
}

async function dispatchRequest(router, request, deps = {}) {
  const resolution = router.resolve(request.method, request.pathname);

  // Both of these reached routing and found nothing to answer with, so both carry
  // `Vary: X-Compatibility-Date` (the answer would have depended on it) and
  // neither carries the echo, because no route produced them.
  if (resolution.outcome === "not-found") return withVary(unrouted(), VARY_UNROUTED);

  if (resolution.outcome === "method-not-allowed") {
    // A HEAD refusal knows its route, so a route that requires a credential refuses
    // first. Everything else never resolved one and cannot. See `resolveRoute`'s
    // note on the outcome this reads.
    if (resolution.route !== null && resolution.route !== undefined) {
      const gate = gateOrFail(resolution.route, request, resolution.pathParams, deps);
      if (gate !== null) return gate;
    }
    return withVary(methodNotAllowed(resolution.allow), VARY_UNROUTED);
  }

  // The post-routing gate, before anything else this route would do: a refusal
  // costs only the check, and the handler must not observe a request it was never
  // allowed to see. Same seat, and same argument, as `parsePage` one call below.
  const gate = gateOrFail(resolution.route, request, resolution.pathParams, deps);
  if (gate !== null) return gate;

  const params = Object.freeze({
    method: resolution.route.method,
    pathname: request.pathname,
    prefix: resolution.prefix,
    compatibilityDate: resolution.compatibilityDate,
    errorFamily: resolution.route.errorFamily,
    path: Object.freeze({ ...resolution.pathParams }),
    // Who is asking, verified: `null` on a public route, and on a route that requires
    // a scope it is the projection `lib/bearerToken.js` built and the gate above has
    // checked. A handler needing the caller's identity reads
    // `params.credential.characterId`, a number that was signed, rather than coercing
    // `params.path.character_id`, a string typed by whoever made the request.
    credential: request.credential && request.credential.claims ? request.credential.claims : null,
    query: Object.freeze({ ...(request.query || {}) }),
    body: request.body === undefined ? null : request.body,
  });

  try {
    if (resolution.route.pageSize !== null) {
      return await dispatchPaginated(router, request, resolution, params, deps);
    }

    const body = await resolution.route.handler(params, deps);

    // A `204` route that returned something is a route whose author thought it was
    // sending a body, and the status says it is not. `server.js` would drop it
    // silently, the one outcome worth refusing: a write endpoint that reports its
    // result in a body nobody transmits looks like it works.
    if (resolution.route.successStatus === 204 && body !== undefined && body !== null) {
      throw new Error(
        `ESI mod: route "${resolution.route.name}" declares successStatus 204 and its handler `
          + "returned a body. A 204 carries none, so the body would be dropped without a trace.",
      );
    }

    return {
      status: resolution.route.successStatus,
      body: resolution.route.successStatus === 204 ? null : body,
      // The route's, not the framework's: `server.js` cannot tell from a body which of
      // ESI's two implementations is supposed to have written it.
      producer: resolution.route.producer,
      // Carried for the same reason, one layer further out: `lib/cache.js` needs the
      // published TTL to write `max-age` and `Expires`, and to decide the window
      // `Last-Modified` and `Etag` are stable across.
      cacheTtl: resolution.route.cacheTtl,
      // And whether a credential was required, for the same layer. `Cache-Control` is
      // not a function of the producer alone: an authenticated route sends `private`
      // where the same producer sends `public` on a public one, and `public` on a
      // response carrying one pilot's location invites a shared cache to hand it to
      // the next pilot. Carried on the result rather than re-resolved, as `producer`
      // and `cacheTtl` are.
      authenticated: resolution.route.scope !== null,
      // The static-data dump's validators, on a route that reads one. Carried rather
      // than computed downstream for the same reason as `producer` and `cacheTtl`:
      // which dump a body came out of is the route's fact, and `lib/cache.js` is
      // decorating a response that already exists.
      //
      // The reading is the request's, so a request that arrives at 11:04:59 and
      // answers at 11:05:01 reports the `Expires` it was routed under rather than one a
      // later call to the clock would produce.
      snapshot: resolution.route.snapshot === null
        ? null
        : resolution.route.snapshot(readingFor(request, typeof deps.now === "function" ? deps.now : Date.now)),
      // No page snapshot on this path, so no hit to report: the handler ran.
      headers: routedHeaders(resolution.route, request),
    };
  } catch (err) {
    // A refusal the handler meant, not a failure. It carries the route's headers like
    // any other route-produced refusal, and is deliberately not logged: an
    // authenticated caller asking for somebody else's fleet is a request answered
    // correctly, and logging it would fill the game server's log with the gate
    // working.
    if (err instanceof RouteRefusal) {
      return routedRefusal(err.refusal, resolution.route, request);
    }

    if (typeof deps.logError === "function") {
      deps.logError(`route "${resolution.route.name}" threw`, err);
    }
    // Opaque on purpose: the stack goes to the game server's log, never to a client.
    // What the body looks like is lib/errors.js's business.
    return internalServerError();
  }
}

module.exports = {
  COMPATIBILITY_DATE,
  RouteRefusal,
  RouteTableError,
  SUBJECT,
  SUCCESS_STATUSES,
  VERSION_PREFIXES,
  canonicalKey,
  compilePathPattern,
  compileRoute,
  createRouter,
  dispatchRequest,
  matchPathPattern,
  resolveRoute,
  splitPath,
};
