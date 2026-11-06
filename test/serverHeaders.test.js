/**
 * The header set on the wire, against what CCP actually sends.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * `test/server.test.js` asks whether the HTTP substrate behaves: timeouts, body
 * limits, the dispatch seam, what happens when a handler throws. This suite asks
 * whether what leaves the socket is what CCP would have sent. Its assertions
 * come from `contract/wire.js`, which is observation of live ESI, and it is
 * extended every time the router learns to write another header.
 *
 * It is also a worked example of the harness catching real errors. This
 * repository once wrote `x-content-type-options: nosniff` on every response, and
 * `content-type: application/json; charset=utf-8`. Both were reasonable, both
 * were wrong, and a test written against our own implementation would not have
 * noticed. The observation came first and the code changed to match it.
 *
 * The fix itself needed a second correction. `charset=utf-8` was replaced with a
 * bare `application/json` on the strength of `GET /status/`, and a wider survey
 * then found that `GET /universe/regions/10000002/` sends
 * `application/json; charset=UTF-8` and ends its body one byte shorter, because
 * the other implementation writes it. One endpoint is a data point and not a
 * rule.
 *
 * Ceiling and floor. This file once asserted only one direction: we send
 * nothing CCP does not. The `Vary`, limiter and localization headers are now
 * written, so the acceptance is checkable as stated (a raw header diff against a
 * real-ESI response shows no missing header and no extra header), and it is
 * checked below in both directions against `GATEWAY_SUCCESS_HEADERS` and
 * `APP_SUCCESS_HEADERS`. A diff has exactly one permitted entry,
 * `strict-transport-security`, which is a promise about `https` that D1's plain
 * HTTP cannot keep. `contract/wire.js` `NOT_SENT_BY_CHOICE` records that, and
 * the test reads the exception from there rather than hardcoding it.
 *
 * The two-directional form lets the suite fail for the right reason. A ceiling
 * alone never notices a header that was never written, and a floor alone never
 * notices one CCP does not send. Both are ways to be distinguishable from CCP,
 * which is the only thing this file measures.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const { startServer, closeServer } = require(path.join(__dirname, "../server"));
const { createEsiDispatch } = require(path.join(__dirname, "../lib/pipeline"));
const { createRouter } = require(path.join(__dirname, "../lib/router"));

// Node adds these itself, on every response, and they are not ours to decide.
// `keep-alive` is the HTTP/1.1 default; `date` is required by RFC 9110.
const NODE_ADDS = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);

async function serve(t, dispatch) {
  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch,
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));
  return `http://127.0.0.1:${handle.port}`;
}

/** Header names as they came off the socket, lowercased, duplicates collapsed. */
function headerNames(response) {
  return [...new Set([...response.headers.keys()].map((name) => name.toLowerCase()))].sort();
}

/**
 * The response head, as bytes.
 *
 * `fetch` lowercases header names on the way in and comma-joins repeated lines,
 * so it would pass whatever we sent for both of the things this file measures.
 * Anything asserting casing or line count has to read the socket.
 */
function rawHead(port, request) {
  return new Promise((resolve, reject) => {
    const socket = http.globalAgent.createConnection({ host: "127.0.0.1", port });
    let raw = "";
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("end", () => resolve(raw.split("\r\n\r\n")[0]));
    socket.on("error", reject);
    socket.write(request);
  });
}

/** How many times a header name appears as its own line. */
function lineCount(head, name) {
  return head.split("\r\n").filter((line) => line.toLowerCase().startsWith(`${name}: `)).length;
}

/** The surface `loader.js` builds, over one route, behind the real listener. */
function esi(t, route) {
  return serve(t, createEsiDispatch(createRouter([route])));
}

const gatewayRoute = {
  method: "GET",
  path: "/status",
  name: "GetStatus",
  handler: () => ({ players: 1 }),
  producer: "gateway",
  cacheTtl: 30,
  // A published group, so this response carries the token bucket's family, which
  // is the one the gateway's observed header set contains.
  rateLimitGroup: "status",
};

const appRoute = {
  method: "GET",
  path: "/universe/regions/:region_id",
  name: "GetUniverseRegionsRegionId",
  handler: () => ({ region_id: 10000002 }),
  producer: "app",
  cacheTtl: 3600,
  // Its body has a name and a description in it, so it is one of the routes that
  // repeats `Accept-Language`. The survey found this exact route on the two-line
  // side and `/universe/regions/` (a list of ids) on the one-line side. Declared
  // here so the socket test below has a route that sends four.
  localizedBody: true,
  // No group, so this one falls to the error limiter: the family the
  // application's observed header set contains, and never the other.
  rateLimitGroup: null,
};

// The ceiling

test("a 200 carries no header CCP does not send", async (t) => {
  const url = await serve(t, () => ({ status: 200, body: { players: 1 } }));

  const response = await fetch(`${url}/latest/status/`);
  const allowed = new Set(wire.GATEWAY_SUCCESS_HEADERS);

  const extra = headerNames(response).filter((name) => !allowed.has(name) && !NODE_ADDS.has(name));

  assert.deepEqual(
    extra,
    [],
    `these headers are on our 2XX and on none of CCP's (observed ${wire.ESTABLISHED}). `
      + "If one of them is genuinely sent by ESI, add it to GATEWAY_SUCCESS_HEADERS with the "
      + "request that shows it: do not delete the assertion.",
  );
});

test("a gateway 200 off the real stack matches CCP's header set exactly", async (t) => {
  // No missing header and no extra header. Read as two sets rather than as a list
  // of assertions, so that a header nobody thought to check for is still counted.
  const url = await esi(t, gatewayRoute);
  const response = await fetch(`${url}/latest/status/`);

  const sent = new Set(headerNames(response).filter((name) => !NODE_ADDS.has(name)));
  // Node writes `date` and `connection` itself, so they are on both sides of this
  // diff for a reason that has nothing to do with fidelity. Taken off both.
  const observed = new Set(wire.GATEWAY_SUCCESS_HEADERS.filter((name) => !NODE_ADDS.has(name)));
  const excused = new Set(Object.keys(wire.NOT_SENT_BY_CHOICE));

  assert.deepEqual([...sent].filter((name) => !observed.has(name)), [], "sent, and CCP does not");
  assert.deepEqual(
    [...observed].filter((name) => !sent.has(name) && !excused.has(name)),
    [],
    "CCP sends it and we do not, which is half of what a conformance diff counts",
  );
  assert.deepEqual(
    [...observed].filter((name) => !sent.has(name)),
    ["strict-transport-security"],
    "and the one difference left is the one D1 chose, not one nobody noticed",
  );
});

test("an application 200 matches its own, different, header set", async (t) => {
  // The two sets differ, which is the clearest evidence in the repository that
  // ESI is two implementations: the application reports the error limit where the
  // gateway reports the rate limit, and stamps a request id the gateway does not.
  const url = await esi(t, appRoute);
  const response = await fetch(`${url}/latest/universe/regions/10000002/`);

  const sent = new Set(headerNames(response).filter((name) => !NODE_ADDS.has(name)));
  const observed = new Set(wire.APP_SUCCESS_HEADERS.filter((name) => !NODE_ADDS.has(name)));
  const excused = new Set(Object.keys(wire.NOT_SENT_BY_CHOICE));

  assert.deepEqual([...sent].filter((name) => !observed.has(name)), []);
  assert.deepEqual([...observed].filter((name) => !sent.has(name) && !excused.has(name)), []);

  assert.ok(sent.has("x-esi-request-id"), "the application's stamp");
  assert.ok(sent.has("x-esi-error-limit-remain"), "and its limiter family");
  assert.ok(!sent.has("x-ratelimit-limit"), "never the other one");
});

test("Vary goes out as separate lines, in the producer's own multiplicity", async (t) => {
  // `fetch` cannot see this: it comma-joins repeated lines, so a replica sending
  // `Vary: X-Tenant, Accept-Language` as one line would pass every test written
  // against a fetch response. Some intermediaries fold them, and the folded form
  // is a different string for anything keying a cache on it.
  const gatewayUrl = await esi(t, gatewayRoute);
  const gateway = await rawHead(
    Number(new URL(gatewayUrl).port),
    "GET /latest/status/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  );

  assert.equal(lineCount(gateway, "vary"), 3);
  assert.equal(lineCount(gateway, "vary"), wire.VARY_BY_KIND[wire.KIND.GATEWAY_SUCCESS].length);
  assert.match(gateway, /\r\nVary: X-Tenant\r\n/);
  assert.match(gateway, /\r\nVary: Accept-Language\r\n/);
  assert.match(gateway, /\r\nVary: X-Compatibility-Date\r\n/);
  assert.doesNotMatch(gateway, /\r\nVary: [^\r\n]*,/, "never comma-joined");

  const appUrl = await esi(t, appRoute);
  const app = await rawHead(
    Number(new URL(appUrl).port),
    "GET /latest/universe/regions/10000002/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  );

  // Four, not three, because this route's body has names in it, not because it is
  // the application. `/universe/regions/{id}/` repeats `Accept-Language` on the
  // wire and `/universe/regions/` does not, on the same producer and the same
  // etag.
  assert.equal(lineCount(app, "vary"), 4);
  assert.equal(lineCount(app, "vary"), wire.VARY_LOCALIZED_BODY.length);
  assert.equal(app.split("\r\n").filter((line) => line === "Vary: Accept-Language").length, 2);

  // The same producer, without the names, sends three.
  const plainUrl = await esi(t, { ...appRoute, localizedBody: false });
  const plain = await rawHead(
    Number(new URL(plainUrl).port),
    "GET /latest/universe/regions/10000002/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
  );

  assert.equal(lineCount(plain, "vary"), wire.VARY_BY_KIND[wire.KIND.APP_SUCCESS].length);
  assert.equal(lineCount(plain, "vary"), 3);
});

test("the localization pair reaches the socket in CCP's casing", async (t) => {
  const url = await esi(t, gatewayRoute);
  const head = await rawHead(
    Number(new URL(url).port),
    "GET /latest/status/ HTTP/1.1\r\nHost: x\r\nAccept-Language: de\r\nConnection: close\r\n\r\n",
  );

  // Answered in English, and saying so. See test/language.test.js for why the
  // request is not echoed (D27).
  assert.match(head, /\r\nContent-Language: en\r\n/);
  assert.match(head, /\r\nX-Esi-Cache-Status: MISS\r\n/);
});

test("the headers we deliberately do not send are named, with the reason", async (t) => {
  // An absent header is either a bug or a decision, and the difference has to be
  // written down somewhere a diff can read. `NOT_SENT_BY_CHOICE` is that place,
  // and the two tests above take their one permitted exception from it rather
  // than from a literal here.
  assert.deepEqual(Object.keys(wire.NOT_SENT_BY_CHOICE).sort(), ["strict-transport-security", "warning"]);

  const url = await esi(t, gatewayRoute);
  const response = await fetch(`${url}/latest/status/`);

  // HSTS would tell a browser to refuse the only scheme this replica answers on
  // (D1), so reproducing it faithfully would break the client it was copied for.
  // It arrives with TLS (D14).
  assert.equal(response.headers.get("strict-transport-security"), null);
  // CCP retired `Warning: 199` in favour of /meta/changelog, and nothing this
  // replica serves is deprecated, so there is nothing to warn about.
  assert.equal(response.headers.get("warning"), null);
});

test("nosniff is absent from a 2XX, because it is absent from CCP's", async (t) => {
  // The specific header this harness was built to remove. Called out separately
  // from the set comparison above so a regression names itself in the failure.
  const url = await serve(t, () => ({ status: 200, body: {} }));

  const response = await fetch(`${url}/latest/status/`);

  assert.equal(wire.SENDS_NOSNIFF[wire.KIND.GATEWAY_SUCCESS], false, "the observation this rests on");
  assert.equal(response.headers.get("x-content-type-options"), null);
});

test("the JSON content type is the answering producer's, not one spelling for everything", async (t) => {
  // Three spellings exist. On the 2XX path, `/sovereignty/map/` is answered by
  // the gateway and `/universe/regions/` by the application, and they do not
  // agree.
  const url = await serve(t, (request) => (
    request.pathname.includes("sovereignty")
      ? { status: 200, body: [], producer: "gateway" }
      : { status: 200, body: [], producer: "app" }
  ));

  const gateway = await fetch(`${url}/latest/sovereignty/map/`);
  assert.equal(gateway.headers.get("content-type"), wire.CONTENT_TYPE[wire.KIND.GATEWAY_SUCCESS]);
  assert.equal(gateway.headers.get("content-type"), "application/json", "no charset on this one");

  const app = await fetch(`${url}/latest/universe/regions/`);
  assert.equal(app.headers.get("content-type"), wire.CONTENT_TYPE[wire.KIND.APP_SUCCESS]);
  assert.equal(app.headers.get("content-type"), "application/json; charset=UTF-8", "capitalised");
});

test("the last byte on the socket is the answering producer's too", async (t) => {
  // The half of the producer split that no header shows. Go's encoder ends every
  // body it writes with a newline, so `[]` is three bytes from the gateway and two
  // from the application, and `content-length` says so.
  const url = await serve(t, (request) => (
    request.pathname.includes("sovereignty")
      ? { status: 200, body: [], producer: "gateway" }
      : { status: 200, body: [], producer: "app" }
  ));

  const gateway = await fetch(`${url}/latest/sovereignty/map/`);
  assert.equal(await gateway.text(), "[]\n");
  assert.equal(gateway.headers.get("content-length"), "3");
  assert.equal(wire.TRAILING_NEWLINE[wire.KIND.GATEWAY_SUCCESS], true, "the observation this rests on");

  const app = await fetch(`${url}/latest/universe/regions/`);
  assert.equal(await app.text(), "[]");
  assert.equal(app.headers.get("content-length"), "2");
  assert.equal(wire.TRAILING_NEWLINE[wire.KIND.APP_SUCCESS], false);
});

// Gateway refusals

test("a malformed request keeps nosniff, because CCP's gateway refusals carry it", async (t) => {
  // 401 and `Invalid tenant` are gateway refusals and do send it. A request too
  // broken to route is the same kind of answer, made before any route is reached.
  const url = await serve(t, () => ({ status: 200 }));
  const port = Number(new URL(url).port);

  const head = await new Promise((resolve, reject) => {
    const socket = http.globalAgent.createConnection({ host: "127.0.0.1", port });
    let raw = "";
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("end", () => resolve(raw.split("\r\n\r\n")[0]));
    socket.on("error", reject);
    socket.write("NOT-A-REQUEST\r\n\r\n");
  });

  assert.match(head, /^HTTP\/1\.1 400 /);
  assert.equal(wire.SENDS_NOSNIFF[wire.KIND.GATEWAY_ERROR], true, "the observation this rests on");
  assert.match(head, /x-content-type-options: nosniff/i);
  assert.match(head, /content-type: application\/json\r/i, "no charset here either");
});

// Headers a consumer needs

test("every header a client depends on is one CCP was observed sending", () => {
  // What a consumer misbehaves without: eve-nexum self-throttles on missing
  // error-limit headers, market-hub-seed aborts a paged sweep on an inconsistent
  // `Last-Modified`, and polling clients that see no `Expires` poll in a tight
  // loop against the game's own event loop. Every one is sent (the two tests at
  // the top of this file say so). This test asks the other question: that each is
  // a header CCP sends, rather than something helpful we invented.
  const owed = [
    "access-control-allow-origin",
    "access-control-expose-headers",
    "cache-control",
    "content-language",
    "etag",
    "expires",
    "last-modified",
    "vary",
    "x-compatibility-date",
    "x-esi-cache-status",
  ];

  for (const name of owed) {
    assert.ok(
      wire.GATEWAY_SUCCESS_HEADERS.includes(name),
      `${name} is owed to clients but is not in the observed set: one of the two is wrong`,
    );
  }

  // The one that is the application's alone, which is why it is not above.
  assert.ok(wire.APP_SUCCESS_HEADERS.includes("x-esi-request-id"));
  assert.ok(!wire.GATEWAY_SUCCESS_HEADERS.includes("x-esi-request-id"));
});

// Casing

test("the observed header names go out in CCP's casing, not lowercase", async (t) => {
  // Header names are case-insensitive and every correct client agrees, which is
  // why the incorrect ones are worth matching. `market-hub-seed` indexes response
  // headers by name; a tool reading `Etag` off a replica that sends `etag`
  // concludes the response has no validator.
  //
  // Read off the raw socket, because `fetch` lowercases on the way in and would
  // pass whatever we sent.
  const url = await serve(t, () => ({
    status: 200,
    body: { players: 1 },
    producer: "gateway",
    headers: { etag: 'W/"abc"', "x-pages": "3", "x-compatibility-date": "2020-01-01" },
  }));
  const port = Number(new URL(url).port);

  const head = await new Promise((resolve, reject) => {
    const socket = http.globalAgent.createConnection({ host: "127.0.0.1", port });
    let raw = "";
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("end", () => resolve(raw.split("\r\n\r\n")[0]));
    socket.on("error", reject);
    socket.write("GET /latest/status/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  });

  assert.match(head, /\r\nEtag: /, "CCP sends Etag, and the pinned spec's `ETag` is the wrong one (D23)");
  assert.doesNotMatch(head, /\r\netag: /);
  assert.match(head, /\r\nX-Pages: 3\r\n/);
  assert.match(head, /\r\nX-Compatibility-Date: 2020-01-01\r\n/);

  // Not just the surprising ones: CCP title-cases every name it sends.
  assert.match(head, /\r\nContent-Type: /);
  assert.match(head, /\r\nContent-Length: /);
  assert.doesNotMatch(head, /\r\n[a-z][a-z-]*: /, "a lowercase header name went out");
});

test("title-case reproduces every spelling that was actually observed", () => {
  // CCP title-cases mechanically, so `Etag` and `X-Ratelimit-Group` are
  // exceptions to convention, not to the rule. A lookup table of "the odd ones"
  // would get the next one wrong. The day CCP sends a name the rule cannot
  // produce, this fails and lib/headers.js grows a genuine exception.
  const { OBSERVED_CASE, titleCase } = require(path.join(__dirname, "../lib/headers"));

  assert.deepEqual({ ...OBSERVED_CASE }, { ...wire.HEADER_CASE }, "lib/ and contract/ keep copies (D20)");

  for (const [lower, observed] of Object.entries(OBSERVED_CASE)) {
    assert.equal(titleCase(lower), observed, `title-case does not produce CCP's ${observed}`);
  }

  assert.equal(titleCase("etag"), "Etag", "and not the RFC's ETag, which the pinned spec also says");
  assert.equal(titleCase("x-ratelimit-group"), "X-Ratelimit-Group", "not the conventional X-RateLimit-");
});

test("every header goes out title-cased, not only the surprising ones", () => {
  // CCP sends `Content-Type` and `Last-Modified`, not `content-type` and
  // `last-modified`. A table that covered only the odd spellings would leave
  // every ordinary header lowercase and still be wrong for a client that
  // string-compares.
  const { withCcpCasing } = require(path.join(__dirname, "../lib/headers"));

  assert.deepEqual(
    withCcpCasing({ "content-type": "application/json", etag: 'W/"x"', "last-modified": "now", ETag: "reNormalised" }),
    { "Content-Type": "application/json", Etag: "reNormalised", "Last-Modified": "now" },
  );
});
