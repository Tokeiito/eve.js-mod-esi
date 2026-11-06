/**
 * `GET /v2/oauth/verify` and `GET /oauth/verify`: the contract.
 *
 * Run with:  node --test test/verifyContract.test.js
 *
 * Four sources, named per assertion the way `test/tokenContract.test.js` names
 * them (D23), because they carry very different weight:
 *
 *   - The endpoint's specification: the two paths, the seven member names,
 *     their PascalCase spelling, and the one wire fact it records: a refusal
 *     on this endpoint is `text/html`, not JSON.
 *   - `contract/sso.js`: the same, written down, plus
 *     `VERIFY_MEMBER_PROVENANCE`, the record of how much of the rest is ours.
 *     The route duplicates its constants to keep its injection property; the
 *     two copies are asserted to agree.
 *   - `lib/bearerToken.js`, through its exported pure `projectClaims`, which
 *     drives the happy path from a CCP-shaped payload rather than from claims a
 *     double's author invented. `test/tokenIntegration.test.js` exists because
 *     a double agrees with whatever its author believed the neighbour returned;
 *     using the neighbour's own projection applies that lesson at unit cost.
 *   - RFC 9110, RFC 6750 and `routes/oauthVerify.js` itself: the statuses, the
 *     method handling, the challenge header. `contract/sso.js` `UNOBSERVED`
 *     records that no response header has been captured off
 *     `login.eveonline.com`, so those assertions show that the choices are the
 *     ones written down and reasoned about, not that CCP makes them.
 *
 * The three assertions most worth failing on:
 *
 *   "The body is PascalCase": asserted against the serialized string rather
 *   than a parsed object, because `JSON.parse` makes `characterID` and
 *   `CharacterID` look interchangeable, and the clients this endpoint exists
 *   for index the parsed object by the literal key.
 *
 *   "Every 401 is the same bytes": a refusal that varies with the cause tells a
 *   forger that their token parsed and merely expired, the most useful thing
 *   they could learn.
 *
 *   "CharacterID is what sub encodes": the one assertion here that crosses a
 *   module boundary.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const sso = require(path.join(__dirname, "../contract/sso"));
const { createSsoDispatch } = require(path.join(__dirname, "../lib/ssoDispatch"));
const { VERIFY_REASON, projectClaims } = require(path.join(__dirname, "../lib/bearerToken"));
const {
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
} = require(path.join(__dirname, "../routes/oauthVerify"));

// Fixtures

const CHARACTER_ID = 90000001;
const CHARACTER_NAME = "Some Bloke";
const CLIENT_ID = "1f0e3dad99908345f7439f8ffabdffc4";
const SCOPES = ["publicData", "esi-skills.read_skills.v1"];

/**
 * The `owner` claim, shaped like a real one: `contract/sso.js`
 * `ACCESS_TOKEN_OWNER` records standard base64 with a `/` and a pad byte, and
 * both are characters a route that "tidied" the value would lose.
 */
const OWNER = sso.ACCESS_TOKEN_OWNER.sample;

/** `exp`, and the instant it renders to. Chosen so no field is ambiguous. */
const EXP = 1648563218;
const EXPECTED_EXPIRES_ON = "2022-03-29T14:13:38";

/**
 * A payload in CCP's claim shape, built from `contract/sso.js`'s decomposed
 * tables rather than written out, so a claim renamed there breaks here.
 */
function payload(overrides = {}) {
  return {
    ...sso.ACCESS_TOKEN_CONSTANT_CLAIMS,
    scp: SCOPES.slice(),
    jti: "00000000-0000-4000-8000-000000000000",
    sub: `${sso.ACCESS_TOKEN_SUBJECT_PREFIX}${CHARACTER_ID}`,
    azp: CLIENT_ID,
    aud: [CLIENT_ID, sso.ACCESS_TOKEN_AUDIENCE_LITERAL],
    name: CHARACTER_NAME,
    owner: OWNER,
    exp: EXP,
    iat: EXP - sso.ACCESS_TOKEN_LIFETIME_SECONDS,
    iss: "http://host.local:26006",
    ...overrides,
  };
}

/**
 * Claims as `lib/bearerToken.js` actually projects them.
 *
 * `projectClaims` is pure and exported, so this needs no key, no signature and
 * no clock beyond the one number it is handed. Using it rather than an object
 * literal stops this suite passing against a projection that has since been
 * renamed.
 */
function claimsFor(overrides = {}) {
  const projected = projectClaims(payload(overrides), EXP - 1);
  assert.equal(projected.ok, true, "the fixture payload must project cleanly");
  return projected.claims;
}

/** The route, a `bearer` double, and the log lines it emitted. */
function harness({ verdict } = {}) {
  const calls = { log: [], verified: [] };

  const bearer = {
    fromHeader(headers) {
      const value = headers && (headers.authorization || headers.Authorization);
      if (typeof value !== "string") return null;
      // The real one is stricter; a double only has to be honest about the one thing
      // this route depends on: `null` for "nothing was presented".
      return value.startsWith("Bearer ") ? value.slice(7) : null;
    },
    verify(presented) {
      calls.verified.push(presented);
      if (verdict !== undefined) return verdict;
      return { ok: true, claims: claimsFor() };
    },
  };

  const route = createOauthVerifyRoute({ bearer, log: (line) => calls.log.push(line) });
  return { route, calls };
}

/** A request with a bearer token on it. */
function get(route, { method = "GET", authorization = "Bearer a.b.c", pathname } = {}) {
  const headers = authorization === null ? {} : { authorization };
  return route.handle({ method, pathname: pathname || VERIFY_PATHS[0], headers });
}

const bodyOf = (response) => JSON.parse(response.body);

// The route's copies agree with contract/sso.js

test("the route's path, member order and constants are contract/sso.js's", () => {
  // Duplicated rather than required, because `contract/` is never deployed
  // (`lib/sourceHash.js` HASHED_DIRS is ["lib", "routes"]) and a route requiring
  // it would pass this suite and throw MODULE_NOT_FOUND in the game process.
  // This assertion makes the duplication safe.
  assert.deepEqual([...VERIFY_PATHS], [...sso.VERIFY_PATHS]);
  assert.deepEqual([...MEMBER_ORDER], [...sso.VERIFY_MEMBER_ORDER]);
  assert.equal(TOKEN_TYPE, sso.VERIFY_CONSTANT_MEMBERS.TokenType);
  assert.equal(INTELLECTUAL_PROPERTY, sso.VERIFY_CONSTANT_MEMBERS.IntellectualProperty);
  assert.equal(SCOPE_DELIMITER, sso.VERIFY_SCOPES.delimiter);
  assert.equal(CONTENT_TYPE_HTML, sso.REFUSAL_CONTENT_TYPE, "a refusal here is text/html");
});

test("the legacy alias is not under /v2/, and the current one is what discovery advertises", () => {
  // The same shape as the JWKS endpoint's two paths: a route table written by
  // pattern ("the SSO endpoints are /v2/oauth/*") mounts only the first, and
  // every tool written before CCP's JWT migration gets a 404 from an endpoint
  // that is right there.
  assert.equal(VERIFY_PATHS[0], "/v2/oauth/verify");
  assert.equal(VERIFY_PATHS[1], "/oauth/verify");
  assert.ok(!VERIFY_PATHS[1].startsWith("/v2/"), "the legacy alias is not under /v2/");
  assert.equal(VERIFY_PATHS[0], sso.DISCOVERY_ENDPOINT_PATHS.userinfo);
  assert.equal(new Set(VERIFY_PATHS).size, 2);
});

test("both paths reach one handler through lib/ssoDispatch.js", async () => {
  const { route } = harness();
  const dispatch = createSsoDispatch([route]);

  const responses = [];
  for (const pathname of VERIFY_PATHS) {
    responses.push(await dispatch({
      method: "GET",
      pathname,
      headers: { authorization: "Bearer a.b.c" },
    }));
  }

  assert.equal(responses.length, 2);
  // Byte identity, because two spellings of one endpoint that answered
  // differently would be two endpoints.
  assert.equal(responses[0].body, responses[1].body);
  assert.deepEqual(responses[0].headers, responses[1].headers);

  // The dispatch normalizes nothing, so a third spelling is a 404.
  const missing = await dispatch({ method: "GET", pathname: "/v2/oauth/verify/", headers: {} });
  assert.equal(missing.status, 404);
});

// The happy path

test("every one of the seven members is present, and nothing else is", () => {
  const { route } = harness();
  const response = get(route);

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(bodyOf(response)), [...MEMBER_ORDER]);
  assert.equal(MEMBER_ORDER.length, 7);
});

test("the member names are PascalCase, asserted against the serialized bytes", () => {
  // Against the string and not the parsed object: `JSON.parse` makes
  // `characterID` and `CharacterID` look interchangeable, and the clients this
  // endpoint exists for index the parsed object by the literal key. `CharacterID`
  // is `ID` and not `Id`, the character most likely to be silently "corrected".
  const { route } = harness();
  const body = get(route).body;

  for (const member of MEMBER_ORDER) {
    assert.ok(body.includes(`"${member}":`), `${member} must appear exactly so in the bytes`);
  }

  // The snake_case spelling ESI proper would use appears nowhere.
  for (const wrong of ["character_id", "characterID", "CharacterId", "character_name",
    "expires_on", "token_type", "character_owner_hash", "intellectual_property"]) {
    assert.ok(!body.includes(wrong), `${wrong} is not how this endpoint spells anything`);
  }
});

test("the members come out in contract/sso.js's order", () => {
  // Member order is irrelevant to every JSON parser and observable to a client
  // comparing against a recorded fixture. One array is what it costs to keep, and
  // this stops a readability re-sort.
  const { route } = harness();
  const body = get(route).body;

  let cursor = -1;
  for (const member of sso.VERIFY_MEMBER_ORDER) {
    const at = body.indexOf(`"${member}":`);
    assert.ok(at > cursor, `${member} is out of order in the serialized body`);
    cursor = at;
  }
});

test("CharacterID is the integer the token's sub encodes", () => {
  // The one assertion here that crosses a module boundary: the claims come from
  // `lib/bearerToken.js`'s own `projectClaims`, and the id is checked back
  // against the raw subject with the consumer's regex from `contract/sso.js`
  // rather than against the integer the projection handed over.
  const claims = claimsFor();
  const { route } = harness({ verdict: { ok: true, claims } });
  const body = bodyOf(get(route));

  const match = sso.ACCESS_TOKEN_SUBJECT_PATTERN.exec(claims.subject);
  assert.notEqual(match, null, "the fixture subject must match the recorded pattern");
  assert.equal(body.CharacterID, Number(match[1]));
  assert.equal(body.CharacterID, CHARACTER_ID);
  assert.equal(typeof body.CharacterID, "number");
  assert.ok(Number.isInteger(body.CharacterID), "an integer, not a numeric string");
  assert.ok(!get(route).body.includes(`"CharacterID":"`), "and not quoted in the bytes");
});

test("CharacterName is the name claim", () => {
  const { route } = harness();
  assert.equal(bodyOf(get(route)).CharacterName, CHARACTER_NAME);
});

test("CharacterOwnerHash is the owner claim verbatim, standard base64 and all", () => {
  // Two names for one value; `contract/sso.js` `VERIFY_MEMBER_SOURCES` carries
  // the confirmation. This asserts that nothing is derived: a second derivation
  // would be a second thing to keep in step with `lib/accessToken.js`
  // `ownerHashFor`, and the first time it fell behind, every client comparing a
  // stored `CharacterOwnerHash` against a JWT's `owner` would discard a working
  // refresh token.
  const { route } = harness();
  const body = bodyOf(get(route));

  assert.equal(body.CharacterOwnerHash, OWNER);
  assert.equal(body.CharacterOwnerHash, claimsFor().owner);
  // The `/` and the `=` prove the alphabet was not "fixed" to base64url on the
  // way out.
  assert.ok(body.CharacterOwnerHash.includes("/"), "standard base64, not base64url");
  assert.ok(body.CharacterOwnerHash.endsWith("="), "padded");
  assert.equal(sso.ACCESS_TOKEN_OWNER.base64, "standard");
});

test("TokenType is Character, and is emphatically not Bearer", () => {
  // Two members four characters apart with unrelated meanings: `token_type` in a
  // token response is the HTTP authentication scheme; `TokenType` here names the
  // subject's namespace.
  const { route } = harness();
  const body = bodyOf(get(route));

  assert.equal(body.TokenType, "Character");
  assert.notEqual(body.TokenType, "Bearer");
  assert.ok(
    sso.ACCESS_TOKEN_SUBJECT_PREFIX.toUpperCase().startsWith(body.TokenType.toUpperCase()),
    "the value names the subject namespace CHARACTER:EVE: comes from",
  );
});

test("IntellectualProperty is EVE, and contract/sso.js records that as ours", () => {
  const { route } = harness();
  assert.equal(bodyOf(get(route)).IntellectualProperty, "EVE");
  assert.equal(sso.VERIFY_MEMBER_PROVENANCE.IntellectualProperty, "ours");
});

// Scopes, and ExpiresOn

test("Scopes is a space-delimited string, not the array scp carries", () => {
  // The opposite of `scp`'s decision one surface over, deliberately: this body's
  // consumers were written against RFC 6749 section 3.3's `scope`, which is a
  // string. `contract/sso.js` `VERIFY_SCOPES` carries the argument.
  const { route } = harness();
  const body = bodyOf(get(route));

  assert.equal(typeof body.Scopes, "string");
  assert.equal(body.Scopes, SCOPES.join(" "));
  assert.deepEqual(body.Scopes.split(" "), SCOPES);
  assert.equal(sso.ACCESS_TOKEN_SCP.oursAlwaysArray, true, "while scp stays an array");
  assert.equal(sso.VERIFY_SCOPES.oursIsSpaceDelimitedString, true);
});

test("a token with one scope still gets a string, and one with none gets an empty one", () => {
  const one = harness({ verdict: { ok: true, claims: claimsFor({ scp: ["publicData"] }) } });
  const oneBody = bodyOf(get(one.route));
  assert.equal(oneBody.Scopes, "publicData");
  assert.equal(typeof oneBody.Scopes, "string");

  const none = harness({ verdict: { ok: true, claims: claimsFor({ scp: [] }) } });
  const noneBody = bodyOf(get(none.route));
  // Present and empty, never null and never absent: every member must be there,
  // and a body whose member set depends on its content is one a client has to
  // branch on.
  assert.equal(noneBody.Scopes, "");
  assert.ok(Object.prototype.hasOwnProperty.call(noneBody, "Scopes"));
  assert.deepEqual(Object.keys(noneBody), [...MEMBER_ORDER]);
});

test("scopesStringOf takes either shape and never produces a double space", () => {
  assert.equal(scopesStringOf(["a", "b"]), "a b");
  assert.equal(scopesStringOf("a b"), "a b");
  assert.equal(scopesStringOf([]), "");
  assert.equal(scopesStringOf(undefined), "");
  assert.equal(scopesStringOf(null), "");
  assert.equal(scopesStringOf(7), "");
  // A stray empty element would otherwise become a scope named "" in every
  // consumer that splits on a single space.
  assert.equal(scopesStringOf(["a", "", "b"]), "a b");
});

test("ExpiresOn is UTC seconds with no zone designator and no fraction", () => {
  const { route } = harness();
  const body = bodyOf(get(route));

  assert.equal(body.ExpiresOn, EXPECTED_EXPIRES_ON);
  assert.match(body.ExpiresOn, sso.VERIFY_EXPIRES_ON.pattern);
  assert.ok(!body.ExpiresOn.endsWith("Z"), "no zone designator: contract/sso.js says why");
  assert.ok(!body.ExpiresOn.includes("."), "no fractional seconds");
  assert.equal(sso.VERIFY_EXPIRES_ON.oursHasZoneDesignator, false);
  assert.equal(sso.VERIFY_EXPIRES_ON.oursHasFractionalSeconds, false);

  // It is the same instant `exp` encodes, read back the strict way. This would
  // catch a local-time rendering, the one mistake the missing `Z` makes easy to
  // commit and hard to see.
  assert.equal(Date.parse(`${body.ExpiresOn}Z`), EXP * 1000);
});

test("expiresOnFrom floors a fractional exp and refuses what it cannot render", () => {
  // RFC 7519 section 2 permits a non-integer NumericDate and
  // `lib/bearerToken.js` accepts one, so refusing here would 500 on a token the
  // verifier called good. Down rather than to-nearest: the advertised instant is
  // then never later than the real one, so a client scheduling from it refreshes
  // early.
  assert.equal(expiresOnFrom(EXP), EXPECTED_EXPIRES_ON);
  assert.equal(expiresOnFrom(EXP + 0.9), EXPECTED_EXPIRES_ON);
  assert.equal(expiresOnFrom(EXP + 0.1), EXPECTED_EXPIRES_ON);

  for (const unusable of [undefined, null, "1648563218", NaN, Infinity, -Infinity, {}]) {
    assert.equal(expiresOnFrom(unusable), null, `${String(unusable)} is not a renderable instant`);
  }

  // The expanded-year form is what a blind slice(0, 19) falls into:
  // `+275760-09-13T00:00:00.000Z` truncates to something the right length and
  // wrong everywhere else, and it would reach a client.
  assert.equal(expiresOnFrom(8.64e12 + 1), null, "beyond the Date range is refused, not sliced");
  // Year 10000 renders as `+010000-01-01T00:00:00.000Z`, which a blind
  // slice(0, 19) would turn into `+010000-01-01T00:0`: right length, wrong
  // everywhere else, and it would reach a client.
  assert.equal(expiresOnFrom(253402300800), null, "the expanded-year form is refused");
  // The last second before it still renders, so the check is a shape test and
  // not an accidental upper bound on ordinary tokens.
  assert.match(String(expiresOnFrom(253402300799)), sso.VERIFY_EXPIRES_ON.pattern);
});

// The 401, and everything it does not say

test("a missing bearer, a malformed one and an expired one are the same 401 bytes", () => {
  // A refusal that varied with the cause would tell a forger that their token
  // parsed and merely expired, the most useful thing they could learn. The
  // distinction is kept, in the log.
  const cases = [
    ["no Authorization header", harness({ verdict: undefined }), { authorization: null }],
    ["a malformed token", harness({
      verdict: { ok: false, reason: VERIFY_REASON.MALFORMED, detail: "not three segments." },
    }), {}],
    ["an expired token", harness({
      verdict: { ok: false, reason: VERIFY_REASON.EXPIRED, detail: "exp passed 4s ago." },
    }), {}],
    ["a bad signature", harness({
      verdict: { ok: false, reason: VERIFY_REASON.BAD_SIGNATURE, detail: "no." },
    }), {}],
    ["a wrong issuer", harness({
      verdict: { ok: false, reason: VERIFY_REASON.WRONG_ISSUER, detail: "no." },
    }), {}],
  ];

  const seen = new Set();
  for (const [label, built, options] of cases) {
    const response = get(built.route, options);
    assert.equal(response.status, 401, `${label} is a 401`);
    assert.equal(response.headers["content-type"], CONTENT_TYPE_HTML, `${label} is text/html`);
    assert.equal(response.body, UNAUTHORIZED_BODY);
    seen.add(JSON.stringify({ s: response.status, h: response.headers, b: response.body }));
  }

  assert.equal(seen.size, 1, "every 401 on this endpoint is the same response, byte for byte");
});

test("the 401 body carries nothing about why, and the log carries all of it", () => {
  const expired = harness({
    verdict: { ok: false, reason: VERIFY_REASON.EXPIRED, detail: "exp 1648563218 passed 4s ago." },
  });
  const response = get(expired.route);

  // Nothing in the bytes names a cause, a claim, a token or a character.
  const forbidden = [
    "expired", "EXPIRED", "malformed", "signature", "issuer", "token", "Bearer",
    "1648563218", CHARACTER_NAME, String(CHARACTER_ID), OWNER, CLIENT_ID,
  ];
  for (const needle of forbidden) {
    assert.ok(!response.body.includes(needle), `the 401 body must not contain ${needle}`);
  }
  assert.ok(response.body.includes("401"), "it does say which status it is, and stops");

  // The operator's copy has the machine reason and the verifier's sentence.
  assert.equal(expired.calls.log.length, 1);
  assert.ok(expired.calls.log[0].includes(VERIFY_REASON.EXPIRED));
  assert.ok(expired.calls.log[0].includes("passed 4s ago"));
});

test("EXPIRED stays a distinct name in the log, so it can be filtered out", () => {
  // It is the ordinary end of a token's life, happening once every twenty minutes
  // per client. A log that reports it in the same words as a bad signature buries
  // the one that matters.
  const expired = harness({ verdict: { ok: false, reason: VERIFY_REASON.EXPIRED, detail: "x." } });
  const forged = harness({
    verdict: { ok: false, reason: VERIFY_REASON.BAD_SIGNATURE, detail: "x." },
  });
  get(expired.route);
  get(forged.route);

  assert.notEqual(expired.calls.log[0], forged.calls.log[0]);
  assert.ok(!forged.calls.log[0].includes(VERIFY_REASON.EXPIRED));
});

test("the 401 challenges with Bearer and carries no RFC 6750 error parameter", () => {
  // RFC 9110 section 15.5.2 makes the header mandatory on a 401, so omitting it
  // is not neutral. RFC 6750 section 3's `error="invalid_token"` is deliberately
  // absent: it would put the why back in the response one header line away from
  // the body that was made not to say it.
  const { route } = harness();
  const response = get(route, { authorization: null });

  assert.equal(response.headers["www-authenticate"], WWW_AUTHENTICATE);
  assert.ok(response.headers["www-authenticate"].startsWith("Bearer "), "the scheme we implement");
  assert.ok(!response.headers["www-authenticate"].includes("error"));
  assert.ok(!response.headers["www-authenticate"].includes("Basic"));
});

test("a verifier that answers nothing usable is still a 401, not a throw", () => {
  // `ok !== true` rather than a falsiness test, for `lib/clientAuth.js`'s reason:
  // a double or a future version answering with an object that has no `ok` at all
  // must not be read as a pass.
  for (const verdict of [null, undefined, {}, { ok: "yes" }, { ok: 1 }, { claims: {} }]) {
    const bearer = { fromHeader: () => "a.b.c", verify: () => verdict };
    const route = createOauthVerifyRoute({ bearer });
    const response = route.handle({ method: "GET", headers: { authorization: "Bearer a.b.c" } });
    assert.equal(response.status, 401, `${JSON.stringify(verdict)} is not a pass`);
    assert.equal(response.body, UNAUTHORIZED_BODY);
  }
});

test("fromHeader owning the parse means this route never sees a header shape", () => {
  const { route, calls } = harness();
  get(route, { authorization: "Bearer a.b.c" });
  // Whatever `fromHeader` returned is what `verify` was handed, unmodified.
  assert.deepEqual(calls.verified, ["a.b.c"]);

  // A wrong scheme is "nothing was presented" rather than a bad token, which is
  // `lib/bearerToken.js`'s documented behaviour and the reason the route's own
  // check is `typeof token !== "string"`.
  const wrongScheme = harness();
  const response = get(wrongScheme.route, { authorization: "Basic dXNlcjpwYXNz" });
  assert.equal(response.status, 401);
  assert.deepEqual(wrongScheme.calls.verified, [], "verify is not called with a non-credential");
});

// Methods

test("GET and HEAD are answered, and HEAD is the GET", () => {
  // `routes/oauthJwks.js`'s arrangement: HEAD runs the GET and Node's
  // ServerResponse drops the body, so the two methods cannot become two code
  // paths that disagree about the headers.
  assert.deepEqual([...ALLOWED_METHODS], ["GET", "HEAD"]);

  const { route } = harness();
  const read = get(route);
  const head = get(route, { method: "HEAD" });

  assert.equal(head.status, 200);
  assert.deepEqual(head.headers, read.headers);
  assert.equal(head.body, read.body);
});

test("everything else is a 405 with Allow, in text/html", () => {
  // Unlike `routes/oauthToken.js`, refusing OPTIONS here is not about a
  // destructive request. It avoids advertising that a cross-origin page may hold
  // an access token and read a character out of it.
  const { route } = harness();

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {
    const response = get(route, { method });
    assert.equal(response.status, 405, `${method} is refused`);
    assert.equal(response.headers.allow, ALLOW);
    assert.equal(response.headers.allow, "GET, HEAD");
    assert.equal(response.headers["content-type"], CONTENT_TYPE_HTML);
    assert.equal(response.body, METHOD_NOT_ALLOWED_BODY);
  }
});

test("a request with no method at all is read as a GET", () => {
  // `server.js` always supplies one; a route driven by an object literal may not,
  // and defaulting to the allowed method keeps a test's omission from looking
  // like a 405.
  const { route } = harness();
  const response = route.handle({ headers: { authorization: "Bearer a.b.c" } });
  assert.equal(response.status, 200);
});

// Content types and caching

test("the success is bare application/json and the refusals are bare text/html", () => {
  // Nothing here is borrowed from `contract/wire.js`: its three JSON spellings
  // are facts about esi.evetech.net's two producers, on a different hostname.
  const { route } = harness();
  assert.equal(get(route).headers["content-type"], CONTENT_TYPE_JSON);
  assert.equal(CONTENT_TYPE_JSON, "application/json");
  assert.ok(!CONTENT_TYPE_JSON.includes("charset"));

  const refusal = get(route, { authorization: null });
  assert.equal(refusal.headers["content-type"], "text/html");
  assert.ok(!refusal.headers["content-type"].includes("charset"));
  // The bare media type is only safe because a browser may not re-sniff it.
  assert.equal(refusal.headers["x-content-type-options"], "nosniff");
});

test("nothing from this endpoint may be cached, refusals included", () => {
  // A cached 401 outlives the expired token that caused it, and the client's
  // refresh then looks like it did not work.
  const { route } = harness();
  for (const response of [get(route), get(route, { authorization: null }),
    get(route, { method: "POST" })]) {
    assert.equal(response.headers["cache-control"], CACHE_CONTROL);
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("the body is a string, as lib/ssoDispatch.js's route contract requires", () => {
  const { route } = harness();
  assert.equal(typeof get(route).body, "string");
  assert.equal(typeof get(route, { authorization: null }).body, "string");
});

// The 500s: our fault, not the caller's

test("a verified token this route cannot project is a 500, not a 401", () => {
  // Answering 401 would tell a client with a perfectly good token to throw it
  // away and re-authorise, which under D3 means a human back at the game client
  // typing a bind code, for a defect a restart might fix.
  //
  // None of these is reachable through the real `lib/bearerToken.js`, which
  // refuses such a token before projecting it. They are backstops, because this
  // route is written against an interface rather than one implementation, and
  // the alternative is a 200 carrying `"CharacterName":null`.
  const unusable = [
    ["no character id", { characterId: undefined }],
    ["a non-integer character id", { characterId: 1.5 }],
    ["a negative character id", { characterId: -1 }],
    ["no character name", { characterName: undefined }],
    ["an empty character name", { characterName: "" }],
    ["no owner hash", { owner: undefined }],
    ["an empty owner hash", { owner: "" }],
    ["no expiry", { expiresAt: undefined }],
    ["an unrenderable expiry", { expiresAt: "soon" }],
  ];

  const bodies = new Set();
  for (const [label, override] of unusable) {
    const claims = { ...claimsFor(), ...override };
    const built = harness({ verdict: { ok: true, claims } });
    const response = get(built.route);

    assert.equal(response.status, 500, `${label} is a 500`);
    assert.equal(response.headers["content-type"], CONTENT_TYPE_HTML, `${label} is text/html`);
    assert.equal(response.body, SERVER_ERROR_BODY);
    assert.equal(built.calls.log.length, 1, `${label} is logged once`);
    bodies.add(response.body);
  }

  assert.equal(bodies.size, 1, "one 500 document, whatever went wrong");
});

test("an empty owner hash is refused rather than emitted", () => {
  // Emitting `""` is worse than no answer: a client stores it, compares a real
  // hash against it later, sees a change, and discards a working refresh token.
  const built = harness({ verdict: { ok: true, claims: { ...claimsFor(), owner: "" } } });
  const response = get(built.route);
  assert.equal(response.status, 500);
  assert.ok(built.calls.log[0].includes("owner hash"));
});

// Construction

test("a missing dependency throws at construction, naming what to inject", () => {
  // `lib/ssoDispatch.js`'s reason: a table with a mistake in it should fail at
  // boot naming the route, not on the one request that reaches it.
  assert.throws(() => createOauthVerifyRoute(), /bearer\.fromHeader/);
  assert.throws(() => createOauthVerifyRoute({}), /bearer\.fromHeader/);
  assert.throws(
    () => createOauthVerifyRoute({ bearer: { fromHeader: () => null } }),
    /bearer\.verify/,
  );
  assert.throws(() => createOauthVerifyRoute(), TypeError);
});

test("the route is frozen and shaped the way lib/ssoDispatch.js expects", () => {
  const { route } = harness();
  assert.ok(Object.isFrozen(route));
  assert.equal(route.name, "GetOauthVerify");
  assert.ok(Array.isArray(route.paths) && Object.isFrozen(route.paths));
  assert.equal(typeof route.handle, "function");
});

test("the module's exports are frozen, and so are its constant tables", () => {
  const module = require(path.join(__dirname, "../routes/oauthVerify"));
  assert.ok(Object.isFrozen(module));
  assert.ok(Object.isFrozen(MEMBER_ORDER));
  assert.ok(Object.isFrozen(ALLOWED_METHODS));
  assert.ok(Object.isFrozen(VERIFY_PATHS));
});

// The provenance record

test("contract/sso.js records what we had to decide, and holds no invented facts", () => {
  // The endpoint's specification gives seven names and no values, so not one
  // entry in the table is `observed`. A later author who does capture CCP's
  // answer has to move the label as well as the value.
  assert.deepEqual(
    Object.keys(sso.VERIFY_MEMBER_PROVENANCE).sort(),
    [...sso.VERIFY_MEMBER_ORDER].sort(),
    "every member has a provenance label",
  );

  for (const [member, level] of Object.entries(sso.VERIFY_MEMBER_PROVENANCE)) {
    assert.ok(
      sso.VERIFY_PROVENANCE_LEVELS.includes(level),
      `${member} carries ${level}, which is not one of the three labels`,
    );
  }

  assert.ok(
    !Object.values(sso.VERIFY_MEMBER_PROVENANCE).includes("observed"),
    "nothing here is observed; no value is recorded for any member",
  );

  // The gaps are named, with a request that would close them, and hold no values
  // to be mistaken for facts.
  for (const name of ["verifyMemberValues", "verifyRefusalBody"]) {
    assert.equal(typeof sso.UNOBSERVED[name], "string");
    assert.ok(sso.UNOBSERVED[name].includes("curl"), `${name} names the request that settles it`);
  }
});

test("every member's source is a claim this replica mints, or a constant", () => {
  // Catches a member wired to a claim that does not exist, which no assertion
  // about the route alone would find.
  assert.deepEqual(
    Object.keys(sso.VERIFY_MEMBER_SOURCES).sort(),
    [...sso.VERIFY_MEMBER_ORDER].sort(),
  );

  for (const [member, source] of Object.entries(sso.VERIFY_MEMBER_SOURCES)) {
    if (source === "constant") {
      assert.ok(
        Object.prototype.hasOwnProperty.call(sso.VERIFY_CONSTANT_MEMBERS, member),
        `${member} is a constant, so it needs a value`,
      );
      continue;
    }
    assert.ok(
      sso.ACCESS_TOKEN_CLAIM_ORDER.includes(source),
      `${member} reads ${source}, which is not a claim this replica mints`,
    );
  }

  // `CharacterOwnerHash` is the `owner` claim.
  assert.equal(sso.VERIFY_MEMBER_SOURCES.CharacterOwnerHash, "owner");
  assert.equal(sso.VERIFY_MEMBER_SOURCES.CharacterID, "sub");
});
