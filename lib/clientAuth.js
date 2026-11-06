/**
 * eve.js-mod-esi: client authentication and PKCE.
 *
 * The three questions `POST /v2/oauth/token` must answer before turning an
 * authorization code into a token, none of them an HTTP question:
 *
 *   `authenticate`  who is this, and did they prove it?
 *   `verifyPkce`    does this verifier match the challenge the code carries?
 *   `mayRedeem`     given those answers, may this code be redeemed at all?
 *
 * The third is a security invariant, so it is a function that can be tested
 * without constructing an HTTP request.
 *
 * The invariant: `routes/oauthAuthorize.js` accepts an authorize request with no
 * `code_challenge` (RFC 8414 section 2 defines `code_challenge_methods_supported`
 * as the methods a server supports, not as PKCE being mandatory). That is safe
 * only if a code minted with a challenge is redeemable only with a matching
 * verifier, and one minted without only by a client that authenticated. If a
 * public client could redeem a no-challenge code, an attacker who rewrites the
 * authorization request would get PKCE removal by stripping two query
 * parameters. D1 puts this replica on plain HTTP, so that attacker is someone on
 * the same LAN.
 *
 *     challenge, verifier matches     -> yes, authenticated or not
 *     no challenge, authenticated     -> yes
 *     no challenge, not authenticated -> no
 *
 * The third line is the one a naive implementation gets wrong: `if
 * (code.codeChallenge) { check the verifier }` has no `else` and silently grants
 * every no-challenge code to whoever holds it. `test/clientAuth.test.js` has
 * that shape as a named case.
 *
 * Which refusals are collapsed: credential outcomes are collapsed to a single
 * message; the shape of the caller's own request is not. "Wrong secret", "a
 * secret for a client registered without one" and "a secret for an unknown
 * `client_id`" are byte-identical, because the difference is a fact about this
 * deployment's configuration. Every way a `code_verifier` can fail (too short,
 * wrong alphabet, simply wrong) is one message, because telling a malformed
 * guess from a well-formed wrong one is the free hint `lib/pendingBinds.js` and
 * the bind poll in `routes/oauthAuthorize.js` also refuse to give. What stays
 * distinct is what the caller already knows because they wrote it: a non-Basic
 * `Authorization` header, two disagreeing `client_id`s, two authentication
 * methods at once.
 *
 * The `error` values are RFC 6749's registered ones only (`invalid_client`,
 * `invalid_grant`, `invalid_request`). This module decides no HTTP: no status
 * codes, no `WWW-Authenticate`, no serialisation. The token endpoint is the one
 * SSO endpoint answering in JSON and it flattens `lib/authCodes.js`'s outcomes
 * onto `invalid_grant` so as not to be an oracle; that flattening is the
 * route's, including replacing every `errorDescription` below with one constant
 * if it decides so.
 *
 * Where credentials are read from:
 *
 *   `Authorization: Basic base64(client_id ":" client_secret)`: RFC 6749
 *   section 2.3.1's required form, sent by confidential server-side tools.
 *
 *   `client_id` in the form body with no secret: the optional form, but required
 *   here. `docs/d6-listener-split.md` records that the EVE client itself
 *   refreshes with `client_id` in the body and no secret.
 *
 * A body `client_secret` is accepted, which RFC 6749 permits and discourages.
 * The discouragement is about exposure in logs, and under D1 the whole exchange
 * is plain HTTP (`Basic` is base64, not encryption) and this listener does not
 * log request bodies. Refusing it would break old and varied tools (D4) for no
 * confidentiality gain. Revisit when D14 brings TLS.
 *
 * Form-urlencoding: RFC 6749 section 2.3.1 says both halves of the Basic
 * credential are form-urlencoded before being base64'd. Many clients send raw
 * bytes. Accepting both spellings would give one client two authenticating
 * strings (`lib/clientRegistry.js`'s "exact means exact"), so this module
 * decodes strictly, once, per the RFC. The registry removes the cost from the
 * other end: a configured secret must be drawn from `[A-Za-z0-9._-]`, all fixed
 * points of form-urlencoding, so for a real credential the encoded and raw
 * forms are the same bytes. The strictness refuses a `+` that should have been
 * `%2B`, a stray `%` that decodes to nothing, and a second spelling.
 *
 * Shape:
 *
 *     createClientAuthenticator({ registry }) -> frozen {
 *       authenticate({ headers, body })
 *         -> { ok: true,  clientId, authenticated: boolean,
 *              method: "basic" | "body" }
 *         |  { ok: false, error, errorDescription }
 *
 *       verifyPkce({ codeChallenge, codeChallengeMethod, codeVerifier })
 *         -> { ok: true } | { ok: false, error, errorDescription }
 *
 *       mayRedeem({ authenticated, codeChallenge, codeVerifier })
 *         -> { ok: true } | { ok: false, error, errorDescription }
 *     }
 *
 * There is no success method `"none"` for a request with no credentials: a token
 * request that identifies nobody is `invalid_client`. RFC 6749 section 4.1.3
 * requires `client_id` when the client is not authenticating, and a
 * `{ ok: true, clientId: null }` is the object a caller forgets to check. A
 * refusal cannot be forgotten.
 *
 * What this module does not check: `mayRedeem` takes a boolean, not an identity,
 * so it cannot know that the client who authenticated is the one the code was
 * minted for. Three checks belong to the token route, the only place holding
 * both the credential and `lib/authCodes.js`'s record:
 *
 *   - The authenticated `clientId` must equal the code's `clientId` (RFC 6749
 *     section 4.1.3). Without it, a confidential client with its own valid
 *     secret can redeem a no-challenge code minted for somebody else, which
 *     satisfies the invariant above and still breaks it.
 *   - The presented `redirect_uri` must equal the code's, whenever one was used
 *     at the authorization endpoint.
 *   - The `clientId` compared is the one `authenticate` returned, not a
 *     `client_id` the route re-reads from the body, which would let a request
 *     refused for saying two different things say them again.
 *
 * `registry` is `lib/clientRegistry.js`, injected; only `verifySecret` is
 * called. Nothing here reads configuration, opens a file, looks at a clock or
 * throws on the request path: eve.js treats an unhandled throw as fatal (see
 * `server.js`'s header), and this runs on every token exchange.
 */

"use strict";

const crypto = require("node:crypto");

// Constants

/**
 * RFC 6749 section 5.2's registered error codes, the three this module can
 * reach. Spelled here rather than imported from `lib/errors.js`, which holds
 * ESI's error bodies; this is the SSO surface's vocabulary.
 */
const ERROR = Object.freeze({
  /** Authentication failed, or was attempted two ways at once (section 5.2). */
  INVALID_CLIENT: "invalid_client",
  /** The grant is not one this client may exchange, for any reason (section 5.2). */
  INVALID_GRANT: "invalid_grant",
  /** The request is malformed or self-contradictory, before credentials (section 5.2). */
  INVALID_REQUEST: "invalid_request",
});

/** Where a client's identity was read from, on the success side. */
const METHOD = Object.freeze({
  BASIC: "basic",
  BODY: "body",
});

/**
 * The only PKCE transformation, matching `routes/oauthAuthorize.js`'s
 * `CODE_CHALLENGE_METHOD` and `contract/sso.js`'s advertised method.
 *
 * `plain` is refused here as well as there, and the second refusal is not
 * redundant: the authorize endpoint decides what may be minted, this decides
 * what may be redeemed, and a record reaching redemption with
 * `codeChallengeMethod: "plain"` did not come from that endpoint. Under RFC 7636
 * section 7.2 `plain` protects against nothing an attacker who can read the
 * authorization request cannot defeat, and D1's plain HTTP makes that attacker
 * realistic.
 */
const PKCE_METHOD = "S256";

/**
 * RFC 7636 section 4.1: the verifier is 43 to 128 characters of unreserved
 * ASCII.
 *
 * The lower bound is the RFC's entropy floor (43 base64url characters is the 256
 * bits it asks for). The upper bound and the alphabet keep this from hashing
 * whatever arrives in a form field.
 */
const MIN_VERIFIER_LENGTH = 43;
const MAX_VERIFIER_LENGTH = 128;
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * Mirrors `lib/clientRegistry.js`'s `MAX_CLIENT_ID_LENGTH`, duplicated as
 * `routes/oauthAuthorize.js` duplicates its constants: this module is driven by
 * an injected double in tests and requires no mod module.
 * `test/clientAuth.test.js` asserts the two copies agree.
 */
const MAX_CLIENT_ID_LENGTH = 255;

/**
 * The one sentence every failed credential gets, whichever way it failed.
 *
 * Wrong secret, a secret for a client registered without one, a secret for an
 * unknown `client_id`, an empty half of a Basic credential: all are this string.
 * The differences describe the operator's configuration, and the caller has not
 * authenticated.
 */
const AUTHENTICATION_FAILED =
  "Client authentication failed.";

/**
 * The one sentence every rejected `code_verifier` gets.
 *
 * Too short, too long, wrong alphabet, not a string, simply wrong: one message,
 * because "your guess had the right shape" is a hint to someone guessing.
 */
const VERIFIER_REJECTED =
  "The code_verifier does not match the code_challenge this authorization code was issued with.";

// Small shared shapes

function fail(error, errorDescription) {
  return Object.freeze({ ok: false, error, errorDescription });
}

const GRANTED = Object.freeze({ ok: true });

/**
 * A present, usable string, or `null`.
 *
 * `null` for anything that is not a non-empty string, including an array, which
 * is what a form parser returns for a duplicated field. Callers that care about
 * "absent" versus "duplicated" ask `isDuplicated` first; the rest treat both as
 * absent, so a duplicate is never silently read as its first or last value.
 */
function readString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Did a form parser hand back more than one value for this field? */
function isDuplicated(value) {
  return Array.isArray(value) && value.length > 1;
}

/**
 * One header, by name, case-insensitively.
 *
 * Node lowercases incoming header names, but this module is called with object
 * literals from tests and from routes that may build their own, and a
 * credential read on the wire but not in a unit test is the worst asymmetry.
 *
 * An array value returns a sentinel rather than a string: Node yields one for a
 * header sent twice, and two `Authorization` headers is a request smuggling
 * shape, not a credential. The caller refuses it.
 */
const DUPLICATE_HEADER = Symbol("duplicate-header");

function readHeader(headers, name) {
  if (headers === null || typeof headers !== "object") return null;

  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    if (Array.isArray(value)) return value.length > 1 ? DUPLICATE_HEADER : readString(value[0]);
    return readString(value);
  }
  return null;
}

/**
 * One field out of a parsed form body.
 *
 * A plain object and a `URLSearchParams` are both accepted. `URLSearchParams` is
 * asked with `getAll` so a duplicated field is seen as duplicated rather than
 * collapsed to its first value, matching the plain-object path's
 * `isDuplicated`.
 */
function readField(body, name) {
  if (body === null || typeof body !== "object") return null;

  if (typeof body.getAll === "function") {
    const values = body.getAll(name);
    if (values.length > 1) return values;
    return readString(values[0]);
  }

  const value = body[name];
  if (Array.isArray(value)) return value.length > 1 ? value : readString(value[0]);
  return readString(value);
}

// The Basic credential

/**
 * Canonical base64: groups of four, `A-Za-z0-9+/`, at most two `=` at the end.
 *
 * Checked because `Buffer.from(s, "base64")` is lenient and skips characters it
 * does not recognise, so `"YWJj"`, `"YW!Jj"` and `"YWJj\n\n"` all decode to the
 * same three bytes. Three spellings of one credential is the failure
 * `lib/clientRegistry.js` refuses on redirect URIs.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** `Basic` then at least one space, per RFC 7235 section 2.1, scheme case-insensitive. */
const BASIC_SCHEME_PATTERN = /^Basic +(\S+)$/i;

/**
 * Pull `{ clientId, clientSecret }` out of an `Authorization` header, or say
 * which way it was unusable.
 *
 * Returns `{ credential }` or `{ failure }`. Every failure is `invalid_client`:
 * RFC 6749 section 5.2 assigns that code to missing, malformed or unsupported
 * client authentication. The descriptions differ from each other and from
 * `AUTHENTICATION_FAILED`, because a malformed header is a fact about the bytes
 * the caller sent and leaks no configuration.
 *
 * The split is on the first colon, per RFC 7617 section 2: a userid may not
 * contain one and a password may, so `id:a:b` is the secret `a:b`.
 */
function parseBasic(raw) {
  const match = BASIC_SCHEME_PATTERN.exec(raw.trim());
  if (match === null) {
    return {
      failure: fail(
        ERROR.INVALID_CLIENT,
        "The Authorization header is not an HTTP Basic credential. This endpoint authenticates "
          + "confidential clients with `Authorization: Basic base64(client_id:client_secret)`, "
          + "and public clients by sending client_id in the request body instead.",
      ),
    };
  }

  const encoded = match[1];
  if (!BASE64_PATTERN.test(encoded) || encoded.length % 4 !== 0) {
    return {
      failure: fail(
        ERROR.INVALID_CLIENT,
        "The Authorization header's Basic credential is not valid base64. It must be "
          + "canonically encoded: no whitespace, no line breaks, correct padding.",
      ),
    };
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon === -1) {
    return {
      failure: fail(
        ERROR.INVALID_CLIENT,
        "The Authorization header's Basic credential contains no colon. RFC 7617 encodes it as "
          + "client_id:client_secret, and both halves are required.",
      ),
    };
  }

  // Form-urlencoded, exactly once, per RFC 6749 section 2.3.1. See the file header
  // for why this is strict and why the strictness is free for a real credential.
  const clientId = formDecode(decoded.slice(0, colon));
  const clientSecret = formDecode(decoded.slice(colon + 1));

  if (clientId === null || clientSecret === null) {
    return {
      failure: fail(
        ERROR.INVALID_CLIENT,
        "The Authorization header's Basic credential is not correctly form-urlencoded. "
          + "RFC 6749 §2.3.1 requires the client_id and client_secret to be "
          + "application/x-www-form-urlencoded before they are base64 encoded, so a literal "
          + "percent sign has to be sent as %25.",
      ),
    };
  }

  return { credential: { clientId, clientSecret } };
}

/**
 * `application/x-www-form-urlencoded` decoding of one component, or `null`.
 *
 * `+` is a space and `%XX` is a byte, per RFC 6749 section 2.3.1.
 * `decodeURIComponent` throws on a malformed escape and on invalid UTF-8; the
 * throw is caught and turned into `null`, because a `%zz` in a header must not
 * be able to take the game server down.
 */
function formDecode(component) {
  try {
    return decodeURIComponent(component.replace(/\+/g, " "));
  } catch (_) {
    return null;
  }
}

// The authenticator

/**
 * Build the thing `POST /v2/oauth/token` asks.
 *
 * `registry` is the only dependency and only `verifySecret` is used, so a test
 * can drive the module with `{ verifySecret: () => true }`.
 */
function createClientAuthenticator({ registry } = {}) {
  if (registry === null || typeof registry !== "object"
    || typeof registry.verifySecret !== "function") {
    // Construction, not the request path, so a throw is a startup refusal and not a
    // dead game server.
    throw new TypeError(
      "ESI mod: createClientAuthenticator needs a registry with a verifySecret method: "
        + "lib/clientRegistry.js's createClientRegistry() returns one.",
    );
  }

  /**
   * A per-authenticator key for the PKCE comparison's digests. 32 bytes from the
   * platform CSPRNG, never leaving this closure. See `verifyPkce`.
   */
  const digestKey = crypto.randomBytes(32);

  function digest(value) {
    return crypto.createHmac("sha256", digestKey).update(value, "utf8").digest();
  }

  /**
   * Who is this, and did they prove it?
   *
   * The header wins where there is one (RFC 6749 section 2.3.1 makes it the form a
   * server MUST support and the body form one it MAY), but only after two
   * contradictions are refused outright. A request that says two things about who
   * is calling has an interpretation this server picks and one the caller (or a
   * proxy, or an attacker who added a parameter) intended, and any rule for
   * choosing is a rule somebody can aim.
   *
   *   A Basic header and a body `client_secret` is `invalid_client`, even when
   *   they agree. RFC 6749 section 5.2 lists "more than one authentication method"
   *   as this error, and it is not obvious which credential the server checked.
   *
   *   A Basic header and a body `client_id` that disagree is `invalid_request`,
   *   not `invalid_client`: a body `client_id` without a secret is an identity
   *   claim, not an authentication method, so what is wrong is the request's
   *   coherence. Agreement is permitted and common.
   *
   *   A field sent twice (two `client_id`s, two `Authorization` headers) is
   *   refused before it is read. Which of two values a parser returns is a
   *   property of the parser, and two parts of a stack can disagree about it.
   */
  function authenticate(request) {
    const source = request !== null && typeof request === "object" ? request : {};
    const { headers, body } = source;

    const rawHeader = readHeader(headers, "authorization");
    if (rawHeader === DUPLICATE_HEADER) {
      return fail(
        ERROR.INVALID_REQUEST,
        "The request carries more than one Authorization header. Which credential a server "
          + "reads out of that is not something two implementations agree on, so it is refused "
          + "rather than resolved.",
      );
    }

    const bodyClientId = readField(body, "client_id");
    const bodyClientSecret = readField(body, "client_secret");

    if (isDuplicated(bodyClientId) || isDuplicated(bodyClientSecret)) {
      return fail(
        ERROR.INVALID_REQUEST,
        "The request body repeats client_id or client_secret. RFC 6749 §3.2 says a parameter "
          + "may be sent at most once, and a credential whose value depends on which duplicate "
          + "a parser happened to keep is not one this server will check.",
      );
    }

    if (rawHeader !== null) {
      if (bodyClientSecret !== null) {
        return fail(
          ERROR.INVALID_CLIENT,
          "The request authenticates two ways at once: an Authorization header and a "
            + "client_secret in the body. RFC 6749 §5.2 names this case explicitly. Send one.",
        );
      }

      const { credential, failure } = parseBasic(rawHeader);
      if (failure !== undefined) return failure;

      if (bodyClientId !== null && bodyClientId !== credential.clientId) {
        return fail(
          ERROR.INVALID_REQUEST,
          "The client_id in the Authorization header and the client_id in the request body "
            + "are different. This server does not choose between them.",
        );
      }

      return checkSecret(credential.clientId, credential.clientSecret, METHOD.BASIC);
    }

    if (bodyClientId === null) {
      // Includes the body-secret-without-an-id case: a credential naming nobody is
      // not a credential.
      return fail(
        ERROR.INVALID_CLIENT,
        "The request identifies no client. Send either `Authorization: Basic "
          + "base64(client_id:client_secret)` or a client_id parameter in the request body.",
      );
    }

    if (bodyClientId.length > MAX_CLIENT_ID_LENGTH) {
      // Bounded here as well as at the authorize endpoint, because a code's stored
      // `clientId` came through that check and this one did not.
      return fail(
        ERROR.INVALID_CLIENT,
        `The client_id is longer than the ${MAX_CLIENT_ID_LENGTH} characters this replica `
          + "accepts.",
      );
    }

    if (bodyClientSecret !== null) {
      return checkSecret(bodyClientId, bodyClientSecret, METHOD.BODY);
    }

    // The public client, and the EVE client itself: an identity, no proof, and an
    // honest `authenticated: false`. Whether that is enough is `mayRedeem`'s
    // question.
    return Object.freeze({
      ok: true,
      clientId: bodyClientId,
      authenticated: false,
      method: METHOD.BODY,
    });
  }

  /**
   * Ask the registry, and report the failing cases identically.
   *
   * A wrong secret, a secret for a client registered without one, and a secret
   * for an unlisted `client_id` all leave as the same object.
   * `lib/clientRegistry.js`'s `verifySecret` already makes them the same work (it
   * compares against a random decoy rather than short-circuiting); this is the
   * same words. Either half alone leaks which clients are confidential.
   */
  function checkSecret(clientId, clientSecret, method) {
    // `!== true` rather than a falsiness test: the registry documents a bare
    // boolean, and a double or future implementation returning an object would
    // otherwise authenticate everybody.
    if (registry.verifySecret({ clientId, clientSecret }) !== true) {
      return fail(ERROR.INVALID_CLIENT, AUTHENTICATION_FAILED);
    }
    return Object.freeze({ ok: true, clientId, authenticated: true, method });
  }

  /**
   * `base64url(sha256(code_verifier)) === code_challenge`, in constant time.
   *
   * Both sides are digested to 32 bytes under this authenticator's key and
   * compared with `crypto.timingSafeEqual`. Hashing the challenge as well looks
   * redundant but is not: a stored challenge is 43 to 128 characters and the
   * computed value is always 43, so comparing raw needs a length test, which is
   * an early return on the branch an attacker measures. `timingSafeEqual` would
   * also throw on the mismatch, an oracle and under eve.js fatal. Two digests are
   * always the same length.
   *
   * What still leaks is the length of the verifier the caller sent, their own
   * input, already bounded above; it is the same ceiling `lib/clientRegistry.js`'s
   * `verifySecret` states.
   *
   * Every refusal is `invalid_grant`, RFC 7636 section 4.6's answer for a
   * mismatched verifier, with the same words. A verifier outside section 4.1's 43
   * to 128 unreserved characters is not reported as a malformed request: calling
   * it `invalid_request` would tell a caller which guesses were well-formed.
   *
   * An absent `codeChallenge` is refused rather than passed, so a route that calls
   * this on a no-challenge code gets a refusal instead of a `true`. `mayRedeem`
   * routes that case correctly; this is the backstop for a caller that skipped it.
   */
  function verifyPkce(request) {
    const source = request !== null && typeof request === "object" ? request : {};
    const { codeChallenge, codeChallengeMethod, codeVerifier } = source;

    const challenge = readString(codeChallenge);
    if (challenge === null) {
      return fail(
        ERROR.INVALID_GRANT,
        "This authorization code carries no PKCE challenge, so there is nothing for a "
          + "code_verifier to be checked against.",
      );
    }

    if (codeChallengeMethod !== PKCE_METHOD) {
      return fail(
        ERROR.INVALID_GRANT,
        `This replica supports the ${PKCE_METHOD} code challenge method only, which is also `
          + "what its discovery document advertises. A plain challenge protects against "
          + "nothing an attacker who can read the authorization request cannot defeat.",
      );
    }

    const verifier = readString(codeVerifier);
    if (verifier === null || !VERIFIER_PATTERN.test(verifier)) {
      return fail(ERROR.INVALID_GRANT, VERIFIER_REJECTED);
    }

    const computed = crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");

    if (!crypto.timingSafeEqual(digest(computed), digest(challenge))) {
      return fail(ERROR.INVALID_GRANT, VERIFIER_REJECTED);
    }

    return GRANTED;
  }

  /**
   * The invariant: three lines of truth table, and the third is the one.
   *
   * `authenticated` is compared against `true` identically, not for truthiness. A
   * caller that passed the string `"false"`, an options object, or the result of
   * `authenticate()` instead of its `authenticated` field would otherwise have
   * authenticated every public client, and it would look correct at every call
   * site.
   *
   * `ok: true` means "the rule permits this redemption". When the code carries a
   * challenge it means a verifier is present and must now be checked by
   * `verifyPkce`, never that the verifier is correct. They are separate so the rule
   * can be asserted without a hash and the hash without the rule.
   *
   * The refusals are `invalid_grant`, not `invalid_client`, including when a
   * client failed to authenticate. This is the anti-oracle property: the token
   * endpoint flattens every `lib/authCodes.js` outcome onto `invalid_grant` so a
   * caller holding a stolen code cannot learn from the error code whether it was
   * real. `invalid_client` for "this code exists and needs client authentication"
   * would hand that back one code at a time.
   */
  function mayRedeem(request) {
    const source = request !== null && typeof request === "object" ? request : {};
    const { authenticated, codeChallenge, codeVerifier } = source;

    const hasChallenge = readString(codeChallenge) !== null;
    const hasVerifier = readString(codeVerifier) !== null;
    const isAuthenticated = authenticated === true;

    if (hasChallenge) {
      // Authentication is irrelevant on this branch, by design: a confidential client
      // that used PKCE still has to produce the verifier, because the code was bound
      // to it and a binding that a second credential can waive is not a binding.
      if (!hasVerifier) {
        return fail(
          ERROR.INVALID_GRANT,
          "This authorization code was issued with a PKCE challenge, so it can only be "
            + "redeemed by presenting the matching code_verifier.",
        );
      }
      return GRANTED;
    }

    if (hasVerifier) {
      // A verifier against a code that carries no challenge. Probably a client whose
      // challenge was lost between the two requests, which on D1's plain HTTP is what
      // a stripping attacker looks like from the server's side. Refused rather than
      // ignored: accepting it would let one code be redeemed under two rule sets, and
      // the client would never learn its PKCE was not in force.
      return fail(
        ERROR.INVALID_GRANT,
        "A code_verifier was presented for an authorization code that carries no PKCE "
          + "challenge. The challenge was lost between the authorization request and this "
          + "one, so the exchange is refused rather than completed without it.",
      );
    }

    if (isAuthenticated) return GRANTED;

    // The third case of the truth table: an `if (challenge)` with no `else` lands
    // here and silently grants the code to whoever holds it. See the header.
    return fail(
      ERROR.INVALID_GRANT,
      "This authorization code was issued without a PKCE challenge, so it can only be "
        + "redeemed by a client that authenticates with its client secret. A code with "
        + "neither a challenge nor an authenticated client is not exchangeable.",
    );
  }

  return Object.freeze({ authenticate, verifyPkce, mayRedeem });
}

module.exports = Object.freeze({
  AUTHENTICATION_FAILED,
  ERROR,
  MAX_CLIENT_ID_LENGTH,
  MAX_VERIFIER_LENGTH,
  METHOD,
  MIN_VERIFIER_LENGTH,
  PKCE_METHOD,
  VERIFIER_PATTERN,
  VERIFIER_REJECTED,

  createClientAuthenticator,
});
