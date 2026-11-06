/**
 * eve.js-mod-esi: `Accept-Language`, and the `Content-Language` that answers it
 *
 * `Content-Language` is on both producers' 2XX (`contract/wire.js`
 * `GATEWAY_SUCCESS_HEADERS`, `APP_SUCCESS_HEADERS`), and a header diff counts
 * its absence the same way it counts an invented header.
 *
 * Request side: `Accept-Language` is a shared parameter on all 197 operations of
 * the pinned `2020-01-01` document, an enum of eight with a default of `en`.
 * It is an enum, not RFC 4647: `de` is a value and `de-DE, de;q=0.9, en;q=0.8`
 * is not. This module takes the first tag, drops any `q=` weight, and checks
 * the result against the eight. That accepts everything the enum accepts and
 * reads a browser's default header as a preference rather than a syntax error.
 *
 * There is no `language` query parameter in the pinned document, and an
 * undeclared query parameter is ignored rather than refused
 * (`contract/wire.js` `IGNORES_UNKNOWN_QUERY_PARAMS`). `?language=de` (the form
 * older ESI used) is therefore accepted, and is read here as a preference too.
 * The header wins where both are present, because the header is the declared one.
 *
 * The answer is always `en` (D27). `SERVED` has one entry: eve.js's static data
 * is English, so a request for `de` is answered in English and
 * `Content-Language: en` is the true statement about those bytes. Echoing the
 * request would claim something about the body that is false, and what CCP
 * answers a `de` request is unobserved (`contract/wire.js` `CONTENT_LANGUAGE`
 * records only the value a default request produced). Adding a second language
 * to `SERVED` is the whole change if one ever exists.
 */

"use strict";

/**
 * The eight values CCP's `Accept-Language` accepts, in the spec's order.
 *
 * Duplicated from `contract/openapi.json` because `contract/` is test-only and
 * never deployed (D20). `test/language.test.js` reads the pinned document and
 * asserts the two agree.
 */
const LANGUAGES = Object.freeze(["en", "de", "fr", "ja", "ru", "zh", "ko", "es"]);

/** The spec's own default, for a request that expresses no preference. */
const DEFAULT_LANGUAGE = "en";

/**
 * The languages this replica has data in. One: the static-data dump is English.
 * See the file header.
 */
const SERVED = Object.freeze(["en"]);

/** The query parameter the older surface had. Read, never required. */
const QUERY_PARAMETER = "language";

const HEADER = "accept-language";

/**
 * The first tag of an `Accept-Language`, lowercased, with any `q=` weight and
 * region subtag removed: `de-DE;q=0.9, en` -> `de`.
 *
 * The region is dropped rather than rejected because the enum has none: a
 * browser sending `de-DE` means the language CCP spells `de`.
 */
function firstTag(value) {
  const [tag] = String(value).split(",");
  return String(tag || "").trim().split(";")[0].trim().split("-")[0].toLowerCase();
}

/** Case-insensitive header read, since `headers` may come from anywhere. */
function header(headers, name) {
  if (!headers) return undefined;
  if (headers[name] !== undefined) return headers[name];

  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return headers[key];
  }
  return undefined;
}

/**
 * The language this request asked for, or `null` for one that asked for nothing
 * this surface knows about.
 *
 * A value outside the enum is `null` rather than a refusal: CCP validates the
 * declared parameters of a route (`contract/wire.js`
 * `VALIDATES_DECLARED_QUERY_PARAMS`) and no observation has it refusing a
 * language.
 */
function requestedLanguage(request) {
  const raw = header((request && request.headers) || {}, HEADER);
  const query = (request && request.query) || {};

  for (const candidate of [raw, query[QUERY_PARAMETER]]) {
    if (candidate === undefined || candidate === null || candidate === "") continue;

    const tag = firstTag(Array.isArray(candidate) ? candidate[0] : candidate);
    if (LANGUAGES.includes(tag)) return tag;
  }

  return null;
}

/**
 * The `Content-Language` for the response to this request.
 *
 * The preference is honoured when it is a language we have data in, which today
 * is `en` only, so this returns `en` for every request, including one that
 * asked for `de`.
 */
function contentLanguageFor(request) {
  const wanted = requestedLanguage(request);
  return wanted !== null && SERVED.includes(wanted) ? wanted : DEFAULT_LANGUAGE;
}

module.exports = {
  DEFAULT_LANGUAGE,
  HEADER,
  LANGUAGES,
  QUERY_PARAMETER,
  SERVED,
  contentLanguageFor,
  firstTag,
  requestedLanguage,
};
