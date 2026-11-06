/**
 * eve.js-mod-esi: minting the access token, in CCP's exact claim shape.
 *
 * Unlike every other surface here, a token leaves the building and is decoded by software we
 * never see: `jose`, `python-jose`, `jsonwebtoken`, the EVE client's own Python, and
 * hand-rolled `split(".")[1]` readers. None call a verify endpoint. The claim shape is the
 * interface, and getting it wrong yields a client that authenticates and then behaves as though
 * the character does not exist. This file reproduces a recorded CCP token member for member,
 * including parts that look like bugs, and diverges in exactly one place, `iss` (D7).
 *
 * It builds claims and signs them. It does not read game state, speak HTTP, decide who may have
 * a token, or store anything. `lib/runtimeAccess.js` is the only module that reaches the game,
 * `lib/sessionIdentity.js` is the only unforgeable source of a character, and
 * `POST /v2/oauth/token` is the only place a grant becomes a call to `mint`. Everything else
 * (clock, `jti`, ownership inputs) arrives as an argument, so `test/accessToken.test.js` pins a
 * token to the byte.
 *
 * It does not mint refresh tokens. D8 relies on them being opaque and stored rather than signed
 * by the RSA key, so a key rotation costs a client one refresh instead of a re-authorisation.
 *
 * Eight things about the recorded token break a real client if "cleaned up", and each is
 * asserted by name in `test/accessToken.test.js` against the decoded token:
 *
 *   1. `sub` is `CHARACTER:EVE:<id>` (`SUBJECT_PREFIX`).
 *   2. `aud` is an array of exactly two entries, the second the literal `EVE Online`
 *      (`AUDIENCE_LITERAL`).
 *   3. `iss` is the one deliberate divergence (below).
 *   4. `kid` appears in the JOSE header and in the body (`buildAccessTokenClaims`).
 *   5. `scp` is always an array here (below, `normalizeScopes`).
 *   6. `owner` is standard base64, not base64url (`ownerHashFor`).
 *   7. `exp - iat` is exactly `LIFETIME_SECONDS`.
 *   8. `tenant`, `tier` and `region` are flat strings (below).
 *
 * `iss` (3). The recorded token carries `iss: "login.eveonline.com"`, a bare hostname. The EVE
 * client takes `iss`, rewrites it into a discovery URL and fetches `token_endpoint` from the
 * result on every launch. The rewrite supplies `https` when `iss` has no scheme, which is
 * invisible at CCP. D1 puts this replica on plain HTTP on a non-standard port, and both
 * scheme-less spellings fail: a bare `host.local:26006` parses as scheme `host.local`, and a
 * bare `host.local` loses the port. The rewrite also discards any path. So `iss` is the
 * configured issuer string verbatim: absolute URL, explicit `http`/`https` scheme, no trailing
 * slash, no path (D7, with the evidence in `docs/d6-listener-split.md`). It is an argument, not
 * derived from a bind address, because a derived issuer welds every token to today's transport.
 * `assertIssuer` enforces the shape at construction. `contract/sso.js` `ACCESS_TOKEN_ISS`
 * records CCP's bare hostname, and `test/ssoWire.test.js` asserts the two differ as D7 requires.
 *
 * `scp` (5). CCP emits a bare string for exactly one scope and an array for more, the usual
 * source of `TypeError: scopes.map is not a function`. This replica always emits an array.
 * Every consumer handles the array branch, since a two-scope token is ordinary, whereas one that
 * handled only the bare string would break against CCP on the second scope.
 *
 * `tenant` (8) is `tranquility`, imported from `lib/tenant.js` (D26: the set of valid
 * datasources is shrinking, so a replica with its own name would be differently shaped from
 * CCP). The import pulls `lib/errors.js` and `lib/serialize.js` in behind it. D6 keeps the ESI
 * pipeline off SSO traffic (error budget, token bucket, cache layer), not the module graph, and
 * nothing here calls into any of them.
 *
 * `CLAIM_ORDER` drives insertion, so the payload's member order is the recorded one. JSON member
 * order is semantically irrelevant and no known consumer depends on it, but it costs one array to
 * match and driving it from an array makes the order visibly protocol.
 *
 * Minting is synchronous: one RSA-2048 PKCS1 v1.5 signature (about a millisecond) on the game's
 * event loop (design constraint 2), once per login and once per twenty minutes per client.
 * If the token endpoint ever becomes hot, rate-limit it rather than adding a callback here.
 */

"use strict";

const crypto = require("node:crypto");

const { TENANT } = require("./tenant");

// The JOSE header

/**
 * `{"alg":"RS256","kid":"JWT-Signature-Key","typ":"JWT"}`, in that order.
 *
 * `alg` is a literal, not read off the injected key: it must describe what this file does
 * (`crypto.sign("sha256", ...)` against an RSA key is RS256 and nothing else). The key's own
 * published `alg` is cross-checked at construction instead; see `assertSigningKey`.
 *
 * `kid` is not a literal and this file contains no spelling of `JWT-Signature-Key`. It comes
 * from the injected key set member, so the header, the body and the published JWKS share one
 * source (D8's single signing slot).
 */
const JOSE_ALG = "RS256";
const JOSE_TYP = "JWT";
const JOSE_HEADER_MEMBER_ORDER = Object.freeze(["alg", "kid", "typ"]);

/** The Node digest and key type that `JOSE_ALG` is the JOSE spelling of. */
const SIGNATURE_DIGEST = "sha256";
const SIGNATURE_KEY_TYPE = "rsa";

// The claims

/**
 * `sub`, and the only subject form this replica emits.
 *
 * `CHARACTER:EVE:123123`. Consumers parse it with `/CHARACTER:EVE:(\d+)/i`
 * (`contract/sso.js` `ACCESS_TOKEN_SUBJECT_PATTERN`), so a bare integer, a `CORPORATION:EVE:` or
 * `CHARACTER:TQ:` prefix does not match, and the failure surfaces in the consumer as "no
 * character id", never "bad token". The namespace is CCP's: its SSO issues tokens for things
 * that are not characters, and this replica spells characters the same way.
 */
const SUBJECT_PREFIX = "CHARACTER:EVE:";

/**
 * The second `aud` entry: two words, a space and a capital `O`.
 *
 * `aud` is `[<client_id>, "EVE Online"]`, an array of exactly two, never a bare string even
 * though RFC 7519 section 4.1.3 permits one. Validators that call `aud.includes(...)` and ones
 * configured with an expected-audience list both break on the string form. Some tools match the
 * literal to decide whether a token came from EVE SSO at all, so `"EVE-Online"`, `"eve online"`
 * and `"EVE"` are each a different service to them.
 */
const AUDIENCE_LITERAL = "EVE Online";

/**
 * `tier` and `region`, flat strings, exactly as recorded.
 *
 * They describe CCP's deployment topology and mean nothing on a private server, which is why
 * they are reproduced rather than dropped: the acceptance check compares claim sets, and a
 * missing member counts the same as an invented one.
 */
const TIER = "live";
const REGION = "world";

/**
 * `exp - iat`, in seconds, and exact.
 *
 * Twenty minutes. `docs/d6-listener-split.md` builds its migration story on it (an issuer change
 * or key rotation self-heals because an access token lives 1200 seconds and the refresh token is
 * not signed by the key), and `routes/oauthJwks.js` sizes its `max-age` against it. Clients
 * schedule refresh at `iat + expires_in - slack`, and the token endpoint's `expires_in` is this
 * number.
 */
const LIFETIME_SECONDS = 1200;

/**
 * The payload's member order, as recorded. See the header.
 *
 * `kid` sits in the body between `jti` and `sub` rather than beside the JOSE header's copy, and
 * `exp` precedes `iat`. A tidy-up destroys both.
 */
const CLAIM_ORDER = Object.freeze([
  "scp",
  "jti",
  "kid",
  "sub",
  "azp",
  "tenant",
  "tier",
  "region",
  "aud",
  "name",
  "owner",
  "exp",
  "iat",
  "iss",
]);

// `owner`: the one claim this replica has to design

/**
 * How many bytes of digest the `owner` claim carries, and why it is truncated.
 *
 * CCP's recorded value is 28 base64 characters with one pad, therefore 20 bytes: a SHA-1 digest
 * length, and very likely SHA-1. `contract/sso.js` `UNOBSERVED.accessTokenOwnerHashInput` records
 * that as an inference, since nothing here has seen CCP's input.
 *
 * We take 20 bytes off an HMAC-SHA-256 instead, so the value has the expected length, alphabet
 * and padding (a fixed-width column or a `length === 28` check behaves) on a construction
 * nobody has to defend. 160 bits is ample for a claim whose job is inequality.
 */
const OWNER_HASH_BYTES = 20;

/**
 * The domain separation tag mixed into every `owner` hash.
 *
 * It keeps this HMAC's outputs disjoint from any other use of the same salt. The `/v1` versions
 * the derivation: changing it changes every `owner` on the server, and clients invalidate stored
 * tokens when `owner` changes, so that is a fleet-wide re-authorisation.
 */
// A former project name, kept: it is hashed into every `owner` claim, so
// changing it would read to every client as a transfer of every character.
const OWNER_DOMAIN = "evej-esi_sso/owner/v1";

/** Standard base64, padded, not base64url. See `ownerHashFor`. */
const OWNER_ENCODING = "base64";

/**
 * The floor on an owner salt, in characters.
 *
 * Not a security threshold (16 characters of anything is not 128 bits) but a refusal of obvious
 * placeholders, so `ownerSalt: "salt"` fails at startup. The real requirement is
 * `generateOwnerSalt()`'s 32 random bytes.
 */
const MINIMUM_OWNER_SALT_LENGTH = 16;

// Refusals

/**
 * Every way this module declines, named and carrying its own sentence.
 *
 * Thrown rather than returned, the opposite of `lib/authCodes.js`, whose checks run on the
 * request path in front of every identity check, where a throw is a denial of service. Everything
 * here is a construction-time programming error (a missing clock, a malformed issuer, a key that
 * cannot sign) or an argument the caller built from an already validated session. A minter that
 * refuses costs a failed login; one that mints a subtly wrong token costs a client that
 * misbehaves for twenty minutes.
 *
 * `POST /v2/oauth/token` is the caller and catches this, as the SSO listener's startup catches
 * `SigningKeyError`.
 */
class AccessTokenError extends Error {
  constructor(message) {
    super(`[EsiApiMod] ${message}`);
    this.name = "AccessTokenError";
  }
}

// Pure: the ownership hash

/**
 * A fresh owner salt: 32 CSPRNG bytes as hex.
 *
 * Exported here because the salt is defined by what it is for. Whoever wires the SSO listener
 * must persist it (see `ownerHashFor` for the cost of losing it), beside the signing key, in the
 * durable sibling of the game store that D8 chose.
 */
function generateOwnerSalt() {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Pure core: the `owner` claim, from the character and the account owning it.
 *
 * What the claim is for. `owner` is how a client discovers that a stored token no longer
 * describes the same relationship. Consumers remember the `owner` seen at authorisation and, if
 * a later token for the same `sub` carries a different one, discard the stored refresh token and
 * re-authorise. At CCP the trigger is a character transfer. So the claim must be stable while
 * ownership is unchanged and must change when it changes: a flickering value logs everybody out,
 * a constant one defeats the mechanism silently.
 *
 * What we hash: `HMAC-SHA256(salt, "<domain>\n<subject>\n<account>")`, truncated to 20 bytes,
 * standard base64. The account id comes from the game session (`lib/sessionIdentity.js` reads
 * `accountID` alongside `characterID`), and a character appearing under a different account is
 * the eve.js event matching CCP's ownership transfer.
 *
 * Detected: the character moves to another account, which is all CCP's own hash detects.
 *
 * Not detected:
 *
 *   - An account changing hands without changing id (a player handing over a password). CCP's
 *     hash has the same blind spot, but this is the likeliest way ownership changes on a private
 *     server.
 *   - A character id reused after deletion. eve.js allocates ids per entity kind (D9), so a
 *     recycled id on the same account yields the same `owner` as the deleted character; the
 *     token's twenty-minute `exp` bounds that, not this claim.
 *   - A name change, deliberately: `name` is its own claim, CCP's hash does not cover it, and
 *     forcing re-authorisation over a rename is worse than a stale display name.
 *
 * Derived, never stored. There is no owner-hash table in this mod and there must not be one: a
 * stored copy of a fact the session already carries can go stale and report an ownership that
 * ended months ago.
 *
 * Why there is a salt. The account id is a small integer, so an unsalted hash of a known
 * character id and an unknown small integer is an encoding: anyone holding a token can
 * enumerate the account space in milliseconds and read the account id from the claim. The HMAC
 * key closes that, so it is an argument and the caller persists it. The salt is the one thing
 * that must survive a restart for `owner` to mean anything: losing it changes every owner claim,
 * which every client reads as every character having changed hands.
 *
 * It must not be the signing key. D8 makes rotation a deliberate break and buys its
 * affordability with a promise: a rotation costs a client one failed request and one refresh,
 * never a re-authorisation. Deriving `owner` from the signing key would repeal that promise.
 *
 * Standard base64 (RFC 4648 section 4: `+`, `/`, `=`), not the URL-safe alphabet. This is the
 * claim most likely to be "fixed", since the rest of a JWT is base64url, but CCP's recorded value
 * contains a `/` and clients compare stored owner hashes as strings. The mechanical hazard is one
 * word wide: `Buffer.toString("base64url")` sits beside `Buffer.toString("base64")` and differs
 * only for digests containing `+` or `/`. `test/accessToken.test.js` therefore searches for
 * inputs producing each distinguishing character rather than trusting one sample.
 */
function ownerHashFor({ characterId, accountId, salt } = {}) {
  const character = assertPositiveInteger(characterId, "characterId");
  const account = assertPositiveInteger(
    accountId,
    "accountId",
    "An owner claim derived from unknown ownership is a claim that changes the moment ownership "
      + "becomes known, and every client reads that change as a character transfer. Refusing to "
      + "mint is cheaper than a spurious fleet-wide re-authorisation.",
  );
  assertOwnerSalt(salt);

  const message = `${OWNER_DOMAIN}\n${SUBJECT_PREFIX}${character}\nACCOUNT:${account}`;
  return crypto
    .createHmac(SIGNATURE_DIGEST, salt)
    .update(message, "utf8")
    .digest()
    .subarray(0, OWNER_HASH_BYTES)
    .toString(OWNER_ENCODING);
}

// Pure: the claim set

/**
 * `scp`, always an array, never a bare string. See the header.
 *
 * A space-delimited string is accepted as input because that is OAuth's wire form for `scope`,
 * and what `lib/authCodes.js` recorded verbatim off the authorization request. Splitting on runs
 * of whitespace rather than a single space means a stray tab or trailing space yields what the
 * client meant instead of an empty scope name.
 *
 * Order is preserved and duplicates are not removed. `lib/authCodes.js` records the requested
 * scope verbatim on the same principle: this module is not where a scope set is decided, and
 * whether a scope may be granted at all is the token endpoint's question.
 */
function normalizeScopes(scopes) {
  if (scopes === undefined || scopes === null) return [];

  let list;
  if (Array.isArray(scopes)) {
    list = scopes;
  } else if (typeof scopes === "string") {
    list = scopes.split(/\s+/).filter((scope) => scope !== "");
  } else {
    throw new AccessTokenError(
      `scopes must be an array of strings or a space-delimited string, not ${describe(scopes)}.`,
    );
  }

  for (const scope of list) {
    if (typeof scope !== "string" || scope === "") {
      throw new AccessTokenError(
        `every scope must be a non-empty string; got ${describe(scope)}. An empty scope name `
          + "reaches a consumer as a permission that matches nothing and is never granted.",
      );
    }
  }

  return list;
}

/**
 * Pure core: everything a token says, with no key in sight.
 *
 * Split from signing so that "a recorded real CCP token and one of ours differ only in values,
 * never in claim set or types" is a statement about this function's output, testable without
 * generating an RSA key. `test/accessToken.test.js` diffs the result against
 * `contract/sso.js` `CCP_ACCESS_TOKEN_CLAIMS`, key for key and type for type.
 *
 * `issuedAt` is epoch seconds, because `iat` and `exp` are (RFC 7519 section 4.1.4).
 * `createAccessTokenMinter` takes a `now()` in milliseconds, like every clock in this mod, and
 * divides once, at that boundary. A token whose `exp` is a thousand times too far away
 * validates happily for thirty-eight years and nothing about it looks wrong.
 *
 * Nothing may be `undefined`. `JSON.stringify` silently drops such a member, so a claim that
 * failed to arrive would yield a valid token with thirteen claims. Every claim is checked before
 * serializing, which is `lib/serialize.js`'s rule about projection getters, applied on a
 * surface that cannot use `projection()`.
 */
function buildAccessTokenClaims({
  characterId,
  characterName,
  ownerHash,
  clientId,
  scopes,
  issuer,
  kid,
  jti,
  issuedAt,
  lifetimeSeconds = LIFETIME_SECONDS,
} = {}) {
  const character = assertPositiveInteger(characterId, "characterId");
  const name = assertNonEmptyString(characterName, "characterName");
  const owner = assertNonEmptyString(ownerHash, "ownerHash");
  const azp = assertNonEmptyString(clientId, "clientId");
  const iss = assertIssuer(issuer);
  const keyId = assertNonEmptyString(kid, "kid");
  const tokenId = assertNonEmptyString(jti, "jti");
  const iat = assertNonNegativeInteger(issuedAt, "issuedAt");
  const lifetime = assertPositiveInteger(lifetimeSeconds, "lifetimeSeconds");

  const source = {
    scp: Object.freeze(normalizeScopes(scopes)),
    jti: tokenId,
    // Claim 4: the same `kid` in the body as in the JOSE header. It is redundant
    // by every JOSE rule (a validator selects the key from the header) and it is
    // in CCP's recorded body, so it is in ours. Tools that read it from the
    // payload find it where they found it at CCP.
    kid: keyId,
    sub: `${SUBJECT_PREFIX}${character}`,
    // `azp` is load-bearing beyond audience checking: the EVE client reads it
    // back out of the token and uses it as the `client_id` for its own refresh
    // calls (`docs/d6-listener-split.md`). A wrong `azp` produces a refresh
    // request for a client that does not exist, twenty minutes after a login that
    // appeared to work.
    azp,
    tenant: TENANT,
    tier: TIER,
    region: REGION,
    // Claim 2: exactly two entries, the client first, the literal second.
    aud: Object.freeze([azp, AUDIENCE_LITERAL]),
    name,
    owner,
    // Claim 7: `exp - iat` is exactly `lifetimeSeconds`, computed by addition from
    // one `iat` rather than two clock reads. Two reads of `now()` either side of
    // a signature is how a token acquires a 1199-second lifetime nobody can
    // reproduce.
    exp: iat + lifetime,
    iat,
    iss,
  };

  const claims = {};
  for (const claim of CLAIM_ORDER) {
    if (source[claim] === undefined) {
      throw new AccessTokenError(
        `the ${claim} claim came out undefined, and JSON.stringify would drop it silently: `
          + "producing a token that is valid and missing a claim its consumer needs.",
      );
    }
    claims[claim] = source[claim];
  }

  return Object.freeze(claims);
}

// Pure: the bytes

/** One JSON value as a base64url segment, which is what a JWS is made of. */
function encodeSegment(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * The JOSE header, built from `JOSE_HEADER_MEMBER_ORDER` for the same reason the payload is built
 * from `CLAIM_ORDER`.
 *
 * Three members and no more. `jwk`, `x5c`, `x5u` and `jku` each tell a validator where to find
 * a key, an invitation to verify a token against a key the token chose. The published JWKS is
 * the only source of a key, and the header says only which one.
 */
function buildJoseHeader(kid) {
  const source = { alg: JOSE_ALG, kid, typ: JOSE_TYP };
  const header = {};
  for (const member of JOSE_HEADER_MEMBER_ORDER) header[member] = source[member];
  return header;
}

/**
 * Pure core: claims plus a private key become the three-segment token.
 *
 * `crypto.sign(SIGNATURE_DIGEST, ...)` with an RSA key is RSASSA-PKCS1-v1_5 with SHA-256, Node's
 * default RSA padding, which is what RS256 names in RFC 7518 section 3.3. It is left as the
 * default rather than spelled `padding: crypto.constants.RSA_PKCS1_PADDING` because the
 * neighbouring `RSA_PKCS1_PSS_PADDING` is PS256, a different `alg`. A header claiming RS256 over
 * a PSS signature fails verification everywhere with no clue why.
 *
 * The signature is base64url and unpadded, which `Buffer.toString("base64url")` gives directly:
 * a `=` inside a JWS segment is malformed to a strict parser and a different string to a lax one.
 */
function signAccessToken(claims, { privateKey, kid } = {}) {
  const keyId = assertNonEmptyString(kid, "kid");
  if (!privateKey) {
    throw new AccessTokenError("signAccessToken needs the signing key's privateKey KeyObject.");
  }

  const signingInput = `${encodeSegment(buildJoseHeader(keyId))}.${encodeSegment(claims)}`;
  const signature = crypto
    .sign(SIGNATURE_DIGEST, Buffer.from(signingInput, "utf8"), privateKey)
    .toString("base64url");

  return `${signingInput}.${signature}`;
}

// The minter

/**
 * The mod's one entry point for minting.
 *
 *     createAccessTokenMinter({ signingKey, issuer, now, ownerSalt, generateJti })
 *       -> frozen {
 *            mint({ characterId, characterName, clientId, scopes,
 *                   ownerHash | ownerInputs: { accountId } })
 *              -> { token, claims, expiresIn }
 *          }
 *
 * Nothing injected has a default except `generateJti`.
 *
 * `signingKey` is the key set member `lib/signingKey.js` returns, not a path or PEM. The SSO
 * listener loads it at startup and must not re-read it per request: D8 makes the loaded object
 * the process's key for its lifetime so no mint puts the filesystem on the event loop. Taking
 * the object also attaches `kid` to the key it names.
 *
 * `issuer` is the configured string, taken rather than derived (header, `assertIssuer`).
 *
 * `now` returns epoch milliseconds and is required, as in `lib/authCodes.js`, so a test cannot
 * pass without injecting a clock.
 *
 * `ownerSalt` is required; `ownerHashFor` explains why it exists, why it must be persisted, and
 * why it must not be the signing key.
 *
 * `generateJti` defaults to `crypto.randomUUID` (the recorded token carries a UUID) and is
 * injectable so a test can pin a whole token to a byte string. It is the only claim not a
 * function of the arguments.
 *
 * Exactly one owner source per call. `ownerInputs: { accountId }` is the ordinary path: the
 * module derives the hash, using the token's own subject as the character id so an `owner`
 * cannot be computed for a different character than the `sub` beside it. `ownerHash` is the
 * escape hatch for a caller holding the value from elsewhere. Passing both is refused rather
 * than resolved by precedence, because a silent precedence rule is how the two eventually
 * disagree.
 */
function createAccessTokenMinter({
  signingKey,
  issuer,
  now,
  ownerSalt,
  generateJti = crypto.randomUUID,
  lifetimeSeconds = LIFETIME_SECONDS,
} = {}) {
  const key = assertSigningKey(signingKey);
  const resolvedIssuer = assertIssuer(issuer);
  const lifetime = assertPositiveInteger(lifetimeSeconds, "lifetimeSeconds");
  assertOwnerSalt(ownerSalt);

  if (typeof now !== "function") {
    throw new AccessTokenError(
      "createAccessTokenMinter needs a now() returning epoch milliseconds. It is required rather "
        + "than defaulted so that no caller, and no test, can end up depending on a clock it "
        + "did not choose.",
    );
  }
  if (typeof generateJti !== "function") {
    throw new AccessTokenError("createAccessTokenMinter's generateJti must be a function.");
  }

  function resolveOwner(characterId, ownerHash, ownerInputs) {
    const hasHash = ownerHash !== undefined && ownerHash !== null;
    const hasInputs = ownerInputs !== undefined && ownerInputs !== null;

    if (hasHash && hasInputs) {
      throw new AccessTokenError(
        "mint() was given both ownerHash and ownerInputs. Exactly one, because a precedence rule "
          + "between them is a silent way for the two to disagree and the wrong one to win.",
      );
    }
    if (hasHash) return assertNonEmptyString(ownerHash, "ownerHash");
    if (hasInputs) {
      return ownerHashFor({
        characterId,
        accountId: ownerInputs.accountId,
        salt: ownerSalt,
      });
    }

    throw new AccessTokenError(
      "mint() needs either ownerInputs: { accountId } or a precomputed ownerHash. The owner claim "
        + "is what every client uses to decide a stored token is no longer about the same "
        + "relationship; a token without one cannot be invalidated by anything but its expiry.",
    );
  }

  function mint({ characterId, characterName, clientId, scopes, ownerHash, ownerInputs } = {}) {
    const character = assertPositiveInteger(characterId, "characterId");
    const owner = resolveOwner(character, ownerHash, ownerInputs);

    // One read of the clock per token. `iat` is floored rather than rounded:
    // rounding up produces an `iat` in the future, and a validator applying no
    // leeway (the correct default, and what `jose` does) rejects a token that
    // has not been issued yet.
    const millis = Number(now());
    if (!Number.isFinite(millis)) {
      throw new AccessTokenError(
        `now() returned ${describe(millis)}; a token needs a real clock to date itself with.`,
      );
    }

    const claims = buildAccessTokenClaims({
      characterId: character,
      characterName,
      ownerHash: owner,
      clientId,
      scopes,
      issuer: resolvedIssuer,
      kid: key.kid,
      jti: generateJti(),
      issuedAt: Math.floor(millis / 1000),
      lifetimeSeconds: lifetime,
    });

    return Object.freeze({
      token: signAccessToken(claims, { privateKey: key.privateKey, kid: key.kid }),
      claims,
      // What `POST /v2/oauth/token` puts in `expires_in`. It is the lifetime rather
      // than `exp - now()/1000`, so it cannot come out as 1199 on a slow response
      // and 1200 on a fast one; the contract requires 1199 to 1200, and a constant
      // is always inside that range.
      expiresIn: lifetime,
    });
  }

  return Object.freeze({ mint, issuer: resolvedIssuer, kid: key.kid, lifetimeSeconds: lifetime });
}

// Argument checks

/**
 * The issuer's shape, enforced here as well as wherever configuration is validated. D7's three
 * requirements:
 *
 *   - An explicit `http`/`https` scheme. Not merely "a scheme": a bare `host.local:26006` parses
 *     as scheme `host.local` with path `26006`, so a check for "has a colon", or "`new URL`
 *     accepts it", passes the exact value D6 proved unusable.
 *   - No path. The EVE client discards `iss`'s path before fetching, so an issuer carrying one
 *     names a discovery document that cannot be reached.
 *   - No trailing slash. OAuth issuer comparison is exact string comparison, so the slashed form
 *     is a different issuer and rejects every token minted under this one.
 *
 * A query or fragment is refused on the same ground as a path.
 */
function assertIssuer(issuer) {
  const value = assertNonEmptyString(issuer, "issuer");

  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new AccessTokenError(
      `issuer ${JSON.stringify(value)} is not an absolute URL. D7 requires the scheme to be `
        + "explicit: the EVE client supplies https to a scheme-less iss, and D1 serves plain HTTP.",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AccessTokenError(
      `issuer ${JSON.stringify(value)} has scheme ${JSON.stringify(url.protocol)}. A bare `
        + "host:port parses as a scheme, which is the exact shape D6 found unusable; write the "
        + "http:// or https:// out.",
    );
  }
  if (value.endsWith("/")) {
    throw new AccessTokenError(
      `issuer ${JSON.stringify(value)} ends in a slash. Issuer comparison is exact string `
        + "comparison, so the slashed form is a different issuer to every validator.",
    );
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new AccessTokenError(
      `issuer ${JSON.stringify(value)} carries a path, query or fragment. The EVE client `
        + "discards it before fetching the discovery document, so the surface it names is "
        + "unreachable (D6).",
    );
  }

  return value;
}

/**
 * The injected key set member, checked for the three things that would produce a token nothing
 * can verify.
 *
 * The `alg` cross-check: this file signs RS256 as a literal (see `JOSE_ALG`), so a key published
 * as anything else gives a JWKS and a token that disagree. `routes/oauthJwks.js` refuses to
 * publish a non-RS256 key for the mirror-image reason, so a future algorithm under D8 fails
 * loudly in both of their tests.
 */
function assertSigningKey(signingKey) {
  if (signingKey === null || typeof signingKey !== "object") {
    throw new AccessTokenError(
      "createAccessTokenMinter needs the key object lib/signingKey.js returns: the loaded key "
        + "set member, not a path and not a PEM. D8 loads it once at startup, so a mint never "
        + "touches the filesystem.",
    );
  }
  if (!signingKey.privateKey) {
    throw new AccessTokenError("the signing key has no privateKey; nothing can be signed with it.");
  }
  if (signingKey.privateKey.asymmetricKeyType !== SIGNATURE_KEY_TYPE) {
    throw new AccessTokenError(
      `the signing key is a ${JSON.stringify(signingKey.privateKey.asymmetricKeyType)} key, and `
        + `${JOSE_ALG} needs ${SIGNATURE_KEY_TYPE.toUpperCase()}.`,
    );
  }
  assertNonEmptyString(signingKey.kid, "signingKey.kid");

  const published = signingKey.jwk && signingKey.jwk.alg;
  if (published !== undefined && published !== JOSE_ALG) {
    throw new AccessTokenError(
      `the signing key publishes alg ${JSON.stringify(published)} while this minter signs `
        + `${JOSE_ALG}. A token whose header disagrees with the published key fails verification `
        + "everywhere, with an error about the signature rather than about the mismatch.",
    );
  }

  return signingKey;
}

/** A salt that is present and not obviously a placeholder. See `ownerHashFor`. */
function assertOwnerSalt(salt) {
  if (typeof salt !== "string" || salt.length < MINIMUM_OWNER_SALT_LENGTH) {
    throw new AccessTokenError(
      `ownerSalt must be a string of at least ${MINIMUM_OWNER_SALT_LENGTH} characters; got `
        + `${describe(salt)}. Use generateOwnerSalt() and persist the result beside the signing `
        + "key: without a secret salt the owner claim is a reversible encoding of the account "
        + "id, and if the salt changes every client reads every character as transferred.",
    );
  }
  return salt;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || value === "") {
    throw new AccessTokenError(`${name} must be a non-empty string; got ${describe(value)}.`);
  }
  return value;
}

function assertPositiveInteger(value, name, why = "") {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AccessTokenError(
      `${name} must be a positive integer; got ${describe(value)}.${why ? ` ${why}` : ""}`,
    );
  }
  return value;
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AccessTokenError(
      `${name} must be a non-negative integer number of seconds; got ${describe(value)}. `
        + "iat and exp are NumericDates (RFC 7519 §4.1.4): seconds, not milliseconds.",
    );
  }
  return value;
}

/** `null`, `undefined`, `an array`, `the number 3`, `the empty string`. */
function describe(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (value === "") return "the empty string";
  return `the ${typeof value} ${JSON.stringify(value)}`;
}

module.exports = Object.freeze({
  AUDIENCE_LITERAL,
  CLAIM_ORDER,
  JOSE_ALG,
  JOSE_HEADER_MEMBER_ORDER,
  JOSE_TYP,
  LIFETIME_SECONDS,
  MINIMUM_OWNER_SALT_LENGTH,
  OWNER_DOMAIN,
  OWNER_ENCODING,
  OWNER_HASH_BYTES,
  REGION,
  SUBJECT_PREFIX,
  TIER,
  AccessTokenError,

  createAccessTokenMinter,

  buildAccessTokenClaims,
  buildJoseHeader,
  generateOwnerSalt,
  normalizeScopes,
  ownerHashFor,
  signAccessToken,
});
