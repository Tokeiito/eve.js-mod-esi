# Changelog

## 1.0.0

First public release.

- **ESI replica.** 36 operations from CCP's `2020-01-01` document, plus `GET /ping`: status and meta, public entities, static universe, name resolution, markets, industry, and authenticated reads for location, skills, roles, assets, blueprints, industry jobs, orders, contacts, fleets and structures. `POST /ui/autopilot/waypoint` is the one write. The README lists every endpoint.
- **Wire behaviour matched to observation of live ESI:** version prefixes, both error shapes, CORS, cache headers and conditional requests, offset pagination, compatibility date and tenant validation, the error budget and the token bucket.
- **SSO replica on its own listener:** discovery, JWKS, authorize, token, verify and revoke. Sign-in is proved by an in-game bind code, `/esi <code>`. Refresh grants are kept as hashes.
- **EveJS Launcher package.** `EveJS-ESI-<version>.zip` installs as `mods/esiApi`, starts disabled, has a settings form, and can update from GitHub releases on native installs (D47).
- **Configuration layers,** lowest first: defaults, `settings.json`, `.env.txt`, `.env`, real environment. `settings.json` can set only the fields on the form. Either listener can be off independently. A port eve.js itself uses is refused.
- **No runtime dependencies.** No eve.js file is modified.

An install with no port or issuer set listens on loopback by default: ESI on `127.0.0.1:26005`, and SSO on `127.0.0.1:26006` with the issuer `http://localhost:26006`. To keep a listener off, set its key and leave it blank.
