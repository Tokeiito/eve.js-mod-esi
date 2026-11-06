# Architecture

## What the mod is

eve.js private servers could in principle use the third-party EVE tools written against CCP's **ESI** REST API and **EVE
SSO** OAuth2 provider: market analysers, fitting tools, industry planners, route planners, killboards, character managers.
eve.js implements neither, so today each tool has to be forked and every ESI call rewritten against a custom API. `eve-nexum`
is the worked example: its `nexumApi` mod exposes a private, custom-shaped API and its server code was rewritten to call it.
That work is per tool and repeats whenever the tool changes upstream.

This mod implements ESI and SSO once, on the server side, faithfully enough that tools cannot tell the difference. A tool's
integration cost becomes changing a few URLs in its configuration.

"1:1" does not mean implementing all of ESI's operations. It means that for the endpoints that exist, an unmodified client cannot
distinguish the replica from CCP. That is three obligations:

1. **The JSON bodies match.** snake_case, exact field names and types, bare arrays and objects with no envelope, down to the last
   byte. ESI is more than one implementation behind one hostname, and the Go gateway ends every body it writes with a newline
   while the application does not, so `GET /latest/status/` is 93 bytes for 92 bytes of JSON.
2. **The HTTP semantics match.** Clients treat headers as protocol. `market-hub-seed` aborts a run if `X-Pages` changes between pages
   or `Last-Modified` differs across a paged sweep, and it sends `If-None-Match` and expects real `304`s. `eve-nexum`'s HTTP client reads
   `x-esi-error-limit-remain` and `-reset` and throttles itself globally when they are missing or low. Polling clients sleep until
   `Expires`; without it they poll in a tight loop against the game's own event loop.
3. **The tokens are real.** Several consumers decode the access token locally. It must be a signed JWT with CCP's claim shape: `sub` as
   `CHARACTER:EVE:<id>`, `aud` as a two-element array ending in `"EVE Online"`, and a JWKS document whose `kid` matches what validators
   have pinned.

### Constraints that shape the design

- **eve.js has no ESI to collide with.** A grep of the vendor `server/src` tree for `esi|oauth|jwks|login.eveonline.com` matches no files.
- **eve.js has no identity system OAuth can sit on.** No browser sessions, no meaningful passwords, no token concept. The only thing that
  unforgeably knows which character a request belongs to is the live game session (see [SSO design](#sso-design)).
- **ESI's contract is date-scoped.** CCP replaced `/v1/` to `/v6/` with an `X-Compatibility-Date` header. Legacy prefixes still resolve and
  pin to `2020-01-01`, and every tool in the ecosystem uses that form, so it is the target (D4).
- **eve.js ids are allocated per entity kind**, while ESI assumes one global id space (D9).
- **There is no world event bus.** Nothing publishes "character undocked" or "asset moved". Every location and asset endpoint is a poll against
  live state.

### Non-goals

- ESI operations no consumer in the ecosystem needs.
- CCP's 2026-era route families (D16).
- Replicating `zkillboard.com` (D15).
- Proxying to real ESI (D13). This serves the private server's own universe.

## Sources of truth

`contract/` is authoritative, and every endpoint starts with a contract test written before its handler. A test written afterwards encodes whatever
the handler already does.

| Source | Authoritative for |
|---|---|
| `contract/spec.js` over the pinned `openapi.json` (D22) | Body keys, required-ness, types, enums, published cache TTL and rate-limit group |
| `contract/wire.js` (D23) | What the spec cannot describe: header names and casing, statuses, literal error strings, observed off live ESI |
| `contract/golden.js` and `contract/golden/` | Whole bodies, kept and compared as bytes |
| `contract/sso.js` | `login.eveonline.com`'s constants, quirks included |

The spec check is closed-world: an undeclared key is a failure. The `2020-01-01` document has no nullable types, so a `null` in a body is a contract
violation. Field declaration order in a `projection()` is output order, and output order is bytes.

`scripts/observe-*.js` settle an unobserved wire fact against live ESI with a real token. They record protocol (field order, byte counts of fixed
strings, omitted fields, statuses) and never payload.

## The layer stack

`lib/pipeline.js` builds the nine layers around the router. The order was established by observing live ESI, and tests call the same builder as
`loader.js`, because a private copy of the order cannot catch a misplaced layer.

```
clock( cors( errorLimit( rateLimit( bearer( tenant( compatibility( requestId( cache( router )))))))))
```

- `clock` stamps one time reading on the request so every layer below agrees.
- `cors` answers the preflight without routing and decorates everything below, refusals included, so a browser can read a refusal.
- The two limiters are siblings. A response carries the error budget's headers or the token bucket's, never both. `groupFor` asks the request rather than
  the path, because a refusal made before routing has no bucket to charge. They sit outside `cache` because a `304` is priced: free on the error limiter,
  one token on the bucket.
- `bearer` is below `cors` (a preflight with a forged token is still a `204`) and above `tenant` and `compatibility` (a bad token beats both of their
  refusals, and beats the unrouted `404` and the `405`).
- `tenant` is outside `compatibility`: with both wrong, CCP answers `Invalid tenant`.
- `requestId` is inside `compatibility`, because a bad-date refusal is the gateway's and carries no request id, and outside `cache`, because a `304` gets its own id.
- `cache` wraps the router because it needs the response to exist before turning it into a `304`.

`/_mod/health` (the mod's own, never ESI's) and `/ping` sit outside the stack. `/ping` carries no CORS, cache or limiter headers, reproduced by never letting
it reach a layer.

## Routes and producers

```js
handler(params, deps) -> data     // or a promise of data
```

A handler never sees `req` or `res` and never requires game code; it asks `deps`. Every endpoint is testable by calling a function with two object literals.

A route's path is written once, canonically: no version prefix, no trailing slash. The nine prefixes (`latest`, `legacy`, `dev`, `v1` to `v6`) are a dimension of
`lib/router.js` and all pin to `2020-01-01`. Writing a prefix into a route's path is a construction error.

Route descriptors carry `scope`, `subject`, `rateLimitGroup`, `cacheTtl`, `successStatus` and `producer`, so the framework is table-driven.

**`producer`** names which implementation behind ESI's one hostname answers the route: `gateway` (Go), `app` (most of the surface), or `meta` (the `/meta/` routes, which
agree with the gateway on content type and newline but carry no `Etag` and no `Last-Modified`). That one fact derives the success content type and trailing newline, the error
shape and status codes, the `Cache-Control` form and what `Expires` measures from, and how a conditional request is answered. `PRODUCER_WIRE` and `lib/cache.js` `CACHE_POLICY`
hold the rows. Nothing derives the producer from the path: `/sovereignty/map/` is the gateway and `/sovereignty/campaigns/` the application, in one rate-limit group.

**`subject`** is compulsory on a scoped route. A scope says the caller may read fleets, not that they may read that fleet. `compileRoute` refuses a scoped route keyed by an
entity that says nothing about who may read it.

An authenticated route on the gateway producer has never been observed, so `assertScope` refuses to compile one. A scoped route that sends JSON is `app`.

## Reaching the game

`lib/runtimeAccess.js` is the only module allowed to require game code, lazily, through a frozen path table (`GAME_MODULES`), so an upstream file move breaks in one place.
`test/runtimeAccess.test.js` stats every path without requiring it. Upstream ships periodic distribution zips with no git history, so internals are assumed to move on every drop.

Every accessor is a pair: `xFromRuntime(module, options)` is pure and injectable, `x(options)` is a one-line wrapper supplying the real module. Every module is requirable and
unit-testable with no eve.js checkout present.

Raw table reads use `gameStore/tableRepository`'s `createTableRepository("mod:esiApi", { strict: true, allowSharedWrites: false })`: reads pass through and writes throw. Ask `gameStore/storeRoot` for paths; never
hardcode them. The backend is `better-sqlite3` for runtime state plus in-memory JSON for SDE-derived tables.

Game exports are inspected only through `lib/exportProbe.js`, which is `hasOwnProperty`-based. Direct property access on a half-built circular-require module hits Node's warning proxy,
which eve.js logs with a full stack and a heap snapshot. A game module that changed shape throws rather than degrades: the drift tests catch it a release earlier, and swallowing it would
report zero forever with nothing saying why.

### Hazards in eve.js

| Hazard | Detail |
|---|---|
| `celestials` is 258 MB | `JSON.parse` on it stalls the universe. Stream, never parse |
| `getAllKillmailRecords()` | Deep-clones every killmail: about 1 s blocked at 100k records, `RangeError` past about 25k fat records |
| `mapTelemetryState.*` | Deep-copies unbounded maps: 1.7 s at 1.5 M entries, then `RangeError` |
| `getCharacterRecord` | Deep-clones and re-derives standings. Use `peekCharacterRecord` |
| `getCorporationSessionRoleState` | Persists a default member record on read (D32) |
| `app` in `server/src/_secondary/express/server.js` | Function-local, and in a forked child rather than the world process, so the existing express app cannot be extended |
| `killTime` | Stored as a Windows FILETIME |

## The loader

`loader.js` is the only file that is not a module. eve.js has no mod system, so a `--require` preload plus one `Module._load` interceptor is the whole attachment mechanism.

- The file is wrapped in try/catch, and every hook `run` in its own, because `--require` preloads are not covered by eve.js's secondary-service try/catch. A throw at preload would kill the
  server. Every failure degrades to "the mod is not running".
- `ESI_MOD_ESI_PORT` and `ESI_MOD_SSO_ISSUER` are the two switches, armed by default on loopback (D47). Blank turns that listener off, and both blank installs nothing. A package nobody enabled
  never loads, because the launcher ships it as `loader.js.disabled`.
- `NODE_OPTIONS` is process-wide, and eve.js forks about five edge processes plus a healthcheck. `isMainThread` keeps the loader out of worker threads. The listeners start from the
  game-runtime-readiness hook, never from `install()`, which keeps the healthcheck from binding the ports out from under the game process.
- `server.unref()` is unconditional: the mod may never keep the game process alive.
- Extension is one entry in `buildHooks()`.

`config.js` never throws and never touches the game's `process.env`. It never calls `process.loadEnvFile()`, which mutates shared state. Layers, lowest first: defaults, `settings.json`, `.env.txt`,
`.env`, real environment. The highest layer that sets a key wins, per key.

## SSO design

The SSO listener owns the root of its own origin (D6). The issuer is a configured absolute URL with an explicit scheme (D7). Reasoning and the EVE client's behaviour are in
[d6-listener-split.md](d6-listener-split.md).

**The grant.** The authorization-code grant rests on the in-game bind code (D3). The authorize page mints an 8-character code from a confusable-free alphabet, valid for 2 minutes, and the player
types `/esi <code>` in game chat. `lib/slashCommandPatch.js` wraps `SlashService.prototype.Handle_SlashCmd` to answer it without modifying the game. A browser can lie about being a given
character; it cannot type into that character's chat window. `ESI_MOD_DEV_AUTO_APPROVE` skips this for tests and refuses to start on a non-loopback SSO bind.

**Clients.** Any `client_id` is accepted, because a tool's id was issued by CCP and cannot be known in advance. A `redirect_uri` must be a loopback address literal or an exact match in the optional
clients file (`ESI_MOD_SSO_CLIENTS_PATH`).

**Durable state.** `<gameStore root>/../sso/` holds `signing-key.pem` (D8), `owner-salt.txt` and `refresh-tokens.jsonl` (D30). Authorization codes live in memory for 60 seconds with a 5-minute tombstone
(D40). Durable state is outside the mod directory, so removing the mod leaves it behind.

**Unchanged identifiers.** `OWNER_DOMAIN` (`evej-esi_sso/owner/v1`, `lib/accessToken.js`) and `STORE_KIND` (`evej-esi_sso.refresh-tokens`, `lib/refreshTokens.js`) carry the project's former name on purpose.
The first is hashed into every `owner` claim, and changing it moves that claim for every character, which clients read as a character transfer. The second is checked when the store is read, and changing
it makes existing stores unreadable.

## Research findings

Observed against live ESI and SSO unless stated otherwise. `contract/wire.js` is the machine-readable record and is what tests assert against.

### Versioning

`/latest/swagger.json` and `/_latest/swagger.json` return `404`. Swagger 2.0 is replaced by OpenAPI 3.1.0 at `GET /meta/openapi.json`.

`X-Compatibility-Date: YYYY-MM-DD` or `?compatibility_date=` selects the surface, and omitted means `2020-01-01`. Legacy prefixes `/latest/`, `/v1/` to `/v6/`, `/dev/` and `/legacy/` resolve to `2020-01-01`;
`/v99/` is a `404`. The response header echoes the newest published date at or before the requested one that changed that route, not the requested date. See D11 for what the replica reproduces.

Every tool in the ecosystem uses `/latest/` plus `?datasource=tranquility`. eve-nexum calls `/latest/`, `/v1/` to `/v5/`, and calls both `/latest/universe/structures/{id}/` and `/v2/universe/structures/{id}/` for
one resource.

### Headers

The gateway 2XX set, with CCP's exact casing:

```
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: Etag, Retry-After, X-Compatibility-Date, X-Esi-Error-Limit-Remain,
  X-Esi-Error-Limit-Reset, X-Pages, X-Ratelimit-Group, X-Ratelimit-Limit, X-Ratelimit-Remaining, X-Ratelimit-Used
Cache-Control: public, max-age=30, must-revalidate, stale-if-error=900
Etag: W/"817faa26..."             weak on cached collections, strong on some others
Expires / Last-Modified           RFC 7231 IMF-fixdate
Vary: X-Tenant                    three SEPARATE header lines, not comma-joined
Vary: Accept-Language
Vary: X-Compatibility-Date
X-Ratelimit-Group / -Limit ("N/15m") / -Remaining / -Used
Content-Language: en
Strict-Transport-Security
X-Esi-Cache-Status
```

- Without `Access-Control-Expose-Headers`, browser tools cannot read `X-Pages` or `Etag`.
- A 2XX from the gateway carries no `X-Esi-Error-Limit-*` headers.
- `Content-Type` has three spellings: `application/json` from the gateway, `application/json; charset=UTF-8` from the application, and `text/plain; charset=utf-8` from Go's `404`.
- `X-Content-Type-Options: nosniff` appears on gateway refusals and unrouted `404`s, and on no 2XX and no application-level error.
- `Last-Modified` is identical across all pages of a paginated resource, and clients use it to detect torn reads.

### Success bodies

A 2XX is served by whichever implementation owns the route, and the two differ in the header and the last byte:

```
GET /latest/status/                      93  application/json                 {"server_version":...}\n
GET /latest/sovereignty/map/                 application/json                 [...]\n
GET /latest/universe/regions/10000002/  270  application/json; charset=UTF-8  {"constellations":...}
GET /latest/alliances/                       application/json; charset=UTF-8  [...]
```

Go's encoder appends a newline to every body it writes (`json.Encoder.Encode`, against `Marshal` and write in the application), and it counts in `Content-Length`. The correlation with `Content-Type` is exact on every
endpoint surveyed, so `lib/serialize.js` keeps them in one row. `GET /characters/{id}/` is the gateway and `POST /characters/affiliation/` the application. `SUCCESS_KIND` in `contract/wire.js` is the survey. The two also send
different limiter headers: the gateway `X-Ratelimit-*`, the application `X-Esi-Error-Limit-*`, never both.

### Errors

The canonical body is `{"error": "..."}`, with optional `status` and `details[]`. Many client libraries read `body.error` on any status of 400 or above.

- `401 {"error":"Unauthorized - No token provided"}` and `{"error":"Unauthorized - Invalid token"}`: exact strings. A `401` is 45 bytes.
- `400 {"error":"Invalid tenant"}`.
- Unrouted paths escape JSON: `404 page not found` as `text/plain`, 19 bytes, Go's default.
- `HEAD /status/` is a `405`.
- Unknown query parameters are ignored, and query parameters are not validated on either family: `?page=abc` on `/universe/system_kills/` is a `200`.

Parameter validation has two shapes on the `2020-01-01` surface, and which one a request gets is a property of the route:

```
GET /latest/universe/systems/abc/   400  {"error":"failed to coerce value 'abc' into type integer
                                           (format: int32), 'system_id' is required"}
                                         Content-Type: application/json; charset=UTF-8
GET /latest/characters/abc/         422  {"status":422,"error":"validation failed",
                                          "details":[{"message":"invalid integer",
                                                      "location":"path.character_id","value":"abc"}]}
                                         Content-Type: application/json
```

`/corporations/` and `/alliances/` behave like `/characters/`, and `/universe/stations/` like `/universe/systems/`. The `404`s differ the same way: `{"error":"Region not found"}` against
`{"status":404,"error":"Not Found"}`. An out-of-range integer fails coercion on a legacy route: `999999999999` overflows `int32`, so it is a `400` rather than a `404`.

### Limiters

- **Error limiter:** 100 errors per 60 seconds, `420 Enhanced Your Calm` on exhaustion, across all routes. `X-Esi-Error-Limit-Remain: 100`, `X-Esi-Error-Limit-Reset: 60`.
- **Token bucket:** per group, cost 2 for 2XX, 1 for 3XX, 5 for 4XX, 0 for 5XX, over a 15-minute floating window, `429` plus `Retry-After`. 32 groups; for example `market-order` 12000/15m, `char-killmail` 30/15m,
  `char-notification` 15/15m.

D39 records how each keys a caller.

### Conditional requests

Neither producer follows RFC 9110 section 13.1.2:

```
                                  gateway   application
  exact etag                        304        304
  W/"x" sent for "x"                304        200      weak comparison
  If-None-Match: *                  200        304
  "other", "ours"                   200        200      neither parses a list
  If-Modified-Since                 304        200
  a validator matching nothing      200        200
```

The gateway's `304` drops both validators (no `Etag`, no `Last-Modified`) and keeps its full `Cache-Control`. The application's keeps both validators and sends bare `public`, which is also what that producer sends on a `200`.
`Expires` is recomputed on both, so it moves forward on every conditional request. Neither sends `Content-Type` or `Content-Length`. `If-Modified-Since` on the gateway is real date comparison: a date before `Last-Modified` is a `200`.

The static-data-backed application routes (`/universe/regions/`, `/universe/types/`, `/universe/categories/`, `/fw/wars/`, the same set that shares one etag) do parse lists and compare weakly; an invented etag is still a `200`. This may be a
cache in front of them, which is inference. It is recorded as `CONDITIONAL_STATIC_DATA_EXCEPTION` in `contract/wire.js`. All of this was established against three gateway routes and three application routes, each probe re-fetching the
current etag first so a rotated validator could not be mistaken for a rule.

Per-route cache TTLs are published as `x-cache-age`: 3600 s on 60 operations, 300 s on 20, 5 s on 9 (location endpoints), and others. Clients poll on `Expires`, so the TTLs matter.

### Pagination

1. `X-Pages` offset: 40 routes, `?page=N`, all pages share `Last-Modified`. A page past the end is `404 {"error":"Requested page does not exist!"}`.
2. From-ID: 4 routes (`last_mail_id`, `from_event`, `from_id`), fixed page size, descending.
3. Cursor: 12 routes, added 2026-08-18. Out of scope for the legacy surface.

### SSO

The discovery document is at `/.well-known/oauth-authorization-server`. Its inconsistencies are reproduced: `issuer` has no trailing slash, `jwks_uri` is `/oauth/jwks` (not under `/v2/`), and `id_token_signing_alg_values_supported` says
`HS256` although access tokens are RS256.

| Endpoint | Method | Notes |
|---|---|---|
| `/v2/oauth/authorize` | GET, 302 | PKCE S256 supported |
| `/v2/oauth/token` | POST form | Basic auth, or `client_id` in the body (PKCE) |
| `/v2/oauth/revoke` | POST form | `200` whether or not the token was valid (RFC 7009) |
| `/v2/oauth/verify` | GET | Bearer required |
| `/oauth/jwks` | GET | Unauthenticated, CORS-open, cacheable |

The token response is `{access_token, token_type:"Bearer", expires_in:1199, refresh_token}` with `Cache-Control: no-store,no-cache`. `token_type` is exactly `"Bearer"`, which several clients string-compare. CCP rotates refresh tokens; the replica does
not (D30).

### JWT claims

The following is CCP's published documentation example, from `docs.esi.evetech.net/docs/sso/validating_eve_jwt.html`. It is not a real character:

```json
{ "scp": ["esi-skills.read_skills.v1"], "jti": "998e12c7-...", "kid": "JWT-Signature-Key",
  "sub": "CHARACTER:EVE:123123", "azp": "my3rdpartyclientid", "tenant": "tranquility",
  "tier": "live", "region": "world", "aud": ["my3rdpartyclientid", "EVE Online"],
  "name": "Some Bloke", "owner": "8PmzCeTKb4VFUDrHLc/AeZXDSWM=", "exp": 1648563218,
  "iat": 1648562018, "iss": "login.eveonline.com" }
```

1. `iss` is the bare hostname, with no scheme or trailing slash, though the discovery document says `https://`. The replica cannot copy this (D7).
2. `aud` is an array of exactly two entries, the second the literal `"EVE Online"`. A single-string `aud` breaks validators.
3. `sub` is parsed by the regex `/CHARACTER:EVE:(\d+)/i`. No other form is emitted.
4. `scp` is an array with more than one scope and a bare string with exactly one. Client code handles the array branch universally.
5. `owner` is standard base64 (with `+`, `/`, `=`), not base64url. It changes on character transfer, and clients use it to invalidate stored tokens.
6. `kid` appears in both the JOSE header and the body. JWKS publishes `kid: "JWT-Signature-Key"`, a literal rather than a thumbprint, and many validators pin it.
7. `exp - iat` is 1200.

72 scopes exist in the current spec. Legacy scopes (`publicData`, `esi-characters.read_bookmarks.v1` and others) are still requested by older tools, so unknown `esi-*` scopes are accepted at authorize rather than refused.

### EVE client behaviour

Read from a decompiled client, build 3396210: `clientRefreshToken/discovery_hacks.py` and `clientRefreshToken/refresher.py`. It is the only consumer that does programmatic discovery, and it decided D6 and D7. Analysis in
[d6-listener-split.md](d6-listener-split.md).

- It derives the discovery URL from the `iss` claim of the token the launcher gave it, supplying `https` if there is no scheme and replacing any path with `/.well-known/oauth-authorization-server/`. The trailing slash is not in CCP's published form.
- It reads only `token_endpoint` from the document, so `iss` and `issuer` are never compared.
- It refreshes with `client_id` from the token's `azp` claim and no secret, and treats an empty `access_token` or `refresh_token` as an error. If discovery fails entirely, it falls back to client id `eveLauncherTQ` and token endpoint
  `https://login.eveonline.com/v2/oauth/token`.
- `esiBaseUrl` from machoNet `globalConfig` is used only by `eve/common/script/util/esiUtils.py`, to build killmail and fleet URLs for copy-to-clipboard. The client makes no ESI request with it. Pointing it at the replica would make "copy
  killmail link" produce a working link and would not put the client on the replica's ESI surface.

### Tool behaviour

| Tool | Endpoints | Base URL configurable? |
|---|---|---|
| `market-hub-seed` | `/markets/prices/`, `/markets/{region}/orders/` | Yes, `--esi-base-url` |
| `market-seederv3` (Rust) | `/latest/markets/prices/` | Yes, TOML `esi_prices_url` |
| `eve-nexum` | `/incursions/`, `/killmails/{id}/{hash}/`, `/status/`, `/universe/systems/{id}/`, paged contacts, and more | Only with the D18 patch |
| Elysian-FitALL V3 | `/latest/killmails/{id}/{hash}/` | No, a module constant |
| EVE game client | `esiBaseUrl` for clipboard links only; SSO refresh via discovery driven by the token's `iss` | Yes, server-controlled |

**`market-hub-seed` is the strictest client.** Its cache client keys on `SHA-256(compatibilityDate + url)`, sends `If-None-Match`, treats `304` as a cache hit, stores `expires`, `last-modified` and `x-pages`, sends `X-Compatibility-Date`, and fails
the run if `x-pages` changes mid-download or `Last-Modified` differs between order pages. It needs no patching. `scripts/market-canary.js` runs it as an acceptance check.

- The `compatibilityDate` in that key is the one the tool sent. `currentCompatibilityDate()` is its own clock shifted to UTC-11, used for both the request header and the hash, and the response header is never read into it. The replica's echo of
  `2020-01-01` therefore cannot invalidate its cache.
- The tool puts `?datasource=tranquility` on every URL and today's date in every request, and both are validated, so getting either rule wrong is a `400` on every request. `test/marketHubSeed.test.js` reproduces its request shape, its `max-age`
  regex and its conditional revalidation against `/status/`.
- A client running ahead of the server across 11:00Z asks for tomorrow and gets a `400`. Real ESI has the same window, and widening it would hide a failure the tool would meet on Tranquility.

**Other CCP hosts in play.** `images.evetech.net` (portraits and type icons, 3 tools, none configurable, D10), the `developers.eveonline.com` static-data zip (configurable in both consumers), `data.everef.net` (configurable), and `zkillboard.com` (D15).

## Known gaps

- **Endpoints not served:** `GET /incursions/`, `GET /killmails/{id}/{hash}/`, `GET /sovereignty/map/`, `GET /universe/system_jumps/`, `GET /universe/system_kills/`, `POST /characters/affiliation/`, and everything else outside the route table. eve-nexum calls these,
  so it does not yet have every call answered.
- **End-to-end acceptance:** a full eve-nexum run against the replica has not been recorded. `market-hub-seed` has its own acceptance run in `scripts/market-canary.js`.
- **Transport:** plain HTTP only. Clients that require `https://` do not work (D14).
- **EVE client:** the server does not set `esiBaseUrl` in machoNet `globalConfig`, and refresh through discovery has not been run with a real client against the replica.
- **Images:** no `images.evetech.net` equivalent (D10).
- **`/meta/openapi.json`** is not served (D17).
- **Unobserved refusals:** alliance, fleet and structure non-member requests answer a logged `500` until captured (D35). A character mismatch on a gateway-producer route is unobserved (D31).
- **Unobserved fields:** `faction_id` is omitted from entity bodies (D37), and the deleted-character `404` is not reproduced (D36).
- **Divergences:** title-granted corporation role bits are missed and nine role bits are dropped (D32). A waypoint set for a browser pilot succeeds silently (D34). Browser pilots are not counted in `players` (D12).
- **Limiter key spelling:** whether `applicationID` is `azp` or a numeric id is unresolved, with no effect on behaviour (D39).
- **Launcher:** a real Add ZIP, Adopt and hosted update have not been run; only the launcher's validators were (D47). `localhost` in the default issuer is untested with real tools under IPv6-first resolution, since listeners are IPv4. Docker users get no update button.
- **Windows key protection:** file-mode bits on the signing key are cosmetic on Windows (D8).
