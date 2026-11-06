/**
 * The two limiters, composed: does a response ever carry both families?
 *
 * Run with: node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * `test/errorLimiter.test.js` and `test/rateLimiter.test.js` each prove their
 * own module against `contract/wire.js`, each with a `groupFor` double. Neither
 * can prove the property of the pair: a response carries one family or the
 * other and never both. Seventeen surveyed requests say a response carries
 * exactly one family, or none (`wire.LIMITER_SURVEY`). Two modules that each
 * independently keep quiet are a correct outcome held up by two separate
 * decisions, and it breaks when someone changes one for a good local reason.
 * So it is asserted once, here, through the layers composed in `loader.js` and
 * against a real router.
 *
 * What is composed:
 *
 *   clock( cors( errorLimit( rateLimit( bearer( tenant( compatibility(
 *     requestId( cache( router ) ) ) ) ) ) ) ) )
 *
 * The whole stack, because `createEsiDispatch` is the only thing that builds
 * one. Two boundaries are of interest: the preflight is answered above the
 * limiters, which is how it carries neither family, and the `304` is decided
 * below them, which is how it can be priced (free on one limiter and one token
 * on the other).
 *
 * The fixture is two routes, one of each kind, both from the survey: `/status`
 * publishes the group `status` and is the token bucket's, and
 * `/universe/factions` publishes none and is the error limiter's. On live ESI
 * those two answer with different families, which makes the pair worth having
 * as a fixture rather than one route and a flag.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const { createRouter } = require(path.join(__dirname, "../lib/router"));
const { createEsiDispatch } = require(path.join(__dirname, "../lib/pipeline"));
const { HEADER_REMAIN, HEADER_RESET } = require(path.join(__dirname, "../lib/errorLimiter"));

// A clock that does not move, so `Expires`, `Reset` and the refill all answer
// the same question and none drifts mid-test.
const AT = Date.UTC(2026, 7, 23, 14, 29, 18);

const ERROR_LIMIT_HEADERS = [HEADER_REMAIN, HEADER_RESET];
const TOKEN_BUCKET_HEADERS = [
  "x-ratelimit-group",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-used",
];

function table() {
  return [
    {
      method: "GET",
      path: "/status",
      name: "GetStatus",
      rateLimitGroup: "status",
      cacheTtl: 30,
      producer: "gateway",
      handler: () => ({ players: 1 }),
    },
    {
      method: "GET",
      path: "/universe/factions",
      name: "GetUniverseFactions",
      cacheTtl: 3600,
      producer: "app",
      handler: () => [{ faction_id: 500001 }],
    },
  ];
}

/**
 * A verifier that refuses everything, which is all this file needs.
 *
 * The survey row it makes reachable is about which limiter answers a bad
 * credential, not why the credential was bad; on the wire those are the same
 * 41 bytes. `test/bearerCredential.test.js` exercises the verdicts against a
 * real key.
 */
const REFUSES_EVERYTHING = { verify: () => ({ ok: false, reason: "MALFORMED" }) };

/**
 * A verifier whose token is the application it names.
 *
 * The token bucket keys on the application and the error limiter keys on the
 * address regardless of credential. Neither module can show that on its own,
 * and showing it needs a credential that verifies rather than one refused in
 * front of routing.
 */
const NAMES_ITS_APPLICATION = {
  verify: (token) => ({ ok: true, claims: { clientId: String(token) } }),
};

/** The stack `loader.js` builds, from the one module that knows the order. */
function pipeline({ now = () => AT, verifier = REFUSES_EVERYTHING } = {}) {
  return createEsiDispatch(createRouter(table()), { now, verifier });
}

function request(overrides = {}) {
  return {
    method: "GET",
    pathname: "/status/",
    query: {},
    headers: {},
    remoteAddress: "203.0.113.7",
    ...overrides,
  };
}

/** Which family a result carries, in `wire.LIMITER`'s own vocabulary. */
function familyOf(result) {
  const names = Object.keys(result.headers || {}).map((name) => name.toLowerCase());
  const bucket = TOKEN_BUCKET_HEADERS.some((name) => names.includes(name));
  const errors = ERROR_LIMIT_HEADERS.some((name) => names.includes(name));

  assert.equal(bucket && errors, false, "a response carried both limiter families");

  if (bucket) return wire.LIMITER.TOKEN_BUCKET;
  return errors ? wire.LIMITER.ERROR_LIMIT : wire.LIMITER.NONE;
}

// The one property neither module can prove alone

test("no response carries both limiter families, across every outcome the pipeline has", async () => {
  const dispatch = pipeline();

  // Success and refusal, both producers, both kinds of route, both kinds of 405,
  // the unrouted 404 and the preflight. `familyOf` throws on any response
  // carrying both, so the assertion is every row of this list.
  const outcomes = [
    request(),
    request({ pathname: "/latest/universe/factions/" }),
    request({ method: "HEAD" }),
    request({ method: "POST" }),
    request({ method: "POST", pathname: "/latest/universe/factions/" }),
    request({ pathname: "/nope/" }),
    request({ pathname: "/v99/status/" }),
    request({ method: "OPTIONS", headers: { "access-control-request-method": "GET" } }),
    request({ headers: { "x-compatibility-date": "nope" } }),
  ];

  for (const outcome of outcomes) {
    const result = await dispatch(outcome);
    familyOf(result);
  }
});

test("a route that publishes a group is the token bucket's, and one that does not is the error limiter's", async () => {
  const dispatch = pipeline();

  assert.equal(familyOf(await dispatch(request())), wire.LIMITER.TOKEN_BUCKET);
  assert.equal(
    familyOf(await dispatch(request({ pathname: "/latest/universe/factions/" }))),
    wire.LIMITER.ERROR_LIMIT,
  );
});

test("the surveyed rows that name a route this replica has reproduce their family", async () => {
  const dispatch = pipeline();

  // Only the rows whose route exists in the fixture: the survey covers the real
  // surface. The rows are read from `wire` rather than restated here, so a
  // corrected observation fails this test rather than sitting in a comment.
  const reachable = {
    "GET /status/": request(),
    "GET /latest/universe/factions/ + If-None-Match": null, // asserted below, needs an Etag
    "HEAD /latest/status/": request({ method: "HEAD" }),
    "POST /latest/status/": request({ method: "POST" }),
    "GET /nope/": request({ pathname: "/nope/" }),
    // The same route as the first row and the other limiter: a credential that
    // was presented and does not verify is refused in front of routing, so it
    // never reaches the bucket `/status/` owns.
    "GET /latest/status/ + Bearer garbage": request({
      pathname: "/latest/status/",
      headers: { authorization: "Bearer garbage" },
    }),
  };

  let checked = 0;
  for (const row of wire.LIMITER_SURVEY) {
    const probe = reachable[row.request];
    if (!probe) continue;

    assert.equal(familyOf(await dispatch(probe)), row.limiter, `${row.request}: ${row.note}`);
    checked += 1;
  }

  assert.equal(checked, 5, "the survey rows this fixture can reach");
});

// The boundaries the composition order buys

test("the preflight is answered above both limiters, so it carries neither family", async () => {
  const dispatch = pipeline();

  const result = await dispatch(request({
    method: "OPTIONS",
    headers: { "access-control-request-method": "GET" },
  }));

  assert.equal(result.status, wire.PREFLIGHT.status);
  assert.equal(familyOf(result), wire.LIMITER.NONE);
});

test("a 304 is priced, which is only possible because both limiters sit outside the cache", async () => {
  const dispatch = pipeline();

  // Grouped: a revalidation costs one token, so `Used` is 1 rather than the 2 a
  // 200 costs. Ungrouped: it costs nothing, so `Remain` does not move.
  const first = await dispatch(request());
  assert.equal(first.headers["x-ratelimit-used"], "2");

  const revalidated = await dispatch(request({
    headers: { "if-none-match": first.headers.etag },
  }));

  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.headers["x-ratelimit-used"], "1", "wire.LIMITER_SURVEY: Used: 1 on a 304");
  assert.equal(
    Number(first.headers["x-ratelimit-remaining"]) - Number(revalidated.headers["x-ratelimit-remaining"]),
    1,
  );

  const factions = request({ pathname: "/latest/universe/factions/" });
  const before = await dispatch(factions);
  const after = await dispatch({ ...factions, headers: { "if-none-match": before.headers.etag } });

  assert.equal(after.status, 304);
  assert.equal(familyOf(after), wire.LIMITER.ERROR_LIMIT);
  assert.equal(after.headers[HEADER_REMAIN], before.headers[HEADER_REMAIN], "a revalidation is free here");
});

test("a 405 splits by the method it refused, all the way out to the headers", async () => {
  const dispatch = pipeline();

  const head = await dispatch(request({ method: "HEAD" }));
  const post = await dispatch(request({ method: "POST" }));

  assert.equal(head.status, 405);
  assert.equal(post.status, 405);
  assert.equal(familyOf(head), wire.METHOD_NOT_ALLOWED_LIMITER.HEAD);
  assert.equal(familyOf(post), wire.METHOD_NOT_ALLOWED_LIMITER.OTHER);
});

test("a refusal made in front of routing has no bucket, even on a route that has one", async () => {
  const dispatch = pipeline();

  // `/status` publishes the group `status`, so a request that reaches it is the
  // token bucket's. The same path with a malformed compatibility date is not: it
  // never got to the route that owns the bucket, so it falls to the error
  // limiter and spends a unit, the same rule that splits the two 405s.
  assert.equal(familyOf(await dispatch(request())), wire.LIMITER.TOKEN_BUCKET);

  const refused = await dispatch(request({ headers: { "x-compatibility-date": "nope" } }));

  assert.equal(refused.status, 400);
  assert.equal(familyOf(refused), wire.LIMITER.ERROR_LIMIT);
  assert.equal(refused.headers[HEADER_REMAIN], String(wire.ERROR_LIMIT.maxErrors - 1), "post-charge");
  assert.equal(refused.headers["access-control-allow-origin"], wire.ALLOW_ORIGIN, "and a browser can read it");
});

test("the unrouted 404 is the error limiter's, because there is no route to have a bucket", async () => {
  const dispatch = pipeline();

  const result = await dispatch(request({ pathname: "/nope/" }));

  assert.equal(result.status, 404);
  assert.equal(familyOf(result), wire.LIMITER.ERROR_LIMIT);
  assert.equal(result.headers[HEADER_REMAIN], String(wire.ERROR_LIMIT.maxErrors - 1), "post-charge");
});

// Neither limiter can be spent through the other

test("errors on an ungrouped route do not drain a grouped route's bucket, or the reverse", async () => {
  const dispatch = pipeline();

  // Twenty 404s against the ungrouped surface: twenty units of the error budget
  // and nothing from the `status` bucket.
  for (let i = 0; i < 20; i += 1) await dispatch(request({ pathname: `/nope/${i}/` }));

  const grouped = await dispatch(request());
  assert.equal(grouped.headers["x-ratelimit-used"], "2");
  assert.equal(
    grouped.headers["x-ratelimit-remaining"],
    String(600 - 2),
    "the token bucket is untouched by traffic that never reached it",
  );

  const ungrouped = await dispatch(request({ pathname: "/latest/universe/factions/" }));
  assert.equal(ungrouped.headers[HEADER_REMAIN], String(wire.ERROR_LIMIT.maxErrors - 20));
});

test("an exhausted error budget does not refuse a grouped route", async () => {
  const dispatch = pipeline();

  for (let i = 0; i < wire.ERROR_LIMIT.maxErrors; i += 1) {
    await dispatch(request({ pathname: `/nope/${i}/` }));
  }

  const refused = await dispatch(request({ pathname: "/nope/again/" }));
  assert.equal(refused.status, wire.LIMITER_UNOBSERVED.errorLimitOverStatus);

  // The grouped route is on the other limiter, which has been idle.
  const grouped = await dispatch(request());
  assert.equal(grouped.status, 200);
  assert.equal(familyOf(grouped), wire.LIMITER.TOKEN_BUCKET);
});

// The configurable budget (D44)
//
// A third-party tool observed against a deployment of this replica enumerates
// every character it knows about at startup in a single burst, most of them
// unknown to this private server and so honest 404s. Two such bursts spend
// CCP's observed 100-error budget before the tool finishes starting, and
// everything after is refused with a 420, including requests that would have
// succeeded. `ESI_MOD_ERROR_LIMIT_MAX_ERRORS` (D44) is the knob;
// `lib/pipeline.js` threads it through `createEsiDispatch`'s
// `errorLimitMaxErrors` option, and this proves the whole stack, not just
// `lib/errorLimiter.js` in isolation, honours it.

test("createEsiDispatch's errorLimitMaxErrors option is CCP's 100 when left unset", async () => {
  const dispatch = pipeline();

  for (let i = 0; i < wire.ERROR_LIMIT.maxErrors - 1; i += 1) {
    await dispatch(request({ pathname: `/nope/${i}/` }));
  }

  const last = await dispatch(request({ pathname: "/nope/last/" }));
  assert.equal(last.status, 404, "the 100th error is still answered");
  assert.equal(last.headers[HEADER_REMAIN], "0");

  const refused = await dispatch(request({ pathname: "/nope/again/" }));
  assert.equal(refused.status, wire.LIMITER_UNOBSERVED.errorLimitOverStatus);
});

test("createEsiDispatch's errorLimitMaxErrors option raises the whole stack's budget past CCP's 100", async () => {
  const raised = 250;
  const dispatch = createEsiDispatch(createRouter(table()), {
    now: () => AT,
    verifier: REFUSES_EVERYTHING,
    errorLimitMaxErrors: raised,
  });

  // A burst well past CCP's own 100, simulating the reported startup burst.
  // Every one of these would have 420'd against the default budget.
  const burst = 150;
  for (let i = 0; i < burst; i += 1) {
    const result = await dispatch(request({ pathname: `/nope/${i}/` }));
    assert.equal(result.status, 404, `request ${i} should still be answered, not 420'd`);
  }

  const last = await dispatch(request({ pathname: "/nope/last/" }));
  assert.equal(last.status, 404);
  assert.equal(
    last.headers[HEADER_REMAIN],
    String(raised - burst - 1),
    "the raised budget, not CCP's 100, is what the response is charged against",
  );

  // It never touches the other limiter, which is still on its own budget.
  const grouped = await dispatch(request());
  assert.equal(familyOf(grouped), wire.LIMITER.TOKEN_BUCKET);
  assert.equal(grouped.headers["x-ratelimit-remaining"], String(600 - 2));
});

// The two limiters key differently (D39)

test("one address, two applications: the token bucket partitions and the error limiter does not", async () => {
  // `wire.LIMITER_KEY` is the 2026-08-25 capture, and its most expensive finding
  // is that the answer for one limiter is not the answer for the other. Each
  // module asserts its own half against the record; only the composed stack can
  // show the two halves disagreeing on the same pair of requests.
  assert.equal(wire.LIMITER_KEY.limitersAgree, false);
  assert.equal(wire.LIMITER_KEY.tokenBucket.key, "applicationOnly");
  assert.equal(wire.LIMITER_KEY.errorLimiter.key, "sourceAddress");

  const dispatch = pipeline({ verifier: NAMES_ITS_APPLICATION });
  const from = (application) => ({ authorization: `Bearer ${application}` });

  // The token bucket's route. Two applications from one address, and the second
  // finds a full budget rather than the first one's leavings.
  const a = await dispatch(request({ headers: from("application-a") }));
  const b = await dispatch(request({ headers: from("application-b") }));
  const aAgain = await dispatch(request({ headers: from("application-a") }));

  assert.equal(familyOf(a), wire.LIMITER.TOKEN_BUCKET);
  assert.equal(a.headers["x-ratelimit-remaining"], String(600 - 2));
  assert.equal(b.headers["x-ratelimit-remaining"], String(600 - 2), "a second application, a second bucket");
  assert.equal(aAgain.headers["x-ratelimit-remaining"], String(600 - 4), "and the first one continued");

  // The error limiter's route, same address, same two applications. One
  // counter, which is what "sourceAddress" means: 100 -> 99 -> 98 -> 97 on the
  // wire, across credentials that had never been seen before.
  const errors = [];
  for (const headers of [{}, from("application-a"), from("application-b")]) {
    const refused = await dispatch(request({ pathname: "/nope/", headers }));
    assert.equal(familyOf(refused), wire.LIMITER.ERROR_LIMIT);
    errors.push(refused.headers[HEADER_REMAIN]);
  }

  assert.deepEqual(
    errors,
    [wire.ERROR_LIMIT.maxErrors - 1, wire.ERROR_LIMIT.maxErrors - 2, wire.ERROR_LIMIT.maxErrors - 3].map(String),
    "the credential never started a second error budget",
  );
});

test("the 420 still reaches a browser, because CORS wraps both limiters", async () => {
  const dispatch = pipeline();

  for (let i = 0; i < wire.ERROR_LIMIT.maxErrors; i += 1) {
    await dispatch(request({ pathname: `/nope/${i}/` }));
  }

  const refused = await dispatch(request({ pathname: "/nope/again/" }));

  assert.equal(refused.headers["access-control-allow-origin"], wire.ALLOW_ORIGIN);
  assert.match(
    refused.headers["access-control-expose-headers"],
    /X-Esi-Error-Limit-Reset/,
    "a client that cannot read the reset cannot back off for the right length of time",
  );
});
