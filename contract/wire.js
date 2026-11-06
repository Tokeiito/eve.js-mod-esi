/**
 * What the pinned spec does not describe: CCP's wire behaviour.
 *
 * `contract/openapi.json` is authoritative for what a body may contain: field
 * names, types, and which are required. It says nothing about the things real
 * clients break on:
 *
 *   - the spec declares the response header as `ETag`; CCP sends `Etag`
 *   - `Vary` goes out as three separate header lines, never comma-joined
 *   - `GET /ping` is not in the document at all
 *   - an unrouted path leaves JSON entirely for Go's plain-text 404
 *   - `HEAD /status/` is a 405
 *   - the 401 bodies are literal strings half the client libraries match on
 *   - half the endpoints end their body with a newline and half do not
 *
 * These are protocol constants, written by hand with the date they were
 * established and the request that established them, not recorded into a fixture
 * corpus. Nothing under `contract/` is anyone's character data, and the test suite
 * never opens a socket.
 *
 * Source: direct observation of `https://esi.evetech.net` on the dates in
 * `ESTABLISHED`, with `curl -D -`. Every entry names its request, so
 * re-establishing one is a single command. A value nobody has observed does not
 * belong in this file: no entry means not known yet.
 *
 * The reconciliation rule (D22): this module and `contract/spec.js` deliberately
 * do not import one another. The spec owns the possibility space of a body, the
 * wire owns everything a client can observe about the response carrying it. A test
 * composes the two, which keeps it obvious which source each assertion stands on.
 */

"use strict";

/** The date the values in this file were last observed against live ESI. */
const ESTABLISHED = "2026-08-24";

// Response kinds

/**
 * ESI has two implementations behind one hostname, and these names for their
 * outputs make the disagreements statable.
 *
 * `GATEWAY_SUCCESS`  a 2XX served by the Go gateway                 GET /status/
 * `GATEWAY_ERROR`    a refusal the gateway makes before the app     401, Invalid tenant
 * `APP_SUCCESS`      a 2XX the application itself produced          GET /universe/regions/10000002/
 * `APP_ERROR`        a 4XX the application itself produced          bad id, unknown id
 * `UNROUTED`         no route matched; Go's own handler answers     /nope/, /v99/status/
 * `META_SUCCESS`     a 2XX from the `/meta/` surface                GET /meta/compatibility-dates
 * `PING`             `GET /ping`, outside every pipeline            2 bytes, no CORS
 *
 * `META_SUCCESS` (added 2026-08-23) sends the gateway's bytes (bare
 * `application/json`, body ending in a newline) and disagrees with the gateway
 * about caching: `Cache-Control: public, max-age=600` with no `must-revalidate` and
 * no `stale-if-error`, an `Expires` to match, and **no `Etag` and no `Last-Modified`
 * at all**. See `META`.
 *
 * `APP_SUCCESS` (added 2026-08-22): a 2XX is served by whichever implementation owns
 * the route, exactly as a 4XX is, and the two disagree about both the `content-type`
 * and the last byte of the body. `lib/serialize.js` keys on this. See `SUCCESS_KIND`
 * below for the survey.
 */
const KIND = Object.freeze({
  GATEWAY_SUCCESS: "gatewaySuccess",
  GATEWAY_ERROR: "gatewayError",
  APP_SUCCESS: "appSuccess",
  APP_ERROR: "appError",
  UNROUTED: "unrouted",
  META_SUCCESS: "metaSuccess",
  PING: "ping",
});

/**
 * `content-type`, exactly as sent, per producer.
 *
 * Three separate JSON spellings. The gateway sends no charset parameter; the
 * application sends one in capitals (`UTF-8`, not `utf-8`); Go's 404 sends
 * lowercase. A single `application/json; charset=utf-8` matches none of the three.
 *
 * The split runs through the 2XX path too: `GET /status/` and
 * `GET /universe/regions/10000002/` are both plain successes and disagree here.
 *
 *   curl -sD - https://esi.evetech.net/status/                            -> application/json
 *   curl -sD - https://esi.evetech.net/latest/universe/regions/10000002/  -> application/json; charset=UTF-8
 *   curl -sD - https://esi.evetech.net/latest/universe/systems/abc/       -> application/json; charset=UTF-8
 *   curl -sD - https://esi.evetech.net/nope/                              -> text/plain; charset=utf-8
 *   curl -sD - https://esi.evetech.net/ping                               -> text/plain
 */
const CONTENT_TYPE = Object.freeze({
  [KIND.GATEWAY_SUCCESS]: "application/json",
  [KIND.GATEWAY_ERROR]: "application/json",
  [KIND.APP_SUCCESS]: "application/json; charset=UTF-8",
  [KIND.APP_ERROR]: "application/json; charset=UTF-8",
  [KIND.UNROUTED]: "text/plain; charset=utf-8",
  // curl -sD - https://esi.evetech.net/meta/compatibility-dates -> application/json
  [KIND.META_SUCCESS]: "application/json",
  [KIND.PING]: "text/plain",
});

/**
 * Whether the body's last byte is `\n`.
 *
 * **The Go implementation appends a newline to every body it writes, and the
 * application appends none.** It is Go's `json.Encoder.Encode` against the
 * application's `Marshal`-and-write, visible in `content-length` on every response:
 *
 *   GET /latest/status/                         93  {"server_version":...}\n
 *   GET /latest/universe/regions/10000002/     270  {"constellations":...}
 *   401 (no token)                              45  {"error":"Unauthorized - No token provided"}\n
 *   400 Invalid tenant                          27  {"error":"Invalid tenant"}\n
 *   422 validation failed                      130  {"status":422,...}\n
 *   404 {"error":"Region not found"}            28  {"error":"Region not found"}
 *   404 page not found  (unrouted)              19  404 page not found\n
 *   GET /ping                                    2  ok
 *
 * The correlation with `CONTENT_TYPE` is exact on every endpoint surveyed: a JSON
 * body sent as bare `application/json` ends with a newline, one sent as
 * `application/json; charset=UTF-8` does not. They are two facts about one producer,
 * so `lib/serialize.js` keeps them in a single row.
 *
 * A missing newline is one byte of `content-length`, so a replica omitting it is off
 * by one on every gateway response, and a client comparing an `Etag` or a hash sees a
 * different body.
 */
const TRAILING_NEWLINE = Object.freeze({
  [KIND.GATEWAY_SUCCESS]: true,
  [KIND.GATEWAY_ERROR]: true,
  [KIND.APP_SUCCESS]: false,
  [KIND.APP_ERROR]: false,
  [KIND.UNROUTED]: true,
  // 208 bytes for 207 of JSON, so the meta surface writes Go's newline too.
  [KIND.META_SUCCESS]: true,
  [KIND.PING]: false,
});

/**
 * Which implementation answers a given 2XX, as observed: the success-side twin of
 * `ERROR_FAMILY` below.
 *
 * No rule derives this from the path. It is not the path prefix:
 * `/sovereignty/map/` is the gateway and `/sovereignty/campaigns/` is the application.
 * It is not the rate-limit group: those two share `sovereignty`. It is not even the
 * path alone: `GET /characters/:character_id` is the gateway and
 * `POST /characters/affiliation/` is the application, so a key here names the method
 * when the path would be ambiguous.
 *
 * So a route declares its success producer per route, like its cache TTL. This table
 * is the survey behind that rule, taken 2026-08-22 with `curl -sD -` against
 * `/latest/<path>/`, and `lib/router.js` refuses to let a route omit it. It covers the
 * endpoints surveyed, not all 35: an absent endpoint has not been observed yet.
 */
const SUCCESS_KIND = Object.freeze({
  "/status": KIND.GATEWAY_SUCCESS,
  "/sovereignty/map": KIND.GATEWAY_SUCCESS,
  "/sovereignty/structures": KIND.GATEWAY_SUCCESS,
  "/characters/:character_id": KIND.GATEWAY_SUCCESS,
  // The other two public entity lookups, observed 2026-08-25. The prose on
  // `ERROR_FAMILY` below had recorded both at `200` since 2026-08-22. They are the
  // gateway, on all four signals: bare `application/json`, a trailing newline, a weak
  // 64-hex `Etag`, and no `X-Esi-Request-Id`.
  //
  // Nothing is claimed by proximity. `/alliances` (the collection, two rows down) is the
  // application, and `/corporations/npccorps` has not been looked at. One path level is
  // not evidence, as `/characters/:character_id` and its authenticated children show.
  "/corporations/:corporation_id": KIND.GATEWAY_SUCCESS,
  "/alliances/:alliance_id": KIND.GATEWAY_SUCCESS,
  "/sovereignty/campaigns": KIND.APP_SUCCESS,
  "POST /characters/affiliation": KIND.APP_SUCCESS,
  "POST /universe/names": KIND.APP_SUCCESS,
  "POST /universe/ids": KIND.APP_SUCCESS,
  "/alliances": KIND.APP_SUCCESS,
  "/incursions": KIND.APP_SUCCESS,
  "/markets/prices": KIND.APP_SUCCESS,
  "/wars": KIND.APP_SUCCESS,
  "/fw/wars": KIND.APP_SUCCESS,
  "/fw/systems": KIND.APP_SUCCESS,
  "/universe/systems": KIND.APP_SUCCESS,
  "/universe/regions": KIND.APP_SUCCESS,
  "/universe/regions/:region_id": KIND.APP_SUCCESS,
  "/universe/systems/:system_id": KIND.APP_SUCCESS,
  "/universe/stars/:star_id": KIND.APP_SUCCESS,
  "/universe/constellations/:constellation_id": KIND.APP_SUCCESS,
  "/universe/types/:type_id": KIND.APP_SUCCESS,
  "/universe/categories/:category_id": KIND.APP_SUCCESS,
  "/universe/moons/:moon_id": KIND.APP_SUCCESS,
  "/universe/stations/:station_id": KIND.APP_SUCCESS,
  "/universe/graphics": KIND.APP_SUCCESS,
  "/universe/factions": KIND.APP_SUCCESS,
  "/universe/races": KIND.APP_SUCCESS,
  "/universe/bloodlines": KIND.APP_SUCCESS,
  "/universe/ancestries": KIND.APP_SUCCESS,
  "/universe/system_jumps": KIND.APP_SUCCESS,
  "/universe/system_kills": KIND.APP_SUCCESS,
  // Both market-hub-seed reads, observed 2026-08-23. `/markets/prices/` sends 15,817
  // rows in one body with no `X-Pages` at all; `/markets/{region_id}/orders/` reported
  // `X-Pages: 413` for The Forge at 1000 per page, which is `PAGINATION.pageSize`
  // confirmed on a third route. Both: charset=UTF-8, no trailing newline, strong 56-hex
  // Etag, bare `public`, and Expires measured from Last-Modified. They disagree about
  // the limiter because of the pinned spec: `/markets/prices` publishes no `x-rate-limit`
  // and `/markets/{region_id}/orders` publishes `market-order`.
  "/markets/prices": KIND.APP_SUCCESS,
  "/markets/:region_id/orders": KIND.APP_SUCCESS,
  // The three authenticated reads, observed 2026-08-25 with a real token for a real
  // character. All three are the application: `charset=UTF-8`, no trailing newline, a
  // strong 56-hex `Etag`, `X-Esi-Request-Id` and `X-Esi-Cache-Status`. The parent
  // `/characters/:character_id` above is the *gateway*, and a sibling path is not
  // evidence either way.
  //
  // They also send a new `Cache-Control` form. See `CACHE_CONTROL` and
  // `AUTHENTICATED_CACHE_CONTROL` below.
  "/characters/:character_id/online": KIND.APP_SUCCESS,
  "/characters/:character_id/location": KIND.APP_SUCCESS,
  "/characters/:character_id/ship": KIND.APP_SUCCESS,
  // A further authenticated capture, 2026-08-25, one token throughout
  // (`scripts/observe-authed.js`). All three are the application, on the same four
  // signals as the reads above: `charset=UTF-8`, no trailing newline, `X-Esi-Request-Id`,
  // and no `nosniff`.
  //
  // **Only three.** The same run also reached `/corporations/{id}/structures` and
  // `/characters/{id}/fleet`, and neither answered a success: a `403` for want of a
  // corporation role and a `404` for a pilot in no fleet. Their refusals are recorded
  // below; their success kind is not recorded here because it was not seen.
  "/characters/:character_id/contacts": KIND.APP_SUCCESS,
  "/corporations/:corporation_id/contacts": KIND.APP_SUCCESS,
  "/alliances/:alliance_id/contacts": KIND.APP_SUCCESS,
  "/characters/:character_id/roles": KIND.APP_SUCCESS,
  // Unversioned, and a third implementation: see `META`.
  "/meta/compatibility-dates": KIND.META_SUCCESS,
  "/meta/changelog": KIND.META_SUCCESS,
});

/**
 * Which producers send `X-Content-Type-Options: nosniff`.
 *
 * Not "always" (no 2XX carries it) and not "never". The gateway and Go send it; the
 * application does not:
 *
 *   401 Unauthorized                    X-Content-Type-Options: nosniff
 *   400 Invalid tenant                  X-Content-Type-Options: nosniff
 *   404 page not found  (unrouted)      X-Content-Type-Options: nosniff
 *   200 GET /status/                    absent
 *   404 {"error":"System not found"}    absent
 *
 * Design constraint 3 is fidelity over hygiene, so this is reproduced as observed.
 */
const SENDS_NOSNIFF = Object.freeze({
  [KIND.GATEWAY_SUCCESS]: false,
  [KIND.GATEWAY_ERROR]: true,
  [KIND.APP_SUCCESS]: false,
  [KIND.APP_ERROR]: false,
  [KIND.META_SUCCESS]: false,
  [KIND.UNROUTED]: true,
  [KIND.PING]: false,
});

/**
 * Which producers carry the CORS headers at all.
 *
 * All of them except `PING`, which carries nothing. As a table, this lets
 * `test/ping.test.js` assert the absence against an observation.
 */
const SENDS_CORS = Object.freeze({
  [KIND.GATEWAY_SUCCESS]: true,
  [KIND.GATEWAY_ERROR]: true,
  [KIND.APP_SUCCESS]: true,
  [KIND.APP_ERROR]: true,
  [KIND.UNROUTED]: true,
  [KIND.META_SUCCESS]: true,
  [KIND.PING]: false,
});

// CORS

/**
 * `Access-Control-Expose-Headers`, in CCP's order and casing, as one string.
 *
 * Load-bearing for every browser-direct consumer: without it a page can read neither
 * `X-Pages` nor `Etag`, and eve-nexum's client self-throttles when the error-limit
 * headers it cannot see appear to be missing. Sent on every kind except `PING`.
 */
const EXPOSE_HEADERS = [
  "Etag",
  "Retry-After",
  "X-Compatibility-Date",
  "X-Esi-Error-Limit-Remain",
  "X-Esi-Error-Limit-Reset",
  "X-Pages",
  "X-Ratelimit-Group",
  "X-Ratelimit-Limit",
  "X-Ratelimit-Remaining",
  "X-Ratelimit-Used",
].join(", ");

/**
 * The CORS preflight, a response path of its own.
 *
 * It does not route. `OPTIONS /nope/` and `OPTIONS /ping` both answer `204` exactly as
 * `OPTIONS /status/` does, so the preflight is decided before anything looks at a path.
 * An implementation answering it from the router would 404 the first two.
 *
 * **The trigger is `Access-Control-Request-Method`, not `Origin`.** Both halves were
 * checked:
 *
 *   OPTIONS /status/  + Access-Control-Request-Method: GET   -> 204 preflight
 *   OPTIONS /status/  + Origin: https://example.com          -> 405, the ordinary one
 *   OPTIONS /status/  (neither)                              -> 405, the ordinary one
 *
 * The 204 carries these six headers and **nothing else**: no
 * `Access-Control-Expose-Headers`, no `Content-Language`, no `Content-Length`, and one
 * `Vary` line rather than the usual three. It is as far outside the normal pipeline as
 * `/ping` is.
 */
const PREFLIGHT = Object.freeze({
  status: 204,
  /** The request header whose presence makes an OPTIONS a preflight. */
  trigger: "access-control-request-method",
  /**
   * Echoed straight back from `Access-Control-Request-Headers`, verbatim, including the
   * client's own spacing, and `*` when the client asked for nothing. A mirror, not a list
   * CCP maintains.
   */
  defaultAllowHeaders: "*",
  /**
   * Fixed, and not derived from the route: `/status/` accepts only GET and
   * still advertises four.  Comma-space separated, and `OPTIONS`, `PATCH` and
   * `HEAD` are all missing.
   */
  allowMethods: "GET, POST, PUT, DELETE",
  maxAge: "86400",
  /** One line, replacing the usual three. */
  vary: "Access-Control-Request-Headers",
  /** The complete header set, lowercased. Nothing else appears. */
  headers: Object.freeze([
    "access-control-allow-headers",
    "access-control-allow-methods",
    "access-control-allow-origin",
    "access-control-max-age",
    "connection",
    "date",
    "vary",
  ]),
});

/**
 * `Access-Control-Allow-Credentials` is **never** sent, on any response, including one
 * carrying an `Origin`. `Allow-Origin: *` and credentials mode are mutually exclusive,
 * and a browser rejects the pair, so adding it would break every browser-based consumer.
 */
const NEVER_SENT = Object.freeze(["access-control-allow-credentials"]);

/**
 * `Access-Control-Allow-Origin: *`, unconditionally, whether or not the request carried
 * an `Origin`, so there is no per-origin logic to write and nothing to vary on.
 */
const ALLOW_ORIGIN = "*";

/**
 * `Vary`, as three separate header lines in this order, not comma-joined.
 *
 * Node writes an array as repeated headers. Do not fold them into one line, which some
 * intermediaries do and which changes the bytes a cache keys on.
 */
const VARY = Object.freeze(["X-Tenant", "Accept-Language", "X-Compatibility-Date"]);

/**
 * `Vary`, per response kind, in the order and multiplicity CCP sends it.
 *
 * How many `Vary` lines a response carries says how far the request got:
 *
 *   GET /ping                         (none)
 *   400 Invalid tenant                (none)
 *   400 bad compatibility date        X-Tenant, Accept-Language
 *   200 /status/            (gateway) X-Tenant, Accept-Language, X-Compatibility-Date
 *   404 unrouted                      X-Tenant, Accept-Language, X-Compatibility-Date
 *   200 /markets/prices/    (app)     X-Tenant, Accept-Language, X-Compatibility-Date
 *
 * `X-Compatibility-Date` appears once the request has reached routing, which is why the
 * two refusals made in front of it (a bad `datasource`, a bad date) do not carry it.
 *
 * This table gives the three-line form. A route whose body carries translated text sends
 * a *fourth* line: `VARY_LOCALIZED_BODY` below, a property of the route, not of the kind.
 *
 * **`GATEWAY_ERROR` is the one row this table cannot state.** The two edge refusals share
 * the kind and disagree: the compatibility-date one sends two lines and `Invalid tenant`
 * sends none, on the same status, from the same producer, one layer apart. The row below
 * is the compatibility-date refusal's; the tenant refusal's is `TENANT.refusal.vary`,
 * which is empty. So `lib/compatibility.js` attaches its own `Vary` and `lib/errors.js`
 * attaches none.
 */
const VARY_BY_KIND = Object.freeze({
  [KIND.GATEWAY_SUCCESS]: Object.freeze(["X-Tenant", "Accept-Language", "X-Compatibility-Date"]),
  [KIND.GATEWAY_ERROR]: Object.freeze(["X-Tenant", "Accept-Language"]),
  [KIND.APP_SUCCESS]: Object.freeze(["X-Tenant", "Accept-Language", "X-Compatibility-Date"]),
  [KIND.APP_ERROR]: Object.freeze(["X-Tenant", "Accept-Language", "X-Compatibility-Date"]),
  [KIND.UNROUTED]: Object.freeze(["X-Tenant", "Accept-Language", "X-Compatibility-Date"]),
  [KIND.META_SUCCESS]: Object.freeze(["X-Tenant", "Accept-Language", "X-Compatibility-Date"]),
  [KIND.PING]: Object.freeze([]),
});

/**
 * The fourth line, and what earns it.
 *
 * A response whose body contains **translated text** repeats `Accept-Language`. One whose
 * body does not, sends it once. Both producers, successes and errors alike: it follows
 * the route, not the kind and not the status.
 *
 * Surveyed 2026-08-24, eighteen routes, and the split is total:
 *
 *   two lines                          one line
 *   /universe/factions/                /universe/regions/
 *   /universe/regions/{id}/            /universe/categories/
 *   /universe/categories/{id}/         /universe/types/
 *   /universe/types/{id}/              /universe/systems/
 *   /universe/races/                   /dogma/attributes/
 *   /universe/bloodlines/              /markets/prices/
 *   404 /universe/regions/99999999/    /markets/{region_id}/orders/
 *   404 /universe/types/999999999/     /contracts/public/{region_id}/
 *                                      /status/ /wars/ /incursions/
 *                                      /alliances/ /fw/wars/
 *                                      400 ?page=0 on /markets/{id}/orders/
 *
 * The left-hand bodies have `name` and `description` in them; the right-hand ones are ids
 * and numbers. `/universe/regions/` is a list of integers and sends one line; the *item*
 * route beside it has a name and sends two, on the same weak etag, from the same
 * static-data dump, so the cache in front of them is not the cause.
 *
 * The pinned spec cannot answer this alone: it declares the `AcceptLanguage` parameter on
 * **every** operation, including `/status/`. What predicts it on all eighteen is whether
 * the operation's `200` schema carries a localizable `name` or `description` string;
 * `test/varyLocalization.test.js` runs that prediction against this table.
 *
 * Sending a `Vary` line CCP does not send (a survey off `/universe/factions/` once
 * generalised the duplicate to the whole producer) widens the cache key: a shared cache
 * in front of the replica fragments on a header CCP's does not, which costs hit rate.
 */
const VARY_LOCALIZED_BODY = Object.freeze([
  "X-Tenant",
  "Accept-Language",
  "X-Compatibility-Date",
  "Accept-Language",
]);

/**
 * The routes the survey above put in each column, as data a test can check.
 *
 * Keyed by the spec path (no trailing slash), because `contract/openapi.json` is keyed by
 * it and the prediction looks the operation up.
 */
const VARY_LOCALIZED_SURVEY = Object.freeze({
  localized: Object.freeze([
    // One surprise in the authenticated capture (2026-08-25): every response in that run sent
    // the plain three-line `VARY`, except the `403` refusing `/corporations/{id}/structures`
    // for want of a role, which sent the four-line `VARY_LOCALIZED_BODY` form,
    // `Accept-Language` twice.
    //
    // So on this evidence the fourth line is a property of the **response**, not the *route*,
    // and an error body counts as translated text where that route's success may not. The
    // success was never seen (the role gate refused first), so this entry is about the refusal
    // only and the route's success column stays unfilled.
    "/corporations/{corporation_id}/structures",
    "/universe/factions",
    // Observed 2026-08-25. Both carry a `name` that is a dictionary of eight languages in CCP's
    // own dump, which is what the left-hand column means and why these two sit here rather than
    // in the third.
    "/universe/systems/{system_id}",
    "/universe/constellations/{constellation_id}",
    "/universe/regions/{region_id}",
    "/universe/categories/{category_id}",
    "/universe/types/{type_id}",
    "/universe/races",
    "/universe/bloodlines",
  ]),
  plain: Object.freeze([
    "/universe/regions",
    "/universe/categories",
    "/universe/types",
    "/universe/systems",
    "/dogma/attributes",
    "/markets/prices",
    "/markets/{region_id}/orders",
    "/contracts/public/{region_id}",
    "/status",
    "/wars",
    "/incursions",
    "/alliances",
    "/fw/wars",
  ]),

  /**
   * The third column, which puts a boundary on the rule.
   *
   * Observed 2026-08-25: `/characters/{id}/`, `/corporations/{id}/` and `/alliances/{id}/` each
   * answer with a `name`, and a `description` on two of the three, and each sends the **plain
   * three-line** `Vary`.
   *
   *   curl -sD - https://esi.evetech.net/latest/characters/3004069/
   *   curl -sD - https://esi.evetech.net/latest/corporations/1000035/
   *   curl -sD - https://esi.evetech.net/latest/alliances/99000001/
   *     Vary: X-Tenant / Vary: Accept-Language / Vary: X-Compatibility-Date
   *
   * So the content rule alone does not predict the wire. All eighteen routes in the two columns
   * above are the **application**, and these three are the **gateway** (`SUCCESS_KIND`). The
   * rule, with both halves:
   *
   *   gateway      -> always three lines, whatever the body says
   *   application  -> four lines iff the 200 schema carries name/description
   *
   * `/status/` sat in `plain` and agreed with both readings (it is the gateway *and* answers
   * with numbers), so it could not tell them apart. These three can. They keep their own column
   * so the second test over `plain` keeps asserting the content rule for the producer it
   * describes.
   */
  plainDespiteText: Object.freeze([
    "/characters/{character_id}",
    "/corporations/{corporation_id}",
    "/alliances/{alliance_id}",
  ]),

  /**
   * The fourth column, which bounds the *content* half of the rule the way the third bounds the
   * producer half.
   *
   * Observed 2026-08-25, and these two are the application:
   *
   *   curl -sD - https://esi.evetech.net/latest/universe/stars/40009076/
   *   curl -sD - https://esi.evetech.net/latest/universe/stations/60003760/
   *     Vary: X-Tenant / Vary: Accept-Language / Vary: X-Compatibility-Date
   *
   * Both `200` schemas carry a `name` string, so the rule above predicts four lines and CCP
   * sends three. The producer qualifier does not explain it: `/universe/systems/{id}/` and
   * `/universe/constellations/{id}/` are the same producer, captured in the same minute, and
   * they *do* repeat it.
   *
   * The difference is in the dump. `mapSolarSystems.jsonl` and `mapConstellations.jsonl` carry
   * `name` as a dictionary of eight languages; `mapStars.jsonl` and `npcStations.jsonl` carry
   * **no name field at all**, and the exporter composes those two from other names: "Jita - Star"
   * from the system, "Jita IV - Moon 4 - Caldari Navy Assembly Plant" from the orbit and the
   * station operation. CCP repeats the header for a string they *translate*, not for a string
   * field called `name`, and a response schema cannot tell those apart.
   *
   * A positive case outside these four, checked afterwards: `factions.jsonl` carries both `name`
   * and `description` as language dictionaries, and `/universe/factions/` is in `localized`. So
   * the dictionary predicts the fourth line on a route in neither of these two columns.
   *
   * The rule, with both bounds:
   *
   *   gateway      -> always three lines, whatever the body says
   *   application  -> four lines iff the body carries a string CCP translates,
   *                   which the 200 schema cannot distinguish from a composed one
   *
   * Its own column rather than folded into `plainDespiteText`, because the two exceptions are
   * unrelated: that one is about which implementation answered, this one about where the string
   * came from.
   */
  plainDespiteComposedName: Object.freeze([
    "/universe/stars/{star_id}",
    "/universe/stations/{station_id}",
  ]),
});

// X-Compatibility-Date (D11)

/**
 * The surface this replica serves, and the value it echoes.
 *
 * D4 pins us to `2020-01-01`, and `/latest/` echoes exactly that whatever a client asks for:
 * `X-Compatibility-Date: 2026-08-01` against `/latest/status/` still comes back
 * `X-Compatibility-Date: 2020-01-01`.
 */
const COMPATIBILITY_DATE = "2020-01-01";

/**
 * Which responses echo it.
 *
 * The echo says *which surface answered you*, so it appears exactly when a route answered:
 *
 *   200 /status/                       X-Compatibility-Date: 2020-01-01
 *   200 /universe/regions/10000002/    X-Compatibility-Date: 2020-01-01
 *   404 {"error":"Region not found"}   X-Compatibility-Date: 2020-01-01
 *   422 validation failed              X-Compatibility-Date: 2020-01-01
 *   304 Not Modified                   X-Compatibility-Date: 2020-01-01
 *   401 Unauthorized                   absent
 *   404 page not found (unrouted)      absent
 *   405 Method Not Allowed             absent
 *   400 Invalid tenant                 absent
 *   GET /ping                          absent
 *
 * The `405` and the unrouted `404` both carry `Vary: X-Compatibility-Date` (routing happened)
 * and neither carries the echo, because no route answered.
 */
const ECHOES_COMPATIBILITY_DATE = Object.freeze({
  [KIND.GATEWAY_SUCCESS]: true,
  [KIND.GATEWAY_ERROR]: false,
  [KIND.APP_SUCCESS]: true,
  [KIND.APP_ERROR]: true,
  [KIND.UNROUTED]: false,
  [KIND.PING]: false,
});

/**
 * **D11 assumed the header is ignored on the legacy surface. It is validated.**
 *
 * Three classes of value are refused before anything routes, each with its own message. All
 * three are `EDGE` refusals (`application/json`, `nosniff`, a two-line `Vary` and no echo),
 * like `Invalid tenant`:
 *
 *   nope / 2026-8-1 / 20260801 / 2026-13-01 / 2026-02-30
 *     400 {"error":"Invalid compatibility date format. Expected YYYY-MM-DD."}
 *   2019-12-31
 *     400 {"error":"Compatibility date (2019-12-31) is before the oldest supported date: 2020-01-01."}
 *   2026-08-24, when today is 2026-08-23
 *     400 {"error":"Compatibility date (2026-08-24) is in the future. Current date (UTC-11) is 2026-08-23."}
 *
 * `2026-13-01` and `2026-02-30` are *format* errors, not range errors: the check is that the
 * value is a real calendar date in that spelling. An empty header is accepted and treated as
 * absent.
 *
 * "Today" is evaluated in **UTC-11**, and CCP says so in the message. A date is in the future
 * only once it is past today in the most westerly zone, so the boundary is eleven hours later
 * than a naive UTC comparison.
 *
 * These refusals carry CORS, which is why the layer sits inside `lib/cors.js`, as
 * `SENDS_CORS[GATEWAY_ERROR]` records. Two curls on 2026-08-23:
 *
 *   curl -sD - -H "X-Compatibility-Date: nope" https://esi.evetech.net/latest/status/
 *   curl -sD - "https://esi.evetech.net/latest/status/?datasource=nope"
 *     Access-Control-Allow-Origin: *
 *     Access-Control-Expose-Headers: Etag, Retry-After, ... X-Ratelimit-Used
 *     X-Content-Type-Options: nosniff
 *     Vary: X-Tenant / Accept-Language          (two lines, and no echo)
 *     X-Esi-Error-Limit-Remain: 99              (and it spent a unit)
 *
 * `test/compatibility.test.js` asserts this row. A table row nothing asserts can be contradicted
 * in a comment.
 *
 * The error-limit pair holds on a route the token bucket owns: `/latest/status/` publishes the
 * group `status`, and a bad date on it still comes back on the error limiter. A refusal made in
 * front of routing never reached the route that owns the bucket, the same rule that splits the
 * two `405`s.
 *
 * Deliberately not reproduced
 *
 * A valid in-range date **selects a surface**, and the header wins over the path prefix for
 * routing:
 *
 *   GET /latest/sovereignty/map/  X-Compatibility-Date: 2026-08-01
 *     404 {"error":"Page not found"}
 *
 * because `/sovereignty/map` does not exist on the modern surface, the same fact that makes
 * pinning the default fetch the only correct one (D22). Reproducing that needs a date-versioned
 * route table, and D4 scoped this replica to the `2020-01-01` surface. So an in-range date is
 * served from the one surface we have and echoed as `2020-01-01`, which is what CCP does for
 * every route that exists on both.
 */
const COMPATIBILITY_DATE_RULES = Object.freeze({
  oldestSupported: "2020-01-01",
  /** The zone "today" is evaluated in, and named in the message. */
  todayOffsetHours: -11,
  emptyHeaderIsAbsent: true,
  /**
   * The second way to ask, which D11 did not implement.
   *
   *   curl -sD - "https://esi.evetech.net/latest/status/?compatibility_date=nope"
   *     400 {"error":"Invalid compatibility date format. Expected YYYY-MM-DD."}
   *   curl -sD - "https://esi.evetech.net/latest/status/?compatibility_date=2019-12-31"
   *     400 {"error":"Compatibility date (2019-12-31) is before the oldest supported date: 2020-01-01."}
   *   curl -sD - "https://esi.evetech.net/latest/status/?compatibility_date=2026-08-25"
   *     400 {"error":"Compatibility date (2026-08-25) is in the future. ..."}
   *
   * Same three refusals, same messages, same edge shape. A replica validating only the header
   * would serve a `200` to a request CCP refuses.
   */
  queryParameter: "compatibility_date",
  /**
   * **The query parameter wins outright**, and does not merely fill in for an absent header: a
   * bad header with a good query parameter is a `200`:
   *
   *   -H "X-Compatibility-Date: nope"  ?compatibility_date=2020-01-01  -> 200
   *   -H "X-Compatibility-Date: 2020-01-01"  ?compatibility_date=nope  -> 400
   *
   * So: pick one, then validate it. Not "validate both".
   */
  queryWins: true,
  /**
   * An empty query parameter is absent, exactly as an empty header is, and being absent it hands
   * the question back to the header:
   *
   *   -H "X-Compatibility-Date: nope"  ?compatibility_date=   -> 400, from the header
   */
  emptyQueryIsAbsent: true,
  errors: Object.freeze({
    badFormat: "Invalid compatibility date format. Expected YYYY-MM-DD.",
    tooOld: (value, oldest = "2020-01-01") =>
      `Compatibility date (${value}) is before the oldest supported date: ${oldest}.`,
    inFuture: (value, today) =>
      `Compatibility date (${value}) is in the future. Current date (UTC-11) is ${today}.`,
  }),
});

/**
 * Every header name observed on a gateway 2XX, lowercased.
 *
 * As a *ceiling* it is exact: a header this list does not contain is one CCP does not send, and
 * writing it makes us distinguishable (this is what took `x-content-type-options` off our 2XX
 * responses). As a *floor* it is aspirational, since not every listed header is written by every
 * layer yet: `cache-control`, `etag`, `expires`, `vary` and the rate-limit family belong to the
 * caching and limiter layers.
 *
 * `strict-transport-security` is meaningless under D1's plain HTTP and waits for D14.
 * `x-esi-cache-status` is on every 2XX CCP sends, and a conformance diff counts a missing header
 * the same as an invented one; "we have no CDN" concerns the *value*, not the header. See
 * `INFRASTRUCTURE` below for what the replica derives it from.
 *
 *   curl -sD - https://esi.evetech.net/status/
 */
const GATEWAY_SUCCESS_HEADERS = Object.freeze([
  "access-control-allow-origin",
  "access-control-expose-headers",
  "cache-control",
  "connection",
  "content-language",
  "content-length",
  "content-type",
  "date",
  "etag",
  "expires",
  "last-modified",
  "strict-transport-security",
  "vary",
  "x-compatibility-date",
  "x-esi-cache-status",
  "x-ratelimit-group",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-used",
]);

/**
 * Every header name observed on an application 2XX, lowercased.
 *
 * Not the gateway's list: the gateway reports the **rate** limit (`x-ratelimit-*`) and the
 * application reports the **error** limit (`x-esi-error-limit-*`), and neither sends the other's
 * family. The application also stamps an `x-esi-request-id`, which the gateway does not. So which
 * limiter headers an endpoint sends follows from its producer.
 *
 * The application sends `Vary: Accept-Language` **twice** (four `Vary` lines, one repeated) where
 * the gateway sends three.
 *
 *   curl -sD - https://esi.evetech.net/latest/universe/regions/10000002/
 */
const APP_SUCCESS_HEADERS = Object.freeze([
  "access-control-allow-origin",
  "access-control-expose-headers",
  "cache-control",
  "connection",
  "content-language",
  "content-length",
  "content-type",
  "date",
  "etag",
  "expires",
  "last-modified",
  "strict-transport-security",
  "vary",
  "x-compatibility-date",
  "x-esi-cache-status",
  "x-esi-error-limit-remain",
  "x-esi-error-limit-reset",
  "x-esi-request-id",
]);

// Tenant (D11)

/**
 * `?datasource=` and `X-Tenant:`, and the one value either may hold.
 *
 * One tenant, and `singularity` is not it
 *
 * Every tool in the ecosystem sends `?datasource=tranquility` (D4), now the *only* value the
 * surface takes. `singularity`, the second datasource half the client libraries still carry in an
 * enum, is refused:
 *
 *   curl -sD - "https://esi.evetech.net/latest/status/?datasource=singularity"
 *     400 {"error":"Invalid tenant"}
 *
 * A private server advertises `tranquility` rather than its own name: every tool hardcoding the
 * query parameter would be refused otherwise, and CCP has spent years shrinking this set.
 *
 * Both spellings, and the query parameter wins
 *
 *   ?datasource=tranquility                    200
 *   X-Tenant: tranquility                      200
 *   ?datasource=nope                           400 {"error":"Invalid tenant"}
 *   X-Tenant: nope                             400 {"error":"Invalid tenant"}
 *   X-Tenant: nope + ?datasource=tranquility   200   <- the query parameter wins
 *   X-Tenant: tranquility + ?datasource=nope   400   <- and both ways round
 *
 * The same precedence as the compatibility date. "The header is a fallback for the query parameter"
 * and "either one being bad is a refusal" agree on four of those rows and disagree on the last two.
 *
 * Case-insensitive, and empty is absent
 *
 *   ?datasource=TRANQUILITY   200      ?datasource=            200
 *   X-Tenant: Tranquility     200      X-Tenant: (empty)       200
 *
 * Where the check happens
 *
 * Before routing, and **before the compatibility date**:
 *
 *   /nope/?datasource=nope                             400 Invalid tenant, not the unrouted 404
 *   -H "X-Compatibility-Date: nope" ?datasource=nope   400 Invalid tenant, not the date refusal
 *
 * and outside both surfaces that sit in front of everything:
 *
 *   /ping?datasource=nope                              200 ok, two bytes
 *   OPTIONS + Access-Control-Request-Method            204 preflight
 *
 * What the refusal carries
 *
 * An `EDGE` refusal, the emptiest response on the surface: **no `Vary` at all** (not even the two
 * lines the compatibility-date refusal sends) and no `Content-Language`, which every other JSON
 * response carries.
 *
 *   curl -sD - "https://esi.evetech.net/latest/status/?datasource=nope"
 *     HTTP/1.1 400 Bad Request
 *     Content-Type: application/json
 *     Content-Length: 27
 *     Access-Control-Allow-Origin: *
 *     Access-Control-Expose-Headers: Etag, ...
 *     X-Content-Type-Options: nosniff
 *     X-Esi-Error-Limit-Remain: 99          (and it spent a unit)
 *
 * It is on the error limiter even on `/latest/status/`, which the token bucket owns, the same rule as
 * the compatibility-date refusal and the POST `405`: a request refused in front of routing never
 * reached the route that owns a bucket.
 */
const TENANT = Object.freeze({
  /** The only accepted value, compared case-insensitively. */
  value: "tranquility",
  queryParameter: "datasource",
  header: "x-tenant",
  queryWins: true,
  caseInsensitive: true,
  emptyIsAbsent: true,
  /** Refused before the compatibility date is even looked at. */
  checkedBeforeCompatibilityDate: true,
  refusal: Object.freeze({
    status: 400,
    family: "edge",
    body: '{"error":"Invalid tenant"}',
    /** Empty; see `VARY_BY_KIND` on why this is not a row in that table. */
    vary: Object.freeze([]),
    cors: true,
    nosniff: true,
    limiter: "error-limit",
    costsAUnit: true,
  }),
});

// The `/meta/` surface

/**
 * `GET /meta/compatibility-dates`, the third implementation behind the hostname.
 *
 * Why it is a producer and not a route on the gateway
 *
 * It sends the gateway's *bytes* (bare `application/json`, body ending in a newline, 208 for 207 of
 * JSON) and disagrees with it about everything cache-shaped:
 *
 *   GET /latest/status/            public, max-age=30, must-revalidate, stale-if-error=900
 *                                  Etag: W/"..."   Last-Modified: ...   X-Esi-Cache-Status: HIT
 *   GET /meta/compatibility-dates  public, max-age=600
 *                                  (no Etag, no Last-Modified, no X-Esi-Cache-Status)
 *   GET /meta/openapi.json         public, max-age=600
 *                                  (the same, which is what makes it a surface)
 *
 * Two routes agreeing with each other and disagreeing with the gateway the same way makes this a
 * third row of `CACHE_CONTROL` rather than one endpoint's quirk.
 *
 * It is unversioned
 *
 *   GET /meta/compatibility-dates          200
 *   GET /latest/meta/compatibility-dates   404 page not found   (Go's, 19 bytes)
 *
 * The same shape as `/ping`, and the second entry in `UNVERSIONED_PATHS`.
 *
 * The body
 *
 * `{"compatibility_dates":[...]}`, newest first, and CCP's list is fourteen long. A replica serving
 * one surface (D4) publishes one date: the endpoint says which surfaces exist *here*. The golden
 * recording beside this file is CCP's bytes, and proves the shape (the key name, the newline) rather
 * than the list.
 *
 * Deliberately not reproduced
 *
 * `HEAD /meta/compatibility-dates` is a `405` carrying the route's `Cache-Control` and the
 * `X-Compatibility-Date` echo, where `HEAD /latest/status/` carries neither:
 *
 *   curl -sI https://esi.evetech.net/meta/compatibility-dates
 *     405  Cache-Control: public, max-age=600   X-Compatibility-Date: 2020-01-01
 *          X-Ratelimit-Group: meta
 *   curl -sI https://esi.evetech.net/latest/status/
 *     405  X-Ratelimit-Group: status            (and neither of the other two)
 *
 * `lib/router.js` gives both the `/status/` shape, so our `HEAD` here is two headers short of CCP's;
 * the rate-limit group and the absent `Allow` are right. No client sends this method on purpose.
 *
 * `POST` is the ordinary `405` (`Allow: GET` / `Allow: HEAD`, three `Vary` lines, the error limiter),
 * and the router already produces that one.
 */
const META = Object.freeze({
  path: "/meta/compatibility-dates",
  operationId: "GetMetaCompatibilityDates",
  versioned: false,
  /** `x-cache-age` in the pinned spec, and `max-age` on the wire. */
  cacheTtl: 600,
  rateLimitGroup: "meta",
  bodyKey: "compatibility_dates",
  /** Newest first on CCP; a one-surface replica has one entry. */
  ours: Object.freeze(["2020-01-01"]),
  sendsValidators: false,
  /** Observed on `HEAD`, and not reproduced: see the header. */
  headRefusalCarriesRouteHeaders: true,
});

// Localization

/**
 * `Content-Language`, on every 2XX from both producers.
 *
 * One value observed: a `curl` with no `Accept-Language` gets `en` from every endpoint surveyed. The
 * CORS preflight is the one response known *not* to carry it (see `PREFLIGHT.headers`).
 *
 *   curl -sD - https://esi.evetech.net/status/                            -> Content-Language: en
 *   curl -sD - https://esi.evetech.net/latest/universe/regions/10000002/  -> Content-Language: en
 *
 * What CCP answers a request asking for one of the other seven is **unobserved**: no probe was run with
 * an `Accept-Language`, so echoing `de` would reproduce a behaviour nobody has seen. This replica has
 * one language of data (D27).
 *
 * The request side is the spec's: `Accept-Language` is a shared parameter on all 197 operations, with an
 * enum of eight and a default of `en`, and `contract/spec.js` reads it from the pinned document. There is
 * no `language` **query** parameter on the `2020-01-01` surface: the spec declares none, and an undeclared
 * query parameter is ignored rather than refused (`IGNORES_UNKNOWN_QUERY_PARAMS`). That is all
 * "`?language=de` is accepted" means here.
 */
const CONTENT_LANGUAGE = "en";

// The two X-Esi stamps

/**
 * `X-Esi-Request-Id` and `X-Esi-Cache-Status`: present on the wire, values unobserved.
 *
 * Both are in the observed header sets above, so omitting them is visible in a header diff. Neither value
 * was captured. *That* the header is sent is an observation; *what it says* is a claim, marked so, as
 * `LIMITER_UNOBSERVED` marks the two limiter bodies nobody may provoke.
 *
 * `x-esi-request-id` is the application's stamp and the gateway sends none (observed, in the difference
 * between `APP_SUCCESS_HEADERS` and `GATEWAY_SUCCESS_HEADERS`). It is one value per response rather than
 * per representation, so it does not belong in `NOT_MODIFIED_SENDS`: a `304` carries an id because the
 * application answered, not because the `200` it stands in for carried one.
 *
 * `x-esi-cache-status` reports on CCP's own server-side cache, which the pinned spec describes per
 * operation: `x-server-cache-mode` is `ttl-based` or `event-based` and `x-server-cache-ttl` is its window.
 * So a replica can honour the meaning, and D28 records what this one derives it from.
 */
const INFRASTRUCTURE = Object.freeze({
  requestId: Object.freeze({
    header: "x-esi-request-id",
    /** Observed: the application stamps one, the gateway does not. */
    producers: Object.freeze(["app"]),
    /** Claimed, not observed: recorded as a UUID. */
    format: "uuid",
    formatObserved: false,
  }),
  cacheStatus: Object.freeze({
    header: "x-esi-cache-status",
    /** Observed: on the 2XX of both producers. */
    producers: Object.freeze(["gateway", "app"]),
    /** Claimed, not observed: recorded as the two values HIT and MISS. */
    values: Object.freeze(["HIT", "MISS"]),
    valuesObserved: false,
  }),
});

/**
 * Two headers observed on live ESI that this replica deliberately does not send.
 *
 * `strict-transport-security` is a promise about `https`, and D1 chose plain HTTP. Sending it would tell a
 * browser to refuse the scheme the replica is reachable on. It arrives with TLS (D14).
 *
 * `warning` is CCP's retired deprecation channel (`Warning: 199 - This endpoint is deprecated`), replaced
 * by `/meta/changelog`. Nothing this replica serves is deprecated.
 */
const NOT_SENT_BY_CHOICE = Object.freeze({
  "strict-transport-security": "D1 serves plain HTTP; an HSTS promise would break the only scheme we answer on (D14)",
  warning: "CCP's retired 199 deprecation channel; no route of ours is deprecated",
});

// Header casing

/**
 * Response header names in CCP's casing, where it is not the obvious spelling.
 *
 * `Etag` is the one that matters and the one the spec gets wrong. HTTP header names are case-insensitive,
 * but some incorrect clients string-compare, and those are worth matching.
 */
const HEADER_CASE = Object.freeze({
  etag: "Etag",
  "x-pages": "X-Pages",
  "x-compatibility-date": "X-Compatibility-Date",
  "x-esi-error-limit-remain": "X-Esi-Error-Limit-Remain",
  "x-esi-error-limit-reset": "X-Esi-Error-Limit-Reset",
  "x-ratelimit-group": "X-Ratelimit-Group",
  "x-ratelimit-limit": "X-Ratelimit-Limit",
  "x-ratelimit-remaining": "X-Ratelimit-Remaining",
  "x-ratelimit-used": "X-Ratelimit-Used",
  "x-content-type-options": "X-Content-Type-Options",
  "x-esi-cache-status": "X-Esi-Cache-Status",
  "x-esi-request-id": "X-Esi-Request-Id",
});

// Error shapes

/**
 * ESI has three error shapes, and which one a request gets is a property of **the route**, not of the
 * failure.
 *
 * The `2020-01-01` surface is two implementations behind one hostname, and they disagree about the status
 * code for the same mistake, the body shape, and the `content-type`. Observed 2026-08-21:
 *
 *   GET /latest/universe/systems/abc/       400  {"error":"failed to coerce ..."}
 *   GET /latest/characters/abc/             422  {"status":422,"error":"validation failed","details":[...]}
 *   GET /latest/corporations/abc/           422  ... same
 *   GET /latest/alliances/abc/              422  ... same
 *   GET /latest/universe/stations/abc/      400  ... coercion again
 *
 *   GET /latest/universe/regions/99999999/  404  {"error":"Region not found"}
 *   GET /latest/characters/0/               404  {"status":404,"error":"Not Found"}
 *
 * So the entity routes have been migrated to a newer validator and the universe and static routes have not.
 * Our 35 endpoints straddle the line, so a route table carries its error family as it carries its cache
 * TTL. Both `400` and `422` live on the legacy surface, per route.
 */
/**
 * A route belongs to **one** implementation, and that implementation decides everything about it.
 *
 * Established 2026-08-22 by fetching a success *and* a refusal from the same route, six times. Every pair
 * agrees:
 *
 *   GET /alliances/99000001/        200  application/json                 ...}\n
 *   GET /alliances/99999999/        404  application/json                 {"status":404,"error":"Not Found"}\n
 *   GET /characters/{character_id}/ 200  application/json                 ...}\n
 *   GET /characters/abc/            422  application/json                 {"status":422,...}\n
 *   GET /corporations/98000001/     200  application/json                 ...}\n
 *   GET /corporations/abc/          422  application/json                 {"status":422,...}\n
 *   GET /universe/systems/30000142/ 200  application/json; charset=UTF-8  ...}
 *   GET /universe/systems/abc/      400  application/json; charset=UTF-8  {"error":"failed to coerce ..."}
 *   GET /universe/regions/10000002/ 200  application/json; charset=UTF-8  ...}
 *   GET /universe/regions/99999999/ 404  application/json; charset=UTF-8  {"error":"Region not found"}
 *   GET /contracts/public/10000002/ 200  application/json; charset=UTF-8  ...]
 *   GET /contracts/public/...?page=0  400  application/json; charset=UTF-8  {"error":"0 does not meet ..."}
 *
 * The `/characters/` success was fetched against a real character whose id is deliberately not recorded, so
 * that row carries a placeholder segment. The pair exists for a `200` and a `422` off the same route.
 *
 * So `ERROR_FAMILY` is **not** an independent dimension of a route: `LEGACY` is what the application's errors
 * look like and `VALIDATED` is what the gateway's look like, and which one a route gets follows from
 * `SUCCESS_KIND`.
 *
 * Do not read a path and the path plus an id as one route: the collection `/alliances/` is the application,
 * and `/alliances/{alliance_id}/` is the gateway on both halves.
 *
 * `EDGE` is the exception: those refusals happen before a route is resolved, so they belong to no route.
 */
const ERROR_FAMILY = Object.freeze({
  /** Universe and static routes. Bare `{error}`, and a charset parameter. */
  LEGACY: "legacy",
  /** Character, corporation and alliance routes. `{status, error, details?}`. */
  VALIDATED: "validated",
  /** Refusals made before a route is reached: 401, `Invalid tenant`. */
  EDGE: "edge",
});

/**
 * The `content-type`, `nosniff` and trailing-newline behaviour of each family.
 *
 * The edge is the only one that sends `nosniff`, consistent with being the same producer as the gateway 2XX
 * path.
 *
 * `trailingNewline` follows from which implementation writes the body, so it agrees with `contentType` on
 * every row. The legacy family is the application, and neither sends a newline; the validated and edge families
 * are Go, and both do. This is why the 401 is 45 bytes and not the 44 its JSON text weighs.
 */
const ERROR_SHAPE = Object.freeze({
  [ERROR_FAMILY.LEGACY]: Object.freeze({
    contentType: CONTENT_TYPE[KIND.APP_ERROR],
    nosniff: false,
    trailingNewline: TRAILING_NEWLINE[KIND.APP_ERROR],
    // Bare: `error` and nothing else. No `status`, no `details`.
    keys: Object.freeze(["error"]),
    coercionStatus: 400,
    notFoundStatus: 404,
  }),
  [ERROR_FAMILY.VALIDATED]: Object.freeze({
    contentType: CONTENT_TYPE[KIND.GATEWAY_ERROR],
    nosniff: false,
    trailingNewline: TRAILING_NEWLINE[KIND.GATEWAY_ERROR],
    // `status` first on the wire, then `error`, then `details` when present.
    keys: Object.freeze(["status", "error", "details"]),
    coercionStatus: 422,
    notFoundStatus: 404,
  }),
  [ERROR_FAMILY.EDGE]: Object.freeze({
    contentType: CONTENT_TYPE[KIND.GATEWAY_ERROR],
    nosniff: true,
    trailingNewline: TRAILING_NEWLINE[KIND.GATEWAY_ERROR],
    keys: Object.freeze(["error"]),
    coercionStatus: null,
    notFoundStatus: null,
  }),
});

/**
 * Bodies as exact bytes, because key order is part of the contract and each status code has a test asserting
 * the exact body.
 *
 *   curl -s https://esi.evetech.net/latest/characters/999999999999/
 *   curl -s https://esi.evetech.net/latest/universe/systems/abc/
 *   curl -s https://esi.evetech.net/latest/universe/regions/99999999/
 *   curl -s https://esi.evetech.net/latest/characters/0/
 *
 * These are the JSON **text** (what a client parses) and deliberately omit the producer's trailing newline,
 * which is a property of the family. The bytes on the wire are this text plus
 * `ERROR_SHAPE[family].trailingNewline`, and `test/errors.test.js` asserts both halves.
 */
const ERROR_BYTES = Object.freeze({
  unauthorizedNoToken: '{"error":"Unauthorized - No token provided"}',
  // The other 401: this one is sent for *any* non-blank `Authorization`, the other only for an absent one. See
  // `BEARER`.
  unauthorizedInvalidToken: '{"error":"Unauthorized - Invalid token"}',
  invalidTenant: '{"error":"Invalid tenant"}',
  legacyNotFound: '{"error":"Region not found"}',
  legacyCoercion:
    '{"error":"failed to coerce value ' + "'abc'" + ' into type integer (format: int32), '
    + "'system_id'" + ' is required"}',
  validatedNotFound: '{"status":404,"error":"Not Found"}',
  validatedInvalidInteger:
    '{"status":422,"error":"validation failed","details":'
    + '[{"message":"invalid integer","location":"path.character_id","value":"abc"}]}',
  validatedOutOfRange:
    '{"status":422,"error":"validation failed","details":'
    + '[{"message":"invalid character ID","location":"path.character_id","value":999999999999}]}',
});

/**
 * A validated route's 404 says `Not Found` and names nothing; a legacy route's names the entity (`System not
 * found`, `Region not found`, lowercase `not`). The template is here so an endpoint need not guess the wording.
 */
const LEGACY_NOT_FOUND = (entity) => `${entity} not found`;

/**
 * `details[].location` is `path.<name>` or `query.<name>`, and `value` is the
 * offending value **with its original JSON type**: the string `"abc"` when the
 * parameter was unparseable, the number `999999999999` when it parsed and was
 * out of range.  A validator that stringified everything would be visibly
 * wrong to a client reading `details`.
 */
const DETAIL_LOCATION = (where, name) => `${where}.${name}`;

/**
 * Whether a query parameter is validated: only when the route uses it.
 *
 * `?bogus=1` is ignored everywhere, and so is `?page=abc` on a route that does not paginate:
 * `/universe/system_kills/?page=abc` and `/status/?page=abc` are both **200**. On a route that *does* paginate,
 * the same value is a `400` with a message naming it:
 *
 *   GET /latest/universe/system_kills/?page=abc      200
 *   GET /latest/contracts/public/10000002/?page=abc  400 {"error":"failed to coerce value 'abc' ..."}
 *
 * The rule (settled 2026-08-22) is that a parameter the route does not declare does not exist. A paginated route validates `page` and nothing else validates
 * anything.
 */
const VALIDATES_DECLARED_QUERY_PARAMS = true;
const VALIDATES_UNDECLARED_QUERY_PARAMS = false;

// Pagination

/**
 * Offset pagination, as observed on the two public paginated routes.
 *
 *   curl -sD - 'https://esi.evetech.net/latest/contracts/public/10000002/?page=2'
 *   curl -sD - 'https://esi.evetech.net/latest/markets/10000002/orders/'
 *
 * `X-Pages` is on every response from a paginated route, **including one whose whole
 * result is a single page**: region 10000070's contracts answer `X-Pages: 1`. A client
 * cannot distinguish "not paginated" from "one page" by absence.
 *
 * Every page of one resource shares one `Last-Modified` and carries its **own** `Etag`:
 * the etag identifies the page, the `Last-Modified` the snapshot. `market-hub-seed`
 * hard-fails a run when the second differs between pages.
 *
 * Both paginated routes are the application producer. No publicly reachable gateway
 * route paginates, so the gateway's pagination behaviour is unobserved.
 */
const PAGINATION = Object.freeze({
  parameter: "page",
  /** int32, minimum 1. The spec declares the same, and CCP enforces it. */
  minimum: 1,
  /** Items per page, on both routes observed. 34 pages x 1000, last page 168. */
  pageSize: 1000,
  /** Sent even when there is exactly one page. */
  alwaysSent: true,
  /** Missing `?page` is page 1, not an unpaginated whole-collection response. */
  defaultsToFirstPage: true,
  /** One per page. Two pages of one resource never share an etag. */
  etagPerPage: true,
  /** One per resource. Every page of a sweep agrees. */
  lastModifiedPerResource: true,
});

/**
 * What CCP answers for a `page` it will not serve, byte for byte.
 *
 * All four are the application's error shape (bare `{error}`, `charset=UTF-8`, no
 * trailing newline), because both paginated routes are application routes.
 *
 * A page beyond `X-Pages` is a `404` with a body, not an empty array, so a client
 * expecting `[]` gets an object.
 *
 * The coercion message is **not** the one a path parameter gets. A bad path parameter
 * is `... (format: int32), 'system_id' is required`; a bad `page` stops at the format
 * and names nothing. `lib/errors.js` handles both.
 *
 *   ?page=35    404  {"error":"Requested page does not exist!"}
 *   ?page=0     400  {"error":"0 does not meet minimum of 1"}
 *   ?page=-1    400  {"error":"-1 does not meet minimum of 1"}
 *   ?page=abc   400  {"error":"failed to coerce value 'abc' into type integer (format: int32)"}
 *   ?page=1.5   400  the same, with '1.5': a non-integer is a coercion failure
 *   ?page=2147483648  400  the same: one past int32 never became an integer
 *
 * What counts as an integer is a **strict decimal parse**, not what `Number()` accepts.
 * Two forms JavaScript would reject are fine and three it would accept are not:
 *
 *   ?page=+1    200   a leading plus
 *   ?page=01    200   leading zeros
 *   ?page=1e3   400   Number("1e3") is 1000
 *   ?page=0x2   400   Number("0x2") is 2
 *   ?page=%20   400   Number(" ") is 0, which would have produced the *minimum*
 *                     message rather than the coercion one
 *
 * A repeated `?page=1&page=2` is refused with the value rendered as a Python list:
 * `failed to coerce value '['1', '2']' into type integer (format: int32)`.
 */
const PAGINATION_ERRORS = Object.freeze({
  beyondLastPage: Object.freeze({
    status: 404,
    body: '{"error":"Requested page does not exist!"}',
  }),
  belowMinimum: Object.freeze({
    status: 400,
    template: (value) => `${value} does not meet minimum of 1`,
  }),
  notAnInteger: Object.freeze({
    status: 400,
    template: (value, format = "int32") =>
      `failed to coerce value '${value}' into type integer (format: ${format})`,
  }),
});

// Byte-exact responses

/**
 * `GET /ping`: 2 bytes, no trailing newline, and no CORS, cache, rate-limit or
 * compatibility headers whatsoever. It is outside the normal pipeline, so it is a
 * special case rather than a route the framework decorates.
 */
const PING = Object.freeze({
  status: 200,
  contentType: CONTENT_TYPE[KIND.PING],
  body: "ok",
});

/**
 * An unrouted path: Go's `http.NotFound`, 19 bytes including the newline.
 *
 * Reached both by a path with no route (`/nope/`) and by an unknown version prefix
 * (`/v99/status/`), so the router's version dimension falls through to this, not to a
 * JSON 404.
 */
const UNROUTED_404 = Object.freeze({
  status: 404,
  contentType: CONTENT_TYPE[KIND.UNROUTED],
  body: "404 page not found\n",
});

/**
 * Error bodies as literal strings.  Half the client libraries read `body.error`
 * unconditionally on any status at or above 400, and some match these exactly.
 */
const ERROR_BODY = Object.freeze({
  noToken: "Unauthorized - No token provided",
  invalidToken: "Unauthorized - Invalid token",
  invalidTenant: "Invalid tenant",
});

// Routing

/**
 * The version prefixes that resolve, all to the same `2020-01-01` handler.
 *
 * Nine: three names and six numbers. The boundary is exact: `/v6/` resolves and `/v7/`
 * does not.
 *
 *   /latest/status/  /legacy/status/  /dev/status/  /v1/ .. /v6/   -> 200
 *   /v7/status/  /v99/status/                                      -> 404, and see UNROUTED_404
 *
 * A prefix is also **optional**: `/status/` and `/universe/systems/30000142/` both answer
 * 200 bare, which is why the pinned spec describes paths with no prefix. So is the
 * trailing slash: `/latest/status` and `/latest/status/` are the same route.
 */
const VERSION_PREFIXES = Object.freeze(["latest", "legacy", "dev", "v1", "v2", "v3", "v4", "v5", "v6"]);

/**
 * Paths that exist *only* unprefixed. `/latest/ping` is a 404 and so is
 * `/latest/meta/compatibility-dates`. Both were checked:
 *
 *   curl -so /dev/null -w '%{http_code}' https://esi.evetech.net/latest/ping
 *   curl -so /dev/null -w '%{http_code}' https://esi.evetech.net/latest/meta/compatibility-dates
 *
 * For `/ping` it is consistent with being outside every pipeline; the `/meta/` surface
 * is inside the pipeline and unversioned anyway, sensible for a route that says which
 * versions there are.
 */
const UNVERSIONED_PATHS = Object.freeze(["/ping", "/meta/compatibility-dates"]);

// Caching

/**
 * `Cache-Control`, per producer, as a function of the route's published TTL.
 *
 * The third thing that splits by producer, after the `content-type` and the trailing
 * newline:
 *
 *   GET /latest/status/                     public, max-age=30, must-revalidate, stale-if-error=900
 *   GET /latest/sovereignty/map/            public, max-age=3600, must-revalidate, stale-if-error=900
 *   GET /latest/universe/regions/10000002/  public
 *   GET /latest/incursions/                 public
 *
 * The application sends a bare `public` and **no `max-age` at all**, so a client on those
 * routes has only `Expires` to sleep on: on half this surface it is the only freshness
 * signal.
 *
 * `stale-if-error=900` is constant on every gateway response observed, across TTLs of 30,
 * 300 and 3600.
 */
const CACHE_CONTROL = Object.freeze({
  [KIND.GATEWAY_SUCCESS]: (ttlSeconds) =>
    `public, max-age=${ttlSeconds}, must-revalidate, stale-if-error=900`,
  [KIND.APP_SUCCESS]: () => "public",
  // A third form, and why the meta surface is a producer rather than a route on the
  // gateway: `max-age` and nothing else.
  //
  //   curl -sD - https://esi.evetech.net/meta/compatibility-dates
  //   curl -sD - https://esi.evetech.net/meta/openapi.json
  //     Cache-Control: public, max-age=600      (both, ttl 600 from x-cache-age)
  [KIND.META_SUCCESS]: (ttlSeconds) => `public, max-age=${ttlSeconds}`,
});

/**
 * The fourth form, which is not a function of the producer.
 *
 * An **authenticated** route sends `private` where the same producer sends `public` on a
 * public one. Observed 2026-08-25 on all three of `/characters/{id}/online|location|ship/`,
 * each an `APP_SUCCESS` that `CACHE_CONTROL` above would have spelled `public`:
 *
 *   Cache-Control: private
 *   Expires: <date + x-cache-age>
 *   Etag: "<56 hex>"          Last-Modified: <date>
 *
 * The missing dimension is *whether the route requires a credential*, not which
 * implementation answered.
 *
 * Hazard: `public` on a route answering with one pilot's location invites a shared cache to
 * store it and hand it to the next pilot who asks. This header is the only thing that stops
 * that.
 *
 * Everything else stays the producer's: `Expires` measured from `Last-Modified`, the strong
 * sha224 `Etag`, the cache status, the conditional-request rules. Only this header moves.
 *
 * Unobserved and deliberately absent: what a *gateway*-producer authenticated route sends.
 * There is no such route on the surface this replica reproduces.
 */
const AUTHENTICATED_CACHE_CONTROL = "private";

/**
 * The three character reads, observed 2026-08-25.
 *
 * A real application, a real character, a token carrying all three scopes, and one `GET`
 * each. `scripts/observe-403.js --success` is the run.
 *
 * **The values are deliberately not here**: the bodies say where a pilot was docked and what
 * their ship is called, and nothing under `contract/` is anyone's character data. What is
 * recorded is the protocol and not the payload (D23). The same rule makes all three **exempt**
 * from a golden recording; see `contract/golden/`.
 *
 * The shapes, with the values replaced:
 *
 *   /online/    {"last_login":<ts>,"last_logout":<ts>,"logins":<n>,"online":<bool>}
 *   /location/  {"solar_system_id":<id>,"station_id":<id>}
 *   /ship/      {"ship_item_id":<id>,"ship_name":<str>,"ship_type_id":<id>}
 *
 * Field order is alphabetical, and order is bytes
 *
 * On all three. It happens to match the pinned spec's declaration order, but the spec's key
 * order is not evidence and this is.
 *
 * `structure_id` is omitted, not null
 *
 * The captured pilot was docked in a station, so `station_id` was present and `structure_id`
 * was **absent from the body entirely**. Neither serializes as null or 0: `contract/spec.js`'s
 * validator refuses `null` anywhere because the pinned document declares nothing nullable, and
 * eve-nexum never reads either field. Omit.
 *
 * No `Content-Length` is recorded: unlike the two `401` bodies, which are fixed strings and
 * fixed lengths, these vary with the pilot, so it is not a protocol constant.
 *
 * The two fields this replica cannot send
 *
 * CCP sends all four `/online/` fields. eve.js has no source for **`last_login`** or **`logins`**:
 * nothing in the vendor tree persists a login timestamp (upstream's corp-member view synthesises
 * one as "now, if they're online") and no login counter exists.
 *
 * Both are optional in the spec, so they are omitted rather than invented, a real divergence:
 * this replica answers `/online/` with two of CCP's four fields. It is safe for the first consumer
 * incidentally: eve-nexum's staleness heuristic reads `if (!last_login || !last_logout) return true`,
 * so an absent pair is treated as "trust `online`", and the toolbar tooltip that would display
 * `last_login` renders nothing. A second consumer may differ.
 *
 * `last_logout` **is** available, as `logoffDate` on the character record: a Windows FILETIME decimal
 * string that needs converting, which eve.js seeds to the character's creation time rather than
 * leaving unset. A character who has never logged out reports a plausible-looking wrong answer.
 */
const CHARACTER_LOCATION = Object.freeze({
  /** Alphabetical, on all three, and order is bytes. */
  fieldOrder: Object.freeze({
    online: Object.freeze(["last_login", "last_logout", "logins", "online"]),
    location: Object.freeze(["solar_system_id", "station_id", "structure_id"]),
    ship: Object.freeze(["ship_item_id", "ship_name", "ship_type_id"]),
  }),

  /** Absent from the body, never `null` and never `0`. */
  omitsAbsentOptionalFields: true,

  /**
   * Fields eve.js cannot supply, and which this replica therefore omits.
   * Optional in the spec, present on the real thing.
   */
  unavailableFromGame: Object.freeze(["last_login", "logins"]),

  /** `x-cache-age`, and the `Expires` offsets confirm them. */
  cacheTtlSeconds: Object.freeze({ online: 60, location: 5, ship: 5 }),

  /** One bucket for all three, and a 200 costs 2. */
  rateLimitGroup: "char-location",
});

/**
 * What `Expires` is measured from, and the two producers disagree.
 *
 *   gateway:  Expires = Date + ttl            a full window from *now*
 *   app:      Expires = Last-Modified + ttl   a window anchored to the data
 *
 * Observed, with the arithmetic exact in every sample:
 *
 *   /status/          date 10:31:35  expires 10:32:05  ttl 30    (date + 30)
 *   /sovereignty/map/ date 10:31:35  expires 11:31:35  ttl 3600  (date + 3600)
 *   /incursions/      lm   10:30:16  expires 10:35:16  ttl 300   (lm + 300)
 *   /markets/prices/  lm   09:48:01  expires 10:48:01  ttl 3600  (lm + 3600)
 *   /wars/            lm   09:52:38  expires 10:52:38  ttl 3600  (lm + 3600)
 *
 * Any polling client sees the difference: a gateway route always promises a full TTL ahead, while
 * an application route's window shrinks as it ages and can already be expired when served. Computing
 * both the same way changes how often every polling client comes back.
 */
const EXPIRES_BASIS = Object.freeze({
  [KIND.GATEWAY_SUCCESS]: "date",
  [KIND.APP_SUCCESS]: "lastModified",
  // date 18:51:19, expires 19:01:19, ttl 600. It has no `Last-Modified`, so `date` is the only
  // available basis as well as the observed one.
  [KIND.META_SUCCESS]: "date",
});

/**
 * How each producer builds its `Etag`: a different digest **and** a different strength.
 *
 *   gateway:  W/"<64 hex>"   weak, SHA-256
 *   app:      "<56 hex>"     strong, SHA-224
 *
 * 56 hex is 224 bits. Both are visible to a client: the `W/` prefix decides whether a cache may use
 * the response for a byte-range request, and the length is the first thing an `If-None-Match`
 * comparison sees.
 *
 * A third form is not modelled here. The static-data-backed application routes (`/universe/regions/`,
 * `/universe/types/`, `/universe/categories/`, and `/fw/wars/`) all answer with the *same* weak SHA-224
 * etag, the same `Last-Modified` and the same `Expires`, because they are one snapshot of one dump:
 *
 *   Etag:          W/"bff97004d7099f7880d1ba8339448fb84533dc1b4eb1d4271321cd11"
 *   Last-Modified: Thu, 20 Aug 2026 11:05:14 GMT
 *   Expires:       Sat, 22 Aug 2026 11:05:00 GMT
 *
 * That is a property of the *dataset*, not of the producer. `STATIC_DATA` below carries the
 * observations, `lib/staticSnapshot.js` reproduces the mechanism, and D43 is the decision. A replica
 * giving each static route its own etag is distinguishable from CCP by a client fetching two of them.
 */
const ETAG = Object.freeze({
  [KIND.GATEWAY_SUCCESS]: Object.freeze({ algorithm: "sha256", weak: true }),
  [KIND.APP_SUCCESS]: Object.freeze({ algorithm: "sha224", weak: false }),
  // `null`, not an omission: the meta surface sends no `Etag` and no `Last-Modified`, so there is no
  // digest to describe and no conditional request can succeed against it. The pinned spec declares both
  // headers on these operations and CCP sends neither (D23).
  [KIND.META_SUCCESS]: null,
});

/**
 * Which responses carry cache headers at all: the two success kinds, and nothing else.
 *
 * A `401`, a `422` and `GET /ping` carry no `Cache-Control`, no `Expires`, no `Etag` and no
 * `Last-Modified`. The one exception observed is an application `404`, which carries the static-data
 * etag and nothing else:
 *
 *   GET /latest/universe/regions/99999999/
 *   404  Etag: W/"bff97004..."     and no Cache-Control, Expires or Last-Modified
 *
 * The static snapshot's etag leaks onto a refusal from a static-backed route. `lib/router.js`
 * `staticEtagHeader` reproduces it, the only place a non-2XX gets a cache header (`lib/cache.js` never
 * sees one). Every other response: 2XX gets all four, everything else gets none.
 */
const SENDS_CACHE_HEADERS = Object.freeze({
  [KIND.GATEWAY_SUCCESS]: true,
  [KIND.GATEWAY_ERROR]: false,
  [KIND.APP_SUCCESS]: true,
  [KIND.APP_ERROR]: false,
  [KIND.UNROUTED]: false,
  // Two of the four: `Cache-Control` and `Expires`, never the validators.
  [KIND.META_SUCCESS]: true,
  [KIND.PING]: false,
});

/**
 * How each producer answers a conditional request: the fourth thing that splits, and neither half
 * follows RFC 9110 §13.1.2.
 *
 * The RFC says `If-None-Match` is a comma-separated list, that `*` matches any existing representation,
 * and that the comparison is weak, so `W/"x"` and `"x"` are the same validator. Between them the two
 * producers implement all three and neither implements more than one:
 *
 *                            gateway   application
 *   exact etag                 304        304
 *   `W/"x"` sent for `"x"`     304        200      weak comparison
 *   `If-None-Match: *`         200        304
 *   `"other", "ours"`          200        200      neither parses a list
 *   `If-Modified-Since`        304        200
 *   a validator that matches nothing     200        200
 *
 * Established 2026-08-22, three gateway routes and three application routes, each probe re-fetching the
 * current etag first so a rotated validator cannot be mistaken for a rule. `If-Modified-Since` on the
 * gateway is real date comparison: a date before `Last-Modified` is a 200.
 *
 * "Matched verbatim, including any `W/` prefix" is the application's rule and "`If-Modified-Since` is also
 * accepted" is the gateway's; no single route does both.
 */
const CONDITIONAL = Object.freeze({
  [KIND.GATEWAY_SUCCESS]: Object.freeze({
    star: false,
    list: false,
    weakComparison: true,
    ifModifiedSince: true,
  }),
  [KIND.APP_SUCCESS]: Object.freeze({
    star: true,
    list: false,
    weakComparison: false,
    ifModifiedSince: false,
  }),
});

/**
 * What a `304` carries, per producer.
 *
 * The gateway drops **both validators** (a client refreshing cache metadata from a `304` gets neither an
 * `Etag` nor a `Last-Modified`) and keeps its full `Cache-Control`, `max-age` included. The application
 * keeps both validators and sends the same bare `public` it sends on a `200`.
 *
 * `Expires` is recomputed rather than echoed on both, so it moves forward on every conditional request.
 * Neither carries `Content-Type` or `Content-Length`, and the body is empty.
 *
 *   curl -sD - -H 'If-None-Match: <etag>' https://esi.evetech.net/latest/sovereignty/map/
 *   curl -sD - -H 'If-None-Match: <etag>' https://esi.evetech.net/latest/universe/regions/10000002/
 *
 * The application's bare `public` is not `Cache-Control` "collapsing on a 304, losing max-age": that
 * producer's `200` already sends bare `public`, and the producer that sends `max-age` still sends it on a
 * `304`.
 */
const NOT_MODIFIED_SENDS = Object.freeze({
  [KIND.GATEWAY_SUCCESS]: Object.freeze({
    cacheControl: true,
    expires: true,
    etag: false,
    lastModified: false,
    contentType: false,
    contentLength: false,
    // Added 2026-08-23. These are the router's headers, and the router runs inside the cache layer, so keeping
    // them on a `304` takes explicit work.
    //
    //   curl -sD - -H "If-None-Match: <etag>" https://esi.evetech.net/latest/status/
    //     Vary: X-Tenant / Accept-Language / X-Compatibility-Date
    //     X-Compatibility-Date: 2020-01-01
    //
    // A missing `Vary` on a `304` is a hazard: RFC 9110 has a `304` update the stored response's headers, so a
    // cache refreshing metadata from ours can drop the variance key and start serving one tenant's body to
    // another.
    vary: true,
    compatibilityDate: true,
    // Added 2026-08-24. It is the negotiated representation rather than a framing header, which is why it
    // survives where `Content-Type` does not:
    //
    //   curl -sD - -H "If-None-Match: W/\"9d9851f6...\"" https://esi.evetech.net/latest/status/
    //     304, Cache-Control: public, max-age=30, must-revalidate, stale-if-error=900
    //     Content-Language: en
    contentLanguage: true,
    // No `xPages` row: no publicly reachable gateway route paginates, so no request could answer the question.
    // See the app row.
  }),
  [KIND.APP_SUCCESS]: Object.freeze({
    cacheControl: true,
    expires: true,
    etag: true,
    lastModified: true,
    contentType: false,
    contentLength: false,
    // Same on this producer, and its `Vary` is its own four lines with `Accept-Language` repeated: the `304`
    // carries what the `200` carried:
    //
    //   curl -sD - -H "If-None-Match: <etag>" https://esi.evetech.net/latest/universe/factions/
    //     Vary: X-Tenant / Accept-Language / X-Compatibility-Date / Accept-Language
    //     X-Compatibility-Date: 2020-01-01
    vary: true,
    compatibilityDate: true,
    contentLanguage: true,
    /**
     * `X-Pages` survives a `304`, on both paginated routes.
     *
     * Added 2026-08-24, against Tranquility. The survey behind this table was taken on `/status/` and
     * `/universe/factions/`, neither of which paginates, so it could not answer this.
     *
     *   curl -sD - 'https://esi.evetech.net/latest/markets/10000002/orders/?order_type=all&page=1'
     *     200  Etag: "101f18df..."  Last-Modified: 21:10:31  X-Pages: 414
     *   curl -sD - -H 'If-None-Match: "101f18df..."' <the same url>
     *     304  Etag: "101f18df..."  Last-Modified: 21:10:31  X-Pages: 414
     *
     *   curl -sD - 'https://esi.evetech.net/latest/contracts/public/10000002/?page=1'
     *   curl -sD - -H 'If-None-Match: "22781c59..."' <the same url>
     *     304  X-Pages: 35
     *
     * RFC 9110 has a `304` update the stored response's headers: a client keeping the page count beside the
     * body (`market-hub-seed` does) refreshes it from here.
     */
    xPages: true,
  }),
});

/**
 * The application routes that do not follow the application's own rule.
 *
 * `/universe/regions/`, `/universe/types/`, `/universe/categories/`, `/fw/wars/`: the set that shares one
 * etag, one `Last-Modified` and one `Expires` because they are one snapshot of one static-data dump. On
 * those, a comma-separated list matches and a weak/strong flip matches, neither of which works on
 * `/incursions/`, `/alliances/` or `/markets/prices/`. They do still compare: an invented etag is a 200.
 *
 * Possibly a cache in front of them, but that is inference. A route declaring a `snapshot` gets these rules
 * and every other route keeps its producer's. It is load-bearing here because our static-data etag is weak:
 * a client storing `W/"x"` and sending `"x"` back, as RFC 9110 says to, would never see a `304` under the
 * application's strong comparison.
 */
const CONDITIONAL_STATIC_DATA_EXCEPTION = Object.freeze({
  paths: Object.freeze([
    "/universe/regions/:region_id",
    "/universe/types/:type_id",
    "/universe/categories/:category_id",
    "/fw/wars",
  ]),
  list: true,
  weakComparison: true,
});

/**
 * `405 Method Not Allowed`.
 *
 * The body is empty and there is no `content-type`, unlike every other refusal. `Allow` arrives as **separate
 * header lines**, like `Vary`, and their order is not stable between responses, so a test may assert the set
 * but never the order.
 *
 * `Allow` advertises `HEAD`, and `HEAD /status/` is itself a 405. A 405 answering a HEAD carries no `Allow`
 * header at all, while a 405 answering a POST does. Reproduced as observed (design constraint 3).
 *
 *   curl -sD - -X POST https://esi.evetech.net/status/   -> Allow: HEAD / Allow: GET
 *   curl -sI          https://esi.evetech.net/status/    -> 405, no Allow
 */
const METHOD_NOT_ALLOWED = Object.freeze({
  status: 405,
  // Sorted here; the wire order varies. Compare as a set.
  allow: Object.freeze(["GET", "HEAD"]),
  body: "",
  sendsAllowAnsweringHead: false,
});

// Rate limiting

/**
 * ESI runs two independent limiters, and a response carries **one of them and never both**.
 *
 * CCP's documentation says "headers on every response". The survey below disagrees: seventeen requests, both
 * producers, successes and refusals and two 304s, and every row carries exactly one family or none.
 *
 *   curl -sD - https://esi.evetech.net/status/                    -> X-Ratelimit-*, group status
 *   curl -sD - https://esi.evetech.net/latest/universe/factions/  -> X-Esi-Error-Limit-*
 *
 * The selector is **not** the producer. `/latest/incursions/` is an application success on the token bucket;
 * `/v3/alliances/{alliance_id}/` is a gateway success on the error limiter.
 *
 * The selector is the route's **published rate-limit group**. The pinned spec gives 135 of its 197 operations
 * an `x-rate-limit`, exactly the ones the token bucket answers for. The other 62, and every path that routes
 * nowhere, belong to the error limiter.
 *
 * So the error limiter is the **fallback** for requests with no bucket to charge, not a universal limiter
 * under the token bucket. That is why it answers an unrouted 404: no route, no group, nothing to take a token
 * from, only a counter keyed on the caller.
 *
 * `/ping` and the CORS preflight carry neither: the third state, `LIMITER.NONE`.
 */
const LIMITER = Object.freeze({
  TOKEN_BUCKET: "tokenBucket",
  ERROR_LIMIT: "errorLimit",
  NONE: "none",
});

/**
 * The survey the paragraph above stands on. Observed 2026-08-23, one `curl -sD -` per row, in this order: the
 * counters in `note` are only meaningful read top to bottom.
 *
 * Two rows probed a real entity whose id is deliberately not recorded, so those paths carry a placeholder
 * segment: the character the `401` was asked for, and the alliance behind the `200`. Neither turns on which
 * entity was named.
 *
 * The `errorLimit` rows give the decrement rule: `100 -> 99` across the unrouted 404, `99 -> 98` across the 400,
 * `98 -> 97` across the 404, and then `97` unchanged across a 200 and `99` unchanged across a 304. Errors cost,
 * successes and revalidations do not.
 *
 * The `tokenBucket` rows give the cost table: `Used: 2` on every 200, `Used: 1` on the 304, `Used: 5` on the 400,
 * the 401, the 422 and the 405.
 */
const LIMITER_SURVEY = Object.freeze([
  Object.freeze({ request: "GET /ping", status: 200, limiter: LIMITER.NONE, note: "outside every pipeline, as it is for CORS and caching" }),
  Object.freeze({ request: "OPTIONS /latest/status/ (preflight)", status: 204, limiter: LIMITER.NONE, note: "answered before routing; also true of an ungrouped route" }),
  Object.freeze({ request: "GET /status/", status: 200, limiter: LIMITER.TOKEN_BUCKET, note: "group status, 600/15m, Used: 2" }),
  Object.freeze({ request: "GET /latest/sovereignty/map/", status: 200, limiter: LIMITER.TOKEN_BUCKET, note: "gateway content-type, group sovereignty" }),
  Object.freeze({ request: "GET /latest/incursions/", status: 200, limiter: LIMITER.TOKEN_BUCKET, note: "application content-type, group incursion: the pair that rules the producer out" }),
  Object.freeze({ request: "GET /latest/route/30000142/30002187/", status: 200, limiter: LIMITER.TOKEN_BUCKET, note: "group routes, 3600/15m, Used: 2" }),
  Object.freeze({ request: "GET /latest/status/ + If-None-Match", status: 304, limiter: LIMITER.TOKEN_BUCKET, note: "Used: 1 (a revalidation costs, on this limiter)" }),
  Object.freeze({ request: "GET /latest/killmails/abc/abcdef/", status: 400, limiter: LIMITER.TOKEN_BUCKET, note: "group killmail, Used: 5" }),
  Object.freeze({ request: "GET /latest/killmails/1/abcdef/", status: 422, limiter: LIMITER.TOKEN_BUCKET, note: "Used: 5" }),
  Object.freeze({ request: "GET /latest/characters/{character_id}/location/", status: 401, limiter: LIMITER.TOKEN_BUCKET, note: "group char-location, Used: 5 (an unauthenticated call still charges the route bucket)" }),
  Object.freeze({ request: "GET /latest/status/ + Bearer garbage", status: 401, limiter: LIMITER.ERROR_LIMIT, note: "a presented-and-bad credential is refused in front of routing (the same route the token bucket owns above, on the other limiter); see BEARER" }),
  Object.freeze({ request: "HEAD /latest/status/", status: 405, limiter: LIMITER.TOKEN_BUCKET, note: "Used: 5; see METHOD_NOT_ALLOWED_LIMITER" }),
  Object.freeze({ request: "POST /latest/status/", status: 405, limiter: LIMITER.ERROR_LIMIT, note: "the same route, the other family; see METHOD_NOT_ALLOWED_LIMITER" }),
  Object.freeze({ request: "GET /nope/", status: 404, limiter: LIMITER.ERROR_LIMIT, note: "100 -> 99; no route, so no bucket" }),
  Object.freeze({ request: "GET /latest/universe/systems/abc/", status: 400, limiter: LIMITER.ERROR_LIMIT, note: "99 -> 98" }),
  Object.freeze({ request: "GET /latest/universe/systems/99/", status: 404, limiter: LIMITER.ERROR_LIMIT, note: "98 -> 97" }),
  Object.freeze({ request: "GET /v3/alliances/{alliance_id}/", status: 200, limiter: LIMITER.ERROR_LIMIT, note: "97 unchanged (a success does not cost)" }),
  Object.freeze({ request: "GET /latest/universe/factions/ + If-None-Match", status: 304, limiter: LIMITER.ERROR_LIMIT, note: "99 unchanged (a revalidation does not cost, on this limiter)" }),
]);

/**
 * The row the survey above does not have, and the capture that closed it.
 *
 * Every request in `LIMITER_SURVEY` was **unauthenticated**. CCP documents keying an authenticated caller on
 * `applicationID:characterID` instead, with the authenticated half winning where both exist. This block describes
 * the capture; `LIMITER_KEY` and `LIMITER_KEY_SURVEY` below are the result, which is not the documented rule.
 *
 * The notes below are why the run is readable: each is a way the capture could have produced a wrong answer.
 *
 * `scripts/observe-limiter-key.js` is the capture, shaped by three facts about the surface:
 *
 *   - The pairing must differ in **exactly one dimension**. Both halves go to the same path from the same address
 *     inside the same window, and only the `Authorization` header changes. A route answering `401` unauthenticated
 *     and `200` authenticated would change the status class and the charge along with the credential.
 *   - The two limiters get **separate probes**. `/latest/universe/systems/99/` is on the error limiter in the survey
 *     above and `/latest/status/` is on the token bucket, so each answer is read off the limiter that owns it.
 *   - `X-Esi-Error-Limit-Reset` counts **down** inside a 60 second window, so a rollover between two readings makes
 *     them incomparable and looks like a second budget. Every reading is taken with its `Reset`, and a `Reset` that
 *     counted up voids the run.
 *
 * The application half needs a **second registered application** and the character half a **second character**,
 * because "which half of the key moves" shows only as a budget partitioning along one axis and not the other. Hence
 * a 2x2.
 *
 * A complete 2x2 says which half moves the budget, not what `applicationID` **is** on the wire. The client id from a
 * token's `azp` and a registered application's numeric id are different things, and a budget partitioning by
 * application partitions identically under either.
 */
const LIMITER_KEY_CAPTURE = Object.freeze({
  script: "scripts/observe-limiter-key.js",
  decision: "D39",
  issue: 65,
  // The two paths, and which limiter owns each. Both appear in LIMITER_SURVEY above, so their unauthenticated
  // behaviour is known and the authenticated request is the only new variable.
  errorLimitProbe: "GET /latest/universe/systems/99/",
  tokenBucketProbe: "GET /latest/status/",
  // Four credentials over two applications and two characters. Fewer cells
  // leave one axis unobserved; the classifier reports "inconclusive" rather
  // than choosing, and names the cell that would split what is left.
  cells: Object.freeze(["a1", "a2", "b1", "b2"]),
  // What the operator has to supply and nothing here can stand in for.
  requiresSecondApplication: true,
  requiresSecondCharacter: true,
  // What one full run costs on CCP's side, so the price is stated before the
  // run rather than discovered by it.
  errorUnitsSpent: 6,
  tokenBucketUnitsSpent: 12,
  // Run on 2026-08-25, one address, one 60 second window, all four cells held at once, with a single surviving
  // candidate on each limiter. `LIMITER_KEY` below is what it read; `LIMITER_KEY_SURVEY` is the thirteen requests.
  // The counters priced above are what it spent: 6 error units and 12 tokens on group `status`.
  observed: true,
});

/**
 * **The result of the capture.**
 *
 * `scripts/observe-limiter-key.js`, run 2026-08-25, one source address, one 60 second window, all four credentials
 * held at once: two registered applications, two characters, the full 2x2. Thirteen requests, transcribed row by
 * row in `LIMITER_KEY_SURVEY` below.
 *
 * **The two limiters key differently, and neither keys the way CCP documents.** That is why `limitersAgree` is a
 * field.
 *
 * The error limiter: the credential is not part of the key
 *
 * Seven readings of `X-Esi-Error-Limit-Remain` on `/latest/universe/systems/99/`, every one a `404`, every one from
 * the same address:
 *
 *   pre-flight (a `200`, free)   Remain 100   Reset 35
 *   unauthenticated 1            Remain  99   Reset 34
 *   unauthenticated 2            Remain  98   Reset 34
 *   application A, character 1   Remain  97   Reset 34
 *   application A, character 2   Remain  96   Reset 34
 *   application B, character 1   Remain  95   Reset 34
 *   application B, character 2   Remain  94   Reset 34
 *
 * One counter, six decrements, four credentials and no credential, and `Reset` counting **down** from 35 to 34 and
 * never up, so this is one window and the readings are comparable. Neither a `Bearer` token nor swapping either half
 * of the credential started a fresh budget.
 *
 * One reading rules out three candidate keys: `applicationAndCharacter`, `characterOnly` and `applicationOnly` all
 * predict that a credential never seen before arrives at a full budget and reads `99`. It read `97`. What survives is
 * the source address, regardless of credential, which is what `lib/errorLimiter.js` `keyFor` does.
 *
 * The token bucket: the application moves it, the character does not
 *
 * Six readings of `X-Ratelimit-Remaining` on `/latest/status/`, every one a `200`, group `status`, limit `600/15m`,
 * `Used: 2` on every row:
 *
 *   unauthenticated 1            Remaining 598
 *   unauthenticated 2            Remaining 596
 *   application A, character 1   Remaining 598
 *   application A, character 2   Remaining 596
 *   application B, character 1   Remaining 598
 *   application B, character 2   Remaining 596
 *
 * Three budgets. `598` then `596` is a bucket drawn down twice; a reading **higher** than the one before it, inside a
 * window nothing else could have refilled, is a different bucket. It happens twice, at the first cell of each
 * application.
 *
 * `sourceAddress` fails on the first authenticated row: it predicts `594`, the continuation of the unauthenticated
 * pair, and `598` came back. `applicationAndCharacter` and `characterOnly` both fail on the second: a key containing
 * the character half predicts that character 2 under application A is untouched and reads `598`, and it read `596`.
 * The two characters shared one bucket inside each application and the applications shared nothing, so one candidate
 * remains.
 *
 * The documented sentence is wrong twice
 *
 * `LIMITER_UNOBSERVED.errorLimitKey` carries CCP's rule, `"applicationID:characterID, else source IP"`. The error
 * limiter never consults the credential, so the first clause describes a mechanism that does not exist there. The
 * token bucket keys on the application half only, so the `:characterID` is not a narrowing this surface applies. The
 * observation wins, as in D31, where a guess was wrong in status, family, producer, content-type and last byte at
 * once. A guessed limiter key would be worse: a replica keying its own budgets by a rule it read agrees with itself and
 * no test here can catch it.
 *
 * The string stays verbatim because `test/errorLimiter.test.js` pins it, annotated as contradicted so the claim and the
 * reading sit together.
 *
 * What no run of this shape can say
 *
 * What `applicationID` **is** on the wire. The client id from the token's `azp` and the registered application's numeric
 * id are different things, and every reading above is produced by both spellings: the experiment measures the partition,
 * not the label. So `applicationIdSpelling` is `null`, and `LIMITER_UNOBSERVED.errorLimitKeyQuestions.whatApplicationIdIs`
 * stays `"unobserved"`.
 *
 * What this licenses
 *
 * Rekeying `lib/rateLimiter.js` on the application; the open spelling is no obstacle. Each registered application has
 * exactly one client id and one numeric id, so the two spellings induce the *same partition*. A replica keying on `azp`
 * puts the same requests in the same buckets as CCP whichever value CCP uses internally.
 *
 * Nothing about the error limiter, which needed no change: keying on the address unconditionally is CCP's behaviour.
 *
 * It does not license any claim about what `applicationID` *is*. Nothing here may be read as naming it.
 */
const LIMITER_KEY = Object.freeze({
  errorLimiter: Object.freeze({
    /** The probe, already in `LIMITER_SURVEY` unauthenticated at `98 -> 97`. */
    probe: "GET /latest/universe/systems/99/",
    key: "sourceAddress",
    credentialMovesTheBudget: false,
    sharedWithUnauthenticated: true,
    ruledOut: Object.freeze(["applicationAndCharacter", "characterOnly", "applicationOnly"]),
    /** One counter across all six errors, so one budget was seen and no more. */
    distinctBudgetsSeen: 1,
  }),
  tokenBucket: Object.freeze({
    /** The probe, already in `LIMITER_SURVEY` at group `status`, `Used: 2`. */
    probe: "GET /latest/status/",
    group: "status",
    limit: "600/15m",
    key: "applicationOnly",
    applicationMovesTheBudget: true,
    characterMovesTheBudget: false,
    sharedWithUnauthenticated: false,
    ruledOut: Object.freeze(["sourceAddress", "applicationAndCharacter", "characterOnly"]),
    /** Unauthenticated, application A, application B. Four cells, three buckets. */
    distinctBudgetsSeen: 3,
  }),
  /**
   * The two limiters key differently, so no answer about one is evidence about the other.
   */
  limitersAgree: false,
  /**
   * The documented rule this run contradicts, kept next to the contradiction.
   */
  contradicts: "applicationID:characterID, else source IP",
  /** Unobserved: `azp`'s client id and the registered numeric id partition identically. */
  applicationIdSpelling: null,
  script: "scripts/observe-limiter-key.js",
  decision: "D39",
  issue: 65,
  observedOn: "2026-08-25",
});

/**
 * The thirteen requests `LIMITER_KEY` stands on, in the order they were made.
 *
 * Same form as `LIMITER_SURVEY`: the counters in `note` are **only meaningful read top to bottom**, because the argument
 * is about which readings continue a sequence and which restart one.
 *
 * Credentials are named by their cell, never by identity. Which accounts they were is not a protocol fact, does not appear
 * in the recording the script wrote, and could not be reconstructed from these rows. The protocol fact is that the four
 * cells span two applications and two characters, crossed.
 *
 * The error-limiter rows carried no `X-Ratelimit-*` header at all and the token-bucket rows carried no
 * `X-Esi-Error-Limit-*`, so neither verdict could be read off the other limiter's headers.
 */
const LIMITER_KEY_SURVEY = Object.freeze([
  Object.freeze({ request: "GET /latest/universe/factions/ (unauthenticated)", status: 200, limiter: LIMITER.ERROR_LIMIT, note: "pre-flight: Remain 100, Reset 35. A 200 does not charge, so the budget is read for free before anything is spent" }),
  Object.freeze({ request: "GET /latest/universe/systems/99/ (unauthenticated)", status: 404, limiter: LIMITER.ERROR_LIMIT, note: "Remain 99, Reset 34" }),
  Object.freeze({ request: "GET /latest/universe/systems/99/ (unauthenticated)", status: 404, limiter: LIMITER.ERROR_LIMIT, note: "Remain 98, Reset 34" }),
  Object.freeze({ request: "GET /latest/universe/systems/99/ (application A, character 1)", status: 404, limiter: LIMITER.ERROR_LIMIT, note: "Remain 97, Reset 34. The whole verdict is on this row: a credential never seen before continued the unauthenticated counter instead of starting one, so every key containing any part of the credential predicted 99 and read 97" }),
  Object.freeze({ request: "GET /latest/universe/systems/99/ (application A, character 2)", status: 404, limiter: LIMITER.ERROR_LIMIT, note: "Remain 96, Reset 34. Swapping the character half changed nothing" }),
  Object.freeze({ request: "GET /latest/universe/systems/99/ (application B, character 1)", status: 404, limiter: LIMITER.ERROR_LIMIT, note: "Remain 95, Reset 34. Swapping the application half changed nothing either" }),
  Object.freeze({ request: "GET /latest/universe/systems/99/ (application B, character 2)", status: 404, limiter: LIMITER.ERROR_LIMIT, note: "Remain 94, Reset 34. One counter, six decrements, four credentials; Reset only ever counted down, so this is one window" }),
  Object.freeze({ request: "GET /latest/status/ (unauthenticated)", status: 200, limiter: LIMITER.TOKEN_BUCKET, note: "group status, 600/15m, Remaining 598, Used 2" }),
  Object.freeze({ request: "GET /latest/status/ (unauthenticated)", status: 200, limiter: LIMITER.TOKEN_BUCKET, note: "Remaining 596, Used 2. The unauthenticated bucket, drawn down twice" }),
  Object.freeze({ request: "GET /latest/status/ (application A, character 1)", status: 200, limiter: LIMITER.TOKEN_BUCKET, note: "Remaining 598, Used 2. Higher than the request before it left it, inside one window, which is a second bucket; sourceAddress predicted 594 and dies here" }),
  Object.freeze({ request: "GET /latest/status/ (application A, character 2)", status: 200, limiter: LIMITER.TOKEN_BUCKET, note: "Remaining 596, Used 2. A different character continued application A's bucket, so the character half does not move it; applicationAndCharacter and characterOnly both predicted 598 and die here" }),
  Object.freeze({ request: "GET /latest/status/ (application B, character 1)", status: 200, limiter: LIMITER.TOKEN_BUCKET, note: "Remaining 598, Used 2. A third bucket, so the application half does move it" }),
  Object.freeze({ request: "GET /latest/status/ (application B, character 2)", status: 200, limiter: LIMITER.TOKEN_BUCKET, note: "Remaining 596, Used 2. Application B's bucket continued the way A's did; three buckets over four cells, and no sharing with unauthenticated" }),
]);

/**
 * `X-Pages` on an **authenticated** collection that fits on one page.
 *
 * It is sent, and it is `1`. `/markets/prices` is a large public collection that sends no `X-Pages` at all, so omitting it
 * for a single-page body was a plausible reading until this run.
 *
 * Observed 2026-08-25 on both contact buckets, each with a one-page body.
 */
const AUTHENTICATED_PAGING = Object.freeze({
  sendsXPagesOnSinglePage: true,
  singlePageValue: "1",
});

/**
 * The three contact buckets, observed 2026-08-25 across two characters.
 *
 * Field order
 *
 * Alphabetical, as for the location family: `contact_id`, `contact_type`, `is_watched`, `standing`. `is_watched` is the
 * evidence: it is **optional and slots between `contact_type` and `standing`**, which alphabetical predicts and declaration
 * order in the pinned spec does not.
 *
 * It is **omitted when it does not apply**, never sent as `false`: on one character's 139 personal contacts, 35 rows carried
 * it and 104 did not. The same omit-rather-than-null rule as the location family, on a boolean.
 *
 * `label_ids` is declared optional by the pinned spec and appeared on **no row at all** across ~580 contacts in three
 * buckets. Not evidence that it never appears; evidence that omitting it is within observed behaviour.
 *
 * Page size is not 1000, and is not one number
 *
 * `PAGINATION.pageSize` is 1000, confirmed on `/markets/{region_id}/orders`. Contacts do not use it. The corporation bucket
 * returned **exactly 200 rows with `X-Pages: 2`**, a full page with more behind it, which fixes its page size at 200. The
 * alliance bucket returned **240 rows on `X-Pages: 1`**, so its page size is *at least* 240 and is therefore **not** 200.
 *
 * `route.pageSize` is per-route in `lib/router.js`, so this is expressible, but do not use the market constant. The alliance
 * and character sizes are lower bounds rather than values.
 *
 * Settling them needs one probe each against a bucket large enough to overflow: fetch the last page and count it.
 */
const CONTACTS = Object.freeze({
  fieldOrder: Object.freeze(["contact_id", "contact_type", "is_watched", "standing"]),
  /** Required on every row, in every bucket, on every observation. */
  required: Object.freeze(["contact_id", "contact_type", "standing"]),
  /** Present on some rows and absent on others, never `false` and never `null`. */
  omittedWhenAbsent: Object.freeze(["is_watched"]),
  /** Declared optional by the spec; seen on no row. */
  neverObserved: Object.freeze(["label_ids"]),
  /** `contact_type` values actually seen. `faction` is declared but unobserved. */
  contactTypesObserved: Object.freeze(["character", "corporation", "alliance"]),
  pageSize: Object.freeze({
    "/corporations/{corporation_id}/contacts": 200,
    "/alliances/{alliance_id}/contacts": null,
    "/characters/{character_id}/contacts": null,
  }),
  pageSizeLowerBound: Object.freeze({
    "/alliances/{alliance_id}/contacts": 240,
    "/characters/{character_id}/contacts": 139,
  }),
  rateLimitGroup: Object.freeze({
    "/characters/{character_id}/contacts": "char-social",
    "/corporations/{corporation_id}/contacts": "corp-social",
    "/alliances/{alliance_id}/contacts": "alliance-social",
  }),
});

/**
 * Reading a **corporation the caller is not a member of**: the refusal the router's `subject` check exists for.
 *
 * A `403`. A scoped route keyed by an entity refuses a caller with no claim on that entity with the application's `403`, not
 * a `404` hiding the entity's existence and not the `401` a missing scope earns (D31).
 *
 * Observed against an **NPC corporation** (a published SDE constant, so the probe names no player's corporation) with a token
 * holding `esi-corporations.read_contacts.v1`. It charges the route's own bucket, `corp-social`, at the usual refusal cost of 5.
 *
 * The message names the **relationship**, not the permission: "is not in the corporation" rather than "is not allowed". It is
 * corporation-shaped and cannot be reused for an alliance or a fleet; those refusals are unobserved.
 */
const CROSS_ENTITY_REFUSAL = Object.freeze({
  status: 403,
  body: "Character is not in the corporation",
  contentLength: 47,
  kind: KIND.APP_ERROR,
  contentType: CONTENT_TYPE[KIND.APP_ERROR],
  trailingNewline: false,
  sendsNosniff: false,
  vary: VARY,
  sendsContentLanguage: true,
  echoesCompatibilityDate: true,
  sendsCacheStatus: true,
  sendsRequestId: true,
  sendsCacheControl: false,
  limiter: LIMITER.TOKEN_BUCKET,
  rateLimitGroup: "corp-social",
  cost: 5,
  observedAgainst: "an NPC corporation, so no player entity is named",
});

/**
 * `GET /characters/{character_id}/roles/`.
 *
 * All four arrays are **present**, and an empty one is sent as `[]` rather than omitted, the opposite of the contacts rule on the
 * same capture and producer.
 *
 * On **both** characters observed, `roles` was **empty** while `roles_at_base`, `roles_at_hq` and `roles_at_other` were populated:
 * 7/9/7 on one and 2/2/2 on the other. A consumer gating on `roles[]` containing `Station_Manager` or `Director` sees the empty
 * array on two of two observations. Two characters is not a survey, but an empty `roles[]` is ordinary, so do not assume a pilot
 * with corporation authority presents it there.
 */
const CHARACTER_ROLES = Object.freeze({
  fieldOrder: Object.freeze(["roles", "roles_at_base", "roles_at_hq", "roles_at_other"]),
  emptyArrayIsSent: true,
  rateLimitGroup: "char-detail",
  rolesWasEmptyOnEveryObservation: true,
  observations: 2,
});

/**
 * `GET /characters/{character_id}/fleet/` for a pilot who is **not in a fleet**.
 *
 * This `404` is the *normal* answer: eve-nexum reads it as "this pilot is not in a fleet", and answering `200` with a null body, or
 * `500`, both break it. So the replica produces it deliberately.
 *
 * The application's refusal, on every signal. It charges the **token bucket** rather than the error limiter: group `fleet`, and
 * `Used: 5` like every other refusal on a route that has a bucket.
 *
 * The string reads as a **statement of fact about the pilot**, not a complaint about the request, which is how eve-nexum takes it:
 * "there is no fleet here", not "you asked wrong".
 */
const FLEET_ABSENT = Object.freeze({
  status: 404,
  body: "Character is not in a fleet",
  contentLength: 39,
  kind: KIND.APP_ERROR,
  contentType: CONTENT_TYPE[KIND.APP_ERROR],
  trailingNewline: false,
  sendsNosniff: false,
  vary: VARY,
  sendsContentLanguage: true,
  echoesCompatibilityDate: true,
  sendsCacheStatus: true,
  sendsRequestId: true,
  sendsCacheControl: false,
  limiter: LIMITER.TOKEN_BUCKET,
  rateLimitGroup: "fleet",
  cost: 5,
});

/**
 * `GET /corporations/{corporation_id}/structures/` for a character whose corporation role does not permit it.
 *
 * A **`403`**, distinct from both refusals D31 settled: a missing *scope* is a `401` naming the scope, a character mismatch is a
 * `403` naming the mismatch, and here the token is right, the scope is held, the caller is who they say, and the game says no. The
 * consumer reads it as `x-required-roles` and its sync reports `no_role` and stops.
 *
 * The one response in that authenticated run that sent the four-line `VARY_LOCALIZED_BODY`: see `VARY_LOCALIZED_SURVEY`.
 *
 * The `(s)` is CCP's, and it is bytes: 40 characters, not 39 and not "required roles".
 */
const REQUIRED_ROLE_REFUSAL = Object.freeze({
  status: 403,
  body: "Character does not have required role(s)",
  contentLength: 52,
  kind: KIND.APP_ERROR,
  contentType: CONTENT_TYPE[KIND.APP_ERROR],
  trailingNewline: false,
  sendsNosniff: false,
  vary: VARY_LOCALIZED_BODY,
  sendsContentLanguage: true,
  echoesCompatibilityDate: true,
  sendsCacheStatus: true,
  sendsRequestId: true,
  sendsCacheControl: false,
  limiter: LIMITER.TOKEN_BUCKET,
  rateLimitGroup: "corp-structure",
  cost: 5,
});

/**
 * `POST /ui/autopilot/waypoint/`: the one operation in this group whose wire behaviour is **entirely unobserved**.
 *
 * The `--write` probe in `scripts/observe-authed.js` has never been run, because it sets a real pilot's autopilot route in the real
 * game, and it is off by default for that reason. This row stops a reader assuming a `204` here looks like the `204` of CCP's CORS
 * preflight, which is a different producer, a different set of six headers, and no route behind it.
 *
 * The two known values come from the **pinned document**, not the wire: `204` is the only numeric status it declares on this
 * operation, and the only other response it declares is `default`. D34 turns on that absence: there is no refusal on this operation
 * to be faithful to.
 *
 * One run closes it, and also closes `SUCCESS_KIND`'s missing row:
 *
 *   node scripts/observe-authed.js --client-id <id> --write
 *
 * Read off: whether the `204` carries `Cache-Control`, `Etag` or `Last-Modified` (the document declares all three on it and CCP has
 * been seen declaring headers it does not send, D23), whether it carries `X-Esi-Request-Id` and `X-Esi-Cache-Status`, which of the
 * two limiters it charges and at what cost, and whether a `Content-Length: 0` appears where RFC 9110 says none should.
 */
const WAYPOINT_WRITE = Object.freeze({
  /** The document's, and the only numeric status it declares on this operation. */
  successStatus: 204,
  /** Not "none were observed": none are *declared*. See D34. */
  declaredErrorStatuses: Object.freeze([]),
  /**
   * Nothing below this line has been seen. `null` is "nobody has looked", the same spelling `CONTACTS.pageSize` uses for the two
   * buckets it could not measure, never "the header is absent", which is a claim a capture makes.
   */
  observed: false,
  kind: null,
  sendsCacheControl: null,
  sendsValidators: null,
  sendsRequestId: null,
  sendsCacheStatus: null,
  limiter: null,
  /** The document's `x-rate-limit` group, which is a publication and not a capture. */
  rateLimitGroup: "ui",
  probe: "node scripts/observe-authed.js --client-id <id> --write",
});

/**
 * A `405` picks its family by the **method it refused**.
 *
 *   curl -sI           https://esi.evetech.net/latest/status/  -> X-Ratelimit-*, Used: 5
 *   curl -sD - -X POST https://esi.evetech.net/latest/status/  -> X-Esi-Error-Limit-*
 *
 * `METHOD_NOT_ALLOWED` above records the other half: the POST refusal carries `Allow` and the HEAD refusal does not. The HEAD refusal
 * is made where the route is known and the POST refusal in front of it, so this is one quirk with two visible consequences.
 */
const METHOD_NOT_ALLOWED_LIMITER = Object.freeze({
  HEAD: LIMITER.TOKEN_BUCKET,
  OTHER: LIMITER.ERROR_LIMIT,
});

/**
 * The error limiter, as observed.
 *
 * `Reset` counts **down** inside the window rather than restating its length: 42, then 32, then 31 seconds across three requests, and
 * 56 at the start of the next window. A client reading it as "the window is 60 s" would back off for roughly twice as long as needed,
 * and eve-nexum reads it as a sleep duration.
 */
const ERROR_LIMIT = Object.freeze({
  headers: Object.freeze(["X-Esi-Error-Limit-Remain", "X-Esi-Error-Limit-Reset"]),
  maxErrors: 100,
  windowSeconds: 60,
  resetIsSecondsRemaining: true,
  // Statuses seen to decrement `Remain`, and statuses seen to leave it alone. `304` is in the second list on purpose: it is the one 3XX
  // this replica sends, and charging a revalidation would punish clients that cache correctly.
  charges: Object.freeze([400, 404, 405]),
  free: Object.freeze([200, 304]),
});

/**
 * The token bucket, as observed.
 *
 * `X-Ratelimit-Limit` is `<max-tokens>/<window-size>` with the window written the way the spec writes it: `600/15m`, not `600/900`. Both
 * halves come from the pinned spec's `x-rate-limit`, so a route's header restates its descriptor.
 */
const TOKEN_BUCKET = Object.freeze({
  headers: Object.freeze([
    "X-Ratelimit-Group",
    "X-Ratelimit-Limit",
    "X-Ratelimit-Remaining",
    "X-Ratelimit-Used",
  ]),
  windowSize: "15m",
  windowSeconds: 900,
  limit: (maxTokens, windowSize) => `${maxTokens}/${windowSize}`,
  // Tokens charged for the request that produced the response, keyed by status
  // class. Every entry was read off an `X-Ratelimit-Used` in the survey above.
  cost: Object.freeze({ 2: 2, 3: 1, 4: 5 }),
  // 32 groups in the pinned spec, on 135 of its 197 operations.
  groupCount: 32,
});

/**
 * The bearer credential, as observed on 2026-08-24.
 *
 * Two 401s
 *
 * CCP does not split on whether a *bearer credential* was presented. It splits on whether the
 * `Authorization` header was **there at all**:
 *
 *   (no Authorization header)          -> "Unauthorized - No token provided"
 *   Authorization;            (empty)  -> "Unauthorized - No token provided"
 *   Authorization:      (spaces only)  -> treated as absent; a public route 200s
 *   Authorization: Bearer garbage      -> "Unauthorized - Invalid token"
 *   Authorization: Bearer              -> "Unauthorized - Invalid token"
 *   Authorization: Basic dXNlcjpwdw==  -> "Unauthorized - Invalid token"
 *   Authorization: bearer xyz          -> "Unauthorized - Invalid token"
 *
 * So a `Basic` credential is an **invalid token**, not an absent one. `lib/bearerToken.js`'s
 * `fromHeader` returns `null` for "nothing was presented", which conflates the two cases, so the
 * body cannot be chosen from that `null` and the header itself must tell them apart (design constraint
 * 3). The value is trimmed before the emptiness test, which is why six spaces is "absent" and a bare
 * `Bearer`, whose token68 survives the trim, is not.
 *
 * Two positions, because the checks are made at different depths
 *
 * The invalid-token refusal carries no `Vary`, no `Content-Language` and no `X-Ratelimit-*`, and is
 * charged to the **error** limiter. The no-token refusal carries three `Vary` lines,
 * `Content-Language: en` and the resolved route's rate-limit group, and is charged to the **token
 * bucket** at the 4XX price of 5.
 *
 * A bad token beats every other refusal on the surface:
 *
 *   GET  /latest/nope/                                    -> 404
 *   GET  /latest/nope/              + Bearer garbage      -> 401 invalid token
 *   POST /latest/incursions/                              -> 405
 *   POST /latest/incursions/        + Bearer garbage      -> 401 invalid token
 *   GET  /latest/incursions/  + bad X-Compatibility-Date  -> 400
 *   GET  /latest/incursions/  + bad date + Bearer garbage -> 401 invalid token
 *   GET  /latest/status/?datasource=nope                  -> 400 Invalid tenant
 *   GET  /latest/status/?datasource=nope + Bearer garbage -> 401 invalid token
 *   GET  /                          + Bearer garbage      -> 401 invalid token
 *
 * while the no-token refusal loses to routing and to both pre-routing refusals:
 *
 *   GET /latest/nope/               (no header)           -> 404, not 401
 *   GET /latest/characters/{character_id}/location/?datasource=nope
 *                                   (no header)           -> 400, not 401
 *
 * **Verification happens before routing; the requirement is decided after it.** The verifier never
 * learns which route was asked for, which is why its refusal carries none of the three headers that
 * name one.
 *
 * One thing outranks the credential. A CORS **preflight** (`OPTIONS` carrying `Origin` and
 * `Access-Control-Request-Method`) is answered `204` with a bad token, on a secured route and on an
 * unrouted path, and it is free. `OPTIONS` with a bad token and no `Origin` is an ordinary 401, so the
 * preflight shape short-circuits, not the method. `PREFLIGHT` above records the 204 itself.
 *
 * What was checked
 *
 * 32 refusals across 12 rate-limit groups. The no-token form held on every secured route tried
 * (`char-wallet`, `char-detail`, `char-asset`, `char-social`, `char-location`, `corp-structure`, `ui`)
 * across GET, HEAD and POST, and on a route whose path parameter was itself malformed
 * (`/characters/abc/location/`, which is 401 rather than 400: coercion is below authentication too). The
 * invalid-token form was byte-identical on public routes, secured routes, `/meta/openapi.json` (a third
 * producer), `/v1/` and `/legacy/` prefixes, unrouted paths and the bare root.
 *
 * `X-Ratelimit-Used: 5` is the **cost of the request**, not a running total: the same route seconds apart
 * held `Used: 5` while `Remaining` walked 145 to 140. `TOKEN_BUCKET.cost` already says 5 for a 4XX.
 *
 *   curl -sD - https://esi.evetech.net/latest/characters/{character_id}/location/
 *   curl -sD - -H "Authorization: Bearer not-a-token" \
 *              https://esi.evetech.net/latest/characters/{character_id}/location/
 */
const BEARER = Object.freeze({
  /** The header, and the rule for reading it. */
  header: "Authorization",
  scheme: "Bearer",
  /**
   * **Not observed, and marked so.** `bearer xyz` is refused, but so it would be by a case-*sensitive*
   * server: an unknown scheme carrying garbage is an invalid token either way, so nothing in 32 tokenless
   * probes tells the two apart. `lib/bearerToken.js` accepts a lowercase scheme on RFC 7235 §2.1, which
   * says the scheme is case-insensitive: a spec fact, not a wire one. Closing curl, given a good token:
   *
   *   curl -sD - -H "Authorization: bearer <a token that works>" ...
   */
  schemeIsCaseInsensitive: null,
  schemeCaseFromRfc7235: true,
  /**
   * The value is trimmed, and an empty result counts as **no header at all**. Anything left over (any
   * scheme, any garbage) is a presented credential.
   */
  blankValueCountsAsAbsent: true,

  /**
   * Absent (or blank) `Authorization`, on a route that requires one.
   *
   * Decided *after* routing: it knows the route's rate-limit group, and an
   * unrouted path with no header is a 404 rather than this.
   */
  absent: Object.freeze({
    status: 401,
    body: ERROR_BODY.noToken,
    contentLength: 45,
    limiter: LIMITER.TOKEN_BUCKET,
    cost: 5,
    vary: VARY,
    sendsContentLanguage: true,
    sendsNosniff: true,
    echoesCompatibilityDate: false,
    sendsRequestId: false,
    sendsCacheHeaders: false,
  }),

  /**
   * A presented credential that does not verify: malformed, wrong scheme, or well-formed JWS with a bogus
   * signature. CCP does not distinguish them.
   *
   * Decided *before* routing: no `Vary`, no `Content-Language`, no rate-limit group, and it beats a 404, a
   * 405 and a bad compatibility date. It happens on **public** routes too.
   */
  presentedAndBad: Object.freeze({
    status: 401,
    body: ERROR_BODY.invalidToken,
    contentLength: 41,
    limiter: LIMITER.ERROR_LIMIT,
    vary: Object.freeze([]),
    sendsContentLanguage: false,
    sendsNosniff: true,
    echoesCompatibilityDate: false,
    sendsRequestId: false,
    sendsCacheHeaders: false,
    appliesToPublicRoutes: true,
    // Every other refusal this surface makes: the unrouted 404, the 405, the
    // bad-compatibility-date 400 and the bad-tenant 400.
    outranks: Object.freeze([404, 405, 400]),
    // ...and the requirement check loses to the last two, so the two bearer checks sit on opposite sides of
    // `tenant` and `compatibility`.
    absentCheckOutrankedBy: Object.freeze([400]),
  }),

  /**
   * Every header name observed on each 401, lowercased: the `GATEWAY_ERROR` counterpart to
   * `GATEWAY_SUCCESS_HEADERS`.
   */
  absentHeaders: Object.freeze([
    "access-control-allow-origin",
    "access-control-expose-headers",
    "connection",
    "content-language",
    "content-length",
    "content-type",
    "date",
    "strict-transport-security",
    "vary",
    "x-content-type-options",
    "x-ratelimit-group",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-used",
  ]),
  presentedAndBadHeaders: Object.freeze([
    "access-control-allow-origin",
    "access-control-expose-headers",
    "connection",
    "content-length",
    "content-type",
    "date",
    "strict-transport-security",
    "x-content-type-options",
    "x-esi-error-limit-remain",
    "x-esi-error-limit-reset",
  ]),

  /**
   * Never sent, on any 401, in 32 probes. Listed because a bearer surface omitting it is unusual enough to
   * look like an oversight.
   */
  sendsWwwAuthenticate: false,

  /** The preflight wins even over the credential.  See `PREFLIGHT`. */
  preflightOutranksCredential: true,

  /**
   * `HEAD` on a route that requires a credential is the **401**, not the `405`: the second consequence of
   * the quirk `METHOD_NOT_ALLOWED_LIMITER` records. The `HEAD` refusal is made where the route is known and
   * the `POST` refusal in front of it, so only the first can know the route needed a token. Byte-identical
   * to the `GET` refusal, down to the rate-limit group.
   *
   *   curl -sI           .../latest/characters/{character_id}/location/  -> 401, 45 bytes
   *   curl -sD - -X POST .../latest/characters/{character_id}/location/  -> 405, Allow: GET/HEAD
   */
  absentRefusesHead: true,
  absentLosesToMethodNotAllowed: Object.freeze(["POST", "PUT", "DELETE"]),

  /**
   * `/ping` is outside all of this, credential included. Observed, because `loader.js` answers it ahead of
   * every layer:
   *
   *   curl -H "Authorization: Bearer garbage" https://esi.evetech.net/ping
   *     200 ok
   */
  pingIsExempt: true,
});

/**
 * Authorisation refused, observed on 2026-08-24.
 *
 * `scripts/observe-403.js` makes this repeatable: a real application, a real character, a token holding
 * exactly one scope, and the two requests below.
 *
 * A missing scope is a `401`, not a `403`
 *
 * eve-nexum's source carries the comment `401 = token invalid/no scopes, 403 = token valid but scope
 * missing`, which is wrong, and so is any reading that expects `403`. A token that verifies and lacks the route's scope is refused `401`, with a **third** wording that
 * *names the scope it wanted*:
 *
 *   {"error":"Unauthorized - Token is not valid for any required scope: <scope>"}
 *
 * That is parameterised, unlike any other refusal on this surface: the bytes depend on the route. 106 for
 * the wallet scope below.
 *
 * Captured twice, once with a token carrying **no scopes at all** and once with a token carrying a
 * *different* scope. The two bodies are byte-identical, so they are one case.
 *
 * A character mismatch **is** a `403`, and it is the application's
 *
 * A token for character A asking for character B's data, on a route whose scope the token *does* hold:
 *
 *   {"error":"Character ID mismatch between request path and auth token"}
 *
 * It carries `application/json; charset=UTF-8`, **no** trailing newline, **no** `nosniff`, and it carries
 * `X-Esi-Request-Id`, `X-Esi-Cache-Status: MISS` and the `X-Compatibility-Date` echo: `KIND.APP_ERROR`'s
 * signature, none of which the `401` beside it has.
 *
 * So these two refusals are made by **two different implementations**, and the `403` derives its family from
 * the route as a `404` does. `lib/errors.js`'s `familyFor` is the right tool and `FAMILY.EDGE` the wrong one.
 *
 * What is still not known
 *
 * The `403` was observed on **one** route, `/characters/{id}/online/`, whose refusals are the application's
 * (`LEGACY`). What a *gateway*-producer route says for the same mistake is unobserved: it would be
 * `VALIDATED`'s `{"status":403,"error":...,"details":[...]}` if the family rule holds, which is a derivation.
 * `CHARACTER_MISMATCH.familyIsDerived` says so.
 *
 *   node scripts/observe-403.js --client-id <id> --scope esi-location.read_online.v1 \
 *     --other-character <a character that is not yours>
 */
const SCOPE_REFUSAL = Object.freeze({
  status: 401,
  /** The scope name is interpolated, so the bytes are the route's, not a constant. */
  body: (scope) => `Unauthorized - Token is not valid for any required scope: ${scope}`,
  /** `esi-wallet.read_character_wallet.v1`, the one actually observed. */
  observedScope: "esi-wallet.read_character_wallet.v1",
  observedContentLength: 106,
  kind: KIND.GATEWAY_ERROR,
  contentType: CONTENT_TYPE[KIND.GATEWAY_ERROR],
  trailingNewline: true,
  sendsNosniff: true,
  vary: VARY,
  sendsContentLanguage: true,
  echoesCompatibilityDate: false,
  sendsCacheStatus: false,
  sendsRequestId: false,
  limiter: LIMITER.TOKEN_BUCKET,
  cost: 5,
  /**
   * A token with no scopes at all and a token with the wrong scope are the same refusal, byte for byte, whatever
   * eve-nexum's source says.
   */
  noScopesAndWrongScopeAgree: true,
});

const CHARACTER_MISMATCH = Object.freeze({
  status: 403,
  body: "Character ID mismatch between request path and auth token",
  contentLength: 69,
  /** The **application's** refusal, not the gateway's: see the header above. */
  kind: KIND.APP_ERROR,
  contentType: CONTENT_TYPE[KIND.APP_ERROR],
  trailingNewline: false,
  sendsNosniff: false,
  vary: VARY,
  sendsContentLanguage: true,
  echoesCompatibilityDate: true,
  sendsCacheStatus: true,
  sendsRequestId: true,
  limiter: LIMITER.TOKEN_BUCKET,
  cost: 5,
  /**
   * Observed on a `LEGACY` route only. That a gateway-producer route would answer in `VALIDATED`'s shape follows
   * from `ERROR_FAMILY` but has not been seen.
   */
  observedOn: "/characters/{character_id}/online/",
  familyIsDerived: true,
});

/**
 * What is **not** in this file, and why.
 *
 * Every value above came from a request that cost CCP nothing to answer. The only way to observe a `420` or a
 * `429` from esi.evetech.net is to deliberately exhaust a third party's limiter. So these are CCP's documented
 * values, carried as *claims*, and a test may not treat them as wire facts.
 *
 * The replica has to implement them regardless, so they are written down and marked.
 *
 * The two that matter most if wrong: `429` is documented to carry `Retry-After` and `420` is not, and a `5XX` is
 * documented to cost zero tokens.
 */
const LIMITER_UNOBSERVED = Object.freeze({
  errorLimitOverStatus: 420,
  errorLimitOverSendsRetryAfter: false,
  tokenBucketOverStatus: 429,
  tokenBucketOverSendsRetryAfter: true,
  // The weakest two values in this file. CCP publishes the statuses and not the bodies, and the pinned spec
  // documents no `420` or `429` response at all, so these are placeholders in the shape of an edge refusal, chosen
  // to be short and boring. A client acts on the status and `Retry-After`; nothing in the ecosystem survey matches
  // on either string. `lib/errorLimiter.js` and `lib/rateLimiter.js` keep their own copies, as deployed code must,
  // and their tests compare against these, so observing the real ones means one edit here failing two tests.
  errorLimitOverBody: "error limit exceeded",
  tokenBucketOverBody: "rate limit exceeded",
  // 5XX is free, and a 429 does not charge for itself.
  tokenBucketCostServerError: 0,
  tokenBucketCostOverLimit: 0,
  // CCP's documented sentence, kept verbatim and known to be **wrong on this surface**. `LIMITER_KEY` is the
  // observation (2026-08-25), and it contradicts this string on both limiters: the error limiter never consults the
  // credential at all, and the token bucket keys on the application alone, so the `:characterID` is a narrowing
  // nothing applies. `LIMITER_KEY.contradicts` and this field are the two halves of one
// documented-versus-observed conflict, in which the observation wins (D31).
  //
  // Kept verbatim because it is pinned by `test/errorLimiter.test.js` ("the key is the source address whatever the
  // credential, which is observed and not deferred"), which asserts this exact string, and so the next person reading
  // CCP's docs finds out it was tried (D39).
  errorLimitKey: "applicationID:characterID, else source IP",
  // What is left of the three open questions behind that one string.
  //
  // Two closed on 2026-08-25:
  //
  //   `oneBudgetOrTwo`         answered. One budget on the error limiter, and three separate ones on the token
  //                            bucket. See `LIMITER_KEY.errorLimiter.sharedWithUnauthenticated` and
  //                            `LIMITER_KEY.tokenBucket.sharedWithUnauthenticated`.
  //   `tokenBucketKeysTheSame` answered, and the answer is no. See `LIMITER_KEY.limitersAgree`.
  //
  // The two limiters are separate mechanisms that key differently, so nothing about either may be inferred from the
  // other.
  //
  // The one below stays open, and neither limiter waits on it. `lib/errorLimiter.js` `keyFor` keys on the address
  // unconditionally, the observed behaviour. `lib/rateLimiter.js` keys an authenticated caller on the application,
  // using the client id from the token's `azp`, which is sound because the two candidate spellings are one-to-one per
  // registered application and induce the same partition. What stays unobserved is which of them CCP names.
  errorLimitKeyQuestions: Object.freeze({
    // Nothing in the pinned spec names it and no response carries it. The client id from a token's `azp` and the
    // registered application's numeric id are different things, and no capture yet devised can tell them apart: a budget
    // partitioning by application partitions the same way under either, which the 2x2 confirmed.
    whatApplicationIdIs: "unobserved",
  }),
  tokenBucketRefill: "floating window",
});

// Method and parameter handling

/**
 * `HEAD` on a GET route is 405, with CORS headers and no body. Node answers HEAD from the GET handler by default, so
 * this must be taken away.
 */
const HEAD_STATUS = 405;

/**
 * A query parameter the operation does not declare is ignored, not rejected: `?datasource=tranquility` reaches routes
 * that never mention it. The one exception observed is a *recognised* parameter with an unusable value:
 * `?datasource=nope` is `400 {"error":"Invalid tenant"}` from the gateway.
 */
const IGNORES_UNKNOWN_QUERY_PARAMS = true;

/**
 * Path-parameter validation on the legacy surface is a `400` carrying a coercion message, not the `422` with `details[]`
 * that the modern surface returns. Observed verbatim:
 *
 *   GET /latest/universe/systems/abc/
 *   400 {"error":"failed to coerce value 'abc' into type integer (format: int32), 'system_id' is required"}
 *
 * A template rather than a constant, because the value and parameter name are interpolated.
 */
const COERCION_ERROR = Object.freeze({
  status: 400,
  template: (value, format, parameter) =>
    `failed to coerce value '${value}' into type integer (format: ${format}), '${parameter}' is required`,
});

// How a float reaches the wire

/**
 * **ESI writes a `double` with a decimal point, and `JSON.stringify` does not.**
 *
 * Observed 2026-08-25 across four operations and three producers:
 *
 *   GET /latest/characters/3004069/     "security_status":0.0
 *   GET /latest/characters/{id}/        "security_status":0.1
 *   GET /latest/corporations/1000035/   "tax_rate":0.000
 *   GET /latest/corporations/{id}/      "tax_rate":0.050   and 0.100
 *   GET /latest/universe/factions/      "size_factor":5.0
 *   GET /latest/markets/10000002/...      "price":170000000.0
 *
 * `JSON.stringify(0)` is `0`, `JSON.stringify(5)` is `5`, and `JSON.stringify(170000000)` is `170000000`, so a replica
 * serialising an integer-valued double the obvious way is **two to four bytes short** on every such field, on a response
 * whose `content-length` and `Etag` both depend on the count. The pinned spec says only `"type":"number","format":"double"`,
 * and a `JSON.parse` round-trip hides it: `0.0` and `0` parse to the same value.
 *
 * `contract/golden/`'s `GetMarketsRegionIdOrders` carries it (`"price":170000000.0`, recorded 2026-08-23), but that golden's
 * diff kind is `shape`, because a private server's order book is not CCP's. A `shape` diff checks the field set, the key order
 * and the last byte, and does not read a value.
 *
 * Two rules
 *
 * `tax_rate` is **quantised to three decimal places** (`0.000`, `0.050`, `0.100`, never `0.05`): a fixed scale rather than a
 * minimum. Every other double observed renders in Python's `repr` style: the shortest representation that round-trips, with a
 * `.0` appended when that would otherwise be an integer. `security_status` is `0.0` on one character and `0.1` on another, so it
 * is the second rule.
 *
 * `fixed` is keyed by field name: the same field carries the same scale wherever it appears, and keying by operation would repeat
 * `tax_rate` for every corporation route.
 *
 * What is not claimed
 *
 * That the two rules cover every double on the surface. Six fields were seen across four operations; `adjusted_price`,
 * `average_price`, `standing`, `size_factor` on a fractional faction, and every double on routes this replica does not serve are
 * unobserved, and `repr` is *assumed* for them. A correction is one row in `fixed`.
 *
 * `standing` is the likeliest candidate for a second `fixed` row: EVE shows a standing to two decimal places, and a `-2.50` on the
 * wire would be a scale. The captures behind `CONTACTS` were read for field order and optionality, not digits, so one authenticated
 * `curl` against `/characters/{id}/contacts/` closes this.
 */
const DOUBLE_RENDERING = Object.freeze({
  /**
   * Fields written at a fixed number of decimal places, by field name.
   *
   * A table entry rather than a special case in the serializer, so a new capture is a new row.
   */
  fixed: Object.freeze({ tax_rate: 3 }),

  /**
   * Everything else: the shortest round-tripping form, with `.0` appended when
   * the value is an integer.  `String(0.1)` is already `"0.1"` in JavaScript
   * and `String(5)` is `"5"`, so only the integer case needs doing.
   */
  minimumDecimals: 1,

  /** The fields this rule was read off, so a test can name its evidence. */
  observed: Object.freeze(["price", "security_status", "size_factor", "tax_rate"]),
});

// Non-ASCII, the fourth producer split

/**
 * **The application escapes every character outside ASCII; the gateway writes it raw.**
 *
 * After the `content-type`, the trailing newline and the double suffix, this is the fourth property of which implementation wrote
 * the body. Observed 2026-08-25, three application routes and one gateway route:
 *
 *   GET /latest/universe/factions/    ...throughout Anoikis \u2013 otherwise...
 *   GET /latest/universe/bloodlines/  ...not generally considered \u201censlaved\u201d...
 *   GET /latest/universe/ancestries/  ...vast amounts of wealth \u2013 along with...
 *   GET /latest/characters/{id}/      "title":"...\r\n<box-drawing characters>\r\n..."   raw UTF-8
 *
 * Lowercase hex, four digits, and a character outside the BMP would arrive as the two escapes of its surrogate pair, which is what a
 * UTF-16 pass produces. No ESI body observed carries one, so that last clause is the mechanism rather than an observation.
 *
 * Why it matters
 *
 * An en dash is three bytes raw and six escaped. A replica writing raw on an application route is short on `content-length` by three
 * bytes for every non-ASCII character, and sends a body whose hash disagrees with CCP's. The same class of error as the missing
 * trailing newline, and commoner here: every faction, race, bloodline and ancestry description is prose with typographic quotes and
 * dashes.
 *
 * How it was found
 *
 * `/universe/factions/` built from this replica's own dump matched CCP's captured body **field for field** (27 rows, ten fields each,
 * every value equal including the two derived station counts) and differed by six bytes: two en dashes in one faction's description.
 *
 * Neither a `shape` golden nor a spec check can see that: both compare parsed values, and `"\u2013"` and a raw en dash parse to the
 * same string. It shows only in a byte comparison of a body whose values are reproducible. With the escaping in place that body is
 * 22,171 bytes against CCP's 22,171.
 */
const NON_ASCII_ESCAPING = Object.freeze({
  observedAt: "2026-08-25",

  /** Which producers escape. Keyed as `SUCCESS_KIND`'s values are named. */
  byProducer: Object.freeze({
    gateway: false,
    app: true,
    /**
     * `false`, and **unexercised** rather than observed: no `/meta/` body carries a character outside ASCII. It is the value that changes
     * nothing.
     */
    meta: false,
  }),

  /** Four hex digits, lowercase. `\u2013`, never `\U2013` and never `\u+2013`. */
  form: "\\uXXXX",
  lowercaseHex: true,

  /** The routes the split was read off, so a test can name its evidence. */
  observed: Object.freeze({
    escaping: Object.freeze([
      "/universe/factions",
      "/universe/bloodlines",
      "/universe/ancestries",
    ]),
    raw: Object.freeze(["/characters/:character_id"]),
  }),
});

// Public entity information

/**
 * `GET /characters/{id}/`, `/corporations/{id}/` and `/alliances/{id}/`: the three public entity lookups, observed 2026-08-25.
 *
 * All three are the **gateway**: bare `application/json`, a body ending in a newline, a weak 64-hex `Etag`, `Expires` measured from
 * `Date`, the three-line `Vary`, `X-Esi-Cache-Status` and **no** `X-Esi-Request-Id`. Their refusals are therefore the `VALIDATED`
 * family, which `ERROR_FAMILY` above derives from the success.
 *
 * The captures were chosen so nothing recorded names a person: an NPC agent, an NPC corporation, and ordering probes against player
 * entities whose ids are deliberately not written down. What is kept is the protocol (which fields, which order, what a refusal says)
 * and never the payload (D23).
 *
 * Three operations, three different field orders
 *
 *   alliance      plain alphabetical
 *   character     the six required fields alphabetically, then the optionals
 *                 in an order that is *not* alphabetical (`title` before
 *                 `description`)
 *   corporation   neither; a declaration order out of the legacy schema
 *
 *
 * `contract/openapi.json`'s key order is alphabetical on all three, so it agrees with one of them and would produce the wrong bytes on
 * the other two. The spec's key order is not evidence; the wire is, the same conclusion as `CHARACTER_LOCATION` for `/ship/`.
 *
 * The id minimums, which the spec does not publish
 *
 * A path id below its entity's range is **not** a `404`. It is the validated family's `422` with a *different message* from the one an
 * unparseable id gets, and the boundary is CCP's own id-range start, to the unit:
 *
 *   GET /latest/characters/2999999/    422 invalid character ID
 *   GET /latest/characters/3000000/    404 Not Found
 *   GET /latest/corporations/999999/   422 invalid corporation ID
 *   GET /latest/corporations/1000000/  404 Not Found
 *   GET /latest/alliances/98999999/    422 invalid alliance ID
 *   GET /latest/alliances/99000000/    404 Not Found
 *
 * `details[].value` keeps its JSON type across the pair (the number `2999999` for a range failure and the string `"abc"` for an
 * unparseable one), as `DETAIL_LOCATION` above records, confirmed on three more routes. `ERROR_BYTES.validatedOutOfRange` was the first
 * seen; here the wording names the entity, so `invalid corporation ID` and `invalid alliance ID` are two more strings.
 *
 * These minimums are also eve.js's own ranges: `services/corporation/corporationIdRanges.js` allocates player corporations from 98000000
 * and alliances from 99000000, and NPC corporations sit in the 1000000s, so the check refuses nothing this game can produce.
 *
 * The 404 that is not `Not Found`
 *
 * `GET /latest/characters/90000001/`, the character id the pinned spec publishes as its own example, answers
 * `404 {"status":404,"error":"Character has been deleted!"}`, 53 bytes, exclamation mark included. A second wording on a status that
 * `notFound()` treats as having one, reachable only for a character that existed and no longer does.
 *
 * Recorded and **not reproduced**: eve.js has a deletion runtime, but nothing was observed about which answer a *never-existing* in-range
 * id gets on a private server versus a deleted one, and this replica answers every unknown character with the plain `Not Found`. No
 * consumer in this ecosystem branches on this string.
 */
const PUBLIC_ENTITY = Object.freeze({
  /** The date all of the below was read off live ESI. */
  observedAt: "2026-08-25",

  /**
   * Declaration order is output order is bytes, per operation.
   *
   * An optional field no captured entity carried has **no known position** (`unobservedFields`), so emitting it would guess at a byte
   * offset. `routes/entities.js` omits them, as `routes/characters.js` does for `last_login` and `logins`.
   */
  fieldOrder: Object.freeze({
    character: Object.freeze([
      "birthday",
      "bloodline_id",
      "corporation_id",
      "gender",
      "name",
      "race_id",
      "alliance_id",
      "title",
      "description",
      "security_status",
    ]),
    corporation: Object.freeze([
      "name",
      "ticker",
      "description",
      "url",
      "date_founded",
      "ceo_id",
      "creator_id",
      "alliance_id",
      "home_station_id",
      "member_count",
      "tax_rate",
      "shares",
      "war_eligible",
    ]),
    alliance: Object.freeze([
      "creator_corporation_id",
      "creator_id",
      "date_founded",
      "executor_corporation_id",
      "name",
      "ticker",
    ]),
  }),

  /**
   * Optional fields the captures never produced, so their position is unknown.
   *
   * `faction_id` on a corporation was nearly settled: a militia corporation carries it between `creator_id` and `home_station_id`, which is
   * where `alliance_id` sits on a player corporation. No corporation carrying *both* was found (a militia corporation is an NPC one and
   * joins no alliance), so their relative order is the one missing fact.
   */
  unobservedFields: Object.freeze({
    character: Object.freeze(["faction_id"]),
    corporation: Object.freeze(["faction_id"]),
    alliance: Object.freeze(["faction_id"]),
  }),

  /** `gender` is an enum of two, lowercase, and required. */
  genderValues: Object.freeze(["male", "female"]),

  /**
   * The lowest id each route accepts before the validator refuses it, observed
   * to the unit. An id at the boundary is a `404`; one below is a `422`.
   */
  idMinimum: Object.freeze({
    character_id: 3000000,
    corporation_id: 1000000,
    alliance_id: 99000000,
  }),

  /**
   * `details[].message` for an id that parsed and was out of range, per
   * parameter. The unparseable case is `invalid integer` on all three, which is
   * `ERROR_BYTES.validatedInvalidInteger`.
   */
  outOfRangeMessage: Object.freeze({
    character_id: "invalid character ID",
    corporation_id: "invalid corporation ID",
    alliance_id: "invalid alliance ID",
  }),

  /**
   * The second 404 wording, observed and deliberately not reproduced. See the
   * header; `contentLength` is a protocol constant here because the string is
   * fixed, unlike a body whose length depends on somebody's name.
   */
  deletedCharacter: Object.freeze({
    status: 404,
    body: '{"status":404,"error":"Character has been deleted!"}',
    contentLength: 53,
    reproduced: false,
  }),
});

// The faction roster

/**
 * `GET /universe/factions/`, observed 2026-08-25.
 *
 * The **application** producer: `charset=UTF-8`, no trailing newline, `X-Esi-Request-Id`, and the four-line `Vary` (`VARY_LOCALIZED_SURVEY`
 * has it in the localized column). 27 rows, 22,171 bytes.
 *
 * It is a static-data route, and that shows in three headers
 *
 *   Cache-Control: public                       (bare; no max-age at all)
 *   Etag:          W/"a3cbe689..."                (weak, 56 hex)
 *   Last-Modified: Tue, 25 Aug 2026 11:05:15 GMT
 *   Expires:       Wed, 26 Aug 2026 11:05:00 GMT
 *
 * The pinned spec publishes **no `x-cache-age`** on this operation, the only route this replica serves that publishes none, and says instead,
 * in prose, *"This route expires daily at 11:05"*. So `Expires` is neither `Date + ttl` nor `Last-Modified + ttl`: it is the next 11:05 UTC,
 * and there is no TTL to declare. `ETAG` above records the third form these static routes share.
 *
 * What is recorded and what is reproduced
 *
 * On CCP's surface `/universe/factions/`, `/universe/regions/{id}/`, `/universe/types/{id}/` and `/fw/wars/` answer with the **same**
 * validator, because they are one snapshot of one dump; a replica giving each route its own etag is distinguishable by a client fetching two.
 * `lib/staticSnapshot.js` (D43) provides the snapshot-wide validator and this route takes the same one, so a faction and a solar system fetched
 * from here carry one etag. See `sharedSnapshotEtag` below.
 *
 * The row order is CCP's and is not reproducible
 *
 * The array is **not sorted by `faction_id`**: it arrives 500003, 500010, 500017, 500024, 500004, 500011, ..., a stride through some internal
 * bucketing, stable only because CCP serves it from cache. Nothing derives it from the data, so this replica sorts by `faction_id` ascending, as
 * eve.js's `getAllFactionRecords` does. Order is bytes, so this is a real difference, and the one place on this route where matching CCP is not
 * possible.
 *
 * The two fields the SDE does not carry
 *
 * `station_count` and `station_system_count` are **required** and appear nowhere on eve.js's faction record. They are derived from the `stations`
 * table: a station names its owning corporation and its solar system, and a corporation names its faction, so the counts are a group-by over 5,210
 * rows. That is a real computation on the game's event loop, so `lib/runtimeAccess.js` memoises it; see there for the cost and the invalidation, and
 * `routes/entities.js` for why a required field with a derivable value is derived rather than omitted.
 */
const FACTIONS = Object.freeze({
  observedAt: "2026-08-25",

  /** Alphabetical, unlike two of the three entity lookups above. */
  fieldOrder: Object.freeze([
    "corporation_id",
    "description",
    "faction_id",
    "is_unique",
    "militia_corporation_id",
    "name",
    "size_factor",
    "solar_system_id",
    "station_count",
    "station_system_count",
  ]),

  /** Absent from the body entirely when the faction has none. */
  omitsAbsentOptionalFields: true,

  /** 27 rows on Tranquility, and 27 in this install's dump. Not asserted equal. */
  rowCountObserved: 27,

  /**
   * `null`, which is the spec's answer: the operation publishes no `x-cache-age`. `Expires` is the next 11:05 UTC instead.
   */
  cacheAgeSeconds: null,

  /** UTC hour and minute the dump's `Expires` lands on, from the spec's prose. */
  expiresDailyAt: Object.freeze({ hour: 11, minute: 5 }),

  /**
   * The shared static-snapshot etag, which **is** reproduced.
   *
   * `lib/staticSnapshot.js`, deliberately not universe-specific, provides it, and `/universe/factions/` takes the same instance its four routes take,
   * so a faction and a solar system fetched from this replica carry one validator as they do from CCP.
   *
   * The contents differ: CCP's names their dump and ours names ours, through the store's own `source` stamp (the build number, the directory the dump
   * was extracted to, and when the tables were generated from it). The reproduced property is that the routes **agree with each other** and that the
   * validator moves only when the operator rebuilds the store, the only event that can change these bodies. See D43.
   */
  sharedSnapshotEtag: Object.freeze({
    weak: true,
    algorithm: "sha224",
    sharedWith: Object.freeze([
      "/universe/regions/:region_id",
      "/universe/types/:type_id",
      "/universe/categories/:category_id",
      "/fw/wars",
    ]),
    reproduced: true,
  }),

  /** CCP's row order, which no data derives. This replica sorts by faction_id. */
  sortedByFactionId: false,
});

/**
 * The static-data snapshot: one dump, one validator (D43).
 *
 * The `/universe/` item routes do not cache like the rest of the application. Four of them fetched seconds apart on 2026-08-25 answered with the
 * identical `Etag`, the identical `Expires`, and a `Last-Modified` within seconds of each other, because they are one snapshot of one static-data dump:
 *
 *   curl -sD - https://esi.evetech.net/latest/universe/systems/30000142/
 *   curl -sD - https://esi.evetech.net/latest/universe/constellations/20000020/
 *   curl -sD - https://esi.evetech.net/latest/universe/stations/60003760/
 *   curl -sD - https://esi.evetech.net/latest/universe/types/34/
 *     Cache-Control: public
 *     Etag:          W/"a3cbe689cb47e4053e2cc66a2aeb133118f235186aa60a00ceecaa7a"
 *     Expires:       Wed, 26 Aug 2026 11:05:00 GMT
 *     Last-Modified: Tue, 25 Aug 2026 11:05:15 GMT
 *
 * Three things are unlike every other application route, each a field below. The etag is **weak** where the application's is a strong SHA-224 over the
 * body, and is the same on four different bodies, so it digests none of them. `Expires` is a **wall-clock instant** rather than a window, the instant the
 * pinned spec names in prose on each of these operations ("This route expires daily at 11:05") while publishing no `x-cache-age`. And the `404` carries
 * the etag alone, `SENDS_CACHE_HEADERS`'s one exception.
 *
 * `expiresAt` is UTC. Both sources agree to the minute and the wire agrees to the second.
 */
const STATIC_DATA = Object.freeze({
  expiresAt: Object.freeze({ hour: 11, minute: 5 }),
  etag: Object.freeze({ algorithm: "sha224", weak: true }),
  cacheControl: "public",
  /** Observed sharing one validator in a single capture, 2026-08-25. */
  sharedBy: Object.freeze([
    "/universe/systems/:system_id",
    "/universe/constellations/:constellation_id",
    "/universe/stations/:station_id",
    "/universe/stars/:star_id",
    "/universe/types/:type_id",
    "/universe/regions/:region_id",
  ]),
  /** The `404` carries the etag and none of the other three. */
  notFoundCarriesEtag: true,
});

/**
 * What each `/universe/` item route calls the thing it could not find.
 *
 * The legacy family words a not-found as `<Entity> not found`, and the noun is not derivable: the operation is `GetUniverseSystemsSystemId`, the schema
 * `UniverseSystemsSystemIdGet`, the parameter `system_id`, the tag `Universe`, and the body says `System`. Four requests, four nouns, on 2026-08-25:
 *
 *   GET /latest/universe/systems/30099999/         28  {"error":"System not found"}
 *   GET /latest/universe/stars/40999999/           26  {"error":"Star not found"}
 *   GET /latest/universe/constellations/20099999/  35  {"error":"Constellation not found"}
 *   GET /latest/universe/stations/60999999/        29  {"error":"Station not found"}
 *
 * The byte counts are `content-length` as served.
 */
const UNIVERSE_NOT_FOUND = Object.freeze({
  "/universe/systems/:system_id": Object.freeze({ entity: "System", contentLength: 28 }),
  "/universe/stars/:star_id": Object.freeze({ entity: "Star", contentLength: 26 }),
  "/universe/constellations/:constellation_id":
    Object.freeze({ entity: "Constellation", contentLength: 35 }),
  "/universe/stations/:station_id": Object.freeze({ entity: "Station", contentLength: 29 }),
});

module.exports = {
  AUTHENTICATED_CACHE_CONTROL,
  CACHE_CONTROL,
  CHARACTER_LOCATION,
  COERCION_ERROR,
  COMPATIBILITY_DATE,
  COMPATIBILITY_DATE_RULES,
  ECHOES_COMPATIBILITY_DATE,
  CONDITIONAL,
  CONDITIONAL_STATIC_DATA_EXCEPTION,
  CONTENT_LANGUAGE,
  CONTENT_TYPE,
  DOUBLE_RENDERING,
  ETAG,
  FACTIONS,
  PUBLIC_ENTITY,
  EXPIRES_BASIS,
  NOT_MODIFIED_SENDS,
  SENDS_CACHE_HEADERS,
  DETAIL_LOCATION,
  ERROR_BODY,
  ERROR_BYTES,
  ERROR_FAMILY,
  ERROR_LIMIT,
  ERROR_SHAPE,
  ESTABLISHED,
  ALLOW_ORIGIN,
  APP_SUCCESS_HEADERS,
  EXPOSE_HEADERS,
  GATEWAY_SUCCESS_HEADERS,
  HEADER_CASE,
  HEAD_STATUS,
  IGNORES_UNKNOWN_QUERY_PARAMS,
  INFRASTRUCTURE,
  KIND,
  LEGACY_NOT_FOUND,
  LIMITER,
  LIMITER_KEY,
  LIMITER_KEY_CAPTURE,
  LIMITER_KEY_SURVEY,
  LIMITER_SURVEY,
  LIMITER_UNOBSERVED,
  META,
  METHOD_NOT_ALLOWED,
  METHOD_NOT_ALLOWED_LIMITER,
  NEVER_SENT,
  NON_ASCII_ESCAPING,
  NOT_SENT_BY_CHOICE,
  PING,
  PREFLIGHT,
  SENDS_CORS,
  SENDS_NOSNIFF,
  SUCCESS_KIND,
  TENANT,
  TOKEN_BUCKET,
  BEARER,
  SCOPE_REFUSAL,
  CHARACTER_MISMATCH,
  AUTHENTICATED_PAGING,
  CONTACTS,
  CHARACTER_ROLES,
  CROSS_ENTITY_REFUSAL,
  FLEET_ABSENT,
  REQUIRED_ROLE_REFUSAL,
  WAYPOINT_WRITE,
  TRAILING_NEWLINE,
  UNROUTED_404,
  UNVERSIONED_PATHS,
  PAGINATION,
  PAGINATION_ERRORS,
  VALIDATES_DECLARED_QUERY_PARAMS,
  VALIDATES_UNDECLARED_QUERY_PARAMS,
  VARY,
  VARY_BY_KIND,
  VARY_LOCALIZED_BODY,
  STATIC_DATA,
  UNIVERSE_NOT_FOUND,
  VARY_LOCALIZED_SURVEY,
  VERSION_PREFIXES,
};
