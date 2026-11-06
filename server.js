/**
 * eve.js-mod-esi: HTTP listener
 *
 * The socket layer only. This file turns an `http.IncomingMessage` into a plain
 * `{ method, pathname, query, headers, rawBody, body }` object, hands it to an
 * injected `dispatch`, and turns the `{ status, headers, body }` that comes back
 * into bytes. Routing, version prefixes, error shapes, caching, pagination, CORS and
 * rate limiting all live behind `dispatch`.
 *
 * It serves both listeners. D6 puts ESI and SSO on two ports, and the difference
 * between them is the injected `dispatch` and one row of the `LISTENERS` table below.
 *
 * It requires nothing from the eve.js vendor tree, which would make the listener
 * untestable without a game checkout and put game code on the socket layer's critical
 * path. Game state is reached through lib/runtimeAccess.js, by whoever builds `dispatch`.
 *
 * Four required properties, each of which guards against the mod harming the game server:
 *
 * It cannot take the game down. It runs inside the eve.js process, and eve.js's
 * ProcessLifecycle treats an unhandled rejection as fatal. So a throwing or rejecting
 * handler, a malformed request or a client that hangs up mid-response must not escape as
 * one. The request path is wrapped twice: `handleRequest` catches inside, and the
 * `(req, res)` function Node calls attaches a `.catch()` to what comes back, because Node
 * ignores a listener's return value. The fallback that writes the 500 is itself wrapped,
 * in case writing the error response is what failed.
 *
 * It cannot keep the process alive. `server.unref()` is unconditional: the game server's
 * own handles hold the event loop open, and if they go away the mod must not keep node
 * running. There is deliberately no opt-out flag, because a test-only escape hatch could
 * make the property false in production.
 *
 * It never emits HTML. Node's own answer to a malformed request line is plain text, and an
 * intermediary's error page is HTML, while every consumer of this port parses JSON.
 * `attachClientErrorHandler` takes over the one path where Node would answer for us and
 * writes JSON straight to the socket.
 *
 * It does not block the event loop, which is the one the game ticks on. Nothing here is
 * O(game state): the body is capped as bytes arrive, the only parse is of that capped
 * buffer, and work proportional to the universe belongs behind `dispatch`, where it can be
 * streamed.
 *
 * What this file deliberately does not do:
 *
 *   * No success or failure envelope. nexumApi's `{ok, apiVersion, source}` and
 *     `{ok:false, error:"CODE"}` shapes are discarded on purpose; real ESI has neither. The
 *     bodies this file emits on its own (400, 408, 413, 500) use the bare `{"error":
 *     "..."}` that ESI itself uses.
 *   * No default `cache-control`. nexumApi put `no-store` on everything; real ESI publishes
 *     per-route TTLs that clients poll against. A route that wants caching headers returns
 *     them.
 *   * No opinion about status codes beyond the transport-level ones above. `{ status: 404
 *   }`
 *     from `dispatch` is written as a bodiless 404; the 19-byte `404 page not found` real
 *     ESI sends for an unrouted path is a routing decision, made where routing lives.
 */

"use strict";

const http = require("node:http");

const { PRODUCER, contentTypeFor, serializeBody } = require("./lib/serialize");
const { withCcpCasing } = require("./lib/headers");

const LOG_PREFIX = "[EsiApiMod]";

// The largest legitimate body on the target surface is `POST /latest/universe/names/`,
// capped by CCP at 1000 integer IDs: a few tens of kilobytes at worst. 64 KiB is generous
// for that and small enough that an over-limit body costs one chunk of memory rather than
// all of it.
const MAX_BODY_BYTES = 64 * 1024;

// Node's default request timeout is 300 s. Nothing on this port is slow, and a stalled
// request holds a socket open inside the game process. 30 s is the nexumApi precedent.
//
// Bulk transfers are the exception (nexumApi's static-table route hit this at ~640k of 643k
// rows). If the replica grows an SDE download route, the exemption belongs on that one
// response (`res.setTimeout(0)` plus `connection: close`), never on the server object,
// which would make it global.
const REQUEST_TIMEOUT_MS = 30 * 1000;

// Separate from REQUEST_TIMEOUT_MS though currently equal: they guard different things
// (time to finish sending headers, time to finish the whole request), and Node clamps
// headersTimeout to requestTimeout when the former is larger. Equal is the safe pairing.
const HEADERS_TIMEOUT_MS = 30 * 1000;

// Neither timeout above is a per-connection timer. Node sweeps its connection list on an
// interval, 30 s by default, and expires what is overdue when it looks, so a 30 s timeout
// really means between 30 and 60 s. Node's default is kept because the sweep runs on the
// game's event loop and the difference for a stalled socket is not worth a more frequent
// timer. It is an option so a test need not wait 30 s to prove the timeouts are wired up.
const CONNECTIONS_CHECKING_INTERVAL_MS = 30 * 1000;

// The producer for the bodies this file writes itself: the malformed request, the timeout,
// the oversized body, the 500. These are refusals made before any route is reached, where
// CCP's gateway answers, so they are written as the gateway writes: bare `application/json`
// and a trailing newline. Design constraint 3: fidelity beats hygiene.
//
// There is no constant `content-type` for routes. ESI's 2XX path is two implementations
// that spell the header differently and disagree about a trailing newline, and which one
// answers is a property of the route. So the header comes from the producer on the result,
// through `lib/serialize.js`.
//
// Observed against CCP:
//
//   - `x-content-type-options: nosniff` is not sent on any 2XX. It appears on gateway
//   refusals (401,
//     `Invalid tenant`) and on Go's unrouted 404, which is why the malformed-request path
//     below still writes it.
//   - `GET /status/` sends `application/json` with no charset parameter. That does not
//   generalise to
//     every route.
const TRANSPORT_PRODUCER = PRODUCER.GATEWAY;

// Statuses that cannot carry a body and must not carry `content-length` either. 204 is the
// CORS preflight and 304 the conditional-request answer; this replica sends both, and an
// intermediary will mangle either if the framing headers are wrong.
const BODILESS_STATUSES = new Set([204, 304]);

// A relative request target needs a base to be parsed. The base is discarded (only pathname
// and query are used), so it is a name that can never resolve, to make it obvious as a
// placeholder in a stack trace.
const URL_BASE = "http://esi.invalid";

/**
 * The listener surfaces this mod can bind, and everything that differs between them.
 *
 * D6 puts ESI and SSO on two listeners on two ports, each owning the root of its own
 * origin, and both need every property this file has: the client-error handler, the runtime
 * `error` listener, `unref()`, the bounded body, the timeouts. A copy of `startServer`
 * would let those properties drift.
 *
 * So a surface is a row in this table, named by `startServer`'s `listener` option, stating
 * which two config fields it binds and what it calls itself in the log. Keeping them in one
 * row means a caller cannot pass a combination that does not exist.
 */
const LISTENERS = Object.freeze({
  esi: Object.freeze({ label: "ESI", hostField: "esiBindHost", portField: "esiPort" }),
  sso: Object.freeze({ label: "SSO", hostField: "ssoBindHost", portField: "ssoPort" }),
});

/**
 * The surface `startServer` binds when it is not told otherwise: ESI. A caller that wants
 * the other one names it.
 */
const DEFAULT_LISTENER = "esi";

// Node reports both `headersTimeout` and `requestTimeout` expiry through
// `clientError` under this code.  It is the one clientError that is not the
// client sending garbage, so it gets 408 rather than 400.
const TIMEOUT_ERROR_CODES = new Set(["ERR_HTTP_REQUEST_TIMEOUT", "HPE_HEADERS_TIMEOUT"]);

/**
 * A transport-level refusal carrying the status it should be answered with.
 *
 * Not exported: `status` is its whole contract, and nothing outside this file should
 * construct one. `dispatch` reports its failures by returning a status, not by throwing.
 */
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

// Default logging
// console only. The game's logger lives in server/src, and requiring it here would break
// this file's rule of never touching the vendor tree.

function defaultLog(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function defaultLogError(message, err) {
  console.error(`${LOG_PREFIX} ${message}`);
  if (err && err.stack) console.error(err.stack);
}

// Request parsing

/**
 * Split a request into `{ method, pathname, query }`.
 *
 * `pathname` is left percent-encoded. Decoding is a routing decision (ESI path segments are
 * numeric IDs, and a route that wants a decoded segment can decode it), and decoding here
 * would merge `%2F` into a path separator.
 *
 * Never throws. A target the URL parser refuses yields `pathname: null`, which the request
 * handler answers with a 400; a fabricated `/` would route a malformed request to a real
 * handler.
 *
 * @param {object} req  an http.IncomingMessage, or anything with `method`/`url`
 * @returns {{ method: string, pathname: string|null, query: object }}
 */
function parseRequestTarget(req) {
  const method = String((req && req.method) || "GET").toUpperCase();

  let parsed;
  try {
    parsed = new URL(String((req && req.url) || "/"), URL_BASE);
  } catch (_) {
    return { method, pathname: null, query: {} };
  }

  // Last value wins for a repeated key, so a handler never checks whether a parameter arrived
  // as a string or a list. Real ESI takes comma-separated values for the few plural
  // parameters.
  const query = {};
  for (const [key, value] of parsed.searchParams) {
    query[key] = value;
  }

  return { method, pathname: parsed.pathname, query };
}

/**
 * Read the body, refusing anything over the cap.
 *
 * The cap is enforced as bytes arrive: crossing it pauses the stream and rejects
 * immediately, so an oversized body costs one chunk of memory instead of all of it. Without
 * the `pause()` the client keeps sending into a socket whose answer is already decided.
 *
 * Resolves to a Buffer, empty when there is no body. Rejects with a `RequestError` carrying
 * 413 past the limit, and with the underlying error when the client disappears mid-body.
 *
 * @param {object} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<Buffer>}
 */
function readRequestBody(req, options = {}) {
  const limit =
    Number.isInteger(options.limit) && options.limit > 0 ? options.limit : MAX_BODY_BYTES;

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    // Every listener below can fire after the promise has settled: 'end' arrives after
    // 'aborted', and a paused stream still emits its queued 'data'. Settling once keeps a late
    // event from being an unhandled rejection on an already-resolved promise.
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        if (typeof req.pause === "function") req.pause();
        finish(reject, new RequestError(413, `Request body exceeds ${limit} bytes.`));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => finish(resolve, Buffer.concat(chunks)));
    req.on("error", (err) => finish(reject, err));
    req.on("aborted", () => finish(reject, new Error("Client aborted the request.")));
  });
}

/**
 * Parse a body buffer as JSON, or answer `null`.
 *
 * Never throws. A body that is not JSON is `body: null` with `rawBody` still carrying the
 * bytes, rather than a 400 from the socket layer: "malformed input" is an ESI error shape,
 * and real ESI does not answer all of them the same way (400 vs. 422 with `details[]`). A
 * route can tell absent from malformed by looking at `rawBody`.
 */
function parseJsonBody(buffer) {
  if (!buffer || buffer.length === 0) return null;

  const text = buffer.toString("utf8").trim();
  if (text === "") return null;

  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/**
 * Turn an `http.IncomingMessage` into the plain object `dispatch` receives.
 *
 * `headers` is Node's own lowercased header bag, passed by reference: it is read-only by
 * convention and copying it on every request has no benefit.
 *
 * @param {object} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{method:string, pathname:string, query:object, headers:object, rawBody:Buffer, body:*}>}
 */
/**
 * The socket's peer address, or `null`.
 *
 * The error limiter keys its bucket on the caller, a property of the connection rather than
 * of anything the client wrote. Read here because this file is the only one with a socket,
 * and defensively because a `req` built by a test has none.
 *
 * Deliberately not `X-Forwarded-For`. Any client can set that header, so honouring it would
 * let a single caller mint a fresh error budget per request by varying it. A deployment
 * behind a trusted proxy needs that trust configured by an operator before the header can
 * mean anything.
 */
function remoteAddressOf(req) {
  const socket = req && (req.socket || req.connection);
  const address = socket && socket.remoteAddress;
  return typeof address === "string" && address !== "" ? address : null;
}

async function parseRequest(req, options = {}) {
  const target = parseRequestTarget(req);
  if (target.pathname === null) {
    throw new RequestError(400, "The request target is not a valid URL.");
  }

  // The body is drained for every method, including GET. A GET with a body is legal, some
  // clients send an empty one unprompted, and bytes left unread in the socket corrupt the
  // next request on a keep-alive connection. Requests with no body end immediately, so this
  // costs a microtask.
  const rawBody = await readRequestBody(req, options);

  return {
    method: target.method,
    pathname: target.pathname,
    query: target.query,
    headers: (req && req.headers) || {},
    remoteAddress: remoteAddressOf(req),
    rawBody,
    body: parseJsonBody(rawBody),
  };
}

// Response writing

/**
 * Merge header objects case-insensitively, last writer winning.
 *
 * HTTP header names are case-insensitive but Node writes whatever key it is given, so
 * `{"content-type": ...}` merged naively with `{"Content-Type": ...}` puts both on the
 * wire. Fidelity needs exact casing (CCP sends `Etag`, `X-Pages`), so a route's casing is
 * what survives.
 */
function mergeHeaders(base, extra) {
  const merged = { ...base };
  if (extra && typeof extra === "object") {
    for (const key of Object.keys(extra)) {
      const lower = key.toLowerCase();
      for (const existing of Object.keys(merged)) {
        if (existing !== key && existing.toLowerCase() === lower) delete merged[existing];
      }
      merged[key] = extra[key];
    }
  }

  // The last thing that happens to a header name before it reaches a socket. Every layer
  // above keys headers in lowercase, which allows the de-duplication above; CCP spells
  // several otherwise, and a client that string-compares `Etag` reads nothing from an `etag`.
  // Applied here, once, so no layer has to remember.
  return withCcpCasing(merged);
}

/**
 * Write a JSON response.
 *
 * Idempotent: a second call on a response already written is a no-op rather than an
 * `ERR_HTTP_HEADERS_SENT` throw, because the error paths in this file can be reached after
 * a partial success.
 *
 * The bytes belong to `lib/serialize.js`: bare bodies, no envelope, Sets already flattened,
 * and the producer's trailing newline or not. This file handles the socket: the framing
 * header, the idempotence guard, and a body that cannot be turned into bytes.
 *
 * `producer` decides the `content-type` and the last byte together, from one row in
 * `lib/serialize.js`, so they cannot be set to a combination CCP never sends. It defaults
 * to this file's own, which is right for bodies this file invents; a route's producer
 * arrives on its result, and `sendResult` passes it through.
 */
/**
 * Write bytes that are already decided, with the framing header that describes them.
 *
 * Shared by `sendJson` and the `result.payload` path in `sendResult`, so a response whose
 * bytes were produced upstream (by `lib/cache.js`, which serializes the body to digest it
 * for the `Etag`) is framed by the same code.
 */
function writeSerialized(res, status, payload, contentType, headers) {
  res.writeHead(
    status,
    mergeHeaders({ "content-type": contentType, "content-length": String(payload.length) }, headers),
  );
  res.end(payload);
}

function sendJson(res, status, body, headers, producer = TRANSPORT_PRODUCER) {
  if (!res || res.writableEnded || res.headersSent || res.destroyed) return;

  let payload;
  let contentType;
  try {
    payload = serializeBody(body, producer);
    contentType = contentTypeFor(producer);
  } catch (_) {
    // A body that cannot be serialised, or a route that never declared which implementation it
    // imitates, is a bug behind `dispatch`, not a reason to leave the client hanging on an open
    // socket.
    payload = serializeBody({ error: "The response body could not be serialised." }, TRANSPORT_PRODUCER);
    contentType = contentTypeFor(TRANSPORT_PRODUCER);
    status = 500;
  }

  writeSerialized(res, status, payload, contentType, headers);
}

/**
 * Write whatever `dispatch` returned.
 *
 * A result with no `body`, or whose status cannot carry one, is written as a bodiless
 * response: an explicit `content-length: 0` and no `content-type`. `{ status: 404 }` is
 * that shape, and so is the router's `405`, so this is a common case. A `204` and a `304`
 * drop the `content-length` as well (see the branch).
 *
 * A `body` that is already a string or a Buffer is written verbatim, with whatever
 * `content-type` the result declares and no JSON encoding. An unrouted path is Go's `404
 * page not found` as `text/plain`, and `GET /ping` is two bytes of `ok`; encoding those
 * would add quotes and change the byte count. The rules for JSON bodies (bare snake_case,
 * no envelope) are in `lib/serialize.js`, which `sendJson` below goes through.
 *
 * A result's `producer` names which of ESI's two implementations wrote the body. It is
 * carried, not guessed: the router puts the route's on every 2XX and `lib/errors.js` puts
 * the family's on every refusal. A verbatim `body` does not need one, because its bytes are
 * already decided, newline included.
 */
function sendResult(res, result) {
  if (!res || res.writableEnded || res.headersSent || res.destroyed) return;

  // The status decides this, not only the absence of a body. A `204` route returns `null`
  // rather than `undefined` (`lib/router.js` sets the field explicitly), and a `null`
  // reaching `sendJson` below would serialize the four bytes `null` and frame them with a
  // `content-length` on a response that must have neither. Reading the status does not depend
  // on every producer of a result spelling absence the same way.
  if (result.body === undefined || BODILESS_STATUSES.has(result.status)) {
    // A 204 or a 304 carries no `content-length`: RFC 9110 says a server must not send one, and
    // CCP does not (its CORS preflight is seven header lines, and that is not among them). Node
    // will not strip it, so the bodiless branch must distinguish a zero-length body from a
    // status that cannot have one.
    const headers = BODILESS_STATUSES.has(result.status)
      ? {}
      : { "content-length": "0" };

    res.writeHead(result.status, mergeHeaders(headers, result.headers));
    res.end();
    return;
  }

  if (typeof result.body === "string" || Buffer.isBuffer(result.body)) {
    const payload = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body, "utf8");
    res.writeHead(
      result.status,
      mergeHeaders({ "content-length": String(payload.length) }, result.headers),
    );
    res.end(payload);
    return;
  }

  // Already serialized upstream. `lib/cache.js` turns the body into bytes to digest them for
  // the `Etag` and passes them on, which avoids a second full pass over an 8000-element array
  // on the game's event loop.
  if (Buffer.isBuffer(result.payload)) {
    writeSerialized(
      res,
      result.status,
      result.payload,
      contentTypeFor(result.producer),
      result.headers,
    );
    return;
  }

  sendJson(res, result.status, result.body, result.headers, result.producer);
}

/**
 * Take over Node's answer to a request it could not parse.
 *
 * This is the one path where Node replies on our behalf, and its reply is `text/plain`.
 * Replacing it makes "everything from this port is JSON" true.
 *
 * The response is assembled by hand because the failure happened before Node built a
 * `ServerResponse`: there is only a raw socket.
 *
 * Three cases:
 *   * the socket is already gone (`ECONNRESET`, destroyed, not writable): say nothing;
 *   * `headersTimeout` / `requestTimeout` expiry: 408, because the client was only slow;
 *   * everything else: 400, a malformed request.
 */
function attachClientErrorHandler(server, options = {}) {
  const logError = options.logError || defaultLogError;

  server.on("clientError", (err, socket) => {
    try {
      if (!socket || socket.destroyed || !socket.writable) return;
      if (err && err.code === "ECONNRESET") {
        socket.destroy();
        return;
      }

      const timedOut = Boolean(err && TIMEOUT_ERROR_CODES.has(err.code));
      const status = timedOut ? 408 : 400;
      const reason = timedOut ? "Request Timeout" : "Bad Request";
      const message = timedOut
        ? "The request was not completed in time."
        : "Malformed HTTP request.";

      // Through `lib/serialize.js` like every other body, so this hand-written response gets the
      // gateway's trailing newline and its `content-length` from the same place.
      const payload = serializeBody({ error: message }, TRANSPORT_PRODUCER);

      socket.end(
        `HTTP/1.1 ${status} ${reason}\r\n` +
          `content-type: ${contentTypeFor(TRANSPORT_PRODUCER)}\r\n` +
          // Only here in this file: this is a refusal made before any route is reached, and CCP's
          // gateway-level refusals are the responses that carry it. See `contract/wire.js`.
          "x-content-type-options: nosniff\r\n" +
          `content-length: ${payload.length}\r\n` +
          "connection: close\r\n" +
          "\r\n" +
          payload.toString("utf8"),
      );
    } catch (writeErr) {
      // Answering a broken request must not break anything else. The socket is beyond help, and
      // throwing from an event handler would be worse.
      logError("failed to answer a malformed request", writeErr);
      if (socket && typeof socket.destroy === "function") socket.destroy();
    }
  });

  return server;
}

// The request handler

/**
 * Build the `(req, res)` function Node calls.
 *
 * Exported separately from `startServer` so a test can drive it with fake request and
 * response objects, and so the listener and the request logic can fail independently.
 *
 * `dispatch` is injected, never required:
 *
 *   dispatch(request) -> Promise<{status, headers?, body?}> | {status, headers?, body?}
 *
 * A `dispatch` that throws, rejects, or answers with something that is not a `{status}`
 * object becomes a logged 500. Otherwise a route bug could reach eve.js's ProcessLifecycle
 * as an unhandled rejection, which is fatal to the game server.
 *
 * A missing `dispatch` throws here, synchronously, at construction. That is a wiring error,
 * and a listener with nothing behind it is not a useful degraded mode.
 */
function createRequestHandler(options = {}) {
  const dispatch = options.dispatch;
  if (typeof dispatch !== "function") {
    throw new TypeError(`${LOG_PREFIX} createRequestHandler needs a dispatch function.`);
  }

  const log = options.log || defaultLog;
  const logError = options.logError || defaultLogError;
  const bodyLimit =
    Number.isInteger(options.bodyLimit) && options.bodyLimit > 0
      ? options.bodyLimit
      : MAX_BODY_BYTES;

  // Accepted so a caller can give one pair of loggers to `createRequestHandler` and
  // `startServer` alike. Currently unused: nothing on the request path is worth a line per
  // request in a game server's stdout.
  void log;

  async function handleRequest(req, res) {
    let request;
    try {
      request = await parseRequest(req, { limit: bodyLimit });
    } catch (err) {
      // A RequestError is the client's fault and carries its own status. Anything else is the
      // socket dying: still answer, because `sendJson` is a no-op if there is nothing left to
      // answer to.
      const status = err instanceof RequestError ? err.status : 400;
      const message =
        err instanceof RequestError ? err.message : "The request could not be read.";
      sendJson(res, status, { error: message }, { connection: "close" });
      return;
    }

    let result;
    try {
      result = await dispatch(request);
    } catch (err) {
      // Covers a synchronous throw and a rejected promise, since `await` turns the second into
      // the first. This catch keeps a route bug from becoming a fatal unhandled rejection.
      logError(`dispatch failed for ${request.method} ${request.pathname}`, err);
      sendJson(res, 500, { error: "The request failed. See the server log." });
      return;
    }

    if (result === null || typeof result !== "object" || !Number.isInteger(result.status)) {
      logError(
        `dispatch returned no usable status for ${request.method} ${request.pathname}`,
        new TypeError(`Expected { status }, received ${typeof result}.`),
      );
      sendJson(res, 500, { error: "The request failed. See the server log." });
      return;
    }

    sendResult(res, result);
  }

  // Node ignores what a request listener returns, so an `async` listener that rejects
  // surfaces as an unhandled rejection, the one failure mode this mod may not have. The
  // listener Node sees is therefore synchronous, and the `.catch()` below is the last defence
  // behind the try/catch inside `handleRequest`.
  return function onRequest(req, res) {
    let pending;
    try {
      pending = handleRequest(req, res);
    } catch (err) {
      failsafe(res, err, logError);
      return;
    }
    Promise.resolve(pending).catch((err) => failsafe(res, err, logError));
  };
}

/**
 * The last thing that runs before an error would escape the process.
 *
 * Reaching it means the failure was in this file rather than behind `dispatch`, so it is
 * logged loudly. The write itself is wrapped, because a socket already gone is the most
 * likely reason to be here and must not become an unhandled throw.
 */
function failsafe(res, err, logError) {
  try {
    logError("request failed outside the request handler", err);
    sendJson(res, 500, { error: "The request failed. See the server log." }, { connection: "close" });
  } catch (_) {
    // Swallowing is correct here: there is no caller to report to and no socket to answer on.
  }
}

// Starting the listener

/**
 * Start the HTTP listener.
 *
 * Resolves to a frozen handle:
 *
 *   { server, host, port, url, close() }
 *
 * `port` is the port actually bound, so a test passing `esiPort: 0` learns which ephemeral
 * port it got. That is a test-only affordance reached by hand-building a config:
 * `config.js` rejects 0, which would arm the mod on a port nobody can find.
 *
 * `listener` names the surface, a key of `LISTENERS` defaulting to `"esi"`. It decides
 * which pair of config fields are bound and what the log line calls itself. The label
 * matters: an operator debugging a port conflict believes what the log line says.
 *
 * Rejects, rather than resolving to a dormant handle, when the wiring is wrong (no config,
 * no `dispatch`, an unknown listener) or the address cannot be bound. loader.js logs the
 * reason and carries on without that listener, leaving the game server unaffected. It
 * rejects rather than throwing synchronously so the caller has one failure path.
 *
 * @param {{config: object, dispatch: Function, listener?: string, log?: Function,
 *          logError?: Function, bodyLimit?: number, requestTimeout?: number,
 *          headersTimeout?: number, connectionsCheckingInterval?: number}} options
 */
function startServer(options = {}) {
  const config = options.config;
  if (config === null || typeof config !== "object") {
    return Promise.reject(new Error(`${LOG_PREFIX} startServer needs a parsed config.`));
  }
  if (typeof options.dispatch !== "function") {
    return Promise.reject(
      new Error(`${LOG_PREFIX} startServer needs a dispatch function; refusing to bind a port with nothing behind it.`),
    );
  }

  const listenerName = options.listener === undefined ? DEFAULT_LISTENER : options.listener;
  const listener = Object.prototype.hasOwnProperty.call(LISTENERS, listenerName)
    ? LISTENERS[listenerName]
    : null;
  if (listener === null) {
    // A typo here would otherwise bind `undefined:undefined`, which is every interface on a
    // random port (see below).
    return Promise.reject(
      new Error(
        `${LOG_PREFIX} startServer does not know a listener called ${JSON.stringify(listenerName)}; ` +
          `it is one of ${Object.keys(LISTENERS).join(", ")}.`,
      ),
    );
  }

  // config.js guarantees these. Checked anyway, because binding `undefined` silently listens
  // on every interface, which on a machine running a game server must not happen quietly. The
  // message names the fields rather than the surface, because the fields are what need
  // fixing.
  const host = config[listener.hostField];
  const port = config[listener.portField];
  if (typeof host !== "string" || host === "") {
    return Promise.reject(
      new Error(`${LOG_PREFIX} startServer needs config.${listener.hostField}.`),
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return Promise.reject(
      new Error(
        `${LOG_PREFIX} startServer needs a valid config.${listener.portField}, received ${String(port)}.`,
      ),
    );
  }

  const log = options.log || defaultLog;
  const logError = options.logError || defaultLogError;

  const server = http.createServer(
    {
      connectionsCheckingInterval: Number.isInteger(options.connectionsCheckingInterval)
        ? options.connectionsCheckingInterval
        : CONNECTIONS_CHECKING_INTERVAL_MS,
    },
    createRequestHandler({
      dispatch: options.dispatch,
      log,
      logError,
      bodyLimit: options.bodyLimit,
    }),
  );

  // Overridable only so the suite can prove the timeouts are wired up without waiting 30 s.
  // Production passes none of the three.
  server.requestTimeout =
    Number.isInteger(options.requestTimeout) ? options.requestTimeout : REQUEST_TIMEOUT_MS;
  server.headersTimeout =
    Number.isInteger(options.headersTimeout) ? options.headersTimeout : HEADERS_TIMEOUT_MS;

  attachClientErrorHandler(server, { logError });

  return new Promise((resolve, reject) => {
    const onListenError = (err) => {
      server.removeListener("listening", onListening);
      reject(new Error(`${LOG_PREFIX} could not bind ${host}:${port}: ${err.message}`));
    };

    const onListening = () => {
      server.removeListener("error", onListenError);

      // From here on an error on the server is a runtime event, not a startup failure, and must
      // not become an unhandled 'error' event, which in Node is a process-level throw and in
      // eve.js is a dead game server.
      server.on("error", (err) => logError("listener error", err));

      const address = server.address();
      const boundPort = address && typeof address === "object" ? address.port : port;

      // Not behind a flag. The mod must never be the reason the game process stays alive, and
      // this also lets the test suite exit on its own.
      server.unref();

      const url = `http://${host}:${boundPort}`;
      // Names the surface, so an operator with two listeners up need not match ports by hand.
      log(`${listener.label} listener on ${url}`);

      const handle = Object.freeze({
        server,
        // Carried so a caller holding two handles can say which one it is closing or reporting on
        // without tracking start order.
        listener: listenerName,
        label: listener.label,
        host,
        port: boundPort,
        url,
        close: () => closeServer(server),
      });
      resolve(handle);
    };

    server.once("error", onListenError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Close the listener and drop any keep-alive sockets.
 *
 * `close()` alone waits for idle connections to time out, which can hang a shutdown for
 * thirty seconds inside a game server trying to exit. `closeAllConnections()` makes it
 * immediate.
 *
 * Takes the handle `startServer` resolved to or a bare `http.Server`. Always resolves,
 * including on an already-closed server: `close()` reports that through its callback, and
 * rejecting would give the caller a failure to handle during shutdown, when nothing can be
 * done about it.
 */
function closeServer(handle) {
  const server = handle && handle.server ? handle.server : handle;

  return new Promise((resolve) => {
    if (!server || typeof server.close !== "function") {
      resolve();
      return;
    }
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    server.close(() => resolve());
  });
}

module.exports = {
  DEFAULT_LISTENER,
  HEADERS_TIMEOUT_MS,
  LISTENERS,
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
};
