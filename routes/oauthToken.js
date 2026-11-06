/**
 * `POST /v2/oauth/token`: exchanges an authorization code or a refresh token
 * for credentials.
 *
 * Success body (four members, always non-empty):
 *
 *   {"access_token":"eyJ...","token_type":"Bearer","expires_in":1199,
 *    "refresh_token":"gEy..."}
 *
 * Errors are RFC 6749 section 5.2 JSON (`{error, error_description}`, status
 * 400). Unlike `routes/oauthAuthorize.js`, which refuses in HTML or by
 * redirect, the caller here is the application's own HTTP client, so the RFC's
 * error channel is the only channel.
 *
 * Grant failures are flattened. `lib/authCodes.js` keeps `already_used`,
 * `expired` and `unknown` apart, and the distinction goes to the log only.
 * Every refusal about a grant returns the same `error` and the same
 * `error_description` bytes (`INVALID_CODE_DESCRIPTION`,
 * `INVALID_REFRESH_DESCRIPTION`, frozen constants), because any variation
 * would let a caller probe which codes were minted or spent. The one outcome
 * that is not flattened is `scope_not_subset`: it is a fault in the request,
 * not a statement about the grant, and maps to `invalid_scope` (D30: "a
 * refusal ... not a silent intersection").
 *
 * Replay of an authorization code (RFC 6749 section 4.1.2):
 *   - On success, `issueAndMint` takes the `family` off the record
 *     `refreshTokens.issue` wrote and hands it to `authCodes.rememberGrant`,
 *     which binds it to the code's tombstone.
 *   - On a replay, `redeem` answers with `grant = {characterId, clientId,
 *     grantRef}` and this route calls `refreshTokens.revokeFamily(grantRef)`.
 *
 * Only that one family is revoked, never every grant of the (character,
 * client) pair. A replay is refused before `mayRedeem` and `verifyPkce` run,
 * so a sniffed spent code plus a public `client_id` is enough to reach it, and
 * a wider revocation would be a cheap logout oracle. The revocation is also
 * skipped when `grant.clientId` is not the client that authenticated.
 *
 * Still exposed after a replay:
 *   - The access token minted from the replayed code survives. It is a
 *     stateless RS256 JWT with no revocation path; revoking the family stops
 *     renewal and leaves up to twenty minutes of the token already held
 *     (`test/tokenIntegration.test.js` pins this).
 *   - A restart loses the link. `lib/authCodes.js` is in memory, so a replayed
 *     code is then `unknown` or carries `grantRef: null`, and nothing is
 *     revoked. The log says which. The revocation endpoint is the manual
 *     remedy.
 * None of this reaches the caller: the response is byte-identical to an
 * expired or unknown code. Authorization codes travel over plain HTTP (D1), so
 * an attacker who sniffs one still needs the client secret or PKCE verifier,
 * which are checked before anything is issued.
 *
 * Both `access_token` and `refresh_token` are always non-empty
 * (`docs/d6-listener-split.md`: the EVE client treats an empty one as an
 * error). A minter or store that cannot issue produces a `500` with an OAuth
 * error shape, never a `200`. The refresh token is issued before the access
 * token is minted so a failure in either means neither is sent.
 *
 * D30: the refresh token is not rotated. `refreshTokens.refresh` returns no
 * token (the store keys records by an unkeyed SHA-256 and writes the token
 * nowhere), so the response echoes the one the caller presented, verbatim,
 * after the store confirms it is live.
 *
 * `expires_in` is copied from the minter (`lib/accessToken.js` returns
 * `expiresIn` beside the token) and never range-checked here. This route has
 * no clock, so it cannot disagree with the token's `exp`; see `now` in the
 * factory.
 *
 * Everything is injected: `createOauthTokenRoute({clientAuth, authCodes,
 * refreshTokens, mintAccessToken, now, log})`. The file requires no mod
 * module, so `test/tokenContract.test.js` drives it with object literals and
 * no listener, store, signing key or game. It never touches the signing key or
 * the owner salt; `mintAccessToken` arrives already holding both.
 *
 * `contract/sso.js` is the authority for the path and is not imported:
 * `contract/` is test-only and never deployed (`lib/sourceHash.js`
 * `HASHED_DIRS` is `["lib", "routes"]`, and `scripts/deploy-mod.js` copies that
 * manifest), so importing it would pass the suite and throw `MODULE_NOT_FOUND`
 * in the game process. The outcome names duplicated from `lib/authCodes.js` and
 * `lib/refreshTokens.js` are asserted against their authority in
 * `test/tokenContract.test.js`.
 */

"use strict";

// The path

/**
 * `contract/sso.js` `DISCOVERY_ENDPOINT_PATHS.token`.
 *
 * A literal path, not a version prefix. `docs/d6-listener-split.md` states
 * that `/v2/oauth/*` is on the other listener and never enters the ESI route
 * table, and `lib/ssoDispatch.js` exact-matches it. There is no `/latest/`
 * spelling and no trailing-slash spelling. The discovery document is served at
 * two spellings only because the EVE client was observed asking for the second;
 * nothing equivalent was observed here. This is also the string
 * `routes/oauthDiscovery.js` publishes as `token_endpoint`, which the EVE
 * client reads on every launch.
 */
const TOKEN_PATH = "/v2/oauth/token";

// The two outcome names this route compares against.
// Duplicated rather than required to keep the route injection-only; the test
// asserts each against its authority.

/** `lib/authCodes.js` `REDEEM_OUTCOME.OK`. Every other outcome is a refusal. */
const REDEEM_OK = "ok";

/** `lib/refreshTokens.js` `REFRESH_OUTCOME.OK`. */
const REFRESH_OK = "ok";

/**
 * `lib/refreshTokens.js` `REFRESH_OUTCOME.SCOPE_NOT_SUBSET`: the one refresh
 * outcome that is not flattened. See the header.
 */
const REFRESH_SCOPE_NOT_SUBSET = "scope_not_subset";

/**
 * `lib/refreshTokens.js` `REVOKE_OUTCOME.OK`: at least one live grant in the
 * family was retired.
 *
 * Used only to decide what the replay log line says. Every other outcome
 * (`unknown`, `persist_failed`) is reported as "nothing was revoked", and none
 * changes the response.
 */
const REVOKE_OK = "ok";

// Protocol constants

/**
 * The two grants this endpoint implements, spelled as RFC 6749 spells them.
 *
 * `client_credentials` and `password` get `unsupported_grant_type`. This
 * server's only source of character identity is a session already logged into
 * the game (D3), so a grant with no player behind it could only mint a token
 * for nobody.
 */
const GRANT_TYPE = Object.freeze({
  AUTHORIZATION_CODE: "authorization_code",
  REFRESH_TOKEN: "refresh_token",
});

/**
 * `Bearer`, capitalised. Several clients in this ecosystem string-compare
 * `token_type` without folding case, even though RFC 6749 section 7.1 says the
 * comparison is case-insensitive, and discard a lowercase `bearer`. This is
 * also what CCP sends (design constraint 3).
 */
const TOKEN_TYPE = "Bearer";

/**
 * The response's member order.
 *
 * Built from an array so the order stays stable: a literal in the right order
 * produces identical bytes until someone sorts it. Member order is observable
 * to a client comparing against a recorded fixture.
 *
 * There is no `scope` member. RFC 6749 section 5.1 requires it only when the
 * granted scope differs from the requested one, and this endpoint never grants
 * a set the caller did not ask for: a code carries the set the player
 * authorised, and a refresh keeps it or narrows it to exactly the request (a
 * non-subset is refused, D30). One caveat: `parseScope` in
 * `routes/oauthAuthorize.js` drops duplicate scopes, so a client that sent one
 * twice and byte-compared would see a difference.
 */
const RESPONSE_MEMBER_ORDER = Object.freeze([
  "access_token",
  "token_type",
  "expires_in",
  "refresh_token",
]);

// Request shape

/**
 * `POST` only, not `HEAD` and not `OPTIONS`.
 *
 * A request here redeems a one-time authorization code and mints two
 * credentials, so `HEAD` (a `GET` without the body) would mean "do all of that
 * and discard the result", and a monitoring probe would burn a real client's
 * code. `GET` is refused too, because a `code` or `client_secret` in a query
 * string lands in access logs and `Referer` headers.
 *
 * `OPTIONS` is refused rather than answered as a CORS preflight, following
 * `routes/oauthAuthorize.js` and not `routes/oauthJwks.js`. The response holds
 * two bearer credentials and nothing legitimate calls this endpoint from a
 * browser, so a preflight answer would only advertise a capability to the
 * wrong party.
 */
const ALLOWED_METHOD = "POST";

/**
 * The one media type a token request may carry (RFC 6749 section 4.1.3).
 *
 * Compared as a bare media type, parameters stripped and case folded, so
 * `application/x-www-form-urlencoded; charset=UTF-8` is accepted. A missing
 * `content-type` is refused.
 */
const REQUEST_CONTENT_TYPE = "application/x-www-form-urlencoded";

/**
 * A cap on the request body, over and above `server.js`'s.
 *
 * A token request is a grant type, a code or token and at most a client
 * assertion, so 8 KB is ample. It bounds the parse below, which runs on the
 * game's event loop (design constraint 2).
 */
const MAX_REQUEST_BODY_BYTES = 8192;

/**
 * The parameters this route reads, and the only names a refusal will repeat.
 *
 * An `error_description` is either a fixed sentence or one of these names. A
 * duplicate-parameter refusal that echoed the offending name verbatim would
 * reflect attacker-chosen text into the client's log.
 */
const KNOWN_PARAMETERS = Object.freeze([
  "client_assertion",
  "client_assertion_type",
  "client_id",
  "client_secret",
  "code",
  "code_verifier",
  "grant_type",
  "redirect_uri",
  "refresh_token",
  "scope",
]);

// Response shape
//
// `contract/sso.js` `UNOBSERVED` records that no response header has been
// captured off `login.eveonline.com`, so nothing below reproduces CCP except
// the two cache directives. Nothing is borrowed from `contract/wire.js`, which
// describes `esi.evetech.net`.

/** Bare `application/json`, matching `routes/oauthJwks.js`'s reasoning. */
const CONTENT_TYPE_JSON = "application/json";

/**
 * `Cache-Control: no-store,no-cache` and `pragma: no-cache`, including the
 * missing space after the comma, because a recorded value is kept whole.
 *
 * The response carries two bearer credentials, one of which (D30) never
 * expires, so `no-store` is backed by `no-cache` and HTTP/1.0 `Pragma` for old
 * intermediaries. Every refusal carries them too: a cached `400` outlives the
 * mistake that caused it.
 *
 * Header names are title-cased on the way to the socket by `lib/headers.js`
 * `withCcpCasing`, applied once in `server.js` `mergeHeaders`, so `pragma`
 * leaves as `Pragma` and `www-authenticate` as `Www-Authenticate`. Names are
 * case-insensitive (RFC 9110 section 5.1) and written lowercase here because
 * every layer in this codebase keys headers that way.
 */
const CACHE_CONTROL = "no-store,no-cache";
const PRAGMA = "no-cache";

/**
 * The `WWW-Authenticate` that accompanies a `401`. It names `Basic` instead of
 * echoing what the client sent.
 *
 * RFC 6749 section 5.2 says the header must match the scheme the client used,
 * which read literally reflects an attacker-chosen token into a response
 * header. `Basic` is the only scheme the Authorization header path implements.
 *
 * No `charset="UTF-8"` (RFC 7617 section 2.1): how credentials are decoded is
 * `lib/clientAuth.js`'s decision.
 */
const WWW_AUTHENTICATE = 'Basic realm="EVE SSO"';

// Refusals as fixed bytes

/**
 * Every refusal about an authorization code, in one string.
 *
 * Shared by "already used", "expired", "never existed", "issued to another
 * client" and "redirect_uri does not match", because telling them apart is the
 * oracle the header describes.
 */
const INVALID_CODE_DESCRIPTION =
  "The authorization code is not valid for this client, or it has expired or already been "
  + "used. Start the authorization again.";

/** The same, for a refresh token. See `INVALID_CODE_DESCRIPTION`. */
const INVALID_REFRESH_DESCRIPTION =
  "The refresh token is not valid for this client, or it has been revoked or replaced. "
  + "Authorize again to obtain a new one.";

/**
 * The sentence every replay alarm ends with. A log string, never a response.
 *
 * It is a constant so no branch can drift out of step and tell an operator the
 * incident is closed when it is not. Revoking the family stops renewal and
 * does nothing to the access token already minted, which is stateless and has
 * no revocation path. See the header.
 */
const ACCESS_TOKEN_STILL_LIVE =
  "The access token already minted from that code is a stateless JWT with no revocation path "
  + "and stays valid until it expires, so this is contained rather than closed.";

// Small pure helpers

/** Case-insensitive header read; `request.headers` may come from anywhere. */
function readHeader(request, name) {
  const headers = (request && request.headers) || {};
  if (headers[name] !== undefined) return headers[name];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

/** `application/x-www-form-urlencoded; charset=UTF-8` -> the bare media type. */
function mediaTypeOf(value) {
  if (typeof value !== "string") return null;
  const semicolon = value.indexOf(";");
  return (semicolon === -1 ? value : value.slice(0, semicolon)).trim().toLowerCase();
}

/**
 * The form body, or a reason it is unusable.
 *
 * `server.js` parses a body as JSON only: `parseJsonBody` answers `null` for
 * anything else and leaves the bytes on `rawBody`. A form body therefore
 * arrives as `body: null` with `rawBody` set, and this route decodes it.
 *
 * `URLSearchParams` is used because it matches the encoder OAuth client
 * libraries use: in `application/x-www-form-urlencoded` a `+` is an encoded
 * space and a literal plus arrives as `%2B`. A refresh token contains `+` and
 * `/`, so clients must encode it. No leniency is applied to a raw `+`: it
 * would corrupt space-delimited `scope` values, and CCP's endpoint decodes
 * forms the same way (design constraint 3). Instead a failed refresh whose
 * decoded token contains a space is logged; see `plusLikelyMangled`.
 *
 * A repeated parameter is refused. RFC 6749 section 3.1 forbids it, and
 * `server.js`'s last-value-wins rule for query parameters would let
 * `code=stolen&code=mine` be read differently by each server in the chain.
 *
 * @returns {{ fields: Map<string, string> } | { failure: string }}
 */
function parseFormBody(rawBody) {
  const text = Buffer.isBuffer(rawBody)
    ? rawBody.toString("utf8")
    : (typeof rawBody === "string" ? rawBody : "");

  const params = new URLSearchParams(text);
  const fields = new Map();

  for (const name of params.keys()) {
    if (fields.has(name)) continue;

    const all = params.getAll(name);
    if (all.length > 1) {
      const named = KNOWN_PARAMETERS.includes(name) ? `The parameter ${name}` : "A parameter";
      return {
        failure:
          `${named} was sent more than once. RFC 6749 §3.1 does not permit a repeated `
          + "parameter in a token request, and resolving one by precedence would let the "
          + "value this server acts on differ from the value the client believes it sent.",
      };
    }
    fields.set(name, all[0]);
  }

  return { fields };
}

/**
 * Did this refresh token almost certainly arrive with an un-encoded `+`?
 *
 * Tokens from `lib/refreshTokens.js` (base64url) and CCP (base64) contain no
 * space, so a space in a decoded token means the wire carried a `+` that the
 * form decoder read as a space. It surfaces as an ordinary `invalid_grant`, and
 * the log line is the only way to tell it from a dead token.
 *
 * The line says only that it happened. The token is never written anywhere (D30
 * hashes it so a copy of the file is not a set of working credentials).
 */
function plusLikelyMangled(token) {
  return typeof token === "string" && token.includes(" ");
}

/**
 * The scope list a code carries, as an array.
 *
 * `parseScope` in `routes/oauthAuthorize.js` stores a space-delimited string.
 * This splits on space only: a tab or newline is not an RFC 6749 delimiter.
 */
function scopesOf(scope) {
  if (Array.isArray(scope)) return scope.slice();
  if (typeof scope !== "string" || scope === "") return [];
  return scope.split(" ").filter((token) => token !== "");
}

/** `null`, `undefined`, `an array`, `the number 3`, `the empty string`. */
function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (value === "") return "the empty string";
  return `the ${typeof value} ${JSON.stringify(value)}`;
}

// Responses

/**
 * The headers every response from this endpoint carries.
 *
 * Rebuilt per response, because callers spread `allow` and `www-authenticate`
 * into it and a shared object would leak one refusal's extra header into
 * every other.
 */
function baseHeaders() {
  return {
    "content-type": CONTENT_TYPE_JSON,
    "cache-control": CACHE_CONTROL,
    pragma: PRAGMA,
  };
}

/** An RFC 6749 §5.2 refusal. `body` is a string; the dispatch contract says so. */
function errorResponse(status, error, description, extraHeaders = {}) {
  return {
    status,
    headers: { ...baseHeaders(), ...extraHeaders },
    body: JSON.stringify({ error, error_description: description }),
  };
}

/**
 * The success body, with members inserted in `RESPONSE_MEMBER_ORDER`.
 *
 * Insertion order is output order for non-integer-like string keys, the
 * mechanism `lib/serialize.js` `projection` and `routes/oauthJwks.js`
 * `orderKey` also rely on.
 */
function tokenResponse({ accessToken, expiresIn, refreshToken }) {
  const source = {
    access_token: accessToken,
    token_type: TOKEN_TYPE,
    expires_in: expiresIn,
    refresh_token: refreshToken,
  };

  const body = {};
  for (const member of RESPONSE_MEMBER_ORDER) body[member] = source[member];

  return { status: 200, headers: baseHeaders(), body: JSON.stringify(body) };
}

// The route

/**
 * Build the token route, with everything it talks to injected.
 *
 * @param {{
 *   clientAuth: { authenticate: Function, verifyPkce: Function, mayRedeem: Function },
 *   authCodes: { redeem: Function, rememberGrant: Function },
 *   refreshTokens: { issue: Function, refresh: Function, revokeFamily: Function },
 *   mintAccessToken: (grant: object) => { token: string, expiresIn: number },
 *   now?: () => number,
 *   log?: (message: string) => void,
 * }} deps
 */
function createOauthTokenRoute(deps = {}) {
  const { clientAuth, authCodes, refreshTokens, mintAccessToken, now, log } = deps;

  // Construction-time validation (`lib/ssoDispatch.js`'s reason): a mistake
  // fails at boot naming the route, not on the request of a client whose access
  // token has just expired.
  requireMethod(clientAuth, "clientAuth", "authenticate");
  requireMethod(clientAuth, "clientAuth", "verifyPkce");
  requireMethod(clientAuth, "clientAuth", "mayRedeem");
  requireMethod(authCodes, "authCodes", "redeem");
  requireMethod(refreshTokens, "refreshTokens", "issue");
  requireMethod(refreshTokens, "refreshTokens", "refresh");

  // `revokeFamily` and `rememberGrant` are required, not feature-detected. A
  // `typeof` guard would degrade silently to the behaviour the revocation exists
  // to remove (a replay that is refused and leaves its tokens live) on a path
  // that only runs after a code has been stolen.
  requireMethod(authCodes, "authCodes", "rememberGrant");
  requireMethod(refreshTokens, "refreshTokens", "revokeFamily");
  if (typeof mintAccessToken !== "function") {
    throw new TypeError(
      "ESI mod: createOauthTokenRoute needs a mintAccessToken({characterId, clientId, scopes}) "
      + "returning {token, expiresIn}. It is injected rather than required so that this route "
      + "never holds the signing key or the owner salt.",
    );
  }

  // Accepted so the wiring can hand one dependency bag to every SSO route, and
  // never read. Each clock-dependent decision belongs to a module with its own
  // clock: code expiry to `lib/authCodes.js`, grant expiry to
  // `lib/refreshTokens.js`, `expires_in` to `lib/accessToken.js`. A second
  // reading of time here could only disagree with `expires_in`. `server.js`
  // accepts and voids its `log` for the same reason.
  void now;

  const emit = typeof log === "function" ? log : () => {};

  // The two grants

  /**
   * `grant_type=authorization_code`.
   *
   * The order of the checks is load-bearing: none may move above `redeem`,
   * because `redeem` is destructive (a second call gets `already_used`). Anyone
   * holding a code, for instance a listener on D1's plain HTTP, could otherwise
   * burn the honest client's code without the secret or verifier. The client is
   * proved first, then anything is consumed.
   */
  function handleAuthorizationCode({ fields, clientId, authenticated }) {
    const code = fields.get("code");
    if (code === undefined || code === "") {
      return errorResponse(400, "invalid_request", "code is required for grant_type="
        + `${GRANT_TYPE.AUTHORIZATION_CODE}.`);
    }

    const redeemed = authCodes.redeem(code) || {};

    if (redeemed.outcome !== REDEEM_OK || !redeemed.record) {
      // The operator's copy, with the outcome the store kept distinct. The
      // caller's copy, below, is the same bytes for every outcome.
      const outcome = typeof redeemed.outcome === "string" ? redeemed.outcome : "no outcome";
      emit(
        `token exchange refused for client ${JSON.stringify(clientId)}: the authorization `
        + `code was ${outcome} (answered invalid_grant).`,
      );

      // The replay, and RFC 6749 section 4.1.2's revocation. Everything it does goes
      // to the log; the return below is the same bytes an expired code gets. See the
      // header and `revokeReplayedGrant`.
      if (outcome === "already_used") {
        revokeReplayedGrant(redeemed.grant, clientId);
      }

      return errorResponse(400, "invalid_grant", INVALID_CODE_DESCRIPTION);
    }

    const record = redeemed.record;

    // RFC 6749 section 4.1.3: the code must have been issued to the
    // authenticated client. Without this check a public client that learned a code
    // could exchange it under its own id and hold a token for a character it never
    // authorised.
    if (record.clientId !== clientId) {
      emit(
        `token exchange refused: an authorization code minted for client `
        + `${JSON.stringify(record.clientId)} was presented by client `
        + `${JSON.stringify(clientId)} (answered invalid_grant).`,
      );
      return errorResponse(400, "invalid_grant", INVALID_CODE_DESCRIPTION);
    }

    // RFC 6749 section 4.1.3 requires `redirect_uri` here when it was sent to the
    // authorize endpoint. CCP's documented request does not carry it, so an
    // absent one is accepted. One that is sent is compared byte for byte with the
    // value the code was minted with.
    const presentedRedirect = fields.get("redirect_uri");
    if (presentedRedirect !== undefined && presentedRedirect !== record.redirectUri) {
      emit(
        `token exchange refused for client ${JSON.stringify(clientId)}: the redirect_uri in `
        + "the token request is not the one the code was minted with (answered invalid_grant).",
      );
      return errorResponse(400, "invalid_grant", INVALID_CODE_DESCRIPTION);
    }

    const codeVerifier = fields.get("code_verifier");

    // `routes/oauthAuthorize.js` hands over this invariant: a code minted with a
    // challenge is redeemable only with a matching verifier, and a code minted
    // without one only by a client that authenticated. Only redemption knows how
    // the client authenticated. The rule lives in `lib/clientAuth.js` so its two
    // halves cannot be edited apart, and its refusal is returned as given.
    const allowed = clientAuth.mayRedeem({
      authenticated,
      codeChallenge: record.codeChallenge,
      codeVerifier,
    }) || {};
    if (allowed.ok !== true) {
      return refusalFrom(allowed, "invalid_grant", 400);
    }

    // PKCE proper, only when the code carries a challenge. `parsePkce` stores
    // `null` for "no PKCE" so this line can tell it from an unreadable
    // challenge; `mayRedeem` has already decided whether no-PKCE was permissible
    // for this client.
    if (record.codeChallenge !== null && record.codeChallenge !== undefined) {
      const verified = clientAuth.verifyPkce({
        codeChallenge: record.codeChallenge,
        codeChallengeMethod: record.codeChallengeMethod,
        codeVerifier,
      }) || {};
      if (verified.ok !== true) {
        emit(
          `token exchange refused for client ${JSON.stringify(clientId)}: PKCE verification `
          + "failed.",
        );
        return refusalFrom(verified, "invalid_grant", 400);
      }
    }

    const characterId = record.characterId;
    if (!Number.isInteger(characterId) || characterId <= 0) {
      // The code was minted without a usable character: a bug on the authorize
      // side, not the caller's. The code is already spent and cannot be given back;
      // see `issueAndMint` for why that ordering is still right.
      emit(
        `token exchange failed for client ${JSON.stringify(clientId)}: the authorization code `
        + `carried ${describeValue(characterId)} as its character id.`,
      );
      return errorResponse(
        500,
        "server_error",
        "The authorization code did not identify a character, so no token could be issued.",
      );
    }

    return issueAndMint({
      characterId,
      clientId,
      scopes: scopesOf(record.scope),

      // Passed only from here. `issueAndMint` is shared with the refresh path, which
      // must not bind anything, so `bindGrant` is a closure over `code` (the string
      // bound is the one redeemed above) that the refresh path does not supply.
      bindGrant: (family) => {
        if (authCodes.rememberGrant(code, family) === true) return;

        // Not an error: the exchange succeeded. The cost is that a later replay of
        // this code is still refused but will have nothing to revoke, and its log
        // line will say the link was lost.
        emit(
          `the refresh grant issued to client ${JSON.stringify(clientId)} could not be bound `
          + "to the authorization code it came from, so a replay of that code will be refused "
          + `but not actionable (${describeValue(family)} as its family).`,
        );
      },
    });
  }

  // The replay, and the revocation it triggers

  /**
   * Revoke the refresh grant a replayed authorization code minted, or log why
   * not.
   *
   * Returns nothing on purpose. The response is `INVALID_CODE_DESCRIPTION`
   * whether this revoked a family, refused to, or found nothing, because a
   * response that moved would confirm the code was real and had been used.
   *
   * Branches:
   *   - No `grant`: the store knows the code was spent and nothing else.
   *     `lib/authCodes.js` keeps this distinct from `grantRef: null`, and so does
   *     the log.
   *   - A different client: `grant.clientId` is not the client that just
   *     authenticated. Honouring it would let anyone with a learned code and any
   *     `client_id` retire a third party's grant. Logged as a probable attack,
   *     nothing touched.
   *   - `grantRef` is `null`: the tombstone survived but the binding never
   *     happened in this process, the ordinary case after a restart. The
   *     revocation endpoint is the manual remedy.
   *   - A family to revoke: the store's answer is reported as returned
   *     (`unknown` and `persist_failed` both mean nothing was retired).
   */
  function revokeReplayedGrant(grant, clientId) {
    const alarm = "!! AUTHORIZATION CODE REPLAY !! A code was presented a second time by client "
      + `${JSON.stringify(clientId)}. `;

    // Read rather than destructured (`mint`'s reasoning in `lib/authCodes.js`): a
    // store with the old shape, or a double with none, must not throw here.
    const source = grant !== null && typeof grant === "object" ? grant : null;

    if (source === null) {
      emit(
        alarm + "The tombstone carried no grant, so there is nothing to name and nothing was "
        + `revoked. ${ACCESS_TOKEN_STILL_LIVE}`,
      );
      return;
    }

    if (source.clientId !== clientId) {
      emit(
        alarm + `The code was minted for client ${JSON.stringify(source.clientId)}, so this is `
        + "a replay against a client it never belonged to and NOTHING was revoked: honouring it "
        + "would let anyone holding a leaked code retire another client's grants. If this was "
        + `not a probe, that client's grants are still live and /v2/oauth/revoke can retire them. `
        + ACCESS_TOKEN_STILL_LIVE,
      );
      return;
    }

    if (typeof source.grantRef !== "string" || source.grantRef === "") {
      emit(
        alarm + "The code's link to the grant it minted is gone, which is what a restart looks "
        + "like: the code store is in memory and the binding was never made in this process. "
        + `Nothing was revoked. Retire that character's refresh tokens by hand (/v2/oauth/revoke). `
        + ACCESS_TOKEN_STILL_LIVE,
      );
      return;
    }

    let revoked;
    try {
      revoked = refreshTokens.revokeFamily(source.grantRef, {
        reason: "authorization code replayed (D40)",
      }) || {};
    } catch (err) {
      // `lib/refreshTokens.js` promises not to throw, and this is caught anyway:
      // this is the request path, eve.js treats an unhandled throw as fatal, and a
      // replay of a stolen code must not be a way to take the server down. A throw
      // is the one outcome the store has no name for, so it gets its own log line.
      emit(
        alarm + `Revoking the refresh grant threw (${describeError(err)}), so nothing was `
        + `revoked and the store may be in a state worth looking at. ${ACCESS_TOKEN_STILL_LIVE}`,
      );
      return;
    }

    const count = Array.isArray(revoked.records) ? revoked.records.length : 0;
    const outcome = typeof revoked.outcome === "string" ? revoked.outcome : "no outcome";

    if (outcome === REVOKE_OK) {
      emit(
        alarm + `The refresh grant it minted has been revoked: ${count} grant`
        + `${count === 1 ? "" : "s"} in family ${JSON.stringify(source.grantRef)}, for `
        + `character ${describeValue(source.characterId)}. ${ACCESS_TOKEN_STILL_LIVE}`,
      );
      return;
    }

    emit(
      alarm + `Its refresh grant could not be revoked: the token store answered ${outcome} for `
      + `family ${JSON.stringify(source.grantRef)}, which means nothing live matched (a restart, `
      + "or a grant already revoked) or the revocation could not be written. Retire that "
      + `character's refresh tokens by hand (/v2/oauth/revoke). ${ACCESS_TOKEN_STILL_LIVE}`,
    );
  }

  /**
   * `grant_type=refresh_token`.
   *
   * The EVE client refreshes with `client_id` in the body and no secret
   * (`docs/d6-listener-split.md`), so an unauthenticated caller is the ordinary
   * case. The refresh token stands in for the secret, plus the check that it
   * belongs to the presenting client.
   */
  function handleRefreshToken({ fields, clientId }) {
    const presented = fields.get("refresh_token");
    if (presented === undefined || presented === "") {
      return errorResponse(400, "invalid_request", "refresh_token is required for grant_type="
        + `${GRANT_TYPE.REFRESH_TOKEN}.`);
    }

    // An absent or empty `scope` means "the same scopes as before" (RFC 6749
    // section 6; `lib/refreshTokens.js` treats an empty one identically), so both
    // are passed as an empty list rather than a narrowing request for nothing.
    const requestedScopes = scopesOf(fields.get("scope"));

    const result = refreshTokens.refresh(presented, { scopes: requestedScopes }) || {};

    // The one outcome that is not flattened: a fault in the request, not a
    // statement about the grant. See the header and D30.
    if (result.outcome === REFRESH_SCOPE_NOT_SUBSET) {
      return errorResponse(
        400,
        "invalid_scope",
        "The requested scope is not a subset of the scopes this refresh token was granted. "
        + "A refresh may narrow the granted set and never widen it.",
      );
    }

    if (result.outcome !== REFRESH_OK || !result.record) {
      const outcome = typeof result.outcome === "string" ? result.outcome : "no outcome";
      emit(
        `refresh refused for client ${JSON.stringify(clientId)}: the refresh token was `
        + `${outcome} (answered invalid_grant).`,
      );
      if (plusLikelyMangled(presented)) {
        // The un-encoded `+` failure, the only way to tell it from a dead token.
        // Nothing of the token is written.
        emit(
          "the presented refresh token contained a space, which in a base64 token means the "
          + "client sent it without URL-encoding: a form body reads `+` as a space (RFC 1866). "
          + "The refresh token must be percent-encoded in the request body.",
        );
      }
      return errorResponse(400, "invalid_grant", INVALID_REFRESH_DESCRIPTION);
    }

    const record = result.record;

    // The token proves a grant, and the grant names a client. Without this check
    // any client id could be presented with somebody else's token, and the minted
    // access token would carry the wrong `azp`, which the client reads back as its
    // `client_id` for later refreshes.
    if (record.clientId !== clientId) {
      emit(
        `refresh refused: a token granted to client ${JSON.stringify(record.clientId)} was `
        + `presented by client ${JSON.stringify(clientId)} (answered invalid_grant).`,
      );
      return errorResponse(400, "invalid_grant", INVALID_REFRESH_DESCRIPTION);
    }

    // The granted scopes from the store, not the requested ones from the body.
    // Minting from the request would let a request never checked against the grant
    // decide what the token authorises.
    return issueAndMint({
      characterId: record.characterId,
      clientId,
      scopes: scopesOf(result.scopes === undefined ? result.scope : result.scopes),
      // D30: no rotation. `refresh` returns no token (the store holds only an
      // unkeyed hash), so the value returned is the one presented, verbatim, now
      // that the store has said it is live.
      refreshToken: presented,
    });
  }

  // Issuing

  /**
   * The last two steps of both grants: a refresh token, then an access token.
   *
   * Both halves must exist before either is written, because the EVE client
   * treats an empty `access_token` or `refresh_token` as an error
   * (`docs/d6-listener-split.md`). Minting the access token first and then
   * finding the store at capacity would leave a valid token issued to nobody.
   *
   * On the authorization-code path the code is already spent, so a failure costs
   * the player a new sign-in through the game client (D3). Issuing before
   * redeeming is worse: it mints credentials from a code that may already be
   * used, which cannot be undone.
   */
  function issueAndMint({ characterId, clientId, scopes, refreshToken, bindGrant }) {
    let token = refreshToken;

    if (token === undefined) {
      const issued = refreshTokens.issue({ characterId, clientId, scopes }) || {};
      if (typeof issued.token !== "string" || issued.token === "") {
        const failure = typeof issued.failure === "string" ? issued.failure : "no reason given";
        emit(
          `token exchange failed for character ${characterId} / client `
          + `${JSON.stringify(clientId)}: no refresh token could be issued (${failure}).`,
        );
        return errorResponse(
          500,
          "server_error",
          `This server could not issue a refresh token (${failure}).`,
        );
      }
      token = issued.token;

      // The binding goes here: after `issue` succeeded, before the access token is
      // minted. The refresh grant is live the moment `issue` returns, so it must be
      // revocable from that moment. Binding after the mint would leave a grant no
      // replay can kill if the mint fails: the caller gets a 500 and no tokens, but
      // the grant exists and is refreshable by anyone holding the unsent token.
      //
      // Only the authorization-code path supplies `bindGrant`.
      if (typeof bindGrant === "function") {
        const record = issued.record !== null && typeof issued.record === "object"
          ? issued.record
          : {};
        // Handed over exactly as the store wrote it. `rememberGrant` refuses anything
        // unusable instead of throwing, so there is nothing to check here.
        bindGrant(record.family);
      }
    }

    let minted;
    try {
      minted = mintAccessToken({ characterId, clientId, scopes }) || {};
    } catch (err) {
      // The one dependency documented as throwing: `lib/accessToken.js` `mint`
      // raises `AccessTokenError` for an unusable argument, where `lib/authCodes.js`
      // and `lib/refreshTokens.js` promise not to throw on the request path. Caught
      // here so the answer keeps the OAuth error shape and the log names this
      // endpoint, rather than falling to `server.js`'s dispatch guard.
      emit(
        `token exchange failed for character ${characterId} / client `
        + `${JSON.stringify(clientId)}: minting the access token threw (${describeError(err)}).`,
      );
      return errorResponse(500, "server_error", "This server could not sign an access token.");
    }

    if (typeof minted.token !== "string" || minted.token === "") {
      emit(
        `token exchange failed for character ${characterId} / client `
        + `${JSON.stringify(clientId)}: the access token minter returned `
        + `${describeValue(minted.token)}.`,
      );
      return errorResponse(500, "server_error", "This server could not sign an access token.");
    }

    // `expires_in` is the minter's, copied rather than computed. Checked only for
    // being a usable number, not for being 1199-1200: the lifetime is
    // `lib/accessToken.js`'s (`LIFETIME_SECONDS`, with an injectable
    // `lifetimeSeconds`), and clamping it here would make `expires_in` disagree
    // with the token's `exp`.
    if (!Number.isInteger(minted.expiresIn) || minted.expiresIn <= 0) {
      emit(
        `token exchange failed for character ${characterId} / client `
        + `${JSON.stringify(clientId)}: the access token minter returned `
        + `${describeValue(minted.expiresIn)} for expiresIn.`,
      );
      return errorResponse(
        500,
        "server_error",
        "This server could not determine how long the access token is valid for.",
      );
    }

    return tokenResponse({
      accessToken: minted.token,
      expiresIn: minted.expiresIn,
      refreshToken: token,
    });
  }

  // The request

  function handle(request) {
    const method = String((request && request.method) || ALLOWED_METHOD).toUpperCase();
    if (method !== ALLOWED_METHOD) {
      return errorResponse(
        405,
        "invalid_request",
        `The token endpoint answers ${ALLOWED_METHOD} requests only. See ALLOWED_METHOD for `
        + "why HEAD and OPTIONS are not on that list.",
        { allow: ALLOWED_METHOD },
      );
    }

    const contentType = mediaTypeOf(readHeader(request, "content-type"));
    if (contentType !== REQUEST_CONTENT_TYPE) {
      // A `400 invalid_request` rather than a `415`. RFC 6749 section 5.2 defines no
      // status but `400` for a malformed request, and an OAuth client library that
      // meets a `415` typically reports a transport failure with no `error` in it.
      return errorResponse(
        400,
        "invalid_request",
        `A token request must be sent as ${REQUEST_CONTENT_TYPE}; this one declared `
        + `${contentType === null || contentType === "" ? "no content type" : contentType}.`,
      );
    }

    const rawBody = request && request.rawBody;
    const size = Buffer.isBuffer(rawBody) ? rawBody.length : String(rawBody || "").length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      return errorResponse(
        400,
        "invalid_request",
        `The request body is ${size} bytes; a token request is at most `
        + `${MAX_REQUEST_BODY_BYTES}.`,
      );
    }

    const parsed = parseFormBody(rawBody);
    if (parsed.failure !== undefined) {
      return errorResponse(400, "invalid_request", parsed.failure);
    }
    const fields = parsed.fields;

    // Authentication comes first, before the grant is inspected and before
    // anything is consumed. `authenticate` gets the headers and the parsed body
    // because `client_secret_basic` lives in one and `client_secret_post` in the
    // other; choosing between them is `lib/clientAuth.js`'s job.
    // `body` is passed as a plain object, not the `Map` this route reads. It is
    // prototype-less (`Object.create(null)`): a form body may contain `__proto__=`
    // or `constructor=`, which on an ordinary object would be a prototype write
    // that makes every unset field appear to have a value.
    const body = Object.create(null);
    for (const [name, value] of fields) body[name] = value;

    const client = clientAuth.authenticate({
      headers: (request && request.headers) || {},
      body,
    }) || {};

    if (client.ok !== true) {
      // RFC 6749 section 5.2's split: a client that attempted to authenticate
      // through the Authorization header gets `401` with a `WWW-Authenticate`; one
      // that authenticated in the body, or not at all, gets `400`.
      //
      // `401` plus `WWW-Authenticate` is the HTTP challenge handshake, so sending it
      // to a client that never used the header invites a retry down an unused path,
      // and a bare `400` to one that did leaves a conforming HTTP client with no
      // challenge to answer. Only `invalid_client` is eligible; any other
      // `authenticate` failure is a `400`.
      const usedHeader = readHeader(request, "authorization") !== undefined;
      return refusalFrom(client, "invalid_client", 400, usedHeader);
    }

    const clientId = client.clientId;
    const authenticated = client.authenticated === true;

    const grantType = fields.get("grant_type");
    if (grantType === undefined || grantType === "") {
      return errorResponse(400, "invalid_request", "grant_type is required.");
    }

    if (grantType === GRANT_TYPE.AUTHORIZATION_CODE) {
      return handleAuthorizationCode({ fields, clientId, authenticated });
    }

    if (grantType === GRANT_TYPE.REFRESH_TOKEN) {
      return handleRefreshToken({ fields, clientId });
    }

    // `unsupported_grant_type`, which RFC 6749 section 5.2 defines for this case,
    // status `400`. The grant type is not echoed: it is attacker-chosen text.
    return errorResponse(
      400,
      "unsupported_grant_type",
      `This server implements grant_type=${GRANT_TYPE.AUTHORIZATION_CODE} and `
      + `grant_type=${GRANT_TYPE.REFRESH_TOKEN}.`,
    );
  }

  return Object.freeze({
    // Optional as far as `lib/ssoDispatch.js` is concerned; it is what a
    // route-table error names instead of the route's index.
    name: "PostOauthToken",
    paths: Object.freeze([TOKEN_PATH]),
    handle,
  });
}

// Helpers used by the factory

/** Construction-time check with a message that says what to inject and why. */
function requireMethod(object, name, method) {
  if (!object || typeof object[method] !== "function") {
    throw new TypeError(
      `ESI mod: createOauthTokenRoute needs ${name}.${method}(). It is injected rather than `
      + "required so this route does not depend on the module that provides it.",
    );
  }
}

/**
 * A dependency's refusal, turned into a response without being reinterpreted.
 *
 * `lib/clientAuth.js` answers `{ok: false, error, errorDescription}` and both
 * members are returned as given, so the decision about what a failure is
 * called stays in the module that made the policy.
 *
 * The fallbacks cover a double or future version that answers `{ok: false}`
 * alone, which would otherwise produce a refusal no OAuth client can parse.
 */
function refusalFrom(answer, fallbackError, fallbackStatus, challengeIfInvalidClient = false) {
  const error = typeof answer.error === "string" && answer.error !== ""
    ? answer.error
    : fallbackError;
  const description = typeof answer.errorDescription === "string" && answer.errorDescription !== ""
    ? answer.errorDescription
    : "The request could not be authorised.";

  if (challengeIfInvalidClient && error === "invalid_client") {
    return errorResponse(401, error, description, { "www-authenticate": WWW_AUTHENTICATE });
  }

  return errorResponse(fallbackStatus, error, description);
}

/** An error as one short sentence, without a stack and without a log injection. */
function describeError(err) {
  const message = err && typeof err.message === "string" ? err.message : String(err);
  return JSON.stringify(message.slice(0, 200));
}

module.exports = Object.freeze({
  ACCESS_TOKEN_STILL_LIVE,
  ALLOWED_METHOD,
  CACHE_CONTROL,
  CONTENT_TYPE_JSON,
  GRANT_TYPE,
  INVALID_CODE_DESCRIPTION,
  INVALID_REFRESH_DESCRIPTION,
  KNOWN_PARAMETERS,
  MAX_REQUEST_BODY_BYTES,
  PRAGMA,
  REDEEM_OK,
  REFRESH_OK,
  REFRESH_SCOPE_NOT_SUBSET,
  REQUEST_CONTENT_TYPE,
  RESPONSE_MEMBER_ORDER,
  REVOKE_OK,
  TOKEN_PATH,
  TOKEN_TYPE,
  WWW_AUTHENTICATE,
  createOauthTokenRoute,
  mediaTypeOf,
  parseFormBody,
  scopesOf,
});
