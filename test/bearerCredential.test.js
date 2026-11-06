/**
 * eve.js-mod-esi: tests for the credential gate and the route requirement
 *
 * Two modules are under test, because the gate is two halves:
 * `lib/bearerCredential.js` decides whether what a client presented verifies,
 * in front of the router, and `lib/router.js` decides whether the route
 * required one, after it. Four layers apart. Every assertion about where they
 * sit is read from `contract/wire.js` `BEARER` rather than restated here, so a
 * corrected observation fails this file instead of contradicting a comment.
 *
 * `lib/bearerToken.js` once carried a reasoned claim about which of the two 401
 * wordings a request earns: `fromHeader` returns `null` when no bearer
 * credential was presented, so `null` meant "No token provided" and a `Basic`
 * credential was a client that had not presented one. That was wrong. CCP
 * splits on whether the `Authorization` header was there at all, so
 * `Basic ...` is an invalid token. One `curl` settled it.
 *
 * The cases are organised around the boundary that exists, and the two
 * wordings are asserted from `wire.ERROR_BODY` so that neither can be quietly
 * reworded into the other.
 *
 * A `403` is not covered. A token that verifies and then fails to authorise
 * (wrong scope, wrong character) has never been observed, because that needs a
 * real token with a narrow scope set and every probe so far was tokenless. The
 * last section asserts what the code does instead: it throws, loudly, and the
 * router turns that into a `500`. Those tests make the gap impossible to ship
 * past unnoticed, and are the ones to delete when the observation lands.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const signingKeyModule = require(path.join(__dirname, "../lib/signingKey"));
const { createAccessTokenMinter } = require(path.join(__dirname, "../lib/accessToken"));
const { createBearerVerifier } = require(path.join(__dirname, "../lib/bearerToken"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const { createRouter, dispatchRequest, RouteTableError } = require(path.join(__dirname, "../lib/router"));
const { FAMILY, characterMismatch, unauthorizedScope } = require(path.join(__dirname, "../lib/errors"));
const { createEsiDispatch, createGroupFor } = require(path.join(__dirname, "../lib/pipeline"));
const {
  ABSENT,
  createBearerCredentialDispatch,
  readCredential,
} = require(path.join(__dirname, "../lib/bearerCredential"));

// Fixtures

const KEY = signingKeyModule.signingKeyFromPem(signingKeyModule.generateSigningKeyPem(), {
  path: "(in-memory fixture)",
});

const ISSUER = "http://host.local:26006";
const SALT = "0123456789abcdef0123456789abcdef";
const NOW_MS = 1648562018000;

const CHARACTER_ID = 123123;
const OTHER_CHARACTER_ID = 456456;
const SCOPE = "esi-location.read_location.v1";

/** A clock that does not move, so nothing here can flake on a TTL boundary. */
const AT = NOW_MS;

function mint({ characterId = CHARACTER_ID, scopes = [SCOPE] } = {}) {
  return createAccessTokenMinter({
    signingKey: KEY,
    issuer: ISSUER,
    now: () => NOW_MS,
    ownerSalt: SALT,
    generateJti: () => "5f4e3d2c-1b0a-4998-8877-665544332211",
  }).mint({
    characterId,
    characterName: "Some Bloke",
    clientId: "my3rdpartyclientid",
    scopes,
    ownerInputs: { accountId: 90210 },
  }).token;
}

function verifier() {
  return createBearerVerifier({ signingKey: KEY, issuer: ISSUER, now: () => NOW_MS });
}

/**
 * One public route and one that requires a scope, the smallest table that can
 * tell the two halves apart.
 */
function table() {
  return [
    {
      method: "GET",
      path: "/status",
      name: "GetStatus",
      rateLimitGroup: "status",
      cacheTtl: 30,
      producer: "gateway",
      handler: () => ({ players: 1 }),
    },
    {
      method: "GET",
      path: "/characters/:character_id/location",
      name: "GetCharactersCharacterIdLocation",
      scope: SCOPE,
      rateLimitGroup: "char-location",
      cacheTtl: 5,
      // An application route, which is what the 403 was observed on:
      // `/characters/{id}/online/` answered `application/json; charset=UTF-8` with a
      // request id and no nosniff. The 403's family is derived from the route, so a
      // gateway fixture here would exercise a shape nobody has seen, and
      // `lib/errors.js` refuses to build that one at all.
      producer: "app",
      handler: (params) => ({ solar_system_id: Number(params.path.character_id) }),
    },
  ];
}

function pipeline({ now = () => AT, verifier: v = verifier() } = {}) {
  return createEsiDispatch(createRouter(table()), { now, verifier: v });
}

function request(overrides = {}) {
  return {
    method: "GET",
    pathname: "/latest/status/",
    query: {},
    headers: {},
    remoteAddress: "203.0.113.7",
    ...overrides,
  };
}

const authorized = (token) => ({ authorization: `Bearer ${token}` });
const onTheWire = (result) => serializeBody(result.body, result.producer);
const headerNames = (result) => Object.keys(result.headers || {}).map((n) => n.toLowerCase());

// The boundary: absent, blank, presented

test("the two 401 wordings split on whether the header was there, not on whether a token was", () => {
  const v = verifier();

  // Absent, and blank-after-trim, are the same answer. `BEARER` records the trim
  // as CCP's rule: six spaces is answered as though nothing was sent.
  assert.equal(wire.BEARER.blankValueCountsAsAbsent, true);
  for (const headers of [{}, { authorization: "" }, { authorization: "      " }, { authorization: "\t " }]) {
    assert.deepEqual(
      readCredential({ headers }, v),
      ABSENT,
      `${JSON.stringify(headers)} should read as no credential at all`,
    );
  }

  // Presented, and bad. Each of these used to be `null` from `fromHeader` and
  // would have been answered "No token provided", the bug this file holds shut.
  for (const value of ["Bearer", "Bearer ", "Basic dXNlcjpwdw==", "Negotiate abcdef", "Bearer part one"]) {
    const reading = readCredential({ headers: { authorization: value } }, v);
    assert.equal(reading.presented, true, `${JSON.stringify(value)} is a presented credential`);
    assert.equal(reading.claims, null);
    assert.notEqual(reading.refusal, null, `${JSON.stringify(value)} must be refused, not waved through`);
  }

  // Presented, and good.
  const good = readCredential({ headers: authorized(mint()) }, v);
  assert.equal(good.presented, true);
  assert.equal(good.refusal, null);
  assert.equal(good.claims.characterId, CHARACTER_ID);
});

test("a verdict's reason never reaches the client: all of them are the same 41 bytes", async () => {
  const v = verifier();
  const dispatch = createBearerCredentialDispatch(async () => ({ status: 200 }), { verifier: v });

  const reasons = new Set();
  for (const value of ["Basic dXNlcjpwdw==", "Bearer not-a-token", `Bearer ${mint()}x`]) {
    const result = await dispatch(request({ headers: { authorization: value } }));

    assert.equal(result.status, wire.BEARER.presentedAndBad.status);
    assert.deepEqual(result.body, { error: wire.ERROR_BODY.invalidToken });
    assert.equal(
      onTheWire(result).length,
      wire.BEARER.presentedAndBad.contentLength,
      "Content-Length is what a proxy frames the response by",
    );
    reasons.add(readCredential(request({ headers: { authorization: value } }), v).refusal);
  }

  assert.ok(reasons.size > 1, "the fixture should produce more than one internal reason");
});

test("the credential is verified once per request, however many layers ask", () => {
  let verifications = 0;
  const counting = { verify: () => { verifications += 1; return { ok: false, reason: "MALFORMED" }; } };
  const req = request({ headers: { authorization: "Bearer garbage" } });

  readCredential(req, counting);
  readCredential(req, counting);
  createGroupFor(createRouter(table()), { now: () => AT, verifier: counting })(req);

  assert.equal(verifications, 1, "an RSA verification per layer is two too many");
});

// Where the refusal sits: it outranks everything

test("a presented-and-bad credential beats every other refusal this surface makes", async () => {
  const dispatch = pipeline();
  const bad = { authorization: "Bearer garbage" };

  const cases = [
    ["an unrouted path", request({ pathname: "/latest/nope/" }), 404],
    ["a method the route refuses", request({ method: "POST" }), 405],
    ["a bad tenant", request({ query: { datasource: "nope" } }), 400],
    ["a bad compatibility date", request({ headers: { "x-compatibility-date": "nope" } }), 400],
  ];

  for (const [what, probe, withoutCredential] of cases) {
    const plain = await dispatch(probe);
    assert.equal(plain.status, withoutCredential, `${what} without a credential`);

    const withBad = await dispatch({ ...probe, headers: { ...probe.headers, ...bad } });
    assert.equal(withBad.status, 401, `${what} with a bad credential should be 401`);
    assert.deepEqual(withBad.body, { error: wire.ERROR_BODY.invalidToken });
  }

  assert.deepEqual(
    wire.BEARER.presentedAndBad.outranks,
    [404, 405, 400],
    "the survey and this test must name the same set",
  );
});

test("a bad credential is refused on a public route too, and carries nothing that names one", async () => {
  const dispatch = pipeline();

  assert.equal(wire.BEARER.presentedAndBad.appliesToPublicRoutes, true);
  const result = await dispatch(request({ headers: { authorization: "Bearer garbage" } }));

  assert.equal(result.status, 401);
  const names = headerNames(result);
  // Never resolved a route, so it cannot name one, and CCP's does not either.
  assert.equal(names.includes("vary"), false, "no Vary: this refusal never reached routing");
  assert.equal(names.includes("content-language"), false);
  assert.equal(names.some((n) => n.startsWith("x-ratelimit")), false);
  assert.equal(names.includes("x-esi-request-id"), false);
  // The error limiter charges it. Asserted here as headers, and against the
  // survey row in `test/limiters.test.js`.
  assert.ok(names.includes("x-esi-error-limit-remain"));
});

test("a preflight outranks even the credential, and pays for no verification", async () => {
  let verifications = 0;
  const counting = { verify: () => { verifications += 1; return { ok: false, reason: "MALFORMED" }; } };
  const dispatch = pipeline({ verifier: counting });

  const result = await dispatch(request({
    method: "OPTIONS",
    headers: {
      origin: "https://example.test",
      "access-control-request-method": "GET",
      authorization: "Bearer garbage",
    },
  }));

  assert.equal(wire.BEARER.preflightOutranksCredential, true);
  assert.equal(result.status, 204, "the preflight is answered above the credential layer");
  assert.equal(verifications, 0, "a request that will never reach a route must not pay for a signature check");
});

test("a bad credential has no bucket to charge, which is why the error limiter answers", () => {
  const router = createRouter(table());
  const groupFor = createGroupFor(router, { now: () => AT, verifier: verifier() });

  // The same route, three ways.
  assert.equal(groupFor(request()), "status", "a plain request is the bucket's");
  assert.equal(groupFor(request({ headers: authorized(mint()) })), "status", "so is a good credential");
  assert.equal(
    groupFor(request({ headers: { authorization: "Bearer garbage" } })),
    null,
    "a bad credential never reached the route that owns the bucket",
  );
});

// The other half: the route's requirement, decided after routing

test("a route that requires a scope refuses an absent credential, in the gateway's bytes", async () => {
  const dispatch = pipeline();
  const result = await dispatch(request({ pathname: "/latest/characters/123123/location/" }));

  assert.equal(result.status, wire.BEARER.absent.status);
  assert.deepEqual(result.body, { error: wire.ERROR_BODY.noToken });
  assert.equal(onTheWire(result).length, wire.BEARER.absent.contentLength);

  const names = headerNames(result);
  // Decided after routing, so unlike its sibling it can name the route: three
  // `Vary` lines and a `Content-Language`.
  assert.deepEqual(result.headers.vary, [...wire.BEARER.absent.vary]);
  assert.equal(result.headers["content-language"], "en");
  assert.equal(names.includes("x-content-type-options"), true, "an EDGE refusal carries nosniff");
  // Still not these two, the combination that made this refusal worth building
  // by hand rather than through `routedHeaders`.
  assert.equal(wire.BEARER.absent.echoesCompatibilityDate, false);
  assert.equal(names.includes("x-compatibility-date"), false);
  assert.equal(names.includes("x-esi-cache-status"), false);
  assert.equal(names.includes("x-esi-request-id"), false);
});

test("the requirement loses to the two refusals its sibling beats", async () => {
  const dispatch = pipeline();
  const secured = "/latest/characters/123123/location/";

  // Both of these are made in front of the router, and the requirement is made
  // inside it, so on a secured route with no credential at all they win.
  const tenant = await dispatch(request({ pathname: secured, query: { datasource: "nope" } }));
  assert.equal(tenant.status, 400);
  assert.deepEqual(tenant.body, { error: wire.ERROR_BODY.invalidTenant });

  const date = await dispatch(request({ pathname: secured, headers: { "x-compatibility-date": "nope" } }));
  assert.equal(date.status, 400);

  // An unrouted path is a 404 rather than a challenge, the other end of the
  // same rule.
  const unrouted = await dispatch(request({ pathname: "/latest/nope/" }));
  assert.equal(unrouted.status, 404);
});

test("a public route is unaffected by all of this", async () => {
  const dispatch = pipeline();

  const plain = await dispatch(request());
  assert.equal(plain.status, 200);

  // A good credential on a public route is carried, not refused.
  const withToken = await dispatch(request({ headers: authorized(mint()) }));
  assert.equal(withToken.status, 200);
  assert.deepEqual(withToken.body, { players: 1 });
});

test("a token that carries the route's scope reaches the handler", async () => {
  const dispatch = pipeline();
  const result = await dispatch(request({
    pathname: `/latest/characters/${CHARACTER_ID}/location/`,
    headers: authorized(mint()),
  }));

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { solar_system_id: CHARACTER_ID });
});

test("with no verifier the ESI surface still serves, and says so in one place", async () => {
  // The SSO listener failed to start; `loader.js` promises ESI is unaffected.
  const dispatch = pipeline({ verifier: null });

  // A public route is served, including one carrying a token nobody can check.
  assert.equal((await dispatch(request())).status, 200);
  assert.equal((await dispatch(request({ headers: { authorization: "Bearer garbage" } }))).status, 200);

  // A route that requires a scope still refuses, because an uncheckable
  // credential and an absent one both fail the requirement. The degradation is a
  // fidelity gap on public routes, never an open door on a secured one.
  const secured = await dispatch(request({ pathname: "/latest/characters/123123/location/" }));
  assert.equal(secured.status, 401);
  assert.deepEqual(secured.body, { error: wire.ERROR_BODY.noToken });
});

test("HEAD on a route that requires a credential is the 401, and POST is still the 405", async () => {
  const dispatch = pipeline();
  const secured = `/latest/characters/${CHARACTER_ID}/location/`;

  // The second consequence of the quirk `METHOD_NOT_ALLOWED_LIMITER` records:
  // the HEAD refusal is made where the route is known, so it is the one that can
  // know a credential was required. Observed, byte for byte:
  //
  //   curl -sI https://esi.evetech.net/latest/characters/{character_id}/location/
  //     401, Content-Length: 45, X-Ratelimit-Group: char-location, Used: 5
  assert.equal(wire.BEARER.absentRefusesHead, true);
  const head = await dispatch(request({ method: "HEAD", pathname: secured }));
  assert.equal(head.status, 401, "a HEAD on a secured route is refused before the 405");
  assert.deepEqual(head.body, { error: wire.ERROR_BODY.noToken });
  assert.equal(onTheWire(head).length, wire.BEARER.absent.contentLength);
  assert.deepEqual(head.headers.vary, [...wire.BEARER.absent.vary]);

  // Everything else never resolved a route, so it cannot.
  for (const method of wire.BEARER.absentLosesToMethodNotAllowed) {
    const result = await dispatch(request({ method, pathname: secured }));
    assert.equal(result.status, 405, `${method} is a 405, credential or no credential`);
  }

  // A HEAD carrying a good credential is refused the ordinary way, which shows
  // the gate did not swallow the 405 outright.
  const withToken = await dispatch(request({
    method: "HEAD",
    pathname: secured,
    headers: authorized(mint()),
  }));
  assert.equal(withToken.status, 405);
});

test("a character_id the token did not sign is refused, however it is spelled", async () => {
  const router = createRouter(table());
  const deps = { logError: () => {} };
  const credential = readCredential({ headers: authorized(mint()) }, verifier());

  const dispatchAs = (segment) => dispatchRequest(router, {
    method: "GET",
    pathname: `/latest/characters/${segment}/location/`,
    headers: {},
    credential,
  }, deps);

  // The canonical spelling, and only that one, is this character.
  const ok = await dispatchAs(String(CHARACTER_ID));
  assert.equal(ok.status, 200);

  // Each of these is `Number()`-equal to the subject and none is the subject.
  // Left to `Number()` alone the gate would pass them and the handler would
  // receive the raw string, and `parseInt("1.23123e5")` is 1. `projectClaims`
  // applies the same round trip to `sub`; so does this.
  for (const segment of ["0123123", "1.23123e5", "0x1e0f3", "+123123", "%20123123%20", "123123%0A"]) {
    const result = await dispatchAs(segment);
    assert.notEqual(result.status, 200, `${segment} must not be read as character ${CHARACTER_ID}`);
  }

  // A handler never has to coerce the path to learn who is asking.
  assert.equal(ok.body.solar_system_id, CHARACTER_ID);
});

test("the verified identity reaches the handler, so nothing has to trust the path", async () => {
  let seen = null;
  const router = createRouter([{
    ...table()[1],
    handler: (params) => { seen = params; return { ok: true }; },
  }]);

  await dispatchRequest(router, {
    method: "GET",
    pathname: `/latest/characters/${CHARACTER_ID}/location/`,
    headers: {},
    credential: readCredential({ headers: authorized(mint()) }, verifier()),
  }, {});

  assert.equal(seen.credential.characterId, CHARACTER_ID);
  assert.equal(typeof seen.credential.characterId, "number");
  assert.deepEqual([...seen.credential.scopes], [SCOPE]);
  // Still not the request, which is the router's oldest promise.
  assert.equal("req" in seen, false);
});

test("a verifier that misbehaves is a refusal, never a throw", () => {
  // `readCredential` runs in front of every route on a game server's event
  // loop, and the verifier is injected, so a bad one must not become an
  // unhandled rejection four layers above. `routes/oauthVerify.js` hardens the
  // same case for the same reason.
  const misbehaving = [
    ["answers null", { verify: () => null }],
    ["answers undefined", { verify: () => undefined }],
    ["answers a string", { verify: () => "yes" }],
    ["says ok with no claims", { verify: () => ({ ok: true }) }],
    ["throws", { verify: () => { throw new Error("boom"); } }],
  ];

  for (const [what, verifierDouble] of misbehaving) {
    const reading = readCredential({ headers: { authorization: "Bearer x" } }, verifierDouble);
    assert.equal(reading.presented, true, what);
    assert.equal(reading.claims, null, `${what}: nothing usable must become claims`);
    assert.notEqual(reading.refusal, null, `${what}: must refuse rather than wave through`);
  }
});

// Construction

test("a scope that is not a non-empty string fails at boot, naming the route", () => {
  for (const scope of ["", 7, true, [], {}]) {
    assert.throws(
      () => createRouter([{ ...table()[1], scope }]),
      RouteTableError,
      `scope ${JSON.stringify(scope)} should not compile`,
    );
  }

  // Public is spelled two ways and both mean the same thing.
  assert.equal(createRouter([{ ...table()[0], scope: null }]).routes[0].scope, null);
  assert.equal(createRouter([table()[0]]).routes[0].scope, null);
});

// Authorisation: the two refusals, as observed

test("a token that verifies but lacks the route's scope is a 401 that names the scope", async () => {
  // The specifying issue says this must be a 403. It is not, and eve-nexum's
  // `401 = no scopes, 403 = scope missing` is wrong the same way. Both were
  // captured: a scopeless token and a wrongly-scoped one give the same bytes.
  const router = createRouter(table());
  const wrongScope = mint({ scopes: ["esi-skills.read_skills.v1"] });

  const result = await dispatchRequest(router, {
    method: "GET",
    pathname: `/latest/characters/${CHARACTER_ID}/location/`,
    headers: {},
    credential: readCredential({ headers: authorized(wrongScope) }, verifier()),
  }, {});

  assert.equal(result.status, wire.SCOPE_REFUSAL.status);
  assert.deepEqual(result.body, { error: wire.SCOPE_REFUSAL.body(SCOPE) });
  assert.equal(wire.SCOPE_REFUSAL.noScopesAndWrongScopeAgree, true);

  // The gateway's bytes, and a routed refusal's headers minus the two a
  // refusal made before the body exists cannot carry.
  const names = headerNames(result);
  assert.equal(result.headers["content-type"], wire.SCOPE_REFUSAL.contentType);
  assert.equal(names.includes("x-content-type-options"), wire.SCOPE_REFUSAL.sendsNosniff);
  assert.deepEqual(result.headers.vary, [...wire.SCOPE_REFUSAL.vary]);
  assert.equal(result.headers["content-language"], "en");
  assert.equal(names.includes("x-compatibility-date"), wire.SCOPE_REFUSAL.echoesCompatibilityDate);
  assert.equal(names.includes("x-esi-cache-status"), wire.SCOPE_REFUSAL.sendsCacheStatus);
});

test("the scope refusal weighs what CCP's weighs, to the byte", () => {
  // Parameterised, unlike every other refusal on this surface: the scope name
  // is in the body, so the length is the route's rather than a constant.
  const observed = wire.SCOPE_REFUSAL.observedScope;
  const refusal = unauthorizedScope(observed);

  assert.equal(
    serializeBody(refusal.body, refusal.producer).length,
    wire.SCOPE_REFUSAL.observedContentLength,
    "Content-Length is the number a proxy frames the response by",
  );
  assert.throws(() => unauthorizedScope(""), /name the scope/);
});

test("a token for another character is the application's 403, not the gateway's", async () => {
  // The one real 403 in the gate, and the odd one out: it derives its family
  // from the route, so it carries the echo, a cache status and (via
  // lib/requestId.js, on an application producer) a request id, none of which
  // the two 401s beside it have.
  const router = createRouter(table());
  const result = await dispatchRequest(router, {
    method: "GET",
    pathname: `/latest/characters/${OTHER_CHARACTER_ID}/location/`,
    headers: {},
    credential: readCredential({ headers: authorized(mint()) }, verifier()),
  }, {});

  assert.equal(result.status, wire.CHARACTER_MISMATCH.status);
  assert.deepEqual(result.body, { error: wire.CHARACTER_MISMATCH.body });
  assert.equal(
    serializeBody(result.body, result.producer).length,
    wire.CHARACTER_MISMATCH.contentLength,
  );

  const names = headerNames(result);
  assert.equal(result.headers["content-type"], wire.CHARACTER_MISMATCH.contentType);
  assert.equal(names.includes("x-content-type-options"), wire.CHARACTER_MISMATCH.sendsNosniff);
  assert.equal(names.includes("x-compatibility-date"), wire.CHARACTER_MISMATCH.echoesCompatibilityDate);
  assert.equal(names.includes("x-esi-cache-status"), wire.CHARACTER_MISMATCH.sendsCacheStatus);
  assert.deepEqual(result.headers.vary, [...wire.CHARACTER_MISMATCH.vary]);
});

test("the two refusals are different refusals, and the code cannot merge them", () => {
  // They were one open question and are two answers: different statuses,
  // different families, different producers, different last byte.
  const scope = unauthorizedScope("esi-wallet.read_character_wallet.v1");
  const mismatch = characterMismatch(FAMILY.LEGACY);

  assert.notEqual(scope.status, mismatch.status);
  assert.notEqual(scope.producer, mismatch.producer);
  const lastByte = (result) => {
    const bytes = Buffer.from(serializeBody(result.body, result.producer));
    return bytes[bytes.length - 1];
  };
  assert.equal(lastByte(scope), 0x0a, "the gateway's refusal ends in a newline");
  assert.notEqual(lastByte(mismatch), 0x0a, "the application's does not");

  // The family nobody has observed is refused rather than derived.
  assert.throws(() => characterMismatch(FAMILY.VALIDATED), /never been observed/);
});
