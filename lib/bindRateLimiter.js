/**
 * eve.js-mod-esi: the bind limiter
 *
 * A keyed token bucket with the clock injected. It fills the two holes
 * `lib/pendingBinds.js` leaves open: that store takes a `mintLimiter` and a
 * `redeemLimiter`, and minting is rate-limited per session and redemption per
 * character. These are security properties, and a `null` limiter type-checks,
 * runs and passes every test while shipping neither defence.
 *
 * Why not `lib/rateLimiter.js`: it is an HTTP dispatch wrapper. It keys off
 * CCP's 32 published rate-limit groups via the router, charges an observed
 * per-status-class cost, and writes the `X-Ratelimit-*` headers. A bind mint is
 * not a routed ESI request, has no group, and its refusal is never a `429` on
 * the ESI surface. It exposes no `check(key, now)` primitive either. The same
 * holds for `lib/errorLimiter.js` (`X-Esi-Error-Limit-*` and the `420`). The
 * primitive is ported from another mod's rate limiter. The export is
 * `createBindRateLimiter`, not `createRateLimiter`, so the two cannot be
 * confused at a call site.
 *
 * What it defends, with two limiters and separate key spaces:
 *
 *   Redemption   A bind code is ~39 bits (`lib/bindCodes.js`). Unlimited
 *                guessing makes that a search; a few attempts per character
 *                per minute makes it impractical. Keyed by character, because
 *                the game session is what an attacker would have to multiply.
 *
 *   Minting      Every mint is an entry in a table in the game server's heap
 *                (design constraint 2). Keyed by the requesting session,
 *                so one browser cannot fill it.
 *
 * A token bucket rather than a fixed window: a fixed window allows double the
 * rate across a boundary, while a bucket refills continuously and gives an
 * exact `retryAfterMs`, which `lib/pendingBinds.js` puts in its refusal.
 *
 * Bounded memory. The key space is attacker-influenced (any character id, any
 * session id) and the map lives in the game's heap, so `maxKeys` and eviction
 * are load-bearing. `lib/authCodes.js` refuses at its cap instead of evicting,
 * deliberately: it holds grants, this file holds counters. Evicting a pending
 * authorization code cancels a human's in-flight sign-in under conditions an
 * attacker can create on demand, so for grants the eviction policy is itself the
 * attack. Evicting a bucket only forgets that someone was throttled. Neither
 * policy generalises; `lib/bindFlow.js` holds something closer to a grant and
 * sides with `lib/authCodes.js`.
 *
 * Eviction never invents an allowance for someone who was not throttled. Full
 * buckets are dropped first, since a full bucket is indistinguishable from an
 * unseen key, and `test/bindRateLimiter.test.js` asserts that a limiter that
 * never saw a key is exactly as permissive as one that just evicted it.
 *
 * The clock is defended, not trusted. `now` is an argument (no timers live
 * here), and a throw on this path takes the game server down, so two failures
 * are survived without throwing:
 *
 *   Not a time at all (`NaN`, `undefined`, a string). Reading it would turn
 *   every comparison `false` and grant everything. As in
 *   `lib/errorLimiter.js`: coerce, test `Number.isFinite`, fall back to the real
 *   clock.
 *
 *   Going backwards (an NTP step, a test that rewinds). Refill floors elapsed
 *   time at zero, but the ported version wrote the earlier stamp back onto the
 *   bucket, so the next honest reading refilled it too far. Here `updatedAt`
 *   only moves forward, which can at worst make a throttled caller wait
 *   slightly longer than the arithmetic says.
 */

"use strict";

// A ceiling a legitimate deployment never reaches: one bucket per browser
// session or per character. Sized as a heap bound, not a capacity plan.
const DEFAULT_MAX_KEYS = 4096;

/** What an unusable `intervalMs` falls back to. One minute. */
const DEFAULT_INTERVAL_MS = 60000;

/**
 * @param limit      tokens in a full bucket (the burst size)
 * @param intervalMs time to refill an empty bucket completely
 * @param maxKeys    hard cap on tracked keys
 *
 * Nonsense settings are clamped rather than thrown at. This object is built
 * during `loader.js` wiring inside the game's process, where a throw is the game
 * server failing to boot; a limiter that falls back to one per minute is wrong
 * in the safe direction and visible in `capacity`.
 */
function createBindRateLimiter({ limit, intervalMs, maxKeys = DEFAULT_MAX_KEYS } = {}) {
  const capacity = Number.isFinite(limit) && limit > 0 ? limit : 1;
  const window =
    Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
  const keyCap =
    Number.isFinite(maxKeys) && maxKeys > 0 ? Math.trunc(maxKeys) : DEFAULT_MAX_KEYS;
  const refillPerMs = capacity / window;

  // Insertion order doubles as recency: every touch re-inserts, so the first
  // entry `Map` iteration yields is the least recently used.
  const buckets = new Map();

  /** A broken clock must not become a granted allowance. See the header. */
  function reading(now) {
    const at = Number(now);
    return Number.isFinite(at) ? at : Date.now();
  }

  function tokensAt(entry, at) {
    const elapsed = Math.max(0, at - entry.updatedAt);
    return Math.min(capacity, entry.tokens + elapsed * refillPerMs);
  }

  /**
   * Write a bucket back and mark it most-recently-used.
   *
   * `updatedAt` is monotonic per bucket: an older stamp is ignored, so a clock
   * that stepped backwards cannot manufacture refill for the next reading.
   */
  function touch(key, entry, at) {
    if (at > entry.updatedAt) entry.updatedAt = at;
    buckets.delete(key);
    buckets.set(key, entry);
  }

  /** Drop buckets that have refilled completely: they carry no information. */
  function sweep(now) {
    const at = reading(now);
    let removed = 0;
    for (const [key, entry] of buckets) {
      if (tokensAt(entry, at) >= capacity) {
        buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Make room for one new key, sweeping first so eviction is the last resort.
   * Only reached from `check` on a key the map does not hold, so a resident key is
   * never evicted by its own call.
   */
  function evictIfNeeded(at) {
    if (buckets.size < keyCap) return;
    sweep(at);
    while (buckets.size >= keyCap) {
      const oldest = buckets.keys().next();
      if (oldest.done) return;
      buckets.delete(oldest.value);
    }
  }

  /**
   * Spend one token for `key`.
   *
   * Returns `{ allowed, remaining, retryAfterMs }`. `allowed` and `retryAfterMs`
   * are the two fields `lib/pendingBinds.js` documents as its limiter interface.
   *
   * A rejected call costs nothing: the bucket is not drained further, so a caller
   * hammering a throttled key cannot push their own recovery away, and an attacker
   * guessing against a character id cannot lock out its legitimate owner.
   *
   * A `null` or `undefined` key collapses to one shared bucket, matching the
   * `"anonymous"` redemption key in `lib/pendingBinds.js`: there is no legitimate
   * traffic on that path, so the cost falls on an attacker.
   */
  function check(key, now) {
    const at = reading(now);
    const id = String(key === null || key === undefined ? "" : key);

    let entry = buckets.get(id);
    if (!entry) {
      evictIfNeeded(at);
      // A never-seen key and a just-evicted key arrive here with the same full
      // bucket. That identity is what makes eviction safe; see the header.
      entry = { tokens: capacity, updatedAt: at };
    }

    const available = tokensAt(entry, at);
    if (available < 1) {
      entry.tokens = available;
      touch(id, entry, at);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.ceil((1 - available) / refillPerMs),
      };
    }

    entry.tokens = available - 1;
    touch(id, entry, at);
    return { allowed: true, remaining: Math.floor(entry.tokens), retryAfterMs: 0 };
  }

  return Object.freeze({
    capacity,
    intervalMs: window,
    maxKeys: keyCap,
    check,
    sweep,
    size: () => buckets.size,
  });
}

module.exports = Object.freeze({
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_KEYS,

  createBindRateLimiter,
});
