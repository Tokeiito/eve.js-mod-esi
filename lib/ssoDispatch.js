/**
 * eve.js-mod-esi: the SSO listener's dispatch.
 *
 * Exact-match routing, deliberately not `lib/router.js` and not `lib/pipeline.js`. D6 put SSO on
 * its own listener, and two of its reasons are reasons not to reuse the ESI stack behind it:
 *
 *   The error limiter must not cover token traffic. ESI runs a 100-errors-per-60-seconds budget
 *   that answers `420` across the whole surface once spent (`lib/errorLimiter.js`). A client
 *   looping on a stale refresh token would burn it, and on a shared pipeline would take the
 *   public read surface down. Separate listeners keep the limiters separate for free, but only if
 *   the second listener does not mount the limiter itself.
 *
 *   `/v2/oauth/token` is a literal path, not a version prefix. `docs/d6-listener-split.md` says:
 *   "the version-prefix dimension is ESI's alone. `/v2/oauth/*` is on the other listener and
 *   never enters the ESI route table." `lib/router.js` would read that `v2` as its own dimension
 *   and refuse the route at construction (`compilePathPattern` throws for a path starting with a
 *   version prefix). That refusal is correct: the router is saying it is the wrong tool.
 *
 * The rest follows. No compatibility-date layer: `X-Compatibility-Date` is a fact about ESI's
 * surface, and CCP's SSO host has never been observed to have an opinion about it. No tenant
 * layer: `?datasource=` is an ESI query parameter. No rate-limit groups: those come from CCP's
 * OpenAPI document, which describes ESI and contains none of these paths. No `X-Esi-Request-Id`
 * or `X-Esi-Cache-Status`. Each absence is a header `login.eveonline.com` does not send, and each
 * would have been inherited by reusing the ESI pipeline.
 *
 * Route contract. Every SSO route module exports a factory returning a frozen object:
 *
 *   { paths: ["/exact/path", ...], handle(request) -> { status, headers, body } }
 *
 * `request` is what `server.js`'s `parseRequest` produces (`method`, `pathname`, `query`,
 * `headers`, `body`), so a route is testable by calling `handle` with an object literal.
 * `handle` owns three things this file does not do for it:
 *
 *   its method check, and the `405` plus `Allow` that refuses one. A central method table would
 *   be a second place to state what a route accepts.
 *
 *   its CORS headers and cache headers. On the ESI side those are pipeline layers because there
 *   are 197 operations and one policy; here there are a handful of documents and no observed
 *   policy (see `contract/sso.js` `UNOBSERVED`), so each route states what it sends and marks
 *   which parts are ours rather than CCP's.
 *
 *   its body, as a string. Member order and the final byte are then the route's decision, not an
 *   accident of a `JSON.stringify` downstream. CCP's documents have an observed member order that
 *   no serializer would reproduce by chance, and whether the body ends in a newline is
 *   unobserved. `server.js` writes a string body verbatim.
 *
 * Exact matching, nothing normalized. `request.pathname` is compared to the route's paths as a
 * string: no trailing slash folding, no case folding, no percent-decoding. The discovery document
 * is served at `/.well-known/oauth-authorization-server` and at the same path with a trailing
 * slash, because CCP publishes the first and the EVE client asks for the second. A dispatch that
 * folded the slash would collapse two facts into one. Two entries in a table, both asserted, is
 * the honest shape.
 */

"use strict";

/** A malformed SSO route table. Thrown at construction, never at request time. */
class SsoRouteTableError extends Error {
  constructor(message) {
    super(message);
    this.name = "SsoRouteTableError";
  }
}

/**
 * What to call a route in an error message, before we know it is well-formed.
 *
 * A route that failed validation may have no `name`, no `paths`, or not be an
 * object at all, so this degrades through all three rather than throwing while
 * composing the message about a throw.
 */
function describeRoute(route, index) {
  if (route && typeof route === "object") {
    if (typeof route.name === "string" && route.name !== "") return route.name;
    if (Array.isArray(route.paths) && typeof route.paths[0] === "string") {
      return `the route at ${route.paths[0]}`;
    }
  }
  return `SSO route #${index}`;
}

/**
 * Build the dispatch `server.js` is handed for the SSO listener.
 *
 * Validation happens here, at construction, for the reason `createRouter` gives on the ESI side:
 * a table with a mistake should fail at boot naming the route, not on the one request that
 * reaches it. On this surface the argument is stronger: an unreachable `token_endpoint` is not
 * noticed until a client's access token expires, twenty minutes after everything looked fine.
 *
 * A duplicate path is an error rather than last-wins, because two routes mounting the same path
 * is the collision that should be loud.
 *
 * @param {Array<{paths: string[], handle: Function, name?: string}>} routes
 * @returns {(request: object) => Promise<{status: number, headers?: object, body?: string}>}
 */
function createSsoDispatch(routes) {
  if (!Array.isArray(routes)) {
    throw new SsoRouteTableError("ESI mod: the SSO route table must be an array.");
  }

  // Path -> route, which is both the lookup and the duplicate check. A Map
  // rather than a plain object so that a path like `__proto__` (which nothing
  // will serve, and which an attacker would try) is a key and not a prototype
  // write.
  const byPath = new Map();

  routes.forEach((route, index) => {
    const label = describeRoute(route, index);

    if (route === null || typeof route !== "object") {
      throw new SsoRouteTableError(`ESI mod: ${label} is not an object.`);
    }
    if (!Array.isArray(route.paths) || route.paths.length === 0) {
      throw new SsoRouteTableError(
        `ESI mod: ${label} declares no paths. An SSO route is mounted at exact paths: `
          + "one, or several when a surface is reachable by more than one spelling.",
      );
    }
    if (typeof route.handle !== "function") {
      throw new SsoRouteTableError(`ESI mod: ${label} has no handle function.`);
    }

    for (const path of route.paths) {
      if (typeof path !== "string" || !path.startsWith("/")) {
        throw new SsoRouteTableError(
          `ESI mod: ${label} declares the path ${JSON.stringify(path)}, which is not an `
            + 'absolute path starting with "/".',
        );
      }
      if (byPath.has(path)) {
        throw new SsoRouteTableError(
          `ESI mod: ${label} and ${byPath.get(path).label} both claim "${path}".`,
        );
      }
      byPath.set(path, { label, handle: route.handle });
    }
  });

  return async function ssoDispatch(request) {
    const pathname = request && typeof request.pathname === "string" ? request.pathname : "";
    const matched = byPath.get(pathname);

    // Not routed here.
    //
    // A bodiless 404, as a decision rather than a shortcut. What
    // `login.eveonline.com` answers for an unrouted path is unobserved (no
    // status, no body, no headers), and `contract/sso.js` records the gap rather
    // than a guess. The ESI side's `404 page not found` is Go's, established by
    // curling `esi.evetech.net`, and copying it onto a different origin running
    // different software would invent an observation.
    //
    // So this answers with the one thing that is certainly true, that there is
    // nothing here, and claims nothing else: no body to be byte-compared, no
    // content-type describing a body that does not exist, no CORS header we
    // cannot source. It is ours, not a reproduction, and should be replaced by
    // whatever a `curl -sD -` against CCP eventually shows.
    if (matched === undefined) return { status: 404 };

    return matched.handle(request);
  };
}

module.exports = Object.freeze({
  SsoRouteTableError,
  createSsoDispatch,
});
