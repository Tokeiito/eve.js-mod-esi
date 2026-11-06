/**
 * eve.js-mod-esi: the client registry.
 *
 * Who is allowed to be redirected where. `GET /v2/oauth/authorize` asks this
 * before anything else, and the answer decides whether the request becomes a
 * redirect at all.
 *
 * The rule: any `client_id` is accepted. The `redirect_uri` must be either an
 * exact match against a configured allowlist or a loopback address.
 *
 * A private server has no developer portal, so there is no registration step in
 * which a tool could tell us its `redirect_uri` in advance. A tool's `client_id`
 * was issued by CCP (eve-nexum, EVEMon, pyfa and the rest registered on CCP's
 * portal), so refusing an unknown `client_id` would refuse the whole ecosystem.
 * A native tool's `redirect_uri` names a port it picked at runtime (RFC 8252
 * section 7.3 tells native apps to bind an ephemeral loopback port), so no
 * string could be written down for it either.
 *
 * A wide-open "accept any client_id and redirect_uri" would be an open
 * redirector, and the loopback rule bounds it. An attacker who gets this
 * endpoint to redirect can only aim it at `127.0.0.0/8` or `[::1]`, the victim's
 * own machine, and PKCE (S256; `contract/sso.js` publishes no `plain`) means the
 * code arriving there cannot be exchanged without the verifier that never left
 * the real client. Everything off the local machine must be a string the
 * operator wrote down.
 *
 * Exact means exact: an allowlist comparison is byte-for-byte against the raw
 * string the client sent, over the whole URI. No trailing-slash forgiveness, no
 * case folding of the path, no dropping the query, no reserialising through a
 * URL parser. A bad `redirect_uri` is the one error class that must never be
 * reported via a redirect (that is the open redirect), so the only way an
 * attacker gets a redirect is by getting `check` to say yes. Every normalisation
 * is a second string that also says yes, and a place where our idea of "the same
 * URI" and the operator's differ (a parser that folds `%2e%2e`, one that
 * lowercases a case-sensitive path, one that treats `?a=1&b=2` and `?b=2&a=1` as
 * equal). A near-miss fails and the operator fixes the one character.
 *
 * Configured entries are validated at construction, so an operator's typo is a
 * boot-time refusal rather than a URI that silently never matches.
 *
 * Loopback means the address, not the name: `127.0.0.0/8` and `[::1]` as
 * literals, any port, `http` or `https`.
 *
 * `localhost` does not count. What a name resolves to is not ours to assume (an
 * `/etc/hosts` line, a DNS search domain, a corporate resolver or an IPv6-first
 * stack can each make it something other than loopback), and RFC 8252 section
 * 8.3 recommends literal addresses for that reason. A native app builds its
 * redirect URI from the address it bound, and a tool that insists on the name
 * can be allowlisted verbatim in one line.
 *
 * `config.js`'s `isLoopbackHost` is deliberately not reused. It answers "will
 * this bind put a listener on the network?" about a string the operator typed,
 * accepts `localhost`, and tests IPv4 with `startsWith("127.")`. Here the string
 * comes from an unauthenticated caller, and `127.evil.com` starts with `127.`
 * while resolving anywhere its owner likes.
 *
 * Any port, because picking one at runtime is the point. `http` because a
 * loopback callback has no certificate; `https` as well because the rule is
 * about where the browser is sent.
 *
 * Not accepted, as a deliberate narrowing of RFC 8252: a private-use URI scheme
 * (`com.example.app:/oauth`). It has no equivalent of the loopback bound: the
 * scheme is claimed by whichever application registered it with the operating
 * system, which we cannot see or verify. It can still be allowlisted exactly.
 *
 * A `client_id` is accepted but still validated: it becomes the `azp` claim of
 * the access token this replica signs, and the EVE client reads it back to use
 * as its own `client_id` on refresh. An unbounded or control-character-bearing
 * value would be an unbounded claim in a signed token, an unbounded key in the
 * refresh store, and a newline in a log line written from an unauthenticated
 * endpoint. Non-empty, bounded, printable; beyond that CCP issued it and its
 * shape is not ours to legislate.
 *
 * Secrets: an entry may carry a `clientSecret`; an entry without one describes a
 * public client, the normal case since a native tool on a loopback redirect has
 * nowhere to keep a secret (RFC 8252 section 8.5). CCP's real secrets are
 * unknowable to us, so the operator invents one and configures both this file
 * and the tool. That manual step is why it is optional.
 *
 * What it buys: `routes/oauthAuthorize.js` accepts an authorize request with no
 * `code_challenge`, on RFC 8414 section 2's reading that
 * `code_challenge_methods_supported` says which methods exist rather than that
 * PKCE is mandatory. That is safe only if a code minted with a challenge is
 * redeemable only with a matching verifier, and one minted without only by a
 * client that authenticated. Without a secret no client could authenticate, so
 * a no-challenge code was redeemable by anybody holding it, and a network
 * attacker on D1's plain HTTP got PKCE removal by deleting two query
 * parameters. The check and the invariant live in `lib/clientAuth.js`; this
 * module owns only "is this the secret registered for this client_id?".
 *
 * Three properties of that check:
 *
 *   Both sides are hashed before comparison, with `crypto.timingSafeEqual` over
 *   two 32-byte digests. This removes the length test: a length comparison is an
 *   early return on the branch an attacker times, and `timingSafeEqual` throws
 *   on unequal lengths, so raw secrets would turn a length mismatch into a
 *   thrown exception on the request path.
 *
 *   A client registered without a secret is compared against a decoy (32 random
 *   bytes minted at construction) rather than short-circuited to `false`, so
 *   presenting a secret to a public client costs the same work as presenting a
 *   wrong one to a confidential client. `lib/clientAuth.js` reports both with the
 *   same bytes, so the token endpoint is not an oracle for which clients are
 *   confidential.
 *
 *   The digest is keyed (HMAC-SHA-256 under a per-process random key). It never
 *   leaves the process, so this is cheap insurance against a memorable-phrase
 *   secret being a dictionary attack away from an unkeyed digest in a heap dump
 *   or `util.inspect`. The configured plaintext is digested at construction and
 *   dropped here, though `config.js` still holds the string it parsed, so this
 *   bounds the blast radius rather than eliminating it.
 *
 * What remains observable to a timing attacker is stated on `verifySecret`.
 *
 * A registered secret that is empty or too short is a configuration error at
 * construction, like a mistyped redirect URI: `client_secret: ""` meant to
 * configure a confidential client and instead configured one that no presented
 * secret can authenticate. This is not a check for easily guessed secrets.
 *
 * The `"*"` entry may not carry a secret. A secret shared by every `client_id`
 * authenticates its holder as anybody, which negates client authentication: the
 * invariant needs the identity on the code and the identity that proved itself
 * to be the same.
 *
 * Failure strings: `reason` is a short stable token for a log line and a test.
 * `detail` is one sentence of prose for the operator. Neither is for the client:
 * a bad redirect URI is never reported by redirecting, so whatever the route
 * renders is a page a human reads, and `detail` may therefore name the
 * configured allowlist.
 *
 * Shape:
 *
 *     createClientRegistry({ clients, allowLoopback }) -> frozen {
 *       check({ clientId, redirectUri })
 *         -> { ok: true,  via: "allowlist" | "loopback" }
 *         |  { ok: false, reason, detail }
 *
 *       verifySecret({ clientId, clientSecret }) -> boolean
 *     }
 *
 * `check` is unaffected by secrets: it is the authorize endpoint's question, that
 * endpoint has no credentials, and a redirect target is registered or not
 * regardless of who can prove what.
 *
 * `verifySecret` returns a bare boolean: no reason, no detail, no "this client
 * has no secret". The token endpoint may act on exactly one bit, and a second
 * field would be a difference for somebody downstream to report.
 *
 * Configuration errors throw at construction (`ClientRegistryError`), where a
 * startup can refuse. Nothing throws at check time: this runs inside the game
 * server's process and eve.js treats an unhandled rejection as fatal (see
 * `server.js`'s header).
 */

"use strict";

const crypto = require("node:crypto");

// Constants

/**
 * How long a `client_id` may be.
 *
 * CCP issues 32-character hex strings, so this is an order of magnitude of
 * headroom. The value is attacker-supplied on an unauthenticated endpoint and
 * ends up inside a signed token: a megabyte of `client_id` would be a megabyte
 * of `azp` handed to every consumer that reads the token.
 */
const MAX_CLIENT_ID_LENGTH = 255;

/**
 * The shortest secret an operator may configure.
 *
 * Sixteen characters out of the roughly 64-character set below is about 96 bits,
 * which nobody guesses over a network against a server fronted by
 * `lib/errorLimiter.js`. A floor is needed because this secret is invented by a
 * human, unlike every other credential here (authorization codes, refresh
 * tokens and the owner salt are all `crypto.randomBytes`), and "hunter2" would
 * make the header's invariant say something it does not mean.
 *
 * It is a floor, not a policy: an operator may paste 64 hex characters, and the
 * error message asks them to.
 */
const MIN_CLIENT_SECRET_LENGTH = 16;

/**
 * The longest, mirroring `MAX_CLIENT_ID_LENGTH` for a weaker reason: the value
 * is digested rather than stored or signed. A bound keeps a file with a stray
 * megabyte in it a refusal a human reads rather than a megabyte this process
 * keeps.
 */
const MAX_CLIENT_SECRET_LENGTH = 255;

/**
 * The characters a configured secret may be made of. This is a security rule
 * disguised as a syntax rule.
 *
 * RFC 6749 section 2.3.1 says the two halves of an HTTP Basic credential are
 * form-urlencoded before they are base64'd, and many clients send raw bytes. A
 * server that guesses which a header meant has two strings that authenticate one
 * client, the same class of mistake as normalising redirect URIs.
 *
 * `lib/clientAuth.js` decodes strictly, once, per the RFC, and this charset
 * makes that free. Every character here is a fixed point of
 * `application/x-www-form-urlencoded`: no serialiser percent-encodes
 * `A-Z a-z 0-9 . _ -`, and none is the `+` that decodes to a space. For a secret
 * from this set the encoded and raw forms are the same bytes, so a client that
 * forgot to encode still authenticates. The strictness costs real clients
 * nothing and costs an attacker the second spelling.
 *
 * Excluded on purpose: `~` (the WHATWG form serialiser encodes it as `%7E` but
 * `encodeURIComponent` does not; two encoders disagreeing about one character is
 * the ambiguity this set removes), `+`, `%`, `:` (RFC 7617 splits the credential
 * on the first one), space, and everything non-ASCII.
 */
const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * The one wildcard, on the `client_id` only.
 *
 * An allowlist entry written for `"*"` contributes its redirect URIs to every
 * caller regardless of `client_id`. This is not a hole, because the URIs are
 * still exact matches: the operator is saying "this address is a legitimate
 * callback on this deployment, whoever asks", the honest description of a
 * browser tool served from a known origin.
 *
 * It exists because pairing a URI to a `client_id` would require the operator to
 * know a string CCP issued to somebody else; an operator who can see the tool's
 * callback URL but not its `client_id` could allowlist nothing.
 *
 * There is no wildcard on the redirect URI side, in any form (no `*`, no prefix
 * match, no subdomain match). That would be the open redirector, and a prefix
 * match is the same thing (`http://good.example/` also prefixes
 * `http://good.example.evil.test/`).
 */
const ANY_CLIENT_ID = "*";

/**
 * The schemes a loopback redirect may use. See the file header: `http` because a
 * loopback listener has no certificate, `https` because the rule is about the
 * destination rather than the transport. An allowlisted URI is not limited to
 * these.
 */
const LOOPBACK_SCHEMES = Object.freeze(["http:", "https:"]);

/**
 * The IPv6 loopback, spelled the way `new URL` reports a hostname: in brackets.
 *
 * WHATWG parsing normalises IPv6 literals, so `[0:0:0:0:0:0:0:1]` arrives as
 * `[::1]` and is accepted without a second spelling. The IPv4-mapped form
 * (`[::ffff:127.0.0.1]`, normalised to `[::ffff:7f00:1]`) is not accepted: no
 * native tool's loopback listener produces it, and every extra accepted spelling
 * is one more string to probe with.
 */
const IPV6_LOOPBACK_HOST = "[::1]";

/**
 * `127.0.0.0/8`, as a literal dotted quad and nothing else.
 *
 * Four octets, each 0 to 255, first octet exactly 127. A hostname is not an
 * address: `127.evil.com` matches a `startsWith("127.")` test and resolves
 * wherever its owner points it, which is why this parses rather than prefixes.
 */
const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * The machine-readable half of a refusal. Short, stable, lowercase: a log line
 * groups by these, and a test asserts on them.
 *
 * There is no separate reason for "the scheme is not one we auto-accept" or
 * "loopback is switched off". Those are the same outcome (the URI is not one
 * this deployment permits) and the difference belongs in `detail`.
 */
const REASON = Object.freeze({
  CLIENT_ID_MISSING: "client_id_missing",
  CLIENT_ID_INVALID: "client_id_invalid",
  REDIRECT_URI_MISSING: "redirect_uri_missing",
  REDIRECT_URI_RELATIVE: "redirect_uri_relative",
  REDIRECT_URI_CREDENTIALS: "redirect_uri_credentials",
  REDIRECT_URI_FRAGMENT: "redirect_uri_fragment",
  REDIRECT_URI_UNREGISTERED: "redirect_uri_unregistered",
});

/** How a URI was permitted, on the success side. */
const VIA = Object.freeze({
  ALLOWLIST: "allowlist",
  LOOPBACK: "loopback",
});

/** A registry that was configured wrong. Thrown at construction, never at check time. */
class ClientRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClientRegistryError";
  }
}

// Small shared shapes

function ok(via) {
  return Object.freeze({ ok: true, via });
}

function fail(reason, detail) {
  return Object.freeze({ ok: false, reason, detail });
}

/**
 * Control characters, refused wherever they appear in a value that will be
 * logged or signed.
 *
 * A `client_id` carrying a `\n` writes a second line into the game server's
 * console that looks like something the server said, from an endpoint anybody
 * can reach without authenticating.
 */
function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // C0 and DEL. A scan rather than a character class, because a regular expression
    // made of control characters is unreadable and editors may mangle it.
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// The redirect URI, examined once

/**
 * Parse a redirect URI, or say which way it was malformed.
 *
 * Returns `{ url }` or `{ failure }`. Three refusals happen here, before either
 * gate, because they are true of a redirect URI whatever list it is on:
 *
 *   Not absolute. RFC 6749 section 3.1.2 requires an absolute URI, and a
 *   relative one has no origin to bound anything with. `new URL(raw)` with no
 *   base is the whole test.
 *
 *   Credentials. `http://user:pass@127.0.0.1:8080/cb` is a loopback address by
 *   every test here and also a userinfo component a browser will send onward; it
 *   has no business in a callback and would be written into logs.
 *
 *   A fragment. RFC 6749 section 3.1.2 says the redirection endpoint URI MUST
 *   NOT include one: the authorization response appends its own parameters, and
 *   a URI that already has a fragment loses or corrupts them.
 *
 * The relative-URI message names the mistake `config.js` documents for the issuer:
 * `new URL("host.local:8080/cb")` does not throw. It parses with `host.local` as
 * the scheme, so it arrives looking absolute and then fails the loopback gate
 * for a reason that sends somebody looking in the wrong place.
 */
function examineRedirectUri(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      failure: fail(
        REASON.REDIRECT_URI_MISSING,
        "The authorize request carried no redirect_uri. It is required, and it is never "
          + "defaulted: a replica that guessed one would be choosing where to send a code.",
      ),
    };
  }

  if (hasControlCharacter(raw)) {
    // Before parsing, because a URL parser silently percent-encodes some of these
    // and strips others (a tab inside a URL is dropped), which would let two
    // different strings become one.
    return {
      failure: fail(
        REASON.REDIRECT_URI_RELATIVE,
        "The redirect_uri contains a control character. A URL parser rewrites or drops those, "
          + "so it can never be compared byte-for-byte against a configured entry.",
      ),
    };
  }

  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return {
      failure: fail(
        REASON.REDIRECT_URI_RELATIVE,
        `The redirect_uri "${raw}" is not an absolute URI. It needs an explicit scheme: `
          + `"http://127.0.0.1:8080/callback", not "/callback" or "127.0.0.1:8080/callback".`,
      ),
    };
  }

  if (url.username !== "" || url.password !== "") {
    return {
      failure: fail(
        REASON.REDIRECT_URI_CREDENTIALS,
        "The redirect_uri carries credentials in its userinfo component. A callback address "
          + "does not need them, a browser would send them onward, and they would be written "
          + "into this server's log.",
      ),
    };
  }

  // `url.hash` is empty for a bare trailing `#`, so the raw string is asked as
  // well: `http://127.0.0.1:8080/cb#` has a fragment component, and appending a
  // query to it produces something no client will parse back.
  if (url.hash !== "" || raw.includes("#")) {
    return {
      failure: fail(
        REASON.REDIRECT_URI_FRAGMENT,
        "The redirect_uri carries a fragment. RFC 6749 forbids one on a redirection endpoint, "
          + "because the authorization response appends its own parameters and a fragment "
          + "already there would swallow them.",
      ),
    };
  }

  return { url };
}

/**
 * Is this parsed URI a loopback callback?
 *
 * Address and scheme, nothing about port or path. See the file header.
 */
function isLoopbackRedirect(url) {
  if (!LOOPBACK_SCHEMES.includes(url.protocol)) return false;
  return isLoopbackHostname(url.hostname);
}

/** `127.0.0.0/8` or `[::1]`, as literal addresses. Never a name. */
function isLoopbackHostname(hostname) {
  if (hostname === IPV6_LOOPBACK_HOST) return true;

  const match = IPV4_LOOPBACK.exec(hostname);
  if (match === null) return false;

  // Each octet is parsed and range-checked rather than pattern-matched loosely:
  // `127.0.0.999` matches three digits per group and is not an address. `new URL`
  // would refuse it anyway, but this predicate makes the safety claim, so it makes
  // it on its own.
  return match.slice(1).every((octet) => Number(octet) <= 255);
}

// The configured allowlist

/**
 * Turn the configured clients into `{ allowlist, secrets }`, or throw.
 *
 * `allowlist` is `Map<clientId, Set<redirectUri>>`; `secrets` is
 * `Map<clientId, string>` holding only the entries that configured one.
 *
 * A `Map` and a `Set` rather than an object, because the key is a `client_id`
 * from an unauthenticated request: on a plain object `allowlist["constructor"]`
 * is a function rather than `undefined`, and a caller identifying itself as
 * `toString` should find an empty allowlist, not an inherited one.
 *
 * Every configured URI is validated with the same `examineRedirectUri` a request
 * goes through: a mistyped URI can never match anything, and "your allowlist has
 * a typo" at boot beats "the tool gets a refusal page" three weeks later.
 * Repeating a `client_id` merges its URIs rather than failing, as a way of
 * organising a file.
 */
function buildAllowlist(clients) {
  if (!Array.isArray(clients)) {
    throw new ClientRegistryError(
      "ESI mod: the client registry needs an array of { clientId, redirectUris } entries. "
        + "config.js parses one out of ESI_MOD_SSO_CLIENTS_PATH; an absent allowlist is an "
        + "empty array, not null.",
    );
  }

  const allowlist = new Map();
  const secrets = new Map();

  clients.forEach((entry, index) => {
    const where = `client entry #${index + 1}`;

    if (entry === null || typeof entry !== "object") {
      throw new ClientRegistryError(`ESI mod: ${where} is not an object.`);
    }

    const { clientId, redirectUris } = entry;
    if (clientId !== ANY_CLIENT_ID) {
      const problem = clientIdProblem(clientId);
      if (problem !== null) {
        throw new ClientRegistryError(
          `ESI mod: ${where} has an unusable client_id: ${problem} `
            + `Use "${ANY_CLIENT_ID}" to list a redirect URI for any client_id.`,
        );
      }
    }

    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      throw new ClientRegistryError(
        `ESI mod: ${where} (${clientId}) lists no redirect URIs. An entry with none permits `
          + "nothing, so it is a half-written line rather than a configuration.",
      );
    }

    const uris = allowlist.get(clientId) ?? new Set();
    for (const uri of redirectUris) {
      const { failure } = examineRedirectUri(uri);
      if (failure !== undefined) {
        throw new ClientRegistryError(
          `ESI mod: ${where} (${clientId}) lists redirect URI ${JSON.stringify(uri)}, which `
            + `cannot be used: ${failure.detail} A configured URI is compared byte-for-byte `
            + "against what a client sends, so one that is malformed would silently never match.",
        );
      }
      uris.add(uri);
    }
    allowlist.set(clientId, uris);

    registerSecret(secrets, entry, clientId, where);
  });

  return { allowlist, secrets };
}

/**
 * Read this entry's optional secret, validate it, and record it, or throw.
 *
 * Two spellings are accepted. `config.js` translates the operator's file into
 * this module's vocabulary (`client_id` becomes `clientId`, `redirect_uris`
 * becomes `redirectUris`), so a registry built from configuration sees
 * `clientSecret`; a test or anything built from the file's own vocabulary may
 * write `client_secret`. Both are read, and if both are present and disagree it
 * throws rather than picking one.
 */
function registerSecret(secrets, entry, clientId, where) {
  const camel = entry.clientSecret;
  const snake = entry.client_secret;

  if (camel !== undefined && snake !== undefined && camel !== snake) {
    throw new ClientRegistryError(
      `ESI mod: ${where} (${clientId}) sets both clientSecret and client_secret, and they `
        + "differ. One entry has one secret; there is no rule for which of two disagreeing "
        + "credentials wins.",
    );
  }

  const secret = camel !== undefined ? camel : snake;
  if (secret === undefined || secret === null) return;

  if (clientId === ANY_CLIENT_ID) {
    // See the file header. A secret on `"*"` authenticates its holder as whichever
    // client_id they name, which inverts the invariant rather than weakening it.
    throw new ClientRegistryError(
      `ESI mod: ${where} sets a client secret on the "${ANY_CLIENT_ID}" entry. A secret shared `
        + "by every client_id would authenticate whoever holds it as any client, which is the "
        + "opposite of what client authentication is for. Give the secret its own entry, with "
        + "the client_id it belongs to.",
    );
  }

  const problem = clientSecretProblem(secret);
  if (problem !== null) {
    throw new ClientRegistryError(
      `ESI mod: ${where} (${clientId}) has an unusable client secret: ${problem} A registered `
        + "secret that no presented secret can ever match is a confidential client that silently "
        + "behaves like a public one, so it is refused here rather than at the token endpoint. "
        + "Omit the field entirely to register a public client.",
    );
  }

  const existing = secrets.get(clientId);
  if (existing !== undefined && existing !== secret) {
    // Repeating a client_id merges its URIs, which is a way of organising a file.
    // Repeating it with two different secrets is not.
    throw new ClientRegistryError(
      `ESI mod: ${where} gives client_id ${JSON.stringify(clientId)} a second, different `
        + "client secret. Repeated entries merge their redirect URIs, but a client has one "
        + "secret or none.",
    );
  }

  secrets.set(clientId, secret);
}

/**
 * What is wrong with this configured secret, as a sentence fragment, or `null`.
 *
 * Only asked about a configured value. A secret arriving in a request is never
 * run through this: telling a caller their secret was the wrong shape says
 * something about the shape of the real one, and every refusal on that path is
 * the same refusal (see `verifySecret`).
 */
function clientSecretProblem(secret) {
  if (typeof secret !== "string") {
    return `it is ${secret === null ? "null" : typeof secret}, not a string.`;
  }
  if (secret === "") {
    return "it is empty. An empty secret is a configuration mistake, not a weak credential.";
  }
  if (secret.length < MIN_CLIENT_SECRET_LENGTH) {
    return `it is ${secret.length} characters, under the ${MIN_CLIENT_SECRET_LENGTH} this replica `
      + "requires: an operator invents this string, so the floor is the only thing standing "
      + "between it and a password. `openssl rand -hex 32` is a fine one.";
  }
  if (secret.length > MAX_CLIENT_SECRET_LENGTH) {
    return `it is ${secret.length} characters, over the ${MAX_CLIENT_SECRET_LENGTH} this replica `
      + "accepts.";
  }
  if (!CLIENT_SECRET_PATTERN.test(secret)) {
    return "it contains a character outside A-Z a-z 0-9 . _ - , which are the characters that "
      + "survive RFC 6749 §2.3.1's form-urlencoding of a Basic credential unchanged. Anything "
      + "else has two spellings on the wire, and a client that encodes differently from the way "
      + "this server decodes would fail to authenticate for a reason nobody could see.";
  }
  return null;
}

/**
 * What is wrong with this `client_id`, as a sentence fragment, or `null`.
 *
 * One function for the configured entries and the incoming request, so a
 * `client_id` an operator cannot configure is also one a client cannot present.
 */
function clientIdProblem(clientId) {
  if (typeof clientId !== "string" || clientId.trim() === "") {
    return "it is empty.";
  }
  if (clientId.length > MAX_CLIENT_ID_LENGTH) {
    return `it is ${clientId.length} characters, over the ${MAX_CLIENT_ID_LENGTH} this replica `
      + "accepts: the value becomes the azp claim of every token issued to it.";
  }
  if (hasControlCharacter(clientId)) {
    return "it contains a control character, which would be written into a log line and into a "
      + "signed token.";
  }
  return null;
}

// The registry

/**
 * Build the registry the authorize route asks before anything else.
 *
 * `clients` is `config.ssoClients`, an array of `{ clientId, redirectUris }`,
 * empty when no allowlist file is configured. Empty is a working configuration:
 * under the loopback rule every native tool still authenticates, and a
 * deployment with no browser-based client needs nothing else.
 *
 * `allowLoopback` lets a deployment that wants only its listed URIs say so. It
 * defaults to `true`, because turning it off locks out every RFC 8252 native
 * app, which is most of the ecosystem.
 */
function createClientRegistry({ clients = [], allowLoopback = true } = {}) {
  if (typeof allowLoopback !== "boolean") {
    throw new ClientRegistryError(
      `ESI mod: allowLoopback must be a boolean, got ${JSON.stringify(allowLoopback)}. It is `
        + "the switch on the rule that lets native apps in at all, so a truthy string quietly "
        + "meaning `true` is not a kindness.",
    );
  }

  const { allowlist, secrets } = buildAllowlist(clients);
  const wildcard = allowlist.get(ANY_CLIENT_ID);

  /**
   * The key the digests below are taken under, and the decoy an unregistered
   * client is compared against. Both are 32 bytes from the platform CSPRNG, minted
   * once per registry and never leaving it. See the file header.
   */
  const digestKey = crypto.randomBytes(32);
  const decoyDigest = crypto.randomBytes(32);

  /** HMAC-SHA-256 of a secret under this registry's key. Always 32 bytes. */
  function digest(secret) {
    return crypto.createHmac("sha256", digestKey).update(secret, "utf8").digest();
  }

  // The configured plaintext is turned into digests here and the strings go out of
  // scope with `secrets` at the end of construction.
  const secretDigests = new Map();
  for (const [clientId, secret] of secrets) {
    secretDigests.set(clientId, digest(secret));
  }
  secrets.clear();

  /** The exact URIs configured for this caller: its own entry plus `"*"`'s. */
  function permits(clientId, redirectUri) {
    const own = allowlist.get(clientId);
    if (own !== undefined && own.has(redirectUri)) return true;
    return wildcard !== undefined && wildcard.has(redirectUri);
  }

  /**
   * The one question.
   *
   * Order: the `client_id` first, because a request without a usable one is
   * malformed whatever it points at; then the redirect URI's shape; then the
   * allowlist; then loopback. The allowlist is asked before loopback so that a
   * configured `http://127.0.0.1:9000/cb` reports `via: "allowlist"`, which is what
   * the operator's file says and matters once they set `allowLoopback: false`.
   */
  function check(request) {
    // Read rather than destructured with a default, because a default covers only
    // `undefined`: `check(null)` would throw, and this is the request path, where
    // eve.js treats a throw as fatal.
    const source = request !== null && typeof request === "object" ? request : {};
    const { clientId, redirectUri } = source;

    if (clientId === undefined || clientId === null || clientId === "") {
      return fail(
        REASON.CLIENT_ID_MISSING,
        "The authorize request carried no client_id. This replica accepts any client_id, since CCP "
          + "issued them and we cannot know them in advance, but it records the one it was "
          + "given as the token's azp claim, so there has to be one.",
      );
    }

    const problem = clientIdProblem(clientId);
    if (problem !== null) {
      return fail(REASON.CLIENT_ID_INVALID, `The client_id cannot be used: ${problem}`);
    }

    const { url, failure } = examineRedirectUri(redirectUri);
    if (failure !== undefined) return failure;

    // Byte-for-byte, against the raw string, before anything looks at `url`. The
    // parse is for the refusals above and the loopback test, never the comparison.
    if (permits(clientId, redirectUri)) return ok(VIA.ALLOWLIST);

    if (allowLoopback && isLoopbackRedirect(url)) return ok(VIA.LOOPBACK);

    return fail(REASON.REDIRECT_URI_UNREGISTERED, unregisteredDetail(url, allowLoopback));
  }

  /**
   * Is this the secret registered for this `client_id`? One bit, no detail.
   *
   * Both sides are digested to 32 bytes and handed to `crypto.timingSafeEqual`.
   * There is no length comparison anywhere on this path: a length test is an early
   * return on the branch an attacker times, and `timingSafeEqual` on raw secrets
   * throws on a length mismatch, an oracle and under eve.js fatal.
   *
   * A `client_id` with no registered secret is compared against `decoyDigest`
   * rather than short-circuited, so "a secret presented to a public client" and
   * "the wrong secret presented to a confidential one" run the same instructions
   * and return the same `false`. `lib/clientAuth.js` gives both the same words.
   *
   * Still observable, none of it the secret:
   *
   *   The length of the presented secret changes how many SHA-256 blocks the HMAC
   *   compresses. It is the attacker's own input, bounded by the caller's length
   *   check before this is reached.
   *
   *   Whether the `client_id` is in the allowlist at all is a `Map` lookup on an
   *   attacker-supplied key, and a miss is slightly cheaper than a hit. That is not
   *   secret: this replica accepts any `client_id`.
   *
   *   Everything else the token endpoint does around this call, which over a
   *   network is orders of magnitude noisier.
   *
   * Which of the two failing cases happened is not observable, which is the
   * property the invariant needs.
   *
   * A malformed argument (no object, no string) returns `false` rather than
   * throwing: this is the request path, and eve.js treats a throw as fatal.
   */
  function verifySecret(request) {
    const source = request !== null && typeof request === "object" ? request : {};
    const { clientId, clientSecret } = source;

    // Not a credential at all. Refused before any comparison, because there is
    // nothing to compare and saying so takes no secret-dependent branch: the
    // presence of a string in the request is a fact the caller supplied.
    if (typeof clientSecret !== "string" || clientSecret === "") return false;
    if (typeof clientId !== "string" || clientId === "") return false;
    if (clientSecret.length > MAX_CLIENT_SECRET_LENGTH) return false;

    const registered = secretDigests.get(clientId);
    const expected = registered === undefined ? decoyDigest : registered;

    return crypto.timingSafeEqual(digest(clientSecret), expected);
  }

  return Object.freeze({ check, verifySecret });
}

/**
 * The operator-facing sentence for the one refusal that is about policy rather
 * than a malformed value.
 *
 * It says which gate the URI missed, because the fixes differ ("add this line to
 * the allowlist file" against "your tool is not binding loopback the way you
 * think it is"). It never repeats the allowlist's contents: this text can reach
 * a rendered page, and enumerating what a deployment permits is not something to
 * hand an unauthenticated caller.
 */
function unregisteredDetail(url, allowLoopback) {
  const uri = `${url.protocol}//${url.host}${url.pathname}`;

  if (!LOOPBACK_SCHEMES.includes(url.protocol)) {
    return `The redirect_uri is not in this replica's allowlist, and its "${url.protocol.slice(0, -1)}" `
      + "scheme is not one that is accepted automatically: only http and https to a loopback "
      + "address are. A private-use scheme has to be listed exactly in ESI_MOD_SSO_CLIENTS_PATH.";
  }

  if (!allowLoopback) {
    return `The redirect_uri ${uri} is not in this replica's allowlist, and loopback redirect `
      + "URIs are switched off on this deployment, so the allowlist is the only way in.";
  }

  if (isLoopbackHostname(url.hostname)) {
    // Reachable only when the caller asked for a loopback URI and loopback is on,
    // which the branch above already accepted. Defensive, and says something true
    // rather than something impossible.
    return `The redirect_uri ${uri} was not accepted. It names a loopback address, so this is a `
      + "bug in the registry rather than a configuration problem.";
  }

  return `The redirect_uri host "${url.hostname}" is neither in this replica's allowlist nor a `
    + "loopback address (127.0.0.0/8 or [::1] as literals; the name \"localhost\" is not one, "
    + "because what it resolves to is not this server's to assume). Add the exact URI to the "
    + "file named by ESI_MOD_SSO_CLIENTS_PATH, or point the tool at its loopback address.";
}

module.exports = Object.freeze({
  ANY_CLIENT_ID,
  CLIENT_SECRET_PATTERN,
  ClientRegistryError,
  IPV6_LOOPBACK_HOST,
  LOOPBACK_SCHEMES,
  MAX_CLIENT_ID_LENGTH,
  MAX_CLIENT_SECRET_LENGTH,
  MIN_CLIENT_SECRET_LENGTH,
  REASON,
  VIA,

  createClientRegistry,

  // Exported for the tests that state the address rule directly, without a
  // registry and allowlist in the way.
  isLoopbackHostname,
  isLoopbackRedirect,
});
