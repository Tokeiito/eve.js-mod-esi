/**
 * `GET /.well-known/oauth-authorization-server`: how the EVE client finds the
 * token endpoint.
 *
 * A static document of thirteen members. It decides whether the EVE game client
 * itself works against this replica with no patch. Build 3396210's
 * `clientRefreshToken/` does this on every launch (`docs/d6-listener-split.md`
 * has the reduction):
 *
 *   1. take `iss` out of the token the launcher handed it,
 *   2. rewrite it into `<origin>/.well-known/oauth-authorization-server/`,
 *   3. GET that, retrying ten times a second apart,
 *   4. read `token_endpoint` out of the JSON and refresh against it.
 *
 * Only on failure does it fall back to hardcoded `login.eveonline.com` values,
 * which on a private server reach CCP and fail. The failure shows up about
 * twenty minutes into a session rather than at launch.
 *
 * Three things look like bugs and are load-bearing. Clients string-compare all
 * three, and design constraint 3 (fidelity beats hygiene) applies:
 *
 *   `issuer` has no trailing slash. OAuth/OIDC issuer comparison is exact string
 *   comparison, so a validator configured with the slashed form rejects every
 *   token from the unslashed one. `config.js` refuses a configured issuer that
 *   ends in a slash.
 *
 *   `jwks_uri` is under `/oauth/`, everything else under `/v2/oauth/`. A client
 *   that cached this document asks for that exact path. A route table written
 *   by pattern ("the SSO endpoints are `/v2/oauth/*`") would mount the JWKS at
 *   `/v2/oauth/jwks` while this document advertises `/oauth/jwks`; token issue
 *   still succeeds and only signature verification fails, late.
 *
 *   `id_token_signing_alg_values_supported` says `HS256` while access tokens are
 *   signed `RS256`. That is CCP's document contradicting CCP's own JWKS, live.
 *   It is inert in an OAuth authorization-server document, from which the EVE
 *   client reads `token_endpoint` and nothing else; see below for why these
 *   bytes are not served at the OpenID Connect path.
 *
 * A fourth member looks like the same bug and is not:
 * `token_endpoint_auth_signing_alg_values_supported: ["HS256"]` is correct, as
 * those are the algorithms for `client_secret_jwt`, which is HMAC. The bug next
 * to it was probably copied one member up. And `userinfo_endpoint` is
 * `/v2/oauth/verify`, not `/userinfo`: CCP's verify endpoint predates the OIDC
 * framing.
 *
 * Two paths, one document. CCP publishes `/.well-known/oauth-authorization-server`.
 * The EVE client asks for the same path with a trailing slash (`WELL_KNOWN_PATH`
 * is that literal). Both are served, as two exact paths onto one handler. A
 * redirect is the alternative, but whether the client's fetch follows a 3XX is
 * unobserved, and it gets ten attempts before the session degrades.
 *
 * `/.well-known/openid-configuration` is considered and not served:
 *
 *   The document would become wrong by being moved. On an OAuth document
 *   `id_token_signing_alg_values_supported` is a member nothing reads. On an
 *   OpenID Connect document it is the member a client uses to pick how to verify
 *   an ID token, so a library that probed OIDC-first would fail verification
 *   against a correctly signed RS256 token. Correcting the member for the OIDC
 *   copy alone would fork one document into two that must never disagree.
 *
 *   It would claim something not implemented. A document served as
 *   `openid-configuration` asserts OpenID Connect, and this replica issues no
 *   `id_token` and publishes no `scopes_supported`.
 *
 *   Fidelity gives no direction. CCP does not serve it, and libraries that
 *   probe it already handle the fallback. What CCP answers there (404, a 301 to
 *   the OAuth path, something else) is unobserved (`contract/sso.js`
 *   `UNOBSERVED`). The path falls through to `lib/ssoDispatch.js`'s bodiless 404,
 *   marked there as ours rather than a reproduction.
 *
 * It would be reopened by a real consumer that probes OIDC-first and does not
 * fall back. The document would then be served there with
 * `id_token_signing_alg_values_supported` corrected to what is signed, as a
 * recorded divergence.
 *
 * `createOauthDiscoveryRoute({ issuer })` takes nothing else. This file requires
 * no mod module (not `../config`, not `contract/sso.js`, which is test-only and
 * never deployed, D20; not `lib/cors.js`), so the route is testable by calling
 * `handle` with an object literal.
 */

"use strict";

// The constants, and why they are duplicated
//
// `contract/sso.js` holds these as the transcription of record, with the
// observation date and the reasoning for each. It cannot be imported here:
// `contract/` is test-only and not part of the deployable artifact (D20;
// `lib/sourceHash.js` hashes `loader.js`, `config.js`, `server.js`, `lib/` and
// `routes/`, and `scripts/deploy-mod.js` copies exactly those). `lib/cors.js`
// and `lib/headers.js` duplicate in the same way, and
// `test/discoveryContract.test.js` asserts the copies agree member for member
// and path for path.

/**
 * Both spellings, CCP's first.
 *
 * Anything treating the head as canonical picks the path CCP publishes; the
 * dispatch matches both exactly.
 */
const DISCOVERY_PATHS = Object.freeze([
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/",
]);

/**
 * The path component of every endpoint the document advertises.
 *
 * Paths, never URLs: each becomes `<issuer> + <path>`, which keeps CCP's origin
 * out of this file and so out of any document this replica serves.
 *
 * `jwks` is the one under `/oauth/` rather than `/v2/oauth/`; see the header.
 */
const ENDPOINT_PATHS = Object.freeze({
  authorization: "/v2/oauth/authorize",
  token: "/v2/oauth/token",
  userinfo: "/v2/oauth/verify",
  jwks: "/oauth/jwks",
  revocation: "/v2/oauth/revoke",
});

/**
 * Which member each endpoint becomes.
 *
 * Data rather than a `switch`, because the names are not derivable: `jwks` takes
 * `_uri` and the other four take `_endpoint`. The assembler walks `MEMBER_ORDER`
 * and looks members up here.
 */
const ENDPOINT_MEMBERS = Object.freeze({
  authorization_endpoint: "authorization",
  token_endpoint: "token",
  userinfo_endpoint: "userinfo",
  jwks_uri: "jwks",
  revocation_endpoint: "revocation",
});

/**
 * The members with no issuer in them, copied verbatim.
 *
 * `id_token_signing_alg_values_supported` is the preserved contradiction and
 * `token_endpoint_auth_signing_alg_values_supported` beside it is correct (see
 * the header); the two are one careless edit apart.
 *
 * Nothing is added. Some libraries read a discovery document as a closed
 * statement of capability, so publishing `scopes_supported` or
 * `grant_types_supported`, which CCP does not, is the same divergence as
 * dropping a member CCP does publish.
 */
const CONSTANTS = Object.freeze({
  response_types_supported: Object.freeze(["code", "token"]),
  subject_types_supported: Object.freeze(["public"]),
  revocation_endpoint_auth_methods_supported: Object.freeze([
    "client_secret_basic",
    "client_secret_post",
    "client_secret_jwt",
  ]),
  token_endpoint_auth_methods_supported: Object.freeze([
    "client_secret_basic",
    "client_secret_post",
    "client_secret_jwt",
  ]),
  id_token_signing_alg_values_supported: Object.freeze(["HS256"]),
  token_endpoint_auth_signing_alg_values_supported: Object.freeze(["HS256"]),
  code_challenge_methods_supported: Object.freeze(["S256"]),
});

/**
 * Top-level member order, exactly as observed. It is not an order anyone would
 * choose: `response_types_supported` sits between `userinfo_endpoint` and
 * `jwks_uri`, splitting the endpoint members into two runs, and
 * `subject_types_supported` lands after `revocation_endpoint`. It cannot be
 * derived, so it is written down.
 *
 * No JSON parser cares about member order and no known client depends on it. It
 * is reproduced because matching costs one array (the same bet `lib/headers.js`
 * makes about `Etag`).
 *
 * This array is also the document's membership: `buildDiscoveryDocument` walks
 * it, so a member in neither `ENDPOINT_MEMBERS` nor `CONSTANTS` cannot be
 * written.
 */
const MEMBER_ORDER = Object.freeze([
  "issuer",
  "authorization_endpoint",
  "token_endpoint",
  "userinfo_endpoint",
  "response_types_supported",
  "jwks_uri",
  "revocation_endpoint",
  "subject_types_supported",
  "revocation_endpoint_auth_methods_supported",
  "token_endpoint_auth_methods_supported",
  "id_token_signing_alg_values_supported",
  "token_endpoint_auth_signing_alg_values_supported",
  "code_challenge_methods_supported",
]);

// How it is served, and which parts of that are ours
//
// It is unauthenticated, CORS-open and cacheable, with no response header
// recorded. `contract/sso.js` `UNOBSERVED` names the gap: no
// content-type spelling, no `Cache-Control`, no `max-age`, no `Etag`, no `Vary`,
// and no answer on whether the body ends with a newline. None may be borrowed
// from `contract/wire.js`: those are facts about `esi.evetech.net`'s two
// producers, and `login.eveonline.com` is different software on a different
// hostname.
//
// So every value below is ours, chosen deliberately and marked as a choice
// (D23), to be replaced by whatever
// `curl -sD - https://login.eveonline.com/.well-known/oauth-authorization-server`
// shows.

/**
 * `application/json`, bare.
 *
 * Ours. RFC 8414 section 3.2 defines the authorization server metadata response
 * as `application/json`. No `charset` parameter: JSON is UTF-8 by definition
 * (RFC 8259), so one would invent detail.
 */
const CONTENT_TYPE = "application/json";

/**
 * Ten minutes.
 *
 * The requirement is cacheable with no directive stated, so the trade-off is
 * ours: a long TTL keeps a stale `token_endpoint` after the issuer changes, a
 * short one costs a small request per client per window.
 *
 * 600 s is shorter than an access token's 20-minute lifetime, so a client whose
 * cached document went stale re-fetches it before the token that pointed it
 * there expires, and an issuer change self-heals within one token generation.
 * `public` because nothing in it is per-caller.
 *
 * No `Etag` and no `Last-Modified`. Both are unobserved, and neither has an
 * honest value: the document is assembled from constants and a configured
 * string, so its last modification is the process start, which would tell a
 * client the document changed on every restart.
 */
const CACHE_TTL_SECONDS = 600;
const CACHE_CONTROL = `public, max-age=${CACHE_TTL_SECONDS}`;

/**
 * CORS-open.
 *
 * Deliberately not imported from `lib/cors.js`. That module's `*` is an
 * observation about `esi.evetech.net`, recorded with ten ESI header names it
 * exposes (`X-Pages`, the error-limit pair, the four `X-Ratelimit-` names), none
 * of which this response sends. Importing the constant would tie an SSO
 * requirement to an ESI observation, and `corsHeaders()` would advertise an
 * expose-list for headers this origin does not have.
 *
 * No `Access-Control-Expose-Headers`: everything a client needs is in the body,
 * and the response's own headers are on the browser's default safe list.
 */
const ALLOW_ORIGIN = "*";

/**
 * GET only, and the refusal is ours.
 *
 * No status, method restriction or `Allow` is recorded for these paths, and
 * there is no SSO equivalent of `contract/wire.js` to inherit one from (D23).
 *
 * `Allow: GET`, without `HEAD`. The ESI side advertises `HEAD` beside `GET` and
 * then refuses it, which is reproduced there because it was observed there;
 * carrying it onto this origin would invent an observation.
 *
 * `OPTIONS` is refused with everything else rather than answered as a CORS
 * preflight. Discovery is fetched as a plain `GET` with no custom headers,
 * which a browser never preflights, and `lib/cors.js`'s preflight is six
 * specific headers observed on ESI.
 */
const ALLOWED_METHOD = "GET";

/**
 * The body's last byte, which nobody has observed.
 *
 * No trailing newline: `JSON.stringify` output as-is, the minimum claim.
 * `lib/serialize.js` gives ESI's producers a newline or not because a survey
 * says which; there is none here. Compact rather than pretty-printed for the
 * same reason: pretty-printed JSON in a requirements document is a parse
 * rendered for a human, not a capture.
 */

/**
 * Assemble the document for one issuer.
 *
 * Walks `MEMBER_ORDER`, so member order is the observed one by construction and
 * a member with no source cannot appear.
 *
 * Every absolute URL is `issuer + path` from the one issuer string, as
 * `docs/d6-listener-split.md` commits option A to, and `issuer` is that same
 * string unchanged, which is why it must arrive with no trailing slash.
 *
 * A fresh object every call, arrays included, so no caller can mutate a shared
 * constant through the document it was handed.
 *
 * @param {string} issuer  the configured issuer, e.g. `http://host.local:26006`
 * @returns {object}
 */
function buildDiscoveryDocument(issuer) {
  const document = {};

  for (const member of MEMBER_ORDER) {
    if (member === "issuer") {
      document.issuer = issuer;
      continue;
    }

    const endpoint = ENDPOINT_MEMBERS[member];
    if (endpoint !== undefined) {
      document[member] = `${issuer}${ENDPOINT_PATHS[endpoint]}`;
      continue;
    }

    document[member] = [...CONSTANTS[member]];
  }

  return document;
}

/**
 * The route, for the table `loader.js` hands to `createSsoDispatch`.
 *
 * The issuer is checked here at construction even though `config.js` has
 * validated it: a route built with `{}` in a test would otherwise serve
 * `undefined/v2/oauth/token`. Throwing is right rather than degrading, as
 * `createRequestHandler` does for a missing `dispatch`.
 *
 * The body is serialized once, at construction, and served as the same string
 * for the life of the process. Nothing in it depends on the request, and it
 * keeps `JSON.stringify` off the game's event loop, including the ten fetches in
 * ten seconds an EVE client makes when retrying.
 *
 * @param {{issuer: string}} deps
 */
function createOauthDiscoveryRoute(deps) {
  const issuer = deps && deps.issuer;
  if (typeof issuer !== "string" || issuer === "") {
    throw new TypeError(
      "ESI mod: createOauthDiscoveryRoute needs the configured issuer (ESI_MOD_SSO_ISSUER); "
        + "every absolute URL in the discovery document is built from it.",
    );
  }
  if (issuer.endsWith("/")) {
    // `config.js` refuses this, so reaching it means a hand-built one. Checked
    // anyway because the damage is silent: `issuer + "/oauth/jwks"` becomes
    // `//oauth/jwks`, which some clients normalize and some fetch verbatim.
    throw new TypeError(
      `ESI mod: the issuer must not end with a slash, got "${issuer}": the document's URLs `
        + "are built by appending to it, and clients compare `issuer` as an exact string.",
    );
  }

  const body = JSON.stringify(buildDiscoveryDocument(issuer));

  return Object.freeze({
    name: "OauthDiscovery",
    paths: DISCOVERY_PATHS,
    handle(request) {
      const method = String((request && request.method) || "").toUpperCase();
      if (method !== ALLOWED_METHOD) {
        // Bodiless: what CCP sends in a 405 body on this origin is unobserved, and
        // `Allow` is the part a client acts on.
        return { status: 405, headers: { allow: ALLOWED_METHOD } };
      }

      return {
        status: 200,
        headers: {
          // Lowercase throughout. `server.js`'s `mergeHeaders` puts every name through
          // `lib/headers.js` on the way to the socket, so these leave as `Content-Type`,
          // `Cache-Control` and so on, with one casing implementation for both listeners.
          "content-type": CONTENT_TYPE,
          "cache-control": CACHE_CONTROL,
          "access-control-allow-origin": ALLOW_ORIGIN,
        },
        // A string, so member order and the final byte are this route's decision and not
        // a downstream serializer's. `server.js` writes a string body verbatim.
        body,
      };
    },
  });
}

module.exports = Object.freeze({
  ALLOWED_METHOD,
  ALLOW_ORIGIN,
  CACHE_CONTROL,
  CACHE_TTL_SECONDS,
  CONSTANTS,
  CONTENT_TYPE,
  DISCOVERY_PATHS,
  ENDPOINT_MEMBERS,
  ENDPOINT_PATHS,
  MEMBER_ORDER,
  buildDiscoveryDocument,
  createOauthDiscoveryRoute,
});
