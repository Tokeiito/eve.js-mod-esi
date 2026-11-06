/**
 * ESI/SSO replica mod: HTTP listener tests.
 *
 * Run with: node --test "test/**\/*.test.js"   (from the mod directory, or RunTests.bat)
 *
 * These are the only tests in the mod that open a socket, and they open it on
 * port 0 (the kernel picks a free port), so the suite never collides with a
 * running server. Every listener is closed in a `t.after` and is unref'd, so
 * the runner exits on its own.
 *
 * No game code is loaded here: server.js requires nothing but `node:http`.
 * Every `dispatch` below is a fake defined inline.
 *
 * The tests cover these properties, each a way this mod could take a game
 * server down:
 *
 *   * a throwing or rejecting `dispatch` becomes a 500, never an unhandled
 *     rejection (eve.js's ProcessLifecycle treats those as fatal);
 *   * `unref()` is genuinely set, proved by a child process that exits;
 *   * a malformed request line produces JSON, not Node's plain-text 400;
 *   * an over-limit body is refused as bytes arrive, not after buffering;
 *   * `closeServer` resolves against a live keep-alive connection instead of
 *     hanging for the idle timeout.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { spawnSync } = require("node:child_process");

const {
  HEADERS_TIMEOUT_MS,
  MAX_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  attachClientErrorHandler,
  closeServer,
  createRequestHandler,
  parseRequest,
  parseRequestTarget,
  readRequestBody,
  sendJson,
  startServer,
} = require(path.join(__dirname, "../server"));

const SERVER_PATH = path.join(__dirname, "../server.js");

// The shape config.js hands over. Only the two ESI fields are read by
// server.js; the rest makes the fake honest about what a real config carries,
// and catches a future accidental dependency on another field.
function configWith(overrides = {}) {
  return {
    modVersion: "0.1.0",
    esiBindHost: "127.0.0.1",
    esiPort: 0,
    ssoBindHost: "127.0.0.1",
    ssoPort: 0,
    ssoIssuer: null,
    devAutoApprove: false,
    devAutoApproveCharacterID: null,
    signingKeyPath: null,
    logLevel: "info",
    ...overrides,
  };
}

/** Start a listener for one test and guarantee it is closed afterwards. */
async function serve(t, options = {}) {
  const handle = await startServer({
    config: configWith(options.config),
    dispatch: options.dispatch || (() => ({ status: 404 })),
    log: () => {},
    logError: () => {},
    ...options,
  });
  t.after(() => handle.close());
  return handle;
}

/**
 * Fail loudly instead of hanging. `node --test` has no default per-test
 * timeout, so a `close()` that never resolves would wedge the whole suite
 * rather than report the bug.
 */
function withDeadline(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Speak HTTP by hand.
 *
 * Node's `fetch` will not send a malformed request line and will not stall
 * mid-headers, which are the two cases the listener has to survive. Resolves
 * with everything the server wrote, once it closes the connection.
 */
function rawExchange(port, payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(port, "127.0.0.1", () => {
      if (payload) socket.write(payload);
    });
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error("the server never answered the raw request"));
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function splitRawResponse(text) {
  const separator = text.indexOf("\r\n\r\n");
  assert.ok(separator > 0, `no header/body separator in: ${JSON.stringify(text)}`);
  const head = text.slice(0, separator);
  return {
    head,
    status: Number(head.split("\r\n")[0].split(" ")[1]),
    body: text.slice(separator + 4),
  };
}

// Refusing to start

test("startServer rejects rather than throwing when the wiring is wrong", async () => {
  // Rejecting rather than throwing synchronously: loader.js has one failure
  // path to handle, not two, and a throw at preload kills the game.
  await assert.rejects(() => startServer({}), /needs a parsed config/);
  await assert.rejects(() => startServer({ config: null }), /needs a parsed config/);
});

test("a listener with no dispatch behind it refuses to bind", async () => {
  // A port that is open onto nothing is not a degraded mode worth having.
  await assert.rejects(
    () => startServer({ config: configWith() }),
    /needs a dispatch function/,
  );
  await assert.rejects(
    () => startServer({ config: configWith(), dispatch: "not a function" }),
    /needs a dispatch function/,
  );
});

test("startServer rejects a config with no bind host or an impossible port", async () => {
  // Binding `undefined` listens on every interface, which on a machine running
  // a game server is not a mistake to make quietly.
  await assert.rejects(
    () => startServer({ config: configWith({ esiBindHost: undefined }), dispatch: () => ({ status: 200 }) }),
    /needs config\.esiBindHost/,
  );
  await assert.rejects(
    () => startServer({ config: configWith({ esiPort: 70000 }), dispatch: () => ({ status: 200 }) }),
    /needs a valid config\.esiPort/,
  );
  await assert.rejects(
    () => startServer({ config: configWith({ esiPort: "26005" }), dispatch: () => ({ status: 200 }) }),
    /needs a valid config\.esiPort/,
  );
});

test("createRequestHandler throws at construction without a dispatch function", () => {
  assert.throws(() => createRequestHandler({}), /needs a dispatch function/);
  assert.throws(() => createRequestHandler({ dispatch: {} }), TypeError);
});

// The two surfaces (D6)
//
// One `startServer`, two listeners. Every property checked above (the
// client-error handler, the runtime `error` listener, `unref()`, the bounded
// body, the timeouts) is a way the mod could take a game server down, and the
// SSO listener needs all of them. A second copy of the function would have to
// keep having them; a `listener` row means it does by construction, and these
// cases check the row rather than the properties.

test("an unknown listener rejects rather than binding undefined:undefined", async () => {
  await assert.rejects(
    () => startServer({ config: configWith(), dispatch: () => ({ status: 200 }), listener: "auth" }),
    /does not know a listener called "auth"/,
  );
  // The message names what it does know, so the fix does not need this file.
  await assert.rejects(
    () => startServer({ config: configWith(), dispatch: () => ({ status: 200 }), listener: "auth" }),
    /esi, sso/,
  );
});

test("the listener decides which config fields are bound, and the message names them", async () => {
  // The same two refusals as the ESI case above, following the SSO row. The
  // field name is in the message rather than the surface's label, because a
  // field is what the reader has to go and fix.
  await assert.rejects(
    () =>
      startServer({
        config: configWith({ ssoBindHost: undefined }),
        dispatch: () => ({ status: 200 }),
        listener: "sso",
      }),
    /needs config\.ssoBindHost/,
  );
  await assert.rejects(
    () =>
      startServer({
        config: configWith({ ssoPort: 70000 }),
        dispatch: () => ({ status: 200 }),
        listener: "sso",
      }),
    /needs a valid config\.ssoPort/,
  );
});

test("the SSO listener binds the SSO fields and says so in the log", async (t) => {
  const lines = [];
  const handle = await startServer({
    config: configWith({ ssoBindHost: "127.0.0.1", ssoPort: 0, esiPort: 65535 }),
    dispatch: () => ({ status: 200 }),
    listener: "sso",
    log: (message) => lines.push(message),
    logError: () => {},
  });
  t.after(() => handle.close());

  // Not the ESI port, which was set to a value it would have collided with
  // nothing on: the point is that it was never consulted.
  assert.notEqual(handle.port, 65535);
  assert.equal(handle.listener, "sso");
  assert.equal(handle.label, "SSO");

  // An honest log line. Two listeners are up in a real deployment, and one that
  // announced itself as ESI while bound to the SSO port would mislead an
  // operator debugging a port conflict.
  assert.deepEqual(lines, [`SSO listener on http://127.0.0.1:${handle.port}`]);
});

test("the default listener is ESI, so every existing call site means what it did", async (t) => {
  const lines = [];
  const handle = await startServer({
    config: configWith({ esiBindHost: "127.0.0.1", esiPort: 0, ssoPort: 65535 }),
    dispatch: () => ({ status: 200 }),
    log: (message) => lines.push(message),
    logError: () => {},
  });
  t.after(() => handle.close());

  assert.notEqual(handle.port, 65535);
  assert.equal(handle.listener, "esi");
  assert.deepEqual(lines, [`ESI listener on http://127.0.0.1:${handle.port}`]);
});

test("both listeners run at once, each answering only its own dispatch", async (t) => {
  // The shape D6 deploys: two ports, two dispatches, one implementation of the
  // socket layer. This proves the negative: the SSO surface does not answer
  // ESI's routes and vice versa, guarding against a shared route table quietly
  // reappearing.
  const esi = await serve(t, {
    dispatch: (request) => ({ status: request.pathname === "/status/" ? 200 : 404 }),
  });
  const sso = await serve(t, {
    listener: "sso",
    dispatch: (request) => ({
      status: request.pathname === "/.well-known/oauth-authorization-server" ? 200 : 404,
    }),
  });

  assert.notEqual(esi.port, sso.port);

  const get = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`)).status;

  assert.equal(await get(esi.port, "/status/"), 200);
  assert.equal(await get(esi.port, "/.well-known/oauth-authorization-server"), 404);
  assert.equal(await get(sso.port, "/.well-known/oauth-authorization-server"), 200);
  assert.equal(await get(sso.port, "/status/"), 404);
});

test("the SSO listener is unref'd and timeout-bounded like the ESI one", async (t) => {
  // Not a restatement of the ESI cases: they make this listener safe to put
  // inside a game process, and the argument for one `startServer` is that the
  // second surface cannot be missing any of them.
  const handle = await serve(t, { listener: "sso" });

  assert.equal(handle.server.requestTimeout, REQUEST_TIMEOUT_MS);
  assert.equal(handle.server.headersTimeout, HEADERS_TIMEOUT_MS);
  // The handle Node keeps for an unref'd server does not hold the loop open.
  assert.equal(handle.server.listening, true);
  assert.equal(handle.server._handle.hasRef(), false);
});

// Binding

test("the listener binds the configured host on an ephemeral port", async (t) => {
  const handle = await serve(t);

  assert.equal(handle.host, "127.0.0.1");
  assert.ok(handle.port > 0, "an ephemeral port should have been assigned");
  assert.equal(handle.server.address().address, "127.0.0.1");
  assert.equal(handle.url, `http://127.0.0.1:${handle.port}`);
});

test("a port that cannot be bound rejects with a message naming the address", async (t) => {
  const first = await serve(t);

  await assert.rejects(
    () =>
      startServer({
        config: configWith({ esiPort: first.port }),
        dispatch: () => ({ status: 200 }),
        log: () => {},
        logError: () => {},
      }),
    /could not bind 127\.0\.0\.1:\d+/,
  );
});

test("the request and headers timeouts are set on the server object", async (t) => {
  const handle = await serve(t);

  assert.equal(handle.server.requestTimeout, REQUEST_TIMEOUT_MS);
  assert.equal(handle.server.headersTimeout, HEADERS_TIMEOUT_MS);
  assert.equal(REQUEST_TIMEOUT_MS, 30_000, "30 s is the nexumApi precedent");
});

// The dispatch seam

test("what dispatch returns is what goes on the wire", async (t) => {
  const handle = await serve(t, {
    dispatch: () => ({ status: 200, headers: { "X-Pages": "3" }, body: { alive: true } }),
  });

  const response = await fetch(`${handle.url}/latest/status/`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("x-content-type-options"), null, "CCP sends no nosniff on a 2XX");
  assert.equal(response.headers.get("x-pages"), "3");
  assert.deepEqual(await response.json(), { alive: true });
});

test("a route's own header casing wins, and does not duplicate ours", async (t) => {
  // CCP's exact casing (`Etag`, `X-Pages`) must be reproduced. Merging naively
  // would put both `content-type` and `Content-Type` on the wire, which `fetch`
  // reports as one comma-joined value: a bug invisible until a client splits on
  // it.
  const handle = await serve(t, {
    dispatch: () => ({
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", Etag: 'W/"817faa26"' },
      body: [],
    }),
  });

  const response = await fetch(`${handle.url}/x`);

  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("etag"), 'W/"817faa26"');
});

test("an unknown path is a bodiless 404, not an HTML page and not a JSON null", async (t) => {
  // `{ status: 404 }` is the shape the contract names for an unknown path.
  // Claiming a JSON body that is not there would be worse than saying nothing.
  const handle = await serve(t, { dispatch: () => ({ status: 404 }) });

  const response = await fetch(`${handle.url}/nope`);

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-length"), "0");
  assert.equal(response.headers.get("content-type"), null);
  assert.equal(await response.text(), "");
});

test("a 204 is written with no body and no content-length at all", async (t) => {
  // The waypoint write's shape, and a framing bug a route author could not
  // see: `lib/router.js` returns `body: null` for a declared 204, and a `null`
  // reaching the JSON writer would serialize the four bytes `null` and frame
  // them with a `content-length`, on a response RFC 9110 says must carry
  // neither. The status decides this, not the shape of `body`.
  const handle = await serve(t, {
    dispatch: () => ({ status: 204, body: null, producer: "app" }),
  });

  const response = await fetch(`${handle.url}/latest/ui/autopilot/waypoint/`, { method: "POST" });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("content-type"), null);
  assert.equal(await response.text(), "");
});

test("a dispatch that throws becomes a logged 500", async (t) => {
  const logged = [];
  const handle = await serve(t, {
    dispatch: () => {
      throw new Error("boom, synchronously");
    },
    logError: (message, err) => logged.push([message, err && err.message]),
  });

  const response = await fetch(`${handle.url}/latest/status/`);

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.match((await response.json()).error, /See the server log/);
  assert.deepEqual(logged, [["dispatch failed for GET /latest/status/", "boom, synchronously"]]);
});

test("a dispatch that rejects becomes a logged 500", async (t) => {
  // Separate from the throwing case on purpose: a rejected promise is the one
  // that reaches eve.js's ProcessLifecycle as a fatal unhandled rejection if the
  // `await` in the handler is ever refactored away.
  const logged = [];
  const handle = await serve(t, {
    dispatch: async () => {
      throw new Error("boom, asynchronously");
    },
    logError: (message, err) => logged.push([message, err && err.message]),
  });

  const response = await fetch(`${handle.url}/latest/status/`);

  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /See the server log/);
  assert.deepEqual(logged, [["dispatch failed for GET /latest/status/", "boom, asynchronously"]]);
});

test("neither a throwing nor a rejecting dispatch escapes as an unhandled rejection", async (t) => {
  // The property, observed directly rather than inferred from the 500. An
  // unhandled rejection inside the game process is fatal, so "it answered 500"
  // is necessary but not sufficient.
  const escaped = [];
  const capture = (reason) => escaped.push(reason);
  process.on("unhandledRejection", capture);
  t.after(() => process.removeListener("unhandledRejection", capture));

  const thrower = await serve(t, {
    dispatch: () => {
      throw new Error("sync");
    },
  });
  const rejecter = await serve(t, {
    dispatch: () => Promise.reject(new Error("async")),
  });
  const nonsense = await serve(t, { dispatch: () => "not a result at all" });

  await fetch(`${thrower.url}/a`);
  await fetch(`${rejecter.url}/b`);
  await fetch(`${nonsense.url}/c`);

  // Unhandled-rejection detection is deferred to the end of the microtask
  // queue plus a macrotask, so give it one.
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(escaped, [], "nothing may reach the process as an unhandled rejection");
});

test("a dispatch that answers with something other than { status } is a logged 500", async (t) => {
  const logged = [];
  const handle = await serve(t, {
    dispatch: () => ({ body: { oops: true } }),
    logError: (message) => logged.push(message),
  });

  const response = await fetch(`${handle.url}/x`);

  assert.equal(response.status, 500);
  assert.deepEqual(logged, ["dispatch returned no usable status for GET /x"]);
});

// Request parsing

test("dispatch receives { method, pathname, query, headers, rawBody, body }", async (t) => {
  const handle = await serve(t, {
    dispatch: (request) => ({
      status: 200,
      body: {
        method: request.method,
        pathname: request.pathname,
        query: request.query,
        contentType: request.headers["content-type"],
        rawBodyIsBuffer: Buffer.isBuffer(request.rawBody),
        rawBodyText: request.rawBody.toString("utf8"),
        body: request.body,
      },
    }),
  });

  const response = await fetch(`${handle.url}/latest/universe/names/?datasource=tranquility`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([90000001, 30000142]),
  });

  assert.deepEqual(await response.json(), {
    method: "POST",
    pathname: "/latest/universe/names/",
    query: { datasource: "tranquility" },
    contentType: "application/json",
    rawBodyIsBuffer: true,
    rawBodyText: "[90000001,30000142]",
    body: [90000001, 30000142],
  });
});

test("a body that is not JSON arrives as null with the bytes still attached", async (t) => {
  // Deliberate: "malformed input" is an ESI error shape (400 here, 422 with
  // details[] there) and the socket layer must not pre-empt that decision with a
  // shape the routes would have to discard. `rawBody` lets a route tell absent
  // from malformed.
  const handle = await serve(t, {
    dispatch: (request) => ({
      status: 200,
      body: { body: request.body, rawBodyText: request.rawBody.toString("utf8") },
    }),
  });

  const response = await fetch(`${handle.url}/x`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{oops",
  });

  assert.equal(response.status, 200, "the socket layer must not decide this is a 400");
  assert.deepEqual(await response.json(), { body: null, rawBodyText: "{oops" });
});

test("a request target is split into a method, a pathname and a query object", () => {
  assert.deepEqual(parseRequestTarget({ method: "get", url: "/things?a=1&b=2" }), {
    method: "GET",
    pathname: "/things",
    query: { a: "1", b: "2" },
  });
  assert.deepEqual(parseRequestTarget({ url: "/" }), {
    method: "GET",
    pathname: "/",
    query: {},
  });
  assert.equal(parseRequestTarget({}).pathname, "/");
});

test("a repeated query key keeps the last value rather than becoming an array", () => {
  // Shape stability matters more than expressiveness: a handler should never
  // have to check whether a parameter arrived as a string or as a list.
  assert.deepEqual(parseRequestTarget({ url: "/x?id=1&id=2" }).query, { id: "2" });
});

test("the pathname is left percent-encoded for the router to decide about", () => {
  // Decoding here would merge %2F into a path separator before anything could
  // object to it.
  assert.equal(parseRequestTarget({ url: "/latest/a%2Fb/" }).pathname, "/latest/a%2Fb/");
});

test("a target the URL parser refuses yields a null pathname, never a fabricated one", () => {
  // `GET // HTTP/1.1` is a valid request line that is not a valid URL. Routing
  // it to `/` would hand a malformed request to a real handler.
  assert.deepEqual(parseRequestTarget({ url: "//" }), {
    method: "GET",
    pathname: null,
    query: {},
  });
});

test("an unparseable request target is answered with JSON, and dispatch never sees it", async (t) => {
  let dispatched = 0;
  const handle = await serve(t, {
    dispatch: () => {
      dispatched += 1;
      return { status: 200, body: {} };
    },
  });

  const raw = await rawExchange(handle.port, "GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
  const response = splitRawResponse(raw);

  assert.equal(response.status, 400);
  assert.match(response.head, /content-type: application\/json/i);
  assert.match(JSON.parse(response.body).error, /not a valid URL/);
  assert.equal(dispatched, 0);
});

// The body cap

test("readRequestBody stops reading at the limit instead of buffering the rest", async () => {
  // The wire test cannot see this: crossing the cap pauses the stream and
  // settles immediately, so an oversized body costs one chunk of memory rather
  // than all of it. A fake request is used because a real one would need a real
  // oversized upload to prove the same thing less precisely.
  const req = new EventEmitter();
  const consumed = [];
  let paused = 0;
  req.pause = () => {
    paused += 1;
  };

  const pending = readRequestBody(req, { limit: 64 });

  const emit = (bytes) => {
    const chunk = Buffer.alloc(bytes, "x");
    consumed.push(bytes);
    req.emit("data", chunk);
  };

  emit(32);
  emit(64); // crosses the 64-byte cap
  emit(1024); // must be ignored: the answer is already decided
  req.emit("end"); // must not resolve over the rejection

  await assert.rejects(pending, /exceeds 64 bytes/);
  assert.equal(paused, 1, "the stream must be paused, not left to drain");
  assert.deepEqual(consumed, [32, 64, 1024]);
});

test("readRequestBody resolves an absent body as an empty buffer", async () => {
  const req = new EventEmitter();
  const pending = readRequestBody(req);
  req.emit("end");

  const body = await pending;
  assert.ok(Buffer.isBuffer(body));
  assert.equal(body.length, 0);
});

test("readRequestBody rejects once when the client disappears mid-body", async () => {
  const req = new EventEmitter();
  const pending = readRequestBody(req);

  req.emit("data", Buffer.from("half a "));
  req.emit("aborted");
  req.emit("end"); // a late 'end' must not resolve an already-rejected promise

  await assert.rejects(pending, /aborted/);
});

test("an over-limit body is refused with a 413, in JSON", async (t) => {
  const handle = await serve(t, {
    bodyLimit: 64,
    dispatch: () => ({ status: 200, body: {} }),
  });

  const response = await fetch(`${handle.url}/latest/universe/names/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(4096),
  });

  assert.equal(response.status, 413);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.match((await response.json()).error, /exceeds 64 bytes/);
});

test("the default cap is 64 KiB, generous for POST /universe/names/, small enough to be safe", () => {
  assert.equal(MAX_BODY_BYTES, 64 * 1024);
});

// Never HTML

test("a malformed request line produces JSON, not Node's plain-text 400", async (t) => {
  // Node answers this one on our behalf, in plain text, unless we take it over.
  // Every consumer of this port parses JSON.
  const handle = await serve(t);

  const raw = await rawExchange(handle.port, "NOT-A-REQUEST\r\n\r\n");
  const response = splitRawResponse(raw);

  assert.equal(response.status, 400);
  assert.match(response.head, /content-type: application\/json\r/i);
  assert.match(response.head, /x-content-type-options: nosniff/i);
  assert.match(response.head, /connection: close/i);
  assert.doesNotMatch(raw, /<html|<!doctype/i);
  assert.doesNotMatch(raw, /text\/plain/i);
  assert.deepEqual(JSON.parse(response.body), { error: "Malformed HTTP request." });
  assert.equal(
    Number(/content-length: (\d+)/i.exec(response.head)[1]),
    Buffer.byteLength(response.body, "utf8"),
    "the declared length must match the body actually written",
  );
});

test("a client that stalls mid-headers hits headersTimeout and is told so in JSON", async (t) => {
  // headersTimeout guards against a socket held open inside the game process by
  // a client that never finishes asking. requestTimeout is left long so that a
  // 408 can only have come from the headers timer. The connection sweep is
  // tightened because neither timeout is a per-connection timer: Node expires
  // overdue sockets when it next looks, 30 s apart by default, which is longer
  // than this suite will wait.
  const handle = await serve(t, {
    headersTimeout: 200,
    requestTimeout: 5000,
    connectionsCheckingInterval: 50,
  });

  const started = Date.now();
  const raw = await rawExchange(handle.port, "GET /latest/status/ HTTP/1.1\r\nHost: x\r\n");
  const response = splitRawResponse(raw);
  const elapsed = Date.now() - started;

  assert.equal(response.status, 408);
  assert.match(response.head, /content-type: application\/json/i);
  assert.doesNotMatch(raw, /<html|<!doctype/i);
  assert.match(JSON.parse(response.body).error, /not completed in time/);
  assert.ok(elapsed < 4000, `the headers timer should have fired, not the request timer (${elapsed}ms)`);
});

test("attachClientErrorHandler distinguishes a dead socket, a timeout and garbage", () => {
  // Read directly, without a listener, because the three branches are hard to
  // provoke on the wire and the difference between them is the point: 408 is
  // "you were slow", 400 is "that was not HTTP", and a reset socket has nobody
  // left to answer to.
  const server = new EventEmitter();
  attachClientErrorHandler(server, { logError: () => {} });

  const fakeSocket = () => {
    const written = [];
    let destroyed = 0;
    return {
      socket: {
        destroyed: false,
        writable: true,
        end: (text) => written.push(text),
        destroy: () => {
          destroyed += 1;
        },
      },
      written,
      destroyCount: () => destroyed,
    };
  };

  const garbage = fakeSocket();
  server.emit("clientError", { code: "HPE_INVALID_METHOD" }, garbage.socket);
  assert.match(garbage.written[0], /^HTTP\/1\.1 400 Bad Request\r\n/);

  const slow = fakeSocket();
  server.emit("clientError", { code: "ERR_HTTP_REQUEST_TIMEOUT" }, slow.socket);
  assert.match(slow.written[0], /^HTTP\/1\.1 408 Request Timeout\r\n/);

  const reset = fakeSocket();
  server.emit("clientError", { code: "ECONNRESET" }, reset.socket);
  assert.deepEqual(reset.written, [], "nothing may be written to a reset socket");
  assert.equal(reset.destroyCount(), 1);

  const gone = fakeSocket();
  gone.socket.destroyed = true;
  server.emit("clientError", { code: "HPE_INVALID_METHOD" }, gone.socket);
  assert.deepEqual(gone.written, []);
});

test("sendJson is a no-op once the response has been written", () => {
  // Reachable in production: an error path can run after a partial success, and
  // a second writeHead would be an ERR_HTTP_HEADERS_SENT throw inside the game.
  const written = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead: (status, headers) => {
      written.push([status, headers]);
      res.headersSent = true;
    },
    end: () => {
      res.writableEnded = true;
    },
  };

  sendJson(res, 200, { a: 1 });
  sendJson(res, 500, { error: "too late" });

  assert.equal(written.length, 1);
  assert.equal(written[0][0], 200);
  // 7 bytes of JSON and the newline. With no producer named, sendJson writes as
  // the gateway, because the bodies server.js invents are refusals made before
  // any route is reached, which is where CCP's gateway answers. A route's
  // producer arrives on its result.
  assert.equal(written[0][1]["Content-Length"], "8");
  assert.equal(written[0][1]["Content-Type"], "application/json");
});

test("a body that cannot be serialised still answers, as a 500", () => {
  const written = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead: (status) => {
      written.push(status);
      res.headersSent = true;
    },
    end: () => {},
  };

  const circular = {};
  circular.self = circular;
  sendJson(res, 200, circular);

  assert.deepEqual(written, [500]);
});

// Not keeping the process alive

test("the listener does not keep the process alive on its own", () => {
  // It is unref'd, so a node process whose only handle is this listener exits.
  // Getting this wrong would hold the game process open after shutdown, and
  // hang this suite.
  const script = `
    const { startServer } = require(${JSON.stringify(SERVER_PATH)});
    startServer({
      config: { esiBindHost: "127.0.0.1", esiPort: 0 },
      dispatch: () => ({ status: 404 }),
      log: () => {},
      logError: () => {},
    }).then((handle) => console.log("listening on " + handle.port));
  `;

  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 });

  assert.equal(result.signal, null, "the process should exit on its own, not be killed");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /listening on \d+/);
});

test("unref is unconditional: there is no keep-alive escape hatch to pass", () => {
  // A "keep the process alive for tests" flag is how the property quietly stops
  // being true in production, so the API offers none.
  const script = `
    const { startServer } = require(${JSON.stringify(SERVER_PATH)});
    startServer({
      config: { esiBindHost: "127.0.0.1", esiPort: 0 },
      dispatch: () => ({ status: 404 }),
      keepProcessAlive: true,
      keepAlive: true,
      unref: false,
      log: () => {},
      logError: () => {},
    }).then(() => console.log("started"));
  `;

  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 10_000 });

  assert.equal(result.signal, null, "no option may make the listener hold the loop open");
  assert.equal(result.status, 0, result.stderr);
});

// Shutdown

test("close() resolves against a live keep-alive connection rather than hanging", async (t) => {
  // `close()` alone waits for idle connections to time out: thirty seconds of a
  // game server trying to exit. `closeAllConnections()` makes it immediate, and
  // this test notices if it is dropped.
  const handle = await serve(t, { dispatch: () => ({ status: 200, body: { ok: true } }) });

  // Node's fetch pools its sockets, so this leaves a real idle keep-alive
  // connection behind, which is what stalls a naive close.
  const response = await fetch(`${handle.url}/x`);
  await response.json();
  assert.equal(response.headers.get("connection"), "keep-alive");

  await withDeadline(handle.close(), 3000, "close() hung on an idle keep-alive connection");
});

test("closeServer takes either the handle or a bare server, and is safe to call twice", async () => {
  const handle = await startServer({
    config: configWith(),
    dispatch: () => ({ status: 404 }),
    log: () => {},
    logError: () => {},
  });

  await withDeadline(closeServer(handle), 3000, "closeServer(handle) hung");
  // An already-closed server reports that by passing an error to its callback.
  // Rejecting there would hand the caller a failure during shutdown, when there
  // is nothing left to do about it.
  await withDeadline(closeServer(handle.server), 3000, "closeServer(server) hung on a closed server");
  await withDeadline(closeServer(undefined), 3000, "closeServer(undefined) hung");
});

test("close() releases the port", async () => {
  const first = await startServer({
    config: configWith(),
    dispatch: () => ({ status: 404 }),
    log: () => {},
    logError: () => {},
  });
  const port = first.port;
  await first.close();

  // Binding the same port again proves it was released.
  const second = await startServer({
    config: configWith({ esiPort: port }),
    dispatch: () => ({ status: 404 }),
    log: () => {},
    logError: () => {},
  });
  assert.equal(second.port, port);
  await second.close();
});

test("an error on the listener after it is up is logged, not thrown", async (t) => {
  // An unhandled 'error' event is a process-level throw in Node, which inside
  // eve.js is a dead game server.
  const logged = [];
  const handle = await serve(t, { logError: (message, err) => logged.push([message, err.message]) });

  handle.server.emit("error", new Error("something went wrong later"));

  assert.deepEqual(logged, [["listener error", "something went wrong later"]]);
});

// The handler in isolation

test("createRequestHandler can be driven without opening a port", async () => {
  // The seam that keeps the rest of the mod testable: no socket, no listener,
  // no config, just a request in and a response out.
  const handler = createRequestHandler({
    dispatch: (request) => ({ status: 200, body: { saw: request.pathname } }),
    log: () => {},
    logError: () => {},
  });

  const req = new EventEmitter();
  req.method = "GET";
  req.url = "/latest/status/";
  req.headers = {};

  const written = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead: (status, headers) => {
      written.push({ status, headers });
      res.headersSent = true;
    },
    end: (payload) => {
      res.writableEnded = true;
      written[written.length - 1].payload = payload ? payload.toString("utf8") : "";
    },
  };

  handler(req, res);
  req.emit("end");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(written.length, 1);
  assert.equal(written[0].status, 200);
  assert.deepEqual(JSON.parse(written[0].payload), { saw: "/latest/status/" });
});

test("parseRequest is usable directly against an http.IncomingMessage", async (t) => {
  // Proves the exported helper and the listener agree, rather than the listener
  // having its own private parse.
  let seen = null;
  const server = http.createServer((req, res) => {
    parseRequest(req, { limit: 1024 }).then((request) => {
      seen = request;
      res.writeHead(204, { "content-length": "0" });
      res.end();
    });
  });
  server.unref();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));

  await fetch(`http://127.0.0.1:${server.address().port}/v4/characters/90000001/?x=1`, {
    method: "POST",
    body: '{"a":1}',
  });

  assert.equal(seen.method, "POST");
  assert.equal(seen.pathname, "/v4/characters/90000001/");
  assert.deepEqual(seen.query, { x: "1" });
  assert.deepEqual(seen.body, { a: 1 });
  assert.equal(seen.rawBody.toString("utf8"), '{"a":1}');
  assert.equal(typeof seen.headers.host, "string");
});
