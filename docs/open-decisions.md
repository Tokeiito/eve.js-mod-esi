# Decision register

`Dnn` references in code and commits point here. Each entry records what was chosen, why, and what was
observed to settle it. Numbers are stable and never reused; D24, D25 and D41 were never assigned.

`<eve.js tree>` means an eve.js checkout. "Design constraint" refers to the list in `CONTRIBUTING.md`: (1) no modification
of the eve.js vendor tree, (2) the mod must never take the game server down, (3) fidelity beats hygiene.

Measurements quoted from "the measured install" come from one eve.js install's own tables and static-data
dump. They are aggregate counts and name no player.

## Settled

### D1: Transport

**Choice.** Own hostname, plain HTTP: `http://<host>:26005` for ESI, `:26006` for SSO.

**Rationale.** Simplest to build and debug. The market tools (`market-hub-seed`, `market-seederv3`) are
already URL-configurable and need no patching. TLS is deferred, not rejected (D14). D47 supersedes the
opt-in half of this entry: both listeners are armed by default.

### D2: First acceptance target

**Choice.** An unmodified eve-nexum checkout, with the single configurability patch from D18.

**Rationale.** The acceptance test is that upstream runs against the replica with only URL configuration
changed. It exercises the whole stack, SSO included, rather than just the public read path.

### D3: Identity mechanism

**Choice.** The in-game bind code (the `nexumApi` flow) is the real grant, plus a config-gated development
auto-approve.

**Rationale.** The game session is the only unforgeable source of character identity. Auto-approve keeps
automated tests from needing a live session and is never the default.

### D4: Compatibility surface

**Choice.** Legacy `2020-01-01`, served under `/latest/` and `/v1/` to `/v6/`.

**Rationale.** Every tool in the ecosystem uses `/latest/` with `?datasource=tranquility`. The 2026-era route
families and cursor pagination are out of scope.

### D5: Vendor tree

**Choice.** Zero modifications, enforced.

**Rationale.** Design constraint 1. Deleting `mods/<name>/` must remove the mod completely. Durable SSO state
(D8, D30) lives outside the mod directory on purpose and is left behind.

### D6: One listener or two for ESI and SSO

**Choice.** Two listeners on two ports: ESI `26005`, SSO `26006`, each owning the root of its own origin.

**Rationale.** The EVE client derives its discovery URL from a token's `iss` by discarding the path and asking
the origin root, so an SSO surface behind a path prefix is unreachable whatever `iss` says. That leaves "its
own port" or "the ESI port's root". Two ports keep the ESI error limiter off token traffic, keep `oauth` out
of the router's version-prefix namespace, and map onto `esi.<host>` and `login.<host>` if D14 brings TLS. D1
had already assigned both ports. Full reasoning in [d6-listener-split.md](d6-listener-split.md).

### D7: The `iss` value

**Choice.** An absolute URL with an explicit scheme, no trailing slash and no path (`http://<host>:26006`). The
discovery document's `issuer` is the identical string. It is configuration, not derivation, and must hold its
intended final value before the first token is signed.

**Rationale.** CCP emits a bare hostname and relies on the client supplying `https`. Under D1's plain HTTP that
is unusable: `host.local:26006` parses as scheme `host.local`, and `host.local` loses the port and is fetched
over `https`. A configured issuer means the first reverse proxy or certificate is not a breaking change: the
operator names the endpoint they intend to keep and the transport can move underneath it. D47 adds a fixed
default, `http://localhost:26006`; the objection to deriving the issuer stands.

### D8: Where the RSA signing key lives, and its lifecycle

**Choice.**

- Persisted at `<gameStore root>/../sso/signing-key.pem`, a derived sibling of the store root beside `sde/` and
  `market/`, never hardcoded.
- An unencrypted PKCS#8 PEM holding the private half of a 2048-bit RSA key, created on first run with `O_EXCL`
  and mode `0o600`. Its path and public RFC 7638 thumbprint are logged; its private half never is.
- `ESI_MOD_SIGNING_KEY_PATH` overrides the location. Nothing overrides the lifecycle.
- `kid` is CCP's literal `JWT-Signature-Key` and there is exactly one signing slot, so rotation is a deliberate,
  operator-driven break rather than an overlap window. The overlap that survives a rotation is the access
  token's lifetime, not the key set's.
- The JWKS is an ordered array, active key first, and `lib/signingKey.js` returns a key set accordingly.
- A key file that exists and cannot be used (truncated, wrong algorithm, modulus below 2048 bits, unreadable) is
  a refusal to serve SSO, never a silent regeneration.

**Rationale.**

*Location.* Outside the mod directory is necessary, because `<eve.js tree>/mods/esiApi/` is a copy that
`scripts/deploy-mod.js` replaces wholesale (D21). It is not sufficient: a container is rebuilt on every image
change, so the only place a key survives both a redeploy and a rebuild is the volume the store root already
sits in. Deriving from `gameStore/storeRoot` puts it there in every layout, the same argument as
`sdeRootFromGameStoreRoot` and `marketDbPathFromGameStoreRoot`. That neighbourhood is also the ceiling on the
key's protection: anything that can read it can already read every character record, so equal protection with
the game's own data is the target.

*Permissions.* On POSIX `0o600` is set through the `open` mode rather than a later `chmod`, so the key is never
briefly world-readable. On Windows Node maps a mode onto the read-only attribute and nothing else, so the bits
are cosmetic; `node:fs` cannot set an ACL, and shelling out to `icacls` from inside the game process at boot is
worse than the exposure it would close. The code states this.

*Format.* PKCS#8 rather than PKCS#1 because it tags its algorithm, so the filename survives an algorithm change
and an operator-supplied `openssl genpkey` key drops straight in. Unencrypted because a passphrase readable by
an unattended boot would live in `.env` on the same disk.

*The `kid`.* The obvious rotation story does not work. A token minted by the outgoing key carries
`kid: "JWT-Signature-Key"` in its JWS header. Giving the incoming key that literal and the outgoing key another
makes every `kid`-selecting validator (`jose`, `python-jose`, `jwks-rsa`) pick the new key for an old token and
fail, with both keys published. Reversing it defers the break and turns one break into two, since the incoming
key must eventually be renamed. Publishing both under one `kid` is worse: `jose` throws
`JWKSMultipleMatchingKeys` and fails closed. A pinned literal `kid` and a same-algorithm overlap window are
mutually exclusive, and this decision keeps the literal (design constraint 3).

That is affordable because refresh tokens are opaque and stored rather than signed by this key, so a rotation
costs a client one failed request and one refresh, not a re-authorisation. It is correct because the failure
that forces a rotation is a leaked key, and for that an overlap window keeps the attacker's forged tokens valid
for as long as the honest ones. Scheduled rotation of a key that never leaves the host buys a single-operator
server little and costs the whole break, so it is not scheduled.

The array shape stays because `{"keys": [...]}` is RFC 7517's shape and what every library parses, and because
an algorithm migration is the one overlap a pinned `kid` still permits: `jose` and python-jose narrow candidates
by `alg`/`kty` as well as `kid`. `jwks-rsa` does not, so even that is partial. `signingJwks` drops any entry
repeating an already-published `kid`, so the fail-closed state cannot reach the wire.

*Corrupt files.* Silent regeneration would kill every token in use, report a normal start, and destroy the
truncated file, which is the only recoverable state. The remedy is a deliberate `mv` by an operator who has read
the message, the same gesture as a rotation on purpose. The throw is safe because the SSO listener's startup
catches it and declines to serve SSO, which satisfies design constraint 2.

### D9: ID resolution order for `POST /universe/names/`

**Choice.** There is no order, because no id is claimed by two categories, and the index checks that per id.
`lib/nameIndex.js` tests the claim as it inserts each entry and raises `AmbiguousIdError` if two categories
claim one id. An ambiguous id is omitted from the response and logged, never resolved by picking a winner. The
check is per id and not per range: `corporation` is allocated from two bands, CCP's NPC corporations at
1,000,00x and eve.js's player corporations from 98,000,000, so that one category's lowest and highest ids
enclose `agent`, `region`, `constellation` and `solar_system` entirely. A range check would refuse to resolve
most of New Eden.

**Rationale.** The premise that eve.js's per-kind allocation causes collisions does not hold. Measured against
the install's tables and dump:

| Category | Range | Rows |
|---|---|---|
| `inventory_type` | 2 to 371,027 | 52,590 |
| `faction` | 500,001 to 500,029 | |
| NPC `corporation` | 1,000,001 to 1,000,441 | |
| `agent` | 3,008,416 to 3,020,257 | 10,941 |
| `region` | 10,000,001 to 19,000,001 | |
| `constellation` | 20,000,001 to 26,000,001 | |
| `solar_system` | 30,000,001 to 36,000,001 | |
| `station` | 60,000,004 to 60,015,262 | |

The three ranges eve.js allocates into are declared upstream: player corporations from 98,000,000 and alliances
from 99,000,000 (`services/corporation/corporationIdRanges.js`), characters from 140,000,001
(`services/_shared/identityAllocator.js` `CHARACTER_ID_FLOOR`). Each sits in a gap between CCP's bands, and
`routes/entities.js` relies on the same fact for D36.

A fixed precedence (the `nexumApi` precedent: character, then corporation, then alliance) would answer a
question this data does not ask, and would hide the one case that matters: two categories colliding means the
install's id space is broken, and mislabelling an entity would surface as wrong names rather than an error. The
cost is an id absent from the response, which is what the endpoint already does for an unknown id, and eve-nexum
tolerates it by falling back to raw ids. The two eve.js bands that could grow into their neighbours
(corporations into 99,000,000 after a million of them, alliances into 140,000,001 after forty-one million) are
upstream's design; the assertion makes either visible on the day it happens.

### D11: How `X-Compatibility-Date` is handled

**Choice.** Echo `2020-01-01` on every response a route produced, and validate what the client sends. A malformed
date, one before `2020-01-01`, and one after today in UTC-11 are each a `400` edge refusal with CCP's exact
message. An absent or empty header is no opinion. `Vary` is three lines on a routed response from either producer,
a fourth repeating `Accept-Language` on a route whose body carries translated text (`localizedBody`, surveyed across eighteen routes in `contract/wire.js`
`VARY_LOCALIZED_BODY`), and two lines on the refusal itself.

The query parameter `?compatibility_date=` is validated identically, with the same three refusals and messages,
and it wins outright: a bad header with a good query parameter is a `200`, and a good header does not rescue a
bad query parameter. An empty value on either is absent, so an empty query parameter hands the question back to
the header.

**Rationale.** ESI does echo `2020-01-01` on `/latest/` whatever is asked for, but the header is validated, and
three classes of value are refused before anything routes. Those refusals are cheap, exactly observable, and
easy for a client to hit by accident, so they are reproduced. Surface selection is not reproduced: a valid
in-range date picks a surface and beats the path prefix, so `/latest/sovereignty/map/` with `2026-08-01` is a
`404` at CCP because that route does not exist on the modern surface. That needs a date-versioned route table
and D4 scoped this replica to `2020-01-01`, so an in-range date is served from the one surface there is. The echo
appears exactly when a route answered: the unrouted `404` and the `405` carry the `Vary` (routing happened) and
not the echo.

### D12: What `/status/` reports on a private server

**Choice.**

- `players` is the game's live session count.
- `server_version` is CCP's static-data build number: the `<build>` in the `eve-online-static-data-<build>-jsonl`
  directory `CreateDatabase.bat` extracted (`"3396210"` on the measured install), and `"0"` when no dump can be
  read.
- `vip` is always `false`.
- `start_time` is when the listener came up, which for a preloaded mod is the game process's own start.

**Rationale.** The build number is the only candidate that is both well-formed and informative. eve.js's own
version is semver, and `server_version` is never semver on real ESI (it is a seven-digit build), so a tool that
parses or compares it sees something malformed. A synthetic constant is well-formed and information-free. CCP's
build number answers the question the field asks, which universe this is, and two replicas built from different
dumps report different values, as TQ's would.

`players` counts connected clients as CCP's does, with two limits recorded on the accessor: a browser pilot holds
a control lease rather than a session and is not counted, and a client in character selection is. A runtime that
is not up yet reports `0`, which is true during eve.js's two-minute boot. The session registry having changed
shape throws and becomes a logged `500`, because "nobody is connected" and "upstream moved" must not be the same
answer.

### D13: Does the replica ever proxy to real ESI as a fallback?

**Choice.** No, on any route, under any configuration. A universe id this server does not know is a `404` from
this server.

**Rationale.** First, the ids are not the same universe: a private server's stations, structures and characters
are its operator's, and CCP's `60003760` is not this server's `60003760`, so a fallback would answer some ids out
of New Eden and some out of the local game with no way to tell which. Second, a fallback leaks: every `404`
becomes a query to CCP naming what somebody looked up on a private server. Third, it makes correctness depend on
Tranquility being up, on the mod holding a client id, and on CCP's rate limits. The static half of the surface
needs no fallback: the SDE-derived tables and the extracted dump are CCP's static data, which is what makes the
star and constellation recordings byte-exact. Where local data cannot answer, D42 refuses loudly.

### D18: eve-nexum configurability

**Choice.** Patch it. Add `ESI_BASE`, `SSO_BASE`, `IMAGES_BASE` and `SDE_URL` server-side, `VITE_ESI_BASE` and
`VITE_IMG_BASE` for the bundle, and template the nginx CSP origins.

**Rationale.** Vanilla eve-nexum has no configurable base URLs: 24 hardcoded server-side ESI literals, 5 in the
browser bundle, 3 SSO literals, and an nginx CSP pinning `connect-src https://esi.evetech.net`, with only
`API_PORT` in the envsubst filter. This resolves the conflict between D1 and D2 in favour of keeping plain HTTP.
All defaults remain CCP's values, so an unconfigured deployment behaves identically, and the patch is written to
be upstreamable. The acceptance target is therefore upstream plus one patch rather than strictly vanilla.

### D19: How the patch is held

**Choice.** A private fork of eve-nexum mirroring a vendor-import model: a pristine upstream branch that is only
ever imported into, and a main branch made of upstream plus the patches replayed on top, with one bookmark branch
per patch inside that linear history.

**Rationale.** Upstream moves. A merge-based fork accumulates an unresolvable diff. A replayed patch stack keeps
each patch reviewable in isolation, and retiring a patch once upstream accepts it is a one-line change to the
fork's patch list.

### D20: Source-repo tooling versus the deployable mod

**Choice.** Separate them with a release step. The source repository may carry whatever tooling is useful
(`package.json`, lint, formatters, editor config). The artifact that lands in `<eve.js tree>/mods/esiApi/` is produced by
a release step (`scripts/deploy-mod.js`, `scripts/build-release.js`) and depends on nothing.

**Rationale.** D5 requires that deleting `mods/<name>/` removes the mod completely, and a development
`package.json` beside eve.js's own undermines that. Separating the two makes the constraint a property of the
artifact.

### D21: How the mod reaches `<eve.js tree>/mods/esiApi/`

**Choice.** A copy, built by `scripts/deploy-mod.js`, not a junction. Drift is detected rather than prevented:
`--check` on demand, `test/deployDrift.test.js` in the ordinary suite, and `sourceHash` on `/_mod/health` for the
running process.

**Rationale.** A junction would make divergence structurally impossible, and it does not work. Node resolves a
link to its real path without `--preserve-symlinks`, which neither eve.js launcher passes, so `__dirname` would be
the source repo: `lib/runtimeAccess.js` would walk upward from there, find no eve.js tree, and the mod would load,
report itself active, and reach no game state. `EVEJS_REPO_ROOT` works around that. Nothing works around the second
problem: `config.js` reads `.env` beside itself, so through a junction the game server's configuration, including
the path to its signing key, would live in the source working tree, shared by every server linked at it. See
[deployment.md](deployment.md).

### D22: How CCP's contract is pinned

**Choice.** A normalized copy of the `2020-01-01` OpenAPI document in `contract/`, written only by
`scripts/pin-spec.js`. The default fetch of `GET /meta/openapi.json` (no `X-Compatibility-Date`) is D4's legacy
surface, so nothing has to project one surface onto another. It is stored pretty-printed with sorted keys, and
`contract/provenance.json` carries the source URL, retrieval date, compatibility date and the SHA-256 of the raw
bytes as served.

**Rationale.** The spec is compatibility-date scoped like every other route, and `info.version` says which surface
you have. A fetch at a modern date is a different document that is missing `/sovereignty/map`, so pinning the
default is the only correct fetch. Pinning keeps `node --test` offline and hermetic: a test that reaches CCP fails
for reasons unrelated to the code and stops failing when CCP moves. CCP serves 464 KB on one line, so a verbatim
copy makes every re-pin an unreadable diff; normalizing gives a reviewable diff and the raw hash keeps the
normalization checkable. `pin-spec.js` refuses to write if `info.version` is not `2020-01-01`, so a change to CCP's
default is a loud failure rather than a silent change of contract.

### D23: Which source wins when the spec and observed behaviour disagree

**Choice.** Layered by domain. The spec is authoritative for the body's possibility space (field names, types,
required versus optional) and for the numbers it publishes (`x-cache-age`, `x-rate-limit`). Observation is
authoritative for everything a client can see about the response carrying that body: header names and casing,
`Vary` as separate lines, content types, statuses for paths the spec omits, byte-exact non-JSON bodies, literal
error strings. Where the two overlap and disagree, observation wins and the disagreement is written into
`contract/wire.js` beside the request that establishes it. Observations are recorded as hand-written protocol
constants with a date, never as a corpus of recorded responses.

**Rationale.** A single observation shows what happened once and cannot distinguish "optional and absent" from
"required", which is the distinction that breaks clients; the pinned surface declares no nullable field anywhere.
OpenAPI has no vocabulary for header casing or repeated `Vary`, and CCP's document does not contain `/ping` at all.
The disagreements are real: the spec calls the header `ETag` and CCP sends `Etag`. Constants rather than a fixture
corpus keep character data out of the repository and the suite off the network. `contract/spec.js` and
`contract/wire.js` do not import one another, so every assertion declares which source it stands on.

### D26: Which tenant a private server advertises

**Choice.** `tranquility`, CCP's, with no configuration knob. `?datasource=` and `X-Tenant:` both carry it, the
query parameter wins over the header, the comparison is case-insensitive, and an empty value on either is absent.
Anything else is `400 {"error":"Invalid tenant"}`, an edge refusal made before routing and before the compatibility
date, carrying the CORS pair, `nosniff`, the error-limit pair and no `Vary` at all. `GET /meta/compatibility-dates`
publishes the one surface this replica serves.

**Rationale.** The alternative was the server's own name. Observation settles it: the set of valid datasources is
shrinking (`singularity` was valid for a decade and is now a `400`), so a replica answering to its own name would be
differently shaped from CCP rather than more permissive. Every client library carrying a datasource enum would need
a case for it, and every tool that hardcodes `?datasource=tranquility` (D4: all of them) would be refused. A knob is
worse: the only value that works is the default, so its whole range of effect is turning every consumer off. What
is lost is telling two replicas apart by datasource, which nothing asks for; `/status/`'s `server_version` answers
that (D12).

### D27: What `Content-Language` says, and what `Accept-Language` buys

**Choice.** Read the preference, answer `en`, never echo. The eight-value enum is the spec's, on all 197 operations.
A value outside it is read as no preference rather than refused, and `?language=`, which this surface does not
declare, is read as well so a tool written against 2017-era ESI is not answered in something else.
`Content-Language: en` goes on every routed 2XX.

**Rationale.** `Vary: Accept-Language` claims the answer depends on a header, and a response that never says what it
settled on leaves a cache keyed on something the client cannot read back, so the header is owed once the `Vary` is
sent. Echoing `de` would be a claim about the payload: eve.js's static data is English, and a client rendering "German"
has no way to discover otherwise. Design constraint 3 does not license a false statement about the bytes. What CCP answers
a non-`en` request is also unobserved. `lib/language.js` keeps the served set as a list, so a second language is one
edit.

### D28: Which of CCP's infrastructure headers the replica reproduces

**Choice.** `X-Esi-Cache-Status` and `X-Esi-Request-Id`: yes. `Strict-Transport-Security`: not until TLS.
`Warning: 199`: nothing to warn about. The cache status is derived from the one server-side cache this replica has,
the paginated snapshot store, so a page served out of it is `HIT` and everything else is `MISS`. The request id is a
UUID per response, on the application's responses only, including its `304`s and `404`s.

**Rationale.** Both headers are on every 2XX CCP sends, and a header diff counts a missing name exactly as it counts
an invented one. Deriving the cache status from the snapshot store reports a worse hit rate than CCP's, and the true
one. Reporting `HIT` because the response would have been identical inside the window describes the window rather
than the cache. HSTS is a promise about `https` and D1 answers on plain HTTP, so a browser told to upgrade would stop
reaching the replica; it arrives with D14. `Warning: 199` is CCP's retired deprecation channel and nothing here is
deprecated.

### D29: How the replica reads the market order book

**Choice.** Read the market daemon's `market.sqlite` directly, read-only, resolved as a sibling of the game store
root. `lib/marketStore.js` is the only module that touches it, opens it with `readOnly: true`, and treats an absent
database as an empty market with a reason rather than an error. The four ESI order fields the seeded tables do not
carry (`order_id`, `duration`, `min_volume`, `range`) are synthesised there, and `order_id` deterministically from
`(station_id, type_id)`, which is unique across all 970,571 seeded rows.

**Rationale.** The daemon's RPC `GetOrders` takes `{region_id, type_id}`, per type, so a region sweep is 52,590 calls
on the event loop the universe ticks on, which design constraint 2 rules out. A region-wide RPC in the daemon is the
clean fix and D5 forbids it. That leaves the file the daemon already writes, with the region indexes it already
maintains: one query, about 198 ms for The Forge's 79,147 orders, amortised across a 300-second window by the page
snapshot.

The cost is a new kind of coupling: every other reach into the game goes through a game module via
`lib/runtimeAccess.js`, and this is a sibling service's private storage. It is confined to one module, and the schema
is transcribed once in `test/marketFixture.js` so the mapping is testable without a daemon. A fixture cannot notice the
daemon renaming a column, so `test/marketSchemaDrift.test.js` compares against a real database when `ESI_MOD_MARKET_DB`
names one, and skips otherwise.

`services/market/marketState.js` looks like the source and is not: its `getOrders` fabricates two orders from
`basePrice * 1.08` and `* 1.12`, so a replica built on it would serve two synthetic orders per type and look correct.

### D30: Refresh token rotation, and where the store lives

**Choice.**

- No rotation. A refresh returns the same `refresh_token` it was given; the record's `lastUsedAt` and refresh count
  change.
- The grant lives in `<gameStore root>/../sso/refresh-tokens.jsonl`, the signing key's sibling, derived through
  `lib/runtimeAccess.js`, never hardcoded. There is no file-level override; `ESI_MOD_SSO_STATE_DIR` moves the whole
  directory.
- The format is JSON Lines rewritten whole on every mutation through a temp file, `fsync` and `rename`, synchronously,
  mode `0o600`.
- Records are keyed by an unkeyed SHA-256 of the token. The token itself is written nowhere.
- A revoked record is kept, marked, for 30 days from its revocation and then pruned.
- A live grant never expires on a clock. It is capped at 8 per `(character, client)`, where the ninth retires the least
  recently used as `superseded`, and at a global 4,096 the store refuses to issue rather than evicting.
- A store file that exists and cannot be parsed is a refusal to serve SSO, never a silent fresh start.
- An optional `scope` on refresh may narrow the granted set and never widen it. A set that is not a subset is a refusal
  (`invalid_scope`), not a silent intersection, and the narrowing applies to that refresh only.

**Rationale.**

*No rotation.* The failure modes are asymmetric. A client that mishandles a rotated token is locked out with nothing a
user can diagnose, and the only recovery is a human in the game client typing a bind code (D3) for every tool. A stolen
token is a smaller risk on a private server where an attacker who can read the game store already has more than a
refresh token. The ecosystem's tools are old and varied, and the EVE client itself refuses an empty `refresh_token`, so
this population does not reliably persist a rotated one. Rotation buys theft detection, not containment: revocation does
not depend on it.

*Reopening condition.* This is a property of a single-operator private server on a trusted LAN. It reopens if D14 puts
the replica on a network the operator does not control, if a deployment gains users outside the operator's trusted
circle, or if a real token theft happens and the absent alarm is what let it run. Turning it on is one edit: every record
already carries a `family` (a lineage id, constant across a rotation) and a `generation` (0 on every record), and the
`superseded` state already exists, is already an outcome `refresh` answers with, and is already pruned.

*Location.* D8's argument, plus the fact that a read-only mod mount makes the signing key's sibling the only writable
place that also survives a redeploy (D21). The key has a file override so an operator can supply their own key; nobody
supplies their own token store.

*Full rewrite rather than an append-only log.* Writes are rare (one per authorisation, revocation or refresh) and reads
never touch the file after startup, which removes the log's only advantage. A compactor would be a second writer of a
credential file, and a log has to distinguish a benign truncated tail from real corruption on evidence that cannot tell
them apart. A rename is atomic, so that state never exists. The price is O(n) bytes per write, bounded by the cap at about
a megabyte and a few kilobytes in practice.

*Synchronous.* With a full-rewrite format two interleaved writes are a silent data loss: the loser serialises the
pre-mutation store and the second rename deletes a token nobody knows is gone. A synchronous write makes the map mutation
and the file rewrite one indivisible step. The cost is a serialise, a write, an `fsync` and a `rename` on the game's event
loop per login or refresh (design constraint 2). The `fsync` is deliberate: without it a power loss can make the rename
durable and the bytes not, which loses every grant rather than the last one. Two limits: the directory is not synced, and
there is no lock. `loader.js` guarantees exactly one process binds the SSO listener, so there is one writer by construction;
if that stops holding, this needs a lock.

*Hashing.* A copy of the file is a list of who authorised what rather than a set of working credentials, which matters
because a store plausibly reaches a backup or a bug report. Unkeyed and unsalted because a 256-bit random string has no
dictionary to defend, and because a keyed hash would put a secret into the refresh token's validation path, which D8 must
not have.

*Corrupt store.* Refused for D8's reason. Starting empty logs every client out, reports a normal startup, and destroys the
damaged file. Logging in again means a human at the game client for every tool (D3), which is worse than a refusal a human
can read and clear with one `mv`.

*Bounds.* `lib/authCodes.js` concluded that a pruned tombstone downgrades `already_used` to `unknown`, which is still a
refusal, and RFC 6749 section 5.2 makes both `invalid_grant`, so what is lost is an operational story and not a security
property. A 60-second code needs 5 minutes of memory while a token with no expiry can be replayed months later, which is
what 30 days is measured against. The live caps differ because issuing is gated behind an in-game bind (D3). The global cap
is a backstop: it refuses rather than evicting because evicting a live refresh token logs a working client out permanently,
and it is not self-healing, so reaching it is an operator fact to look at. The per-subject cap is self-healing and covers the
realistic fill path, one tool re-authorising repeatedly. There is no idle expiry, because CCP publishes none (a divergence a
client cannot discover, design constraint 3) and it would log out the monthly job and the laptop that was shut.

*D8 is unaffected.* Nothing in the store depends on the signing key. `lib/refreshTokens.js` requires only `node:crypto`,
`node:fs` and `node:path`, and `test/refreshTokens.test.js` asserts both mechanically, so a key rotation still costs a client
one failed request and one refresh.

### D31: What a missing scope and a character mismatch answer

**Choice.** Settled on 2026-08-24 by observation.

- A missing scope is a `401`, not a `403`, with a third wording that names the scope:
  `{"error":"Unauthorized - Token is not valid for any required scope: <scope>"}`, in the gateway's `EDGE` bytes.
- The `403` belongs to a character mismatch: `{"error":"Character ID mismatch between request path and auth token"}`. It is
  the application's refusal: `application/json; charset=UTF-8`, no trailing newline, no `nosniff`, and it carries
  `X-Esi-Request-Id`, `X-Esi-Cache-Status` and the compatibility-date echo. It derives its family from the route the way a
  `404` does.

`contract/wire.js` `SCOPE_REFUSAL` and `CHARACTER_MISMATCH` hold both. `lib/errors.js` has `unauthorizedScope()` and
`characterMismatch()`.

**Rationale.** The working assumption was that a missing scope must be a `403`. A guess would have been wrong in status,
family, producer, content-type, last byte, and the condition it was attached to. eve-nexum's source comment says
`401 = token invalid/no scopes, 403 = token valid but scope missing`, which also has the rule backwards. A token with no
scopes and a token with a different scope produce byte-identical `401`s, so the two cases eve-nexum distinguishes are one
case. The capture needs an application, one browser click and two requests: `scripts/observe-403.js`.

**Still derived, not seen.** The `403` was observed on a `LEGACY` route only. What a gateway-producer route says for the same
mistake follows from `ERROR_FAMILY` and has not been read off a wire. `characterMismatch()` therefore throws for `VALIDATED`
rather than deriving it, and `CHARACTER_MISMATCH.familyIsDerived` records the inference.

### D32: What `GET /characters/{character_id}/roles/` answers on a private server

**Choice.** A faithful decomposition of eve.js's own mask, and only of the bits whose ESI name was read rather than matched.

- eve.js keeps CCP's 64-bit corporation-role vocabulary on a corp-membership record, not on the character:
  `runtime.members[String(characterID)]`, masks persisted as decimal strings
  (`services/corporation/corporationRuntimeState.js:392-443`, `roles: roleMask.toString()` at `:415`). They must be parsed as
  `BigInt`, because `FULL_ADMIN_ROLE_MASK` is about a thousand times `Number.MAX_SAFE_INTEGER`.
- The four ESI arrays are the four eve.js fields: `roles` from the admin mask, `roles_at_hq`, `roles_at_base` and
  `roles_at_other` from the three locational masks. No field is invented and none is merged.
- The bit-to-name table is the mod's own. eve.js has no display-name table for a role bit, and `CORP_ROLE_STATION_MANAGER`
  (`:49`) is not exported, while `ALL_CORPORATION_ROLE_MASK` (`:85-99`) is. A drift test asserts every named bit is a member of
  that exported mask and that the named-plus-unnamed sets account for all 55 bits.
- A set bit whose ESI name was arrived at by elimination is dropped, not emitted under a plausible name, alongside the bits
  with no name at all. There are 55 eve.js bits against 54 ESI names, so at least one bit maps to nothing, and nothing says which.
- The read is `getCorporationMember` plus `getCorporationRecord`, never `getCorporationSessionRoleState` (`:1721`), because that
  accessor's first line is `ensureCharacterMemberState` (`:1572-1585`), which calls `updateCorporationRuntime` and persists a
  default member record. A read endpoint must not write into the game.
- The cost is that title-granted role bits are missed: `getEffectiveMemberRoleMask` (`:1614`), which ORs them in, is absent from
  `module.exports` (`:1837`), and re-deriving the title OR would be a copy of vendor logic that drifts silently. This is a recorded
  divergence.

**Rationale.** The mask is CCP's own, and its locational/admin split is ESI's `roles` versus `roles_at_*` split, so decomposition
beats synthesising `["Director"]`, a CEO heuristic, or an empty answer, all of which discard state the game holds.

46 of the 55 bits carry an eve.js constant that is the ESI name (`CORP_ROLE_DIRECTOR`, `CORP_ROLE_STATION_MANAGER`,
`Hangar_Take_1..7`, `Account_Take_1..7` and the rest); those are readings. Of the other nine, five have an eve.js name near an
unassigned ESI name (`CORP_ROLE_CHAT_MANAGER` and `Communications_Officer`, `ROLE_FACTORY_MANUFACTURING` and
`Rent_Factory_Facility`, and three more), and four have no corporation-role name in the vendor tree. Emitting the five as marked
inferences is refused on arithmetic: nine bits compete for eight remaining names, so at least one is wrong, and `roles[]` is a
capability list a client acts on. Under-reporting a capability is the direction this replica already chose when `last_login` and
`logins` were omitted rather than invented (`routes/characters.js`, `contract/wire.js` `CHARACTER_LOCATION.unavailableFromGame`).
`Director` (bit 0) and `Station_Manager` (bit 11) are both in the read set.

**Hazard.** `services/account/accountRoleProfiles.js` declares a different 64-bit namespace over the same numeric values:
`9007199254740992` is `ROLE_GMH` there and an unnamed corporation bit here, and `2251799813685248` is `ROLE_PROGRAMMER` there and
`ROLE_FACTORY_SCIENCE` in industry's table. A lookup that reached the wrong module would publish a GM flag as a corporation role.
Membership in the exported `ALL_CORPORATION_ROLE_MASK` is what keeps the two apart mechanically.

### D33: What `/contacts/`'s `standing` does with a value outside -10..10

**Choice.** Clamp to -10..10, using eve.js's own clamp rather than a constant of ours, and emit the row. No rounding.

- eve.js stores contact standing as `relationshipID`, an unclamped integer: `normalizeInteger` is `Math.trunc(Number(...))` with a
  fallback and no bounds (`services/character/charMgrService.js:93-100`), applied at `:146`. The corporation and alliance write paths
  pass the same function's output through (`services/corporation/corpRegistryRuntime.js:1917`,
  `services/corporation/allianceRegistryRuntime.js:731`). Nothing on the three contacts paths enforces a range.
- The pinned document does not either: `standing` is a required `number`/`double` with no `minimum` and no `maximum`.
- The bound comes from eve.js, which clamps this field at its only value-consuming read: `resolveCorporationContactStanding`
  (`services/planet/planetOrbitalState.js:972`) clamps `contacts[...].relationshipID` to -10..10 at `:989-991`, and
  `getStandingTaxRateKey` (`:955-956`) buckets the clamped value on the -10, -5, 0, 5, 10 ladder CCP's document describes for
  `standing_level` (`contract/openapi.json:2052`: -10 Terrible, -5 Bad, 0 Neutral, 5 Good, 10 Excellent).
- `normalizeInteger` truncates, so a fractional standing cannot exist in the store and rounding would be dead code.

**Rationale.** eve-nexum's `replaceStandings` is all-or-nothing (`BEGIN`, `DELETE`, one `UNNEST` bulk insert, `ROLLBACK` on any error,
`server/src/services/standings.ts:96-126`), but the column is `standing REAL NOT NULL` (`server/src/migrate.ts:714-720`) and PostgreSQL
`real` accepts values up to about 1e38. An out-of-range standing does not abort the bucket; a `null` standing or a `contact_id` above
`2147483647` does, and neither is this question. The cost of not clamping is that the value is compared against a login threshold
(`AND standing >= $2` with `$2` of 5 or 10, `server/src/services/accessGrants.ts:107`), so a garbage standing decides whether a pilot may
log in.

A drop is refused for the same reason: `replaceStandings` is DELETE-then-INSERT, so a dropped row means the standing is withdrawn,
silently revoking access the game grants. Refusing the whole response is worse: one strange row would blank a pilot's contact list, and
no such refusal has been observed on this route, so status, family and bytes would all be invented (D31). Passing the value through
publishes a number outside the scale consumers do arithmetic on. Design constraint 3 does not apply, because this is not CCP doing
something ugly; it is this game permitting something CCP's data model does not.

### D34: What the replica answers when a waypoint cannot be delivered

**Choice.** `204`, always. The push is best-effort and its outcome appears only in the mod's log.

- The pinned document declares `204` and `default` on `POST /ui/autopilot/waypoint` and no numeric error status, so there is no refusal
  on this operation to be faithful to.
- `lib/router.js` has a `successStatus` route-table column, validated in `compileRoute` and applied at dispatch, and it refuses a `204`
  route whose handler returned a body, because `server.js` would drop those bytes without a trace.
- The replica cannot distinguish "offline" from "online and unreachable", and cannot know whether anything was delivered even when it
  finds a session. `services/chat/sessionRegistry.js` says character control and presence are derived through `characterControlRuntime`
  so browser-pilot leases need no sessions in the registry (`:1-4`), so `findSessionByCharacterID` (`:177`) returns `null` for a browser
  pilot who is flying, indistinguishably from one who logged out. A found session is no guarantee either: `clientSession.sendNotification`
  (`network/clientSession.js:828`) checks `this.socket.destroyed`, records a `packet.dropped` ledger event with `reason: "socket-closed"`,
  and returns (`:829-841`). The game layer is fire-and-forget.

`nexumApi`'s shape is rejected: `200 {characterID, destinationID, clearOtherWaypoints, first, delivered, reason}` is an envelope of the kind
this replica does not send, its `reason: "offline"` is false for a browser pilot, and a body of any shape contradicts the `204`.

**Rationale.** Every candidate error status (`404`, `409`, a `5xx`) is unobserved on this route and the spec declares none, and D31 records
what such a guess is worth. Here it would attach to the wrong condition by construction: the predicate would be "the pilot is offline" and
the observation is "the registry had no session".

Queueing fails on its own terms. eve.js has no server-side autopilot, destination or route state: `setDestination` and `activateAutopilot`
appear only as client-originated achievement counters (`services/character/achievementTrackerMgrService.js:11`, `:27`). A queue would invent a
subsystem and a behaviour real ESI does not have, and would still not reach the browser pilot.

The cost is stated rather than mitigated: eve-nexum shows "Destination set to X" whether or not anything happened. Real ESI does the same for a
pilot who is not logged in. On this server the same silent success also happens for a pilot logged in through the browser, which is a
divergence. The operability answer is a log line per attempt naming the outcome (`pushed`, `no-session`, `push-failed`), carrying the operation
and never the character id.

### D35: What a scoped route keyed by an entity answers when the caller has no claim on that entity

**Choice.** Settled on 2026-08-25 by observation for corporations, and deliberately unanswered for everything else.

A token holding `esi-corporations.read_contacts.v1`, asked for a corporation the caller is not a member of, is refused with the application's
`403`: `{"error":"Character is not in the corporation"}`, 47 bytes, `X-Esi-Cache-Status` present, charging the route's own token bucket at the
usual refusal cost of 5. `contract/wire.js` `CROSS_ENTITY_REFUSAL` is the recording and `routes/structures.js` `corporationStructuresSubject` the
use of it.

The wording is corporation-shaped and must not be reused by substituting the noun. For an alliance, a fleet, or a structure whose ACL excludes the
caller, the `subject` check throws, `lib/router.js` `gateOrFail` turns that into a logged `500`, and it stays that way until each is captured. That
is the shipped behaviour of `routes/fleets.js` `fleetMembersSubject` and `routes/structures.js` `universeStructureSubject`.

**Rationale.** First, the string names the relationship and not the permission, so extrapolating it invents a sentence CCP has never sent (D31).
Second, the status is in doubt for the other kinds. `/characters/{character_id}/fleet/` answers a `404` for a pilot in no fleet (`contract/wire.js`
`FLEET_ABSENT`), so a non-member asking for `/fleets/{fleet_id}/members/` may get a `404` hiding the fleet's existence rather than a `403`
confirming it. Third, on `/universe/structures/{structure_id}/` the consumer expects and tolerates both `403` and `404`, so even its author did not
know which arrives.

The throw costs a wrong status on a request that is refused anyway. The gate runs before the handler, so the roster, contacts and structure are not
read, and the security property holds exactly. A logged `500` naming the route is a line an operator notices, where an invented `403` is not. This is
the posture `lib/errors.js` `characterMismatch` takes for an error family nobody captured.

**What settles each.** One `curl` per entity kind with a token that holds the scope and no claim on the target. `scripts/observe-authed.js` takes
`--other-corporation`, `--other-structure`, `--other-alliance` and `--other-fleet`.

The ladder this replica can state:

| Condition | Answer |
|---|---|
| Scope missing | `401` (D31) |
| Character mismatch | `403` (D31) |
| Corporation non-member | `403` (this entry) |
| Everything else | Unobserved |

### D36: CCP's path-id range refusal

**Choice.** Reproduce it, at CCP's exact minimums. An id below its entity's range is a `422` from the validated family whose `details[].message` names
the entity (`invalid character ID`, `invalid corporation ID`, `invalid alliance ID`) and whose `value` keeps its number type. An unparseable segment
is the same status with `invalid integer` and the value as a string. The boundaries were bisected against live ESI on 2026-08-25 and are exact to the
unit: character 3000000, corporation 1000000, alliance 99000000. `contract/wire.js` `PUBLIC_ENTITY.idMinimum` and `.outOfRangeMessage` are the recording.
`routes/entities.js` `parseEntityId` is the implementation, and `ID_MINIMUM` is duplicated there because `contract/` is test-only (D20), with
`test/entitiesContract.test.js` asserting the copies agree.

**Rationale.** The alternative is to skip the range check and let every unknown id fall through to `404`, on the grounds that an invented refusal could
hide a private server's own entity. eve.js allocates in CCP's ranges: `services/corporation/corporationIdRanges.js` starts player corporations at
98000000 and alliances at 99000000, NPC corporations sit in the 1000000s, and characters are allocated well above 3000000. The check cannot refuse an
entity this game can create. A consumer then sees CCP's two-tier answer: `422` means "not an id of this kind" and `404` means "no such entity".
eve-nexum's admin page caches a `null` name on a `404` and has no reason to cache anything on a `422`.

The three strings were each read off the wire rather than templated (D31): `invalid corporation ID` was observed, not inferred from
`invalid character ID`. A fourth entity kind arrives with its own `curl`.

Not reproduced: a deleted character answers `{"status":404,"error":"Character has been deleted!"}` where an unknown one answers `Not Found`. eve.js has a
deletion runtime, but nothing was observed about which answer a never-existing in-range id gets versus a deleted one, so this replica sends `Not Found`
for every unknown character. `contract/wire.js` `PUBLIC_ENTITY.deletedCharacter` carries the string with `reproduced: false`. No consumer branches on it.

### D37: Which optional fields the public entity bodies omit

**Choice.** Two grounds, kept distinct, each omission declared as an `OMIT` seat in its projection. No observed position: `faction_id` on character,
corporation and alliance. No source in eve.js: `war_eligible` on a corporation. Everything else the game can answer is sent, including fields no consumer
reads. `contract/wire.js` `PUBLIC_ENTITY.unobservedFields` records the first kind.

**Rationale.** A militia corporation carries `faction_id` between `creator_id` and `home_station_id`. A player corporation carries `alliance_id` in what
looks like the same seat. No corporation carrying both was found, because a militia corporation is an NPC one and joins no alliance. Their relative order
is the one missing fact, and eve.js writes `factionID` on player corporation records too, so this replica could produce such a body. Field order is bytes,
so emitting it means choosing an offset nobody has seen. It stays out until one `curl` against a corporation with an alliance and a faction settles it. The
character and alliance cases are the same with less at stake: no captured body carried a `faction_id`.

`war_eligible` is a different refusal. eve.js has a war-permit concept in a different module, and it is not the same predicate as CCP's. A boolean invented
to fill a hole is worse than a missing key on an optional field, the same posture `routes/characters.js` took for `last_login` and `logins`.

Two fields are deliberately not omitted, or omitted differently. `description` is sent as `""` for a character with no bio, because the recorded body carries
`"description":""`. `title` is omitted when empty, because the recorded body for a pilot with no corporation title has no `title` key. Both came off the same
recording, and neither could have been decided from the schema.

### D38: Where `station_count` and `station_system_count` come from

**Choice.** Derived from the store, not omitted and not zeroed. Both are required on `/universe/factions/` and appear on no faction record in the vendor tree.
`lib/runtimeAccess.js` `readFactionStationCountsFromRuntime` computes them with a two-hop group-by over the read-only table handle: a station row names its
owning corporation and solar system, a corporation row names its faction. Memoised for the life of the process, because both tables are the static-data dump.
A faction with no bucket gets `0` for both, which is also what CCP sends for the four factions that own nothing.

**Rationale.** The derivation reproduces CCP's published numbers exactly on all 27 factions (Amarr 1041/515, Caldari 1535/534, Gallente 1083/525, down to the
four at 0/0) against the measured dump. Four stations have an owning corporation with no `factionID` and fall into no bucket, and CCP's totals agree. Omitting
is not open because the fields are required; zeroing would publish a false statement about every empire faction while remaining well-formed. The cost is 5,210
station rows and 283 corporation rows walked once, about a millisecond on the game's event loop, on the first request of the process. Player structures are a
different table and never enter this one, so "static for the life of the process" is true by construction. A store that cannot be read yields an empty map
rather than a throw, so a missing table costs this endpoint two numeric fields and not its body.

### D39: How the limiters key an authenticated caller

**Choice.** Settled on 2026-08-25 by observation. CCP's documented rule is wrong on both limiters, in different directions. A full 2x2 was run from one address
inside one 60-second window over two registered applications and two characters (`scripts/observe-limiter-key.js`, 6 error units and 12 `status` tokens).

- The error limiter keys on the source address and ignores the credential: one counter ran 100, 99, 98 unauthenticated, then 97, 96, 95, 94 across four different
  credentials.
- The token bucket keys on the application alone: three distinct buckets, each reading 598 then 596, where two different characters under one application shared
  a bucket and one character under two applications got two.

The documented `applicationID:characterID` overstates one limiter and understates the other. `contract/wire.js` `LIMITER_KEY` and the 13-row `LIMITER_KEY_SURVEY` hold
the readings. `LIMITER_UNOBSERVED.errorLimitKey` keeps CCP's sentence, marked as checked and contradicted. `lib/errorLimiter.js` `keyFor` was already right;
`lib/rateLimiter.js` keys on the application within its group key.

**Rationale.** The credential was reachable for free: `lib/pipeline.js` `createGroupFor` calls `readCredential` above both limiters and memoises it per request. What
was missing was the answer, so nothing was plumbed before the capture. Three things would have been guessed wrong: keying the error limiter on the credential at all,
including the character half in the token bucket, and deriving the second limiter from the first. No key containing any part of the credential can produce a counter
that continues across a credential change.

**Still open.** Whether `applicationID` is the client id from a token's `azp` or the registered application's numeric id. No experiment of this shape separates them, and
`LIMITER_KEY.applicationIdSpelling` is `null`. It does not block the implementation: each registered application has exactly one of each, so the two spellings induce the
same partition.

### D40: What a replayed authorization code revokes

**Choice.** The one refresh family that code minted, not every grant its `(character, client)` pair holds. `lib/authCodes.js` `redeem` returns a `grant` alongside
`already_used`, carrying `characterId`, `clientId` and an opaque `grantRef`. `rememberGrant` binds the issued refresh record's `family` to the tombstone when the exchange
succeeds. `lib/refreshTokens.js` `revokeFamily` retires every live grant in that family. `routes/oauthToken.js` calls it on the replay branch, revoking only when the
replaying client is the one the code was minted for. The refusal stays byte-identical to a replay of an expired code and of a code that never existed.

**Rationale.** Revoke-by-`(character, client)` is simpler and dangerous. On the replay branch `mayRedeem` and `verifyPkce` have not run (they sit below the refusal in
`handleAuthorizationCode`), so reaching it takes an authenticated client, not a proven one. A public PKCE client's `client_id` is public and D1 puts codes on plain HTTP, so
an attacker who sniffs a used code reaches this branch with no verifier and no secret. Under the broad rule that is a revocation oracle amplified by D30's cap of 8 grants per
pair: one sniffed code logs a character out of every session with that client. The narrow rule kills the single grant minted from the leaked code, which is what RFC 6749
section 4.1.2 asks for. The client-match guard closes the cross-client case; the same-client case is irreducible for a public client, so blast radius is the lever.

`family` was already on every refresh record for D30. With rotation off a family is one record; if rotation is switched on, the same call retires the whole chain.

**Still exposed, and stated in the alarm.** Access tokens are stateless RS256 JWTs with no revocation path, so the one minted from the replayed code stays valid until it
expires. `lib/authCodes.js` is in-memory, so a replay after a restart finds no tombstone, revokes nothing, and says so, naming the revoke endpoint as the manual remedy.

### D42: Where the static universe is read from

**Choice.** Two arms. The gameStore's SDE-derived tables (`solarSystems`, `celestials`, `stargates`, `stations`) for everything they carry, and the extracted dump beside the
store (`mapConstellations.jsonl`, `mapStars.jsonl`, `stationOperations.jsonl`) for the three things they do not. When the dump is absent, a route that needs it answers a logged
`500` rather than a body without those fields.

**Rationale.** There are three gaps: the store has no constellations table and no constellation names outside station rows, no star statistics at all (`grep -rl spectralClass`
over the whole store matches nothing), and no resolution of a station's `operationID` into services. So the dump is a source rather than a fallback, and only
`/universe/systems/` is answerable without it. Refusing beats degrading because both missing fields are required and read unguarded: `services: []` is a claim that Jita 4-4
has no market, and eve-nexum reads a constellation's `name` on any 2xx. An absent dump is already a degraded install, since `/status/`'s `server_version` comes from the same
directory (D12). The reads are cheap: the tables are JSON the game loads into memory at boot, and the one expensive index (461,881 celestials grouped by system) is built
lazily, once, in 26 ms, against 11 ms per request for the filter it replaces.

### D43: What validator the static-data routes carry

**Choice.** One snapshot for the whole dump: a weak SHA-224 over the store's own `source` stamp plus the mod's build, one `Last-Modified` (the dump's real generation time), and
an `Expires` at the next 11:05 UTC. Declared per route as `snapshot`, and a route that declares one may not declare a `cacheTtl`.

**Rationale.** `contract/wire.js` records that four static-data routes fetched seconds apart answer with the identical weak etag, and it is not a hash of any of their bodies.
Reproducing the mechanism makes it true here too: two systems fetched from this replica share one validator because they are one dataset, and it moves when the operator rebuilds
the store, the only event that can change these bodies. The mod's build is in the identity so a projection fix is visible to a client before the next 11:05. `Expires` stays on
CCP's daily cadence because clients are written against it, while `Last-Modified` is the dump's own. Two consequences are reproduced: `CONDITIONAL_STATIC_DATA_EXCEPTION` becomes
load-bearing (a weak etag needs weak comparison or no conditional request ever matches), and a static-data `404` carries the etag and nothing else, the only refusal on the surface
with a cache header.

### D44: A tool's startup burst empties the error budget

**Choice.** A configuration knob, `ESI_MOD_ERROR_LIMIT_MAX_ERRORS`, defaulting to CCP's observed 100 (`lib/errorLimiter.js` `MAX_ERRORS`). Unset is byte-identical to CCP's observed
limiter: same window, same charging rule, same post-charge accounting, same `420` body. Set, it replaces only the number the budget store is constructed with. `lib/pipeline.js`
`createEsiDispatch` threads it through as `maxErrors`, left `undefined` by every caller but `loader.js`, which reads it off the resolved config.

**Rationale.** A client observed against a deployment enumerates every character it knows about at startup and issues one `GET /characters/{id}/` per character in a burst of about 25
requests. Most ids are Tranquility characters this server has never heard of, so they correctly answer `404` (D13). `lib/errorLimiter.js` counts any refusal against the
100-per-60-seconds budget CCP was observed enforcing (`contract/wire.js` `ERROR_LIMIT`), and two bursts inside one window empty it. Verified live: `X-Esi-Error-Limit-Remain` counted
down to single digits, then the replica answered `420` to a request that alone was a plain `200`. The client cannot finish starting up.

Exempting `404`s or `4xx` from the budget was rejected as the default: CCP's charging rule was observed (`100 -> 99` across this kind of unrouted refusal, `charges()` in
`lib/errorLimiter.js`), and not charging would no longer match what a client sees from Tranquility (design constraint 3). The knob keeps fidelity for every deployment that does not ask
otherwise, like the opt-in surfaces of `devAutoApprove` and `signingKeyPath`. Raising it is legitimate because CCP's limiter deters a client hammering nonexistent resources on the public
internet, and a private server answering a short, known list of tools has no such adversary.

`parseErrorLimitMaxErrors` follows `parsePort` and `parseCharacterID`: a whole number, safe-integer bounded, a config error rather than a silent coercion, and no warning when unset. The
default should not move: it keeps this replica indistinguishable from CCP for a client that has never heard of the key.

### D45: Whether `POST /universe/ids/` matches a name case-sensitively

**Choice.** Case-insensitively, on a locale-independent fold, with a collision omitted rather than resolved. `lib/nameIndex.js` `matchable()` trims and `toLowerCase`s the key a name is
indexed and looked up under, while the `name` sent back is the source row's own spelling, so `jita` resolves and is answered with `Jita`. Two rows that fold to one key and disagree about
the id are reported as an `AmbiguousIdError` and both omitted, the same bargain as D9.

**Rationale.** CCP's document says only that "Only exact matches will be returned", which settles substring versus whole-string and says nothing about case. This is a choice, and it is visible
on the wire. First, folding introduces no ambiguity for names a player can pick: EVE enforces case-insensitive uniqueness on character, corporation and alliance names, so `Example Corp` and
`example corp` cannot both exist. Second, the failure modes are not symmetric. A replica that folds where CCP does not answers a client that typed a name from a chat log, and that client's
code also works on Tranquility. A replica that does not fold where CCP does answers `{}`, so a tool silently resolves nothing on a private server and works on Tranquility, which is harder to
diagnose. Static data has no uniqueness rule (an `inventory_type` and a `solar_system` could differ only in case), which is why a collision is detected and omitted rather than resolved by
indexing order. `toLowerCase` and not `toLocaleLowerCase`, because the Turkish dotless i would make one deployment resolve a name another does not.

### D46: What `location_flag` an item carries when its `flagID` is 0

**Choice.** `AutoFit`, on CCP's own authority. eve.js writes `flagID` 0 wherever no compartment applies, and no ESI enum publishes a `None`. A decompiled client's `inventorycommon/const.py` is
the `invFlags` table the extracted SDE omits, and it gives both `flagAutoFit` and `flagNone` the value 0. Of those two names the document publishes `AutoFit` on all three surfaces and `None` on
none, so the id has one legal spelling.

The same file settles a second row: `flagCrateLoot` and `flagCorpseBay` are both 174, the character enum publishes `CorpseBay` and the corporation enum publishes `CrateLoot`, so 174 is renamed per
surface (`corporationName`) rather than refused on one of them.

The client dump is a third source for `lib/locationFlags.js`, checked by `test/locationFlags.test.js` when `ESI_MOD_CLIENT_ROOT` names one and skipped otherwise, with
`test/vendorPresence.test.js` refusing a strict run that would skip.

**Rationale.** The failure was total. `flagID` 0 is what a container's contents carry and what anything in space carries: on the install that raised this, 827 of 2,692 items, 778 of them inside a
container, and 781 of 873 blueprints. All four asset and blueprint endpoints answered a logged `500` for 12 of that install's 31 characters, and 0 was the only unmapped id in the live table.

Neither existing source could settle it. The SDE dump has 61 files and no `invFlags`. eve.js declares no `ITEM_FLAGS` constant for 0. The positional argument that settled 134 does not close here:
after the three documented divergences (`Implant`, `Skill`, `Wardrobe`) the character enum still has two values no flag id produces, `AutoFit` and `HangarAll`, against one unmapped id. The client
closes it twice: it names 0, and it numbers `flagHangarAll` at 1000, a UI selector three digits above any flag an item can hold.

The client is not authoritative for ESI names. Stripping the `flag` prefix from its 133 constants over 129 ids, 119 names are published verbatim, seven are CCP renaming its own constant on the way out
(`SubsystemBay` to `SubSystemBay`, `GeneralMiningHold` to `SpecializedOreHold`, and five more), seven name no place an item sits, and one published value, `QuantumCoreRoom`, has no constant in this
build. So the checks say "where CCP's name for an id is a value the document publishes, this table sends that name", never "the table equals the client". The document stays authoritative for names and
the client for ids, the half eve.js does not cover because it declares only the ids it uses.

This settles an unobserved fact in the sense of D23: a decompiled client is CCP's declaration of its own constant, and what it yields is protocol (an id and a name), not anybody's data. Dropping the rows
would have silently removed nine tenths of every blueprint body, and leaving the `500` would have kept four endpoints shut for most characters over a name CCP had written down.

One guard came with the row: `locationFlagFor` refuses anything that is not a number or the string spelling of one, because `Number()` reads `null`, `""`, `false` and `[]` as zero, and a row carrying no
flag must stay a refusal rather than become `AutoFit`.

### D47: How the mod is enabled and configured as an EveJS Launcher package

**Choice.** The launcher's `loader.js.disabled` is the off switch, and the mod is armed by default when enabled.

- `ESI_MOD_ESI_PORT` defaults to 26005 and `ESI_MOD_SSO_ISSUER` to `http://localhost:26006`. Absent means the default and present-blank means off, for those two keys only.
- `ok` holds when either listener is wanted, and ESI can be off with SSO on.
- Layers, lowest first: defaults, `settings.json`, `.env.txt`, `.env`, real environment.
- `settings.json` enters through a frozen allowlist map, so it can never arm dev auto-approve or move the credential paths. Its `esiPort: 0` means blank, because a launcher integer field cannot be blank.
- The package id and folder are `esiApi`, the release asset is `EveJS-ESI-<version>.zip` with one `esiApi/` root, and `preserveFiles` is `[".env.txt"]`.
- `sso/` state and the clients file stay where they are.

**Rationale.** This supersedes the "no default" reasoning for the issuer in [d6-listener-split.md](d6-listener-split.md) and the opt-in half of D1 and D7. Those protected a checkout merely copied into
`mods/`. The launcher imports every package disabled, so copying no longer arms anything, and a form with an empty required field would be a worse first run. D7's objection to a derived issuer stands:
this default is a fixed string, and it must never change in a later release, because untouched installs would move with it and every token would be invalidated. An existing `.env` issuer outranks it, so
running deployments keep their tokens.

`.env.txt` exists because `preserveFiles` accepts only `.ini .txt .toml .json .yml .yaml .cfg`, so plain `.env` is refused there and disappears on the first launcher update. It keeps working for the
deploy-script flow and warns once at boot. A later change to the preservation contract blocks the update button, so `.env.txt` ships in 1.0.0.

`DEFAULTS` and the manifest defaults must agree, because an untouched install relies on one while the form shows the other; `test/manifest.test.js` pins that. The form shows `settings.json`, not effective
values, so an overriding key is logged at boot. `/_mod/health` lives on the ESI listener and is unreachable while ESI is off.

Launcher behaviour was read from the installed 1.0.77 build and its validators were run. A real Add ZIP, Adopt and hosted update were not.

## Open

### D10: Do we serve `images.evetech.net` equivalents?

Three tools hardcode portrait and type-icon URLs with no config override. eve.js has its own image server on 26001. It is outside the stated scope (ESI URL, SSO URL, maybe SDE), but those tools show broken
images without it.

## Deferred, deliberately

### D14: TLS and CCP hostname impersonation

D1 chose plain HTTP. Revisit when the cost of certificate trust is worth paying to reach `https://`-only client libraries.

### D15: `zkillboard.com` replica

Not CCP infrastructure. Only Elysian-FitALL depends on it, and it needs a different solution.

### D16: 2026-era ESI route families

Freelance Jobs, Corp Projects, Military Campaigns, SKINR/Paragon Hub, Mercenary Dens, Skyhooks. No consumer in the ecosystem uses them.

### D17: Serving `GET /meta/openapi.json`

Only matters for codegen-based SDKs, none of which are in the ecosystem today. Cheap to add now that the route table exists.
