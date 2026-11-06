# D6 and D7: one listener or two, and what `iss` is

Outcome: **two listeners on two ports**, and **`iss` is an absolute URL with an explicit scheme**. Both are
recorded as settled in [open-decisions.md](open-decisions.md). D47 later gave the issuer a fixed default; see
below.

## The question

ESI and SSO are separate hosts at CCP: `esi.evetech.net` and `login.eveonline.com`. A replica can mirror that with
two listeners on two ports, or serve both from one listener split by path prefix.

The SSO discovery document advertises absolute URLs, and the `iss` claim goes into every signed token. Anything that
pins one of those to a value that later changes stops working, and by then tokens are in use.

Three shapes were considered:

| | Shape | ESI base | SSO base |
|---|---|---|---|
| **A** | Two listeners, two ports | `http://<host>:26005` | `http://<host>:26006` |
| **B** | One listener, both surfaces at their natural CCP paths | `http://<host>:26005` | `http://<host>:26005` |
| **C** | One listener, artificial prefixes | `http://<host>:26005/esi` | `http://<host>:26005/sso` |

## What consumes the discovery document

**`market-hub-seed` and `market-seederv3`** never touch SSO. They read public market endpoints with a configurable
base URL and no token.

**`eve-nexum`** does not do discovery. Under the D18 patch it holds `ESI_BASE` and `SSO_BASE` as two independent settings
and builds `${SSO_BASE}/v2/oauth/authorize` and `${SSO_BASE}/v2/oauth/token` directly. Every option above works for it.

**The EVE client** decides this. Client build 3396210 carries `clientRefreshToken/discovery_hacks.py` and
`clientRefreshToken/refresher.py`, and on every launch they do the following:

1. Take the `iss` claim out of the token the launcher handed the client.
2. Turn it into a discovery URL (`create_well_known_url_from_iss_claim`).
3. `GET` that URL and read `token_endpoint` from the JSON, retrying up to 10 times, one second apart.
4. Use it, with `azp` from the same token as the `client_id`, to refresh: `grant_type=refresh_token`, no client secret, and it
   requires both `access_token` and `refresh_token` to come back non-empty.

Step 2 is what matters. The function applies three rewrites to the parsed `iss`:

- If there is no network location, it treats the parsed path as the host, so a bare hostname becomes the host.
- If there is no scheme, it supplies `https`.
- If the path is anything other than `/.well-known/oauth-authorization-server/`, it replaces the path with that value.

Running the real function over candidate `iss` values:

| `iss` | Derived discovery URL |
|---|---|
| `login.eveonline.com` | `https://login.eveonline.com/.well-known/oauth-authorization-server/` |
| `host.local` | `https://host.local/.well-known/oauth-authorization-server/` |
| `host.local:26006` | `host.local://26006/.well-known/oauth-authorization-server/` |
| `http://host.local:26005/sso` | `http://host.local:26005/.well-known/oauth-authorization-server/` |
| `http://host.local:26006` | `http://host.local:26006/.well-known/oauth-authorization-server/` |

### Finding 1: the path in `iss` is discarded, so option C is impossible

The third rewrite replaces whatever path `iss` carried. An SSO surface mounted at `/sso` is unreachable: the client asks the
origin root for the discovery document whatever `iss` says. The SSO surface must own a scheme, host and port whose root it
controls. That leaves its own port (A) or the ESI port's root (B).

### Finding 2: a scheme-less `iss` is forced to `https`, which D1 rules out

CCP emits `iss` as a bare hostname with no scheme, and the client's second rewrite supplies `https`. CCP is on `https`, so this
works for CCP.

D1 puts the replica on plain HTTP on a non-standard port, and both ways of writing that without a scheme fail:

- `host.local:26006`: `urlparse` reads `host.local` as the scheme and `26006` as the path, giving `host.local://26006/...`, which is
  not a URL. CPython 2, which the client runs, has a guard that declines to read a scheme when everything after the colon is digits;
  that branch yields `https://host.local:26006/...`, a scheme the replica does not serve.
- `host.local`: loses the port, and `https://host.local/...` reaches nothing.

So under D1, `iss` must carry an explicit scheme. This is a deliberate divergence from CCP's bare hostname, forced by the transport
decision.

## `iss` and `issuer` under each option

CCP does not keep these two equal: `iss` is `login.eveonline.com` and the discovery document's `issuer` is
`https://login.eveonline.com`. Anything that string-compared them would already fail against CCP. The EVE client reads only
`token_endpoint` from the document and never looks at `issuer`.

The replica cannot copy that split, because Finding 2 rules out the bare form. Both values are the same string, and the only question
is which origin it names.

| | `iss` claim | Discovery `issuer` | Discovery document lives at |
|---|---|---|---|
| **A** | `http://<host>:26006` | `http://<host>:26006` | The SSO listener's root |
| **B** | `http://<host>:26005` | `http://<host>:26005` | The ESI listener's root |

## Why A

The paths do not collide under B: ESI has no `oauth` resource and no `.well-known`, and CCP has no reason to add one, because at CCP
those live on a different host. B is implementable. Three reasons not to use it:

- **The version prefix stops meaning one thing.** The router's version dimension is load-bearing: `/v2/` selects an ESI compatibility
  surface. Under B, `/v2/oauth/token` sits inside that namespace while meaning something else, so `oauth` becomes a permanent carve-out
  in the route table.
- **The error limiter would cover token traffic.** Real ESI runs a 100-errors-per-60-seconds limiter that returns `420` across the whole
  surface on exhaustion (see [architecture.md](architecture.md)), and the replica reproduces it. On a shared listener, a client looping on
  a stale refresh token would burn that budget and take the public read surface down with it. Separate listeners keep the limiters
  separate without a path exemption.
- **It leaves TLS somewhere to go.** D14 may put real hostnames in front of this. Two ports map onto `esi.<host>` and `login.<host>` behind a
  proxy; one port has to be split by path at the proxy first.

B saves one published port and one bind-host setting. D1 had already assigned 26005 and 26006, so A costs nothing further.

## What A commits to

- The SSO surface owns the root of `http://<host>:26006`. `/.well-known/oauth-authorization-server`, `/oauth/jwks` and `/v2/oauth/*` hang off it
  directly, as at CCP.
- Every absolute URL in the discovery document is built from one issuer string: `authorization_endpoint`, `token_endpoint`,
  `revocation_endpoint`, `jwks_uri`.
- `iss` is that same string. No trailing slash, no path, scheme included.

## Cost of changing the origin later

Refresh tokens are opaque strings in the replica's own store and do not embed the issuer, so the replica would not invalidate them. What
breaks is on the client side:

| What | Effect of an origin change | Recovery |
|---|---|---|
| Issued access tokens | Carry the old `iss`. 20-minute lifetime | Self-heals |
| JWKS and signing keys | `kid` is the literal `JWT-Signature-Key`, independent of origin | Unaffected |
| Cached discovery documents | Every absolute URL in them is stale | Client restart, or cache TTL |
| The EVE client | Re-derives `token_endpoint` from the current token's `iss` at each launch | Self-heals if the launcher hands it a token minted with the new issuer. If not, refresh fails and the session degrades about 20 minutes in |
| `eve-nexum` | `SSO_BASE`, plus the nginx CSP `connect-src` origins the D18 patch templates | Config edit and restart; stored token rows survive |
| Anything that pinned `iss` for JWT validation | Fails closed on every request | Config edit. The common library idiom is an `issuer:` option, so this population is the most likely to exist and the hardest to enumerate |

So the cost is a coordinated config change for every consumer, and any forgotten consumer fails closed until someone finds it. It grows with the
number of consumers.

### The mitigation

Make the issuer an explicit configured value rather than deriving it from the bind host and port.

A derived issuer ties the token's identity to the current transport, so the first reverse proxy, hostname or TLS certificate forces the expensive
change. With a configured one, an operator who intends to end up at `login.host.local` can set the issuer to that name now and put a proxy in
front later, and no token, discovery document or client config changes when the transport does.

D47 gave the issuer a fixed default, `http://localhost:26006`, because the launcher's disabled state took over the job of keeping a copied package
inert. The objection to deriving it stands.

The issuer must be reachable by clients as written, because it is fetched, not just compared, so it cannot name a host that does not resolve yet.
Choose it before the first token is signed, the same deadline D8 carries.

## Implementation consequences

- **Discovery document.** Served at both `/.well-known/oauth-authorization-server` and `/.well-known/oauth-authorization-server/`. CCP publishes the
  first; the EVE client requests the second. The recorded inconsistencies stay: `issuer` with no trailing slash, `jwks_uri` at `/oauth/jwks` rather
  than under `/v2/`, and `id_token_signing_alg_values_supported: ["HS256"]` even though access tokens are RS256.
- **Token endpoint.** The EVE client refreshes with `client_id` in the body and no secret, and treats an empty `access_token` or an empty
  `refresh_token` in the response as an error. Both fields must always be present and non-empty.
- **JWT minting.** `iss` is the configured issuer string. `azp` matters beyond audience checking: the client reads it back as the `client_id` for its
  own refresh calls.
- **Signing key lifecycle.** Shares D7's deadline. The issuer is chosen before the first signature, for the same reason the key is.
- **TLS and hostnames (D14).** Inherit two ports, and a configured issuer that a proxy can be placed behind without re-issuing anything.
- **Router.** The version-prefix dimension is ESI's alone. `/v2/oauth/*` is on the other listener and never enters the ESI route table.
