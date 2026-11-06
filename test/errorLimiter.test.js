/**
 * The error limiter: `X-Esi-Error-Limit-*` and the `420`.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * Two sources of assertions, of different kinds.
 *
 * The counting rules were observed: `contract/wire.js` `ERROR_LIMIT` and
 * `LIMITER_SURVEY` hold seventeen live requests from 2026-08-23, and every
 * assertion about which statuses charge, what `Remain` reports and which
 * responses carry the family at all is compared against them rather than
 * restated. Changing the observation turns this file red, instead of two
 * copies of a number agreeing with each other and disagreeing with CCP.
 *
 * The behaviour past the limit was not observed and could not be: the only way
 * to see a real `420` is to exhaust a third party's limiter deliberately.
 * `contract/wire.js` `LIMITER_UNOBSERVED` carries CCP's documented status, the
 * absent `Retry-After` and a deliberately boring placeholder body as claims.
 * `lib/errorLimiter.js` keeps its own copy because `contract/` is test-only and
 * never deployed (D20), and the tests compare the two.
 *
 * The `X-Esi-Error-Limit-*` headers do not appear on every response. ESI runs
 * two limiters and a response carries one family or neither, selected by
 * whether the resolved route publishes a rate-limit group. Several tests are
 * about the absence of these headers for that reason.
 *
 * No socket is opened and no eve.js checkout is needed; the layer is driven
 * through a plain dispatch double, and the one test that wants a real group
 * resolution builds a two-route `createRouter` rather than a mock of it.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const { serializeBody } = require(path.join(__dirname, "../lib/serialize"));
const { createRouter } = require(path.join(__dirname, "../lib/router"));
const {
  DEFAULT_MAX_KEYS,
  HEADER_REMAIN,
  HEADER_RESET,
  MAX_ERRORS,
  OVER_LIMIT_BODY,
  OVER_LIMIT_SENDS_RETRY_AFTER,
  OVER_LIMIT_STATUS,
  WINDOW_SECONDS,
  charges,
  createErrorBudget,
  createErrorLimitDispatch,
  keyFor,
  overLimitResult,
  resetSeconds,
} = require(path.join(__dirname, "../lib/errorLimiter"));

// Fixtures

/**
 * Eighteen seconds into a window, so `resetSeconds` is 42, the first value the
 * live survey recorded and one no constant-60 implementation produces by
 * accident.
 */
const NOW = Date.parse("2026-08-23T20:00:18Z");

const CALLER = "203.0.113.7";

const bytes = (result) => serializeBody(result.body, result.producer).toString("utf8");

function request(overrides = {}) {
  return {
    method: "GET",
    pathname: "/nope/",
    query: {},
    headers: {},
    remoteAddress: CALLER,
    rawBody: null,
    body: null,
    ...overrides,
  };
}

/**
 * The layer, wrapped around a dispatch double whose status the test chooses.
 *
 * `calls` proves a refusal is made before dispatch: a limiter that answers
 * the request it meant to refuse has already done the work.
 */
function harness({ group = null, respond = () => ({ status: 200 }), ...options } = {}) {
  const calls = [];
  const clock = { at: NOW };

  const next = async (received) => {
    calls.push(received);
    return respond(received);
  };

  const dispatch = createErrorLimitDispatch(next, {
    groupFor: () => group,
    now: () => clock.at,
    ...options,
  });

  return { dispatch, calls, clock };
}

/** A pass-through adds nothing at all, so a result may have no headers to read. */
const headersOf = (result) => (result && result.headers) || {};

/** `Remain` as a number, or `undefined` when the family is absent. */
function remainOf(result) {
  const value = headersOf(result)[HEADER_REMAIN];
  return value === undefined ? undefined : Number(value);
}

// The numbers, against the observation

test("the budget, the window and the two header names are the ones observed on the wire", () => {
  assert.equal(MAX_ERRORS, wire.ERROR_LIMIT.maxErrors);
  assert.equal(WINDOW_SECONDS, wire.ERROR_LIMIT.windowSeconds);
  assert.deepEqual(
    [HEADER_REMAIN, HEADER_RESET],
    wire.ERROR_LIMIT.headers.map((name) => name.toLowerCase()),
    "lowercase in this codebase; lib/headers.js title-cases on the way to the socket",
  );
});

test("the status past the limit, its silence about Retry-After and its body are the unobserved claims", () => {
  // Not wire facts. The only way to observe them is to exhaust CCP's limiter on
  // purpose, so they are carried as documented claims and marked as such. A
  // future observation fails a test naming lib/errorLimiter.js.
  assert.equal(OVER_LIMIT_STATUS, wire.LIMITER_UNOBSERVED.errorLimitOverStatus);
  assert.equal(OVER_LIMIT_STATUS, 420, "Enhanced Your Calm");
  assert.equal(OVER_LIMIT_BODY, wire.LIMITER_UNOBSERVED.errorLimitOverBody);
  assert.equal(
    OVER_LIMIT_SENDS_RETRY_AFTER,
    wire.LIMITER_UNOBSERVED.errorLimitOverSendsRetryAfter,
  );
});

test("a status observed to charge charges, and a status observed not to does not", () => {
  for (const status of wire.ERROR_LIMIT.charges) {
    assert.equal(charges(status), true, `${status} was observed to decrement Remain`);
  }
  for (const status of wire.ERROR_LIMIT.free) {
    assert.equal(charges(status), false, `${status} was observed to leave Remain alone`);
  }

  // The rule as stated: non-2XX and non-3XX. A 5XX charges, which is a judgement
  // rather than an observation; see lib/errorLimiter.js `charges`.
  assert.equal(charges(500), true);
  assert.equal(charges(204), false);
  assert.equal(charges(301), false);
  assert.equal(charges(undefined), false, "a result with no status is not a refusal");
});

// Reset counts down

test("Reset is the seconds left in the window, not the length of the window", () => {
  assert.equal(wire.ERROR_LIMIT.resetIsSecondsRemaining, true);

  // The observed sequence was 42, then 32, then 31, and 56 at the start of the
  // next window: a countdown, and a client that read it as "the window is 60s"
  // would sleep roughly twice as long as it needed to.
  assert.equal(resetSeconds(NOW), 42);
  assert.equal(resetSeconds(NOW + 10_000), 32);
  assert.equal(resetSeconds(NOW + 11_000), 31);
  assert.equal(resetSeconds(NOW + 46_000), 56, "and the next window starts high again");
});

test("Reset is never zero while the window is still open", () => {
  // A client told to sleep zero seconds retries immediately into the same
  // exhausted window, turning a back-off signal into a busy loop. Rounding up
  // keeps the value in 1..60 everywhere inside a window.
  const start = Math.floor(NOW / 60_000) * 60_000;

  assert.equal(resetSeconds(start), WINDOW_SECONDS, "the boundary reports a whole window");
  assert.equal(resetSeconds(start + 59_999), 1);
  for (let offset = 0; offset < WINDOW_SECONDS * 1000; offset += 997) {
    const seconds = resetSeconds(start + offset);
    assert.ok(seconds >= 1 && seconds <= WINDOW_SECONDS, `reset was ${seconds} at +${offset}ms`);
  }
});

// One family or the other, never both

test("a route that publishes a rate-limit group gets no error-limit headers at all", async () => {
  // A grouped route belongs to the token bucket, and seventeen live requests
  // carried one family or neither, never both.
  const { dispatch, calls } = harness({ group: "status", respond: () => ({ status: 404 }) });

  const result = await dispatch(request({ pathname: "/status/" }));

  assert.equal(calls.length, 1, "it still dispatches; it just adds nothing");
  assert.equal(headersOf(result)[HEADER_REMAIN], undefined);
  assert.equal(headersOf(result)[HEADER_RESET], undefined);
});

test("every surveyed response carries the family its route's group selects", async () => {
  // Driven off the survey itself rather than a list retyped here. The three
  // `NONE` rows are excluded because they never reach this layer at all (see the
  // next assertion), not because the rule has an exception.
  const reachable = wire.LIMITER_SURVEY.filter((row) => row.limiter !== wire.LIMITER.NONE);
  assert.ok(reachable.length >= 14, "the survey should still have most of its rows");

  for (const row of reachable) {
    const errorLimited = row.limiter === wire.LIMITER.ERROR_LIMIT;
    const { dispatch } = harness({
      group: errorLimited ? null : "some-group",
      respond: () => ({ status: row.status }),
    });

    const result = await dispatch(request());
    const carries = headersOf(result)[HEADER_REMAIN] !== undefined
      && headersOf(result)[HEADER_RESET] !== undefined;

    assert.equal(carries, errorLimited, `${row.request} -> ${row.limiter}`);
  }
});

test("the two responses that carry neither family never reach this layer", () => {
  // `/ping` is dispatched outside the whole pipeline and the preflight
  // short-circuits in lib/cors.js, so there is no exemption list in
  // lib/errorLimiter.js: a second place that knows about /ping is a second place
  // that can disagree with the first.
  const none = wire.LIMITER_SURVEY.filter((row) => row.limiter === wire.LIMITER.NONE);

  assert.deepEqual(
    none.map((row) => row.request),
    ["GET /ping", "OPTIONS /latest/status/ (preflight)"],
  );
});

test("a 405 picks its family by the method it refused, and the router already knows", async () => {
  // The same 405, two families: the HEAD refusal is made where the route is
  // known and reports its group, the POST refusal is made in front of it and
  // falls back here. Driven through a real createRouter rather than a double,
  // because that is the wiring loader.js uses.
  const router = createRouter([
    {
      method: "GET",
      path: "/status",
      name: "GetStatus",
      handler: () => ({ players: 1 }),
      producer: "gateway",
      cacheTtl: 30,
      rateLimitGroup: "status",
    },
  ]);
  const groupFor = (received) => router.rateLimitGroupFor(received.method, received.pathname);

  const seen = {};
  const dispatch = createErrorLimitDispatch(async () => ({ status: 405 }), {
    groupFor,
    now: () => NOW,
  });

  for (const method of ["HEAD", "POST"]) {
    const result = await dispatch(request({ method, pathname: "/status/" }));
    seen[method] = headersOf(result)[HEADER_REMAIN] === undefined
      ? wire.LIMITER.TOKEN_BUCKET
      : wire.LIMITER.ERROR_LIMIT;
  }

  assert.equal(seen.HEAD, wire.METHOD_NOT_ALLOWED_LIMITER.HEAD);
  assert.equal(seen.POST, wire.METHOD_NOT_ALLOWED_LIMITER.OTHER);

  // And a path that routes nowhere is this layer's by definition: no route, no
  // group, nothing to take a token from.
  assert.equal(groupFor(request()), null);
});

// Counting

test("Remain is post-charge: the 404 that spends the unit reports the decremented value", async () => {
  const { dispatch } = harness({ respond: () => ({ status: 404 }) });

  const result = await dispatch(request());

  assert.equal(remainOf(result), MAX_ERRORS - 1, "100 -> 99, answered on the 404 itself");
  assert.equal(result.headers[HEADER_RESET], "42");
});

test("the surveyed sequence of five requests reproduces exactly", async () => {
  // 100 -> 99 across the unrouted 404, 99 -> 98 across the 400, 98 -> 97 across
  // the 404, then 97 unchanged across a 200 and unchanged again across a 304.
  const statuses = [404, 400, 404, 200, 304];
  let index = 0;
  const { dispatch } = harness({ respond: () => ({ status: statuses[index] }) });

  const observed = [];
  for (; index < statuses.length; index += 1) {
    observed.push(remainOf(await dispatch(request())));
  }

  assert.deepEqual(observed, [99, 98, 97, 97, 97]);
});

test("a 304 costs nothing here, though it costs a token on the other limiter", async () => {
  // Charging a revalidation would punish exactly the clients that cache
  // correctly. The token bucket does charge for one: the two limiters genuinely
  // disagree.
  assert.ok(wire.ERROR_LIMIT.free.includes(304));
  assert.equal(wire.TOKEN_BUCKET.cost[3], 1);

  const { dispatch } = harness({ respond: () => ({ status: 304 }) });

  for (let attempt = 0; attempt < 200; attempt += 1) {
    assert.equal(remainOf(await dispatch(request())), MAX_ERRORS);
  }
});

test("two callers do not spend each other's budget", async () => {
  const { dispatch } = harness({ respond: () => ({ status: 404 }) });

  await dispatch(request({ remoteAddress: "198.51.100.1" }));
  await dispatch(request({ remoteAddress: "198.51.100.1" }));
  const other = await dispatch(request({ remoteAddress: "198.51.100.2" }));

  assert.equal(remainOf(other), MAX_ERRORS - 1);
});

// Acceptance: the 101st request

test("100 consecutive 404s produce a 420 on the 101st request", async () => {
  const { dispatch, calls } = harness({ respond: () => ({ status: 404 }) });

  for (let attempt = 1; attempt <= MAX_ERRORS; attempt += 1) {
    const result = await dispatch(request());
    assert.equal(result.status, 404, `request ${attempt} should still be answered`);
    assert.equal(remainOf(result), MAX_ERRORS - attempt);
  }

  assert.equal(calls.length, MAX_ERRORS);

  const refused = await dispatch(request());

  assert.equal(refused.status, OVER_LIMIT_STATUS);
  assert.equal(
    calls.length,
    MAX_ERRORS,
    "the refusal is made before dispatch: a limiter that answers the request it meant to "
      + "refuse has already done the work",
  );
});

test("the 420 is an edge refusal, and says when to come back without a Retry-After", async () => {
  const { dispatch } = harness({ respond: () => ({ status: 404 }) });
  for (let attempt = 0; attempt < MAX_ERRORS; attempt += 1) await dispatch(request());

  const refused = await dispatch(request());

  assert.equal(refused.status, wire.LIMITER_UNOBSERVED.errorLimitOverStatus);
  assert.equal(JSON.parse(bytes(refused)).error, wire.LIMITER_UNOBSERVED.errorLimitOverBody);

  // Refused before routing, so it is shaped like every other edge refusal: the
  // gateway's bytes, nosniff, and Go's trailing newline.
  assert.equal(refused.headers["content-type"], "application/json");
  assert.equal(refused.headers["x-content-type-options"], "nosniff");
  assert.ok(bytes(refused).endsWith("\n"));

  assert.equal(refused.headers[HEADER_REMAIN], "0");
  assert.equal(refused.headers[HEADER_RESET], "42");

  // No Retry-After, which looks like an oversight and is CCP's documented
  // behaviour: the expose list names the header and the 420 is where a client
  // would want it, and Reset already carries the same number. Fidelity beats
  // hygiene.
  assert.equal(wire.LIMITER_UNOBSERVED.errorLimitOverSendsRetryAfter, false);
  assert.equal(refused.headers["retry-after"], undefined);
  // ...unlike the other limiter's refusal, which does send one.
  assert.equal(wire.LIMITER_UNOBSERVED.tokenBucketOverSendsRetryAfter, true);
});

test("a grouped route is never refused by this limiter, however exhausted the caller is", async () => {
  // The two limiters are independent. A caller who has spent its error budget
  // still reaches a route the token bucket answers for, and the token bucket
  // decides what happens to it there.
  // One budget, shared by both harnesses, so the caller really is the same
  // exhausted caller in both halves of the test.
  const budget = createErrorBudget();

  const { dispatch: ungrouped } = harness({ respond: () => ({ status: 404 }), budget });
  for (let attempt = 0; attempt < MAX_ERRORS; attempt += 1) await ungrouped(request());
  assert.equal((await ungrouped(request())).status, OVER_LIMIT_STATUS);

  const { dispatch: grouped, calls } = harness({
    group: "status",
    respond: () => ({ status: 200 }),
    budget,
  });

  assert.equal((await grouped(request())).status, 200, "not refused here");
  assert.equal(calls.length, 1, "and dispatched, rather than answered by this layer");
});

// Acceptance: the window resets

test("the counter resets after the window, and the caller is served again", async () => {
  const { dispatch, clock } = harness({ respond: () => ({ status: 404 }) });

  for (let attempt = 0; attempt < MAX_ERRORS; attempt += 1) await dispatch(request());
  assert.equal((await dispatch(request())).status, OVER_LIMIT_STATUS);

  // Still inside the window: still refused.
  clock.at = NOW + 30_000;
  assert.equal((await dispatch(request())).status, OVER_LIMIT_STATUS);

  // Past the boundary the window is floored to, by the same flooring rule
  // lib/cache.js uses to keep an Etag stable across a paged sweep.
  clock.at = NOW + WINDOW_SECONDS * 1000;
  const served = await dispatch(request());

  assert.equal(served.status, 404, "a fresh window is a fresh budget");
  assert.equal(remainOf(served), MAX_ERRORS - 1);
});

test("an entry from a previous window is worth nothing, and is not distinguishable from none", () => {
  const budget = createErrorBudget();

  assert.equal(budget.charge(`ip:${CALLER}`, NOW), MAX_ERRORS - 1);
  assert.equal(budget.remaining(`ip:${CALLER}`, NOW), MAX_ERRORS - 1);
  assert.equal(budget.remaining(`ip:${CALLER}`, NOW + WINDOW_SECONDS * 1000), MAX_ERRORS);
});

// Acceptance: the map cannot grow without limit

test("a hostile client cannot grow the key map without limit", () => {
  // The mod runs inside a live game process, so a map keyed on caller-controlled
  // input with no ceiling is a memory-exhaustion bug in somebody's game server,
  // reachable by anyone who can open a socket.
  const maxKeys = 64;
  const budget = createErrorBudget({ maxKeys });

  for (let index = 0; index < 20_000; index += 1) {
    budget.charge(`ip:10.0.${(index >> 8) & 0xff}.${index & 0xff}`, NOW);
    assert.ok(budget.size <= maxKeys, `size reached ${budget.size} after ${index + 1} callers`);
  }

  assert.equal(budget.size, maxKeys);
});

test("the same flood through the layer is bounded too, and evicts least-recently-used", async () => {
  const maxKeys = 8;
  const budget = createErrorBudget({ maxKeys });
  const { dispatch } = harness({ respond: () => ({ status: 404 }), budget });

  const victim = request({ remoteAddress: "192.0.2.99" });
  await dispatch(victim);
  assert.equal(budget.remaining(keyFor(victim), NOW), MAX_ERRORS - 1);

  for (let index = 0; index < 5_000; index += 1) {
    await dispatch(request({ remoteAddress: `192.0.2.${index}` }));
  }

  assert.equal(budget.size, maxKeys);
  // The cold key is gone, and the newest ones are not. Eviction is
  // deterministic: the coldest key is the first the Map yields.
  assert.equal(budget.remaining(keyFor(victim), NOW), MAX_ERRORS, "the coldest went first");
  assert.equal(budget.remaining("ip:192.0.2.4999", NOW), MAX_ERRORS - 1, "the hottest stayed");
});

test("a read never allocates, so traffic that produces no errors occupies no slots", () => {
  // This is what makes the bound meaningful: a flood of successes from a
  // million addresses costs nothing, and the only way to occupy a slot is to
  // have already been charged for one.
  const budget = createErrorBudget({ maxKeys: 4 });

  for (let index = 0; index < 10_000; index += 1) {
    assert.equal(budget.remaining(`ip:198.18.0.${index}`, NOW), MAX_ERRORS);
  }

  assert.equal(budget.size, 0);
});

test("the default cap is a stated number rather than an accident", () => {
  assert.equal(DEFAULT_MAX_KEYS, 1024);
  assert.equal(createErrorBudget().size, 0);
});

// The caller we cannot name

test("a request with no source address gets a budget that is never stored and never refuses", async () => {
  // One shared "unknown" bucket would let a single unidentifiable caller
  // exhaust every other unidentifiable caller's budget, and would be the one map
  // entry a hostile client could always reach. A null address is not something a
  // client can ask for (the socket had no peer), so exempting it grants nothing
  // a hostile client can reach.
  const budget = createErrorBudget();
  const { dispatch, calls } = harness({ respond: () => ({ status: 404 }), budget });

  assert.equal(keyFor(request({ remoteAddress: null })), null);
  assert.equal(keyFor(request({ remoteAddress: "" })), null);

  for (let attempt = 0; attempt < MAX_ERRORS * 3; attempt += 1) {
    const result = await dispatch(request({ remoteAddress: null }));

    assert.equal(result.status, 404, "never refused");
    assert.equal(remainOf(result), MAX_ERRORS - 1, "honest for this response, and not remembered");
  }

  assert.equal(budget.size, 0, "nothing was written down");
  assert.equal(calls.length, MAX_ERRORS * 3);
});

test("the key is the source address whatever the credential, which is observed and not deferred", () => {
  // The key is the address alone. Observed on 2026-08-25: one counter on one
  // address inside one 60 second window walked 100 -> 99 -> 98
  // unauthenticated and then 97, 96, 95, 94 across four different credentials
  // spanning two applications and two characters. A credential never seen
  // before continued the unauthenticated count instead of starting its own,
  // which rules out every candidate key with any part of the credential in it.
  assert.equal(wire.LIMITER_KEY.errorLimiter.key, "sourceAddress");
  assert.equal(wire.LIMITER_KEY.errorLimiter.credentialMovesTheBudget, false);
  assert.equal(wire.LIMITER_KEY.errorLimiter.sharedWithUnauthenticated, true);
  assert.equal(wire.LIMITER_KEY.errorLimiter.distinctBudgetsSeen, 1);

  // The surprise, kept as an assertion so it cannot be forgotten: CCP's
  // documented rule says otherwise, and the wire disagrees with the document.
  // D31's house rule is that the observation wins, so the sentence stays a
  // claim beside the reading rather than being deleted or acted on.
  assert.equal(wire.LIMITER_UNOBSERVED.errorLimitKey, "applicationID:characterID, else source IP");
  assert.equal(wire.LIMITER_KEY.contradicts, wire.LIMITER_UNOBSERVED.errorLimitKey);

  // And the other limiter does not key this way (D39), which is why the
  // question had to be asked twice rather than once and copied.
  assert.equal(wire.LIMITER_KEY.limitersAgree, false);
  assert.equal(wire.LIMITER_KEY.tokenBucket.key, "applicationOnly");

  // The behaviour itself. X-Forwarded-For is not consulted anywhere, because a
  // header the client sets would let one caller mint a fresh budget per request;
  // the Authorization header changes nothing, which is a fact about ESI.
  assert.equal(keyFor(request()), `ip:${CALLER}`);
  assert.equal(
    keyFor(request({ headers: { "x-forwarded-for": "10.0.0.1", authorization: "Bearer nope" } })),
    `ip:${CALLER}`,
  );
  assert.equal(
    keyFor(request({ headers: { authorization: "Bearer good-token-for-some-application" } })),
    `ip:${CALLER}`,
    "a credential that would verify keys the same way as one that would not",
  );
});

test("two different credentials from one address draw down one counter", async () => {
  // The shape of the observation, replayed through the layer: six errors, four
  // credentials, one budget. Anything that partitioned on the credential would
  // reset Remain somewhere in this sequence.
  const { dispatch } = harness({ respond: () => ({ status: 404 }) });

  const remains = [];
  for (const authorization of [
    undefined,
    undefined,
    "Bearer application-a.character-1",
    "Bearer application-a.character-2",
    "Bearer application-b.character-1",
    "Bearer application-b.character-2",
  ]) {
    const headers = authorization === undefined ? {} : { authorization };
    remains.push(remainOf(await dispatch(request({ headers }))));
  }

  assert.deepEqual(
    remains,
    [MAX_ERRORS - 1, MAX_ERRORS - 2, MAX_ERRORS - 3, MAX_ERRORS - 4, MAX_ERRORS - 5, MAX_ERRORS - 6],
    "one counter, six decrements, four credentials; 100 down to 94 on the wire",
  );
});

// Composition

test("a header the wrapped dispatch set itself wins, in any casing", async () => {
  // Writing ours next to theirs would go out as one comma-joined value, a shape
  // bug invisible until a client parses it. The rule lib/cors.js and
  // lib/cache.js both follow.
  const { dispatch } = harness({
    respond: () => ({
      status: 404,
      headers: { "X-Esi-Error-Limit-Remain": "7", [HEADER_RESET]: "3" },
    }),
  });

  const result = await dispatch(request());

  assert.equal(result.headers["X-Esi-Error-Limit-Remain"], "7");
  assert.equal(result.headers[HEADER_REMAIN], undefined, "not added a second time");
  assert.equal(result.headers[HEADER_RESET], "3");
});

test("everything else about the result is passed through untouched", async () => {
  const answer = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { players: 1 },
    payload: Buffer.from("{}"),
    producer: "gateway",
    cacheTtl: 30,
  };
  const { dispatch } = harness({ respond: () => answer });

  const result = await dispatch(request());

  assert.equal(result.body, answer.body);
  assert.equal(result.payload, answer.payload);
  assert.equal(result.producer, "gateway");
  assert.equal(result.cacheTtl, 30);
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(remainOf(result), MAX_ERRORS);
});

test("a dispatch that returns something other than a result is passed straight back", async () => {
  for (const answer of [undefined, null, "not a result"]) {
    const { dispatch } = harness({ respond: () => answer });
    assert.equal(await dispatch(request()), answer);
  }
});

test("the layer refuses to be built without the two things it cannot work without", () => {
  // At construction, where a misconfiguration is a startup failure with a
  // message instead of a 500 on every request.
  assert.throws(() => createErrorLimitDispatch(null, { groupFor: () => null }), /dispatch function/);
  assert.throws(() => createErrorLimitDispatch(async () => ({ status: 200 })), /groupFor/);
  assert.throws(
    () => createErrorLimitDispatch(async () => ({ status: 200 }), { groupFor: "status" }),
    /groupFor/,
  );
});

test("nothing in the request path throws, including on a clock that stopped making sense", async () => {
  // eve.js's ProcessLifecycle treats an unhandled rejection as fatal, and a
  // limiter that can kill the game server it is protecting has inverted its own
  // purpose.
  const dispatch = createErrorLimitDispatch(async () => ({ status: 404 }), {
    groupFor: () => null,
    now: () => Number.NaN,
  });

  const result = await dispatch(request());

  assert.equal(result.status, 404);
  assert.equal(remainOf(result), MAX_ERRORS - 1);
  assert.ok(Number(result.headers[HEADER_RESET]) >= 1);
});

test("the refusal can be built on its own, which is what makes it inspectable", () => {
  const refusal = overLimitResult(0, "17");

  assert.equal(refusal.status, OVER_LIMIT_STATUS);
  assert.equal(refusal.producer, "gateway");
  assert.deepEqual(refusal.body, { error: OVER_LIMIT_BODY });
  assert.equal(refusal.headers[HEADER_RESET], "17");
});
