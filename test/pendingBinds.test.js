/**
 * eve.js-mod-esi: tests for lib/pendingBinds.js
 *
 * Run with: node --test "test/**\/*.test.js"   (from the mod directory)
 *
 * The clock is injected, so every TTL and sweep case is exact and instant. A
 * test that slept for two minutes to watch a code expire would be deleted or
 * have its TTL lowered until it proved nothing.
 *
 * About the limiter double: both limiters are injected into the store, and
 * this repository's `lib/rateLimiter.js` is not one of them. It is an HTTP
 * dispatch bound to CCP's published rate-limit groups and `X-Ratelimit-*`
 * headers, which answers a different question. The double below is a small
 * token bucket with the clock passed in. What the store owes is keying the
 * limiter correctly and honouring its verdict; the bucket algorithm belongs to
 * whichever limiter the wiring supplies. The double records its keys so the
 * tests can assert the keying rather than infer it from a refusal.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  CLAIM_OUTCOME,
  DEFAULT_MAX_PENDING,
  MINT_FAILURE,
  UNKNOWN_INSPECTION,
  createPendingBindStore,
} = require(path.join(__dirname, "..", "lib", "pendingBinds"));

// A token bucket, for the store to be refused by
function makeLimiter({ limit, intervalMs = 60000 } = {}) {
  const buckets = new Map();
  const keys = [];
  const refillPerMs = limit / intervalMs;

  return {
    keys,
    check(key, at) {
      keys.push(String(key));
      const entry = buckets.get(key) || { tokens: limit, updatedAt: at };
      const available = Math.min(limit, entry.tokens + Math.max(0, at - entry.updatedAt) * refillPerMs);
      entry.updatedAt = at;
      if (available < 1) {
        entry.tokens = available;
        buckets.set(key, entry);
        return { allowed: false, retryAfterMs: Math.ceil((1 - available) / refillPerMs) };
      }
      entry.tokens = available - 1;
      buckets.set(key, entry);
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

// A generator that emits valid, distinct, entirely predictable codes.
function sequentialCodes() {
  const symbols = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  let index = 0;
  return () => {
    const value = index++;
    let code = "";
    for (let position = 0; position < 8; position += 1) {
      code = symbols[(value + position * 7) % symbols.length] + code;
    }
    return code;
  };
}

function makeStore(overrides = {}) {
  const clock = { at: 1000 };
  const store = createPendingBindStore({
    now: () => clock.at,
    generateCode: sequentialCodes(),
    ttlMs: 60000,
    graceMs: 120000,
    ...overrides,
  });
  return { clock, store };
}

// Minting

test("a mint yields a code, an expiry and nothing else the caller must guess", () => {
  const { store } = makeStore();
  const result = store.mint({ sessionId: "browser-1" });

  assert.equal(result.ok, true);
  assert.equal(typeof result.code, "string");
  assert.equal(result.expiresAt, 1000 + 60000);
  assert.equal(result.ttlMs, 60000);
});

test("minting without a session is refused", () => {
  // A code with no session behind it could be completed into any browser.
  const { store } = makeStore();
  for (const sessionId of [undefined, null, "", "   ", 7, "x".repeat(300)]) {
    const result = store.mint({ sessionId });
    assert.equal(result.ok, false);
    assert.equal(result.reason, MINT_FAILURE.INVALID_SESSION);
  }
  assert.equal(store.size(), 0);
});

test("a generator that keeps emitting the same code gives up rather than looping", () => {
  const { store } = makeStore({ generateCode: () => "AAAAAAAA" });
  assert.equal(store.mint({ sessionId: "a" }).ok, true);
  const second = store.mint({ sessionId: "b" });
  assert.equal(second.ok, false);
  assert.equal(second.reason, MINT_FAILURE.GENERATOR);
});

test("a generator emitting junk is refused, never stored", () => {
  const { store } = makeStore({ generateCode: () => "not a code" });
  assert.equal(store.mint({ sessionId: "a" }).reason, MINT_FAILURE.GENERATOR);
  assert.equal(store.size(), 0);
});

test("the store refuses to grow past its cap", () => {
  const { store } = makeStore({ maxPending: 3 });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(store.mint({ sessionId: `s${index}` }).ok, true);
  }
  assert.equal(store.mint({ sessionId: "s4" }).reason, MINT_FAILURE.FULL);
});

// Single use

test("a code redeems once and is `used` from then on", () => {
  const { store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });

  const first = store.claim({ code, characterID: 90001 });
  assert.equal(first.outcome, CLAIM_OUTCOME.CLAIMED);
  assert.equal(first.claim.characterID, 90001);

  assert.equal(store.claim({ code, characterID: 90002 }).outcome, CLAIM_OUTCOME.USED);
  assert.equal(store.claim({ code, characterID: 90001 }).outcome, CLAIM_OUTCOME.USED);
});

test("two concurrent redemptions of one code produce exactly one success", async () => {
  // The property the whole design turns on. `claim` is synchronous from lookup
  // to state change, so the two calls below are ordered by the event loop and
  // the second cannot see an entry the first has taken. Racing them through
  // Promise.all is how a caller would get here: two characters typing the same
  // stolen code at the same moment.
  const { store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });

  const results = await Promise.all([
    Promise.resolve().then(() => store.claim({ code, characterID: 90001 })),
    Promise.resolve().then(() => store.claim({ code, characterID: 90002 })),
  ]);

  const claimed = results.filter((result) => result.outcome === CLAIM_OUTCOME.CLAIMED);
  const used = results.filter((result) => result.outcome === CLAIM_OUTCOME.USED);
  assert.equal(claimed.length, 1, "exactly one redemption must succeed");
  assert.equal(used.length, 1, "the loser must be told the code is used");
});

test("many simultaneous redemptions still produce exactly one success", async () => {
  const { store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });

  const results = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      Promise.resolve().then(() => store.claim({ code, characterID: 90000 + index })),
    ),
  );

  assert.equal(results.filter((result) => result.outcome === CLAIM_OUTCOME.CLAIMED).length, 1);
});

// unknown / expired / used are three answers

test("unknown, expired and used are distinguishable", () => {
  const { clock, store } = makeStore();

  const minted = store.mint({ sessionId: "browser-1" });
  const expiring = store.mint({ sessionId: "browser-2" });

  store.claim({ code: minted.code, characterID: 1 });
  clock.at += 60001;

  assert.equal(store.claim({ code: minted.code, characterID: 1 }).outcome, CLAIM_OUTCOME.USED);
  assert.equal(
    store.claim({ code: expiring.code, characterID: 1 }).outcome,
    CLAIM_OUTCOME.EXPIRED,
  );
  assert.equal(
    store.claim({ code: "ZZZZZZZZ", characterID: 1 }).outcome,
    CLAIM_OUTCOME.UNKNOWN,
  );
});

test("a code expires exactly at its expiry, not a millisecond either side", () => {
  const { clock, store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });

  clock.at += 59999;
  assert.equal(store.claim({ code, characterID: 1 }).outcome, CLAIM_OUTCOME.CLAIMED);

  const second = makeStore();
  const later = second.store.mint({ sessionId: "browser-1" });
  second.clock.at += 60000;
  assert.equal(
    second.store.claim({ code: later.code, characterID: 1 }).outcome,
    CLAIM_OUTCOME.EXPIRED,
  );
});

test("a code that is neither typed nor minted is malformed, not looked up", () => {
  const { store } = makeStore();
  for (const code of ["", "abc", "SAV82K90", null, 42]) {
    assert.equal(store.claim({ code, characterID: 1 }).outcome, CLAIM_OUTCOME.MALFORMED);
  }
});

test("what the player typed is folded before lookup", () => {
  const { store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });
  const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`;
  assert.equal(store.claim({ code: typed, characterID: 1 }).outcome, CLAIM_OUTCOME.CLAIMED);
});

// Sweeping

test("the sweep bounds the store, and only after the grace period", () => {
  const { clock, store } = makeStore();
  store.mint({ sessionId: "browser-1" });
  assert.equal(store.size(), 1);

  clock.at += 60001;
  store.sweep(clock.at);
  assert.equal(store.size(), 1, "an expired code still answers `expired` during grace");

  clock.at += 120000;
  store.sweep(clock.at);
  assert.equal(store.size(), 0);
});

test("a used code becomes unknown once its tombstone is swept", () => {
  const { clock, store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });
  store.claim({ code, characterID: 1 });

  clock.at += 119999;
  assert.equal(store.claim({ code, characterID: 1 }).outcome, CLAIM_OUTCOME.USED);

  clock.at += 2;
  assert.equal(store.claim({ code, characterID: 1 }).outcome, CLAIM_OUTCOME.UNKNOWN);
  assert.equal(store.size(), 0);
});

test("the store cannot grow without bound under sustained minting", () => {
  // No timer involved: mint sweeps inline, which makes an idle-server timer a
  // tidy-up rather than the safety net. This is a heap bound inside the game
  // server's process, so it is a hard-constraint-2 property.
  const { clock, store } = makeStore({ maxPending: 100000 });
  for (let index = 0; index < 500; index += 1) {
    store.mint({ sessionId: `s${index}` });
    clock.at += 1000;
  }
  // TTL 60s + grace 120s = 180 entries' worth of one-per-second minting.
  assert.ok(store.size() <= 181, `expected the store to stay bounded, got ${store.size()}`);
});

// Rate limiting

test("minting is rate limited per session", () => {
  const mintLimiter = makeLimiter({ limit: 2 });
  const { store } = makeStore({ mintLimiter });

  assert.equal(store.mint({ sessionId: "browser-1" }).ok, true);
  assert.equal(store.mint({ sessionId: "browser-1" }).ok, true);

  const refused = store.mint({ sessionId: "browser-1" });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, MINT_FAILURE.RATE_LIMITED);
  assert.ok(refused.retryAfterMs > 0);

  assert.equal(store.mint({ sessionId: "browser-2" }).ok, true, "another session is unaffected");
  // Keyed by the session, verbatim, not by anything the store made up.
  assert.deepEqual(mintLimiter.keys, ["browser-1", "browser-1", "browser-1", "browser-2"]);
});

test("a refused mint never reaches the table", () => {
  // The heap-exhaustion defence only works if the limiter is consulted before
  // the entry is written.
  const { store } = makeStore({ mintLimiter: makeLimiter({ limit: 1 }) });
  assert.equal(store.mint({ sessionId: "browser-1" }).ok, true);
  assert.equal(store.mint({ sessionId: "browser-1" }).ok, false);
  assert.equal(store.size(), 1);
});

test("redemption is rate limited per character", () => {
  const redeemLimiter = makeLimiter({ limit: 3 });
  const { store } = makeStore({ redeemLimiter });

  for (let index = 0; index < 3; index += 1) {
    assert.equal(store.claim({ code: "ZZZZZZZZ", characterID: 5 }).outcome, CLAIM_OUTCOME.UNKNOWN);
  }
  const refused = store.claim({ code: "ZZZZZZZZ", characterID: 5 });
  assert.equal(refused.outcome, CLAIM_OUTCOME.RATE_LIMITED);
  assert.ok(refused.retryAfterMs > 0);

  assert.equal(
    store.claim({ code: "ZZZZZZZZ", characterID: 6 }).outcome,
    CLAIM_OUTCOME.UNKNOWN,
    "another character is unaffected",
  );
  assert.deepEqual(new Set(redeemLimiter.keys), new Set(["char:5", "char:6"]));
});

test("a claim with no usable character shares one harsh bucket", () => {
  const redeemLimiter = makeLimiter({ limit: 1 });
  const { store } = makeStore({ redeemLimiter });

  assert.equal(store.claim({ code: "ZZZZZZZZ" }).outcome, CLAIM_OUTCOME.UNKNOWN);
  assert.equal(store.claim({ code: "ZZZZZZZZ", characterID: 0 }).outcome, CLAIM_OUTCOME.RATE_LIMITED);
  assert.deepEqual(redeemLimiter.keys, ["anonymous", "anonymous"]);
});

test("a throttled guess cannot spend a real code", () => {
  const { store } = makeStore({ redeemLimiter: makeLimiter({ limit: 1 }) });
  const { code } = store.mint({ sessionId: "browser-1" });

  store.claim({ code: "ZZZZZZZZ", characterID: 5 });
  assert.equal(store.claim({ code, characterID: 5 }).outcome, CLAIM_OUTCOME.RATE_LIMITED);
  // The code survived the throttled attempt.
  assert.equal(store.claim({ code, characterID: 6 }).outcome, CLAIM_OUTCOME.CLAIMED);
});

test("a throttled caller is refused before the code is even shape-checked", () => {
  // Otherwise the refusal itself leaks: a malformed string answered `malformed`
  // and a well-formed one answered `rate-limited` would tell an attacker which
  // guesses had the right shape, for free.
  const { store } = makeStore({ redeemLimiter: makeLimiter({ limit: 1 }) });
  store.claim({ code: "ZZZZZZZZ", characterID: 5 });
  assert.equal(
    store.claim({ code: "obviously not a code", characterID: 5 }).outcome,
    CLAIM_OUTCOME.RATE_LIMITED,
  );
});

// No confirmation oracle

test("a code belonging to another session is byte-identical to one that never existed", () => {
  // The property most easily lost in a refactor, because the natural shape (a
  // switch returning a different object per case) loses it silently. So this
  // asserts identity of the serialised answers, not merely that both say
  // "unknown".
  const { store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });

  const answers = [
    store.inspect({ code, sessionId: "browser-2" }),          // real code, wrong session
    store.inspect({ code: "ZZZZZZZZ", sessionId: "browser-1" }), // never minted
    store.inspect({ code: "ZZZZZZZZ", sessionId: "browser-2" }), // neither
    store.inspect({ code, sessionId: "" }),                   // no session at all
    store.inspect({ code: "nope", sessionId: "browser-1" }),   // not even a code shape
    store.inspect({}),
  ];

  for (const answer of answers) {
    assert.equal(JSON.stringify(answer), JSON.stringify(UNKNOWN_INSPECTION));
    assert.deepEqual(Object.keys(answer), Object.keys(UNKNOWN_INSPECTION));
  }
});

test("a spent code still tells no other session anything", () => {
  const { clock, store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });
  store.claim({ code, characterID: 90001 });

  assert.deepEqual(store.inspect({ code, sessionId: "browser-2" }), UNKNOWN_INSPECTION);

  clock.at += 60001;
  assert.deepEqual(store.inspect({ code, sessionId: "browser-2" }), UNKNOWN_INSPECTION);
});

// Release

test("a released claim can be redeemed again", () => {
  const { store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });

  const claimed = store.claim({ code, characterID: 90001 });
  assert.equal(store.release(claimed.claim), true);
  assert.equal(store.claim({ code, characterID: 90001 }).outcome, CLAIM_OUTCOME.CLAIMED);
});

test("a released claim leaves no trace of the character it was claimed by", () => {
  const { store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });
  const claimed = store.claim({ code, characterID: 90001, accountID: 42, role: "8", isGM: true });

  store.release(claimed.claim);
  assert.deepEqual(store.inspect({ code, sessionId: "browser-1" }), {
    state: "pending",
    expiresAt: 61000,
  });
});

test("a claim released after its TTL stays spent", () => {
  // Otherwise a run of failing follow-ups could keep a code alive indefinitely,
  // which undoes the TTL.
  const { clock, store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });
  const claimed = store.claim({ code, characterID: 90001 });

  clock.at += 60001;
  assert.equal(store.release(claimed.claim), false);
  assert.equal(store.claim({ code, characterID: 90001 }).outcome, CLAIM_OUTCOME.EXPIRED);
});

test("releasing junk, or releasing twice, changes nothing", () => {
  const { store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });
  const claimed = store.claim({ code, characterID: 1 });

  assert.equal(store.release(null), false);
  assert.equal(store.release({}), false);
  assert.equal(store.release({ code: "ZZZZZZZZ" }), false);
  assert.equal(store.release(claimed.claim), true);
  assert.equal(store.release(claimed.claim), false, "already pending: nothing to release");
});

// The claim handed to the caller

test("a claim carries the session the code was minted for", () => {
  // This lets the authorize route refuse a bind arriving for a different
  // browser. The store has never seen the browser and cannot make that
  // comparison itself.
  const { store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });
  const claimed = store.claim({
    code,
    characterID: 90001,
    accountID: 42,
    role: "274877906944",
    isGM: true,
  });

  assert.equal(claimed.claim.sessionId, "browser-1");
  assert.equal(claimed.claim.accountID, 42);
  assert.equal(claimed.claim.role, "274877906944");
  assert.equal(claimed.claim.isGM, true);
  assert.equal(claimed.claim.claimedAt, 1000);
});

test("a missing account or role degrades rather than throwing", () => {
  const { store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });
  const claimed = store.claim({ code, characterID: 90001 });

  assert.equal(claimed.claim.accountID, null);
  assert.equal(claimed.claim.role, "0");
  assert.equal(claimed.claim.isGM, false);
});

// Has this been claimed, and by whom?

test("a session polling its own code sees pending, then the whole identity", () => {
  // The question the authorize route holds a mint and needs answered. `nexumApi`
  // pushed the identity to a separate server over HTTP and only reported the
  // character here; the SSO listener is in this process and mints the token
  // itself, so the whole tuple has to survive the claim.
  const { store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });

  assert.deepEqual(store.inspect({ code, sessionId: "browser-1" }), {
    state: "pending",
    expiresAt: 61000,
  });

  store.claim({
    code,
    characterID: 90000001,
    accountID: 12345,
    role: "274877906944",
    isGM: true,
  });

  assert.deepEqual(store.inspect({ code, sessionId: "browser-1" }), {
    state: "used",
    characterID: 90000001,
    accountID: 12345,
    role: "274877906944",
    isGM: true,
    claimedAt: 1000,
  });
});

test("an entry that expired unclaimed reports the same shape with nothing in it", () => {
  // Uniform shape, so a caller reads `state` rather than probing for a key.
  const { clock, store } = makeStore();
  const { code } = store.mint({ sessionId: "browser-1" });

  clock.at += 60001;
  assert.deepEqual(store.inspect({ code, sessionId: "browser-1" }), {
    state: "expired",
    characterID: null,
    accountID: null,
    role: null,
    isGM: false,
    claimedAt: null,
  });
});

test("stats report what is live and what is a tombstone", () => {
  const { clock, store } = makeStore();
  const first = store.mint({ sessionId: "a" });
  store.mint({ sessionId: "b" });
  store.claim({ code: first.code, characterID: 1 });

  assert.deepEqual(store.stats(), {
    pending: 1, spent: 1, total: 2, maxPending: DEFAULT_MAX_PENDING,
  });

  clock.at += 60001;
  assert.deepEqual(store.stats(), {
    pending: 0, spent: 2, total: 2, maxPending: DEFAULT_MAX_PENDING,
  });
});

// Construction

test("a store without a clock or a generator refuses to exist", () => {
  assert.throws(() => createPendingBindStore({}), /clock/);
  assert.throws(() => createPendingBindStore({ now: () => 0 }), /generator/);
});

test("the store handle is frozen, because it is a process-wide singleton", () => {
  const { store } = makeStore();
  assert.throws(() => {
    store.claim = () => ({ outcome: CLAIM_OUTCOME.CLAIMED });
  }, TypeError);
});
