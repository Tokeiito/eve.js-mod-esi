/**
 * eve.js-mod-esi: refresh tokens, the credential that has to outlive the process
 *
 * An access token dies in twenty minutes and nobody notices; a refresh token
 * dies and a human has to go back into the game client, type a bind code and
 * re-authorise a tool that was working yesterday. On a private server that
 * bounces for a config change or a `docker compose up -d`, the grant must be on
 * disk before the token reaches the client.
 *
 * This module owns the grant and nothing else: what a refresh token is, where
 * the record lives, when it stops being valid, and whether a requested scope is
 * inside the granted one. It knows nothing about HTTP (no statuses, no form
 * bodies, no `invalid_grant`): `POST /v2/oauth/token` consumes this store as an
 * injected object and answers in the shape OAuth requires. It does not mint
 * access tokens either.
 *
 * The signing key is not involved (D8). D8 allows one signing slot and no
 * overlap window because a refresh token is an opaque random string recorded in
 * this file, not something the key signs; replacing the key costs a client one
 * failed request and one refresh, never a re-authorisation. So:
 *
 *   - the token is `crypto.randomBytes(32)`, base64url: no key, signature or
 *     claims;
 *   - what is stored is an unkeyed SHA-256 of it, not an HMAC, so no secret is in
 *     the validation path;
 *   - this module requires `node:crypto`, `node:fs` and `node:path`, and
 *     deliberately not `lib/signingKey.js`, including for the file-permission
 *     warning below, a near-duplicate of that module's. A shared helper would be
 *     a real edge from the refresh store to the signing key.
 *
 * If a refresh token ever depends on the signing key (signed, keyed hash,
 * derived), D8 has to be reopened: a key rotation would invalidate every refresh
 * token on the server.
 *
 * No rotation (D30). Real CCP may return a different `refresh_token` from a
 * refresh call; we do not. The argument is in `docs/open-decisions.md` D30: a
 * client that mishandles a rotated token is locked out with nothing an operator
 * can diagnose (D4: this ecosystem's tools are old and varied, and the EVE client
 * itself refuses an empty `refresh_token`), while a stolen token that goes
 * undetected is a risk on a server where the attacker is already inside the
 * trust boundary. Rotation buys theft detection, not containment, and revocation
 * still works.
 *
 * Turning rotation on is one edit inside `issue`/`refresh`. Every record carries
 * a `family` and a `generation` (0 on every record written so far); rotation
 * would mint a new token in the same `family` at `generation + 1` and retire the
 * old record as `SUPERSEDED`, which is already a state, an outcome `refresh`
 * answers with, and something the pruner ages out (the per-subject cap uses it).
 * The theft signal a rotating store would produce, a refresh for an already
 * superseded record, is therefore distinguishable in this outcome set before
 * rotation is switched on.
 *
 * `revokeFamily` (D40) is the first reader of `family`. When an authorization code
 * is replayed, the tokens minted from it must go, and the caller holding the used
 * code can name the family it issued into but not the token strings. With
 * rotation off a family is one record; with it on, the whole chain is retired.
 *
 * Location: `<gameStore root>/../sso/refresh-tokens.jsonl`, resolved through
 * `lib/runtimeAccess.js`'s `getRefreshTokenStorePath()`, never hardcoded. It is a
 * sibling of the game store in the `sso/` directory with the signing key (D8).
 * The mod directory is a copy `scripts/deploy-mod.js` replaces wholesale (D21),
 * and in the container the mod tree is mounted read-only while the store root is
 * a writable volume, so this is the only writable place that survives a redeploy.
 * There is no `ESI_MOD_REFRESH_TOKEN_STORE_PATH`: the signing key has an override
 * because an operator may already own a key, while nobody owns a refresh token
 * store but this mod, and moving one means moving the whole `sso/` directory. The
 * path is a required argument, which keeps this module testable against a temp
 * directory.
 *
 * On-disk format: JSON Lines, rewritten whole, atomically. Line 1 is a header
 * carrying a format version; every other non-empty line is one record. Every
 * mutation rewrites the file into a temp file, `fsync`s, and `rename`s over the
 * target.
 *
 * The alternative was an append-only log compacted on load. Writes are rare (one
 * per authorisation, revocation or refresh: tens per hour on a busy private
 * server) and reads never touch the file after startup, because the store is a
 * `Map` for the life of the process. That removes the log's advantage (O(1)
 * writes) and leaves its cost: a compaction path is a second writer of the same
 * file with its own atomicity story, and an append-only log must decide what a
 * truncated final line means, when a benign half-written record and a corrupt
 * file look identical. A rename is atomic, so what is on disk is always a
 * complete document. The cost is O(n) bytes per write, with `n` capped
 * (`DEFAULT_MAX_RECORDS`): about 1 MB worst case, a few kilobytes realistically.
 *
 * JSON Lines rather than one array so a record that does not parse is an
 * identifiable line number the refusal can name ("line 14 is not a record").
 *
 * The token is not in the file. Records are keyed by the unkeyed SHA-256 of the
 * token, hex; the token string is written and kept nowhere. Unkeyed and unsalted
 * because the token is 256 bits from the platform CSPRNG, so there is no
 * dictionary or rainbow table to defend against, and a keyed hash would put a
 * secret in the validation path (see D8 above). A copy of this file is therefore
 * not a set of working credentials. That is a modest claim, since anything that
 * can read the neighbouring game store can read every character record (the same
 * ceiling `lib/signingKey.js` states), but a store is a plausible thing to copy
 * (a backup, a `docker cp`, a bug report attachment) where a key is not. Lookup is
 * a `Map` get on the hash, not a scan with `crypto.timingSafeEqual`: an attacker
 * would need the token to compute the hash, and the only fact timing could leak,
 * whether the record exists, is in the answer.
 *
 * Writes are synchronous. With a full-rewrite format, two interleaved writes lose
 * data silently: the loser serialises the store as it was before the winner's
 * mutation, and the later rename deletes a token nobody knows is gone. A
 * synchronous write makes the in-memory mutation and the file rewrite one step as
 * far as the event loop is concerned, so the file always matches the map. The
 * cost is paid on the game's event loop (design constraint 2): a serialise,
 * a write, an `fsync` and a `rename` per login, revocation or refresh. The `fsync`
 * is deliberate: without it a power loss can leave the rename durable and the
 * bytes not, which loses every token rather than the last one. The directory is
 * not `fsync`ed, so the rename is only as durable as the filesystem makes it, and
 * `node:fs` offers no portable way to do better on Windows.
 *
 * Two processes remain a risk, closed upstream: `loader.js` guarantees exactly
 * one process binds the SSO listener (the readiness hook keys off a module only
 * the game-state process loads, guard 2 in its header). This store does not defend
 * against a second writer, whose rename would replace the winner's file. If that
 * guarantee stops holding, this file needs a lock.
 *
 * A corrupt store is refused, never treated as empty. A file that exists and
 * cannot be parsed (a bad line, a duplicate record, an unknown format version, an
 * unreadable file) throws, naming the path, the line and one remedy. Starting
 * empty would trade a refusal a human can read and clear with one `mv` for
 * re-authorisation of every tool, which is worse because D3 makes an in-game bind
 * code the only grant. The damaged file is also the only recoverable state, and
 * the first thing an empty store does is write over it: every client dies and the
 * log says the mod started normally. A single bad line refuses the whole file for
 * the same reason. The throw is safe because the SSO listener's startup is the
 * caller (as with `lib/signingKey.js`), and design constraint 2 is met by that
 * caller declining to serve SSO, as `loader.js` goes dormant on a configuration
 * error. An absent file is the first-boot state and loads as an empty store.
 *
 * Bounded growth. A revoked record stays recorded so a replay is distinguishable
 * from an unknown token, which is unbounded unless given a horizon:
 *
 *   - A retired record (revoked or superseded) is kept for
 *     `DEFAULT_RETENTION_MS` (30 days) from the moment it was retired, then
 *     pruned. After that a replay reads `UNKNOWN` instead of `REVOKED`.
 *   - Retired records are also capped, evicting oldest-first.
 *   - Live records are capped per subject (`(characterId, clientId)`): a ninth
 *     authorisation for the same pair retires the least recently used of the
 *     eight, as `SUPERSEDED`.
 *   - Live records are capped globally as a backstop, and at the cap `issue`
 *     refuses rather than evicting.
 *
 * `lib/authCodes.js` concluded that a pruned tombstone downgrades `already_used`
 * to `unknown`, which is still a refusal, and the argument transfers: RFC 6749
 * section 5.2 makes both `invalid_grant`, so a pruned record costs an operational
 * story, never a security property. The timescale differs. An authorization code
 * lives 60 seconds, so five minutes of tombstone covers every retry. A refresh
 * token lives indefinitely, so a replay of a revoked one can arrive months later;
 * 30 days is the window in which an operator who revoked a token is still
 * plausibly watching for it.
 *
 * The live caps differ from `authCodes`'s in who can fill them. `mint` there is
 * reachable before any identity check; issuing here requires a redeemed
 * authorization code, which requires an in-game bind (D3), so the fill rate is
 * gated by real characters. The global cap is a backstop, and refuses rather than
 * evicting because evicting a live refresh token permanently logs out a working
 * client. It is not self-healing (nothing here expires on a clock): reaching it
 * means `characters x clients` genuinely exceeded four thousand, an operator fact
 * to look at. The per-subject cap is self-healing and covers the realistic fill
 * path: one tool re-authorising repeatedly recycles its own eight slots.
 *
 * Live records do not expire on a clock. CCP's refresh tokens have no published
 * idle expiry, so one here would be a divergence a client cannot discover (design
 * constraint 3), and it would log out the tools this store exists for (the one
 * that runs monthly, the laptop that was closed for a while).
 *
 * Scope narrowing. RFC 6749 section 6: the refresh request's optional `scope`
 * must not include any scope the original grant did not. The check lives here
 * because the granted set does. A requested set that is not a subset is a refusal
 * (`SCOPE_NOT_SUBSET`), never a silent intersection, which would hand back an
 * access token that does less than asked and surface at the first 403. It is a
 * distinct outcome because the wire answers differ: RFC 6749 section 5.2 gives a
 * bad token `invalid_grant` and an over-wide scope `invalid_scope`. Narrowing
 * applies to this refresh only; the stored grant is not narrowed, since a client
 * that asks for less once must be able to ask for everything next time. An absent
 * or empty requested set is "no narrowing".
 *
 * The clock is injected and nothing sweeps on a timer. `now` is required, with no
 * default, as in `lib/authCodes.js`: tests drive a 30-day horizon by arithmetic,
 * and no caller depends on a clock it did not choose. There is no `setInterval`:
 * this mod shares the game's event loop. The prune is lazy: every mutation drops
 * what has aged out first, as a prefix scan, since every retired record is held
 * for the same span from its own retirement, so insertion order is expiry order.
 *
 * Nothing here is a wire constant. Deployed modules that duplicate an observation
 * from `contract/` carry a note saying so (`contract/` is test-only, D20). A
 * refresh token is opaque, so CCP's wire constrains nothing about it, and every
 * byte that reaches a client belongs to the token route.
 *
 * Shape:
 *
 *     createRefreshTokenStore({ storePath, now, generateToken, fs, platform,
 *                               log, maxRecords, maxPerSubject, retentionMs,
 *                               maxRetired }) -> frozen {
 *       issue({ characterId, clientId, scopes })
 *         -> { token, record } | { token: null, failure }
 *       refresh(token, { scopes }) -> { outcome, record, scopes, scope }
 *       revoke(token, { reason }) -> { outcome, record }
 *       revokeFamily(family, { reason }) -> { outcome, records }
 *       inspect(token) -> { outcome, record }
 *       size() / retiredCount() / path
 *     }
 *
 * Misconfiguration and an unusable file throw at construction
 * (`RefreshTokenStoreError`), where a startup can refuse. Nothing throws on the
 * request path: eve.js treats an unhandled rejection as fatal (see `server.js`'s
 * header).
 */

"use strict";

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const path = require("node:path");

// Constants

/**
 * Bytes of randomness per token: 32, so 256 bits, in 43 base64url characters.
 *
 * The same width as `lib/authCodes.js`'s code, for a stronger reason: that one
 * leans partly on a 60-second TTL, while a refresh token has no TTL, so the
 * entropy is the whole defence and must hold without a limiter or clock.
 *
 * At most 4,096 live tokens is 2^12 live values against a 2^256 space. A million
 * guesses a second, far beyond what this event loop would serve, covers about
 * 2^52 values in a century, so the chance of hitting a live one is around 2^-192.
 *
 * Not wider: 256 bits is past every brute-force horizon and each extra byte is
 * paid by every client that stores or sends the string. Not narrower: 128 bits
 * would be safe today, and "safe today" is the wrong standard for a credential
 * with no expiry.
 *
 * base64url rather than hex as for the authorization code (43 characters instead
 * of 64), and rather than base64 because `+`, `/` and `=` need percent-encoding
 * in a form body.
 */
const TOKEN_BYTES = 32;

/**
 * The store format's version, on the header line.
 *
 * A version lets a future format change be recognised instead of parsed into
 * nonsense or refused as corruption. An unknown version is a refusal that says
 * "this store was written by a newer mod", pointing at a different fix (roll
 * forward, not `mv`) from "this store is damaged".
 */
const STORE_FORMAT_VERSION = 1;

/** What the header line calls itself, so a stray file is identifiable by `head -1`. */
// A former project name, kept: stores on disk carry it, and one that does not
// match is refused at boot.
const STORE_KIND = "evej-esi_sso.refresh-tokens";

/**
 * POSIX modes, applied through the `open` mode at creation rather than a later
 * `chmod`, so the file is never briefly world-readable.
 *
 * The same bits and reasoning as the signing key's, with the same caveat about
 * what they are worth: see `permissionWarningsFor` below and `lib/signingKey.js`.
 */
const STORE_FILE_MODE = 0o600;
const STORE_DIR_MODE = 0o700;

/** The bits that must be clear on POSIX: group and other, read included. */
const FORBIDDEN_PERMISSION_BITS = 0o077;

/**
 * How many live grants the store will hold in total.
 *
 * A backstop, not a defence: issuing is gated behind an in-game bind (D3).
 * Four thousand is far past what a private server's characters times its tools
 * can produce, and keeps the file rewritten on every mutation near a megabyte in
 * the worst case. At the cap `issue` refuses; see the header for why refusing
 * beats evicting somebody's working session.
 */
const DEFAULT_MAX_RECORDS = 4096;

/**
 * How many live grants one `(characterId, clientId)` pair may hold at once.
 *
 * Eight, and this is the cap that does the work: the realistic way a store grows
 * is one tool re-authorising, and this makes that path recycle its own slots.
 * Eight rather than one because a client legitimately holds more than one grant
 * (the same tool on a second machine, a re-authorisation while the old token is
 * still in use), and retiring a token somebody is holding is the failure the
 * store exists to prevent.
 */
const DEFAULT_MAX_PER_SUBJECT = 8;

/**
 * How long a retired record (revoked or superseded) is remembered.
 *
 * Thirty days, chosen for the operator rather than the protocol, because every
 * answer this store can give about a dead token is the same refusal on the wire.
 * It is the window in which somebody who revoked a token is still plausibly
 * asking "did it come back?".
 */
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** What a record is. Retired records keep every field they had while live. */
const RECORD_STATE = Object.freeze({
  /** Usable. Exactly the records `refresh` answers `OK` for. */
  LIVE: "live",
  /** An operator or a client revoked it. Kept, so a replay is nameable. */
  REVOKED: "revoked",
  /**
   * Retired by the per-subject cap and, if rotation is ever switched on, by a
   * rotation. One state for both because they are the same event: this grant has
   * been replaced by a newer one in the same family.
   */
  SUPERSEDED: "superseded",
});

/** Why an `issue` produced no token. */
const ISSUE_FAILURE = Object.freeze({
  /**
   * The store is at `maxRecords`. A refusal rather than an eviction, and unlike
   * `lib/authCodes.js`'s it does not clear itself on a timer; see the header.
   */
  AT_CAPACITY: "at_capacity",

  /**
   * The generator returned a token this store already holds, live or retired.
   *
   * Impossible with the default generator unless the RNG is broken (a 256-bit
   * collision against a few thousand values), and possible with an injected one,
   * which is why there is no retry loop: overwriting a live record would destroy a
   * working grant, and overwriting a retired one would re-open a revoked token for
   * replay. A generator that collides collides again.
   */
  COLLISION: "collision",

  /** `generateToken` returned something that is not a usable token. */
  GENERATOR: "generator",

  /**
   * `characterId` or `clientId` is missing or unusable.
   *
   * The store records `scopes` verbatim and has no opinion about them, as
   * `lib/authCodes.js` records a whole grant verbatim. These two are different:
   * they are the key of the per-subject bookkeeping, so a store that accepted
   * `undefined` would file every anonymous grant under one subject and start
   * retiring unrelated clients' tokens. This is the store refusing to key its own
   * map on nothing, not second-guessing the route's policy.
   */
  SUBJECT: "subject",

  /**
   * The record could not be written to disk, so it was not issued.
   *
   * The value of issuing is that it survives a restart. A token whose record only
   * exists in this process's heap would die at the next bounce with nothing in the
   * log, so the in-memory record is rolled back and the caller is told. See
   * `revoke` for the same asymmetry pointing the other way, and `refresh` for where
   * it does not apply.
   */
  PERSIST: "persist",
});

/** What happened to a `refresh`. The token route flattens the token ones onto `invalid_grant`. */
const REFRESH_OUTCOME = Object.freeze({
  /** Live, and the requested scopes were inside the granted set. */
  OK: "ok",
  /** The record exists and was revoked. Distinct from `UNKNOWN`: a revoked token is told apart from one never issued. */
  REVOKED: "revoked",
  /** The record exists and a newer grant replaced it (per-subject cap, or a rotation). */
  SUPERSEDED: "superseded",
  /** Never issued here, or issued so long ago its retired record has been pruned. */
  UNKNOWN: "unknown",
  /**
   * The token is fine; the requested scope is not a subset of the granted set.
   *
   * Distinct because the wire answer is distinct: RFC 6749 section 5.2's
   * `invalid_scope`, not `invalid_grant`.
   */
  SCOPE_NOT_SUBSET: "scope_not_subset",
});

/** What happened to a `revoke`. RFC 7009 says to answer 200 to most of these. */
const REVOKE_OUTCOME = Object.freeze({
  /** It was live, it is not any more, and the change is on disk. */
  OK: "ok",
  /** It was already revoked. Idempotent, which is what RFC 7009 §2.2 asks for. */
  ALREADY_REVOKED: "already_revoked",
  /** It was already retired by a newer grant, so there is nothing left to revoke. */
  SUPERSEDED: "superseded",
  /** Never issued here, or pruned. */
  UNKNOWN: "unknown",
  /**
   * The revocation could not be written, so it did not happen.
   *
   * The mirror of `ISSUE_FAILURE.PERSIST` and the sharper half: a revocation that
   * lives only in this process's heap comes back to life at the next restart,
   * un-revoking a token an operator believes is dead. So it is rolled back and
   * reported, and the revoke route must not answer 200 to it.
   */
  PERSIST_FAILED: "persist_failed",
});

/**
 * The `records` a `revokeFamily` that retired nothing hands back.
 *
 * A frozen shared constant rather than a fresh `[]` per call, for two reasons.
 * It is never null, so a caller counting what it revoked writes
 * `result.records.length` on every path instead of guarding first; and the two
 * ways of retiring nothing, an unmatched family and a write that failed, cannot
 * drift into answering with different shapes, because they answer with the same
 * object. Frozen because everything else this module hands out is.
 */
const NO_RECORDS = Object.freeze([]);

/** A store that was built wrong, or a file that cannot be used. */
class RefreshTokenStoreError extends Error {
  constructor(message, storePath) {
    super(`[EsiApiMod] ${message}`);
    this.name = "RefreshTokenStoreError";
    this.storePath = storePath === undefined ? null : storePath;
  }
}

/**
 * The one remedy, appended to every refusal about the file itself.
 *
 * The same gesture `lib/signingKey.js` teaches for a damaged key (move it aside,
 * restart), so the mod has one recovery procedure, and the cost is stated in the
 * sentence.
 */
function remedyFor(storePath) {
  return (
    `Move ${storePath} aside and restart to start from an empty store, understanding `
    + "that every client then has to authorise again through an in-game bind code (D3). "
    + "This mod will not do that for you: silently starting fresh over an unreadable "
    + "store logs every client out and reports a normal startup."
  );
}

// The default generator

/**
 * 256 bits from the platform CSPRNG, base64url encoded. See `TOKEN_BYTES`.
 *
 * `crypto.randomBytes` synchronously rather than with a callback: 32 bytes is a
 * read from the OS pool costing microseconds, and the async form would make
 * every caller of `issue` a promise for no measurable gain inside a process that
 * is already the game's.
 */
function defaultGenerateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Pure core: the token's storage key.
 *
 * **Unkeyed SHA-256, hex.** Not an HMAC (see the D8 section in the header,
 * which this function is the mechanical half of). Not salted, because a
 * full-entropy random string has no dictionary to defend against and a per-record
 * salt would defeat the `Map` lookup this store is built on.
 */
function hashToken(token) {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Pure core: the short, safe thing a log line may say about a token. */
function tokenFingerprint(tokenHash) {
  return tokenHash.slice(0, 12);
}

// Pure: scopes

/**
 * Pure core: whatever a caller had, as an ordered list of distinct scope tokens,
 * or `null` for "not given".
 *
 * Both a string and an array are accepted, on purpose. `routes/oauthAuthorize.js`
 * parses the request into a space-delimited `scope` string, which is what
 * `authCodes.mint` records and what RFC 6749 section 3.3 says the parameter is,
 * while the record field is `scopes` and a subset check wants a list. A store
 * accepting only one would push the conversion onto the caller, where handing a
 * whole space-delimited string in as one scope token silently over-grants (that
 * one giant token becomes a member of the granted set and nothing ever matches
 * it). Doing it once, here, is one place to be right.
 *
 * Order is preserved and duplicates drop, first occurrence winning, matching
 * `parseScope`'s normalisation so the granted set is not reordered between the
 * authorize route and the token response.
 */
function normalizeScopes(input) {
  if (input === undefined || input === null) return null;

  const raw = typeof input === "string" ? input.split(" ") : input;
  if (!Array.isArray(raw)) return null;

  const seen = new Set();
  const scopes = [];
  for (const token of raw) {
    if (typeof token !== "string" || token === "") continue;
    if (seen.has(token)) continue;
    seen.add(token);
    scopes.push(token);
  }
  return scopes;
}

/** Pure core: the space-delimited form RFC 6749 puts on the wire. */
function scopeString(scopes) {
  return Array.isArray(scopes) ? scopes.join(" ") : "";
}

/**
 * Pure core: is every requested scope inside the granted set?
 *
 * Exact string equality on each token: no prefix matching, no case folding, no
 * `esi-`-aware cleverness. A scope is opaque to everything except the route that
 * requires it, and a store that decided `esi-wallet.read_character_wallet.v1`
 * implied `.v2` would invent authority CCP never granted.
 */
function isSubsetOfScopes(requested, granted) {
  const have = new Set(granted);
  for (const scope of requested) {
    if (!have.has(scope)) return false;
  }
  return true;
}

// Pure: the file

/**
 * The record's member order, which is also the file's column order.
 *
 * Fixed, so a store rewritten by a mod that changed nothing produces a
 * byte-identical file and an operator diffing two backups sees only the records
 * that changed.
 */
const RECORD_MEMBERS = Object.freeze([
  "tokenHash",
  "state",
  "characterId",
  "clientId",
  "scopes",
  "issuedAt",
  "lastUsedAt",
  "refreshCount",
  "family",
  "generation",
  "retiredAt",
  "revokedReason",
]);

/** Pure core: an in-memory record as the object that goes on its line. */
function recordToLine(record) {
  const out = {};
  for (const member of RECORD_MEMBERS) out[member] = record[member];
  return JSON.stringify(out);
}

/**
 * Pure core: the whole store as the bytes that go on disk.
 *
 * Live records first, then retired ones in retirement order, because that is
 * the order they are held in and the order the loader wants them back in. The
 * retired map's insertion order *is* its expiry order, and a load that shuffled
 * it would break the prefix scan the pruner depends on.
 */
function serializeStore(records, writtenAt) {
  const lines = [
    JSON.stringify({ kind: STORE_KIND, version: STORE_FORMAT_VERSION, written: writtenAt }),
  ];
  for (const record of records) lines.push(recordToLine(record));
  return `${lines.join("\n")}\n`;
}

/**
 * Pure core: the bytes on disk as records, or a `RefreshTokenStoreError`.
 *
 * Every refusal names the line, the difference between an operator who can look
 * at the damage and one who can only delete the file.
 *
 * Empty lines are skipped wherever they appear. A blank line carries no
 * information and is not a truncated record (the whole-file rename means a
 * truncated record is not a state this format can be in), while an editor's
 * trailing newline is normal.
 */
function parseStore(text, storePath) {
  const lines = text.split(/\r?\n/);

  let header = null;
  const records = [];
  const seen = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;

    let value;
    try {
      value = JSON.parse(line);
    } catch (err) {
      throw new RefreshTokenStoreError(
        `the refresh token store at ${storePath} has a line that is not JSON `
        + `(line ${index + 1}: ${err && err.message ? err.message : String(err)}). `
        + remedyFor(storePath),
        storePath,
      );
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new RefreshTokenStoreError(
        `the refresh token store at ${storePath} has a line that is not a JSON object `
        + `(line ${index + 1}). ${remedyFor(storePath)}`,
        storePath,
      );
    }

    if (header === null) {
      header = readHeader(value, storePath, index + 1);
      continue;
    }

    const record = readRecord(value, storePath, index + 1);
    if (seen.has(record.tokenHash)) {
      // Two records for one token is not a state this store can write, so the
      // file has been concatenated, merged or hand-edited. Picking one silently
      // either resurrects a revoked grant or destroys a live one, and there is
      // no way to tell from here which copy is the true one.
      throw new RefreshTokenStoreError(
        `the refresh token store at ${storePath} records the same token twice `
        + `(line ${index + 1}). ${remedyFor(storePath)}`,
        storePath,
      );
    }
    seen.add(record.tokenHash);
    records.push(record);
  }

  if (header === null) {
    // A file that exists and has no header line at all. Not treated as an empty
    // store: an empty store is an *absent* file, and a present one that says
    // nothing is a file something else wrote.
    throw new RefreshTokenStoreError(
      `the refresh token store at ${storePath} has no header line. ${remedyFor(storePath)}`,
      storePath,
    );
  }

  return records;
}

/** Pure core: the header line, or a refusal that says which kind of wrong it is. */
function readHeader(value, storePath, line) {
  if (value.kind !== STORE_KIND) {
    throw new RefreshTokenStoreError(
      `the file at ${storePath} is not a refresh token store: its first line says `
      + `${JSON.stringify(value.kind)} rather than ${JSON.stringify(STORE_KIND)} `
      + `(line ${line}). Check the path before moving anything: this is more likely a `
      + "misconfiguration than a damaged store.",
      storePath,
    );
  }
  if (value.version !== STORE_FORMAT_VERSION) {
    // Deliberately a different sentence from the corruption ones. A newer version is
    // not damage and `mv` is not the fix; running the mod that wrote it is.
    throw new RefreshTokenStoreError(
      `the refresh token store at ${storePath} is format version `
      + `${JSON.stringify(value.version)}, and this mod reads version `
      + `${STORE_FORMAT_VERSION}. It was written by a different build; run that one, or `
      + "move the store aside and let every client authorise again.",
      storePath,
    );
  }
  return value;
}

/**
 * Pure core: one line's object as a record, with every field checked.
 *
 * Strict about types rather than coercing, because every one of these fields is
 * load-bearing: a `characterId` that arrives as a string keys a different
 * subject from the same id as a number, a `state` this build does not know is a
 * record whose validity nobody can decide, and an `issuedAt` of `null` makes
 * every comparison against it false forever.
 */
function readRecord(value, storePath, line) {
  const problem = recordProblem(value);
  if (problem !== null) {
    throw new RefreshTokenStoreError(
      `the refresh token store at ${storePath} has an unusable record `
      + `(line ${line}: ${problem}). ${remedyFor(storePath)}`,
      storePath,
    );
  }

  return freezeRecord({
    tokenHash: value.tokenHash,
    state: value.state,
    characterId: value.characterId,
    clientId: value.clientId,
    scopes: value.scopes.slice(),
    issuedAt: value.issuedAt,
    lastUsedAt: value.lastUsedAt,
    refreshCount: value.refreshCount,
    family: value.family,
    generation: value.generation,
    retiredAt: value.retiredAt,
    revokedReason: value.revokedReason,
  });
}

/** Pure core: the first thing wrong with a record object, or `null`. */
function recordProblem(value) {
  if (typeof value.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(value.tokenHash)) {
    return "tokenHash is not a SHA-256 hex digest";
  }
  if (!Object.values(RECORD_STATE).includes(value.state)) {
    return `state ${JSON.stringify(value.state)} is not one this build knows`;
  }
  const subject = subjectProblem(value.characterId, value.clientId);
  if (subject !== null) return subject;
  if (!Array.isArray(value.scopes) || value.scopes.some((s) => typeof s !== "string")) {
    return "scopes is not an array of strings";
  }
  if (!Number.isFinite(value.issuedAt)) return "issuedAt is not a number";
  if (!Number.isFinite(value.lastUsedAt)) return "lastUsedAt is not a number";
  if (!Number.isInteger(value.refreshCount) || value.refreshCount < 0) {
    return "refreshCount is not a non-negative integer";
  }
  if (typeof value.family !== "string" || value.family === "") return "family is not a string";
  if (!Number.isInteger(value.generation) || value.generation < 0) {
    return "generation is not a non-negative integer";
  }
  if (value.state === RECORD_STATE.LIVE) {
    if (value.retiredAt !== null) return "a live record carries a retiredAt";
  } else if (!Number.isFinite(value.retiredAt)) {
    return "a retired record has no retiredAt";
  }
  if (value.revokedReason !== null && typeof value.revokedReason !== "string") {
    return "revokedReason is neither null nor a string";
  }
  return null;
}

/**
 * Pure core: what is wrong with the two fields the store keys its own
 * bookkeeping on, or `null`.
 *
 * One function for both callers (the file and `issue`), so the file cannot accept
 * a subject the request path would have refused, or the reverse. A character id is
 * a number or a non-empty string because this mod does not decide which the game
 * uses; it needs the same character to always produce the same key.
 */
function subjectProblem(characterId, clientId) {
  const idOk =
    (typeof characterId === "number" && Number.isFinite(characterId))
    || (typeof characterId === "string" && characterId !== "");
  if (!idOk) return "characterId is neither a finite number nor a non-empty string";
  if (typeof clientId !== "string" || clientId === "") return "clientId is not a non-empty string";
  return null;
}

/**
 * Pure core: the map key for a `(characterId, clientId)` pair.
 *
 * NUL as the separator, because a printable one lets two different subjects
 * collide: a client id is a string somebody else chose, and every printable
 * character is legal inside it. `lib/clientRegistry.js` refuses every C0 control
 * character in a `client_id`, configured and presented, so a `client_id` that
 * could split this key never reaches this store. Written as an escape rather than
 * the byte, because a literal NUL in source is invisible to reviewers and editors
 * may mangle it.
 *
 * The character id is stringified, so `90000001` and `"90000001"` are one
 * subject. Otherwise a caller passing the id as a number on one path and a string
 * on another would get two subjects for one character and two full sets of
 * grants, the per-subject cap quietly not applying. The record keeps whichever
 * type it was given (`recordProblem` accepts both); only the key is flattened.
 */
function subjectKey(characterId, clientId) {
  return `${characterId}\u0000${clientId}`;
}

/** Records are handed to callers and held across calls; nobody may edit one in place. */
function freezeRecord(record) {
  Object.freeze(record.scopes);
  return Object.freeze(record);
}

// Permissions, and what they are worth on each platform

/**
 * Pure core: a stat mode and a platform become zero or one warning strings.
 *
 * A near-duplicate of `lib/signingKey.js`'s, kept separate (see the D8 section in
 * the header). On POSIX the bits are real and this reports a store readable
 * beyond its owner. On Windows, the primary platform here, they are cosmetic:
 * Node maps a POSIX mode onto the read-only attribute and nothing else, and
 * `node:fs` cannot set an ACL, so nothing is reported rather than a warning about
 * a number that means nothing.
 *
 * A warning and never a refusal: a group-readable store still holds correct
 * grants, and taking SSO down over a permission bit trades a small exposure for a
 * total outage.
 */
function permissionWarningsFor(mode, platform, storePath) {
  if (platform === "win32") return [];
  if (typeof mode !== "number") return [];
  if ((mode & FORBIDDEN_PERMISSION_BITS) === 0) return [];
  return [
    `refresh token store ${storePath} is readable beyond its owner (mode `
    + `${(mode & 0o777).toString(8).padStart(3, "0")}); it should be 600.`,
  ];
}

// The filesystem half

/**
 * Read the store, or `null` when the file is simply not there yet.
 *
 * Absent is the first-run state and not an error. Anything else (a directory
 * where the file should be, a permission denial, an I/O failure) is a refusal,
 * for the reason a corrupt file is: the mod cannot tell those from "someone is
 * mid-restore", and starting empty over them is the silent-reset disaster with a
 * different `errno`.
 */
function readStoreText(fs, storePath) {
  try {
    return fs.readFileSync(storePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw new RefreshTokenStoreError(
      `the refresh token store at ${storePath} exists but could not be read `
      + `(${err && err.code ? err.code : "unknown error"}). `
      + "Fix the file or its permissions; this mod will not start fresh over it.",
      storePath,
    );
  }
}

/**
 * Write the whole store: temp file, `fsync`, `rename`.
 *
 * The rename makes this atomic (POSIX and Windows both replace the target in one
 * step), so a crash leaves either the complete old file or the complete new one.
 * That is why `parseStore` can be strict: there is no benign half-written state
 * to forgive.
 *
 * The temp file is created with `"wx"` and the mode in the `open` call, so it is
 * never briefly world-readable and never reuses somebody else's leftover. It
 * carries the pid and six random bytes so a leftover from a crashed process does
 * not block the next write.
 *
 * The `fsync` is before the rename: without it the rename can be durable while
 * the bytes are not, which loses every grant rather than the last one. The
 * directory itself is not synced, so the rename's durability is whatever the
 * filesystem gives it; `node:fs` has no portable way to do better on this mod's
 * primary platform.
 *
 * Throws on any failure. The callers catch and roll back; see
 * `ISSUE_FAILURE.PERSIST`.
 */
function writeStoreFile(fs, storePath, text) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true, mode: STORE_DIR_MODE });

  const tempPath = `${storePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tempPath, "wx", STORE_FILE_MODE);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, storePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        // Nothing useful to do with a failed close on a write that already
        // failed, and the unlink below is what actually matters.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch (_) {
      // The temp file may never have been created. Either way its absence is
      // the goal, so a failure to remove it is not worth reporting over the
      // error that actually stopped the write.
    }
    throw err;
  }
}

/** Thin wrapper: stat the file, then ask the pure core what to say about it. */
function permissionsAudit(fs, storePath, platform) {
  if (platform === "win32") return [];
  try {
    return permissionWarningsFor(fs.statSync(storePath).mode, platform, storePath);
  } catch (_) {
    // A stat that fails on a file we have just read is not worth failing a
    // startup over, and it says nothing about whether the store works.
    return [];
  }
}

// The store

/**
 * Build the refresh token store. Loads the file, or starts empty on first run.
 *
 * `storePath` is required and absolute. The caller resolves it from
 * `lib/runtimeAccess.js`'s `getRefreshTokenStorePath()`, which answers
 * `{ path, reason }` so that "no store path could be resolved" arrives with its
 * explanation. This module does not reach for it: taking the path as an argument
 * makes it testable against a temp directory, and `runtimeAccess` is the only
 * module allowed to ask the game where anything lives.
 *
 * `now` is required and has no default, for `lib/authCodes.js`'s reason: a
 * silent `Date.now()` would let a test pass that never injected a clock, and a
 * thirty-day horizon has to be arithmetic.
 *
 * `fs`, `platform` and `generateToken` are injection seams with real defaults, so
 * the one-argument call is the real thing and a test can drive a failed write, a
 * collision or a POSIX permission warning on a machine that has none of them.
 *
 * `log(message)` matches `loader.js`'s logger: one string, no levels. It receives
 * paths, counts and token fingerprints (the first twelve hex characters of the
 * stored hash) and never a token.
 *
 * Throws `RefreshTokenStoreError` when the file cannot be used or the options are
 * impossible. Nothing after construction throws.
 */
function createRefreshTokenStore(options = {}) {
  const {
    storePath,
    now,
    generateToken = defaultGenerateToken,
    fs = nodeFs,
    platform = process.platform,
    log = null,
    maxRecords = DEFAULT_MAX_RECORDS,
    maxPerSubject = DEFAULT_MAX_PER_SUBJECT,
    retentionMs = DEFAULT_RETENTION_MS,
    maxRetired = maxRecords,
  } = options;

  if (typeof storePath !== "string" || storePath.trim() === "") {
    throw new RefreshTokenStoreError(
      "createRefreshTokenStore needs an absolute storePath: the caller resolves it from "
      + "runtimeAccess.getRefreshTokenStorePath().",
      null,
    );
  }
  if (typeof now !== "function") {
    throw new RefreshTokenStoreError(
      "createRefreshTokenStore needs a now() returning epoch milliseconds. It is required "
      + "rather than defaulted so that no caller, and no test, can end up depending on a "
      + "clock it did not choose.",
      null,
    );
  }
  if (typeof generateToken !== "function") {
    throw new RefreshTokenStoreError(
      "createRefreshTokenStore's generateToken must be a function.",
      null,
    );
  }
  assertPositiveInteger(maxRecords, "maxRecords");
  assertPositiveInteger(maxPerSubject, "maxPerSubject");
  assertPositiveInteger(retentionMs, "retentionMs");
  assertPositiveInteger(maxRetired, "maxRetired");

  const resolved = path.resolve(storePath);
  const emit = typeof log === "function" ? log : () => {};

  /** tokenHash -> record. Every record here is `LIVE`. */
  const live = new Map();

  /**
   * tokenHash -> record, in retirement order.
   *
   * Every record is held for the same `retentionMs` from its own `retiredAt`, so
   * insertion order is also expiry order, which makes the prune a prefix scan
   * rather than a full one.
   */
  const retired = new Map();

  /** subjectKey -> Set of tokenHash, so the per-subject cap is not a scan. */
  const bySubject = new Map();

  load();

  // Loading

  function load() {
    const text = readStoreText(fs, resolved);
    if (text === null) {
      emit(`refresh token store ${resolved} does not exist yet; starting empty.`);
      return;
    }

    const records = parseStore(text, resolved);
    const at = clockReading();

    let pruned = 0;
    for (const record of records) {
      if (record.state === RECORD_STATE.LIVE) {
        live.set(record.tokenHash, record);
        subjectSet(record).add(record.tokenHash);
        continue;
      }
      // Pruned in memory rather than rewritten: a load that writes is a load
      // that can damage the file it has just accepted, and the next mutation
      // rewrites it anyway. A store nobody touches keeps stale bytes on disk,
      // which costs nothing and cannot be mistaken for a live grant.
      if (at - record.retiredAt >= retentionMs) {
        pruned += 1;
        continue;
      }
      retired.set(record.tokenHash, record);
    }

    for (const warning of permissionsAudit(fs, resolved, platform)) emit(warning);

    emit(
      `refresh token store loaded from ${resolved} (${live.size} live, ${retired.size} `
      + `retired${pruned > 0 ? `, ${pruned} aged out` : ""}).`,
    );
  }

  // Persistence

  /**
   * Serialise and write everything.
   *
   * Live records first, then retired in retirement order, which is the order
   * `load` needs them back in.
   */
  function persist(at) {
    writeStoreFile(fs, resolved, serializeStore([...live.values(), ...retired.values()], at));
  }

  // Pruning

  /**
   * Drop retired records that have outlived the retention window, and trim the
   * retired map to its cap.
   *
   * Called at the top of every mutation with one reading of the clock, so a single
   * call cannot see the store in two states. Returns whether anything changed,
   * because a prune that changed nothing must not trigger a write: a quiet store
   * costs nothing.
   */
  function prune(at) {
    let changed = false;

    for (const [hash, record] of retired) {
      if (at - record.retiredAt < retentionMs) break;
      retired.delete(hash);
      changed = true;
    }

    // Oldest first, which is insertion order. Safe in a way evicting a live
    // record is not: an evicted retired record downgrades a replay's answer from
    // `revoked` to `unknown`, and both are the same refusal on the wire.
    while (retired.size > maxRetired) {
      retired.delete(retired.keys().next().value);
      changed = true;
    }

    return changed;
  }

  // Subject bookkeeping

  function subjectSet(record) {
    const key = subjectKey(record.characterId, record.clientId);
    let set = bySubject.get(key);
    if (set === undefined) {
      set = new Set();
      bySubject.set(key, set);
    }
    return set;
  }

  /** Move a live record into the retired map, keeping every field it had. */
  function retire(record, state, at, reason) {
    live.delete(record.tokenHash);
    const set = bySubject.get(subjectKey(record.characterId, record.clientId));
    if (set !== undefined) {
      set.delete(record.tokenHash);
      if (set.size === 0) bySubject.delete(subjectKey(record.characterId, record.clientId));
    }
    const retiredRecord = freezeRecord({
      ...record,
      state,
      retiredAt: at,
      revokedReason: reason === undefined ? null : reason,
    });
    retired.set(record.tokenHash, retiredRecord);
    return retiredRecord;
  }

  /**
   * Make room for one more grant for this subject, retiring the least recently
   * used if the pair is already at its cap.
   *
   * Least recently used, not oldest issued: the token a client is actively
   * refreshing is the one it would notice losing, and `lastUsedAt` says so. That is
   * why `refresh` pays a write to keep it current across a restart.
   */
  function enforceSubjectCap(characterId, clientId, at) {
    const set = bySubject.get(subjectKey(characterId, clientId));
    if (set === undefined || set.size < maxPerSubject) return null;

    let victim = null;
    for (const hash of set) {
      const record = live.get(hash);
      if (record === undefined) continue;
      if (victim === null || record.lastUsedAt < victim.lastUsedAt) victim = record;
    }
    if (victim === null) return null;
    return retire(victim, RECORD_STATE.SUPERSEDED, at, null);
  }

  // issue

  function issue(request) {
    // Read rather than destructured with a default: a default only covers
    // `undefined`, and `issue(null)` would throw on the request path, where
    // eve.js treats a throw as fatal.
    const source = request !== null && typeof request === "object" ? request : {};
    const { characterId, clientId } = source;

    const subject = subjectProblem(characterId, clientId);
    if (subject !== null) {
      return Object.freeze({ token: null, failure: ISSUE_FAILURE.SUBJECT, detail: subject });
    }

    const at = clockReading();
    const prunedSomething = prune(at);

    if (live.size >= maxRecords) {
      return Object.freeze({ token: null, failure: ISSUE_FAILURE.AT_CAPACITY });
    }

    // Caught rather than allowed to propagate: `generateToken` is an injection
    // seam, and the promise this module makes is that nothing on the request
    // path throws. A generator that throws is the same class of programming
    // error as one that returns a number, so it gets the same answer.
    let token;
    try {
      token = generateToken();
    } catch (err) {
      emit(`refresh token generator threw (${describe(err)}); no token was issued.`);
      return Object.freeze({ token: null, failure: ISSUE_FAILURE.GENERATOR });
    }
    if (typeof token !== "string" || token === "") {
      return Object.freeze({ token: null, failure: ISSUE_FAILURE.GENERATOR });
    }

    const tokenHash = hashToken(token);
    if (live.has(tokenHash) || retired.has(tokenHash)) {
      return Object.freeze({ token: null, failure: ISSUE_FAILURE.COLLISION });
    }

    const scopes = normalizeScopes(source.scopes === undefined ? source.scope : source.scopes);

    const record = freezeRecord({
      tokenHash,
      state: RECORD_STATE.LIVE,
      characterId,
      clientId,
      scopes: scopes === null ? [] : scopes,
      issuedAt: at,
      lastUsedAt: at,
      refreshCount: 0,
      // The lineage. Constant across a rotation, if rotation is ever switched
      // on (D30); with rotation off there is exactly one record per family, and
      // that is the shape a future rotation would grow rather than replace.
      family: crypto.randomBytes(16).toString("hex"),
      // Always 0 today. See the header: this field is what makes turning
      // rotation on an edit in one place rather than a schema change.
      generation: 0,
      retiredAt: null,
      revokedReason: null,
    });

    const superseded = enforceSubjectCap(characterId, clientId, at);
    live.set(tokenHash, record);
    subjectSet(record).add(tokenHash);

    try {
      persist(at);
    } catch (err) {
      // Rolled back completely, including the supersession the cap just did:
      // a client must not lose a working token to a write that did not happen.
      // The store's memory and its file are either both new or both old.
      live.delete(tokenHash);
      const set = bySubject.get(subjectKey(characterId, clientId));
      if (set !== undefined) set.delete(tokenHash);
      if (superseded !== null) {
        retired.delete(superseded.tokenHash);
        const restored = freezeRecord({
          ...superseded,
          state: RECORD_STATE.LIVE,
          retiredAt: null,
          revokedReason: null,
        });
        live.set(restored.tokenHash, restored);
        subjectSet(restored).add(restored.tokenHash);
      }
      emit(
        `refresh token store could not be written (${describe(err)}); no token was issued `
        + `for character ${characterId} / client ${clientId}.`,
      );
      return Object.freeze({ token: null, failure: ISSUE_FAILURE.PERSIST, detail: describe(err) });
    }

    if (superseded !== null) {
      emit(
        `refresh token ${tokenFingerprint(superseded.tokenHash)} superseded: character `
        + `${characterId} / client ${clientId} reached ${maxPerSubject} live grants.`,
      );
    }
    if (prunedSomething) {
      emit(`refresh token store pruned aged-out records (${retired.size} kept).`);
    }

    return Object.freeze({ token, record });
  }

  // refresh

  /**
   * Present a refresh token. Does not rotate (D30): the same token comes back
   * valid, and what changes is `lastUsedAt` and `refreshCount`.
   *
   * The returned `scopes`/`scope` are what this refresh grants: the stored set, or
   * the narrowed subset the request asked for. The stored grant is never narrowed;
   * see the header.
   */
  function refresh(token, request) {
    const source = request !== null && typeof request === "object" ? request : {};
    const at = clockReading();
    prune(at);

    const found = lookup(token);
    if (found.outcome !== REFRESH_OUTCOME.OK) return found;

    const record = found.record;
    const requested = normalizeScopes(
      source.scopes === undefined ? source.scope : source.scopes,
    );

    // Absent and explicitly empty both mean "the same scopes as before": RFC 6749
    // section 6 treats an omitted scope that way, and an empty `scope=` is the same
    // statement.
    const narrowing = requested !== null && requested.length > 0;
    if (narrowing && !isSubsetOfScopes(requested, record.scopes)) {
      return Object.freeze({
        outcome: REFRESH_OUTCOME.SCOPE_NOT_SUBSET,
        record,
        scopes: null,
        scope: null,
      });
    }

    const granted = narrowing ? Object.freeze(requested) : record.scopes;

    const updated = freezeRecord({
      ...record,
      lastUsedAt: at,
      refreshCount: record.refreshCount + 1,
    });
    live.set(record.tokenHash, updated);

    try {
      persist(at);
    } catch (err) {
      // **Not** rolled back, and not a failure. Unlike `issue` and `revoke`,
      // nothing here needs the disk to be correct: the grant itself is already
      // on file and unchanged, and what failed to persist is bookkeeping:
      // `lastUsedAt` and a counter. Failing the refresh would take a working
      // client offline to protect a field nobody's access depends on. The
      // honest cost is that a restart can lose the update, which can make the
      // per-subject cap retire a slightly wrong record, and the log says so.
      emit(
        `refresh token store could not be written (${describe(err)}); the refresh for `
        + `${tokenFingerprint(record.tokenHash)} succeeded but its last-used time may not `
        + "survive a restart.",
      );
    }

    return Object.freeze({
      outcome: REFRESH_OUTCOME.OK,
      record: updated,
      scopes: granted,
      scope: scopeString(granted),
    });
  }

  // revoke

  /**
   * Revoke a token. The record stays, marked, so a later replay is `REVOKED` rather
   * than `UNKNOWN`, which lets a log distinguish a stolen token coming back from a
   * stranger knocking.
   */
  function revoke(token, request) {
    const source = request !== null && typeof request === "object" ? request : {};
    const at = clockReading();
    prune(at);

    const found = lookup(token);
    if (found.outcome === REFRESH_OUTCOME.REVOKED) {
      return Object.freeze({ outcome: REVOKE_OUTCOME.ALREADY_REVOKED, record: found.record });
    }
    if (found.outcome === REFRESH_OUTCOME.SUPERSEDED) {
      return Object.freeze({ outcome: REVOKE_OUTCOME.SUPERSEDED, record: found.record });
    }
    if (found.outcome === REFRESH_OUTCOME.UNKNOWN) {
      return Object.freeze({ outcome: REVOKE_OUTCOME.UNKNOWN, record: null });
    }

    const record = found.record;
    const reason = typeof source.reason === "string" && source.reason !== ""
      ? source.reason
      : null;
    const revoked = retire(record, RECORD_STATE.REVOKED, at, reason);

    try {
      persist(at);
    } catch (err) {
      // Rolled back, and the sharpest of the three cases: a revocation that only exists
      // in this process's heap comes back to life at the next restart, so an operator
      // who was told "revoked" would hold a token that still works. The revoke route
      // must not answer 200 to this.
      retired.delete(revoked.tokenHash);
      live.set(record.tokenHash, record);
      subjectSet(record).add(record.tokenHash);
      emit(
        `refresh token store could not be written (${describe(err)}); token `
        + `${tokenFingerprint(record.tokenHash)} was NOT revoked.`,
      );
      return Object.freeze({ outcome: REVOKE_OUTCOME.PERSIST_FAILED, record: null });
    }

    emit(
      `refresh token ${tokenFingerprint(record.tokenHash)} revoked for character `
      + `${record.characterId} / client ${record.clientId}`
      + `${reason === null ? "" : ` (${reason})`}.`,
    );
    return Object.freeze({ outcome: REVOKE_OUTCOME.OK, record: revoked });
  }

  // revokeFamily

  /**
   * Revoke every live grant in one family (D40).
   *
   * This is `family`'s first reader. D30 laid the field down for a rotation that is
   * still switched off. An authorization code replayed against
   * `POST /v2/oauth/token` means the code leaked, and the tokens already minted
   * from it are as compromised as the code. Refusing the replay and leaving them
   * alive would answer the request and not the incident. The family is the only
   * handle: the caller detecting the replay holds a used authorization code, not a
   * refresh token, so it can name the lineage and not the string.
   *
   * A scan over `live`, not a `byFamily` index. `live` is capped at
   * `DEFAULT_MAX_RECORDS` (4,096), so the worst case is four thousand `===`
   * comparisons on a path that runs when somebody has replayed a code, which on a
   * private server is approximately never. `bySubject` is already maintained in
   * five places (`load`, `issue`, `retire`, and the rollback paths in `issue` and
   * `revoke`); a second index means the same five, and missing one makes the store
   * wrong silently, not slow. A scan reads the thing it asks about and cannot go
   * stale. If rotation is switched on and a family grows past one record, that
   * changes the size of the answer, not of the search.
   *
   * Nothing is coerced. `family` is compared with `===` against the exact string,
   * the discipline `characterId` gets. A caller that hands over the wrong shape
   * gets `UNKNOWN`, as for a family that has aged out.
   *
   * `UNKNOWN` is the ordinary answer, not a fault. After a restart the
   * authorization code store is empty and this one is not, so the usual case is a
   * replay this process has no memory of, answered by a quiet no-op. It is also what
   * a caller sees for a family whose records were all revoked or superseded, because
   * only `live` records are eligible and re-retiring a dead one would move its
   * `retiredAt` and lose when it actually died. Nothing here throws; the token
   * route must never see a throw from this.
   */
  function revokeFamily(family, request) {
    const source = request !== null && typeof request === "object" ? request : {};
    const at = clockReading();
    prune(at);

    // Defended the way `lookup` defends `token`: whatever the caller extracted
    // from a used authorization code arrives here unvalidated.
    if (typeof family !== "string" || family === "") {
      return Object.freeze({ outcome: REVOKE_OUTCOME.UNKNOWN, records: NO_RECORDS });
    }

    const matched = [];
    for (const record of live.values()) {
      if (record.family === family) matched.push(record);
    }
    if (matched.length === 0) {
      return Object.freeze({ outcome: REVOKE_OUTCOME.UNKNOWN, records: NO_RECORDS });
    }

    const reason = typeof source.reason === "string" && source.reason !== ""
      ? source.reason
      : null;
    // Collected before the write, so a failure has one list to undo. `retire`
    // is the single lifecycle transition, so these records leave `live` and
    // drain out of `bySubject` exactly as a one-token revocation does.
    const revoked = matched.map((record) => retire(record, RECORD_STATE.REVOKED, at, reason));

    try {
      // Once for the batch, not once per record. Each `persist` rewrites the
      // whole file, so a per-record write would be n rewrites of the same
      // bytes, and a failure halfway through would leave a file that agrees
      // with neither the state before nor the state after.
      persist(at);
    } catch (err) {
      // Rolled back completely, for `revoke`'s reason and one more: a partial
      // rollback is worse than none. It would leave the store believing some of
      // a compromised family is dead when the file says all of it is alive, and
      // the next restart would resurrect exactly the records nobody is watching
      // any more.
      for (const dead of revoked) retired.delete(dead.tokenHash);
      for (const record of matched) {
        live.set(record.tokenHash, record);
        subjectSet(record).add(record.tokenHash);
      }
      const subject = matched.length === 1 ? "grant was" : "grants were";
      emit(
        `refresh token store could not be written (${describe(err)}); ${matched.length} `
        + `${subject} NOT revoked in that family.`,
      );
      return Object.freeze({ outcome: REVOKE_OUTCOME.PERSIST_FAILED, records: NO_RECORDS });
    }

    emit(
      `refresh token family revoked: ${revoked.length} grant`
      + `${revoked.length === 1 ? "" : "s"} `
      + `(${revoked.map((dead) => tokenFingerprint(dead.tokenHash)).join(", ")})`
      + `${reason === null ? "" : ` (${reason})`}.`,
    );
    return Object.freeze({ outcome: REVOKE_OUTCOME.OK, records: Object.freeze(revoked) });
  }

  // Lookup

  /**
   * The token, as an outcome. Shared by `refresh`, `revoke` and `inspect`, so the
   * three cannot disagree about what a token is.
   *
   * A non-string is `UNKNOWN` rather than an error: the `refresh_token` parameter
   * is whatever arrived in a form body, and shaping the answer around that is the
   * token route's job.
   */
  function lookup(token) {
    if (typeof token !== "string" || token === "") {
      return Object.freeze({ outcome: REFRESH_OUTCOME.UNKNOWN, record: null });
    }

    const tokenHash = hashToken(token);

    const record = live.get(tokenHash);
    if (record !== undefined) {
      return Object.freeze({ outcome: REFRESH_OUTCOME.OK, record });
    }

    const dead = retired.get(tokenHash);
    if (dead !== undefined) {
      return Object.freeze({
        outcome: dead.state === RECORD_STATE.REVOKED
          ? REFRESH_OUTCOME.REVOKED
          : REFRESH_OUTCOME.SUPERSEDED,
        record: dead,
      });
    }

    return Object.freeze({ outcome: REFRESH_OUTCOME.UNKNOWN, record: null });
  }

  // The clock, defended

  /**
   * The same defence `lib/authCodes.js` puts around its clock: a `now` returning a
   * non-number would poison every `issuedAt` and `retiredAt` with `NaN`, which
   * compares false against everything, so nothing would age out and the prune would
   * silently stop working.
   */
  function clockReading() {
    const at = Number(now());
    return Number.isFinite(at) ? at : Date.now();
  }

  return Object.freeze({
    issue,
    refresh,
    revoke,
    revokeFamily,

    /**
     * What this token is, without touching it.
     *
     * For the revoke route, which has to decide whether it may revoke, and for a log
     * line that wants to say what it saw. Does not prune and does not write, so it is
     * safe to call from anywhere.
     */
    inspect(token) {
      return lookup(token);
    },

    /** Where the store is. Reported by whoever starts SSO, and used by tests. */
    path: resolved,

    /**
     * How many live grants are held.
     *
     * Retired records are not live and are not counted; `retiredCount()` is the
     * other half. Neither prunes (that is what "lazy" means): a store nobody has
     * touched still holds what aged out while nothing was happening, and drops it on
     * the next mutation.
     */
    size() {
      return live.size;
    },

    retiredCount() {
      return retired.size;
    },
  });
}

// Small shared pieces

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RefreshTokenStoreError(
      `createRefreshTokenStore's ${name} must be a positive integer, got `
      + `${JSON.stringify(value)}.`,
      null,
    );
  }
}

/** An error as one short safe string. Never carries a token: errors here are I/O. */
function describe(err) {
  if (err && err.code) return err.code;
  return err && err.message ? err.message : String(err);
}

module.exports = Object.freeze({
  TOKEN_BYTES,
  STORE_FORMAT_VERSION,
  STORE_KIND,
  STORE_FILE_MODE,
  STORE_DIR_MODE,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_PER_SUBJECT,
  DEFAULT_RETENTION_MS,
  RECORD_MEMBERS,
  RECORD_STATE,
  ISSUE_FAILURE,
  REFRESH_OUTCOME,
  REVOKE_OUTCOME,
  RefreshTokenStoreError,

  createRefreshTokenStore,

  defaultGenerateToken,
  hashToken,
  normalizeScopes,
  scopeString,
  isSubsetOfScopes,
  serializeStore,
  parseStore,
  permissionWarningsFor,
});
