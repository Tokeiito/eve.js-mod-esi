/**
 * `Content-Language`, and the `Accept-Language` that asks for it (D27).
 *
 * Two sources. The spec owns the request: `Accept-Language` is a shared
 * parameter on all 197 operations, with an enum of eight and a default of `en`.
 * This file reads that out of the pinned document rather than restating it, so a
 * ninth language appearing in a re-pin fails here, naming `lib/language.js`. The
 * wire owns the response: `Content-Language: en` was observed on both
 * producers' 2XX, and it is the only value seen.
 *
 * The replica deliberately does not echo. A request for `de` is answered
 * `Content-Language: en`, because the body is English (eve.js's static data has
 * one language) and saying otherwise would be a claim about the payload. What
 * CCP answers a `de` request is unobserved, so echoing would also be inventing a
 * behaviour.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "../contract/wire"));
const spec = require(path.join(__dirname, "../contract/spec"));
const { createEsiDispatch } = require(path.join(__dirname, "../lib/pipeline"));
const { createRouter } = require(path.join(__dirname, "../lib/router"));
const {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  QUERY_PARAMETER,
  SERVED,
  contentLanguageFor,
  firstTag,
  requestedLanguage,
} = require(path.join(__dirname, "../lib/language"));

const NOW = Date.parse("2026-08-23T10:00:00Z");

const route = (producer = "gateway") => ({
  method: "GET",
  path: "/status",
  name: "GetStatus",
  handler: () => ({ players: 1 }),
  producer,
  cacheTtl: 30,
});

/** The real stack, from the one place that knows the order. */
function compose(routes = [route()]) {
  return createEsiDispatch(createRouter(routes), { now: () => NOW });
}

const get = (dispatch, { headers = {}, query = {} } = {}) =>
  dispatch({ method: "GET", pathname: "/latest/status/", query, headers });

// The contract, from both sources

test("the enum is CCP's, read from the pinned spec rather than restated", () => {
  // lib/ cannot import contract/ (it is test-only and never deployed, D20), so
  // the eight values are duplicated and this test checks that they agree.
  const parameter = spec.sharedParameter("AcceptLanguage");

  assert.equal(parameter.in, "header");
  assert.equal(parameter.name, "Accept-Language");
  assert.deepEqual([...LANGUAGES], [...parameter.schema.enum], "the enum, in the spec's own order");
  assert.equal(DEFAULT_LANGUAGE, parameter.schema.default);
});

test("every operation on the surface takes it, so the header is not per-route", () => {
  // `Content-Language` belongs to the router's own header set rather than to a
  // route descriptor because no operation fails to declare it.
  const document = spec.loadSpec();
  const operations = [];

  for (const [wirePath, item] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!spec.BODY_METHODS.includes(method)) continue;
      operations.push({ wirePath, method, operation });
    }
  }

  const without = operations.filter(({ operation }) => !(operation.parameters || [])
    .some((parameter) => parameter.$ref === "#/components/parameters/AcceptLanguage"));

  assert.deepEqual(without.map((o) => `${o.method} ${o.wirePath}`), []);
  assert.equal(operations.length, 197, "the pinned surface, in case a re-pin moves it");
});

test("the value we send is the one that was observed", () => {
  assert.equal(wire.CONTENT_LANGUAGE, "en");
  assert.deepEqual([...SERVED], [wire.CONTENT_LANGUAGE], "one language of data, and it is CCP's default");
  assert.equal(DEFAULT_LANGUAGE, wire.CONTENT_LANGUAGE);
});

test("it is in both producers' observed header sets, which is why it is owed", () => {
  assert.ok(wire.GATEWAY_SUCCESS_HEADERS.includes("content-language"));
  assert.ok(wire.APP_SUCCESS_HEADERS.includes("content-language"));
  assert.ok(
    !wire.PREFLIGHT.headers.includes("content-language"),
    "and not on the preflight, which is the one response observed without it",
  );
});

// Reading the request

test("the header is read as an enum value, not as an RFC 4647 list", () => {
  // CCP declares a plain string with eight permitted values, so `de` is the
  // value and the weights are not read. Taking the first tag accepts everything
  // the enum accepts and also understands what a browser sends by default, which
  // would otherwise look like a syntax error and mean `en`.
  assert.equal(firstTag("de"), "de");
  assert.equal(firstTag("de-DE;q=0.9, en;q=0.8"), "de");
  assert.equal(firstTag("  JA  "), "ja");
  assert.equal(firstTag("zh-Hans-CN"), "zh");
});

test("a language outside the enum is no preference, not a refusal", () => {
  // Nothing observed has CCP refusing a language, and it validates only the
  // parameters a route declares (contract/wire.js
  // VALIDATES_DECLARED_QUERY_PARAMS). So an unknown value is read as silence.
  assert.equal(requestedLanguage({ headers: { "accept-language": "klingon" } }), null);
  assert.equal(requestedLanguage({ headers: { "accept-language": "" } }), null);
  assert.equal(requestedLanguage({}), null);
});

test("the older surface's ?language= is read too, and the header wins", () => {
  // A `?language=` query parameter is recorded in the register. The pinned
  // 2020-01-01 document declares none, so it is an undeclared parameter and is
  // ignored rather than refused (IGNORES_UNKNOWN_QUERY_PARAMS), which already
  // counts as accepted. It is read anyway, so a tool written against 2017-era ESI
  // gets the language it asked for.
  assert.equal(wire.IGNORES_UNKNOWN_QUERY_PARAMS, true, "the observation this rests on");
  assert.equal(QUERY_PARAMETER, "language");

  assert.equal(requestedLanguage({ query: { language: "fr" } }), "fr");
  assert.equal(
    requestedLanguage({ headers: { "accept-language": "ja" }, query: { language: "fr" } }),
    "ja",
    "the header is the form the contract declares",
  );
});

// Answering it

test("a request for a language we do not have is answered in the one we do", () => {
  for (const language of LANGUAGES) {
    assert.equal(
      contentLanguageFor({ headers: { "accept-language": language } }),
      "en",
      `${language} is answered honestly, in the language the bytes are actually in`,
    );
  }
});

test("the preference is genuinely read, so a second language would be one edit", () => {
  // `en` is the answer because it is the only thing in SERVED, not because the
  // function ignores its argument. A hardcoded constant would pass every other
  // test here and stay wrong the day the data grows a translation.
  assert.deepEqual([...SERVED], ["en"]);
  assert.equal(requestedLanguage({ headers: { "accept-language": "de" } }), "de");
  assert.equal(contentLanguageFor({ headers: { "accept-language": "de" } }), "en");
});

// Through the stack

test("every routed 2XX carries it, on both producers", async () => {
  for (const producer of ["gateway", "app"]) {
    const result = await get(compose([route(producer)]));

    assert.equal(result.status, 200);
    assert.equal(result.headers["content-language"], wire.CONTENT_LANGUAGE);
  }
});

test("asking for German is a 200 in English, not a 400", async () => {
  // The parameter is accepted rather than rejected, in both spellings, and
  // neither changes the answer.
  const dispatch = compose();

  for (const request of [
    { headers: { "accept-language": "de" } },
    { headers: { "accept-language": "de-DE,de;q=0.9,en;q=0.8" } },
    { query: { language: "de" } },
    { headers: { "accept-language": "not-a-language" } },
  ]) {
    const result = await get(dispatch, request);

    assert.equal(result.status, 200, JSON.stringify(request));
    assert.equal(result.headers["content-language"], "en");
  }
});

test("the response says it varies on Accept-Language, and then says what it settled on", async () => {
  // `Vary: Accept-Language` without `Content-Language` tells a cache the answer
  // depends on a header but never says which answer it got, so the stored entry
  // is keyed on something the client cannot read back off the response.
  const result = await get(compose());

  assert.ok(result.headers.vary.includes("Accept-Language"));
  assert.equal(result.headers["content-language"], "en");
});
