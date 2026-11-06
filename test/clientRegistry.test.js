/**
 * Client registry tests.
 *
 * Run with:  node --test "test/**\/*.test.js"   (from the mod directory, or RunTests.bat)
 *
 * The module is pure (no clock, no randomness, no filesystem), so every case is
 * a literal in and a literal out.
 *
 * Most of the file is near-misses. A registry is only as good as the strings it
 * refuses: a bad `redirect_uri` is never reported by redirecting, so the only
 * way to get a redirect out of the authorize endpoint is to get `check` to say
 * yes, and each case is a string a helpful implementation would have accepted.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ANY_CLIENT_ID,
  ClientRegistryError,
  MAX_CLIENT_ID_LENGTH,
  MAX_CLIENT_SECRET_LENGTH,
  MIN_CLIENT_SECRET_LENGTH,
  REASON,
  VIA,
  createClientRegistry,
  isLoopbackHostname,
} = require("../lib/clientRegistry");

const CLIENT = "1a2b3c4d5e6f7g8h9i0j";
const LISTED = "http://host.local:8080/sso/callback";

function registryWith(clients, options = {}) {
  return createClientRegistry({ clients, ...options });
}

/** The common case: one client, one exactly-listed URI. */
function listedRegistry(options = {}) {
  return registryWith([{ clientId: CLIENT, redirectUris: [LISTED] }], options);
}

function check(registry, redirectUri, clientId = CLIENT) {
  return registry.check({ clientId, redirectUri });
}

// The allowlist, and what exact means

test("an exactly listed redirect URI is permitted, and says which gate let it through", () => {
  const result = check(listedRegistry(), LISTED);
  assert.deepEqual({ ...result }, { ok: true, via: VIA.ALLOWLIST });
});

test("every near-miss of a listed URI is refused rather than helpfully normalised", () => {
  const registry = listedRegistry();

  const nearMisses = [
    // A trailing slash: the most common "surely this is the same URI", and the one
    // an operator is most likely to have got wrong in either file.
    "http://host.local:8080/sso/callback/",
    // The other direction, for a listed URI that did have one.
    "http://host.local:8080/sso/callbac",
    // An added query. The whole URI is compared, including the query, because an
    // appended parameter is how a redirect gets aimed somewhere else.
    "http://host.local:8080/sso/callback?next=http://evil.test/",
    "http://host.local:8080/sso/callback?",
    // Case. A URL path is case-sensitive and the host is not, and folding either
    // here would be this module having an opinion about which.
    "http://host.local:8080/sso/Callback",
    "http://HOST.local:8080/sso/callback",
    // A different port on a host that is not loopback. The allowlist is not
    // per-host or per-prefix.
    "http://host.local:8081/sso/callback",
    // A different scheme.
    "https://host.local:8080/sso/callback",
    // A percent-encoding that means the same thing to a server but is not the same
    // bytes. Normalising this is how a registry gets talked into a path it did not
    // list.
    "http://host.local:8080/sso%2Fcallback",
    "http://host.local:8080/sso/./callback",
    // A different host that merely starts with the listed one: the reason there is
    // no prefix matching in any form.
    "http://host.local.evil.test:8080/sso/callback",
    // Userinfo pointing the eye at the listed host while the browser goes
    // somewhere else.
    "http://host.local:8080@evil.test/sso/callback",
  ];

  for (const uri of nearMisses) {
    const result = check(registry, uri);
    assert.equal(result.ok, false, `${uri} must not be permitted`);
    assert.equal(typeof result.reason, "string");
    assert.equal(typeof result.detail, "string");
  }
});

test("a listed URI is matched byte-for-byte, not by re-serialising it", () => {
  // `new URL("http://host.local:8080/a b")` percent-encodes the space, so a
  // registry that compared parsed forms would accept both spellings. The
  // configured one is what an operator wrote, and only that string matches.
  const raw = "http://host.local:8080/a%20b";
  const registry = registryWith([{ clientId: CLIENT, redirectUris: [raw] }]);

  assert.equal(check(registry, raw).ok, true);
  assert.equal(check(registry, "http://host.local:8080/a b").ok, false);
});

test("a URI listed for one client is not usable by another", () => {
  const registry = listedRegistry();
  const result = check(registry, LISTED, "some-other-client");

  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.REDIRECT_URI_UNREGISTERED);
});

test('the "*" client_id lists a URI for whoever asks, and only on the client_id side', () => {
  const registry = registryWith([{ clientId: ANY_CLIENT_ID, redirectUris: [LISTED] }]);

  // A tool whose client_id CCP issued and nobody here can know still reaches a
  // callback the operator did write down.
  assert.equal(check(registry, LISTED, "a-client-nobody-registered").via, VIA.ALLOWLIST);
  // It is not a wildcard on the URI. There is no prefix, suffix or subdomain
  // match: that would be an open redirector.
  assert.equal(check(registry, `${LISTED}/deeper`, "anyone").ok, false);
});

test("a client's own entry and the wildcard's are both consulted", () => {
  const registry = registryWith([
    { clientId: CLIENT, redirectUris: ["http://host.local:8080/mine"] },
    { clientId: ANY_CLIENT_ID, redirectUris: ["http://host.local:3000/shared"] },
  ]);

  assert.equal(check(registry, "http://host.local:8080/mine").ok, true);
  assert.equal(check(registry, "http://host.local:3000/shared").ok, true);
  assert.equal(check(registry, "http://host.local:8080/mine", "someone-else").ok, false);
});

test("two entries for one client merge rather than one shadowing the other", () => {
  const registry = registryWith([
    { clientId: CLIENT, redirectUris: ["http://host.local:8080/one"] },
    { clientId: CLIENT, redirectUris: ["http://host.local:8080/two"] },
  ]);

  assert.equal(check(registry, "http://host.local:8080/one").ok, true);
  assert.equal(check(registry, "http://host.local:8080/two").ok, true);
});

test("a client_id that names an Object property finds an empty allowlist", () => {
  // The lookup is a Map: on a plain object `allowlist["constructor"]` is a
  // function rather than undefined.
  const registry = listedRegistry();
  for (const clientId of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(check(registry, LISTED, clientId).ok, false, clientId);
  }
});

// Loopback

test("every loopback form this replica accepts", () => {
  const registry = registryWith([]);

  const accepted = [
    // The ordinary native-app case: an ephemeral port picked at runtime, so no
    // port is checked.
    "http://127.0.0.1:8080/callback",
    "http://127.0.0.1:1/callback",
    "http://127.0.0.1:65535/callback",
    // No port, a path, a query: all of it is the client's business once the
    // address is loopback.
    "http://127.0.0.1/callback",
    "http://127.0.0.1:8080/callback?state=abc&x=1",
    "http://127.0.0.1:8080/",
    // The whole of 127.0.0.0/8, not just the .1.
    "http://127.0.0.53:8080/cb",
    "http://127.255.255.255:8080/cb",
    "http://127.0.0.0:8080/cb",
    // IPv6 loopback, and the long spelling of it, which the URL parser normalises
    // to [::1] before this module sees it.
    "http://[::1]:8080/cb",
    "http://[0:0:0:0:0:0:0:1]:8080/cb",
    // https on loopback. A loopback listener has no certificate, which is why http
    // must work; a native app that terminates TLS on its own port is no more
    // dangerous than one that does not.
    "https://127.0.0.1:8443/cb",
    // The compressed IPv4 spellings are accepted because the URL parser has
    // already resolved them to 127.0.0.1, the same resolution the browser will do.
    // Refusing them would make this module disagree with the thing that decides
    // where the redirect goes.
    "http://127.1/cb",
    "http://2130706433/cb",
  ];

  for (const uri of accepted) {
    const result = check(registry, uri);
    assert.equal(result.ok, true, `${uri} should be a loopback redirect`);
    assert.equal(result.via, VIA.LOOPBACK, uri);
  }
});

test("localhost is not loopback: a name is not an address", () => {
  const registry = registryWith([]);
  const result = check(registry, "http://localhost:8080/callback");

  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.REDIRECT_URI_UNREGISTERED);
  // The refusal says why, because "but localhost is 127.0.0.1" is the first
  // thing anybody hitting this will think.
  assert.match(result.detail, /localhost/);

  // The escape hatch works: an operator whose tool insists on the name lists it
  // exactly, which is what an exact-match allowlist is for.
  const listed = registryWith([
    { clientId: CLIENT, redirectUris: ["http://localhost:8080/callback"] },
  ]);
  assert.equal(check(listed, "http://localhost:8080/callback").via, VIA.ALLOWLIST);
});

test("a hostname that merely looks like 127.0.0.0/8 is not loopback", () => {
  const registry = registryWith([]);

  for (const uri of [
    // Why config.js's `startsWith("127.")` predicate is not reused here: this is a
    // name, its owner points it wherever they like, and it is supplied by an
    // unauthenticated caller.
    "http://127.evil.com/cb",
    "http://127.0.0.1.evil.test/cb",
    "http://not-127.0.0.1/cb",
    // A neighbouring address that is not in the loopback block.
    "http://128.0.0.1/cb",
    "http://10.0.0.1/cb",
    "http://192.168.1.1/cb",
    // The IPv4-mapped IPv6 loopback is deliberately not accepted: no native tool's
    // listener produces it, and every extra accepted spelling is one more string to
    // probe with.
    "http://[::ffff:127.0.0.1]/cb",
    "http://[::2]/cb",
  ]) {
    assert.equal(check(registry, uri).ok, false, `${uri} must not count as loopback`);
  }
});

test("a non-http scheme is never automatic, even pointed at loopback", () => {
  const registry = registryWith([]);

  for (const uri of [
    // RFC 8252 blesses private-use schemes for native apps and this replica
    // narrows that deliberately: the scheme belongs to whichever application
    // registered it with the operating system, which we cannot see or verify.
    "com.example.app:/oauth/callback",
    "myapp://callback",
    // The ones that are not callbacks at all.
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///c:/windows/system32/",
    "ftp://127.0.0.1/cb",
  ]) {
    const result = check(registry, uri);
    assert.equal(result.ok, false, `${uri} must not be permitted`);
  }
});

test("a private-use scheme can still be listed exactly", () => {
  const registry = registryWith([
    { clientId: CLIENT, redirectUris: ["com.example.app:/oauth/callback"] },
  ]);
  assert.equal(check(registry, "com.example.app:/oauth/callback").via, VIA.ALLOWLIST);
});

test("allowLoopback: false leaves the allowlist as the only way in", () => {
  const registry = listedRegistry({ allowLoopback: false });

  assert.equal(check(registry, LISTED).ok, true);
  const result = check(registry, "http://127.0.0.1:8080/cb");
  assert.equal(result.ok, false);
  assert.match(result.detail, /switched off/);
});

test("a listed loopback URI reports the allowlist, not loopback", () => {
  // Which gate answered is not cosmetic: it tells an operator whether turning
  // allowLoopback off will break this client.
  const registry = registryWith([
    { clientId: CLIENT, redirectUris: ["http://127.0.0.1:9000/cb"] },
  ]);
  assert.equal(check(registry, "http://127.0.0.1:9000/cb").via, VIA.ALLOWLIST);
});

test("the address predicate stands on its own, without a registry in the way", () => {
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("127.255.255.255"), true);
  assert.equal(isLoopbackHostname("[::1]"), true);
  assert.equal(isLoopbackHostname("localhost"), false);
  assert.equal(isLoopbackHostname("127.evil.com"), false);
  assert.equal(isLoopbackHostname("127.0.0.999"), false);
  assert.equal(isLoopbackHostname("::1"), false, "an unbracketed IPv6 is not what URL reports");
  assert.equal(isLoopbackHostname(""), false);
});

// The redirect URI's own shape

test("a redirect URI has to be absolute", () => {
  const registry = registryWith([]);

  for (const uri of ["/callback", "callback", "//127.0.0.1/cb", "?code=1"]) {
    const result = check(registry, uri);
    assert.equal(result.ok, false, uri);
    assert.equal(result.reason, REASON.REDIRECT_URI_RELATIVE, uri);
  }
});

test("the scheme-less host:port spelling is diagnosed as a missing scheme", () => {
  // `new URL("host.local:8080/cb")` does not throw: it parses with `host.local`
  // as the scheme. config.js documents the same mistake for the issuer; here it
  // arrives looking absolute and fails the loopback gate.
  const result = check(registryWith([]), "127.0.0.1:8080/cb");
  assert.equal(result.ok, false);
  assert.match(result.detail, /scheme/);
});

test("credentials in a redirect URI are refused even on loopback", () => {
  const result = check(registryWith([]), "http://user:pass@127.0.0.1:8080/cb");
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.REDIRECT_URI_CREDENTIALS);
});

test("a fragment is refused: the authorization response needs the tail of the URI", () => {
  for (const uri of ["http://127.0.0.1:8080/cb#frag", "http://127.0.0.1:8080/cb#"]) {
    const result = check(registryWith([]), uri);
    assert.equal(result.ok, false, uri);
    assert.equal(result.reason, REASON.REDIRECT_URI_FRAGMENT, uri);
  }
});

test("a control character in a redirect URI is refused before it is parsed", () => {
  // A URL parser drops some of these and percent-encodes others, which would let
  // two different strings become one comparable string.
  for (const uri of [
    "http://127.0.0.1:8080/cb\nSet-Cookie: x=1",
    "http://127.0.0.1:8080/c\tb",
    "http://127.0.0.1:8080/cb\u0000",
  ]) {
    assert.equal(check(registryWith([]), uri).ok, false, JSON.stringify(uri));
  }
});

test("a missing redirect URI is its own refusal, never a default", () => {
  const registry = registryWith([]);
  for (const uri of [undefined, null, "", "   ", 42, {}]) {
    const result = check(registry, uri);
    assert.equal(result.ok, false, String(uri));
    assert.equal(result.reason, REASON.REDIRECT_URI_MISSING, String(uri));
  }
});

// The client_id

test("any client_id is accepted: CCP issued them and we cannot know them", () => {
  const registry = registryWith([{ clientId: ANY_CLIENT_ID, redirectUris: [LISTED] }]);

  for (const clientId of [
    "1a2b3c4d5e6f7g8h9i0j",
    "eve-nexum",
    "a",
    "x".repeat(MAX_CLIENT_ID_LENGTH),
  ]) {
    assert.equal(check(registry, LISTED, clientId).ok, true, clientId.slice(0, 20));
  }
});

test("a missing client_id is refused: it becomes the token's azp", () => {
  const registry = registryWith([{ clientId: ANY_CLIENT_ID, redirectUris: [LISTED] }]);

  for (const clientId of [undefined, null, ""]) {
    const result = registry.check({ clientId, redirectUri: LISTED });
    assert.equal(result.ok, false, String(clientId));
    assert.equal(result.reason, REASON.CLIENT_ID_MISSING, String(clientId));
  }
});

test("a client_id that is unbounded, blank or control-bearing is refused", () => {
  const registry = registryWith([{ clientId: ANY_CLIENT_ID, redirectUris: [LISTED] }]);

  const bad = [
    "x".repeat(MAX_CLIENT_ID_LENGTH + 1),
    "   ",
    "client\nid",
    "client\u0000id",
    42,
    {},
  ];

  for (const clientId of bad) {
    const result = registry.check({ clientId, redirectUri: LISTED });
    assert.equal(result.ok, false, JSON.stringify(clientId));
    assert.equal(result.reason, REASON.CLIENT_ID_INVALID, JSON.stringify(clientId));
  }
});

test("the client_id is judged before the redirect URI", () => {
  // A request with neither is malformed in both ways; reporting the client_id
  // first keeps construction and check telling one story.
  const result = registryWith([]).check({ clientId: "", redirectUri: "" });
  assert.equal(result.reason, REASON.CLIENT_ID_MISSING);
});

test("check never throws, whatever it is handed", () => {
  const registry = listedRegistry();
  for (const argument of [undefined, null, 42, "string", [], { clientId: [] }]) {
    assert.doesNotThrow(() => registry.check(argument), JSON.stringify(argument));
  }
});

// Construction

test("a registry with no clients is a working registry, not a broken one", () => {
  // The empty allowlist is what an operator with only native tools has, and
  // every one of those still authenticates.
  const registry = createClientRegistry();
  assert.equal(check(registry, "http://127.0.0.1:8080/cb").via, VIA.LOOPBACK);
  assert.equal(check(registry, LISTED).ok, false);
});

test("the returned registry is frozen", () => {
  const registry = listedRegistry();
  assert.equal(Object.isFrozen(registry), true);
});

test("a misconfigured allowlist throws at construction, where a startup can refuse", () => {
  const cases = [
    [{ clients: "not-an-array" }, /array of \{ clientId, redirectUris \}/],
    [{ clients: [null] }, /is not an object/],
    [{ clients: [{ clientId: "", redirectUris: [LISTED] }] }, /it is empty/],
    [{ clients: [{ clientId: "a\nb", redirectUris: [LISTED] }] }, /control character/],
    [
      { clients: [{ clientId: "x".repeat(300), redirectUris: [LISTED] }] },
      /over the 255 this replica accepts/,
    ],
    [{ clients: [{ clientId: CLIENT }] }, /lists no redirect URIs/],
    [{ clients: [{ clientId: CLIENT, redirectUris: [] }] }, /lists no redirect URIs/],
    // A URI the operator mistyped can never match anything, so it is a boot-time
    // refusal rather than a login that fails weeks later.
    [{ clients: [{ clientId: CLIENT, redirectUris: ["/callback"] }] }, /not an absolute URI/],
    [
      { clients: [{ clientId: CLIENT, redirectUris: ["http://x/cb#f"] }] },
      /carries a fragment/,
    ],
    [
      { clients: [{ clientId: CLIENT, redirectUris: ["http://u:p@x/cb"] }] },
      /credentials/,
    ],
    [{ clients: [{ clientId: CLIENT, redirectUris: [7] }] }, /carried no redirect_uri/],
    [{ clients: [], allowLoopback: "yes" }, /allowLoopback must be a boolean/],
  ];

  for (const [options, expected] of cases) {
    assert.throws(
      () => createClientRegistry(options),
      (err) => err instanceof ClientRegistryError && expected.test(err.message),
      JSON.stringify(options),
    );
  }
});

// Client secrets
//
// A code minted without a `code_challenge` is redeemable only by a client that
// authenticated, which requires the registry to hold secrets.
// `lib/clientAuth.js` owns the invariant; what is asserted here is the one
// question this module answers for it.

const SECRET = "s3cret-value.for_the-operator";
const OTHER_SECRET = "another-secret-value-entirely";
const PUBLIC_CLIENT = "public-client-id";

/** One confidential client and one public one, the two shapes. */
function mixedRegistry() {
  return registryWith([
    { clientId: CLIENT, redirectUris: [LISTED], clientSecret: SECRET },
    { clientId: PUBLIC_CLIENT, redirectUris: [LISTED] },
  ]);
}

test("a matching secret verifies and a wrong one does not", () => {
  const registry = mixedRegistry();

  assert.equal(registry.verifySecret({ clientId: CLIENT, clientSecret: SECRET }), true);
  assert.equal(registry.verifySecret({ clientId: CLIENT, clientSecret: OTHER_SECRET }), false);
  // A prefix, and one character too many. Neither is nearly right.
  assert.equal(
    registry.verifySecret({ clientId: CLIENT, clientSecret: SECRET.slice(0, -1) }),
    false,
  );
  assert.equal(registry.verifySecret({ clientId: CLIENT, clientSecret: SECRET + "x" }), false);
});

test("a secret presented for a client registered without one never verifies", () => {
  const registry = mixedRegistry();

  // Not the other client's secret, not an empty one, not any one. A public
  // client has nothing to authenticate with, and the absence of a registered
  // secret must never read as "anything matches".
  for (const clientSecret of [SECRET, OTHER_SECRET, "", " ", "undefined", "null"]) {
    assert.equal(
      registry.verifySecret({ clientId: PUBLIC_CLIENT, clientSecret }),
      false,
      JSON.stringify(clientSecret),
    );
  }
});

test("a secret for a client_id nobody registered never verifies", () => {
  const registry = mixedRegistry();
  assert.equal(registry.verifySecret({ clientId: "who-is-this", clientSecret: SECRET }), false);
  assert.equal(registry.verifySecret({ clientId: ANY_CLIENT_ID, clientSecret: SECRET }), false);
});

test("verifySecret answers one bit and nothing else", () => {
  // Not an object, not a reason, not "this client has no secret". Any second
  // field is a difference a caller could report by accident, and the two failing
  // cases have to be indistinguishable (see lib/clientAuth.js).
  const registry = mixedRegistry();
  assert.equal(typeof registry.verifySecret({ clientId: CLIENT, clientSecret: SECRET }), "boolean");
  assert.equal(typeof registry.verifySecret({ clientId: CLIENT, clientSecret: "x" }), "boolean");
});

test("verifySecret never throws, whatever it is handed", () => {
  // The request path. A length mismatch handed raw to `crypto.timingSafeEqual`
  // would throw, and eve.js treats a throw as fatal, so this also asserts that
  // digests, not secrets, are what get compared.
  const registry = mixedRegistry();
  const inputs = [
    undefined, null, 42, "string", [],
    { clientId: CLIENT },
    { clientId: CLIENT, clientSecret: null },
    { clientId: CLIENT, clientSecret: 7 },
    { clientId: CLIENT, clientSecret: {} },
    { clientId: [], clientSecret: SECRET },
    { clientId: CLIENT, clientSecret: "x".repeat(10000) },
  ];

  for (const input of inputs) {
    assert.doesNotThrow(() => registry.verifySecret(input), JSON.stringify(input));
    assert.equal(registry.verifySecret(input), false, JSON.stringify(input));
  }
});

test("a presented secret of any length is compared without a throw or a short circuit", () => {
  // Structural, not a timing measurement: this shows that no length mismatch
  // produces a throw or a different kind of answer. Whether the machine code
  // takes constant time cannot be asserted on a shared runner, and pretending
  // otherwise is worse than not asserting.
  const registry = mixedRegistry();

  for (let length = 1; length <= 300; length += 1) {
    const clientSecret = "a".repeat(length);
    assert.equal(registry.verifySecret({ clientId: CLIENT, clientSecret }), false, `${length}`);
    assert.equal(
      registry.verifySecret({ clientId: PUBLIC_CLIENT, clientSecret }),
      false,
      `${length}`,
    );
  }
});

test("client_secret is accepted as a second spelling, and a disagreement throws", () => {
  // config.js translates the operator's file into this module's vocabulary, so a
  // registry built from configuration sees `clientSecret`; anything built from
  // the file's own spelling writes `client_secret`. Both work. Two that disagree
  // are refused, not defaulted.
  const snake = registryWith([
    { clientId: CLIENT, redirectUris: [LISTED], client_secret: SECRET },
  ]);
  assert.equal(snake.verifySecret({ clientId: CLIENT, clientSecret: SECRET }), true);

  const agreeing = registryWith([
    { clientId: CLIENT, redirectUris: [LISTED], clientSecret: SECRET, client_secret: SECRET },
  ]);
  assert.equal(agreeing.verifySecret({ clientId: CLIENT, clientSecret: SECRET }), true);

  assert.throws(
    () => registryWith([{
      clientId: CLIENT,
      redirectUris: [LISTED],
      clientSecret: SECRET,
      client_secret: OTHER_SECRET,
    }]),
    /both clientSecret and client_secret, and they differ/,
  );
});

test("an unusable secret is a configuration error at construction", () => {
  const cases = [
    // Empty is the one worth naming. An operator who wrote `client_secret: ""`
    // configured a confidential client that nothing can authenticate, and the
    // alternative to refusing here is discovering it at a token exchange weeks
    // later.
    ["", /it is empty/],
    ["short", /under the 16/],
    ["a".repeat(MIN_CLIENT_SECRET_LENGTH - 1), /under the 16/],
    ["a".repeat(MAX_CLIENT_SECRET_LENGTH + 1), /over the 255/],
    // Outside the charset that survives RFC 6749 section 2.3.1's form-urlencoding
    // unchanged. Each of these has two spellings on the wire.
    ["secret with spaces here", /outside A-Z a-z 0-9/],
    ["secret+with+plusses+xx", /outside A-Z a-z 0-9/],
    ["secret%20percent%20xxx", /outside A-Z a-z 0-9/],
    ["secret:with:colons:xxx", /outside A-Z a-z 0-9/],
    ["secret~with~tildes~xxx", /outside A-Z a-z 0-9/],
    ["secret-with\nnewline-x", /outside A-Z a-z 0-9/],
    [42, /not a string/],
    [{}, /not a string/],
    [true, /not a string/],
  ];

  for (const [clientSecret, expected] of cases) {
    assert.throws(
      () => registryWith([{ clientId: CLIENT, redirectUris: [LISTED], clientSecret }]),
      (err) => err instanceof ClientRegistryError && expected.test(err.message),
      JSON.stringify(clientSecret),
    );
  }
});

test("null is an omitted secret rather than an unusable one", () => {
  // A file that spells "no secret" as `"client_secret": null` describes a public
  // client, not a misconfiguration. `""` is the mistake, because somebody meant
  // to put a string there.
  const registry = registryWith([
    { clientId: CLIENT, redirectUris: [LISTED], clientSecret: null },
  ]);
  assert.equal(registry.verifySecret({ clientId: CLIENT, clientSecret: SECRET }), false);
  assert.equal(check(registry, LISTED).ok, true);
});

test("the wildcard entry may not carry a secret", () => {
  // A secret shared by every client_id authenticates its holder as anybody. That
  // is not weaker client authentication but the negation of what the invariant is
  // built on.
  assert.throws(
    () => registryWith([{ clientId: ANY_CLIENT_ID, redirectUris: [LISTED], clientSecret: SECRET }]),
    (err) => err instanceof ClientRegistryError
      && /opposite of what client authentication is for/.test(err.message),
  );
});

test("two entries for one client_id merge URIs but may not disagree about the secret", () => {
  const merged = registryWith([
    { clientId: CLIENT, redirectUris: [LISTED], clientSecret: SECRET },
    { clientId: CLIENT, redirectUris: ["http://host.local:8080/other"], clientSecret: SECRET },
  ]);
  assert.equal(check(merged, "http://host.local:8080/other").ok, true);
  assert.equal(merged.verifySecret({ clientId: CLIENT, clientSecret: SECRET }), true);

  assert.throws(
    () => registryWith([
      { clientId: CLIENT, redirectUris: [LISTED], clientSecret: SECRET },
      { clientId: CLIENT, redirectUris: [LISTED], clientSecret: OTHER_SECRET },
    ]),
    /a second, different client secret/,
  );
});

test("secrets change nothing about check", () => {
  // The authorize endpoint has no credentials to offer and asks the question it
  // always did: a redirect target is registered or it is not.
  const withSecret = registryWith([
    { clientId: CLIENT, redirectUris: [LISTED], clientSecret: SECRET },
  ]);
  const withoutSecret = listedRegistry();

  for (const uri of [LISTED, `${LISTED}/`, "http://127.0.0.1:9000/cb", "http://evil.test/cb"]) {
    assert.equal(
      JSON.stringify(check(withSecret, uri)),
      JSON.stringify(check(withoutSecret, uri)),
      uri,
    );
  }
});

test("each registry digests under its own key, and both still verify", () => {
  // The digest key is per-registry, so a digest means nothing outside the
  // process that made it. Asserted through behaviour: two registries built from
  // one file each verify their own secret.
  const first = mixedRegistry();
  const second = mixedRegistry();
  assert.equal(first.verifySecret({ clientId: CLIENT, clientSecret: SECRET }), true);
  assert.equal(second.verifySecret({ clientId: CLIENT, clientSecret: SECRET }), true);
});
