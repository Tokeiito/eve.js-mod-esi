/**
 * `POST /v2/oauth/revoke`: RFC 7009. It is the revocation capability D30
 * relies on.
 *
 *   token_type_hint=refresh_token&token=<refresh token>
 *
 *   HTTP/1.1 200 OK
 *   (no body)
 *
 * D30 declined refresh-token rotation on the argument that rotation buys theft
 * detection, not containment, and that revocation is the lock an operator
 * reaches for when a token is known lost. `routes/oauthToken.js` also points at
 * revocation: its authorization-code replay path logs that an operator should
 * revoke that character's refresh tokens by hand.
 *
 * 200 whether or not the token was valid. RFC 7009 section 2.2 responds 200
 * "if the token has been revoked successfully or if the client submitted an
 * invalid token". A status, header or body that forks on validity would let a
 * caller with a list of guesses learn which are real tokens without being able
 * to use one. `lib/refreshTokens.js`'s five outcomes are therefore flattened,
 * as `routes/oauthToken.js` flattens `authCodes`' three. The store keeps them
 * apart (`already_revoked` is idempotent; `unknown` means never issued here or
 * pruned) and the distinction goes to the log only: `already_revoked` states
 * that a real grant once existed.
 *
 * `persist_failed` is the exception. `lib/refreshTokens.js` instructs that a
 * revocation existing only in the process heap comes back at the next restart,
 * so this endpoint must not answer 200 to it. RFC 7009 section 2.2.1 defines
 * `503` for this case ("the client must assume the token still exists and may
 * retry after a reasonable delay"); it is a statement about this server's
 * disk, not the token. Residue: while the store is unwritable, a live token
 * gets `503` and garbage gets `200`, so an oracle exists for the length of a
 * disk failure. It is not attacker-triggerable, and a `200` to a revocation that
 * did not stick would tell the owner of a lost token that it is dead while it
 * still works.
 *
 * Client authentication: unauthenticated requests get `401`.
 * `clientAuth.authenticate` has three answers:
 *
 *   `{ok: false}`             the request identifies no client, or the
 *                             credential is wrong. 401.
 *   `{ok: true, authenticated: false}`  a public client: identity, no proof.
 *                             Accepted.
 *   `{ok: true, authenticated: true}`   a secret was checked. Accepted.
 *
 * Requiring `authenticated === true` would make the endpoint unreachable on a
 * default deployment, since `lib/clientRegistry.js` registers a secret only
 * where an operator configured one. A public client is accepted because:
 *
 *   - The token is the proof. A refresh token is a bearer credential: its
 *     holder can already mint access tokens through `routes/oauthToken.js`
 *     with no secret (the EVE client's own refresh works that way,
 *     `docs/d6-listener-split.md`). Revoking is strictly less.
 *   - CCP's discovery document understates this endpoint's methods.
 *     `contract/sso.js` `CCP_DISCOVERY_DOCUMENT` lists three `client_secret_*`
 *     methods and no `none` for `revocation_endpoint_auth_methods_supported`,
 *     and the identical three for `token_endpoint_auth_methods_supported`,
 *     where public clients demonstrably authenticate without a secret.
 *   - A deployment with no configured secret is a deployment of public clients,
 *     and PKCE plus the in-game bind (D3) stand in for the secret across this
 *     surface.
 *
 * Cost: on a default deployment, anyone who can reach port 26006 and holds a
 * refresh token can revoke it. With a configured secret, the confidential
 * client's Basic credential is still checked and a wrong one is a `401`.
 *
 * Ownership (RFC 7009 section 2.1) cannot be checked before acting:
 * `refreshTokens.revoke(token, {reason})` takes no client, and peeking with
 * `refresh` would write `lastUsedAt` and a counter on a record about to be
 * killed. The check happens after: `revoke` returns the record, which names its
 * client, and a mismatch is logged loudly. The response is still `200`, since
 * the non-disclosure rule of section 2.2 outranks section 2.1 when they
 * collide. Closing it properly needs `revoke(token, {clientId})` in
 * `lib/refreshTokens.js`; the exposure requires already holding the token.
 *
 * Timing is not equalised. Status, headers and body are byte-identical across
 * every outcome (`test/revokeContract.test.js` asserts it over the store's
 * whole enum), but a real revocation makes `lib/refreshTokens.js` rewrite its
 * store synchronously (temp file, `fsync`, `rename`; D30) while garbage returns
 * after a hash and a map miss. A caller measuring milliseconds on loopback can
 * tell them apart. Equalising would mean writing the file on every request on
 * the game's event loop (design constraint 2), so it is the store's
 * decision.
 *
 * Everything is injected: `createOauthRevokeRoute({clientAuth, refreshTokens,
 * log})`. The file requires no mod module, so `test/revokeContract.test.js`
 * drives it with object literals and two doubles. `contract/sso.js` is the
 * authority for the path and is not imported: `contract/` is test-only and
 * never deployed (`lib/sourceHash.js` `HASHED_DIRS` is `["lib", "routes"]`),
 * so importing it would pass the suite and throw `MODULE_NOT_FOUND` in the game
 * process. The outcome names duplicated from `lib/refreshTokens.js` are
 * asserted against their authority in the test.
 *
 * There is no `now`: expiry is not a concept here (D30's grants never expire
 * on a clock) and the store stamps its own `retiredAt`.
 */

"use strict";

// The path

/**
 * `contract/sso.js` `REVOKE_PATH`, which is
 * `DISCOVERY_ENDPOINT_PATHS.revocation`: the string `routes/oauthDiscovery.js`
 * publishes as `revocation_endpoint`.
 *
 * One spelling. A legacy alias is recorded for verify and none for this, and
 * a path nobody asked for should not be served.
 */
const REVOKE_PATH = "/v2/oauth/revoke";

// The outcome names this route compares against.
// Duplicated rather than required to keep the route injection-only; the test
// asserts the set against its authority.

/**
 * `lib/refreshTokens.js` `REVOKE_OUTCOME.PERSIST_FAILED`: the one outcome that
 * is not answered `200`. See the header.
 */
const PERSIST_FAILED = "persist_failed";

/**
 * Every outcome `lib/refreshTokens.js` `REVOKE_OUTCOME` can produce today.
 *
 * It decides nothing. The decision is `persist_failed` or not, and an unknown
 * outcome is answered `200` because the RFC's rule is the default and a new
 * name must not silently become a refusal.
 *
 * The test compares it against the store's enum and fails when they diverge,
 * which forces a human to ask whether a new outcome is `persist_failed`-shaped.
 */
const KNOWN_OUTCOMES = Object.freeze([
  "ok",
  "already_revoked",
  "superseded",
  "unknown",
  PERSIST_FAILED,
]);

// Request shape

/**
 * `POST` only.
 *
 * RFC 7009 section 2.1 requires it. As in `routes/oauthToken.js`, a `GET`
 * would put a live refresh token in a query string (access logs, `Referer`),
 * and a `HEAD` would mean "revoke and discard the answer", so a monitoring
 * probe would kill a working grant.
 *
 * `OPTIONS` is refused rather than answered as a preflight, which would
 * advertise a capability with no legitimate browser caller: revocation
 * happens in the application's own process or an operator's `curl`.
 */
const ALLOWED_METHOD = "POST";

/**
 * The one media type a revocation request may carry (RFC 7009 section 2.1).
 *
 * Compared as a bare media type, parameters stripped and case folded, as in
 * `routes/oauthToken.js`.
 */
const REQUEST_CONTENT_TYPE = "application/x-www-form-urlencoded";

/**
 * A cap on the request body, over and above `server.js`'s.
 *
 * The same 8 KB as `routes/oauthToken.js`; this body is smaller (a token, a
 * hint, a client credential). It bounds the parse below on the game's event
 * loop (design constraint 2).
 */
const MAX_REQUEST_BODY_BYTES = 8192;

/**
 * The parameters this route reads: RFC 7009 section 2.1's two, plus the three
 * `lib/clientAuth.js` reads from the body.
 *
 * Used only by the duplicate-parameter refusal, which names a parameter only if
 * it is on this list, to avoid reflecting attacker-chosen text into a log.
 * `KNOWN_PARAMETERS` in `routes/oauthToken.js` has the same rule.
 */
const KNOWN_PARAMETERS = Object.freeze([
  "client_assertion",
  "client_assertion_type",
  "client_id",
  "client_secret",
  "token",
  "token_type_hint",
]);

/**
 * RFC 7009 section 2.1's two `token_type_hint` values, and the one this
 * replica can act on.
 *
 * `contract/sso.js` `REVOKE_TOKEN_TYPES` carries the reasoning. The hint never
 * changes what happens: the RFC makes it advisory and requires a server that
 * misses under the hint to search all its token types, and this replica has one
 * searchable store, so "extend the search" and "ignore the hint" coincide.
 *
 * `token_type_hint=access_token` gets a `200` and a log line, not
 * `unsupported_token_type`. An access token is a signed JWT this server never
 * stored, and refusing it would reveal which token type this server keeps
 * state for.
 */
const HINT_ACCESS_TOKEN = "access_token";
const HINT_REFRESH_TOKEN = "refresh_token";

// Response shape
//
// `contract/sso.js` `UNOBSERVED` records that no response header has been
// captured off `login.eveonline.com`, and `UNOBSERVED.revokeResponseShape` that
// nothing about this response has been. Nothing below is a reproduction, and
// nothing is borrowed from `contract/wire.js`, which describes
// `esi.evetech.net`.

/**
 * `contract/sso.js` `REFUSAL_CONTENT_TYPE`.
 *
 * `text/html` is recorded for verify's `401`, under the rule "Only the token
 * endpoint returns JSON errors", so a refusal here is HTML too. This endpoint
 * has no machine-readable `error` member by design, and the detail goes to the
 * log.
 */
const CONTENT_TYPE_HTML = "text/html";

/**
 * `no-store` on every response, success included. A cached `200` would report
 * success for a request that never reached this server, leaving an operator
 * believing a token is dead because a cache said so.
 */
const CACHE_CONTROL = "no-store";

/**
 * The `WWW-Authenticate` on a `401`, naming `Basic`.
 *
 * Byte-identical to `WWW_AUTHENTICATE` in `routes/oauthToken.js`, duplicated
 * rather than imported so one route's deployment is not tied to the other's;
 * the test asserts they agree. RFC 6749 section 5.2 asks for the scheme "used
 * by the client", which read literally reflects an attacker-chosen token, and
 * `Basic` is the only scheme this endpoint implements.
 *
 * RFC 9110 section 15.5.2 makes the header mandatory on a `401`, so it is sent
 * even to a caller that authenticated (or failed to) in the body.
 */
const WWW_AUTHENTICATE = 'Basic realm="EVE SSO"';

/**
 * How long a client should wait before retrying a `503`.
 *
 * RFC 7009 section 2.2.1 permits it and says the token may still exist, so
 * retry. Sixty seconds is short enough that a retry falls inside the window an
 * operator is still looking at the alert, and the endpoint is idempotent. It is
 * advice, not a promise.
 */
const RETRY_AFTER_SECONDS = 60;

/**
 * The refusal bodies. They are ours: `contract/sso.js`
 * `UNOBSERVED.verifyRefusalBody` names the `curl` that would replace them.
 *
 * One body per status, never one per cause. The `400` is a single document
 * for a bad content type, an oversized body, a repeated parameter and a
 * missing `token`; none of those says anything about a token, and a body that
 * varies with the request turns every variation into a per-refusal safety
 * judgement. Specifics go to the log.
 *
 * `405` may name the method, because the caller chose it and `Allow` says the
 * same in a header.
 */
function refusalDocument(title, extra) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    "</head>",
    "<body>",
    `<h1>${title}</h1>`,
    ...(extra === undefined ? [] : [`<p>${extra}</p>`]),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

const BAD_REQUEST_BODY = refusalDocument("400 Bad Request");
const UNAUTHORIZED_BODY = refusalDocument("401 Unauthorized");
const METHOD_NOT_ALLOWED_BODY = refusalDocument(
  "405 Method Not Allowed",
  `This endpoint answers ${ALLOWED_METHOD}.`,
);
const SERVICE_UNAVAILABLE_BODY = refusalDocument(
  "503 Service Unavailable",
  "The revocation was not recorded. The token may still be valid; retry.",
);

/**
 * What the store writes on the record as the reason it was retired.
 *
 * A fixed string, not the calling client's id. The reason is persisted into
 * `sso/refresh-tokens.jsonl` (D30), and with no configured secret the
 * `client_id` in a request is caller-chosen, so using it would let an
 * unauthenticated caller write bounded arbitrary text into a credential store
 * file. The record already carries the grant's `clientId`, and the caller's id
 * goes to the log as in `routes/oauthToken.js`.
 */
const REVOCATION_REASON = "revoked at /v2/oauth/revoke";

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
 * A near-copy of `parseFormBody` in `routes/oauthToken.js`, kept separate so
 * one route's deployment is not tied to the other's (`lib/refreshTokens.js`
 * does the same with `lib/signingKey.js`'s permission check). The bodies
 * differ: that one refuses a repeated `code`, this one a repeated `token`. The
 * shared behaviour is asserted across both in the test.
 *
 * `URLSearchParams` matches the encoder OAuth client libraries use, `+` as a
 * space included. A refresh token is base64 and contains `+` and `/`, so a
 * client that does not percent-encode it sends a token with spaces. Here the
 * consequence is quieter: the mangled token is not found and the caller gets
 * the same `200` as a successful revocation, so the client believes it revoked
 * a token it did not. `spaceLikelyMangled` is the only way an operator learns
 * that, so it is logged even though the outcome is not reported.
 *
 * A repeated parameter is refused rather than resolved by precedence (RFC 6749
 * section 3.1): `token=theirs&token=mine` lets each server in the chain pick a
 * different token to revoke.
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
      const named = KNOWN_PARAMETERS.includes(name) ? `the parameter ${name}` : "a parameter";
      return {
        failure:
          `${named} was sent more than once. RFC 6749 §3.1 does not permit a repeated `
          + "parameter, and resolving one by precedence would let the token this server "
          + "acts on differ from the token the client believes it sent.",
      };
    }
    fields.set(name, all[0]);
  }

  return { fields };
}

/**
 * Did this token almost certainly arrive with an un-encoded `+`?
 *
 * Tokens from `lib/refreshTokens.js` (base64url) and CCP (base64) contain no
 * space, so a space in a decoded token means the wire carried a `+` that the
 * form decoder read as a space. The token is never written anywhere; the log
 * line says only that it happened.
 */
function spaceLikelyMangled(token) {
  return typeof token === "string" && token.includes(" ");
}

// Responses

/** A refusal, in the content type recorded for verify and with nothing else in it. */
function htmlResponse(status, body, extraHeaders = {}) {
  return {
    status,
    headers: {
      "content-type": CONTENT_TYPE_HTML,
      "cache-control": CACHE_CONTROL,
      // A browser may not re-decide what these bytes are, which lets the content
      // type above stay the bare media type recorded.
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
    body,
  };
}

/**
 * The one success response, built fresh each time so no caller can mutate the
 * object others receive, and identical each time
 * (`test/revokeContract.test.js` asserts it across the whole outcome set).
 *
 * The body is empty (RFC 7009 section 2.2: the client ignores the body) and
 * there is no `content-type`, because there is no content to describe:
 * `server.js` writes an empty string body as `content-length: 0`, and
 * `lib/ssoDispatch.js`'s bodiless `404` makes the same choice.
 */
function revokedResponse() {
  return {
    status: 200,
    headers: { "cache-control": CACHE_CONTROL },
    body: "",
  };
}

// The route

/**
 * Build the revocation route, with everything it talks to injected.
 *
 * @param {{
 *   clientAuth: { authenticate: Function },
 *   refreshTokens: { revoke: Function },
 *   log?: (message: string) => void,
 * }} deps
 */
function createOauthRevokeRoute(deps = {}) {
  const { clientAuth, refreshTokens, log } = deps;

  // Construction-time validation (`lib/ssoDispatch.js`'s reason): a mistake fails
  // at boot naming the route, not on the request of an operator revoking a token
  // they have just been told is stolen.
  requireMethod(clientAuth, "clientAuth", "authenticate");
  requireMethod(refreshTokens, "refreshTokens", "revoke");

  const emit = typeof log === "function" ? log : () => {};

  function handle(request) {
    const method = String((request && request.method) || ALLOWED_METHOD).toUpperCase();
    if (method !== ALLOWED_METHOD) {
      return htmlResponse(405, METHOD_NOT_ALLOWED_BODY, { allow: ALLOWED_METHOD });
    }

    const contentType = mediaTypeOf(readHeader(request, "content-type"));
    if (contentType !== REQUEST_CONTENT_TYPE) {
      return badRequest(
        `the request declared `
        + `${contentType === null || contentType === "" ? "no content type" : contentType}`
        + `; RFC 7009 §2.1 requires ${REQUEST_CONTENT_TYPE}`,
      );
    }

    const rawBody = request && request.rawBody;
    const size = Buffer.isBuffer(rawBody) ? rawBody.length : String(rawBody || "").length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      return badRequest(
        `the request body is ${size} bytes; a revocation request is at most `
        + `${MAX_REQUEST_BODY_BYTES}`,
      );
    }

    const parsed = parseFormBody(rawBody);
    if (parsed.failure !== undefined) return badRequest(parsed.failure);
    const fields = parsed.fields;

    // Authentication first, before a byte of the token is looked at. Nothing
    // destructive needs protecting as at the token endpoint, but an
    // unauthenticated caller must not probe this endpoint's parameter handling, so
    // every refusal below is reachable only by a caller this server agreed to talk
    // to.
    //
    // `body` is a prototype-less plain object rather than the `Map` this route
    // reads, for the two reasons in `routes/oauthToken.js`: "the parsed body"
    // conventionally answers to `body.client_id`, and a form body may contain
    // `__proto__=`, which on an ordinary object is a prototype write that makes
    // every unset field appear to have a value.
    const body = Object.create(null);
    for (const [name, value] of fields) body[name] = value;

    const client = clientAuth.authenticate({
      headers: (request && request.headers) || {},
      body,
    }) || {};

    if (client.ok !== true) {
      // A flat `401`, without the `401`/`400` split of RFC 6749 section 5.2 that
      // `routes/oauthToken.js` implements: this endpoint has no JSON error body in
      // which a `400` could carry a readable `error`. Every refusal about who is
      // asking is one status and one document, and the reason goes to the log.
      const error = typeof client.error === "string" ? client.error : "no error given";
      const description = typeof client.errorDescription === "string"
        ? ` ${client.errorDescription}`
        : "";
      emit(`revocation refused: the client could not be identified (${error}).${description}`);
      return htmlResponse(401, UNAUTHORIZED_BODY, { "www-authenticate": WWW_AUTHENTICATE });
    }

    const clientId = client.clientId;

    // A public client (an identity with no proof) is accepted. See the header:
    // requiring `authenticated === true` makes the endpoint unreachable on a
    // deployment with no configured client secret, the default, and the refresh
    // token presented is itself the bearer proof. Logged here so an operator can
    // see which kind of caller made the revocation.
    const authenticated = client.authenticated === true;

    const token = fields.get("token");
    if (token === undefined || token === "") {
      // RFC 7009 section 2.1 makes `token` REQUIRED. A request without one is a
      // missing parameter, not "an invalid token", so the 200 rule of section 2.2
      // does not apply. The caller learns only that they sent no token.
      return badRequest("the request carried no token parameter");
    }

    const hint = fields.get("token_type_hint");
    noteHint(hint, clientId);

    // The one call, made for every token (real, dead, mangled or invented) so
    // nothing above this line forks on what the token turns out to be.
    const result = refreshTokens.revoke(token, { reason: REVOCATION_REASON }) || {};
    const outcome = typeof result.outcome === "string" ? result.outcome : "no outcome";
    const record = (result.record !== null && typeof result.record === "object")
      ? result.record
      : null;

    // The operator's copy of everything the caller will not be told: the payoff of
    // `lib/refreshTokens.js` keeping five outcomes apart.
    emit(
      `revocation by client ${JSON.stringify(clientId)} `
      + `(${authenticated ? "authenticated" : "unauthenticated"}): ${outcome}.`,
    );

    if (!KNOWN_OUTCOMES.includes(outcome)) {
      // Answered 200 with the rest (see `KNOWN_OUTCOMES`) and logged loudly, since
      // whether a new outcome is `persist_failed`-shaped is a question for a human.
      emit(
        `!! UNKNOWN REVOKE OUTCOME !! lib/refreshTokens.js answered ${JSON.stringify(outcome)}, `
        + "which routes/oauthRevoke.js has not been taught. It was answered 200 like every "
        + "other outcome. If it means the revocation did not stick, this route needs the "
        + "treatment persist_failed gets.",
      );
    }

    if (record !== null && record.clientId !== clientId) {
      // RFC 7009 section 2.1's ownership check, made after the fact because the
      // store offers no way to make it before. See the header: the answer is still
      // 200, because "that token is somebody else's" is a statement about the token,
      // and section 2.2 outranks section 2.1 where they collide.
      emit(
        `!! CROSS-CLIENT REVOCATION !! a refresh token granted to client `
        + `${JSON.stringify(record.clientId)} for character ${record.characterId} was revoked `
        + `by client ${JSON.stringify(clientId)}. RFC 7009 §2.1 asks that this be refused; `
        + "this store revokes by token alone, so it is reported rather than prevented. The "
        + "caller had to be holding the token, which is already enough to use it.",
      );
    }

    if (outcome === PERSIST_FAILED) {
      // The one outcome `lib/refreshTokens.js` instructs this endpoint not to answer
      // 200 to. RFC 7009 section 2.2.1's 503 is what is true: assume the token still
      // exists, and retry.
      emit(
        "revocation NOT recorded: the refresh token store could not be written, so the token "
        + "is still live. Answered 503 rather than 200: telling an operator a token is dead "
        + "when it is not is the failure D30's argument against rotation rests on not "
        + "happening.",
      );
      return htmlResponse(503, SERVICE_UNAVAILABLE_BODY, {
        "retry-after": String(RETRY_AFTER_SECONDS),
      });
    }

    if (outcome !== "ok" && spaceLikelyMangled(token)) {
      // The field failure that is silent here because the answer is always 200: the
      // client believes it revoked something.
      emit(
        "the presented token contained a space, which in a base64 token means the client sent "
        + "it without URL-encoding: a form body reads `+` as a space (RFC 1866). The token "
        + "must be percent-encoded in the request body, and this revocation almost certainly "
        + "did nothing.",
      );
    }

    return revokedResponse();
  }

  /** A `400`, with the specifics going to the log and never to the caller. */
  function badRequest(detail) {
    emit(`revocation refused: ${detail} (answered 400).`);
    return htmlResponse(400, BAD_REQUEST_BODY);
  }

  /**
   * Log what the hint was, and do nothing about it.
   *
   * The `access_token` case matters to an operator trying to kill a leaked access
   * token through this endpoint: they get a `200` and no effect, and this line is
   * the only place that shows. The token cannot be recalled and expires on its
   * own inside twenty minutes (`contract/sso.js` `ACCESS_TOKEN_LIFETIME_SECONDS`);
   * the refresh token behind it is what to revoke.
   */
  function noteHint(hint, clientId) {
    if (hint === undefined || hint === "" || hint === HINT_REFRESH_TOKEN) return;

    if (hint === HINT_ACCESS_TOKEN) {
      emit(
        `revocation by client ${JSON.stringify(clientId)} hinted `
        + `token_type_hint=${HINT_ACCESS_TOKEN}. Access tokens are signed JWTs this server does `
        + "not store and cannot recall; one expires on its own within its lifetime. The "
        + "refresh token that mints them is what this endpoint can revoke. The request was "
        + "answered 200 either way, because a hint may not change the answer (RFC 7009 §2.1).",
      );
      return;
    }

    // An unrecognised hint. The value is not echoed: it is attacker-chosen text
    // and the caller already knows what they sent.
    emit(
      `revocation by client ${JSON.stringify(clientId)} carried an unrecognised `
      + "token_type_hint. RFC 7009 §2.1 makes the hint advisory, so it was ignored rather "
      + "than refused.",
    );
  }

  return Object.freeze({
    // Optional as far as `lib/ssoDispatch.js` is concerned; it is what a
    // route-table error names instead of the route's index.
    name: "PostOauthRevoke",
    paths: Object.freeze([REVOKE_PATH]),
    handle,
  });
}

// Helpers used by the factory

/** Construction-time check with a message that says what to inject and why. */
function requireMethod(object, name, method) {
  if (!object || typeof object[method] !== "function") {
    throw new TypeError(
      `ESI mod: createOauthRevokeRoute needs ${name}.${method}(). It is injected rather than `
      + "required so this route does not depend on the module that provides it.",
    );
  }
}

module.exports = Object.freeze({
  ALLOWED_METHOD,
  BAD_REQUEST_BODY,
  CACHE_CONTROL,
  CONTENT_TYPE_HTML,
  HINT_ACCESS_TOKEN,
  HINT_REFRESH_TOKEN,
  KNOWN_OUTCOMES,
  KNOWN_PARAMETERS,
  MAX_REQUEST_BODY_BYTES,
  METHOD_NOT_ALLOWED_BODY,
  PERSIST_FAILED,
  REQUEST_CONTENT_TYPE,
  RETRY_AFTER_SECONDS,
  REVOCATION_REASON,
  REVOKE_PATH,
  SERVICE_UNAVAILABLE_BODY,
  UNAUTHORIZED_BODY,
  WWW_AUTHENTICATE,
  createOauthRevokeRoute,
  mediaTypeOf,
  parseFormBody,
});
