/**
 * eve.js-mod-esi: response serialization
 *
 * Bodies are bare. ESI has thousands of consumers written against them:
 *
 *   GET /latest/universe/systems/   ->  [30000001, 30000002, …]
 *   GET /latest/status/             ->  {"players":12345,"server_version":"…", …}
 *
 * No envelope, no `ok`, no version echo, no wrapper object. A client that does
 * `for (const id of await res.json())` gets a TypeError the moment a body is
 * wrapped. `ENVELOPE_KEYS` is therefore checked, not merely avoided by
 * convention.
 *
 * snake_case. Every one of the 531 property names in the pinned `2020-01-01` spec
 * matches `SNAKE_CASE`, and `test/serialize.test.js` asserts that against
 * `contract/openapi.json`. A field name that fails it is one CCP does not use.
 *
 * Where the checks happen: at construction, in `projection()`, as `createRouter`
 * validates its route table. A projection declares its field names once at load,
 * so an envelope key or a camelCase name fails at server start with the
 * offending name, not on the one request that reaches that endpoint. The request
 * path stays a `JSON.stringify` and a `Buffer.from`: it runs on the game's event
 * loop, and re-walking an 8000-element array is a stall the universe pays for.
 * `findEnvelopeKeys` and `findNonSnakeCaseKeys` are the same rules as
 * after-the-fact probes for tests that hold a body (a golden file, a handler's
 * output); nothing on the request path calls them.
 *
 * Three ways a field can be absent, and only one is a bug.
 *
 * `undefined` from a projection getter throws. It is the shape of every
 * accidental omission (a renamed game-store field, a typo, a record missing what
 * was assumed), and `JSON.stringify` drops it silently, so a client would get a
 * body missing a required field with nothing saying so.
 *
 * `OMIT` is the deliberate version: ESI leaves the key out. This is the common
 * case, because the pinned spec has no nullable field anywhere (202 schemas, 531
 * properties, zero `nullable`, zero `"null"` in a type union). Everything ESI
 * cannot say, it says by omission. `test/serialize.test.js` asserts that
 * emptiness, so the day CCP publishes a nullable field it fails.
 *
 * `null` is what a stored game record holds for an id that is not set, and it
 * must survive as `null` rather than becoming `0` or `NaN`, hence
 * `numberOrNull`. Whether an endpoint then sends the `null` or omits the key is
 * its decision, spelled `optional()`.
 *
 * There is no single success shape either. The `2020-01-01` surface is two
 * implementations behind one hostname, and which one answers is a property of
 * the route (the same split as on the error side):
 *
 *   GET /latest/status/                     application/json                 …}\n
 *   GET /latest/universe/regions/10000002/  application/json; charset=UTF-8  …}
 *
 * Two differences. The Go gateway writes JSON with `json.Encoder.Encode`, which
 * appends a newline; the application writes `Marshal` output, which does not. So
 * `GET /status/` is 93 bytes and only 92 are JSON. Dropping that byte makes
 * `content-length` off by one on every gateway route, which no client can work
 * around because a proxy frames the response by it.
 *
 * The two facts travel together (bare `application/json` ends with a newline;
 * the charset form does not, on every endpoint surveyed), so `PRODUCER` keeps
 * them in one row and `sendJson` takes both from it. Independent settings would
 * drift into four combinations, three of which CCP never sends.
 *
 * `contract/wire.js` has the survey, the `curl` invocations and the per-path
 * table. It is test-only and never deployed (D20), so the values are duplicated
 * here and `test/serialize.test.js` asserts the two agree.
 */

"use strict";

// The envelope that must not exist

/**
 * Top-level keys that would mean an envelope had been added.
 *
 * Top-level only, deliberately: `source` is a legitimate field name inside an ESI
 * body (a killmail has one). The envelope is a property of the outermost object
 * or of nothing.
 */
const ENVELOPE_KEYS = Object.freeze(["ok", "apiVersion", "source"]);

/**
 * Every field name in the pinned spec matches this: lowercase, digits allowed
 * after the first character, single underscores between parts, no trailing
 * underscore.
 *
 * The leading `[a-z]` also rules out an integer-like key. JavaScript orders
 * integer-like own properties ahead of everything else regardless of insertion
 * order, so a projection declaring one would silently serialize in a different
 * order than written.
 */
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * A projection declared wrongly, or a body asked for in terms of a producer that
 * does not exist. Thrown at construction (server start), so it names the field
 * and never reaches a socket.
 */
class SerializationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SerializationError";
  }
}

// The two producers

/**
 * Which of ESI's two implementations a body is being written as.
 *
 * Named for what was observed. The same distinction governs the error side
 * (`lib/errors.js`), the limiter headers and the cache headers: one fact about a
 * route, not several.
 */
const PRODUCER = Object.freeze({
  /** Go. `GET /status/`, `/sovereignty/map/`, `/sovereignty/structures/`. */
  GATEWAY: "gateway",
  /** The application. `/universe/*`, `/alliances/`, `/incursions/`, most of the surface. */
  APP: "app",
  /**
   * The `/meta/` surface: `/meta/compatibility-dates`, `/meta/openapi.json`,
   * `/meta/changelog`.
   *
   * A third producer, added 2026-08-23. It agrees with the gateway on both facts
   * in the row below and disagrees on every cache fact: a `Cache-Control` of
   * `public, max-age=<ttl>` with neither `must-revalidate` nor `stale-if-error`,
   * and no `Etag` and no `Last-Modified` at all. Two meta routes agree with each
   * other, which makes it a surface rather than one endpoint's quirk.
   * `lib/cache.js` `CACHE_POLICY` has the row and `contract/wire.js` `META` has the
   * probes.
   */
  META: "meta",
});

/**
 * Everything about a producer's JSON bytes, in one row.
 *
 * `contentType` and `trailingNewline` are not independent (see the file header).
 * Reading both from one row stops a response going out with one producer's header
 * and the other's byte count.
 */
const PRODUCER_WIRE = Object.freeze({
  // `.0`. It was `""` until 2026-08-25, on the reasoning that the gateway is Go and
  // Go's `encoding/json` writes `float64(5)` as `5`. The wire disagrees on all
  // three public entity lookups, which are the gateway on every other signal
  // (bare `application/json`, a trailing newline, a weak 64-hex `Etag`, no
  // `X-Esi-Request-Id`):
  //
  //   GET /latest/characters/<id>/    "security_status":0.0
  //   GET /latest/corporations/<id>/  "tax_rate":0.000
  //
  // `0.000` settles it: Go never writes trailing zeros, so these bodies are not
  // Go's `Marshal` output. The gateway relays a body the legacy application
  // produced and re-frames it. The suffix is therefore a property of whoever wrote
  // the digits, not of whoever wrote the newline, and on this half of the surface
  // they are different processes. Recorded in `contract/wire.js`
  // `DOUBLE_RENDERING`.
  [PRODUCER.GATEWAY]: Object.freeze({
    contentType: "application/json",
    trailingNewline: true,
    integralDoubleSuffix: ".0",
    escapesNonAscii: false,
  }),
  [PRODUCER.APP]: Object.freeze({
    contentType: "application/json; charset=UTF-8",
    trailingNewline: false,
    integralDoubleSuffix: ".0",
    escapesNonAscii: true,
  }),
  // Identical to the gateway's, as observed: 208 bytes for 207 of JSON on
  // `/meta/compatibility-dates`. The two producers part company one table over,
  // in `lib/cache.js`.
  //
  // `escapesNonAscii` is `false` and unexercised, like the double suffix above it:
  // no `/meta/` body carries a non-ASCII character, so this is the value that
  // changes nothing rather than one anybody watched.
  [PRODUCER.META]: Object.freeze({
    contentType: "application/json",
    trailingNewline: true,
    integralDoubleSuffix: "",
    escapesNonAscii: false,
  }),
});

/**
 * Non-ASCII, the fourth thing that splits by producer.
 *
 * After the `content-type`, the trailing newline and the double suffix: the
 * application escapes every character outside ASCII to `\uXXXX` and the gateway
 * writes it raw. Observed 2026-08-25 on three application routes and one gateway
 * route:
 *
 *   GET /latest/universe/factions/    …spread throughout Anoikis – otherwise…
 *   GET /latest/universe/bloodlines/  …not generally considered “enslaved”…
 *   GET /latest/universe/ancestries/  …vast amounts of wealth – along with…
 *   GET /latest/characters/{id}/      "title":"…\r\n<box-drawing characters>\r\n…"   raw UTF-8
 *
 * `JSON.stringify` writes raw, so the gateway needed nothing. An en dash is three
 * bytes raw and six escaped, so a replica writing raw on an application route is
 * short on `content-length` by three bytes per non-ASCII character and sends a
 * body a client's hash disagrees with. It was found the same way as the missing
 * trailing newline: a body that matched CCP's field for field and not byte for
 * byte.
 *
 * Lowercase hex, four digits; a character outside the BMP becomes the two
 * escapes of its surrogate pair, which is what `String.prototype.replace` over
 * UTF-16 code units does and what CCP's output does.
 *
 * Applied after the double substitution, which is safe in either order: a
 * rendered double is ASCII only, so neither pass can see the other's output.
 */
const NON_ASCII = /[\u0080-\uffff]/g;

function escapeNonAscii(json) {
  return json.replace(
    NON_ASCII,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * The wire row for a producer, or a throw naming the caller's mistake.
 *
 * There is deliberately no default. The common producer is wrong for `/status/`,
 * and a missing producer means a route whose producer nobody observed, which one
 * `curl` answers.
 */
function producerWire(producer) {
  const row = PRODUCER_WIRE[producer];
  if (row === undefined) {
    throw new SerializationError(
      `ESI mod: ${JSON.stringify(producer)} is not one of ESI's producers `
        + `(${Object.values(PRODUCER).join(", ")}). Which one answers a route decides both its `
        + "content-type and whether its body ends with a newline, and it is established by "
        + "observing the real endpoint: see contract/wire.js SUCCESS_KIND.",
    );
  }
  return row;
}

/** The `content-type` this producer sends, exactly as CCP spells it. */
function contentTypeFor(producer) {
  return producerWire(producer).contentType;
}

/**
 * "This field is genuinely absent; leave the key out."
 *
 * A symbol, because it must be a value no game record can hold and no endpoint
 * can mean literally.
 */
const OMIT = Symbol("esi.omit");

// Value helpers

/**
 * `null` for anything that is not a finite number.
 *
 * A stored character record carries `null`, `""`, or a value `Number()` turns
 * into `NaN` in its location fields while the character has neither a station nor
 * a structure. `JSON.stringify(NaN)` is `null` but `Number("") === 0`, so the
 * choice of coercion is the difference between an honest absence and a claim
 * that the character is docked at station 0.
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * `OMIT` for an absent value, the value itself otherwise.
 *
 * The idiom for a field the spec lists as optional:
 *
 *   station_id: (record) => optional(numberOrNull(record.stationID)),
 *
 * The id is a number or it is nothing, and nothing means CCP leaves the key out.
 * `0`, `""` and `false` are values and pass through: an `is_online: false` that
 * vanished through a falsy test would be a bug with a very long tail.
 */
function optional(value) {
  return value === null || value === undefined ? OMIT : value;
}

/**
 * A Set, or any non-string iterable, as an array.
 *
 * `JSON.stringify(new Set([1, 2]))` is `{}`, not `[1,2]`, and does not warn. The
 * game's stores hand out Sets for the things ESI publishes as arrays of ids, so
 * a list endpoint hits this first, as an empty object rather than an error.
 *
 * An absent collection is `[]`: the pinned spec has no nullable array, so "no
 * members" is an empty list on every ESI endpoint.
 *
 * Strings are wrapped rather than exploded into characters.
 */
function arrayOf(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  if (typeof value === "object" && typeof value[Symbol.iterator] === "function") return [...value];
  return [value];
}

// Doubles, which JSON has no type for and CCP writes anyway

/**
 * "This field is a `double`, and the application writes one as a double."
 *
 * `JSON.stringify(50000000)` is `50000000` whatever the spec calls the field,
 * because JavaScript has one number type. The application producer does not: a
 * field the spec declares `format: double` arrives with a fractional part even
 * when its value is whole, and a field it declares `int64` never does. Observed
 * on every static-universe body, 2026-08-25:
 *
 *   "max_dockable_ship_volume":50000000.0   "office_rental_cost":8675313605.0
 *   "position":{"x":-129064861735000000.0,…}
 *   "radius":513100000                      int64, and no `.0`
 *
 * The digits are JavaScript's own, the shortest decimal that round-trips.
 * `(64999452632293264).toFixed(1)` writes the exact value of the double and
 * disagrees with CCP in the last two digits; `String(64999452632293260)` is what
 * CCP sent. So this appends to the shortest form rather than formatting a new
 * one, and `contract/golden/GetUniverseConstellationsConstellationId.json` is the
 * 231-byte proof.
 *
 * The suffix rides in `PRODUCER_WIRE` beside the trailing newline, and the row it
 * does not travel with is the informative one: the gateway sends the newline the
 * application does not, and writes the suffix the application does (the capture
 * is in the table). One fact belongs to whoever framed the response, the other to
 * whoever wrote the digits, so read each off the table. The `/meta/` row is
 * unexercised rather than observed: no body it serves carries a number, and a
 * `/meta/` route that ever marks a double has an observation to make first.
 *
 * Not observed: either end of JavaScript's exponent range. At `1e21` and above,
 * and below `1e-6`, `String` switches to `1e+21` notation, and no ESI body seen
 * carries a double there. Universe positions reach `7.2e18` and stop.
 */
const DOUBLE = Symbol("esi.double");

/**
 * The fixed scale a marked double carries when CCP quantises the field.
 *
 * Separate from `DOUBLE` so the ordinary marker stays a one-property object and
 * `isDouble` keeps asking one question.
 *
 * The bounds make the scaled form safe. `toFixed` writes the double's exact
 * binary expansion, the disagreement the default form exists to avoid
 * (`(64999452632293264).toFixed(1)` differs from CCP in its last two digits), so
 * a scale is refused for a magnitude where that can bite. Every field observed
 * at a fixed scale is a rate between 0 and 1, and 1e15 leaves a `double` three
 * spare decimal digits above the largest one.
 */
const SCALE = Symbol("esi.double.scale");
const MAX_FIXED_PLACES = 6;
const MAX_FIXED_MAGNITUDE = 1e15;

/** The sentinel a marked double is stringified as, and its `\u0000` fence. */
const DOUBLE_SENTINEL = (index) => `\u0000esi.double:${index}\u0000`;
const DOUBLE_SENTINEL_PATTERN = /"\\u0000esi\.double:(\d+)\\u0000"/g;

/**
 * Mark a number as a `double` for the producer's serializer.
 *
 * `null` and `undefined` pass through unchanged, so the optional idiom reads as
 * every other one does:
 *
 *   office_rental_cost: (row) => optional(double(row.officeRentalCost)),
 *
 * Anything else that is not a finite number throws: a `NaN` here is a field that
 * would be serialized as `null` under a name the spec says is a number.
 */
function double(value, { places } = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SerializationError(
      `ESI mod: double() takes a finite number, got ${JSON.stringify(value)}. A field the spec `
        + "declares `format: double` has to have one: omit the key with OMIT if the value is "
        + "genuinely absent.",
    );
  }
  if (places === undefined) return { [DOUBLE]: value };

  if (!Number.isInteger(places) || places < 1 || places > MAX_FIXED_PLACES) {
    throw new SerializationError(
      `ESI mod: double()'s places must be an integer from 1 to ${MAX_FIXED_PLACES}, got `
        + `${JSON.stringify(places)}. It is a fixed scale CCP was observed writing, not a rounding `
        + "preference: see contract/wire.js DOUBLE_RENDERING.fixed.",
    );
  }
  if (Math.abs(value) >= MAX_FIXED_MAGNITUDE) {
    throw new SerializationError(
      `ESI mod: double() cannot write ${value} at a fixed scale. Past ${MAX_FIXED_MAGNITUDE} a `
        + "double has fewer than `places` digits left to spend, so toFixed() writes the value's "
        + "exact binary expansion and disagrees with the shortest form in its last digits. Every "
        + "field observed at a fixed scale is a rate between 0 and 1.",
    );
  }
  return { [DOUBLE]: value, [SCALE]: places };
}

/** True for a value `double()` produced. */
function isDouble(value) {
  return value !== null && typeof value === "object" && typeof value[DOUBLE] === "number";
}

/**
 * One marked double as this producer writes it.
 *
 * Two forms, because CCP writes two. The default is the shortest round-tripping
 * decimal plus the producer's suffix when that form carries no `.` or `e`; a
 * marker carrying a scale is written at exactly that many decimal places,
 * trailing zeros included.
 *
 * The scaled form is a quantisation CCP applies, not a formatting choice of ours.
 * `tax_rate` is the one field observed with it (`0.000`, `0.050`, `0.100`, never
 * `0.05`), and `contract/wire.js` `DOUBLE_RENDERING.fixed` is the table of which
 * fields have one.
 */
function renderDouble(value, integralDoubleSuffix, places) {
  if (typeof places === "number") return value.toFixed(places);
  const shortest = String(value);
  return /[.e]/.test(shortest) ? shortest : shortest + integralDoubleSuffix;
}

// Projections

function assertFieldName(projectionName, field) {
  if (ENVELOPE_KEYS.includes(field)) {
    throw new SerializationError(
      `ESI mod: projection "${projectionName}" declares the field "${field}", which is one of `
        + `nexumApi's envelope keys (${ENVELOPE_KEYS.join(", ")}). ESI bodies are bare: if this `
        + "really is an ESI field name, it is the first one, and this check is wrong.",
    );
  }
  if (!SNAKE_CASE.test(field)) {
    throw new SerializationError(
      `ESI mod: projection "${projectionName}" declares the field "${field}", which is not `
        + "snake_case. Every field name in CCP's spec is; nexumApi's camelCase is not ours to "
        + "inherit.",
    );
  }
}

/**
 * Build the projection function for one endpoint: `projectX(record) -> esiShape`.
 *
 * It keeps game-state shape from leaking into a response. A handler that returns
 * a store record directly publishes whatever upstream keeps on it (internal ids,
 * mutable references, fields added by a future eve.js version). A projection
 * writes the field list down, checks it against CCP's names at load, and a field
 * not on it cannot appear.
 *
 *   const projectStatus = projection("GetStatus", {
 *     players: (record) => record.players,
 *     server_version: (record) => String(record.build),
 *     start_time: (record) => record.startedAt,
 *     vip: (record) => optional(record.vip),
 *   });
 *
 * `name` is the spec's `operationId`, so a thrown message, a log line and a spec
 * lookup are the same string.
 *
 * Declaration order is output order, and output order is bytes: the golden files
 * under `contract/golden/` are compared as bytes. Write the fields in the order
 * CCP sends them.
 */
function projection(name, fields) {
  if (typeof name !== "string" || name === "") {
    throw new SerializationError("ESI mod: a projection must be named: use the spec's operationId.");
  }
  if (fields === null || typeof fields !== "object") {
    throw new SerializationError(`ESI mod: projection "${name}" needs an object of field readers.`);
  }

  const entries = Object.entries(fields);
  if (entries.length === 0) {
    throw new SerializationError(`ESI mod: projection "${name}" declares no fields.`);
  }

  for (const [field, read] of entries) {
    assertFieldName(name, field);
    if (typeof read !== "function") {
      throw new SerializationError(
        `ESI mod: projection "${name}" field "${field}" must be a function of the record, got `
          + `${typeof read}.`,
      );
    }
  }

  const frozen = Object.freeze(entries.map(([field, read]) => Object.freeze([field, read])));

  function project(record, ...rest) {
    const out = {};
    for (const [field, read] of frozen) {
      const value = read(record, ...rest);
      if (value === OMIT) continue;
      if (value === undefined) {
        throw new SerializationError(
          `ESI mod: projection "${name}" produced undefined for "${field}". JSON.stringify would `
            + "drop the key and say nothing: return OMIT to leave it out on purpose, or null to "
            + "send null.",
        );
      }
      out[field] = value;
    }
    return out;
  }

  project.fields = Object.freeze(frozen.map(([field]) => field));
  project.projectionName = name;
  return project;
}

// Serialization

/**
 * `JSON.stringify`'s replacer, and the only work done per value on the request
 * path. Non-objects short-circuit on the first line, which is nearly every value
 * in a body that is mostly ids.
 *
 * `instanceof` first as the fast path, `Object.prototype.toString` behind it
 * because a Set built in another realm (a `vm` context, which is how parts of
 * the game runtime are loaded) fails `instanceof` while being a Set in every way
 * that matters here.
 */
function setsToArrays(_key, value) {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Set || Object.prototype.toString.call(value) === "[object Set]") {
    return [...value];
  }
  return value;
}

/**
 * The replacer that carries marked doubles through `JSON.stringify`, which
 * cannot emit a raw token: every hook it offers returns a value, and a number
 * comes back out written JavaScript's way.
 *
 * A marked double leaves as a string nobody can spell, fenced with U+0000, which
 * no ESI body carries. `substituteDoubles` counts what it replaced rather than
 * trusting that, and the sentinels come back as digits afterwards. The
 * alternative is a hand-written JSON emitter, which means owning string escaping
 * for every corporation ticker and system name to change how one kind of number
 * is spelled.
 */
function doubleCollector(literals, integralDoubleSuffix) {
  return function replacer(key, value) {
    // `this` is the holder. Reading the raw value off it is what makes the marker
    // survive: `value` has already been through `toJSON` (the marker has none), but
    // a getter or a `Date` would have been converted there, and reading the holder
    // is how the other hooks in this file avoid the same mistake.
    const raw = this === undefined ? value : this[key];
    if (isDouble(raw)) {
      literals.push(renderDouble(raw[DOUBLE], integralDoubleSuffix, raw[SCALE]));
      return DOUBLE_SENTINEL(literals.length - 1);
    }
    return setsToArrays(key, value);
  };
}

/**
 * The sentinels back into digits, and a failure if one did not come back.
 *
 * A count that disagrees means a sentinel was swallowed (a `toJSON` upstream, a
 * body that carried the fence itself) and the response would carry a JSON string
 * where a client expected a number. This runs on the request path, so the failure
 * is a `500` in the log rather than a quietly malformed body.
 */
function substituteDoubles(json, literals) {
  if (literals.length === 0) return json;

  let replaced = 0;
  const out = json.replace(DOUBLE_SENTINEL_PATTERN, (match, index) => {
    const literal = literals[Number(index)];
    if (literal === undefined) return match;
    replaced += 1;
    return literal;
  });

  if (replaced !== literals.length) {
    throw new SerializationError(
      `ESI mod: ${literals.length} double(s) were marked and ${replaced} reached the body. A `
        + "marked double that does not come back as digits would go out as a JSON string.",
    );
  }
  return out;
}

/**
 * The bytes of a JSON body as `producer` would have written them, and the length
 * `content-length` has to claim.
 *
 * `Buffer.from(..., "utf8")` rather than `res.end(string)`, because the two
 * disagree once a body carries a non-ASCII character (a corporation ticker, a
 * system name), and a `content-length` counted in characters against a body
 * written in bytes is a truncated response.
 *
 * The trailing newline is the producer's: Go appends one, the application does
 * not. `producer` is required because no answer is right for both halves of the
 * surface.
 *
 * `undefined` becomes `null`: `JSON.stringify(undefined)` is `undefined`, not a
 * string, and `Buffer.from(undefined)` throws. A handler that fell off the end of
 * a function should not take the response with it.
 */
function serializeBody(body, producer) {
  const { trailingNewline, integralDoubleSuffix, escapesNonAscii } = producerWire(producer);
  const literals = [];
  const substituted = substituteDoubles(
    JSON.stringify(
      body === undefined ? null : body,
      doubleCollector(literals, integralDoubleSuffix),
    ),
    literals,
  );
  const json = escapesNonAscii ? escapeNonAscii(substituted) : substituted;
  return Buffer.from(trailingNewline ? `${json}\n` : json, "utf8");
}

// After-the-fact probes, for tests

/**
 * Which envelope keys a body carries at the top level. Empty for a bare body,
 * which is every body this replica may send.
 */
function findEnvelopeKeys(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
  return ENVELOPE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
}

/**
 * Every key anywhere in a body that is not snake_case, as paths
 * (`body.characters[0].characterID`), so a failure names the field.
 *
 * Walks the whole body, so it belongs in a test and not on the request path.
 */
function findNonSnakeCaseKeys(body, where = "body") {
  const problems = [];

  const walk = (value, path) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    for (const key of Object.keys(value)) {
      if (!SNAKE_CASE.test(key)) problems.push(`${path}.${key}`);
      walk(value[key], `${path}.${key}`);
    }
  };

  walk(body, where);
  return problems;
}

module.exports = {
  ENVELOPE_KEYS,
  OMIT,
  PRODUCER,
  PRODUCER_WIRE,
  SNAKE_CASE,
  SerializationError,
  arrayOf,
  contentTypeFor,
  double,
  escapeNonAscii,
  findEnvelopeKeys,
  findNonSnakeCaseKeys,
  isDouble,
  numberOrNull,
  optional,
  producerWire,
  projection,
  serializeBody,
};
