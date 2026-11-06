/**
 * `GET /v2/oauth/authorize`: the only endpoint on this surface that a human
 * looks at, and the only one where this replica diverges from CCP on purpose.
 *
 * From the third-party application's side nothing differs. It renders its own
 * "Log in with EVE SSO" button, sends the browser here with `response_type`,
 * `client_id`, `redirect_uri`, `scope`, `state` and the PKCE pair, and gets back
 * `redirect_uri?code=...&state=...`. Steps 1, 4 and 5 of the flow are standard
 * OAuth 2.0.
 *
 * Step 3 is the divergence. Where CCP asks for a username and password, this
 * replica cannot: a private server has no password to check, and the only
 * unforgeable source of character identity is a session already logged into the
 * game (D3). So the page shows a short bind code, the player types it into their
 * running client, and the browser's poll turns that into the redirect.
 *
 * Two error channels, and the order is the security property:
 *
 *   Rendered, never redirected. A `redirect_uri` that is missing, malformed, or
 *   not registered for the `client_id` is refused here as an HTML page, and the
 *   browser goes nowhere (RFC 6749 section 4.1.2.1).
 *
 *   Redirected. Everything that goes wrong after the redirect target has been
 *   proved (a bad `response_type`, a malformed scope, a refused PKCE challenge,
 *   a store that could not mint) goes back to the application as
 *   `?error=...&error_description=...&state=...`.
 *
 * An endpoint that redirected an error to an unvalidated `redirect_uri` would be
 * an open redirector. Validating the target first is why the client and redirect
 * checks sit above every other check in `handleAuthorize`.
 *
 * The rendered refusal says nothing about what would have been accepted: no echo
 * of the submitted `redirect_uri` (an XSS sink), no list of registered URIs, and
 * not even whether the client was unknown or the URI unregistered.
 * `clientRegistry.check` returns an operator sentence that goes to the log.
 *
 * The poll endpoint is ours (D23). `/_mod/sso/bind-status` has no counterpart on
 * `login.eveonline.com`, which has no bind code and nothing to poll. The `/_mod/`
 * prefix is `routes/health.js`'s argument: CCP's SSO paths are `/v2/oauth/...`,
 * `/oauth/...` and `/.well-known/...`, so a leading underscore segment cannot
 * collide with something CCP grows later.
 *
 * It is deliberately not an oracle:
 *
 *   The `requestId` is 256 bits of `crypto.randomBytes`, minted here and handed
 *   only to the browser that asked. It is not derived from the bind code, client
 *   id or character. It is also the key the bind store files the bind under (the
 *   store treats a session id as opaque), so there is no id mapping to get
 *   wrong, and its unguessability is the whole defence.
 *
 *   The answer never carries the character id, bind code, client id or scope.
 *   "Not yet" and "here is where to go now" are the only facts the browser
 *   needs. The bind store's `inspect` returns more on a claimed entry
 *   (`characterID`, `accountID`, `role`, `isGM`, `claimedAt`) and the integration
 *   adapter narrows it to `{state, characterId}`; this route reads named fields
 *   and never spreads what it was handed, so an adapter that forgets to strip
 *   something still cannot publish it. The redirect does carry an authorization
 *   code, which is why this endpoint sends no CORS headers: a cross-origin page
 *   that learned a `requestId` must not be able to read the code.
 *
 *   An unknown, expired, misshapen and absent `requestId` all answer with the
 *   same bytes. The bind store holds that line across six no-information paths
 *   (asserting `JSON.stringify` identity), and its rate limiter sits ahead of its
 *   shape check because answering a malformed guess differently tells an
 *   attacker which guesses had the right shape. `handleBindStatus` has no shape
 *   check at all.
 *
 * `bindFlow.mint({requestId})` takes a request id and nothing else, so nothing
 * downstream remembers which authorization a bind belongs to. This route keeps
 * the validated request (client, redirect target, scope, PKCE pair, state) in a
 * bounded in-memory map keyed by the request id, until the poll turns it into a
 * code. Putting those parameters in the page and having the browser hand them
 * back would reopen the redirector hole: the `redirect_uri` was proved before
 * the page was rendered, and a value the browser can edit afterwards was never
 * proved. Server-side, keyed by a secret the server minted, the check still
 * means something.
 *
 * The map is capped and swept lazily. There is no `setInterval`: this listener
 * shares the game's event loop (design constraint 2), and a timer sweeping
 * an empty map is a cost paid when nobody is logging in.
 *
 * `createOauthAuthorizeRoute({clientRegistry, authCodes, bindFlow,
 * devAutoApprove, now, log})`. This file requires no mod module (not `../config`,
 * not `contract/sso.js`, not `lib/clientRegistry.js`), so
 * `test/authorizeContract.test.js` drives it with object literals and three
 * doubles, as `routes/oauthJwks.js` does with `getJwks`.
 *
 * `contract/sso.js` is the authority for the path and the PKCE method and is not
 * imported: `contract/` is test-only and never deployed (`lib/sourceHash.js`
 * `HASHED_DIRS` is `["lib", "routes"]`, and `scripts/deploy-mod.js` copies that
 * manifest), so a route requiring it would pass the suite and throw
 * `MODULE_NOT_FOUND` inside the game process. The constants are duplicated
 * below and the test asserts the copies agree.
 */

"use strict";

const crypto = require("node:crypto");

// Paths (contract/sso.js is the authority for the first one)

/**
 * `contract/sso.js` `DISCOVERY_ENDPOINT_PATHS.authorization`.
 *
 * A literal path, not a version prefix. `docs/d6-listener-split.md` states that
 * the version dimension is ESI's alone and `/v2/oauth/*` never enters the ESI
 * route table; `lib/ssoDispatch.js` exact-matches this string and there is no
 * `/latest/` spelling of it.
 */
const AUTHORIZE_PATH = "/v2/oauth/authorize";

/**
 * Ours, not CCP's (D23); see the header.
 *
 * Named `bind-status` because it answers the status of a bind. It is not
 * reusable for anything else: it mints an authorization code as a side effect of
 * its first `approved` answer.
 */
const BIND_STATUS_PATH = "/_mod/sso/bind-status";

/** The one parameter the poll takes. Also the name the page's script uses. */
const BIND_STATUS_QUERY_PARAM = "request_id";

/**
 * The in-game command, owned by the bind-code module; this page does not get a
 * vote on it.
 *
 * `/esi <code>`, exactly. Not `/bind`, not `/esi bind`. The bind module's help
 * line is `/esi <code> - finish signing in to a tool with this character`, and
 * its usage message tells the player "Start the sign-in in your browser and type
 * the code it shows you here." That message and this page are two halves of one
 * instruction. A page telling a player to type something the parser does not
 * accept is the likeliest way this flow fails in the field, as a player who
 * thinks they did it right.
 *
 * Duplicated rather than imported because `handle` is driven by injected doubles
 * and this route requires no mod module. This is a copy of another module's
 * parser rather than a wire constant, so it is rendered whole (`/esi <code>`)
 * for a human to read on the way past.
 */
const SLASH_COMMAND = "/esi";

// The protocol constants

/**
 * The only `response_type` this endpoint implements.
 *
 * CCP's discovery document advertises `["code", "token"]` (the implicit flow is
 * still on their metadata) and `routes/oauthDiscovery.js` reproduces that
 * verbatim. This replica does not implement `token`: it would mint an access
 * token straight into a URL fragment, and RFC 6749's security guidance has been
 * retiring it for a decade.
 *
 * The divergence is recorded here rather than by editing the discovery
 * document, which is byte-compared by clients and is a transcription of CCP's,
 * not a statement of capability. A request for `token` gets
 * `unsupported_response_type` through the redirect channel (RFC 6749 section
 * 4.1.2.1).
 */
const RESPONSE_TYPE = "code";

/**
 * `contract/sso.js` `DISCOVERY_CONSTANTS.code_challenge_methods_supported`:
 * `S256`, and nothing else.
 *
 * `plain` is refused. RFC 7636 section 7.2 notes `plain` protects against
 * nothing an attacker who can read the authorization request cannot defeat, and
 * D1 puts this replica on plain HTTP, where reading the request is what someone
 * on the same LAN can do. A `plain` challenge would look like PKCE in every log
 * and be worth zero. A server that advertises S256-only and accepts `plain` is
 * also contradicting its own discovery document.
 */
const CODE_CHALLENGE_METHOD = "S256";

/**
 * RFC 7636 section 4.2: the challenge is 43 to 128 characters of unreserved
 * base64url.
 *
 * Checked because the value is stored verbatim and handed to the token endpoint
 * to compare against `base64url(sha256(verifier))`. A challenge that cannot be
 * that comparison's left-hand side would fail at token exchange with an error
 * about the verifier: late, in the application's process, naming the wrong
 * parameter.
 */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * RFC 6749 section 3.3's `scope-token`: visible ASCII except space, `"` and `\`.
 *
 * A syntax check and deliberately not a membership check; see `parseScope`.
 */
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/**
 * Bounds on the scope list, ours: no requirement names a number.
 *
 * Accepting unknown scopes (see `parseScope`) makes this parameter a free-form
 * channel into the token's `scp` claim, and a signed JWT is carried on every
 * later call. Without a cap a client could make each of its own requests 100 KB
 * heavier by accident.
 *
 * EVE's full scope list is around ninety entries and the longest is under forty
 * characters, so a tool asking for everything lands near 3.5 KB and 90 tokens.
 * 8 KB and 256 tokens leave a comfortable multiple; 128 characters per token is
 * four times the longest real scope.
 */
const SCOPE_LIMITS = Object.freeze({
  maxTokens: 256,
  maxTokenLength: 128,
  maxTotalLength: 8192,
});

/**
 * A `client_id` long enough to be anything real and short enough to be safe.
 *
 * CCP's are 32 hex characters. The cap is not a format check (the registry owns
 * what a client id is): it bounds the value before it reaches a log line or an
 * error page, because everything here arrives from a query string an attacker
 * writes.
 */
const MAX_CLIENT_ID_LENGTH = 255;

/** The same, for the redirect target. A registered URI is nowhere near this. */
const MAX_REDIRECT_URI_LENGTH = 2048;

// The pending-request store's sizing, all ours

/**
 * How many authorizations may be in flight at once.
 *
 * A ceiling rather than a target: 256 simultaneous logins on a private eve.js
 * server is far past plausible, and the memory is a few hundred kilobytes. It
 * defends against a client looping on `authorize` and growing this map inside the
 * game's heap.
 *
 * At the cap, expired entries are dropped first and a live entry is never
 * evicted to make room. Evicting the oldest would let a flood of requests push an
 * honest player's half-finished login out from under them.
 */
const MAX_PENDING_REQUESTS = 256;

/**
 * The longest a pending authorization may live, whatever `bindFlow` says.
 *
 * `bindFlow.mint` returns its own `expiresAt`, which normally decides it (the
 * authorization must not outlive the bind code that completes it). This clamps
 * the case where that value is absent or unusable, or a future bind store hands
 * back a very long one.
 *
 * Fifteen minutes is long enough to alt-tab into the game, find the prompt and
 * type six characters with interruptions, and short enough that an abandoned
 * login is gone before anyone notices.
 */
const PENDING_TTL_MS = 15 * 60 * 1000;

/**
 * How often the page asks.
 *
 * Two seconds. This listener shares the game's event loop (design
 * constraint 2). One poll is a `Map` lookup, a `bindFlow.peek` and a small JSON
 * response, so a minute costs thirty of them, and at the `MAX_PENDING_REQUESTS`
 * ceiling that is 128 trivial requests a second. Faster multiplies the load for
 * a snappier feel; slower leaves the player looking at a page that seems to have
 * missed what they did.
 */
const POLL_INTERVAL_MS = 2000;

/**
 * The three answers the poll can give.
 *
 * `expired` covers "never existed", "timed out" and "already handed back its
 * redirect", by design (see the header). `ready` carries a `redirect` and nothing
 * else, and that redirect may itself be an OAuth error redirect: whether the
 * application receives a code or an error is this server's decision, not the
 * page's.
 */
const POLL_STATUS = Object.freeze({
  PENDING: "pending",
  EXPIRED: "expired",
  READY: "ready",
});

// How responses are shaped, and which parts are ours
//
// All of it is ours. `contract/sso.js` `UNOBSERVED` records that no response
// header has been captured off `login.eveonline.com`, and the authorize
// endpoint's HTML has not been transcribed. Nothing may be borrowed from
// `contract/wire.js`, which holds facts about `esi.evetech.net`'s two producers.

/** HTML, with a charset: unlike JSON, HTML has no implied encoding. */
const CONTENT_TYPE_HTML = "text/html; charset=utf-8";

/** Bare `application/json`, matching `routes/oauthJwks.js`. */
const CONTENT_TYPE_JSON = "application/json";

/**
 * `302`, not `303` or `307`.
 *
 * The request is a `GET` and the response is a `GET`, so the method-preservation
 * distinctions those statuses draw do not apply. `302` is what RFC 6749 section
 * 4.1.2 names and every OAuth client library handles.
 */
const REDIRECT_STATUS = 302;

/**
 * `GET`, and nothing else, not even `HEAD`.
 *
 * `routes/oauthJwks.js` answers `HEAD` because a JWKS is a document. This
 * endpoint is an action: a `GET` mints a request id and a bind code and consumes
 * a slot in the pending store. A `HEAD` would perform all of that for a
 * monitoring probe, burning bind codes and filling the map. `Allow` says what to
 * use instead.
 *
 * `POST` is permitted by RFC 6749 section 3.1 as a MAY and is not implemented:
 * it needs form-encoded body parsing that `server.js` does not do (it parses
 * JSON), and the browser arrives by navigation, a `GET`.
 *
 * `OPTIONS` is refused rather than answered as a CORS preflight, following
 * `routes/oauthDiscovery.js`. Neither path is fetched cross-origin by anything
 * legitimate (the authorize page is a top-level navigation, the poll a
 * same-origin `fetch`), and answering a preflight would advertise a cross-origin
 * capability the poll must not have.
 */
const ALLOWED_METHOD = "GET";

// Small pure helpers

/**
 * Read one query parameter, or `undefined` when it was not sent.
 *
 * `hasOwnProperty` rather than a truthiness test, because `state=` is a present
 * state whose value is the empty string, and `state` is echoed verbatim. It also
 * keeps the read off the prototype: `server.js` builds its query object with
 * plain assignment, so `?__proto__=x` sets the prototype rather than an own
 * property.
 *
 * `server.js` collapses a repeated parameter to the last value. That is the
 * listener's rule; a client sending `redirect_uri` twice gets the second one
 * validated and redirected to, which is self-consistent.
 */
function readQuery(request, name) {
  const query = (request && request.query) || {};
  if (!Object.prototype.hasOwnProperty.call(query, name)) return undefined;
  const value = query[name];
  return typeof value === "string" ? value : String(value);
}

/**
 * HTML text escaping, applied to every value that reaches the page.
 *
 * Every embedded value is generated by this process (bind code, request id,
 * milliseconds) and none is client-supplied. It is escaped anyway, because "these
 * are safe" is a claim about a generator in another module. The five characters
 * are the standard set; the quote forms matter because values land in attributes.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Attach parameters to a redirect target without re-serializing it.
 *
 * `new URL(redirectUri)` plus `searchParams.set` is wrong here because `URL`
 * normalizes: it re-encodes the existing query, collapses `%7E` to `~`, resolves
 * dot segments, lowercases the host and drops a default port. The registry
 * matched this URI exactly, so a normalized variant is somewhere the registry
 * never approved, and a client that compares the callback URL against its own
 * configuration may refuse it.
 *
 * So: the registered bytes verbatim, with an appended query, `?` or `&`
 * depending on whether the registered URI already has one (RFC 6749 section
 * 3.1.2 permits it).
 *
 * `encodeURIComponent` rather than `URLSearchParams`, for `state`:
 * `URLSearchParams` encodes a space as `+`, and a client reading `state` back
 * with `decodeURIComponent` would see a `+` and conclude it was tampered with.
 * `%20` round-trips through both. Verbatim has to mean verbatim in the client's
 * parser.
 */
function buildRedirect(redirectUri, params) {
  const query = params
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");

  if (query === "") return redirectUri;
  return `${redirectUri}${redirectUri.includes("?") ? "&" : "?"}${query}`;
}

/**
 * The scope list, or a reason it is unusable.
 *
 * Unknown scopes are accepted. `publicData` and unknown `esi-*` scopes must not
 * be refused: tools in this ecosystem still ask for scopes whose ESI routes CCP
 * removed years ago (`publicData`, `esi-characters.read_bookmarks.v1`,
 * `esi-characters.read_opportunities.v1`), and refusing them would stop those
 * tools before consent, with no recovery, since the tools are not modified.
 *
 * It goes one step further and accepts any syntactically valid scope-token: a
 * generic OAuth library that appends `openid`, a tool with a typo, a fork with a
 * scope somebody invented. Granting them costs nothing, because a scope is only
 * authority if some route requires it, and no route here requires a scope that
 * does not exist. The token carries an extra string in `scp` and authorises
 * exactly what it did before.
 *
 * What is refused is malformed or unbounded: a token with a control character
 * or quote will be re-serialized into a JWT claim, a log line and possibly a UI,
 * and an unbounded list makes every later request heavier. Both come back as
 * `invalid_scope` through the redirect channel.
 *
 * Duplicates are dropped, first occurrence wins, order preserved. A repeated
 * scope grants nothing a single one does not, so this is the one normalization
 * that provably cannot change what a token authorises, and it stops a client
 * inflating its tokens with copies of `publicData`. A client that byte-compared
 * the granted `scope` against its request and sent duplicates would see a
 * difference; nothing observed does either.
 *
 * @returns {{ scope: string, scopes: string[] } | { failure: string }}
 */
function parseScope(raw) {
  if (raw === undefined || raw === "") return { scope: "", scopes: [] };

  if (raw.length > SCOPE_LIMITS.maxTotalLength) {
    return {
      failure:
        `The scope parameter is ${raw.length} characters; this server accepts at most `
        + `${SCOPE_LIMITS.maxTotalLength}.`,
    };
  }

  // Space, and only space. RFC 6749 section 3.3 delimits on `%x20`, and a tab or
  // newline that arrived percent-encoded is a character inside a token, which the
  // pattern below refuses. Splitting on general whitespace would accept a scope
  // list containing a newline and pass it to whatever writes the log.
  const seen = new Set();
  const scopes = [];

  for (const token of raw.split(" ")) {
    if (token === "") continue;
    if (token.length > SCOPE_LIMITS.maxTokenLength) {
      return {
        failure:
          `A requested scope is ${token.length} characters; this server accepts at most `
          + `${SCOPE_LIMITS.maxTokenLength} per scope.`,
      };
    }
    if (!SCOPE_TOKEN_PATTERN.test(token)) {
      return {
        failure:
          "A requested scope contains a character RFC 6749 does not allow in a scope value "
          + '(visible ASCII except space, double quote and backslash).',
      };
    }
    if (seen.has(token)) continue;
    seen.add(token);
    scopes.push(token);
    if (scopes.length > SCOPE_LIMITS.maxTokens) {
      return {
        failure:
          `More than ${SCOPE_LIMITS.maxTokens} distinct scopes were requested; this server `
          + "accepts at most that many.",
      };
    }
  }

  // A space-delimited string, which is what `scope` is in RFC 6749 and what
  // `authCodes.mint` names its argument; the token endpoint splits it to build
  // `scp`. An array would have made the two modules disagree about the type of a
  // shared parameter.
  return { scope: scopes.join(" "), scopes };
}

/**
 * The PKCE pair, or a reason it is unusable.
 *
 * A missing `code_challenge` is accepted. This is the decision most likely to be
 * revisited. CCP's discovery document publishes
 * `code_challenge_methods_supported: ["S256"]`, which RFC 8414 section 2 defines
 * as which methods the server supports, not as PKCE being mandatory, and CCP
 * publishes no mandatory-PKCE member. The token endpoint authenticates
 * confidential clients with HTTP Basic and a client secret, the flow every
 * server-side tool here uses, and those clients send no verifier. Requiring a
 * challenge would refuse all of them at the authorization endpoint, diverging
 * from CCP before they can reach consent.
 *
 * So the challenge is optional, and `codeChallenge` reaches `authCodes.mint` as
 * `null` when absent, explicitly `null` rather than omitted so the token endpoint
 * can tell "no PKCE" from "a challenge I failed to read".
 *
 * The invariant this hands to the token endpoint, which must hold or the
 * optionality becomes a downgrade: a code minted with a challenge must be
 * redeemable only with a matching verifier, and a code minted without one only
 * by a client that authenticated. If a public client could redeem a no-challenge
 * code, a network attacker would get PKCE removal by stripping two query
 * parameters. The check belongs at redemption because only redemption knows how
 * the client authenticated.
 *
 * `plain` is refused, and so is an omitted method. `plain` for the reasons on
 * `CODE_CHALLENGE_METHOD`. RFC 7636 section 4.3 defaults an omitted
 * `code_challenge_method` to `plain`; following that and then refusing it
 * matches refusing an omitted method outright, so the choice is only the
 * message: "the method must be S256" is actionable, where "plain is not
 * supported" describes a value they never sent. Guessing `S256` for them is
 * wrong: a client that computed a `plain` challenge would pass here and fail at
 * token exchange with a verifier mismatch, a late, misattributed failure.
 *
 * A method without a challenge is refused for the mirror-image reason: it is an
 * incoherent request that probably means the challenge was dropped in the
 * client, and accepting it would mint a code with no PKCE binding for a client
 * that believes it has one.
 *
 * @returns {{ codeChallenge: string|null, codeChallengeMethod: string|null }
 *           | { failure: string }}
 */
function parsePkce(challenge, method) {
  const hasChallenge = challenge !== undefined && challenge !== "";
  const hasMethod = method !== undefined && method !== "";

  if (!hasChallenge && !hasMethod) return { codeChallenge: null, codeChallengeMethod: null };

  if (!hasChallenge) {
    return {
      failure:
        "code_challenge_method was sent without a code_challenge. A method with nothing to "
        + "apply it to usually means the challenge was lost in the client, and minting a code "
        + "with no PKCE binding for a client that believes it has one is not something this "
        + "server will do.",
    };
  }

  if (!hasMethod) {
    return {
      failure:
        `code_challenge was sent without a code_challenge_method. This server supports `
        + `${CODE_CHALLENGE_METHOD} only, and RFC 7636 defaults an omitted method to "plain", `
        + `which is refused. Send code_challenge_method=${CODE_CHALLENGE_METHOD}.`,
    };
  }

  if (method !== CODE_CHALLENGE_METHOD) {
    return {
      failure:
        `code_challenge_method=${method} is not supported. This server supports `
        + `${CODE_CHALLENGE_METHOD} only, which is also what its discovery document `
        + "advertises.",
    };
  }

  if (!CODE_CHALLENGE_PATTERN.test(challenge)) {
    return {
      failure:
        "code_challenge is not a valid RFC 7636 challenge: it must be 43 to 128 characters "
        + "of unreserved base64url (A-Z a-z 0-9 - . _ ~).",
    };
  }

  // Returned byte-for-byte: no trimming, no case folding, no base64 round trip.
  // The token endpoint compares this against `base64url(sha256(verifier))`, so any
  // transformation breaks PKCE for every client, silently (the authorization
  // succeeds and the token exchange fails describing the verifier).
  return { codeChallenge: challenge, codeChallengeMethod: method };
}

/**
 * Is this a redirect target we are willing to append a code to?
 *
 * Shape only. Whether it is registered is `clientRegistry.check`'s question, as
 * are loopback ports, schemes and hosts.
 *
 * Checked here is what makes the URI unusable whatever the registry said: it
 * must be absolute (a relative target would resolve against this listener) and
 * carry no fragment. RFC 6749 section 3.1.2 forbids the fragment, and appending
 * `?code=...` after a `#` would put the code inside the fragment, where it never
 * reaches the client's server.
 */
function redirectUriProblem(redirectUri) {
  if (redirectUri === undefined || redirectUri === "") {
    return "no redirect_uri was sent";
  }
  if (redirectUri.length > MAX_REDIRECT_URI_LENGTH) {
    return `the redirect_uri is longer than ${MAX_REDIRECT_URI_LENGTH} characters`;
  }
  if (redirectUri.includes("#")) {
    return "the redirect_uri contains a fragment, which RFC 6749 §3.1.2 forbids";
  }

  let parsed;
  try {
    parsed = new URL(redirectUri);
  } catch (_) {
    return "the redirect_uri is not an absolute URL";
  }
  if (parsed.protocol === "") return "the redirect_uri has no scheme";

  return null;
}

// The page

/**
 * The stylesheet, inline; it is the whole of the page's design.
 *
 * No external asset of any kind (no font, image or script file). That is partly
 * D5/D20 (nothing is fetched or bundled, there is no build step) and mostly the
 * CSP: a page served by a game-server mod over plain HTTP should have as little
 * attack surface as possible, which means depending on nothing.
 */
const PAGE_STYLE = [
  ":root{color-scheme:light dark;--fg:#1a1a1a;--bg:#fbfbfb;--muted:#5b5b5b;--line:#d6d6d6}",
  "@media(prefers-color-scheme:dark){:root{--fg:#e8e8e8;--bg:#161616;--muted:#9a9a9a;",
  "--line:#3a3a3a}}",
  "body{margin:0;background:var(--bg);color:var(--fg);",
  "font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}",
  "main{max-width:34rem;margin:0 auto;padding:2.5rem 1.25rem}",
  "h1{font-size:1.25rem;margin:0 0 1rem}",
  ".code{font:700 2rem/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;",
  "letter-spacing:.18em;margin:1rem 0 0;padding:.75rem 1rem;border:1px solid var(--line);",
  "border-radius:.5rem;text-align:center;user-select:all;overflow-wrap:anywhere}",
  ".copyrow{display:flex;justify-content:flex-end;margin:.5rem 0 0}",
  ".copy{display:none;align-items:center;gap:.4rem;font:inherit;font-size:.875rem;",
  "color:var(--fg);background:transparent;border:1px solid var(--line);",
  "border-radius:.375rem;padding:.4rem .7rem;cursor:pointer}",
  ".copy.ready{display:inline-flex}",
  ".copy:hover{border-color:var(--fg)}",
  ".copy:focus-visible{outline:2px solid var(--fg);outline-offset:2px}",
  ".copy .icon{flex:none;width:1em;height:1em}",
  "#status{margin-top:1.5rem;padding-top:1rem;border-top:1px solid var(--line);",
  "color:var(--muted)}",
  ".fine{margin-top:2rem;font-size:.8125rem;color:var(--muted)}",
].join("");

/**
 * The copy button's icon, as inline markup rather than an image.
 *
 *   No `xmlns`. An `<svg>` inside an HTML document is put in the SVG namespace
 *   by the HTML parser, so the attribute is redundant, and its value is an
 *   `http://` URL, the only absolute URL in a document that otherwise contains
 *   none.
 *
 *   No `src`, `<img>` or data URI. `img-src 'none'` is in the CSP because this
 *   page fetches nothing; a fetched icon would need the CSP relaxed.
 *
 *   `aria-hidden`. The button's text says "Copy command", and a screen reader
 *   that also announced the graphic would announce the control twice.
 */
const COPY_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="9" y="9" width="13" height="13" rx="2"></rect>'
  + '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'
  + "</svg>";

/** What the copy button says when it is not saying anything else. */
const COPY_LABEL = "Copy command";

/**
 * The browser half.
 *
 * No template literals and no `${`, because this string is assembled inside
 * template literals; no `</script>` can appear in it, because nothing from the
 * request reaches it. Every per-request value (poll URL, request id, interval,
 * deadline) is read from a `data-` attribute, and the command it copies is read
 * from the document's own text. Reading configuration out of the DOM rather than
 * an inlined JSON blob makes injecting a value into this script structurally
 * impossible, since attribute escaping is the only escaping involved. The one
 * literal spliced in is `COPY_LABEL`, through `JSON.stringify`, a constant in
 * this file.
 *
 * `location.replace` rather than an assignment: the page carrying the bind code
 * should not sit in the back stack.
 *
 * The deadline is computed in the browser from a duration the server sent, not
 * an absolute timestamp, so a client clock minutes off the server's does not
 * make the page give up instantly or long after the bind is dead.
 */
const PAGE_SCRIPT = [
  "(function(){",
  "var el=document.getElementById('status');",
  "var url=el.getAttribute('data-poll-url');",
  "var id=el.getAttribute('data-request-id');",
  "var every=Number(el.getAttribute('data-interval'));",
  "var deadline=Date.now()+Number(el.getAttribute('data-expires-in'));",
  "var timer=null;",
  "function stop(text){if(timer)clearTimeout(timer);timer=null;el.textContent=text;}",
  "function later(){timer=setTimeout(tick,every);}",
  "function waiting(){",
  "var left=Math.max(0,Math.round((deadline-Date.now())/1000));",
  "el.textContent='Waiting for the code to be entered in game ('+left+'s left).';",
  "}",
  "function gone(){stop('That code has expired. Start the sign-in again from the application.');}",
  // The copy button, wired here rather than declared with an `onclick`: an inline
  // handler is what `script-src 'nonce-...'` refuses.
  "var cmd=document.getElementById('command');",
  "var copy=document.getElementById('copy');",
  "var label=document.getElementById('copy-label');",
  "var idle=", JSON.stringify(COPY_LABEL), ";",
  "var revert=null;",
  "function say(text){label.textContent=text;if(revert)clearTimeout(revert);",
  "revert=setTimeout(function(){label.textContent=idle;},2000);}",
  // Last resort, and still useful: leave the line selected so the player's own
  // Ctrl+C or long-press finishes the job.
  "function pick(){try{var range=document.createRange();range.selectNodeContents(cmd);",
  "var chosen=window.getSelection();chosen.removeAllRanges();chosen.addRange(range);}",
  "catch(e){}}",
  // `document.execCommand` is obsolete and is the only thing that works when the
  // page is not a secure context, which is this page's ordinary case: a private
  // server is reached over plain HTTP, and only `127.0.0.1` and `localhost` are
  // trusted without TLS.
  "function legacy(text){var box=document.createElement('textarea');box.value=text;",
  "box.setAttribute('readonly','');box.style.position='fixed';box.style.top='0';",
  "box.style.opacity='0';document.body.appendChild(box);box.select();",
  "var done=false;try{done=document.execCommand('copy');}catch(e){done=false;}",
  "document.body.removeChild(box);return done;}",
  "function fell(text){if(legacy(text)){say('Copied');return;}pick();say('Copy it yourself');}",
  "copy.addEventListener('click',function(){",
  // The line out of the document, not a second copy: whatever the player is
  // looking at is what their clipboard gets.
  "var text=cmd.textContent.trim();",
  "if(navigator.clipboard&&navigator.clipboard.writeText){",
  "navigator.clipboard.writeText(text).then(function(){say('Copied');},",
  "function(){fell(text);});return;}",
  "fell(text);",
  "});",
  // Shown only now: a button that cannot work is worse than none, and without this
  // script it cannot. The code box selects whole on one click either way.
  "copy.className='copy ready';",
  "function tick(){",
  "if(Date.now()>=deadline){gone();return;}",
  "waiting();",
  "fetch(url+'?", BIND_STATUS_QUERY_PARAM, "='+encodeURIComponent(id),",
  "{cache:'no-store',credentials:'omit'})",
  ".then(function(r){return r.json();})",
  ".then(function(d){",
  "if(d&&d.status==='ready'&&typeof d.redirect==='string'){",
  "stop('Signing you in\\u2026');location.replace(d.redirect);return;}",
  "if(d&&d.status==='expired'){gone();return;}",
  "later();",
  "})",
  ".catch(later);",
  "}",
  "tick();",
  "})();",
].join("");

/**
 * The response headers every page this route serves carries.
 *
 * A nonce-based CSP rather than `'unsafe-inline'`. The page has one inline style
 * and one inline script and no other resource, so `default-src 'none'` with two
 * nonce sources and a single `connect-src 'self'` describes it exactly. The nonce
 * costs sixteen random bytes.
 *
 *   `frame-ancestors 'none'` and `X-Frame-Options: DENY`: framed inside someone
 *   else's page, a sign-in page showing a code becomes a way to show a player a
 *   code that is not theirs. The two headers cover two generations of browser.
 *
 *   `Referrer-Policy: no-referrer`: this page's URL carries the client id, scope
 *   list and state, and its next act is to navigate to the application's
 *   `redirect_uri`. Without this, that navigation hands the application's server
 *   the whole authorization request in a `Referer` header.
 *
 *   `Cache-Control: no-store`: the page contains a live bind code, and every
 *   redirect carries a one-time authorization code or an error. None may sit in
 *   a shared cache or the back-forward store.
 *
 *   `nosniff`: backs up `Content-Type` on a response whose body is partly
 *   attacker-adjacent.
 */
function pageHeaders(nonce) {
  return {
    "content-type": CONTENT_TYPE_HTML,
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "img-src 'none'",
      "connect-src 'self'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
    ].join("; "),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

/** The document around whatever `main` is. One shell, so the headers fit both. */
function pageShell({ nonce, title, main, script }) {
  return "<!doctype html>\n"
    + '<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    + '<meta name="referrer" content="no-referrer">\n'
    + `<title>${escapeHtml(title)}</title>\n`
    + `<style nonce="${nonce}">${PAGE_STYLE}</style>\n`
    + "</head>\n<body>\n<main>\n"
    + main
    + "\n</main>\n"
    + (script ? `<script nonce="${nonce}">${script}</script>\n` : "")
    + "</body>\n</html>\n";
}

/**
 * The refusal page, and the whole of what it is allowed to say.
 *
 * One fixed sentence per class of failure, never a value from the request: not
 * the submitted `redirect_uri` (an XSS sink that tells a prober their value got
 * this far), not the registered ones, not the registry's machine `reason`, and
 * not the distinction between "no such client" and "that URI is not registered
 * for it", which would let anybody enumerate client ids.
 *
 * The operator's version is a log line carrying `clientRegistry.check`'s
 * `detail` sentence. This is the split made on the ESI side: an error a client
 * sees says what to do, an error only an operator sees says what happened.
 */
function noticePage(status, heading, message) {
  const nonce = newNonce();
  return {
    status,
    headers: pageHeaders(nonce),
    body: pageShell({
      nonce,
      title: "EVE SSO",
      main: `<h1>${escapeHtml(heading)}</h1>\n<p>${escapeHtml(message)}</p>`,
      script: "",
    }),
  };
}

/**
 * The bind page: the code, what to do with it, and a poller.
 *
 * It names nothing from the request: not the application, scopes or client id.
 * Naming the application would be friendlier and also a phishing surface, since
 * `client_id` is attacker-chosen and a page that renders it can be made to say
 * anything above a prompt asking the player to act. The bind code already
 * disambiguates concurrent sign-ins.
 *
 * It does name `SLASH_COMMAND`, whole: the line the player copies is the line
 * the bind parser accepts, character for character. This is the half of the
 * instruction that can be wrong without anything failing loudly.
 */
function bindPage({ code, requestId, expiresInMs }) {
  const nonce = newNonce();
  const main = [
    "<h1>Sign in with your character</h1>",
    "<p>Switch to your running EVE client, to the character you want to sign in as, ",
    "and type this into chat:</p>",
    // The whole command, not the code alone. A player shown six characters and told
    // "type the code" types six characters; showing the line as the parser expects
    // it removes the step of remembering which command it belonged to.
    `<p class="code" id="command">${escapeHtml(SLASH_COMMAND)} ${escapeHtml(code)}</p>`,
    // The button copies the line above by reading it out of the DOM, which is why
    // the command is not repeated in a `data-` attribute. Two copies in one document
    // could disagree, and the failure would surface as a player certain they typed
    // what they were shown.
    `<div class="copyrow"><button type="button" id="copy" class="copy">${COPY_ICON}`,
    `<span id="copy-label" aria-live="polite">${escapeHtml(COPY_LABEL)}</span>`,
    "</button></div>",
    "<p>The command signs in whichever character sends it. ",
    "Leave this page open &mdash; it finishes on its own.</p>",
    `<p id="status" data-poll-url="${escapeHtml(BIND_STATUS_PATH)}"`,
    ` data-request-id="${escapeHtml(requestId)}"`,
    ` data-interval="${escapeHtml(POLL_INTERVAL_MS)}"`,
    ` data-expires-in="${escapeHtml(expiresInMs)}">`,
    "Waiting for the code to be entered in game.</p>",
    '<p class="fine">This page belongs to your private server, not to CCP. ',
    "It will never ask you for your EVE Online password.</p>",
  ].join("\n");

  return {
    status: 200,
    headers: pageHeaders(nonce),
    body: pageShell({ nonce, title: "Sign in with your character", main, script: PAGE_SCRIPT }),
  };
}

/** 16 bytes of CSP nonce. Fresh per response; a reused nonce is not a nonce. */
function newNonce() {
  return crypto.randomBytes(16).toString("base64url");
}

/**
 * 256 bits, base64url.
 *
 * The size is the security property: this value is the only thing between a
 * stranger and somebody else's in-flight sign-in, so it must not be enumerable
 * or derivable. It comes from `crypto.randomBytes`, not from the bind code,
 * client id or a counter.
 *
 * `randomBytes` is synchronous on the game's event loop, a few microseconds for
 * 32 bytes from an already-seeded pool; the async form would cost this route its
 * synchronous contract.
 */
function newRequestId() {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * The one answer for every request that does not name a live, approved sign-in.
 *
 * Built from a single frozen payload so the three no-information paths cannot
 * drift apart. `lib/bindCodes.js` does the same with its `UNKNOWN_INSPECTION`:
 * the property defended is byte identity, which holds between separately written
 * literals only until somebody edits one.
 */
const EXPIRED_PAYLOAD = Object.freeze({ status: POLL_STATUS.EXPIRED });

function expiredAnswer() {
  return jsonResponse(200, EXPIRED_PAYLOAD);
}

// The route

/**
 * Build the authorize route, with everything it talks to injected.
 *
 * @param {{
 *   clientRegistry: { check: Function },
 *   authCodes: { mint: Function },
 *   bindFlow: { mint: Function, peek: Function },
 *   devAutoApprove?: { enabled: boolean, characterID: number|null },
 *   now?: () => number,
 *   log?: (message: string) => void,
 * }} deps
 */
function createOauthAuthorizeRoute(deps = {}) {
  const { clientRegistry, authCodes, bindFlow, devAutoApprove, now, log } = deps;

  // Construction-time validation, as in `lib/ssoDispatch.js`: a table with a
  // mistake in it fails at boot naming the route, not on the one request that
  // reaches it, which here is a player mid-sign-in.
  requireMethod(clientRegistry, "clientRegistry", "check");
  requireMethod(authCodes, "authCodes", "mint");
  requireMethod(bindFlow, "bindFlow", "mint");
  requireMethod(bindFlow, "bindFlow", "peek");

  const clock = typeof now === "function" ? now : () => Date.now();
  const emit = typeof log === "function" ? log : () => {};

  const autoApprove = resolveAutoApprove(devAutoApprove, log);

  /**
   * The in-flight authorizations; see the file header.
   *
   * A `Map` rather than an object, as in `lib/ssoDispatch.js`: a map key is never
   * a prototype write, which should not depend on the generator staying honest.
   */
  const pending = new Map();

  /** Drop everything past its expiry. Called on the paths that touch the map. */
  function sweep() {
    const at = clock();
    for (const [id, entry] of pending) {
      if (entry.expiresAt <= at) pending.delete(id);
    }
  }

  // The authorize endpoint

  function handleAuthorize(request) {
    const method = String((request && request.method) || "GET").toUpperCase();
    if (method !== ALLOWED_METHOD) {
      const page = noticePage(
        405,
        "That is not how this page is reached",
        `The authorization endpoint answers ${ALLOWED_METHOD} requests only.`,
      );
      // The page's own headers, plus `Allow`. Spread from `page.headers` rather than
      // rebuilt, because rebuilding would mint a second CSP nonce, the one in the
      // document would stop matching the header, and the page would render blank. See
      // ALLOWED_METHOD for why `HEAD` is not on the list.
      return { ...page, headers: { ...page.headers, allow: ALLOWED_METHOD } };
    }

    // Stage 1: prove where "back" is, before anything else.
    //
    // Nothing below this block may be reordered above it. Every refusal here
    // renders; every refusal after it redirects.

    const redirectUri = readQuery(request, "redirect_uri");
    const shapeProblem = redirectUriProblem(redirectUri);
    if (shapeProblem !== null) {
      emit(`authorize refused before redirecting: ${shapeProblem}.`);
      return refuseAtSso();
    }

    const clientId = readQuery(request, "client_id");
    if (clientId === undefined || clientId === "" || clientId.length > MAX_CLIENT_ID_LENGTH) {
      // Bounded here rather than left to the registry, because this value is about to
      // appear in a log line and arrives from a query string somebody else wrote.
      emit("authorize refused before redirecting: client_id is missing or implausibly long.");
      return refuseAtSso();
    }

    const registered = clientRegistry.check({ clientId, redirectUri });
    if (!registered || registered.ok !== true) {
      // The operator's copy, with the registry's own sentence. The player's copy
      // says none of it. `JSON.stringify` on the client id because a newline in a log
      // line is an injection.
      const reason = (registered && registered.reason) || "no reason given";
      const detail = (registered && registered.detail) || "";
      emit(
        `authorize refused before redirecting for client ${JSON.stringify(clientId)}: `
        + `${reason}. ${detail}`.trim(),
      );
      return refuseAtSso();
    }

    // Stage 2: past here, an error goes back to the application.

    // Captured immediately, so every refusal below can echo it. `state` is read with
    // `hasOwnProperty`, so `?state=` is a present, empty state and `null` means none
    // was sent. RFC 6749 requires the parameter back only when it was sent, and
    // inventing an empty one would be a difference a strict client can see.
    const state = readQuery(request, "state");
    const stateValue = state === undefined ? null : state;

    const fail = (error, description) =>
      redirectResponse(buildRedirect(redirectUri, [
        ["error", error],
        ["error_description", description],
        ["state", stateValue],
      ]));

    const responseType = readQuery(request, "response_type");
    if (responseType === undefined || responseType === "") {
      return fail("invalid_request", "response_type is required.");
    }
    if (responseType !== RESPONSE_TYPE) {
      return fail(
        "unsupported_response_type",
        `This server implements response_type=${RESPONSE_TYPE} only. `
        + "The implicit flow is advertised in CCP's discovery document and is not implemented "
        + "here.",
      );
    }

    const scope = parseScope(readQuery(request, "scope"));
    if (scope.failure !== undefined) return fail("invalid_scope", scope.failure);

    const pkce = parsePkce(
      readQuery(request, "code_challenge"),
      readQuery(request, "code_challenge_method"),
    );
    if (pkce.failure !== undefined) return fail("invalid_request", pkce.failure);

    const grant = {
      clientId,
      redirectUri,
      scope: scope.scope,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
    };

    // Stage 3a: the dev branch, which skips only the human.

    if (autoApprove !== null) {
      // Everything above still ran: the client and redirect target were proved, the
      // scope was parsed, the PKCE pair was stored, and `state` is echoed below. Dev
      // auto-approve skips the player, not the protocol.
      emit(devAutoApproveWarning(clientId, autoApprove.characterID));

      const minted = authCodes.mint({ ...grant, characterId: autoApprove.characterID });
      if (!minted || typeof minted.code !== "string" || minted.code === "") {
        return fail("server_error", mintFailureText(minted));
      }
      return redirectResponse(buildRedirect(redirectUri, [
        ["code", minted.code],
        ["state", stateValue],
      ]));
    }

    // Stage 3b: the human.

    sweep();
    if (pending.size >= MAX_PENDING_REQUESTS) {
      // A live entry is never evicted to make room; see MAX_PENDING_REQUESTS.
      emit(
        `authorize is holding ${pending.size} unfinished sign-ins, which is its ceiling. `
        + "Refusing new ones until some expire.",
      );
      return fail(
        "temporarily_unavailable",
        "This server is already holding as many unfinished sign-ins as it will hold. "
        + "Try again in a few minutes.",
      );
    }

    const requestId = newRequestId();
    const bind = bindFlow.mint({ requestId });
    if (!bind || typeof bind.code !== "string" || bind.code === "") {
      const failure = (bind && bind.failure) || "no reason given";
      emit(`authorize could not mint a bind code: ${failure}`);
      return fail(
        "temporarily_unavailable",
        "This server could not start an in-game sign-in just now. Try again shortly.",
      );
    }

    const at = clock();
    const expiresAt = pendingExpiryFor(bind.expiresAt, at);
    pending.set(requestId, { ...grant, state: stateValue, expiresAt });

    return bindPage({ code: bind.code, requestId, expiresInMs: expiresAt - at });
  }

  // The poll endpoint (ours)

  function handleBindStatus(request) {
    const method = String((request && request.method) || "GET").toUpperCase();
    if (method !== ALLOWED_METHOD) {
      // JSON here and HTML on the other path: each refuses in the content type it
      // serves, so a caller's parser never has to guess.
      return jsonResponse(
        405,
        {
          error: "invalid_request",
          error_description: `This endpoint answers ${ALLOWED_METHOD} requests only.`,
        },
        { allow: ALLOWED_METHOD },
      );
    }

    // Every no-information path answers with the same bytes, and there is
    // deliberately no shape check in front of the lookup.
    //
    // A misshapen `request_id` could have been a `400` (it is a bug in the page this
    // server serves, not a state of anybody's sign-in), but answering it differently
    // would tell a caller their guess had the right shape. The bind store fixed the
    // same leak by moving its throttle ahead of its shape check, and asserts
    // `JSON.stringify` identity across six no-information paths; this holds the
    // line one layer up. Cost: a page bug shows up as "expired" rather than as an
    // error, with no log line, because logging on an unauthenticated poll is a flood
    // a caller controls.
    const requestId = readQuery(request, BIND_STATUS_QUERY_PARAM);

    sweep();
    const entry = requestId === undefined ? undefined : pending.get(requestId);
    if (entry === undefined) return expiredAnswer();

    // Only `state`, and below only `characterId`. The bind store's `inspect` carries
    // `characterID`, `accountID`, `role`, `isGM` and `claimedAt` on a claimed entry,
    // and the integration adapter narrows that to this interface, so this route
    // reads named fields and never builds a response by spreading it. An adapter
    // that forgets to strip a field still cannot publish one.
    const seen = bindFlow.peek(requestId);
    const state = (seen && seen.state) || "unknown";

    if (state === "pending") return jsonResponse(200, { status: POLL_STATUS.PENDING });

    if (state !== "approved") {
      // `expired`, `unknown`, or anything a future bind store invents. All mean this
      // sign-in is not going to complete.
      pending.delete(requestId);
      return expiredAnswer();
    }

    // Approved. The entry is consumed before the code is minted, so a second poll (a
    // retry, a duplicated fetch, a double-clicked page) cannot mint a second code
    // against the same authorization. The cost is that a response lost in transit
    // costs the player the sign-in and they start over; the alternative is a request
    // id that hands out authorization codes for as long as it lives, so failing
    // closed is not a close call.
    pending.delete(requestId);

    const characterId = seen.characterId;
    if (!Number.isInteger(characterId) || characterId <= 0) {
      emit(
        `bind ${JSON.stringify(requestId.slice(0, 8))}… was approved without a usable character `
        + "id, so no code was minted.",
      );
      return readyWithError(entry, "server_error", "The approved sign-in carried no character.");
    }

    const minted = authCodes.mint({
      clientId: entry.clientId,
      redirectUri: entry.redirectUri,
      scope: entry.scope,
      codeChallenge: entry.codeChallenge,
      codeChallengeMethod: entry.codeChallengeMethod,
      characterId,
    });

    if (!minted || typeof minted.code !== "string" || minted.code === "") {
      emit(`authorize could not mint an authorization code: ${mintFailureText(minted)}`);
      return readyWithError(entry, "server_error", mintFailureText(minted));
    }

    // The one answer that carries anything, and it is a URL the browser is about to
    // visit anyway. Not the character id, bind code, client id or scope.
    return jsonResponse(200, {
      status: POLL_STATUS.READY,
      redirect: buildRedirect(entry.redirectUri, [
        ["code", minted.code],
        ["state", entry.state],
      ]),
    });
  }

  /**
   * An OAuth error, delivered the only way the browser can deliver one at this
   * point: as a redirect it is told to follow.
   *
   * The page does not render an error of its own here; the party that needs to
   * know is the application, which only learns anything through its
   * `redirect_uri`.
   */
  function readyWithError(entry, error, description) {
    return jsonResponse(200, {
      status: POLL_STATUS.READY,
      redirect: buildRedirect(entry.redirectUri, [
        ["error", error],
        ["error_description", description],
        ["state", entry.state],
      ]),
    });
  }

  function handle(request) {
    // The dispatch exact-matches, so `pathname` is one of the two below. The default
    // is the authorize path so a test may call `handle` with an object literal that
    // omits it, as every other SSO route's tests do.
    const pathname = (request && request.pathname) || AUTHORIZE_PATH;
    if (pathname === BIND_STATUS_PATH) return handleBindStatus(request);
    return handleAuthorize(request);
  }

  return Object.freeze({
    name: "OauthAuthorize",
    // Two paths on one handler, as in `routes/oauthDiscovery.js`, except that here
    // they are two different endpoints rather than two spellings of one. They share
    // a route because they share the pending store, and a second module would have
    // to be handed that store, making the in-flight authorization writable from two
    // files.
    paths: Object.freeze([AUTHORIZE_PATH, BIND_STATUS_PATH]),
    handle,
  });
}

// Pieces the factory uses, kept out of its closure

/** Construction-time check with a message that says what to inject and why. */
function requireMethod(object, name, method) {
  if (!object || typeof object[method] !== "function") {
    throw new TypeError(
      `ESI mod: createOauthAuthorizeRoute needs ${name}.${method}(). It is injected rather `
      + "than required so this route does not depend on the module that provides it.",
    );
  }
}

/**
 * The runtime half of the dev auto-approve guard, resolved once at
 * construction.
 *
 * Resolved here rather than per request so the branch's condition is computed in
 * one place and the request path reads either a character id or `null`, with no
 * third state for a future edit to get wrong.
 *
 * `enabled === true`, strictly. A configuration layer that handed over the
 * string `"true"` from an environment variable must not turn this on, and a
 * truthiness test is how that happens.
 *
 * The enabled path throws rather than degrading, and only the enabled path
 * throws:
 *
 *   A truthy `enabled` that is not `true` is a coercion mistake. Going quiet
 *   would leave a CI pipeline hanging on a sign-in page nobody will complete,
 *   with nothing in the log. It can never make the feature more enabled, so
 *   throwing is free.
 *
 *   No character id: there is no "pick the first character" fallback, and there
 *   must not be one, because a dev convenience that guesses an identity will
 *   eventually guess somebody's.
 *
 *   No logger: the loud-on-every-use requirement cannot be met, and a silent dev
 *   auto-approve is what the feature must prevent. Refusing to construct is the
 *   only honest answer.
 *
 * The quiet path (absent, `false`, `null`, `undefined`) never throws and never
 * enables. That is the default configuration, and it cannot reach this branch.
 */
function resolveAutoApprove(devAutoApprove, log) {
  if (!devAutoApprove || devAutoApprove.enabled === undefined || devAutoApprove.enabled === null) {
    return null;
  }
  if (devAutoApprove.enabled === false || devAutoApprove.enabled === 0
    || devAutoApprove.enabled === "") {
    return null;
  }

  if (devAutoApprove.enabled !== true) {
    throw new TypeError(
      "ESI mod: devAutoApprove.enabled must be the boolean true to enable dev auto-approve, "
      + `got ${JSON.stringify(devAutoApprove.enabled)}. A truthy value from an environment `
      + "variable does not turn this on: it is a bypass of the only identity check this "
      + "server has (D3).",
    );
  }

  const characterID = devAutoApprove.characterID;
  if (!Number.isInteger(characterID) || characterID <= 0) {
    throw new TypeError(
      "ESI mod: devAutoApprove.enabled is true but devAutoApprove.characterID is "
      + `${JSON.stringify(characterID)}. Auto-approve issues tokens for one explicitly `
      + "configured character and has no fallback: a bypass that guesses whose identity to "
      + "hand out is worse than no bypass at all.",
    );
  }

  if (typeof log !== "function") {
    throw new TypeError(
      "ESI mod: devAutoApprove.enabled is true but no log function was injected. Every use "
      + "of the bypass has to be visible in the server's log, and a route that cannot "
      + "write one will not enable it.",
    );
  }

  return Object.freeze({ characterID });
}

/**
 * The line an operator finds in a log they did not expect to find it in.
 *
 * Unmistakable at a glance and greppable: it names the bypass, says a code was
 * issued, says no human was involved, and says what to do. It is emitted on
 * every use rather than once at startup, because a startup banner scrolls away
 * and the operator's question is "did this token come from a player?".
 *
 * `JSON.stringify` on the client id: it is attacker-chosen text on its way into
 * a log, and a raw newline would let a client forge log lines.
 */
function devAutoApproveWarning(clientId, characterID) {
  return "!! DEV AUTO-APPROVE !! /v2/oauth/authorize issued an authorization code for "
    + `character ${characterID} to client ${JSON.stringify(clientId)} with NO player `
    + "interaction and NO in-game bind code. This bypasses the only proof of identity this "
    + "server has. It is a test-only setting and must be off on any server another "
    + "person can reach.";
}

/**
 * A mint failure, as a sentence, without inventing detail the store did not give.
 *
 * `authCodes.mint` answers with a machine string (`at_capacity`, `collision`,
 * `generator`), so it is wrapped rather than emitted raw: an `error_description`
 * reading `at_capacity` sends a client author to look it up. The machine string
 * stays inside the sentence because it greps, and all three are operational facts
 * about this server rather than about the player.
 */
function mintFailureText(minted) {
  const failure = minted && minted.failure;
  const suffix = typeof failure === "string" && failure !== "" ? ` (${failure})` : "";
  return `This server could not issue an authorization code${suffix}.`;
}

/**
 * How long the pending entry lives.
 *
 * Normally the bind code's own expiry: the authorization must not outlive the
 * thing that completes it. `bindFlow.expiresAt` is read as epoch milliseconds,
 * the unit of `Date.now()` and `lib/requestClock.js`.
 *
 * When it is absent, unparseable, or already in the past (what a unit mismatch
 * looks like, seconds read as milliseconds landing in 1970), the fallback is this
 * route's own TTL rather than an immediate expiry. An immediate expiry renders
 * "expired" the instant the page loads for a live bind code, with nothing to
 * diagnose. With the fallback the flow works and the mismatch surfaces where it
 * is legible: a bind the store reports expired while the page is still waiting.
 */
function pendingExpiryFor(expiresAt, at) {
  const ceiling = at + PENDING_TTL_MS;
  if (!Number.isFinite(expiresAt) || expiresAt <= at) return ceiling;
  return Math.min(expiresAt, ceiling);
}

/**
 * A redirect, and nothing else.
 *
 * Bodiless on purpose: every browser and OAuth library follows the `Location`,
 * so a body would be read by nobody and would be a second copy of a URL carrying
 * a one-time code, where a proxy log or screenshot can keep it.
 *
 * No CORS header. This response is a navigation target, and a redirect carrying
 * an authorization code must not be readable by cross-origin script.
 */
function redirectResponse(location) {
  return {
    status: REDIRECT_STATUS,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
    body: "",
  };
}

/**
 * The poll's answers.
 *
 * `no-store` because the poll's answer changes, and a cached `pending` is a page
 * that waits forever.
 *
 * No `Access-Control-Allow-Origin`. The page that reads this is same-origin and
 * needs none; adding one would make an endpoint that returns a URL containing an
 * authorization code readable by any page that learned a request id.
 */
function jsonResponse(status, payload, extraHeaders = {}) {
  return {
    status,
    headers: {
      "content-type": CONTENT_TYPE_JSON,
      "cache-control": "no-store",
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  };
}

/**
 * The refusal that never redirects. One sentence, the same every time.
 *
 * A `400`: the request is malformed in that its declared way back is not one
 * this server will use. Not a `403` (nothing here concerns the player's
 * permissions) and not a `302`.
 */
function refuseAtSso() {
  return noticePage(
    400,
    "This sign-in cannot continue",
    "The application that sent you here is not registered with this server, or it asked to "
    + "be sent back to an address that is not registered for it. For safety, nothing was "
    + "sent back to it. Ask whoever runs this server to check the application's "
    + "registration.",
  );
}

module.exports = Object.freeze({
  ALLOWED_METHOD,
  AUTHORIZE_PATH,
  BIND_STATUS_PATH,
  BIND_STATUS_QUERY_PARAM,
  CODE_CHALLENGE_METHOD,
  CODE_CHALLENGE_PATTERN,
  CONTENT_TYPE_HTML,
  CONTENT_TYPE_JSON,
  COPY_LABEL,
  MAX_CLIENT_ID_LENGTH,
  MAX_PENDING_REQUESTS,
  MAX_REDIRECT_URI_LENGTH,
  PENDING_TTL_MS,
  POLL_INTERVAL_MS,
  POLL_STATUS,
  REDIRECT_STATUS,
  RESPONSE_TYPE,
  SCOPE_LIMITS,
  SLASH_COMMAND,
  buildRedirect,
  createOauthAuthorizeRoute,
  escapeHtml,
  parsePkce,
  parseScope,
  redirectUriProblem,
});
