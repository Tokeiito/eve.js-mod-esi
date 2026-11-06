/**
 * `GET /v2/oauth/authorize`: the contract, and the runtime guard on the
 * auto-approve branch.
 *
 * Run with:  node --test test/authorizeContract.test.js
 *
 * Two sources, named per assertion the way `test/jwksContract.test.js` names
 * them (D23):
 *
 *   - `contract/sso.js`: the path, and the one PKCE method CCP's discovery
 *     document advertises. Those are transcriptions of CCP's live surface.
 *   - RFC 6749, RFC 7636, and `routes/oauthAuthorize.js` itself: everything
 *     else. The bind page, the poll endpoint, the status codes, the headers and
 *     the HTML have no counterpart on `login.eveonline.com`: `contract/sso.js`
 *     `UNOBSERVED` records that no response header has been captured off that
 *     host, and CCP's authorize page asks for a password where this one shows a
 *     bind code (D3). The assertions check that the documented choices are the
 *     ones made, not that CCP makes them.
 *
 * There is no listener, no store and no game. The route is driven directly with
 * object literals and three doubles (client registry, auth code store, bind
 * adapter), so it is tested independently of those modules.
 *
 * Two tests matter most:
 *
 *   - "a bad redirect_uri renders and never redirects": if it inverts, this
 *     endpoint becomes an open redirector on an origin the player's browser
 *     trusts.
 *   - "the default configuration cannot reach the auto-approve branch": if it
 *     inverts, the server hands out authorization codes for a configured
 *     character to anyone who asks, and every other test still passes.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const sso = require(path.join(__dirname, "../contract/sso"));
const {
  ALLOWED_METHOD,
  AUTHORIZE_PATH,
  BIND_STATUS_PATH,
  BIND_STATUS_QUERY_PARAM,
  CODE_CHALLENGE_METHOD,
  CONTENT_TYPE_HTML,
  CONTENT_TYPE_JSON,
  COPY_LABEL,
  MAX_PENDING_REQUESTS,
  POLL_INTERVAL_MS,
  POLL_STATUS,
  REDIRECT_STATUS,
  RESPONSE_TYPE,
  SCOPE_LIMITS,
  SLASH_COMMAND,
  buildRedirect,
  createOauthAuthorizeRoute,
  parsePkce,
  parseScope,
} = require(path.join(__dirname, "../routes/oauthAuthorize"));

// Fixtures

const CLIENT_ID = "1f0e3dad99908345f7439f8ffabdffc4";
const REDIRECT_URI = "http://127.0.0.1:8080/sso/callback";
const OTHER_REGISTERED_URI = "http://127.0.0.1:9999/a-uri-that-must-never-be-named";
const CHARACTER_ID = 90000001;

/** A real 43-character S256 challenge: base64url of a SHA-256, unpadded. */
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/**
 * A `state` built to break every encoder that is nearly right.
 *
 * `&` and `=` end the parameter for a naive splitter, `+` and the space are the
 * `URLSearchParams`-versus-`encodeURIComponent` disagreement, `#` truncates the
 * URL for anything that forgets to encode it, `%` breaks a double-decode, and
 * the two non-ASCII characters catch a UTF-8 mistake. The state is echoed
 * verbatim.
 */
const GNARLY_STATE = 'a b&c=d#e/f+g%h"i<j>k\\lé☃';

const VALID_QUERY = Object.freeze({
  response_type: RESPONSE_TYPE,
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  scope: "publicData esi-skills.read_skills.v1",
  state: GNARLY_STATE,
  code_challenge: CHALLENGE,
  code_challenge_method: CODE_CHALLENGE_METHOD,
});

/**
 * The three doubles, plus a record of everything that reached them.
 *
 * `bind.state` is the knob the poll tests turn: the bind adapter is the only
 * dependency whose answer changes between two otherwise identical requests, so
 * a whole sign-in (page, poll, approval, redirect) fits in one synchronous test.
 */
function harness(options = {}) {
  const calls = { registry: [], authCodes: [], bindMint: [], bindPeek: [], log: [] };

  const bind = {
    state: "pending",
    characterId: CHARACTER_ID,
    code: "SNOW-42",
    expiresAtOffsetMs: 5 * 60 * 1000,
    mintFailure: null,
    ...(options.bind || {}),
  };

  const clock = { at: 1_700_000_000_000 };

  const registryAnswer = options.registryAnswer
    || (({ redirectUri }) => (redirectUri === REDIRECT_URI
      ? { ok: true, via: "allowlist" }
      : {
        ok: false,
        reason: "redirect_uri_mismatch",
        detail: `Client ${CLIENT_ID} is registered for ${OTHER_REGISTERED_URI}.`,
      }));

  const deps = {
    clientRegistry: {
      check(args) {
        calls.registry.push(args);
        return registryAnswer(args);
      },
    },
    authCodes: {
      mint(args) {
        calls.authCodes.push(args);
        if (options.authCodeFailure) {
          return { code: null, failure: options.authCodeFailure };
        }
        return { code: `authcode-${calls.authCodes.length}`, expiresAt: clock.at + 60_000 };
      },
    },
    bindFlow: {
      mint(args) {
        calls.bindMint.push(args);
        if (bind.mintFailure) return { code: null, failure: bind.mintFailure };
        return { code: bind.code, expiresAt: clock.at + bind.expiresAtOffsetMs };
      },
      peek(requestId) {
        calls.bindPeek.push(requestId);
        return bind.state === "approved"
          ? { state: "approved", characterId: bind.characterId }
          : { state: bind.state };
      },
    },
    now: () => clock.at,
    log: (message) => calls.log.push(message),
    ...(options.deps || {}),
  };

  if ("devAutoApprove" in options) deps.devAutoApprove = options.devAutoApprove;

  return { route: createOauthAuthorizeRoute(deps), calls, bind, clock, deps };
}

/** One authorize request. `query` overrides `VALID_QUERY`; `null` deletes a key. */
function authorize(route, query = {}, request = {}) {
  const merged = { ...VALID_QUERY, ...query };
  for (const [key, value] of Object.entries(merged)) {
    if (value === null) delete merged[key];
  }
  return route.handle({
    method: "GET",
    pathname: AUTHORIZE_PATH,
    query: merged,
    headers: {},
    ...request,
  });
}

/** One poll. */
function poll(route, requestId, request = {}) {
  const query = requestId === undefined ? {} : { [BIND_STATUS_QUERY_PARAM]: requestId };
  return route.handle({
    method: "GET",
    pathname: BIND_STATUS_PATH,
    query,
    headers: {},
    ...request,
  });
}

/** Case-insensitive header read, as `test/jwksContract.test.js` does it. */
function header(response, name) {
  const entry = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === name);
  return entry === undefined ? undefined : entry[1];
}

/** The request id out of the bind page, which is the only place it exists. */
function requestIdOf(page) {
  const found = /data-request-id="([^"]+)"/.exec(page.body);
  assert.ok(found, "the bind page carries a request id");
  return found[1];
}

/** One query parameter, still percent-encoded, out of a redirect URL. */
function rawParam(location, name) {
  const query = location.slice(location.indexOf("?") + 1);
  const found = query.split("&").find((pair) => pair.startsWith(`${name}=`));
  return found === undefined ? undefined : found.slice(name.length + 1);
}

/** Walk a whole sign-in to the point where the poll is about to hand back a code. */
function signInTo(harnessed, query = {}) {
  const page = authorize(harnessed.route, query);
  assert.equal(page.status, 200, "the bind page was served");
  const requestId = requestIdOf(page);
  harnessed.bind.state = "approved";
  return { page, requestId, ready: poll(harnessed.route, requestId) };
}

// The deployable copy of the contract

test("the route's constants are contract/sso.js's, value for value", () => {
  // `routes/` is deployed and `contract/` is not (`lib/sourceHash.js`
  // `HASHED_DIRS` is `["lib", "routes"]` and `scripts/deploy-mod.js` copies
  // exactly that manifest), so a route requiring `../contract/sso` would pass
  // this suite and throw MODULE_NOT_FOUND inside the game process.
  // `routes/oauthJwks.js`, `lib/cors.js` and `lib/headers.js` duplicate their
  // contract constants for the same reason and are checked the same way.
  assert.equal(AUTHORIZE_PATH, sso.DISCOVERY_ENDPOINT_PATHS.authorization);

  // The discovery document this replica serves advertises S256 and nothing
  // else. An endpoint that accepted `plain` would contradict its own published
  // metadata, so the two constants have to move together.
  assert.deepEqual(
    [...sso.DISCOVERY_CONSTANTS.code_challenge_methods_supported],
    [CODE_CHALLENGE_METHOD],
  );

  // And the endpoint the discovery document points at is the one mounted here.
  assert.ok(route().paths.includes(AUTHORIZE_PATH));
});

test("the poll endpoint cannot collide with CCP's SSO surface", () => {
  // It is ours, not CCP's (D23), for the reason given in `routes/health.js`: an
  // underscore-prefixed first segment is not a shape CCP's SSO paths use, so no
  // future endpoint of theirs can grow into it.
  assert.match(BIND_STATUS_PATH, /^\/_mod\//);

  for (const ccpPath of [
    ...Object.values(sso.DISCOVERY_ENDPOINT_PATHS),
    sso.JWKS_PATH,
    sso.OPENID_DISCOVERY_PATH,
    ...sso.DISCOVERY_PATHS,
  ]) {
    assert.notEqual(BIND_STATUS_PATH, ccpPath);
    assert.ok(!ccpPath.startsWith("/_mod/"), `${ccpPath} is not in the mod's namespace`);
  }
});

test("the route is the shape lib/ssoDispatch.js validates at construction", () => {
  const built = route();

  assert.equal(built.name, "OauthAuthorize");
  assert.ok(Array.isArray(built.paths) && built.paths.length === 2);
  assert.ok(Object.isFrozen(built) && Object.isFrozen(built.paths));
  assert.equal(typeof built.handle, "function");
  for (const p of built.paths) assert.ok(p.startsWith("/"));
});

test("a missing dependency is refused at construction, not at request time", () => {
  const ok = {
    clientRegistry: { check: () => ({ ok: true }) },
    authCodes: { mint: () => ({ code: "x" }) },
    bindFlow: { mint: () => ({ code: "y" }), peek: () => ({ state: "pending" }) },
  };

  assert.throws(() => createOauthAuthorizeRoute({ ...ok, clientRegistry: {} }), /clientRegistry/);
  assert.throws(() => createOauthAuthorizeRoute({ ...ok, authCodes: {} }), /authCodes/);
  assert.throws(() => createOauthAuthorizeRoute({ ...ok, bindFlow: { mint() {} } }), /peek/);
  assert.doesNotThrow(() => createOauthAuthorizeRoute(ok));
});

// Channel one: the error that must never be redirected

test("a bad redirect_uri is refused at the SSO, rendered, never redirected", () => {
  const { route: built, calls } = harness();
  const response = authorize(built, { redirect_uri: "http://evil.example/steal" });

  assert.equal(response.status, 400);
  assert.equal(header(response, "content-type"), CONTENT_TYPE_HTML);

  // No way onward: not a Location, not a status that carries one, and not a
  // meta refresh or a link smuggled into the body.
  assert.equal(header(response, "location"), undefined);
  assert.ok(response.status < 300 || response.status >= 400);
  assert.ok(!/http-equiv=["']?refresh/i.test(response.body));
  assert.ok(!response.body.includes("evil.example"));

  // The registry was asked: this is a refusal, not a route that forgot to
  // check. If this stops being true the test above passes for the wrong reason.
  assert.deepEqual(calls.registry, [{ clientId: CLIENT_ID, redirectUri: "http://evil.example/steal" }]);

  // And nothing downstream was touched: no bind code burned, no code minted.
  assert.equal(calls.bindMint.length, 0);
  assert.equal(calls.authCodes.length, 0);
});

test("the rendered refusal leaks nothing about what would have been accepted", () => {
  const { route: built, calls } = harness();
  const response = authorize(built, { redirect_uri: "http://evil.example/steal" });

  // Not the registered URI, not the submitted one, not the machine reason, not
  // the operator sentence, and not the client id. A prober learns only that it
  // did not work.
  for (const secret of [
    OTHER_REGISTERED_URI,
    "9999",
    "evil.example",
    "redirect_uri_mismatch",
    "is registered for",
    CLIENT_ID,
  ]) {
    assert.ok(!response.body.includes(secret), `the page does not contain ${secret}`);
  }

  // The operator gets all of it, in the log, where the client cannot read it.
  const line = calls.log.join("\n");
  assert.match(line, /redirect_uri_mismatch/);
  assert.match(line, new RegExp(OTHER_REGISTERED_URI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("every unusable redirect target renders rather than redirecting", () => {
  const cases = {
    "no redirect_uri at all": null,
    "an empty redirect_uri": "",
    "a relative redirect_uri": "/callback",
    "a redirect_uri with a fragment": "http://127.0.0.1:8080/cb#frag",
    "a redirect_uri that is not a URL": "not a url at all",
    "an absurdly long redirect_uri": `http://127.0.0.1:8080/${"a".repeat(4096)}`,
  };

  for (const [label, redirect_uri] of Object.entries(cases)) {
    const { route: built, calls } = harness();
    const response = authorize(built, { redirect_uri });

    assert.equal(response.status, 400, label);
    assert.equal(header(response, "location"), undefined, label);
    assert.equal(header(response, "content-type"), CONTENT_TYPE_HTML, label);
    // Shape is checked before the registry is consulted: a URI that cannot be
    // appended to is unusable whatever the registry would say, and asking first
    // would put an unbounded string into the registry module.
    assert.equal(calls.registry.length, 0, label);
  }
});

test("a missing or implausible client_id renders: there is nothing to validate against", () => {
  for (const client_id of [null, "", "x".repeat(300)]) {
    const { route: built, calls } = harness();
    const response = authorize(built, { client_id });

    assert.equal(response.status, 400);
    assert.equal(header(response, "location"), undefined);
    assert.equal(calls.registry.length, 0);
  }
});

// Channel two: everything after the target is proved

test("post-validation errors go back by redirect, with the verbatim state", () => {
  const cases = [
    [{ response_type: null }, "invalid_request"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ response_type: "code id_token" }, "unsupported_response_type"],
    [{ scope: 'esi-skills.read_skills.v1 bad"scope' }, "invalid_scope"],
    [{ scope: "x".repeat(SCOPE_LIMITS.maxTotalLength + 1) }, "invalid_scope"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: "too-short" }, "invalid_request"],
    [{ code_challenge: null }, "invalid_request"],
    [{ code_challenge_method: null }, "invalid_request"],
  ];

  for (const [query, expectedError] of cases) {
    const { route: built } = harness();
    const response = authorize(built, query);
    const label = JSON.stringify(query);

    assert.equal(response.status, REDIRECT_STATUS, label);
    const location = header(response, "location");
    assert.ok(location.startsWith(`${REDIRECT_URI}?`), label);

    const url = new URL(location);
    assert.equal(url.searchParams.get("error"), expectedError, label);
    assert.ok((url.searchParams.get("error_description") || "").length > 0, label);
    assert.equal(url.searchParams.get("code"), null, "no code on an error redirect");

    // Verbatim, through a form decoder...
    assert.equal(url.searchParams.get("state"), GNARLY_STATE, label);
    // ...and through the other decoder half the ecosystem uses. `%20`
    // round-trips through both where `URLSearchParams`' `+` round-trips only
    // through one, and a client that saw a `+` where it wrote a space would
    // conclude the state had been tampered with.
    assert.equal(decodeURIComponent(rawParam(location, "state")), GNARLY_STATE, label);
    assert.ok(!rawParam(location, "state").includes("+"), "a literal space is %20, never +");

    // The refusal is not cacheable and does not hand the client's server the
    // whole authorization request in a Referer.
    assert.equal(header(response, "cache-control"), "no-store", label);
    assert.equal(header(response, "referrer-policy"), "no-referrer", label);
    assert.equal(response.body, "", "bodiless; the Location is the whole message");
  }
});

test("a state that was not sent is not invented, and an empty one is echoed", () => {
  const { route: absent } = harness();
  const noState = header(authorize(absent, { state: null, response_type: null }), "location");
  assert.ok(!noState.includes("state="), "RFC 6749 returns state only when it was sent");

  const { route: empty } = harness();
  const emptyState = header(authorize(empty, { state: "", response_type: null }), "location");
  assert.match(emptyState, /(^|[?&])state=($|&)/, "`?state=` is a present, empty state");
});

test("a redirect_uri that already has a query string is appended to, not rewritten", () => {
  const registered = "http://127.0.0.1:8080/cb?tenant=alpha&v=2";
  const { route: built } = harness({
    registryAnswer: ({ redirectUri }) =>
      (redirectUri === registered ? { ok: true, via: "allowlist" } : { ok: false, reason: "no" }),
  });

  const location = header(
    authorize(built, { redirect_uri: registered, response_type: null }),
    "location",
  );

  // The registered bytes survive character for character. `new URL(...)` plus
  // `searchParams.set` would re-serialize the whole URI, and the registry
  // matched it exactly, so a normalized variant is a target nobody approved.
  assert.ok(location.startsWith(`${registered}&`), location);
  assert.equal(new URL(location).searchParams.get("tenant"), "alpha");
});

// Success

test("a completed sign-in redirects with the minted code and the echoed state", () => {
  const harnessed = harness();
  const { ready, requestId } = signInTo(harnessed);

  assert.equal(ready.status, 200);
  assert.equal(header(ready, "content-type"), CONTENT_TYPE_JSON);

  const answer = JSON.parse(ready.body);
  assert.equal(answer.status, POLL_STATUS.READY);

  const url = new URL(answer.redirect);
  assert.equal(`${url.origin}${url.pathname}`, REDIRECT_URI);

  // The code is the one `authCodes.mint` returned: not a re-derivation, not a
  // second mint, not a truncation.
  assert.equal(harnessed.calls.authCodes.length, 1);
  assert.equal(url.searchParams.get("code"), "authcode-1");
  assert.equal(url.searchParams.get("state"), GNARLY_STATE);
  assert.equal(decodeURIComponent(rawParam(answer.redirect, "state")), GNARLY_STATE);
  assert.equal(url.searchParams.get("error"), null);

  // The character reached the code store and never reached the browser.
  assert.equal(harnessed.calls.authCodes[0].characterId, CHARACTER_ID);
  assert.ok(!ready.body.includes(String(CHARACTER_ID)));
  assert.equal(harnessed.calls.bindPeek[0], requestId);
});

test("the whole validated request reaches authCodes.mint, and nothing else does", () => {
  const harnessed = harness();
  signInTo(harnessed);

  assert.deepEqual(harnessed.calls.authCodes[0], {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope: "publicData esi-skills.read_skills.v1",
    codeChallenge: CHALLENGE,
    codeChallengeMethod: CODE_CHALLENGE_METHOD,
    characterId: CHARACTER_ID,
  });

  // `state` is this route's to echo and not the code's to carry. A code store
  // that held it would be a second place for it to be wrong.
  assert.ok(!("state" in harnessed.calls.authCodes[0]));
});

// Scopes

test("publicData and unknown esi-* scopes are accepted and recorded, not refused", () => {
  // Three scope names whose ESI routes CCP removed years ago are still
  // requested by tools that cannot be modified. Refusing them would stop those
  // tools before consent, a dead end for everybody.
  const scope = [
    "publicData",
    "esi-characters.read_bookmarks.v1",
    "esi-characters.read_opportunities.v1",
    "esi-not-a-real-scope.invented_here.v9",
  ].join(" ");

  const harnessed = harness();
  signInTo(harnessed, { scope });

  assert.equal(harnessed.calls.authCodes.length, 1, "it reached the code store at all");
  assert.equal(harnessed.calls.authCodes[0].scope, scope, "recorded verbatim, order preserved");
});

test("a scope that is neither publicData nor esi-*-shaped is accepted too", () => {
  // Unknown scopes (a generic OAuth library that appends `openid`, a fork
  // carrying an invented scope, a typo) are granted: refusing them produces a
  // dead end at the point in the flow where the user cannot help and the tool's
  // author is not present. Granting them costs nothing, because no route here
  // requires a scope that does not exist.
  const harnessed = harness();
  signInTo(harnessed, { scope: "openid profile weird_but_legal" });
  assert.equal(harnessed.calls.authCodes[0].scope, "openid profile weird_but_legal");
});

test("scopes are bounded and syntax-checked, because they end up in a signed token", () => {
  assert.ok(parseScope('has"quote').failure);
  assert.ok(parseScope("has\\backslash").failure);
  assert.ok(parseScope("has\ttab").failure);
  assert.ok(parseScope("has\nnewline").failure);
  assert.ok(parseScope("x".repeat(SCOPE_LIMITS.maxTokenLength + 1)).failure);
  assert.ok(parseScope("x".repeat(SCOPE_LIMITS.maxTotalLength + 1)).failure);

  const many = Array.from({ length: SCOPE_LIMITS.maxTokens + 1 }, (_, i) => `esi-s${i}.v1`);
  assert.ok(parseScope(many.join(" ")).failure);

  // Empty and absent are both "no scopes", which real EVE SSO permits.
  assert.deepEqual(parseScope(undefined), { scope: "", scopes: [] });
  assert.deepEqual(parseScope(""), { scope: "", scopes: [] });

  // Runs of spaces are separators, not empty scopes.
  assert.equal(parseScope("  publicData   esi-a.v1 ").scope, "publicData esi-a.v1");

  // Duplicates are dropped, first occurrence wins, order preserved. This is the
  // one normalization that provably cannot change what a token authorises.
  assert.equal(parseScope("a b a c b").scope, "a b c");
});

// PKCE

test("code_challenge reaches authCodes.mint byte for byte", () => {
  // The token endpoint compares this against `base64url(sha256(verifier))`. A
  // trim, a case fold or a base64 round trip here breaks PKCE for every client
  // silently: authorization succeeds and token exchange fails. So this is a byte
  // comparison.
  const harnessed = harness();
  signInTo(harnessed);

  const stored = harnessed.calls.authCodes[0].codeChallenge;
  assert.equal(stored, CHALLENGE);
  assert.equal(Buffer.from(stored, "utf8").compare(Buffer.from(CHALLENGE, "utf8")), 0);
  assert.equal(harnessed.calls.authCodes[0].codeChallengeMethod, CODE_CHALLENGE_METHOD);
});

test("a challenge at both ends of RFC 7636's length range survives unchanged", () => {
  for (const challenge of ["A".repeat(43), `${"-._~".repeat(31)}ABCD`.slice(0, 128)]) {
    const harnessed = harness();
    signInTo(harnessed, { code_challenge: challenge });
    assert.equal(harnessed.calls.authCodes[0].codeChallenge, challenge);
  }
});

test("a missing code_challenge is accepted, and arrives as an explicit null", () => {
  // Accepted because CCP's `code_challenge_methods_supported` says which
  // methods exist, not that PKCE is mandatory (RFC 8414 §2), and because the
  // token endpoint authenticates confidential clients with Basic auth instead.
  // Requiring a challenge here would refuse every server-side tool in the
  // ecosystem at the authorization endpoint.
  const harnessed = harness();
  signInTo(harnessed, { code_challenge: null, code_challenge_method: null });

  assert.equal(harnessed.calls.authCodes.length, 1);
  // `null`, not absent: the token endpoint has to tell "no PKCE" from "a
  // challenge I failed to read", because the two have opposite redemption rules.
  assert.ok("codeChallenge" in harnessed.calls.authCodes[0]);
  assert.equal(harnessed.calls.authCodes[0].codeChallenge, null);
  assert.equal(harnessed.calls.authCodes[0].codeChallengeMethod, null);
});

test("plain is refused, and so is every way of arriving at it by default", () => {
  // `plain` protects against nothing an attacker who can read the request can
  // defeat (RFC 7636 §7.2), and D1 puts this replica on plain HTTP where that
  // attacker is the realistic one. A `plain` challenge would look like PKCE in
  // every log and be worth nothing.
  assert.match(parsePkce(CHALLENGE, "plain").failure, /S256/);
  assert.match(parsePkce(CHALLENGE, "PLAIN").failure, /S256/);
  assert.match(parsePkce(CHALLENGE, "s256").failure, /S256/, "the method is case-sensitive");

  // RFC 7636 §4.3 defaults an omitted method to `plain`, which is refused, so
  // refusing the omission outright is the same outcome with a message the
  // client's author can act on. Guessing S256 instead would let a client that
  // computed a `plain` challenge through here to fail at token exchange.
  assert.match(parsePkce(CHALLENGE, undefined).failure, /S256/);
  assert.match(parsePkce(CHALLENGE, "").failure, /S256/);

  // And a method with nothing to apply it to is a challenge lost in the client.
  // Minting a code with no PKCE binding for a client that believes it has one
  // is a silent downgrade.
  assert.ok(parsePkce(undefined, CODE_CHALLENGE_METHOD).failure);
});

// The bind page

test("the bind page carries the code bindFlow.mint returned, and its own poller", () => {
  const harnessed = harness({ bind: { code: "SNOW-42" } });
  const page = authorize(harnessed.route);

  assert.equal(page.status, 200);
  assert.equal(header(page, "content-type"), CONTENT_TYPE_HTML);
  assert.equal(harnessed.calls.bindMint.length, 1);

  // The code a player reads and retypes, in the document.
  assert.ok(page.body.includes("SNOW-42"), "the bind code is on the page");
  assert.match(page.body, /^<!doctype html>/);

  // It is shown as the whole command the bind parser accepts, not as a bare
  // code the player has to remember a command for. A page that told them to
  // type something the parser refuses would fail as a player who is sure they
  // did it right.
  assert.equal(SLASH_COMMAND, "/esi");
  assert.ok(page.body.includes("/esi SNOW-42"), "the exact line the player types");
  // The code appears only attached to the command, so a player cannot read a
  // bare code off the page and type it on its own.
  assert.equal(page.body.split("SNOW-42").length - 1, 1);
  assert.ok(page.body.includes(`${SLASH_COMMAND} SNOW-42`));

  // The request id the bind was minted against is the one the page polls with.
  assert.equal(requestIdOf(page), harnessed.calls.bindMint[0].requestId);

  // Unguessable: 32 random bytes as base64url. It is the only thing standing
  // between a stranger and somebody else's in-flight sign-in.
  assert.match(requestIdOf(page), /^[A-Za-z0-9_-]{43}$/);

  // Two sign-ins never share one.
  assert.notEqual(requestIdOf(authorize(harnessed.route)), requestIdOf(page));

  // The poll's wiring is data on an element, not an inlined JSON blob, which
  // makes injecting a value into the page's script structurally impossible.
  assert.ok(page.body.includes(`data-poll-url="${BIND_STATUS_PATH}"`));
  assert.ok(page.body.includes(`data-interval="${POLL_INTERVAL_MS}"`));
  assert.match(page.body, /data-expires-in="(\d+)"/);

  // A duration, not a timestamp: the browser's clock is not this server's, and
  // an absolute deadline would make a few minutes of skew look like an expiry.
  assert.equal(Number(/data-expires-in="(\d+)"/.exec(page.body)[1]), 5 * 60 * 1000);
});

test("the copy button copies the line the player is looking at, and only that", () => {
  const harnessed = harness({ bind: { code: "SNOW-42" } });
  const page = authorize(harnessed.route);

  // A button, and it says what it does. The code box already selects whole on
  // one click, so the button covers the step after the selection. On a phone,
  // where there is no Ctrl+C, it is the only way the line moves.
  assert.ok(page.body.includes('<button type="button" id="copy" class="copy">'));
  assert.ok(page.body.includes(COPY_LABEL), "the button is labelled");

  // The command is in the document once and the button reads it from there.
  // Repeating it into a `data-` attribute would be a second place for it to be
  // right, and the displayed copy and the clipboard copy could disagree, which
  // surfaces as a player certain they typed what they saw.
  assert.ok(page.body.includes(`<p class="code" id="command">${SLASH_COMMAND} SNOW-42</p>`));
  assert.equal(page.body.split("SNOW-42").length - 1, 1);
  assert.ok(page.body.includes("document.getElementById('command')"));
  assert.ok(page.body.includes("cmd.textContent"));

  // Wired with `addEventListener`, never with an attribute. An inline handler
  // is what `script-src 'nonce-...'` refuses, and a button whose handler the CSP
  // ate fails silently.
  assert.ok(page.body.includes("copy.addEventListener('click'"));
  assert.ok(!/\son[a-z]+=/i.test(page.body), "no inline event handler anywhere");

  // Three ways to copy, in order, because this page's ordinary home is a plain
  // HTTP address that is not `127.0.0.1`, where `navigator.clipboard` does not
  // exist: every browser denies it in an insecure context.
  assert.ok(page.body.includes("navigator.clipboard&&navigator.clipboard.writeText"));
  assert.ok(page.body.includes("document.execCommand('copy')"));
  assert.ok(page.body.includes("selectNodeContents(cmd)"), "and failing that, it selects it");

  // Hidden until the script that gives it meaning has run. A dead button beside
  // a code the player must retype by hand is worse than no button.
  assert.ok(page.body.includes(".copy{display:none"));
  assert.ok(page.body.includes("copy.className='copy ready'"));

  // The icon is drawn, not fetched: `img-src 'none'` is in the CSP because this
  // page fetches nothing, and an `xmlns` (unneeded for `<svg>` in HTML) would
  // put the document's only absolute URL in it.
  assert.ok(page.body.includes("<svg class=\"icon\""));
  assert.ok(!page.body.includes("xmlns"));
});

test("the bind page names nothing from the request", () => {
  const harnessed = harness();
  const page = authorize(harnessed.route);

  // `client_id` is attacker-chosen, and a page that renders it can be made to
  // say anything above a prompt asking the player to act. The bind code already
  // tells two concurrent sign-ins apart, which is all naming the application
  // would have bought.
  for (const value of [CLIENT_ID, REDIRECT_URI, GNARLY_STATE, CHALLENGE, "publicData"]) {
    assert.ok(!page.body.includes(value), `the page does not contain ${value}`);
  }
});

test("the page's CSP describes exactly what the page contains", () => {
  const page = authorize(harness().route);
  const csp = header(page, "content-security-policy");

  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self'/);

  // A nonce, not `'unsafe-inline'`: the latter would re-open a class of
  // injection this page must not be exposed to.
  assert.ok(!csp.includes("unsafe-inline"));
  const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/.exec(csp);
  assert.ok(nonce, "a script nonce is declared");

  // The header's nonce and the document's are the same value. A mismatch fails
  // as a blank page rather than as an error, so it is asserted.
  assert.ok(page.body.includes(`<script nonce="${nonce[1]}">`));
  assert.ok(page.body.includes(`<style nonce="${nonce[1]}">`));

  // Nothing is fetched from anywhere: no build step, no CDN, no font, no image
  // (D5/D20). The CSP surface of a page served over plain HTTP by a game-server
  // mod should be as small as it can be.
  assert.ok(!/<(script|link|img|iframe)[^>]+src=/i.test(page.body));
  assert.ok(!/https?:\/\//i.test(page.body.replace(/<!doctype html>/i, "")));

  // Fresh per response; a reused nonce is not a nonce.
  const second = header(authorize(harness().route), "content-security-policy");
  assert.notEqual(csp, second);
});

test("the page and every redirect refuse to be cached or to leak a Referer", () => {
  const page = authorize(harness().route);
  assert.equal(header(page, "cache-control"), "no-store");
  assert.equal(header(page, "referrer-policy"), "no-referrer");
  assert.equal(header(page, "x-frame-options"), "DENY");
  assert.equal(header(page, "x-content-type-options"), "nosniff");
});

// The poll: not an oracle

test("the poll answers pending without revealing anything", () => {
  const harnessed = harness({ bind: { state: "pending" } });
  const requestId = requestIdOf(authorize(harnessed.route));
  const response = poll(harnessed.route, requestId);

  assert.equal(response.status, 200);
  assert.equal(header(response, "content-type"), CONTENT_TYPE_JSON);
  assert.equal(header(response, "cache-control"), "no-store");

  // Two members would already be one too many. The browser needs "not yet".
  assert.deepEqual(JSON.parse(response.body), { status: POLL_STATUS.PENDING });

  // Nothing about who, what or for whom.
  for (const secret of [String(CHARACTER_ID), CLIENT_ID, "SNOW-42", REDIRECT_URI, CHALLENGE]) {
    assert.ok(!response.body.includes(secret));
  }

  // No CORS header at all: this endpoint hands back a URL containing an
  // authorization code, and a cross-origin page that learned a request id must
  // not be able to read it.
  assert.equal(header(response, "access-control-allow-origin"), undefined);
});

test("an unknown request id and an expired one are byte-identical", () => {
  // The bind store holds this line for bind codes (an unclaimed code and a
  // never-minted one are indistinguishable to the caller) and it has to hold
  // for request ids too, or the poll becomes an enumeration oracle for
  // in-flight sign-ins.
  const expired = harness({ bind: { state: "expired" } });
  const expiredAnswer = poll(expired.route, requestIdOf(authorize(expired.route)));

  const unknown = harness();
  const unknownAnswer = poll(unknown.route, "A".repeat(43));

  assert.equal(expiredAnswer.status, unknownAnswer.status);
  assert.equal(expiredAnswer.body, unknownAnswer.body);
  assert.deepEqual(expiredAnswer.headers, unknownAnswer.headers);
  assert.deepEqual(JSON.parse(unknownAnswer.body), { status: POLL_STATUS.EXPIRED });

  // The unknown one never asked the bind store, so a store that logged its
  // lookups could not be used as the oracle either.
  assert.equal(unknown.calls.bindPeek.length, 0);
});

test("a request that timed out here answers the same as one that never existed", () => {
  const harnessed = harness({ bind: { expiresAtOffsetMs: 60_000 } });
  const requestId = requestIdOf(authorize(harnessed.route));

  harnessed.clock.at += 60_001;
  const timedOut = poll(harnessed.route, requestId);

  assert.deepEqual(JSON.parse(timedOut.body), { status: POLL_STATUS.EXPIRED });
  assert.equal(harnessed.calls.authCodes.length, 0, "an expired sign-in mints nothing");
});

test("a second poll after a code was handed back gets nothing", () => {
  // The pending entry is consumed before the code is minted, so a retry, a
  // duplicated fetch or a double-clicked page cannot mint a second code against
  // one authorization. The cost (a response lost in transit costs the player the
  // sign-in) is the direction to fail in.
  const harnessed = harness();
  const { requestId } = signInTo(harnessed);

  const replay = poll(harnessed.route, requestId);
  assert.deepEqual(JSON.parse(replay.body), { status: POLL_STATUS.EXPIRED });
  assert.equal(harnessed.calls.authCodes.length, 1, "exactly one code, ever");
});

test("every no-information poll is byte-identical, misshapen ones included", () => {
  // The bind store asserts `JSON.stringify` identity across six no-information
  // paths and puts its throttle ahead of its shape check, because answering a
  // malformed guess differently from a well-formed one tells an attacker the
  // guess had the right shape. The same line is held here: there is no shape
  // check in front of the lookup at all.
  const { route: built, calls } = harness();
  const baseline = poll(built, "A".repeat(43));

  for (const requestId of [
    undefined,          // no parameter at all
    "",                 // present and empty
    "short",            // too short to be one of ours
    "has spaces",       // not the alphabet we mint from
    "has/slash",
    "x".repeat(4096),   // absurd
    "A".repeat(43),     // perfectly well-formed, and still never minted
  ]) {
    const response = poll(built, requestId);
    assert.equal(response.status, baseline.status, JSON.stringify(requestId));
    assert.equal(response.body, baseline.body, JSON.stringify(requestId));
    assert.deepEqual(response.headers, baseline.headers, JSON.stringify(requestId));
  }

  assert.deepEqual(JSON.parse(baseline.body), { status: POLL_STATUS.EXPIRED });
  assert.equal(header(baseline, "content-type"), CONTENT_TYPE_JSON);

  // None of them reached the bind store (see above).
  assert.equal(calls.bindPeek.length, 0);
});

test("the poll publishes state and nothing else, whatever peek hands it", () => {
  // The bind store's `inspect` returns `{state, characterID, accountID, role,
  // isGM, claimedAt}` on a claimed entry and the adapter narrows it. This
  // asserts the narrowing is not the only thing between that object and the
  // wire: the route reads named fields and never spreads what it was given.
  const leaky = {
    state: "approved",
    characterId: CHARACTER_ID,
    characterID: CHARACTER_ID,
    accountID: 7788,
    role: "director",
    isGM: true,
    claimedAt: 1_700_000_000_000,
  };

  const harnessed = harness({ deps: {} });
  const requestId = requestIdOf(authorize(harnessed.route));
  harnessed.deps.bindFlow.peek = () => leaky;

  const ready = poll(harnessed.route, requestId);
  const answer = JSON.parse(ready.body);

  assert.deepEqual(Object.keys(answer).sort(), ["redirect", "status"]);
  for (const secret of ["characterID", "accountID", "role", "isGM", "claimedAt", "director",
    "7788", "true", String(CHARACTER_ID)]) {
    assert.ok(!ready.body.includes(secret), `the poll does not publish ${secret}`);
  }

  // And a pending answer is one member, not one member plus whatever came back.
  const pendingHarness = harness();
  pendingHarness.deps.bindFlow.peek = () => ({ ...leaky, state: "pending" });
  const waiting = poll(pendingHarness.route, requestIdOf(authorize(pendingHarness.route)));
  assert.deepEqual(JSON.parse(waiting.body), { status: POLL_STATUS.PENDING });
});

test("an approval with no usable character mints nothing and tells the application", () => {
  const harnessed = harness({ bind: { state: "pending", characterId: null } });
  const requestId = requestIdOf(authorize(harnessed.route));
  harnessed.bind.state = "approved";

  const answer = JSON.parse(poll(harnessed.route, requestId).body);
  assert.equal(answer.status, POLL_STATUS.READY);
  assert.equal(harnessed.calls.authCodes.length, 0);

  // The browser's job stays "go where you are told"; the application learns
  // through its redirect_uri, which is the only channel it has.
  const url = new URL(answer.redirect);
  assert.equal(url.searchParams.get("error"), "server_error");
  assert.equal(url.searchParams.get("state"), GNARLY_STATE);
  assert.equal(url.searchParams.get("code"), null);
});

test("a code store that cannot mint becomes an OAuth error, not a broken page", () => {
  const harnessed = harness({ authCodeFailure: "the code store is not writable" });
  const { ready } = signInTo(harnessed);

  const url = new URL(JSON.parse(ready.body).redirect);
  assert.equal(url.searchParams.get("error"), "server_error");
  assert.equal(url.searchParams.get("state"), GNARLY_STATE);
});

test("a bind store that cannot mint refuses through the redirect channel", () => {
  const harnessed = harness({ bind: { mintFailure: "the bind store is full" } });
  const response = authorize(harnessed.route);

  assert.equal(response.status, REDIRECT_STATUS);
  const url = new URL(header(response, "location"));
  assert.equal(url.searchParams.get("error"), "temporarily_unavailable");
  assert.equal(url.searchParams.get("state"), GNARLY_STATE);
  // The operator's copy carries the store's own sentence; the client's does not.
  assert.match(harnessed.calls.log.join("\n"), /the bind store is full/);
});

test("the pending store is capped, and a live sign-in is never evicted for a new one", () => {
  const harnessed = harness();
  const first = requestIdOf(authorize(harnessed.route));

  for (let i = 1; i < MAX_PENDING_REQUESTS; i += 1) authorize(harnessed.route);

  const overflow = authorize(harnessed.route);
  assert.equal(overflow.status, REDIRECT_STATUS);
  assert.equal(
    new URL(header(overflow, "location")).searchParams.get("error"),
    "temporarily_unavailable",
  );

  // The first player's sign-in still works. Evicting the oldest to make room
  // would turn a flood into a working denial of service against real players.
  harnessed.bind.state = "approved";
  assert.equal(JSON.parse(poll(harnessed.route, first).body).status, POLL_STATUS.READY);
});

// Methods and headers

test("both paths answer GET only, and each refuses in the type it serves", () => {
  const { route: built, calls } = harness();

  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]) {
    const page = authorize(built, {}, { method });
    assert.equal(page.status, 405, method);
    assert.equal(header(page, "allow"), ALLOWED_METHOD, method);
    assert.equal(header(page, "content-type"), CONTENT_TYPE_HTML, method);

    const status = poll(built, "A".repeat(43), { method });
    assert.equal(status.status, 405, method);
    assert.equal(header(status, "allow"), ALLOWED_METHOD, method);
    assert.equal(header(status, "content-type"), CONTENT_TYPE_JSON, method);
  }

  // HEAD is refused rather than answered, unlike `routes/oauthJwks.js`. A JWKS
  // is a document; this is an action (a GET mints a request id, mints a bind
  // code and takes a slot), so a monitoring probe pointed here would burn bind
  // codes indefinitely.
  assert.equal(calls.bindMint.length, 0, "no method probe reached the bind store");
  assert.equal(calls.registry.length, 0);
});

test("the 405 page's CSP nonce still matches its own document", () => {
  // The `Allow` is merged onto the page's own headers rather than onto a
  // rebuilt set, because rebuilding would mint a second nonce and the mismatch
  // would surface as a blank page rather than as an error.
  const page = authorize(harness().route, {}, { method: "POST" });
  const nonce = /script-src 'nonce-([A-Za-z0-9_-]+)'/
    .exec(header(page, "content-security-policy"))[1];
  assert.ok(page.body.includes(`<style nonce="${nonce}">`));
});

test("every header name is written lowercase, as both listeners' routes do", () => {
  // `server.js` puts every name through `lib/headers.js` `titleCase` on the way
  // to the socket, so lowercase here is the codebase's internal spelling and
  // `Location`, `Content-Security-Policy` and the rest leave correctly cased.
  const responses = [
    authorize(harness().route),
    authorize(harness().route, { response_type: null }),
    poll(harness().route, "A".repeat(43)),
  ];

  for (const response of responses) {
    for (const name of Object.keys(response.headers || {})) {
      assert.equal(name, name.toLowerCase(), name);
    }
  }
});

// The auto-approve guard

test("the default configuration cannot reach the auto-approve branch", () => {
  // The first acceptance criterion for the guard, and it must not be folded
  // into another test: when this inverts, every other test in this file still
  // passes and the server hands out codes for a configured character to anyone
  // who asks.
  const defaults = [
    undefined,
    {},
    { enabled: false, characterID: null },
    // Off, but with a character configured: a knob that is only half turned must
    // still be off.
    { enabled: false, characterID: CHARACTER_ID },
    { enabled: null, characterID: CHARACTER_ID },
  ];

  for (const devAutoApprove of defaults) {
    const harnessed = harness({ devAutoApprove });
    const response = authorize(harnessed.route);
    const label = JSON.stringify(devAutoApprove) || "undefined";

    // A human is required: the bind page, not a redirect.
    assert.equal(response.status, 200, label);
    assert.equal(header(response, "location"), undefined, label);
    assert.equal(harnessed.calls.bindMint.length, 1, label);
    assert.equal(harnessed.calls.authCodes.length, 0, label);
    assert.ok(!harnessed.calls.log.join("\n").includes("AUTO-APPROVE"), label);
  }
});

test("enabled, it completes headlessly and logs loudly on every use", () => {
  const harnessed = harness({
    devAutoApprove: { enabled: true, characterID: CHARACTER_ID },
  });

  const response = authorize(harnessed.route);

  // No page, no bind code, no poll: the human is the only thing skipped.
  assert.equal(response.status, REDIRECT_STATUS);
  assert.equal(harnessed.calls.bindMint.length, 0);

  const url = new URL(header(response, "location"));
  assert.equal(url.searchParams.get("code"), "authcode-1");
  assert.equal(url.searchParams.get("state"), GNARLY_STATE);

  // Everything before the branch still ran: the client was checked, the
  // redirect target was proved, the scope was parsed and the PKCE pair stored.
  assert.deepEqual(harnessed.calls.registry, [{ clientId: CLIENT_ID, redirectUri: REDIRECT_URI }]);
  assert.equal(harnessed.calls.authCodes[0].codeChallenge, CHALLENGE);
  assert.equal(harnessed.calls.authCodes[0].scope, "publicData esi-skills.read_skills.v1");
  assert.equal(harnessed.calls.authCodes[0].characterId, CHARACTER_ID);

  // On every use, not once at startup: a startup banner scrolls away, and the
  // question an operator asks later is "did this token come from a player?"
  authorize(harnessed.route);
  authorize(harnessed.route);
  const loud = harnessed.calls.log.filter((line) => line.includes("DEV AUTO-APPROVE"));
  assert.equal(loud.length, 3, "one line per use");

  // Written so nobody reading a production log mistakes it for normal traffic.
  assert.match(loud[0], /!! DEV AUTO-APPROVE !!/);
  assert.match(loud[0], /NO player interaction/);
  assert.match(loud[0], new RegExp(String(CHARACTER_ID)));
  assert.match(loud[0], /must be off/i);

  // The client id is JSON-quoted on the way into the log: it is attacker-chosen
  // text, and a raw newline in it would let a client forge log lines.
  const forged = harness({ devAutoApprove: { enabled: true, characterID: CHARACTER_ID } });
  authorize(forged.route, { client_id: 'evil"\nSERVER: all clear' });
  assert.ok(!forged.calls.log.join("").includes("\nSERVER: all clear"));
});

test("a half-configured bypass refuses to be constructed", () => {
  const base = {
    clientRegistry: { check: () => ({ ok: true }) },
    authCodes: { mint: () => ({ code: "x" }) },
    bindFlow: { mint: () => ({ code: "y" }), peek: () => ({ state: "pending" }) },
    log: () => {},
  };

  // No "pick the first character" fallback, ever: a bypass that guesses an
  // identity will eventually guess somebody's.
  for (const characterID of [null, undefined, 0, -1, "90000001", 1.5]) {
    assert.throws(
      () => createOauthAuthorizeRoute({ ...base, devAutoApprove: { enabled: true, characterID } }),
      /characterID/,
      JSON.stringify(characterID),
    );
  }

  // A truthy value that is not the boolean `true` is a coercion mistake (the
  // string an environment variable hands you). It must not turn this on, and
  // going quiet on it would leave a CI pipeline hanging on a page nobody is
  // going to complete.
  for (const enabled of ["true", 1, "yes", {}]) {
    assert.throws(
      () => createOauthAuthorizeRoute({
        ...base,
        devAutoApprove: { enabled, characterID: CHARACTER_ID },
      }),
      /boolean true/,
      JSON.stringify(enabled),
    );
  }

  // Loud-on-every-use is not optional, so a bypass with nowhere to write is not
  // constructed at all.
  assert.throws(
    () => createOauthAuthorizeRoute({
      ...base,
      log: undefined,
      devAutoApprove: { enabled: true, characterID: CHARACTER_ID },
    }),
    /log/,
  );

  // And the quiet path stays quiet: an absent or false setting never throws.
  for (const devAutoApprove of [undefined, {}, { enabled: false }, { enabled: null }]) {
    assert.doesNotThrow(() => createOauthAuthorizeRoute({ ...base, devAutoApprove }));
  }
});

// The redirect builder, on its own

test("buildRedirect preserves the registered bytes and encodes the rest", () => {
  assert.equal(buildRedirect("http://h/cb", [["a", "1"]]), "http://h/cb?a=1");
  assert.equal(buildRedirect("http://h/cb?x=1", [["a", "2"]]), "http://h/cb?x=1&a=2");
  assert.equal(buildRedirect("http://h/cb", []), "http://h/cb");

  // A null value is a parameter that was not sent, not a parameter whose value
  // is the word "null"; that is how an unsent `state` stays unsent.
  assert.equal(buildRedirect("http://h/cb", [["a", "1"], ["state", null]]), "http://h/cb?a=1");

  // Odd but legal registered forms are not normalized. `new URL` would rewrite
  // every one of these, and the registry matched them exactly.
  assert.equal(
    buildRedirect("http://h:80/a%7Eb/../c", [["a", "1"]]),
    "http://h:80/a%7Eb/../c?a=1",
  );

  // Space is `%20`, never `+`.
  assert.equal(buildRedirect("http://h/cb", [["s", "a b"]]), "http://h/cb?s=a%20b");
});

/** A route with the default doubles, for the tests that only need its shape. */
function route() {
  return harness().route;
}
