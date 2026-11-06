/**
 * `contract/sso.js`: the SSO surface's constants, checked against each other.
 *
 * Run with:  node --test test/ssoWire.test.js
 *
 * This file cannot prove the constants match `login.eveonline.com`. The suite
 * never opens a socket, and the only evidence that these values are CCP's is the
 * transcription of the SSO requirements and the date on `ESTABLISHED`. A green
 * run means "we still match what somebody wrote down in August", not "we still
 * match CCP".
 *
 * What it proves is self-consistency, which covers most of the ways these
 * constants go wrong:
 *
 *   - a member added to the document and to no source of truth, so the route
 *     assembles it from whatever it feels like;
 *   - a member dropped from a table but left in the order, or the reverse;
 *   - the discovery document advertising a `jwks_uri` that is not where the
 *     JWKS was mounted, which no test of either half alone would catch;
 *   - one of the four preserved inconsistencies "fixed" by a maintainer who
 *     read it as a typo, the failure `contract/sso.js` exists to prevent.
 *
 * The one assertion that reaches outside the tables is the recomposition test:
 * `CCP_DISCOVERY_DOCUMENT` is the transcription of record, and rebuilding it from
 * the decomposed constants catches a path constant mistyped once. Every other
 * check here would pass against a consistently wrong set.
 *
 * The freeze test matters because these constants are imported by route modules
 * that run inside the game server's process (design constraint 2). A shared array
 * that is not frozen is one a handler can splice, and the second request sees the
 * damage. `Object.freeze` on the export alone is shallow, so the check walks.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const sso = require(path.join(__dirname, "../contract/sso"));

const {
  ACCESS_TOKEN_AUDIENCE_LITERAL,
  ACCESS_TOKEN_CLAIM_ORDER,
  ACCESS_TOKEN_CLAIM_TYPES,
  ACCESS_TOKEN_CONSTANT_CLAIMS,
  ACCESS_TOKEN_ISS,
  ACCESS_TOKEN_JOSE_HEADER,
  ACCESS_TOKEN_JOSE_HEADER_MEMBER_ORDER,
  ACCESS_TOKEN_LIFETIME_SECONDS,
  ACCESS_TOKEN_OWNER,
  ACCESS_TOKEN_SCP,
  ACCESS_TOKEN_SUBJECT_PATTERN,
  ACCESS_TOKEN_SUBJECT_PREFIX,
  ACCESS_TOKEN_VARIABLE_CLAIMS,
  CCP_ACCESS_TOKEN_CLAIMS,
  CCP_ACCESS_TOKEN_PLACEHOLDERS,
  CCP_DISCOVERY_DOCUMENT,
  DISCOVERY_CONSTANTS,
  DISCOVERY_ENDPOINT_MEMBERS,
  DISCOVERY_ENDPOINT_PATHS,
  DISCOVERY_ISSUER_DERIVED_MEMBERS,
  DISCOVERY_MEMBER_ORDER,
  DISCOVERY_PATHS,
  ESTABLISHED,
  JWKS_ALG,
  JWKS_CCP_EXTRA_ALGS,
  JWKS_KEY_CONSTANTS,
  JWKS_KEY_MATERIAL_MEMBERS,
  JWKS_KEY_MEMBER_ORDER,
  JWKS_KID,
  JWKS_MEMBER_ORDER,
  JWKS_PATH,
  JWKS_SKIP_UNRESOLVED_MEMBER,
  JWKS_SKIP_UNRESOLVED_VALUE,
  OPENID_DISCOVERY_PATH,
  REFUSAL_CONTENT_TYPE,
  REVOKE_PATH,
  REVOKE_TOKEN_TYPES,
  REVOKE_TOKEN_TYPE_HINTS,
  SERVING,
  SSO_ORIGIN,
  UNOBSERVED,
  VERIFY_CONSTANT_MEMBERS,
  VERIFY_EXPIRES_ON,
  VERIFY_MEMBER_ORDER,
  VERIFY_MEMBER_PROVENANCE,
  VERIFY_MEMBER_SOURCES,
  VERIFY_PATHS,
  VERIFY_PROVENANCE_LEVELS,
  VERIFY_SCOPES,
} = sso;

/** Sorted copy, so a set comparison does not depend on declaration order. */
const asSet = (names) => [...names].sort();

// Provenance

test("the file dates itself, in the spelling every other date in the repo uses", () => {
  assert.equal(ESTABLISHED, "2026-08-24");
  assert.match(ESTABLISHED, /^\d{4}-\d{2}-\d{2}$/);
});

// The four preserved inconsistencies.
//
// Each of these looks like a defect and is an observation. The assertion is
// pointed at a future cleanup, not at a typo, so each one says what it is
// defending.

test("issuer carries no trailing slash", () => {
  // Exact-string issuer comparison is the OAuth/OIDC rule, so the slashed form is
  // a different issuer and rejects every token minted under this one.
  assert.equal(SSO_ORIGIN, "https://login.eveonline.com");
  assert.ok(!SSO_ORIGIN.endsWith("/"), "a trailing slash makes this a different issuer");
  assert.equal(CCP_DISCOVERY_DOCUMENT.issuer, SSO_ORIGIN);
});

test("the JWKS path is not under /v2/, while every other endpoint is", () => {
  assert.equal(JWKS_PATH, "/oauth/jwks");
  assert.ok(!JWKS_PATH.startsWith("/v2/"), "clients ask for /oauth/jwks; do not tidy this");

  const versioned = Object.entries(DISCOVERY_ENDPOINT_PATHS).filter(([key]) => key !== "jwks");
  assert.equal(versioned.length, 4);
  for (const [key, value] of versioned) {
    assert.ok(value.startsWith("/v2/oauth/"), `${key} should be under /v2/oauth/, got ${value}`);
  }
});

test("the discovery document points jwks_uri at the path the JWKS is mounted on", () => {
  // The pairing no unit test of either route would catch: token issue succeeds
  // and only signature verification fails, which surfaces late and elsewhere.
  assert.equal(DISCOVERY_ENDPOINT_PATHS.jwks, JWKS_PATH);
  assert.equal(CCP_DISCOVERY_DOCUMENT.jwks_uri, SSO_ORIGIN + JWKS_PATH);
});

test("id_token_signing_alg_values_supported says HS256 while we sign RS256", () => {
  assert.deepEqual(DISCOVERY_CONSTANTS.id_token_signing_alg_values_supported, ["HS256"]);
  assert.equal(JWKS_ALG, "RS256");
  assert.ok(
    !DISCOVERY_CONSTANTS.id_token_signing_alg_values_supported.includes(JWKS_ALG),
    "CCP's document contradicts its own signature; correcting it changes bytes clients compare",
  );

  // The neighbouring HS256 is not the same mistake: client_secret_jwt is HMAC by
  // definition, so this one is correct where it stands.
  assert.deepEqual(DISCOVERY_CONSTANTS.token_endpoint_auth_signing_alg_values_supported, ["HS256"]);
  assert.ok(
    DISCOVERY_CONSTANTS.token_endpoint_auth_methods_supported.includes("client_secret_jwt"),
  );
});

test("kid is the literal string third-party validators pin", () => {
  assert.equal(JWKS_KID, "JWT-Signature-Key");
  assert.equal(JWKS_KEY_CONSTANTS.kid, JWKS_KID);
  // Not a thumbprint and not a UUID: both are what a JOSE library would hand you
  // by default, and either breaks every pinned validator.
  assert.ok(
    !/^[0-9a-f-]{36}$/i.test(JWKS_KID),
    "a generated kid is unverifiable by anything holding CCP's pin",
  );
});

// The JWKS document's shape

test("the key object's member order is the observed one", () => {
  assert.deepEqual(JWKS_KEY_MEMBER_ORDER, ["alg", "e", "kid", "kty", "use", "n"]);
});

test("the key's constant and key-material halves cover its members exactly", () => {
  const halves = [...Object.keys(JWKS_KEY_CONSTANTS), ...JWKS_KEY_MATERIAL_MEMBERS];

  assert.deepEqual(
    asSet(halves),
    asSet(JWKS_KEY_MEMBER_ORDER),
    "a member in neither half has no source of truth; a member in neither order is unserved",
  );
  assert.equal(new Set(halves).size, halves.length, "no member may appear in both halves");
});

test("the key's constant members carry the observed values", () => {
  assert.deepEqual(JWKS_KEY_CONSTANTS, {
    alg: "RS256",
    kid: "JWT-Signature-Key",
    kty: "RSA",
    use: "sig",
  });
  // `e` and `n` come from the signing key at runtime. This file must never grow
  // a value for either.
  assert.deepEqual(JWKS_KEY_MATERIAL_MEMBERS, ["e", "n"]);
});

test("the non-standard .NET member survives, spelled and typed as observed", () => {
  assert.equal(JWKS_SKIP_UNRESOLVED_MEMBER, "SkipUnresolvedJsonWebKeys");
  assert.equal(JWKS_SKIP_UNRESOLVED_VALUE, true);
  assert.equal(typeof JWKS_SKIP_UNRESOLVED_VALUE, "boolean", "the boolean, not the string");
  assert.deepEqual(JWKS_MEMBER_ORDER, ["keys", JWKS_SKIP_UNRESOLVED_MEMBER]);
});

test("the one key we publish, and the one CCP publishes that we do not", () => {
  assert.deepEqual(JWKS_CCP_EXTRA_ALGS, ["ES256"]);
  assert.ok(
    !JWKS_CCP_EXTRA_ALGS.includes(JWKS_ALG),
    "the alg we sign with is not in the list of the ones we omit",
  );
});

// The discovery document's membership

test("DISCOVERY_MEMBER_ORDER is exactly the union of the two halves", () => {
  const halves = [...DISCOVERY_ISSUER_DERIVED_MEMBERS, ...Object.keys(DISCOVERY_CONSTANTS)];

  assert.deepEqual(
    asSet(halves),
    asSet(DISCOVERY_MEMBER_ORDER),
    "no member missing from the order, and none in the order that nothing can produce",
  );
  assert.equal(new Set(halves).size, halves.length, "no member may be issuer-derived and constant");
  assert.equal(
    new Set(DISCOVERY_MEMBER_ORDER).size,
    DISCOVERY_MEMBER_ORDER.length,
    "no member written twice",
  );
});

test("the issuer-derived half is `issuer` plus the five endpoint members", () => {
  assert.deepEqual(DISCOVERY_ISSUER_DERIVED_MEMBERS, [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "userinfo_endpoint",
    "jwks_uri",
    "revocation_endpoint",
  ]);
  assert.deepEqual(
    asSet(Object.values(DISCOVERY_ENDPOINT_MEMBERS)),
    asSet(Object.keys(DISCOVERY_ENDPOINT_PATHS)),
    "every advertised member resolves to a path, and every path is advertised",
  );
});

test("the top-level member order is the observed one, quirks included", () => {
  assert.deepEqual(DISCOVERY_MEMBER_ORDER, [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "userinfo_endpoint",
    "response_types_supported",
    "jwks_uri",
    "revocation_endpoint",
    "subject_types_supported",
    "revocation_endpoint_auth_methods_supported",
    "token_endpoint_auth_methods_supported",
    "id_token_signing_alg_values_supported",
    "token_endpoint_auth_signing_alg_values_supported",
    "code_challenge_methods_supported",
  ]);

  // Two quirks, named so a re-sort fails loudly: the endpoint members are split
  // by `response_types_supported`, and `subject_types_supported` is separated from
  // the other `_supported` lists.
  assert.equal(
    DISCOVERY_MEMBER_ORDER.indexOf("response_types_supported") + 1,
    DISCOVERY_MEMBER_ORDER.indexOf("jwks_uri"),
  );
  assert.equal(
    DISCOVERY_MEMBER_ORDER.indexOf("revocation_endpoint") + 1,
    DISCOVERY_MEMBER_ORDER.indexOf("subject_types_supported"),
  );
});

test("the constant half carries no issuer, so it is safe to copy verbatim", () => {
  for (const [member, value] of Object.entries(DISCOVERY_CONSTANTS)) {
    for (const item of value) {
      assert.equal(typeof item, "string", `${member} should hold strings`);
      assert.ok(!item.includes("://"), `${member} must not carry a URL; it would pin CCP's origin`);
    }
  }
});

test("nothing CCP does not publish has been added to the document", () => {
  // Some libraries read a discovery document as a closed statement of capability,
  // so an invented member is the same class of divergence as a dropped one. These
  // four are the plausible additions.
  for (const member of [
    "scopes_supported",
    "grant_types_supported",
    "introspection_endpoint",
    "service_documentation",
  ]) {
    assert.ok(!DISCOVERY_MEMBER_ORDER.includes(member), `${member} is not on CCP's document`);
  }
});

// The transcription of record

test("the decomposed constants recompose CCP's document exactly", () => {
  const rebuilt = {};
  for (const member of DISCOVERY_MEMBER_ORDER) {
    if (member === "issuer") {
      rebuilt[member] = SSO_ORIGIN;
    } else if (member in DISCOVERY_ENDPOINT_MEMBERS) {
      rebuilt[member] = SSO_ORIGIN + DISCOVERY_ENDPOINT_PATHS[DISCOVERY_ENDPOINT_MEMBERS[member]];
    } else {
      rebuilt[member] = DISCOVERY_CONSTANTS[member];
    }
  }

  // Members and their order, then the values. Split so a failure names which.
  assert.deepEqual(Object.keys(rebuilt), Object.keys(CCP_DISCOVERY_DOCUMENT));
  assert.deepEqual(rebuilt, { ...CCP_DISCOVERY_DOCUMENT });
});

// Paths

test("the discovery document is served at both paths, CCP's first", () => {
  // CCP publishes the unslashed form; the EVE game client has the slashed one as
  // a literal in `clientRefreshToken/discovery_hacks.py` (D6).
  assert.deepEqual(DISCOVERY_PATHS, [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/",
  ]);
  assert.equal(DISCOVERY_PATHS[1], `${DISCOVERY_PATHS[0]}/`);
  assert.equal(new Set(DISCOVERY_PATHS).size, 2);
});

test("the OIDC probe path is recorded and is not one of the served ones", () => {
  assert.equal(OPENID_DISCOVERY_PATH, "/.well-known/openid-configuration");
  assert.ok(
    !DISCOVERY_PATHS.includes(OPENID_DISCOVERY_PATH),
    "whether we serve this is the route's decision; the contract must not make it by listing it",
  );
});

test("every path this file names is origin-relative and absolute", () => {
  const paths = [
    JWKS_PATH,
    OPENID_DISCOVERY_PATH,
    ...DISCOVERY_PATHS,
    ...Object.values(DISCOVERY_ENDPOINT_PATHS),
    ...VERIFY_PATHS,
    REVOKE_PATH,
  ];
  for (const value of paths) {
    assert.ok(value.startsWith("/"), `${value} should start with /`);
    assert.ok(!value.includes("://"), `${value} should be a path, not a URL`);
  }
});

// Verify and revoke.
//
// These endpoints have the least recorded about them. `contract/sso.js` has
// seven member names and not one member value, so almost everything below
// asserts that a choice was recorded as a choice rather than that CCP was
// reproduced.

test("verify is served at both spellings, and the legacy one is not under /v2/", () => {
  // The same shape as the JWKS mount, one endpoint over: a route table written
  // by pattern mounts only the first, and every tool written before CCP's JWT
  // migration gets a 404 from an endpoint that is right there.
  assert.deepEqual(VERIFY_PATHS, ["/v2/oauth/verify", "/oauth/verify"]);
  assert.ok(!VERIFY_PATHS[1].startsWith("/v2/"));
  assert.equal(new Set(VERIFY_PATHS).size, 2);

  // Referenced out of the discovery table rather than retyped, so
  // `userinfo_endpoint` and the mount cannot drift. The identity `jwks_uri` and
  // `JWKS_PATH` hold, for the same reason.
  assert.equal(VERIFY_PATHS[0], DISCOVERY_ENDPOINT_PATHS.userinfo);
  assert.equal(REVOKE_PATH, DISCOVERY_ENDPOINT_PATHS.revocation);
});

test("revoke has one spelling, and no symmetrical alias has been invented for it", () => {
  // `contract/sso.js` records a second spelling for verify and not for revoke. A path
  // served because it looked symmetrical is a path no client asked for.
  assert.equal(REVOKE_PATH, "/v2/oauth/revoke");
  assert.ok(!VERIFY_PATHS.includes(REVOKE_PATH));
});

test("verify's seven members are PascalCase, in the recorded order", () => {
  assert.deepEqual(VERIFY_MEMBER_ORDER, [
    "CharacterID",
    "CharacterName",
    "ExpiresOn",
    "Scopes",
    "TokenType",
    "CharacterOwnerHash",
    "IntellectualProperty",
  ]);

  for (const member of VERIFY_MEMBER_ORDER) {
    assert.match(member, /^[A-Z][A-Za-z]*$/, `${member} is PascalCase with no underscore`);
  }
  // `CharacterID` is `ID` and not `Id`, the character of this body most likely to
  // be silently "corrected".
  assert.ok(VERIFY_MEMBER_ORDER.includes("CharacterID"));
  assert.ok(!VERIFY_MEMBER_ORDER.includes("CharacterId"));
});

test("every member has a source, and every source is a claim we mint or a constant", () => {
  // Catches a member wired to a claim that does not exist, which no assertion
  // about a route alone would find.
  assert.deepEqual(asSet(Object.keys(VERIFY_MEMBER_SOURCES)), asSet(VERIFY_MEMBER_ORDER));

  for (const [member, source] of Object.entries(VERIFY_MEMBER_SOURCES)) {
    if (source === "constant") {
      assert.ok(
        Object.prototype.hasOwnProperty.call(VERIFY_CONSTANT_MEMBERS, member),
        `${member} is a constant and needs a value`,
      );
      continue;
    }
    assert.ok(
      ACCESS_TOKEN_CLAIM_ORDER.includes(source),
      `${member} reads the claim ${source}, which this replica does not mint`,
    );
  }

  assert.deepEqual(asSet(Object.keys(VERIFY_CONSTANT_MEMBERS)),
    asSet(["TokenType", "IntellectualProperty"]));
});

test("CharacterOwnerHash is the owner claim under its older name", () => {
  // Two names for one value drift, and the drift is silent in the worst
  // direction: a client that stored `CharacterOwnerHash` and later compares it
  // against a JWT's `owner` would discard a working refresh token for a character
  // whose ownership never changed.
  assert.equal(VERIFY_MEMBER_SOURCES.CharacterOwnerHash, "owner");
  assert.ok(ACCESS_TOKEN_VARIABLE_CLAIMS.includes("owner"), "so it varies per character");
  assert.equal(ACCESS_TOKEN_CLAIM_TYPES.owner, "string");
  // The shape a consumer stores is the same on both surfaces.
  assert.equal(ACCESS_TOKEN_OWNER.base64, "standard");
});

test("CharacterID comes from sub, and the recorded pattern reads it back", () => {
  assert.equal(VERIFY_MEMBER_SOURCES.CharacterID, "sub");
  const match = ACCESS_TOKEN_SUBJECT_PATTERN.exec(CCP_ACCESS_TOKEN_CLAIMS.sub);
  assert.notEqual(match, null);
  assert.ok(Number.isInteger(Number(match[1])));
});

test("every member's provenance is one of the three labels, and none is observed", () => {
  // The record holds seven names and no values, so `observed` is the count
  // this file is entitled to claim and it is zero. A later author who does capture
  // CCP's answer has to move the label as well as the value.
  assert.deepEqual(asSet(Object.keys(VERIFY_MEMBER_PROVENANCE)), asSet(VERIFY_MEMBER_ORDER));
  assert.deepEqual(VERIFY_PROVENANCE_LEVELS, ["observed", "inferred", "ours"]);

  for (const [member, level] of Object.entries(VERIFY_MEMBER_PROVENANCE)) {
    assert.ok(
      VERIFY_PROVENANCE_LEVELS.includes(level),
      `${member} carries ${JSON.stringify(level)}, which is not one of the three labels`,
    );
  }

  assert.ok(!Object.values(VERIFY_MEMBER_PROVENANCE).includes("observed"));
  // The three that would move on the wire the day somebody captures CCP's answer
  // are the three marked ours.
  assert.deepEqual(
    asSet(Object.entries(VERIFY_MEMBER_PROVENANCE)
      .filter(([, level]) => level === "ours")
      .map(([member]) => member)),
    asSet(["ExpiresOn", "Scopes", "IntellectualProperty"]),
  );
});

test("TokenType is Character and is not the token response's Bearer", () => {
  // Two members four characters apart with unrelated meanings: `token_type` in a
  // token response is the HTTP authentication scheme; this names the subject
  // namespace `ACCESS_TOKEN_SUBJECT_PREFIX` comes from.
  assert.equal(VERIFY_CONSTANT_MEMBERS.TokenType, "Character");
  assert.notEqual(VERIFY_CONSTANT_MEMBERS.TokenType, "Bearer");
  assert.ok(ACCESS_TOKEN_SUBJECT_PREFIX.startsWith("CHARACTER"));
  assert.equal(VERIFY_MEMBER_PROVENANCE.TokenType, "inferred");
});

test("IntellectualProperty is EVE, marked ours, and the gap is named", () => {
  assert.equal(VERIFY_CONSTANT_MEMBERS.IntellectualProperty, "EVE");
  assert.equal(VERIFY_MEMBER_PROVENANCE.IntellectualProperty, "ours");
  // The consistency argument, which is all there is: the same three letters
  // appear in the subject prefix and at the head of the audience literal.
  assert.ok(ACCESS_TOKEN_SUBJECT_PREFIX.includes("EVE"));
  assert.ok(ACCESS_TOKEN_AUDIENCE_LITERAL.startsWith("EVE"));
});

test("Scopes deliberately disagrees with scp, and the disagreement is written down", () => {
  // `lib/accessToken.js`'s array argument does not transfer to this body. A JWT
  // claim set is a new surface and this is the old one, whose consumers were
  // written against RFC 6749 section 3.3's `scope`.
  assert.equal(VERIFY_SCOPES.oursIsSpaceDelimitedString, true);
  assert.equal(ACCESS_TOKEN_SCP.oursAlwaysArray, true);
  assert.equal(VERIFY_SCOPES.delimiter, " ");
  assert.equal(VERIFY_SCOPES.emptyIsEmptyString, true);
  assert.equal(ACCESS_TOKEN_CLAIM_TYPES.scp, "string[]", "while the claim stays an array");
  assert.equal(VERIFY_MEMBER_PROVENANCE.Scopes, "ours");
});

test("ExpiresOn's recorded shape accepts only the form we emit", () => {
  const { pattern } = VERIFY_EXPIRES_ON;
  assert.match("2026-08-24T14:34:16", pattern);
  // The two spellings the argument rejects, and the expanded-year rendering a
  // blind slice would produce.
  assert.doesNotMatch("2026-08-24T14:34:16Z", pattern);
  assert.doesNotMatch("2026-08-24T14:34:16.000Z", pattern);
  assert.doesNotMatch("+010000-01-01T00:0", pattern);
  assert.doesNotMatch("2026-08-24 14:34:16", pattern);

  assert.equal(VERIFY_EXPIRES_ON.oursHasZoneDesignator, false);
  assert.equal(VERIFY_EXPIRES_ON.oursHasFractionalSeconds, false);
  assert.equal(VERIFY_EXPIRES_ON.oursIsUtc, true);
  // Derived from `exp`, which is a number of seconds, so there is never a
  // fraction to drop in the first place.
  assert.equal(VERIFY_MEMBER_SOURCES.ExpiresOn, "exp");
  assert.equal(ACCESS_TOKEN_CLAIM_TYPES.exp, "number");
});

test("a refusal on this pair is text/html, and carries no body this file claims to know", () => {
  // The one wire fact recorded about either endpoint, and
  // `routes/oauthToken.js` makes the same claim from the other side: it is the
  // only SSO endpoint answering in JSON errors.
  assert.equal(REFUSAL_CONTENT_TYPE, "text/html");
  assert.ok(!REFUSAL_CONTENT_TYPE.includes("charset"), "the parameter is unobserved");
  assert.ok(!REFUSAL_CONTENT_TYPE.includes("json"));
  // The body is in UNOBSERVED, not here: a content type reproduced without the
  // bytes it describes is half a reproduction.
  assert.ok(UNOBSERVED.verifyRefusalBody.includes("text/html"));
});

test("the token_type_hint values are RFC 7009's two, and only one is revocable here", () => {
  assert.deepEqual(asSet(REVOKE_TOKEN_TYPE_HINTS), asSet(["access_token", "refresh_token"]));
  assert.deepEqual(asSet(Object.keys(REVOKE_TOKEN_TYPES)), asSet(REVOKE_TOKEN_TYPE_HINTS));
  // A refresh token is a record in `lib/refreshTokens.js`; an access token is a
  // signed JWT this server never stores.
  assert.equal(REVOKE_TOKEN_TYPES.refresh_token, true);
  assert.equal(REVOKE_TOKEN_TYPES.access_token, false);
});

test("the verify and revoke gaps are named with the request that would close them", () => {
  for (const name of ["verifyMemberValues", "verifyRefusalBody", "revokeResponseShape"]) {
    assert.equal(typeof UNOBSERVED[name], "string", `${name} must hold prose, never a value`);
  }
  // Two of the three are settled by one `curl` each, and the file says so.
  assert.ok(UNOBSERVED.verifyMemberValues.includes("curl"));
  assert.ok(UNOBSERVED.verifyRefusalBody.includes("curl"));
  // The one that is not says why: it needs a credential and a token to throw
  // away.
  assert.ok(UNOBSERVED.revokeResponseShape.includes("credential"));
});

// The access token's claim shape.
//
// Same discipline as the two documents above: these assertions prove the
// constants are self-consistent and that the recorded transcription can be
// rebuilt from the decomposed tables. They prove nothing about CCP.
//
// `test/accessToken.test.js` is the other half: it holds a minted token against
// these constants, which is where the claim shape stops being a table and
// becomes bytes.

test("the JOSE header is the three observed members, and its kid and alg are the JWKS's", () => {
  assert.deepEqual(ACCESS_TOKEN_JOSE_HEADER_MEMBER_ORDER, ["alg", "kid", "typ"]);
  assert.deepEqual(Object.keys(ACCESS_TOKEN_JOSE_HEADER), ACCESS_TOKEN_JOSE_HEADER_MEMBER_ORDER);

  // A header naming a kid the published document does not carry is a token every
  // validator rejects, with a message about the signature.
  assert.equal(ACCESS_TOKEN_JOSE_HEADER.kid, JWKS_KID);
  assert.equal(ACCESS_TOKEN_JOSE_HEADER.alg, JWKS_ALG);
  assert.equal(ACCESS_TOKEN_JOSE_HEADER.typ, "JWT");
});

test("kid appears in the JOSE header and again in the body", () => {
  // Redundant by every JOSE rule and present in CCP's record, so present in ours.
  // A maintainer could remove the body copy as duplication.
  assert.equal(ACCESS_TOKEN_JOSE_HEADER.kid, CCP_ACCESS_TOKEN_CLAIMS.kid);
  assert.equal(ACCESS_TOKEN_CONSTANT_CLAIMS.kid, JWKS_KID);
  assert.ok(ACCESS_TOKEN_CLAIM_ORDER.includes("kid"));
});

test("sub is CHARACTER:EVE:<id>, and the consumer's regex is recorded with it", () => {
  assert.equal(ACCESS_TOKEN_SUBJECT_PREFIX, "CHARACTER:EVE:");
  assert.equal(CCP_ACCESS_TOKEN_CLAIMS.sub, `${ACCESS_TOKEN_SUBJECT_PREFIX}123123`);

  const match = ACCESS_TOKEN_SUBJECT_PATTERN.exec(CCP_ACCESS_TOKEN_CLAIMS.sub);
  assert.ok(match, "the recorded subject must match the regex the ecosystem parses it with");
  assert.equal(match[1], "123123");

  // The two spellings that read as "no character" rather than "bad token".
  assert.equal(ACCESS_TOKEN_SUBJECT_PATTERN.exec("123123"), null);
  assert.equal(ACCESS_TOKEN_SUBJECT_PATTERN.exec("CHARACTER:TQ:123123"), null);
});

test("aud is an array of exactly two, the second the literal EVE Online", () => {
  assert.equal(ACCESS_TOKEN_AUDIENCE_LITERAL, "EVE Online");
  assert.ok(Array.isArray(CCP_ACCESS_TOKEN_CLAIMS.aud));
  assert.equal(CCP_ACCESS_TOKEN_CLAIMS.aud.length, 2);
  assert.equal(CCP_ACCESS_TOKEN_CLAIMS.aud[1], ACCESS_TOKEN_AUDIENCE_LITERAL);
  // The client id is the first entry and the `azp` claim is the same string.
  assert.equal(CCP_ACCESS_TOKEN_CLAIMS.aud[0], CCP_ACCESS_TOKEN_CLAIMS.azp);
  // A space and a capital O: tools match this literal to decide whether a token
  // came from EVE SSO at all.
  assert.ok(ACCESS_TOKEN_AUDIENCE_LITERAL.includes(" "));
});

test("iss is the one claim we deliberately do not match, and the record says why", () => {
  // CCP's is a bare hostname; D7 requires an explicit scheme because D1 serves
  // plain HTTP on a non-standard port and the EVE client supplies `https` to a
  // scheme-less iss. This assertion is aimed at a future "restore fidelity"
  // commit.
  assert.equal(ACCESS_TOKEN_ISS.ccp, "login.eveonline.com");
  assert.equal(ACCESS_TOKEN_ISS.ccpHasScheme, false);
  assert.ok(!ACCESS_TOKEN_ISS.ccp.includes("://"));
  assert.equal(CCP_ACCESS_TOKEN_CLAIMS.iss, ACCESS_TOKEN_ISS.ccp);

  // CCP does not keep iss and issuer equal; D7 collapses ours into one value.
  assert.notEqual(CCP_ACCESS_TOKEN_CLAIMS.iss, SSO_ORIGIN);
  assert.equal(SSO_ORIGIN, `https://${ACCESS_TOKEN_ISS.ccp}`);

  // There is no value for ours here, deliberately: the issuer is configuration,
  // and a value pasted into a contract module would pin one deployment's
  // transport.
  assert.equal(ACCESS_TOKEN_ISS.oursIsConfiguredIssuer, true);
  assert.equal(Object.values(ACCESS_TOKEN_ISS).includes("http://"), false);
  for (const value of Object.values(ACCESS_TOKEN_ISS)) {
    if (typeof value === "string") {
      assert.ok(!value.includes("://"), "no absolute URL belongs in this record");
    }
  }
});

test("scp's recorded type and the disagreement between its two recordings are both written down", () => {
  assert.equal(ACCESS_TOKEN_SCP.ccpSingleScopeIsBareString, true);
  assert.equal(ACCESS_TOKEN_SCP.ccpReproducedBodyIsArray, true);
  assert.equal(ACCESS_TOKEN_SCP.oursAlwaysArray, true);

  // The reproduced body is the evidence for the second of those.
  assert.ok(Array.isArray(CCP_ACCESS_TOKEN_CLAIMS.scp));
  assert.equal(CCP_ACCESS_TOKEN_CLAIMS.scp.length, 1);
  assert.equal(ACCESS_TOKEN_CLAIM_TYPES.scp, "string[]");

  // The disagreement is named as an open question rather than resolved by
  // whichever of the two got written down last.
  assert.equal(typeof UNOBSERVED.accessTokenScpSingleScope, "string");
});

test("owner is standard base64, and the sample is the evidence for the length", () => {
  assert.equal(ACCESS_TOKEN_OWNER.base64, "standard");
  assert.equal(ACCESS_TOKEN_OWNER.padded, true);
  assert.equal(ACCESS_TOKEN_OWNER.sample, CCP_ACCESS_TOKEN_CLAIMS.owner);
  assert.equal(ACCESS_TOKEN_OWNER.sample.length, ACCESS_TOKEN_OWNER.characters);
  assert.equal(Buffer.from(ACCESS_TOKEN_OWNER.sample, "base64").length, ACCESS_TOKEN_OWNER.bytes);

  // The `/` proves the alphabet is RFC 4648 section 4 and not section 5's
  // URL-safe one, which every other segment of the token around it uses.
  assert.ok(ACCESS_TOKEN_OWNER.sample.includes("/"));
  assert.ok(ACCESS_TOKEN_OWNER.sample.endsWith("="));

  // What CCP hashes is not recorded, and that gap has an export rather than a
  // guess: an implementation needs the input, and 20 bytes only names a digest
  // length.
  assert.equal(typeof UNOBSERVED.accessTokenOwnerHashInput, "string");
});

test("exp minus iat is exactly 1200 on the recorded token", () => {
  assert.equal(ACCESS_TOKEN_LIFETIME_SECONDS, 1200);
  assert.equal(
    CCP_ACCESS_TOKEN_CLAIMS.exp - CCP_ACCESS_TOKEN_CLAIMS.iat,
    ACCESS_TOKEN_LIFETIME_SECONDS,
  );
  // Numbers, not numeric strings: a serializer handed a Date produces an ISO
  // string that parses as a JWT and expires never.
  assert.equal(typeof CCP_ACCESS_TOKEN_CLAIMS.exp, "number");
  assert.equal(typeof CCP_ACCESS_TOKEN_CLAIMS.iat, "number");
});

test("the constant and variable halves cover the claim order exactly", () => {
  const halves = [...Object.keys(ACCESS_TOKEN_CONSTANT_CLAIMS), ...ACCESS_TOKEN_VARIABLE_CLAIMS];

  assert.deepEqual(
    asSet(halves),
    asSet(ACCESS_TOKEN_CLAIM_ORDER),
    "a claim in neither half has no source of truth; a claim in neither order is unminted",
  );
  assert.equal(new Set(halves).size, halves.length, "no claim may be constant and variable");
  assert.equal(new Set(ACCESS_TOKEN_CLAIM_ORDER).size, ACCESS_TOKEN_CLAIM_ORDER.length);
});

test("every claim has a recorded type, and no type describes a claim that is not minted", () => {
  assert.deepEqual(asSet(Object.keys(ACCESS_TOKEN_CLAIM_TYPES)), asSet(ACCESS_TOKEN_CLAIM_ORDER));
  for (const [claim, type] of Object.entries(ACCESS_TOKEN_CLAIM_TYPES)) {
    assert.ok(
      ["string", "number", "string[]"].includes(type),
      `${claim} has type ${type}; the spellings are deliberately crude, see the constant`,
    );
  }
});

test("the constant claims carry D26's tenant and CCP's topology strings", () => {
  assert.deepEqual(ACCESS_TOKEN_CONSTANT_CLAIMS, {
    kid: "JWT-Signature-Key",
    tenant: "tranquility",
    tier: "live",
    region: "world",
  });
  // Flat strings, and some tools assert on `tenant`. D26 gives it no knob.
  for (const value of Object.values(ACCESS_TOKEN_CONSTANT_CLAIMS)) {
    assert.equal(typeof value, "string");
  }
});

test("the claim order is the recorded one, with the two quirks a re-sort destroys", () => {
  assert.deepEqual(ACCESS_TOKEN_CLAIM_ORDER, [
    "scp", "jti", "kid", "sub", "azp", "tenant", "tier", "region",
    "aud", "name", "owner", "exp", "iat", "iss",
  ]);

  // `kid` sits in the body between `jti` and `sub`, not beside the header's copy,
  // and `exp` precedes `iat`.
  assert.equal(ACCESS_TOKEN_CLAIM_ORDER.indexOf("jti") + 1, ACCESS_TOKEN_CLAIM_ORDER.indexOf("kid"));
  assert.ok(
    ACCESS_TOKEN_CLAIM_ORDER.indexOf("exp") < ACCESS_TOKEN_CLAIM_ORDER.indexOf("iat"),
    "exp before iat, which is the opposite of every other timestamp pair here",
  );
});

test("the recorded token's members and types are exactly what the tables say", () => {
  assert.deepEqual(
    Object.keys(CCP_ACCESS_TOKEN_CLAIMS),
    ACCESS_TOKEN_CLAIM_ORDER,
    "the transcription of record is what the decomposed tables are checked against",
  );

  for (const [claim, type] of Object.entries(ACCESS_TOKEN_CLAIM_TYPES)) {
    const value = CCP_ACCESS_TOKEN_CLAIMS[claim];
    if (type === "string[]") {
      assert.ok(Array.isArray(value), `${claim} should be an array`);
      for (const item of value) assert.equal(typeof item, "string");
    } else {
      assert.equal(typeof value, type, `${claim} should be a ${type}`);
    }
  }

  // The constant half is compared by value; the variable half only by type,
  // because its values are somebody's.
  for (const [claim, expected] of Object.entries(ACCESS_TOKEN_CONSTANT_CLAIMS)) {
    assert.equal(CCP_ACCESS_TOKEN_CLAIMS[claim], expected);
  }
});

test("the two redacted members are kept as placeholders, not filled in", () => {
  // A redaction replaced by a plausible value is a fabricated observation, which
  // contract/ may never contain.
  assert.deepEqual(CCP_ACCESS_TOKEN_PLACEHOLDERS, ["jti", "azp"]);
  for (const claim of CCP_ACCESS_TOKEN_PLACEHOLDERS) {
    const value = CCP_ACCESS_TOKEN_CLAIMS[claim];
    assert.match(value, /^<[a-z_]+>$/, `${claim} is redacted in the record and must stay so`);
  }
  assert.equal(CCP_ACCESS_TOKEN_CLAIMS.aud[0], CCP_ACCESS_TOKEN_CLAIMS.azp);
  // A placeholder jti is not a UUID, so nothing may assert one here. The shape
  // belongs to the minter's test, against a token it actually produced.
  assert.ok(!/^[0-9a-f-]{36}$/i.test(CCP_ACCESS_TOKEN_CLAIMS.jti));
});

// Serving requirements, and the gaps

test("both documents are unauthenticated, CORS-open and cacheable", () => {
  // Requirements in words, not observed bytes. Both documents are public by
  // definition; a token in front of either makes the surface undiscoverable in a
  // way no client can report.
  for (const [name, rules] of Object.entries(SERVING)) {
    assert.equal(rules.authenticated, false, `${name} must not require a token`);
    assert.equal(rules.cors, true, `${name} must be CORS-open`);
    assert.equal(rules.cacheable, true, `${name} must be cacheable`);
  }
  assert.deepEqual(asSet(Object.keys(SERVING)), asSet([JWKS_PATH, "discovery"]));
  assert.equal(SERVING[JWKS_PATH].clientsCacheByKid, true);
});

test("the unobserved questions are named, and hold no values to be mistaken for facts", () => {
  const expected = [
    "accessTokenOwnerHashInput",
    "accessTokenScpSingleScope",
    "cacheHeaders",
    "contentType",
    "openidConfigurationStatus",
    "revokeResponseShape",
    "trailingNewline",
    "vary",
    "verifyMemberValues",
    "verifyRefusalBody",
  ];
  assert.deepEqual(asSet(Object.keys(UNOBSERVED)), expected);

  for (const [name, reason] of Object.entries(UNOBSERVED)) {
    assert.equal(typeof reason, "string", `${name} must hold prose, never a value`);
    assert.ok(reason.length > 40, `${name} should say what would establish it`);
  }
});

test("no header spelling has crept in under cover of the serving rules", () => {
  // Guards against filling `contentType` in from `contract/wire.js`, whose tables
  // are facts about esi.evetech.net's producers and were never checked against
  // login.eveonline.com.
  const serialized = JSON.stringify(SERVING);
  for (const spelling of ["application/json", "max-age", "Etag", "charset"]) {
    assert.ok(
      !serialized.includes(spelling),
      `${spelling} is unobserved on this origin; it belongs in UNOBSERVED, not SERVING`,
    );
  }
});

// Freezing

test("every exported constant is deeply frozen", () => {
  const seen = new Set();
  const walk = (value, where) => {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    assert.ok(Object.isFrozen(value), `${where} is not frozen`);
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${where}[${index}]`));
    } else {
      for (const [key, item] of Object.entries(value)) walk(item, `${where}.${key}`);
    }
  };

  assert.ok(Object.isFrozen(sso), "module.exports itself must be frozen");
  walk(sso, "sso");
});

test("the module exports the names the route modules were written against", () => {
  // Renaming one of these is a four-file change made in one file, and the other
  // three are somebody else's. Pinned so the break is here rather than there.
  assert.deepEqual(asSet(Object.keys(sso)), asSet([
    "ESTABLISHED",
    "SSO_ORIGIN",
    "JWKS_PATH",
    "JWKS_KID",
    "JWKS_ALG",
    "JWKS_KEY_MEMBER_ORDER",
    "JWKS_KEY_CONSTANTS",
    "JWKS_KEY_MATERIAL_MEMBERS",
    "JWKS_MEMBER_ORDER",
    "JWKS_SKIP_UNRESOLVED_MEMBER",
    "JWKS_SKIP_UNRESOLVED_VALUE",
    "JWKS_CCP_EXTRA_ALGS",
    "DISCOVERY_PATHS",
    "OPENID_DISCOVERY_PATH",
    "DISCOVERY_ENDPOINT_PATHS",
    "DISCOVERY_ENDPOINT_MEMBERS",
    "DISCOVERY_ISSUER_DERIVED_MEMBERS",
    "DISCOVERY_CONSTANTS",
    "DISCOVERY_MEMBER_ORDER",
    "CCP_DISCOVERY_DOCUMENT",
    "VERIFY_PATHS",
    "REVOKE_PATH",
    "VERIFY_MEMBER_ORDER",
    "VERIFY_MEMBER_SOURCES",
    "VERIFY_PROVENANCE_LEVELS",
    "VERIFY_MEMBER_PROVENANCE",
    "VERIFY_CONSTANT_MEMBERS",
    "VERIFY_SCOPES",
    "VERIFY_EXPIRES_ON",
    "REFUSAL_CONTENT_TYPE",
    "REVOKE_TOKEN_TYPE_HINTS",
    "REVOKE_TOKEN_TYPES",
    "ACCESS_TOKEN_JOSE_HEADER",
    "ACCESS_TOKEN_JOSE_HEADER_MEMBER_ORDER",
    "ACCESS_TOKEN_SUBJECT_PREFIX",
    "ACCESS_TOKEN_SUBJECT_PATTERN",
    "ACCESS_TOKEN_AUDIENCE_LITERAL",
    "ACCESS_TOKEN_LIFETIME_SECONDS",
    "ACCESS_TOKEN_SCP",
    "ACCESS_TOKEN_ISS",
    "ACCESS_TOKEN_OWNER",
    "ACCESS_TOKEN_CLAIM_ORDER",
    "ACCESS_TOKEN_CLAIM_TYPES",
    "ACCESS_TOKEN_CONSTANT_CLAIMS",
    "ACCESS_TOKEN_VARIABLE_CLAIMS",
    "CCP_ACCESS_TOKEN_CLAIMS",
    "CCP_ACCESS_TOKEN_PLACEHOLDERS",
    "SERVING",
    "UNOBSERVED",
  ]));
});
