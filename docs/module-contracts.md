# Module contracts

The names, signatures and shapes the core modules export, so that they compose without a reshuffle. Change a signature here before
changing it in code. Modules not listed (`lib/signingKey.js`, `lib/refreshTokens.js`, the route families and so on) document their interfaces
in their own headers and follow the same conventions.

## Project-wide conventions

| Thing | Value |
|---|---|
| Language | CommonJS, `"use strict";` at the top of every file, Node 24 |
| Runtime dependencies | None. `node:` builtins only; the released mod carries no dependency tree (D20) |
| `package.json` | Source repo only, for tooling. No `version` field: `MOD_VERSION` in `config.js` is the single source of truth |
| Test runner | `node --test "test/**/*.test.js"`, with `node:test` and `node:assert/strict` |
| Test doubles | Inline, local to the test that uses them. `test/fixtures/` is reserved for doubles genuinely shared across suites, and is empty until one exists |
| Deployed directory | `<eve.js tree>/mods/esiApi/`, where `<eve.js tree>` is an eve.js checkout. It is the release artifact, not this repository verbatim (D20) |
| Table-repository owner | `mod:esiApi` |
| Env var prefix | `ESI_MOD_` |
| Log prefix | `[EsiApiMod]` |
| Ports (D1) | ESI `26005`, SSO `26006` |
| Contract sources | `contract/`: the pinned `2020-01-01` spec (D22) and the observed wire constants (D23). Test-only: nothing there is hashed or released, and the suite never opens a socket to CCP |

Every module must be requirable and unit-testable with no eve.js checkout present. Only `lib/runtimeAccess.js` may reach game code, and only lazily.

## `lib/exportProbe.js`

```js
exportHas(value, property, expectedType)   // expectedType is a typeof result, or "array"
prototypeHasMethod(value, method)
```

Both are `hasOwnProperty`-based and never read through a prototype. Any predicate that inspects a game module's exports goes through these.

## `config.js`

```js
MOD_VERSION                 // string, hand-maintained
ENV_FILE_NAME               // ".env"
ENV_TXT_FILE_NAME           // ".env.txt"
SETTINGS_FILE_NAME          // "settings.json"
ENV_FILE_PATH               // absolute, beside this file
ENV_KEYS                    // frozen array of recognised ESI_MOD_* keys
SETTINGS_ENV_KEYS           // frozen allowlist, settings key -> env key
DEFAULTS                    // frozen defaults object
RESERVED_GAME_PORTS         // frozen Map, port -> what eve.js uses it for; either port set to one is an error

parseEnvFile(text, fileName)   // -> { values, warnings }                  never throws
readEnvFile(filePath)          // -> { values, warnings }                  never throws, a missing file is silent
parseSettingsFile(text)        // -> { values, warnings }                  pure; values is env-like
readSettingsFile(filePath)     // -> { values, warnings }                  absent is silent, never throws
parseClientsFile / readClientsFile                                         // the optional SSO clients file
parseConfigFromEnv(env)        // -> { ok, config, warnings, notices, errors }     pure
loadConfig({ dir, env } = {})  // -> { ok, config, warnings, notices, errors }     dir defaults to __dirname, env to process.env
describeConfig(config)         // -> plain object safe to log; secrets redacted, never printed
loopbackListenersInContainer(config)  // -> env keys of armed listeners bound to loopback; pure
```

Merge order is `{ ...settingsJson, ...envTxt, ...envFile, ...processEnv }`: a real environment variable wins per key, then `.env`, then `.env.txt`, then
`settings.json`, then `DEFAULTS` (D47). **Never call `process.loadEnvFile()`**: it mutates the game server's shared `process.env`.

`settings.json` is written by the launcher form. It reaches the parsers through one frozen allowlist from settings key to env key (`SETTINGS_ENV_KEYS`). An unknown
key warns and is ignored, so it can never arm dev auto-approve or move the credential paths. Numbers are stringified, non-scalars warn and are ignored, malformed
JSON warns and is ignored, and `esiPort: 0` means blank.

`config` is `Object.freeze`d and carries:

```
modVersion, esiBindHost, esiPort, ssoBindHost, ssoPort, ssoIssuer, ssoClientsPath, ssoClients, ssoStateDir,
devAutoApprove, devAutoApproveCharacterID, signingKeyPath, errorLimitMaxErrors, logLevel
```

`ESI_MOD_ESI_PORT` and `ESI_MOD_SSO_ISSUER` are the two switches, and both have defaults (26005 and `http://localhost:26006`). Absent means the default; present and
blank means that listener is off. `ok` is `errors.length === 0 && (esiPort !== null || ssoIssuer !== null)`. Both blank is `ok: false` with no error, which is the
dormant state. Inertness for a package nobody enabled comes from the launcher's `loader.js.disabled`, not from configuration.

## `lib/runtimeAccess.js`

```js
GAME_MODULES                       // frozen { key: "path/relative/to/server/src" }, no extension
SERVER_SRC_SEARCH_DEPTH
TABLE_REPOSITORY_OWNER             // "mod:esiApi"
GameModuleShapeError               // named error class

findServerSrc(startDir)            // pure walk-up, -> absolute path | null
resolveServerSrc()                 // memoised; EVEJS_REPO_ROOT overrides (tests only)
gameModuleFilenameIn(serverSrc, key)         // pure; resolves, never loads -> filename | null
getGameModule(key)                 // lazy + memoised require
peekGameModule(key)                // an already-loaded module, without loading it
clearGameModuleCache()             // test seam
requireOwnCallable(value, prop, moduleKey)   // -> function, else throws GameModuleShapeError
readOwnCallable(value, prop)

isRuntimeReachable()               // -> { reachable: boolean, reason: string | null }   never throws
getStorePaths() / getStorePathsFromRuntime(storeRootModule)   // -> { gameStoreRoot, sdeRoot }
getReadOnlyTableRepository()       // createTableRepository("mod:esiApi", { strict: true, allowSharedWrites: false })
```

**Pure core, thin wrapper.** Every accessor is a pair: `xFromRuntime(module, options)` is pure and injectable, `x(options)` is a one-line wrapper supplying the real module.
This is what lets the suite run without booting the game.

## `server.js`

```js
MAX_BODY_BYTES, REQUEST_TIMEOUT_MS, HEADERS_TIMEOUT_MS
LISTENERS, DEFAULT_LISTENER                   // "esi" and "sso", the default is "esi" (D6)

parseRequestTarget(req)                       // -> { method, pathname, query }
readRequestBody(req, { limit })               // -> Promise<Buffer>, rejects past the limit
parseRequest(req, { limit })                  // -> Promise<{ method, pathname, query, headers, rawBody, body }>
sendJson(res, status, body, headers)
attachClientErrorHandler(server)              // JSON straight to the socket, never Node's plain-text 400
createRequestHandler({ dispatch, log, logError })   // -> (req, res) => void
startServer({ config, listener, dispatch, log, logError })    // -> Promise<{ server, host, port, url, close }>
closeServer(handle)                           // -> Promise<void>
```

`dispatch` is injected, not imported:

```js
dispatch(request) -> Promise<{ status, headers?, body? }> | { status, headers?, body? }
```

An unknown path resolves to `{ status: 404 }`. A `dispatch` that throws or rejects becomes a 500 and is logged; it must never surface as an unhandled rejection, which eve.js's
ProcessLifecycle treats as fatal.

A `body` that is a string or a Buffer is written verbatim; anything else is JSON. A bodiless `204` or `304` carries no `content-length`: RFC 9110 forbids it and CCP does not send one.

Non-negotiables: `server.unref()`, timeouts set, bounded body, no HTML on any path, no synchronous work proportional to game state.

## `lib/sourceHash.js`

```js
HASHED_DIRS, HASHED_FILES, SHORT_HASH_LENGTH   // 12
listHashedFiles(modDir)      // -> sorted repo-relative paths, deterministic
readNormalized(filePath)     // -> file text with CRLF collapsed to LF
computeSourceHash(modDir)    // -> full lowercase hex
shortSourceHash(modDir)      // -> first SHORT_HASH_LENGTH hex chars; never throws, "unknown" on failure
```

## `routes/health.js`

```js
HEALTH_PATH                  // "/_mod/health", outside the ESI namespace by construction
buildHealthReport(deps)      // -> plain object, never throws
createHealthDispatch(deps)   // -> dispatch-compatible handler for server.js
```

`deps` is `{ config, runtime, modDir, startedAt, now }`, all injected. The report carries `status, modVersion, sourceHash, startedAt, uptimeSeconds, gameStore, sde, runtimeReachable`, and
reports rather than judges: an unreachable game runtime is a field in the body, not an error status.

## `lib/pipeline.js`

```js
createEsiDispatch(router, options)   // the nine layers around the router, in the one order
createGroupFor(router, options)      // which token bucket a request would be charged to, or null
```

`loader.js` and the tests call the same builder. Never hand-assemble the stack. The order and the reason for each boundary are in the module header and in
[architecture.md](architecture.md).

## `lib/router.js`

```js
VERSION_PREFIXES            // frozen, nine: latest, legacy, dev, v1..v6
COMPATIBILITY_DATE          // "2020-01-01"; every prefix pins here (D4)
SUBJECT, SUCCESS_STATUSES
RouteTableError             // named error class, thrown at construction only
RouteRefusal

createRouter(routes)        // -> { routes, resolve(method, pathname), rateLimitGroupFor(method, pathname), ... }
compileRoute(route)
resolveRoute(routes, method, pathname)
dispatchRequest(router, request, deps)   // -> { status, headers?, body?, producer? }
compilePathPattern(pattern) / matchPathPattern(segments, actual) / splitPath(pathname)
canonicalKey(route)         // collision key: prefix and trailing slash removed
```

A route descriptor, with the canonical path (no version prefix, no trailing slash):

```js
{ method, path, handler, producer, name?, scope?, subject?, rateLimitGroup?, cacheTtl?, snapshot?,
  pageSize?, successStatus?, localizedBody?, versioned? }
```

`handler` is `(params, deps) => data`, never seeing `req` or `res`. `params` carries `{ method, pathname, prefix, compatibilityDate, path, query, body }`.

`producer` is the one field with no default: it is `"gateway"`, `"app"` or `"meta"`, or an explicit `null` for a route that sends no JSON, and omitting it is a `RouteTableError` at server start.

It is deliberately one field. ESI is more than one implementation behind one hostname and a route belongs to one of them. That single fact decides its success `content-type` and trailing newline,
its error shape and status codes, its `Cache-Control` form and `Expires` basis, and how it answers a conditional request. There is no separate `errorFamily` field. Fetching a success and a refusal
from the same route, six times, gave six agreements and no exceptions; apparent independence came from comparing `/alliances/` with `/alliances/{alliance_id}/`, which are different routes. The
family is derived (`lib/errors.js` `familyFor`), because two fields could be set to a combination that does not exist.

`scope`, `rateLimitGroup` and `cacheTtl` are published by CCP, so `contract/spec.js`'s `assertRouteMatchesSpec(route)` checks a table against the pinned spec. The values are declared on the route rather
than read from `contract/` because `contract/` is never deployed (D20).

`resolve` has three outcomes: `matched` (with `route`, `pathParams`, `prefix`), `method-not-allowed` (with `allow`, which is `null` for a HEAD request), and `not-found`. Observed oddities: a prefix
is optional and so is the trailing slash; `/v7/` is not a prefix and falls through to the same plain-text 404 as an unrouted path; `Allow` advertises `HEAD` and `HEAD` is refused anyway.

## `lib/errors.js`

```js
FAMILY                       // { LEGACY, VALIDATED, EDGE }
SHAPE                        // per-family producer and nosniff behaviour
FAMILY_BY_PRODUCER           // app -> legacy, gateway -> validated, meta -> null
familyFor(producer)          // a route's error family, derived, never declared
UNAUTHORIZED_REASONS         // { "no-token", "invalid-token" } -> the two exact strings
INVALID_TENANT, CHARACTER_MISMATCH, NOT_IN_CORPORATION, MISSING_REQUIRED_ROLE
UNROUTED_BODY, UNROUTED_CONTENT_TYPE

unauthorized(reason)                              // 401, edge
unauthorizedScope(scope)                          // 401, edge (D31)
characterMismatch(family)                         // 403, application; throws for VALIDATED (D31)
notInCorporation() / missingRequiredRole(...)     // 403, application (D35)
invalidTenant()                                   // 400, edge
edgeRefusal(...)
coercionFailed(family, { parameter, value, message?, where?, format? })
invalidBody(...)
notFound(family, { entity })                      // legacy names the entity; validated does not
pageBelowMinimum(...) / pageBeyondEnd(family)
unrouted()                                        // Go's plain-text 404, 19 bytes
methodNotAllowed(allow)                           // 405, bodiless; null means send no Allow
internalServerError()                             // 500, opaque
```

Every one returns `{ status, headers, body, producer }`, ready for `server.js`.

**There is no single ESI error shape.** Which implementation answers is a property of the route: `GET /latest/universe/systems/abc/` is a `400` with `{"error":"failed to coerce ..."}` and a
`charset=UTF-8` content type, while `GET /latest/characters/abc/` is a `422` with `{"status":422,"error":"validation failed","details":[...]}` and no charset. Universe and static routes are on the
older one; character, corporation and alliance routes have been migrated.

`EDGE` covers refusals made before routing (401, `Invalid tenant`) and is the only family that sends `x-content-type-options: nosniff`.

Key order is part of the bytes: `status`, then `error`, then `details`. So is the last byte: the `LEGACY` family is written by the application and ends where its JSON does, while `VALIDATED` and `EDGE`
are written by Go and end with a newline. A `401` is 45 bytes, not 44. Each family names a `lib/serialize.js` producer rather than appending anything itself.

## `lib/serialize.js`

```js
PRODUCER                     // { GATEWAY, APP, META }
PRODUCER_WIRE                // per-producer { contentType, trailingNewline }
ENVELOPE_KEYS                // ["ok", "apiVersion", "source"]: nexumApi's, never ours
SNAKE_CASE                   // matches all 531 property names in the pinned spec
SerializationError           // thrown at construction, or for an unknown producer

projection(name, fields)     // -> project(record) -> esiShape, field order = wire order
serializeBody(body, producer)// -> Buffer; producer is required, there is no default
contentTypeFor(producer) / producerWire(producer)
numberOrNull(value) / optional(value) / arrayOf(value) / double(value) / isDouble(value) / OMIT
escapeNonAscii(text)
findEnvelopeKeys(body) / findNonSnakeCaseKeys(body)   // after-the-fact probes, tests only
```

There is no single ESI success shape either. A `2XX` is served by whichever implementation owns the route:

```
GET /latest/status/                     application/json                 ...}\n    93 bytes
GET /latest/universe/regions/10000002/  application/json; charset=UTF-8  ...}      270 bytes
```

Go's encoder appends a newline and the application's does not, so the two facts travel together in one `PRODUCER_WIRE` row and `sendJson` takes both from it. `contract/wire.js` `SUCCESS_KIND` is the survey.

A projection is checked at construction: envelope keys and camelCase fail at server start, naming the field, so the request path stays a `JSON.stringify` and a `Buffer.from`. `undefined` from a field reader
throws (`JSON.stringify` would drop the key silently); `OMIT` leaves it out on purpose; `null` is sent as `null`.

`contract/golden.js` holds the recordings: `assertGolden(name, body)` diffs a handler's body against bytes CCP served, after checking the recording against the pinned spec so a stale recording reports itself as
one. `contract/golden/index.json` carries each recording's URL, date and producer, and `findIndexProblems()` cross-checks every file's last byte against the producer it claims.

## `lib/cache.js`

```js
CACHE_POLICY                 // per-producer { cacheControl(ttl), expiresFrom, etag }
CACHE_STATUS
CacheError

cacheHeaders({ producer, payload, cacheTtl, now, lastModified })  // -> the four headers
createCacheDispatch(next, { now })   // adds them to every 2XX with a JSON body
etagFor(payload, producer) / httpDate(date) / windowStart(at, ttlSeconds) / policyFor(producer)
cacheControlFor(...) / sendsCacheStatus(...)
```

Cache behaviour splits by producer:

```
gateway  Cache-Control: public, max-age=<ttl>, must-revalidate, stale-if-error=900
         Expires = Date + ttl              Etag: W/"<sha256>"   weak
app      Cache-Control: public                      (no max-age at all)
         Expires = Last-Modified + ttl     Etag: "<sha224>"     strong
```

On application routes `Expires` is the only freshness signal a client is given, and it can arrive already expired.

`Last-Modified` defaults to the clock floored to the route's TTL. That satisfies the hard requirement of one `Last-Modified` across every page of a paged sweep structurally, with nothing to invalidate. A route with a
real modification time supplies `lastModified` instead.

Cache headers go on 2XX with a JSON body only. A refusal, a bodiless response and `/ping` carry none of the four, as observed. The layer composes inside `lib/cors.js` because the `304` is decided from the `Etag`
computed here, so CORS must be able to see a response this layer has already turned into one.

The `Etag` is a digest of the bytes as written, so the layer serializes and passes the buffer on as `result.payload`, which `sendResult` writes instead of serializing again. That saves a second full pass over an
8000-element array on the game's event loop.

### Conditional requests

```js
isNotModified(request, { etag, lastModified }, producer)   // -> boolean
notModifiedResult(headers, producer)                       // -> { status: 304, headers }
stripWeak(validator)                                       // W/"x" -> "x"
```

Decided in the same layer, because that is where the validators exist, and inside the CORS layer so a `304` carries the CORS headers like any other response.

Neither producer follows RFC 9110 section 13.1.2, and they do not fail the same way:

```
                        gateway   application
  exact etag              304        304
  W/"x" sent for "x"      304        200      weak comparison
  If-None-Match: *        200        304
  "other", "ours"         200        200      neither parses a list
  If-Modified-Since       304        200
```

Reproduced in both directions. Being more correct than ESI is a failure: a client that finds `*` works on a gateway route writes something that stops working against CCP.

The `304`s differ too. The gateway drops both validators and keeps its full `Cache-Control`. The application keeps both and sends bare `public`, which is what its `200` sends. `Expires` is recomputed on both. Neither carries
`Content-Type`, `Content-Length` or a body, and `server.js` omits `content-length` for the statuses that may not have one.

`lib/headers.js`: `withCcpCasing` is applied once in `mergeHeaders`, on the way to the socket, so `Etag` goes out as `Etag` and `X-Pages` and `X-Ratelimit-*` get their spellings without any layer having to remember. A name nobody has
observed is written exactly as given. The table is a record, not a style rule: a generic capitaliser would produce the pinned spec's `ETag`, which is the one CCP does not send.

## `lib/pagination.js`

```js
PAGE_PARAM / MINIMUM_PAGE / MAX_INT32 / DECIMAL_INTEGER / DEFAULT_MAX_SNAPSHOTS

parsePage(query, { family })      // -> { page } | { refusal }
pageCount(total, pageSize)        // never 0: an empty collection is one empty page
slicePage(items, page, pageSize)
snapshotKey(routeName, pathParams, query)   // everything but `page`
createSnapshotCache({ maxEntries })         // window-keyed, LRU-bounded
```

A paginated route declares `pageSize` and `cacheTtl`; the router refuses one without the other at construction. Its handler is asked for the whole collection (the framework slices, so `X-Pages` and the body cannot disagree) and is asked
once per cache window, not once per request.

`market-hub-seed` fails a run over that second property. The collection is resolved once and every page in the window is a slice of that array, so `X-Pages` cannot move mid-sweep. The window is the one `lib/cache.js` floors `Last-Modified`
to, so the snapshot and the header describing it cannot disagree. The cache is bounded by entry count and LRU-evicted: a snapshot is the resolved collection sitting in the game's own heap, and the access pattern is a sweep, one resource at a
time.

It lives in the router rather than a wrapping layer because pagination decides which handler call happens at all.

**Edges.** A page past the end is `404 {"error":"Requested page does not exist!"}`, not an empty array. `?page=0` and `?page=-1` are `400 "<n> does not meet minimum of 1"`. A non-integer is a coercion failure whose message is shorter than the path
form's, with no `, '<name>' is required` clause. An integer is a strict decimal parse, not `Number()`: `+1` and `01` are accepted, `1e3`, `0x2` and a bare space are not.

## `lib/compatibility.js` (D11)

```js
COMPATIBILITY_DATE / OLDEST_SUPPORTED / TODAY_OFFSET_HOURS   // 2020-01-01, 2020-01-01, -11
COMPATIBILITY_DATE_HEADER / COMPATIBILITY_DATE_QUERY / DATE_SPELLING / ERRORS
VARY_ROUTED / VARY_UNROUTED / VARY_EDGE / VARY_LOCALIZED_EXTRA

readCompatibilityDate(request, { now })   // -> { date } | { refusal }
requestedCompatibilityDate(request)
createCompatibilityDispatch(next, { now })
isCalendarDate(value) / todayAt(now, offsetHours)
```

Three classes of value are refused before anything routes, each an `EDGE` refusal: `application/json`, `nosniff`, and a two-line `Vary` with no echo. They carry CORS headers, so this layer sits inside `lib/cors.js` and a browser tool sending a
malformed date sees a readable `400`.

```
nope / 2026-8-1 / 2026-13-01   400  Invalid compatibility date format. Expected YYYY-MM-DD.
2019-12-31                     400  Compatibility date (...) is before the oldest supported date: 2020-01-01.
2026-08-24                     400  Compatibility date (...) is in the future. Current date (UTC-11) is ...
```

`2026-13-01` and `2026-02-30` are format errors: the value must be a real calendar date in that spelling. "Today" is evaluated in UTC-11, eleven hours of slack a UTC comparison would not give.

The echo is attached by the router, not this layer, because it says which surface answered. The unrouted `404` and the `405` carry the `Vary` (routing happened) and not the echo (no route produced them). `Vary` is three lines on a routed response from either producer, with a fourth repeating `Accept-Language` on a route that declares `localizedBody`.

Not implemented, deliberately: a valid in-range date selects a surface and beats the path prefix, so `/latest/sovereignty/map/` with `2026-08-01` is a `404` at CCP. That needs a date-versioned route table; D4 scoped this replica to `2020-01-01`.

## `lib/cors.js`

```js
ALLOW_ORIGIN, EXPOSE_HEADERS, ALLOW_METHODS, MAX_AGE, PREFLIGHT_VARY, PREFLIGHT_STATUS, DEFAULT_ALLOW_HEADERS
EXEMPT_PATHS                 // ["/ping"]: the one path with no CORS at all
PREFLIGHT_TRIGGER            // "access-control-request-method"

isPreflight(request)
corsHeaders()                // -> the two headers every non-exempt response carries
preflightResponse(request)   // -> the 204
createCorsDispatch(next, { exemptPaths } = {})   // -> a dispatch wrapping a dispatch
```

A wrapper, not a route. The preflight does not route (`OPTIONS /nope/` and `OPTIONS /ping` both answer `204`), so it is decided before anything looks at a path. Every layer takes the same shape: `createXDispatch(next)` composed around the router, so
`server.js` keeps its single injected `dispatch`.

The trigger is `Access-Control-Request-Method`, not `Origin`: an `OPTIONS` carrying only an `Origin` gets the ordinary `405`. `Access-Control-Allow-Headers` echoes whatever the client asked for (`*` when it asked nothing), and
`Access-Control-Allow-Methods` is a fixed `GET, POST, PUT, DELETE`: not route-derived, and missing `OPTIONS`, `PATCH` and `HEAD`.

`Access-Control-Allow-Credentials` is never sent; `*` and credentials mode are mutually exclusive.

## `routes/status.js` and `routes/ping.js`

```js
// routes/status.js
createStatusRoute(deps)      // -> the route descriptor for loader.js's table
buildStatus(deps)            // -> the projected body
projectStatus                // GetStatus, in CCP's field order
toEsiTimestamp(value)
STATUS_PATH / CACHE_TTL_SECONDS / RATE_LIMIT_GROUP / PRODUCER / UNKNOWN_BUILD / VIP

// routes/ping.js
createPingDispatch(next)     // answers GET /ping, hands everything else on
PING_BODY / PING_CONTENT_TYPE / PING_PATH
```

`deps` is `{ runtime, startedAt }`, with `runtime` being `lib/runtimeAccess.js` or a double, as in `routes/health.js`, so the endpoint is testable with no eve.js checkout.

There is no `createStatusDispatch`. A routed endpoint gets a route descriptor and nothing else: the version prefix is a dimension of `lib/router.js`, so a standalone entry point would reimplement prefix stripping or 404 the other prefixes. `/_mod/health` keeps
its own dispatch because it is not routed.

`/ping` is deliberately not a route. It carries no CORS, cache, rate-limit or compatibility headers, so `loader.js` composes it ahead of the stack rather than decorating and stripping. A prefixed `/latest/ping` falls through to the router and gets Go's plain-text 404,
which is what CCP gives it. D12 settles `server_version`; see [open-decisions.md](open-decisions.md).

## `loader.js`

Not a module: the `--require` preload entry point. It exports nothing and wires the above:

```
install()
  - globalThis[INSTALL_FLAG] double-preload guard
  - isMainThread guard (worker threads never install)
  - config.loadConfig(): not ok means log why, install nothing, return
  - installModuleHook(context, hooks): wraps Module._load, drives the table from buildHooks()
  - boot banner with MOD_VERSION and shortSourceHash(MOD_DIR)

buildHooks() -> [{ name, match(request, exports), run(exports, context) }]
  each entry fires once, each wrapped in its own try/catch
  match() MUST use exportHas / prototypeHasMethod

gameRuntimeReady hook -> start the armed listeners
  require("./server").startServer({ config, listener, dispatch, log, logError })
  listeners are started from the readiness hook and NEVER from install(),
  which is what keeps the healthcheck process from binding the ports
```

The whole file sits inside one outermost `try/catch`. A throw at preload kills the game server before it boots, and `--require` preloads are not covered by eve.js's secondary-service try/catch.
