/**
 * eve.js-mod-esi: the layer stack, in one place.
 *
 * Nine layers wrap the router. The order is not a style choice: seven of them behave differently
 * depending on which side of another they sit, and every boundary was established by observing
 * live ESI.
 *
 * The stack is built only here, and `loader.js` and the tests call the same function, because the
 * ordering is the behaviour. A test holding its own copy of the order asserts that copy, and a
 * wrong order in production would change nothing it can see.
 *
 *     clock( cors( errorLimit( rateLimit( bearer( tenant( compatibility(
 *       requestId( cache( router ) ) ) ) ) ) ) ) )
 *
 * `clock` is outermost and the only layer that decorates nothing. It stamps one reading on the
 * request so every layer below answers "what time is it" the same way. Threading one `now`
 * function through the stack was not enough: it holds a test still, but in production each layer
 * still called `Date.now()`, with the whole handler between two calls. `lib/requestClock.js` has
 * the sweep that cost.
 *
 * `cors` next. The preflight is answered without routing, and everything below it is decorated,
 * refusals included: a browser that cannot read a refusal cannot act on one.
 *
 * The two limiters are siblings, not a stack. A response carries one family of headers or the
 * other, never both; each asks the same question first and the one whose answer is no passes
 * straight through. They are inside `cors` so a `420` or `429` reaches a browser, and outside
 * `cache` because a `304` is decided there and is priced: free on the error limiter, one token on
 * the bucket. A limiter that saw only the pre-cache status would charge a revalidation as a
 * `200`.
 *
 * `bearer` next, with its depth fixed at both ends by observation. Below `cors`, because a
 * preflight carrying `Origin` and `Access-Control-Request-Method` is answered `204` even with a
 * forged token, so no request that never reaches a route pays for a signature check. Below both
 * limiters, because its refusal carries `X-Esi-Error-Limit-Remain` and the layer that writes
 * that header has to see it. Above `tenant` and `compatibility`, because a bad token beats both
 * of their refusals:
 *
 *   -H "Authorization: Bearer garbage" ".../latest/status/?datasource=nope"
 *     401 {"error":"Unauthorized - Invalid token"}
 *
 * and beats the unrouted `404` and the `405` too: it is the outermost refusal this surface makes.
 * Only half of the credential rule is here. Whether a route required a credential is decided
 * after routing, in `lib/router.js`, and that half loses to the two refusals this one beats.
 * `contract/wire.js` `BEARER` is the evidence.
 *
 * `tenant` and `compatibility` sit inside both limiters, in that order. Their refusals carry the
 * error-limit pair and spend a unit, so the layer that counts has to see them, even on a route
 * the token bucket owns, because a request refused in front of routing never reached the route
 * that owns the bucket.
 *
 * `tenant` is outside `compatibility`, and the boundary is one request wide:
 *
 *   -H "X-Compatibility-Date: nope" ".../latest/status/?datasource=nope"
 *     400 {"error":"Invalid tenant"}
 *
 * Two refusals were available and CCP picks that one, so the order is observed rather than
 * chosen. The layers are otherwise near-identical (same status, family and limiter), which is
 * why the one distinguishing fact is also written in `lib/tenant.js`.
 *
 * `requestId` sits between `compatibility` and `cache`; both boundaries are load-bearing. Inside
 * `compatibility`, because the application stamps `X-Esi-Request-Id` and a bad-date refusal is
 * the gateway's (the producer test gets that right without a rule, but only if the refusal never
 * reaches this layer with an application result's shape). Outside `cache`, because a `304` is a
 * response and gets its own id: the layer that builds one rebuilds its headers from a named list,
 * so an id written deeper would be dropped, and one carried through that list would be the
 * previous response's.
 *
 * `cache` is innermost, wrapping the router, because it turns a response into a `304` and needs
 * the response to exist first.
 *
 * `groupFor` is the selector both limiters use. It is asked of the request, not the path,
 * because a refusal made in front of routing has no bucket to charge. `/latest/status/`
 * publishes the group `status` and is answered by the token bucket; the same path with a bad
 * tenant or malformed compatibility date comes back on the error limiter, because it never
 * reached the route that owns the bucket. The same rule governs the two `405`s: the one refusing
 * a HEAD knows its route and the one refusing a POST does not.
 *
 * So it asks all three pre-routing questions, in the order the layers answer them, and the tenant
 * and date are each parsed twice: once here, once by the layer that refuses on them. The
 * credential is not verified more than once, though three places ask for it: `groupFor`, the
 * token bucket (which keys on the application the credential names, D39), and the layer that
 * refuses on it. That is an RSA verification rather than a string comparison, so
 * `lib/bearerCredential.js` memoises the reading per request. The alternative was the two
 * limiters reading each other's results after the fact, a permanent coupling between modules that
 * currently share only a question.
 *
 * Not in the stack: `/_mod/health` and `/ping`, which `loader.js` dispatches outside it. Health
 * is ours and never ESI's; `/ping` carries no CORS, no cache headers and no limiter headers
 * (`contract/wire.js` `SENDS_CORS`, `SENDS_CACHE_HEADERS`, `LIMITER_SURVEY`), reproduced by never
 * letting it reach a layer rather than by stripping afterwards.
 */

"use strict";

const { createBearerCredentialDispatch, readCredential } = require("./bearerCredential");
const { createCacheDispatch } = require("./cache");
const { createCompatibilityDispatch, readCompatibilityDate } = require("./compatibility");
const { createCorsDispatch } = require("./cors");
const { createErrorLimitDispatch } = require("./errorLimiter");
const { createRateLimitDispatch } = require("./rateLimiter");
const { createRequestClockDispatch } = require("./requestClock");
const { createRequestIdDispatch } = require("./requestId");
const { dispatchRequest } = require("./router");
const { createTenantDispatch, readTenant } = require("./tenant");

/**
 * Which token bucket a request would be charged to, or `null` for a request that belongs to the
 * error limiter.
 *
 * Exported so a test can ask it directly: the rule that a pre-routing refusal has no bucket is
 * the least obvious thing in this file, and easier to assert as a function than to infer from a
 * header two layers later.
 */
function createGroupFor(router, { now = () => Date.now(), verifier = null } = {}) {
  return function groupFor(request) {
    // All three pre-routing refusals, in the order they are made. Any one of
    // them means the request never reached the route that owns a bucket, so
    // there is no bucket to charge and the error limiter answers (observed on
    // `/latest/status/`, which the token bucket otherwise owns).
    //
    // The credential is asked first because it outranks the other two on the
    // wire: a bad token beats a bad tenant and a bad compatibility date, and
    // beats the 404 and the 405 as well (`contract/wire.js` `BEARER`). Asking
    // in refusal order keeps this function readable as the precedence it is.
    //
    // It is also the one that is not free; see `lib/bearerCredential.js` on
    // why the reading is memoised rather than repeated for each limiter.
    if (readCredential(request, verifier).refusal) return null;
    if (readTenant(request).refusal) return null;
    if (readCompatibilityDate(request, { now: now() }).refusal) return null;

    return router.rateLimitGroupFor(request.method, request.pathname);
  };
}

/**
 * The ESI surface: every layer, wrapped around one router, in the one order.
 *
 * `now` is injected into every layer that reads a clock, so a test can hold the whole stack
 * still with one function, and it is called once per request rather than once per layer.
 * `clock` takes the reading at the top and `request.receivedAt` carries it down, which closes
 * the race between the page snapshot and the `Last-Modified` describing it: a TTL boundary
 * crossed mid-handler moves the whole response to the same window instead of splitting it.
 */
function createEsiDispatch(
  router,
  {
    logError = () => {},
    now = () => Date.now(),
    verifier = null,
    log = () => {},
    // D44. Left `undefined`, `createErrorLimitDispatch`'s own default parameter
    // applies (`lib/errorLimiter.js` `MAX_ERRORS`, CCP's observed 100), the
    // same "the callee's default is the truth" shape `verifier = null` and
    // `logError = () => {}` already have here. A configured deployment threads
    // its own budget through `loader.js`; nothing else in this file changes.
    errorLimitMaxErrors = undefined,
  } = {},
) {
  if (!router || typeof router.rateLimitGroupFor !== "function") {
    throw new TypeError("ESI mod: createEsiDispatch needs a router from createRouter.");
  }

  const groupFor = createGroupFor(router, { now, verifier });

  return createRequestClockDispatch(
    createCorsDispatch(
      createErrorLimitDispatch(
      createRateLimitDispatch(
        createBearerCredentialDispatch(
        createTenantDispatch(
          createCompatibilityDispatch(
            createRequestIdDispatch(
              createCacheDispatch(
                (request) => dispatchRequest(router, request, { logError, now }),
                { now },
              ),
            ),
            { now },
          ),
        ),
        { verifier, log },
        ),
        {
          groupFor,
          now,
          // The route table's own groups, so a route declaring a group CCP does
          // not publish fails here, at boot, naming the route, rather than
          // quietly going unmetered on the one request that reaches it. Same
          // bargain as the router's own construction-time validation.
          groups: router.routes.map((route) => route.rateLimitGroup),
          // The same verifier `bearer` is given, four lines below. The token
          // bucket keys on the application (D39), and this layer sits outside the
          // one that stamps `request.credential`, so it has to read the credential
          // itself. It is free: `groupFor` above already asked, and
          // `lib/bearerCredential.js` memoises the answer per request.
          verifier,
        },
        ),
        // D44. `maxErrors` is `createErrorLimitDispatch`'s own option name;
        // `undefined` here (the unconfigured default above) leaves its default
        // parameter (CCP's observed 100) in charge, exactly as if this file
        // never mentioned it.
        { groupFor, now, maxErrors: errorLimitMaxErrors },
      ),
    ),
    { now },
  );
}

module.exports = {
  createEsiDispatch,
  createGroupFor,
};
