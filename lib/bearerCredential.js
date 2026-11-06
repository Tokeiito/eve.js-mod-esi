/**
 * eve.js-mod-esi: the credential, read in front of the router.
 *
 * Half of the bearer gate, decided before the route is known. It answers one
 * question, did this request carry a credential and does it verify, and it
 * refuses on exactly one answer: a credential was presented and does not
 * verify. Whether a route requires one is asked after routing by
 * `lib/router.js`, which needs the route's declared `scope`. `contract/wire.js`
 * `BEARER` is the survey showing the two halves sit on opposite sides of four
 * layers.
 *
 *   Authorization absent or blank       -> nothing to check; carry on
 *   Authorization present, unverifiable -> 401 "Unauthorized - Invalid token"
 *   Authorization present, verifies     -> carry the claims down
 *
 * "Blank" means empty after a trim, which is CCP's rule: `Authorization:`
 * followed by six spaces is answered `200` on a public route, while a bare
 * `Bearer` (whose token68 survives the trim) is an invalid token. Everything
 * non-blank that is not a good token is refused, including
 * `Basic dXNlcjpwdw==`.
 *
 * The refusal carries no `Vary`, no `Content-Language` and no `X-Ratelimit-*`,
 * because this layer has never resolved a route and cannot name what those
 * headers describe; CCP's does not either. Observed on public routes, secured
 * routes, `/meta/openapi.json`, `/v1/` and `/legacy/` prefixes, unrouted paths
 * and the bare root, always the same 41 bytes.
 *
 * It outranks every other refusal on this surface: an unrouted 404, a 405, a
 * bad compatibility date and a bad tenant all lose to it. That fixes the
 * layer's depth: above `tenant` and `compatibility`, below both limiters (so
 * the error limiter can charge and decorate it), and below `cors` (so a
 * preflight is answered `204` without token work).
 *
 * `readCredential` is called twice on a normal request: by `lib/pipeline.js`
 * `groupFor`, which must know that a bad credential has no bucket to charge,
 * and by the layer that refuses on it. Unlike the tenant and the date, which
 * `pipeline.js` parses twice on purpose, this answer costs an RSA
 * verification, so the reading is memoised per request object. One answer per
 * request means no two layers can disagree about what the client presented.
 * The map is weak and keyed on the request.
 *
 * `verifier` may be the verifier itself or a function returning one. The
 * second form is required: `loader.js` builds the ESI stack before it loads
 * any SSO credential and starts the ESI listener whether or not the SSO
 * surface comes up, so a verifier resolved at construction would always be
 * `null`. Resolved per request, the ESI surface picks up the key as soon as
 * SSO has one and keeps serving when it never does.
 *
 * With no verifier (the SSO surface did not start, so there is no signing
 * key) a credential is treated as absent rather than bad. Refusing every
 * request that carries `Authorization` because our key is missing would turn
 * one broken listener into an outage on the other, and `loader.js` promises
 * the ESI listener is unaffected when SSO fails. The cost: a forged token on a
 * public route is answered `200` where CCP answers `401`. A route that
 * requires a scope still refuses, since an absent and an uncheckable
 * credential both fail the requirement.
 */

"use strict";

const { bearerFromAuthorization, readAuthorizationHeader } = require("./bearerToken");
const { unauthorized } = require("./errors");

/**
 * The three answers, as frozen singletons where they carry no payload.
 *
 * `presented` is about the header, not the token: a `Basic` credential is
 * presented, and is bad. `claims` is the projection `lib/bearerToken.js`
 * built, and is null unless the token verified. `refusal` is the verdict's
 * reason, kept for the log and never sent to the client: all eleven reasons
 * are the same 41 bytes on the wire.
 */
const ABSENT = Object.freeze({ presented: false, claims: null, refusal: null });

/** Per-request memo. See the header comment. */
const READINGS = new WeakMap();

/**
 * What this request presented, read once.
 *
 * Total: it never throws, because it runs in front of every route on a game
 * server's event loop and `lib/bearerToken.js` guarantees verify never throws.
 */
function readCredential(request, verifier) {
  if (!request || typeof request !== "object") return ABSENT;

  const cached = READINGS.get(request);
  if (cached !== undefined) return cached;

  const reading = read(request, verifier);
  READINGS.set(request, reading);
  return reading;
}

function read(request, verifier) {
  const raw = readAuthorizationHeader(request.headers);
  // The trim is CCP's and is the whole absent/bad boundary: a whitespace-only
  // value is answered as though no header had been sent.
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") return ABSENT;

  // Late-bound, because the ESI listener starts before the surface that owns
  // the signing key. See the header comment.
  const resolved = typeof verifier === "function" ? verifier() : verifier;

  // No key to check against: a degradation, kept from being a hole by the route
  // table.
  if (!resolved || typeof resolved.verify !== "function") return ABSENT;

  const token = bearerFromAuthorization(value);
  // Nothing below may throw. An injected verifier that misbehaves must not
  // become an unhandled rejection several layers above.
  try {
    return verify(resolved, token);
  } catch {
    return Object.freeze({ presented: true, claims: null, refusal: "verifier-threw" });
  }
}

function verify(resolved, token) {
  // Presented, and not even the shape of a bearer credential (`Basic ...`, a
  // bare `Bearer`, whitespace inside the token68). CCP answers all of these as
  // it answers a forged signature.
  if (token === null) return Object.freeze({ presented: true, claims: null, refusal: "not-a-bearer-token" });

  // A verifier that answers nothing usable is refused rather than trusted or
  // allowed to throw: this function is total and runs in front of every route.
  // `routes/oauthVerify.js` hardens the same case.
  const verdict = resolved.verify(token);
  if (!verdict || typeof verdict !== "object") {
    return Object.freeze({ presented: true, claims: null, refusal: "verifier-answered-nothing" });
  }
  if (!verdict.ok || !verdict.claims) {
    return Object.freeze({ presented: true, claims: null, refusal: verdict.reason || "unusable-verdict" });
  }

  return Object.freeze({ presented: true, claims: verdict.claims, refusal: null });
}

/**
 * The layer.
 *
 * Stamps `request.credential` on the way down so the router can ask what was
 * presented without reading a header again, and refuses on the one refusable
 * answer.
 */
function createBearerCredentialDispatch(next, { verifier = null, log = () => {} } = {}) {
  if (typeof next !== "function") {
    throw new TypeError("ESI mod: createBearerCredentialDispatch needs a dispatch function to wrap.");
  }

  return async function bearerCredentialDispatch(request) {
    const credential = readCredential(request, verifier);

    if (credential.refusal !== null) {
      // The reason is ours, not the client's: every one is the same 41 bytes on the
      // wire, and the difference between a forged signature and an expired token is
      // for operators, not attackers.
      log(`bearer credential refused (${credential.refusal})`);
      return unauthorized("invalid-token");
    }

    // Copied rather than mutated, as `lib/requestClock.js` does: a layer that
    // edits the caller's object makes the order it ran in unrecoverable.
    return next({ ...request, credential });
  };
}

module.exports = {
  ABSENT,
  createBearerCredentialDispatch,
  readCredential,
};
