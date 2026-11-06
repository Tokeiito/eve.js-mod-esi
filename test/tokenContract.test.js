/**
 * `POST /v2/oauth/token`: the contract.
 *
 * Run with:  node --test test/tokenContract.test.js
 *
 * Four sources, named per assertion the way `test/authorizeContract.test.js`
 * names them (D23), because they cover very different ground:
 *
 *   - The endpoint's recorded success shape: the response's four members and
 *     their order, the literal `Bearer`, the `expires_in` range, the two cache
 *     directives. These are transcriptions of CCP's live surface.
 *   - `contract/sso.js`: the path, and the access token's lifetime. Also
 *     transcriptions, and the route's copies are asserted against them.
 *   - `lib/authCodes.js` and `lib/refreshTokens.js`: the outcome enums. The
 *     route duplicates three names out of them to keep its injection property;
 *     the two copies are asserted to agree, and the whole enum is walked so an
 *     outcome added later cannot quietly leak.
 *   - RFC 6749, RFC 7636 and `routes/oauthToken.js` itself: the statuses, the
 *     error names, the method handling and the `invalid_client` split.
 *     `contract/sso.js` `UNOBSERVED` records that no response header has been
 *     captured off `login.eveonline.com`, so those assertions show that the
 *     choices are the ones written down and reasoned about, not that CCP makes
 *     them.
 *
 * There is no store, no key and no game. The route is driven with object
 * literals and four doubles. `lib/clientAuth.js`, `lib/authCodes.js`,
 * `lib/refreshTokens.js` and `lib/accessToken.js` are other modules the route
 * has never heard of, which is the point of injecting them.
 *
 * The exception is the `+` and `/` case, driven through a real listener:
 * `server.js`'s own request handler over a real socket with a real
 * form-encoded body. A hand-built request object would prove the route decodes
 * what the test encoded and nothing about what arrives in the field; the
 * failure lives between the client's encoder and this route's decoder.
 *
 * The three assertions most worth failing on:
 *
 *   "Every authCodes outcome answers invalid_grant": the day one answers
 *   something else, this endpoint becomes an oracle for which authorization
 *   codes this server has minted.
 *
 *   "Neither token is ever empty in a success response":
 *   `docs/d6-listener-split.md` records the EVE client treating an empty one as
 *   an error, and a 200 with a blank field fails in the client with a message
 *   about something else entirely.
 *
 *   "A refresh token containing + and / survives a real form body": every
 *   unit test can pass through this failure and every real client hits it on
 *   its first refresh.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

const sso = require(path.join(__dirname, "../contract/sso"));
const { REDEEM_OUTCOME } = require(path.join(__dirname, "../lib/authCodes"));
const { REFRESH_OUTCOME, REVOKE_OUTCOME } = require(path.join(__dirname, "../lib/refreshTokens"));
const { createSsoDispatch } = require(path.join(__dirname, "../lib/ssoDispatch"));
const { createRequestHandler } = require(path.join(__dirname, "../server"));
const {
  ACCESS_TOKEN_STILL_LIVE,
  ALLOWED_METHOD,
  CACHE_CONTROL,
  CONTENT_TYPE_JSON,
  GRANT_TYPE,
  INVALID_CODE_DESCRIPTION,
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
  scopesOf,
} = require(path.join(__dirname, "../routes/oauthToken"));

// Fixtures

const CLIENT_ID = "1f0e3dad99908345f7439f8ffabdffc4";
const OTHER_CLIENT_ID = "ffffffffffffffffffffffffffffffff";
const REDIRECT_URI = "http://127.0.0.1:8080/sso/callback";
const CHARACTER_ID = 90000001;
const CODE = "an-authorization-code";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const SCOPES = ["publicData", "esi-skills.read_skills.v1"];

/**
 * A refresh token shaped like a real one: standard base64, so it carries the
 * `+` and the `/` that form decoding mishandles, plus the `=` padding that a
 * naive query-string splitter also mishandles.
 */
const GNARLY_REFRESH_TOKEN = "gEy+Th1s/Is+A/Refresh+Token/With==";

/**
 * The lineage id `refreshTokens.issue` puts on the record it writes, shaped the
 * way the real store shapes one: 16 bytes as hex.
 *
 * The route never parses it and never mints one, so in every family assertion
 * what matters is that it is the same string that came back from `issue` and
 * went into `rememberGrant` and then into `revokeFamily`. A route that invented
 * its own identifier, or passed the `grantRef` from one store where the other's
 * belonged, would pass a test that only checked the shape.
 */
const FAMILY = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** The recorded success body, as a shape rather than as bytes. */
const EXPECTED_MEMBERS = ["access_token", "token_type", "expires_in", "refresh_token"];

/**
 * The four doubles, plus a record of everything that reached them.
 *
 * Every answer is a knob, because what this endpoint does is almost entirely
 * decided by what its dependencies say: the interesting tests are the ones where
 * a dependency refuses and the question is whether the refusal reaches the
 * caller intact or gets reinterpreted on the way.
 *
 * `rememberGrant` and `revokeFamily` are knobs on the same terms. Both are
 * recorded rather than only answered, because for those two the assertion is
 * usually about the argument rather than the answer: the family the token store
 * minted must be the family the code store binds and the family a replay later
 * kills, and only the recorded call says so.
 */
function harness(options = {}) {
  const calls = {
    authenticate: [],
    verifyPkce: [],
    mayRedeem: [],
    redeem: [],
    rememberGrant: [],
    issue: [],
    refresh: [],
    revokeFamily: [],
    mint: [],
    log: [],
  };

  const record = {
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope: SCOPES.join(" "),
    codeChallenge: CHALLENGE,
    codeChallengeMethod: "S256",
    characterId: CHARACTER_ID,
    ...(options.record || {}),
  };

  const grant = {
    clientId: CLIENT_ID,
    characterId: CHARACTER_ID,
    scopes: SCOPES,
    ...(options.grant || {}),
  };

  const deps = {
    clientAuth: {
      authenticate(args) {
        calls.authenticate.push(args);
        return options.authenticate
          ? options.authenticate(args)
          : { ok: true, clientId: CLIENT_ID, authenticated: true, method: "client_secret_basic" };
      },
      verifyPkce(args) {
        calls.verifyPkce.push(args);
        return options.verifyPkce ? options.verifyPkce(args) : { ok: true };
      },
      mayRedeem(args) {
        calls.mayRedeem.push(args);
        return options.mayRedeem ? options.mayRedeem(args) : { ok: true };
      },
    },
    authCodes: {
      redeem(code) {
        calls.redeem.push(code);
        if (options.redeem) return options.redeem(code);
        return { outcome: REDEEM_OUTCOME.OK, record, grant: null };
      },
      rememberGrant(code, grantRef) {
        calls.rememberGrant.push({ code, grantRef });
        if (options.rememberGrant) return options.rememberGrant(code, grantRef);
        return true;
      },
    },
    refreshTokens: {
      issue(args) {
        calls.issue.push(args);
        if (options.issue) return options.issue(args);
        return { token: GNARLY_REFRESH_TOKEN, record: { ...grant, family: FAMILY } };
      },
      revokeFamily(family, request) {
        calls.revokeFamily.push({ family, request });
        if (options.revokeFamily) return options.revokeFamily(family, request);
        return { outcome: REVOKE_OUTCOME.OK, records: [{ family }] };
      },
      refresh(token, args) {
        calls.refresh.push({ token, args });
        if (options.refresh) return options.refresh(token, args);
        const requested = (args && args.scopes) || [];
        const granted = requested.length > 0 ? requested : grant.scopes;
        return {
          outcome: REFRESH_OUTCOME.OK,
          record: { ...grant },
          scopes: granted,
          scope: granted.join(" "),
        };
      },
    },
    mintAccessToken(args) {
      calls.mint.push(args);
      if (options.mint) return options.mint(args);
      return { token: "eyJhbGciOiJSUzI1NiJ9.payload.signature", expiresIn: 1200 };
    },
    now: () => 1_700_000_000_000,
    log: (message) => calls.log.push(message),
  };

  return { route: createOauthTokenRoute(deps), calls, record, grant, deps };
}

/** One token request, driven directly. `fields` becomes the form body. */
function post(route, fields = {}, request = {}) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    params.append(name, value);
  }

  return route.handle({
    method: "POST",
    pathname: TOKEN_PATH,
    query: {},
    headers: { "content-type": REQUEST_CONTENT_TYPE, ...(request.headers || {}) },
    rawBody: Buffer.from(request.rawBody === undefined ? params.toString() : request.rawBody),
    body: null,
    ...(request.rest || {}),
  });
}

/** The authorization-code exchange, with every parameter a real client sends. */
function exchangeCode(route, overrides = {}, request = {}) {
  return post(route, {
    grant_type: GRANT_TYPE.AUTHORIZATION_CODE,
    code: CODE,
    code_verifier: VERIFIER,
    ...overrides,
  }, request);
}

/** The refresh exchange. */
function refresh(route, overrides = {}, request = {}) {
  return post(route, {
    grant_type: GRANT_TYPE.REFRESH_TOKEN,
    refresh_token: GNARLY_REFRESH_TOKEN,
    ...overrides,
  }, request);
}

/** Case-insensitive header read, as `test/jwksContract.test.js` does it. */
function header(response, name) {
  const entry = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === name);
  return entry === undefined ? undefined : entry[1];
}

function bodyOf(response) {
  assert.equal(typeof response.body, "string", "an SSO route serializes its own body");
  return JSON.parse(response.body);
}

// The constants this route duplicates

test("the route's copy of the path is contract/sso.js's", () => {
  assert.equal(TOKEN_PATH, sso.DISCOVERY_ENDPOINT_PATHS.token);

  // The route mounts exactly where the discovery document points, the member the
  // EVE client reads on every launch. A divergence between the two is a client
  // that cannot refresh at all, and no unit test of either half would catch it.
  assert.deepEqual(createOauthTokenRoute(harness().deps).paths, [TOKEN_PATH]);
});

test("the route's copies of the outcome names are the stores' own", () => {
  // `routes/` may not require `contract/` (it is not deployed) and this route
  // does not require `lib/` either, because injection is the property the whole
  // file is built on. Both copies are checked here instead.
  assert.equal(REDEEM_OK, REDEEM_OUTCOME.OK);
  assert.equal(REFRESH_OK, REFRESH_OUTCOME.OK);
  assert.equal(REFRESH_SCOPE_NOT_SUBSET, REFRESH_OUTCOME.SCOPE_NOT_SUBSET);

  // This decides only what a log line says. A drift here would make the replay
  // alarm claim a revocation that did not happen, the one way this endpoint could
  // misinform an operator without changing a byte on the wire.
  assert.equal(REVOKE_OK, REVOKE_OUTCOME.OK);
});

// Both grants, end to end

test("an authorization code becomes the recorded four-member response", () => {
  const { route, calls } = harness();
  const response = exchangeCode(route);

  assert.equal(response.status, 200);
  const body = bodyOf(response);

  // Member order too, not just membership: this order is recorded and a client
  // holding a recorded fixture compares the whole document. Built from
  // RESPONSE_MEMBER_ORDER in the route for this reason.
  assert.deepEqual(Object.keys(body), EXPECTED_MEMBERS);
  assert.deepEqual(RESPONSE_MEMBER_ORDER.slice(), EXPECTED_MEMBERS);

  assert.equal(body.access_token, "eyJhbGciOiJSUzI1NiJ9.payload.signature");
  assert.equal(body.refresh_token, GNARLY_REFRESH_TOKEN);
  assert.equal(body.expires_in, 1200);

  // Capital B, because several clients string-compare it.
  assert.equal(body.token_type, "Bearer");
  assert.equal(TOKEN_TYPE, "Bearer");

  // The code was redeemed exactly once, and the grant reached both stores.
  assert.deepEqual(calls.redeem, [CODE]);
  assert.deepEqual(calls.issue, [
    { characterId: CHARACTER_ID, clientId: CLIENT_ID, scopes: SCOPES },
  ]);
  assert.deepEqual(calls.mint, [
    { characterId: CHARACTER_ID, clientId: CLIENT_ID, scopes: SCOPES },
  ]);
});

test("a refresh token becomes the same four-member response", () => {
  const { route, calls } = harness();
  const response = refresh(route);

  assert.equal(response.status, 200);
  const body = bodyOf(response);

  assert.deepEqual(Object.keys(body), EXPECTED_MEMBERS);
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.expires_in, 1200);

  // D30: no rotation. The token that comes back is the one that was presented,
  // byte for byte; the store cannot return one, it holds only a hash. A client
  // that persists whatever it receives writes back what it had.
  assert.equal(body.refresh_token, GNARLY_REFRESH_TOKEN);
  assert.equal(calls.refresh.length, 1);
  assert.equal(calls.refresh[0].token, GNARLY_REFRESH_TOKEN);

  // A refresh mints an access token and never issues a second refresh token.
  assert.equal(calls.issue.length, 0);
  assert.equal(calls.mint.length, 1);
});

test("expires_in is the minter's number, not a second reading of the clock", () => {
  // The recorded range is 1199-1200, and `lib/accessToken.js` guarantees it by
  // returning its configured lifetime rather than `exp - now()`. This route
  // copies that number, so the assertion is that it copies rather than computes.
  for (const expiresIn of [1199, 1200, 600]) {
    const { route } = harness({ mint: () => ({ token: "eyJ.a.b", expiresIn }) });
    assert.equal(bodyOf(exchangeCode(route)).expires_in, expiresIn);
    assert.equal(bodyOf(refresh(route)).expires_in, expiresIn);
  }

  // The real minter's default lands inside the recorded range.
  assert.equal(sso.ACCESS_TOKEN_LIFETIME_SECONDS, 1200);
  assert.ok(sso.ACCESS_TOKEN_LIFETIME_SECONDS >= 1199);
});

test("a minter that reports an unusable expires_in is a 500, not a guess", () => {
  for (const expiresIn of [undefined, null, "1200", 0, -1, 1200.5]) {
    const { route } = harness({ mint: () => ({ token: "eyJ.a.b", expiresIn }) });
    const response = exchangeCode(route);
    assert.equal(response.status, 500);
    assert.equal(bodyOf(response).error, "server_error");
  }
});

// Neither token is ever empty

test("neither token is ever empty in a success response", () => {
  // `docs/d6-listener-split.md`: the EVE client treats an empty access_token or
  // an empty refresh_token as an error. There must be no 200 with a blank field
  // on either grant.
  for (const drive of [exchangeCode, refresh]) {
    const { route } = harness();
    const body = bodyOf(drive(route));
    assert.equal(typeof body.access_token, "string");
    assert.notEqual(body.access_token, "");
    assert.equal(typeof body.refresh_token, "string");
    assert.notEqual(body.refresh_token, "");
  }
});

test("an unusable token from either store is a 500 rather than a blank field", () => {
  for (const token of [undefined, null, "", 0]) {
    const issueFails = harness({ issue: () => ({ token, failure: "at_capacity" }) });
    const one = exchangeCode(issueFails.route);
    assert.equal(one.status, 500);
    assert.equal(bodyOf(one).error, "server_error");
    // The access token is never minted: nothing is signed for a response that is
    // not going to be sent.
    assert.equal(issueFails.calls.mint.length, 0);

    const mintFails = harness({ mint: () => ({ token, expiresIn: 1200 }) });
    const two = exchangeCode(mintFails.route);
    assert.equal(two.status, 500);
    assert.equal(bodyOf(two).error, "server_error");
  }
});

test("a minter that throws is a 500 in the OAuth error shape, not an unhandled throw", () => {
  // `lib/accessToken.js` mint raises AccessTokenError by design. Left to
  // `server.js`'s dispatch guard it would become a generic 500 whose body is not
  // an OAuth error, and design constraint 2 says a throw on this path is the
  // expensive kind of failure.
  const { route, calls } = harness({
    mint: () => {
      throw new Error("characterId must be a positive integer");
    },
  });

  const response = exchangeCode(route);
  assert.equal(response.status, 500);
  assert.equal(bodyOf(response).error, "server_error");
  assert.ok(calls.log.some((line) => line.includes("minting the access token threw")));
});

// Flattening: the security property

test("every authCodes outcome that is not ok answers invalid_grant", () => {
  // Walked from the store's own enum rather than from a list written here, so an
  // outcome added to `lib/authCodes.js` later cannot quietly leak a
  // distinguishable answer out of this endpoint. RFC 6749 section 5.2 puts all of
  // them under invalid_grant.
  const outcomes = Object.values(REDEEM_OUTCOME).filter((name) => name !== REDEEM_OUTCOME.OK);
  assert.ok(outcomes.length >= 3, "already_used, expired and unknown at least");

  const bodies = new Set();

  // `already_used` is driven twice: once with the bare tombstone, and once
  // carrying the `grant` that replay revocation works from. The second is where
  // this route does the most work on a refusal, calling into the token store and
  // writing three sentences to the log, and it is the case that must not be
  // distinguishable on the wire. A response that moved when a revocation fired
  // would confirm to whoever replayed the code that it had been real and that
  // somebody had used it, the same oracle this test exists to close.
  const drives = [
    ...outcomes.map((outcome) => ({ outcome, record: null, grant: null })),
    {
      outcome: REDEEM_OUTCOME.ALREADY_USED,
      record: null,
      grant: { characterId: CHARACTER_ID, clientId: CLIENT_ID, grantRef: FAMILY },
    },
    { outcome: "an_outcome_invented_next_year", record: null, grant: null },
  ];

  for (const answer of drives) {
    const { route, calls } = harness({ redeem: () => answer });
    const response = exchangeCode(route);

    assert.equal(response.status, 400, `${answer.outcome} is a 400`);
    const body = bodyOf(response);
    assert.equal(body.error, "invalid_grant", `${answer.outcome} answers invalid_grant`);
    assert.equal(body.error_description, INVALID_CODE_DESCRIPTION);

    // The distinction is kept in the log, where an operator can read it.
    assert.ok(
      calls.log.some((line) => line.includes(answer.outcome)),
      `the log distinguishes ${answer.outcome}`,
    );

    bodies.add(response.body);
  }

  // The one that revoked something did so, so the identical bytes below are the
  // interesting kind of identical rather than the trivial kind.
  const revoking = harness({
    redeem: () => ({
      outcome: REDEEM_OUTCOME.ALREADY_USED,
      record: null,
      grant: { characterId: CHARACTER_ID, clientId: CLIENT_ID, grantRef: FAMILY },
    }),
  });
  bodies.add(exchangeCode(revoking.route).body);
  assert.equal(revoking.calls.revokeFamily.length, 1);

  // Byte identity across every one of them. A description that varied per
  // outcome would be the same oracle under a different member name.
  assert.equal(bodies.size, 1, "every refusal about a code is the same bytes");

  // The headers are the same too, so the oracle cannot move out of the body into
  // a member the test above does not read.
  const statuses = new Set();
  const headers = new Set();
  for (const answer of drives) {
    const response = exchangeCode(harness({ redeem: () => answer }).route);
    statuses.add(response.status);
    headers.add(JSON.stringify(response.headers));
  }
  assert.equal(statuses.size, 1, "every refusal about a code is the same status");
  assert.equal(headers.size, 1, "every refusal about a code carries the same headers");
});

test("a code for another client, and a mismatched redirect_uri, answer the same bytes", () => {
  const wrongClient = harness({ record: { clientId: OTHER_CLIENT_ID } });
  const one = exchangeCode(wrongClient.route);
  assert.equal(one.status, 400);
  assert.equal(bodyOf(one).error, "invalid_grant");
  assert.equal(bodyOf(one).error_description, INVALID_CODE_DESCRIPTION);
  // RFC 6749 section 4.1.3, and the log says which of the two it was.
  assert.ok(wrongClient.calls.log.some((line) => line.includes(OTHER_CLIENT_ID)));

  const wrongRedirect = harness();
  const two = exchangeCode(wrongRedirect.route, { redirect_uri: "http://127.0.0.1:9/evil" });
  assert.equal(two.status, 400);
  assert.equal(bodyOf(two).error_description, INVALID_CODE_DESCRIPTION);

  // An omitted redirect_uri is accepted: CCP's documented request does not carry
  // one, and refusing would break every client written against it.
  const omitted = harness();
  assert.equal(exchangeCode(omitted.route, { redirect_uri: null }).status, 200);

  // A matching one is accepted too.
  const matching = harness();
  assert.equal(exchangeCode(matching.route, { redirect_uri: REDIRECT_URI }).status, 200);
});

// The replay, and the revocation it triggers
//
// One helper, because every test below differs only in what the code store
// remembers about the spent code.

/** A route whose `redeem` answers `already_used` carrying `grant`. */
function replayHarness(grant, options = {}) {
  return harness({
    ...options,
    redeem: () => ({ outcome: REDEEM_OUTCOME.ALREADY_USED, record: null, grant }),
  });
}

/** The alarm line, which every branch must produce exactly one of. */
function alarmOf(calls) {
  const found = calls.log.filter((line) => line.includes("AUTHORIZATION CODE REPLAY"));
  assert.equal(found.length, 1, "a replay is unmissable in a grep, and says one thing");
  return found[0];
}

test("a code replay revokes the family the code minted, and says so", () => {
  // RFC 6749 section 4.1.2's revocation, which this route could not perform
  // until `redeem` started answering a replay with a `grant` and the token store
  // grew `revokeFamily`. The assertion that matters is the argument: the exact
  // string the token store minted, not a shape that looks like one.
  const { route, calls } = replayHarness({
    characterId: CHARACTER_ID,
    clientId: CLIENT_ID,
    grantRef: FAMILY,
  });

  const response = exchangeCode(route);
  assert.equal(bodyOf(response).error, "invalid_grant");
  assert.equal(bodyOf(response).error_description, INVALID_CODE_DESCRIPTION);

  assert.equal(calls.revokeFamily.length, 1, "exactly one family, exactly once");
  assert.equal(calls.revokeFamily[0].family, FAMILY);

  // The store logs its own line about what it retired, so this one carries a
  // reason for whoever reads the two together.
  assert.equal(typeof calls.revokeFamily[0].request.reason, "string");

  const alarm = alarmOf(calls);
  assert.ok(alarm.includes(FAMILY), "the alarm names the family it killed");
  assert.ok(alarm.includes("revoked"), "and says the revocation happened");

  // The honest half: the access token minted from that code is stateless and
  // outlives the grant. An alarm that read as though the incident were closed
  // would be worse than no alarm.
  assert.ok(alarm.includes(ACCESS_TOKEN_STILL_LIVE), "and what is still exposed");

  // Nothing was issued or minted on a refusal, revocation or not.
  assert.equal(calls.issue.length, 0);
  assert.equal(calls.mint.length, 0);
});

test("a replay by a client the code was never minted for revokes nothing", () => {
  // The narrowness argument at its sharpest. `mayRedeem` and `verifyPkce` are
  // both below this branch, so a sniffed code plus a public `client_id` reaches
  // it; if that were enough to revoke, anybody who watched one code go by could
  // retire a third party's grants. So the mismatch is logged and nothing else.
  const { route, calls } = replayHarness({
    characterId: CHARACTER_ID,
    clientId: OTHER_CLIENT_ID,
    grantRef: FAMILY,
  });

  const response = exchangeCode(route);
  assert.equal(bodyOf(response).error, "invalid_grant");
  assert.equal(bodyOf(response).error_description, INVALID_CODE_DESCRIPTION);

  assert.equal(calls.revokeFamily.length, 0, "another client's grant is not this route's to kill");

  const alarm = alarmOf(calls);
  assert.ok(alarm.includes(OTHER_CLIENT_ID), "the alarm names the client the code belonged to");
  assert.ok(alarm.includes("NOTHING was revoked"), "and is explicit that it did not act");
});

test("a replay whose grant lost its link revokes nothing and names the remedy", () => {
  // `grantRef: null` is the ordinary state after a restart: `lib/authCodes.js` is
  // in memory, so the binding this process would have made never happened. The
  // store distinguishes it from `grant: null` deliberately, and the log keeps the
  // two apart for the same reason.
  const lost = replayHarness({
    characterId: CHARACTER_ID,
    clientId: CLIENT_ID,
    grantRef: null,
  });
  assert.equal(bodyOf(exchangeCode(lost.route)).error, "invalid_grant");
  assert.equal(lost.calls.revokeFamily.length, 0, "there is no family to name");

  const alarm = alarmOf(lost.calls);
  assert.ok(alarm.includes("restart"), "the alarm says why the link is gone");
  assert.ok(alarm.includes("/v2/oauth/revoke"), "and what an operator can do by hand instead");
  assert.ok(alarm.includes(ACCESS_TOKEN_STILL_LIVE));

  // A tombstone with no grant at all is the other story, and gets its own line
  // rather than being folded into this one.
  const nothing = replayHarness(null);
  assert.equal(bodyOf(exchangeCode(nothing.route)).error, "invalid_grant");
  assert.equal(nothing.calls.revokeFamily.length, 0);
  assert.ok(alarmOf(nothing.calls).includes("no grant"));

  // A store that answers with the old shape, or a double that answers with none,
  // must not throw on this path.
  const legacy = harness({
    redeem: () => ({ outcome: REDEEM_OUTCOME.ALREADY_USED, record: null }),
  });
  assert.equal(bodyOf(exchangeCode(legacy.route)).error, "invalid_grant");
  assert.equal(legacy.calls.revokeFamily.length, 0);
});

test("a revokeFamily that retires nothing, or cannot be written, is the same bytes", () => {
  // `unknown` is the ordinary answer after a restart and `persist_failed` is a
  // disk that would not take the write. Neither merits a different response,
  // because a caller who could tell them apart could tell that the code had been
  // real. Both merit a different log line.
  const bodies = new Set();

  for (const outcome of [REVOKE_OUTCOME.UNKNOWN, REVOKE_OUTCOME.PERSIST_FAILED]) {
    const { route, calls } = replayHarness(
      { characterId: CHARACTER_ID, clientId: CLIENT_ID, grantRef: FAMILY },
      { revokeFamily: () => ({ outcome, records: [] }) },
    );

    const response = exchangeCode(route);
    assert.equal(response.status, 400);
    assert.equal(bodyOf(response).error, "invalid_grant");
    bodies.add(response.body);

    const alarm = alarmOf(calls);
    assert.ok(alarm.includes(outcome), `the alarm reports ${outcome} as it came back`);
    assert.ok(alarm.includes("/v2/oauth/revoke"), "and points at the manual remedy");
  }

  // Against the successful revocation, and against a plain unknown code.
  const revoked = replayHarness({
    characterId: CHARACTER_ID,
    clientId: CLIENT_ID,
    grantRef: FAMILY,
  });
  bodies.add(exchangeCode(revoked.route).body);
  bodies.add(exchangeCode(harness({
    redeem: () => ({ outcome: REDEEM_OUTCOME.UNKNOWN, record: null, grant: null }),
  }).route).body);

  assert.equal(bodies.size, 1, "a revocation cannot be observed from the response");
});

test("a revokeFamily that throws is contained, and the refusal is unchanged", () => {
  // `lib/refreshTokens.js` promises it does not throw. It is caught anyway for
  // the reason the access token minter is: this is the request path, eve.js
  // treats an unhandled rejection as fatal, and a replay of a stolen code must
  // never be a way to take the universe down with it.
  const { route, calls } = replayHarness(
    { characterId: CHARACTER_ID, clientId: CLIENT_ID, grantRef: FAMILY },
    {
      revokeFamily: () => {
        throw new Error("the refresh token store exploded");
      },
    },
  );

  const response = exchangeCode(route);
  assert.equal(response.status, 400, "not a 500, and not an escaped throw");
  assert.equal(bodyOf(response).error, "invalid_grant");
  assert.equal(bodyOf(response).error_description, INVALID_CODE_DESCRIPTION);

  // Byte-identical to the same refusal with no revocation attempted at all.
  const quiet = harness({
    redeem: () => ({ outcome: REDEEM_OUTCOME.EXPIRED, record: null, grant: null }),
  });
  assert.equal(response.body, exchangeCode(quiet.route).body);

  const alarm = alarmOf(calls);
  assert.ok(alarm.includes("threw"), "the alarm says the store threw");
  assert.ok(alarm.includes("exploded"), "and carries the message");
});

test("a successful exchange binds the issued family to the code it came from", () => {
  // The other half of the replay revocation. The route mints no identifier of its
  // own: what it binds is the `family` the token store just wrote, against the
  // `code` the request presented.
  const { route, calls } = harness();
  assert.equal(exchangeCode(route).status, 200);

  assert.deepEqual(calls.rememberGrant, [{ code: CODE, grantRef: FAMILY }]);

  // The order explains why the binding is where it is: issue, then bind, then
  // mint. The grant is live from the moment `issue` returns, so that is the
  // moment it has to become revocable; binding after the mint would leave a grant
  // that a failed mint made unrevocable forever.
  const order = [];
  const ordered = harness({
    issue: () => {
      order.push("issue");
      return { token: GNARLY_REFRESH_TOKEN, record: { family: FAMILY } };
    },
    rememberGrant: () => {
      order.push("bind");
      return true;
    },
    mint: () => {
      order.push("mint");
      return { token: "eyJhbGciOiJSUzI1NiJ9.payload.signature", expiresIn: 1200 };
    },
  });

  assert.equal(exchangeCode(ordered.route).status, 200);
  assert.deepEqual(order, ["issue", "bind", "mint"]);
});

test("a grant is bound even when the access token mint then fails", () => {
  // The case the ordering exists for. The caller gets a 500 and no tokens, and
  // the refresh grant is live in the store regardless, so a later replay of that
  // code must still be able to name it.
  const { route, calls } = harness({
    mint: () => {
      throw new Error("the signing key is gone");
    },
  });

  assert.equal(exchangeCode(route).status, 500);
  assert.deepEqual(calls.rememberGrant, [{ code: CODE, grantRef: FAMILY }]);
});

test("nothing is bound when no refresh token could be issued", () => {
  // Nothing was created, so there is nothing to make revocable, and a tombstone
  // pointing at a family that does not exist would ask a future replay to revoke
  // nothing and report it as a failure.
  const { route, calls } = harness({ issue: () => ({ token: null, failure: "at_capacity" }) });

  assert.equal(exchangeCode(route).status, 500);
  assert.equal(calls.rememberGrant.length, 0);
});

test("a refresh never binds anything, because it never issues a grant", () => {
  // `issueAndMint` is shared, and the refresh path presents its own token and
  // skips the issue block entirely. `bindGrant` is supplied only by the
  // authorization-code path, which makes this unreachable rather than merely
  // avoided.
  const { route, calls } = harness();
  assert.equal(refresh(route).status, 200);

  assert.equal(calls.rememberGrant.length, 0);
  assert.equal(calls.issue.length, 0);
  assert.equal(calls.revokeFamily.length, 0);
});

test("a rememberGrant that misses is logged and changes nothing the caller sees", () => {
  // `rememberGrant` returns `false` for every way it can miss and never throws. A
  // miss is not an error: the exchange succeeded and the caller gets its tokens.
  // What it costs is a future replay of that code, which will still be refused
  // and will have nothing to revoke, so it merits a line.
  const { route, calls } = harness({ rememberGrant: () => false });

  const response = exchangeCode(route);
  assert.equal(response.status, 200, "a lost binding is not a failed login");
  assert.equal(bodyOf(response).refresh_token, GNARLY_REFRESH_TOKEN);

  assert.ok(
    calls.log.some((line) => line.includes("could not be bound")),
    "and the operator is told when the link was lost",
  );

  // Byte-identical to the exchange where the binding took.
  assert.equal(response.body, exchangeCode(harness().route).body);
});

test("a store that issues without a family binds nothing and says so", () => {
  // The route hands over whatever the store wrote and lets `rememberGrant`
  // refuse it, rather than holding a second opinion about the token store's own
  // field. What must not happen is a throw.
  for (const family of [undefined, null, "", 7]) {
    const { route, calls } = harness({
      issue: () => ({ token: GNARLY_REFRESH_TOKEN, record: { family } }),
      rememberGrant: () => false,
    });

    assert.equal(exchangeCode(route).status, 200, `family ${String(family)} is not a 500`);
    assert.deepEqual(calls.rememberGrant, [{ code: CODE, grantRef: family }]);
    assert.ok(calls.log.some((line) => line.includes("could not be bound")));
  }

  // A store that answers `issue` with no record at all.
  const { route, calls } = harness({
    issue: () => ({ token: GNARLY_REFRESH_TOKEN }),
    rememberGrant: () => false,
  });
  assert.equal(exchangeCode(route).status, 200);
  assert.deepEqual(calls.rememberGrant, [{ code: CODE, grantRef: undefined }]);
});

test("every refreshTokens outcome except ok and scope_not_subset answers invalid_grant", () => {
  const outcomes = Object.values(REFRESH_OUTCOME).filter(
    (name) => name !== REFRESH_OUTCOME.OK && name !== REFRESH_OUTCOME.SCOPE_NOT_SUBSET,
  );
  assert.ok(outcomes.length >= 3, "revoked, superseded and unknown at least");

  const bodies = new Set();

  for (const outcome of [...outcomes, "an_outcome_invented_next_year"]) {
    const { route, calls } = harness({ refresh: () => ({ outcome, record: null }) });
    const response = refresh(route);

    assert.equal(response.status, 400, `${outcome} is a 400`);
    assert.equal(bodyOf(response).error, "invalid_grant", `${outcome} answers invalid_grant`);
    assert.ok(calls.log.some((line) => line.includes(outcome)));
    bodies.add(response.body);
  }

  assert.equal(bodies.size, 1, "every refusal about a refresh token is the same bytes");
});

test("scope_not_subset is invalid_scope, because it is a fault in the request", () => {
  // `lib/refreshTokens.js` keeps this outcome distinct so that the route can draw
  // the line, and D30 says a non-subset is a refusal rather than a silent
  // intersection. It is not an oracle: the caller already holds the token and
  // learns only something about the list they just typed.
  const { route } = harness({
    refresh: () => ({ outcome: REFRESH_OUTCOME.SCOPE_NOT_SUBSET, record: null }),
  });

  const response = refresh(route, { scope: "esi-wallet.read_character_wallet.v1" });
  assert.equal(response.status, 400);
  assert.equal(bodyOf(response).error, "invalid_scope");
});

test("a refresh token granted to another client answers invalid_grant", () => {
  const { route, calls } = harness({ grant: { clientId: OTHER_CLIENT_ID } });
  const response = refresh(route);

  assert.equal(response.status, 400);
  assert.equal(bodyOf(response).error, "invalid_grant");
  assert.equal(calls.mint.length, 0);
});

// The PKCE invariant `routes/oauthAuthorize.js` hands over

test("mayRedeem is asked, with the arguments the invariant is stated in", () => {
  const { route, calls } = harness();
  exchangeCode(route);

  assert.deepEqual(calls.mayRedeem, [
    { authenticated: true, codeChallenge: CHALLENGE, codeVerifier: VERIFIER },
  ]);

  // The no-PKCE case reaches it as an explicit null, which is what `parsePkce`
  // stores so that "no PKCE" is distinguishable from "a challenge I failed to
  // read".
  const noPkce = harness({ record: { codeChallenge: null, codeChallengeMethod: null } });
  exchangeCode(noPkce.route, { code_verifier: null });
  assert.deepEqual(noPkce.calls.mayRedeem, [
    { authenticated: true, codeChallenge: null, codeVerifier: undefined },
  ]);
  // With no challenge stored, PKCE verification is not attempted at all.
  assert.equal(noPkce.calls.verifyPkce.length, 0);
});

test("mayRedeem's refusal is returned rather than swallowed", () => {
  // The downgrade this closes: a public client redeeming a code that was minted
  // with no challenge. If it ever succeeds, a network attacker gets PKCE removal
  // for free by stripping two query parameters at the authorize endpoint.
  const { route, calls } = harness({
    authenticate: () => ({ ok: true, clientId: CLIENT_ID, authenticated: false, method: "none" }),
    mayRedeem: () => ({
      ok: false,
      error: "invalid_grant",
      errorDescription: "This code requires a code_verifier or an authenticated client.",
    }),
  });

  const response = exchangeCode(route);
  assert.equal(response.status, 400);
  const body = bodyOf(response);
  assert.equal(body.error, "invalid_grant");
  // The module that decided the policy also decided what the failure says.
  assert.equal(
    body.error_description,
    "This code requires a code_verifier or an authenticated client.",
  );
  assert.equal(calls.issue.length, 0);
  assert.equal(calls.mint.length, 0);
});

test("verifyPkce gets the stored challenge and the presented verifier, and can refuse", () => {
  const { route, calls } = harness();
  exchangeCode(route);

  assert.deepEqual(calls.verifyPkce, [
    { codeChallenge: CHALLENGE, codeChallengeMethod: "S256", codeVerifier: VERIFIER },
  ]);

  const refused = harness({
    verifyPkce: () => ({
      ok: false,
      error: "invalid_grant",
      errorDescription: "code_verifier does not match the code_challenge.",
    }),
  });
  const response = exchangeCode(refused.route);
  assert.equal(response.status, 400);
  assert.equal(
    bodyOf(response).error_description,
    "code_verifier does not match the code_challenge.",
  );
  assert.equal(refused.calls.mint.length, 0);
});

test("a refusal with no error name of its own still parses as an OAuth error", () => {
  const { route } = harness({ mayRedeem: () => ({ ok: false }) });
  const body = bodyOf(exchangeCode(route));
  assert.equal(body.error, "invalid_grant");
  assert.equal(typeof body.error_description, "string");
  assert.notEqual(body.error_description, "");
});

// Scope narrowing on refresh

test("a refresh may narrow, may repeat, and may not widen", () => {
  // A subset succeeds.
  const subset = harness();
  assert.equal(refresh(subset.route, { scope: "publicData" }).status, 200);
  assert.deepEqual(subset.calls.refresh[0].args, { scopes: ["publicData"] });

  // An equal set succeeds.
  const equal = harness();
  assert.equal(refresh(equal.route, { scope: SCOPES.join(" ") }).status, 200);
  assert.deepEqual(equal.calls.refresh[0].args, { scopes: SCOPES });

  // An absent scope is "the same as before" (RFC 6749 section 6), passed through
  // as an empty list rather than turned into a narrowing request for nothing.
  const absent = harness();
  assert.equal(refresh(absent.route, { scope: null }).status, 200);
  assert.deepEqual(absent.calls.refresh[0].args, { scopes: [] });

  // An empty scope= is the same statement spelled differently.
  const empty = harness();
  assert.equal(refresh(empty.route, { scope: "" }).status, 200);
  assert.deepEqual(empty.calls.refresh[0].args, { scopes: [] });

  // A superset is refused, and the store decides that: this route does not
  // compute subsets, it reports the answer.
  const superset = harness({
    refresh: () => ({ outcome: REFRESH_OUTCOME.SCOPE_NOT_SUBSET, record: null }),
  });
  const response = refresh(superset.route, { scope: `${SCOPES.join(" ")} esi-mail.send_mail.v1` });
  assert.equal(response.status, 400);
  assert.equal(bodyOf(response).error, "invalid_scope");
  assert.equal(superset.calls.mint.length, 0);
});

test("the granted scopes reach the minter, not the requested ones", () => {
  // The case that must not be got wrong: the store answers with a set that is not
  // the one in the body. Minting from the request would let a list never checked
  // against the grant decide what the token authorises.
  const granted = ["publicData"];
  const { route, calls } = harness({
    refresh: () => ({
      outcome: REFRESH_OUTCOME.OK,
      record: { clientId: CLIENT_ID, characterId: CHARACTER_ID, scopes: SCOPES },
      scopes: granted,
      scope: granted.join(" "),
    }),
  });

  assert.equal(refresh(route, { scope: SCOPES.join(" ") }).status, 200);
  assert.deepEqual(calls.mint, [
    { characterId: CHARACTER_ID, clientId: CLIENT_ID, scopes: granted },
  ]);
});

test("the code's scope string is split the way parseScope stored it", () => {
  assert.deepEqual(scopesOf("publicData esi-skills.read_skills.v1"), SCOPES);
  assert.deepEqual(scopesOf(""), []);
  assert.deepEqual(scopesOf(undefined), []);
  // Space, and only space: a tab is not an RFC 6749 section 3.3 delimiter, and
  // treating one as a delimiter would turn one scope into two.
  assert.deepEqual(scopesOf("a\tb"), ["a\tb"]);
});

// The `+` and `/` in a refresh token, through a real body

/** A real listener running `server.js`'s own request handler in front of the route. */
async function listenerFor(t, route) {
  const dispatch = createSsoDispatch([route]);
  const server = http.createServer(createRequestHandler({
    dispatch,
    log: () => {},
    logError: () => {},
  }));

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  return `http://127.0.0.1:${server.address().port}`;
}

test("a refresh token containing + and / survives a real form-encoded body", async (t) => {
  // The most likely way a correct implementation fails in the field, and one a
  // test that hands the route a request object it built itself cannot reproduce:
  // `server.js` parses a body as JSON and leaves a form body on `rawBody`
  // untouched, so the decoding is this route's and the `+` is decided by which
  // decoder it picked.
  const { route, calls } = harness();
  const base = await listenerFor(t, route);

  // Encoded the way every OAuth client library encodes a form body: the `+`
  // becomes `%2B` and the `/` becomes `%2F`. The refresh token must be
  // URL-encoded in the request.
  const body = new URLSearchParams({
    grant_type: GRANT_TYPE.REFRESH_TOKEN,
    refresh_token: GNARLY_REFRESH_TOKEN,
  }).toString();
  assert.ok(body.includes("%2B"), "the encoder really did escape the plus");
  assert.ok(body.includes("%2F"), "and the slash");

  const response = await fetch(`${base}${TOKEN_PATH}`, {
    method: "POST",
    headers: { "content-type": REQUEST_CONTENT_TYPE },
    body,
  });

  assert.equal(response.status, 200);
  const parsed = await response.json();

  // The store saw the token exactly as the client holds it...
  assert.equal(calls.refresh[0].token, GNARLY_REFRESH_TOKEN);
  // ...and so does the client, coming back.
  assert.equal(parsed.refresh_token, GNARLY_REFRESH_TOKEN);
  assert.equal(parsed.token_type, "Bearer");

  // The wire spelling of the cache headers, through the listener's own casing
  // layer. Header names are case-insensitive and `lib/headers.js` title-cases
  // every one on the way out, so the lowercase `pragma` in the recorded response
  // leaves as `Pragma`.
  assert.equal(response.headers.get("cache-control"), CACHE_CONTROL);
  assert.equal(response.headers.get("pragma"), PRAGMA);
});

test("a refresh token sent with a raw + is refused, and the log says why", async (t) => {
  // Form decoding reads `+` as a space (RFC 1866), so a client that did not
  // encode its token presents a different string and gets an ordinary
  // invalid_grant. That is what CCP's endpoint does too, and being lenient here
  // would break the space-carrying values that the same encoding rule covers.
  // What this server adds is a log line that names the cause.
  const { route, calls } = harness({
    refresh: (token) => (token === GNARLY_REFRESH_TOKEN
      ? {
        outcome: REFRESH_OUTCOME.OK,
        record: { clientId: CLIENT_ID, characterId: CHARACTER_ID },
        scopes: SCOPES,
        scope: SCOPES.join(" "),
      }
      : { outcome: REFRESH_OUTCOME.UNKNOWN, record: null }),
  });
  const base = await listenerFor(t, route);

  const response = await fetch(`${base}${TOKEN_PATH}`, {
    method: "POST",
    headers: { "content-type": REQUEST_CONTENT_TYPE },
    // Deliberately hand-built: the token's `+` characters are left raw.
    body: `grant_type=${GRANT_TYPE.REFRESH_TOKEN}&refresh_token=${GNARLY_REFRESH_TOKEN}`,
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_grant");

  assert.ok(
    calls.log.some((line) => line.includes("without URL-encoding")),
    "an operator can tell this apart from a genuinely dead token",
  );
  // Nothing of the token itself is written to the log.
  assert.ok(!calls.log.some((line) => line.includes(GNARLY_REFRESH_TOKEN)));
});

test("a repeated parameter is refused rather than resolved by precedence", async (t) => {
  // RFC 6749 section 3.1. `server.js` collapses a repeated query parameter to the
  // last value, which is the right rule for a query string and the wrong one for
  // a token body: `code=stolen&code=mine` is a request where each server in the
  // chain gets to pick a different one.
  const { route, calls } = harness();
  const base = await listenerFor(t, route);

  const response = await fetch(`${base}${TOKEN_PATH}`, {
    method: "POST",
    headers: { "content-type": REQUEST_CONTENT_TYPE },
    body: `grant_type=${GRANT_TYPE.AUTHORIZATION_CODE}&code=stolen&code=mine`,
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "invalid_request");
  assert.ok(body.error_description.includes("code"));
  assert.equal(calls.redeem.length, 0);
});

// Methods, content type, and the shape of a refusal

test("only POST is answered, and the refusal says what to use", () => {
  const { route } = harness();

  for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "PATCH"]) {
    const response = route.handle({
      method,
      pathname: TOKEN_PATH,
      headers: { "content-type": REQUEST_CONTENT_TYPE },
      rawBody: Buffer.alloc(0),
    });

    assert.equal(response.status, 405, `${method} is refused`);
    assert.equal(header(response, "allow"), ALLOWED_METHOD);
    assert.equal(bodyOf(response).error, "invalid_request");
  }

  assert.equal(ALLOWED_METHOD, "POST");
});

test("a wrong or missing content type is refused before anything is redeemed", () => {
  const { route, calls } = harness();

  for (const contentType of ["application/json", "text/plain", "", undefined]) {
    const response = route.handle({
      method: "POST",
      pathname: TOKEN_PATH,
      headers: contentType === undefined ? {} : { "content-type": contentType },
      rawBody: Buffer.from(`grant_type=${GRANT_TYPE.AUTHORIZATION_CODE}&code=${CODE}`),
    });

    assert.equal(response.status, 400);
    assert.equal(bodyOf(response).error, "invalid_request");
  }

  // Nothing was consumed and nobody was authenticated.
  assert.equal(calls.redeem.length, 0);
  assert.equal(calls.authenticate.length, 0);

  // A charset parameter is the same request, not a different one.
  const withCharset = harness();
  const ok = withCharset.route.handle({
    method: "POST",
    pathname: TOKEN_PATH,
    headers: { "content-type": `${REQUEST_CONTENT_TYPE}; charset=UTF-8` },
    rawBody: Buffer.from(new URLSearchParams({
      grant_type: GRANT_TYPE.AUTHORIZATION_CODE,
      code: CODE,
      code_verifier: VERIFIER,
    }).toString()),
  });
  assert.equal(ok.status, 200);
});

test("an oversized body is refused before it is parsed", () => {
  const { route, calls } = harness();
  const response = route.handle({
    method: "POST",
    pathname: TOKEN_PATH,
    headers: { "content-type": REQUEST_CONTENT_TYPE },
    rawBody: Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, 0x61),
  });

  assert.equal(response.status, 400);
  assert.equal(bodyOf(response).error, "invalid_request");
  assert.equal(calls.authenticate.length, 0);
});

test("every response carries the two recorded cache directives and bare application/json", () => {
  const { route } = harness();

  const responses = [
    exchangeCode(route),
    refresh(route),
    post(route, { grant_type: "client_credentials" }),
    route.handle({ method: "GET", pathname: TOKEN_PATH, headers: {}, rawBody: Buffer.alloc(0) }),
  ];

  for (const response of responses) {
    // A response carrying two bearer credentials, and a refusal that must not
    // outlive the mistake that caused it.
    assert.equal(header(response, "cache-control"), "no-store,no-cache");
    assert.equal(header(response, "pragma"), "no-cache");
    assert.equal(header(response, "content-type"), CONTENT_TYPE_JSON);
    assert.equal(CONTENT_TYPE_JSON, "application/json");
  }
});

test("grant_type is required, and an unknown one is unsupported_grant_type", () => {
  const { route, calls } = harness();

  assert.equal(bodyOf(post(route, {})).error, "invalid_request");

  const unimplemented = [
    "client_credentials",
    "password",
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  ];

  for (const grantType of unimplemented) {
    const response = post(route, { grant_type: grantType });
    assert.equal(response.status, 400);
    assert.equal(bodyOf(response).error, "unsupported_grant_type");
    // The grant type is attacker-chosen text and is not echoed back.
    assert.ok(!response.body.includes(grantType));
  }

  assert.equal(calls.redeem.length, 0);
});

test("a missing code or refresh_token is invalid_request, not invalid_grant", () => {
  const one = harness();
  const missingCode = post(one.route, { grant_type: GRANT_TYPE.AUTHORIZATION_CODE });
  assert.equal(missingCode.status, 400);
  assert.equal(bodyOf(missingCode).error, "invalid_request");
  assert.equal(one.calls.redeem.length, 0);

  const two = harness();
  const missingToken = post(two.route, { grant_type: GRANT_TYPE.REFRESH_TOKEN });
  assert.equal(bodyOf(missingToken).error, "invalid_request");
  assert.equal(two.calls.refresh.length, 0);
});

// The invalid_client status split

test("invalid_client is 401 with a challenge when the Authorization header was used", () => {
  // RFC 6749 section 5.2: a client that attempted to authenticate via the
  // Authorization header gets 401 plus WWW-Authenticate; anything else gets 400.
  // An HTTP stack below the OAuth client acts on the distinction.
  const refuse = () => ({
    ok: false,
    error: "invalid_client",
    errorDescription: "That client id and secret are not a pair this server knows.",
  });

  const viaHeader = harness({ authenticate: refuse });
  const challenged = exchangeCode(viaHeader.route, {}, {
    headers: { authorization: "Basic dXNlcjpwYXNz" },
  });
  assert.equal(challenged.status, 401);
  assert.equal(header(challenged, "www-authenticate"), WWW_AUTHENTICATE);
  assert.equal(bodyOf(challenged).error, "invalid_client");

  const viaBody = harness({ authenticate: refuse });
  const plain = exchangeCode(viaBody.route, { client_id: CLIENT_ID, client_secret: "nope" });
  assert.equal(plain.status, 400);
  assert.equal(header(plain, "www-authenticate"), undefined);
  assert.equal(bodyOf(plain).error, "invalid_client");

  // The challenge names Basic rather than echoing the scheme the client sent:
  // echoing it would put attacker-chosen text in a response header.
  const oddScheme = harness({ authenticate: refuse });
  const odd = exchangeCode(oddScheme.route, {}, {
    headers: { authorization: "Weird-Scheme \r\nX-Injected: yes" },
  });
  assert.equal(header(odd, "www-authenticate"), WWW_AUTHENTICATE);
  assert.ok(WWW_AUTHENTICATE.startsWith("Basic "));
});

test("an authentication failure that is not invalid_client stays a 400", () => {
  const { route } = harness({
    authenticate: () => ({
      ok: false,
      error: "invalid_request",
      errorDescription: "The Authorization header is not valid Basic credentials.",
    }),
  });

  const response = exchangeCode(route, {}, { headers: { authorization: "Basic %%%" } });
  assert.equal(response.status, 400);
  assert.equal(header(response, "www-authenticate"), undefined);
  assert.equal(bodyOf(response).error, "invalid_request");
});

test("nothing is redeemed until the client has been authenticated", () => {
  // `redeem` is destructive. A route that redeemed first would let anyone holding
  // a code (a listener on D1's plain HTTP) burn the honest client's code without
  // knowing the secret or the verifier.
  const { route, calls } = harness({
    authenticate: () => ({ ok: false, error: "invalid_client", errorDescription: "no" }),
  });

  exchangeCode(route);
  assert.equal(calls.redeem.length, 0);
  assert.equal(calls.refresh.length, 0);
  assert.equal(calls.issue.length, 0);
  assert.equal(calls.mint.length, 0);
});

test("the public client the EVE client actually is can refresh", () => {
  // `docs/d6-listener-split.md`: the EVE client "refreshes with `client_id` in the
  // body and no secret". An unauthenticated caller on the refresh grant is the
  // ordinary case, not the suspicious one.
  const { route, calls } = harness({
    authenticate: () => ({ ok: true, clientId: CLIENT_ID, authenticated: false, method: "none" }),
  });

  const response = refresh(route, { client_id: CLIENT_ID });
  assert.equal(response.status, 200);
  assert.equal(bodyOf(response).refresh_token, GNARLY_REFRESH_TOKEN);

  // The body reached the authenticator as a plain object, prototype-less so that
  // a `__proto__=` field is a property rather than a prototype write.
  const seen = calls.authenticate[0].body;
  assert.equal(seen.client_id, CLIENT_ID);
  assert.equal(Object.getPrototypeOf(seen), null);
});

test("a body carrying __proto__ cannot make an unset field appear to have a value", () => {
  // Written as raw bytes rather than as an object literal on purpose: in a
  // literal, `__proto__:` is the prototype setter and never becomes a property,
  // so a test that built the body that way would not send the field at all.
  const { route, calls } = harness();
  post(route, {}, {
    rawBody: `grant_type=${GRANT_TYPE.REFRESH_TOKEN}`
      + `&refresh_token=${encodeURIComponent(GNARLY_REFRESH_TOKEN)}`
      + "&__proto__=" + encodeURIComponent('{"client_secret":"polluted"}'),
  });

  const seen = calls.authenticate[0].body;
  assert.equal(Object.getPrototypeOf(seen), null);
  // The field arrived as an ordinary own property...
  assert.equal(seen.__proto__, '{"client_secret":"polluted"}');
  // ...and nothing it could name is inherited by anything.
  assert.equal(seen.client_secret, undefined);
  assert.equal(({}).client_secret, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

// Construction

test("a missing dependency fails at construction, naming what to inject", () => {
  const { deps } = harness();

  // `rememberGrant` and `revokeFamily` are on this list rather than being
  // feature-detected, deliberately: a store without them would degrade silently
  // to a replay refused with its tokens left live. The route fails at boot
  // naming the method instead.
  for (const [name, method] of [
    ["clientAuth", "authenticate"],
    ["clientAuth", "verifyPkce"],
    ["clientAuth", "mayRedeem"],
    ["authCodes", "redeem"],
    ["authCodes", "rememberGrant"],
    ["refreshTokens", "issue"],
    ["refreshTokens", "refresh"],
    ["refreshTokens", "revokeFamily"],
  ]) {
    const broken = { ...deps, [name]: { ...deps[name], [method]: undefined } };
    assert.throws(
      () => createOauthTokenRoute(broken),
      new RegExp(`${name}\\.${method}`),
      `${name}.${method} is checked at construction`,
    );
  }

  assert.throws(
    () => createOauthTokenRoute({ ...deps, mintAccessToken: undefined }),
    /mintAccessToken/,
  );
  assert.throws(() => createOauthTokenRoute(), /createOauthTokenRoute needs/);
});

test("the route is frozen, named, and mounted at one exact path", () => {
  const { route } = harness();
  assert.equal(Object.isFrozen(route), true);
  assert.equal(typeof route.name, "string");
  assert.notEqual(route.name, "");
  assert.equal(Object.isFrozen(route.paths), true);
  assert.deepEqual(route.paths, [TOKEN_PATH]);
  assert.equal(typeof route.handle, "function");
});
