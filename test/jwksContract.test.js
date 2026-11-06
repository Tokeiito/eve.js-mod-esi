/**
 * `GET /oauth/jwks`: the contract.
 *
 * Run with:  node --test test/jwksContract.test.js
 *
 * Two sources, and every assertion names which one it makes a claim from (D23):
 *
 *   - `contract/sso.js`: the path, the literal `kid`, the algorithm, both
 *     member orders and the .NET-ism. Those are the document.
 *   - `routes/oauthJwks.js` itself: the status, the methods, the `Allow` value,
 *     the `content-type` spelling and every cache header. `contract/sso.js`
 *     `UNOBSERVED` records that no response header has been captured off
 *     `login.eveonline.com`, so these are choices. The assertions check that
 *     the choices are the documented ones, not that CCP makes them.
 *
 * There is no listener. The route is driven directly with a fake request and a
 * fixture `getJwks`: no socket, no `lib/ssoDispatch.js`, no `lib/signingKey.js`.
 *
 * The acceptance criterion is that a standard JWT library fetches this document
 * and verifies a token we minted with no special configuration. There is no
 * `jose` in this repository (D5/D20), so the last test does the same with
 * `node:crypto`: generate an RSA key, export its JWK, serve it through the
 * route, parse the served bytes, and feed the published JWK back through
 * `crypto.createPublicKey({ key, format: "jwk" })` to verify an RS256
 * signature made with the private half. What that proves and what it cannot is
 * written on the test.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const sso = require(path.join(__dirname, "../contract/sso"));
const wire = require(path.join(__dirname, "../contract/wire"));
const { titleCase } = require(path.join(__dirname, "../lib/headers"));
const {
  ALG,
  ALLOW,
  ALLOWED_METHODS,
  CACHE_CONTROL,
  CACHE_TTL_SECONDS,
  CONTENT_TYPE,
  KEYS_MEMBER,
  KEY_MEMBER_ORDER,
  KEY_TYPE,
  KEY_USE,
  KID,
  MEMBER_ORDER,
  PATH,
  SKIP_UNRESOLVED_MEMBER,
  SKIP_UNRESOLVED_VALUE,
  createOauthJwksRoute,
  findKeySetProblems,
} = require(path.join(__dirname, "../routes/oauthJwks"));

// Fixtures

/**
 * A modulus-shaped string. Not a real key: every test above the acceptance
 * one is about the document, and a document does not care whether its `n`
 * factors. The acceptance test generates a real key.
 */
const N_ACTIVE = "sYX0nGm4rQ7fJd2vB9pC1xH3kL5nP8tR0wZ6yA4bE7iO2uM9qS3dF6gJ1lN4hK8c";
const N_SECOND = "0aB9cD8eF7gH6iJ5kL4mN3oP2qR1sT0uV9wX8yZ7aB6cD5eF4gH3iJ2kL1mN0oP";

/**
 * One key, with its members written in an order that is not the served one.
 *
 * A fixture already in `KEY_MEMBER_ORDER` would let a route that forwarded
 * whatever object it was handed pass the byte comparison below, which is the
 * one thing that test exists to catch.
 */
const activeKey = () => ({
  n: N_ACTIVE,
  use: KEY_USE,
  kty: KEY_TYPE,
  kid: KID,
  e: "AQAB",
  alg: ALG,
});

/** A second key, for the rotation shape. Also scrambled, differently. */
const secondKey = () => ({
  kty: KEY_TYPE,
  alg: ALG,
  n: N_SECOND,
  kid: "JWT-Signature-Key-2",
  e: "AQAB",
  use: KEY_USE,
});

/** Drive the route directly. `keys` is what the fixture `getJwks` returns. */
function serve(request = {}, keys = [activeKey()]) {
  const route = createOauthJwksRoute({ getJwks: () => keys });
  return route.handle({ method: "GET", pathname: PATH, query: {}, headers: {}, ...request });
}

/**
 * The same, with no default for `keys`, so `undefined` reaches the route as
 * `undefined`. The malformed-key cases below need that distinction and
 * `serve`'s default would swallow it.
 */
function serveExact(keys) {
  const route = createOauthJwksRoute({ getJwks: () => keys });
  return route.handle({ method: "GET", pathname: PATH, query: {}, headers: {} });
}

/** The served document, parsed. For the assertions that are about values. */
function servedDocument(keys) {
  return JSON.parse(serve({ method: "GET" }, keys).body);
}

/** Case-insensitive header read from a response. */
function header(response, name) {
  const entry = Object.entries(response.headers || {}).find(
    ([key]) => key.toLowerCase() === name,
  );
  return entry === undefined ? undefined : entry[1];
}

// The deployable copy of the contract

test("the route's constants are contract/sso.js's, value for value", () => {
  // `routes/` is deployed and `contract/` is not (`lib/sourceHash.js`
  // `HASHED_DIRS` is `["lib", "routes"]`, and `scripts/deploy-mod.js` copies
  // exactly that manifest), so a route requiring `../contract/sso` would work
  // in this suite and throw MODULE_NOT_FOUND inside the game process.
  // `lib/cors.js`, `lib/headers.js` and `lib/serialize.js` duplicate their
  // contract constants for the same reason and are checked the same way.
  assert.equal(PATH, sso.JWKS_PATH);
  assert.equal(KID, sso.JWKS_KID);
  assert.equal(ALG, sso.JWKS_ALG);
  assert.deepEqual([...KEY_MEMBER_ORDER], [...sso.JWKS_KEY_MEMBER_ORDER]);
  assert.deepEqual([...MEMBER_ORDER], [...sso.JWKS_MEMBER_ORDER]);
  assert.equal(SKIP_UNRESOLVED_MEMBER, sso.JWKS_SKIP_UNRESOLVED_MEMBER);
  assert.equal(SKIP_UNRESOLVED_VALUE, sso.JWKS_SKIP_UNRESOLVED_VALUE);
  assert.equal(KEY_TYPE, sso.JWKS_KEY_CONSTANTS.kty);
  assert.equal(KEY_USE, sso.JWKS_KEY_CONSTANTS.use);
  assert.equal(KEYS_MEMBER, sso.JWKS_MEMBER_ORDER[0]);

  // And the two halves cover the key exactly: the constant members plus the
  // material ones are the served member list, nothing missing, nothing extra.
  assert.deepEqual(
    [...KEY_MEMBER_ORDER].sort(),
    [...Object.keys(sso.JWKS_KEY_CONSTANTS), ...sso.JWKS_KEY_MATERIAL_MEMBERS].sort(),
  );
});

// Three CCP quirks

test("quirk 1: the kid is the literal JWT-Signature-Key", () => {
  const [published] = servedDocument().keys;

  assert.equal(published.kid, "JWT-Signature-Key");
  assert.equal(published.kid, sso.JWKS_KID);

  // Spelled out because the failure this guards is a `kid` that is valid: an
  // RFC 7638 thumbprint is what a JOSE library computes for you, and it is
  // correct everywhere except here.
  assert.doesNotMatch(published.kid, /^[A-Za-z0-9_-]{43}$/, "not a base64url SHA-256 thumbprint");
  assert.doesNotMatch(
    published.kid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "not a UUID",
  );

  // And a document that does not carry it anywhere is refused rather than
  // served: a pinned validator reads it as a document with no keys at all.
  const renamed = { ...activeKey(), kid: "some-thumbprint" };
  const refusal = serve({ method: "GET" }, [renamed]);
  assert.equal(refusal.status, 500);
  assert.match(JSON.parse(refusal.body).error_description, /JWT-Signature-Key/);
});

test("quirk 2: SkipUnresolvedJsonWebKeys survives, as the boolean true", () => {
  const response = serve({ method: "GET" });
  const document = JSON.parse(response.body);

  assert.equal(document[SKIP_UNRESOLVED_MEMBER], true);
  assert.equal(typeof document[SKIP_UNRESOLVED_MEMBER], "boolean", "not the string \"true\"");

  // In the bytes, with CCP's capitalisation, which matters here as `Etag` does
  // on the ESI side. A parsed object could not tell `true` from `"true"` apart
  // from the typeof above, and only the string can show the member name was not
  // tidied to snake_case on the way out.
  assert.ok(
    response.body.includes('"SkipUnresolvedJsonWebKeys":true'),
    "the .NET-ism, verbatim, in the served bytes",
  );

  // This is the most defensible cleanup in the document, and removing it breaks
  // exactly the clients that replay a fixture recorded from CCP.
  assert.equal(Object.keys(document).length, 2, "keys, and the artefact, nothing else");
});

test("quirk 3: RS256 only, and CCP's second key is not published", () => {
  const document = servedDocument();

  assert.equal(document.keys.length, 1);
  assert.equal(document.keys[0].alg, "RS256");
  assert.equal(document.keys[0].kty, "RSA");
  assert.equal(document.keys[0].use, "sig");

  // CCP publishes an ES256 key alongside and signs with RS256. We do not, and
  // the difference is data rather than prose: nothing we serve carries any of
  // the algorithms `contract/sso.js` records as CCP's extras.
  for (const alg of sso.JWKS_CCP_EXTRA_ALGS) {
    assert.ok(
      !document.keys.some((key) => key.alg === alg),
      `${alg} is CCP's and deliberately not ours`,
    );
  }

  // The narrowing is safe for a client selecting by `kid` or by `alg`, which is
  // every client in the ecosystem survey, and is not safe for anything walking
  // to index 1. Nothing observed does that, so this asserts only that both
  // selectors resolve.
  assert.ok(document.keys.find((key) => key.kid === KID), "selects by kid");
  assert.ok(document.keys.find((key) => key.alg === ALG), "selects by alg");

  // A key that is not RS256 is refused rather than filtered. Silently dropping
  // a key an operator published leaves no trace anywhere.
  const es256 = { ...activeKey(), alg: "ES256" };
  const refusal = serve({ method: "GET" }, [es256]);
  assert.equal(refusal.status, 500);
  assert.match(JSON.parse(refusal.body).error_description, /"ES256"/);
});

// The bytes

test("the served bytes carry the observed member order, top level and per key", () => {
  const body = serve({ method: "GET" }).body;

  // The whole document, exactly. Asserted against the string and not a parsed
  // object, because `JSON.parse` discards member order, so a test that parsed
  // first would pass on bytes no fixture-comparing client would accept.
  assert.equal(
    body,
    '{"keys":[{"alg":"RS256","e":"AQAB","kid":"JWT-Signature-Key","kty":"RSA","use":"sig",'
      + `"n":"${N_ACTIVE}"}],"SkipUnresolvedJsonWebKeys":true}`,
  );

  // Derived from the contract as well as written out, so the literal above
  // cannot quietly stop meaning what `contract/sso.js` says.
  const keyMembers = [...body.matchAll(/"(alg|e|kid|kty|use|n)":/g)].map((match) => match[1]);
  assert.deepEqual(keyMembers, [...sso.JWKS_KEY_MEMBER_ORDER]);
  assert.ok(
    body.indexOf(`"${sso.JWKS_MEMBER_ORDER[0]}"`)
      < body.indexOf(`"${sso.JWKS_MEMBER_ORDER[1]}"`),
    "the .NET-ism comes second, which is what was observed",
  );

  // Ours, and marked as ours: `contract/sso.js` `UNOBSERVED.trailingNewline`
  // says nobody has read a content-length off login.eveonline.com. The newline
  // in `lib/serialize.js` belongs to ESI's Go gateway.
  assert.notEqual(body[body.length - 1], "\n");

  // Compact separators, no space after `:` or `,`. Same standing: unobserved,
  // and JSON.stringify's default.
  assert.ok(!/[:,] /.test(body), "no pretty-printing");
});

test("the array shape holds for two keys, in the order getJwks returned them", () => {
  const response = serve({ method: "GET" }, [activeKey(), secondKey()]);
  const document = JSON.parse(response.body);

  assert.equal(document.keys.length, 2);
  assert.deepEqual(document.keys.map((key) => key.kid), [KID, "JWT-Signature-Key-2"]);
  assert.deepEqual(document.keys.map((key) => key.n), [N_ACTIVE, N_SECOND]);

  // The order is `getJwks`'s (active key first) and is not sorted, deduplicated
  // or otherwise changed on the way through.
  assert.ok(
    response.body.indexOf(N_ACTIVE) < response.body.indexOf(N_SECOND),
    "in the bytes too, not just in the parse",
  );

  // Member order holds per key, not only on the first one.
  for (const key of document.keys) {
    assert.deepEqual(Object.keys(key), [...sso.JWKS_KEY_MEMBER_ORDER]);
  }

  // And the artefact is still the last member with two keys in front of it.
  assert.ok(response.body.endsWith('"SkipUnresolvedJsonWebKeys":true}'));
});

// The path

test("the path is /oauth/jwks, and not under /v2/", () => {
  const route = createOauthJwksRoute({ getJwks: () => [activeKey()] });

  assert.deepEqual([...route.paths], ["/oauth/jwks"]);
  assert.deepEqual([...route.paths], [sso.JWKS_PATH]);

  // `contract/sso.js` names the hazard: a route table written by pattern ("the
  // SSO endpoints are /v2/oauth/*") mounts this one at /v2/oauth/jwks while the
  // discovery document keeps advertising /oauth/jwks, and nothing fails until a
  // client verifies a signature. Checked against ESI's own prefix list so a
  // prefix added there cannot creep in here.
  for (const prefix of wire.VERSION_PREFIXES) {
    for (const mounted of route.paths) {
      assert.ok(!mounted.startsWith(`/${prefix}/`), `not under /${prefix}/`);
    }
  }

  // One spelling. The discovery document is served at two because the EVE
  // client was observed asking for the trailing-slash form; there is no such
  // observation here, and a second spelling would be an invented one.
  assert.equal(route.paths.length, 1);

  // And the discovery document's `jwks_uri` points at exactly this string, a
  // defect neither half's own tests would notice.
  assert.equal(sso.DISCOVERY_ENDPOINT_PATHS.jwks, route.paths[0]);

  assert.ok(Object.isFrozen(route), "the route object is frozen");
  assert.ok(Object.isFrozen(route.paths));
});

// Methods (ours, nothing observed)

test("GET is answered, and it is the endpoint", () => {
  const response = serve({ method: "GET" });

  assert.equal(response.status, 200);
  assert.equal(header(response, "content-type"), "application/json");
  assert.equal(CONTENT_TYPE, "application/json");
  assert.equal(typeof response.body, "string", "the route hands over bytes, not a value");
});

test("HEAD is answered like GET, body included, so content-length stays honest", () => {
  const get = serve({ method: "GET" });
  const head = serve({ method: "HEAD" });

  assert.equal(head.status, get.status);
  assert.deepEqual(head.headers, get.headers);
  // Node's ServerResponse suppresses the body for a HEAD request by itself. A
  // route that blanked it here would have to correct content-length by hand,
  // and a content-length that disagrees with the bytes is a framing bug no
  // client recovers from.
  assert.equal(head.body, get.body);
});

test("OPTIONS is a 204 that advertises what the route actually answers", () => {
  const response = serve({
    method: "OPTIONS",
    headers: { "access-control-request-method": "GET" },
  });

  assert.equal(response.status, 204);
  assert.equal(response.body, "");
  assert.equal(header(response, "access-control-allow-methods"), "GET, HEAD, OPTIONS");
  assert.equal(header(response, "access-control-allow-origin"), "*");
  assert.equal(header(response, "access-control-max-age"), "86400");
  assert.equal(header(response, "vary"), "Access-Control-Request-Headers");
  assert.equal(header(response, "allow"), ALLOW);

  // The echo quirk, borrowed from `lib/cors.js`: whatever the client asked for
  // comes straight back, `*` when it asked for nothing.
  assert.equal(header(response, "access-control-allow-headers"), "*");
  const echoed = serve({
    method: "OPTIONS",
    headers: {
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization, x-thing",
    },
  });
  assert.equal(header(echoed, "access-control-allow-headers"), "authorization, x-thing");

  // Unlike ESI, an OPTIONS with no preflight trigger gets the same answer.
  // ESI's split into "preflight" and "ordinary OPTIONS" reproduces observed CCP
  // behaviour; nothing has been observed here, so one answer serves both.
  const bare = serve({ method: "OPTIONS" });
  assert.equal(bare.status, 204);
  assert.equal(header(bare, "access-control-allow-methods"), ALLOW);
});

test("every other method is a 405 that says which three work", () => {
  assert.deepEqual([...ALLOWED_METHODS], ["GET", "HEAD", "OPTIONS"]);
  assert.equal(ALLOW, "GET, HEAD, OPTIONS");

  for (const method of ["POST", "PUT", "DELETE", "PATCH", "TRACE"]) {
    const response = serve({ method });

    assert.equal(response.status, 405, `${method} is refused`);
    // One comma-joined line, RFC 9110's spelling, not `lib/errors.js`'s repeated
    // `Allow` lines, which reproduce CCP's ESI and do not reach this origin. Ours,
    // per D23.
    assert.equal(header(response, "allow"), "GET, HEAD, OPTIONS");
    assert.equal(typeof header(response, "allow"), "string", "one line, not an array");

    const body = JSON.parse(response.body);
    assert.equal(body.error, "invalid_request");
    assert.match(body.error_description, new RegExp(method));
    assert.equal(header(response, "cache-control"), "no-store", "a refusal is not cached");
  }

  // Lowercase method spellings are normalised rather than refused, which keeps
  // a hand-written client off a 405 it would not understand.
  assert.equal(serve({ method: "get" }).status, 200);
});

// CORS and cache (ours, nothing observed)

test("the 200 is CORS-open, and every response is", () => {
  assert.equal(header(serve({ method: "GET" }), "access-control-allow-origin"), "*");
  assert.equal(header(serve({ method: "POST" }), "access-control-allow-origin"), "*");
  assert.equal(header(serve({ method: "GET" }, []), "access-control-allow-origin"), "*");

  // `Access-Control-Allow-Credentials` is never sent: `*` and credentials mode
  // are mutually exclusive and a browser rejects the pair outright. The same
  // hazard `lib/cors.js` documents; "it is an auth endpoint" is the reasoning
  // that would add it.
  assert.equal(header(serve({ method: "GET" }), "access-control-allow-credentials"), undefined);

  // `Access-Control-Allow-Origin` is unconditional, so there is nothing to vary
  // on and no `Vary: Origin`.
  assert.equal(header(serve({ method: "GET", headers: { origin: "https://a" } }), "vary"), undefined);
  assert.equal(
    header(serve({ method: "GET" }), "access-control-allow-origin"),
    header(serve({ method: "GET", headers: { origin: "https://a" } }), "access-control-allow-origin"),
  );

  // Unauthenticated. Nothing in the request influences the document, so a token
  // cannot change it and its absence cannot refuse it.
  assert.equal(sso.SERVING[sso.JWKS_PATH].authenticated, false);
  assert.equal(sso.SERVING[sso.JWKS_PATH].cors, true);
  assert.equal(
    serve({ method: "GET", headers: { authorization: "Bearer nonsense" } }).body,
    serve({ method: "GET" }).body,
  );
});

test("the document is cacheable, for five minutes, with no validator", () => {
  const response = serve({ method: "GET" });

  // The endpoint is cacheable but no number is specified; `contract/sso.js`
  // `UNOBSERVED.cacheHeaders` records that nobody has read one off CCP. So this
  // asserts the choice the route documents, not CCP's bytes.
  assert.equal(sso.SERVING[sso.JWKS_PATH].cacheable, true);
  assert.equal(header(response, "cache-control"), "public, max-age=300");
  assert.equal(CACHE_CONTROL, `public, max-age=${CACHE_TTL_SECONDS}`);

  // The bound that made 300 the number: an access token lives 20 minutes, so a
  // key change that leaves the old key published for 20 minutes plus this
  // max-age is one no client can observe. If either number moves, the other has
  // to be reconsidered.
  assert.ok(CACHE_TTL_SECONDS > 0, "not no-store: a validator would refetch per token");
  assert.ok(CACHE_TTL_SECONDS <= 300, "not long enough to outlive a key change unnoticed");

  // No validator, deliberately: an `Etag` invites `If-None-Match`, nothing on
  // this listener answers one with a 304, and D6 keeps `lib/cache.js` off SSO
  // traffic on purpose.
  assert.equal(header(response, "etag"), undefined);
  assert.equal(header(response, "last-modified"), undefined);
  // `Expires` is HTTP/1.0's spelling of what `Cache-Control` already says.
  assert.equal(header(response, "expires"), undefined);

  // Nothing from the ESI pipeline leaked onto this response.
  for (const name of ["x-esi-request-id", "x-esi-cache-status", "x-pages", "x-compatibility-date"]) {
    assert.equal(header(response, name), undefined, `${name} is ESI's, not this listener's`);
  }
});

test("every header name this route writes survives lib/headers.js as CCP would spell it", () => {
  // The route writes lowercase, this codebase's internal spelling everywhere,
  // and `withCcpCasing` is the single place a name becomes wire casing. This
  // checks that the rule produces something sane for each of them, so the
  // listener applying it on the way out is all that is needed.
  const expected = {
    "content-type": "Content-Type",
    "cache-control": "Cache-Control",
    "access-control-allow-origin": "Access-Control-Allow-Origin",
    "access-control-allow-methods": "Access-Control-Allow-Methods",
    "access-control-allow-headers": "Access-Control-Allow-Headers",
    "access-control-max-age": "Access-Control-Max-Age",
    allow: "Allow",
    vary: "Vary",
  };

  const written = new Set();
  for (const method of ["GET", "OPTIONS", "POST"]) {
    for (const name of Object.keys(serve({ method }).headers)) written.add(name);
  }

  for (const name of written) {
    assert.equal(name, name.toLowerCase(), `${name} is written lowercase`);
    assert.ok(expected[name] !== undefined, `${name} is accounted for here`);
    assert.equal(titleCase(name), expected[name]);
  }
});

// An unusable key set (ours: a 500, and it says why)

test("an empty key set is a 500, not a 200 advertising nothing", () => {
  const response = serve({ method: "GET" }, []);

  // The alternative was a 200 with `"keys":[]`, a well-formed JWKS meaning
  // "nothing here can be verified". It was rejected because it is
  // indistinguishable from health: every uptime probe goes green while no token
  // can be verified. The 500 appears in the one place an operator already looks.
  assert.equal(response.status, 500);

  const body = JSON.parse(response.body);
  assert.equal(body.error, "server_error");
  assert.match(body.error_description, /no keys/);
  assert.ok(!response.body.includes('"keys":[]'), "not served as an empty but valid document");
});

test("a malformed key is a 500 that names the key and the member", () => {
  const cases = [
    [[{ ...activeKey(), n: undefined }], /keys\[0\].*"n".*undefined/s],
    [[{ ...activeKey(), n: "" }], /keys\[0\].*"n".*empty string/s],
    [[{ ...activeKey(), e: 65537 }], /keys\[0\].*"e".*number/s],
    [[{ ...activeKey(), kty: "EC" }], /keys\[0\].*"kty".*"EC"/s],
    [[{ ...activeKey(), use: "enc" }], /keys\[0\].*"use".*"enc"/s],
    [[null], /keys\[0\] is null/],
    [[activeKey(), "not-a-key"], /keys\[1\] is the string/],
    ["not-an-array", /must be an array/],
    [undefined, /must be an array/],
  ];

  for (const [keys, pattern] of cases) {
    const response = serveExact(keys);
    assert.equal(response.status, 500, `${JSON.stringify(keys)} is refused`);
    assert.match(JSON.parse(response.body).error_description, pattern);
  }

  // A missing member is not left to JSON.stringify: it drops an `undefined`
  // value silently, so an unchecked route would serve a valid-looking five-member
  // JWK and the failure would surface inside a third party's JOSE library as
  // something opaque about key import. `lib/serialize.js` applies the same rule
  // to a projection returning undefined, on the one surface that cannot use
  // `projection()`: `SkipUnresolvedJsonWebKeys` is not snake_case and
  // `projection()` refuses it, correctly.
  assert.equal(JSON.stringify({ n: undefined }), "{}");
});

test("every problem in a key set is reported, not just the first", () => {
  const broken = { ...activeKey(), n: undefined, e: undefined, alg: "ES256" };
  const problems = findKeySetProblems([broken]);

  assert.ok(problems.length >= 3, "one restart tells an operator everything");
  assert.ok(problems.some((line) => line.includes('"n"')));
  assert.ok(problems.some((line) => line.includes('"e"')));
  assert.ok(problems.some((line) => line.includes("ES256")));

  // And a publishable set has nothing to say.
  assert.deepEqual(findKeySetProblems([activeKey()]), []);
  assert.deepEqual(findKeySetProblems([activeKey(), secondKey()]), []);
});

test("the factory refuses to be built without getJwks", () => {
  // At construction, the way `createRouter` and `projection()` validate: a
  // route wired up wrongly should fail at server start with the reason, not on
  // the one request that reaches it.
  assert.throws(() => createOauthJwksRoute(), /getJwks/);
  assert.throws(() => createOauthJwksRoute({}), /getJwks/);
  assert.throws(() => createOauthJwksRoute({ getJwks: [activeKey()] }), /getJwks/);
});

test("getJwks is read per request, so a rotation does not need a restart", () => {
  let keys = [activeKey()];
  const route = createOauthJwksRoute({ getJwks: () => keys });

  assert.equal(JSON.parse(route.handle({ method: "GET" }).body).keys.length, 1);
  keys = [activeKey(), secondKey()];
  assert.equal(JSON.parse(route.handle({ method: "GET" }).body).keys.length, 2);
});

// Acceptance, as far as node:crypto reaches

test("a token minted with the private half verifies against the published JWK", () => {
  // This stands in for "a standard JWT library (jose, python-jose,
  // jsonwebtoken) fetches this document and verifies a token we minted, with no
  // special configuration". There is no jose here (D5/D20), so this is the same
  // journey through the standard library, and
  // `crypto.createPublicKey({ key, format: "jwk" })` is what every one of those
  // libraries does underneath.
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { n, e } = publicKey.export({ format: "jwk" });

  // The key exactly as the signing-key module hands it over: six public string
  // members, and nothing private anywhere near this route.
  const jwk = { alg: ALG, e, kid: KID, kty: KEY_TYPE, use: KEY_USE, n };

  // Mint an RS256 JWS compact serialization, with the kid in the header as the
  // token minter does. `crypto.sign` with an RSA key is RSASSA-PKCS1-v1_5, which
  // is what RS256 means.
  const b64 = (value) => Buffer.from(value).toString("base64url");
  const tokenHeader = b64(JSON.stringify({ alg: ALG, typ: "JWT", kid: KID }));
  const claims = b64(
    JSON.stringify({
      iss: "http://host.local:26006",
      sub: "CHARACTER:EVE:90000001",
      azp: "evejs-mod-esi-test",
      exp: Math.floor(Date.now() / 1000) + 1200,
    }),
  );
  const signingInput = `${tokenHeader}.${claims}`;
  const signature = crypto.sign("sha256", Buffer.from(signingInput), privateKey);
  const token = `${signingInput}.${signature.toString("base64url")}`;

  // Now be the third party: fetch the document, parse the served bytes, and
  // resolve the key by the `kid` in the token header. Nothing here knows the
  // key it is about to import.
  const document = JSON.parse(serve({ method: "GET" }, [jwk]).body);

  const [rawHeader, , rawSignature] = token.split(".");
  const parsedHeader = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8"));
  const published = document.keys.find((key) => key.kid === parsedHeader.kid);

  assert.ok(published, "the kid in the token header resolves in the published set");
  assert.equal(published.alg, parsedHeader.alg);

  const imported = crypto.createPublicKey({ key: published, format: "jwk" });
  assert.ok(
    crypto.verify(
      "sha256",
      Buffer.from(signingInput),
      imported,
      Buffer.from(rawSignature, "base64url"),
    ),
    "the published key verifies the signature",
  );

  // The negative, so the assertion above cannot be vacuous: the same key must
  // refuse a token whose payload was altered after signing.
  const tampered = `${tokenHeader}.${b64(JSON.stringify({ sub: "CHARACTER:EVE:90000002" }))}`;
  assert.equal(
    crypto.verify(
      "sha256",
      Buffer.from(tampered),
      imported,
      Buffer.from(rawSignature, "base64url"),
    ),
    false,
  );

  // Import survives the extra members. `alg`, `kid` and `use` are not part of
  // an RSA public key and a strict importer could reject them; this checks that
  // the document we publish is one Node takes as-is, since "no special
  // configuration" is the requirement.
  assert.deepEqual(Object.keys(published), [...KEY_MEMBER_ORDER]);
  assert.equal(imported.asymmetricKeyType, "rsa");

  // What this does not prove: that `jose`, `python-jose` or `jsonwebtoken`
  // accept the document. Each has its own fetch, its own content-type
  // expectations and its own key-selection rules, and none can be installed here
  // (D5/D20). The `content-type`, the `Cache-Control` and the absence of an
  // `Etag` are unverified against a real library; that is a `curl` and a scratch
  // script away, and belongs to an acceptance run rather than this suite.
});

test("the route mounts on lib/ssoDispatch.js and answers at its one path", () => {
  // The one place this file touches another module: the route contract is
  // `{ paths, handle }` and a mismatch would otherwise only surface when the
  // listener came up. Still no socket.
  const { createSsoDispatch } = require(path.join(__dirname, "../lib/ssoDispatch"));

  const route = createOauthJwksRoute({ getJwks: () => [activeKey()] });
  const dispatch = createSsoDispatch([route]);

  return Promise.all([
    dispatch({ method: "GET", pathname: PATH, headers: {} }).then((response) => {
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).keys[0].kid, KID);
    }),
    // Not under /v2/, proved through the dispatch that exact-matches.
    dispatch({ method: "GET", pathname: "/v2/oauth/jwks", headers: {} }).then((response) => {
      assert.equal(response.status, 404);
    }),
    dispatch({ method: "GET", pathname: `${PATH}/`, headers: {} }).then((response) => {
      assert.equal(response.status, 404, "one spelling, and the dispatch does not invent a second");
    }),
  ]);
});
