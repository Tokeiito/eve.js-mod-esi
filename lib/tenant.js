/**
 * eve.js-mod-esi: the tenant.
 *
 * `?datasource=tranquility` is on the end of nearly every URL the ecosystem sends. An unknown
 * query parameter is ignored (`contract/wire.js` `IGNORES_UNKNOWN_QUERY_PARAMS`), but this one is
 * the single observed exception: a recognised parameter whose value the gateway refuses before
 * anything routes.
 *
 * One tenant, and it is CCP's (D26). A private server could advertise `tranquility` or its own
 * name; its own name is the honest answer and the wrong one. Every tool in the ecosystem
 * hardcodes `?datasource=tranquility` (D4), so a replica answering to its own name would refuse all of
 * them, and the fix would be a patch per tool, the cost D18 avoids. Also, the set of valid
 * datasources is shrinking: `singularity` was valid for a decade and is now a `400`, so adding a
 * value is not being more permissive than CCP but differently shaped from it, and a client
 * library with a datasource enum would need a case for us specifically.
 *
 *   curl -sD - "https://esi.evetech.net/latest/status/?datasource=singularity"
 *     400 {"error":"Invalid tenant"}
 *
 * So there is one value and no configuration knob, which would let an operator turn every tool
 * off at once.
 *
 * Two spellings, and the query parameter wins. `?datasource=` and `X-Tenant:` both carry it, and
 * the query parameter does not fall back for a missing header, it replaces it:
 *
 *   X-Tenant: nope + ?datasource=tranquility   200
 *   X-Tenant: tranquility + ?datasource=nope   400
 *
 * Checked in both directions because "validate whichever is present" and "validate both" agree
 * on every row except those two, which are a whole status code apart. An empty value on either is
 * absent, and an empty query parameter hands the question back to the header. The comparison is
 * case-insensitive: `?datasource=TRANQUILITY` is a `200`.
 *
 * Placement. Outside `lib/compatibility.js`, because the tenant is checked first:
 *
 *   -H "X-Compatibility-Date: nope" "...?datasource=nope"   400 {"error":"Invalid tenant"}
 *
 * and inside both limiters and CORS, for the same two reasons that layer is: the refusal carries
 * the CORS pair and the error-limit pair, and it spends a unit even on `/latest/status/`, which
 * the token bucket owns. A request refused in front of routing never reached the route that owns
 * a bucket.
 *
 * This refusal carries no `Vary` at all: not the three a routed response sends, and not the two
 * the compatibility-date refusal sends. Both refusals are `GATEWAY_ERROR` and one sends two lines
 * where this sends none, so it is not derivable from the response kind and `contract/wire.js`
 * records it on `TENANT.refusal` rather than in `VARY_BY_KIND`. `lib/errors.js` `invalidTenant()`
 * attaches none, and this file adds none: the absence is the observation.
 */

"use strict";

const { invalidTenant } = require("./errors");

/** The one accepted value, and the one this replica advertises (D26). */
const TENANT = "tranquility";

/** `?datasource=`. The only query parameter on this surface with a validator. */
const TENANT_QUERY = "datasource";

/** `X-Tenant:`. Lowercase, because that is how Node hands headers over. */
const TENANT_HEADER = "x-tenant";

/**
 * The value this request asked for, or `null` for "no opinion".
 *
 * The query parameter first and unconditionally when non-empty, because it wins outright rather
 * than filling in for an absent header. An empty value on either is absent, so an empty query
 * parameter falls through to the header instead of shadowing it: the one interaction between the
 * two rules, and the one a test has to name.
 */
function requestedTenant(request) {
  const query = (request && request.query) || {};
  const headers = (request && request.headers) || {};

  const fromQuery = query[TENANT_QUERY];
  if (fromQuery !== undefined && fromQuery !== null && fromQuery !== "") {
    return String(fromQuery);
  }

  const fromHeader = headers[TENANT_HEADER];
  if (fromHeader !== undefined && fromHeader !== null && fromHeader !== "") {
    return String(fromHeader);
  }

  return null;
}

/**
 * `{ tenant }` for a request this replica will serve, or `{ refusal }` carrying the `400` CCP
 * would have sent.
 *
 * `{ tenant: null }` is "the client did not say", the overwhelming majority of requests, and not
 * the same as having asked for the default. Nothing downstream reads the value; the distinction
 * is kept so a future surface with more than one tenant need not reconstruct it.
 */
function readTenant(request) {
  const value = requestedTenant(request);
  if (value === null) return { tenant: null };

  // Case-insensitive, observed: `?datasource=TRANQUILITY` is a 200.
  if (value.toLowerCase() !== TENANT) return { refusal: invalidTenant() };

  return { tenant: TENANT };
}

/**
 * Refuse a tenant this replica does not serve, and let everything else through untouched.
 *
 * Composed outside `lib/compatibility.js` and inside both limiters and CORS; see the file header
 * for each boundary and the request that established it. `lib/pipeline.js` owns the order; this
 * file owns only the refusal. No `Vary` is attached, deliberately.
 */
function createTenantDispatch(next) {
  if (typeof next !== "function") {
    throw new TypeError("ESI mod: createTenantDispatch needs a dispatch function to wrap.");
  }

  return async function tenantDispatch(request) {
    const { refusal } = readTenant(request);
    if (refusal) return refusal;

    return next(request);
  };
}

module.exports = {
  TENANT,
  TENANT_HEADER,
  TENANT_QUERY,
  createTenantDispatch,
  readTenant,
  requestedTenant,
};
