/**
 * eve.js-mod-esi: header names, as CCP spells them.
 *
 * HTTP header names are case-insensitive, but clients that are not
 * (`response.headers["Etag"]` against a replica sending `etag`) read
 * `undefined` and conclude the response has no validator. `market-hub-seed`
 * stores `expires`, `last-modified` and `x-pages` per URL, and eve-nexum's
 * client reads the error-limit headers to decide whether to self-throttle.
 *
 * The rule is title-case. Every header name observed on every producer (2XX,
 * refusal, and Go's unrouted 404) is the lowercase name with each
 * dash-separated token capitalised:
 *
 *   Date  Content-Type  Content-Length  Content-Language  Cache-Control
 *   Expires  Last-Modified  Etag  Vary  Access-Control-Allow-Origin
 *   X-Compatibility-Date  X-Esi-Cache-Status  X-Esi-Request-Id
 *   X-Ratelimit-Group  X-Content-Type-Options
 *
 * Two look wrong only against convention: `Etag` (the RFC and CCP's OpenAPI
 * document say `ETag`) and `X-Ratelimit-Group` (other APIs write
 * `X-RateLimit-`). A table of odd ones would have to guess the next one; the
 * rule gets them right because CCP title-cases mechanically.
 *
 * `OBSERVED_CASE` is the check, not the mechanism: `test/serverHeaders.test.js`
 * asserts the rule reproduces every spelling in it. The values are duplicated
 * from `contract/wire.js` because `contract/` is test-only and never deployed
 * (D20).
 */

"use strict";

/**
 * Every header spelling observed on live ESI where convention might have
 * suggested otherwise. Not consulted at runtime: it is the evidence
 * `titleCase` is checked against.
 */
const OBSERVED_CASE = Object.freeze({
  etag: "Etag",
  "x-pages": "X-Pages",
  "x-compatibility-date": "X-Compatibility-Date",
  "x-esi-error-limit-remain": "X-Esi-Error-Limit-Remain",
  "x-esi-error-limit-reset": "X-Esi-Error-Limit-Reset",
  "x-ratelimit-group": "X-Ratelimit-Group",
  "x-ratelimit-limit": "X-Ratelimit-Limit",
  "x-ratelimit-remaining": "X-Ratelimit-Remaining",
  "x-ratelimit-used": "X-Ratelimit-Used",
  "x-content-type-options": "X-Content-Type-Options",
  // The two the application and the gateway stamp per response. Neither is a
  // surprising spelling, which is further evidence the rule is a rule.
  "x-esi-cache-status": "X-Esi-Cache-Status",
  "x-esi-request-id": "X-Esi-Request-Id",
});

/**
 * `cache-control` -> `Cache-Control`, and `etag` -> `Etag`.
 *
 * Splits on `-` only. A name that arrives already capitalised is normalised,
 * so `ETag` from a layer that used the conventional spelling still leaves as
 * `Etag`.
 */
function titleCase(name) {
  return String(name)
    .toLowerCase()
    .split("-")
    .map((part) => (part === "" ? part : part[0].toUpperCase() + part.slice(1)))
    .join("-");
}

/**
 * The same headers with every name in CCP's casing.
 *
 * Applied once, on the way to the socket, so no layer above has to remember:
 * `lib/cache.js` writes `etag` because lowercase is how this codebase keys a
 * header, and it still leaves as `Etag`.
 *
 * Insertion order is preserved: header order is observable, and a stable order
 * keeps a raw-socket assertion meaningful.
 */
function withCcpCasing(headers) {
  if (!headers || typeof headers !== "object") return headers;

  const out = {};
  for (const name of Object.keys(headers)) out[titleCase(name)] = headers[name];
  return out;
}

module.exports = {
  OBSERVED_CASE,
  titleCase,
  withCcpCasing,
};
