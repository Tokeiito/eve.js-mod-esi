/**
 * eve.js-mod-esi: tests for lib/bindRateLimiter.js
 *
 * Run with: node --test "test/**\/*.test.js"   (from the mod directory)
 *
 * The clock is a variable in this file and nothing sleeps: a rate limiter whose
 * tests take a real minute is one nobody will change, and one nobody changes is
 * one nobody notices has stopped working.
 *
 * Most cases came across with the primitive from `nexumApi`'s
 * `lib/rateLimiter.js`; the port is only worth making if the assertions that
 * proved it come too. The new cases cover what this file added: a defended
 * clock, and the explicit "never seen" / "just evicted" equivalence that makes
 * eviction safe.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_KEYS,
  createBindRateLimiter,
} = require(path.join(__dirname, "..", "lib", "bindRateLimiter"));

// The bucket

test("a burst up to the limit is allowed and the next call is not", () => {
  const limiter = createBindRateLimiter({ limit: 3, intervalMs: 60000 });

  assert.equal(limiter.check("a", 0).allowed, true);
  assert.equal(limiter.check("a", 0).allowed, true);
  assert.equal(limiter.check("a", 0).allowed, true);
  assert.equal(limiter.check("a", 0).allowed, false);
});

test("keys are independent", () => {
  const limiter = createBindRateLimiter({ limit: 1, intervalMs: 60000 });

  assert.equal(limiter.check("a", 0).allowed, true);
  assert.equal(limiter.check("a", 0).allowed, false);
  assert.equal(limiter.check("b", 0).allowed, true);
});

test("the bucket refills continuously, not in steps", () => {
  const limiter = createBindRateLimiter({ limit: 2, intervalMs: 1000 });

  assert.equal(limiter.check("a", 0).allowed, true);
  assert.equal(limiter.check("a", 0).allowed, true);
  assert.equal(limiter.check("a", 0).allowed, false);

  // Half the interval buys back exactly one token.
  assert.equal(limiter.check("a", 500).allowed, true);
  assert.equal(limiter.check("a", 500).allowed, false);
});

test("a full interval restores the whole burst", () => {
  const limiter = createBindRateLimiter({ limit: 3, intervalMs: 1000 });
  for (let index = 0; index < 3; index += 1) limiter.check("a", 0);
  assert.equal(limiter.check("a", 0).allowed, false);

  assert.equal(limiter.check("a", 1000).allowed, true);
  assert.equal(limiter.check("a", 1000).allowed, true);
  assert.equal(limiter.check("a", 1000).allowed, true);
});

test("retryAfterMs says when one more token is available", () => {
  // `lib/pendingBinds.js` puts this number straight into its refusal, so it is
  // interface rather than diagnostics.
  const limiter = createBindRateLimiter({ limit: 1, intervalMs: 1000 });
  limiter.check("a", 0);
  assert.equal(limiter.check("a", 0).retryAfterMs, 1000);
  assert.equal(limiter.check("a", 500).retryAfterMs, 500);
});

test("an allowed call reports what is left and a refused one reports zero", () => {
  const limiter = createBindRateLimiter({ limit: 3, intervalMs: 60000 });
  assert.deepEqual(limiter.check("a", 0), { allowed: true, remaining: 2, retryAfterMs: 0 });
  assert.equal(limiter.check("a", 0).remaining, 1);
  assert.equal(limiter.check("a", 0).remaining, 0);
  assert.deepEqual(limiter.check("a", 0), { allowed: false, remaining: 0, retryAfterMs: 20000 });
});

test("a rejected call does not push its own recovery further away", () => {
  // A limiter that drained on rejection would let an attacker lock out the
  // legitimate owner of a key (a character id is not a secret) by hammering it.
  // The refusal has to be free to the person being refused.
  const limiter = createBindRateLimiter({ limit: 1, intervalMs: 1000 });
  limiter.check("a", 0);
  for (let index = 0; index < 50; index += 1) limiter.check("a", 100);
  assert.equal(limiter.check("a", 1000).allowed, true);
});

// Bounded memory

test("a bucket that has refilled completely is swept away", () => {
  const limiter = createBindRateLimiter({ limit: 2, intervalMs: 1000 });
  limiter.check("a", 0);
  limiter.check("a", 0);
  limiter.check("b", 0);
  limiter.check("b", 0);
  assert.equal(limiter.size(), 2);

  assert.equal(limiter.sweep(500), 0, "still partially drained at 500ms");
  assert.equal(limiter.sweep(1000), 2);
  assert.equal(limiter.size(), 0);
});

test("the key map is capped, so an attacker-chosen key space cannot grow it", () => {
  // The reason the cap exists: this map lives in the game server's heap and both
  // key spaces (session id, character id) are attacker-influenced.
  const limiter = createBindRateLimiter({ limit: 1, intervalMs: 1000000, maxKeys: 8 });
  for (let index = 0; index < 1000; index += 1) limiter.check(`key-${index}`, 0);
  assert.ok(limiter.size() <= 8, `expected at most 8 keys, got ${limiter.size()}`);
});

test("eviction forgets a throttle, it never invents an allowance", () => {
  // The only safe direction for an evicted bucket to fail in. Proving the
  // throttled key is still throttled while it is resident is the half that
  // matters for the keys actually under attack.
  const limiter = createBindRateLimiter({ limit: 1, intervalMs: 1000000, maxKeys: 4 });
  limiter.check("victim", 0);
  assert.equal(limiter.check("victim", 0).allowed, false);
  limiter.check("other", 0);
  assert.equal(limiter.check("victim", 0).allowed, false);
});

test("a limiter that never saw a key is no more permissive than one that evicted it", () => {
  // The invariant the eviction policy rests on: if a fresh key were cheaper
  // than an evicted one, filling the map would be a way to buy allowance rather
  // than lose it.
  const settings = { limit: 2, intervalMs: 1000000, maxKeys: 4 };

  const fresh = createBindRateLimiter(settings);
  const virgin = fresh.check("never-seen", 0);

  const churned = createBindRateLimiter(settings);
  churned.check("target", 0);
  churned.check("target", 0);
  assert.equal(churned.check("target", 0).allowed, false, "resident and drained");
  // Push it out with keys the limiter has to make room for.
  for (let index = 0; index < 20; index += 1) churned.check(`filler-${index}`, 0);
  const evicted = churned.check("target", 0);

  assert.deepEqual(evicted, virgin);
  assert.equal(evicted.remaining, virgin.remaining);
});

// The clock, defended

test("a clock that is not a time does not become a granted allowance", () => {
  // The failure this guards against is silent: every comparison against `NaN`
  // is false, so an undefended limiter would refuse nothing and look fine.
  const limiter = createBindRateLimiter({ limit: 1, intervalMs: 1000000 });
  assert.equal(limiter.check("a", Number.NaN).allowed, true);
  assert.equal(limiter.check("a", Number.NaN).allowed, false, "still spent");
  assert.equal(limiter.check("a", undefined).allowed, false);
  assert.equal(limiter.check("a", "not a time").allowed, false);
});

test("a clock that steps backwards does not refill a bucket it should not", () => {
  // Changed from the ported version. Writing an older stamp onto the bucket
  // would make the next honest reading measure elapsed time from before the
  // bucket was touched, and hand back refill nobody waited for.
  const limiter = createBindRateLimiter({ limit: 1, intervalMs: 1000 });

  assert.equal(limiter.check("a", 10000).allowed, true);
  assert.equal(limiter.check("a", 10000).allowed, false);

  // An NTP step, or a caller re-reading a wall clock.
  assert.equal(limiter.check("a", 9000).allowed, false, "no refill from going backwards");

  // The reading that follows measures from 10000, not from 9000.
  assert.equal(limiter.check("a", 10500).allowed, false);
  assert.equal(limiter.check("a", 11000).allowed, true);
});

// Construction

test("nonsense settings fall back to something usable rather than throwing", () => {
  // Built during loader wiring, inside the game's process: a throw here is the
  // game server failing to boot (design constraint 2).
  const limiter = createBindRateLimiter({ limit: 0, intervalMs: -5 });
  assert.equal(limiter.capacity, 1);
  assert.equal(limiter.intervalMs, DEFAULT_INTERVAL_MS);
  assert.equal(limiter.maxKeys, DEFAULT_MAX_KEYS);
  assert.equal(limiter.check("a", 0).allowed, true);
});

test("no arguments at all still builds a limiter", () => {
  const limiter = createBindRateLimiter();
  assert.equal(limiter.capacity, 1);
  assert.equal(limiter.intervalMs, DEFAULT_INTERVAL_MS);
  assert.equal(limiter.check("a", 0).allowed, true);
  assert.equal(limiter.check("a", 0).allowed, false);
});

test("a null or undefined key is treated as one shared bucket, not as many", () => {
  // Matches what `lib/pendingBinds.js` does on purpose with its "anonymous"
  // redemption key: no legitimate traffic uses that path, so collapsing it costs
  // an attacker and nobody else.
  const limiter = createBindRateLimiter({ limit: 1, intervalMs: 1000 });
  assert.equal(limiter.check(null, 0).allowed, true);
  assert.equal(limiter.check(undefined, 0).allowed, false);
  assert.equal(limiter.size(), 1);
});

test("the limiter it returns is frozen, and satisfies the store's stated interface", () => {
  const limiter = createBindRateLimiter({ limit: 1, intervalMs: 1000 });
  assert.ok(Object.isFrozen(limiter));

  // `lib/pendingBinds.js` documents exactly this much:
  // `{ check(key, now) -> { allowed, retryAfterMs } }`.
  assert.equal(typeof limiter.check, "function");
  const verdict = limiter.check("a", 0);
  assert.equal(typeof verdict.allowed, "boolean");
  assert.equal(typeof verdict.retryAfterMs, "number");
});
