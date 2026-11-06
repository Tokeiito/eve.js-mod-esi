/**
 * eve.js-mod-esi: the token bucket.
 *
 * The newer of ESI's two rate limiters, and the one a routed request is charged to.
 * `X-Ratelimit-Group`, `X-Ratelimit-Limit`, `X-Ratelimit-Remaining` and `X-Ratelimit-Used` go
 * out on the response; `429` with `Retry-After` when the bucket cannot pay.
 *
 * One limiter or the other, never both. A response carries one family of limiter headers or
 * none. Seventeen requests across both producers (successes, refusals, two 304s) each carried
 * exactly one; the survey is `contract/wire.js` `LIMITER_SURVEY`. The selector is the route's
 * published rate-limit group: 135 of the pinned spec's 197 operations declare an `x-rate-limit`
 * and are answered here. The other 62, and every path that routes nowhere (so has no bucket to
 * charge), fall to the error limiter. It is not split by producer: `/latest/incursions/` is an
 * application response on the token bucket, and `/v3/alliances/{alliance_id}/` is a gateway
 * response on the error limiter. This layer asks the route table via the injected
 * `groupFor(request)`, which `lib/pipeline.js` wires to `router.rateLimitGroupFor(method, pathname)`.
 * That carries one quirk: a `405` refusing a HEAD reports the route's group, and a `405`
 * refusing anything else reports `null`.
 *
 * The cost table is observed; the refusal is not. Every entry in `COST_BY_CLASS` was read off a
 * live `X-Ratelimit-Used`: `2` on each 200, `1` on the 304, `5` on the 400, 401, 422 and the HEAD
 * 405. `Remaining` is the count after the charge. A real `429` cannot be observed without
 * exhausting CCP's limiter, so the `429`, its `Retry-After`, the free `5XX`, the free `429`,
 * the continuous refill and the body string are CCP's documentation plus this module's choices.
 * They are marked in `contract/wire.js` `LIMITER_UNOBSERVED` and asserted against it by
 * `test/rateLimiter.test.js`. `OVER_LIMIT_BODY` is deliberately boring: clients act on the
 * status and `Retry-After`, and nothing in the ecosystem survey matches the string.
 *
 * Ask before, charge after. The group is known before dispatch and the cost is not known until
 * the response is: check that the bucket can pay anything, dispatch, then charge what the
 * status class costs. Asking first matters because a limiter that refuses after the handler ran
 * has already done the work, on the event loop the universe ticks on. When the charge exceeds
 * the balance (3 tokens, a `4XX` costing 5), the charge is clamped at zero: CCP's `Remaining`
 * was never observed below zero, and a bucket carrying debt lets a client talk itself into a
 * longer lockout than the limit describes. `Used` reports what was actually deducted, so
 * `Remaining` and `Used` on one response add up. Whether CCP does the same is unobserved.
 *
 * One bucket per (group, caller). A per-group global bucket would let one caller exhaust
 * `market-order` for everybody. The caller is the application when the request carried a
 * credential this replica verified, and `request.remoteAddress` otherwise. That is an
 * observation, not CCP's documentation: `scripts/observe-limiter-key.js` ran on 2026-08-25
 * against live ESI from one address in one 60 second window, `GET /latest/status/` (group
 * `status`, two tokens a call), with four credentials over two registered applications and two
 * characters. Unauthenticated read 598 then 596. Application A read 598 then 596 across two
 * different characters. Application B read 598 then 596 across the same two characters. Three
 * budgets, partitioned by application and nothing else:
 *
 *   1. The character does not move the budget: two characters under one application share one
 *      bucket.
 *   2. An authenticated caller does not draw on the unauthenticated bucket for the group, from
 *      the same address in the same window.
 *   3. The address does not move an authenticated caller's budget.
 *
 * `contract/wire.js` `LIMITER_KEY` holds the readings, `docs/open-decisions.md` D39 is the
 * decision, and `test/rateLimiter.test.js` asserts this file against the record. CCP documents
 * `applicationID:characterID`; the wire says `applicationID`. The observation wins over the
 * document (D31).
 *
 * The other limiter disagrees: `lib/errorLimiter.js` keys on the source address regardless of
 * credential (one counter, 100 down through 94, across two unauthenticated errors and then all
 * four credentials). So `LIMITER_KEY.limitersAgree` is `false`, and neither limiter's answer may
 * be borrowed for the other.
 *
 * Which value is the application: the verified `claims.clientId`, which `lib/bearerToken.js`
 * projects from the token's `azp`. Whether CCP's `applicationID` is that client id or the
 * registered application's own numeric id is unobserved, and no probe can tell them apart
 * because a budget partitioned by application partitions identically under either spelling.
 * `contract/wire.js` `LIMITER_KEY.applicationIdSpelling` is `null` and records that.
 *
 * A credential that was presented and did not verify keys on the address. A client id inside an
 * unverified token is chosen by the client, so keying on it would let one caller mint a fresh
 * budget per request (the reason `X-Forwarded-For` is refused). The case is nearly unreachable:
 * `lib/bearerCredential.js` refuses that request `401` in front of routing
 * (`contract/wire.js` `BEARER.presentedAndBad`), so `groupFor` answers `null` and this layer
 * passes it through without choosing a bucket.
 *
 * The application and the address are tagged apart inside the key, so a client id that spells
 * an address cannot land in that address's bucket. `KEY_SEPARATOR` separates every part. The
 * address is the socket's peer supplied by `server.js`, which ignores `X-Forwarded-For`.
 *
 * A caller nameable by neither (no verified application, address `null`) gets a bucket that is
 * not kept: metered for the headers, never refused, never shared. A shared "unknown" bucket
 * would let one anonymous caller exhaust it for all. It is reachable by a request that did not
 * arrive on a socket (an in-process caller, a test double); a remote client cannot null its own
 * address.
 *
 * The map is bounded, because it is keyed on attacker-controlled input inside a live game
 * process. Eviction is the opposite of `lib/pagination.js`'s LRU: a cache evicts what is least
 * likely to be asked for, a limiter must evict what an attacker gains least from.
 * Least-recently-used would evict the exhausted bucket of the caller being throttled and hand
 * them a fresh one. So eviction is fullest-first, and a full bucket is dropped for free since it
 * is indistinguishable from none. Ties go to insertion order, so eviction is deterministic.
 *
 * The refill is continuous at `max-tokens / 900 s`, this module's reading of "floating window"
 * (unobserved). A fixed window would let a client spend a full allowance at the end of one window
 * and another at the start of the next. `Retry-After` is the seconds until one token exists.
 *
 * Nothing throws into the request path; eve.js's ProcessLifecycle treats an unhandled rejection
 * as fatal (see `server.js`'s file header). Everything that can be wrong is wrong at
 * construction: a missing `next` or `groupFor`, a limits value that is not a positive integer,
 * and, if `lib/pipeline.js` passes the route table's groups, a route declaring a group CCP does not
 * publish (`RouteTableError`, via `assertKnownGroups`). At request time an unknown group is
 * passed through unmetered and unlabelled, rather than refusing traffic ESI would answer or
 * advertising an `X-Ratelimit-Limit` that is not CCP's.
 *
 * `GROUP_LIMITS` is duplicated out of `contract/openapi.json` because `contract/` is test-only
 * and never deployed (D20), as with `lib/headers.js` `OBSERVED_CASE`. `test/rateLimiter.test.js`
 * re-derives all 32 rows from the pinned spec and fails on drift.
 */

"use strict";

const { readCredential } = require("./bearerCredential");
const { edgeRefusal } = require("./errors");

// Constants

/**
 * The window, spelled the way the spec spells it.
 *
 * `X-Ratelimit-Limit` is `<max-tokens>/<window-size>` and the window half is the spec's own
 * string: `600/15m`, not `600/900`. All 135 of the pinned spec's rate-limited operations declare
 * `15m`, so this is one constant rather than a per-group column.
 */
const WINDOW_SIZE = "15m";
const WINDOW_SECONDS = 900;
const WINDOW_MS = WINDOW_SECONDS * 1000;

/**
 * Every rate-limit group CCP publishes, with its allowance in tokens per 15m.
 *
 * 32 groups on 135 of the pinned spec's 197 operations, derived from `contract/openapi.json`'s
 * `x-rate-limit`. No group is published with two different allowances, so this is a flat table.
 *
 * Deployed code cannot read `contract/` (D20), so the values live here and
 * `test/rateLimiter.test.js` re-derives them through `contract/spec.js`'s parser and asserts the
 * two agree, row for row.
 */
const GROUP_LIMITS = Object.freeze({
  "alliance-social": 300,
  "char-asset": 1800,
  "char-contract": 600,
  "char-detail": 600,
  "char-industry": 600,
  "char-killmail": 30,
  "char-location": 1200,
  "char-notification": 15,
  "char-social": 600,
  "char-wallet": 150,
  "corp-asset": 1800,
  "corp-contract": 600,
  "corp-detail": 300,
  "corp-industry": 600,
  "corp-killmail": 30,
  "corp-member": 300,
  "corp-social": 300,
  "corp-structure": 300,
  "corp-wallet": 300,
  "factional-warfare": 150,
  "fitting": 150,
  "fleet": 1800,
  "incursion": 150,
  "industry": 150,
  "insurance": 150,
  "killmail": 3600,
  "market-order": 12000,
  "meta": 150,
  "routes": 3600,
  "sovereignty": 600,
  "status": 600,
  "ui": 900,
});

/**
 * Tokens charged for the request that produced a response, by status class.
 *
 * `2`, `3` and `4` were each read off a live `X-Ratelimit-Used`. `5` is CCP's documented zero
 * and is unobserved; it matters most, since it decides whether a broken endpoint costs a client
 * its whole budget or nothing.
 *
 * `1XX` is absent and therefore free: this replica emits none, and a price for a class that
 * cannot happen could never be checked.
 */
const COST_BY_CLASS = Object.freeze({ 2: 2, 3: 1, 4: 5, 5: 0 });

/**
 * A `429` does not charge for itself (CCP's documentation, unobserved).
 *
 * It is an exception to the `4XX` row rather than a case of it: charging 5 for the refusal
 * would push a client's recovery further away each time it knocks, turning a rate limit into a
 * ban.
 */
const OVER_LIMIT_STATUS = 429;
const OVER_LIMIT_COST = 0;

/**
 * The body of the refusal.
 *
 * A placeholder. CCP publishes the status and not the body, and the pinned spec documents no
 * `429` response, so this is short and boring by choice. `contract/wire.js`
 * `LIMITER_UNOBSERVED.tokenBucketOverBody` holds the same string and `test/rateLimiter.test.js`
 * asserts they agree.
 */
const OVER_LIMIT_BODY = "rate limit exceeded";

/**
 * The cheapest charge a dispatched request can incur, and therefore the balance below which
 * there is no point dispatching.
 *
 * Derived from the table rather than written as `1`, so a corrected cost cannot leave the
 * refusal threshold behind.
 */
const MIN_CHARGE = Math.min(...Object.values(COST_BY_CLASS).filter((cost) => cost > 0));

/**
 * How many `(group, caller)` buckets to remember.
 *
 * Sized for the callers a game server actually has (a handful of tools, a front-end, a seeder)
 * with room to spare, not for the address space an attacker can walk. The cap bounds the flood;
 * the eviction policy makes it useless.
 */
const DEFAULT_MAX_BUCKETS = 4096;

/**
 * The separator between the parts of a bucket key.
 *
 * A NUL, because it cannot occur in a group name (32 kebab-case strings from the spec), a peer
 * address, or a client id, so no two distinct callers collide on one key. Joining on `:` would
 * let an IPv6 address do exactly that.
 */
const KEY_SEPARATOR = "\u0000";

/**
 * How the caller was named, carried in the key so the two kinds cannot collide.
 *
 * An application whose client id spells `10.0.0.1` must not land in `10.0.0.1`'s bucket, and
 * the observation is explicit that those are two budgets. Tagging makes that true by
 * construction rather than by the namespaces happening not to overlap.
 */
const CALLER_APPLICATION = "app";
const CALLER_ADDRESS = "ip";

/** A limiter that was built wrong. Thrown at construction, never at request time. */
class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "RateLimitError";
  }
}

// The published values

/** `12000` -> `"12000/15m"`. The window half is the spec's string, not seconds. */
function limitHeader(maxTokens, windowSize = WINDOW_SIZE) {
  return `${maxTokens}/${windowSize}`;
}

/**
 * What a response of this status costs its bucket.
 *
 * Anything unrecognised is free. A status this replica does not produce is not a price to
 * guess at, and a result arriving without one is a bug in a layer below.
 */
function costFor(status) {
  if (!Number.isInteger(status)) return 0;
  if (status === OVER_LIMIT_STATUS) return OVER_LIMIT_COST;

  const cost = COST_BY_CLASS[Math.trunc(status / 100)];
  return cost === undefined ? 0 : cost;
}

/**
 * Seconds until the bucket holds `needed` tokens, at this group's refill rate.
 *
 * Never below 1: `Retry-After: 0` reads as "try immediately" to a client that parses it and as
 * "malformed" to one that does not. For `char-notification` (15 tokens per 15 minutes) an empty
 * bucket is a full minute from a single token, which is the number this produces.
 */
function retryAfterSeconds(tokens, maxTokens, needed = MIN_CHARGE) {
  const perSecond = maxTokens / WINDOW_SECONDS;
  const deficit = Math.max(0, needed - tokens);
  return Math.max(1, Math.ceil(deficit / perSecond));
}

/**
 * The four headers, lowercase, in CCP's order.
 *
 * Lowercase because that is how this codebase keys a header; `lib/headers.js` title-cases on the
 * way to the socket and produces `X-Ratelimit-Group` rather than the conventional
 * `X-RateLimit-Group`, which is what CCP sends. The order is CCP's, and header order is
 * observable on a raw socket.
 */
function rateLimitHeaders(group, maxTokens, tokens, used) {
  return {
    "x-ratelimit-group": group,
    "x-ratelimit-limit": limitHeader(maxTokens),
    "x-ratelimit-remaining": String(Math.max(0, Math.floor(tokens))),
    "x-ratelimit-used": String(used),
  };
}

/**
 * The refusal: an edge-shaped `429` carrying the same four headers plus `Retry-After`.
 *
 * Edge-shaped because it is refused in front of the route and written by the gateway:
 * `nosniff`, Go's trailing newline. `lib/errors.js` owns that shape; its
 * caller-supplies-an-observed-string rule is the one thing this call cannot honour, and the
 * string it is given says so.
 */
function overLimitResult(group, maxTokens, tokens) {
  const refusal = edgeRefusal(OVER_LIMIT_STATUS, OVER_LIMIT_BODY);

  return {
    ...refusal,
    headers: {
      ...refusal.headers,
      ...rateLimitHeaders(group, maxTokens, tokens, OVER_LIMIT_COST),
      "retry-after": String(retryAfterSeconds(tokens, maxTokens)),
    },
  };
}

// The limits table

/**
 * `{ group: maxTokens }` as a `Map`, validated.
 *
 * A `Map` rather than the source object, because a group name arrives from a route table and
 * `limits["constructor"]` on a plain object is a function rather than `undefined`. A route
 * declaring a group called `toString` should be an unknown group, not a limit of `[Function]`.
 */
function toLimitTable(limits) {
  if (!limits || typeof limits !== "object") {
    throw new RateLimitError("ESI mod: the rate-limit table must be an object of group -> max tokens.");
  }

  const table = new Map();
  for (const [group, maxTokens] of Object.entries(limits)) {
    if (!Number.isInteger(maxTokens) || maxTokens < 1) {
      throw new RateLimitError(
        `ESI mod: rate-limit group ${JSON.stringify(group)} has max tokens `
          + `${JSON.stringify(maxTokens)}; CCP publishes a positive integer per 15m window.`,
      );
    }
    table.set(group, maxTokens);
  }
  return table;
}

/**
 * Every group in `groups` is one CCP publishes, or this throws naming the ones that are not.
 *
 * A route declaring a group the spec does not have is a route-table mistake, best found while
 * the table is built: at request time the options are inventing an allowance or pretending the
 * route is ungrouped. `null` and `undefined` are ignored (ungrouped routes).
 */
function assertKnownGroups(groups, limits = GROUP_LIMITS) {
  const table = limits instanceof Map ? limits : toLimitTable(limits);

  const unknown = [...new Set(groups)]
    .filter((group) => group !== null && group !== undefined)
    .filter((group) => !table.has(group));

  if (unknown.length > 0) {
    throw new RateLimitError(
      `ESI mod: route table declares rate-limit group(s) ${unknown.map((g) => JSON.stringify(g)).join(", ")}, `
        + `which CCP's pinned spec does not publish. The 32 it does publish are in lib/rateLimiter.js `
        + "GROUP_LIMITS; a group outside them is a typo in the route table, not a new limit.",
    );
  }
}

// The caller

/**
 * Whose budget this request draws on, tagged by how the caller was named, or `null` for a
 * caller this replica can name neither way.
 *
 * The application first and the address only as a fallback, the order the 2026-08-25 capture
 * fixed (see the file header, including why CCP's documented `applicationID:characterID` is not
 * followed).
 *
 * `readCredential` is memoised per request object by `lib/bearerCredential.js`, so this is a
 * `WeakMap` read and not a second RSA verification: `lib/pipeline.js`'s `groupFor` already asked
 * on the way in, and `test/bearerCredential.test.js` pins one verification per request.
 *
 * A credential presented and not verified has `claims === null` and keys on the address; the
 * request is refused `401` in front of routing anyway (`contract/wire.js`
 * `BEARER.presentedAndBad`), so this is the fallback it would deserve. A verified credential
 * with no usable `clientId` falls back the same way. Callers that cannot be told apart must
 * never share a bucket.
 */
function callerFor(request, verifier) {
  const { claims } = readCredential(request, verifier);

  const application = claims === null || claims === undefined ? null : claims.clientId;
  if (typeof application === "string" && application !== "") {
    return `${CALLER_APPLICATION}${KEY_SEPARATOR}${application}`;
  }

  const address = request && request.remoteAddress;
  if (typeof address === "string" && address !== "") {
    return `${CALLER_ADDRESS}${KEY_SEPARATOR}${address}`;
  }

  return null;
}

// The buckets

/** A bucket starts full: a caller nobody has heard from owes nothing. */
function freshBucket(maxTokens, now) {
  return { tokens: maxTokens, maxTokens, updatedAt: now };
}

/**
 * Trickle tokens back in, up to the group's maximum.
 *
 * A clock that has gone backwards leaves `updatedAt` alone rather than resetting it, so the
 * bucket refills late rather than twice. `Date.now()` moves backwards on any machine that talks
 * to an NTP server, and refilling slowly is the error that cannot be exploited.
 */
function refill(bucket, now) {
  const elapsed = now - bucket.updatedAt;
  if (!(elapsed > 0)) return bucket;

  bucket.updatedAt = now;
  bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + elapsed * (bucket.maxTokens / WINDOW_MS));
  return bucket;
}

/**
 * Make room for one more bucket, fullest first.
 *
 * Two passes. The first is free: a bucket refilled to its maximum holds no information a fresh
 * bucket would not, so dropping all of them changes no answer. Only if that finds nothing is
 * anything real evicted, and then it is the bucket closest to full, measured as a fraction since
 * groups differ by three orders of magnitude (300 tokens means something different to
 * `char-notification` than to `market-order`).
 *
 * Both passes scan a map whose size is capped by construction, so the cost is bounded by the
 * option and not by how hard a client is trying.
 */
function reclaim(buckets, now) {
  let freed = 0;
  for (const [key, bucket] of buckets) {
    refill(bucket, now);
    if (bucket.tokens >= bucket.maxTokens) {
      buckets.delete(key);
      freed += 1;
    }
  }
  if (freed > 0) return freed;

  let victim = null;
  let fullest = -1;
  for (const [key, bucket] of buckets) {
    const ratio = bucket.tokens / bucket.maxTokens;
    // Strictly greater, so a tie leaves the earliest-inserted entry chosen and
    // eviction is deterministic.
    if (ratio > fullest) {
      fullest = ratio;
      victim = key;
    }
  }

  if (victim === null) return 0;
  buckets.delete(victim);
  return 1;
}

// The layer

/**
 * Wrap a dispatch so that a routed request is charged to its group's bucket, and refused before
 * it runs when that bucket cannot pay.
 *
 * `groupFor(request)` returns the group or `null`. `lib/pipeline.js` wires it to
 * `createGroupFor`, which asks the route table and the three questions whose answers mean no
 * route was reached at all (a bad credential, a bad tenant, a bad compatibility date), because
 * a request refused in front of routing has no bucket to charge. Composition is
 *
 *   clock( cors( errorLimit( rateLimit( bearer( tenant( compatibility(
 *     requestId( cache( router ) ) ) ) ) ) ) ) )
 *
 * This layer sits outside `cache` on purpose: a `304` is decided there and costs a token, so
 * the charge has to see the final status. It is outside `bearer` too, which costs nothing: a
 * credential refusal answers `null` above and passes straight through to the error limiter.
 * `lib/pipeline.js` owns the order and the argument for every boundary.
 *
 * `verifier` is the same one `bearer` is given. The bucket is keyed on the application for a
 * caller that presented a credential this replica could check, and since `request.credential`
 * is stamped a layer below this one, reading it here would key every authenticated caller on
 * its address. `readCredential` answers from the same memo, at the cost of a `WeakMap` lookup.
 * With no verifier, every credential reads as absent and every caller keys on its address: an
 * authenticated client sharing a budget it should have had to itself, never one escaping a
 * budget it should have been held to.
 *
 * A header the wrapped dispatch already set wins, as in `lib/cors.js` and `lib/cache.js`: two
 * spellings of one header name go out as one comma-joined value.
 */
function createRateLimitDispatch(next, {
  groupFor,
  now = () => Date.now(),
  limits = GROUP_LIMITS,
  maxBuckets = DEFAULT_MAX_BUCKETS,
  groups = null,
  verifier = null,
} = {}) {
  if (typeof next !== "function") {
    throw new RateLimitError("ESI mod: createRateLimitDispatch needs a dispatch function to wrap.");
  }
  if (typeof groupFor !== "function") {
    throw new RateLimitError(
      "ESI mod: createRateLimitDispatch needs a groupFor(request) function: the route's rate-limit "
        + "group is what decides whether this limiter answers at all, and it has to be known before "
        + "the request is dispatched.",
    );
  }
  if (typeof now !== "function") {
    throw new RateLimitError("ESI mod: createRateLimitDispatch's `now` must be a function returning epoch ms.");
  }
  if (!Number.isInteger(maxBuckets) || maxBuckets < 1) {
    throw new RateLimitError(
      `ESI mod: createRateLimitDispatch needs a positive integer maxBuckets, got ${JSON.stringify(maxBuckets)}. `
        + "The map is keyed on the caller's address; an unbounded one is a memory-exhaustion bug in "
        + "somebody's game server.",
    );
  }

  const table = toLimitTable(limits);
  // Optional, and the only reason a bad route table fails loudly: pass the
  // table's declared groups and a typo is a construction error instead of a
  // route that quietly stops being limited.
  if (groups !== null) assertKnownGroups(groups, table);

  const buckets = new Map();

  /** The stored bucket for this caller, refilled to now. */
  function bucketFor(key, maxTokens, at) {
    const existing = buckets.get(key);
    if (existing !== undefined) return refill(existing, at);

    if (buckets.size >= maxBuckets) reclaim(buckets, at);

    const bucket = freshBucket(maxTokens, at);
    buckets.set(key, bucket);
    return bucket;
  }

  async function rateLimitDispatch(request) {
    // Asked once, up front. `null` is most of the surface (every ungrouped
    // route and every path that routes nowhere), and those responses carry no
    // X-Ratelimit header at all because on the wire they carry the error
    // limiter's instead.
    const group = groupFor(request);
    if (group === null || group === undefined) return next(request);

    const maxTokens = table.get(group);
    // A group nobody published. See the file header: unmetered here, and loud
    // at construction if `lib/pipeline.js` passed the route table's groups.
    if (maxTokens === undefined) return next(request);

    const at = now();
    // The application where one verified, the address otherwise. Free: the
    // credential was already read, once, by `groupFor` one layer up.
    const caller = callerFor(request, verifier);

    // An unidentifiable caller is metered but not remembered: never refused and,
    // more to the point, never sharing a bucket with another one.
    const bucket = caller === null
      ? freshBucket(maxTokens, at)
      : bucketFor(`${group}${KEY_SEPARATOR}${caller}`, maxTokens, at);

    if (Math.floor(bucket.tokens) < MIN_CHARGE) {
      return overLimitResult(group, maxTokens, bucket.tokens);
    }

    const result = await next(request);

    // A dispatch that answered with something that is not a result (a double, a
    // layer under construction) has nothing to charge and nothing to label.
    if (!result || typeof result !== "object") return result;

    // Clamped at the balance, so the bucket never carries debt, and reported as
    // what was deducted so that `Remaining` and `Used` agree with each other.
    const charged = Math.min(costFor(result.status), Math.floor(bucket.tokens));
    bucket.tokens -= charged;

    const headers = {
      ...rateLimitHeaders(group, maxTokens, bucket.tokens, charged),
      ...(result.headers || {}),
    };

    return { ...result, headers };
  }

  /**
   * How many buckets are held, for the test that the bound is real.
   *
   * Nothing in the request path reads it. The alternative is a test that asserts boundedness by
   * watching memory, which is not an assertion.
   */
  rateLimitDispatch.bucketCount = () => buckets.size;

  return rateLimitDispatch;
}

module.exports = {
  CALLER_ADDRESS,
  CALLER_APPLICATION,
  COST_BY_CLASS,
  DEFAULT_MAX_BUCKETS,
  GROUP_LIMITS,
  KEY_SEPARATOR,
  MIN_CHARGE,
  OVER_LIMIT_BODY,
  OVER_LIMIT_COST,
  OVER_LIMIT_STATUS,
  RateLimitError,
  WINDOW_MS,
  WINDOW_SECONDS,
  WINDOW_SIZE,
  assertKnownGroups,
  callerFor,
  costFor,
  createRateLimitDispatch,
  limitHeader,
  rateLimitHeaders,
  retryAfterSeconds,
};
