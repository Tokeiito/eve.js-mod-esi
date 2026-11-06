/**
 * eve.js-mod-esi: CORS.
 *
 * Vanilla eve-nexum's front-end calls this API directly from the browser, so
 * CORS is required.
 *
 * Exposed headers: a browser hides every response header from page script
 * except a short safe list, unless named in `Access-Control-Expose-Headers`.
 * Without it a page can read neither `X-Pages` nor `Etag`, and eve-nexum's
 * HTTP client treats the unreadable error-limit headers as missing and
 * globally self-throttles. The list is ten names, CCP's order and casing, with
 * `Etag` rather than `ETag` to match the header actually sent.
 *
 * `Access-Control-Allow-Origin: *` goes out unconditionally, whether or not
 * the request carried an `Origin`. `Access-Control-Allow-Credentials` is never
 * sent: `*` and credentials mode are mutually exclusive and a browser rejects
 * the pair.
 *
 * The preflight does not route. `OPTIONS /nope/` and `OPTIONS /ping` answer
 * `204` exactly as `OPTIONS /status/` does, so this is a wrapper around
 * `dispatch` rather than a router feature. The trigger is
 * `Access-Control-Request-Method`, not `Origin`: an `OPTIONS` carrying only an
 * `Origin` is an ordinary `OPTIONS` and gets CCP's ordinary `405`. The `204`
 * carries six headers and nothing else: no expose list, no `Content-Language`,
 * no `Content-Length`, and one `Vary` line instead of the usual three.
 *
 * Two quirks are reproduced as observed. `Access-Control-Allow-Headers` echoes
 * whatever the client asked for, verbatim including spacing (`*` when it asked
 * for nothing). `Access-Control-Allow-Methods` is a fixed `GET, POST, PUT,
 * DELETE` not derived from the route: `/status/` accepts only `GET` and still
 * advertises four, while `OPTIONS`, `PATCH` and `HEAD` are missing.
 *
 * The observations are in `contract/wire.js`. The constants are duplicated
 * here because `contract/` is test-only and never deployed (D20);
 * `test/cors.test.js` asserts they agree.
 */

"use strict";


const ALLOW_ORIGIN = "*";

/** Ten names, in CCP's order and casing, joined as one header value. */
const EXPOSE_HEADERS = [
  "Etag",
  "Retry-After",
  "X-Compatibility-Date",
  "X-Esi-Error-Limit-Remain",
  "X-Esi-Error-Limit-Reset",
  "X-Pages",
  "X-Ratelimit-Group",
  "X-Ratelimit-Limit",
  "X-Ratelimit-Remaining",
  "X-Ratelimit-Used",
].join(", ");

/** The request header whose presence turns an OPTIONS into a preflight. */
const PREFLIGHT_TRIGGER = "access-control-request-method";
const PREFLIGHT_REQUEST_HEADERS = "access-control-request-headers";

const PREFLIGHT_STATUS = 204;
const ALLOW_METHODS = "GET, POST, PUT, DELETE";
const MAX_AGE = "86400";
const PREFLIGHT_VARY = "Access-Control-Request-Headers";
const DEFAULT_ALLOW_HEADERS = "*";

/**
 * Paths that carry no CORS headers at all.
 *
 * Only `/ping`: two bytes, observably outside every pipeline (no CORS, cache
 * or rate-limit headers). This is not the router's list of unversioned paths:
 * `/meta/compatibility-dates` is unversioned too and carries CORS like every
 * other routed response.
 */
const EXEMPT_PATHS = Object.freeze(["/ping"]);


/** Case-insensitive header read, since `headers` may come from anywhere. */
function header(headers, name) {
  if (!headers) return undefined;
  if (headers[name] !== undefined) return headers[name];

  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

/** Is this request a CORS preflight? */
function isPreflight(request) {
  if (!request || String(request.method || "").toUpperCase() !== "OPTIONS") return false;
  return header(request.headers, PREFLIGHT_TRIGGER) !== undefined;
}

/** The two headers every non-exempt response carries. */
function corsHeaders() {
  return {
    "access-control-allow-origin": ALLOW_ORIGIN,
    "access-control-expose-headers": EXPOSE_HEADERS,
  };
}

/**
 * The `204`, built from the request it answers.
 *
 * `Allow-Headers` mirrors the request: whatever the client listed comes back,
 * and `*` when it listed nothing.
 */
function preflightResponse(request) {
  const requested = header(request && request.headers, PREFLIGHT_REQUEST_HEADERS);

  return {
    status: PREFLIGHT_STATUS,
    headers: {
      "access-control-allow-headers":
        requested === undefined || requested === "" ? DEFAULT_ALLOW_HEADERS : requested,
      "access-control-allow-methods": ALLOW_METHODS,
      "access-control-allow-origin": ALLOW_ORIGIN,
      "access-control-max-age": MAX_AGE,
      vary: PREFLIGHT_VARY,
    },
  };
}

/** Does `headers` already carry `name`, in any casing? */
function has(headers, name) {
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === name);
}


/**
 * Wrap a dispatch so that every response is readable from a browser and a
 * preflight is answered before anything routes.
 *
 * A header the wrapped dispatch set itself wins and is not duplicated: writing
 * both `access-control-allow-origin` and `Access-Control-Allow-Origin` would go
 * out as one comma-joined value.
 */
function createCorsDispatch(next, { exemptPaths = EXEMPT_PATHS } = {}) {
  if (typeof next !== "function") {
    throw new Error("ESI mod: createCorsDispatch needs a dispatch function to wrap.");
  }

  const exempt = new Set(exemptPaths);

  return async function corsDispatch(request) {
    if (isPreflight(request)) return preflightResponse(request);

    const result = await next(request);

    // A path with no CORS at all. Compared without its trailing slash, since
    // `/ping/` and `/ping` are the same path everywhere else.
    const pathname = String((request && request.pathname) || "").replace(/\/+$/, "") || "/";
    if (exempt.has(pathname)) return result;

    const headers = { ...(result.headers || {}) };
    for (const [name, value] of Object.entries(corsHeaders())) {
      if (!has(headers, name)) headers[name] = value;
    }

    return { ...result, headers };
  };
}

module.exports = {
  ALLOW_METHODS,
  ALLOW_ORIGIN,
  DEFAULT_ALLOW_HEADERS,
  EXEMPT_PATHS,
  EXPOSE_HEADERS,
  MAX_AGE,
  PREFLIGHT_STATUS,
  PREFLIGHT_TRIGGER,
  PREFLIGHT_VARY,
  corsHeaders,
  createCorsDispatch,
  isPreflight,
  preflightResponse,
};
