/**
 * `GET /ping`: two bytes, and nothing else at all.
 *
 *   HTTP/1.1 200 OK
 *   Content-Type: text/plain
 *   Content-Length: 2
 *
 *   ok
 *
 * This is a special case, not a route. Observed against live ESI, `/ping`
 * carries no CORS headers, no cache headers, no rate-limit headers and no
 * `x-compatibility-date`: it is outside CCP's pipeline. Running it through this
 * mod's pipeline and stripping headers afterwards would reproduce the outcome
 * rather than the structure, and would leak the next header someone adds.
 *
 * So it sits in front: `loader.js` composes this dispatch ahead of the CORS
 * layer and the router, and any request that is not `/ping` falls through.
 * Nothing downstream can decorate what never reaches it.
 *
 * It is not versioned. `/latest/ping` is a 404 on real ESI, Go's plain-text one
 * and not a JSON error. This dispatch matches the bare path only, so a prefixed
 * request drops to the router, which has no `/ping` route and answers as it
 * does for any unrouted path.
 *
 * The body is bytes, not JSON. `"ok"` is written verbatim by `server.js`
 * because it is a string; JSON encoding would add quotes and make it four
 * bytes. No trailing newline: this is not one of the bodies Go's JSON encoder
 * writes.
 */

"use strict";

/** Bare only. A prefixed `/latest/ping` is a 404, not this route's to give. */
const PING_PATH = "/ping";

/** Observed verbatim. `contract/wire.js` PING holds the same three facts. */
const PING_BODY = "ok";
const PING_CONTENT_TYPE = "text/plain";

/**
 * `GET /ping`, or hand on to `next`.
 *
 * Same shape as `createCorsDispatch(next)` in `lib/cors.js`, so `loader.js`
 * composes the layers uniformly and their order is visible in one expression.
 *
 * A non-GET on this path is handed on rather than answered 405. The path is not
 * in the router's table either, so a `POST /ping` gets the unrouted 404, which
 * is what CCP gives it.
 */
function createPingDispatch(next) {
  if (typeof next !== "function") {
    throw new TypeError("ESI mod: createPingDispatch needs the dispatch to fall through to.");
  }

  return function pingDispatch(request) {
    const req = request && typeof request === "object" ? request : {};

    if (req.pathname !== PING_PATH || req.method !== "GET") return next(request);

    return {
      status: 200,
      headers: { "content-type": PING_CONTENT_TYPE },
      body: PING_BODY,
    };
  };
}

module.exports = Object.freeze({
  PING_BODY,
  PING_CONTENT_TYPE,
  PING_PATH,
  createPingDispatch,
});
