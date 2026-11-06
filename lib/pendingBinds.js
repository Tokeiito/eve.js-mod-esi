/**
 * eve.js-mod-esi: pending bind store (D3).
 *
 * The table of live bind codes, in memory on purpose. It keeps the mint/claim/release/inspect
 * shape, the tombstones and the atomic claim of the store it was ported from; a spent entry now
 * remembers the whole identity rather than only the character ID (see `inspect`).
 *
 * One store per process. A code minted by an HTTP request on the SSO listener must be
 * redeemable by a slash command arriving on an unrelated code path minutes later, and the two
 * share nothing except the process. So the caller builds one store and keeps it, and the
 * mechanism rests on "the process that binds the listener ports is the process the slash command
 * runs in". `loader.js` establishes that (see its header, "Two guards, because `NODE_OPTIONS` is
 * process-wide"): the readiness hook keys off `wormholeRuntimeState`, which the process owning
 * game state loads and the ~5 edge processes and the healthcheck do not. If that guard is
 * weakened, the store silently splits: the browser polls a table in one process, the player types
 * into a table in another, and every bind hangs. The singleton depends on loader.js's guard 2.
 *
 * Nothing is persisted. A pending bind is worth about ninety seconds. Persisting it would need
 * either a schema in the game's database (forbidden by D5) or a file of live bearer credentials
 * on disk. A restart costs the player one click on "generate a new code".
 *
 * Three-way distinction. `unknown`, `expired` and `used` are three different sentences to the
 * player (check the typo; generate a new code; generate a new code because someone used that
 * one). A store that deleted entries would collapse all three into `unknown`, so entries that
 * stop being redeemable become tombstones and only the sweep removes them, one grace period
 * later. Memory stays bounded.
 *
 * No confirmation oracle. The distinction is for the player holding a code the server minted
 * for them, not for a browser probing `inspect`. A code belonging to a different session and a
 * code never minted both answer `{ state: "unknown" }` from the same `return`, so there is no
 * response shape for the two to differ in. `inspect` therefore has no switch per case: one branch
 * and one message per state would hand an attacker holding a guessed code confirmation that the
 * guess was real. `test/pendingBinds.test.js` asserts byte-identity of the two answers.
 *
 * Atomic claim. `claim` is synchronous from lookup to state change, with no `await` between.
 * That is the whole single-use guarantee: on one event loop turn nothing interleaves, so two
 * redemptions arriving together are ordered, and the second finds the tombstone. If `claim`
 * awaited a callback before the write, both would see the entry and both would succeed. Anything
 * done with a claim happens after it, and `release` undoes a claim whose follow-up failed.
 *
 * Pure core: the clock, the code generator and both rate limiters are arguments. No timer lives
 * here; sweeping is driven by the caller.
 */

"use strict";

const { isBindCodeShape, normalizeBindCode } = require("./bindCodes");

// Defaults
// Two minutes is the window between "the authorize page shows me a code" and
// "I have alt-tabbed and typed it". Long enough to find the chat window,
// short enough that a code read over someone's shoulder is worthless by the
// time they act on it.
const DEFAULT_TTL_MS = 120000;

// How long an expired or used code keeps answering with the specific reason
// before it degrades to `unknown`. Five minutes covers the realistic "I
// waited too long, let me try it anyway" case.
const DEFAULT_GRACE_MS = 300000;

// A ceiling a legitimate deployment will never reach. With minting
// rate-limited per session this is the second line of defence, and it fails
// in the safe direction: minting refuses, redemption of existing codes keeps
// working. It is a heap bound on a table living inside the game server's
// process (design constraint 2).
const DEFAULT_MAX_PENDING = 2048;

// Collisions are astronomically unlikely; a generator that has broken and is
// emitting a constant is not.  Three attempts distinguishes the two.
const MINT_CODE_ATTEMPTS = 3;

const MINT_FAILURE = Object.freeze({
  INVALID_SESSION: "invalid-session",
  // Never returned by this file. It belongs to the layer that composes this
  // store with the rest of SSO and knows whether the mod is configured to
  // complete a bind at all; it is named here so both halves spell it the same
  // way.
  UNAVAILABLE: "unavailable",
  RATE_LIMITED: "rate-limited",
  FULL: "full",
  GENERATOR: "generator",
});

const CLAIM_OUTCOME = Object.freeze({
  CLAIMED: "claimed",
  UNKNOWN: "unknown",
  EXPIRED: "expired",
  USED: "used",
  MALFORMED: "malformed",
  RATE_LIMITED: "rate-limited",
});

const ENTRY_STATE = Object.freeze({
  PENDING: "pending",
  EXPIRED: "expired",
  USED: "used",
});

// What `inspect` answers a caller it will tell nothing. One frozen object,
// returned from every such path, so "wrong session" and "never existed"
// cannot drift into two subtly different shapes (see the file header, "No
// confirmation oracle").
const UNKNOWN_INSPECTION = Object.freeze({ state: "unknown" });

// A session identifier is opaque to this mod: it is whatever the SSO side
// uses to name the browser it is serving (an authorization request id does
// fine). Only its size is this module's business, because the key space is
// attacker-influenced and this map lives in the game's heap.
const MAX_SESSION_ID_LENGTH = 256;

function readSessionId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_SESSION_ID_LENGTH) return "";
  return trimmed;
}

function toPositiveInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const truncated = Math.trunc(number);
  return truncated > 0 ? truncated : null;
}

/**
 * The identity fields a spent entry remembers, in the shape a caller reads them back in. One
 * function, used by `claim` when it writes them and by `inspect` when it reads them, so the two
 * cannot disagree about the names.
 *
 * `role` defaults to `"0"` rather than null on a claim (a mask of no roles is a real answer),
 * while an entry that was never claimed carries nulls throughout, so "nobody claimed this" is
 * legible without a second field.
 */
function identityFromRequest(request) {
  const source = request === null || typeof request !== "object" ? {} : request;
  return {
    characterID: toPositiveInteger(source.characterID),
    accountID: toPositiveInteger(source.accountID),
    role: typeof source.role === "string" ? source.role : "0",
    isGM: source.isGM === true,
  };
}

const UNCLAIMED_IDENTITY = Object.freeze({
  characterID: null,
  accountID: null,
  role: null,
  isGM: false,
});

/**
 * @param now            () => epoch ms
 * @param generateCode   () => string
 * @param mintLimiter    { check(key, now) -> { allowed, retryAfterMs } } or null
 * @param redeemLimiter  { check(key, now) -> { allowed, retryAfterMs } } or null
 *
 * Both limiters are injected, and the interface is two lines wide. This repository's
 * `lib/rateLimiter.js` is an HTTP dispatch bound to CCP's rate-limit groups and `X-Ratelimit-*`
 * headers, a different question that cannot be reused here, so the wiring supplies a per-key
 * bucket and this file states what it needs of it.
 */
function createPendingBindStore({
  now,
  generateCode,
  mintLimiter = null,
  redeemLimiter = null,
  ttlMs = DEFAULT_TTL_MS,
  graceMs = DEFAULT_GRACE_MS,
  maxPending = DEFAULT_MAX_PENDING,
} = {}) {
  if (typeof now !== "function") {
    throw new Error("ESI mod: the bind store needs a clock.");
  }
  if (typeof generateCode !== "function") {
    throw new Error("ESI mod: the bind store needs a code generator.");
  }

  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
  const grace = Number.isFinite(graceMs) && graceMs > 0 ? graceMs : DEFAULT_GRACE_MS;
  const cap =
    Number.isFinite(maxPending) && maxPending > 0
      ? Math.trunc(maxPending)
      : DEFAULT_MAX_PENDING;

  // code -> { state, sessionId, createdAt, expiresAt, forgetAt, claimedAt,
  //           characterID, accountID, role, isGM }
  const entries = new Map();

  // Sweep
  // Removes anything past its `forgetAt`, which is the expiry plus grace for
  // a pending entry and the tombstone deadline for a spent one. Called on
  // every mint and every claim, so growth is bounded by activity even with no
  // timer; an idle-server timer, if the wiring wants one, exists only so the
  // last few entries do not sit in the heap forever.
  function sweep(at) {
    const stamp = Number.isFinite(at) ? at : now();
    let removed = 0;
    for (const [code, entry] of entries) {
      if (entry.forgetAt <= stamp) {
        entries.delete(code);
        removed += 1;
      }
    }
    return removed;
  }

  /** The state of an entry as of `stamp`, without mutating it. */
  function stateOf(entry, stamp) {
    if (entry.state !== ENTRY_STATE.PENDING) return entry.state;
    return entry.expiresAt <= stamp ? ENTRY_STATE.EXPIRED : ENTRY_STATE.PENDING;
  }

  // Mint
  /**
   * Create a code for one browser session.
   *
   *   { ok: true,  code, expiresAt, ttlMs }
   *   { ok: false, reason: MINT_FAILURE, retryAfterMs? }
   *
   * The session ID is mandatory. A code with no session behind it could be completed into
   * whatever browser asked for the result, the property this mechanism exists to deny (see
   * `inspect`).
   */
  function mint(request = {}) {
    const stamp = now();
    const sessionId = readSessionId(request && request.sessionId);
    if (sessionId === "") {
      return { ok: false, reason: MINT_FAILURE.INVALID_SESSION };
    }

    // Minting is rate-limited per session.
    // The heap-exhaustion defence, checked first, before the sweep and before
    // the cap: every mint is an entry in a table living in the game server's
    // process, so an unlimited minter is a memory-pressure attack on the
    // universe rather than on this mod. `maxPending` below is the backstop, not
    // the defence.
    if (mintLimiter) {
      const verdict = mintLimiter.check(sessionId, stamp);
      if (!verdict.allowed) {
        return {
          ok: false,
          reason: MINT_FAILURE.RATE_LIMITED,
          retryAfterMs: verdict.retryAfterMs,
        };
      }
    }

    sweep(stamp);
    if (entries.size >= cap) {
      return { ok: false, reason: MINT_FAILURE.FULL };
    }

    let code = "";
    for (let attempt = 0; attempt < MINT_CODE_ATTEMPTS; attempt += 1) {
      const candidate = normalizeBindCode(generateCode());
      if (isBindCodeShape(candidate) && !entries.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (code === "") {
      return { ok: false, reason: MINT_FAILURE.GENERATOR };
    }

    const expiresAt = stamp + ttl;
    entries.set(code, {
      state: ENTRY_STATE.PENDING,
      sessionId,
      createdAt: stamp,
      expiresAt,
      forgetAt: expiresAt + grace,
      claimedAt: null,
      ...UNCLAIMED_IDENTITY,
    });

    return { ok: true, code, expiresAt, ttlMs: ttl };
  }

  // Claim
  /**
   * Take a code out of circulation on behalf of a character.
   *
   * Synchronous end to end. Returns
   *
   *   { outcome: CLAIM_OUTCOME.CLAIMED, claim: {...} }
   *   { outcome: CLAIM_OUTCOME.<other> }        nothing was consumed
   *
   * The returned `claim` carries the session the code was minted for, so the caller can match it
   * against the browser it is serving. This module has never seen the browser and cannot.
   */
  function claim(request = {}) {
    const stamp = now();
    const characterID = toPositiveInteger(request && request.characterID);

    // Redemption is rate-limited per character.
    // The guessing defence, and the half that makes a 39-bit code adequate.
    // Keyed by character because the game session is the thing an attacker
    // would have to multiply, and multiplying characters is expensive.
    //
    // Checked before the code is even shape-tested, so a throttled caller
    // learns nothing about the string they sent, including whether it was
    // well formed.
    if (redeemLimiter) {
      // A request with no usable character falls back to one shared bucket.
      // Sharing is deliberately harsh: there is no legitimate traffic on that
      // path, so the only cost of collapsing it is borne by an attacker.
      const verdict = redeemLimiter.check(
        characterID === null ? "anonymous" : `char:${characterID}`,
        stamp,
      );
      if (!verdict.allowed) {
        return { outcome: CLAIM_OUTCOME.RATE_LIMITED, retryAfterMs: verdict.retryAfterMs };
      }
    }

    const code = normalizeBindCode(request && request.code);
    if (!isBindCodeShape(code)) {
      // Answered without touching the table at all.
      return { outcome: CLAIM_OUTCOME.MALFORMED };
    }

    sweep(stamp);

    const entry = entries.get(code);
    if (!entry) return { outcome: CLAIM_OUTCOME.UNKNOWN };

    const state = stateOf(entry, stamp);
    if (state === ENTRY_STATE.USED) return { outcome: CLAIM_OUTCOME.USED };
    if (state === ENTRY_STATE.EXPIRED) {
      // Settle the state so every later caller sees the same answer and the
      // sweep does not have to re-derive it.
      entry.state = ENTRY_STATE.EXPIRED;
      return { outcome: CLAIM_OUTCOME.EXPIRED };
    }

    // The atomic bit
    // From here to the return there is no await and no call that could
    // yield. The entry is spent before this function gives up control.
    const identity = identityFromRequest(request);
    entry.state = ENTRY_STATE.USED;
    entry.claimedAt = stamp;
    entry.characterID = identity.characterID;
    entry.accountID = identity.accountID;
    entry.role = identity.role;
    entry.isGM = identity.isGM;
    entry.forgetAt = stamp + grace;

    return {
      outcome: CLAIM_OUTCOME.CLAIMED,
      claim: Object.freeze({
        code,
        sessionId: entry.sessionId,
        ...identity,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        claimedAt: stamp,
      }),
    };
  }

  // Release
  /**
   * Undo a claim whose follow-up never landed.
   *
   * Without this a failure downstream would burn the code: the player would be told to try again
   * and the retry would answer `used`, which is wrong and unactionable. The claim is restored only
   * while the original TTL still has time on it; past that the honest answer is `expired`, and a
   * code that failing retries could resurrect indefinitely would defeat the TTL.
   *
   * Returns true if the code is redeemable again.
   */
  function release(claimToken) {
    if (!claimToken || typeof claimToken !== "object") return false;
    const code = normalizeBindCode(claimToken.code);
    const entry = entries.get(code);
    if (!entry || entry.state !== ENTRY_STATE.USED) return false;

    const stamp = now();
    if (entry.expiresAt <= stamp) {
      entry.state = ENTRY_STATE.EXPIRED;
      return false;
    }

    entry.state = ENTRY_STATE.PENDING;
    entry.claimedAt = null;
    // Every identity field, not just the character. A released entry that
    // kept an accountID would let a later `inspect` report a bind that was
    // rolled back.
    Object.assign(entry, UNCLAIMED_IDENTITY);
    entry.forgetAt = entry.expiresAt + grace;
    return true;
  }

  // Inspect
  /**
   * What a browser session may learn about its own code.
   *
   * A session mismatch answers `unknown`, identically to a code that was never minted: same frozen
   * object, from the same return. Anything else would confirm to a caller holding a guessed code
   * that the guess was real, the oracle the redemption rate limit exists to deny.
   *
   * Spent entries report the whole identity. The store this was ported from answered
   * `{ state, characterID }` for a spent entry and pushed the rest of the identity to a separate
   * server over HTTP. Here the party that needs it is the SSO listener in this same process,
   * waiting on a browser poll to mint a token, so a spent entry reports the whole tuple
   * (`characterID`, `accountID`, `role`, `isGM`, `claimedAt`) and the authorize route can answer
   * "has this been claimed, and by whom?" from this one call. The fields are on every spent state,
   * nulls included, so an expired-and-never-claimed entry and a used one have the same shape and a
   * caller reads `state` rather than probing for a key.
   */
  function inspect(request = {}) {
    const stamp = now();
    const sessionId = readSessionId(request && request.sessionId);
    const code = normalizeBindCode(request && request.code);
    if (sessionId === "" || !isBindCodeShape(code)) return UNKNOWN_INSPECTION;

    const entry = entries.get(code);
    if (!entry || entry.sessionId !== sessionId) return UNKNOWN_INSPECTION;

    const state = stateOf(entry, stamp);
    if (state === ENTRY_STATE.PENDING) return { state, expiresAt: entry.expiresAt };

    return {
      state,
      characterID: entry.characterID,
      accountID: entry.accountID,
      role: entry.role,
      isGM: entry.isGM,
      claimedAt: entry.claimedAt,
    };
  }

  function stats() {
    const stamp = now();
    let pending = 0;
    let spent = 0;
    for (const entry of entries.values()) {
      if (stateOf(entry, stamp) === ENTRY_STATE.PENDING) pending += 1;
      else spent += 1;
    }
    return { pending, spent, total: entries.size, maxPending: cap };
  }

  return Object.freeze({
    ttlMs: ttl,
    graceMs: grace,
    maxPending: cap,
    claim,
    inspect,
    mint,
    release,
    stats,
    sweep,
    size: () => entries.size,
  });
}

module.exports = Object.freeze({
  CLAIM_OUTCOME,
  DEFAULT_GRACE_MS,
  DEFAULT_MAX_PENDING,
  DEFAULT_TTL_MS,
  ENTRY_STATE,
  MAX_SESSION_ID_LENGTH,
  MINT_CODE_ATTEMPTS,
  MINT_FAILURE,
  UNKNOWN_INSPECTION,

  createPendingBindStore,
});
