/**
 * eve.js-mod-esi: the bind flow adapter.
 *
 * The seam between `routes/oauthAuthorize.js` and `lib/pendingBinds.js`, which
 * are keyed on different things. The route knows a request id: 256 bits of
 * `crypto.randomBytes`, minted when the authorize page is rendered and handed
 * to exactly one browser. It never sees the bind code the player will type,
 * because the poll endpoint answers an unauthenticated caller and a route that
 * held the code could leak it. The store is keyed on the code, and its
 * `inspect` requires the session id and the code together, so a guessed code is
 * useless to a browser it was not minted for. This module holds the map
 * `requestId -> code`.
 *
 * `lib/pendingBinds.js` treats a session id as opaque (only its length matters),
 * so the route's request id is passed through as-is with no id mapping.
 *
 * What the route may see: `peek` answers `{ state, characterId? }` and nothing
 * else. `inspect` returns more: a spent entry carries `characterID`,
 * `accountID`, `role`, `isGM` and `claimedAt`, and the poll response is served
 * to an unauthenticated browser. So every field is written out by name and no
 * answer is built by spreading what the store returned.
 * `routes/oauthAuthorize.js` also reads named fields, as defence in depth; that
 * does not make this layer free to forget. `test/bindFlow.test.js` drives this
 * with a deliberately leaky store double.
 *
 * `characterID` becomes `characterId`. The store follows the game's tables
 * (capital `ID`); the route reads `seen.characterId` and refuses the sign-in
 * when it is not a positive integer. Nothing else catches a mismatch, and the
 * failure would be quiet: every successful in-game bind would end in a
 * `server_error`. The translation is explicit and asserted directly.
 *
 * A spent entry whose character id is unusable is still reported as `approved`
 * with `characterId: null`. Reporting it as `expired` would tell the player to
 * generate a new code for a bug that will recur; `null` reaches the route's
 * check, which logs it and answers `server_error`.
 *
 * No oracle: every path where this module knows nothing returns the same frozen
 * object from the same expression. Those paths are an absent request id, a
 * misshapen one, one this map never held, one whose store entry was swept, and
 * both ways the store can fail to answer. `lib/pendingBinds.js` holds the same
 * line across six no-information paths and asserts `JSON.stringify` identity;
 * the route holds it across its own; `test/bindFlow.test.js` holds it here.
 * Do not refactor into a branch per case with a distinct answer each.
 *
 * `expired` is not in that set and is not an oracle: reaching it requires
 * naming an entry this map holds, which requires the 256-bit request id. The
 * route collapses `expired` and `unknown` into identical bytes, so the
 * distinction exists for wiring and logs and does not reach the wire.
 *
 * Bounding: nothing guarantees anyone polls (a browser that renders the page
 * and closes leaves a mapping, and `routes/oauthAuthorize.js` requires only
 * `mint` and `peek`, never `forget`). So the map is capped and swept lazily on
 * the mint that would grow it. There is no `setInterval`: this listener shares
 * the game's event loop (design constraint 2).
 *
 * An entry whose store state is `unknown` or `expired` is dead and goes. At the
 * cap, `mint` refuses with `MINT_FAILURE.FULL` rather than evicting, the
 * opposite of `lib/bindRateLimiter.js`, following `lib/authCodes.js`: a limiter
 * holds counters, and dropping one loses an accounting detail. This map holds
 * the only link between a live authorization and the code that completes it,
 * so evicting silently kills a sign-in in progress, under conditions an
 * attacker can create on demand. A refusal is bounded and self-healing: every
 * entry expires, so a flooded map drains within one TTL, and the route turns
 * the refusal into `temporarily_unavailable`.
 *
 * Three caps back each other up: `routes/oauthAuthorize.js` refuses at 256
 * in-flight authorizations, this map at 1024, `lib/pendingBinds.js` at 2048
 * codes. The outermost fires first, with the best error message.
 *
 * `MINT_FAILURE.UNAVAILABLE` belongs to this file. `lib/pendingBinds.js` names
 * it and never returns it, leaving it to the layer that knows whether the mod
 * is configured to complete a bind at all. It is imported rather than
 * respelled so there is one string for it.
 *
 * Nothing here throws at request time: a store that throws becomes
 * `UNAVAILABLE`. eve.js's ProcessLifecycle treats an unhandled rejection as
 * fatal.
 */

"use strict";

const { ENTRY_STATE, MINT_FAILURE } = require("./pendingBinds");

// The four answers `peek` gives

const BIND_STATE = Object.freeze({
  PENDING: "pending",
  APPROVED: "approved",
  EXPIRED: "expired",
  UNKNOWN: "unknown",
});

/**
 * The answer to a caller this module will tell nothing. One frozen object,
 * returned from every such path, so "never minted", "swept" and "the store is
 * not there" cannot drift into different shapes. See "No oracle" above.
 */
const UNKNOWN_ANSWER = Object.freeze({ state: BIND_STATE.UNKNOWN });

/** Likewise, so a `pending` answer is one object rather than one per poll. */
const PENDING_ANSWER = Object.freeze({ state: BIND_STATE.PENDING });

/** And `expired`, which the route treats identically to `unknown`. */
const EXPIRED_ANSWER = Object.freeze({ state: BIND_STATE.EXPIRED });

// Bounds

/** See "Bounding" above: the middle of three caps, never the first to fire. */
const DEFAULT_MAX_PENDING = 1024;

/**
 * A mapping's absolute lifetime, regardless of what the store says about it.
 *
 * Without this, the bound on the map is borrowed from `inspect` eventually
 * answering `unknown`, which depends on the store's sweep and grace period. A
 * ceiling makes the bound local. Thirty minutes is four times the store's TTL
 * plus grace (two minutes, then five), and twice `routes/oauthAuthorize.js`'s
 * fifteen-minute ceiling, by which point the route has forgotten the
 * authorization and no bind can complete.
 */
const MAX_MAPPING_AGE_MS = 30 * 60 * 1000;

/**
 * The request id is a key in a map in the game's heap and arrives from a query
 * string. Only its size matters here, as in `lib/pendingBinds.js` and with the
 * same limit, because the value is passed to it as a session id and a longer
 * one would be refused there anyway.
 */
const MAX_REQUEST_ID_LENGTH = 256;

function readRequestId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_REQUEST_ID_LENGTH) return "";
  return trimmed;
}

function toPositiveInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const truncated = Math.trunc(number);
  return truncated > 0 ? truncated : null;
}

/** The one shape of refusal `routes/oauthAuthorize.js` knows how to read. */
function refusal(reason) {
  return { code: null, failure: reason };
}

/**
 * @param store       a `lib/pendingBinds.js` store, or null when the mod is
 *                    not configured to complete a bind at all
 * @param now         () => epoch ms
 * @param maxPending  hard cap on tracked request ids
 *
 * `store` may be absent on purpose: `loader.js` builds this before it knows
 * whether every part of SSO came up, and the useful behaviour then is a `mint`
 * that refuses with `UNAVAILABLE` and a `peek` that says `unknown`, not a
 * constructor that throws inside the game's boot.
 */
function createBindFlow({ store = null, now, maxPending = DEFAULT_MAX_PENDING } = {}) {
  const clock = typeof now === "function" ? now : () => Date.now();
  const cap =
    Number.isFinite(maxPending) && maxPending > 0
      ? Math.trunc(maxPending)
      : DEFAULT_MAX_PENDING;

  // Resolved once at construction. A store missing either half is no store: a
  // `mint` with no `inspect` behind it would hand out codes nothing could ever
  // complete.
  const usable =
    store !== null
    && typeof store === "object"
    && typeof store.mint === "function"
    && typeof store.inspect === "function"
      ? store
      : null;

  // requestId -> { code, mintedAt }
  const mappings = new Map();

  /** The clock, defended: `lib/errorLimiter.js`'s pattern, for its reasons. */
  function reading() {
    const at = Number(clock());
    return Number.isFinite(at) ? at : Date.now();
  }

  /**
   * Ask the store about one mapping, once.
   *
   * Deriving the state from one call and re-reading the character id from a
   * second would let a claim landing between the two produce an `approved`
   * answer carrying the first call's data. One reading decides both, as in
   * `lib/pendingBinds.js`'s synchronous claim.
   *
   * A store that throws is indistinguishable from one that knows nothing, which
   * is the safe answer and deliberately the same answer.
   */
  function inspectOf(requestId, mapping) {
    if (usable === null) return null;
    try {
      const seen = usable.inspect({ sessionId: requestId, code: mapping.code });
      return seen && typeof seen === "object" ? seen : null;
    } catch {
      return null;
    }
  }

  /** One inspection, reduced to this module's four states. */
  function stateOf(seen) {
    const state = seen && typeof seen.state === "string" ? seen.state : "";
    if (state === ENTRY_STATE.PENDING) return BIND_STATE.PENDING;
    if (state === ENTRY_STATE.USED) return BIND_STATE.APPROVED;
    if (state === ENTRY_STATE.EXPIRED) return BIND_STATE.EXPIRED;
    return BIND_STATE.UNKNOWN;
  }

  /**
   * Drop every mapping that can no longer complete a sign-in.
   *
   * Driven by `mint`, the call that would grow the map, so growth is bounded by
   * the activity that causes it and no timer is needed. The pass is O(n) in map
   * lookups with n bounded by the cap, the same shape as the sweep
   * `lib/pendingBinds.js` runs on every mint.
   *
   * `peek` also drops an entry it finds dead, so where people are polling this
   * rarely has much to do.
   */
  function sweep(at) {
    let removed = 0;
    for (const [requestId, mapping] of mappings) {
      let dead = at - mapping.mintedAt >= MAX_MAPPING_AGE_MS;
      if (!dead) {
        const state = stateOf(inspectOf(requestId, mapping));
        dead = state === BIND_STATE.UNKNOWN || state === BIND_STATE.EXPIRED;
      }
      if (dead) {
        mappings.delete(requestId);
        removed += 1;
      }
    }
    return removed;
  }

  // Mint
  /**
   * Start a bind for one authorization request.
   *
   *   { code, expiresAt }
   *   { code: null, failure: <string> }     nothing was minted
   *
   * `expiresAt` is passed through unchanged, in epoch milliseconds, as the store
   * returns it and the route reads it. The route clamps it against its own
   * ceiling and falls back when it is unusable.
   *
   * Minting twice for the same request id replaces the mapping rather than
   * refusing. The route generates a fresh id per authorization, so this should
   * not happen; replacing keeps the map's size honest, the orphaned store entry
   * expires on its own, and refusing would leave the caller unable to recover
   * from its own retry.
   */
  function mint(request = {}) {
    const requestId = readRequestId(request && request.requestId);
    if (requestId === "") return refusal(MINT_FAILURE.INVALID_SESSION);
    if (usable === null) return refusal(MINT_FAILURE.UNAVAILABLE);

    sweep(reading());
    if (!mappings.has(requestId) && mappings.size >= cap) {
      return refusal(MINT_FAILURE.FULL);
    }

    let minted;
    try {
      minted = usable.mint({ sessionId: requestId });
    } catch {
      // A store that throws is a store that is not there. Nothing on this path may
      // reach eve.js's ProcessLifecycle.
      return refusal(MINT_FAILURE.UNAVAILABLE);
    }

    if (!minted || minted.ok !== true || typeof minted.code !== "string" || minted.code === "") {
      // The store's own vocabulary where it gave one (`invalid-session`,
      // `rate-limited`, `full`, `generator`), and `unavailable` for a store that
      // answered with something nobody wrote down.
      const reason =
        minted && typeof minted.reason === "string" && minted.reason !== ""
          ? minted.reason
          : MINT_FAILURE.UNAVAILABLE;
      return refusal(reason);
    }

    mappings.set(requestId, { code: minted.code, mintedAt: reading() });
    return { code: minted.code, expiresAt: minted.expiresAt };
  }

  // Peek
  /**
   * What one browser may learn about its own sign-in.
   *
   *   { state: "pending" }
   *   { state: "approved", characterId }
   *   { state: "expired" }
   *   { state: "unknown" }
   *
   * Named fields only; the `approved` object is built here, not derived from the
   * store's (see the header).
   *
   * A dead mapping is dropped on the way past. The poll is the one call that
   * repeats, so this keeps the map small between mints.
   */
  function peek(requestId) {
    const id = readRequestId(requestId);
    if (id === "" || usable === null) return UNKNOWN_ANSWER;

    const mapping = mappings.get(id);
    if (mapping === undefined) return UNKNOWN_ANSWER;

    if (reading() - mapping.mintedAt >= MAX_MAPPING_AGE_MS) {
      mappings.delete(id);
      return UNKNOWN_ANSWER;
    }

    const seen = inspectOf(id, mapping);
    const state = stateOf(seen);
    if (state === BIND_STATE.PENDING) return PENDING_ANSWER;
    if (state === BIND_STATE.APPROVED) {
      // The translation this module exists to get right, and the one that fails
      // silently if missed: `characterID` there, `characterId` here. One named read,
      // no spread: every other field on a spent entry (`accountID`, `role`, `isGM`,
      // `claimedAt`) stops at this line.
      return { state: BIND_STATE.APPROVED, characterId: toPositiveInteger(seen.characterID) };
    }

    mappings.delete(id);
    if (state === BIND_STATE.EXPIRED) return EXPIRED_ANSWER;
    return UNKNOWN_ANSWER;
  }

  // Forget
  /**
   * Drop one mapping on demand.
   *
   * It undoes nothing in the store: a code cannot be un-minted, and a spent one
   * stays spent so the player is still told `used` rather than `unknown`. This
   * only stops this module answering for a request id the caller has finished
   * with.
   *
   * `routes/oauthAuthorize.js` does not call it (it deletes its own pending entry
   * and leaves this one to the sweep), so it exists for the wiring and future
   * callers, and the map's bound does not depend on it.
   */
  function forget(requestId) {
    const id = readRequestId(requestId);
    if (id === "") return;
    mappings.delete(id);
  }

  function stats() {
    return { tracked: mappings.size, maxPending: cap, available: usable !== null };
  }

  return Object.freeze({
    maxPending: cap,
    forget,
    mint,
    peek,
    stats,
    sweep: (at) => sweep(Number.isFinite(at) ? at : reading()),
    size: () => mappings.size,
  });
}

module.exports = Object.freeze({
  BIND_STATE,
  DEFAULT_MAX_PENDING,
  EXPIRED_ANSWER,
  MAX_MAPPING_AGE_MS,
  MAX_REQUEST_ID_LENGTH,
  PENDING_ANSWER,
  UNKNOWN_ANSWER,

  createBindFlow,
});
