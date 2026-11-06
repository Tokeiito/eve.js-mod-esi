/**
 * What the SSO surface sends, as observed on `login.eveonline.com`.
 *
 * `contract/wire.js` records observed wire behaviour for `esi.evetech.net`. This
 * file records it for `login.eveonline.com`, a separate hostname run by different
 * code. Almost nothing in `wire.js` is known to hold here: the three JSON
 * spellings, the trailing newline that follows the content-type,
 * `X-Compatibility-Date`, the tenant check, both limiters and `Vary` as three
 * lines are all facts about ESI's two producers, established by curling ESI. D6
 * puts the two surfaces on separate listeners (`26005` and `26006`) for the same
 * reason.
 *
 * Same discipline (D23): hand-written protocol constants, each with the date and
 * source, never a recorded fixture corpus. Node builtins only (D5/D20); nothing
 * under `contract/` is anyone's character data, and the test suite never opens a
 * socket.
 *
 * Sources
 *
 * Transcribed from recorded observations of `GET /oauth/jwks`,
 * `GET /.well-known/oauth-authorization-server` and a decoded access token against
 * `https://login.eveonline.com`, on the date in `ESTABLISHED`. All three were
 * recorded as pretty-printed JSON, which is what a client *parses*. That says
 * nothing about bytes: not the separator spacing, the indentation or the last
 * byte of the body. `UNOBSERVED` names those questions.
 *
 * A JWT's payload is base64url inside a signature, so its transcription is what a
 * decoder printed. Member order therefore has the same standing as
 * `JWKS_KEY_MEMBER_ORDER`: recorded because matching it is nearly free, believed
 * because decoders ordinarily preserve insertion order, and load-bearing for
 * nothing surveyed. The claim *set* and claim *types* are protocol, and
 * `ACCESS_TOKEN_CLAIM_TYPES` pins them.
 *
 * `wire.js`'s rule applies: a value nobody has observed does not belong in this
 * file.
 *
 * Scope
 *
 * Constants only. It assembles no document and serves no response:
 * `routes/oauthJwks.js` and `routes/oauthDiscovery.js` import from here. As D22
 * gives for `spec.js` and `wire.js`, a test composing a contract module with a
 * route module shows which source each assertion stands on, and a contract module
 * that builds its own answer can only agree with itself.
 *
 * Quirks preserved on purpose
 *
 * Design constraint 3 (fidelity beats hygiene) applies. The SSO documents contain
 * four things a reviewer would fix on sight, each load-bearing because a real
 * client string-compares it: `SSO_ORIGIN` (no trailing slash),
 * `DISCOVERY_ENDPOINT_PATHS.jwks` (not under `/v2/`),
 * `DISCOVERY_CONSTANTS.id_token_signing_alg_values_supported` (`HS256` against an
 * `RS256` signature) and `JWKS_KID` (a literal, not a thumbprint).
 * `test/ssoWire.test.js` asserts all four are still here.
 *
 * The access token carries its own set: an `aud` that is an array of exactly two
 * with a space in the second entry, a `scp` whose *type* depends on how many
 * scopes it holds, a `kid` written twice, an `owner` in standard base64 while
 * every segment around it is base64url, and an `iss` that is a bare hostname where
 * the discovery document's `issuer` is an absolute URL. The last is the one place
 * this replica deliberately does **not** match CCP: see `ACCESS_TOKEN_ISS`.
 */

"use strict";

/** The date the values in this file were established, from the JWKS and discovery observations. */
const ESTABLISHED = "2026-08-24";

/**
 * CCP's own SSO origin, **for reference and diffing only.**
 *
 * This replica does not serve it and must not put it in a document. D7 settles
 * that the issuer is a *configured* value, an absolute URL with an explicit scheme,
 * no trailing slash and no path, chosen by the operator before the first token is
 * signed; `routes/oauthDiscovery.js` substitutes it everywhere CCP's document
 * carries this one. The value here is used to read the observations back as
 * absolute URLs and to diff our document's *shape* against CCP's without a network
 * call.
 *
 * Quirk 1 of 4: no trailing slash
 *
 * `https://login.eveonline.com`, not `https://login.eveonline.com/`. This is the
 * `issuer` member verbatim, and OAuth/OIDC issuer comparison is *exact string*
 * comparison: a validator configured with the slashed form rejects every token
 * from the unslashed one. `issuer:` is the common library idiom, so this population
 * is likely and hard to enumerate (see the migration table in
 * `docs/d6-listener-split.md`).
 *
 * A configured issuer inherits the constraint: it is fetched as written, so it must
 * be reachable and must not end in a slash. That check belongs to whatever
 * validates the operator's configuration.
 *
 * CCP does **not** keep `iss` and `issuer` equal: the token claim is the bare
 * hostname `login.eveonline.com` and the document's `issuer` is this string. D7
 * collapses them into one value here, because D1's plain HTTP makes the bare form
 * unusable (the EVE client supplies `https` to a scheme-less `iss`). Nothing in the
 * ecosystem compared the two, so nothing breaks.
 */
const SSO_ORIGIN = "https://login.eveonline.com";

// JWKS: GET /oauth/jwks

/**
 * The JWKS path, which is **not** under `/v2/`.
 *
 * Quirk 2 of 4
 *
 * Every other SSO endpoint lives at `/v2/oauth/...`; this one lives at
 * `/oauth/jwks`. `jwks_uri` in the discovery document points here,
 * `DISCOVERY_ENDPOINT_PATHS` repeats it, and a client that has cached either asks
 * for this exact path.
 *
 * A route table written by pattern ("the SSO endpoints are `/v2/oauth/*`") would
 * mount this at `/v2/oauth/jwks` while the discovery document keeps advertising
 * `/oauth/jwks`. Token *issue* still succeeds; only verification fails.
 */
const JWKS_PATH = "/oauth/jwks";

/**
 * `kid`, a literal string rather than anything derived.
 *
 * Quirk 3 of 4
 *
 * `JWT-Signature-Key`. Not an RFC 7638 thumbprint, a UUID or a rotation counter,
 * but a constant stable long enough for third-party validators to pin it, as the
 * JWKS observation records. Generating one from the key material (what every JOSE
 * library does, and correct on a surface nobody has pinned) makes this replica's
 * tokens unverifiable by anything holding the pin.
 *
 * `docs/d6-listener-split.md` notes the consequence: because the `kid` is not
 * derived from the origin, it survives an issuer change (the one row in that
 * migration table reading "Unaffected"). The cost: if the signing key is ever
 * replaced, the `kid` cannot distinguish old from new, so key rollover on this
 * surface has no overlap window. That is CCP's design.
 */
const JWKS_KID = "JWT-Signature-Key";

/**
 * The algorithm we publish and sign with.
 *
 * Real CCP publishes **two** keys, an ES256 alongside this RS256 one, and signs with
 * RS256. We publish the RS256 key only, deliberately: a key we publish and never
 * sign with is a key a client may try to verify against.
 *
 * A client selecting the key by `kid` or by `alg` gets the RS256 key from a one-key
 * set exactly as from CCP's two-key set. A client walking the array expecting index
 * 1 to exist would break; nothing in the ecosystem survey does that, which is the
 * whole of the evidence.
 *
 * Recorded as `JWKS_CCP_EXTRA_ALGS` below so a diff can see the difference.
 */
const JWKS_ALG = "RS256";

/**
 * The member order inside a key object, exactly as observed.
 *
 * Alphabetical for the first five and then `n` last, which is what a .NET
 * serializer emits. JSON member order is semantically irrelevant to parsers; it is
 * recorded for the same reason `wire.js` records that CCP spells the header `Etag`,
 * and matching it costs one array.
 *
 * Its practical use is narrow: this is what a byte-comparison test asserts our
 * serializer emits. No client in the ecosystem survey is known to depend on it.
 */
const JWKS_KEY_MEMBER_ORDER = Object.freeze(["alg", "e", "kid", "kty", "use", "n"]);

/**
 * The members of a key object whose values do not depend on the key material.
 *
 * Split out so `test/ssoWire.test.js` can check the two halves cover the observed
 * shape exactly, the same union check the discovery document gets below. It catches
 * a member dropped during a refactor.
 */
const JWKS_KEY_CONSTANTS = Object.freeze({
  alg: JWKS_ALG,
  kid: JWKS_KID,
  kty: "RSA",
  use: "sig",
});

/**
 * The other half: the two members carrying the actual public key.
 *
 * `e` is the exponent (`AQAB`, 65537, for every RSA key generated in practice) and
 * `n` is the base64url modulus. Both come from the signing key at runtime, so they
 * are named here and valued nowhere: this file has no key and must never grow one.
 */
const JWKS_KEY_MATERIAL_MEMBERS = Object.freeze(["e", "n"]);

/**
 * The non-standard top-level member, and why it stays.
 *
 * `"SkipUnresolvedJsonWebKeys": true` is not in RFC 7517. It is a
 * Microsoft.IdentityModel serialization artefact that CCP has never trimmed, sitting
 * beside `keys` at the top level of the JWKS document.
 *
 * It is preserved because, as the JWKS observation records, some cached client
 * fixtures compare against it. A fixture recorded from CCP and replayed against this
 * replica is a whole-document comparison, and a missing member fails as hard as a
 * wrong `kid` (design constraint 3).
 *
 * The name is exported separately from the value (`JWKS_SKIP_UNRESOLVED_VALUE`), so
 * a caller writing the member gets both from one place. The capitalisation is CCP's
 * and is as load-bearing as `Etag` is on the ESI side.
 */
const JWKS_SKIP_UNRESOLVED_MEMBER = "SkipUnresolvedJsonWebKeys";

/** The value that member carries, observed as the boolean `true`, not `"true"`. */
const JWKS_SKIP_UNRESOLVED_VALUE = true;

/**
 * The top-level member order of the JWKS document: `keys`, then the .NET artefact.
 *
 * The artefact comes *second*. A serializer emitting it before `keys` is equally
 * plausible and is not what was observed.
 */
const JWKS_MEMBER_ORDER = Object.freeze(["keys", JWKS_SKIP_UNRESOLVED_MEMBER]);

/**
 * What CCP publishes here that we do not, as data.
 *
 * One entry: `ES256`. See `JWKS_ALG` for why the narrowing is deliberate. A future
 * diff of our JWKS against a fresh capture of CCP's has one expected difference and
 * can say so.
 */
const JWKS_CCP_EXTRA_ALGS = Object.freeze(["ES256"]);

// OAuth discovery: GET /.well-known/oauth-authorization-server

/**
 * Both paths the discovery document is served at.
 *
 * CCP publishes `/.well-known/oauth-authorization-server`. **The EVE game client asks
 * for `/.well-known/oauth-authorization-server/`**, with the trailing slash.
 * `docs/d6-listener-split.md` has the evidence: build 3396210's
 * `clientRefreshToken/discovery_hacks.py` carries
 * `WELL_KNOWN_PATH = '/.well-known/oauth-authorization-server/'` as a literal and
 * rewrites whatever path the token's `iss` claim had into exactly that.
 *
 * That rewrite is also why the SSO surface owns a whole origin (D6): the path in
 * `iss` is discarded before the request is made, so no `iss` can name a
 * path-prefixed discovery document, and option C (`.../sso` on the ESI port) cannot
 * work.
 *
 * Serve **both**, as two routes to one document. Whether the client's fetch follows a
 * 3XX is unobserved, and it retries only ten times at one second apart before the
 * session degrades about twenty minutes in, so a redirect is not an option here.
 *
 * Ordered CCP's first, so anything treating the head as canonical picks the path CCP
 * publishes.
 */
const DISCOVERY_PATHS = Object.freeze([
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/",
]);

/**
 * The OIDC discovery path, recorded and **not** thereby served.
 *
 * CCP does not serve this. Many OIDC libraries probe
 * `/.well-known/openid-configuration` *first* and only fall back to the OAuth path,
 * so a replica answering it is easier to point a generic library at than CCP is.
 *
 * **Whether we serve it is the route's decision.** This file names the path and states
 * the two facts the decision turns on:
 *
 *   - Fidelity (design constraint 3) argues against. CCP does not serve it, and a client
 *     that probes it against real CCP already handles the fallback.
 *   - The document would be wrong in one member if served unchanged.
 *     `id_token_signing_alg_values_supported: ["HS256"]` is harmless on an OAuth
 *     document; on an *OpenID Connect* document it is the member a client uses to
 *     choose how to verify an ID token, and it disagrees with the RS256 we sign with.
 *     A library that probed OIDC-first and believed it would fail verification against
 *     a correctly signed token.
 *
 * `routes/oauthDiscovery.js` decides.
 */
const OPENID_DISCOVERY_PATH = "/.well-known/openid-configuration";

/**
 * The path component of each endpoint the discovery document advertises.
 *
 * Paths, not URLs. The document carries absolute URLs, each `<issuer> + <path>`, which
 * under D7 means *the configured issuer*, not `SSO_ORIGIN`. This split stops CCP's
 * hostname being pasted into a served document, and `docs/d6-listener-split.md` commits
 * to it: "every absolute URL in the discovery document is built from one issuer string".
 *
 * Quirk 2 again
 *
 * Four of these five are under `/v2/oauth/`. `jwks` is `/oauth/jwks`, the same string as
 * `JWKS_PATH`, referenced rather than retyped so the two cannot drift. A test asserts
 * that identity, because "the discovery document advertises a JWKS URI that is not where
 * we mounted the JWKS" is a defect no unit test of either half would catch.
 *
 * `userinfo` is `/v2/oauth/verify`
 *
 * Not `/userinfo`, which the OIDC name suggests. CCP's verify endpoint predates the OIDC
 * framing and the discovery document points the OIDC member at it.
 */
const DISCOVERY_ENDPOINT_PATHS = Object.freeze({
  authorization: "/v2/oauth/authorize",
  token: "/v2/oauth/token",
  userinfo: "/v2/oauth/verify",
  jwks: JWKS_PATH,
  revocation: "/v2/oauth/revoke",
});

/**
 * Which document member each of those paths becomes, as a map from the member name to
 * its key in `DISCOVERY_ENDPOINT_PATHS`.
 *
 * The member names are not derivable from the keys (`jwks` becomes `jwks_uri` while the
 * other four take `_endpoint`), so the mapping is data. An assembler can walk
 * `DISCOVERY_MEMBER_ORDER` and look up what to write, and the test can compute the
 * document's full member set from its two halves.
 */
const DISCOVERY_ENDPOINT_MEMBERS = Object.freeze({
  authorization_endpoint: "authorization",
  token_endpoint: "token",
  userinfo_endpoint: "userinfo",
  jwks_uri: "jwks",
  revocation_endpoint: "revocation",
});

/**
 * Every member whose value depends on the issuer: `issuer` itself, plus the five
 * endpoint URLs built from it.
 *
 * The complement of `DISCOVERY_CONSTANTS`, and the pair is exhaustive, which
 * `test/ssoWire.test.js` checks against `DISCOVERY_MEMBER_ORDER`. A member in the order
 * but in neither half would have no source of truth.
 */
const DISCOVERY_ISSUER_DERIVED_MEMBERS = Object.freeze([
  "issuer",
  ...Object.keys(DISCOVERY_ENDPOINT_MEMBERS),
]);

/**
 * The members whose values are fixed (no issuer in them), so they are copied verbatim
 * into the document this replica serves.
 *
 * Quirk 4 of 4: `id_token_signing_alg_values_supported` is HS256
 *
 * CCP signs access tokens with **RS256** (what `JWKS_ALG` publishes and what the key at
 * `/oauth/jwks` is for), and this member says `HS256`. The two disagree, in the document,
 * on CCP's live surface.
 *
 * It is preserved because clients string-compare it and because the consumer that matters
 * never reads it: the EVE client takes only `token_endpoint` from this document. The
 * member is inert where it is served, which is the argument against serving it at
 * `OPENID_DISCOVERY_PATH`, above. Do not change it to `["RS256"]`: some client may have
 * byte-compared this document against CCP's for years. The test enforces this.
 *
 * The rest, and what is absent
 *
 * `code_challenge_methods_supported: ["S256"]`: PKCE, `S256` only, no `plain`.
 * `response_types_supported` carries `token` beside `code`, so the implicit flow is still
 * advertised. Both auth-method lists are identical and both include `client_secret_jwt`,
 * whose signing algs are the `HS256` in `token_endpoint_auth_signing_alg_values_supported`.
 * That one is correct: `client_secret_jwt` is HMAC by definition. The `id_token` member
 * beside it is probably a wrong copy of it, so the two are not the same mistake.
 *
 * Absent, and not to be added: `scopes_supported`, `grant_types_supported`,
 * `introspection_endpoint`, `service_documentation`. Some libraries read a discovery
 * document as a closed statement of capability, and adding a member CCP does not publish
 * is the same class of divergence as omitting one.
 */
const DISCOVERY_CONSTANTS = Object.freeze({
  response_types_supported: Object.freeze(["code", "token"]),
  subject_types_supported: Object.freeze(["public"]),
  revocation_endpoint_auth_methods_supported: Object.freeze([
    "client_secret_basic",
    "client_secret_post",
    "client_secret_jwt",
  ]),
  token_endpoint_auth_methods_supported: Object.freeze([
    "client_secret_basic",
    "client_secret_post",
    "client_secret_jwt",
  ]),
  id_token_signing_alg_values_supported: Object.freeze(["HS256"]),
  token_endpoint_auth_signing_alg_values_supported: Object.freeze(["HS256"]),
  code_challenge_methods_supported: Object.freeze(["S256"]),
});

/**
 * The top-level member order, exactly as observed.
 *
 * Not grouped and not alphabetical: `response_types_supported` sits between
 * `userinfo_endpoint` and `jwks_uri`, splitting the endpoint members into two runs, and
 * `subject_types_supported` lands after `revocation_endpoint` rather than beside the other
 * `_supported` lists. It cannot be derived, so it is recorded.
 *
 * As with `JWKS_KEY_MEMBER_ORDER`: order is irrelevant to every JSON parser, no client in
 * the ecosystem survey is known to depend on it, and matching it is nearly free.
 *
 * This array is also the document's *membership*, which does matter:
 * `test/ssoWire.test.js` holds it to exactly the union of
 * `DISCOVERY_ISSUER_DERIVED_MEMBERS` and `DISCOVERY_CONSTANTS`' keys.
 */
const DISCOVERY_MEMBER_ORDER = Object.freeze([
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

/**
 * CCP's document as recorded, **reference only, never served.**
 *
 * The absolute URLs name `login.eveonline.com`, so nothing may copy a value out of this
 * object into a response; D7's configured issuer is what our document carries.
 * `test/ssoWire.test.js` reassembles it from `SSO_ORIGIN`, `DISCOVERY_ENDPOINT_PATHS`,
 * `DISCOVERY_CONSTANTS` and `DISCOVERY_MEMBER_ORDER` and compares member for member.
 *
 * Every other assertion in that file compares our constants with each other, so they all
 * pass if `"/v2/oauth/authroize"` was typed once. This is the transcription they are
 * checked against, for the same reason `wire.js` keeps `ERROR_BYTES` as literal strings.
 */
const CCP_DISCOVERY_DOCUMENT = Object.freeze({
  issuer: "https://login.eveonline.com",
  authorization_endpoint: "https://login.eveonline.com/v2/oauth/authorize",
  token_endpoint: "https://login.eveonline.com/v2/oauth/token",
  userinfo_endpoint: "https://login.eveonline.com/v2/oauth/verify",
  response_types_supported: Object.freeze(["code", "token"]),
  jwks_uri: "https://login.eveonline.com/oauth/jwks",
  revocation_endpoint: "https://login.eveonline.com/v2/oauth/revoke",
  subject_types_supported: Object.freeze(["public"]),
  revocation_endpoint_auth_methods_supported: Object.freeze([
    "client_secret_basic",
    "client_secret_post",
    "client_secret_jwt",
  ]),
  token_endpoint_auth_methods_supported: Object.freeze([
    "client_secret_basic",
    "client_secret_post",
    "client_secret_jwt",
  ]),
  id_token_signing_alg_values_supported: Object.freeze(["HS256"]),
  token_endpoint_auth_signing_alg_values_supported: Object.freeze(["HS256"]),
  code_challenge_methods_supported: Object.freeze(["S256"]),
});

// The access token: a decoded JWT

/**
 * The JOSE header.
 *
 * `{"alg":"RS256","kid":"JWT-Signature-Key","typ":"JWT"}`. Both values are the ones the
 * JWKS publishes, referenced rather than retyped so the token and the key set cannot
 * drift: a header naming a `kid` the document does not contain is rejected by every
 * validator with a message about the signature.
 *
 * `typ: "JWT"` is optional by RFC 7515 §4.1.9 and present here. Libraries check it before
 * deciding a compact serialization is worth parsing.
 */
const ACCESS_TOKEN_JOSE_HEADER_MEMBER_ORDER = Object.freeze(["alg", "kid", "typ"]);

const ACCESS_TOKEN_JOSE_HEADER = Object.freeze({
  alg: JWKS_ALG,
  kid: JWKS_KID,
  typ: "JWT",
});

/**
 * `sub`, and the regex the ecosystem parses it with.
 *
 * `CHARACTER:EVE:123123`, read by `/CHARACTER:EVE:(\d+)/i`. The prefix is a namespace (CCP
 * issues tokens for subjects that are not characters), and a replica with only characters
 * must still use CCP's spelling. Anything else (a bare integer, `CHARACTER:TQ:`, a
 * lower-cased prefix without the `i` flag on the reader's side) fails the match rather than
 * the token, so the consumer reports *no character* instead of *bad subject*.
 *
 * Recorded as the regex because it is the *consumer's* code: it is unanchored, so a subject
 * with anything before or after it still matches.
 */
const ACCESS_TOKEN_SUBJECT_PREFIX = "CHARACTER:EVE:";
const ACCESS_TOKEN_SUBJECT_PATTERN = Object.freeze(/CHARACTER:EVE:(\d+)/i);

/**
 * The second `aud` entry: two words, one space, capital `O`.
 *
 * `aud` is `["<client_id>", "EVE Online"]`, an array of **exactly two**. Do not use RFC 7519
 * §4.1.3's permission to collapse a single-element audience to a bare string: a validator
 * doing `aud.includes(...)` throws on a string that happens to contain the substring and
 * passes on one that does not.
 *
 * The literal doubles as a service identifier for tools deciding "is this an EVE SSO token at
 * all", so its exact spelling is protocol.
 */
const ACCESS_TOKEN_AUDIENCE_LITERAL = "EVE Online";

/** `exp - iat`, in seconds.  Twenty minutes, exactly, on every token. */
const ACCESS_TOKEN_LIFETIME_SECONDS = 1200;

/**
 * `scp`, whose **type** depends on how many scopes the token carries, and whose record
 * disagrees with itself.
 *
 * The recorded note says CCP emits a bare string for exactly one scope and an array for more.
 * The reproduced body, transcribed into `CCP_ACCESS_TOKEN_CLAIMS` below, carries **one** scope
 * **as an array**. Both cannot be a literal record of the same token: the body may have been
 * edited down from a multi-scope token, the decoder may have normalised, or the single-scope
 * rule may be narrower than stated. Nobody has curled CCP for a one-scope token, so both facts
 * are kept.
 *
 * `ours` is unaffected: this replica emits an array for every scope count. `lib/accessToken.js`
 * has the argument: the array branch exists in every consumer that survives a two-scope token
 * at CCP, while the string branch is the one that produces `scopes.map is not a function`.
 */
const ACCESS_TOKEN_SCP = Object.freeze({
  /** The rule as stated in the record, for tokens read from CCP. */
  ccpSingleScopeIsBareString: true,
  /** The record's own reproduced body, which shows one scope as an array. */
  ccpReproducedBodyIsArray: true,
  /** Ours: an array at every scope count, including zero and one. */
  oursAlwaysArray: true,
});

/**
 * `iss`, **the one claim this replica deliberately does not match.**
 *
 * CCP's is the bare hostname `login.eveonline.com` (no scheme, no trailing slash) while the
 * discovery document's `issuer` is `https://login.eveonline.com`. That works for CCP because
 * the EVE client supplies `https` to a scheme-less `iss` before fetching.
 *
 * D7 collapses the two into one value and requires an explicit scheme, and
 * `docs/d6-listener-split.md` shows why: under D1's plain HTTP on a non-standard port, a bare
 * `host.local:26006` parses as scheme `host.local`, and a bare `host.local` loses the port and
 * is fetched over a scheme this replica does not answer. The same client rewrite discards
 * `iss`'s path, which is why the issuer may not carry one.
 *
 * There is therefore **no value for `ours` in this file**: the issuer is configuration (D7),
 * chosen by the operator before the first token is signed, and `lib/accessToken.js` takes it
 * as an argument and emits it unchanged.
 *
 * Do not restore the bare hostname from the recorded body: that produces a discovery URL of
 * `host.local://26006/...` and an EVE client that cannot refresh, roughly twenty minutes after
 * a successful login.
 */
const ACCESS_TOKEN_ISS = Object.freeze({
  /** Observed, and not reproduced: a bare hostname with no scheme. */
  ccp: "login.eveonline.com",
  ccpHasScheme: false,
  /**
   * Ours is the configured issuer string, verbatim: an absolute URL with an explicit scheme, no
   * trailing slash and no path (D7). No value here.
   */
  oursIsConfiguredIssuer: true,
});

/**
 * `owner`, which is **standard** base64 in a token made of base64url.
 *
 * The recorded value is `8PmzCeTKb4VFUDrHLc/AeZXDSWM=`: 28 characters, one pad byte, one `/`.
 * That is 20 bytes of digest in RFC 4648 §4's alphabet, inside a JWS payload segment in §5's
 * URL-safe alphabet. Correcting it changes a string clients compare against one stored from
 * CCP.
 *
 * `sample` is kept as the evidence for `bytes`, and the `/` in it proves the alphabet is the
 * standard one. It is CCP's illustrative value and nobody's character data.
 *
 * The claim is a hash of character ownership state, so it must be stable per character and
 * must change when ownership changes, because clients use a change to invalidate stored
 * tokens. What CCP hashes is not recorded (see `UNOBSERVED.accessTokenOwnerHashInput`), so
 * `lib/accessToken.js` designs its own derivation and documents what it does and does not
 * detect.
 */
const ACCESS_TOKEN_OWNER = Object.freeze({
  base64: "standard",
  padded: true,
  characters: 28,
  bytes: 20,
  sample: "8PmzCeTKb4VFUDrHLc/AeZXDSWM=",
});

/**
 * The payload's member order, as transcribed.
 *
 * Same standing as `JWKS_KEY_MEMBER_ORDER`, and weaker evidence than a document's (see the
 * file header). Two things worth naming so a re-sort fails loudly: `kid` sits in the body
 * between `jti` and `sub` rather than beside the header's copy, and `exp` precedes `iat`.
 */
const ACCESS_TOKEN_CLAIM_ORDER = Object.freeze([
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

/**
 * Every claim's type, the half of the shape that is protocol.
 *
 * A recorded real CCP token and one of ours must differ only in values, never in claim set
 * or types, and this table plus `ACCESS_TOKEN_CLAIM_ORDER` is what
 * a diff is made against. The spellings are deliberately crude (`string`, `number`, `string[]`)
 * so this does not imply a schema beyond the evidence.
 *
 * `exp` and `iat` are **numbers**, not numeric strings. RFC 7519 §4.1.4 says so, every validator
 * coerces or refuses, and a JSON serializer handed a `Date` produces an ISO string.
 *
 * `scp` is `string[]` here because that is what this replica emits and what the reproduced body
 * shows; `ACCESS_TOKEN_SCP` carries the variance.
 */
const ACCESS_TOKEN_CLAIM_TYPES = Object.freeze({
  scp: "string[]",
  jti: "string",
  kid: "string",
  sub: "string",
  azp: "string",
  tenant: "string",
  tier: "string",
  region: "string",
  aud: "string[]",
  name: "string",
  owner: "string",
  exp: "number",
  iat: "number",
  iss: "string",
});

/**
 * The claims whose values are the same on every token this replica issues.
 *
 * `tenant` is D26's `tranquility`, the one datasource: the set of valid datasources is shrinking,
 * and a replica answering to its own name would be differently shaped from CCP. Some tools assert
 * on it. `lib/tenant.js` holds the deployable copy of that string, and `lib/accessToken.js` imports
 * it from there.
 *
 * `tier` and `region` describe CCP's deployment topology and mean nothing on a private server. They
 * are reproduced because a token must match CCP's claim *set*, and because the truthful
 * alternatives (`"private"`, `"local"`) are values no consumer has seen.
 *
 * `kid` is here because there is exactly one signing slot (D8) and it is permanently named.
 */
const ACCESS_TOKEN_CONSTANT_CLAIMS = Object.freeze({
  kid: JWKS_KID,
  tenant: "tranquility",
  tier: "live",
  region: "world",
});

/**
 * The other ten: everything whose value comes from the grant, the clock, the key set or the
 * configuration.
 *
 * Split out as `JWKS_KEY_CONSTANTS` and `JWKS_KEY_MATERIAL_MEMBERS` are: `test/ssoWire.test.js`
 * checks the two halves cover `ACCESS_TOKEN_CLAIM_ORDER` exactly and overlap nowhere.
 */
const ACCESS_TOKEN_VARIABLE_CLAIMS = Object.freeze([
  "scp",
  "jti",
  "sub",
  "azp",
  "aud",
  "name",
  "owner",
  "exp",
  "iat",
  "iss",
]);

/**
 * The decoded token as recorded, **reference only, never minted.**
 *
 * Same rule as `CCP_DISCOVERY_DOCUMENT`: nothing may copy a value out of here into a token. `iss`
 * names CCP's origin, `azp` is a client id that is not ours, `sub` is a character that does not
 * exist on this server, and `owner` is a hash of ownership state nobody here can reproduce.
 *
 * The other assertions in `test/ssoWire.test.js` compare this file's constants with each other, so
 * the decomposed tables are rebuilt and checked against this. `test/accessToken.test.js` diffs a
 * real minted token's claim set and types against it, without needing a real CCP token.
 *
 * **Two values are placeholders in the record itself**, kept as the angle-bracketed strings written
 * there. `jti` was recorded as `<uuid>` and `azp` (which reappears as `aud[0]`) as `<client_id>`,
 * because a real token's `jti` and client id are somebody's. Inventing values would fabricate an
 * observation. This object is compared for its claim *set*, *order* and *types*, and a placeholder
 * is still a string. `exp - iat` still checks out to 1200, because those two were not redacted.
 */
const CCP_ACCESS_TOKEN_CLAIMS = Object.freeze({
  scp: Object.freeze(["esi-skills.read_skills.v1"]),
  jti: "<uuid>",
  kid: "JWT-Signature-Key",
  sub: "CHARACTER:EVE:123123",
  azp: "<client_id>",
  tenant: "tranquility",
  tier: "live",
  region: "world",
  aud: Object.freeze(["<client_id>", "EVE Online"]),
  name: "Some Bloke",
  owner: "8PmzCeTKb4VFUDrHLc/AeZXDSWM=",
  exp: 1648563218,
  iat: 1648562018,
  iss: "login.eveonline.com",
});

/** The two members the record redacts. Named so a test can skip their values. */
const CCP_ACCESS_TOKEN_PLACEHOLDERS = Object.freeze(["jti", "azp"]);

// Verify and revoke
//
// The record names both surfaces and verify's seven body members, and records two wire facts: the
// PascalCase member names, and that a refusal on this pair is `text/html` rather than the token
// endpoint's JSON. It records no member **values**, no member **types**, no refusal body and no
// response header.
//
// So the *shape* is transcribed here, and the values the route had to choose are named in
// `UNOBSERVED` and decided in `routes/oauthVerify.js`, beside the code that emits them.
//
// `VERIFY_MEMBER_PROVENANCE` is one label per member saying how well-sourced the emitted value is:
// "we know the member is called `TokenType`" and "we know what CCP puts in it" are different claims.

/**
 * Verify's two paths, and the second is not under `/v2/`.
 *
 * Quirk 2 again. `/oauth/verify` is recorded as a "still-live legacy alias": the path every tool
 * written before the JWT migration calls, the population D4 describes. The `/v2/` spelling is
 * referenced out of `DISCOVERY_ENDPOINT_PATHS` rather than retyped, so the document's
 * `userinfo_endpoint` and the route's mount cannot drift, the same identity `jwks_uri` and
 * `JWKS_PATH` hold.
 *
 * CCP's first, so anything treating the head as canonical picks the current spelling. Both are one
 * handler: two entries in `lib/ssoDispatch.js`'s table, because that dispatch exact-matches and
 * normalizes nothing.
 */
const VERIFY_PATHS = Object.freeze([
  DISCOVERY_ENDPOINT_PATHS.userinfo,
  "/oauth/verify",
]);

/**
 * Revoke's one path. Referenced, not retyped, for `VERIFY_PATHS`'s reason.
 *
 * No legacy alias is recorded for this one and none is invented.
 */
const REVOKE_PATH = DISCOVERY_ENDPOINT_PATHS.revocation;

/**
 * Verify's seven members, in the recorded order, and they are **PascalCase**, which nothing else
 * on either origin is.
 *
 * `CharacterID`, not `character_id`. ESI proper is snake_case everywhere (`lib/serialize.js` keeps
 * it that way) and this endpoint predates that convention; every existing tool indexes the parsed
 * object by these exact strings. Note `CharacterID` is `ID` and not `Id`.
 *
 * The order has the standing of `JWKS_KEY_MEMBER_ORDER` and `ACCESS_TOKEN_CLAIM_ORDER`: it is the
 * order the names were written down in, matching it costs one array, and nothing surveyed depends
 * on it.
 */
const VERIFY_MEMBER_ORDER = Object.freeze([
  "CharacterID",
  "CharacterName",
  "ExpiresOn",
  "Scopes",
  "TokenType",
  "CharacterOwnerHash",
  "IntellectualProperty",
]);

/**
 * Where each member's value comes from, as data so the mapping is asserted.
 *
 * A claim name from `ACCESS_TOKEN_CLAIM_ORDER`, or `"constant"` for the two members that are the
 * same on every response.
 *
 * `CharacterOwnerHash` **is** the `owner` claim
 *
 * If the two ever diverged, a client that stored `CharacterOwnerHash` from verify and later compared
 * it against a JWT's `owner` would throw away a working refresh token and demand a fresh
 * authorisation for a character whose ownership never changed.
 *
 * They have the same *job*: `lib/accessToken.js` on `owner` says to remember the `owner` seen at
 * authorisation, and if a later token for the same `sub` carries a different one, discard the stored
 * refresh token and re-authorise. Every consumer implemented that against `CharacterOwnerHash` before
 * CCP issued JWTs; this member is the older name. They have the same *shape*: `ACCESS_TOKEN_OWNER`
 * records 28 characters of padded **standard** base64 with a `/` in the sample, the shape third-party
 * tools store for `CharacterOwnerHash`.
 *
 * So `routes/oauthVerify.js` emits the `owner` claim verbatim under this name and derives nothing. A
 * second derivation would have to stay in step with `ownerHashFor`.
 */
const VERIFY_MEMBER_SOURCES = Object.freeze({
  CharacterID: "sub",
  CharacterName: "name",
  ExpiresOn: "exp",
  Scopes: "scp",
  TokenType: "constant",
  CharacterOwnerHash: "owner",
  IntellectualProperty: "constant",
});

/** The three labels `VERIFY_MEMBER_PROVENANCE` may carry, and nothing else. */
const VERIFY_PROVENANCE_LEVELS = Object.freeze(["observed", "inferred", "ours"]);

/**
 * How well-sourced each member's **value** is. Every *name* is recorded; this table is about what goes
 * in it.
 *
 *   `observed`  transcribed from a recorded capture.
 *   `inferred`  derived from something else recorded in this file, with the derivation written down at
 *               the constant that carries it.
 *   `ours`      a choice this replica made with nothing to reproduce.
 *
 * There is not one `observed` in the table: the record gives seven names and no values. Everything is
 * either read off a token this replica minted (inferred, since the claim-to-member mapping is ours) or
 * chosen outright.
 *
 * `ExpiresOn`, `Scopes` and `IntellectualProperty` would change on the wire the day somebody captures
 * CCP's answer, so `UNOBSERVED` names the request that would settle those three.
 */
const VERIFY_MEMBER_PROVENANCE = Object.freeze({
  /** An integer, from `sub`'s digits: `ACCESS_TOKEN_SUBJECT_PATTERN` captures `(\d+)`. */
  CharacterID: "inferred",
  /** The `name` claim, a string, per `ACCESS_TOKEN_CLAIM_TYPES`. */
  CharacterName: "inferred",
  /** The format is a choice; `exp` is a number and this is a string. See `VERIFY_EXPIRES_ON`. */
  ExpiresOn: "ours",
  /** String or array is a choice, and the opposite of `scp`'s. See `VERIFY_SCOPES`. */
  Scopes: "ours",
  /** `"Character"`, from `ACCESS_TOKEN_SUBJECT_PREFIX`'s namespace. */
  TokenType: "inferred",
  /** The `owner` claim verbatim; see `VERIFY_MEMBER_SOURCES`. */
  CharacterOwnerHash: "inferred",
  /** `"EVE"`, and nothing in this repository sources it. */
  IntellectualProperty: "ours",
});

/**
 * The two flat members, reasoned separately because they are not equally well founded.
 *
 * `TokenType: "Character"`: inferred, from something real
 *
 * `ACCESS_TOKEN_SUBJECT_PREFIX` is `CHARACTER:EVE:`, and its comment states the reason: "CCP issues
 * tokens for subjects that are not characters". A member called `TokenType` on an endpoint returning the
 * subject's identity names that namespace, and the only one this replica issues into is `CHARACTER` (D3
 * makes the in-game session the only source of identity).
 *
 * The spelling `Character` (initial capital, singular, matching the member names around it rather than
 * the subject prefix) is the guess in the derivation, which is why this is `inferred`.
 *
 * It is **not** `Bearer`. `token_type` in a token response is the HTTP authentication scheme
 * (`routes/oauthToken.js` `TOKEN_TYPE`, which clients are recorded string-comparing); `TokenType` here
 * describes the subject. The spellings are close and the meanings unrelated, so a route using the wrong
 * constant would produce a body that parses perfectly and is wrong.
 *
 * `IntellectualProperty: "EVE"`: ours
 *
 * Nothing in this repository sources this value. The member says which of CCP's properties the identity
 * belongs to, this replica serves one game, and `EVE` is that game's string elsewhere on this surface:
 * `ACCESS_TOKEN_AUDIENCE_LITERAL` is `EVE Online` and `ACCESS_TOKEN_SUBJECT_PREFIX` is `CHARACTER:EVE:`.
 * That is consistency, not evidence, so the label is `ours`.
 *
 * Nothing in the ecosystem survey branches on it. If a capture shows something else, changing it costs one
 * string.
 */
const VERIFY_CONSTANT_MEMBERS = Object.freeze({
  TokenType: "Character",
  IntellectualProperty: "EVE",
});

/**
 * `Scopes`: a **space-delimited string**, the opposite of the decision `scp` made.
 *
 * `ACCESS_TOKEN_SCP.oursAlwaysArray` is `true`: the JWT carries an array at every scope count, for the
 * reason `lib/accessToken.js` gives (the string branch is the one that produces
 * `scopes.map is not a function`).
 *
 * That argument does not transfer. Every consumer of a JWT claim set was written after CCP published the
 * claim shape. This body is the *old* surface, whose consumers were written against RFC 6749's `scope`, a
 * space-delimited string by definition (§3.3). It is what the client sent to `routes/oauthAuthorize.js`,
 * what that route stores (its `parseScope` keeps "a space-delimited string, which is what the `scope`
 * parameter *is* in RFC 6749"), and what `routes/oauthToken.js` splits apart to build `scp`. A tool handing
 * `Scopes` straight to its next authorization request is the ordinary case, and an array would break it.
 *
 * `emptyIsEmptyString`: a token with no scopes emits `""`, not `null` and not an absent member. The
 * acceptance is that every member is present, so the body's shape must not depend on its content.
 */
const VERIFY_SCOPES = Object.freeze({
  /** Ours: one string, scopes joined by a single space, at every count. */
  oursIsSpaceDelimitedString: true,
  /** The delimiter, and the only one: a tab is not an RFC 6749 §3.3 separator. */
  delimiter: " ",
  /** Zero scopes is the empty string, never `null` and never an absent member. */
  emptyIsEmptyString: true,
});

/**
 * `ExpiresOn`: seconds-precision ISO 8601 in UTC, with **no zone designator** and no fractional part.
 * `2026-08-24T14:34:16`.
 *
 * Ours. Three candidate spellings of one instant:
 *
 *   `2026-08-24T14:34:16`        what this replica emits
 *   `2026-08-24T14:34:16Z`       the same instant, RFC 3339-complete
 *   `2026-08-24T14:34:16.000Z`   what `Date.prototype.toISOString` returns
 *
 * Full ISO-8601 parsers read all three. A tool doing `strptime(s, "%Y-%m-%dT%H:%M:%S")`, the idiom of the
 * era this endpoint comes from, raises on the trailing `Z` and on the `.000`. The shortest form is
 * accepted by the most real parsers, whichever one CCP sends.
 *
 * The cost: with no `Z`, a parser defaulting a naive timestamp to *local* time reads an instant offset by
 * the reader's timezone. A client hits that identically against CCP if CCP sends the bare form, and adding
 * a `Z` CCP does not send would make this replica the only server giving that client a different answer
 * (design constraint 3, applied to a value we must guess).
 *
 * Fractional seconds cannot arise: the value is derived from `exp`, which `ACCESS_TOKEN_CLAIM_TYPES`
 * records as a number of whole seconds.
 *
 * `pattern` is the shape, recorded as a regex so a test can hold the route to it. Anchored, because unlike
 * `ACCESS_TOKEN_SUBJECT_PATTERN` this is *our* reader and not a consumer's.
 */
const VERIFY_EXPIRES_ON = Object.freeze({
  oursHasZoneDesignator: false,
  oursHasFractionalSeconds: false,
  oursIsUtc: true,
  pattern: Object.freeze(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/),
});

/**
 * The content type a refusal on this pair carries: **`text/html`**, on a surface where every other refusal
 * is a redirect or JSON.
 *
 * The one wire fact recorded about either endpoint: "Without a bearer token, real CCP returns 401 with
 * `Content-Type: text/html`, not JSON. Only the token endpoint returns JSON errors." `routes/oauthToken.js`
 * agrees from the other side, as "the only SSO endpoint that answers in JSON errors", from different
 * evidence.
 *
 * Recorded as the **bare media type**. Whether CCP appends a `charset` parameter is not established
 * (`UNOBSERVED.verifyRefusalBody`). No *body* is recorded either: `routes/oauthVerify.js` chooses one and
 * marks it ours.
 */
const REFUSAL_CONTENT_TYPE = "text/html";

/**
 * RFC 7009 §2.1's two `token_type_hint` values, and what this replica can do about each.
 *
 * §2.1 says a server that cannot find the token under the hinted type "MUST extend its search across all of
 * its supported token types", so a wrong, absent or unknown hint must behave identically. Refusing on one
 * would break clients sending the hint CCP's own documentation shows.
 *
 * `REVOKE_TOKEN_TYPES`: this replica has one revocable token type. A refresh token is a record in
 * `lib/refreshTokens.js` and can be marked dead; an access token is a signed JWT this server does not store
 * and cannot recall, so `token_type_hint=access_token` names something no endpoint here can act on. It is
 * still a 200: answering differently would tell a caller which of their two guesses this server keeps state
 * for.
 */
const REVOKE_TOKEN_TYPE_HINTS = Object.freeze(["access_token", "refresh_token"]);

const REVOKE_TOKEN_TYPES = Object.freeze({
  /** Stateful here, so revocable: `lib/refreshTokens.js` marks the record dead. */
  refresh_token: true,
  /** Stateless (a signed JWT this server never stores), so not revocable. */
  access_token: false,
});

// Serving these two documents

/**
 * How the two documents are served, as **requirements**, not observed bytes.
 *
 * The same distinction `wire.js` draws around `INFRASTRUCTURE`: *that* something is so can be an observation,
 * *what exactly* it is can be a claim.
 *
 * The JWKS observation states the serving requirements in words: unauthenticated, CORS-open, cacheable, with
 * clients caching by `kid`. No response header is recorded: not the `content-type` spelling, `Cache-Control`,
 * a `max-age`, an `Etag` or a `Vary`. Those are in `UNOBSERVED`.
 *
 * Do not fill them in from `wire.js`. Its content-type and newline tables are facts about ESI's two producers,
 * established by curling `esi.evetech.net`. `login.eveonline.com` is different software on a different
 * hostname, and nobody has checked whether the correlation holds.
 *
 * `authenticated: false` has a security consequence if inverted: both documents are public by definition (a
 * JWKS publishes public keys and a discovery document advertises endpoints), and putting either behind a token
 * makes the surface undiscoverable in a way a client cannot report.
 */
const SERVING = Object.freeze({
  [JWKS_PATH]: Object.freeze({
    authenticated: false,
    cors: true,
    cacheable: true,
    /** Stated in the JWKS observation: clients key their cache on `kid`, not on the URL. */
    clientsCacheByKid: true,
  }),
  discovery: Object.freeze({
    authenticated: false,
    cors: true,
    cacheable: true,
  }),
});

/**
 * The questions the recorded observations do not answer, named so the gap is data.
 *
 * `wire.js`'s rule is that a value nobody has observed does not belong in the file. This object holds no values:
 * only their *names*, and a sentence each on how to establish them.
 *
 * The absence gets an export because a table row nothing asserts can be contradicted in a comment with nothing
 * failing. A gap recorded only in a paragraph is not found by someone grepping the exports. `NOT_SENT_BY_CHOICE` in `wire.js` has the same shape.
 *
 * A route may not read a default out of this object, because there is none to read. It must choose deliberately and
 * record the choice where it makes it, marked as a choice, the way `META.ours` records that a one-surface replica
 * publishes one date. When somebody captures these off `login.eveonline.com` with `curl -D -`, the entry moves out
 * of here and becomes a constant with a date.
 */
const UNOBSERVED = Object.freeze({
  trailingNewline:
    "Whether either document's body ends with `\\n`. The references for the two documents reproduce "
    + "pretty-printed JSON, which is a parse rather than a capture and says nothing about "
    + "the last byte, nor about separator spacing or indentation. `wire.js`'s "
    + "newline-follows-content-type correlation is a fact about esi.evetech.net's two "
    + "producers and does not transfer to a different origin. Establish with "
    + "`curl -sD - https://login.eveonline.com/oauth/jwks` and read `content-length` "
    + "against the JSON text's length.",
  contentType:
    "The exact `content-type` spelling on either document. ESI sends three different ones "
    + "and a replica that guesses `application/json; charset=utf-8` matches none of them; "
    + "there is no reason to think SSO is tidier. `application/jwk-set+json` is also live "
    + "for the JWKS, which is what RFC 7517 registers and what a correct server would send.",
  cacheHeaders:
    "`Cache-Control`, `Expires`, `Etag` and `Last-Modified` on either document. The JWKS reference says "
    + "it is cacheable and the discovery reference says nothing at all; neither states a directive or a "
    + "max-age. What a cacheable document's headers actually are decides how long a client "
    + "holds a stale key, which is the rollover window D8 discusses.",
  vary: "Whether either document sends `Vary`, and on what.",
  accessTokenOwnerHashInput:
    "What CCP hashes to produce the `owner` claim. The recorded value is 28 base64 characters, "
    + "so the digest is 20 bytes, and 20 bytes is SHA-1, which is an inference from a length "
    + "and not an observation, and it says nothing about the *input*, which is the half an "
    + "implementation actually needs. Nothing short of CCP's source or a character transfer "
    + "observed across two tokens would establish it, and neither is available here. "
    + "`lib/accessToken.js` therefore designs its own derivation and documents what it does and "
    + "does not detect, rather than claiming to reproduce one.",
  accessTokenScpSingleScope:
    "Whether a CCP token with exactly one scope really carries `scp` as a bare string. The token reference says "
    + "so in prose and reproduces a one-scope token with an array; see `ACCESS_TOKEN_SCP`. A "
    + "single authorization against CCP with one scope, decoded without a normalising library, "
    + "settles it. It does not change what this replica emits either way.",
  openidConfigurationStatus:
    "What CCP answers at `/.well-known/openid-configuration`. The discovery reference says CCP does not serve "
    + "it; whether that is a 404, a 301 to the OAuth path, or something else is unrecorded, "
    + "and it is the fact a fidelity argument about serving it would have to stand on.",
  verifyMemberValues:
    "What CCP actually puts in `TokenType`, `IntellectualProperty`, `Scopes` and `ExpiresOn` at "
    + "`GET /v2/oauth/verify`. The endpoint's reference names all seven members and gives no value and no type for "
    + "any of them, so `VERIFY_MEMBER_PROVENANCE` carries `inferred` or `ours` for every row "
    + "and not one `observed`. One authenticated request settles all four at once: "
    + "`curl -sD - -H 'Authorization: Bearer <token>' https://login.eveonline.com/v2/oauth/verify` "
    + "against a token with **two or more** scopes, because a single-scope token cannot "
    + "distinguish a space-delimited string from an array with one entry, which is the same "
    + "ambiguity `accessTokenScpSingleScope` records one surface over.",
  verifyRefusalBody:
    "The bytes of the 401 recorded as `text/html`, and whether that content type carries a "
    + "`charset` parameter. That record establishes the media type and stops there, which leaves the "
    + "body itself (a whole HTML document, an error page from a reverse proxy, or nothing at "
    + "all) entirely unrecorded. `routes/oauthVerify.js` serves a minimal document of its own "
    + "and marks it ours; a content type reproduced without the bytes it describes is half a "
    + "reproduction. `curl -sD - https://login.eveonline.com/v2/oauth/verify` with no "
    + "Authorization header settles both, and needs no credentials to run.",
  revokeResponseShape:
    "What CCP's revocation endpoint sends with its 200: whether the body is empty, whether it "
    + "carries a content type at all, and what it answers when its own store cannot record the "
    + "revocation. RFC 7009 §2.2 says the body is ignored by the client and §2.2.1 offers 503 "
    + "for `the token may still exist`, which is what `routes/oauthRevoke.js` reaches for on "
    + "`persist_failed`, but that is the RFC's shape, not a capture of CCP's. Settling it needs "
    + "a real client credential and a token to throw away.",
});

module.exports = Object.freeze({
  ESTABLISHED,
  SSO_ORIGIN,

  JWKS_PATH,
  JWKS_KID,
  JWKS_ALG,
  JWKS_KEY_MEMBER_ORDER,
  JWKS_KEY_CONSTANTS,
  JWKS_KEY_MATERIAL_MEMBERS,
  JWKS_MEMBER_ORDER,
  JWKS_SKIP_UNRESOLVED_MEMBER,
  JWKS_SKIP_UNRESOLVED_VALUE,
  JWKS_CCP_EXTRA_ALGS,

  DISCOVERY_PATHS,
  OPENID_DISCOVERY_PATH,
  DISCOVERY_ENDPOINT_PATHS,
  DISCOVERY_ENDPOINT_MEMBERS,
  DISCOVERY_ISSUER_DERIVED_MEMBERS,
  DISCOVERY_CONSTANTS,
  DISCOVERY_MEMBER_ORDER,
  CCP_DISCOVERY_DOCUMENT,

  VERIFY_PATHS,
  REVOKE_PATH,
  VERIFY_MEMBER_ORDER,
  VERIFY_MEMBER_SOURCES,
  VERIFY_PROVENANCE_LEVELS,
  VERIFY_MEMBER_PROVENANCE,
  VERIFY_CONSTANT_MEMBERS,
  VERIFY_SCOPES,
  VERIFY_EXPIRES_ON,
  REFUSAL_CONTENT_TYPE,
  REVOKE_TOKEN_TYPE_HINTS,
  REVOKE_TOKEN_TYPES,

  ACCESS_TOKEN_JOSE_HEADER,
  ACCESS_TOKEN_JOSE_HEADER_MEMBER_ORDER,
  ACCESS_TOKEN_SUBJECT_PREFIX,
  ACCESS_TOKEN_SUBJECT_PATTERN,
  ACCESS_TOKEN_AUDIENCE_LITERAL,
  ACCESS_TOKEN_LIFETIME_SECONDS,
  ACCESS_TOKEN_SCP,
  ACCESS_TOKEN_ISS,
  ACCESS_TOKEN_OWNER,
  ACCESS_TOKEN_CLAIM_ORDER,
  ACCESS_TOKEN_CLAIM_TYPES,
  ACCESS_TOKEN_CONSTANT_CLAIMS,
  ACCESS_TOKEN_VARIABLE_CLAIMS,
  CCP_ACCESS_TOKEN_CLAIMS,
  CCP_ACCESS_TOKEN_PLACEHOLDERS,

  SERVING,
  UNOBSERVED,
});
