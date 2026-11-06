/**
 * Tests for lib/bindFlow.js.
 *
 * Run with:  node --test "test/**\/*.test.js"   (from the mod directory)
 *
 * Everything is driven by an injected clock and a store double, so no test
 * sleeps and none depends on randomness. The doubles matter for most of the
 * file: this module owes a translation (which id goes where, which field is
 * renamed, which fields never leave), and a double is the only way to assert
 * that a field is absent by construction rather than by luck.
 *
 * A suite of doubles can become doubles agreeing with each other, so the last
 * test composes the real `createPendingBindStore` with the real
 * `createBindFlow` and walks a bind from mint to claim to an approved poll. If
 * the two files disagree about a field name, that test notices.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  BIND_STATE,
  DEFAULT_MAX_PENDING,
  MAX_MAPPING_AGE_MS,
  MAX_REQUEST_ID_LENGTH,
  UNKNOWN_ANSWER,
  createBindFlow,
} = require(path.join(__dirname, "..", "lib", "bindFlow"));

const {
  CLAIM_OUTCOME,
  ENTRY_STATE,
  MINT_FAILURE,
  createPendingBindStore,
} = require(path.join(__dirname, "..", "lib", "pendingBinds"));

const { BIND_CODE_ALPHABET, isBindCodeShape } = require(
  path.join(__dirname, "..", "lib", "bindCodes"),
);

// A store double
//
// It records what it was asked, because half of what this module owes is the
// keying (`sessionId` is the request id, verbatim) and a test that only
// watched the return value would pass with the ids swapped.

function makeStore({ mint, inspect } = {}) {
  const entries = new Map(); // code -> inspection object
  const calls = { mint: [], inspect: [] };
  let sequence = 0;

  const store = {
    calls,
    entries,
    mint(request) {
      calls.mint.push(request);
      if (typeof mint === "function") return mint(request, entries);
      sequence += 1;
      const code = `CODE${String(sequence).padStart(4, "0")}`;
      entries.set(code, { state: ENTRY_STATE.PENDING, expiresAt: 120000 });
      return { ok: true, code, expiresAt: 120000, ttlMs: 120000 };
    },
    inspect(request) {
      calls.inspect.push(request);
      if (typeof inspect === "function") return inspect(request, entries);
      const found = entries.get(request && request.code);
      return found === undefined ? { state: "unknown" } : found;
    },
  };
  return store;
}

/** Move a double's entry to whatever state a test needs next. */
function setEntry(store, code, inspection) {
  store.entries.set(code, inspection);
}

// The happy path

test("mint, pending, then approved with the character id translated", () => {
  const store = makeStore();
  const flow = createBindFlow({ store, now: () => 1000 });

  const minted = flow.mint({ requestId: "req-alpha" });
  assert.equal(typeof minted.code, "string");
  assert.ok(minted.code !== "");
  assert.equal(minted.expiresAt, 120000);
  assert.equal(minted.failure, undefined);

  // The request id goes to the store as its session id, unchanged and
  // unparsed. There is no id mapping in this chain to get wrong.
  assert.deepEqual(store.calls.mint, [{ sessionId: "req-alpha" }]);

  assert.deepEqual(flow.peek("req-alpha"), { state: BIND_STATE.PENDING });
  assert.deepEqual(store.calls.inspect.at(-1), {
    sessionId: "req-alpha",
    code: minted.code,
  });

  setEntry(store, minted.code, {
    state: ENTRY_STATE.USED,
    characterID: 90000001,
    accountID: 4242,
    role: "128",
    isGM: true,
    claimedAt: 900,
  });

  const seen = flow.peek("req-alpha");
  assert.deepEqual(seen, { state: BIND_STATE.APPROVED, characterId: 90000001 });

  // The route's own gate, asserted here so a regression is caught at this seam
  // rather than as a `server_error` at the last step of a real sign-in.
  assert.ok(Number.isInteger(seen.characterId) && seen.characterId > 0);
});

test("a spent entry stays approved across repeated polls, and nothing is consumed here", () => {
  // The route consumes its own pending entry before minting a code. This module
  // has no equivalent and must not grow one: a poll that silently unmade the
  // answer would turn a retried fetch into a dead sign-in.
  const store = makeStore();
  const flow = createBindFlow({ store, now: () => 0 });
  const minted = flow.mint({ requestId: "req" });
  setEntry(store, minted.code, { state: ENTRY_STATE.USED, characterID: 7, claimedAt: 1 });

  assert.deepEqual(flow.peek("req"), { state: BIND_STATE.APPROVED, characterId: 7 });
  assert.deepEqual(flow.peek("req"), { state: BIND_STATE.APPROVED, characterId: 7 });
  assert.equal(flow.size(), 1);
});

// `characterID` -> `characterId`, and nothing else

test("nothing from a spent entry reaches the caller but the state and the character", () => {
  // A deliberately leaky store: everything a real spent entry carries, plus
  // three fields no store has, because the failure guarded against is a spread
  // rather than a named read, and a spread would carry those too.
  const store = makeStore({
    mint: () => ({ ok: true, code: "LEAKY001", expiresAt: 1 }),
    inspect: () => ({
      state: ENTRY_STATE.USED,
      characterID: 12345,
      accountID: 999,
      role: "2147483648",
      isGM: true,
      claimedAt: 1700000000000,
      sessionId: "req-leaky",
      code: "LEAKY001",
      secret: "should never appear",
    }),
  });
  const flow = createBindFlow({ store, now: () => 0 });
  flow.mint({ requestId: "req-leaky" });

  const seen = flow.peek("req-leaky");
  assert.deepEqual(Object.keys(seen).sort(), ["characterId", "state"]);
  assert.deepEqual(seen, { state: BIND_STATE.APPROVED, characterId: 12345 });

  // Named individually, because `deepEqual` above would already fail, but a
  // future answer that legitimately grows a field must not be able to grow one
  // of these.
  for (const leaked of ["characterID", "accountID", "role", "isGM", "claimedAt", "secret", "code"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(seen, leaked),
      false,
      `${leaked} must not reach the poll response`,
    );
  }
});

test("an approved entry with an unusable character id says so", () => {
  // `null` reaches the route's `Number.isInteger` check, which logs it and
  // answers `server_error`. Laundering it into `expired` would tell the player
  // to generate a new code for a bug that will happen again.
  for (const characterID of [null, undefined, 0, -5, "not a number", Number.NaN]) {
    const store = makeStore({
      mint: () => ({ ok: true, code: "AAAA0002", expiresAt: 1 }),
      inspect: () => ({ state: ENTRY_STATE.USED, characterID, claimedAt: 1 }),
    });
    const flow = createBindFlow({ store, now: () => 0 });
    flow.mint({ requestId: "req" });
    assert.deepEqual(
      flow.peek("req"),
      { state: BIND_STATE.APPROVED, characterId: null },
      `characterID ${JSON.stringify(characterID)}`,
    );
  }
});

test("a numeric-string character id is translated to a number, as the route needs", () => {
  const store = makeStore({
    mint: () => ({ ok: true, code: "AAAA0003", expiresAt: 1 }),
    inspect: () => ({ state: ENTRY_STATE.USED, characterID: "90000042", claimedAt: 1 }),
  });
  const flow = createBindFlow({ store, now: () => 0 });
  flow.mint({ requestId: "req" });
  assert.deepEqual(flow.peek("req"), { state: BIND_STATE.APPROVED, characterId: 90000042 });
});

// The non-approved states

test("a pending entry answers pending and carries nothing else", () => {
  const store = makeStore({
    mint: () => ({ ok: true, code: "AAAA0004", expiresAt: 5000 }),
    inspect: () => ({ state: ENTRY_STATE.PENDING, expiresAt: 5000 }),
  });
  const flow = createBindFlow({ store, now: () => 0 });
  flow.mint({ requestId: "req" });

  const seen = flow.peek("req");
  assert.deepEqual(seen, { state: BIND_STATE.PENDING });
  // `expiresAt` was already given to the browser at mint. Repeating it on every
  // poll adds a field to an unauthenticated response for no reader.
  assert.equal(Object.keys(seen).length, 1);
});

test("an expired entry answers expired, and the mapping goes with it", () => {
  const store = makeStore();
  const flow = createBindFlow({ store, now: () => 0 });
  const minted = flow.mint({ requestId: "req" });
  setEntry(store, minted.code, {
    state: ENTRY_STATE.EXPIRED,
    characterID: null,
    accountID: null,
    role: null,
    isGM: false,
    claimedAt: null,
  });

  assert.deepEqual(flow.peek("req"), { state: BIND_STATE.EXPIRED });
  assert.equal(flow.size(), 0, "a dead mapping is dropped by the poll that found it");
  // The second poll is the ordinary no-information answer.
  assert.equal(flow.peek("req"), UNKNOWN_ANSWER);
});

test("a store that has forgotten the code answers unknown and drops the mapping", () => {
  const store = makeStore();
  const flow = createBindFlow({ store, now: () => 0 });
  flow.mint({ requestId: "req" });
  store.entries.clear();

  assert.equal(flow.peek("req"), UNKNOWN_ANSWER);
  assert.equal(flow.size(), 0);
});

test("a state this module does not know is not approved", () => {
  // A future store growing a fifth state must fail closed. The route treats
  // everything that is not `pending` or `approved` as a sign-in that will not
  // complete, and so does this module.
  const store = makeStore({
    mint: () => ({ ok: true, code: "AAAA0005", expiresAt: 1 }),
    inspect: () => ({ state: "quarantined", characterID: 5 }),
  });
  const flow = createBindFlow({ store, now: () => 0 });
  flow.mint({ requestId: "req" });
  assert.equal(flow.peek("req"), UNKNOWN_ANSWER);
});

// No oracle

test("every no-information path answers with the same bytes", () => {
  // `lib/pendingBinds.js` asserts `JSON.stringify` identity across six of its
  // own paths and the route asserts it across its own; this holds the same line
  // at the layer between them, so the property is true end to end.
  const working = createBindFlow({ store: makeStore(), now: () => 0 });
  working.mint({ requestId: "someone-elses-request" });

  const swept = createBindFlow({ store: makeStore(), now: () => 0 });
  const sweptStore = makeStore();
  const sweptFlow = createBindFlow({ store: sweptStore, now: () => 0 });
  sweptFlow.mint({ requestId: "req" });
  sweptStore.entries.clear();

  const throwing = createBindFlow({
    store: makeStore({ inspect: () => { throw new Error("store is on fire"); } }),
    now: () => 0,
  });
  throwing.mint({ requestId: "req" });

  const answers = [
    ["an absent request id", working.peek(undefined)],
    ["an empty request id", working.peek("")],
    ["a whitespace request id", working.peek("   ")],
    ["a request id that is not a string", working.peek({ requestId: "req" })],
    ["an oversized request id", working.peek("x".repeat(MAX_REQUEST_ID_LENGTH + 1))],
    ["a request id this map never held", working.peek("never-minted")],
    ["somebody else's live request", swept.peek("someone-elses-request")],
    ["a request whose store entry was swept", sweptFlow.peek("req")],
    ["a store that is not there at all", createBindFlow({ now: () => 0 }).peek("req")],
    ["a store that threw", throwing.peek("req")],
  ];

  const expected = JSON.stringify(UNKNOWN_ANSWER);
  for (const [label, answer] of answers) {
    assert.equal(JSON.stringify(answer), expected, label);
    // Byte identity is the assertion; object identity is how it is kept true.
    assert.equal(answer, UNKNOWN_ANSWER, label);
  }
  assert.ok(answers.length >= 6);
});

test("the frozen answers cannot be edited by a caller into something that differs", () => {
  const flow = createBindFlow({ store: makeStore(), now: () => 0 });
  const answer = flow.peek("nothing");
  assert.ok(Object.isFrozen(answer));
  assert.throws(() => {
    "use strict";
    answer.state = "approved";
  });
  assert.equal(flow.peek("nothing").state, BIND_STATE.UNKNOWN);
});

// Minting refusals

test("a missing or unusable request id is refused without touching the store", () => {
  const store = makeStore();
  const flow = createBindFlow({ store, now: () => 0 });

  for (const requestId of [undefined, null, "", "   ", 42, {}, "x".repeat(257)]) {
    const minted = flow.mint({ requestId });
    assert.deepEqual(minted, { code: null, failure: MINT_FAILURE.INVALID_SESSION });
  }
  assert.equal(flow.mint().code, null);
  assert.equal(store.calls.mint.length, 0);
});

test("no store at all is UNAVAILABLE, in the store's own spelling", () => {
  // `lib/pendingBinds.js` names this reason and never returns it, leaving it to
  // the composing layer. This is that layer, and it imports the constant rather
  // than respelling the string.
  assert.deepEqual(
    createBindFlow({ now: () => 0 }).mint({ requestId: "req" }),
    { code: null, failure: MINT_FAILURE.UNAVAILABLE },
  );
  assert.deepEqual(
    createBindFlow({ store: {}, now: () => 0 }).mint({ requestId: "req" }),
    { code: null, failure: MINT_FAILURE.UNAVAILABLE },
  );
  // A `mint` with no `inspect` behind it would hand out codes nothing could ever
  // complete, so half a store is no store.
  assert.deepEqual(
    createBindFlow({ store: { mint: () => ({ ok: true, code: "X" }) }, now: () => 0 })
      .mint({ requestId: "req" }),
    { code: null, failure: MINT_FAILURE.UNAVAILABLE },
  );
});

test("a store that throws becomes a refusal, never an exception", () => {
  // The listener shares the game's event loop and eve.js treats an unhandled
  // rejection as fatal. An adapter that can take the server down on a mint has
  // inverted its purpose (design constraint 2).
  const store = makeStore({ mint: () => { throw new Error("store is on fire"); } });
  const flow = createBindFlow({ store, now: () => 0 });
  assert.deepEqual(flow.mint({ requestId: "req" }), {
    code: null,
    failure: MINT_FAILURE.UNAVAILABLE,
  });
  assert.equal(flow.size(), 0);
});

test("the store's own refusal vocabulary is passed through, not rewritten", () => {
  for (const reason of [
    MINT_FAILURE.RATE_LIMITED,
    MINT_FAILURE.FULL,
    MINT_FAILURE.GENERATOR,
    MINT_FAILURE.INVALID_SESSION,
  ]) {
    const flow = createBindFlow({
      store: makeStore({ mint: () => ({ ok: false, reason }) }),
      now: () => 0,
    });
    assert.deepEqual(flow.mint({ requestId: "req" }), { code: null, failure: reason });
  }
});

test("a store answering with something nobody wrote down is UNAVAILABLE", () => {
  for (const answer of [null, undefined, {}, { ok: true }, { ok: true, code: "" }, { ok: false }]) {
    const flow = createBindFlow({
      store: makeStore({ mint: () => answer }),
      now: () => 0,
    });
    assert.deepEqual(
      flow.mint({ requestId: "req" }),
      { code: null, failure: MINT_FAILURE.UNAVAILABLE },
      JSON.stringify(answer),
    );
  }
});

test("every refusal has the shape the route tests for", () => {
  // `routes/oauthAuthorize.js`: `!bind || typeof bind.code !== "string"` and
  // then `bind.failure`. A refusal that answered `{ ok: false }` would be read
  // as "no reason given".
  const flow = createBindFlow({ now: () => 0 });
  const refused = flow.mint({ requestId: "req" });
  assert.equal(refused.code, null);
  assert.notEqual(typeof refused.code, "string");
  assert.equal(typeof refused.failure, "string");
  assert.ok(refused.failure !== "");
});

// The cap, and the lazy sweep

test("at the cap mint refuses and no live mapping is evicted", () => {
  // The opposite of `lib/bindRateLimiter.js`, on purpose: that holds counters and
  // evicting one loses an accounting detail; this holds the only link between a
  // live authorization and the code that completes it, so eviction would
  // silently kill a sign-in a human is in the middle of.
  const store = makeStore();
  const flow = createBindFlow({ store, now: () => 0, maxPending: 2 });

  const first = flow.mint({ requestId: "req-1" });
  const second = flow.mint({ requestId: "req-2" });
  assert.equal(typeof first.code, "string");
  assert.equal(typeof second.code, "string");

  assert.deepEqual(flow.mint({ requestId: "req-3" }), {
    code: null,
    failure: MINT_FAILURE.FULL,
  });

  assert.equal(flow.size(), 2);
  assert.deepEqual(flow.peek("req-1"), { state: BIND_STATE.PENDING });
  assert.deepEqual(flow.peek("req-2"), { state: BIND_STATE.PENDING });
});

test("the sweep runs on mint, so a full map of dead entries drains itself", () => {
  const store = makeStore();
  const flow = createBindFlow({ store, now: () => 0, maxPending: 2 });

  const first = flow.mint({ requestId: "req-1" });
  const second = flow.mint({ requestId: "req-2" });
  assert.deepEqual(flow.mint({ requestId: "req-3" }).failure, MINT_FAILURE.FULL);

  // Both binds die in the store. Nobody ever polled, the case a browser that
  // renders the page and closes creates.
  setEntry(store, first.code, { state: ENTRY_STATE.EXPIRED, characterID: null });
  store.entries.delete(second.code);

  const third = flow.mint({ requestId: "req-3" });
  assert.equal(typeof third.code, "string");
  assert.equal(flow.size(), 1, "the two dead mappings went, the new one stayed");
});

test("the sweep never drops a mapping that is still pending or approved", () => {
  const store = makeStore();
  const flow = createBindFlow({ store, now: () => 0, maxPending: 8 });
  const live = flow.mint({ requestId: "live" });
  const done = flow.mint({ requestId: "done" });
  const dead = flow.mint({ requestId: "dead" });

  setEntry(store, done.code, { state: ENTRY_STATE.USED, characterID: 11, claimedAt: 1 });
  store.entries.delete(dead.code);

  assert.equal(flow.sweep(0), 1);
  assert.equal(flow.size(), 2);
  assert.deepEqual(flow.peek("live"), { state: BIND_STATE.PENDING });
  assert.deepEqual(flow.peek("done"), { state: BIND_STATE.APPROVED, characterId: 11 });
  assert.ok(live.code !== done.code);
});

test("a mapping is dropped once it is older than the ceiling, whatever the store says", () => {
  // The bound on this map has to be this module's own property. A store
  // misconfigured with an enormous grace, or not the store this file was written
  // against, would otherwise keep every mapping alive.
  let clock = 0;
  const store = makeStore({
    mint: () => ({ ok: true, code: "AAAA0006", expiresAt: 1 }),
    inspect: () => ({ state: ENTRY_STATE.PENDING, expiresAt: Number.MAX_SAFE_INTEGER }),
  });
  const flow = createBindFlow({ store, now: () => clock });

  flow.mint({ requestId: "req" });
  clock = MAX_MAPPING_AGE_MS - 1;
  assert.deepEqual(flow.peek("req"), { state: BIND_STATE.PENDING });

  clock = MAX_MAPPING_AGE_MS;
  assert.equal(flow.peek("req"), UNKNOWN_ANSWER);
  assert.equal(flow.size(), 0);
});

test("minting again for the same request id replaces rather than grows the map", () => {
  const store = makeStore();
  const flow = createBindFlow({ store, now: () => 0, maxPending: 1 });
  const first = flow.mint({ requestId: "req" });
  const second = flow.mint({ requestId: "req" });

  assert.equal(typeof second.code, "string");
  assert.notEqual(second.code, first.code);
  assert.equal(flow.size(), 1);
  assert.deepEqual(flow.peek("req"), { state: BIND_STATE.PENDING });
  assert.deepEqual(store.calls.inspect.at(-1), { sessionId: "req", code: second.code });
});

// Forget

test("forget drops one mapping and leaves the others alone", () => {
  const store = makeStore();
  const flow = createBindFlow({ store, now: () => 0 });
  flow.mint({ requestId: "req-1" });
  flow.mint({ requestId: "req-2" });

  assert.equal(flow.forget("req-1"), undefined);
  assert.equal(flow.peek("req-1"), UNKNOWN_ANSWER);
  assert.deepEqual(flow.peek("req-2"), { state: BIND_STATE.PENDING });
  assert.equal(flow.size(), 1);
});

test("forget of something unknown is a no-op rather than a throw", () => {
  const flow = createBindFlow({ store: makeStore(), now: () => 0 });
  for (const id of [undefined, null, "", "   ", 7, {}, "never-minted"]) {
    assert.equal(flow.forget(id), undefined);
  }
  assert.equal(flow.size(), 0);
});

test("forget does not un-spend a code in the store", () => {
  // A claimed code stays claimed, so the player who typed it is still told
  // `used` rather than `unknown` if they try it again.
  const store = makeStore();
  const flow = createBindFlow({ store, now: () => 0 });
  const minted = flow.mint({ requestId: "req" });
  setEntry(store, minted.code, { state: ENTRY_STATE.USED, characterID: 3, claimedAt: 1 });

  flow.forget("req");
  assert.equal(store.entries.get(minted.code).state, ENTRY_STATE.USED);
});

// Construction

test("the flow is frozen and exposes exactly the interface the route requires", () => {
  const flow = createBindFlow({ store: makeStore(), now: () => 0 });
  assert.ok(Object.isFrozen(flow));
  // `routes/oauthAuthorize.js` validates these two at construction time.
  assert.equal(typeof flow.mint, "function");
  assert.equal(typeof flow.peek, "function");
  assert.equal(typeof flow.forget, "function");
});

test("nonsense bounds fall back rather than throwing during boot", () => {
  for (const maxPending of [0, -1, Number.NaN, "many", undefined]) {
    const flow = createBindFlow({ store: makeStore(), now: () => 0, maxPending });
    assert.equal(flow.maxPending, DEFAULT_MAX_PENDING);
  }
});

test("a clock that is not a clock does not stop the flow working", () => {
  for (const now of [undefined, null, 5, "now", () => Number.NaN, () => "later"]) {
    const flow = createBindFlow({ store: makeStore(), now });
    const minted = flow.mint({ requestId: "req" });
    assert.equal(typeof minted.code, "string", String(now));
    assert.deepEqual(flow.peek("req"), { state: BIND_STATE.PENDING });
  }
});

test("stats reports what it is holding and whether it can mint at all", () => {
  const flow = createBindFlow({ store: makeStore(), now: () => 0, maxPending: 4 });
  assert.deepEqual(flow.stats(), { tracked: 0, maxPending: 4, available: true });
  flow.mint({ requestId: "req" });
  assert.deepEqual(flow.stats(), { tracked: 1, maxPending: 4, available: true });
  assert.equal(createBindFlow({ now: () => 0 }).stats().available, false);
});

// The real store, because everything above is doubles

test("the real store and the real flow complete a bind end to end", () => {
  // Deterministic codes in the real alphabet: the generator is injected, so this
  // needs no randomness and no `crypto`.
  let sequence = 0;
  function generateCode() {
    sequence += 1;
    let remaining = sequence;
    let code = "";
    for (let index = 0; index < 8; index += 1) {
      code = BIND_CODE_ALPHABET[remaining % BIND_CODE_ALPHABET.length] + code;
      remaining = Math.floor(remaining / BIND_CODE_ALPHABET.length);
    }
    return code;
  }

  let clock = 1_700_000_000_000;
  const store = createPendingBindStore({ now: () => clock, generateCode });
  const flow = createBindFlow({ store, now: () => clock });

  // Mint
  const minted = flow.mint({ requestId: "request-id-alpha" });
  assert.ok(isBindCodeShape(minted.code), `${minted.code} is not a bind code`);
  assert.equal(minted.expiresAt, clock + store.ttlMs);
  assert.equal(Object.keys(minted).sort().join(","), "code,expiresAt");

  // Pending
  clock += 3000;
  assert.deepEqual(flow.peek("request-id-alpha"), { state: BIND_STATE.PENDING });

  // A different request id learns nothing, in the same bytes as everything else
  // that learns nothing.
  assert.equal(flow.peek("request-id-beta"), UNKNOWN_ANSWER);

  // The player types it in game
  const claimed = store.claim({
    code: minted.code,
    characterID: 90000042,
    accountID: 5150,
    role: "128",
    isGM: true,
  });
  assert.equal(claimed.outcome, CLAIM_OUTCOME.CLAIMED);
  assert.equal(claimed.claim.sessionId, "request-id-alpha");

  // Approved
  clock += 2000;
  const seen = flow.peek("request-id-alpha");
  assert.deepEqual(seen, { state: BIND_STATE.APPROVED, characterId: 90000042 });

  // The real store spells it `characterID` and carries the rest of the
  // identity; this asserts that the two files agree about the rename and that
  // none of the rest crossed the seam.
  const raw = store.inspect({ sessionId: "request-id-alpha", code: minted.code });
  assert.equal(raw.characterID, 90000042);
  assert.equal(raw.accountID, 5150);
  assert.equal(raw.isGM, true);
  assert.equal(Object.prototype.hasOwnProperty.call(seen, "accountID"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(seen, "isGM"), false);

  // The route's gate passes, which is what mints the code
  assert.ok(Number.isInteger(seen.characterId) && seen.characterId > 0);

  // Past the tombstone, and what collects it
  // The real store sweeps only on its own `mint` and `claim`, so a tombstone
  // whose grace has run out is still there until something else happens.
  // `approved` remains the honest answer until then.
  clock += store.graceMs + 1;
  assert.deepEqual(flow.peek("request-id-alpha"), {
    state: BIND_STATE.APPROVED,
    characterId: 90000042,
  });

  store.sweep(clock);
  assert.equal(flow.peek("request-id-alpha"), UNKNOWN_ANSWER);
  assert.equal(flow.size(), 0);
});

test("the real store expiring a code reaches the caller as expired, then unknown", () => {
  let sequence = 0;
  const generateCode = () => {
    sequence += 1;
    return `AAAAAA${BIND_CODE_ALPHABET[sequence % 30]}${BIND_CODE_ALPHABET[(sequence * 7) % 30]}`;
  };

  let clock = 0;
  const store = createPendingBindStore({ now: () => clock, generateCode });
  const flow = createBindFlow({ store, now: () => clock });

  flow.mint({ requestId: "req" });
  clock += store.ttlMs;
  assert.deepEqual(flow.peek("req"), { state: BIND_STATE.EXPIRED });

  // Dropped by the poll that found it, so the next answer is the ordinary
  // no-information one, which the route turns into its `expired` page either way.
  assert.equal(flow.peek("req"), UNKNOWN_ANSWER);
  assert.equal(flow.size(), 0);
});

test("the real store's limiters are honoured through this adapter", () => {
  // The composition the rate limiter exists for: the store's documented
  // `{ check(key, now) -> { allowed, retryAfterMs } }`, satisfied by
  // `lib/bindRateLimiter.js`, keyed per session, refusing through here.
  const { createBindRateLimiter } = require(
    path.join(__dirname, "..", "lib", "bindRateLimiter"),
  );

  let sequence = 0;
  const generateCode = () => {
    sequence += 1;
    return `BBBBBB${BIND_CODE_ALPHABET[sequence % 30]}${BIND_CODE_ALPHABET[(sequence * 11) % 30]}`;
  };

  const clock = 0;
  const store = createPendingBindStore({
    now: () => clock,
    generateCode,
    mintLimiter: createBindRateLimiter({ limit: 2, intervalMs: 60000 }),
  });
  const flow = createBindFlow({ store, now: () => clock });

  assert.equal(typeof flow.mint({ requestId: "req-a" }).code, "string");
  assert.equal(typeof flow.mint({ requestId: "req-a" }).code, "string");
  assert.deepEqual(flow.mint({ requestId: "req-a" }), {
    code: null,
    failure: MINT_FAILURE.RATE_LIMITED,
  });

  // Per session, so a different browser is unaffected. That is the point of the
  // keying.
  assert.equal(typeof flow.mint({ requestId: "req-b" }).code, "string");
});
