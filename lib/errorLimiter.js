/**
 * eve.js-mod-esi: the error limiter.
 *
 * `X-Esi-Error-Limit-Remain` and `X-Esi-Error-Limit-Reset`, and the `420` that
 * follows when a caller has spent the budget they describe.
 *
 * Vanilla eve-nexum's `esiFetch` wrapper reads both headers off every response
 * and globally blocks every request it would otherwise make once `Remain`
 * reaches zero or a `420` arrives, easing off below ten remaining and sleeping
 * for `Reset` seconds. A replica that never sends them leaves that client with
 * `undefined` where it expected a number.
 *
 * A response carries one limiter or the other, never both. ESI runs two
 * limiters and a response carries exactly one family, or none: seventeen
 * requests across both producers, successes, refusals and two `304`s, and not
 * one carried both. `contract/wire.js` `LIMITER_SURVEY` is the survey.
 *
 * The selector is the route's published rate-limit group. 135 of the pinned
 * spec's 197 operations declare an `x-rate-limit`, and the token bucket
 * answers for exactly those. The other 62, and every path that routes nowhere,
 * are this file's. So this module is the fallback for a request with no bucket
 * to charge, which is why it answers an unrouted `404`: no route means no
 * group, nothing to take a token from, and a counter keyed on the caller is
 * what is left.
 *
 * The group is asked once, before dispatch, and a request that has one passes
 * through untouched. Asking first also makes a refusal cost nothing, which
 * reading the group off the result would not. That is why `lib/router.js`
 * exposes `rateLimitGroupFor` as a question about the route table rather than
 * a field on the response.
 *
 * The `405` that refuses a `HEAD` belongs to the other limiter and the `405`
 * that refuses anything else belongs to this one: the HEAD refusal is made
 * where the route is known, the other in front of it. `rateLimitGroupFor`
 * already encodes that.
 *
 * `/ping` and the CORS preflight carry neither family. Neither reaches this
 * layer (`/ping` is dispatched outside the whole pipeline and the preflight
 * short-circuits in `lib/cors.js`), so there is deliberately no exemption list
 * here: a second place that knows about `/ping` can disagree with the first.
 *
 * `Reset` counts down; it is not the window length. Observed at 42, then 32,
 * then 31 seconds across three requests, and 56 at the start of the next
 * window. A replica sending a constant `60` would make eve-nexum sleep roughly
 * twice as long as needed, since it reads the value as a sleep duration. A
 * counting-down reset implies a fixed 60-second window, floored by
 * `lib/cache.js`'s `windowStart`, the same rule the cache uses to give every
 * request in one window the same `Etag`. Two flooring rules in one codebase
 * would eventually disagree by a second that no header shows. `Reset` is
 * rounded up so it is never `0` while the window is open: a client told to
 * sleep zero seconds retries into the same exhausted window and busy-loops.
 *
 * `Remain` is post-charge. The `404` that spends a unit is answered with the
 * decremented value: `100 -> 99` across the first unrouted `404`, `99 -> 98`
 * across a `400`, `98 -> 97` across a `404`. A `200` and a `304` leave it
 * alone. On the other limiter a revalidation costs a token and on this one it
 * does not; charging it would punish the clients that cache correctly.
 *
 * Unobserved, and therefore marked: everything above came from requests that
 * cost CCP nothing to answer. Seeing a real `420` would mean deliberately
 * exhausting a third party's limiter, so the status, the absent `Retry-After`
 * and the body below are CCP's documented values and a deliberately boring
 * placeholder, carried as claims. `OVER_LIMIT_BODY` is the weakest string in
 * this file. It is duplicated from `contract/wire.js` because `contract/` is
 * test-only and never deployed (D20), and `test/errorLimiter.test.js` asserts
 * the two agree.
 *
 * The `420` sends no `Retry-After`. `Access-Control-Expose-Headers` names
 * `Retry-After`, but CCP documents it on the `429` and not on the `420`, and
 * `Reset` carries the same number. Design constraint 3: fidelity beats hygiene.
 *
 * The key is the source address, whether or not the request was authenticated
 * (observed: D39, `contract/wire.js` `LIMITER_KEY`). CCP documents keying on
 * `applicationID:characterID` when authenticated and on the source IP
 * otherwise; a live 60 second window walked one counter from 100 down to 94
 * across two unauthenticated errors and four different credentials, so the
 * document is wrong about this limiter. `keyFor` carries the readings. The
 * other limiter does key on the credential (`lib/rateLimiter.js`, on the
 * application), so the question was asked twice and neither key is derived
 * from the other.
 *
 * The address is the socket's peer, never `X-Forwarded-For`. A header the
 * client sets is not an identity, and honouring one would let a single caller
 * mint a fresh budget per request. `server.js` made that decision; this file
 * depends on it.
 *
 * A request with no address at all gets a budget that is never stored and never
 * refuses. One shared `"unknown"` bucket would let one unidentifiable caller
 * exhaust every other's budget, and would be the one map entry a hostile client
 * could always reach. A `null` address is not something a client can ask for
 * (the socket had no peer: an in-process dispatch, a torn-down connection, a
 * test double), so exempting it grants nothing. The headers still go out,
 * because the family is decided by the route, and a client that stops seeing
 * them self-throttles.
 *
 * The bound is a memory bound. This runs inside a live game process (README,
 * design constraint 2), so a map keyed on caller-controlled input with no ceiling
 * is a memory-exhaustion bug reachable by anyone who can open a socket. The
 * store is capped and evicts least-recently-used, using the insertion-ordered
 * `Map` that `lib/pagination.js`'s snapshot cache uses. Two properties do the
 * work: a read never allocates (a key with no live entry reports the full
 * budget without being written down, so only a caller that produces errors can
 * occupy a slot, and a flood of successes from a million addresses costs
 * nothing), and the cap is on entries, since an entry is two numbers and a
 * short string.
 *
 * The bound is not an authentication boundary. A caller who can mint identities
 * (a /64 of IPv6, say) can mint budgets and evict its own exhausted entry by
 * rotating through fresh ones. That is equally true of CCP's limiter, since
 * keying on the source IP makes it so.
 */

"use strict";

const { windowStart } = require("./cache");
const { edgeRefusal } = require("./errors");


/**
 * Errors per window, and the value a fresh caller is told it has.
 *
 * CCP's observed number, and the default `createErrorBudget` and
 * `createErrorLimitDispatch` construct with. This module does not read
 * configuration: `config.js` (`ESI_MOD_ERROR_LIMIT_MAX_ERRORS`, D44) resolves
 * an operator override before `loader.js` builds the pipeline and passes it in
 * as `maxErrors`, both functions' own option. This constant stays what CCP was
 * observed enforcing.
 */
const MAX_ERRORS = 100;

/** The window, in seconds. Fixed, which is what a counting-down reset implies. */
const WINDOW_SECONDS = 60;

/** Lowercase here; `lib/headers.js` title-cases on the way to the socket. */
const HEADER_REMAIN = "x-esi-error-limit-remain";
const HEADER_RESET = "x-esi-error-limit-reset";

/** Enhanced Your Calm. Documented by CCP, never observed. See the header. */
const OVER_LIMIT_STATUS = 420;

/**
 * The body of the `420`, and the least trustworthy value in this file.
 *
 * CCP publishes the status and not the body, and the pinned spec documents no
 * `420` response at all. This is a placeholder in the shape an edge refusal
 * has, short and boring: a client acts on the status and the reset, and
 * nothing in the ecosystem survey matches on the string.
 * `contract/wire.js` `LIMITER_UNOBSERVED.errorLimitOverBody` holds the same
 * value, and the test compares them.
 */
const OVER_LIMIT_BODY = "error limit exceeded";

/** CCP documents `Retry-After` on the `429` and not on this. See the header. */
const OVER_LIMIT_SENDS_RETRY_AFTER = false;

/**
 * How many callers to remember at once.
 *
 * An honest deployment (a game server's own tooling, a hub seeder, a toolbar)
 * has tens of distinct addresses, so this is an order of magnitude of headroom,
 * and small enough that the hostile case costs tens of kilobytes.
 */
const DEFAULT_MAX_KEYS = 1024;


/**
 * The bucket key for this request.
 *
 * The source address, regardless of credential. Observed with
 * `scripts/observe-limiter-key.js` against live ESI on 2026-08-25: one
 * address, one 60 second window, `GET /latest/universe/systems/99/` answering
 * `404` each time. `X-Esi-Error-Limit-Remain` counted 100, then 99 and 98
 * unauthenticated, then 97, 96, 95 and 94 across four different credentials
 * spanning two registered applications and two characters. One counter, never
 * partitioned. That rules out every credential-shaped key:
 * `applicationID:characterID`, the application alone and the character alone
 * all predict 99 at the first authenticated cell, and the wire said 97.
 *
 * The documented rule says otherwise: CCP documents keying on
 * `applicationID:characterID` when authenticated and on the source IP only
 * otherwise, with the authenticated half winning. The observation wins over
 * the document (D31), and the document is kept beside it as a claim so the
 * disagreement stays visible.
 *
 * The two limiters do not agree. `lib/rateLimiter.js` keys on the application
 * (three budgets on that address in that window, one per application plus one
 * unauthenticated, with the character half moving nothing) and this one keys
 * on the address; `contract/wire.js` `LIMITER_KEY.limitersAgree` is `false`.
 * Neither limiter's key may be derived from the other's.
 *
 * `contract/wire.js` `LIMITER_KEY` holds the readings and
 * `docs/open-decisions.md` D39 is the decision.
 * `LIMITER_UNOBSERVED.errorLimitKey` still holds CCP's documented sentence as
 * a claim. `test/errorLimiter.test.js` pins both the sentence and this
 * function's behaviour against the record.
 *
 * `null` means "a caller we cannot name", which is not the same as a caller
 * with no budget: see the file header.
 */
function keyFor(request) {
  const address = request && request.remoteAddress;
  return typeof address === "string" && address !== "" ? `ip:${address}` : null;
}

/**
 * Does a response with this status spend a unit?
 *
 * Non-2XX and non-3XX, which over the statuses this replica produces means a
 * refusal costs. The `< 200` half is unreachable (nothing here emits a `1XX`)
 * and is written so the rule reads as the rule.
 *
 * A `5XX` charges, which is a judgement rather than an observation. Only
 * `400`, `404` and `405` were seen to decrement, because inducing a `500` on
 * live ESI is not something to go looking for; CCP describes the error limit as
 * counting errors, and a `500` is one. The argument the other way: on the
 * token bucket a `5XX` is documented to cost zero
 * (`contract/wire.js` `LIMITER_UNOBSERVED.tokenBucketCostServerError`). Our
 * `500` comes from a handler that threw, so if that value holds for this
 * limiter too, this is the one line to change.
 */
function charges(status) {
  return Number.isInteger(status) && (status < 200 || status >= 400);
}

/**
 * Seconds until the current window ends, rounded up.
 *
 * Rounded up so it is never `0` inside an open window: a back-off signal that
 * means "retry now" is worse than no signal. The value is in `1..windowSeconds`,
 * and the window boundary itself reports the full window.
 */
function resetSeconds(at, windowSeconds = WINDOW_SECONDS) {
  const start = windowStart(at, windowSeconds);
  return Math.ceil((start + windowSeconds * 1000 - at) / 1000);
}


/**
 * The per-caller budgets, bounded and least-recently-used.
 *
 * Insertion-ordered, so the coldest key is the first one `keys()` yields and
 * eviction is `delete(keys().next().value)`, the same shape as
 * `lib/pagination.js`'s snapshot cache.
 *
 * `remaining` does not write. That is what makes the bound mean something: an
 * entry appears only when a caller actually spends, so a hostile client cannot
 * fill the map with addresses that never produced an error.
 *
 * An entry from a previous window is treated as no entry, which is also why
 * nothing sweeps: a stale entry costs one slot until LRU reaches it, and
 * reading it gives the same answer as having dropped it.
 */
function createErrorBudget({
  maxErrors = MAX_ERRORS,
  windowSeconds = WINDOW_SECONDS,
  maxKeys = DEFAULT_MAX_KEYS,
} = {}) {
  const entries = new Map();

  /** The live entry for this key in the window `at` falls in, or `undefined`. */
  function live(key, at) {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    return entry.window === windowStart(at, windowSeconds) ? entry : undefined;
  }

  return {
    /** What this caller has left, without writing anything down. */
    remaining(key, at) {
      if (key === null) return maxErrors;
      const entry = live(key, at);
      return entry === undefined ? maxErrors : entry.remaining;
    },

    /** Spend one and report what is left. Clamped at zero; never negative. */
    charge(key, at) {
      // A caller we cannot name is charged and not remembered: the arithmetic it is
      // told is honest for this response, and there is no shared bucket for one
      // anonymous caller to exhaust on behalf of the rest.
      if (key === null) return Math.max(0, maxErrors - 1);

      const window = windowStart(at, windowSeconds);
      const entry = live(key, at);
      const remaining = Math.max(0, (entry === undefined ? maxErrors : entry.remaining) - 1);

      // Delete-and-reinsert: the touched key moves to the hot end of the Map's
      // insertion order, which is the whole of the LRU bookkeeping.
      entries.delete(key);
      entries.set(key, { window, remaining });

      while (entries.size > maxKeys) {
        entries.delete(entries.keys().next().value);
      }

      return remaining;
    },

    get size() {
      return entries.size;
    },

    clear() {
      entries.clear();
    },
  };
}


/**
 * The `420`, carrying the two headers that say when to come back.
 *
 * Built through `lib/errors.js`'s `edgeRefusal`: a refusal made before any
 * route is reached, so it is the gateway's bytes, with `nosniff` and a
 * trailing newline. `edgeRefusal`'s doc says every caller's string is one
 * observed verbatim, and this one is not. It is the exception, marked as such
 * here and in `contract/wire.js`; the alternative was a limiter that never
 * refuses.
 *
 * No `Retry-After`, no `Vary`. The first is CCP's documented behaviour and the
 * second was never observed on this response. The CORS headers arrive from
 * `lib/cors.js`, which wraps this layer, and its expose list names both
 * error-limit headers so a browser client can read them.
 */
function overLimitResult(remaining, reset) {
  const refusal = edgeRefusal(OVER_LIMIT_STATUS, OVER_LIMIT_BODY);
  return {
    ...refusal,
    headers: {
      ...refusal.headers,
      [HEADER_REMAIN]: String(remaining),
      [HEADER_RESET]: String(reset),
    },
  };
}

/** Does `headers` already carry `name`, in any casing? As `lib/cors.js` asks it. */
function has(headers, name) {
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === name);
}


/**
 * Wrap a dispatch so that a request with no rate-limit group is counted, told
 * what it has left, and refused when it has nothing.
 *
 * `lib/pipeline.js` composes it as
 *
 *     clock( cors( errorLimit( rateLimit( bearer( tenant( compatibility(
 *       requestId( cache( router ) ) ) ) ) ) ) ) )
 *
 * outside `cache` because a `304` is decided in there and this layer has to see
 * the final status to know the revalidation cost nothing. Outside `bearer`
 * because a credential refused in front of the router is charged here, and a
 * layer cannot decorate a response it never saw. `lib/pipeline.js` owns the
 * order and the argument for every boundary.
 *
 * `groupFor(request) -> string | null` is injected rather than the router, so
 * the layer is testable against a plain double and the one place that knows how
 * a group is resolved stays `lib/router.js`. Both it and `next` are checked at
 * construction, where a misconfiguration is a startup failure instead of a
 * `500` on every request.
 *
 * Nothing here throws at request time. eve.js's ProcessLifecycle treats an
 * unhandled rejection as fatal (see `server.js`'s header), and a limiter that
 * can kill the game server it protects has inverted its purpose.
 *
 * The clock is read once, before dispatch, and that reading decides the
 * refusal, the charge and the reset. A handler slow enough to straddle a window
 * boundary charges the window it was admitted in.
 *
 * A header the wrapped dispatch set itself wins, the rule `lib/cors.js` and
 * `lib/cache.js` both follow: writing `x-esi-error-limit-remain` next to an
 * `X-Esi-Error-Limit-Remain` would go out as one comma-joined value.
 */
function createErrorLimitDispatch(next, {
  groupFor,
  now = () => Date.now(),
  maxErrors = MAX_ERRORS,
  windowSeconds = WINDOW_SECONDS,
  maxKeys = DEFAULT_MAX_KEYS,
  budget = createErrorBudget({ maxErrors, windowSeconds, maxKeys }),
} = {}) {
  if (typeof next !== "function") {
    throw new TypeError("ESI mod: createErrorLimitDispatch needs a dispatch function to wrap.");
  }
  if (typeof groupFor !== "function") {
    throw new TypeError(
      "ESI mod: createErrorLimitDispatch needs groupFor(request) -> string | null. A route that "
        + "publishes a rate-limit group belongs to the token bucket, and a response carries "
        + "one family or the other and never both, so this layer has to be able to ask.",
    );
  }

  /**
   * The clock, defended.
   *
   * A clock returning something that is not a time is a programming error that
   * would reach `windowStart` and throw on every request. Falling back to the
   * real clock keeps the limiter counting.
   */
  function clockReading() {
    const at = Number(now());
    return Number.isFinite(at) ? at : Date.now();
  }

  return async function errorLimitDispatch(request) {
    // Asked once, before anything is dispatched. A route with a group is the
    // token bucket's, and gets nothing from here.
    const group = groupFor(request);
    if (group !== null && group !== undefined) return next(request);

    const at = clockReading();
    const key = keyFor(request);
    const reset = String(resetSeconds(at, windowSeconds));

    // Refused before dispatch: the request that would have been refused is never
    // answered, which is the only version of this that saves the work.
    if (budget.remaining(key, at) <= 0) {
      // The refusal itself spends nothing. There is nothing left to spend; whether
      // CCP deepens the debt is unobserved.
      return overLimitResult(0, reset);
    }

    const result = await next(request);

    // A dispatch that returned something other than a result (a double, a future
    // layer). Passing it through unchanged beats inventing headers for a response
    // whose status we cannot read.
    if (!result || typeof result !== "object") return result;

    const remaining = charges(result.status)
      ? budget.charge(key, at)
      : budget.remaining(key, at);

    // Post-charge: the 404 that spends the unit is answered with the decremented
    // value, as observed.
    const headers = { ...(result.headers || {}) };
    if (!has(headers, HEADER_REMAIN)) headers[HEADER_REMAIN] = String(remaining);
    if (!has(headers, HEADER_RESET)) headers[HEADER_RESET] = reset;

    return { ...result, headers };
  };
}

module.exports = {
  DEFAULT_MAX_KEYS,
  HEADER_REMAIN,
  HEADER_RESET,
  MAX_ERRORS,
  OVER_LIMIT_BODY,
  OVER_LIMIT_SENDS_RETRY_AFTER,
  OVER_LIMIT_STATUS,
  WINDOW_SECONDS,
  charges,
  createErrorBudget,
  createErrorLimitDispatch,
  keyFor,
  overLimitResult,
  resetSeconds,
};
