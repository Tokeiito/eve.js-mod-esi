/**
 * eve.js-mod-esi: `X-Esi-Request-Id`.
 *
 * A per-response identifier, stamped by ESI's application and by nothing else. It is the one
 * header that tells the two implementations apart on an otherwise identical response:
 * `contract/wire.js` `APP_SUCCESS_HEADERS` has it and `GATEWAY_SUCCESS_HEADERS` does not.
 *
 * It is a layer, not a line in the router, because it is per response, not per representation,
 * and those come apart on a `304`. A `304` carries an id (the application answered the
 * revalidation) while carrying none of the `200`'s own headers except those `lib/cache.js`
 * `notModifiedResult` keeps. An id written by the router would be discarded by that rebuild, and
 * one listed in `NOT_MODIFIED_SENDS` would be the previous response's: two responses sharing an
 * id is what an id exists to rule out. So the stamp goes on the way out, outside the layer that
 * turns a response into a `304` and inside the one that refuses a bad compatibility date; those
 * refusals are the gateway's (`lib/errors.js` `FAMILY.EDGE`) and carry no id, which falls out of
 * the producer test rather than needing a rule.
 *
 * It is stamped on every result whose `producer` is the application: successes, `304`s and
 * refusals, including the `404`. Not the unrouted `404`, which is Go's own handler and carries no
 * producer, and not `/ping`, which never reaches a layer.
 *
 * The value is `crypto.randomUUID()`. The shape is a UUID; the value is unobserved and marked so
 * in `contract/wire.js` `INFRASTRUCTURE`, which is where a real observation would land. A counter
 * would be cheaper but would leak a private server's request rate to anyone who asked twice.
 */

"use strict";

const crypto = require("node:crypto");

const { PRODUCER } = require("./serialize");

const HEADER = "x-esi-request-id";

/** Which of ESI's two implementations stamps one. Observed; see the header. */
const STAMPED_BY = Object.freeze([PRODUCER.APP]);

/** A fresh id. Separated so a test can hold it still. */
function newRequestId() {
  return crypto.randomUUID();
}

/** Does `headers` already carry `name`, in any casing? */
function has(headers, name) {
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === name);
}

/**
 * Wrap a dispatch so every response the application produced carries an id.
 *
 * A result that set one itself keeps it, as in `lib/cors.js`, for the same reason: writing both
 * `x-esi-request-id` and `X-Esi-Request-Id` would put two lines on the wire, or one comma-joined
 * value, and neither is a UUID any more.
 */
function createRequestIdDispatch(next, { newId = newRequestId } = {}) {
  if (typeof next !== "function") {
    throw new TypeError("ESI mod: createRequestIdDispatch needs a dispatch function to wrap.");
  }

  const stamped = new Set(STAMPED_BY);

  return async function requestIdDispatch(request) {
    const result = await next(request);

    if (!result || typeof result !== "object") return result;
    if (!stamped.has(result.producer)) return result;

    const headers = { ...(result.headers || {}) };
    if (has(headers, HEADER)) return result;

    headers[HEADER] = newId();
    return { ...result, headers };
  };
}

module.exports = {
  HEADER,
  STAMPED_BY,
  createRequestIdDispatch,
  newRequestId,
};
