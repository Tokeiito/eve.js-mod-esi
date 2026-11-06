# Security

## Scope

This mod runs on private eve.js servers. It is not connected to CCP's services and never contacts them at runtime. Tokens it issues are signed by a local key and mean nothing to CCP. It never asks for a CCP account.

In scope: this mod's listeners, token handling and configuration. Problems in eve.js itself, or in CCP's services, are not.

## What the mod holds

The mod runs an OAuth login, issues tokens, and holds a signing key. These tokens give access to character-scoped game state and to one write, setting an autopilot waypoint.

The `sso/` state directory holds three secrets, created on first use with SSO enabled:

| File | Purpose |
|---|---|
| `signing-key.pem` | The RSA private key that signs every access token |
| `owner-salt.txt` | The secret that makes a token's `owner` claim opaque |
| `refresh-tokens.jsonl` | Refresh grants, stored as hashes of the tokens |

Anyone holding the signing key can mint a valid token for any character on the server. Protect this directory, and back the three files up together. Keep it outside the mod folder: `ESI_MOD_SSO_STATE_DIR` refuses a path inside it.

## Network exposure

Both listeners speak plain HTTP. Tokens and game data travel unencrypted.

Both bind to `127.0.0.1` by default. A non-loopback bind host is allowed, because a tool on another machine needs it, and it warns at boot. Do not expose either port to an untrusted network. Inside a container the bind host must be `0.0.0.0`, so apply the restriction on the host side with a `127.0.0.1:` prefix on the published port.

## Dev auto-approve

`ESI_MOD_DEV_AUTO_APPROVE` skips the in-game sign-in, so any caller that reaches the SSO port gets a token for the character in `ESI_MOD_DEV_AUTO_APPROVE_CHARACTER_ID`, with no proof of identity. It exists for automated tests.

- It is off unless set to `1`, `true`, `yes` or `on`.
- It cannot be set from the launcher form or `settings.json`, only from `.env.txt`, `.env` or the environment.
- It needs a character ID. Without one, the mod refuses to start.
- It warns at boot whenever it is on.
- If `ESI_MOD_SSO_BIND_HOST` is not a loopback address, the mod refuses to start.

**Never enable it beyond loopback.** The check looks only at the bind host, so it cannot see a reverse proxy or port forward that exposes a loopback listener. Do not put either in front of a server with this flag on, and do not use it on a server with characters you care about.

## The allowed clients file

Once any entry carries a `client_secret`, the file named by `ESI_MOD_SSO_CLIENTS_PATH` holds secrets in plain text. Keep it out of version control, restrict who can read it, and give it the same handling as the `sso/` directory. A secret is never written to the console.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting: on the [repository's Security tab](https://github.com/Tokeiito/eve.js-mod-esi/security), choose **Report a vulnerability**. Do not open a public issue.

Include the version, what you found, and how to reproduce it. Do not include real tokens, keys or client secrets.
