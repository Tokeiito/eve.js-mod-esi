/**
 * `GET /oauth/jwks`: the public half of the signing key, and nothing else.
 *
 *   {"keys":[{"alg":"RS256","e":"AQAB","kid":"JWT-Signature-Key","kty":"RSA",
 *             "use":"sig","n":"..."}],"SkipUnresolvedJsonWebKeys":true}
 *
 * A wrong JWKS fails late and in someone else's process: the token is minted
 * and stored, and verification fails on the first protected call with an error
 * about the key rather than about this server.
 *
 * The path is not under `/v2/`. The discovery document's `jwks_uri` says so
 * and cached clients repeat it. The version dimension is ESI's alone (D6), and
 * there is no trailing-slash spelling: the discovery document is served at two
 * spellings only because the EVE client was observed asking for the second, and
 * nothing equivalent was observed here. `contract/sso.js` `JWKS_PATH` has the
 * full note; `PATH` below is the deployable copy and the test asserts they
 * agree.
 *
 * `contract/sso.js` is the authority for every literal here and is not
 * required: `contract/` is test-only and never deployed (`lib/sourceHash.js`
 * `HASHED_DIRS` is `lib` and `routes`; `scripts/deploy-mod.js` copies that
 * manifest), so requiring it would load in the suite and throw
 * `MODULE_NOT_FOUND` in the game process (design constraint 2).
 * `lib/cors.js`, `lib/headers.js` and `lib/serialize.js` do the same, and
 * `test/jwksContract.test.js` asserts the copies agree member for member.
 *
 * `getJwks` is injected and returns the published form: six string members per
 * key, all public. No key generation, file read or PEM happens here, so no
 * private material can reach a response, which is what makes it safe for the
 * 500 below to name what is wrong with a key. The key set is an array from the
 * first day, so adding a second key during a rotation needs no rewrite.
 */

"use strict";

const { ALLOW_ORIGIN, DEFAULT_ALLOW_HEADERS, MAX_AGE, PREFLIGHT_STATUS, PREFLIGHT_VARY } = require(
  "../lib/cors",
);

// The document's literals (contract/sso.js is the authority)

/** `contract/sso.js` `JWKS_PATH`. Not under `/v2/`; see the header. */
const PATH = "/oauth/jwks";

/**
 * `contract/sso.js` `JWKS_KID`: a literal string, not a thumbprint.
 *
 * JOSE libraries will compute an RFC 7638 thumbprint, which is correct on an
 * unpinned surface, but third-party validators have pinned this literal. A
 * derived `kid` is correct by the RFC and unverifiable by the ecosystem.
 */
const KID = "JWT-Signature-Key";

/**
 * `contract/sso.js` `JWKS_ALG`. This server publishes RS256 and signs with
 * RS256.
 *
 * Real CCP publishes an ES256 key alongside it and signs with neither, using
 * RS256. Narrowing to the one key is safe for a client that selects by `kid`
 * or `alg`, which is what every client in the ecosystem survey does, and not
 * for anything that walks the array to index 1. Nothing observed does that,
 * which is evidence and not a guarantee. The difference is kept as data in
 * `contract/sso.js` `JWKS_CCP_EXTRA_ALGS`.
 */
const ALG = "RS256";

/**
 * The two members implied by `ALG`, from `contract/sso.js` `JWKS_KEY_CONSTANTS`.
 *
 * RS256 is RSASSA-PKCS1-v1_5 with SHA-256, which has no other `kty`, and a key
 * advertised for signature verification has no other `use`. They are written
 * down rather than inferred because a byte comparison cannot check "implied".
 */
const KEY_TYPE = "RSA";
const KEY_USE = "sig";

/**
 * `contract/sso.js` `JWKS_KEY_MEMBER_ORDER`: the member order inside a key.
 *
 * Alphabetical for five members and then `n` last, which is what a .NET
 * serializer emits (see `TRAILING_NEWLINE` below).
 */
const KEY_MEMBER_ORDER = Object.freeze(["alg", "e", "kid", "kty", "use", "n"]);

/** `contract/sso.js` `JWKS_MEMBER_ORDER`: `keys` first, then the .NET artefact. */
const KEYS_MEMBER = "keys";
const SKIP_UNRESOLVED_MEMBER = "SkipUnresolvedJsonWebKeys";
const SKIP_UNRESOLVED_VALUE = true;
const MEMBER_ORDER = Object.freeze([KEYS_MEMBER, SKIP_UNRESOLVED_MEMBER]);

// Member order is built, not written

/**
 * One key object, with its members inserted in `KEY_MEMBER_ORDER`.
 *
 * An object literal in the right order produces identical bytes until someone
 * sorts it alphabetically. Driving insertion from the array makes the order
 * visibly protocol and makes `contract/sso.js`'s copy load-bearing.
 *
 * Same mechanism as `lib/serialize.js` `projection`: insertion order is output
 * order for every non-integer-like string key. All six names are alphabetic.
 *
 * Member order is semantically irrelevant, but some clients hold cached
 * fixtures recorded from CCP and compare whole documents. `contract/sso.js`
 * notes that no client in the ecosystem survey is known to do this; matching
 * costs one array, and design constraint 3 says fidelity beats hygiene.
 */
function orderKey(jwk) {
  const ordered = {};
  for (const member of KEY_MEMBER_ORDER) ordered[member] = jwk[member];
  return ordered;
}

/**
 * The whole document, as a value: `keys` first, then the artefact.
 *
 * `MEMBER_ORDER` drives this loop as `KEY_MEMBER_ORDER` drives the one above,
 * and adds one fact: the .NET artefact comes second, as CCP was observed doing.
 */
function buildJwksDocument(keys) {
  const source = {
    [KEYS_MEMBER]: keys.map(orderKey),
    [SKIP_UNRESOLVED_MEMBER]: SKIP_UNRESOLVED_VALUE,
  };

  const document = {};
  for (const member of MEMBER_ORDER) document[member] = source[member];
  return document;
}

/**
 * The bytes. A string, not an object, because the member order is protocol
 * only if this route is the last thing to touch it.
 *
 * `lib/serialize.js` is wrong here twice over. `projection()` refuses the field
 * name `SkipUnresolvedJsonWebKeys` (it enforces the snake_case that all 531
 * property names in CCP's ESI spec obey), and `serializeBody()` demands a
 * producer, a fact about which of ESI's two implementations answers a route,
 * which has no answer on a different hostname.
 *
 * TRAILING_NEWLINE: there is none. This is ours, not CCP's
 * (`contract/sso.js` `UNOBSERVED.trailingNewline`: nobody has read a
 * `content-length` off `login.eveonline.com`). The newline in
 * `lib/serialize.js` belongs to ESI's Go gateway (`json.Encoder.Encode`) and
 * does not transfer to another origin. `SkipUnresolvedJsonWebKeys` is a
 * Microsoft.IdentityModel artefact and .NET's serializer appends no newline, so
 * no newline is a reading of that evidence, not a capture.
 */
function serializeJwks(keys) {
  return JSON.stringify(buildJwksDocument(keys));
}

// Caching

/**
 * `max-age`. It is ours: the requirement says "cacheable" without a number, and
 * `contract/sso.js` `UNOBSERVED.cacheHeaders` records that nobody has read one
 * off CCP.
 *
 * Two failures bound it:
 *
 *   - Too long: a client holding the document past a key change cannot verify
 *     tokens signed by the new key, and fails with "signature verification
 *     failed", which reads like a compromised token. `contract/sso.js`
 *     `JWKS_KID` notes the aggravating factor: the `kid` is a literal, so a new
 *     key with the same `kid` is invisible to the cache-by-`kid` refetch, and
 *     there is no overlap window.
 *   - Too short: a validator with no cache fetches this on every token it
 *     checks, on the listener the game's event loop shares.
 *
 * 300 seconds. An access token lives 20 minutes (`docs/d6-listener-split.md`),
 * so a key change that keeps the old key published for token lifetime plus this
 * max-age (25 minutes) is unobservable to clients.
 *
 * `public` because the document is the same bytes for every caller. No
 * `must-revalidate` or `stale-if-error`: those are ESI gateway spellings in
 * `lib/cache.js`.
 */
const CACHE_TTL_SECONDS = 300;
const CACHE_CONTROL = `public, max-age=${CACHE_TTL_SECONDS}`;

/**
 * There is deliberately no `Etag` and no `Expires`.
 *
 * `Expires` is HTTP/1.0's spelling of what `Cache-Control` says, and a second
 * copy of the number is a second place to be wrong.
 *
 * An `Etag` is a promise: it invites `If-None-Match`, and nothing on this
 * listener answers that with a `304`. `lib/cache.js` has the conditional
 * machinery, but D6 keeps the ESI pipeline (error limiter, token bucket, cache
 * layer) off SSO traffic, so wiring it in would re-litigate D6 to save a few
 * hundred bytes every five minutes. At `max-age=300` a cold client fetches
 * twelve times an hour, and a `304` would save bytes but no round trips. If the
 * key set becomes dynamic, an `Etag` over the `kid` list is the natural
 * addition.
 */

/**
 * `content-type`. It is ours (`contract/sso.js` `UNOBSERVED.contentType`).
 *
 * RFC 7517 registers `application/jwk-set+json`. This sends `application/json`
 * so that a standard JWT library works with no special configuration, since a
 * library that sniffs the type is checking for JSON. Bare, with no `charset`,
 * because JSON is UTF-8 by definition (RFC 8259 section 8.1) and an unobserved
 * parameter is a guess.
 */
const CONTENT_TYPE = "application/json";

// Methods

/**
 * `GET`, `HEAD`, `OPTIONS`. The `Allow` value is the same string, so the
 * refusal and the advertisement cannot drift apart.
 *
 * `HEAD` is answered because caches and health checks use it, and a `405`
 * would make a probing client conclude the endpoint is absent. It runs the
 * `GET` path and returns the same status, headers and body. Node's
 * `ServerResponse` suppresses the body for `HEAD` itself, so the framed
 * `content-length` stays truthful; blanking the body here would require
 * correcting `content-length` by hand, and a `content-length` that disagrees
 * with the bytes is a framing bug no client recovers from.
 *
 * `OPTIONS` is answered because the endpoint is CORS-open and a browser-based
 * validator preflights as soon as it sends a custom header. This diverges from
 * `lib/cors.js` on purpose: ESI splits `OPTIONS` into preflight and ordinary
 * and answers the second with `405`, a reproduction of observed ESI behaviour.
 * Nothing has been observed here, so one answer for both.
 *
 * Every other method gets `405`.
 */
const ALLOWED_METHODS = Object.freeze(["GET", "HEAD", "OPTIONS"]);
const ALLOW = ALLOWED_METHODS.join(", ");

// An unusable key set is a 500

/**
 * Everything wrong with what `getJwks` returned, as a list of sentences, so one
 * restart tells an operator everything.
 *
 * Each rule is a way a document can parse cleanly and still be unusable:
 *
 *   - Not an array, or empty. See `refuse()` for why this is a `500`.
 *   - A missing or non-string member. `JSON.stringify` drops an `undefined`
 *     value silently, so a key missing its `n` serializes to a valid-looking
 *     JWK with five members and fails inside a third party's JOSE library
 *     with something opaque. This is `lib/serialize.js`'s "undefined from a
 *     projection getter throws" rule on the one surface that cannot use
 *     `projection()`.
 *   - A wrong `alg`, `kty` or `use`. This replica signs with RS256 only, and
 *     publishing another kind advertises a signature nothing will produce.
 *     Real CCP also publishes an ES256 key (`contract/sso.js`
 *     `JWKS_CCP_EXTRA_ALGS`); narrowing is deliberate, and adding a second
 *     algorithm requires widening this check, which then fails in the signing
 *     key's own tests rather than in someone else's validator.
 *   - No key with the literal `kid`. A validator with `JWT-Signature-Key`
 *     pinned reads a document without it as having no keys, and reports it as a
 *     signature failure. It must appear somewhere, not on every key and not
 *     necessarily first: a literal `kid` leaves rollover no overlap window
 *     (`contract/sso.js` `JWKS_KID`), and the document a pinned validator reads
 *     must still contain the `kid` it pinned.
 *
 * @param {unknown} keys
 * @returns {string[]}  empty when the set is publishable
 */
function findKeySetProblems(keys) {
  if (!Array.isArray(keys)) {
    return [`getJwks() returned ${describeValue(keys)}, and the key set must be an array.`];
  }
  if (keys.length === 0) {
    return ["getJwks() returned no keys, so this replica has nothing to publish."];
  }

  const problems = [];

  keys.forEach((jwk, index) => {
    if (jwk === null || typeof jwk !== "object" || Array.isArray(jwk)) {
      problems.push(`keys[${index}] is ${describeValue(jwk)}, not a JWK object.`);
      return;
    }

    for (const member of KEY_MEMBER_ORDER) {
      const value = jwk[member];
      if (typeof value !== "string" || value === "") {
        problems.push(
          `keys[${index}] has no usable "${member}" (${describeValue(value)}); a JWK member is a `
            + "non-empty string.",
        );
      }
    }

    for (const [member, expected] of [["alg", ALG], ["kty", KEY_TYPE], ["use", KEY_USE]]) {
      if (jwk[member] !== undefined && jwk[member] !== expected) {
        problems.push(
          `keys[${index}] has "${member}": ${JSON.stringify(jwk[member])}, and this replica `
            + `publishes only ${ALG} keys, so it must be ${JSON.stringify(expected)}.`,
        );
      }
    }
  });

  if (!keys.some((jwk) => jwk !== null && typeof jwk === "object" && jwk.kid === KID)) {
    problems.push(
      `no key carries the pinned kid ${JSON.stringify(KID)}; third-party validators hold that `
        + "literal and read a document without it as a document with no keys.",
    );
  }

  return problems;
}

/** `null`, `undefined`, `an array`, `the number 3`, `the empty string`. */
function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (value === "") return "the empty string";
  return `the ${typeof value} ${JSON.stringify(value)}`;
}

/**
 * The refusal body shape. It is ours: nothing about CCP's SSO error bytes has
 * been observed, and `lib/errors.js` reproduces ESI's shapes, which belong to a
 * different origin.
 *
 * RFC 6749 section 5.2's `{error, error_description}` is the shape every OAuth
 * client on this listener already parses.
 *
 * The description names what is wrong, on an unauthenticated endpoint, on
 * purpose. Everything this route sees is public (six string members of a public
 * key, or their absence), no code path touches private material, and an
 * operator debugging a replica that will not verify its own tokens reads the
 * response before a log line; this route has no logger injected.
 */
function refuse(status, error, description) {
  return {
    status,
    headers: {
      "content-type": CONTENT_TYPE,
      // No caching of a refusal: a cached 405 or 500 outlives the mistake that caused
      // it, and the fix then looks like it did not work.
      "cache-control": "no-store",
      "access-control-allow-origin": ALLOW_ORIGIN,
    },
    body: JSON.stringify({ error, error_description: description }),
  };
}

// The route

/**
 * The preflight, borrowed from `lib/cors.js` for its mechanics and overridden
 * for its one opinion.
 *
 * Borrowed: the `204`, the `*`, the 24-hour `Max-Age`, the
 * `Vary: Access-Control-Request-Headers`, and the quirk of echoing
 * `Access-Control-Request-Headers` back verbatim. These are the same on any
 * origin.
 *
 * Not borrowed: `ALLOW_METHODS`. ESI's is a fixed `GET, POST, PUT, DELETE` not
 * derived from the route (`/status/` accepts one method and advertises four),
 * an observed CCP quirk that must not be copied to a surface where it was not
 * observed. This names the three methods the route answers.
 *
 * Not borrowed: `EXPOSE_HEADERS`. Its ten names are ESI's `X-Pages`, `Etag` and
 * limiter headers, none of which this response carries.
 *
 * D6 is not strained: it keeps the ESI pipeline (error budget, token bucket,
 * `lib/cache.js`) off SSO traffic, not four constants and a header echo.
 */
function preflight(request) {
  const requested = readHeader(request, "access-control-request-headers");

  return {
    status: PREFLIGHT_STATUS,
    headers: {
      "access-control-allow-headers":
        requested === undefined || requested === "" ? DEFAULT_ALLOW_HEADERS : requested,
      "access-control-allow-methods": ALLOW,
      "access-control-allow-origin": ALLOW_ORIGIN,
      "access-control-max-age": MAX_AGE,
      allow: ALLOW,
      vary: PREFLIGHT_VARY,
    },
    body: "",
  };
}

/** Case-insensitive header read; `request.headers` may come from anywhere. */
function readHeader(request, name) {
  const headers = (request && request.headers) || {};
  if (headers[name] !== undefined) return headers[name];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

/**
 * `GET /oauth/jwks`, as a route the SSO dispatch can mount.
 *
 * The shape is `{ paths, handle }`, where `handle` returns
 * `{status, headers, body}` with `body` already a string. That is the SSO
 * listener's contract, not the ESI router's `handler(params, deps) -> value`.
 * On the ESI side `lib/pipeline.js` owns status, headers and bytes because many
 * endpoints agree about them; here there are four endpoints that agree about
 * almost nothing, and this document's member order is protocol, so the route
 * touches the bytes last.
 *
 * Header names are lowercase, this codebase's internal spelling
 * (`lib/cors.js` and `lib/errors.js` too). `lib/headers.js` `withCcpCasing` is
 * the one place a name becomes wire casing, applied by the listener.
 *
 * Only `getJwks` is injected: no clock, config, runtime or key module. The
 * endpoint is testable against a fixture without `lib/signingKey.js`.
 *
 * `getJwks` is called per request, not once at construction. The key set is
 * the one thing here that changes without a restart, and capturing it would
 * serve a rotated-away key until the server was bounced.
 *
 * @param {{ getJwks: () => object[] }} deps
 * @returns {{ paths: string[], handle: (request: object) => object }}
 */
function createOauthJwksRoute({ getJwks } = {}) {
  if (typeof getJwks !== "function") {
    throw new Error(
      "ESI mod: createOauthJwksRoute needs a getJwks() returning the published key set, active "
        + "key first. It is injected rather than required so this route does not depend on the "
        + "signing key module.",
    );
  }

  function handle(request) {
    const method = String((request && request.method) || "GET").toUpperCase();

    if (method === "OPTIONS") return preflight(request);

    if (method !== "GET" && method !== "HEAD") {
      const refusal = refuse(
        405,
        "invalid_request",
        `${method} is not a method this endpoint answers; the JWKS is a document, not a `
          + `resource. Allowed: ${ALLOW}.`,
      );

      // `Allow` as one comma-joined line, RFC 9110's spelling. `lib/errors.js`
      // `methodNotAllowed` sends repeated `Allow` lines because that is what ESI was
      // observed doing; nothing has been observed here, so this diverges from an
      // observation that does not reach this origin. Ours, per D23.
      return { ...refusal, headers: { ...refusal.headers, allow: ALLOW } };
    }

    const keys = getJwks();
    const problems = findKeySetProblems(keys);
    if (problems.length > 0) {
      return refuse(
        500,
        "server_error",
        `This replica cannot publish a usable JWKS: ${problems.join(" ")}`,
      );
    }

    // HEAD gets the body too. See ALLOWED_METHODS: Node drops it, and the
    // content-length stays honest.
    return {
      status: 200,
      headers: {
        "content-type": CONTENT_TYPE,
        "cache-control": CACHE_CONTROL,
        "access-control-allow-origin": ALLOW_ORIGIN,
      },
      body: serializeJwks(keys),
    };
  }

  return Object.freeze({
    // Optional as far as `lib/ssoDispatch.js` is concerned; it is what a
    // route-table error names instead of the route's index.
    name: "GetOauthJwks",
    // An array because the dispatch exact-matches `pathname` and the discovery
    // route needs two spellings. This one has one, by design: see the header.
    paths: Object.freeze([PATH]),
    handle,
  });
}

module.exports = Object.freeze({
  ALG,
  ALLOW,
  ALLOWED_METHODS,
  CACHE_CONTROL,
  CACHE_TTL_SECONDS,
  CONTENT_TYPE,
  KEYS_MEMBER,
  KEY_MEMBER_ORDER,
  KEY_TYPE,
  KEY_USE,
  KID,
  MEMBER_ORDER,
  PATH,
  SKIP_UNRESOLVED_MEMBER,
  SKIP_UNRESOLVED_VALUE,
  buildJwksDocument,
  createOauthJwksRoute,
  findKeySetProblems,
  serializeJwks,
});
