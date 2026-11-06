/**
 * eve.js-mod-esi: session identity (D3).
 *
 * The reason the in-game bind command exists. This replica was written against EVE SSO, where a
 * character is something the browser can prove. eve.js has no SSO, so on this server character
 * identity is something the mod asserts (D3). The only place that knows, first-hand and
 * unforgeably, which character typed a line of chat is the game session behind the macho call;
 * this module turns that session into the tuple an access token is minted from.
 *
 * `Handle_SlashCmd(args, session, kwargs)` hands the session straight to us. A browser can lie
 * about being character 90000001; it cannot type into that character's chat window. That is the
 * security argument for the whole authorization-code grant, and every rule below serves it.
 *
 * Everything here is a pure function of a plain object. No game code: the session is injected,
 * so `test/sessionIdentity.test.js` exercises every branch against fakes.
 */

"use strict";

// Why the session fields are read through alias lists.
// The server is not consistent about these names and both spellings are
// live. Counted across `server/src` as `session.<name>` on 2026-08-24:
// characterID 1046, charid 300, userid 116, userID 30, role 23,
// rolesAtAll 23, accountRole 11. Reading only the canonical spelling would
// work for most sessions and silently fail for the rest, the worst failure
// mode for an identity check: the player types a valid code, is told they
// have no character selected, and nothing in any log explains why.
//
// Order is precedence, and it is the game's own: `accountRole` before `role`
// because the sessions that carry both carry the authoritative value in the
// first. `test/sessionIdentity.test.js` has a vendor-gated check that every
// spelling in these lists still appears upstream; it cannot notice a new
// spelling appearing, which is stated there.
const CHARACTER_ID_KEYS = Object.freeze(["characterID", "charid"]);
const ACCOUNT_ID_KEYS = Object.freeze(["userid", "userID"]);
const ROLE_KEYS = Object.freeze(["accountRole", "role", "rolesAtAll"]);

// Why the failures are named.
// The command handler turns each of these into different words for the
// player. "You are not logged in" and "you have no character selected" are
// different problems with different fixes, and a player staring at a browser
// that will not advance needs to be told which one they have.
const IDENTITY_FAILURE = Object.freeze({
  NO_SESSION: "NO_SESSION",
  NO_CHARACTER: "NO_CHARACTER",
});

// GM role bits.
// Copied, deliberately, rather than required from
// `services/account/accountRoleProfiles.js`. Only `lib/runtimeAccess.js` may
// require game code, and these are protocol constants: the bit values are
// fixed by the client, not by this server's source layout, so a copy cannot
// drift the way a code path can. The vendor-gated test reads that file as
// text and asserts the ten literals still agree, the same arrangement
// `lib/rateLimiter.js` has with `contract/openapi.json`.
//
// The set mirrors that file's ROLEMASK_VIEW (the mask it uses to decide who
// is staff) plus ROLE_GMS. `isGM` is advisory: it rides along in the claim so
// a token's scopes can reflect it, and it gates nothing on the game server.
const GM_ROLE_BITS = Object.freeze({
  ROLE_GMS: 274877906944n,
  ROLE_EXT_GM1: 70368744177664n,
  ROLE_EXT_GM2: 140737488355328n,
  ROLE_EXT_GM3: 281474976710656n,
  ROLE_EXT_GM4: 562949953421312n,
  ROLE_QA: 4503599627370496n,
  ROLE_GMH: 9007199254740992n,
  ROLE_GML: 18014398509481984n,
  ROLE_CONTENT: 36028797018963968n,
  ROLE_ADMIN: 72057594037927936n,
});

const GM_ROLE_MASK = Object.values(GM_ROLE_BITS).reduce(
  (mask, bit) => mask | bit,
  0n,
);

// Reading a field off a session.
// Own properties only, the same discipline `lib/exportProbe.js` enforces for
// game exports. A session is a plain object and is never the
// circular-dependency warning proxy, so this is not the proxy defence; it is
// the narrower claim that a prototype supplying a `characterID` is not a
// session that has one. Cheap, and worth more with no exceptions.
function readOwn(source, key) {
  if (source === null || typeof source !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(source, key)) return undefined;
  return source[key];
}

function readFirstOwn(source, keys) {
  for (const key of keys) {
    const value = readOwn(source, key);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

// Numeric IDs.
// The session carries these as numbers, but the odd code path stringifies
// them. Anything that is not a positive integer is treated as absent: a
// characterID of 0, NaN or an empty string is not a character, and minting a
// token for "character 0" would be worse than refusing.
function toPositiveInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const truncated = Math.trunc(number);
  return truncated > 0 ? truncated : null;
}

// Role masks.
// Roles are 64-bit masks, so they exceed Number's exact-integer range and
// arrive as BigInt, Number or a decimal string depending on where they came
// from (`chatCommands` assigns `session.role = roleToString(...)`). Anything
// unparseable is 0n ("no roles"), never a throw. An identity check that can
// throw on a malformed session takes the command down, and design
// constraint 2 does not distinguish the mod crashing from the mod crashing
// politely.
function toRoleMask(value) {
  try {
    if (typeof value === "bigint") return value >= 0n ? value : 0n;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0) return 0n;
      return BigInt(Math.trunc(value));
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      return /^[0-9]+$/.test(trimmed) ? BigInt(trimmed) : 0n;
    }
  } catch (_) {
    // BigInt() is the only thing here that can throw, and only on input this
    // function has already filtered. Belt and braces.
  }
  return 0n;
}

function isGMRoleMask(roleMask) {
  return (roleMask & GM_ROLE_MASK) !== 0n;
}

// The extraction.
// Returns a discriminated result rather than throwing or returning null, so
// the caller can say something specific to the player.
//
//   { ok: true,  identity: { characterID, accountID, role, isGM } }
//   { ok: false, reason: IDENTITY_FAILURE.* }
//
// `role` is the decimal string form of the mask, not a BigInt: this object is
// destined for a JSON body and eventually for a JWT claim set, and
// `JSON.stringify` throws on BigInt. The identity is frozen because it is
// the load-bearing claim in the whole grant: nothing downstream gets to
// rewrite which character was proved.
function extractSessionIdentity(session) {
  if (session === null || typeof session !== "object") {
    return { ok: false, reason: IDENTITY_FAILURE.NO_SESSION };
  }

  const characterID = toPositiveInteger(readFirstOwn(session, CHARACTER_ID_KEYS));
  if (characterID === null) {
    // Logged in to an account but sitting on character selection.  There is
    // nothing to bind yet.
    return { ok: false, reason: IDENTITY_FAILURE.NO_CHARACTER };
  }

  // The account may legitimately be missing on an odd session; a character
  // without a resolvable account is still bindable, and the token layer can
  // decide what to do about a null accountID. Only the character is
  // mandatory, because only the character is what the token is about.
  const accountID = toPositiveInteger(readFirstOwn(session, ACCOUNT_ID_KEYS));
  const roleMask = toRoleMask(readFirstOwn(session, ROLE_KEYS));

  return {
    ok: true,
    identity: Object.freeze({
      characterID,
      accountID,
      role: roleMask.toString(),
      isGM: isGMRoleMask(roleMask),
    }),
  };
}

// Log rendering.
// The one approved way to put an identity in a log line. It is deliberately
// incapable of carrying a bind code, because it never sees one: the property
// is structural rather than a rule somebody has to remember.
function describeIdentity(identity) {
  if (identity === null || typeof identity !== "object") return "char=? account=?";
  const account =
    identity.accountID === null || identity.accountID === undefined
      ? "?"
      : identity.accountID;
  return `char=${identity.characterID} account=${account} gm=${identity.isGM ? "yes" : "no"}`;
}

module.exports = Object.freeze({
  ACCOUNT_ID_KEYS,
  CHARACTER_ID_KEYS,
  GM_ROLE_BITS,
  GM_ROLE_MASK,
  IDENTITY_FAILURE,
  ROLE_KEYS,

  describeIdentity,
  extractSessionIdentity,
  isGMRoleMask,
  toPositiveInteger,
  toRoleMask,
});
