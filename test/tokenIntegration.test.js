/**
 * The whole sign-in, composed from the real modules.
 *
 * Run with:  node --test "test/**\/*.test.js"   (from the mod directory, or RunTests.bat)
 *
 * Every other suite on this surface drives one module against doubles. A double
 * agrees with whatever its author believed the neighbour returned, so two
 * modules can each be correct against a belief the other does not hold.
 * `lib/bindFlow.js` exists because `lib/pendingBinds.js` spells it
 * `characterID` and `routes/oauthAuthorize.js` reads `characterId`, and only a
 * composition catches that.
 *
 * So this file uses no doubles for the mod's own modules. It builds the real
 * registry, code store and refresh store (on a real temp directory), a real RSA
 * key, a real salt, the real minter, and the real authorize and token routes,
 * and walks a client through the flow a third-party tool performs:
 *
 *   authorize  ->  302 with ?code=      (dev auto-approve standing in for the
 *                                        human who would type a bind code)
 *   token      ->  the JWT pair
 *   jwks       ->  the key that verifies it
 *   refresh    ->  a second access token from the same grant
 *
 * The one stub is the character lookup, because it needs a running game:
 * `loader.js` supplies a `mintAccessToken` that reads `characterName` and
 * `accountId` off the game's own character record. The stub returns the shape
 * that record has, and `test/runtimeAccess.test.js` checks against a real
 * vendor tree that the game still produces that shape.
 *
 * No listener and no socket: the routes are driven through `lib/ssoDispatch.js`
 * as `server.js` would, because what is under test is the agreement between
 * modules, not the HTTP layer that `test/ssoListener.test.js` covers over a
 * real port.
 */

"use strict";

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createSsoDispatch } = require(path.join(__dirname, "../lib/ssoDispatch"));
const { createClientRegistry } = require(path.join(__dirname, "../lib/clientRegistry"));
const { createClientAuthenticator } = require(path.join(__dirname, "../lib/clientAuth"));
const { createAuthCodeStore } = require(path.join(__dirname, "../lib/authCodes"));
const { createRefreshTokenStore } = require(path.join(__dirname, "../lib/refreshTokens"));
const { createAccessTokenMinter } = require(path.join(__dirname, "../lib/accessToken"));
const { loadOrCreateSigningKey, signingJwks } = require(path.join(__dirname, "../lib/signingKey"));
const { loadOrCreateOwnerSalt } = require(path.join(__dirname, "../lib/ownerSalt"));
const { createOauthAuthorizeRoute } = require(path.join(__dirname, "../routes/oauthAuthorize"));
const { createOauthTokenRoute } = require(path.join(__dirname, "../routes/oauthToken"));
const { createOauthJwksRoute } = require(path.join(__dirname, "../routes/oauthJwks"));
const { createOauthVerifyRoute } = require(path.join(__dirname, "../routes/oauthVerify"));
const { createOauthRevokeRoute } = require(path.join(__dirname, "../routes/oauthRevoke"));
const { createBearerVerifier } = require(path.join(__dirname, "../lib/bearerToken"));

const ISSUER = "http://127.0.0.1:26006";
const CLIENT_ID = "1a2b3c4d5e6f";
const CLIENT_SECRET = "0123456789abcdef0123456789abcdef";
const REDIRECT_URI = "http://127.0.0.1:53817/callback";
const CHARACTER_ID = 90000001;
const CHARACTER_NAME = "Some Bloke";
const ACCOUNT_ID = 42;

// RFC 7636's own worked example, so the challenge is not computed with the
// code under test.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      // The operating system's problem, not a test failure.
    }
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esi-mod-token-flow-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Everything `loader.js` builds for the SSO listener, built the same way.
 *
 * Mirrors `startSsoListener`'s construction order and its choice of which
 * instances are shared: one `authCodes` and one `clientRegistry` across both
 * routes, because a code minted against one store and redeemed against another
 * is never found.
 */
function buildSurface({ devAutoApprove = true, clientSecret = CLIENT_SECRET } = {}) {
  const dir = tempDir();
  const logLines = [];
  const log = (line) => logLines.push(line);

  const signingKey = loadOrCreateSigningKey({ keyPath: path.join(dir, "signing-key.pem") });
  const ownerSalt = loadOrCreateOwnerSalt({ saltPath: path.join(dir, "owner-salt.txt") });

  const refreshTokens = createRefreshTokenStore({
    storePath: path.join(dir, "refresh-tokens.jsonl"),
    now: () => Date.now(),
  });

  const clients = [{
    clientId: CLIENT_ID,
    redirectUris: [REDIRECT_URI],
    ...(clientSecret ? { clientSecret } : {}),
  }];

  const clientRegistry = createClientRegistry({ clients });
  const authCodes = createAuthCodeStore({ now: () => Date.now() });

  const accessTokens = createAccessTokenMinter({
    signingKey,
    issuer: ISSUER,
    ownerSalt: ownerSalt.salt,
    now: () => Date.now(),
  });

  // The one stub, returning what `loader.js` projects out of the game's
  // character record: `characterName` and `accountId`, the two fields
  // `test/runtimeAccess.test.js` checks against a real vendor tree.
  const mintAccessToken = ({ characterId, clientId, scopes }) => accessTokens.mint({
    characterId,
    characterName: CHARACTER_NAME,
    clientId,
    scopes,
    ownerInputs: { accountId: ACCOUNT_ID },
  });

  const dispatch = createSsoDispatch([
    createOauthJwksRoute({ getJwks: () => signingJwks(signingKey) }),
    createOauthAuthorizeRoute({
      clientRegistry,
      authCodes,
      bindFlow: {
        mint: () => ({ code: "AAAA2345", expiresAt: Date.now() + 900_000 }),
        peek: () => ({ state: "pending" }),
      },
      devAutoApprove: { enabled: devAutoApprove, characterID: CHARACTER_ID },
      now: () => Date.now(),
      log,
    }),
    createOauthTokenRoute({
      clientAuth: createClientAuthenticator({ registry: clientRegistry }),
      authCodes,
      refreshTokens,
      mintAccessToken,
      now: () => Date.now(),
      log,
    }),
    createOauthVerifyRoute({
      bearer: createBearerVerifier({ signingKey, issuer: ISSUER, now: () => Date.now() }),
      now: () => Date.now(),
      log,
    }),
    createOauthRevokeRoute({
      clientAuth: createClientAuthenticator({ registry: clientRegistry }),
      refreshTokens,
      log,
    }),
  ]);

  return { dispatch, signingKey, refreshTokens, logLines, dir };
}

/** A `GET`, in the shape `server.js`'s `parseRequest` produces. */
function get(pathname, query = {}) {
  return {
    method: "GET",
    pathname,
    query,
    headers: {},
    body: null,
    rawBody: Buffer.alloc(0),
  };
}

/**
 * A form `POST`, in the shape `server.js` really produces.
 *
 * `body` is `null` and the bytes are on `rawBody`: `parseJsonBody` tries
 * `JSON.parse` and answers `null` for anything else, so form decoding belongs
 * to `routes/oauthToken.js`. Encoding through `URLSearchParams` puts a real
 * `%2B` in a refresh token and a real `+` where a scope list has a space.
 */
function postForm(pathname, fields, headers = {}) {
  const encoded = new URLSearchParams(fields).toString();
  return {
    method: "POST",
    pathname,
    query: {},
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: null,
    rawBody: Buffer.from(encoded, "utf8"),
  };
}

function basicHeader(id, secret) {
  const encoded = Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`, "utf8");
  return { authorization: `Basic ${encoded.toString("base64")}` };
}

/** Drive the authorize endpoint with auto-approve and take the code off the redirect. */
async function authorizeForCode(dispatch, extra = {}) {
  const query = {
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "publicData esi-skills.read_skills.v1",
    state: "opaque state/with+chars&=",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...extra,
  };

  // An `undefined` in the override means omit the parameter, not send the
  // word. Spreading it leaves the key present, and a route reading a present key
  // sees a value where the client would have sent nothing, which is a different
  // request.
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) delete query[key];
  }

  const answer = await dispatch(get("/v2/oauth/authorize", query));

  assert.equal(answer.status, 302, `expected a redirect, got ${answer.status}: ${answer.body}`);
  const location = new URL(answer.headers.location);
  assert.equal(location.searchParams.get("error"), null, location.search);

  return { code: location.searchParams.get("code"), location };
}

/** Verify a JWT against the JWKS this same surface publishes, the way a library does. */
async function verifyAgainstJwks(dispatch, token) {
  const served = await dispatch(get("/oauth/jwks"));
  assert.equal(served.status, 200);
  const { keys } = JSON.parse(served.body);

  const [headerPart, payloadPart, signaturePart] = token.split(".");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));

  // Selected by `kid`, which is what every JOSE library does and what makes the
  // pinned literal load-bearing.
  const jwk = keys.find((candidate) => candidate.kid === header.kid);
  assert.ok(jwk, `no published key carries kid ${JSON.stringify(header.kid)}`);

  const verified = crypto.verify(
    "sha256",
    Buffer.from(`${headerPart}.${payloadPart}`, "utf8"),
    crypto.createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(signaturePart, "base64url"),
  );
  assert.equal(verified, true, "the published key did not verify the token it signed");

  return JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
}

// The public-client flow: PKCE, no secret

test("a public client walks authorize to token to a verified JWT", async () => {
  const { dispatch } = buildSurface();
  const { code } = await authorizeForCode(dispatch);
  assert.equal(typeof code, "string");

  const answer = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }));

  assert.equal(answer.status, 200, answer.body);

  // The bytes CCP sends, and the two clients string-compare.
  assert.equal(answer.headers["cache-control"], "no-store,no-cache");
  assert.equal(answer.headers.pragma, "no-cache");

  const payload = JSON.parse(answer.body);
  assert.equal(payload.token_type, "Bearer");
  assert.ok(payload.expires_in >= 1199 && payload.expires_in <= 1200, String(payload.expires_in));

  // The EVE client treats either being empty as an error, so neither may be.
  assert.equal(typeof payload.access_token, "string");
  assert.notEqual(payload.access_token, "");
  assert.equal(typeof payload.refresh_token, "string");
  assert.notEqual(payload.refresh_token, "");

  const claims = await verifyAgainstJwks(dispatch, payload.access_token);

  // Token shape pitfalls, reached through the whole flow rather than from a
  // fixture.
  assert.equal(claims.sub, `CHARACTER:EVE:${CHARACTER_ID}`);
  assert.deepEqual(claims.aud, [CLIENT_ID, "EVE Online"]);
  assert.equal(claims.iss, ISSUER);
  assert.equal(claims.azp, CLIENT_ID);
  assert.equal(claims.tenant, "tranquility");
  assert.ok(Array.isArray(claims.scp), "scp must be an array even at one scope");
  assert.equal(claims.exp - claims.iat, 1200);
  assert.equal(claims.name, CHARACTER_NAME);

  // The scopes the code was granted, carried the whole way.
  assert.deepEqual([...claims.scp].sort(), ["esi-skills.read_skills.v1", "publicData"]);
});

test("a confidential client authenticates with Basic and needs no verifier", async () => {
  const { dispatch } = buildSurface();

  // No `code_challenge` at all: the authorize route accepts it, and its safety
  // rests entirely on the client authenticating at the token endpoint instead.
  const { code } = await authorizeForCode(dispatch, {
    code_challenge: undefined,
    code_challenge_method: undefined,
  });

  const answer = await dispatch(postForm(
    "/v2/oauth/token",
    { grant_type: "authorization_code", code },
    basicHeader(CLIENT_ID, CLIENT_SECRET),
  ));

  assert.equal(answer.status, 200, answer.body);
  const payload = JSON.parse(answer.body);
  await verifyAgainstJwks(dispatch, payload.access_token);
});

// The invariant, end to end

test("a no-challenge code cannot be redeemed by a client that did not authenticate", async () => {
  // The hole the authorize route cannot close and `mayRedeem` does: with no
  // PKCE and no client authentication, a network attacker who read the
  // authorization request would have everything they need.
  const { dispatch } = buildSurface();

  const { code } = await authorizeForCode(dispatch, {
    code_challenge: undefined,
    code_challenge_method: undefined,
  });

  const answer = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
  }));

  assert.notEqual(answer.status, 200, "an unauthenticated no-PKCE redemption succeeded");
  assert.equal(JSON.parse(answer.body).error, "invalid_grant");
});

test("a wrong verifier does not redeem, and says nothing about why", async () => {
  const { dispatch } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const wrong = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy",
  }));

  assert.equal(wrong.status, 400);
  const body = JSON.parse(wrong.body);
  assert.equal(body.error, "invalid_grant");

  // A malformed verifier and a well-formed wrong one must be indistinguishable,
  // or a guesser learns which of their guesses had the right shape.
  const malformed = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code: (await authorizeForCode(dispatch)).code,
    client_id: CLIENT_ID,
    code_verifier: "!!",
  }));

  assert.equal(malformed.body, wrong.body);
});

test("a code is single use, and the replay is indistinguishable from an unknown code", async () => {
  const { dispatch, logLines } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const first = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }));
  assert.equal(first.status, 200);

  const replay = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }));

  const unknown = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code: "A".repeat(43),
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }));

  assert.equal(replay.status, 400);
  assert.equal(JSON.parse(replay.body).error, "invalid_grant");

  // RFC 6749 §5.2: the endpoint must not tell a code-holder that their code is
  // real. `lib/authCodes.js` keeps the outcomes distinct so the log can.
  assert.equal(replay.body, unknown.body);
  assert.match(logLines.join("\n"), /REPLAY/i);
});

test("replaying a code kills the grant it minted and nothing else", async () => {
  // Replaying an authorization code revokes the grant it produced. Only a
  // composition can check this: it is an agreement between three real stores.
  // `lib/authCodes.js` has to hand the route the `family` it was told to
  // remember, the route has to have remembered the one `lib/refreshTokens.js`
  // wrote, and the revocation has to land on that lineage and no other. Every
  // double in `test/tokenContract.test.js` agrees with whichever of those its
  // author believed.
  const { dispatch, logLines } = buildSurface();

  const exchange = async (code) => {
    const answer = await dispatch(postForm("/v2/oauth/token", {
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      code_verifier: VERIFIER,
    }));
    assert.equal(answer.status, 200, answer.body);
    return JSON.parse(answer.body);
  };

  const refreshWith = (token) => dispatch(postForm("/v2/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: token,
    client_id: CLIENT_ID,
  }));

  // Two sign-ins by the same character through the same client, which D30's
  // per-subject cap of eight makes ordinary: a player with two tools, or one
  // tool that was restarted.
  const leaked = await authorizeForCode(dispatch);
  const bystander = await authorizeForCode(dispatch);

  const stolen = await exchange(leaked.code);
  const other = await exchange(bystander.code);
  assert.notEqual(stolen.refresh_token, other.refresh_token);

  // Both work before the replay, so the assertions after it are about the
  // replay and not about a grant that was never live.
  assert.equal((await refreshWith(stolen.refresh_token)).status, 200);
  assert.equal((await refreshWith(other.refresh_token)).status, 200);

  const replay = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code: leaked.code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }));

  // The grant the replayed code minted is dead. RFC 6749 §4.1.2.
  const dead = await refreshWith(stolen.refresh_token);
  assert.equal(dead.status, 400, dead.body);
  assert.equal(JSON.parse(dead.body).error, "invalid_grant");

  // The most important assertion here. The other grant belongs to the same
  // character and the same client, and it is untouched. A revocation by
  // (character, client) would have taken it, and since this branch is reachable
  // with nothing but a sniffed code and a public `client_id`, a replay would
  // become an amplified logout oracle rather than a defence.
  const alive = await refreshWith(other.refresh_token);
  assert.equal(alive.status, 200, `the bystander's grant was collateral: ${alive.body}`);
  assert.equal(JSON.parse(alive.body).refresh_token, other.refresh_token);

  // And none of it is visible from the outside. A replay that revoked
  // something must answer in exactly the bytes of a replay of a code that never
  // existed, or the response is an oracle confirming the code was real.
  const unknown = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code: "B".repeat(43),
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }));
  assert.equal(replay.status, unknown.status);
  assert.equal(replay.body, unknown.body);
  assert.deepEqual(replay.headers, unknown.headers);

  // The operator gets the whole story, including the part that is not closed:
  // the access token minted from the replayed code is stateless and outlives
  // the grant, which the test below this one pins from the other side.
  const alarm = logLines.find((line) => line.includes("AUTHORIZATION CODE REPLAY"));
  assert.ok(alarm, "a replay is unmissable in a grep");
  assert.match(alarm, /revoked/);
  assert.match(alarm, /stays valid until it expires/);

  // Replaying it a second time finds nothing left to kill and still says so
  // rather than claiming a revocation.
  logLines.length = 0;
  const again = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code: leaked.code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }));
  assert.equal(again.body, unknown.body);
  const second = logLines.find((line) => line.includes("AUTHORIZATION CODE REPLAY"));
  assert.ok(second, "the second replay is logged too");
  assert.match(second, /could not be revoked/);
});

// The refresh grant

test("the refresh grant returns a second access token from the same store", async () => {
  const { dispatch } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const first = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }));
  const issued = JSON.parse(first.body);

  const refreshed = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    client_id: CLIENT_ID,
  }));

  assert.equal(refreshed.status, 200, refreshed.body);
  const payload = JSON.parse(refreshed.body);

  // D30: no rotation, so the same token comes back, and it must come back,
  // because an absent or empty `refresh_token` is an error to the EVE client.
  assert.equal(payload.refresh_token, issued.refresh_token);

  const claims = await verifyAgainstJwks(dispatch, payload.access_token);
  assert.equal(claims.sub, `CHARACTER:EVE:${CHARACTER_ID}`);
});

test("a refresh may narrow its scopes and may not widen them", async () => {
  const { dispatch } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const issued = JSON.parse((await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }))).body);

  const narrowed = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    client_id: CLIENT_ID,
    scope: "publicData",
  }));

  assert.equal(narrowed.status, 200, narrowed.body);
  const claims = await verifyAgainstJwks(dispatch, JSON.parse(narrowed.body).access_token);
  assert.deepEqual(claims.scp, ["publicData"], "the narrowed set must reach the token");

  const widened = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    client_id: CLIENT_ID,
    scope: "publicData esi-wallet.read_character_wallet.v1",
  }));

  assert.notEqual(widened.status, 200, "a widened scope was granted");
  assert.equal(JSON.parse(widened.body).error, "invalid_scope");
});

test("a refresh token survives the store being reopened", async () => {
  // Reached through the endpoint rather than the module: a grant issued before
  // a restart still refreshes after one.
  const { dispatch, refreshTokens, dir } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const issued = JSON.parse((await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }))).body);

  // A second store over the same file is what a restart looks like from here.
  const reopened = createRefreshTokenStore({
    storePath: path.join(dir, "refresh-tokens.jsonl"),
    now: () => Date.now(),
  });

  assert.notEqual(refreshTokens.size(), 0);
  assert.equal(reopened.size(), refreshTokens.size());

  const seen = reopened.refresh(issued.refresh_token, {});
  assert.equal(seen.outcome, "ok", `a grant did not survive the reopen: ${seen.outcome}`);
});

// The secrets never reach the log

test("no credential this flow issues appears in any log line", async () => {
  const { dispatch, logLines } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const issued = JSON.parse((await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }))).body);

  // Provoke the paths that log the most, so this is not vacuous.
  await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }));

  assert.notEqual(logLines.length, 0, "nothing was logged, so this assertion is vacuous");
  const joined = logLines.join("\n");

  for (const [name, secret] of Object.entries({
    "authorization code": code,
    "access token": issued.access_token,
    "refresh token": issued.refresh_token,
    "client secret": CLIENT_SECRET,
    "code verifier": VERIFIER,
  })) {
    assert.equal(joined.includes(secret), false, `the ${name} reached the log`);
  }
});

// Verify: reading back what we just minted

test("verify answers for a token this surface just issued, on both paths", async () => {
  // Verify returns the same character identity that the token's sub encodes.
  // The token comes out of the real flow rather than a fixture, so the minter
  // and the reader are checked against each other.
  const { dispatch } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const issued = JSON.parse((await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }))).body);

  const bearer = { authorization: `Bearer ${issued.access_token}` };

  for (const target of ["/v2/oauth/verify", "/oauth/verify"]) {
    const answer = await dispatch({ ...get(target), headers: bearer });
    assert.equal(answer.status, 200, `${target}: ${answer.body}`);

    const identity = JSON.parse(answer.body);
    assert.equal(identity.CharacterID, CHARACTER_ID);
    assert.equal(identity.CharacterName, CHARACTER_NAME);
    assert.equal(typeof identity.CharacterOwnerHash, "string");
    assert.notEqual(identity.CharacterOwnerHash, "");

    // PascalCase, asserted against the serialized string: a parsed object cannot
    // see a member that was lowercased on the way out, and this surface is the one
    // place in the replica that is not snake_case.
    assert.match(answer.body, /"CharacterID"/);
    assert.match(answer.body, /"CharacterOwnerHash"/);
  }

  // The legacy alias is not a redirect or a second document. It is the same
  // handler, so the two answers are byte-identical.
  const versioned = await dispatch({ ...get("/v2/oauth/verify"), headers: bearer });
  const legacy = await dispatch({ ...get("/oauth/verify"), headers: bearer });
  assert.equal(legacy.body, versioned.body);
});

test("verify's owner hash is the token's own owner claim, not a second derivation", async () => {
  // Two names for one value drift. If verify computed its own hash it would
  // fall behind `ownerHashFor` and log every client out.
  const { dispatch } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const issued = JSON.parse((await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }))).body);

  const claims = await verifyAgainstJwks(dispatch, issued.access_token);
  const identity = JSON.parse((await dispatch({
    ...get("/v2/oauth/verify"),
    headers: { authorization: `Bearer ${issued.access_token}` },
  })).body);

  assert.equal(identity.CharacterOwnerHash, claims.owner);
});

test("verify refuses every bad credential identically, in text/html", async () => {
  const { dispatch } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const issued = JSON.parse((await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }))).body);

  // A token this surface really signed, then tampered, so the refusal is the
  // signature check failing rather than a parse failing.
  const [head, payload, signature] = issued.access_token.split(".");
  const tampered = [head, Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), sub: "CHARACTER:EVE:1" }),
  ).toString("base64url"), signature].join(".");

  const refusals = [];
  for (const headers of [
    {},
    { authorization: "Bearer" },
    { authorization: "Basic aaaa" },
    { authorization: "Bearer not-a-token" },
    { authorization: `Bearer ${tampered}` },
  ]) {
    const answer = await dispatch({ ...get("/v2/oauth/verify"), headers });
    assert.equal(answer.status, 401);
    // Real CCP refuses this endpoint in HTML, not JSON. Only the token endpoint
    // answers in RFC 6749 JSON.
    assert.match(answer.headers["content-type"], /^text\/html/);
    refusals.push(answer.body);
  }

  // One body for five different causes: a refusal that varied would tell a
  // caller whether their token was real, expired, or simply mistyped.
  assert.equal(new Set(refusals).size, 1, "the 401 body varies with the cause");

  // And it says nothing at all about the token or the character.
  const body = refusals[0];
  for (const leak of [CHARACTER_NAME, String(CHARACTER_ID), "expired", "signature"]) {
    assert.equal(body.toLowerCase().includes(leak.toLowerCase()), false, `401 body leaks ${leak}`);
  }
});

// Revoke

test("revoking a refresh token prevents its further use", async () => {
  // The promise D30 rests on: rotation was declined because revocation still
  // works, and this is the endpoint an operator reaches for when a token is
  // known lost.
  const { dispatch } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const issued = JSON.parse((await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }))).body);

  // It works before.
  const before = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    client_id: CLIENT_ID,
  }));
  assert.equal(before.status, 200);

  const revoked = await dispatch(postForm(
    "/v2/oauth/revoke",
    { token_type_hint: "refresh_token", token: issued.refresh_token },
    basicHeader(CLIENT_ID, CLIENT_SECRET),
  ));
  assert.equal(revoked.status, 200, revoked.body);

  // And not after.
  const after = await dispatch(postForm("/v2/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
    client_id: CLIENT_ID,
  }));
  assert.notEqual(after.status, 200, "a revoked refresh token still worked");
  assert.equal(JSON.parse(after.body).error, "invalid_grant");
});

test("revoke answers identically for a live token, a revoked one, and garbage", async () => {
  // RFC 7009 §2.2: the endpoint must not let a caller distinguish a valid token
  // from an invalid one. The store keeps the outcomes distinct so the log can
  // tell them apart; the wire may not.
  const { dispatch } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const issued = JSON.parse((await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }))).body);

  const auth = basicHeader(CLIENT_ID, CLIENT_SECRET);
  const answers = [];

  for (const token of [issued.refresh_token, issued.refresh_token, "not-a-real-token"]) {
    const answer = await dispatch(postForm(
      "/v2/oauth/revoke",
      { token_type_hint: "refresh_token", token },
      auth,
    ));
    answers.push(JSON.stringify({
      status: answer.status,
      body: answer.body,
      type: answer.headers["content-type"] || null,
    }));
  }

  // Live, already-revoked and never-existed: one answer.
  assert.equal(new Set(answers).size, 1, `revoke leaked validity: ${answers.join(" | ")}`);
  assert.match(answers[0], /"status":200/);

  // An absent token is a different thing and is answered differently: RFC 7009
  // §2.1 makes `token` required, so its absence is `invalid_request`, a fault in
  // the request's shape that the caller already knows about, not a statement
  // about whether some token is valid.
  const missing = await dispatch(postForm("/v2/oauth/revoke", { token: "" }, auth));
  assert.equal(missing.status, 400);
  assert.match(missing.headers["content-type"], /^text\/html/);
});

test("the token_type_hint is advisory and never changes the answer", async () => {
  // RFC 7009 §2.1 makes it a hint: a server must not fail on an absent or wrong
  // one. Access tokens are stateless here and cannot be recalled, so naming one
  // is answered like everything else.
  const { dispatch } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const issued = JSON.parse((await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }))).body);

  const auth = basicHeader(CLIENT_ID, CLIENT_SECRET);
  const answers = [];

  for (const fields of [
    { token: issued.refresh_token },
    { token: issued.refresh_token, token_type_hint: "refresh_token" },
    { token: issued.refresh_token, token_type_hint: "access_token" },
    { token: issued.refresh_token, token_type_hint: "something_else" },
  ]) {
    const answer = await dispatch(postForm("/v2/oauth/revoke", fields, auth));
    answers.push(`${answer.status} ${answer.body}`);
  }

  assert.equal(new Set(answers).size, 1, `the hint changed the answer: ${answers.join(" | ")}`);
});

test("a revoked token's access token still verifies until it expires", async () => {
  // An access token is stateless and self-describing, so revoking the refresh
  // grant cannot recall one already minted. It stops being usable when its
  // expiry passes, twenty minutes out, which is why that lifetime is short and
  // why revocation is of grants rather than tokens.
  const { dispatch } = buildSurface();
  const { code } = await authorizeForCode(dispatch);

  const issued = JSON.parse((await dispatch(postForm("/v2/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    code_verifier: VERIFIER,
  }))).body);

  await dispatch(postForm(
    "/v2/oauth/revoke",
    { token: issued.refresh_token },
    basicHeader(CLIENT_ID, CLIENT_SECRET),
  ));

  const answer = await dispatch({
    ...get("/v2/oauth/verify"),
    headers: { authorization: `Bearer ${issued.access_token}` },
  });

  assert.equal(answer.status, 200, "an access token stopped verifying when its grant was revoked");
});
