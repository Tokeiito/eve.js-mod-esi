# eve.js-mod-esi

A mod for the eve.js private EVE Online server emulator that replicates CCP's ESI API and SSO login, so third-party EVE tools can read a private server's data with no change beyond their ESI and SSO base URLs. It is for people who run an eve.js server and want existing tools to work against it.

## Status and coverage

The mod serves 36 of the 197 operations in CCP's `2020-01-01` ESI document, plus `GET /ping` and the SSO login endpoints. Responses are built to match CCP's observed behaviour: bodies, headers, status codes, error strings, caching, pagination and both rate limiters.

Paths are written below without a prefix or trailing slash. Except where noted, each one also answers under `/latest/`, `/legacy/`, `/dev/` and `/v1/` to `/v6/`, with or without a trailing slash. All prefixes serve the `2020-01-01` surface.

### Public ESI

| Family | Endpoints |
|---|---|
| Status and meta | `GET /status`, `GET /ping` (no prefix), `GET /meta/compatibility-dates` (no prefix) |
| Public entities | `GET /characters/{character_id}`, `GET /corporations/{corporation_id}`, `GET /alliances/{alliance_id}`, `GET /universe/factions` |
| Static universe | `GET /universe/systems/{system_id}`, `GET /universe/stars/{star_id}`, `GET /universe/constellations/{constellation_id}`, `GET /universe/stations/{station_id}` |
| Name resolution | `POST /universe/names`, `POST /universe/ids` |
| Markets | `GET /markets/prices`, `GET /markets/{region_id}/orders` |
| Industry | `GET /industry/systems` |

### Authenticated ESI

| Family | Endpoint | Scope | Corporation role |
|---|---|---|---|
| Location | `GET /characters/{character_id}/online` | `esi-location.read_online.v1` | |
| Location | `GET /characters/{character_id}/location` | `esi-location.read_location.v1` | |
| Location | `GET /characters/{character_id}/ship` | `esi-location.read_ship_type.v1` | |
| Skills | `GET /characters/{character_id}/skills` | `esi-skills.read_skills.v1` | |
| Roles | `GET /characters/{character_id}/roles` | `esi-characters.read_corporation_roles.v1` | |
| Assets | `GET /characters/{character_id}/assets` | `esi-assets.read_assets.v1` | |
| Assets | `GET /corporations/{corporation_id}/assets` | `esi-assets.read_corporation_assets.v1` | `Director` |
| Blueprints | `GET /characters/{character_id}/blueprints` | `esi-characters.read_blueprints.v1` | |
| Blueprints | `GET /corporations/{corporation_id}/blueprints` | `esi-corporations.read_blueprints.v1` | `Director` |
| Industry | `GET /characters/{character_id}/industry/jobs` | `esi-industry.read_character_jobs.v1` | |
| Industry | `GET /corporations/{corporation_id}/industry/jobs` | `esi-industry.read_corporation_jobs.v1` | `Factory_Manager` |
| Markets | `GET /characters/{character_id}/orders` | `esi-markets.read_character_orders.v1` | |
| Markets | `GET /markets/structures/{structure_id}` | `esi-markets.structure_markets.v1` | |
| Contacts | `GET /characters/{character_id}/contacts` | `esi-characters.read_contacts.v1` | |
| Contacts | `GET /corporations/{corporation_id}/contacts` | `esi-corporations.read_contacts.v1` | |
| Contacts | `GET /alliances/{alliance_id}/contacts` | `esi-alliances.read_contacts.v1` | |
| Fleets | `GET /characters/{character_id}/fleet` | `esi-fleets.read_fleet.v1` | |
| Fleets | `GET /fleets/{fleet_id}/members` | `esi-fleets.read_fleet.v1` | |
| Structures | `GET /corporations/{corporation_id}/structures` | `esi-corporations.read_structures.v1` | `Station_Manager` |
| Structures | `GET /universe/structures/{structure_id}` | `esi-universe.read_structures.v1` | |
| UI | `POST /ui/autopilot/waypoint` | `esi-ui.write_waypoint.v1` | |

`POST /ui/autopilot/waypoint` is the only endpoint that changes anything in the game.

### SSO

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-authorization-server` | Discovery document |
| `GET /oauth/jwks` | Public signing key |
| `GET /v2/oauth/authorize` | Sign-in page |
| `POST /v2/oauth/token` | Code and refresh token exchange |
| `GET /v2/oauth/verify`, `GET /oauth/verify` | Token introspection |
| `POST /v2/oauth/revoke` | Token revocation |

### Tested versions

The release package has been booted on eve.js build `261028.1` with a native server. Its manifest passes the validators of EveJS Launcher 1.0.77, but the launcher's own screens (Add ZIP, Configure, enable, remove) have not been run yet. These are the versions checked, not requirements.

## Install through the EveJS Launcher

1. Download `EveJS-ESI-<version>.zip` from a GitHub release of this repository.
2. In the launcher, use **Add ZIP** and select the file. The mod is imported as `mods/esiApi` and starts disabled.
3. Enable the mod.
4. Restart the game server.
5. Check that it is running:

   ```bash
   curl http://localhost:26005/_mod/health
   ```

   The response reports `status`, `modVersion` and `sourceHash`. The health route is on the ESI listener, so it is unreachable while ESI is turned off.

Docker users have further steps: see [Docker](#docker).

To install without the launcher, see [docs/deployment.md](docs/deployment.md).

## Configuration

Use the mod's **Configure** form in the launcher. Every change needs a game server restart.

Settings are read from these layers, and a later layer wins per key:

1. Built-in defaults
2. `settings.json` (written by the Configure form)
3. `.env.txt` in the mod folder
4. `.env` in the mod folder
5. Real environment variables

The form shows `settings.json`, not the effective value. When a file or the environment overrides a form setting, the server console says so at boot.

To use a file, copy `.env.example` to `.env.txt`. It documents every key. Use `.env.txt` rather than `.env`: a launcher update replaces the mod folder and keeps `.env.txt`, but it cannot keep `.env`.

| Form field | Environment key | Default | Notes |
|---|---|---|---|
| ESI port | `ESI_MOD_ESI_PORT` | `26005` | Must differ from the SSO port and from [eve.js's ports](#reserved-ports) |
| ESI listen address | `ESI_MOD_ESI_BIND_HOST` | `127.0.0.1` | A non-loopback address exposes game data over plain HTTP and warns at boot |
| SSO address (issuer) | `ESI_MOD_SSO_ISSUER` | `http://localhost:26006` | Scheme, host and port only, with no path or trailing slash |
| SSO port | `ESI_MOD_SSO_PORT` | `26006` | Keep it matching the port in the issuer. Must differ from [eve.js's ports](#reserved-ports) |
| SSO listen address | `ESI_MOD_SSO_BIND_HOST` | `127.0.0.1` | |
| Allowed clients file | `ESI_MOD_SSO_CLIENTS_PATH` | none | Absolute path, as the server process sees it |
| Error budget per minute | `ESI_MOD_ERROR_LIMIT_MAX_ERRORS` | `100` | `100` is CCP's budget. Raising it diverges from CCP |
| Log detail | `ESI_MOD_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |

Three further settings are read from files and the environment only, never from the form: `ESI_MOD_SSO_STATE_DIR`, `ESI_MOD_SIGNING_KEY_PATH`, and `ESI_MOD_DEV_AUTO_APPROVE` with `ESI_MOD_DEV_AUTO_APPROVE_CHARACTER_ID`. See `.env.example` and [SECURITY.md](SECURITY.md).

### Reserved ports

Neither port may be one eve.js uses: 443, 5222, 26000, 26001, 26002, 26003, 26400, 40110 or 40111. The mod binds before the game does, so the game would otherwise fail with `EADDRINUSE` and exit. Setting one is a configuration error, and the mod stays off while the game boots. The list holds eve.js's defaults. If you moved a game port, keep it clear of the mod's ports yourself.

### Turning a listener off

- **ESI:** set the port to `0` in the form, or leave `ESI_MOD_ESI_PORT` present and blank in a file. `0` in a file is a configuration error.
- **SSO:** leave the issuer blank, in the form or in a file. ESI keeps serving public routes. No tokens are issued, so authenticated routes cannot be used.
- With both off, the mod stays loaded and does nothing.

In a file, absent and blank are different for these two keys: absent means the default, and blank means off. For every other key, blank means the default.

### Changing the issuer

The issuer is written into every token. Changing it invalidates every issued token, so every tool has to sign in again. Choose its final value before the first sign-in. Tools must be able to reach it exactly as written.

### Configuration errors

An invalid value stops the mod from starting, not the game server. The server console names the key. A clients file that is set but cannot be read counts as an invalid value.

## Pointing a tool at it

| Setting in the tool | Value |
|---|---|
| ESI base URL | `http://localhost:26005` |
| SSO base URL | `http://localhost:26006` (the configured issuer) |

To sign in, a tool opens the authorize page, which shows a code. Type `/esi <code>` in EVE chat on the character you are signing in with, while logged in to the server. The page then returns to the tool. This in-game step is what proves which character is asking.

Tool registration is not needed:

- Any `client_id` is accepted, including one issued by CCP.
- A redirect URI on a literal loopback address (`127.0.0.0/8` or `[::1]`, any port) works with no configuration.
- Any other redirect URI must be listed exactly in the allowed clients file. That includes the name `localhost`, which does not count as loopback.
- A sign-in without PKCE can only be completed by a client with a `client_secret` in the clients file. You invent the secret and configure it on both sides.

An allowed clients file looks like this. `"*"` lets any `client_id` use the listed URIs, and cannot carry a secret.

```json
{
  "clients": [
    { "client_id": "*", "redirect_uris": ["http://localhost:3000/callback"] },
    {
      "client_id": "my-tool",
      "redirect_uris": ["http://tools.example:8080/sso/callback"],
      "client_secret": "output-of-openssl-rand-hex-32"
    }
  ]
}
```

Keep this file outside the mod folder, because a launcher update replaces that folder (the server console warns if it is inside), for example at `mods/esiApi-sso-clients.json`. Secrets must be 16 to 255 characters from `A-Z a-z 0-9 . _ -`.

## Docker

Managed Docker in the launcher generates a Compose file that sets only `NODE_OPTIONS` and a bind of `mods/`. It publishes no ports, and the launcher offers no in-launcher mod updates on Docker. Two things are needed beyond the install steps above.

**Bind hosts.** Set **ESI listen address** and **SSO listen address** to `0.0.0.0`. A listener on the container's loopback is unreachable from a published port: it starts cleanly and the port answers connection refused. The mod warns about this at boot. Restrict access on the host side, with the `127.0.0.1:` prefix on the published port.

**Publishing the ports.** There are two ways.

- **Connect-only mode with your own Compose override.** Run `docker compose` yourself and keep the mount, the ports and `NODE_OPTIONS` in `compose.override.yaml`. The launcher then cannot enable or disable mods, so extract the ZIP into `mods/` yourself and rename `loader.js.disabled` to `loader.js`.

  ```yaml
  services:
    server:
      volumes:
        - ./mods:/app/mods:ro
      ports:
        - "127.0.0.1:26005:26005"
        - "127.0.0.1:26006:26006"
      environment:
        NODE_OPTIONS: --require /app/mods/esiApi/loader.js
  ```

  If other mods are loaded, keep their `--require` entries in `NODE_OPTIONS`.

- **A sibling forwarder with Managed Docker.** Run a small separate Compose project on the external network `evejs-net`, publishing the two ports and forwarding to `evejs-server:26005` and `evejs-server:26006`. This approach is untested.

Paths in the clients file setting are container paths, such as `/app/mods/esiApi-sso-clients.json`. See [docs/deployment.md](docs/deployment.md) for details.

## Updating

- **Native:** use the launcher's update button. It replaces the mod folder and keeps `settings.json` and `.env.txt`. A `.env` file is lost: the server console warns about this at boot, so rename it to `.env.txt` first.
- **Docker:** replace the folder by hand, keeping `settings.json` and `.env.txt`. The ZIP contains `loader.js.disabled`, so enable the mod again afterwards.

Then restart the game server and check `sourceHash` on `/_mod/health`.

## Removing

Remove the mod in the launcher, or delete `mods/esiApi/`. The launcher moves the folder to its quarantine, where it can be restored, including `settings.json` and `.env.txt`.

Two things stay on disk, outside the mod folder, so that a reinstall keeps tools signed in:

| What | Where |
|---|---|
| The `sso/` state directory: `signing-key.pem`, `owner-salt.txt`, `refresh-tokens.jsonl` | Beside the game store. `_local/sso/` on a native install, `/var/lib/evejs/sso/` in the data volume on Docker, or wherever `ESI_MOD_SSO_STATE_DIR` and `ESI_MOD_SIGNING_KEY_PATH` point |
| The allowed clients file, if you made one | The path you configured |

To purge the mod completely, stop the server and delete both. A later install creates new credentials, and every tool has to sign in again.

## Known limitations

`Dnn` references, here and throughout the code, are entries in the decision register, [docs/open-decisions.md](docs/open-decisions.md).

- **Partial coverage.** Only the operations listed above are served. Everything else is answered as an unrouted `404`, including wallets, mail, contracts, killmails, sovereignty, wars, dogma, types and regions. `GET /meta/openapi.json` is not served (D17).
- **Private server scope.** The mod never proxies to CCP. IDs and data are this server's own, and an ID it does not know is a `404` (D13).
- **Plain HTTP only.** There is no TLS and no impersonation of CCP's hostnames (D1, D14). A tool must allow its ESI and SSO URLs to be configured, and must accept `http://` for both.
- **Old surface only.** Only compatibility date `2020-01-01` is served, with offset pagination. Newer route families and cursor pagination are not (D4, D16).
- **No image or SDE service.** `images.evetech.net` is not replicated, so tools that hardcode it show broken images (D10). Static data downloads are out of scope.
- **Sign-in needs the game.** The real grant requires the character to be logged in to the server to type the code.
- **`localhost` and IPv6.** The listeners bind IPv4 by default and the default issuer uses the name `localhost`. A client that resolves it to `::1` and does not fall back cannot connect. Set the issuer to `http://127.0.0.1:26006` before the first sign-in if this affects you. This has not been tested with real tools.
- **Unobserved refusals are `500`s.** A caller with no claim on an alliance, a fleet or a structure gets a logged `500`, where the read is refused but CCP's status has not been observed (D35).
- **The waypoint write always answers `204`,** whether or not anything was delivered. The outcome appears only in the mod's log (D34).
- **Game data differs where eve.js does.**
  - Industry cost indices come from eve.js's static approximation, so every system reports one index for every activity.
  - Market orders have `order_id`, `duration`, `min_volume` and `range` synthesised, because the seeded tables do not hold them (D29).
  - `Content-Language` is always `en` (D27).
  - `faction_id` on entities and a corporation's `war_eligible` are omitted (D37).
- **One signing key.** There is no rotation overlap, so replacing the key invalidates issued tokens (D8).
- **In-launcher updates are unexercised.** Updating from a hosted GitHub release has not yet been run end to end.

## Building and testing

Requires Node 24. There is nothing to install: the mod has no runtime dependencies and the repository has no development dependencies.

```bash
npm test                          # the whole suite
node --test test/router.test.js   # one file
node scripts/build-release.js     # dist/EveJS-ESI-<version>.zip and .update.json
```

`RunTests.bat` is the Windows wrapper for the suite. The glob in `npm test` matters: `node --test test` does not work.

Most of the suite needs only Node. The groups that read the outside world skip when it is absent:

| Variable | Un-skips |
|---|---|
| `EVEJS_REPO_ROOT` | Drift checks against an eve.js checkout, and against the deployed copy inside it |
| `ESI_MOD_MARKET_DB` | Market schema checks. Point it at a `market.sqlite`. A copy is fine, with its `-wal` and `-shm` files beside it |
| `ESI_MOD_CLIENT_ROOT` | Location flag checks. Point it at a decompiled client's root, the directory holding `inventorycommon/const.py`, matching your build |
| `ESI_MOD_REQUIRE_VENDOR=1` | Makes an absence a failure rather than a skip. `RunTests.bat --require-vendor` sets it |

To run a working copy on a server, use `node scripts/deploy-mod.js --target <eve.js tree>`. `--check` reports drift. See [docs/deployment.md](docs/deployment.md).

## Project layout

| Path | Contents |
|---|---|
| `loader.js` | The `--require` preload that attaches the mod to eve.js |
| `config.js` | Configuration layers and validation |
| `server.js` | The HTTP listener |
| `evejs-launcher.mod.json` | The launcher manifest and settings form |
| `.env.example` | Every configuration key, documented |
| `lib/` | The ESI pipeline, SSO internals and read-only access to game data |
| `routes/` | One module per endpoint family |
| `contract/` | CCP's pinned OpenAPI document, observed wire behaviour and golden bodies |
| `test/` | The test suite |
| `scripts/` | Release build, deployment, spec pinning and live ESI observation |
| `docs/` | Deployment guide, architecture, module contracts and the decision register |

For the design, see [docs/architecture.md](docs/architecture.md) and [docs/module-contracts.md](docs/module-contracts.md). See also [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and [CHANGELOG.md](CHANGELOG.md).

## License

The code in this repository is released into the public domain under the [Unlicense](LICENSE). That covers this project's own work only: CCP's material listed under Notices stays CCP's.

## Notices

This project is an unofficial fan project and is not affiliated with or endorsed by CCP hf.

`contract/openapi.json` and `contract/golden/` contain CCP's material and are included for interoperability testing only.

© 2014 CCP hf. All rights reserved. "EVE", "EVE Online", "CCP", and all related logos and images are trademarks or registered trademarks of CCP hf.
