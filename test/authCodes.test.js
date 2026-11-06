/**
 * ESI/SSO Replica Mod: authorization code store tests
 *
 * Run with:  node --test "test/**\/*.test.js"   (from the mod directory, or RunTests.bat)
 *
 * Every case injects both sources of non-determinism the module has: the clock
 * and the code generator. Nothing sleeps, nothing calls `Date.now()`, and no
 * assertion depends on a random string, so expiry is arithmetic, the cap is a
 * counted loop, and a failure means the code is wrong rather than that the
 * machine was busy.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_MAX_PENDING,
  DEFAULT_TOMBSTONE_MS,
  DEFAULT_TTL_MS,
  MINT_FAILURE,
  REDEEM_OUTCOME,
  AuthCodeError,
  createAuthCodeStore,
  defaultGenerateCode,
} = require("../lib/authCodes");

/** A clock a test moves by hand. */
function clock(start = 1_700_000_000_000) {
  let at = start;
  return {
    now: () => at,
    advance(ms) {
      at += ms;
      return at;
    },
    get at() {
      return at;
    },
  };
}

/** Codes that are predictable, so an assertion can name one. */
function counter(prefix = "code-") {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

function storeWith(options = {}) {
  const time = clock();
  const store = createAuthCodeStore({ now: time.now, generateCode: counter(), ...options });
  return { store, time };
}

/** A grant with every field the token endpoint needs, each one distinguishable. */
const GRANT = Object.freeze({
  clientId: "1a2b3c4d5e6f7g8h9i0j",
  redirectUri: "http://127.0.0.1:8080/callback?state=abc",
  scope: "esi-skills.read_skills.v1 esi-wallet.read_character_wallet.v1",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  codeChallengeMethod: "S256",
  characterId: 90000001,
});

// Mint and redeem

test("a redeemed code returns every field it was minted with, verbatim", () => {
  // The token endpoint verifies PKCE by hashing the code_verifier and comparing
  // it to the code_challenge recorded here, and compares the redirect_uri
  // byte-for-byte against the one the code was minted for. A store that trimmed,
  // normalised or re-encoded any of this would break both, silently, for values
  // that are perfectly legal.
  const { store } = storeWith();
  const { code } = store.mint(GRANT);

  const { outcome, record } = store.redeem(code);

  assert.equal(outcome, REDEEM_OUTCOME.OK);
  for (const [field, value] of Object.entries(GRANT)) {
    assert.equal(record[field], value, field);
  }
});

test("the store keeps what it is given rather than judging it", () => {
  // The route decides what a valid authorization request is: it is the only
  // layer that can answer a bad one in the shape OAuth requires. A second opinion
  // here is how the two eventually disagree.
  const { store } = storeWith();
  const odd = {
    clientId: "",
    redirectUri: "not-a-uri",
    scope: undefined,
    codeChallenge: "  padded  ",
    codeChallengeMethod: "plain",
    characterId: null,
  };

  const { code } = store.mint(odd);
  const { record } = store.redeem(code);

  assert.equal(record.codeChallenge, "  padded  ");
  assert.equal(record.codeChallengeMethod, "plain");
  assert.equal(record.redirectUri, "not-a-uri");
});

test("mint reports the expiry it recorded, measured from the injected clock", () => {
  const { store, time } = storeWith({ ttlMs: 45_000 });
  const minted = store.mint(GRANT);

  assert.equal(minted.expiresAt, time.at + 45_000);
  assert.equal(store.redeem(minted.code).record.expiresAt, minted.expiresAt);
});

test("the record is frozen, so nothing can rewrite a grant after the fact", () => {
  const { store } = storeWith();
  const { record } = store.redeem(store.mint(GRANT).code);

  assert.equal(Object.isFrozen(record), true);
  assert.throws(() => {
    record.characterId = 1;
  });
});

// Single use

test("a code redeems exactly once", () => {
  const { store } = storeWith();
  const { code } = store.mint(GRANT);

  assert.equal(store.redeem(code).outcome, REDEEM_OUTCOME.OK);

  const replay = store.redeem(code);
  assert.equal(replay.outcome, REDEEM_OUTCOME.ALREADY_USED);
  // Nothing comes back with it, so nothing can be issued from the replay.
  assert.equal(replay.record, null);

  // A third attempt says the same thing as the second.
  assert.equal(store.redeem(code).outcome, REDEEM_OUTCOME.ALREADY_USED);
});

test("a replay is a distinct outcome, because the token endpoint has to be able to act on it", () => {
  // RFC 6749 section 4.1.2 says a replayed code should also revoke what was
  // issued from it. That belongs to the token endpoint, since this store has
  // never seen a token. It is only possible because "used" does not arrive here
  // flattened into the same answer as "never existed".
  const { store } = storeWith();
  const { code } = store.mint(GRANT);
  store.redeem(code);

  assert.notEqual(REDEEM_OUTCOME.ALREADY_USED, REDEEM_OUTCOME.UNKNOWN);
  assert.equal(store.redeem(code).outcome, REDEEM_OUTCOME.ALREADY_USED);
  assert.equal(store.redeem("never-minted").outcome, REDEEM_OUTCOME.UNKNOWN);
});

test("redeeming one code does not disturb another", () => {
  const { store } = storeWith();
  const first = store.mint(GRANT);
  const second = store.mint({ ...GRANT, characterId: 90000002 });

  store.redeem(first.code);

  const result = store.redeem(second.code);
  assert.equal(result.outcome, REDEEM_OUTCOME.OK);
  assert.equal(result.record.characterId, 90000002);
});

// A replay, and the grant it names

test("a replay names the character and the client, and still hands back no record", () => {
  // The token endpoint revokes on a replay (RFC 6749 section 4.1.2) and needs to
  // know whose grant to revoke. It must never get the grant itself: the replay
  // branch has authenticated the client and nothing else, with no `mayRedeem` and
  // no PKCE, so a record here would be a token issued to whoever sniffed the
  // code.
  const { store } = storeWith();
  const { code } = store.mint(GRANT);
  store.redeem(code);

  const replay = store.redeem(code);

  assert.equal(replay.outcome, REDEEM_OUTCOME.ALREADY_USED);
  assert.equal(replay.grant.characterId, GRANT.characterId);
  assert.equal(replay.grant.clientId, GRANT.clientId);
  assert.equal(replay.record, null);
});

test("a replay reports the reference the token endpoint bound, and null when nobody bound one", () => {
  // Null is the honest answer after a restart, and after a redemption that
  // issued nothing worth revoking: "whose grant it was, but not which one".
  const { store } = storeWith({ maxPending: 4 });

  const bound = store.mint(GRANT).code;
  store.redeem(bound);
  assert.equal(store.rememberGrant(bound, "family-1"), true);
  assert.equal(store.redeem(bound).grant.grantRef, "family-1");

  const unbound = store.mint(GRANT).code;
  store.redeem(unbound);
  const replay = store.redeem(unbound);
  assert.equal(replay.grant.grantRef, null);
  assert.equal(replay.grant.characterId, GRANT.characterId, "the identity survives either way");
});

test("a redemption carries no grant, so a non-null grant means a replay and nothing else", () => {
  // The ok path hands back the whole record, which already carries characterId
  // and clientId. Spelling them a second way in a grant object would be two
  // sources for one fact, and would cost the one invariant worth having.
  const { store } = storeWith();
  const { code } = store.mint(GRANT);

  const redeemed = store.redeem(code);
  assert.equal(redeemed.outcome, REDEEM_OUTCOME.OK);
  assert.equal(redeemed.grant, null);
  assert.equal(redeemed.record.scope, GRANT.scope, "and the record is untouched by any of this");

  assert.notEqual(store.redeem(code).grant, null, "the replay is the one call that gets one");
});

test("what a replay is told is two identifying fields and a reference, and nothing else", () => {
  // Asserted as an absence on purpose. `codeChallenge` has no reader once the
  // redemption that verified it is over, and a change that widens the tombstone
  // to carry live credential material for five more minutes should trip a test
  // rather than pass review quietly.
  const { store } = storeWith();
  const { code } = store.mint(GRANT);
  store.redeem(code);

  const { grant } = store.redeem(code);

  assert.deepEqual(Object.keys(grant).sort(), ["characterId", "clientId", "grantRef"]);
  for (const field of ["scope", "codeChallenge", "codeChallengeMethod", "redirectUri"]) {
    assert.equal(grant[field], undefined, field);
    assert.equal(Object.prototype.hasOwnProperty.call(grant, field), false, field);
  }
  assert.equal(Object.isFrozen(grant), true);
});

test("the outcomes that were never redeemed carry no grant at all", () => {
  // A null grant means nothing was ever issued from this and there is nothing to
  // revoke, which is a different fact from a replay whose reference was never
  // bound.
  const { store, time } = storeWith({ ttlMs: 1_000 });
  const { code } = store.mint(GRANT);
  time.advance(1_000);

  const expired = store.redeem(code);
  assert.equal(expired.outcome, REDEEM_OUTCOME.EXPIRED);
  assert.equal(expired.grant, null);

  const unknown = store.redeem("never-minted");
  assert.equal(unknown.outcome, REDEEM_OUTCOME.UNKNOWN);
  assert.equal(unknown.grant, null);

  for (const bad of [undefined, null, "", 42, {}]) {
    const result = store.redeem(bad);
    assert.equal(result.grant, null, JSON.stringify(bad));
    assert.equal(result.record, null, JSON.stringify(bad));
  }
});

test("an evicted tombstone loses the grant with the story, and the replay says unknown", () => {
  // Eviction costs an operational story and never a security property: the code
  // is gone from `pending` and nothing can put it back. What it does cost is the
  // narrow revocation, which is a fidelity loss and not a leak.
  const { store } = storeWith({ maxPending: 8, maxTombstones: 2 });

  const codes = [store.mint(GRANT), store.mint(GRANT), store.mint(GRANT)].map((m) => m.code);
  for (const code of codes) store.redeem(code);

  const evicted = store.redeem(codes[0]);
  assert.equal(evicted.outcome, REDEEM_OUTCOME.UNKNOWN);
  assert.equal(evicted.grant, null);
  assert.equal(evicted.record, null);
  assert.equal(store.redeem(codes[2]).grant.characterId, GRANT.characterId);
});

test("a tombstone remembers the first reference bound to it and refuses to be repointed", () => {
  // A code redeems exactly once and therefore produced exactly one grant.
  // Repointing the tombstone would aim the revocation at something this code
  // never minted, which is the over-revocation the design avoids, arrived at by
  // accident instead of by an attacker.
  const { store } = storeWith();
  const { code } = store.mint(GRANT);
  store.redeem(code);

  assert.equal(store.rememberGrant(code, "family-1"), true);
  assert.equal(store.rememberGrant(code, "family-1"), true, "the same string again is fine");
  assert.equal(store.rememberGrant(code, "family-2"), false, "a different one is refused");

  // What a replay reports is what was actually bound, which is the first.
  assert.equal(store.redeem(code).grant.grantRef, "family-1");
});

// rememberGrant

test("rememberGrant misses quietly rather than throwing, because this is the request path", () => {
  // eve.js treats an unhandled rejection as fatal. The cost of a miss is that one
  // replay cannot name its grant, which the caller sees in the null it gets back,
  // and nothing here is worth a dead universe.
  const { store, time } = storeWith({ ttlMs: 1_000, tombstoneMs: 10_000, maxPending: 4 });

  assert.equal(store.rememberGrant("never-minted", "family-1"), false, "unknown code");

  const expired = store.mint(GRANT).code;
  time.advance(1_000);
  store.redeem(expired);
  assert.equal(store.rememberGrant(expired, "family-1"), false, "an expiry, not a redemption");

  const live = store.mint(GRANT).code;
  assert.equal(store.rememberGrant(live, "family-1"), false, "minted but not yet redeemed");
  store.redeem(live);
  assert.equal(store.rememberGrant(live, "family-1"), true, "and true once there is a tombstone");

  time.advance(10_000);
  // The same string, so that a surviving tombstone would answer true and only the
  // sweep can make this false.
  assert.equal(store.rememberGrant(live, "family-1"), false, "the tombstone was swept");
});

test("rememberGrant refuses arguments that are not usable strings", () => {
  const { store } = storeWith();
  const { code } = store.mint(GRANT);
  store.redeem(code);

  for (const bad of [undefined, null, "", 42, {}, []]) {
    assert.equal(store.rememberGrant(bad, "family-1"), false, `code ${JSON.stringify(bad)}`);
    assert.equal(store.rememberGrant(code, bad), false, `ref ${JSON.stringify(bad)}`);
  }
  assert.equal(store.rememberGrant(), false);

  // None of that wrote anything.
  assert.equal(store.redeem(code).grant.grantRef, null);
});

test("rememberGrant does not extend the tombstone it writes to", () => {
  // A tombstone lives for `tombstoneMs` from when it was created, because the
  // prefix scan in `sweep` depends on insertion order being expiry order, and
  // extending one entry would strand every tombstone behind it.
  const { store, time } = storeWith({ ttlMs: 1_000, tombstoneMs: 10_000 });
  const { code } = store.mint(GRANT);
  store.redeem(code);

  time.advance(9_000);
  assert.equal(store.rememberGrant(code, "family-1"), true);
  assert.equal(store.redeem(code).grant.grantRef, "family-1");

  time.advance(1_000);
  assert.equal(store.redeem(code).outcome, REDEEM_OUTCOME.UNKNOWN, "on the original schedule");
  assert.equal(store.tombstoneCount(), 0);
});

// Expiry

test("a code expires, and the TTL is measured from the injected clock", () => {
  const { store, time } = storeWith({ ttlMs: 60_000 });
  const { code } = store.mint(GRANT);

  time.advance(59_999);
  assert.equal(store.redeem(code).outcome, REDEEM_OUTCOME.OK, "still live one ms before");

  const second = store.mint(GRANT);
  time.advance(60_000);
  const result = store.redeem(second.code);
  assert.equal(result.outcome, REDEEM_OUTCOME.EXPIRED);
  assert.equal(result.record, null);
});

test("expiry is exact at the boundary: the millisecond it expires, it is gone", () => {
  const { store, time } = storeWith({ ttlMs: 1_000 });
  const { code, expiresAt } = store.mint(GRANT);

  time.advance(1_000);
  assert.equal(time.at, expiresAt);
  assert.equal(store.redeem(code).outcome, REDEEM_OUTCOME.EXPIRED);
});

test("expired and never-existed stay distinct for as long as the tombstone lives", () => {
  // Three different operational stories: a client with a bug, a client that is
  // too slow, and somebody probing. The token endpoint answers all of them with
  // `invalid_grant`; the distinction is for the log.
  const { store, time } = storeWith({ ttlMs: 1_000, tombstoneMs: 10_000 });
  const { code } = store.mint(GRANT);

  time.advance(1_000);
  assert.equal(store.redeem(code).outcome, REDEEM_OUTCOME.EXPIRED);

  time.advance(9_999);
  assert.equal(store.redeem(code).outcome, REDEEM_OUTCOME.EXPIRED);

  time.advance(1);
  assert.equal(store.redeem(code).outcome, REDEEM_OUTCOME.UNKNOWN);
});

test("a used code is forgotten on the same schedule, and forgetting is still a refusal", () => {
  const { store, time } = storeWith({ ttlMs: 1_000, tombstoneMs: 10_000 });
  const { code } = store.mint(GRANT);
  store.redeem(code);

  time.advance(9_999);
  assert.equal(store.redeem(code).outcome, REDEEM_OUTCOME.ALREADY_USED);

  time.advance(1);
  const forgotten = store.redeem(code);
  assert.equal(forgotten.outcome, REDEEM_OUTCOME.UNKNOWN);
  // The security property is that nothing comes back, which survives the
  // tombstone going away. Only the story is lost.
  assert.equal(forgotten.record, null);
});

test("nothing sweeps on a timer: expired entries are dropped on the next access", () => {
  const { store, time } = storeWith({ ttlMs: 1_000 });
  store.mint(GRANT);
  assert.equal(store.size(), 1);

  time.advance(60_000);
  // No interval fired, because there is none: this mod shares the game's event
  // loop, and a timer that tidies a map inside a running universe is a cost with
  // no owner.
  assert.equal(store.size(), 1, "held, not swept, while nothing touches the store");

  store.mint(GRANT);
  assert.equal(store.size(), 1, "the next mint drops what aged out");
});

// The cap

test("at the cap, mint refuses rather than evicting a grant somebody is using", () => {
  const { store } = storeWith({ maxPending: 3 });

  const minted = [store.mint(GRANT), store.mint(GRANT), store.mint(GRANT)];
  assert.equal(store.size(), 3);

  const refused = store.mint(GRANT);
  assert.equal(refused.code, null);
  assert.equal(refused.failure, MINT_FAILURE.AT_CAPACITY);

  // Nothing already minted was harmed. Evicting the oldest would cancel an
  // authorization a human is in the middle of completing, and would do it under
  // exactly the conditions an attacker can create on demand, so the eviction
  // policy would be the attack.
  for (const { code } of minted) {
    assert.equal(store.redeem(code).outcome, REDEEM_OUTCOME.OK);
  }
});

test("the cap clears itself: redeeming frees a slot, and so does expiry", () => {
  const { store, time } = storeWith({ maxPending: 2, ttlMs: 1_000 });

  const first = store.mint(GRANT);
  store.mint(GRANT);
  assert.equal(store.mint(GRANT).failure, MINT_FAILURE.AT_CAPACITY);

  store.redeem(first.code);
  assert.equal(store.mint(GRANT).code !== null, true, "a redemption frees a slot");

  assert.equal(store.mint(GRANT).failure, MINT_FAILURE.AT_CAPACITY);
  time.advance(1_000);
  // A flooded store drains within one TTL whether or not anyone is watching,
  // which is what makes refusing bounded and self-healing.
  assert.equal(store.mint(GRANT).code !== null, true, "expiry frees slots");
});

test("tombstones are bounded too, oldest first, and eviction never resurrects a code", () => {
  const { store } = storeWith({ maxPending: 8, maxTombstones: 2 });

  const codes = [store.mint(GRANT), store.mint(GRANT), store.mint(GRANT)].map((m) => m.code);
  for (const code of codes) store.redeem(code);

  assert.equal(store.tombstoneCount(), 2);
  // The oldest tombstone is gone, so its code reads as unknown rather than as
  // used: a downgraded story, and still a refusal.
  assert.equal(store.redeem(codes[0]).outcome, REDEEM_OUTCOME.UNKNOWN);
  assert.equal(store.redeem(codes[0]).record, null);
  assert.equal(store.redeem(codes[2]).outcome, REDEEM_OUTCOME.ALREADY_USED);
});

test("the defaults are the ones the file argues for", () => {
  // Written down here so that changing one is a deliberate edit in two places
  // rather than a number that drifted.
  assert.equal(DEFAULT_TTL_MS, 60_000);
  assert.equal(DEFAULT_TOMBSTONE_MS, 300_000);
  assert.equal(DEFAULT_MAX_PENDING, 256);

  // The TTL is unrelated to the twenty-minute access token: these are
  // sequential lifetimes, not nested ones.
  assert.equal(DEFAULT_TTL_MS < 20 * 60 * 1000, true);
});

// The generator

test("the default code carries 256 bits in 43 url-safe characters", () => {
  const code = defaultGenerateCode();

  // base64url of 32 bytes: 43 characters, and none of `+`, `/` or `=`. The code
  // travels in a query string, and a client that forgets to percent-encode is a
  // bug report about a code that "sometimes" fails.
  assert.equal(code.length, 43);
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);

  // Not an entropy test (that is the platform CSPRNG's job), but it does catch a
  // generator wired to a constant.
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(defaultGenerateCode());
  assert.equal(seen.size, 500);
});

test("a generator that repeats itself fails the mint instead of overwriting a grant", () => {
  // With the default generator this is a 256-bit collision against a few hundred
  // values, i.e. a broken RNG. There is no retry loop, because the only generator
  // that collides is one that would collide again.
  const time = clock();
  const store = createAuthCodeStore({ now: time.now, generateCode: () => "same" });

  const first = store.mint(GRANT);
  assert.equal(first.code, "same");

  const second = store.mint({ ...GRANT, characterId: 90000002 });
  assert.equal(second.code, null);
  assert.equal(second.failure, MINT_FAILURE.COLLISION);

  // The grant that was already there is untouched.
  assert.equal(store.redeem("same").record.characterId, 90000001);
});

test("a tombstoned code cannot be minted again", () => {
  // Overwriting a tombstone would re-open a used code for replay.
  const time = clock();
  const store = createAuthCodeStore({ now: time.now, generateCode: () => "same" });

  store.redeem(store.mint(GRANT).code);
  assert.equal(store.mint(GRANT).failure, MINT_FAILURE.COLLISION);
});

test("a generator that returns junk fails the mint rather than throwing", () => {
  // The request path: eve.js treats an unhandled rejection as fatal, so a
  // programming error here becomes a failed login and not a dead universe.
  for (const bad of [null, undefined, "", 42, {}]) {
    const time = clock();
    const store = createAuthCodeStore({ now: time.now, generateCode: () => bad });
    const result = store.mint(GRANT);

    assert.equal(result.code, null, JSON.stringify(bad));
    assert.equal(result.failure, MINT_FAILURE.GENERATOR, JSON.stringify(bad));
  }
});

// Construction and defence

test("the clock is required, not defaulted", () => {
  // A default would let a test pass without injecting one, and this module is
  // shaped the way it is so that expiry is arithmetic.
  assert.throws(() => createAuthCodeStore(), (err) => err instanceof AuthCodeError);
  assert.throws(
    () => createAuthCodeStore({ now: 12345 }),
    (err) => err instanceof AuthCodeError && /epoch milliseconds/.test(err.message),
  );
});

test("a nonsensical bound throws at construction, where a startup can refuse", () => {
  const time = clock();
  for (const options of [
    { ttlMs: 0 },
    { ttlMs: -1 },
    { ttlMs: 1.5 },
    { ttlMs: "60000" },
    { maxPending: 0 },
    { maxTombstones: 0 },
    { tombstoneMs: 0 },
    { generateCode: "nope" },
  ]) {
    assert.throws(
      () => createAuthCodeStore({ now: time.now, ...options }),
      (err) => err instanceof AuthCodeError,
      JSON.stringify(options),
    );
  }
});

test("a clock that returns nonsense does not poison every expiry with NaN", () => {
  // NaN compares false against everything, so nothing would ever expire and the
  // sweep would stop working silently. This is the failure mode worth defending
  // against rather than trusting.
  const store = createAuthCodeStore({ now: () => "not a time", generateCode: counter() });
  const minted = store.mint(GRANT);

  assert.equal(Number.isFinite(minted.expiresAt), true);
  assert.equal(store.redeem(minted.code).outcome, REDEEM_OUTCOME.OK);
});

test("redeeming something that is not a code is unknown, not an error", () => {
  const { store } = storeWith();
  for (const code of [undefined, null, "", 42, {}, []]) {
    const result = store.redeem(code);
    assert.equal(result.outcome, REDEEM_OUTCOME.UNKNOWN, JSON.stringify(code));
    assert.equal(result.record, null);
  }
});

test("minting nothing at all is still a code, because the store is not the policy", () => {
  const { store } = storeWith();
  assert.doesNotThrow(() => store.mint());
  assert.doesNotThrow(() => store.mint(null));
  assert.equal(store.size(), 2);
});

test("the store and everything it returns are frozen", () => {
  const { store } = storeWith();
  assert.equal(Object.isFrozen(store), true);

  const minted = store.mint(GRANT);
  assert.equal(Object.isFrozen(minted), true);
  assert.equal(Object.isFrozen(store.redeem(minted.code)), true);
  assert.equal(Object.isFrozen(store.redeem("nope")), true);
});
