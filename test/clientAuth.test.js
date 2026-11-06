/**
 * ESI/SSO replica mod: client authentication and PKCE tests
 *
 * Run with: node --test "test/**\/*.test.js"   (from the mod directory, or RunTests.bat)
 *
 * Three groups.
 *
 * `authenticate` and `verifyPkce` are the mechanics: a Basic header parsed as
 * RFC 6749 section 2.3.1 says, a hash compared as RFC 7636 section 4.6 says.
 * Most of their cases are near-misses, because a credential check is only as
 * good as what it refuses.
 *
 * `mayRedeem` is the invariant `routes/oauthAuthorize.js` records when it
 * accepts a missing `code_challenge`: a code minted with a challenge is
 * redeemable only with a matching verifier, one minted without only by a client
 * that authenticated. Its cases are a truth table, with the naive
 * implementation's hole (an unauthenticated client redeeming a no-challenge
 * code) as a named case.
 *
 * On timing: none of this measures a clock. A unit test on a shared runner
 * cannot distinguish a branch from noise. What is asserted is the shape the
 * constant-time property needs: no length mismatch produces an early return, a
 * throw, or a distinguishable answer.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AUTHENTICATION_FAILED,
  ERROR,
  MAX_CLIENT_ID_LENGTH,
  MAX_VERIFIER_LENGTH,
  METHOD,
  MIN_VERIFIER_LENGTH,
  PKCE_METHOD,
  VERIFIER_REJECTED,
  createClientAuthenticator,
} = require("../lib/clientAuth");

const clientRegistry = require("../lib/clientRegistry");
const { DISCOVERY_CONSTANTS } = require("../contract/sso");

const CONFIDENTIAL = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
const PUBLIC = "0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c";
const SECRET = "s3cret-value.for_the-operator";
const LISTED = "http://host.local:8080/sso/callback";

/** A registry with one confidential client and one public one. */
function realRegistry() {
  return clientRegistry.createClientRegistry({
    clients: [
      { clientId: CONFIDENTIAL, redirectUris: [LISTED], clientSecret: SECRET },
      { clientId: PUBLIC, redirectUris: [LISTED] },
    ],
  });
}

function authenticator(registry = realRegistry()) {
  return createClientAuthenticator({ registry });
}

/** `Authorization: Basic ...`, built the way RFC 6749 section 2.3.1 says to build it. */
function basic(clientId, clientSecret) {
  const encoded = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`;
  return `Basic ${Buffer.from(encoded, "utf8").toString("base64")}`;
}

/** The same, without the form-urlencoding step every other client forgets. */
function basicUnencoded(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}

function withHeader(auth, body = {}) {
  return { headers: { authorization: auth }, body };
}

/** A verifier and the S256 challenge it produces. */
function pkcePair(verifier = "a".repeat(64)) {
  const codeChallenge = crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { codeVerifier: verifier, codeChallenge, codeChallengeMethod: PKCE_METHOD };
}

// Basic authentication

test("a correct Basic credential authenticates the client it names", () => {
  const result = authenticator().authenticate(withHeader(basic(CONFIDENTIAL, SECRET)));

  assert.deepEqual({ ...result }, {
    ok: true,
    clientId: CONFIDENTIAL,
    authenticated: true,
    method: METHOD.BASIC,
  });
});

test("a Basic credential that skipped RFC 6749's form-urlencoding still works", () => {
  // The registry's charset rule buys this: every character a configured secret
  // may contain is a fixed point of form-urlencoding, so the client's most
  // common bug cannot change the bytes. See lib/clientRegistry.js's
  // CLIENT_SECRET_PATTERN.
  const result = authenticator().authenticate(withHeader(basicUnencoded(CONFIDENTIAL, SECRET)));
  assert.equal(result.ok, true);
  assert.equal(result.authenticated, true);
});

test("the credential splits on the first colon, so a secret may contain one", () => {
  const secret = "aaaaaaaaaaaaaaaa";
  const registry = { verifySecret: ({ clientId, clientSecret }) => (
    clientId === CONFIDENTIAL && clientSecret === `x:${secret}`
  ) };
  // RFC 7617 section 2: a userid contains no colon, a password may.
  const raw = `Basic ${Buffer.from(`${CONFIDENTIAL}:x:${secret}`, "utf8").toString("base64")}`;
  assert.equal(authenticator(registry).authenticate(withHeader(raw)).ok, true);
});

test("the three ways a secret can be wrong are refused with identical bytes", () => {
  const auth = authenticator();

  const wrongSecret = auth.authenticate(withHeader(basic(CONFIDENTIAL, "wrong-secret-value")));
  const secretForPublicClient = auth.authenticate(withHeader(basic(PUBLIC, SECRET)));
  const unknownClient = auth.authenticate(withHeader(basic("nobody-has-this-id", SECRET)));

  // All three fail the same way. Any difference would tell an unauthenticated
  // caller which of this deployment's clients are confidential, a fact about the
  // operator's file.
  const expected = { ok: false, error: ERROR.INVALID_CLIENT, errorDescription: AUTHENTICATION_FAILED };
  assert.deepEqual({ ...wrongSecret }, expected);
  assert.deepEqual({ ...secretForPublicClient }, expected);
  assert.deepEqual({ ...unknownClient }, expected);

  assert.equal(JSON.stringify(wrongSecret), JSON.stringify(secretForPublicClient));
  assert.equal(JSON.stringify(wrongSecret), JSON.stringify(unknownClient));
});

test("a correct secret presented to a client registered without one does not authenticate", () => {
  // Stated on its own as well as in the group above: a registry that stored
  // `undefined` and compared with `==` would let this through.
  const result = authenticator().authenticate(withHeader(basic(PUBLIC, SECRET)));
  assert.equal(result.ok, false);
  assert.equal(result.error, ERROR.INVALID_CLIENT);
});

test("a malformed Authorization header is invalid_client, and says which way", () => {
  const auth = authenticator();

  const cases = [
    // Not Basic at all. A Bearer token is not a client credential.
    ["Bearer abcdef", /not an HTTP Basic credential/],
    ["Basic", /not an HTTP Basic credential/],
    ["Basic ", /not an HTTP Basic credential/],
    // Buffer.from(..., "base64") would decode all of these; canonical base64 is
    // required so that one credential has one spelling.
    [`Basic ${"!!!!"}`, /not valid base64/],
    // Not a multiple of four: `Buffer.from` decodes it anyway, dropping the
    // trailing bits, so two different headers become one credential.
    ["Basic YWJ", /not valid base64/],
    [`Basic ${Buffer.from("abc", "utf8").toString("base64")}=`, /not valid base64/],
    // Valid base64, no colon: not a credential.
    [`Basic ${Buffer.from("no-colon-here!!!", "utf8").toString("base64")}`, /contains no colon/],
    // A percent that is not an escape. Decoded strictly, once, per RFC 6749
    // section 2.3.1: the alternative is two strings that authenticate one client.
    [`Basic ${Buffer.from("id:%zz-not-an-escape", "utf8").toString("base64")}`,
      /not correctly form-urlencoded/],
  ];

  for (const [header, expected] of cases) {
    const result = auth.authenticate(withHeader(header));
    assert.equal(result.ok, false, header);
    assert.equal(result.error, ERROR.INVALID_CLIENT, header);
    assert.match(result.errorDescription, expected, header);
  }
});

test("two Authorization headers are refused rather than resolved", () => {
  const result = authenticator().authenticate({
    headers: { authorization: [basic(CONFIDENTIAL, SECRET), basic(PUBLIC, SECRET)] },
    body: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, ERROR.INVALID_REQUEST);
});

test("the Authorization header is found whatever case it arrives in", () => {
  const result = authenticator().authenticate({
    headers: { Authorization: basic(CONFIDENTIAL, SECRET) },
    body: {},
  });
  assert.equal(result.authenticated, true);
});

// The header and the body disagreeing

test("a Basic header and a body client_id that disagree is invalid_request", () => {
  const result = authenticator().authenticate(
    withHeader(basic(CONFIDENTIAL, SECRET), { client_id: PUBLIC }),
  );

  // invalid_request rather than invalid_client: a body client_id with no secret
  // is an identity claim, not an authentication method, so what is wrong is the
  // request's coherence. The server does not pick a winner.
  assert.equal(result.ok, false);
  assert.equal(result.error, ERROR.INVALID_REQUEST);
});

test("a Basic header and a body client_id that agree is permitted", () => {
  const result = authenticator().authenticate(
    withHeader(basic(CONFIDENTIAL, SECRET), { client_id: CONFIDENTIAL }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.method, METHOD.BASIC);
});

test("authenticating two ways at once is invalid_client, even when they agree", () => {
  // RFC 6749 section 5.2 names this case: "the client attempted to authenticate
  // via more than one authentication method". Such a request has no obvious
  // answer to "which credential did the server check?".
  const result = authenticator().authenticate(
    withHeader(basic(CONFIDENTIAL, SECRET), { client_id: CONFIDENTIAL, client_secret: SECRET }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, ERROR.INVALID_CLIENT);
  assert.match(result.errorDescription, /two ways at once/);
});

test("a repeated client_id or client_secret in the body is refused before it is read", () => {
  const auth = authenticator();

  for (const body of [
    { client_id: [CONFIDENTIAL, PUBLIC] },
    { client_id: CONFIDENTIAL, client_secret: [SECRET, "other-secret-value"] },
  ]) {
    const result = auth.authenticate({ headers: {}, body });
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(result.error, ERROR.INVALID_REQUEST, JSON.stringify(body));
  }
});

// The body form

test("a body client_id with no secret is an identity without a proof", () => {
  // The EVE client's own refresh call (docs/d6-listener-split.md): client_id in
  // the body, no secret. It is a success, and `authenticated: false` is all
  // mayRedeem then has to work with.
  const result = authenticator().authenticate({ headers: {}, body: { client_id: PUBLIC } });

  assert.deepEqual({ ...result }, {
    ok: true,
    clientId: PUBLIC,
    authenticated: false,
    method: METHOD.BODY,
  });
});

test("a body client_secret is accepted, and authenticates when it matches", () => {
  // RFC 6749 section 2.3.1 permits and discourages this. Under D1's plain HTTP
  // the premise of the discouragement (a body is more exposed than a header)
  // does not hold, and refusing it would break old tools for nothing.
  const result = authenticator().authenticate({
    headers: {},
    body: { client_id: CONFIDENTIAL, client_secret: SECRET },
  });

  assert.deepEqual({ ...result }, {
    ok: true,
    clientId: CONFIDENTIAL,
    authenticated: true,
    method: METHOD.BODY,
  });
});

test("a wrong body client_secret fails exactly as a wrong Basic one does", () => {
  const auth = authenticator();
  const viaBody = auth.authenticate({
    headers: {},
    body: { client_id: CONFIDENTIAL, client_secret: "wrong-secret-value" },
  });
  const viaHeader = auth.authenticate(withHeader(basic(CONFIDENTIAL, "wrong-secret-value")));
  assert.equal(JSON.stringify(viaBody), JSON.stringify(viaHeader));
});

test("a URLSearchParams body is read the same as a plain object", () => {
  const body = new URLSearchParams([["client_id", PUBLIC]]);
  const result = authenticator().authenticate({ headers: {}, body });
  assert.equal(result.clientId, PUBLIC);
  assert.equal(result.authenticated, false);
});

test("a request identifying no client is refused rather than succeeding with null", () => {
  const auth = authenticator();

  for (const request of [
    { headers: {}, body: {} },
    { headers: {}, body: { client_secret: SECRET } },
    {},
    null,
  ]) {
    const result = auth.authenticate(request);
    assert.equal(result.ok, false, JSON.stringify(request));
    assert.equal(result.error, ERROR.INVALID_CLIENT, JSON.stringify(request));
  }
});

test("an over-long body client_id is refused before anything hashes it", () => {
  const result = authenticator().authenticate({
    headers: {},
    body: { client_id: "x".repeat(MAX_CLIENT_ID_LENGTH + 1) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, ERROR.INVALID_CLIENT);
});

test("MAX_CLIENT_ID_LENGTH agrees with the registry's copy", () => {
  // Duplicated rather than imported, as routes/oauthAuthorize.js and lib/cors.js
  // duplicate theirs. This test keeps the copies honest.
  assert.equal(MAX_CLIENT_ID_LENGTH, clientRegistry.MAX_CLIENT_ID_LENGTH);
});

test("PKCE_METHOD is the only method the discovery document advertises", () => {
  // `contract/` is test-only and never deployed (D20, HASHED_DIRS is
  // ["lib", "routes"]), so lib/clientAuth.js may not require it: a module that
  // did would pass this suite and throw MODULE_NOT_FOUND inside the game
  // process. The constant is duplicated and the copies are compared here, as in
  // lib/cors.js and routes/oauthJwks.js.
  assert.deepEqual(
    [...DISCOVERY_CONSTANTS.code_challenge_methods_supported],
    [PKCE_METHOD],
  );
});

// PKCE

test("a correct verifier verifies", () => {
  assert.deepEqual({ ...authenticator().verifyPkce(pkcePair()) }, { ok: true });
});

test("a wrong verifier is invalid_grant", () => {
  const pair = pkcePair();
  const result = authenticator().verifyPkce({ ...pair, codeVerifier: "b".repeat(64) });

  assert.deepEqual({ ...result }, {
    ok: false,
    error: ERROR.INVALID_GRANT,
    errorDescription: VERIFIER_REJECTED,
  });
});

test("every way a verifier can be malformed is refused with the same bytes as a wrong one", () => {
  const auth = authenticator();
  const pair = pkcePair();
  const wrong = auth.verifyPkce({ ...pair, codeVerifier: "b".repeat(64) });

  const malformed = [
    // RFC 7636 section 4.1's bounds. 42 is one under the entropy floor the
    // mechanism assumes: not "nearly right" but a weaker secret.
    "a".repeat(MIN_VERIFIER_LENGTH - 1),
    "a".repeat(MAX_VERIFIER_LENGTH + 1),
    // Outside the unreserved set. Each is a character some client would have
    // base64'd rather than base64url'd, or forgotten to strip.
    `${"a".repeat(63)}+`,
    `${"a".repeat(63)}/`,
    `${"a".repeat(63)}=`,
    `${"a".repeat(63)} `,
    `${"a".repeat(63)}\n`,
    "",
    undefined,
    null,
    12345,
  ];

  for (const codeVerifier of malformed) {
    const result = auth.verifyPkce({ ...pair, codeVerifier });
    // Identical bytes, deliberately: telling a caller that their guess was
    // well-formed is a free hint, and this endpoint gives none.
    assert.equal(JSON.stringify(result), JSON.stringify(wrong), JSON.stringify(codeVerifier));
  }
});

test("the bounds are inclusive at both ends", () => {
  const auth = authenticator();
  for (const length of [MIN_VERIFIER_LENGTH, MAX_VERIFIER_LENGTH]) {
    const verifier = "a".repeat(length);
    assert.equal(auth.verifyPkce(pkcePair(verifier)).ok, true, `length ${length}`);
  }
});

test("the whole unreserved alphabet is accepted", () => {
  const verifier = `${"-._~".repeat(8)}${"aZ0".repeat(4)}${"x".repeat(20)}`;
  assert.equal(verifier.length >= MIN_VERIFIER_LENGTH, true);
  assert.equal(authenticator().verifyPkce(pkcePair(verifier)).ok, true);
});

test("plain is refused at redemption, not only at authorization", () => {
  const auth = authenticator();
  const verifier = "a".repeat(64);

  // The plain transformation is challenge === verifier. Refused even when it
  // matches, because under D1's plain HTTP the realistic attacker can read the
  // authorization request, and plain defends against nothing they do.
  const result = auth.verifyPkce({
    codeChallenge: verifier,
    codeChallengeMethod: "plain",
    codeVerifier: verifier,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, ERROR.INVALID_GRANT);
  assert.match(result.errorDescription, /S256/);
});

test("an absent or unexpected challenge method is refused, never defaulted", () => {
  const auth = authenticator();
  const pair = pkcePair();

  for (const codeChallengeMethod of [undefined, null, "", "s256", "S384", "PLAIN"]) {
    const result = auth.verifyPkce({ ...pair, codeChallengeMethod });
    assert.equal(result.ok, false, String(codeChallengeMethod));
    assert.equal(result.error, ERROR.INVALID_GRANT, String(codeChallengeMethod));
  }
});

test("verifyPkce refuses a code that carries no challenge instead of passing it", () => {
  // The backstop for a caller that skipped mayRedeem: no argument shape makes
  // this function answer `ok: true` without a challenge.
  const auth = authenticator();

  for (const codeChallenge of [null, undefined, ""]) {
    const result = auth.verifyPkce({
      codeChallenge,
      codeChallengeMethod: PKCE_METHOD,
      codeVerifier: "a".repeat(64),
    });
    assert.equal(result.ok, false, JSON.stringify(codeChallenge));
    assert.equal(result.error, ERROR.INVALID_GRANT, JSON.stringify(codeChallenge));
  }
});

test("verifyPkce does not throw on any argument shape", () => {
  // eve.js treats an unhandled throw as fatal, and this runs on the request
  // path. `crypto.timingSafeEqual` on raw strings would throw on a length
  // mismatch, the specific bug this asserts the absence of.
  const auth = authenticator();
  for (const request of [null, undefined, 7, "x", {}, { codeChallenge: {} }]) {
    assert.doesNotThrow(() => auth.verifyPkce(request), JSON.stringify(request));
  }
});

// The invariant
//
// routes/oauthAuthorize.js: "a code minted *with* a challenge must be
// redeemable only with a matching verifier, and a code minted *without* one
// must be redeemable only by a client that authenticated."

test("invariant: a code with a challenge is redeemable with a verifier, authenticated or not", () => {
  const auth = authenticator();
  const { codeChallenge, codeVerifier } = pkcePair();

  for (const authenticated of [true, false]) {
    assert.deepEqual(
      { ...auth.mayRedeem({ authenticated, codeChallenge, codeVerifier }) },
      { ok: true },
      `authenticated: ${authenticated}`,
    );
  }
});

test("invariant: a code with a challenge is not redeemable without a verifier", () => {
  const auth = authenticator();
  const { codeChallenge } = pkcePair();

  for (const authenticated of [true, false]) {
    // Including the authenticated case: a binding that a second credential can
    // waive is not a binding. A confidential client that used PKCE still has to
    // produce the verifier.
    const result = auth.mayRedeem({ authenticated, codeChallenge, codeVerifier: undefined });
    assert.equal(result.ok, false, `authenticated: ${authenticated}`);
    assert.equal(result.error, ERROR.INVALID_GRANT);
  }
});

test("invariant: a code without a challenge is redeemable by an authenticated client", () => {
  const result = authenticator().mayRedeem({
    authenticated: true,
    codeChallenge: null,
    codeVerifier: undefined,
  });
  assert.deepEqual({ ...result }, { ok: true });
});

test("invariant: a code without a challenge is NOT redeemable by a client that did not authenticate", () => {
  // The hole. `if (code.codeChallenge) { checkVerifier() }`, an `if` with no
  // `else`, reads as complete and lands here, granting the code to whoever holds
  // it. On D1's plain HTTP that is PKCE removal for the price of stripping two
  // query parameters from the authorization request.
  const auth = authenticator();

  for (const codeChallenge of [null, undefined, ""]) {
    const result = auth.mayRedeem({ authenticated: false, codeChallenge, codeVerifier: undefined });
    assert.equal(result.ok, false, JSON.stringify(codeChallenge));
    assert.equal(result.error, ERROR.INVALID_GRANT, JSON.stringify(codeChallenge));
    assert.match(result.errorDescription, /without a PKCE challenge/);
  }
});

test("invariant: neither a challenge nor authentication is a refusal, whatever else is present", () => {
  const auth = authenticator();

  // Every shape of "no challenge and no proof", including a verifier being
  // present. A verifier cannot substitute for authentication on a code that was
  // never bound to one.
  const shapes = [
    { authenticated: false, codeChallenge: null, codeVerifier: null },
    { authenticated: false, codeChallenge: null, codeVerifier: "a".repeat(64) },
    { authenticated: undefined, codeChallenge: undefined, codeVerifier: undefined },
    {},
    null,
  ];

  for (const shape of shapes) {
    const result = auth.mayRedeem(shape);
    assert.equal(result.ok, false, JSON.stringify(shape));
    assert.equal(result.error, ERROR.INVALID_GRANT, JSON.stringify(shape));
  }
});

test("invariant: a verifier for a code with no challenge is refused even when authenticated", () => {
  // The client's challenge was lost between the two requests, which from this
  // side is indistinguishable from a stripping attacker. Completing the exchange
  // would leave the client believing its PKCE was in force.
  const result = authenticator().mayRedeem({
    authenticated: true,
    codeChallenge: null,
    codeVerifier: "a".repeat(64),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, ERROR.INVALID_GRANT);
});

test("invariant: `authenticated` is compared identically, so a truthy value does not authenticate", () => {
  const auth = authenticator();

  // Each of these is something a call site could plausibly pass by mistake (the
  // string, the whole authenticate() result, an options object), and each would
  // silently grant every no-challenge code under a truthiness test.
  for (const authenticated of ["false", "true", 1, {}, { authenticated: true }, [], "yes"]) {
    const result = auth.mayRedeem({ authenticated, codeChallenge: null, codeVerifier: null });
    assert.equal(result.ok, false, JSON.stringify(authenticated));
  }
});

test("invariant: mayRedeem's ok does not mean the verifier was checked", () => {
  // The two are separable on purpose, and a route that called only mayRedeem
  // would be wrong. A completely wrong verifier passes mayRedeem and fails
  // verifyPkce.
  const auth = authenticator();
  const { codeChallenge, codeChallengeMethod } = pkcePair();
  const wrong = "z".repeat(64);

  assert.equal(auth.mayRedeem({ authenticated: false, codeChallenge, codeVerifier: wrong }).ok, true);
  assert.equal(
    auth.verifyPkce({ codeChallenge, codeChallengeMethod, codeVerifier: wrong }).ok,
    false,
  );
});

test("invariant: the whole truth table, in one place", () => {
  const auth = authenticator();
  const { codeChallenge, codeVerifier } = pkcePair();

  const table = [
    // challenge, verifier, authenticated -> permitted
    [codeChallenge, codeVerifier, true, true],
    [codeChallenge, codeVerifier, false, true],
    [codeChallenge, null, true, false],
    [codeChallenge, null, false, false],
    [null, codeVerifier, true, false],
    [null, codeVerifier, false, false],
    [null, null, true, true],
    [null, null, false, false],
  ];

  for (const [challenge, verifier, authenticated, permitted] of table) {
    const result = auth.mayRedeem({
      authenticated,
      codeChallenge: challenge,
      codeVerifier: verifier,
    });
    assert.equal(
      result.ok,
      permitted,
      `challenge:${challenge !== null} verifier:${verifier !== null} auth:${authenticated}`,
    );
  }
});

// The constant-time comparisons, structurally
//
// Nothing below measures time. A unit test cannot separate a branch from noise
// on a shared runner. These assert the properties the constant-time argument
// rests on: no early return on a length mismatch, a mismatch is not a throw,
// and the two failing cases are not distinguishable in the answer.

test("structural: a challenge of any length is compared without an early return or a throw", () => {
  const auth = authenticator();
  const codeVerifier = "a".repeat(64);

  // A stored challenge is 43-128 characters; an S256 digest is always 43. A
  // comparison that tested lengths first would branch here, and one that fed
  // `crypto.timingSafeEqual` the raw strings would throw. Both sides are
  // digested to 32 bytes instead, so there is no length to compare.
  for (let length = 1; length <= 200; length += 1) {
    const codeChallenge = "a".repeat(length);
    let result;
    assert.doesNotThrow(() => {
      result = auth.verifyPkce({ codeChallenge, codeChallengeMethod: PKCE_METHOD, codeVerifier });
    }, `length ${length}`);
    assert.equal(JSON.stringify(result), JSON.stringify({
      ok: false,
      error: ERROR.INVALID_GRANT,
      errorDescription: VERIFIER_REJECTED,
    }), `length ${length}`);
  }
});

test("structural: a presented secret of any length is compared without a throw", () => {
  const registry = realRegistry();

  for (let length = 1; length <= 300; length += 1) {
    const clientSecret = "a".repeat(length);
    let verified;
    assert.doesNotThrow(() => {
      verified = registry.verifySecret({ clientId: CONFIDENTIAL, clientSecret });
    }, `length ${length}`);
    assert.equal(verified, false, `length ${length}`);
  }
});

test("structural: both comparisons go through crypto.timingSafeEqual", () => {
  // A source assertion: it proves that neither module compares a credential
  // with `===`, not that the resulting machine code takes constant time.
  const root = path.join(__dirname, "..", "lib");

  for (const file of ["clientAuth.js", "clientRegistry.js"]) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(source, /crypto\.timingSafeEqual\(/, file);
  }
});

// Shape

test("the authenticator is frozen and its verdicts are frozen", () => {
  const auth = authenticator();
  assert.equal(Object.isFrozen(auth), true);
  assert.equal(Object.isFrozen(auth.authenticate(withHeader(basic(CONFIDENTIAL, SECRET)))), true);
  assert.equal(Object.isFrozen(auth.verifyPkce(pkcePair())), true);
  assert.equal(Object.isFrozen(auth.mayRedeem({ authenticated: true })), true);
});

test("construction refuses a registry that cannot verify a secret", () => {
  // A startup refusal, the one place in this module a throw is right.
  for (const registry of [undefined, null, {}, { verifySecret: "nope" }]) {
    assert.throws(
      () => createClientAuthenticator({ registry }),
      /needs a registry with a verifySecret method/,
      JSON.stringify(registry),
    );
  }
});

test("authenticate does not throw on any argument shape", () => {
  const auth = authenticator();
  for (const request of [null, undefined, 7, "x", {}, { headers: 3, body: 4 }]) {
    assert.doesNotThrow(() => auth.authenticate(request), JSON.stringify(request));
  }
});
