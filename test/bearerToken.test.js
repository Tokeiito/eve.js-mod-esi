/**
 * Tests for lib/bearerToken.js
 *
 * Run with:  node --test test/bearerToken.test.js
 *
 * Every token this file expects to be accepted comes out of
 * `lib/accessToken.js`'s real minter, signed by a real key from
 * `lib/signingKey.js`. What is under test is whether the reader and the minter
 * in this repository agree, and a hand-built token asserts the author's belief
 * about the minter rather than the minter. The two files could agree with each
 * other and both be wrong about the claim order, the `owner` encoding or the
 * `iat` flooring, and this suite would still catch a change to either one that
 * broke the other. That is the failure that ships a replica unable to read its
 * own tokens.
 *
 * Tokens expected to be refused are built by hand, because the minter will not
 * produce a token with `alg: "none"`. Where a refusal is about a claim rather
 * than the JOSE layer, the forgery is signed with the real key through
 * `accessToken.signAccessToken`, so the case reads as a token this replica
 * really signed and still must not honour, not a string that was never going to
 * verify anyway.
 *
 * The algorithm-confusion case is the reason this file exists. `alg: "none"` and
 * `alg: "HS256"`-over-the-public-key are the standard JWT attack, trivially
 * mountable against this server because the public key is published at
 * `/oauth/jwks` on purpose. One comparison defeats them, and its only
 * protection is a test. The HMAC forgery is computed for real against the real
 * public key, and the case asserts the forged payload is otherwise good, so the
 * only thing between it and acceptance is the line under test.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const bearerToken = require(path.join(__dirname, "../lib/bearerToken"));
const accessToken = require(path.join(__dirname, "../lib/accessToken"));
const signingKeyModule = require(path.join(__dirname, "../lib/signingKey"));

const {
  DEFAULT_CLOCK_TOLERANCE_SECONDS,
  MAXIMUM_CLOCK_TOLERANCE_SECONDS,
  VERIFY_REASON,
  BearerTokenError,
  bearerFromAuthorization,
  createBearerVerifier,
} = bearerToken;

const { JOSE_ALG, LIFETIME_SECONDS, createAccessTokenMinter, signAccessToken } = accessToken;

// Fixtures

/**
 * One real 2048-bit key for the whole file, generated once: D8 measured
 * generation at ~40 ms, and every case needs a key, so paying it per test would
 * be the only slow thing in this suite.
 *
 * The PEM is kept because two cases below need a second key object over the
 * same private key: the `kid` case needs a token whose signature verifies and
 * whose key name does not, which is the only way to prove the `kid` check does
 * anything.
 */
const KEY_PEM = signingKeyModule.generateSigningKeyPem();
const KEY = signingKeyModule.signingKeyFromPem(KEY_PEM, { path: "(in-memory fixture)" });

/** The same private key wearing a name this replica does not publish. */
const ALIAS_KEY = signingKeyModule.signingKeyFromPem(KEY_PEM, {
  kid: "Someone-Elses-Signature-Key",
  path: "(in-memory fixture)",
});

/** A different key entirely, so "the signature verifies" cannot be true of any key. */
const OTHER_KEY = signingKeyModule.signingKeyFromPem(signingKeyModule.generateSigningKeyPem(), {
  path: "(in-memory fixture)",
});

/** D7's shape: absolute, explicit scheme, no trailing slash, no path. */
const ISSUER = "http://host.local:26006";
const OTHER_ISSUER = "http://someone-else.local:26006";

const SALT = "0123456789abcdef0123456789abcdef";

/** Pinned clock, in milliseconds. Nothing here sleeps and nothing flakes. */
const NOW_MS = 1648562018000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const JTI = "5f4e3d2c-1b0a-4998-8877-665544332211";

const CHARACTER_ID = 123123;
const CHARACTER_NAME = "Some Bloke";
const ACCOUNT_ID = 90210;
const CLIENT_ID = "my3rdpartyclientid";
const SCOPES = ["esi-skills.read_skills.v1", "esi-wallet.read_character_wallet.v1"];

function mint(overrides = {}) {
  const { signingKey = KEY, issuer = ISSUER, atMs = NOW_MS, ...mintOptions } = overrides;
  return createAccessTokenMinter({
    signingKey,
    issuer,
    now: () => atMs,
    ownerSalt: SALT,
    generateJti: () => JTI,
  }).mint({
    characterId: CHARACTER_ID,
    characterName: CHARACTER_NAME,
    clientId: CLIENT_ID,
    scopes: SCOPES,
    ownerInputs: { accountId: ACCOUNT_ID },
    ...mintOptions,
  });
}

function verifier(overrides = {}) {
  const { atMs = NOW_MS, ...rest } = overrides;
  return createBearerVerifier({
    signingKey: KEY,
    issuer: ISSUER,
    now: () => atMs,
    ...rest,
  });
}

/** A token, split the way the module splits it. */
function segmentsOf(token) {
  const segments = token.split(".");
  assert.equal(segments.length, 3, "a compact JWS is three dot-separated segments");
  return segments;
}

function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

/** Every reason a verdict may carry, so a typo in a reason name fails a test. */
const EVERY_REASON = new Set(Object.values(VERIFY_REASON));

function assertRefused(verdict, reason) {
  assert.equal(verdict.ok, false, `expected a refusal, got ${JSON.stringify(verdict)}`);
  assert.ok(EVERY_REASON.has(verdict.reason), `${verdict.reason} is not a declared reason`);
  assert.equal(verdict.reason, reason, `refused for ${verdict.reason}: ${verdict.detail}`);
  assert.equal(typeof verdict.detail, "string");
  assert.notEqual(verdict.detail, "", "a refusal with no detail is a log line nobody can act on");
}

// The reader agrees with the minter

test("a freshly minted token verifies and projects what a route needs", () => {
  const minted = mint();
  const verdict = verifier().verify(minted.token);

  assert.equal(verdict.ok, true, `refused: ${verdict.reason}: ${verdict.detail}`);

  const { claims } = verdict;

  // The character id arrives as an integer. A route must never have to run
  // /CHARACTER:EVE:(\d+)/ for itself: that regex is unanchored everywhere it
  // appears in the ecosystem, so every caller that reimplements it reimplements it
  // more loosely than this module does.
  assert.equal(claims.characterId, CHARACTER_ID);
  assert.equal(typeof claims.characterId, "number");
  assert.ok(Number.isSafeInteger(claims.characterId));
  assert.equal(claims.subject, `CHARACTER:EVE:${CHARACTER_ID}`);

  // The four members /v2/oauth/verify answers with.
  assert.equal(claims.characterName, CHARACTER_NAME);
  assert.equal(claims.owner, minted.claims.owner);
  assert.equal(claims.clientId, CLIENT_ID);
  assert.deepEqual([...claims.scopes], SCOPES);

  // Times, in seconds, and the lifetime the minter promised.
  assert.equal(claims.issuedAt, NOW_SECONDS);
  assert.equal(claims.expiresAt, NOW_SECONDS + LIFETIME_SECONDS);
  assert.equal(claims.expiresIn, LIFETIME_SECONDS);
  assert.equal(claims.issuer, ISSUER);
  assert.equal(claims.tokenId, JTI);

  // Projected but never judged: see the module header on why `aud` decides
  // nothing here.
  assert.deepEqual([...claims.audience], [CLIENT_ID, "EVE Online"]);
  assert.equal(claims.kid, KEY.kid);

  // Frozen, because a route holding a verdict across an await and mutating it
  // would be a confusing bug.
  assert.ok(Object.isFrozen(claims));
  assert.ok(Object.isFrozen(claims.scopes));
  assert.ok(Object.isFrozen(claims.payload));
  assert.equal(claims.payload.iss, ISSUER);
});

test("a token with no scopes projects an empty array rather than being refused", () => {
  // A missing scope is answered with a 403 naming the scope, not with a 401
  // claiming the token is bad. An empty scope set is a valid public-data token and
  // grants nothing, which is the safe direction.
  const verdict = verifier().verify(mint({ scopes: [] }).token);

  assert.equal(verdict.ok, true, `refused: ${verdict.reason}`);
  assert.deepEqual([...verdict.claims.scopes], []);
});

test("CCP's bare-string scp is understood, though this replica never emits one", () => {
  // lib/accessToken.js always writes an array; real CCP writes a string when
  // there is exactly one scope. A reader that could not read the thing it imitates
  // would be a strange reader.
  const claims = { ...mint().claims, scp: `${SCOPES[0]}  ${SCOPES[1]}` };
  const token = signAccessToken(claims, { privateKey: KEY.privateKey, kid: KEY.kid });

  const verdict = verifier().verify(token);
  assert.equal(verdict.ok, true, `refused: ${verdict.reason}: ${verdict.detail}`);
  assert.deepEqual([...verdict.claims.scopes], SCOPES);
});

// Expiry

test("an expired token is refused, and the boundary is exp itself", () => {
  const token = mint().token;
  const expiresAt = NOW_SECONDS + LIFETIME_SECONDS;

  // RFC 7519 section 4.1.4: the current time must be before exp.
  assert.equal(verifier({ atMs: (expiresAt - 1) * 1000 }).verify(token).ok, true);
  assertRefused(verifier({ atMs: expiresAt * 1000 }).verify(token), VERIFY_REASON.EXPIRED);
  assertRefused(
    verifier({ atMs: (expiresAt + 86400) * 1000 }).verify(token),
    VERIFY_REASON.EXPIRED,
  );
});

test("the default clock tolerance is zero, and a configured one extends exactly that far", () => {
  assert.equal(DEFAULT_CLOCK_TOLERANCE_SECONDS, 0);
  assert.equal(verifier().clockToleranceSeconds, 0);

  // Configured tolerance extends the life by exactly that many seconds and no
  // more. That is the cost the default declines to pay: exp - iat is exactly 1200
  // by contract, so this is a straight extension of every token's life.
  const token = mint().token;
  const expiresAt = NOW_SECONDS + LIFETIME_SECONDS;
  const tolerant = (atSeconds) => verifier({ atMs: atSeconds * 1000, clockToleranceSeconds: 30 });

  assert.equal(tolerant(expiresAt).verify(token).ok, true);
  assert.equal(tolerant(expiresAt + 29).verify(token).ok, true);
  assertRefused(tolerant(expiresAt + 30).verify(token), VERIFY_REASON.EXPIRED);
});

test("a token issued in the future is honoured, because iat is not a time gate", () => {
  // The decision, spelled out in lib/bearerToken.js: a future iat is not evidence
  // of forgery (a forger holding the key would simply not write one), while a host
  // clock that steps backwards produces one on a token this replica minted
  // itself. `exp` is what bounds a token, and `exp` is checked.
  const token = mint({ atMs: NOW_MS + 300000 }).token;
  const verdict = verifier().verify(token);

  assert.equal(verdict.ok, true, `refused: ${verdict.reason}: ${verdict.detail}`);
  assert.equal(verdict.claims.issuedAt, NOW_SECONDS + 300);

  // It is still required to be present and a NumericDate: a caller reads it.
  const claims = { ...mint().claims };
  delete claims.iat;
  assertRefused(
    verifier().verify(signAccessToken(claims, { privateKey: KEY.privateKey, kid: KEY.kid })),
    VERIFY_REASON.BAD_CLAIMS,
  );
});

// The attack

test("algorithm confusion: alg none, alg HS256 over the public key, and alg PS256", () => {
  const genuine = mint().token;
  const [genuineHeader, payloadSegment, genuineSignature] = segmentsOf(genuine);

  // The payload is untouched in all three forgeries, and on its own it is a good,
  // unexpired claim set, so the only thing between each forgery and acceptance is
  // the algorithm check.
  assert.equal(verifier().verify(genuine).ok, true);
  assert.equal(decodeSegment(payloadSegment).sub, `CHARACTER:EVE:${CHARACTER_ID}`);

  // alg: "none", the unsigned token.
  //
  // The signature segment is empty, which is what the attack looks like. The
  // refusal is BAD_ALGORITHM, not MALFORMED: lib/bearerToken.js checks the
  // algorithm before it checks whether the signature segment is well-formed, so
  // the most important refusal it makes is not reported as a formatting
  // complaint.
  const none = `${encodeSegment({ alg: "none", kid: KEY.kid, typ: "JWT" })}.${payloadSegment}.`;
  assertRefused(verifier().verify(none), VERIFY_REASON.BAD_ALGORITHM);

  // Some attackers send a garbage signature instead of an empty one, on the
  // theory that a validator rejects the empty segment before reading `alg`.
  const noneWithJunk = `${none}QUJD`;
  assertRefused(verifier().verify(noneWithJunk), VERIFY_REASON.BAD_ALGORITHM);

  // alg: "HS256", HMACed with the public key.
  //
  // The public half is published at /oauth/jwks, so anybody can compute this MAC.
  // A validator that dispatched on the header's `alg` would hand its verification
  // key to a symmetric primitive and confirm the forgery.
  const publicPem = KEY.publicKey.export({ type: "spki", format: "pem" });
  const hsHeader = encodeSegment({ alg: "HS256", kid: KEY.kid, typ: "JWT" });
  const hsInput = `${hsHeader}.${payloadSegment}`;
  const hsSignature = crypto.createHmac("sha256", publicPem).update(hsInput).digest("base64url");
  const hs256 = `${hsInput}.${hsSignature}`;

  // The forgery is real: it is a correct HMAC over its own signing input under
  // the published key, which is what a naive validator would check.
  assert.equal(
    crypto.createHmac("sha256", publicPem).update(hsInput).digest("base64url"),
    hsSignature,
  );
  assertRefused(verifier().verify(hs256), VERIFY_REASON.BAD_ALGORITHM);

  // alg: "PS256", a genuine RSA signature under the wrong padding.
  //
  // This shows the check is on `alg` rather than on "does some signature happen
  // to verify": it is our own key, correctly signing, with the padding one
  // constant away from the one RS256 names.
  const psHeader = encodeSegment({ alg: "PS256", kid: KEY.kid, typ: "JWT" });
  const psInput = `${psHeader}.${payloadSegment}`;
  const psSignature = crypto
    .sign("sha256", Buffer.from(psInput, "utf8"), {
      key: KEY.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64url");
  assertRefused(verifier().verify(`${psInput}.${psSignature}`), VERIFY_REASON.BAD_ALGORITHM);

  // The genuine header with the genuine signature still verifies, so none of the
  // above passes because the fixture was broken.
  assert.equal(
    verifier().verify(`${genuineHeader}.${payloadSegment}.${genuineSignature}`).ok,
    true,
  );
});

test("a JOSE header carrying crit, or a typ that is not JWT, is refused", () => {
  const [, payloadSegment, signature] = segmentsOf(mint().token);

  for (const header of [
    { alg: JOSE_ALG, kid: KEY.kid, typ: "JWT", crit: ["exp"] },
    { alg: JOSE_ALG, kid: KEY.kid, typ: "dpop+jwt" },
    { alg: JOSE_ALG, kid: KEY.kid, typ: "JWE" },
  ]) {
    const token = `${encodeSegment(header)}.${payloadSegment}.${signature}`;
    assertRefused(verifier().verify(token), VERIFY_REASON.BAD_HEADER);
  }
});

// Keys

test("a token signed by a different key is refused", () => {
  const token = mint({ signingKey: OTHER_KEY }).token;

  // Same kid (lib/signingKey.js pins the literal, so a second replica's key wears
  // the same name), so the kid check cannot catch this and the signature has to.
  assert.equal(OTHER_KEY.kid, KEY.kid);
  assertRefused(verifier().verify(token), VERIFY_REASON.BAD_SIGNATURE);

  // Not vacuous: the same token verifies against the key that signed it.
  const other = createBearerVerifier({
    signingKey: OTHER_KEY,
    issuer: ISSUER,
    now: () => NOW_MS,
  });
  assert.equal(other.verify(token).ok, true);
});

test("a token naming a kid this replica does not publish is refused before the signature", () => {
  // Signed by our own private key, so the signature is genuine and only the name
  // is wrong. A verifier without a kid check would accept it outright.
  const token = mint({ signingKey: ALIAS_KEY }).token;
  const [header, payload, signature] = segmentsOf(token);

  assert.equal(decodeSegment(header).kid, "Someone-Elses-Signature-Key");
  assert.equal(
    crypto.verify(
      "sha256",
      Buffer.from(`${header}.${payload}`, "utf8"),
      KEY.publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
    "the fixture must be a token whose signature verifies, or the kid check proves nothing",
  );

  assertRefused(verifier().verify(token), VERIFY_REASON.WRONG_KEY);
});

test("a tampered payload is refused", () => {
  const [header, payload, signature] = segmentsOf(mint().token);

  const forged = { ...decodeSegment(payload), sub: "CHARACTER:EVE:999999" };
  const token = `${header}.${encodeSegment(forged)}.${signature}`;

  assert.notEqual(encodeSegment(forged), payload, "the fixture must actually differ");
  assertRefused(verifier().verify(token), VERIFY_REASON.BAD_SIGNATURE);
});

// Issuer

test("a token from another issuer is refused, and the comparison is exact", () => {
  assertRefused(
    verifier().verify(mint({ issuer: OTHER_ISSUER }).token),
    VERIFY_REASON.WRONG_ISSUER,
  );

  // D7's shape rules are where two spellings of the same server differ. Neither
  // of these is D7-legal, so the minter refuses them outright. The only issuers
  // that reach this comparison are well-shaped ones, and they still have to match
  // byte for byte.
  assert.throws(() => mint({ issuer: `${ISSUER}/` }), accessToken.AccessTokenError);
  assert.throws(() => mint({ issuer: `${ISSUER}/sso` }), accessToken.AccessTokenError);

  // A verifier configured for a different issuer refuses our own tokens, which is
  // what an operator moving ESI_MOD_ISSUER after go-live sees.
  const misconfigured = createBearerVerifier({
    signingKey: KEY,
    issuer: OTHER_ISSUER,
    now: () => NOW_MS,
  });
  assertRefused(misconfigured.verify(mint().token), VERIFY_REASON.WRONG_ISSUER);
});

// Claims this replica could not have minted

test("a signed token whose claims this replica would never emit is still refused", () => {
  const good = mint().claims;
  const sign = (claims) => signAccessToken(claims, { privateKey: KEY.privateKey, kid: KEY.kid });

  const cases = [
    // The subject: the ecosystem's regex is unanchored, so all three of these yield
    // a character id to a consumer. None of them is a subject this minter emits, so
    // none is honoured here.
    [{ ...good, sub: "CORPORATION:EVE:123123" }, VERIFY_REASON.BAD_SUBJECT],
    [{ ...good, sub: "EVIL:CHARACTER:EVE:123123" }, VERIFY_REASON.BAD_SUBJECT],
    [{ ...good, sub: "CHARACTER:EVE:123123 " }, VERIFY_REASON.BAD_SUBJECT],
    [{ ...good, sub: "CHARACTER:EVE:" }, VERIFY_REASON.BAD_SUBJECT],
    [{ ...good, sub: String(CHARACTER_ID) }, VERIFY_REASON.BAD_SUBJECT],
    [{ ...good, sub: 123123 }, VERIFY_REASON.BAD_SUBJECT],
    // Leading zeros would let two distinct subjects project to one character.
    [{ ...good, sub: "CHARACTER:EVE:0000123123" }, VERIFY_REASON.BAD_SUBJECT],
    // More digits than a double holds: this rounds to a different character.
    [{ ...good, sub: "CHARACTER:EVE:99999999999999999999" }, VERIFY_REASON.BAD_SUBJECT],

    // Claims a caller reads, absent or wrongly typed.
    [omit(good, "name"), VERIFY_REASON.BAD_CLAIMS],
    [omit(good, "owner"), VERIFY_REASON.BAD_CLAIMS],
    [omit(good, "azp"), VERIFY_REASON.BAD_CLAIMS],
    [omit(good, "exp"), VERIFY_REASON.BAD_CLAIMS],
    [{ ...good, exp: String(good.exp) }, VERIFY_REASON.BAD_CLAIMS],
    // exp in milliseconds is the mistake worth naming: it validates happily for
    // thirty-eight years and nothing about it looks wrong. It is caught as a type
    // here only when it is a string. As a number it is a very distant expiry, which
    // is the minter's problem and test/accessToken's.
    [{ ...good, scp: 7 }, VERIFY_REASON.BAD_CLAIMS],
    [{ ...good, scp: [""] }, VERIFY_REASON.BAD_CLAIMS],
    [{ ...good, scp: [1, 2] }, VERIFY_REASON.BAD_CLAIMS],
  ];

  for (const [claims, reason] of cases) {
    const verdict = verifier().verify(sign(claims));
    assertRefused(verdict, reason);
  }

  // Payloads that are signed and are not claim sets at all.
  for (const payload of ["not an object", 42, [1, 2, 3]]) {
    assertRefused(verifier().verify(sign(payload)), VERIFY_REASON.MALFORMED);
  }
});

function omit(object, member) {
  const copy = { ...object };
  delete copy[member];
  return copy;
}

// Malformed input

test("a string that is not a compact JWS is refused as malformed", () => {
  const v = verifier();

  assertRefused(v.verify(""), VERIFY_REASON.NO_CREDENTIAL);

  for (const junk of [
    "abc",
    "a.b",
    "a.b.c.d",
    "....",
    "a.b.c",
    "$.$.$",
    "eyJhbGciOiJSUzI1NiJ9",
    // Standard base64 rather than base64url: Node's decoder ignores the "+" and
    // would read it as though it were not there.
    "eyJhbGciOiJSUzI1+iJ9.eyJ9.AAAA",
    `${Buffer.from("{}", "utf8").toString("base64url")}.e30.AAAA`,
  ]) {
    const verdict = v.verify(junk);
    assert.equal(verdict.ok, false, `${JSON.stringify(junk)} must not verify`);
    assert.ok(
      verdict.reason === VERIFY_REASON.MALFORMED || verdict.reason === VERIFY_REASON.BAD_ALGORITHM,
      `${JSON.stringify(junk)} refused for ${verdict.reason}`,
    );
  }
});

test("verify() never throws, whatever it is handed", () => {
  const v = verifier();

  const hostile = [
    undefined,
    null,
    0,
    NaN,
    true,
    {},
    [],
    Symbol("token"),
    () => "token",
    Buffer.from("token"),
    new Date(),
    "💥",
    "Bearer eyJ.eyJ.AAA",
    ".".repeat(1000),
    "a".repeat(100000),
    `${"a".repeat(50000)}.${"b".repeat(50000)}.${"c".repeat(50000)}`,
    // A header whose JSON tries prototype pollution. JSON.parse defines __proto__
    // as an own property, so `header.alg` is undefined and the algorithm check
    // refuses it. The case is here so that a future refactor to a hand-rolled parser
    // has something to fail against.
    `${Buffer.from('{"__proto__":{"alg":"RS256"}}', "utf8").toString("base64url")}.e30.AAAA`,
    // An object with a throwing getter, in case anything ever reads a property off
    // the argument before checking its type.
    {
      get length() {
        throw new Error("no");
      },
    },
  ];

  for (const input of hostile) {
    let verdict;
    assert.doesNotThrow(() => {
      verdict = v.verify(input);
    }, `verify(${String(input).slice(0, 30)}) threw`);

    assert.equal(verdict.ok, false);
    assert.ok(EVERY_REASON.has(verdict.reason), `${verdict.reason} is not a declared reason`);
    // A route calling this inside a game server must never get INTERNAL_ERROR:
    // that reason exists so a bug is a logged verdict rather than a 500, and any
    // input reaching it is a bug in lib/bearerToken.js.
    assert.notEqual(
      verdict.reason,
      VERIFY_REASON.INTERNAL_ERROR,
      `${String(input).slice(0, 40)} reached the unreachable branch: ${verdict.detail}`,
    );
  }
});

// fromHeader

test("fromHeader pulls the credential out, and tells 'none' from 'bad'", () => {
  const v = verifier();
  const token = mint().token;

  // Present, in every spelling a client actually sends.
  assert.equal(v.fromHeader({ authorization: `Bearer ${token}` }), token);
  assert.equal(v.fromHeader({ authorization: `bearer ${token}` }), token);
  assert.equal(v.fromHeader({ authorization: `BeArEr ${token}` }), token);
  assert.equal(v.fromHeader({ authorization: `BEARER ${token}` }), token);
  // RFC 9110 section 5.5 optional whitespace around the value, and RFC 7235's
  // 1*SP after the scheme: an extra space is what `"Bearer " + " " + token` gives.
  assert.equal(v.fromHeader({ authorization: `   Bearer     ${token}   ` }), token);
  assert.equal(v.fromHeader({ authorization: `Bearer\t${token}` }), token);
  // Node lowercases header names; anything else handing us a bag may not.
  assert.equal(v.fromHeader({ Authorization: `Bearer ${token}` }), token);
  assert.equal(v.fromHeader({ AUTHORIZATION: `Bearer ${token}` }), token);
  // Node keeps only the first Authorization when a request carries two.
  assert.equal(v.fromHeader({ authorization: [`Bearer ${token}`, "Bearer second"] }), token);

  // Absent, or not a bearer credential at all: null, meaning "nothing was
  // presented". The route challenges these rather than refusing them.
  for (const headers of [
    {},
    undefined,
    null,
    "not a header bag",
    { authorization: "" },
    { authorization: "   " },
    { authorization: "Basic dXNlcjpwdw==" },
    { authorization: "Negotiate abcdef" },
    { authorization: "Bearer" },
    { authorization: "Bearer " },
    { authorization: "Bearertoken" },
    // token68 has no internal whitespace: this is two credentials or a truncated
    // one, and taking half of it would hand verify() a string that fails for a
    // reason unrelated to what went wrong.
    { authorization: "Bearer part one" },
    { authorization: [] },
    { authorization: 42 },
    { authorization: { token: "x" } },
    { "x-authorization": `Bearer ${token}` },
  ]) {
    assert.equal(v.fromHeader(headers), null, `${JSON.stringify(headers)} is not a credential`);
  }

  // The round trip, and the distinction the two functions exist to keep: a header
  // with nothing in it gives null, and null given to verify() is NO_CREDENTIAL
  // rather than a complaint about a token.
  assertRefused(v.verify(v.fromHeader({})), VERIFY_REASON.NO_CREDENTIAL);
  assert.equal(v.verify(v.fromHeader({ authorization: `Bearer ${token}` })).ok, true);

  // A credential that is present and worthless is a different answer.
  const bad = v.fromHeader({ authorization: "Bearer not-a-token" });
  assert.equal(bad, "not-a-token");
  assertRefused(v.verify(bad), VERIFY_REASON.MALFORMED);
});

test("the pure header core is total", () => {
  for (const input of [undefined, null, 42, {}, [], Symbol("s")]) {
    assert.doesNotThrow(() => bearerFromAuthorization(input));
    assert.equal(bearerFromAuthorization(input), null);
  }
});

// Construction

test("the verifier refuses to be built out of something that cannot verify", () => {
  const ok = { signingKey: KEY, issuer: ISSUER, now: () => NOW_MS };

  assert.throws(() => createBearerVerifier(), BearerTokenError);
  assert.throws(() => createBearerVerifier({ ...ok, signingKey: undefined }), BearerTokenError);
  assert.throws(() => createBearerVerifier({ ...ok, signingKey: "a PEM" }), BearerTokenError);
  assert.throws(() => createBearerVerifier({ ...ok, signingKey: {} }), BearerTokenError);
  assert.throws(
    () => createBearerVerifier({ ...ok, signingKey: { ...KEY, kid: "" } }),
    BearerTokenError,
  );
  assert.throws(
    () => createBearerVerifier({ ...ok, signingKey: { ...KEY, jwk: { alg: "ES256" } } }),
    BearerTokenError,
  );

  assert.throws(() => createBearerVerifier({ ...ok, issuer: undefined }), BearerTokenError);
  assert.throws(() => createBearerVerifier({ ...ok, issuer: "" }), BearerTokenError);

  // The clock is required rather than defaulted, for lib/accessToken.js's reason.
  assert.throws(() => createBearerVerifier({ ...ok, now: undefined }), BearerTokenError);
  assert.throws(() => createBearerVerifier({ ...ok, now: NOW_MS }), BearerTokenError);

  // A tolerance is seconds, non-negative, and capped: past the ceiling it is not
  // describing a clock, it is choosing a token lifetime.
  for (const bad of [-1, 1.5, "30", null, 30000, MAXIMUM_CLOCK_TOLERANCE_SECONDS + 1]) {
    assert.throws(
      () => createBearerVerifier({ ...ok, clockToleranceSeconds: bad }),
      BearerTokenError,
      `clockToleranceSeconds ${String(bad)} must be refused`,
    );
  }
  assert.equal(
    createBearerVerifier({ ...ok, clockToleranceSeconds: MAXIMUM_CLOCK_TOLERANCE_SECONDS })
      .clockToleranceSeconds,
    MAXIMUM_CLOCK_TOLERANCE_SECONDS,
  );

  // The public half is what this module needs, and the private half is what it
  // must not hold: a reader that could mint would make "who may issue a token" a
  // question with two answers.
  const publicOnly = { kid: KEY.kid, publicKey: KEY.publicKey, jwk: KEY.jwk };
  const built = createBearerVerifier({ ...ok, signingKey: publicOnly });
  assert.equal(built.verify(mint().token).ok, true);
  assert.equal(built.kid, KEY.kid);
  assert.equal(built.issuer, ISSUER);
  assert.ok(Object.isFrozen(built));
});

test("a bad clock is a verdict, not a throw", () => {
  // now() is injected, so a caller can hand over something that is not a clock.
  // That must not become a 500 in the game process either.
  const broken = createBearerVerifier({ signingKey: KEY, issuer: ISSUER, now: () => "soon" });
  const verdict = broken.verify(mint().token);
  assertRefused(verdict, VERIFY_REASON.INTERNAL_ERROR);
});
