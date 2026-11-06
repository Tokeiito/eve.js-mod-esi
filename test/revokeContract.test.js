/**
 * `POST /v2/oauth/revoke`: the contract (RFC 7009).
 *
 * Run with:  node --test test/revokeContract.test.js
 *
 * Sources:
 *
 *   - RFC 7009: §2.1's request shape and the advisory `token_type_hint`, §2.2's
 *     "200 whether or not the token was valid", §2.2.1's `503`.
 *   - The endpoint's requirements: unauthenticated is a `401` in `text/html`,
 *     and the status must never leak token validity.
 *   - `lib/refreshTokens.js`: the outcome enum, walked in full rather than from
 *     a list written here, and its own instruction on `PERSIST_FAILED`: the
 *     revoke endpoint must not answer 200 to it.
 *   - `contract/sso.js`: the path and the refusal content type. The route's
 *     copies are asserted against them.
 *
 * There is no game, and mostly no store. The endpoint is driven with object
 * literals and two doubles. The exception is the acceptance criterion
 * ("revoking a valid token prevents its further use"), which runs against the
 * real `lib/refreshTokens.js` on a real temp file, because a double that
 * reports a token dead agrees with its author. That test needs no key, no
 * listener and no character.
 *
 * Two tests matter most:
 *
 *   - "every outcome is the same response, byte for byte": walked from the
 *     store's own enum, because if one answers something else this endpoint
 *     becomes a one-request-per-guess enumeration of live refresh tokens.
 *   - "persist_failed is not a 200": the opposite tells an operator whose token
 *     is known lost that it is dead when it still works, which is the failure
 *     D30's decision against rotation stands on.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sso = require(path.join(__dirname, "../contract/sso"));
const { createSsoDispatch } = require(path.join(__dirname, "../lib/ssoDispatch"));
const {
  REFRESH_OUTCOME,
  REVOKE_OUTCOME,
  createRefreshTokenStore,
} = require(path.join(__dirname, "../lib/refreshTokens"));
const tokenRoute = require(path.join(__dirname, "../routes/oauthToken"));
const {
  ALLOWED_METHOD,
  BAD_REQUEST_BODY,
  CACHE_CONTROL,
  CONTENT_TYPE_HTML,
  HINT_ACCESS_TOKEN,
  HINT_REFRESH_TOKEN,
  KNOWN_OUTCOMES,
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
  parseFormBody,
} = require(path.join(__dirname, "../routes/oauthRevoke"));

// Fixtures

const CLIENT_ID = "1f0e3dad99908345f7439f8ffabdffc4";
const OTHER_CLIENT_ID = "ffffffffffffffffffffffffffffffff";
const CHARACTER_ID = 90000001;
const TOKEN = "gEyThisIsARefreshToken";

/**
 * A refresh token shaped like a real one: standard base64, so it carries the
 * `+` and `/` and the `=` a naive splitter mishandles.
 */
const GNARLY_TOKEN = "gEy+Th1s/Is+A/Refresh+Token/With==";

/**
 * The route, two doubles, and everything they were called with.
 *
 * `authenticated` defaults to `false` (a public client, an identity with no
 * proof) because that is what every caller on a default deployment is:
 * `lib/clientRegistry.js` registers a secret only where an operator configured
 * one. See the unreachability test.
 */
function harness({
  outcome = REVOKE_OUTCOME.OK,
  record = { clientId: CLIENT_ID, characterId: CHARACTER_ID },
  authenticate,
} = {}) {
  const calls = { log: [], revoked: [], authenticate: [] };

  const clientAuth = {
    authenticate(request) {
      calls.authenticate.push(request);
      if (typeof authenticate === "function") return authenticate(request);
      const clientId = request.body && request.body.client_id;
      if (typeof clientId !== "string" || clientId === "") {
        return {
          ok: false,
          error: "invalid_client",
          errorDescription: "The request identifies no client.",
        };
      }
      return { ok: true, clientId, authenticated: false, method: "body" };
    },
  };

  const refreshTokens = {
    revoke(token, request) {
      calls.revoked.push({ token, request });
      return { outcome, record };
    },
  };

  const route = createOauthRevokeRoute({
    clientAuth,
    refreshTokens,
    log: (line) => calls.log.push(line),
  });
  return { route, calls };
}

/** A well-formed revocation request. */
function post(route, {
  method = ALLOWED_METHOD,
  contentType = REQUEST_CONTENT_TYPE,
  headers = {},
  body,
  fields = { client_id: CLIENT_ID, token: TOKEN, token_type_hint: HINT_REFRESH_TOKEN },
} = {}) {
  const rawBody = body !== undefined
    ? body
    : new URLSearchParams(fields).toString();

  return route.handle({
    method,
    pathname: REVOKE_PATH,
    headers: contentType === null ? { ...headers } : { "content-type": contentType, ...headers },
    rawBody,
  });
}

/** One comparable string for a whole response. */
const fingerprint = (response) => JSON.stringify({
  status: response.status,
  headers: response.headers,
  body: response.body,
});

// The route's copies agree with their authorities

test("the path is contract/sso.js's, and it is what discovery advertises", () => {
  assert.equal(REVOKE_PATH, sso.REVOKE_PATH);
  assert.equal(REVOKE_PATH, sso.DISCOVERY_ENDPOINT_PATHS.revocation);
  assert.equal(REVOKE_PATH, "/v2/oauth/revoke");
});

test("the outcome names this route knows are exactly lib/refreshTokens.js's", () => {
  // This makes somebody look at `routes/oauthRevoke.js` when a sixth outcome is
  // added. The route answers an unknown outcome 200 like the rest (the RFC's
  // rule is the default), so nothing else would fail, and whether the new one
  // is persist_failed-shaped has to be asked by a human.
  assert.deepEqual([...KNOWN_OUTCOMES].sort(), Object.values(REVOKE_OUTCOME).sort());
  assert.equal(PERSIST_FAILED, REVOKE_OUTCOME.PERSIST_FAILED);
  assert.equal(KNOWN_OUTCOMES.length, 5);
});

test("the refusal content type and the Basic challenge match their authorities", () => {
  assert.equal(CONTENT_TYPE_HTML, sso.REFUSAL_CONTENT_TYPE);
  // Duplicated rather than imported, because one route requiring another would
  // tie this endpoint's deployment to that one's. This test makes the
  // duplication safe.
  assert.equal(WWW_AUTHENTICATE, tokenRoute.WWW_AUTHENTICATE);
});

test("the two token_type_hint values are RFC 7009 §2.1's, as contract/sso.js records them", () => {
  assert.deepEqual([HINT_ACCESS_TOKEN, HINT_REFRESH_TOKEN].sort(),
    [...sso.REVOKE_TOKEN_TYPE_HINTS].sort());
  assert.equal(sso.REVOKE_TOKEN_TYPES[HINT_REFRESH_TOKEN], true, "stateful here, so revocable");
  assert.equal(sso.REVOKE_TOKEN_TYPES[HINT_ACCESS_TOKEN], false, "a stateless JWT; not revocable");
});

// The security property

test("every outcome but persist_failed is the same 200, byte for byte", () => {
  // Walked from the store's own enum rather than from a list here, so an
  // outcome added to `lib/refreshTokens.js` later cannot quietly leak a
  // distinguishable answer out of this endpoint. This is
  // `test/tokenContract.test.js`'s "every authCodes outcome answers
  // invalid_grant", one endpoint over and with a stronger claim: there the
  // bodies had to match, here the whole response does.
  const outcomes = Object.values(REVOKE_OUTCOME)
    .filter((name) => name !== REVOKE_OUTCOME.PERSIST_FAILED);
  assert.ok(outcomes.length >= 4, "ok, already_revoked, superseded and unknown at least");

  const responses = new Set();

  for (const outcome of [...outcomes, "an_outcome_invented_next_year"]) {
    const { route, calls } = harness({ outcome });
    const response = post(route);

    assert.equal(response.status, 200, `${outcome} is a 200`);
    responses.add(fingerprint(response));

    // The distinction is kept, in the log, where an operator can read it and a
    // prober cannot. That is the payoff of the store keeping five apart.
    assert.ok(
      calls.log.some((line) => line.includes(outcome)),
      `the log distinguishes ${outcome}`,
    );
  }

  assert.equal(responses.size, 1, "a caller cannot tell any of them apart");
});

test("a 200 carries no body, no content type, and nothing derived from the token", () => {
  // RFC 7009 §2.2: the body is ignored by the client because everything is in
  // the status code. No content type, because there is no content to describe;
  // `lib/ssoDispatch.js`'s own bodiless 404 makes the same choice.
  const { route } = harness();
  const response = post(route);

  assert.equal(response.body, "");
  assert.equal(response.headers["content-type"], undefined);
  assert.deepEqual(Object.keys(response.headers), ["cache-control"]);
  assert.equal(response.headers["cache-control"], CACHE_CONTROL);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("garbage, an empty-ish token and a real one all answer the same", () => {
  const real = post(harness({ outcome: REVOKE_OUTCOME.OK }).route);
  const garbage = post(harness({ outcome: REVOKE_OUTCOME.UNKNOWN, record: null }).route, {
    fields: { client_id: CLIENT_ID, token: "not-a-token-anybody-ever-minted" },
  });
  const long = post(harness({ outcome: REVOKE_OUTCOME.UNKNOWN, record: null }).route, {
    fields: { client_id: CLIENT_ID, token: "x".repeat(2000) },
  });

  assert.equal(fingerprint(real), fingerprint(garbage));
  assert.equal(fingerprint(real), fingerprint(long));
});

test("the store is called exactly once, whatever the token turns out to be", () => {
  // Nothing above the call may fork on the token: a route that skipped the
  // store for a token that "looked wrong" would be a hand-written timing oracle.
  for (const token of [TOKEN, "", "x".repeat(500), GNARLY_TOKEN]) {
    const { route, calls } = harness({ outcome: REVOKE_OUTCOME.UNKNOWN, record: null });
    post(route, { fields: { client_id: CLIENT_ID, token } });
    assert.equal(calls.revoked.length, token === "" ? 0 : 1, `${token.length} bytes`);
  }
});

// persist_failed

test("persist_failed is a 503 with Retry-After, and lib/refreshTokens.js says why", () => {
  // The store's own words: a revocation that only exists in this process's heap
  // comes back to life at the next restart, so an operator who was told
  // "revoked" would be holding a token that still works; the revoke endpoint
  // must not answer 200 to this. RFC 7009 §2.2.1 defines exactly this response:
  // assume the token still exists, and retry.
  const { route, calls } = harness({ outcome: REVOKE_OUTCOME.PERSIST_FAILED, record: null });
  const response = post(route);

  assert.equal(response.status, 503);
  assert.equal(response.headers["retry-after"], String(RETRY_AFTER_SECONDS));
  assert.equal(response.headers["content-type"], CONTENT_TYPE_HTML);
  assert.equal(response.body, SERVICE_UNAVAILABLE_BODY);
  // The one refusal body that may say something, because what it says is about
  // this server's disk and not about the token: retrying is the right move and
  // a client that does not know that stops.
  assert.ok(response.body.includes("retry"));
  assert.ok(calls.log.some((line) => line.includes("NOT recorded")));
});

test("the 503 is the only response that is not the flattened 200", () => {
  const flattened = new Set();
  for (const outcome of Object.values(REVOKE_OUTCOME)) {
    flattened.add(post(harness({ outcome }).route).status);
  }
  assert.deepEqual([...flattened].sort(), [200, 503]);
});

// The acceptance criterion, against the real store

test("revoking a valid token prevents its further use", (t) => {
  // The one place a double is not good enough: "prevents its further use" is a
  // claim about `lib/refreshTokens.js`, and a double that reports a token dead
  // agrees with its author. Real store, real temp file, no key and no game.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "esi-revoke-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  let clock = Date.UTC(2026, 7, 24, 12, 0, 0);
  const store = createRefreshTokenStore({
    storePath: path.join(directory, "refresh-tokens.jsonl"),
    now: () => clock,
  });

  const issued = store.issue({
    characterId: CHARACTER_ID,
    clientId: CLIENT_ID,
    scopes: ["publicData"],
  });
  assert.equal(typeof issued.token, "string");

  // Live to begin with.
  assert.equal(store.refresh(issued.token).outcome, REFRESH_OUTCOME.OK);

  const route = createOauthRevokeRoute({
    clientAuth: {
      authenticate: () => ({ ok: true, clientId: CLIENT_ID, authenticated: false, method: "body" }),
    },
    refreshTokens: store,
  });

  const response = post(route, { fields: { client_id: CLIENT_ID, token: issued.token } });
  assert.equal(response.status, 200);

  // Dead afterwards, and `REVOKED` rather than `UNKNOWN`, because D30 keeps the
  // record so a later replay is nameable.
  clock += 1000;
  assert.equal(store.refresh(issued.token).outcome, REFRESH_OUTCOME.REVOKED);

  // Revoking it again is idempotent and answers the same bytes, which is what
  // RFC 7009 §2.2 asks for and what a retrying client does.
  const again = post(route, { fields: { client_id: CLIENT_ID, token: issued.token } });
  assert.equal(fingerprint(again), fingerprint(response));

  // And a token this store never minted answers the same again.
  const never = post(route, { fields: { client_id: CLIENT_ID, token: "never-issued-here" } });
  assert.equal(fingerprint(never), fingerprint(response));
});

test("the revocation reason written to the store is fixed, never the caller's text", () => {
  // It is persisted into `sso/refresh-tokens.jsonl` (D30). On a deployment with
  // no configured secret the `client_id` in a request is caller-chosen text,
  // and putting it there would let an unauthenticated caller write bounded
  // arbitrary text into a credential store file.
  const { route, calls } = harness();
  post(route, { fields: { client_id: "<script>whatever</script>", token: TOKEN } });

  assert.equal(calls.revoked.length, 1);
  assert.deepEqual(calls.revoked[0].request, { reason: REVOCATION_REASON });
  assert.ok(!REVOCATION_REASON.includes("script"));
  assert.equal(REVOCATION_REASON, "revoked at /v2/oauth/revoke");
});

// token_type_hint

test("an absent, a wrong and an access_token hint all answer identically", () => {
  // RFC 7009 §2.1 makes the hint advisory and requires a server that misses
  // under it to extend its search; this replica has one store to extend into,
  // which makes "extend the search" and "ignore the hint" the same instruction.
  const responses = new Set();

  for (const fields of [
    { client_id: CLIENT_ID, token: TOKEN },
    { client_id: CLIENT_ID, token: TOKEN, token_type_hint: HINT_REFRESH_TOKEN },
    { client_id: CLIENT_ID, token: TOKEN, token_type_hint: HINT_ACCESS_TOKEN },
    { client_id: CLIENT_ID, token: TOKEN, token_type_hint: "" },
    { client_id: CLIENT_ID, token: TOKEN, token_type_hint: "device_code" },
    { client_id: CLIENT_ID, token: TOKEN, token_type_hint: "../../etc/passwd" },
  ]) {
    const { route, calls } = harness();
    const response = post(route, { fields });
    assert.equal(response.status, 200);
    assert.equal(calls.revoked.length, 1, "the hint never decides whether we look");
    responses.add(fingerprint(response));
  }

  assert.equal(responses.size, 1, "a hint may not change the answer");
});

test("an access_token hint is logged, because nothing else can tell the operator", () => {
  // An operator trying to kill a leaked access token here gets a 200 and no
  // effect. That is visible only in the log, and what they need is that the
  // token cannot be recalled and the refresh token is what to kill.
  const { route, calls } = harness();
  post(route, {
    fields: { client_id: CLIENT_ID, token: TOKEN, token_type_hint: HINT_ACCESS_TOKEN },
  });

  const line = calls.log.find((entry) => entry.includes(HINT_ACCESS_TOKEN));
  assert.ok(line, "the access_token hint is reported");
  assert.ok(line.includes("cannot recall") || line.includes("do not store")
    || line.includes("not store"));
  assert.ok(line.includes("refresh token"), "and says what to revoke instead");
});

test("an unrecognised hint is ignored, and its value is not echoed into the log", () => {
  // Attacker-chosen text, and the caller already knows what they sent.
  const { route, calls } = harness();
  post(route, {
    fields: { client_id: CLIENT_ID, token: TOKEN, token_type_hint: "MARKER-9c2f" },
  });

  assert.ok(calls.log.some((line) => line.includes("unrecognised")));
  assert.ok(!calls.log.some((line) => line.includes("MARKER-9c2f")));
});

// Client authentication

test("an unauthenticated request is a 401 in text/html, saying nothing", () => {
  const { route, calls } = harness();
  const response = post(route, { fields: { token: TOKEN } });

  assert.equal(response.status, 401);
  assert.equal(response.headers["content-type"], CONTENT_TYPE_HTML);
  assert.equal(response.body, UNAUTHORIZED_BODY);
  assert.equal(response.headers["www-authenticate"], WWW_AUTHENTICATE);
  assert.equal(calls.revoked.length, 0, "nothing is looked up before the caller is known");

  // The reason reaches the log and not the caller.
  assert.ok(calls.log.some((line) => line.includes("invalid_client")));
  for (const needle of ["invalid_client", "client", "token", TOKEN]) {
    assert.ok(!response.body.includes(needle), `the 401 body must not contain ${needle}`);
  }
});

test("every way of failing authentication is the same 401 bytes", () => {
  const responses = new Set();
  for (const answer of [
    { ok: false, error: "invalid_client", errorDescription: "no such client." },
    { ok: false, error: "invalid_request", errorDescription: "two Authorization headers." },
    { ok: false },
    null,
    undefined,
    {},
  ]) {
    const { route } = harness({ authenticate: () => answer });
    const response = post(route);
    assert.equal(response.status, 401);
    responses.add(fingerprint(response));
  }
  assert.equal(responses.size, 1);
});

test("a public client: an identity with no proof, is accepted", () => {
  // Requiring `authenticated: true` would make this endpoint unreachable on a
  // default deployment, because `lib/clientRegistry.js` registers a secret only
  // where an operator configured one, and an endpoint that other decisions name
  // as their remedy but that cannot be called on the default configuration is a
  // promissory note with a 401 on it. What stands in for the secret is the
  // refresh token itself, which the caller must already be holding.
  const { route, calls } = harness({
    authenticate: () => ({ ok: true, clientId: CLIENT_ID, authenticated: false, method: "body" }),
  });
  const response = post(route);

  assert.equal(response.status, 200);
  assert.equal(calls.revoked.length, 1);
  assert.ok(calls.log.some((line) => line.includes("unauthenticated")));
});

test("a confidential client is accepted too, and the log says which kind it was", () => {
  const { route, calls } = harness({
    authenticate: () => ({ ok: true, clientId: CLIENT_ID, authenticated: true, method: "basic" }),
  });
  const response = post(route);

  assert.equal(response.status, 200);
  assert.ok(calls.log.some((line) => line.includes("(authenticated)")));
});

test("the two kinds of caller are indistinguishable on the wire", () => {
  const publicClient = harness({
    authenticate: () => ({ ok: true, clientId: CLIENT_ID, authenticated: false, method: "body" }),
  });
  const confidential = harness({
    authenticate: () => ({ ok: true, clientId: CLIENT_ID, authenticated: true, method: "basic" }),
  });

  assert.equal(fingerprint(post(publicClient.route)), fingerprint(post(confidential.route)));
});

test("clientAuth is handed a prototype-less body, so __proto__= is a field", () => {
  // `routes/oauthToken.js`'s argument: on an object literal built by
  // assignment, `__proto__=` is a prototype write rather than a property, after
  // which every unset field appears to have a value.
  const { route, calls } = harness();
  post(route, { body: "__proto__=polluted&client_id=" + CLIENT_ID + "&token=" + TOKEN });

  const body = calls.authenticate[0].body;
  assert.equal(Object.getPrototypeOf(body), null);
  assert.equal(body.__proto__, "polluted");
  assert.equal(body.client_secret, undefined, "an unset field is still unset");
});

test("CCP understates this endpoint's auth methods exactly as it does the token one", () => {
  // The evidence for the decision above: CCP's
  // `revocation_endpoint_auth_methods_supported` lists three `client_secret_*`
  // methods and no `none`, and lists the identical three for the token
  // endpoint, where public clients demonstrably do authenticate without a secret
  // (`docs/d6-listener-split.md`). The list is known to be incomplete in exactly
  // this way for the token endpoint, so reading it as a hard requirement only
  // for revoke would be selective.
  const document = sso.CCP_DISCOVERY_DOCUMENT;
  assert.deepEqual(
    [...document.revocation_endpoint_auth_methods_supported],
    [...document.token_endpoint_auth_methods_supported],
  );
  assert.ok(!document.revocation_endpoint_auth_methods_supported.includes("none"));
});

// The ownership check RFC 7009 §2.1 asks for

test("a token belonging to another client is still a 200, and is logged loudly", () => {
  // §2.1 asks for the ownership check; §2.2 and the endpoint's requirements
  // forbid the answer that would report it, because "that token is somebody
  // else's" is a statement about token validity by another route. The store
  // revokes by token alone, so it is detected after the fact and reported rather
  // than prevented.
  const mine = harness({ record: { clientId: CLIENT_ID, characterId: CHARACTER_ID } });
  const theirs = harness({ record: { clientId: OTHER_CLIENT_ID, characterId: CHARACTER_ID } });

  const one = post(mine.route);
  const two = post(theirs.route);

  assert.equal(fingerprint(one), fingerprint(two), "indistinguishable on the wire");
  assert.ok(theirs.calls.log.some((line) => line.includes("CROSS-CLIENT REVOCATION")));
  assert.ok(theirs.calls.log.some((line) => line.includes(OTHER_CLIENT_ID)));
  assert.ok(!mine.calls.log.some((line) => line.includes("CROSS-CLIENT")));
});

// The request envelope

test("only POST is answered; everything else is a 405 with Allow", () => {
  // A GET would carry a live refresh token in a query string, where it lands in
  // every access log and every Referer; a HEAD would mean "revoke and discard
  // the answer", so a monitoring probe would kill a working grant.
  assert.equal(ALLOWED_METHOD, "POST");

  const { route, calls } = harness();
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = post(route, { method });
    assert.equal(response.status, 405, `${method} is refused`);
    assert.equal(response.headers.allow, "POST");
    assert.equal(response.headers["content-type"], CONTENT_TYPE_HTML);
    assert.equal(response.body, METHOD_NOT_ALLOWED_BODY);
  }
  assert.equal(calls.revoked.length, 0);
  assert.equal(calls.authenticate.length, 0, "the method is decided before anything else");
});

test("a body that is not form-encoded is a 400, and the caller learns nothing else", () => {
  const { route, calls } = harness();

  for (const contentType of [null, "", "application/json", "text/plain", "multipart/form-data"]) {
    const response = post(route, { contentType });
    assert.equal(response.status, 400, `${contentType} is refused`);
    assert.equal(response.headers["content-type"], CONTENT_TYPE_HTML);
    assert.equal(response.body, BAD_REQUEST_BODY);
  }

  // Parameters on the media type are fine: a library that appends a charset is
  // not a library to refuse.
  const withCharset = post(route, { contentType: `${REQUEST_CONTENT_TYPE}; charset=UTF-8` });
  assert.equal(withCharset.status, 200);
  const upperCased = post(route, { contentType: REQUEST_CONTENT_TYPE.toUpperCase() });
  assert.equal(upperCased.status, 200);

  assert.ok(calls.log.some((line) => line.includes("no content type")));
});

test("an oversized body is refused before it is parsed", () => {
  const { route, calls } = harness();
  const response = post(route, {
    body: `client_id=${CLIENT_ID}&token=${"x".repeat(MAX_REQUEST_BODY_BYTES)}`,
  });

  assert.equal(response.status, 400);
  assert.equal(response.body, BAD_REQUEST_BODY);
  assert.equal(calls.revoked.length, 0);
});

test("a repeated parameter is refused rather than resolved by precedence", () => {
  // RFC 6749 §3.1. `token=theirs&token=mine` is a request where the token being
  // revoked can be chosen separately by whoever writes the body, and every
  // server in the chain gets to pick a different one.
  const { route, calls } = harness();
  const response = post(route, {
    body: `client_id=${CLIENT_ID}&token=theirs&token=mine`,
  });

  assert.equal(response.status, 400);
  assert.equal(response.body, BAD_REQUEST_BODY);
  assert.equal(calls.revoked.length, 0);
  assert.ok(calls.log.some((line) => line.includes("the parameter token")));

  // A repeated parameter we do not know is refused too, and its name is not
  // echoed: that would reflect attacker-chosen text into a log.
  const unknown = harness();
  post(unknown.route, { body: `client_id=${CLIENT_ID}&token=a&MARKER-9c2f=1&MARKER-9c2f=2` });
  assert.ok(unknown.calls.log.some((line) => line.includes("a parameter was sent more than once")));
  assert.ok(!unknown.calls.log.some((line) => line.includes("MARKER-9c2f")));
});

test("parseFormBody behaves the same way routes/oauthToken.js's does", () => {
  // Two near-copies, kept separate so neither route's deployment depends on the
  // other's. The behaviour they share is asserted against each other here.
  for (const raw of [
    "token=a&client_id=b",
    "",
    "token=a%2Bb%2Fc%3D%3D",
    "token=a+b",
    "__proto__=x&token=y",
  ]) {
    const mine = parseFormBody(raw);
    const theirs = tokenRoute.parseFormBody(raw);
    assert.deepEqual([...(mine.fields || [])], [...(theirs.fields || [])], raw);
  }

  // `+` is a space, and that is the decoder every OAuth client library encodes
  // against; a literal plus arrives as `%2B`.
  assert.equal(parseFormBody("token=a+b").fields.get("token"), "a b");
  assert.equal(parseFormBody("token=a%2Bb").fields.get("token"), "a+b");
});

test("a request with no token parameter is a 400, not a 200", () => {
  // RFC 7009 §2.1 makes `token` REQUIRED, and a request without one is not "an
  // invalid token": it is a request with a parameter missing, which §2.2's 200
  // rule has nothing to say about. The caller learns only what they already
  // knew: they sent no token.
  const { route, calls } = harness();

  for (const fields of [{ client_id: CLIENT_ID }, { client_id: CLIENT_ID, token: "" }]) {
    const response = post(route, { fields });
    assert.equal(response.status, 400);
    assert.equal(response.body, BAD_REQUEST_BODY);
  }
  assert.equal(calls.revoked.length, 0);
});

test("a mangled base64 token still answers 200, and the log is the only warning", () => {
  // The failure is silent on this endpoint precisely because the answer is
  // always 200: the client believes it revoked something.
  const { route, calls } = harness({ outcome: REVOKE_OUTCOME.UNKNOWN, record: null });
  const response = post(route, {
    // A client that did not percent-encode: the `+` arrives as a space.
    body: `client_id=${CLIENT_ID}&token=${GNARLY_TOKEN.replace(/\+/g, " ")}`,
  });

  assert.equal(response.status, 200);
  assert.ok(calls.log.some((line) => line.includes("percent-encoded")));
  assert.ok(calls.log.some((line) => line.includes("did nothing")));
  // Nothing of the token is written.
  assert.ok(!calls.log.some((line) => line.includes(GNARLY_TOKEN.slice(0, 12))));
});

test("a correctly encoded gnarly token reaches the store intact", () => {
  const { route, calls } = harness();
  post(route, { fields: { client_id: CLIENT_ID, token: GNARLY_TOKEN } });
  assert.equal(calls.revoked[0].token, GNARLY_TOKEN);
});

// Mounting

test("the route mounts on lib/ssoDispatch.js at exactly one path", async () => {
  const { route } = harness();
  const dispatch = createSsoDispatch([route]);

  const response = await dispatch({
    method: "POST",
    pathname: REVOKE_PATH,
    headers: { "content-type": REQUEST_CONTENT_TYPE },
    rawBody: `client_id=${CLIENT_ID}&token=${TOKEN}`,
  });
  assert.equal(response.status, 200);

  // The dispatch normalizes nothing, so no second spelling is served.
  const slashed = await dispatch({ method: "POST", pathname: `${REVOKE_PATH}/`, headers: {} });
  assert.equal(slashed.status, 404);
});

test("a missing dependency throws at construction, naming what to inject", () => {
  assert.throws(() => createOauthRevokeRoute(), /clientAuth\.authenticate/);
  assert.throws(
    () => createOauthRevokeRoute({ clientAuth: { authenticate: () => ({}) } }),
    /refreshTokens\.revoke/,
  );
  assert.throws(() => createOauthRevokeRoute(), TypeError);
});

test("the route is frozen and shaped the way lib/ssoDispatch.js expects", () => {
  const { route } = harness();
  assert.ok(Object.isFrozen(route));
  assert.equal(route.name, "PostOauthRevoke");
  assert.deepEqual([...route.paths], [REVOKE_PATH]);
  assert.ok(Object.isFrozen(route.paths));
  assert.equal(typeof route.handle, "function");
  assert.equal(typeof post(route).body, "string", "the dispatch contract says a string");
});

test("the module's exports are frozen", () => {
  const module = require(path.join(__dirname, "../routes/oauthRevoke"));
  assert.ok(Object.isFrozen(module));
  assert.ok(Object.isFrozen(KNOWN_OUTCOMES));
});
