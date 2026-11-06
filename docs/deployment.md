# Deployment

How to install the mod into an eve.js server, and how to tell whether the running copy is current.

In this document `<eve.js tree>` means an eve.js checkout: the directory that contains `server/src`.

There are two install paths. Most people want the launcher.

| Path | Use it when | Updates |
|---|---|---|
| [Launcher install](#launcher-install) | You run eve.js through the EveJS Launcher | Launcher button on Native, by hand on Docker |
| [Manual install](#manual-install) | You develop this mod, or run `docker compose` yourself | `node scripts/deploy-mod.js` |

Once enabled, the mod is on by default: ESI on `127.0.0.1:26005` and SSO on `127.0.0.1:26006`, issuing tokens as `http://localhost:26006` (D47). Docker needs extra steps, because a
loopback listener inside a container cannot be reached through a published port.

## Launcher install

### Native backend

**New install.**

1. In the launcher, **Add ZIP** and choose `EveJS-ESI-<version>.zip`. The package imports disabled, as `mods/esiApi/` with `loader.js.disabled`.
2. Enable it. **Configure** opens the settings form, which saves to `mods/esiApi/settings.json`.
3. Restart the game server and [check the build](#checking-what-is-running).

**Existing folder.** Add ZIP refuses a folder that already exists. For a copy already at `<eve.js tree>/mods/esiApi/`, use **Adopt**. Migrate in this order:

1. Deploy the new build (`node scripts/deploy-mod.js --target <eve.js tree>`).
2. Rename `.env` to `.env.txt` in the deployed folder.
3. Press **Adopt**.

Keeping the file keeps an existing issuer ranked above the new default, so issued tokens stay valid.

**Updates.** The launcher replaces the whole folder on an update, keeping `settings.json` and `.env.txt`. Plain `.env` is not preserved and is lost on the first update, and the mod warns about it at boot.

**Not yet exercised.** The manifest passes the validators of launcher build 1.0.77. A real Add ZIP, Adopt and hosted update have not been run through the launcher UI.

### Managed Docker backend

Under Managed Docker the launcher runs `docker compose -f compose.yaml -f .evejs-launcher/compose.mods.yaml`. Consequences:

- The explicit `-f` turns off discovery of `compose.override.yaml`.
- The generated file sets only `NODE_OPTIONS` and a read-write bind of `mods/` to `/app/mods`. It publishes **no ports** and sets no other environment.
- That file is owned by the launcher and is replaced on rewrite, so do not add ports to it.
- Launcher updates are not offered on Docker. Replace the folder by hand, keeping `settings.json` and `.env.txt`.

What you must do:

1. **Set both bind hosts to `0.0.0.0`.** In the form, set **ESI listen address** and **SSO listen address** to `0.0.0.0`. See [Bind hosts in a container](#bind-hosts-in-a-container).
2. **Publish the ports.** Choose one:
   - **Connect-only mode with `compose.override.yaml`.** This works. You run `docker compose` yourself and keep the mount, ports and `NODE_OPTIONS` in the override, as shown in
     [Compose wiring](#compose-wiring). The launcher then cannot enable or disable mods.
   - **A sibling forwarder.** A small separate compose project on the external network `evejs-net`, publishing `127.0.0.1:26005` and `127.0.0.1:26006` and forwarding to `evejs-server:26005` and `:26006`. This
     would keep Managed mode intact and touch nothing vendor-owned. **It is untested.**
   - Do not edit `compose.yaml`. It is a vendor file.
3. **Keep the issuer reachable.** It must match what tools reach from the host. `http://localhost:26006` works with a `127.0.0.1:` publication.
4. **Use the container path for a clients file**, for example `/app/mods/esiApi-sso-clients.json`. A path that cannot be read stops the whole mod.

## Manual install

### Deploy

```bash
node scripts/deploy-mod.js --target <eve.js tree>
```

`--target` or `EVEJS_REPO_ROOT` is required; there is no default location. The script exits 2 if neither is given, or if the directory has no `server/src`.

Restart the eve.js server, then [check the build](#checking-what-is-running). The Windows launcher scripts find mods by walking `mods\*`. Under Docker, wire the mod up as below.

### Compose wiring

`compose.override.yaml` sits beside `compose.yaml` in `<eve.js tree>`. It is not a vendor file, so it can be edited; `compose.yaml`, `.dockerignore` and `docker/entrypoint.sh` are vendor files and would conflict on every distribution drop.

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

Bring it up with `docker compose up -d`. Then set the bind hosts in `<eve.js tree>/mods/esiApi/.env.txt`:

```
ESI_MOD_ESI_BIND_HOST=0.0.0.0
ESI_MOD_SSO_BIND_HOST=0.0.0.0
```

- **The mount here is read-only.** The container runs as `USER node` (uid 1000) and has no need to write into the host mod tree. The mod does not depend on this: Managed Docker mounts read-write. Durable state goes elsewhere (see
  [Durable state](#durable-state)).
- **`/app/mods` is not arbitrary.** A mod may resolve server modules relative to itself, two levels above `/app/server`.
- **Mod edits need only `docker compose restart server`, never a rebuild.** eve.js's `.dockerignore` is deny-all plus an allowlist that excludes `mods/`, so the image does not contain the directory.
- **`--require` goes in `NODE_OPTIONS`,** because `docker/entrypoint.sh` execs a hardcoded `node` command. To add a mod, add another space-separated `--require`. Unlike the Windows launcher scripts, this does not auto-discover
  `mods/*/loader.js`.

### Keeping the vendor tree clean

`mods/` is untracked in the eve.js repo but not ignored, so a deployment appears as `?? mods/` in `git status`. D5 is checked by reading that output. The deploy script prints the repair when it is missing: one line in
`.git/info/exclude`, not `.gitignore`, which is a vendor file.

```
mods/esiApi/
```

This cannot ship with the artifact, so it is a manual step, once per eve.js tree.

## Checking what is running

```bash
curl -s http://127.0.0.1:26005/_mod/health
```

`sourceHash` in that response is the short hash the deploy printed (and `scripts/build-release.js` prints). If they differ, the process is running a different build from the one on disk. `modVersion` is a hand-maintained string and does not answer this.
`/_mod/health` lives on the ESI listener and is unreachable while ESI is off.

The mod exists in three states, which can disagree in any combination:

| Where | What it is | "Is it current?" is answered by |
|---|---|---|
| This repository | The source of truth | `git status` |
| `<eve.js tree>/mods/esiApi/` | The deployed artifact | `node scripts/deploy-mod.js --check`, and `test/deployDrift.test.js` in the ordinary suite |
| The game server process | Whatever was on disk when it last started | `GET /_mod/health`, `sourceHash` |

Copying files does not reload a running server: restart it (`docker compose restart server` on Docker).

## Commands

| Command | What it does |
|---|---|
| `node scripts/deploy-mod.js --target <eve.js tree>` | Build the artifact into `<eve.js tree>/mods/esiApi/`. Prints what changed and the build identity. Without `--target`, `$EVEJS_REPO_ROOT` must be set |
| `node scripts/deploy-mod.js --check --target <eve.js tree>` | Report drift, change nothing, exit 1 if stale |
| `node scripts/build-release.js [--out <dir>]` | Build `dist/EveJS-ESI-<version>.zip` and its `.update.json` for the launcher (D47) |

Both refuse, and change nothing, when the source and the destination are the same directory or one is inside the other: clone this repository outside the eve.js tree. `--check` exits non-zero when the deployment is stale or does not exist yet. The drift test treats those differently: never-deployed is the normal state of a fresh clone and skips with a reason, while deployed-and-stale fails.

`.github/workflows/release.yml` runs the suite, checks that the tag equals `v` plus `MOD_VERSION`, and attaches both `build-release.js` assets to a GitHub release on a `v*` tag.

## What travels

The deployed directory is not this repository verbatim (D20). The manifest is `lib/sourceHash.js`'s hashed file list plus three files that are not code:

| Travels | Stays here |
|---|---|
| `loader.js`, `config.js`, `server.js` | `package.json`, `RunTests.bat` |
| Every `.js` under `lib/` and `routes/` | `test/`, `docs/`, `scripts/` |
| `.env.example`, `README.md`, `evejs-launcher.mod.json` | `.gitignore`, `.gitattributes`, `.git/` |

Defining the manifest as the hashed set means the two lists cannot drift apart, and `sourceHash` identifies the whole artifact. To widen the release set, widen `HASHED_FILES` or `HASHED_DIRS` in `lib/sourceHash.js`. `.env.example` and the
launcher manifest are the exceptions, along with `README.md`, because hashing them would move the build identity on every reworded label.

In the release ZIP the loader is `loader.js.disabled`. `scripts/deploy-mod.js` respects the state of the destination: a disabled package stays disabled, and both names never exist at once, which the launcher treats as an invalid package.

### Configuration never travels

`.env`, `.env.txt`, `.env.local`, anything else `.env.`-prefixed, and `settings.json` are never copied and never deleted from the destination. They are that server's own configuration. `.env.example` is the tracked exception and does travel.

To configure by file, copy `.env.example` to `.env.txt` in the deployed folder. Layers, lowest first: defaults, `settings.json`, `.env.txt`, `.env`, real environment. The highest layer wins per key, and the console logs any key that overrides
the form.

### Durable state

SSO's key, owner salt and refresh store live in `<gameStore root>/../sso/`, outside the mod directory (D8, D30).

| Backend | Path |
|---|---|
| Native | `_local/sso/` |
| Docker | `/var/lib/evejs/sso/`, in the `evejs-data` volume |

They survive a redeploy, a launcher update and removal of the mod. Back up all three together. Removing the mod leaves them behind, along with any clients file kept beside the mod. Delete those by hand to purge fully.

## A copy, not a junction (D21)

Linking `<eve.js tree>/mods/esiApi` at this repository would make divergence impossible, and it does not work:

1. **Node resolves the link.** CommonJS resolves a module through its real path unless `--preserve-symlinks` is passed, and neither eve.js launcher passes it. `loader.js` sets `MOD_DIR = __dirname`, and `lib/runtimeAccess.js` finds `server/src` by
   walking upward from there. Through a junction both point into this repository, the walk finds no eve.js tree, and the mod loads, reports itself active, and reaches no game state.
2. **Configuration would move into this repository.** `config.js` reads its files beside itself, via `__dirname`. Through a junction, the game server's configuration would live in the source working tree, shared by every server linked here.

`EVEJS_REPO_ROOT` works around (1) and is for tests only. Nothing works around (2).

## Runtime notes

### `NODE_OPTIONS` applies to every node process in the container

That includes eve.js's forked edge processes and its healthcheck (`node src/utils/deploymentHealthcheck.js`), and the mod is preloaded into all of them. This is safe because `loader.js` starts the listeners from the `gameRuntimeReady` hook and never from
`install()`: the healthcheck process never loads the game runtime, so it prints the banner and binds nothing.

### Bind hosts in a container

`ESI_MOD_ESI_BIND_HOST` and `ESI_MOD_SSO_BIND_HOST` default to `127.0.0.1`, which is right for a Native run and wrong inside a container: Docker publishes to the container's external interface, so a listener on the container's loopback is unreachable from a
published port. The listener binds and the port answers connection refused. Inside a container the mod logs a line when a bind host is loopback.

So in a container, bind `0.0.0.0` and enforce the loopback restriction on the host side, with the `127.0.0.1:` prefix on the published port. The mod warns at boot about any bind host that is not `127.0.0.1`. Read that warning together with the publish address,
because together they state the actual exposure. Plain HTTP on a network address exposes live game data.

### Ports

D1 assigns 26005 to ESI and 26006 to SSO, and D6 keeps them on two ports. See [d6-listener-split.md](d6-listener-split.md). Both are armed by default (D47) and both need publishing under Docker. In use elsewhere in eve.js: 443, 26000, 26001, 26002, 26003, 26400, 40110,
40111. `nexumApi` uses 26004 by convention.
