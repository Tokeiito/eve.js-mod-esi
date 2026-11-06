/**
 * `lib/rateLimiter.js`: the token bucket, and where its numbers come from.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Three sources, kept apart because they carry different weight:
 *
 *   `contract/openapi.json`   the 32 groups and their allowances, read through
 *                             `contract/spec.js`'s parser. `lib/` cannot import
 *                             `contract/` (D20), so the table is duplicated in
 *                             the module and re-derived here, as with
 *                             `lib/headers.js` `OBSERVED_CASE`.
 *
 *   `contract/wire.js`        the cost per status class, the header names and
 *   `TOKEN_BUCKET`            their order, and the `<max>/<window>` shape, each
 *   `LIMITER_SURVEY`          read off a live `X-Ratelimit-Used` on 2026-08-23.
 *                             The survey rows are asserted against directly.
 *
 *   `contract/wire.js`        the `429`, its `Retry-After`, the free `5XX`, the
 *   `LIMITER_UNOBSERVED`      free `429`, the refill and the body string. These
 *                             could not be observed without deliberately
 *                             exhausting CCP's limiter. They are CCP's
 *                             documentation and this module's choices, and the
 *                             tests say so where they rest on one.
 *
 * The `X-Ratelimit-*` family is not on every response. It is on responses to
 * routes that publish a group, and on nothing else: those have a bucket to
 * charge, and everything else belongs to the error limiter.
 *
 * Nothing here opens a socket, and nothing needs an eve.js checkout.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const spec = require(path.join(__dirname, "../contract/spec"));
const { titleCase } = require(path.join(__dirname, "../lib/headers"));
const { readCredential } = require(path.join(__dirname, "../lib/bearerCredential"));
const {
  CALLER_ADDRESS,
  CALLER_APPLICATION,
  COST_BY_CLASS,
  GROUP_LIMITS,
  KEY_SEPARATOR,
  MIN_CHARGE,
  OVER_LIMIT_BODY,
  OVER_LIMIT_COST,
  OVER_LIMIT_STATUS,
  RateLimitError,
  WINDOW_SECONDS,
  WINDOW_SIZE,
  assertKnownGroups,
  callerFor,
  costFor,
  createRateLimitDispatch,
  limitHeader,
  retryAfterSeconds,
} = require(path.join(__dirname, "../lib/rateLimiter"));

// Doubles

/**
 * A dispatch that records what reached it, so "refused without dispatching" is
 * a claim a test can make. `result` may be a function of the request, for the
 * tests that need a different status per call.
 */
function spy(result = { status: 200, body: { ok: true } }) {
  const calls = [];
  const dispatch = (request) => {
    calls.push(request);
    return typeof result === "function" ? result(request, calls.length) : result;
  };
  dispatch.calls = calls;
  return dispatch;
}

/** An injectable clock, so a 15-minute window is a test that runs instantly. */
function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const request = (overrides = {}) => ({
  method: "GET",
  pathname: "/latest/characters/90000001/notifications/",
  query: {},
  headers: {},
  remoteAddress: "10.0.0.1",
  ...overrides,
});

/** The injected selector, in its simplest form: one group for everything. */
const always = (group) => () => group;

/**
 * A verifier double whose tokens spell what the key is allowed to see.
 *
 * `Bearer <application>.<character>` verifies and projects those two as
 * `clientId` and `characterName`; anything else is refused. There is no RSA or
 * signing key, because these tests are about which of the two halves
 * partitions the budget; `test/bearerCredential.test.js` owns what makes a real
 * token verify. The token shape is a token68 so `lib/bearerToken.js` hands it
 * over rather than refusing it as malformed.
 */
const VERIFIER = {
  verify(token) {
    const parts = String(token).split(".");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      return { ok: false, reason: "MALFORMED" };
    }
    return { ok: true, claims: { clientId: parts[0], characterName: parts[1] } };
  },
};

/** The four cells of the capture, spelled as an `Authorization` header. */
const as = (application, character) => ({ authorization: `Bearer ${application}.${character}` });

/** A verifier that verifies, and names no application this key can use. */
const namesNoApplication = (clientId) => ({ verify: () => ({ ok: true, claims: { clientId } }) });

const remainingOf = (result) => result.headers["x-ratelimit-remaining"];

// The group table, against the pinned spec

test("the deployed group table is exactly what CCP's pinned spec publishes", () => {
  // lib/ cannot read contract/ (D20), so the 32 rows are typed into the module
  // and this test checks they did not drift. They are derived through
  // `contract/spec.js`'s `x-rate-limit` parser rather than a second parser, so
  // there is one reading of the spec.
  const doc = spec.loadSpec();
  const derived = new Map();

  for (const [specPath, item] of Object.entries(doc.paths)) {
    for (const verb of Object.keys(item)) {
      if (!spec.BODY_METHODS.includes(verb)) continue;

      const { rateLimit } = spec.describeOperation(verb, specPath);
      if (!rateLimit) continue;

      const seen = derived.get(rateLimit.group);
      assert.ok(
        seen === undefined || seen === rateLimit.maxTokens,
        `the spec publishes group ${rateLimit.group} with two allowances, ${seen} and ${rateLimit.maxTokens} `
          + ": GROUP_LIMITS is a flat table and could not represent that",
      );
      derived.set(rateLimit.group, rateLimit.maxTokens);
    }
  }

  assert.deepEqual(
    Object.fromEntries([...derived.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    Object.fromEntries(Object.entries(GROUP_LIMITS).sort(([a], [b]) => (a < b ? -1 : 1))),
  );
});

test("there are 32 groups, which is the count the survey recorded", () => {
  assert.equal(Object.keys(GROUP_LIMITS).length, wire.TOKEN_BUCKET.groupCount);
});

test("every rate-limited operation in the spec declares the same 15m window", () => {
  // Which is why `WINDOW_SIZE` is one constant rather than a column of the
  // group table: a second window would make `X-Ratelimit-Limit` per-group on
  // both halves.
  const doc = spec.loadSpec();
  const windows = new Set();

  for (const [specPath, item] of Object.entries(doc.paths)) {
    for (const verb of Object.keys(item)) {
      if (!spec.BODY_METHODS.includes(verb)) continue;
      const { rateLimit } = spec.describeOperation(verb, specPath);
      if (rateLimit) windows.add(rateLimit.windowSize);
    }
  }

  assert.deepEqual([...windows], [wire.TOKEN_BUCKET.windowSize]);
  assert.equal(WINDOW_SIZE, wire.TOKEN_BUCKET.windowSize);
  assert.equal(WINDOW_SECONDS, wire.TOKEN_BUCKET.windowSeconds);
});

test("the nine allowances quoted are the nine the spec publishes", () => {
  // Nine of the 32 were listed in the original request. They agree, which is
  // the reason to trust the other 23 came from the same place.
  assert.equal(GROUP_LIMITS["market-order"], 12000);
  assert.equal(GROUP_LIMITS.killmail, 3600);
  assert.equal(GROUP_LIMITS.routes, 3600);
  assert.equal(GROUP_LIMITS["char-location"], 1200);
  assert.equal(GROUP_LIMITS.status, 600);
  assert.equal(GROUP_LIMITS.sovereignty, 600);
  assert.equal(GROUP_LIMITS.incursion, 150);
  assert.equal(GROUP_LIMITS["char-killmail"], 30);
  assert.equal(GROUP_LIMITS["char-notification"], 15);
});

test("the group table is frozen, because a limit is not a runtime decision", () => {
  assert.ok(Object.isFrozen(GROUP_LIMITS));
});

// The cost table, against the survey

test("every status the survey charged costs what its X-Ratelimit-Used said", () => {
  // The strongest assertion in this file: each row is one live request, and the
  // number comes off the response CCP sent rather than out of this codebase.
  const charged = wire.LIMITER_SURVEY
    .filter((row) => row.limiter === wire.LIMITER.TOKEN_BUCKET)
    .map((row) => ({ row, used: /Used: (\d+)/.exec(row.note) }))
    .filter(({ used }) => used !== null);

  assert.ok(charged.length >= 6, "the survey should still carry the rows this test reads");

  for (const { row, used } of charged) {
    assert.equal(costFor(row.status), Number(used[1]), `${row.request} -> ${row.status}`);
  }
});

test("a 2XX costs two tokens, a 3XX one, and a 4XX five", () => {
  assert.deepEqual(
    { 2: COST_BY_CLASS[2], 3: COST_BY_CLASS[3], 4: COST_BY_CLASS[4] },
    { 2: wire.TOKEN_BUCKET.cost[2], 3: wire.TOKEN_BUCKET.cost[3], 4: wire.TOKEN_BUCKET.cost[4] },
  );
  assert.equal(costFor(200), 2);
  assert.equal(costFor(304), 1);
  assert.equal(costFor(422), 5);
});

test("a 5XX is free, which is CCP's documentation and was not observed", () => {
  // Unobserved, and the entry most worth being right about: it is the
  // difference between a broken endpoint costing a client its whole budget and
  // costing it nothing.
  assert.equal(costFor(500), wire.LIMITER_UNOBSERVED.tokenBucketCostServerError);
  assert.equal(costFor(503), wire.LIMITER_UNOBSERVED.tokenBucketCostServerError);
});

test("a 429 does not charge for itself, so knocking cannot extend the lockout", () => {
  assert.equal(costFor(OVER_LIMIT_STATUS), wire.LIMITER_UNOBSERVED.tokenBucketCostOverLimit);
  assert.equal(OVER_LIMIT_COST, 0);
});

test("a status this replica never sends is free rather than guessed at", () => {
  assert.equal(costFor(100), 0);
  assert.equal(costFor(undefined), 0);
  assert.equal(costFor("200"), 0);
});

test("the refusal threshold is derived from the cost table, not written as one", () => {
  assert.equal(MIN_CHARGE, 1);
  assert.equal(MIN_CHARGE, Math.min(...Object.values(COST_BY_CLASS).filter((c) => c > 0)));
});

// The published header shapes

test("X-Ratelimit-Limit is max tokens over the window's name, not its seconds", () => {
  assert.equal(limitHeader(600), wire.TOKEN_BUCKET.limit(600, wire.TOKEN_BUCKET.windowSize));
  assert.equal(limitHeader(600), "600/15m");
  assert.notEqual(limitHeader(600), "600/900");
});

test("the four headers are CCP's four, in CCP's order and CCP's casing", async () => {
  const dispatch = createRateLimitDispatch(spy(), { groupFor: always("status") });

  const result = await dispatch(request());
  const sent = Object.keys(result.headers).map(titleCase);

  assert.deepEqual(sent, [...wire.TOKEN_BUCKET.headers]);
  // `X-Ratelimit-Group`, not the conventional `X-RateLimit-Group`. CCP
  // title-cases mechanically and `lib/headers.js` reproduces that.
  assert.ok(sent.includes("X-Ratelimit-Group"));
  assert.ok(!sent.includes("X-RateLimit-Group"));
});

// Only a grouped route is this limiter's

test("a route with no group is passed through with no X-Ratelimit header at all", async () => {
  // The headers are not on every response: an ungrouped route carries the error
  // limiter's family instead, and a response carrying both would be a shape
  // live ESI never sends.
  const next = spy({ status: 200, body: { ok: true }, headers: { "content-type": "application/json" } });
  const dispatch = createRateLimitDispatch(next, { groupFor: always(null) });

  const result = await dispatch(request());

  assert.equal(next.calls.length, 1);
  assert.deepEqual(Object.keys(result.headers), ["content-type"]);
});

test("the group is asked once, before the request is dispatched", async () => {
  // Once: asking the route table rather than reading the result lets the
  // refusal happen without doing the work.
  const asked = [];
  const next = spy();
  const dispatch = createRateLimitDispatch(next, {
    groupFor: (req) => {
      asked.push(req);
      return "status";
    },
  });

  await dispatch(request());

  assert.equal(asked.length, 1);
  assert.equal(asked[0].pathname, "/latest/characters/90000001/notifications/");
});

test("a group the spec does not publish is passed through unmetered", async () => {
  // Documented, and deliberately quiet at request time: the alternatives are
  // refusing traffic ESI would answer, or advertising a limit that is not
  // CCP's. `assertKnownGroups` is what makes it loud, at construction.
  const next = spy({ status: 200, headers: { "content-type": "application/json" } });
  const dispatch = createRateLimitDispatch(next, { groupFor: always("invented-group") });

  const result = await dispatch(request());

  assert.equal(next.calls.length, 1);
  assert.deepEqual(Object.keys(result.headers), ["content-type"]);
});

test("a group named after an Object prototype member is unknown, not a limit", async () => {
  // The group comes from a route table, and `limits["constructor"]` on a plain
  // object is a function rather than `undefined`. A `Map` is why this is a
  // passthrough instead of `X-Ratelimit-Limit: function Object() ...`.
  const next = spy({ status: 200, headers: { "content-type": "application/json" } });
  const dispatch = createRateLimitDispatch(next, { groupFor: always("constructor") });

  const result = await dispatch(request());

  assert.deepEqual(Object.keys(result.headers), ["content-type"]);
});

// Charging

test("a 200 charges two tokens and reports the balance after the charge", async () => {
  const dispatch = createRateLimitDispatch(spy(), { groupFor: always("status") });

  const result = await dispatch(request());

  assert.equal(result.headers["x-ratelimit-group"], "status");
  assert.equal(result.headers["x-ratelimit-limit"], "600/15m");
  assert.equal(result.headers["x-ratelimit-used"], "2");
  assert.equal(result.headers["x-ratelimit-remaining"], "598");
});

test("a 304 charges one token: a revalidation costs, on this limiter", async () => {
  // The opposite of the error limiter, where a 304 is free. Both were observed,
  // one request each.
  const dispatch = createRateLimitDispatch(spy({ status: 304 }), { groupFor: always("status") });

  const result = await dispatch(request());

  assert.equal(result.headers["x-ratelimit-used"], "1");
  assert.equal(result.headers["x-ratelimit-remaining"], "599");
});

test("a 401 charges five: an unauthenticated call still costs the route's bucket", async () => {
  const dispatch = createRateLimitDispatch(spy({ status: 401 }), { groupFor: always("char-location") });

  const result = await dispatch(request());

  assert.equal(result.headers["x-ratelimit-used"], "5");
  assert.equal(result.headers["x-ratelimit-remaining"], String(1200 - 5));
});

test("a 500 costs nothing, so a broken endpoint cannot spend a client's budget", async () => {
  const dispatch = createRateLimitDispatch(spy({ status: 500 }), { groupFor: always("status") });

  const result = await dispatch(request());

  assert.equal(result.headers["x-ratelimit-used"], "0");
  assert.equal(result.headers["x-ratelimit-remaining"], "600");
});

test("successive requests draw down one bucket", async () => {
  const dispatch = createRateLimitDispatch(spy(), { groupFor: always("status") });

  const first = await dispatch(request());
  const second = await dispatch(request());
  const third = await dispatch(request());

  assert.deepEqual(
    [first, second, third].map((r) => r.headers["x-ratelimit-remaining"]),
    ["598", "596", "594"],
  );
});

test("a header the wrapped dispatch already set wins over this layer's", async () => {
  // The same rule `lib/cors.js` and `lib/cache.js` follow: two spellings of one
  // header go out as one comma-joined value, which is invisible until a client
  // splits on it.
  const next = spy({ status: 200, headers: { "x-ratelimit-group": "set-below" } });
  const dispatch = createRateLimitDispatch(next, { groupFor: always("status") });

  const result = await dispatch(request());

  assert.equal(result.headers["x-ratelimit-group"], "set-below");
});

test("a dispatch that answers with something that is not a result is left alone", async () => {
  const dispatch = createRateLimitDispatch(() => undefined, { groupFor: always("status") });

  assert.equal(await dispatch(request()), undefined);
});

// Refusal

test("exhausting a group returns 429 with Retry-After", async () => {
  // `char-notification` is 15 tokens per 15 minutes, the smallest allowance CCP
  // publishes and therefore the one a test can exhaust honestly: eight 200s
  // spend it.
  const time = clock();
  const next = spy();
  const dispatch = createRateLimitDispatch(next, {
    groupFor: always("char-notification"),
    now: time.now,
  });

  for (let i = 0; i < 8; i += 1) await dispatch(request());
  const dispatched = next.calls.length;
  const refused = await dispatch(request());

  assert.equal(refused.status, OVER_LIMIT_STATUS);
  assert.equal(refused.status, wire.LIMITER_UNOBSERVED.tokenBucketOverStatus);
  assert.ok(wire.LIMITER_UNOBSERVED.tokenBucketOverSendsRetryAfter);
  assert.equal(refused.headers["retry-after"], "60");
  // Refused before dispatching: a limiter that finds out after the handler ran
  // has already done the work it was supposed to refuse.
  assert.equal(next.calls.length, dispatched);
});

test("the refusal carries the same four headers, an empty balance and no charge", async () => {
  const dispatch = createRateLimitDispatch(spy(), { groupFor: always("char-notification") });

  for (let i = 0; i < 8; i += 1) await dispatch(request());
  const refused = await dispatch(request());

  assert.equal(refused.headers["x-ratelimit-group"], "char-notification");
  assert.equal(refused.headers["x-ratelimit-limit"], "15/15m");
  assert.equal(refused.headers["x-ratelimit-remaining"], "0");
  assert.equal(refused.headers["x-ratelimit-used"], "0");
});

test("the refusal body is the placeholder wire.js marks as unobserved", () => {
  // Neither string nor status could be observed without deliberately exhausting
  // CCP's limiter. `contract/wire.js` holds the same placeholder, and one edit
  // there fails this when the real one is seen.
  assert.equal(OVER_LIMIT_BODY, wire.LIMITER_UNOBSERVED.tokenBucketOverBody);
  assert.equal(OVER_LIMIT_STATUS, wire.LIMITER_UNOBSERVED.tokenBucketOverStatus);
});

test("the refusal is shaped like an edge refusal, because that is what it is", async () => {
  // Refused in front of the route, so the gateway writes it: `application/json`,
  // `nosniff`, and Go's trailing newline via `producer`.
  const dispatch = createRateLimitDispatch(spy(), { groupFor: always("char-notification") });

  for (let i = 0; i < 8; i += 1) await dispatch(request());
  const refused = await dispatch(request());

  assert.deepEqual(refused.body, { error: OVER_LIMIT_BODY });
  assert.equal(refused.producer, "gateway");
  assert.equal(refused.headers["content-type"], "application/json");
  assert.equal(refused.headers["x-content-type-options"], "nosniff");
});

test("Retry-After is the seconds until one token exists, and never zero", () => {
  // It follows from the continuous refill rather than being a second guess at
  // the same quantity. 15 tokens per 900 s is one per minute.
  assert.equal(retryAfterSeconds(0, GROUP_LIMITS["char-notification"]), 60);
  assert.equal(retryAfterSeconds(0.5, GROUP_LIMITS["char-notification"]), 30);
  // 12000 per 900 s is 13 a second: the honest answer is a fraction, and the
  // smallest thing a client can be told is 1.
  assert.equal(retryAfterSeconds(0, GROUP_LIMITS["market-order"]), 1);
  assert.equal(retryAfterSeconds(1, GROUP_LIMITS["status"]), 1);
});

test("the bucket never goes negative, however expensive the last response is", async () => {
  // Three tokens left and a 4XX costing five. CCP's `Remaining` was never seen
  // below zero, and a bucket that can carry debt lets a client be talked into a
  // lockout longer than the limit describes.
  const time = clock();
  const next = spy((req, call) => ({ status: call <= 6 ? 200 : 400 }));
  const dispatch = createRateLimitDispatch(next, {
    groupFor: always("char-notification"),
    now: time.now,
  });

  for (let i = 0; i < 6; i += 1) await dispatch(request());   // 15 - 12 = 3 left
  const expensive = await dispatch(request());

  assert.equal(expensive.headers["x-ratelimit-remaining"], "0");
  // Reported as what was actually deducted, so `Remaining` and `Used` on one
  // response still agree. Whether CCP clamps `Used` too is unobserved: the
  // survey never came near an empty bucket.
  assert.equal(expensive.headers["x-ratelimit-used"], "3");
});

// Isolation

test("exhausting one group leaves the others usable", async () => {
  // The bucket is keyed on the group rather than on the caller alone.
  const groups = new Map([
    ["/latest/characters/1/notifications/", "char-notification"],
    ["/latest/killmails/1/abc/", "killmail"],
  ]);
  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: (req) => groups.get(req.pathname) || null,
  });

  for (let i = 0; i < 9; i += 1) {
    await dispatch(request({ pathname: "/latest/characters/1/notifications/" }));
  }
  const other = await dispatch(request({ pathname: "/latest/killmails/1/abc/" }));

  assert.equal(other.status, 200);
  assert.equal(other.headers["x-ratelimit-group"], "killmail");
  assert.equal(other.headers["x-ratelimit-remaining"], String(3600 - 2));
});

test("exhausting one caller's bucket leaves every other caller usable", async () => {
  // Per group globally would let one client exhaust `market-order` for
  // everybody on the server.
  const dispatch = createRateLimitDispatch(spy(), { groupFor: always("char-notification") });

  for (let i = 0; i < 9; i += 1) await dispatch(request({ remoteAddress: "10.0.0.1" }));

  const refused = await dispatch(request({ remoteAddress: "10.0.0.1" }));
  const stranger = await dispatch(request({ remoteAddress: "10.0.0.2" }));

  assert.equal(refused.status, OVER_LIMIT_STATUS);
  assert.equal(stranger.status, 200);
  assert.equal(stranger.headers["x-ratelimit-remaining"], "13");
});

test("a caller with no address gets a bucket of its own that is never kept", async () => {
  // `remoteAddress` is null for a request that did not arrive on a socket. One
  // shared "unknown" bucket would be exhaustible by every anonymous caller on
  // behalf of every other one, and a remote client cannot make its own address
  // null, so refusing them buys nothing.
  const dispatch = createRateLimitDispatch(spy(), { groupFor: always("char-notification") });

  let last = null;
  for (let i = 0; i < 50; i += 1) last = await dispatch(request({ remoteAddress: null }));

  assert.equal(last.status, 200);
  assert.equal(last.headers["x-ratelimit-remaining"], "13");
  assert.equal(dispatch.bucketCount(), 0);
});

// Who the caller is (D39)
//
// The 2026-08-25 capture, replayed against this module. Every wire fact below
// is asserted from `contract/wire.js` `LIMITER_KEY` rather than restated, so a
// corrected observation fails these tests instead of leaving a comment that
// disagrees with the record.

test("the capture replays: three budgets on one address, one per application plus the unauthenticated one", async () => {
  // Live ESI, `GET /latest/status/`, group `status`, 2 tokens a call, one
  // address, one 15m window. Unauthenticated read 598 then 596; application A
  // read 598 then 596 across two different characters; application B did the
  // same. Four credentials, three buckets.
  assert.equal(wire.LIMITER_KEY.tokenBucket.group, "status");
  assert.equal(wire.LIMITER_KEY.tokenBucket.key, "applicationOnly");
  assert.equal(wire.LIMITER_KEY.tokenBucket.distinctBudgetsSeen, 3);

  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("status"),
    verifier: VERIFIER,
  });

  const readings = [];
  for (const headers of [
    {},
    {},
    as("application-a", "character-1"),
    as("application-a", "character-2"),
    as("application-b", "character-1"),
    as("application-b", "character-2"),
  ]) {
    readings.push(remainingOf(await dispatch(request({ headers }))));
  }

  assert.deepEqual(readings, ["598", "596", "598", "596", "598", "596"]);
  assert.equal(dispatch.bucketCount(), wire.LIMITER_KEY.tokenBucket.distinctBudgetsSeen);
});

test("two characters under one application share one bucket", async () => {
  // The character half does not move the budget: that is the half of CCP's
  // documented `applicationID:characterID` that the wire refuses.
  assert.equal(wire.LIMITER_KEY.tokenBucket.characterMovesTheBudget, false);

  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("status"),
    verifier: VERIFIER,
  });

  const one = await dispatch(request({ headers: as("application-a", "character-1") }));
  const other = await dispatch(request({ headers: as("application-a", "character-2") }));

  assert.equal(remainingOf(one), "598");
  assert.equal(remainingOf(other), "596", "a second character continued the first one's bucket");
  assert.equal(dispatch.bucketCount(), 1);
});

test("the same character under two applications gets two buckets", async () => {
  // The other half of the 2x2, and the half that does move.
  assert.equal(wire.LIMITER_KEY.tokenBucket.applicationMovesTheBudget, true);

  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("status"),
    verifier: VERIFIER,
  });

  const first = await dispatch(request({ headers: as("application-a", "character-1") }));
  const second = await dispatch(request({ headers: as("application-b", "character-1") }));

  assert.equal(remainingOf(first), "598");
  assert.equal(remainingOf(second), "598", "one character, two applications, two full buckets");
  assert.equal(dispatch.bucketCount(), 2);
});

test("an authenticated caller does not draw on the unauthenticated bucket, from the same address", async () => {
  // `sourceAddress` was rejected by this reading: it predicted 594 at the first
  // authenticated cell and the wire said 598. The two are separate budgets
  // rather than one bucket keyed two ways, which is why the key tags how the
  // caller was named instead of concatenating the value raw.
  assert.equal(wire.LIMITER_KEY.tokenBucket.sharedWithUnauthenticated, false);
  assert.ok(wire.LIMITER_KEY.tokenBucket.ruledOut.includes("sourceAddress"));

  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("status"),
    verifier: VERIFIER,
  });

  await dispatch(request({ remoteAddress: "10.0.0.1" }));
  await dispatch(request({ remoteAddress: "10.0.0.1" }));
  const authenticated = await dispatch(request({
    remoteAddress: "10.0.0.1",
    headers: as("application-a", "character-1"),
  }));

  assert.equal(remainingOf(authenticated), "598");
});

test("an application whose client id spells an address does not land in that address's bucket", async () => {
  // The two namespaces are tagged apart in the key rather than trusted never to
  // overlap. A client id is a string an application registrar chose and an
  // address is a string the socket reports; nothing stops them colliding, and
  // the observation says the two budgets are separate.
  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("status"),
    verifier: namesNoApplication("10.0.0.1"),
  });

  await dispatch(request({ remoteAddress: "10.0.0.1" }));
  const collision = await dispatch(request({
    remoteAddress: "10.0.0.2",
    headers: { authorization: "Bearer whatever" },
  }));

  assert.equal(remainingOf(collision), "598");
  assert.equal(dispatch.bucketCount(), 2);
  assert.notEqual(
    callerFor(request({ remoteAddress: "10.0.0.1" }), null),
    callerFor(request({ remoteAddress: "10.0.0.2", headers: { authorization: "Bearer x" } }), namesNoApplication("10.0.0.1")),
  );
});

test("an unauthenticated caller still keys on the group and the address, exactly as before", async () => {
  // Nothing about the unauthenticated half moved. It is the same behaviour the
  // isolation tests above assert, and it holds with a verifier wired in.
  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("status"),
    verifier: VERIFIER,
  });

  const one = await dispatch(request({ remoteAddress: "10.0.0.1" }));
  const stranger = await dispatch(request({ remoteAddress: "10.0.0.2" }));
  const again = await dispatch(request({ remoteAddress: "10.0.0.1" }));

  assert.equal(remainingOf(one), "598");
  assert.equal(remainingOf(stranger), "598");
  assert.equal(remainingOf(again), "596");
});

test("a presented credential that does not verify keys on the address, not on the token", async () => {
  // Deliberate, and the safe direction rather than the observed one: this case
  // was never on the wire, because `lib/bearerCredential.js` answers it 401 in
  // front of routing (`wire.BEARER.presentedAndBad`), so `groupFor` answers null
  // and this layer passes it through unmetered. Were it reachable, a client id
  // inside an unverified token is a string the client picked, and keying on one
  // would let a caller mint a fresh budget per request, which is the failure
  // X-Forwarded-For is refused for.
  assert.equal(wire.BEARER.presentedAndBad.status, 401);

  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("status"),
    verifier: VERIFIER,
  });

  const unauthenticated = await dispatch(request({ remoteAddress: "10.0.0.1" }));
  const bad = await dispatch(request({
    remoteAddress: "10.0.0.1",
    headers: { authorization: "Bearer not-two-parts" },
  }));
  const alsoBad = await dispatch(request({
    remoteAddress: "10.0.0.1",
    headers: { authorization: "Basic dXNlcjpwdw==" },
  }));

  assert.equal(remainingOf(unauthenticated), "598");
  assert.equal(remainingOf(bad), "596", "shares the address's bucket rather than minting one");
  assert.equal(remainingOf(alsoBad), "594");
  assert.equal(dispatch.bucketCount(), 1);
});

test("a verified credential naming no usable application falls back to the address", async () => {
  // `null`, `""` and a missing claim all mean a caller this layer cannot name
  // by application. Those callers must never share a bucket with each other.
  for (const clientId of [null, "", undefined, 42]) {
    const dispatch = createRateLimitDispatch(spy(), {
      groupFor: always("status"),
      verifier: namesNoApplication(clientId),
    });

    const first = await dispatch(request({
      remoteAddress: "10.0.0.1",
      headers: { authorization: "Bearer anything" },
    }));
    const stranger = await dispatch(request({
      remoteAddress: "10.0.0.2",
      headers: { authorization: "Bearer anything" },
    }));

    assert.equal(remainingOf(first), "598", `clientId ${JSON.stringify(clientId)}`);
    assert.equal(remainingOf(stranger), "598", "two addresses, two buckets, never one shared");
    assert.equal(dispatch.bucketCount(), 2);
  }
});

test("the application replaces the address inside the group key and never replaces the group", async () => {
  // Per group, still. One application exhausting `char-notification` leaves its
  // own `killmail` budget alone, and two applications on one group hold two
  // buckets.
  const groups = new Map([
    ["/latest/characters/1/notifications/", "char-notification"],
    ["/latest/killmails/1/abc/", "killmail"],
  ]);
  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: (req) => groups.get(req.pathname) || null,
    verifier: VERIFIER,
  });

  const headers = as("application-a", "character-1");
  for (let i = 0; i < 9; i += 1) {
    await dispatch(request({ pathname: "/latest/characters/1/notifications/", headers }));
  }

  const exhausted = await dispatch(request({
    pathname: "/latest/characters/1/notifications/",
    headers,
  }));
  const otherGroup = await dispatch(request({ pathname: "/latest/killmails/1/abc/", headers }));
  const otherApplication = await dispatch(request({
    pathname: "/latest/characters/1/notifications/",
    headers: as("application-b", "character-1"),
  }));

  assert.equal(exhausted.status, OVER_LIMIT_STATUS);
  assert.equal(otherGroup.status, 200);
  assert.equal(remainingOf(otherGroup), String(3600 - 2));
  assert.equal(otherApplication.status, 200);
  assert.equal(remainingOf(otherApplication), "13");
});

test("a caller nameable by neither application nor address is metered but not remembered", async () => {
  // The rule survives the rekey unchanged. One shared "unknown" bucket would be
  // exhaustible by every anonymous caller on behalf of every other one.
  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("char-notification"),
    verifier: VERIFIER,
  });

  let last = null;
  for (let i = 0; i < 50; i += 1) {
    last = await dispatch(request({
      remoteAddress: null,
      headers: { authorization: "Bearer not-two-parts" },
    }));
  }

  assert.equal(last.status, 200);
  assert.equal(remainingOf(last), "13");
  assert.equal(dispatch.bucketCount(), 0);
});

test("with no verifier every caller keys on its address, which is the safe degradation", async () => {
  // `loader.js` starts the ESI listener whether or not the SSO surface came up.
  // With no signing key a credential reads as absent, so an authenticated
  // client shares a budget it should have had to itself, never the reverse.
  const dispatch = createRateLimitDispatch(spy(), { groupFor: always("status") });

  const first = await dispatch(request({ headers: as("application-a", "character-1") }));
  const second = await dispatch(request({ headers: as("application-b", "character-2") }));

  assert.equal(remainingOf(first), "598");
  assert.equal(remainingOf(second), "596", "one bucket, because neither credential could be read");
});

test("the caller key is tagged by how the caller was named", () => {
  const authenticated = request({ headers: as("application-a", "character-1") });

  assert.equal(
    callerFor(authenticated, VERIFIER),
    `${CALLER_APPLICATION}${KEY_SEPARATOR}application-a`,
  );
  assert.equal(
    callerFor(request(), VERIFIER),
    `${CALLER_ADDRESS}${KEY_SEPARATOR}10.0.0.1`,
  );
  assert.equal(
    callerFor(request({ headers: as("application-a", "character-1") }), null),
    `${CALLER_ADDRESS}${KEY_SEPARATOR}10.0.0.1`,
    "no verifier, no application",
  );
  assert.equal(callerFor(request({ remoteAddress: null }), VERIFIER), null);
  assert.equal(callerFor(request({ remoteAddress: "" }), VERIFIER), null);
  assert.equal(callerFor(null, VERIFIER), null);
});

test("reading the credential here costs no second verification", async () => {
  // `lib/pipeline.js`'s `groupFor` has already read the credential by the time
  // the bucket is chosen, and `lib/bearerCredential.js` memoises the reading per
  // request object, so this layer may ask without a second RSA verification.
  let verifications = 0;
  const counting = {
    verify(token) {
      verifications += 1;
      return { ok: true, claims: { clientId: String(token) } };
    },
  };

  const dispatch = createRateLimitDispatch(spy(), {
    // The shape `createGroupFor` has: it asks the same question first.
    groupFor: (req) => (readCredential(req, counting).refusal ? null : "status"),
    verifier: counting,
  });

  await dispatch(request({ headers: { authorization: "Bearer application-a" } }));

  assert.equal(verifications, 1);
});

test("the two limiters do not agree, and this is the one that keys on the application", () => {
  // The error limiter and this one are separate mechanisms, probed separately
  // on their own routes, and they came back with different keys. Neither answer
  // may be derived from the other.
  assert.equal(wire.LIMITER_KEY.limitersAgree, false);
  assert.equal(wire.LIMITER_KEY.tokenBucket.key, "applicationOnly");
  assert.equal(wire.LIMITER_KEY.errorLimiter.key, "sourceAddress");

  // What a complete 2x2 still cannot say is which spelling of the application
  // CCP means. `azp`'s client id and the registered application's numeric id
  // partition identically, so the budget this file produces is the observed one
  // under either. That is why `applicationIdSpelling` is null and why keying on
  // `claims.clientId` is not a guess standing in for a fact.
  assert.equal(wire.LIMITER_KEY.applicationIdSpelling, null);
  assert.equal(
    wire.LIMITER_UNOBSERVED.errorLimitKeyQuestions.whatApplicationIdIs,
    "unobserved",
  );
});

// The floating window

test("tokens return continuously rather than all at once on a boundary", async () => {
  // Unobserved: `contract/wire.js` records "floating window" as CCP's phrase and
  // nothing more. Continuous is the reading this module chose: a fixed window
  // lets a client spend a full allowance at the end of one and another at the
  // start of the next, twice the published rate for a moment.
  const time = clock();
  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("char-notification"),
    now: time.now,
  });

  for (let i = 0; i < 9; i += 1) await dispatch(request());
  const refused = await dispatch(request());
  assert.equal(refused.status, OVER_LIMIT_STATUS);

  // Exactly the Retry-After it just quoted, and not a second less.
  time.advance(59_000);
  assert.equal((await dispatch(request())).status, OVER_LIMIT_STATUS);

  time.advance(1_000);
  const allowed = await dispatch(request());
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers["x-ratelimit-used"], "1");
  assert.equal(allowed.headers["x-ratelimit-remaining"], "0");
});

test("a whole window of silence refills the bucket and no more", async () => {
  const time = clock();
  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("status"),
    now: time.now,
  });

  await dispatch(request());
  time.advance(WINDOW_SECONDS * 1000 * 10);
  const later = await dispatch(request());

  assert.equal(later.headers["x-ratelimit-remaining"], String(600 - 2));
});

test("a clock that jumps backwards refills late rather than twice", async () => {
  // `Date.now()` moves backwards on any machine that talks to an NTP server.
  // Of the two ways to be wrong about it, refilling slowly cannot be exploited.
  const time = clock();
  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("status"),
    now: time.now,
  });

  await dispatch(request());
  time.advance(-60_000);
  const backwards = await dispatch(request());

  assert.equal(backwards.headers["x-ratelimit-remaining"], String(600 - 4));
});

// The bound on the bucket map

test("the bucket map is bounded, so a hostile client cannot exhaust memory", async () => {
  // The mod runs inside a live game process and the map is keyed on
  // attacker-controlled input. An unbounded one is a memory-exhaustion bug in
  // somebody's game server.
  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("char-notification"),
    maxBuckets: 4,
  });

  for (let i = 0; i < 2000; i += 1) {
    await dispatch(request({ remoteAddress: `198.51.100.${i}` }));
  }

  assert.ok(dispatch.bucketCount() <= 4, `held ${dispatch.bucketCount()} buckets against a cap of 4`);
});

test("a flood of fresh addresses does not evict the bucket it is trying to reset", async () => {
  // Eviction is fullest-first, not the LRU `lib/pagination.js` uses.
  // Least-recently-used would drop the long-lived exhausted bucket of the caller
  // being throttled and hand them a fresh full one: the eviction policy would be
  // the bypass.
  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("char-notification"),
    maxBuckets: 4,
  });

  for (let i = 0; i < 9; i += 1) await dispatch(request({ remoteAddress: "10.0.0.1" }));
  assert.equal((await dispatch(request({ remoteAddress: "10.0.0.1" }))).status, OVER_LIMIT_STATUS);

  for (let i = 0; i < 500; i += 1) {
    await dispatch(request({ remoteAddress: `198.51.100.${i}` }));
  }

  const victim = await dispatch(request({ remoteAddress: "10.0.0.1" }));
  assert.equal(victim.status, OVER_LIMIT_STATUS);
  assert.ok(dispatch.bucketCount() <= 4);
});

test("a bucket that has refilled to full is dropped before a partly spent one", async () => {
  // A full bucket is indistinguishable from one that does not exist, so
  // forgetting it costs nothing and is the first thing reclaim does.
  const time = clock();
  const dispatch = createRateLimitDispatch(spy(), {
    groupFor: always("status"),
    now: time.now,
    maxBuckets: 2,
  });

  await dispatch(request({ remoteAddress: "10.0.0.1" }));   // spends, then refills
  time.advance(WINDOW_SECONDS * 1000);
  await dispatch(request({ remoteAddress: "10.0.0.2" }));   // spends, stays partial
  await dispatch(request({ remoteAddress: "10.0.0.3" }));   // forces the reclaim

  const partlySpent = await dispatch(request({ remoteAddress: "10.0.0.2" }));

  assert.equal(dispatch.bucketCount(), 2);
  assert.equal(partlySpent.headers["x-ratelimit-remaining"], String(600 - 4));
});

// Construction

test("a limiter with nothing to wrap is a construction error", () => {
  assert.throws(() => createRateLimitDispatch(), RateLimitError);
  assert.throws(() => createRateLimitDispatch(spy()), RateLimitError);
  assert.throws(() => createRateLimitDispatch(spy(), { groupFor: "status" }), RateLimitError);
});

test("a maxBuckets that is not a positive integer is a construction error", () => {
  for (const maxBuckets of [0, -1, 1.5, Infinity, "4096", null]) {
    assert.throws(
      () => createRateLimitDispatch(spy(), { groupFor: always("status"), maxBuckets }),
      RateLimitError,
      `maxBuckets ${JSON.stringify(maxBuckets)}`,
    );
  }
});

test("a limits table with an allowance that is not a positive integer is refused", () => {
  assert.throws(
    () => createRateLimitDispatch(spy(), { groupFor: always("status"), limits: { status: "600" } }),
    RateLimitError,
  );
});

test("a route declaring a group CCP does not publish fails at construction", () => {
  // The route table's mistake, found while the table is being built (the same
  // habit as `RouteTableError` in `lib/router.js`). At request time the honest
  // options are "invent an allowance" and "pretend the route is ungrouped", and
  // neither should be discovered in production.
  assert.throws(
    () => assertKnownGroups(["status", "market-orders"]),
    (error) => error instanceof RateLimitError && /market-orders/.test(error.message),
  );
  assert.throws(
    () => createRateLimitDispatch(spy(), { groupFor: always("status"), groups: ["status", "typo"] }),
    RateLimitError,
  );
});

test("an ungrouped route is not a group CCP failed to publish", () => {
  // `null` is most of the route table (62 of the spec's 197 operations, plus
  // `/ping`), so it passes the check rather than tripping it.
  assert.doesNotThrow(() => assertKnownGroups([null, undefined, ...Object.keys(GROUP_LIMITS)]));
  assert.doesNotThrow(
    () => createRateLimitDispatch(spy(), { groupFor: always(null), groups: [null, "status"] }),
  );
});
