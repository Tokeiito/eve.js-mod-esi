/**
 * `GET /v2/oauth/verify`, and `GET /oauth/verify`, the same endpoint under the
 * name every pre-JWT tool in this ecosystem still calls it by.
 *
 * It answers "whose token is this?":
 *
 *   {"CharacterID":90000001,"CharacterName":"Some Bloke",
 *    "ExpiresOn":"2026-08-24T14:34:16","Scopes":"publicData esi-skills.read_skills.v1",
 *    "TokenType":"Character","CharacterOwnerHash":"8PmzCeTKb4VFUDrHLc/AeZXDSWM=",
 *    "IntellectualProperty":"EVE"}
 *
 * It reads a token and issues nothing. There is no store to consume from, no
 * credential to mint, no clock and no client to authenticate: the bearer token
 * is the request, `lib/bearerToken.js` decides whether it is good, and this file
 * projects the claims it returns into seven members with CCP's spelling. The
 * route has no independent opinion about validity: it does not re-check `exp`,
 * re-parse `sub` or consult the refresh token store. A second opinion could only
 * disagree with the verifier's, making this endpoint accept a token every other
 * endpoint refuses.
 *
 * The audience is not judged here. `lib/bearerToken.js` projects `audience` and
 * judges it by nothing, and this route reads neither `audience` nor `clientId`.
 * The question is whose token this is, not whether it was minted for the
 * caller: a tool holding a token issued to another client and asking which
 * character it belongs to is asking something with a true answer. The `aud`
 * check belongs to a protected resource deciding whether to act on a token.
 *
 * What the verifier guarantees, so this file does not repeat it: `verify` never
 * throws on any input (a fuzz test in its suite asserts it), so there is no
 * defensive `try`/`catch` and a malformed `Authorization` header cannot become a
 * `500`. `fromHeader` answers `null` for a missing header, a wrong scheme and a
 * malformed one alike, which is the case the `401` wants: no credential was
 * presented. `verify` also refuses a token whose `sub`, `name` or `owner` is
 * unusable, so the `500` branches below are backstops, not live paths. They
 * exist because the route is written against an interface, and a double or a
 * later version projecting a claim differently should produce a logged `500`
 * rather than a body with `undefined` in it.
 *
 * PascalCase is deliberate. `CharacterID`, not `character_id` or `CharacterId`:
 * this endpoint predates the snake_case convention `lib/serialize.js` keeps, and
 * every tool written against it indexes the parsed object by these exact
 * strings (design constraint 3).
 *
 * `contract/sso.js` `VERIFY_MEMBER_ORDER` is the authority for the names and
 * their order. As in `routes/oauthToken.js` it is not imported: `contract/` is
 * test-only and never deployed (`lib/sourceHash.js` `HASHED_DIRS` is `["lib",
 * "routes"]`), so a route requiring it would pass the suite and then throw
 * `MODULE_NOT_FOUND` inside the game process. `test/verifyContract.test.js`
 * asserts the copies against their authority.
 *
 * The `401` is `text/html`. Without a bearer token, real CCP answers `401` with
 * `Content-Type: text/html`, not JSON, and `routes/oauthToken.js` notes this is
 * "the only SSO endpoint that answers in JSON errors". The content type is
 * CCP's. The body is not: nothing records what bytes sit behind that header, so
 * `UNAUTHORIZED_BODY` is ours, marked as ours, and `contract/sso.js`
 * `UNOBSERVED.verifyRefusalBody` names the `curl` that would replace it (a
 * request that needs no credentials).
 *
 * The body must not say why. One document serves a missing header, a malformed
 * token and an expired one, byte for byte, for `routes/oauthToken.js`'s reason:
 * a refusal that varies with the cause is an oracle about token shape ("that
 * parsed but expired" tells a forger the forgery was structurally right). The
 * distinction is kept in the log.
 *
 * `createOauthVerifyRoute({bearer, now, log})`. This file requires no mod module
 * (not `../config`, not `lib/bearerToken.js`, not `contract/sso.js`), so
 * `test/verifyContract.test.js` drives it with object literals and one double,
 * with no listener, signing key or game.
 */

"use strict";

// The two paths (contract/sso.js is the authority)

/**
 * `contract/sso.js` `VERIFY_PATHS`.
 *
 * Two spellings, one handler. `/v2/oauth/verify` is what the discovery document
 * advertises as `userinfo_endpoint`; `/oauth/verify` is a still-live legacy alias
 * and is not under `/v2/`, the same shape `/oauth/jwks` has. A route table
 * written by pattern ("the SSO endpoints are `/v2/oauth/*`") would mount only
 * the first, and every tool written before CCP's JWT migration would get a
 * `404`.
 *
 * `lib/ssoDispatch.js` exact-matches both and normalizes nothing, so this is
 * two entries rather than a prefix. CCP's current spelling is first.
 */
const VERIFY_PATHS = Object.freeze(["/v2/oauth/verify", "/oauth/verify"]);

// Request shape

/**
 * `GET` and `HEAD`. Not `OPTIONS`, and not anything that writes.
 *
 * `HEAD` is answered. `routes/oauthAuthorize.js` and `routes/oauthToken.js`
 * refuse it because a request to either does something (mints a bind code,
 * redeems a one-time code), so `HEAD` would mean "do all of that and discard the
 * result", and a monitoring probe on the token endpoint would burn a real
 * client's authorization code. Here nothing is done: this is a read of the
 * caller's own token, and RFC 9110 section 9.3.2 defines `HEAD` as that read
 * with the body dropped. It runs the `GET` and lets Node's `ServerResponse`
 * suppress the body, as `routes/oauthJwks.js` does, so the two methods cannot
 * disagree about headers.
 *
 * A `HEAD` reveals `content-length`, which varies with the character's name and
 * scope list. That is not a leak: reading it requires a token that would have
 * answered the `GET` in full.
 *
 * `OPTIONS` is refused rather than answered as a CORS preflight, following
 * `routes/oauthToken.js`. A JWKS is public bytes meant to be readable by a
 * browser-based validator; this response is a named character's identity, and
 * answering a preflight would advertise that a cross-origin page may hold an
 * access token and read a character out of it. Whether CCP sends CORS headers
 * here is unobserved, so the choice is ours, in the direction that can be
 * loosened later on evidence.
 */
const ALLOWED_METHODS = Object.freeze(["GET", "HEAD"]);
const ALLOW = ALLOWED_METHODS.join(", ");

// Response shape

/**
 * `contract/sso.js` `VERIFY_MEMBER_ORDER`, duplicated for the reason in the
 * header, and built from an array rather than written as an object literal.
 *
 * A literal in the right order produces identical bytes until somebody sorts it
 * for readability (the argument of `routes/oauthJwks.js` and
 * `routes/oauthToken.js`). Member order is irrelevant to JSON parsers and
 * observable to a client comparing against a recorded fixture.
 *
 * All seven names are alphabetic, so none can trip the integer-key reordering
 * that makes insertion order stop being output order.
 */
const MEMBER_ORDER = Object.freeze([
  "CharacterID",
  "CharacterName",
  "ExpiresOn",
  "Scopes",
  "TokenType",
  "CharacterOwnerHash",
  "IntellectualProperty",
]);

/**
 * `contract/sso.js` `VERIFY_CONSTANT_MEMBERS.TokenType`, and it is not `Bearer`.
 *
 * `token_type` in a token response is the HTTP authentication scheme
 * (`routes/oauthToken.js` `TOKEN_TYPE`, capital `B`, string-compared by several
 * clients). `TokenType` here says which of CCP's subject namespaces the token
 * identifies. `contract/sso.js` `ACCESS_TOKEN_SUBJECT_PREFIX` is `CHARACTER:EVE:`
 * and notes "CCP issues tokens for subjects that are not characters"; D3 makes
 * the in-game session the only source of identity here, so `Character` is the
 * only namespace this replica issues into.
 *
 * Marked inferred in `contract/sso.js` `VERIFY_MEMBER_PROVENANCE`: the namespace
 * is sourced, the initial-capital singular spelling is the guess.
 *
 * The wrong constant here yields a body that parses and describes a character as
 * an authentication scheme.
 */
const TOKEN_TYPE = "Character";

/**
 * `contract/sso.js` `VERIFY_CONSTANT_MEMBERS.IntellectualProperty`, the thinnest
 * value on this surface.
 *
 * Marked ours: nothing in this repository sources it. It is `EVE` for
 * consistency with `ACCESS_TOKEN_AUDIENCE_LITERAL` (`EVE Online`) and the
 * subject prefix's second segment (`EVE`), which is not evidence.
 * `contract/sso.js` `UNOBSERVED.verifyMemberValues` names the request that
 * settles it, and changing it costs one string.
 */
const INTELLECTUAL_PROPERTY = "EVE";

/**
 * `Scopes` is a space-delimited string, the opposite of the choice `scp` made in
 * the token this endpoint reads.
 *
 * `lib/accessToken.js` emits `scp` as an array at every scope count, because JWT
 * consumers that survive a two-scope token handle the array and the string
 * branch produces `scopes.map is not a function`. That argument is about a new
 * surface. This body is the old surface, whose consumers were written against
 * RFC 6749 section 3.3's `scope`, space-delimited by definition (`contract/sso.js`
 * `VERIFY_SCOPES`). It is also the shape the client sent to
 * `routes/oauthAuthorize.js`, and what a tool feeding `Scopes` into its next
 * authorization request needs.
 *
 * Zero scopes is `""`: present and empty, never `null` and never absent, so the
 * member set does not depend on content.
 */
const SCOPE_DELIMITER = " ";

/**
 * Bare `application/json`, matching `routes/oauthJwks.js` and
 * `routes/oauthToken.js`.
 *
 * `contract/sso.js` `UNOBSERVED.contentType` records that no `content-type` has
 * been captured off `login.eveonline.com` for anything, so this is ours. It is
 * not borrowed from `contract/wire.js`, whose three JSON spellings are facts
 * about `esi.evetech.net`'s two producers.
 */
const CONTENT_TYPE_JSON = "application/json";

/**
 * `contract/sso.js` `REFUSAL_CONTENT_TYPE`, the one wire fact recorded about
 * this endpoint.
 *
 * The bare media type, with no `charset`: the observation names a content type
 * and no parameter, and `routes/oauthAuthorize.js`'s `text/html; charset=utf-8`
 * is that route's own choice. The bodies below are ASCII, so every charset a
 * sniffer could pick decodes them identically, and `nosniff` closes the
 * remaining question.
 */
const CONTENT_TYPE_HTML = "text/html";

/**
 * `no-store`.
 *
 * This response names a character and is valid only for the token that fetched
 * it; a shared cache would serve one player's identity to the next caller. The
 * refusals carry it too, since a cached `401` outlives the expired token that
 * caused it and the client's refresh then looks broken.
 *
 * `routes/oauthToken.js` sends `no-store,no-cache` plus a `Pragma`, which is the
 * recorded pair for the token endpoint. Nothing records a cache header here, so
 * this is the single directive that says what is meant.
 */
const CACHE_CONTROL = "no-store";

/**
 * The challenge on a `401`, naming `Bearer` and carrying nothing else.
 *
 * RFC 9110 section 15.5.2 makes `WWW-Authenticate` mandatory on a `401`. RFC
 * 6750 section 3 defines the scheme's parameters and none is used:
 * `error="invalid_token"` and `error_description` would put the why back in the
 * response, beside a body deliberately made not to say it.
 *
 * `Basic` would be wrong: this endpoint has no Basic path, and naming a scheme
 * not implemented invites a stack to retry down it.
 */
const WWW_AUTHENTICATE = 'Bearer realm="EVE SSO"';

/**
 * The `401` body: ours, byte-identical for every cause, and saying nothing.
 *
 * A minimal document rather than an empty one, since a `text/html` content type
 * describing zero bytes is a claim about a body that does not exist. "401
 * Unauthorized" is RFC 9110's name for the status the caller already received,
 * so it adds no fact.
 *
 * A frozen constant so byte identity across three refusal paths is a property of
 * one string, as with `routes/oauthToken.js` `INVALID_CODE_DESCRIPTION` and
 * `routes/oauthAuthorize.js` `EXPIRED_PAYLOAD`.
 */
const UNAUTHORIZED_BODY = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">',
  "<title>401 Unauthorized</title>",
  "</head>",
  "<body>",
  "<h1>401 Unauthorized</h1>",
  "</body>",
  "</html>",
  "",
].join("\n");

/**
 * The `405` body. Same shape; it may name the status because the method is the
 * caller's own choice and `Allow` says the same in a header a client can act on.
 */
const METHOD_NOT_ALLOWED_BODY = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">',
  "<title>405 Method Not Allowed</title>",
  "</head>",
  "<body>",
  "<h1>405 Method Not Allowed</h1>",
  `<p>This endpoint answers ${ALLOW}.</p>`,
  "</body>",
  "</html>",
  "",
].join("\n");

/**
 * The `500` body, for a token that verified and then could not be projected.
 *
 * As mute as the `401`, even though the fault is ours: the specifics go to the
 * log. What a caller needs is that retrying will not help.
 */
const SERVER_ERROR_BODY = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">',
  "<title>500 Internal Server Error</title>",
  "</head>",
  "<body>",
  "<h1>500 Internal Server Error</h1>",
  "</body>",
  "</html>",
  "",
].join("\n");

// Small pure helpers

/**
 * `claims.expiresAt` (the token's `exp`, in seconds) as `2026-08-24T14:34:16`,
 * or `null` when it cannot be rendered.
 *
 * UTC, seconds precision, no `Z` and no fraction (`contract/sso.js`
 * `VERIFY_EXPIRES_ON`). Every ISO-8601 parser reads all three candidate
 * spellings, and the parsers that do not (a `strptime("%Y-%m-%dT%H:%M:%S")` of
 * the era) raise on a trailing `Z` and on `.000`, so the shortest form is the
 * one most real parsers accept whichever CCP sends.
 *
 * Slice, then check: `toISOString` throws `RangeError` outside +-8.64e15 ms and
 * switches to an expanded year form (`+275760-09-13T00:00:00.000Z`) above year
 * 9999, where a blind `slice(0, 19)` would emit `+275760-09-13T00:0`, the right
 * length and wrong everywhere else. The result is matched against the intended
 * shape first, and a failure is a `500`.
 *
 * A fractional `exp` is floored, not refused. RFC 7519 section 2 permits a
 * non-integer NumericDate and `lib/bearerToken.js` `isNumericDate` accepts one,
 * so refusing would answer `500` to a token the verifier called good. Down is
 * the safe direction: the advertised instant is never later than `exp`, so a
 * client scheduling its refresh from `ExpiresOn` refreshes at or before the real
 * expiry. Rounding to nearest would put half of such tokens on the wrong side.
 */
function expiresOnFrom(exp) {
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;

  const milliseconds = Math.floor(exp) * 1000;
  if (!Number.isSafeInteger(milliseconds)) return null;

  let iso;
  try {
    iso = new Date(milliseconds).toISOString();
  } catch {
    return null;
  }

  // `YYYY-MM-DDTHH:MM:SS` followed by the fraction `toISOString` always appends.
  // Anchored, so an expanded-year rendering fails here instead of being truncated
  // into something that looks like a date.
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d{3}Z$/.exec(iso);
  return match === null ? null : match[1];
}

/**
 * The scope list as one space-delimited string.
 *
 * `lib/bearerToken.js` hands over `claims.scopes` as a frozen array at every
 * scope count (it normalises CCP's two `scp` shapes), so the join is the whole
 * decision. A string is passed through anyway, for a double or later version
 * handing back the `scope` it was given. Anything else (`undefined`, `null`, a
 * number) is `""` rather than `"undefined"` or a throw: a token with no scopes
 * is ordinary (`publicData` is not required), and this is the one member whose
 * empty value is meaningful.
 *
 * Entries are filtered for emptiness so a stray element cannot produce a double
 * space, which a consumer splitting on a single space reads as a scope named "".
 */
function scopesStringOf(scopes) {
  if (typeof scopes === "string") return scopes;
  if (!Array.isArray(scopes)) return "";
  return scopes
    .filter((scope) => typeof scope === "string" && scope !== "")
    .join(SCOPE_DELIMITER);
}

function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (value === "") return "the empty string";
  return `the ${typeof value} ${JSON.stringify(value)}`;
}

// Responses

/** A refusal, in the content type recorded for this endpoint and with nothing else in it. */
function htmlResponse(status, body, extraHeaders = {}) {
  return {
    status,
    headers: {
      "content-type": CONTENT_TYPE_HTML,
      "cache-control": CACHE_CONTROL,
      // Backs up `Content-Type`, and is why the bare media type costs nothing: a
      // browser may not re-decide what these bytes are. `routes/oauthAuthorize.js`
      // sends it on its pages for the same reason.
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
    body,
  };
}

/**
 * The identity body, with its members inserted in `MEMBER_ORDER`.
 *
 * Insertion order is output order for every non-integer-like string key, so
 * `JSON.stringify` reproduces it, as in `lib/serialize.js` `projection`,
 * `routes/oauthJwks.js` `orderKey` and `routes/oauthToken.js` `tokenResponse`.
 */
function verifyResponse(members) {
  const body = {};
  for (const member of MEMBER_ORDER) body[member] = members[member];

  return {
    status: 200,
    headers: {
      "content-type": CONTENT_TYPE_JSON,
      "cache-control": CACHE_CONTROL,
    },
    body: JSON.stringify(body),
  };
}

// The route

/**
 * Build the verify route, with everything it talks to injected.
 *
 * @param {{
 *   bearer: { fromHeader: Function, verify: Function },
 *   now?: () => number,
 *   log?: (message: string) => void,
 * }} deps
 */
function createOauthVerifyRoute(deps = {}) {
  const { bearer, now, log } = deps;

  // Construction-time validation, as in `lib/ssoDispatch.js`: a table with a
  // mistake in it fails at boot naming the route, not on the one request that
  // reaches it.
  requireMethod(bearer, "bearer", "fromHeader");
  requireMethod(bearer, "bearer", "verify");

  // Accepted so the wiring can hand one dependency bag to every SSO route, and
  // never read. `routes/oauthToken.js` voids its `now` likewise. Every
  // clock-dependent decision belongs to the verifier: expiry is `bearer.verify`'s,
  // and `ExpiresOn` is a rendering of the token's own `exp`. A second reading of
  // time here could make this endpoint accept a token the rest of the surface
  // refuses, or the reverse; having no clock makes that unreachable.
  void now;

  const emit = typeof log === "function" ? log : () => {};

  /**
   * The one refusal a caller can provoke, in one place so the bytes are one
   * string.
   *
   * `reason` reaches the log and never the response (as in
   * `routes/oauthToken.js`): an operator debugging "my tool says it is signed out"
   * needs to know whether the header was missing, the token gibberish or expired,
   * and a prober must not be able to tell.
   */
  function unauthorized(reason) {
    emit(`verify refused: ${reason} (answered 401).`);
    return htmlResponse(401, UNAUTHORIZED_BODY, { "www-authenticate": WWW_AUTHENTICATE });
  }

  /** Our fault, not theirs. The specifics go to the log. */
  function serverError(detail) {
    emit(`verify failed: ${detail} (answered 500).`);
    return htmlResponse(500, SERVER_ERROR_BODY);
  }

  function handle(request) {
    const method = String((request && request.method) || "GET").toUpperCase();
    if (!ALLOWED_METHODS.includes(method)) {
      return htmlResponse(405, METHOD_NOT_ALLOWED_BODY, { allow: ALLOW });
    }

    const headers = (request && request.headers) || {};

    // `lib/bearerToken.js` owns the parse. Reading `Authorization` here would be a
    // second implementation of RFC 6750 section 2.1's grammar, differing first on
    // something small (a lowercase `bearer`, two spaces, a trailing comma from a
    // client that appends schemes) and making one endpoint accept what another
    // rejects.
    const token = bearer.fromHeader(headers);
    if (typeof token !== "string" || token === "") {
      return unauthorized("the request carried no bearer token");
    }

    // No `try`/`catch`: `lib/bearerToken.js` promises `verify` never throws on any
    // input, with a fuzz test behind the promise.
    const verified = bearer.verify(token) || {};
    if (verified.ok !== true) {
      // `reason` is one of the verifier's machine names (`EXPIRED`, `BAD_SIGNATURE`,
      // `WRONG_ISSUER` and the rest) and `detail` is its sentence. Both go in the log
      // and neither reaches the caller. `EXPIRED` is distinct so an operator can
      // filter it out: it is the ordinary end of a token's life, once every twenty
      // minutes per client, and would bury the refusals that matter.
      const why = typeof verified.reason === "string" && verified.reason !== ""
        ? verified.reason
        : "no reason given";
      const detail = typeof verified.detail === "string" && verified.detail !== ""
        ? ` ${verified.detail}`
        : "";
      return unauthorized(`the bearer token was rejected (${why}).${detail}`);
    }

    const claims = (verified.claims !== null && typeof verified.claims === "object")
      ? verified.claims
      : {};

    // Everything from here down is a `500` rather than a `401`: the token was
    // accepted, so a body that cannot be built is a fault in what this server
    // minted. Answering `401` would tell a client with a good token to re-authorise,
    // which under D3 means a human back at the game client typing a bind code, for a
    // defect a restart might fix.
    //
    // Against the real `lib/bearerToken.js` none of these is reachable: it refuses a
    // token whose `sub`, `name` or `owner` is unusable before projecting a claim.
    // They are here because the route is written against an interface, and the
    // alternative is a `200` carrying `"CharacterName":null`, a body that parses and
    // is wrong.
    //
    // `claims.characterId` is already the integer the verifier parsed out of `sub`,
    // and `claims.subject` carries the raw `CHARACTER:EVE:<id>` string beside it.
    // This route reads only the first, rather than re-deriving the id from the
    // string (a second implementation of `ACCESS_TOKEN_SUBJECT_PATTERN`).
    // `test/verifyContract.test.js` asserts the two agree.

    const characterId = claims.characterId;
    if (!Number.isInteger(characterId) || characterId <= 0) {
      return serverError(
        `the verified token carried ${describeValue(characterId)} as its character id`,
      );
    }

    const characterName = claims.characterName;
    if (typeof characterName !== "string" || characterName === "") {
      return serverError(
        `the verified token for character ${characterId} carried `
        + `${describeValue(characterName)} as its character name`,
      );
    }

    // Emitted verbatim under CCP's older name for it. `contract/sso.js`
    // `VERIFY_MEMBER_SOURCES` confirms the two are one value. Nothing is derived: a
    // second derivation would have to be kept in step with `lib/accessToken.js`
    // `ownerHashFor`, and when it fell behind every client comparing the two would
    // log its user out.
    const owner = claims.owner;
    if (typeof owner !== "string" || owner === "") {
      // Refused rather than emitted as `""`: a client stores an empty hash, compares a
      // real one against it later, sees a change, and discards a working refresh
      // token.
      return serverError(
        `the verified token for character ${characterId} carried `
        + `${describeValue(owner)} as its owner hash`,
      );
    }

    const expiresOn = expiresOnFrom(claims.expiresAt);
    if (expiresOn === null) {
      return serverError(
        `the verified token for character ${characterId} carried `
        + `${describeValue(claims.expiresAt)} as its expiresAt, which is not a renderable instant`,
      );
    }

    return verifyResponse({
      CharacterID: characterId,
      CharacterName: characterName,
      ExpiresOn: expiresOn,
      Scopes: scopesStringOf(claims.scopes),
      TokenType: TOKEN_TYPE,
      CharacterOwnerHash: owner,
      IntellectualProperty: INTELLECTUAL_PROPERTY,
    });
  }

  return Object.freeze({
    // Optional as far as `lib/ssoDispatch.js` is concerned; it is what a route-table
    // error says instead of "SSO route number 4".
    name: "GetOauthVerify",
    paths: VERIFY_PATHS,
    handle,
  });
}

// Pieces the factory uses, kept out of its closure

/** Construction-time check with a message that says what to inject and why. */
function requireMethod(object, name, method) {
  if (!object || typeof object[method] !== "function") {
    throw new TypeError(
      `ESI mod: createOauthVerifyRoute needs ${name}.${method}(). It is injected rather than `
      + "required so this route does not depend on the module that provides it.",
    );
  }
}

module.exports = Object.freeze({
  ALLOW,
  ALLOWED_METHODS,
  CACHE_CONTROL,
  CONTENT_TYPE_HTML,
  CONTENT_TYPE_JSON,
  INTELLECTUAL_PROPERTY,
  MEMBER_ORDER,
  METHOD_NOT_ALLOWED_BODY,
  SCOPE_DELIMITER,
  SERVER_ERROR_BODY,
  TOKEN_TYPE,
  UNAUTHORIZED_BODY,
  VERIFY_PATHS,
  WWW_AUTHENTICATE,
  createOauthVerifyRoute,
  expiresOnFrom,
  scopesStringOf,
});
