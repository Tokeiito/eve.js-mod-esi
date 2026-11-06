/**
 * eve.js-mod-esi: one clock reading per request.
 *
 * Every layer that needs the time asks this, and nothing asks the clock twice.
 *
 * `lib/router.js` picks a page snapshot's window and `lib/cache.js` floors
 * `Last-Modified`, on either side of the handler. With two readings, a request
 * arriving just before a TTL boundary (a region of market orders takes about
 * 200 ms) goes out with the body from window N and the `Last-Modified` of window
 * N+1. The next page then gets snapshot N+1 and the same `Last-Modified`, so two
 * pages agree on `Last-Modified` while coming from different collections: the
 * torn read that header exists to make detectable. `market-hub-seed` aborts a run
 * when that header moves between order pages, and here it would not move.
 *
 * Injecting one `now` function into every layer does not prevent this: in
 * production both layers would still call `Date.now()`. So there is one reading,
 * taken once at the top of the stack and carried on the request as
 * `request.receivedAt`. A layer added later gets the same answer without knowing
 * this file exists.
 *
 * `receivedAt` is when the request arrived, so every derived header describes
 * one instant, and a slow handler makes the response older rather than
 * inconsistent. A client is never told the data is fresher than it is.
 *
 * `readingFor` falls back to a live clock when a request carries no stamp,
 * because a layer must be callable on its own (`test/cache.test.js` builds a
 * cache dispatch with no pipeline, and `routes/health.js` never enters the
 * stack).
 */

"use strict";

/** The field a stamped request carries. */
const RECEIVED_AT = "receivedAt";

/**
 * This request's reading, or a fresh one for a request that never entered the
 * stack.
 *
 * Uses `Number.isFinite` rather than a presence check: a request rebuilt by a
 * test can carry a string or a `Date`, and flooring a `NaN` into a cache
 * window would yield an `Invalid Date` in a header.
 */
function readingFor(request, now = Date.now) {
  const stamped = request && request[RECEIVED_AT];
  return Number.isFinite(stamped) ? stamped : now();
}

/**
 * Stamp one reading on the request and hand it down.
 *
 * Composed outermost, ahead of CORS, so every layer below sees the same
 * instant. The request is copied rather than mutated, because `server.js` owns
 * the object it built. A request that already carries a stamp keeps it.
 */
function createRequestClockDispatch(next, { now = () => Date.now() } = {}) {
  if (typeof next !== "function") {
    throw new TypeError("ESI mod: createRequestClockDispatch needs a dispatch function to wrap.");
  }

  return async function requestClockDispatch(request) {
    const req = request && typeof request === "object" ? request : {};
    if (Number.isFinite(req[RECEIVED_AT])) return next(request);

    return next({ ...req, [RECEIVED_AT]: now() });
  };
}

module.exports = {
  RECEIVED_AT,
  createRequestClockDispatch,
  readingFor,
};
