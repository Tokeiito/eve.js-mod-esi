/**
 * eve.js-mod-esi: one-time authorization codes.
 *
 * The short-lived string `GET /v2/oauth/authorize` puts in the query of its redirect, and
 * `POST /v2/oauth/token` trades for a token. A bearer credential with a very short life can go
 * wrong three ways: it is replayed, it is guessed, or the map holding it exhausts the game
 * server's heap.
 *
 * The store is not the policy. `mint` records what it is given verbatim and validates none of
 * it: the authorize route decides what a valid request is (it alone can answer a bad one in the
 * shape OAuth requires). Verbatim is also required: the token route verifies PKCE by hashing the
 * presented `code_verifier` and comparing it to the `code_challenge` recorded here, and compares
 * `redirect_uri` byte for byte, so a store that trimmed or re-encoded either would silently
 * break legal values ("the tool cannot log in and nothing is wrong with it"). Same for `scope`.
 *
 * Single use. A code redeems exactly once. A second attempt gets `REDEEM_OUTCOME.ALREADY_USED`
 * and no record, so nothing can be issued from it. RFC 6749 section 4.1.2 says a server SHOULD
 * also revoke tokens already issued from a replayed code. That revocation belongs to the token
 * route (this store never sees a token), but the bare signal is not enough: on the replay branch
 * the route has authenticated the client but has not run `mayRedeem` or verified PKCE, and for a
 * public client the `client_id` is public. Anyone holding a sniffed spent code reaches that
 * branch, so a replay must not revoke everything a (character, client) pair owns, which would be
 * an amplified logout oracle. The narrowest setting is the one grant this code minted.
 *
 * So a spent code's tombstone carries a link to it, one this module remembers rather than
 * invents: the route issues whatever it issues, takes the identifier the issuing store already
 * minted, and hands it back through `rememberGrant`. A later replay gets
 * `grant = { characterId, clientId, grantRef }` and the route revokes exactly that. `grantRef`
 * is an opaque non-empty string, compared against nothing and parsed by nobody, which is why this
 * file's tests never mention a token store. It is `null` when nobody came back to record one
 * (after a process restart, or when a redemption issued nothing worth revoking), which is
 * deliberately distinguishable from a `grant` of `null`: "whose grant, but not which" leaves the
 * route something to log, "I know nothing" leaves it nothing.
 *
 * `grant` is non-null on a replay and only on a replay. The `ok` path returns the whole `record`,
 * which already carries `characterId` and `clientId`, so a non-null `grant` means exactly one
 * thing: this is a replay. `ALREADY_USED` stays a distinct outcome; flattened into a generic
 * failure here, the revocation could not be written.
 *
 * Tombstones. "Used", "expired" and "never existed" are three operational stories (a client with
 * a bug, a slow client, a client pointed at the wrong server or someone probing), so they stay
 * distinct here. What the token endpoint's caller is told differs: RFC 6749 section 5.2 makes
 * all three `invalid_grant`, since telling them apart would make the endpoint an oracle for
 * which codes existed. The route owns that flattening.
 *
 * A tombstone holds an outcome, an expiry and, for a spent code only, `characterId`, `clientId`
 * and `grantRef`. It holds no `scope`, no `redirectUri` and no PKCE challenge, on purpose: the
 * replay branch gives the first two fields a reader, but `codeChallenge` has no reader once the
 * redemption that verified it is over, and outliving its last reader is how a store of
 * short-lived credentials becomes a store of long-lived ones worth stealing. Widening it has to
 * argue for each field.
 *
 * Bounded, because `mint` is reachable before anyone authenticates. The authorize endpoint runs
 * in front of every identity check, so an unbounded map is a heap-exhaustion path in the game
 * server's own process (design constraint 2). At the cap `mint` refuses rather than
 * evicting, unlike every other bounded map here. `lib/errorLimiter.js` and `lib/rateLimiter.js`
 * hold counters, where dropping one loses an accounting detail. This holds grants: evicting the
 * oldest pending code cancels an authorization a human is completing, under conditions an
 * attacker can create on demand, so the eviction policy would itself be the attack. A refusal is
 * bounded and self-healing (every entry expires, so a flooded store drains within one TTL) and
 * is visible to the route. Tombstones are capped separately and do evict, oldest first: an
 * evicted tombstone makes a replayed code read as `UNKNOWN` instead of `ALREADY_USED`, which is
 * still `invalid_grant`, and the code is gone from `pending` regardless.
 *
 * TTL is sixty seconds. RFC 6749 section 4.1.2 recommends a maximum of ten minutes. The real path
 * is far shorter: the client's loopback listener receives the redirect and posts the code back
 * in the same second, after the human has already clicked. A minute is two orders of magnitude of
 * slack and short enough that a code seen in a browser history or proxy log is almost certainly
 * dead. It is unrelated to the twenty-minute access token: the code's life ends when it is
 * redeemed, which is when the token's begins.
 *
 * `now` is a required argument, so tests drive expiry by arithmetic rather than sleeping. There
 * is no `setInterval`: this mod shares the game's event loop, and a timer is a cost with no
 * owner. The sweep is lazy: every `mint` and `redeem` first drops what has aged out. It is a
 * prefix scan, and exact: every record in `pending` shares one `ttlMs`, so insertion order is
 * expiry order, and tombstones, held for a fixed span from creation, have the same property. One
 * limit: the clock belongs to the caller, and a clock stepping backwards (any machine talking to
 * NTP) extends a code's life by a minute on a 256-bit secret. A monotonic clock cannot produce the
 * epoch-millisecond `expiresAt` the token route and the wire need.
 *
 * Default generator: `crypto.randomBytes(32)`, base64url, 256 bits in 43 URL-safe characters.
 * RFC 6749 section 10.10 requires at least 128 bits. A redemption attempt is unauthenticated and
 * cheap, so the strength must live in the code, not in a limiter in front of it. With the
 * defaults at most 256 codes are live for 60 seconds each, so a million guesses per second (far
 * more than this loop would serve) covers about 6e7 of the 2^256 codes per window against 2^8
 * live values: roughly 2^-240 to hit one. base64url rather than hex (43 characters instead of 64
 * for the same entropy) and rather than plain base64 because the code travels in a query string,
 * where `+`, `/` and `=` need percent-encoding. This is not the player-facing bind code
 * (`lib/bindCodes.js`), which is eight characters from a confusable-free alphabet because a
 * human types it, and is weak on purpose (it lives for seconds and is rate-limited).
 *
 *     createAuthCodeStore({ now, generateCode, ttlMs, maxPending }) -> frozen {
 *       mint({ clientId, redirectUri, scope, codeChallenge,
 *              codeChallengeMethod, characterId })
 *         -> { code, expiresAt } | { code: null, failure }
 *       redeem(code) -> { outcome, record, grant }
 *         ok           -> record, grant: null
 *         already_used -> record: null, grant { characterId, clientId,
 *                                               grantRef | null }
 *         expired      -> record: null, grant: null
 *         unknown      -> record: null, grant: null
 *       rememberGrant(code, grantRef) -> boolean
 *       size()
 *     }
 *
 * Misconfiguration throws at construction (`AuthCodeError`), where a startup can refuse. Nothing
 * throws at mint or redeem time: eve.js treats an unhandled rejection as fatal (see `server.js`'s
 * header).
 */

"use strict";

const crypto = require("node:crypto");

// Constants

/** Bytes of randomness per code. 32 bytes is 256 bits; see the file header. */
const CODE_BYTES = 32;

/** Sixty seconds. See the file header; it is not the token's lifetime. */
const DEFAULT_TTL_MS = 60 * 1000;

/**
 * How many codes may be live at once.
 *
 * Sized for a private server (a handful of tools, each logging in once) with three orders of
 * magnitude of headroom, since a legitimate code occupies its slot for about one second of its
 * sixty. Reaching this means something is flooding the authorize endpoint, when refusing is the
 * correct answer.
 */
const DEFAULT_MAX_PENDING = 256;

/**
 * How long a spent or expired code is remembered.
 *
 * Five minutes, chosen for the operator rather than the protocol: long enough that a client
 * retrying after a network hiccup, and a human reading the log ten seconds later, both get the
 * true story ("used" or "expired") instead of "never existed". Longer buys nothing, since every
 * one of those answers is the same refusal on the wire, and costs memory whose fill rate an
 * unauthenticated caller controls.
 */
const DEFAULT_TOMBSTONE_MS = 5 * 60 * 1000;

/** Why a `mint` produced no code. */
const MINT_FAILURE = Object.freeze({
  /**
   * The store is full of live codes. See the file header: this is a refusal rather than an
   * eviction, it affects new logins and not existing sessions, and it clears itself within one TTL.
   */
  AT_CAPACITY: "at_capacity",

  /**
   * The generator returned a string this store already holds, as a live code or as a tombstone.
   *
   * With the default generator this cannot happen unless the RNG is broken (a 256-bit collision
   * against at most a few hundred values). An injected generator can collide, and that is the
   * point: overwriting would destroy a valid grant, or re-open a used code for replay. There is no
   * retry loop, because the only generator that collides would collide again.
   */
  COLLISION: "collision",

  /**
   * `generateCode` returned something that is not a usable code.
   *
   * A programming error, reported as a failure rather than thrown because this is the request
   * path; see the file header.
   */
  GENERATOR: "generator",
});

/** What happened to a `redeem`. Four names; the token route flattens them onto `invalid_grant`. */
const REDEEM_OUTCOME = Object.freeze({
  /** Redeemed, exactly once, and the record came back with it. */
  OK: "ok",
  /** It was redeemed before. RFC 6749's replay case; see the file header. */
  ALREADY_USED: "already_used",
  /** It existed and its TTL ran out before anyone came for it. */
  EXPIRED: "expired",
  /** Never minted here, or minted so long ago its tombstone has gone. */
  UNKNOWN: "unknown",
});

/** A store that was built wrong. Thrown at construction, never at mint or redeem. */
class AuthCodeError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthCodeError";
  }
}

// The default generator

/**
 * 256 bits from the platform CSPRNG, base64url encoded.
 *
 * `crypto.randomBytes` synchronously, not `randomBytes(n, cb)`: 32 bytes is a microsecond read
 * from the OS pool, and the async form would make every caller of `mint` a promise for no gain.
 */
function defaultGenerateCode() {
  return crypto.randomBytes(CODE_BYTES).toString("base64url");
}

// The store

/**
 * Build the code store the authorize and token routes share.
 *
 * `now` is required and has no default: a store that silently reached for `Date.now()` would let
 * a test pass that never injected a clock.
 */
function createAuthCodeStore({
  now,
  generateCode = defaultGenerateCode,
  ttlMs = DEFAULT_TTL_MS,
  maxPending = DEFAULT_MAX_PENDING,
  tombstoneMs = DEFAULT_TOMBSTONE_MS,
  maxTombstones = maxPending,
} = {}) {
  if (typeof now !== "function") {
    throw new AuthCodeError(
      "ESI mod: createAuthCodeStore needs a now() returning epoch milliseconds. It is required "
        + "rather than defaulted so that no caller, and no test, can end up depending on a "
        + "clock it did not choose.",
    );
  }
  if (typeof generateCode !== "function") {
    throw new AuthCodeError("ESI mod: createAuthCodeStore's generateCode must be a function.");
  }
  assertPositiveInteger(ttlMs, "ttlMs");
  assertPositiveInteger(tombstoneMs, "tombstoneMs");
  assertPositiveInteger(maxPending, "maxPending");
  assertPositiveInteger(maxTombstones, "maxTombstones");

  /** code -> the minted record. Insertion order is mint order, so also expiry order. */
  const pending = new Map();

  /**
   * code -> { outcome, until, characterId, clientId, grantRef }. Insertion order is creation
   * order, so also expiry order.
   *
   * The last three are null on everything but a spent code's tombstone, and `grantRef` stays null
   * there until `rememberGrant` fills it in. These entries are the one mutable thing in this
   * module and are never handed out: `redeem` copies what a caller may see into a frozen object,
   * so a caller cannot reach the store's memory.
   */
  const tombstones = new Map();

  /** What a tombstone knows about a code that was never spent: nothing. */
  const NO_GRANT = Object.freeze({ characterId: null, clientId: null, grantRef: null });

  /**
   * Drop everything that has aged out, in two prefix scans.
   *
   * Called at the top of `mint` and `redeem` with one reading of the clock, so one call cannot see
   * the store in two states (a `redeem` that swept with one `now` and compared expiry against
   * another would race with itself).
   */
  function sweep(at) {
    for (const [code, record] of pending) {
      if (at < record.expiresAt) break;
      pending.delete(code);
      entomb(code, REDEEM_OUTCOME.EXPIRED, at);
    }
    for (const [code, entry] of tombstones) {
      if (at < entry.until) break;
      tombstones.delete(code);
    }
  }

  /**
   * Remember that this code is spent, for `tombstoneMs` from now.
   *
   * `grant` is the identity a replay may be told about; see the file header. Anything that was not
   * redeemed (an expiry) gets `NO_GRANT`, since a replay of it has nothing to revoke.
   */
  function entomb(code, outcome, at, grant = NO_GRANT) {
    tombstones.set(code, {
      outcome,
      until: at + tombstoneMs,
      characterId: grant.characterId,
      clientId: grant.clientId,
      grantRef: grant.grantRef,
    });

    // Oldest first, which is insertion order. Safe in a way evicting a live
    // code is not (see the file header): the worst an evicted tombstone does is
    // downgrade a refusal's reason.
    while (tombstones.size > maxTombstones) {
      tombstones.delete(tombstones.keys().next().value);
    }
  }

  function mint(request) {
    // Read rather than destructured with a default, because a default only
    // covers `undefined` and `mint(null)` would throw, and this is the request
    // path, where eve.js treats a throw as fatal.
    const source = request !== null && typeof request === "object" ? request : {};
    const {
      clientId,
      redirectUri,
      scope,
      codeChallenge,
      codeChallengeMethod,
      characterId,
    } = source;

    const at = clockReading();
    sweep(at);

    if (pending.size >= maxPending) {
      return Object.freeze({ code: null, failure: MINT_FAILURE.AT_CAPACITY });
    }

    const code = generateCode();
    if (typeof code !== "string" || code === "") {
      return Object.freeze({ code: null, failure: MINT_FAILURE.GENERATOR });
    }
    if (pending.has(code) || tombstones.has(code)) {
      return Object.freeze({ code: null, failure: MINT_FAILURE.COLLISION });
    }

    const expiresAt = at + ttlMs;

    // Every field as given, plus the two times. Frozen, because this object is
    // handed to whoever redeems it and a route that mutated it would rewrite a
    // grant that a later log line still describes.
    pending.set(
      code,
      Object.freeze({
        clientId,
        redirectUri,
        scope,
        codeChallenge,
        codeChallengeMethod,
        characterId,
        issuedAt: at,
        expiresAt,
      }),
    );

    return Object.freeze({ code, expiresAt });
  }

  function redeem(code) {
    const at = clockReading();
    sweep(at);

    // A non-string is not a code this store ever produced, so it is unknown
    // rather than an error: the token endpoint's `code` parameter is whatever
    // arrived in a form body, and shaping the answer is the route's job.
    if (typeof code !== "string" || code === "") {
      return outcome(REDEEM_OUTCOME.UNKNOWN);
    }

    const record = pending.get(code);
    if (record !== undefined) {
      // The sweep above already moved anything expired into a tombstone using
      // this same `at`, so anything still here is live.
      pending.delete(code);

      // The tombstone is written with the identity a replay may be told about
      // and with no reference yet: at this instant nothing has been issued, and
      // a redemption can still fail downstream (the access token mint can
      // throw, the refresh store can refuse), so a tombstone that named
      // something now would ask the route to revoke what was never created. It
      // learns the reference when the route comes back through `rememberGrant`.
      entomb(code, REDEEM_OUTCOME.ALREADY_USED, at, {
        characterId: record.characterId,
        clientId: record.clientId,
        grantRef: null,
      });

      // `grant` stays null here. The record already carries `characterId` and
      // `clientId`, so a grant object on this path would be a second spelling
      // of what the caller is holding, and it would cost the one invariant
      // worth having: a non-null `grant` means a replay.
      return Object.freeze({ outcome: REDEEM_OUTCOME.OK, record, grant: null });
    }

    const tombstone = tombstones.get(code);
    if (tombstone !== undefined) {
      if (tombstone.outcome !== REDEEM_OUTCOME.ALREADY_USED) return outcome(tombstone.outcome);

      // A replay, and the one answer in this module that is not just a refusal:
      // the token route reads this to revoke what the first redemption minted.
      // `record` stays null: the caller learns whose grant it was, never the grant.
      return Object.freeze({
        outcome: REDEEM_OUTCOME.ALREADY_USED,
        record: null,
        grant: Object.freeze({
          characterId: tombstone.characterId,
          clientId: tombstone.clientId,
          grantRef: tombstone.grantRef,
        }),
      });
    }

    return outcome(REDEEM_OUTCOME.UNKNOWN);
  }

  /**
   * Remember an opaque reference against a spent code's tombstone.
   *
   * The token route calls this once it has actually issued something, which is the only moment
   * there is anything to name. It passes whatever the issuing store calls that thing, and this
   * function stores the string and asks no questions: it is never parsed, never compared, and
   * never handed anywhere except back out of the next replay of this code. Knowing that the string
   * is a refresh family would couple this module to `lib/refreshTokens.js` for no behaviour; the
   * coupling belongs to the route, the only layer that talks to both stores. It also keeps this
   * file's tests free of a token store.
   *
   * A tombstone remembers one reference: the first one bound to it. A second call naming the same
   * string is a no-op and still `true`. A second call naming a different string is `false` and
   * changes nothing, because a code redeems once and therefore produced one grant; overwriting
   * would point the revocation at something this code never minted, the over-revocation this
   * design exists to avoid.
   *
   * Returns whether the tombstone now names this reference, and returns `false` rather than
   * throwing for every way this can miss: an unknown code, a tombstone already swept, an expiry
   * rather than a redemption, arguments that are not usable strings. All are the request path,
   * where a throw is fatal. The cost of a miss is that a replay of that code cannot name its
   * grant, visible in the `null` it gets back.
   *
   * It does not touch `until`. The tombstone lives for `tombstoneMs` from creation, because the
   * prefix scan in `sweep` depends on insertion order being expiry order, and extending one entry
   * would strand every tombstone behind it.
   */
  function rememberGrant(code, grantRef) {
    if (typeof code !== "string" || code === "") return false;
    if (typeof grantRef !== "string" || grantRef === "") return false;

    // Swept first, on the same terms as `mint` and `redeem`, so that "the
    // tombstone aged out" is a miss here rather than a write into an entry the
    // next sweep is about to drop.
    sweep(clockReading());

    const tombstone = tombstones.get(code);
    if (tombstone === undefined) return false;
    if (tombstone.outcome !== REDEEM_OUTCOME.ALREADY_USED) return false;

    // First binding wins, and a repeat of it is not a failure. See above.
    if (tombstone.grantRef !== null) return tombstone.grantRef === grantRef;

    tombstone.grantRef = grantRef;
    return true;
  }

  /**
   * The clock, defended, the way `lib/errorLimiter.js` defends its own.
   *
   * A `now` returning a non-number is a programming error that would poison every `expiresAt` in
   * the store with `NaN`, which compares false against everything, so nothing would expire and
   * the sweep would stop working silently. Falling back keeps the store correct.
   */
  function clockReading() {
    const at = Number(now());
    return Number.isFinite(at) ? at : Date.now();
  }

  return Object.freeze({
    mint,
    redeem,
    rememberGrant,

    /**
     * How many codes are held. Tombstones are not pending and are not counted.
     *
     * It does not sweep, which is what "lazy" means: a store nobody has touched still holds whatever
     * expired meanwhile and drops it on the next `mint` or `redeem`. A caller logging this number
     * should know it is "held" and not "still valid".
     */
    size() {
      return pending.size;
    },

    /**
     * How many spent codes are remembered.
     *
     * Nothing in the request path reads this; it lets the test for the tombstone bound assert the
     * bound instead of watching memory, like `bucketCount` in `lib/rateLimiter.js`.
     */
    tombstoneCount() {
      return tombstones.size;
    },
  });
}

/**
 * Every answer that is not a redemption and not a replay.
 *
 * Both `record` and `grant` are null, for different reasons: there is no grant to issue from,
 * and nothing that was ever issued to revoke. A caller that sees `grant: null` knows this module
 * cannot help it, which differs from a replay whose `grantRef` never got recorded.
 */
function outcome(name) {
  return Object.freeze({ outcome: name, record: null, grant: null });
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new AuthCodeError(
      `ESI mod: createAuthCodeStore's ${name} must be a positive integer, got `
        + `${JSON.stringify(value)}.`,
    );
  }
}

module.exports = Object.freeze({
  CODE_BYTES,
  DEFAULT_MAX_PENDING,
  DEFAULT_TOMBSTONE_MS,
  DEFAULT_TTL_MS,
  MINT_FAILURE,
  REDEEM_OUTCOME,
  AuthCodeError,

  createAuthCodeStore,
  defaultGenerateCode,
});
