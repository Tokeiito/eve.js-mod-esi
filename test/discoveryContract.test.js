/**
 * `GET /.well-known/oauth-authorization-server` against the contract.
 *
 * Run with: node --test "test/**\/*.test.js"   (from the mod directory, or RunTests.bat)
 *
 * `contract/sso.js` is the transcription of record: CCP's document with the
 * observation date and the reasoning behind each member that looks like a bug.
 * `routes/oauthDiscovery.js` carries its own copy of those constants, because
 * `contract/` is test-only and is not part of the deployable artifact (D20:
 * `lib/sourceHash.js` hashes `loader.js`, `config.js`, `server.js`, `lib/` and
 * `routes/`, and `scripts/deploy-mod.js` copies exactly those). A deployed file
 * that required `contract/` would pass every test here and then throw
 * `MODULE_NOT_FOUND` inside a game process.
 *
 * `lib/cors.js`, `lib/headers.js`, `lib/cache.js` and `lib/compatibility.js`
 * carry the same duplication for the same reason: the constants live in both
 * places and a test asserts they agree. This file is that test for the
 * discovery document. Tests are never deployed, so it may require `contract/`.
 *
 * The acceptance asks that the document round-trips through a standard OIDC
 * discovery client and every URL in it resolves. There is no OIDC client in
 * this repository (the suite depends on nothing, D5/D20) and a test that
 * reached the network would fail for reasons unrelated to this code. The
 * reachable half is asserted instead: every absolute URL parses, every one is
 * built from the configured issuer and names no other origin, and every path
 * is one this replica serves today or has a plan for. `jwks_uri` is compared
 * against the path `routes/oauthJwks.js` actually mounts, a defect no unit test
 * of either file could find alone.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const sso = require(path.join(__dirname, "../contract/sso"));
const discovery = require(path.join(__dirname, "../routes/oauthDiscovery"));
const jwksRoute = require(path.join(__dirname, "../routes/oauthJwks"));
const { createSsoDispatch } = require(path.join(__dirname, "../lib/ssoDispatch"));

/** A configured issuer in D7's shape: absolute, explicit scheme, no trailing slash. */
const ISSUER = "http://host.local:26006";

function documentFor(issuer = ISSUER) {
  return discovery.buildDiscoveryDocument(issuer);
}

/** The document as it goes on the wire, parsed back. */
async function served(issuer = ISSUER, request = { method: "GET" }) {
  const route = discovery.createOauthDiscoveryRoute({ issuer });
  return route.handle(request);
}

// The route agrees with the contract

test("the route's constants are the contract's, value for value", () => {
  // This justifies the duplication. A divergence here is a failing test rather
  // than a document that is internally consistent and wrong.
  assert.deepEqual([...discovery.DISCOVERY_PATHS], [...sso.DISCOVERY_PATHS]);
  assert.deepEqual([...discovery.MEMBER_ORDER], [...sso.DISCOVERY_MEMBER_ORDER]);
  assert.deepEqual({ ...discovery.ENDPOINT_PATHS }, { ...sso.DISCOVERY_ENDPOINT_PATHS });
  assert.deepEqual({ ...discovery.ENDPOINT_MEMBERS }, { ...sso.DISCOVERY_ENDPOINT_MEMBERS });

  // The constant members are compared as data, not as object identity: both
  // sides freeze their arrays, and `deepEqual` on them notices a value changing.
  assert.deepEqual(Object.keys(discovery.CONSTANTS).sort(), Object.keys(sso.DISCOVERY_CONSTANTS).sort());
  for (const [member, value] of Object.entries(sso.DISCOVERY_CONSTANTS)) {
    assert.deepEqual([...discovery.CONSTANTS[member]], [...value], member);
  }
});

test("no deployed file reaches for contract/, because it is not deployed (D20)", () => {
  // The rule as a check rather than a paragraph. `routes/` and `lib/` are
  // deployed; `contract/` is not.
  const source = require("node:fs").readFileSync(
    path.join(__dirname, "../routes/oauthDiscovery.js"),
    "utf8",
  );
  assert.doesNotMatch(source, /require\([^)]*contract/);

  const dispatchSource = require("node:fs").readFileSync(
    path.join(__dirname, "../lib/ssoDispatch.js"),
    "utf8",
  );
  assert.doesNotMatch(dispatchSource, /require\([^)]*contract/);
});

test("our document is CCP's, with only the issuer substituted", () => {
  // The strongest single assertion in the file: build the document with CCP's
  // own origin as the issuer and it must equal the transcription of record,
  // member for member and value for value. That makes every other test here a
  // test of our substitution rather than of our own assumptions.
  assert.deepEqual(documentFor(sso.SSO_ORIGIN), { ...sso.CCP_DISCOVERY_DOCUMENT });
});

// The three members that look like bugs

test("issuer is carried through with no trailing slash, exactly as configured", () => {
  // OAuth issuer comparison is exact string comparison: a validator configured
  // with the slashed form rejects every token from the unslashed one, totally
  // rather than partially.
  assert.equal(documentFor().issuer, ISSUER);
  assert.equal(documentFor().issuer.endsWith("/"), false);
});

test("jwks_uri is under /oauth/, while everything else is under /v2/oauth/", () => {
  const document = documentFor();

  assert.equal(document.jwks_uri, `${ISSUER}/oauth/jwks`);
  for (const member of [
    "authorization_endpoint",
    "token_endpoint",
    "userinfo_endpoint",
    "revocation_endpoint",
  ]) {
    assert.ok(document[member].startsWith(`${ISSUER}/v2/oauth/`), member);
  }
});

test("id_token_signing_alg_values_supported still says HS256, against an RS256 signature", () => {
  // The preserved contradiction: CCP's document disagrees with CCP's own JWKS,
  // live. Clients string-compare it, and the consumer that matters never reads
  // it. This guards against a well-meaning cleanup, not a typo.
  assert.deepEqual(documentFor().id_token_signing_alg_values_supported, ["HS256"]);
  assert.equal(jwksRoute.ALG, "RS256");
});

test("token_endpoint_auth_signing_alg_values_supported says HS256 and is not the bug", () => {
  // Sits beside the member above and looks identical. `client_secret_jwt` is
  // HMAC by definition, so HS256 is correct here. That is probably how the bug
  // next to it happened, and the test makes "fix both" fail.
  assert.deepEqual(documentFor().token_endpoint_auth_signing_alg_values_supported, ["HS256"]);
  assert.ok(documentFor().token_endpoint_auth_methods_supported.includes("client_secret_jwt"));
});

test("userinfo_endpoint is /v2/oauth/verify, not /userinfo", () => {
  // The one a reader "corrects" by reflex, because the OIDC member name
  // suggests otherwise. CCP's verify endpoint predates the OIDC framing.
  assert.equal(documentFor().userinfo_endpoint, `${ISSUER}/v2/oauth/verify`);
});

// Member order, on the wire

test("the served bytes carry the observed member order", () => {
  // Asserted against the serialized document rather than `Object.keys`, because
  // the order is only a fact once it is bytes, and because the route serializes
  // once at construction, so this is the string a client receives.
  const body = documentFor();
  assert.deepEqual(Object.keys(body), [...sso.DISCOVERY_MEMBER_ORDER]);

  const wire = JSON.parse(JSON.stringify(body));
  assert.deepEqual(Object.keys(wire), [...sso.DISCOVERY_MEMBER_ORDER]);

  // `response_types_supported` between `userinfo_endpoint` and `jwks_uri`, and
  // `subject_types_supported` after `revocation_endpoint`, are the two
  // placements nobody would choose. They are named so the order is checked as an
  // observation and not merely as a list this file also holds.
  const order = Object.keys(wire);
  assert.equal(order[order.indexOf("userinfo_endpoint") + 1], "response_types_supported");
  assert.equal(order[order.indexOf("revocation_endpoint") + 1], "subject_types_supported");
});

test("the document's membership is exactly the contract's two halves", () => {
  // A member in the order but in neither half has no source of truth, and would
  // be assembled from whatever the route felt like.
  const expected = [
    ...sso.DISCOVERY_ISSUER_DERIVED_MEMBERS,
    ...Object.keys(sso.DISCOVERY_CONSTANTS),
  ].sort();

  assert.deepEqual(Object.keys(documentFor()).sort(), expected);
});

test("nothing CCP does not publish is added", () => {
  // Some libraries read a discovery document as a closed statement of
  // capability, so publishing a member CCP does not is the same class of
  // divergence as dropping one it does.
  for (const member of [
    "scopes_supported",
    "grant_types_supported",
    "introspection_endpoint",
    "service_documentation",
    "end_session_endpoint",
  ]) {
    assert.equal(member in documentFor(), false, member);
  }
});

// Every URL resolves

/**
 * Every path the document can name, and what answers it.
 *
 * `served` means this replica mounts it today; any other value marks a planned
 * endpoint whose path is already the one it will mount. The map is asserted to
 * cover the document exactly, so a sixth endpoint member arriving with no plan
 * behind it fails here rather than shipping as a URL that 404s.
 */
const ENDPOINT_PLAN = Object.freeze({
  "/v2/oauth/authorize": "served",
  "/v2/oauth/token": "served",
  "/v2/oauth/verify": "served",
  "/oauth/jwks": "served",
  "/v2/oauth/revoke": "served",
});

test("every absolute URL parses, and names the configured issuer's origin only", () => {
  const document = documentFor();
  const urls = sso.DISCOVERY_ISSUER_DERIVED_MEMBERS.map((member) => document[member]);

  assert.equal(urls.length, 6, "issuer plus five endpoints");

  for (const value of urls) {
    const url = new URL(value); // throws if it is not absolute, which is the check
    assert.equal(url.protocol, "http:");
    assert.equal(url.host, "host.local:26006");
    // Built from the one issuer string: no member may name a different origin,
    // and CCP's must never appear.
    assert.ok(value.startsWith(ISSUER), value);
    assert.equal(value.includes("login.eveonline.com"), false, value);
  }
});

test("every advertised path is one this replica serves", () => {
  const document = documentFor();
  const advertised = Object.values(sso.DISCOVERY_ENDPOINT_MEMBERS).map(
    (endpoint) => sso.DISCOVERY_ENDPOINT_PATHS[endpoint],
  );

  // Exactly, not "at least". An endpoint added to the contract without a plan is
  // a URL a client will fetch and not reach.
  assert.deepEqual([...advertised].sort(), Object.keys(ENDPOINT_PLAN).sort());

  for (const [pathname, plan] of Object.entries(ENDPOINT_PLAN)) {
    assert.ok(
      Object.values(document).includes(`${ISSUER}${pathname}`),
      `${pathname} (${plan}) is advertised in the document`,
    );
  }
});

test("jwks_uri is the path routes/oauthJwks.js actually mounts", () => {
  // The cross-check neither file can make alone. A route table written by
  // pattern ("the SSO endpoints are /v2/oauth/*") mounts the JWKS at
  // /v2/oauth/jwks while this document keeps advertising /oauth/jwks. Token
  // issue still succeeds; only signature verification fails, which is late and
  // looks like something else.
  assert.equal(documentFor().jwks_uri, `${ISSUER}${jwksRoute.PATH}`);
});

test("the two documents mount on one dispatch without colliding", () => {
  // The route table `loader.js` builds. `createSsoDispatch` validates at
  // construction, so this is the boot that would fail.
  assert.doesNotThrow(() =>
    createSsoDispatch([
      discovery.createOauthDiscoveryRoute({ issuer: ISSUER }),
      { name: "GetOauthJwks", paths: [jwksRoute.PATH], handle: () => ({ status: 200 }) },
    ]),
  );
});

// Both paths, and the one that is deliberately not served

test("the document is mounted at both spellings CCP and the EVE client use", () => {
  const route = discovery.createOauthDiscoveryRoute({ issuer: ISSUER });

  assert.deepEqual([...route.paths], [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/",
  ]);
  // The slashed one is not sloppiness: it is a literal compiled into build
  // 3396210's `clientRefreshToken/discovery_hacks.py`, and it is the spelling the
  // one consumer that decides this design requests.
  assert.ok(route.paths.includes(`${sso.DISCOVERY_PATHS[0]}/`));
});

test("/.well-known/openid-configuration is not served, and that is the decision", () => {
  // Considered and declined. Serving these bytes there would convert a
  // preserved quirk into a live wrong answer:
  // `id_token_signing_alg_values_supported` is inert on an OAuth document and is
  // the member an OIDC client uses to choose how to verify an ID token, so a
  // library that probed OIDC-first and believed it would fail verification
  // against a correctly signed RS256 token. CCP does not serve the path either,
  // and what it answers there is unobserved, so no fidelity argument supports
  // any particular answer.
  const route = discovery.createOauthDiscoveryRoute({ issuer: ISSUER });
  assert.equal(route.paths.includes(sso.OPENID_DISCOVERY_PATH), false);

  // It therefore falls through to the dispatch's own 404, which is marked there
  // as ours rather than a reproduction.
  const dispatch = createSsoDispatch([route]);
  return dispatch({ pathname: sso.OPENID_DISCOVERY_PATH }).then((result) => {
    assert.deepEqual(result, { status: 404 });
  });
});

// How it is served

test("it is unauthenticated, CORS-open and cacheable", () => {
  // The three requirements `contract/sso.js` SERVING records as requirements
  // rather than as observed bytes. The values below are ours; that all three
  // hold at all is the requirement.
  assert.equal(sso.SERVING.discovery.authenticated, false);
  assert.equal(sso.SERVING.discovery.cors, true);
  assert.equal(sso.SERVING.discovery.cacheable, true);

  const result = discovery
    .createOauthDiscoveryRoute({ issuer: ISSUER })
    .handle({ method: "GET", headers: {} });

  // No credential of any kind was supplied, and it answered.
  assert.equal(result.status, 200);
  assert.equal(result.headers["access-control-allow-origin"], "*");
  assert.match(result.headers["cache-control"], /^public, max-age=\d+$/);
});

test("the cache window is shorter than an access token's lifetime", () => {
  // The argument behind the number, asserted so that raising it later has to
  // argue with this rather than a comment: a client whose cached document went
  // stale re-fetches before the token that pointed it there expires, so an
  // issuer change self-heals within one token generation.
  const ACCESS_TOKEN_LIFETIME_SECONDS = 20 * 60;
  assert.ok(discovery.CACHE_TTL_SECONDS < ACCESS_TOKEN_LIFETIME_SECONDS);
  assert.equal(discovery.CACHE_CONTROL, `public, max-age=${discovery.CACHE_TTL_SECONDS}`);
});

test("no validator is sent, because neither has an honest value here", () => {
  const { headers } = discovery
    .createOauthDiscoveryRoute({ issuer: ISSUER })
    .handle({ method: "GET" });

  // Both are unobserved on this origin, and the document is assembled from
  // constants, so its "last modification" would be the process start, telling a
  // client it changed every time the game server restarted.
  for (const name of ["etag", "last-modified"]) {
    assert.equal(name in headers, false, name);
  }
});

test("the body is a string, so member order and the last byte are the route's", () => {
  const result = discovery.createOauthDiscoveryRoute({ issuer: ISSUER }).handle({ method: "GET" });

  assert.equal(typeof result.body, "string");
  assert.equal(result.headers["content-type"], "application/json");
  // No trailing newline: unobserved on this origin, so the choice is to add
  // nothing rather than borrow ESI's producer rule from `contract/wire.js`, which
  // is a fact about a different hostname.
  assert.equal(result.body.endsWith("\n"), false);
  assert.equal(result.body, JSON.stringify(JSON.parse(result.body)));
});

test("only GET is answered, and the refusal carries Allow", async () => {
  // Ours, not a reproduction: no status, method restriction or `Allow` is
  // recorded for these paths, and there is no SSO equivalent of contract/wire.js
  // to inherit one from (D23).
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "HEAD"]) {
    const result = await served(ISSUER, { method });
    assert.equal(result.status, 405, method);
    assert.equal(result.headers.allow, "GET", method);
    assert.equal(result.body, undefined, method);
  }

  assert.equal((await served(ISSUER, { method: "get" })).status, 200);
});

// Construction

test("the route refuses to be built without an issuer", () => {
  // A degraded mode here would serve `undefined/v2/oauth/token` to a client and
  // look like it worked.
  assert.throws(() => discovery.createOauthDiscoveryRoute(), TypeError);
  assert.throws(() => discovery.createOauthDiscoveryRoute({}), /needs the configured issuer/);
  assert.throws(() => discovery.createOauthDiscoveryRoute({ issuer: "" }), TypeError);
});

test("the route refuses an issuer with a trailing slash", () => {
  // `config.js` refuses it too, so reaching this means a hand-built one, and the
  // damage is silent: `issuer + "/oauth/jwks"` becomes `//oauth/jwks`.
  assert.throws(
    () => discovery.createOauthDiscoveryRoute({ issuer: "http://host.local:26006/" }),
    /must not end with a slash/,
  );
});

test("each document is a fresh object, so no caller can mutate the constants", () => {
  const first = documentFor();
  first.response_types_supported.push("id_token");

  assert.deepEqual(documentFor().response_types_supported, ["code", "token"]);
  assert.deepEqual([...discovery.CONSTANTS.response_types_supported], ["code", "token"]);
});

test("the route object is frozen and carries a name for the dispatch's errors", () => {
  const route = discovery.createOauthDiscoveryRoute({ issuer: ISSUER });

  assert.equal(Object.isFrozen(route), true);
  assert.equal(typeof route.name, "string");
  assert.notEqual(route.name, "");
});
