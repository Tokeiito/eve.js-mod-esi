/**
 * eve.js-mod-esi: reading the access token this replica signed.
 *
 * The counterpart to `lib/accessToken.js`. This is not a general JWT library: it reads tokens
 * minted by one minter, under one key, with one issuer, in one process, so it can be strict
 * everywhere a general validator has to be permissive.
 *
 * It is a separate module because two surfaces need it: `/v2/oauth/verify` (whose token is
 * this) and bearer authentication for the authenticated ESI surface. Written twice, the copies
 * would drift on the expiry comparison (`<` versus `<=`, seconds versus milliseconds).
 *
 * Inputs: the key object `lib/signingKey.js` returns, public half only (`key.privateKey` is never
 * touched, so the only module that can mint is the minter). D8 gives this replica one signing slot
 * for the process's lifetime, so there is no JWKS fetch and no network access in this file
 * (design constraint 2). `now` and the clock tolerance are arguments so tests pin them.
 *
 * No HTTP: `verify` returns a verdict and the route decides what it is worth. The verify endpoint
 * answers a bad bearer with `401` and `text/html`, while bearer authentication tells three
 * refusals apart: two `401`s and a `403`, in two different families.
 *
 * `fromHeader` and `verify` are separate because "there is a bearer token here" and "it
 * verifies" are different questions. `fromHeader` returns `null` for no `Authorization`, a scheme
 * that is not `Bearer`, or nothing after the scheme. That `null` does not select between the
 * two 401 bodies: CCP splits on whether the `Authorization` header was present at all, so
 * `Basic ...` and a bare `Bearer` are invalid tokens, not missing ones. See
 * `bearerFromAuthorization` and `contract/wire.js` `BEARER`.
 *
 * `JOSE_ALG`, `JOSE_TYP` and `SUBJECT_PREFIX` are required from `lib/accessToken.js`, not
 * copied: this module is defined as the reader of that minter, and `lib/accessToken.js` is in
 * `HASHED_DIRS` so it ships beside this file. (`routes/oauthJwks.js` and `lib/cors.js` duplicate
 * `contract/sso.js` instead, because that file is test-only and never deployed, D20.)
 *
 * `aud` is `[<client_id>, "EVE Online"]` and is deliberately not checked. It is projected and
 * no verdict turns on it: CCP's verify answers for any valid token whatever client it was
 * issued to, and scope, not audience, is what bearer authentication cares about.
 *
 * No `reason` or `detail` here is ever echoed to a caller; they exist to be logged. `detail`
 * names the symptom and never the credential.
 */

"use strict";

const crypto = require("node:crypto");

const { JOSE_ALG, JOSE_TYP, SUBJECT_PREFIX } = require("./accessToken");

// The credential, as it arrives

/**
 * The header, and the scheme, both lowercase.
 *
 * Node lowercases every name in `IncomingMessage.headers`, so the literal below hits on the
 * ordinary path. `fromHeader` still walks the bag case-insensitively because a route may be
 * handed a header object from anywhere (a test fixture, a dispatch layer;
 * `routes/oauthJwks.js` has the same helper).
 *
 * The scheme is compared case-insensitively because RFC 7235 section 2.1 says `auth-scheme` is
 * case-insensitive, and lowercase `bearer` is common in hand-rolled clients.
 */
const AUTHORIZATION_HEADER = "authorization";
const BEARER_SCHEME = "bearer";

// The bytes, and what a segment is allowed to contain

/** The Node digest `JOSE_ALG` is the JOSE spelling of, and the key type it needs. */
const SIGNATURE_DIGEST = "sha256";
const SIGNATURE_KEY_TYPE = "rsa";

/**
 * A compact JWS segment: base64url, unpadded, non-empty.
 *
 * Checked explicitly because Node's decoder is lenient: `Buffer.from(s, "base64url")` ignores
 * characters outside the alphabet, so `"eyJ+hbGc"` decodes to something plausible. No exploit
 * follows (the signature is computed over the raw segment strings), but "malformed" should mean
 * malformed, and `MALFORMED` is a better log line than `BAD_SIGNATURE` for a string that was
 * never a JWS.
 */
const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** A compact JWS is three segments.  Five is a JWE, which we do not issue. */
const JWS_SEGMENTS = 3;

/**
 * `sub`, anchored.
 *
 * The wider ecosystem parses the subject with `/CHARACTER:EVE:(\d+)/i`
 * (`contract/sso.js` `ACCESS_TOKEN_SUBJECT_PATTERN`), which is unanchored, so
 * `"NOT-A:CHARACTER:EVE:123 "` matches for them. That is what consumers tolerate, not what we
 * accept: `lib/accessToken.js` emits the prefix, the digits and nothing else, so a subject with
 * anything around it was not minted here. The prefix is spliced in from the minter.
 */
const SUBJECT_PATTERN = new RegExp(`^${SUBJECT_PREFIX}(\\d+)$`, "i");

// The clock, and the tolerance that is not needed

/**
 * The clock skew allowance, in seconds. The default is zero.
 *
 * Leeway exists for an issuer and a validator on two machines with two clocks. Here the minter
 * and the reader are the same process reading the same wall clock (D8's single signing slot
 * puts the key in this process), so there is no skew to absorb.
 *
 * `exp - iat` is exactly 1200 seconds (`lib/accessToken.js` `LIFETIME_SECONDS`, the same number
 * as the token endpoint's `expires_in`), so a tolerance is a straight extension of every token's
 * life. `docs/d6-listener-split.md` builds the self-healing story for an issuer change or key
 * rotation on that twenty minutes, and `routes/oauthJwks.js` sizes its `max-age` against it.
 *
 * `lib/accessToken.js` floors `iat` for the same reason: a validator applying no leeway (the
 * correct default, and what `jose` does) rejects a token that has not been issued yet.
 *
 * It stays configurable for a verifier outside the minter's process (a second listener, a
 * sidecar, a host whose clock steps at boot), and is capped at sixty seconds, 5% of a token's
 * life.
 */
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 0;
const MAXIMUM_CLOCK_TOLERANCE_SECONDS = 60;

// Verdicts

/**
 * Every way a token is refused, named. For logs, not for a client.
 *
 * The verify endpoint answers a bad or missing bearer with `401` and CCP's `text/html` body, so
 * none of these reaches a caller. They are distinct because the only place they are read is a
 * log, by someone asking why a client that worked yesterday does not work today.
 *
 *   - `BAD_SIGNATURE` is a key problem: a rotation happened, or the token came from a different
 *     replica. `WRONG_KEY` is the same story caught earlier, by the `kid`.
 *   - `WRONG_ISSUER` is a configuration problem, almost always this replica's own:
 *     `ESI_MOD_ISSUER` moved after tokens were signed under the old value. D7 requires the
 *     issuer to be final before the first token is signed.
 *   - `EXPIRED` is the most common verdict and means the system is working; a client answers it
 *     by refreshing. It is named separately so it can be filtered out of a log.
 */
const VERIFY_REASON = Object.freeze({
  /** Nothing that could be a token: absent, empty, or not a string at all. */
  NO_CREDENTIAL: "NO_CREDENTIAL",
  /** Not a compact JWS: wrong segment count, non-base64url, or not JSON. */
  MALFORMED: "MALFORMED",
  /** The JOSE header names an algorithm that is not RS256.  See `verify`. */
  BAD_ALGORITHM: "BAD_ALGORITHM",
  /** A `typ` that is not `JWT`, or a `crit` member we are required to reject. */
  BAD_HEADER: "BAD_HEADER",
  /** A `kid` naming a key this replica does not publish. */
  WRONG_KEY: "WRONG_KEY",
  /** RS256 verification against the published public half failed. */
  BAD_SIGNATURE: "BAD_SIGNATURE",
  /** `iss` is not the configured issuer, byte for byte. */
  WRONG_ISSUER: "WRONG_ISSUER",
  /** `exp` has passed, allowing for the configured tolerance. */
  EXPIRED: "EXPIRED",
  /** `sub` is absent, or is not `CHARACTER:EVE:<digits>` and nothing else. */
  BAD_SUBJECT: "BAD_SUBJECT",
  /** A claim a caller must be able to read is absent or the wrong type. */
  BAD_CLAIMS: "BAD_CLAIMS",
  /**
   * Should be unreachable; it exists so that "unreachable" is a logged verdict rather than a
   * stack trace. `verify` runs inside a game server: a malformed header must not become a `500`
   * or an unhandled rejection (design constraint 2). The `detail` says which line.
   */
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

/**
 * Construction-time refusals. Thrown rather than returned, as in `lib/accessToken.js`:
 * everything reachable here is a programming or configuration error (a missing clock, a key that
 * cannot verify, a tolerance typed in milliseconds), and the SSO listener's startup catches it
 * and declines to serve. Nothing on the request path throws; see `verify`.
 */
class BearerTokenError extends Error {
  constructor(message) {
    super(`[EsiApiMod] ${message}`);
    this.name = "BearerTokenError";
  }
}

// Pure: pulling the credential out of a header value

/**
 * Pure core: one `Authorization` value becomes the token, or `null`.
 *
 * `null` for every shape that is not a bearer credential: a different scheme, a bare `Bearer`
 * with nothing after it, whitespace inside what should be a `token68`.
 *
 * The `null` is not the 401 body's selector. Observed against live ESI:
 *
 *   curl -sD - -H "Authorization: Basic dXNlcjpwdw==" \
 *        https://esi.evetech.net/latest/characters/{character_id}/location/
 *     401 {"error":"Unauthorized - Invalid token"}
 *
 * CCP splits on whether the header was there, not on whether a bearer credential was. A bare
 * `Bearer`, a `Basic` credential and `bearer xyz` are all invalid tokens; only an absent or blank
 * `Authorization` is a missing one. So callers must not read `null` as "nothing was
 * presented": `lib/bearerCredential.js` reads the raw header for that, and `contract/wire.js`
 * `BEARER` holds the survey.
 *
 * Whitespace: RFC 7235 section 2.1 is `auth-scheme 1*SP token68`, and RFC 9110 section 5.5
 * lets a recipient strip leading and trailing whitespace. So the outer trim and a run of spaces
 * after the scheme are accepted (an extra space is what `"Bearer " + " " + token` gives).
 * Whitespace inside the credential is not: a `token68` has none, so `Bearer a b` is reported
 * as no bearer credential rather than silently truncated.
 */
function bearerFromAuthorization(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;

  const split = trimmed.search(/\s/);
  if (split === -1) return null;

  const scheme = trimmed.slice(0, split);
  if (scheme.toLowerCase() !== BEARER_SCHEME) return null;

  const credential = trimmed.slice(split).trim();
  if (credential === "" || /\s/.test(credential)) return null;

  return credential;
}

/**
 * Case-insensitive header read, tolerant of the whole bag being nonsense.
 *
 * For an array value, the first entry wins. Node keeps only the first `Authorization` when a
 * request carries two (it does not comma-join that header, because joining two credentials
 * yields one that is neither), so this matches the platform for any bag that did not already do
 * it.
 */
function readAuthorizationHeader(headers) {
  if (headers === null || typeof headers !== "object") return undefined;

  let value = headers[AUTHORIZATION_HEADER];
  if (value === undefined) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === AUTHORIZATION_HEADER) {
        value = headers[name];
        break;
      }
    }
  }

  if (Array.isArray(value)) return value.length === 0 ? undefined : value[0];
  return value;
}

// Pure: the segments

/** One base64url segment as a parsed JSON **object**, or `null` for anything else. */
function decodeJsonSegment(segment) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch (_) {
    return null;
  }
  // A payload of `42`, `"abc"` or `[...]` parses fine and is not a claim set.
  // Arrays are excluded explicitly: `typeof [] === "object"`, and an array
  // reaching the claim checks would read every member as `undefined`.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed;
}

// Pure: the projection a route actually uses

/**
 * Pure core: a verified claim set becomes something a route can read without parsing anything.
 *
 * A route given the raw payload would have to run `/CHARACTER:EVE:(\d+)/i` itself (unanchored,
 * as in every ecosystem example) and decide whether `scp` is a string or an array. Both
 * decisions live here: the caller gets an integer `characterId` and a frozen `scopes` array, or
 * a refusal.
 *
 * Required, refused when absent or the wrong type: `sub`, `azp`, `name`, `owner`, `exp`,
 * `iat`. Four of them are the answer `/v2/oauth/verify` gives (`CharacterID`, `CharacterName`,
 * `CharacterOwnerHash` and the client the token belongs to), and an `undefined` there would
 * serialize a response with a missing member (`lib/serialize.js`'s rule about `undefined` from
 * a projection getter, on a surface that cannot use `projection()`). The other two are the
 * token's lifetime.
 *
 * Projected as-is, never refused: `jti`, `aud`, `kid`, `tenant`, `tier`, `region`. None
 * changes what a caller may do, and refusing over a missing `tier` would invent a requirement
 * CCP does not have.
 *
 * `scp` sits between: a wrong type is refused (callers iterate `claims.scopes`), an absent one
 * projects to the empty array. That fails safe, since an empty scope set grants nothing, so
 * bearer authentication refuses the request for want of a scope rather than calling the token
 * bad. The refusal that carries is a `401` naming the scope, not a `403`;
 * `contract/wire.js` `SCOPE_REFUSAL` has the capture.
 *
 * The string form of `scp` is accepted though this replica never emits it. CCP emits a bare
 * string for a single scope, and tools written against CCP must work here.
 *
 * `exp - iat === 1200` is deliberately not re-checked: the lifetime is the minter's to choose
 * (`createAccessTokenMinter` takes it as a parameter), and pinning it here would turn a
 * one-line change there into a two-file break against tokens already issued.
 */
function projectClaims(payload, nowSeconds) {
  const subject = payload.sub;
  if (typeof subject !== "string") {
    return refuse(
      VERIFY_REASON.BAD_SUBJECT,
      `sub is ${describe(subject)}, and it must be a string.`,
    );
  }

  const match = SUBJECT_PATTERN.exec(subject);
  if (match === null) {
    return refuse(
      VERIFY_REASON.BAD_SUBJECT,
      `sub ${snippet(subject)} is not ${SUBJECT_PREFIX}<id>. A subject in any other shape reaches `
        + "a consumer as \"no character id\" rather than as a bad token, so it is refused here.",
    );
  }

  const digits = match[1];
  const characterId = Number(digits);
  // `Number.isSafeInteger` catches a subject with more digits than a double can
  // hold: `CHARACTER:EVE:99999999999999999999` parses to a rounded number that
  // is a different character. The round-trip catches a leading zero, which
  // would let two distinct subjects project to one id.
  if (!Number.isSafeInteger(characterId) || characterId <= 0 || String(characterId) !== digits) {
    return refuse(
      VERIFY_REASON.BAD_SUBJECT,
      `sub ${snippet(subject)} does not carry a character id this replica could have minted.`,
    );
  }

  const characterName = payload.name;
  if (typeof characterName !== "string" || characterName === "") {
    return refuse(VERIFY_REASON.BAD_CLAIMS, `name is ${describe(characterName)}.`);
  }

  const clientId = payload.azp;
  if (typeof clientId !== "string" || clientId === "") {
    return refuse(VERIFY_REASON.BAD_CLAIMS, `azp is ${describe(clientId)}.`);
  }

  const owner = payload.owner;
  if (typeof owner !== "string" || owner === "") {
    return refuse(VERIFY_REASON.BAD_CLAIMS, `owner is ${describe(owner)}.`);
  }

  const scopes = normalizeScopeClaim(payload.scp);
  if (scopes === null) {
    return refuse(
      VERIFY_REASON.BAD_CLAIMS,
      `scp is ${describe(payload.scp)}; it must be an array of strings or a space-delimited `
        + "string, because a caller iterates it to decide what this token may do.",
    );
  }

  return {
    ok: true,
    claims: Object.freeze({
      characterId,
      characterName,
      clientId,
      owner,
      scopes,
      // The subject verbatim beside the parsed id, because the verify endpoint
      // echoes it and a route should not have to rebuild it from the integer.
      subject,
      issuer: payload.iss,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      // Seconds of life left, floored at zero. `exp - now` rather than the
      // lifetime, because a caller reporting this describes this token at this
      // moment, not the policy that made it.
      expiresIn: Math.max(0, payload.exp - nowSeconds),
      tokenId: payload.jti,
      audience: Array.isArray(payload.aud) ? Object.freeze([...payload.aud]) : payload.aud,
      kid: payload.kid,
      tenant: payload.tenant,
      tier: payload.tier,
      region: payload.region,
      // The whole verified payload, frozen, for anything this projection did not
      // anticipate. It is last on purpose: a caller reaching into it probably
      // needs a named member above.
      payload: Object.freeze({ ...payload }),
    }),
  };
}

/** `scp` in either of CCP's two shapes, as a frozen array, or `null` for neither. */
function normalizeScopeClaim(scp) {
  if (scp === undefined || scp === null) return Object.freeze([]);
  if (typeof scp === "string") {
    // Split on runs of whitespace, as `lib/accessToken.js` does on the way in:
    // a stray tab means a scope list, not an empty scope name that fails an
    // equality check somewhere far away.
    return Object.freeze(scp.split(/\s+/).filter((scope) => scope !== ""));
  }
  if (!Array.isArray(scp)) return null;
  for (const scope of scp) {
    if (typeof scope !== "string" || scope === "") return null;
  }
  return Object.freeze([...scp]);
}

// The verifier

/**
 * The mod's one entry point into reading a bearer token.
 *
 *     createBearerVerifier({ signingKey, issuer, now, clockToleranceSeconds })
 *       -> frozen {
 *            fromHeader(headers) -> string | null
 *            verify(token) -> { ok: true, claims } | { ok: false, reason, detail }
 *            issuer, kid, clockToleranceSeconds
 *          }
 *
 * Two orderings of checks are load-bearing, and a plausible refactor introduces a real
 * vulnerability by changing either.
 *
 * 1. `alg` is read from the header and fixed before anything else. The classic JWT attack is
 * an attacker-chosen algorithm. `test/bearerToken.test.js` builds both variants:
 *
 *   - `alg: "none"` with an empty signature segment. The "is the signature segment
 *     well-formed?" check deliberately runs after the `alg` check, otherwise the most important
 *     refusal would be reported as `MALFORMED`.
 *   - `alg: "HS256"` signed with the public key as the HMAC secret. The public half is
 *     published at `/oauth/jwks`, so anyone can compute that MAC; a validator that dispatched on
 *     `alg` would confirm the forgery.
 *
 * `PS256` is refused by the same line. The comparison is equality against one literal rather
 * than set membership because PS256 is RSA over the same key with PSS padding, and "allow the
 * RSA family" is how a validator ends up accepting an algorithm the minter never signs.
 *
 * 2. Nothing from the payload is read until the signature verifies. `iss`, `exp`, `sub` and
 * the rest are attacker-controlled until the RSA check passes. The payload is not even parsed
 * before `crypto.verify` returns true. The JOSE header is parsed first, because the algorithm
 * lives there, and is used only to refuse.
 *
 * `verify` never throws. It runs inside a game server on the loop the universe ticks on, so
 * `Authorization: Bearer <anything>` must produce a `401`, not a `500` or an unhandled
 * rejection. The outer `try` yields `INTERNAL_ERROR` rather than `MALFORMED` so that a bug here
 * cannot hide inside a normal-looking refusal.
 *
 * No revocation check. A refresh token is revocable because it is stored
 * (`lib/refreshTokens.js`, D30); an access token is a signature over claims and nothing on this
 * server knows it exists. Its twenty minutes are its revocation.
 */
function createBearerVerifier({
  signingKey,
  issuer,
  now,
  clockToleranceSeconds = DEFAULT_CLOCK_TOLERANCE_SECONDS,
} = {}) {
  const key = assertVerificationKey(signingKey);
  const expectedIssuer = assertIssuerString(issuer);
  const tolerance = assertClockTolerance(clockToleranceSeconds);

  if (typeof now !== "function") {
    throw new BearerTokenError(
      "createBearerVerifier needs a now() returning epoch milliseconds. It is required rather than "
        + "defaulted for lib/accessToken.js's reason: a verifier that reached for Date.now() lets a "
        + "test pass that never injected a clock, and every expiry case is arithmetic on a pinned "
        + "number rather than a sleep.",
    );
  }

  /** The credential, or `null` when none was presented.  See `bearerFromAuthorization`. */
  function fromHeader(headers) {
    return bearerFromAuthorization(readAuthorizationHeader(headers));
  }

  function verify(token) {
    try {
      return verifyOrRefuse(token);
    } catch (err) {
      // Unreachable by construction; see VERIFY_REASON.INTERNAL_ERROR. The
      // message is included because if this fires, the log should say which line.
      return refuse(
        VERIFY_REASON.INTERNAL_ERROR,
        `verify() threw, which it must not: ${err && err.message ? err.message : String(err)}`,
      );
    }
  }

  function verifyOrRefuse(token) {
    if (typeof token !== "string" || token === "") {
      return refuse(
        VERIFY_REASON.NO_CREDENTIAL,
        `verify() was given ${describe(token)}. fromHeader() returns null when no bearer `
          + "credential was presented, and that is a different answer from a bad one.",
      );
    }

    const segments = token.split(".");
    if (segments.length !== JWS_SEGMENTS) {
      return refuse(
        VERIFY_REASON.MALFORMED,
        `a compact JWS has ${JWS_SEGMENTS} dot-separated segments; this has ${segments.length}.`,
      );
    }
    if (!BASE64URL_SEGMENT.test(segments[0]) || !BASE64URL_SEGMENT.test(segments[1])) {
      return refuse(VERIFY_REASON.MALFORMED, "the header or payload segment is not base64url.");
    }

    const header = decodeJsonSegment(segments[0]);
    if (header === null) {
      return refuse(VERIFY_REASON.MALFORMED, "the header segment is not a JSON object.");
    }

    // The one check that must come first. See the header above.
    if (header.alg !== JOSE_ALG) {
      return refuse(
        VERIFY_REASON.BAD_ALGORITHM,
        `the JOSE header names alg ${snippet(header.alg)}; this replica signs ${JOSE_ALG} and `
          + "accepts nothing else. An attacker-chosen algorithm is the classic JWT forgery.",
      );
    }

    // RFC 7515 section 4.1.11: a validator MUST reject a JWS carrying a `crit` it
    // does not understand, and this one understands none. The minter emits three
    // header members and `crit` is not among them, so nothing we issue is
    // affected.
    if (header.crit !== undefined) {
      return refuse(
        VERIFY_REASON.BAD_HEADER,
        `the JOSE header carries crit ${snippet(header.crit)}, and RFC 7515 §4.1.11 requires a `
          + "validator to reject critical extensions it does not implement.",
      );
    }

    // `typ` is optional in RFC 7519 section 5.1, so its absence is tolerated. Its
    // presence with another value is not: `at+jwt`, `dpop+jwt` and `JWE` each
    // name a token minted for a different protocol slot, and honouring one as an
    // access token is how a proof-of-possession artefact gets replayed as a
    // credential.
    if (header.typ !== undefined && String(header.typ).toUpperCase() !== JOSE_TYP) {
      return refuse(
        VERIFY_REASON.BAD_HEADER,
        `the JOSE header names typ ${snippet(header.typ)} rather than ${JOSE_TYP}.`,
      );
    }

    // `kid` is optional for the same reason `typ` is (a token without one is
    // still verifiable against the only key we have), but a token naming a key
    // names one, and under D8 there is exactly one signing slot, so any other
    // name is a token some other replica minted. Catching it here, rather than
    // falling through to BAD_SIGNATURE, gives the operator a log line to act on.
    if (header.kid !== undefined && header.kid !== key.kid) {
      return refuse(
        VERIFY_REASON.WRONG_KEY,
        `the token names kid ${snippet(header.kid)}; this replica publishes ${snippet(key.kid)}.`,
      );
    }

    if (!BASE64URL_SEGMENT.test(segments[2])) {
      return refuse(VERIFY_REASON.MALFORMED, "the signature segment is not base64url.");
    }

    // `crypto.verify` with an RSA key and no padding option is RSASSA-PKCS1-v1_5,
    // Node's default and what RS256 names in RFC 7518 section 3.3. The padding is
    // left out for the mirror-image reason `lib/accessToken.js` leaves it out
    // when signing: writing it invites a change to `RSA_PKCS1_PSS_PADDING`,
    // which is PS256.
    const signed = Buffer.from(`${segments[0]}.${segments[1]}`, "utf8");
    const signature = Buffer.from(segments[2], "base64url");
    if (!crypto.verify(SIGNATURE_DIGEST, signed, key.publicKey, signature)) {
      return refuse(
        VERIFY_REASON.BAD_SIGNATURE,
        `${JOSE_ALG} verification failed against the key this replica publishes.`,
      );
    }

    // Everything below here is signed, and only now worth reading.

    const payload = decodeJsonSegment(segments[1]);
    if (payload === null) {
      // Reachable only for a token we signed over something that is not a
      // claim set, which is a bug in the minter rather than an attack.
      return refuse(VERIFY_REASON.MALFORMED, "the payload segment is not a JSON object.");
    }

    // D7 makes the issuer configuration rather than derivation, and
    // `lib/accessToken.js` emits it verbatim, so the comparison is exact string
    // equality, which is also what RFC 8725 section 3.1 requires. A verifier that
    // accepted a different issuer would honour tokens minted by another replica
    // against the same key material, and tokens signed under an issuer an operator
    // deliberately moved away from.
    if (payload.iss !== expectedIssuer) {
      return refuse(
        VERIFY_REASON.WRONG_ISSUER,
        `the token was issued by ${snippet(payload.iss)}; this replica is `
          + `${snippet(expectedIssuer)}. If those look like the same server, D7's shape rules (no `
          + "trailing slash, explicit scheme, no path) are where they differ.",
      );
    }

    if (!isNumericDate(payload.exp)) {
      return refuse(
        VERIFY_REASON.BAD_CLAIMS,
        `exp is ${describe(payload.exp)}; RFC 7519 §4.1.4 makes it a NumericDate: seconds, not `
          + "milliseconds. A token whose lifetime cannot be read cannot be honoured.",
      );
    }
    // `iat` must be present and a NumericDate, and is never compared against
    // the clock: a future `iat` is not evidence of forgery (a forger holding the
    // key would not write one), while a clock that steps backwards produces one
    // on a token we minted ourselves. `jose` does not check it either unless
    // asked.
    if (!isNumericDate(payload.iat)) {
      return refuse(
        VERIFY_REASON.BAD_CLAIMS,
        `iat is ${describe(payload.iat)}; RFC 7519 §4.1.4 makes it a NumericDate.`,
      );
    }

    const millis = Number(now());
    if (!Number.isFinite(millis)) {
      return refuse(
        VERIFY_REASON.INTERNAL_ERROR,
        `now() returned ${describe(millis)}; a token cannot be dated against a clock like that, `
          + "and guessing the current time to admit one is not an option.",
      );
    }
    // One division, at one boundary. `now()` is milliseconds everywhere in this
    // mod and `exp` is seconds everywhere in JOSE; the units meeting in more than
    // one place is how a token acquires a lifetime a thousand times too long.
    const nowSeconds = Math.floor(millis / 1000);

    // RFC 7519 section 4.1.4: the current time MUST be before `exp`, so an `exp`
    // equal to now is expired. The tolerance widens that and nothing else; see
    // DEFAULT_CLOCK_TOLERANCE_SECONDS for why it is zero.
    if (nowSeconds >= payload.exp + tolerance) {
      return refuse(
        VERIFY_REASON.EXPIRED,
        `exp ${payload.exp} passed ${nowSeconds - payload.exp}s ago (tolerance ${tolerance}s). `
          + "This is the ordinary end of a token's life; the client refreshes.",
      );
    }

    return projectClaims(payload, nowSeconds);
  }

  return Object.freeze({
    fromHeader,
    verify,
    issuer: expectedIssuer,
    kid: key.kid,
    clockToleranceSeconds: tolerance,
  });
}

// Argument checks

/**
 * The injected key set member, checked for what would make it verify the wrong things, and
 * mirroring what the minter checks.
 *
 * `publicKey` rather than `privateKey`: see the header. `lib/signingKey.js` derives the public
 * key from the private one, so the two cannot disagree about which key this is.
 *
 * The `alg` cross-check is `assertSigningKey`'s, from the other side. `routes/oauthJwks.js`
 * refuses to publish a key that is not RS256, the minter refuses to sign with it, and this
 * refuses to verify against it, so a future algorithm under D8 fails loudly in each of their
 * tests.
 */
function assertVerificationKey(signingKey) {
  if (signingKey === null || typeof signingKey !== "object") {
    throw new BearerTokenError(
      "createBearerVerifier needs the key object lib/signingKey.js returns: the loaded key set "
        + "member, not a PEM and not a JWKS URL. D8 puts one key in this process for its whole "
        + "lifetime, so there is nothing to fetch and nowhere to fetch it from.",
    );
  }
  if (!signingKey.publicKey) {
    throw new BearerTokenError(
      "the signing key has no publicKey; nothing can be verified against it. Note that this "
        + "module wants the public half only and never reads privateKey.",
    );
  }
  if (signingKey.publicKey.asymmetricKeyType !== SIGNATURE_KEY_TYPE) {
    throw new BearerTokenError(
      `the signing key is a ${JSON.stringify(signingKey.publicKey.asymmetricKeyType)} key, and `
        + `${JOSE_ALG} needs ${SIGNATURE_KEY_TYPE.toUpperCase()}.`,
    );
  }
  if (typeof signingKey.kid !== "string" || signingKey.kid === "") {
    throw new BearerTokenError(
      "the signing key has no kid; without one this verifier cannot tell a token naming another "
        + "replica's key from one naming ours.",
    );
  }

  const published = signingKey.jwk && signingKey.jwk.alg;
  if (published !== undefined && published !== JOSE_ALG) {
    throw new BearerTokenError(
      `the signing key publishes alg ${JSON.stringify(published)} while this verifier accepts `
        + `${JOSE_ALG} only. Every token this replica mints would be refused by its own reader.`,
    );
  }

  return signingKey;
}

/**
 * The issuer, checked only for being a usable comparison operand.
 *
 * D7's shape (absolute URL, explicit scheme, no path, no trailing slash) is enforced by
 * `assertIssuer` in `lib/accessToken.js` against the same configured string. A second check
 * here could only disagree with the first; what this module needs is the exact bytes.
 */
function assertIssuerString(issuer) {
  if (typeof issuer !== "string" || issuer === "") {
    throw new BearerTokenError(
      `issuer must be the configured issuer string, the same one lib/accessToken.js mints with, `
        + `byte for byte; got ${describe(issuer)}. Comparison is exact (RFC 8725 §3.1), so any `
        + "difference at all rejects every token this replica has issued.",
    );
  }
  return issuer;
}

/** A tolerance that is seconds, non-negative, and not secretly a lifetime extension. */
function assertClockTolerance(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new BearerTokenError(
      `clockToleranceSeconds must be a non-negative whole number of seconds; got `
        + `${describe(seconds)}. Seconds, like exp: a tolerance handed over in milliseconds `
        + "would honour every token this replica has ever minted, forever.",
    );
  }
  if (seconds > MAXIMUM_CLOCK_TOLERANCE_SECONDS) {
    throw new BearerTokenError(
      `clockToleranceSeconds is ${seconds}, above the ${MAXIMUM_CLOCK_TOLERANCE_SECONDS}s ceiling. `
        + "exp - iat is exactly 1200 by contract, so a tolerance is a straight extension of every "
        + "token's life; past 5% of that it is not describing a clock, it is choosing a lifetime, "
        + "and that needs its own decision.",
    );
  }
  return seconds;
}

/** RFC 7519 section 4.1.4: a NumericDate is a finite number of seconds. */
function isNumericDate(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Refusals, and the strings inside them

/** The frozen `{ ok: false }` verdict.  `detail` is for a log; see the header. */
function refuse(reason, detail) {
  return Object.freeze({ ok: false, reason, detail });
}

/**
 * A value in a `detail`, stringified and bounded.
 *
 * Everything that reaches this comes out of an unverified JOSE header or payload. The
 * truncation stops a 200 KB `kid` from becoming a 200 KB log line. Nothing here ever receives
 * the token itself.
 */
function snippet(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch (_) {
    text = String(value);
  }
  if (typeof text !== "string") return String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** `null`, `undefined`, `an array`, `the number 3`, `the empty string`. */
function describe(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (value === "") return "the empty string";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return `the ${typeof value} ${JSON.stringify(value)}`;
  }
  return `a ${typeof value}`;
}

module.exports = Object.freeze({
  AUTHORIZATION_HEADER,
  BEARER_SCHEME,
  DEFAULT_CLOCK_TOLERANCE_SECONDS,
  MAXIMUM_CLOCK_TOLERANCE_SECONDS,
  SUBJECT_PATTERN,
  VERIFY_REASON,
  BearerTokenError,

  createBearerVerifier,

  bearerFromAuthorization,
  // Exported for `lib/bearerCredential.js`, which needs the raw header value
  // to tell an absent credential from a bad one: a distinction `fromHeader`
  // collapses, and one CCP answers on. Two readers of one header would be two
  // chances to disagree about a case-insensitive lookup and a repeated header
  // field.
  readAuthorizationHeader,
  projectClaims,
});
