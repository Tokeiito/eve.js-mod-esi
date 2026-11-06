# Contributing

## Setup

You need Node 24 and a clone of this repository. There is nothing to install.

```bash
npm test
```

The suite needs no eve.js checkout and boots no game server. Tests that read the outside world skip when it is absent: see "Building and testing" in the [README](README.md) for the variables that enable them.

To try a change on a real server, deploy it, restart the server, and compare `sourceHash` on `GET /_mod/health` with the hash the deploy printed:

```bash
node scripts/deploy-mod.js --target <eve.js tree>
```

## Contract first

A contract test goes in before the handler. A test written afterwards encodes whatever the handler already does, which is the failure this project exists to avoid.

`contract/` is the source of truth, and its four sources are deliberately separate:

| Source | Authoritative for |
|---|---|
| `contract/spec.js`, over the pinned `contract/openapi.json` | Body keys, required fields, types, enums, published cache TTL and rate-limit group |
| `contract/wire.js` | What the spec cannot describe: header names and casing, statuses, literal error strings, all observed on live ESI |
| `contract/golden.js` and `contract/golden/` | Whole bodies, kept as bytes and compared as bytes |
| `contract/sso.js` | The constants of `login.eveonline.com`, including its quirks |

The spec check is closed-world: an undeclared key is a failure. A replica that returns more than CCP is as distinguishable as one that returns less. Field order in a `projection()` is output order, and golden bodies compare bytes, so field order matters.

`openapi.json` is written only by `node scripts/pin-spec.js`, which never runs in the suite.

## Design constraints

1. **Zero modification of eve.js.** The mod attaches through a `--require` preload. It never edits `server/`, `config/*.json`, `package.json`, `compose.yaml` or launchers.
2. **The mod must never take the game server down.** It preloads before the game boots and shares the game's event loop. A throw at preload kills the server, and a blocking parse stalls the universe. Every failure degrades to "the mod is not running".
3. **Fidelity beats hygiene.** Where real ESI does something ugly, replicate it. Tools are written against what ESI does, not what it should do.

The code itself is Node 24, CommonJS, with `"use strict";` at the top of every file. There are no runtime dependencies, only `node:` builtins.

## Code rules

- **Never hand-assemble the layer stack in a test.** The order of the layers is behaviour. Call `createEsiDispatch` in `lib/pipeline.js`, the same builder `loader.js` calls.
- **Routes are plain functions.** A handler is `handler(params, deps)`, never sees `req` or `res`, and never requires game code. A path is written once, with no version prefix and no trailing slash.
- **Only `lib/runtimeAccess.js` requires game code.** Every module must be requirable with no eve.js checkout present. Inspect a game module's exports through `lib/exportProbe.js` only.
- **A game module that changed shape must throw,** not degrade. The drift tests then catch it.
- **Test doubles are inline** and local to the test that uses them.
- **Settled wire facts and design choices go in `docs/open-decisions.md`** as a `Dnn` row, with what was observed to settle them.

## Real accounts and identifiers

Using a real account to establish a wire fact is fine, and is often the only way. `scripts/observe-*.js` exist for this. Identifiers never enter the repository.

Record the protocol, not the payload: field order, byte counts of fixed strings, which fields are omitted, what status came back. Nothing naming a real character, account or their assets may appear in source, tests, fixtures, comments, `contract/`, golden bodies, commit messages, or forge posts.

Where a test needs an ID, prefer the example the upstream spec publishes, or a value nobody could mistake for a real one. Check your staged diff for the identifiers you used before you commit.

## Commits

```
type: a lowercase sentence saying what changed (Dnn)
```

Add the `Dnn` reference when a decision in `docs/open-decisions.md` applies. See `git log` for examples.

## Prose

Prose in this repository does not use em dashes. Use a colon, a full stop, a comma or parentheses, and rework the sentence rather than substituting a spaced hyphen.

## License

By contributing, you agree that your contribution is released under the [Unlicense](LICENSE), the same terms as the rest of the code.
