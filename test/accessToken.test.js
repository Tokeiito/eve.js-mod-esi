/**
 * eve.js-mod-esi: tests for lib/accessToken.js
 *
 * Run with: node --test test/accessToken.test.js
 *
 * Everything is asserted against the decoded token, not against
 * `result.claims`. The claim shape is an interface because consumers decode
 * the token locally (`jose`, `python-jose`, `jsonwebtoken`, the EVE client's
 * own Python, any `split(".")[1]` reader), so what has to be right is the
 * base64url-of-JSON, not the object the minter held on the way there. A test
 * on the intermediate object would pass through a serialization bug, which
 * only reaches a third party's process.
 *
 * `decode()` below splits on `.`, base64url-decodes and `JSON.parse`s, as every
 * consumer does, and each claim-shape case stands on that.
 *
 * What this test proves, and what it does not
 *
 * A token must validate under `jose`, python-jose and `jsonwebtoken`. None can
 * be installed: D5/D20 make the deployable artifact
 * dependency-free and this repository declares no dependencies. What is
 * reachable is the path all three run underneath, reached as
 * `test/signingKey.test.js` reaches it: take the published JWK (the literal
 * object `GET /oauth/jwks` serves), import it with
 * `crypto.createPublicKey({ key, format: "jwk" })`, and verify the RS256
 * signature over `header.payload`.
 *
 * Proved: the JWK we publish imports cleanly, and the signature over the exact
 * bytes we emit verifies against the key that JWK describes, with the digest
 * and padding RS256 names. A tampered payload fails, so the assertion is not
 * vacuous, and a token signed by a different key fails, so it is not verifying
 * against itself.
 *
 * Not proved: that a real library accepts the token. A library also fetches
 * the JWKS over HTTP, selects a key by `kid`, checks `typ`, `alg`, `exp`,
 * `nbf`, `iss` and `aud`, and applies its own leeway, and each step can reject
 * a token for reasons this file cannot see. The claim-shape cases cover most
 * of that surface; the HTTP fetch and each library's policy are unreachable,
 * and that requirement is only fully met by running one of them by hand against
 * a live replica.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const accessToken = require(path.join(__dirname, "../lib/accessToken"));
const signingKeyModule = require(path.join(__dirname, "../lib/signingKey"));
const sso = require(path.join(__dirname, "../contract/sso"));
const { TENANT } = require(path.join(__dirname, "../lib/tenant"));

const {
  AUDIENCE_LITERAL,
  CLAIM_ORDER,
  JOSE_ALG,
  JOSE_HEADER_MEMBER_ORDER,
  JOSE_TYP,
  LIFETIME_SECONDS,
  MINIMUM_OWNER_SALT_LENGTH,
  OWNER_HASH_BYTES,
  REGION,
  SUBJECT_PREFIX,
  TIER,
  AccessTokenError,
  buildAccessTokenClaims,
  createAccessTokenMinter,
  generateOwnerSalt,
  normalizeScopes,
  ownerHashFor,
  signAccessToken,
} = accessToken;

// Fixtures

/**
 * One real 2048-bit key for the whole file.
 *
 * Built through `lib/signingKey.js`'s own pure core, so the object the minter
 * is handed is the object the SSO listener will hand it (`kid`, `privateKey`,
 * `jwk` and all), and the acceptance test verifies against the JWK the JWKS
 * route would publish.
 *
 * Generated once at load: it takes about 40 ms (D8 measured it) and every test
 * needs it.
 */
const KEY = signingKeyModule.signingKeyFromPem(signingKeyModule.generateSigningKeyPem(), {
  path: "(in-memory fixture)",
});

/** A second key, so "the signature verifies" cannot be true of any key. */
const OTHER_KEY = signingKeyModule.signingKeyFromPem(signingKeyModule.generateSigningKeyPem(), {
  path: "(in-memory fixture)",
});

/** D7's shape: absolute, explicit scheme, no trailing slash, no path. */
const ISSUER = "http://host.local:26006";

/** Fixed so every owner hash in this file is reproducible. */
const SALT = "0123456789abcdef0123456789abcdef";

/** Pinned clock, in milliseconds. Nothing here sleeps. */
const NOW_MS = 1648562018000;
const JTI = "5f4e3d2c-1b0a-4998-8877-665544332211";

const CHARACTER_ID = 123123;
const CHARACTER_NAME = "Some Bloke";
const ACCOUNT_ID = 90210;
const CLIENT_ID = "my3rdpartyclientid";
const SCOPE = "esi-skills.read_skills.v1";

function minter(overrides = {}) {
  return createAccessTokenMinter({
    signingKey: KEY,
    issuer: ISSUER,
    now: () => NOW_MS,
    ownerSalt: SALT,
    generateJti: () => JTI,
    ...overrides,
  });
}

function mint(overrides = {}) {
  const { minterOptions, ...mintOptions } = overrides;
  return minter(minterOptions || {}).mint({
    characterId: CHARACTER_ID,
    characterName: CHARACTER_NAME,
    clientId: CLIENT_ID,
    scopes: [SCOPE],
    ownerInputs: { accountId: ACCOUNT_ID },
    ...mintOptions,
  });
}

/**
 * A token, read the way a consumer reads it: split, base64url-decode, parse.
 *
 * The raw JSON text of each segment comes back too, because two cases below
 * are about member order, which survives `JSON.parse` in V8 but cannot be
 * asserted by an object comparison.
 */
function decode(token) {
  const segments = token.split(".");
  assert.equal(segments.length, 3, "a compact JWS is three dot-separated segments");

  const headerJson = Buffer.from(segments[0], "base64url").toString("utf8");
  const payloadJson = Buffer.from(segments[1], "base64url").toString("utf8");

  return {
    segments,
    headerJson,
    payloadJson,
    header: JSON.parse(headerJson),
    payload: JSON.parse(payloadJson),
    signingInput: `${segments[0]}.${segments[1]}`,
    signature: Buffer.from(segments[2], "base64url"),
  };
}

// The subject form

test("quirk 1: sub is CHARACTER:EVE:<id> and nothing else", () => {
  const { payload } = decode(mint().token);

  assert.equal(payload.sub, "CHARACTER:EVE:123123");
  assert.equal(payload.sub, `${SUBJECT_PREFIX}${CHARACTER_ID}`);

  // The regex the ecosystem actually parses it with, from the contract module.
  const match = sso.ACCESS_TOKEN_SUBJECT_PATTERN.exec(payload.sub);
  assert.ok(match, "the subject must match /CHARACTER:EVE:(\\d+)/i");
  assert.equal(Number(match[1]), CHARACTER_ID);

  // No other subject form is emitted: the id appears once, behind the prefix,
  // and never as a bare integer claim beside it.
  assert.equal(payload.sub.startsWith(SUBJECT_PREFIX), true);
  for (const [claim, value] of Object.entries(payload)) {
    if (claim === "sub") continue;
    assert.notEqual(value, CHARACTER_ID, `${claim} must not carry a bare character id`);
    assert.notEqual(value, String(CHARACTER_ID), `${claim} must not carry a bare character id`);
  }
});

// The audience array

test("quirk 2: aud is an array of exactly two, the second the literal EVE Online", () => {
  const { payload } = decode(mint().token);

  assert.ok(Array.isArray(payload.aud), "a single-string aud breaks array-expecting validators");
  assert.equal(payload.aud.length, 2);
  assert.deepEqual(payload.aud, [CLIENT_ID, "EVE Online"]);
  assert.equal(payload.aud[1], AUDIENCE_LITERAL);

  // Spelling is protocol: a space, a capital O, and no hyphen.
  assert.equal(payload.aud[1], "EVE Online");

  // `azp` is the same client id, and the EVE client reads it back as the
  // client_id for its own refresh calls (docs/d6-listener-split.md).
  assert.equal(payload.azp, CLIENT_ID);
  assert.equal(payload.aud[0], payload.azp);
});

// The issuer

test("quirk 3: iss is the configured issuer verbatim, not CCP's bare hostname", () => {
  const { payload } = decode(mint().token);

  // D7. `docs/d6-listener-split.md` says it in as many words: the JWT `iss` is
  // the configured issuer string.
  assert.equal(payload.iss, ISSUER);
  assert.notEqual(payload.iss, sso.ACCESS_TOKEN_ISS.ccp);
  assert.ok(payload.iss.includes("://"), "a scheme-less iss is forced to https by the EVE client");
  assert.ok(!payload.iss.endsWith("/"), "issuer comparison is exact string comparison");

  // Verbatim means verbatim: a different configured issuer comes out unaltered,
  // with no normalisation, no lower-casing and no port stripping.
  for (const issuer of [
    "https://login.host.local",
    "http://127.0.0.1:26006",
    "http://HOST.local:26006",
  ]) {
    assert.equal(decode(mint({ minterOptions: { issuer } }).token).payload.iss, issuer);
  }
});

test("the issuer shapes D6 proved unusable are refused rather than minted", () => {
  // Each of these produces a discovery URL the EVE client cannot fetch, and the
  // damage shows only about twenty minutes after a login that worked.
  const refused = {
    "host.local:26006": "parses as scheme `host.local`",
    "host.local": "loses the port and is fetched over https",
    "http://host.local:26006/": "a trailing slash is a different issuer",
    "http://host.local:26006/sso": "the client discards the path before fetching",
    "": "absent",
  };

  for (const [issuer, why] of Object.entries(refused)) {
    assert.throws(
      () => minter({ issuer }),
      AccessTokenError,
      `${JSON.stringify(issuer)} should be refused: ${why}`,
    );
  }
});

// kid in both places

test("quirk 4: kid is in the JOSE header and again in the body, and they agree", () => {
  const { header, payload } = decode(mint().token);

  assert.equal(header.kid, KEY.kid);
  assert.equal(payload.kid, KEY.kid);
  assert.equal(header.kid, payload.kid);

  // The literal third-party validators pin, arriving from the key set rather
  // than from a fourth copy of the string inside lib/accessToken.js.
  assert.equal(header.kid, sso.JWKS_KID);
});

test("the JOSE header is exactly the three recorded members, in the recorded order", () => {
  const { header, headerJson } = decode(mint().token);

  assert.equal(headerJson, '{"alg":"RS256","kid":"JWT-Signature-Key","typ":"JWT"}');
  assert.deepEqual(Object.keys(header), JOSE_HEADER_MEMBER_ORDER);
  assert.deepEqual(Object.keys(header), sso.ACCESS_TOKEN_JOSE_HEADER_MEMBER_ORDER);
  assert.equal(header.alg, JOSE_ALG);
  assert.equal(header.typ, JOSE_TYP);

  // No `jwk`, `jku`, `x5c` or `x5u`: each tells a validator where to find a
  // key, which invites verifying a token against a key the token itself chose.
  for (const member of ["jwk", "jku", "x5c", "x5u", "crit"]) {
    assert.equal(member in header, false, `${member} must not be in the header`);
  }
});

// scp is always an array

test("quirk 5: one scope still yields an array", () => {
  const { payload, payloadJson } = decode(mint({ scopes: [SCOPE] }).token);

  assert.ok(Array.isArray(payload.scp), "the branch every consumer handles");
  assert.deepEqual(payload.scp, [SCOPE]);
  // Checked in the bytes too, so a serializer that unwrapped a one-element
  // array would fail here rather than in somebody's `.map`.
  assert.ok(payloadJson.includes(`"scp":["${SCOPE}"]`));
});

test("scp is an array at every scope count, in order, with duplicates kept", () => {
  const many = ["esi-skills.read_skills.v1", "esi-wallet.read_character_wallet.v1"];
  assert.deepEqual(decode(mint({ scopes: many }).token).payload.scp, many);

  // Zero scopes is still an array and still present: the claim set is compared
  // as a set, so a dropped `scp` is as wrong as an invented claim.
  const none = decode(mint({ scopes: [] }).token).payload;
  assert.deepEqual(none.scp, []);
  assert.equal("scp" in none, true);
  assert.deepEqual(decode(mint({ scopes: undefined }).token).payload.scp, []);

  // OAuth's space-delimited wire form is accepted, because that is what
  // lib/authCodes.js recorded verbatim off the authorization request.
  assert.deepEqual(decode(mint({ scopes: many.join(" ") }).token).payload.scp, many);
  assert.deepEqual(normalizeScopes(` ${many[0]}\t${many[1]} `), many);

  // Not normalised: order is the caller's and duplicates survive, because this
  // module is not where a scope set is decided.
  assert.deepEqual(normalizeScopes([many[1], many[0], many[0]]), [many[1], many[0], many[0]]);
});

// owner is standard base64

test("quirk 6: owner is standard base64, on the alphabet rather than on luck", () => {
  // A value containing no `+` or `/` would pass a weaker check by luck, so this
  // searches for inputs producing each of the two characters that distinguish
  // RFC 4648 section 4 from section 5. Deterministic: fixed salt.
  const owners = [];
  for (let accountId = 1; accountId <= 400; accountId += 1) {
    owners.push(ownerHashFor({ characterId: CHARACTER_ID, accountId, salt: SALT }));
  }

  assert.ok(owners.some((value) => value.includes("+")), "no sample contained a `+`");
  assert.ok(owners.some((value) => value.includes("/")), "no sample contained a `/`");

  for (const value of owners) {
    assert.match(value, /^[A-Za-z0-9+/]+={0,2}$/, `${value} is not standard base64`);
    assert.ok(!value.includes("-"), "`-` is base64url's substitute for `+`");
    assert.ok(!value.includes("_"), "`_` is base64url's substitute for `/`");
  }

  // CCP's shape: 20 bytes, 28 characters, one pad.
  for (const value of owners) {
    assert.equal(value.length, sso.ACCESS_TOKEN_OWNER.characters);
    assert.equal(Buffer.from(value, "base64").length, OWNER_HASH_BYTES);
    assert.ok(value.endsWith("="));
  }
});

test("the owner claim in a minted token is the same standard base64", () => {
  const { payload } = decode(mint().token);

  assert.equal(payload.owner, ownerHashFor({
    characterId: CHARACTER_ID,
    accountId: ACCOUNT_ID,
    salt: SALT,
  }));
  assert.match(payload.owner, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(payload.owner.length, 28);
});

test("owner is stable per character and moves when ownership does", () => {
  // Clients invalidate a stored token when this claim changes, so a value that
  // flickers logs everybody out and a value that never moves defeats the
  // mechanism silently.
  const first = decode(mint().token).payload.owner;
  const second = decode(mint().token).payload.owner;
  assert.equal(first, second, "two mints with the same ownership must agree");

  const moved = decode(mint({ ownerInputs: { accountId: ACCOUNT_ID + 1 } }).token).payload.owner;
  assert.notEqual(moved, first, "a character on another account is a transferred character");

  // Same account, different character: not the same hash either, or two
  // characters on one account would be correlatable by equality alone.
  const sibling = decode(mint({ characterId: CHARACTER_ID + 1 }).token).payload.owner;
  assert.notEqual(sibling, first);

  // A different salt is a different server: the salt is the one thing that must
  // survive a restart for the claim to mean anything.
  assert.notEqual(
    ownerHashFor({ characterId: CHARACTER_ID, accountId: ACCOUNT_ID, salt: `${SALT}x` }),
    first,
  );
});

test("owner does not carry the account id in the clear, and the salt is required", () => {
  const owner = ownerHashFor({ characterId: CHARACTER_ID, accountId: ACCOUNT_ID, salt: SALT });
  const raw = Buffer.from(owner, "base64").toString("hex");

  for (const spelling of [String(ACCOUNT_ID), ACCOUNT_ID.toString(16)]) {
    assert.ok(!owner.includes(spelling), "the account id must not be readable off the claim");
    assert.ok(!raw.includes(spelling));
  }

  // Without a secret salt the hash is a reversible encoding of a small integer,
  // so a placeholder is refused rather than accepted with a warning nobody
  // reads.
  assert.throws(() => ownerHashFor({ characterId: 1, accountId: 1, salt: "salt" }), AccessTokenError);
  assert.throws(() => ownerHashFor({ characterId: 1, accountId: 1 }), AccessTokenError);
  assert.equal(typeof generateOwnerSalt(), "string");
  assert.ok(generateOwnerSalt().length >= MINIMUM_OWNER_SALT_LENGTH);
  assert.notEqual(generateOwnerSalt(), generateOwnerSalt());
});

test("minting refuses when ownership is unknown, ambiguous or absent", () => {
  // An owner claim derived from unknown ownership changes the moment ownership
  // becomes known, and every client reads that as a character transfer.
  assert.throws(() => mint({ ownerInputs: { accountId: null } }), AccessTokenError);
  assert.throws(() => mint({ ownerInputs: {} }), AccessTokenError);
  assert.throws(() => mint({ ownerInputs: undefined, ownerHash: undefined }), AccessTokenError);

  // Both is refused rather than resolved by precedence.
  assert.throws(
    () => mint({ ownerHash: "AAAA", ownerInputs: { accountId: ACCOUNT_ID } }),
    AccessTokenError,
  );

  // A precomputed hash is honoured verbatim.
  assert.equal(decode(mint({ ownerHash: "AAAA=", ownerInputs: undefined }).token).payload.owner, "AAAA=");
});

// The lifetime

test("quirk 7: exp - iat is exactly 1200", () => {
  const result = mint();
  const { payload } = decode(result.token);

  assert.equal(payload.exp - payload.iat, 1200);
  assert.equal(payload.exp - payload.iat, LIFETIME_SECONDS);
  assert.equal(payload.exp - payload.iat, sso.ACCESS_TOKEN_LIFETIME_SECONDS);

  // Seconds, not milliseconds, and numbers, not numeric strings.
  assert.equal(payload.iat, Math.floor(NOW_MS / 1000));
  assert.equal(typeof payload.exp, "number");
  assert.equal(typeof payload.iat, "number");
  assert.equal(Number.isInteger(payload.exp), true);

  // `expires_in` must be 1199 to 1200. This is the lifetime rather than a
  // second reading of the clock, so it is 1200 every time.
  assert.equal(result.expiresIn, 1200);
  assert.ok(result.expiresIn >= 1199 && result.expiresIn <= 1200);
});

test("the clock is injected, so two mints a simulated hour apart differ only in time", () => {
  const later = createAccessTokenMinter({
    signingKey: KEY,
    issuer: ISSUER,
    now: () => NOW_MS + 3600_000,
    ownerSalt: SALT,
    generateJti: () => JTI,
  }).mint({
    characterId: CHARACTER_ID,
    characterName: CHARACTER_NAME,
    clientId: CLIENT_ID,
    scopes: [SCOPE],
    ownerInputs: { accountId: ACCOUNT_ID },
  });

  const first = decode(mint().token).payload;
  const second = decode(later.token).payload;

  assert.equal(second.iat - first.iat, 3600);
  assert.equal(second.exp - second.iat, 1200);
  for (const claim of CLAIM_ORDER) {
    if (claim === "exp" || claim === "iat") continue;
    assert.deepEqual(second[claim], first[claim], `${claim} must not depend on the clock`);
  }

  // A minter with no clock is refused rather than reaching for Date.now(),
  // which would let a test pass while depending on a clock nobody chose.
  assert.throws(() => minter({ now: undefined }), AccessTokenError);
});

// tenant, tier, region

test("quirk 8: tenant, tier and region are the recorded flat strings", () => {
  const { payload } = decode(mint().token);

  assert.equal(payload.tenant, "tranquility");
  assert.equal(payload.tier, "live");
  assert.equal(payload.region, "world");

  for (const claim of ["tenant", "tier", "region"]) {
    assert.equal(typeof payload[claim], "string", `${claim} is a flat string, not an object`);
  }

  // D26 gives the datasource no knob, and `lib/tenant.js` holds the one
  // deployable spelling of it. Some tools assert on this claim, and a second
  // copy in lib/accessToken.js could drift from the one the ESI surface
  // validates against.
  assert.equal(payload.tenant, TENANT);
  assert.equal(TIER, "live");
  assert.equal(REGION, "world");
});

// The claim set, against the recorded document

test("the claim set matches the recorded token exactly: same keys, same order", () => {
  const { payload, payloadJson } = decode(mint().token);

  assert.deepEqual(
    Object.keys(payload),
    Object.keys(sso.CCP_ACCESS_TOKEN_CLAIMS),
    "no claim invented and none missing",
  );
  assert.deepEqual(Object.keys(payload), CLAIM_ORDER);
  assert.deepEqual(Object.keys(payload), sso.ACCESS_TOKEN_CLAIM_ORDER);

  // Order is asserted on the bytes too, because `Object.keys` on a parsed
  // object reflects V8, not the wire.
  assert.equal(payloadJson.indexOf('"scp"'), 1);
  assert.ok(payloadJson.indexOf('"exp"') < payloadJson.indexOf('"iat"'));
});

test("every claim has the recorded type", () => {
  const { payload } = decode(mint().token);

  for (const [claim, type] of Object.entries(sso.ACCESS_TOKEN_CLAIM_TYPES)) {
    if (type === "string[]") {
      assert.ok(Array.isArray(payload[claim]), `${claim} should be an array`);
      for (const item of payload[claim]) assert.equal(typeof item, "string");
    } else {
      assert.equal(typeof payload[claim], type, `${claim} should be a ${type}`);
    }
  }

  // The same check stated the other way round, so a claim whose type is not in
  // the table cannot slip through as "not asserted".
  assert.deepEqual(
    Object.keys(payload).sort(),
    Object.keys(sso.ACCESS_TOKEN_CLAIM_TYPES).sort(),
  );
});

test("ours and CCP's recorded token differ only in values, never in shape", () => {
  const { payload } = decode(mint().token);
  const recorded = sso.CCP_ACCESS_TOKEN_CLAIMS;

  // The constant half must match by value; the variable half only by type,
  // because CCP's values are a character, a client and an origin that are not
  // ours, and two of them are redacted placeholders in the record.
  for (const [claim, expected] of Object.entries(sso.ACCESS_TOKEN_CONSTANT_CLAIMS)) {
    assert.equal(payload[claim], expected, `${claim} is constant and must match the record`);
    assert.equal(recorded[claim], expected);
  }

  for (const claim of sso.ACCESS_TOKEN_VARIABLE_CLAIMS) {
    assert.equal(
      Array.isArray(payload[claim]),
      Array.isArray(recorded[claim]),
      `${claim} must be the same kind of value as the record`,
    );
    assert.equal(typeof payload[claim], typeof recorded[claim], `${claim} type differs`);
  }

  // The one deliberate value-level divergence, restated where a reader diffing
  // the two will look.
  assert.notEqual(payload.iss, recorded.iss);
  assert.equal(recorded.iss, sso.ACCESS_TOKEN_ISS.ccp);
});

test("jti is a UUID, one per token, and injectable", () => {
  const { payload } = decode(mint().token);
  assert.equal(payload.jti, JTI);

  const real = createAccessTokenMinter({
    signingKey: KEY,
    issuer: ISSUER,
    now: () => NOW_MS,
    ownerSalt: SALT,
  });
  const one = decode(real.mint({
    characterId: CHARACTER_ID,
    characterName: CHARACTER_NAME,
    clientId: CLIENT_ID,
    scopes: [SCOPE],
    ownerInputs: { accountId: ACCOUNT_ID },
  }).token).payload;
  const two = decode(real.mint({
    characterId: CHARACTER_ID,
    characterName: CHARACTER_NAME,
    clientId: CLIENT_ID,
    scopes: [SCOPE],
    ownerInputs: { accountId: ACCOUNT_ID },
  }).token).payload;

  assert.match(one.jti, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(one.jti, two.jti, "a jti that repeats is not an identifier");
});

// The token as bytes

test("the compact serialization is three unpadded base64url segments", () => {
  const { segments } = decode(mint().token);

  for (const segment of segments) {
    assert.match(segment, /^[A-Za-z0-9_-]+$/, "a JWS segment is base64url, unpadded");
    assert.ok(!segment.includes("="), "padding inside a segment is a malformed token");
  }

  // The owner claim's standard base64 lives inside the payload segment, so its
  // `+` and `/` are encoded away rather than reaching the wire raw.
  const owner = decode(mint().token).payload.owner;
  assert.equal(typeof owner, "string");
});

// Validation by a standard library, as far as it is reachable here

test("the published JWK imports and verifies the signature over our own bytes", () => {
  const { signingInput, signature, header } = decode(mint().token);

  // The path `jose`, python-jose and `jwks-rsa` run underneath: a JWK straight
  // out of the JWKS document, imported by the platform.
  const [publishedJwk] = signingKeyModule.signingJwks(KEY);
  assert.equal(publishedJwk.kid, header.kid);
  assert.equal(publishedJwk.alg, header.alg);

  const publicKey = crypto.createPublicKey({ key: publishedJwk, format: "jwk" });
  assert.equal(
    crypto.verify("sha256", Buffer.from(signingInput, "utf8"), publicKey, signature),
    true,
    "RS256 is RSASSA-PKCS1-v1_5 with SHA-256; this is what every validator computes",
  );
});

test("a tampered payload fails, so the verification above is not vacuous", () => {
  const { segments, payload, signature } = decode(mint().token);
  const publicKey = crypto.createPublicKey({ key: KEY.jwk, format: "jwk" });

  const forged = { ...payload, sub: `${SUBJECT_PREFIX}999999` };
  const forgedSegment = Buffer.from(JSON.stringify(forged), "utf8").toString("base64url");
  const forgedInput = `${segments[0]}.${forgedSegment}`;

  assert.notEqual(forgedSegment, segments[1], "the tamper has to actually change the bytes");
  assert.equal(
    crypto.verify("sha256", Buffer.from(forgedInput, "utf8"), publicKey, signature),
    false,
  );

  // A token signed by another key does not verify against this one, so the
  // check is not passing on any signature at all.
  const other = createAccessTokenMinter({
    signingKey: OTHER_KEY,
    issuer: ISSUER,
    now: () => NOW_MS,
    ownerSalt: SALT,
    generateJti: () => JTI,
  }).mint({
    characterId: CHARACTER_ID,
    characterName: CHARACTER_NAME,
    clientId: CLIENT_ID,
    scopes: [SCOPE],
    ownerInputs: { accountId: ACCOUNT_ID },
  });
  const foreign = decode(other.token);
  assert.equal(
    crypto.verify("sha256", Buffer.from(foreign.signingInput, "utf8"), publicKey, foreign.signature),
    false,
  );
});

// The constants, against contract/sso.js

test("lib/accessToken.js's literals agree with contract/sso.js, which is the authority", () => {
  // `contract/` is test-only and never deployed (lib/sourceHash.js HASHED_DIRS
  // is ["lib", "routes"]), so a lib module requiring it would pass this suite
  // and throw MODULE_NOT_FOUND inside the game process. The values are
  // duplicated and this test holds the two copies together.
  assert.equal(SUBJECT_PREFIX, sso.ACCESS_TOKEN_SUBJECT_PREFIX);
  assert.equal(AUDIENCE_LITERAL, sso.ACCESS_TOKEN_AUDIENCE_LITERAL);
  assert.equal(LIFETIME_SECONDS, sso.ACCESS_TOKEN_LIFETIME_SECONDS);
  assert.equal(JOSE_ALG, sso.ACCESS_TOKEN_JOSE_HEADER.alg);
  assert.equal(JOSE_TYP, sso.ACCESS_TOKEN_JOSE_HEADER.typ);
  assert.deepEqual(JOSE_HEADER_MEMBER_ORDER, sso.ACCESS_TOKEN_JOSE_HEADER_MEMBER_ORDER);
  assert.deepEqual(CLAIM_ORDER, sso.ACCESS_TOKEN_CLAIM_ORDER);
  assert.equal(OWNER_HASH_BYTES, sso.ACCESS_TOKEN_OWNER.bytes);
  assert.equal(TIER, sso.ACCESS_TOKEN_CONSTANT_CLAIMS.tier);
  assert.equal(REGION, sso.ACCESS_TOKEN_CONSTANT_CLAIMS.region);
  assert.equal(TENANT, sso.ACCESS_TOKEN_CONSTANT_CLAIMS.tenant);

  // The one literal lib/accessToken.js deliberately does not carry: `kid`
  // arrives on the key set member, so the header, the body and the JWKS share
  // one source.
  const code = require("node:fs")
    .readFileSync(path.join(__dirname, "../lib/accessToken.js"), "utf8")
    .split("\n")
    // Comments may quote the header they describe; code may not. Crude, and it
    // only has to fail when the literal becomes a value.
    .filter((line) => !/^\s*(\/\*|\*|\/\/)/.test(line))
    .join("\n");
  assert.ok(
    !code.includes(sso.JWKS_KID),
    "the kid must come from the signing key, not from a fourth copy of the literal",
  );
});

// Refusals, and the shape of the module

test("a key that cannot produce an RS256 signature is refused at construction", () => {
  assert.throws(() => minter({ signingKey: undefined }), AccessTokenError);
  assert.throws(() => minter({ signingKey: {} }), AccessTokenError);
  assert.throws(
    () => minter({ signingKey: { ...KEY, kid: "" } }),
    AccessTokenError,
  );

  // An EC key would sign happily and produce ES256 under a header claiming
  // RS256.
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  assert.throws(() => minter({ signingKey: { kid: KEY.kid, privateKey } }), AccessTokenError);

  // A key publishing a different alg than this minter signs means the JWKS and
  // the token disagree, which fails verification with a message about the
  // signature.
  assert.throws(
    () => minter({ signingKey: { ...KEY, jwk: { ...KEY.jwk, alg: "PS256" } } }),
    AccessTokenError,
  );
});

test("a claim that would serialize away is refused rather than dropped", () => {
  // JSON.stringify drops an undefined member silently, producing a valid token
  // with thirteen claims and a consumer reporting something unrelated.
  const complete = {
    characterId: CHARACTER_ID,
    characterName: CHARACTER_NAME,
    ownerHash: "AAAA=",
    clientId: CLIENT_ID,
    scopes: [SCOPE],
    issuer: ISSUER,
    kid: KEY.kid,
    jti: JTI,
    issuedAt: Math.floor(NOW_MS / 1000),
  };
  assert.equal(Object.keys(buildAccessTokenClaims(complete)).length, CLAIM_ORDER.length);

  for (const missing of ["characterName", "ownerHash", "clientId", "issuer", "kid", "jti"]) {
    assert.throws(
      () => buildAccessTokenClaims({ ...complete, [missing]: undefined }),
      AccessTokenError,
      `${missing} missing should be a refusal, not a dropped claim`,
    );
  }

  // Milliseconds where seconds belong is the classic JWT bug, and it produces a
  // token that validates for thirty-eight years.
  assert.throws(() => buildAccessTokenClaims({ ...complete, issuedAt: NOW_MS + 0.5 }), AccessTokenError);
  assert.throws(() => buildAccessTokenClaims({ ...complete, characterId: "123123" }), AccessTokenError);
  assert.throws(() => buildAccessTokenClaims({ ...complete, scopes: 7 }), AccessTokenError);
  assert.throws(() => buildAccessTokenClaims({ ...complete, scopes: [""] }), AccessTokenError);
});

test("the claim core builds a token's claims with no key in sight", () => {
  // The claim set is assertable without generating RSA material.
  const claims = buildAccessTokenClaims({
    characterId: CHARACTER_ID,
    characterName: CHARACTER_NAME,
    ownerHash: "AAAA=",
    clientId: CLIENT_ID,
    scopes: [SCOPE],
    issuer: ISSUER,
    kid: "JWT-Signature-Key",
    jti: JTI,
    issuedAt: 1648562018,
  });

  assert.deepEqual(Object.keys(claims), CLAIM_ORDER);
  assert.equal(claims.exp, 1648563218);
  assert.equal(claims.iat, 1648562018);
  assert.ok(Object.isFrozen(claims), "a frozen claim set cannot be edited between build and sign");

  // Signing is a separate call taking the private half, so the two halves
  // compose exactly as the minter composes them.
  const token = signAccessToken(claims, { privateKey: KEY.privateKey, kid: KEY.kid });
  assert.deepEqual(decode(token).payload, JSON.parse(JSON.stringify(claims)));
});

test("the minter's surface is frozen and names what it was configured with", () => {
  const made = minter();
  assert.ok(Object.isFrozen(made));
  assert.equal(made.issuer, ISSUER);
  assert.equal(made.kid, KEY.kid);
  assert.equal(made.lifetimeSeconds, LIFETIME_SECONDS);
  assert.equal(typeof made.mint, "function");

  const result = mint();
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.claims));
  assert.deepEqual(Object.keys(result).sort(), ["claims", "expiresIn", "token"]);
});

test("the module exports the names the token endpoint was written against", () => {
  assert.ok(Object.isFrozen(accessToken), "module.exports itself must be frozen");
  assert.deepEqual(Object.keys(accessToken).sort(), [
    "AUDIENCE_LITERAL",
    "AccessTokenError",
    "CLAIM_ORDER",
    "JOSE_ALG",
    "JOSE_HEADER_MEMBER_ORDER",
    "JOSE_TYP",
    "LIFETIME_SECONDS",
    "MINIMUM_OWNER_SALT_LENGTH",
    "OWNER_DOMAIN",
    "OWNER_ENCODING",
    "OWNER_HASH_BYTES",
    "REGION",
    "SUBJECT_PREFIX",
    "TIER",
    "buildAccessTokenClaims",
    "buildJoseHeader",
    "createAccessTokenMinter",
    "generateOwnerSalt",
    "normalizeScopes",
    "ownerHashFor",
    "signAccessToken",
  ].sort());
});
