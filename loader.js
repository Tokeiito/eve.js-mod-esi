/**
 * eve.js-mod-esi: loader
 *
 * The mod's only entry point and the only file that is not a module: it exports
 * nothing, and Node loads it via `--require <mod>/loader.js`. The EveJS Launcher does
 * that for a package installed from `evejs-launcher.mod.json` (D47), and a plain
 * `--require`, for example in `NODE_OPTIONS`, works the same way. eve.js exposes no
 * lifecycle API to a mod, so a preload plus a `Module._load` interceptor is the whole
 * attachment mechanism. Deleting `mods/esiApi/` removes the mod completely (hard
 * constraint D5), which is why it configures itself out of its own directory.
 *
 * What it does, in order:
 *
 *   1. Parses configuration (config.js). `ESI_MOD_ESI_PORT` and `ESI_MOD_SSO_ISSUER`
 *      are the two switches, armed by default (D47): blank turns that listener off,
 *      and both blank installs nothing. A package nobody enabled never gets here,
 *      because the launcher ships it as `loader.js.disabled`.
 *   2. Installs one `Module._load` hook, which watches every require() in the process
 *      for the game modules this mod attaches to and runs one handler per module, once.
 *   3. Prints one banner naming the version and the build.
 *
 * The HTTP listeners are deliberately not in that list (see "Two guards" below).
 *
 * Why the whole file is wrapped in one try/catch
 * eve.js wraps its secondary services in a try/catch, but that does not cover
 * `--require` preloads: this code runs before the game server has started, so a throw
 * here kills the server before it boots. design constraint 2 (the mod must never
 * take the game server down) is therefore enforced structurally: `install()` is called
 * inside a try/catch, every hook `run` is inside its own, and the listener's promise
 * rejection is handled at the call site. Every failure this file can have degrades to
 * "the mod is not running", which does not affect the game server.
 *
 * Why no game code is required here
 * Requiring game modules from a preload pulls them in ahead of the server's own
 * initialisation, in an undefined order. Game code is reached only through
 * `lib/runtimeAccess.js`, lazily, and only after the readiness hook has seen the
 * runtime come up.
 *
 * Mod-internal modules are lazy too: `./config` (and, once the config says the mod is
 * wanted, the three pure modules the hook table needs) from inside `install()`, and
 * everything else from inside a handler. That keeps the preload phase to configuration
 * parsing, and a syntax error in a module not yet reached surfaces as a caught error
 * and an inert mod rather than stopping the game from booting.
 *
 * Two guards, because `NODE_OPTIONS` is process-wide
 * `NODE_OPTIONS` applies to every node process in the container. eve.js forks around
 * five edge processes (gateway, game, chat, image, redshift) plus a healthcheck, and
 * this file is preloaded into all of them and, since worker threads inherit `execArgv`,
 * into every worker thread they spawn.
 *
 *   1. `isMainThread` keeps the loader out of worker threads. A worker gets a fresh
 *      `globalThis`, so the install flag below cannot see the install that already
 *      happened on the thread that spawned it.
 *   2. The listener starts from the game-runtime-readiness hook, never from
 *      `install()`. Every process installs the hook, which is a harmless function
 *      wrapper, but only the process that loads the game's state layer fires it. That
 *      keeps the healthcheck process from binding the ESI or SSO port out from under
 *      the game process, and means exactly one process binds the listener ports without
 *      this file needing to know which process it is in.
 *
 * Extension is one entry in `buildHooks()` below.
 */

"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");

const LOG_PREFIX = "[EsiApiMod]";

/**
 * The mod's own directory: `__dirname`, never the working directory.
 *
 * The processes this file is preloaded into do not agree on a cwd, and nothing sets one
 * for them. Every mod-internal require and the source hash resolve against this, so the
 * mod works identically from a container, a launcher script and a test child.
 */
const MOD_DIR = __dirname;

/**
 * One process installs one hook, ever.
 *
 * Node's module cache already makes a repeated `--require` of the same resolved path a
 * no-op. This covers the same loader reached by two different paths: a symlinked `mods/`
 * directory, a launcher that globs and also names a mod explicitly, a stale copy beside a
 * fresh one. A second `Module._load` wrapper would double every handler call and every
 * export probe on every require in the process.
 */
const INSTALL_FLAG = "__esiApiModLoaderInstalled";

// Logging
// `console` only. The game's logger lives in `server/src`, and requiring it here would
// break the no-game-code-at-preload rule. These two are also handed to server.js, so
// everything the mod prints carries one prefix and a grep finds all of it.
function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logError(message, err) {
  console.error(`${LOG_PREFIX} ${message}`);
  if (err && err.stack) console.error(err.stack);
}

/**
 * Require one of the mod's own modules, by path relative to the mod directory.
 *
 * Relative to `MOD_DIR` rather than this file's own resolution, because the deployed copy
 * at `<eve.js tree>/mods/esiApi/` and this repository have the same layout and must resolve the
 * same way.
 */
function requireModModule(relativePath) {
  return require(path.join(MOD_DIR, relativePath));
}

// The HTTP listener

/**
 * Every live listener handle.
 *
 * An array because D6 gives this mod two listeners (ESI, and SSO when an issuer is
 * configured), and here they are simply handles that would need closing. Nothing closes
 * them today: every handle is `unref()`'d, so both die with the game process, and a preload
 * must not install a `process.on("exit")` inside a server it does not own. A shutdown path
 * would be `listeners.forEach`. Every started handle must be recorded here.
 *
 * `starting` is separate because `startServer` is asynchronous: between the call and its
 * resolution the array is still empty, and a second call in that window would bind a second
 * socket to the same port. The hook table's run-once bookkeeping already makes that
 * unreachable; this guard does not depend on a caller elsewhere staying correct.
 */
const listeners = [];
let listenerStarting = false;

/**
 * Bring the listeners up. Called from the readiness hook, never from `install()` (guard 2
 * in the file header).
 *
 * The readiness hook makes two things true at once: the game data behind the ports is
 * reachable, so they do not answer early, and requiring `lib/runtimeAccess.js`, the one
 * module that reaches for game code, is no longer premature.
 */
function startHttpListener(context) {
  if (listeners.length > 0 || listenerStarting) return;
  listenerStarting = true;

  const { startServer } = requireModModule("./server");
  const { HEALTH_PATH, createHealthDispatch } = requireModModule("./routes/health");
  const { createPingDispatch } = requireModModule("./routes/ping");
  const { createStatusRoute } = requireModModule("./routes/status");
  const { createMetaCompatibilityDatesRoute } = requireModModule("./routes/meta");
  const {
    createMarketPricesRoute,
    createMarketRegionOrdersRoute,
  } = requireModModule("./routes/markets");
  const {
    createCharacterLocationRoute,
    createCharacterOnlineRoute,
    createCharacterShipRoute,
  } = requireModModule("./routes/characters");
  const { createCharacterRolesRoute } = requireModModule("./routes/roles");
  const { createCharacterSkillsRoute } = requireModModule("./routes/skills");
  const {
    createUniverseIdsRoute,
    createUniverseNamesRoute,
  } = requireModModule("./routes/names");
  const {
    createCharacterAssetsRoute,
    createCorporationAssetsRoute,
  } = requireModModule("./routes/assets");
  const {
    createCharacterBlueprintsRoute,
    createCorporationBlueprintsRoute,
  } = requireModModule("./routes/blueprints");
  const {
    createCharacterIndustryJobsRoute,
    createCorporationIndustryJobsRoute,
    createIndustrySystemsRoute,
  } = requireModModule("./routes/industry");
  const {
    createCharacterOrdersRoute,
    createStructureOrdersRoute,
  } = requireModModule("./routes/orders");
  const {
    createCorporationStructuresRoute,
    createUniverseStructureRoute,
  } = requireModModule("./routes/structures");
  const {
    createCharacterFleetRoute,
    createFleetMembersRoute,
  } = requireModModule("./routes/fleets");
  const {
    createAllianceContactsRoute,
    createCharacterContactsRoute,
    createCorporationContactsRoute,
  } = requireModModule("./routes/contacts");
  const { createSetWaypointRoute } = requireModModule("./routes/ui");
  const {
    createUniverseConstellationRoute,
    createUniverseStarRoute,
    createUniverseStationRoute,
    createUniverseSystemRoute,
  } = requireModModule("./routes/universe");
  const {
    createAlliancePublicRoute,
    createCharacterPublicRoute,
    createCorporationPublicRoute,
    createUniverseFactionsRoute,
  } = requireModModule("./routes/entities");
  const { createUniverseStore } = requireModModule("./lib/universeStore");
  const { createStaticSnapshot } = requireModModule("./lib/staticSnapshot");
  const { createEsiDispatch } = requireModModule("./lib/pipeline");
  const { createRouter } = requireModModule("./lib/router");

  // Built here so the four static-universe routes share them: one store, so the indexes over
  // half a million celestials are built once, and one snapshot, so all four answer with the
  // identical validator, as CCP's static-data routes do. Neither touches the game at
  // construction: the store indexes lazily on the first request that needs one, and the
  // snapshot reads the store's `source` stamp the first time it is asked for facts.
  const universeStore = createUniverseStore();
  // The validator names both inputs to these bodies: which dump the store was built from, and
  // which build of this mod projects it. `context.sourceHash` is the value the banner prints,
  // `/_mod/health` reports and `scripts/deploy-mod.js` stamps, so a new etag and a new build
  // are one event.
  const universeSnapshot = createStaticSnapshot({
    readIdentity: () => universeStore.identity(),
    build: context.sourceHash,
  });
  const universeDeps = {
    store: universeStore,
    snapshot: (now) => universeSnapshot.facts(now),
  };

  // The two stores the asset family reads through, built here so the three routes share them.
  // Neither indexes anything at construction: the static halves (stations, solar systems) are
  // memoised on first use and the live halves (items, industryJobs) are never memoised,
  // because an item moves and a job's status changes on a timer.
  //
  // The game's own reads write. `itemStore`'s every public read begins with `ensureMigrated`,
  // which can rewrite and persist the whole inventory; `getBlueprintState` seeds and persists
  // a record for a blueprint it has not seen. Reading the tables through the read-only handle
  // keeps a `GET` from reshaping a pilot's stacks or granting them blueprint state. See
  // `lib/assetStore.js`.
  const assetDeps = {
    assets: requireModModule("./lib/assetStore").createAssetStore(),
    industry: requireModModule("./lib/industryStore").createIndustryStore(),
  };

  // The market daemon's order book, for the two routes that read an owner's own orders rather
  // than a region's. `lib/marketStore.js` opens its SQLite lazily and read-only, so this line
  // touches no file.
  //
  // The readers are a plain object rather than the module, so the routes state what they
  // need: two queries, not the whole store.
  const marketStore = requireModModule("./lib/marketStore");
  const orderDeps = {
    market: {
      readOwnerOrders: (ownerId, options) => marketStore.readOwnerOrders(ownerId, options),
      readStructureOrders: (structureId, options) =>
        marketStore.readStructureOrders(structureId, options),
    },
    runtime: context.runtime,
  };

  // The corporation twins need the runtime as well, for the role gate.
  const corporationAssetDeps = { ...assetDeps, runtime: context.runtime };

  // Built here because both name-resolution routes read it, and an index per route would
  // build 52,590 type entries twice. It indexes nothing at construction: each of its ten
  // sources is read on the first request that needs it, so this line touches neither the
  // game store nor the dump.
  //
  // `onAmbiguous` is the one dependency the universe store does not have. D9 records that no
  // id on this server is claimed by two categories, and the index checks that. A collision is
  // omitted from the answer, invisibly to the client by design, so the log is the only place
  // an operator can see that the id space has stopped being what D9 measured.
  const nameDeps = {
    names: requireModModule("./lib/nameIndex").createNameIndex({
      onAmbiguous: (err) => log(err.message),
    }),
  };

  // When the listener came up, which is what an operator reading uptime means. `/status/`'s
  // `start_time` uses the same instant: the mod is preloaded into the game process, so the
  // two are within a second of each other.
  const startedAt = Date.now();

  // `runtime` and `sourceHash` are passed in rather than looked up again: `routes/` requires
  // no mod module of its own (so each can be tested with a double), and the hash was already
  // computed for the banner. Hashing twice could also give two answers if a file changed
  // between the reads.
  const healthDispatch = createHealthDispatch({
    config: context.config,
    runtime: context.runtime,
    modDir: context.modDir,
    sourceHash: context.sourceHash,
    startedAt,
  });

  // The ESI surface
  //
  // Assigned when the SSO surface starts, below, and read per request by the ESI stack's
  // credential layer. One verifier for both surfaces: the tokens ESI accepts are the ones
  // `/v2/oauth/verify` accepts, from the same key.
  let bearerVerifier = null;

  // The route table is everything this replica answers. A route declares its own path, cache
  // TTL, rate-limit group, error family and success producer; the router validates all of
  // that at construction, so a mistake fails here at boot, naming the route, rather than on a
  // request.
  const router = createRouter([
    createStatusRoute({ runtime: context.runtime, startedAt }),
    // Unversioned, and about the surface rather than the game, so it takes no `deps`.
    createMetaCompatibilityDatesRoute(),
    // The two market-hub-seed reads. They take no `deps`: the order book is the market daemon's
    // SQLite, not game module state, and `lib/marketStore.js` is the one place that reaches it.
    createMarketPricesRoute(),
    createMarketRegionOrdersRoute(),
    // Authenticated routes. Each declares an OAuth scope, which arms the credential gate: an
    // absent credential, a token without that scope, and a token whose subject is not the
    // `:character_id` in the path are all refused before the handler runs, so
    // `routes/characters.js` checks none of it.
    //
    // They take the runtime because they read live character state: presence through
    // `characterControlRuntime`, because a browser pilot never enters the session registry and
    // `sessionRegistry` would report every one of them offline; location and ship off the
    // character record, through `peekCharacterRecord` rather than `getCharacterRecord`, which
    // is a read that writes.
    createCharacterOnlineRoute({ runtime: context.runtime }),
    createCharacterLocationRoute({ runtime: context.runtime }),
    createCharacterShipRoute({ runtime: context.runtime }),

    // A route that declares a scope and sends JSON has exactly one legal producer.
    // `lib/router.js` `assertScope` refuses at construction to compile a scoped route on the
    // gateway, `meta` is the `/meta/` surface, and `null` claims the route sends no JSON, which
    // leaves `app`. Every authenticated operation observed so far also turned out to be `app`.
    //
    // What is still unobserved about two of these five is handled inside them: the field order
    // of each success body, the ACL refusal on a structure the caller cannot see, and
    // `role_name`. None of that justifies an unrouted 404 for an endpoint this replica
    // implements.
    createCharacterRolesRoute({ runtime: context.runtime }),
    createCorporationStructuresRoute({ runtime: context.runtime }),
    createCharacterFleetRoute({ runtime: context.runtime }),
    createFleetMembersRoute({ runtime: context.runtime }),
    createUniverseStructureRoute({ runtime: context.runtime }),

    // A pilot's trained skills. Its game-side read has no non-writing door.
    //
    // `/location/` and `/ship/` have `peekCharacterRecord` beside the `getCharacterRecord` that
    // writes. `skillState` has no such pair: all five of its public reads funnel through
    // `ensureCharacterSkills`, which seeds a skill set for a character who has none, persists a
    // re-normalised table, and writes the total back onto the character record. So this route
    // reads the `skills` table through the read-only handle (`lib/runtimeAccess.js`
    // `listCharacterSkills`, which cannot write it) and sums the total itself.
    //
    // Nothing about this operation was captured on 2026-08-25, so unlike the five above there
    // is no `contract/wire.js` record to cite. What remains unobserved is argued inside the
    // route: the field order of the body, the row order of `skills[]`, and whether CCP sends a
    // zero `unallocated_sp` or omits it.
    createCharacterSkillsRoute({ runtime: context.runtime }),

    // The three standings buckets: paginated and authenticated, so the page snapshot is per
    // caller's entity rather than per public resource.
    //
    // Two are gated on something a scope cannot express, in different ways. The corporation one
    // refuses with bytes captured on that route. The alliance one has no captured bytes and
    // refuses as a logged 500 rather than inventing a wording, as `lib/router.js` documents and
    // `routes/contacts.js` argues. Both refuse the read.
    createCharacterContactsRoute({ runtime: context.runtime }),
    createCorporationContactsRoute({ runtime: context.runtime }),
    createAllianceContactsRoute({ runtime: context.runtime }),

    // The only route in this table that writes into the game.
    //
    // It takes `log`, this file's, because D34 settled that the outcome of a push is an
    // operator's fact and not a caller's. The route answers `204` whether the pilot was
    // reachable, absent or browser-controlled, so the log line is the only place the difference
    // appears.
    //
    // The notification the client listens for was confirmed against a live client on
    // 2026-08-25, so it is not behind a flag. `lib/runtimeAccess.js` has what was seen.
    createSetWaypointRoute({ runtime: context.runtime, log }),

    // Four reads of the static universe every EVE tool assumes it can look things up in.
    //
    // They take no `runtime`. `lib/universeStore.js` is the one place that reaches the
    // SDE-derived tables and the extracted dump, as `lib/marketStore.js` is for the order book,
    // and the built store is passed in so all four share its indexes.
    //
    // They declare a `snapshot` instead of a `cacheTtl`: CCP publishes no `x-cache-age` for any
    // of them and expires them all at 11:05 daily, off one shared weak etag. See D43 and
    // `lib/staticSnapshot.js`, which has the capture.
    createUniverseSystemRoute(universeDeps),
    createUniverseStarRoute(universeDeps),
    createUniverseConstellationRoute(universeDeps),
    createUniverseStationRoute(universeDeps),

    // Four public entity lookups, public and on the gateway at once. Their `422` for an id
    // outside CCP's range and their `{status, error, details}` refusals follow from that
    // declaration.
    //
    // `GET /characters/{character_id}/` needs care: it is on eve-nexum's login path, where a
    // non-2xx blocks login outright with `?error=corp_check_failed`, and it sits directly above
    // three scoped routes registered above. The router matches on segment count, so the public
    // parent and `/online/`, `/location/` and `/ship/` cannot shadow each other;
    // `test/entitiesContract.test.js` asserts it.
    //
    // `/universe/factions/` is here rather than in `routes/universe.js` because it is a roster
    // of named entities, not geometry, and because a route registered from two files is a boot
    // failure. It takes the same snapshot function as the four routes above: one dump, one
    // validator, so a faction and a solar system carry the identical `Etag`, as they do from
    // CCP.
    createCharacterPublicRoute({ runtime: context.runtime }),
    createCorporationPublicRoute({ runtime: context.runtime }),
    createAlliancePublicRoute({ runtime: context.runtime }),
    createUniverseFactionsRoute({
      runtime: context.runtime,
      snapshot: universeDeps.snapshot,
    }),

    // The two name resolvers, which read a request body. `server.js` draws one on every method
    // and `lib/router.js` carries it to handlers; the validation and refusal are
    // `lib/errors.js` `invalidBody`, the one refusal in that file whose wording is this
    // replica's rather than a capture.
    //
    // They declare a `null` cacheTtl. CCP publishes no `x-cache-age` for either, so
    // `lib/cache.js` sends the validators and makes no freshness claim: an `Etag` and a
    // `Last-Modified`, no `Cache-Control` and no `Expires`. That reproduces the document's
    // absence.
    //
    // They take `nameDeps` and no `runtime`: `lib/nameIndex.js` reaches the ten sources through
    // the read-only repository and the dump, as `lib/universeStore.js` does for the four routes
    // above.
    createUniverseNamesRoute(nameDeps),
    createUniverseIdsRoute(nameDeps),

    // The asset family: what a pilot owns, what they can build from, and what they are
    // building. Three routes over two tables. `location_flag` comes from a closed 89-value enum
    // that eve.js stores as a bare integer with no join table anywhere in the tree.
    // `lib/locationFlags.js` is that join, and a flag it cannot name is a logged 500 rather
    // than a dropped row: an industry tool would reconcile a quietly short asset list against a
    // build plan and report the wrong cause.
    //
    // Two of the three paginate because the document says so, not because of size:
    // `/industry/jobs/` declares no `page` parameter and carries the shortest TTL on the
    // family, 300 seconds, because a job's status changes on a timer.
    createCharacterAssetsRoute(assetDeps),
    createCharacterBlueprintsRoute(assetDeps),
    createCharacterIndustryJobsRoute(assetDeps),

    // The corporation twins: the same three bodies from the same two tables, with a gate as the
    // only difference. They also take `runtime`, unlike the character routes: the gate reads
    // the caller's own corporation and role masks off the game.
    //
    // `routes/roles.js` `corporationRoleSubject` is that gate, shared with
    // `/corporations/{id}/structures/` rather than copied: two disagreeing answers to "what
    // counts as an entity id in a path segment" would allow reading another corporation's data
    // inside the authorised path.
    //
    // The roles are CCP's `x-required-roles` verbatim: Director on the two property routes,
    // Factory_Manager on production. A Director reaches the Factory_Manager route anyway,
    // because eve.js grants a director the full administrative mask at read time, as EVE does.
    createCorporationAssetsRoute(corporationAssetDeps),
    createCorporationBlueprintsRoute(corporationAssetDeps),
    createCorporationIndustryJobsRoute(corporationAssetDeps),

    // The market family's authenticated half: a pilot's own orders, and the book inside a
    // player-owned structure. Both read the daemon's SQLite rather than the game store, a
    // coupling lib/marketStore.js keeps in one place.
    //
    // They differ from /markets/{region_id}/orders/ in more than a filter: that body carries
    // system_id and these carry region_id, escrow and is_corporation between them, and the
    // structure body declares required what the character body declares optional. Three
    // projections of one row.
    //
    // The structure route's ACL is ownership, where CCP's is market access. That is
    // deliberately narrower: a gate that is too tight refuses a read somebody was entitled to,
    // and one too loose hands one corporation another's book. routes/orders.js says what doing
    // better would take.
    createCharacterOrdersRoute(orderDeps),
    createStructureOrdersRoute(orderDeps),

    // The public industry read and the largest body this replica serves: 8,490 systems times
    // six activities, 2.79 MB. Every system reports the same index for every activity, because
    // eve.js's own resolveSystemCostIndex ignores both of its arguments and returns one
    // configured number for the whole cluster. Anything else would disagree with what this
    // server's job quotes charge.
    //
    // It takes the universe store the four static-universe routes share, for the set of system
    // ids.
    createIndustrySystemsRoute({ store: universeStore }),
  ]);

  // Composed outermost-first, and the order is load-bearing:
  //
  //   /_mod/health   ours, never ESI's. Answered before anything can decorate it: a CORS
  //                  header on a diagnostic would be noise, and no ESI route can collide
  //                  with a `/_mod/` path.
  //   /ping          two bytes and no headers at all. Ahead of everything because on real
  //                  ESI it carries none, so it never reaches a layer rather than having
  //                  headers stripped afterwards.
  //   everything     the nine-layer ESI stack, which `lib/pipeline.js` owns.
  //
  // There is one construction of the stack, called from here and from the tests, because the
  // order is the behaviour and a test's private copy of it cannot catch a misplaced layer.
  //
  // The verifier is late-bound on purpose: the SSO surface owns the signing key, loads it
  // further down, and may fail without taking ESI with it. Read at construction it would be
  // `null` on every request forever; read per request, ESI starts verifying the moment SSO
  // has a key and keeps serving when it never does.
  //
  // `lib/bearerCredential.js` says what the null case costs.
  const esiDispatch = createEsiDispatch(router, {
    logError,
    verifier: () => bearerVerifier,
    log,
    // D44. Unset, this is `lib/errorLimiter.js`'s own default (CCP's observed 100). The config
    // layer already resolved that, so this is never `null` or `undefined` for a config that
    // reached this line.
    errorLimitMaxErrors: context.config.errorLimitMaxErrors,
  });

  const pingDispatch = createPingDispatch(esiDispatch);

  const dispatch = (request) => (
    request && request.pathname === HEALTH_PATH
      ? healthDispatch(request)
      : pingDispatch(request)
  );

  // Both listeners are launched from here and fail independently: an SSO port that cannot be
  // bound must not cost ESI, and the reverse.
  const starting = [];
  if (context.config.esiPort !== null) {
    starting.push(startListener(
      startServer({ config: context.config, listener: "esi", dispatch, log, logError }),
      "ESI listener did not start: the mod is loaded but unreachable",
    ));
  }

  // The SSO surface (D6)
  //
  // A second listener on a second port, not the ESI stack with extra routes. D6 split them so
  // that the error limiter never covers token traffic and `oauth` never enters the router's
  // version-prefix namespace: `/v2/oauth/token` is a literal path here. `lib/ssoDispatch.js`
  // has the full reasoning.
  //
  // The issuer is the switch (D7, D47). Blank, there is no SSO listener; `install()` says so
  // once in the banner, and the mod carries on serving ESI, a complete replica for every
  // consumer of public data.
  const issuer = context.config.ssoIssuer;
  if (issuer) {
    const pending = startSsoListener(context, issuer, startServer, {
      // The ESI stack's credential layer reads this per request. Passed over rather than rebuilt,
      // so the tokens ESI accepts are exactly the ones `/v2/oauth/verify` accepts: one key, one
      // issuer, one clock tolerance.
      publishVerifier: (verifier) => { bearerVerifier = verifier; },
    });
    if (pending) starting.push(pending);
  }

  // Cleared once every listener has settled, not by whichever finished first: an early clear
  // would reopen the re-entry window this flag closes while the other listener is still
  // binding.
  Promise.all(starting).then(() => {
    listenerStarting = false;
  });
}

/**
 * Build the SSO surface and bind it, or decline, on this surface alone.
 *
 * Separate from `startHttpListener` because SSO has a third startup outcome. ESI either
 * binds or logs why it could not; SSO can also refuse before there is a port to bind, and
 * must refuse rather than improvise. The whole body is in one try/catch, and every failure
 * degrades the same way: the mod stays loaded, the ESI listener is untouched, and one line
 * says what is wrong and what to do.
 *
 * The refusals belong to the three credentials in `<game store root>/../sso/` (D8, D30):
 *
 *   The accessors in `lib/runtimeAccess.js` answer `{ path, reason }` rather than a bare
 *   path, because an unresolvable location means SSO cannot serve at all.
 *   `getMarketDbPath`'s bare `null` differs: an absent database degrades to an empty order
 *   book, but nothing can sign a token with no key.
 *
 *   Each loader throws its own error for a file that exists and cannot be used:
 *   `SigningKeyError` for a key that is corrupt, not RSA, under 2048 bits or unreadable;
 *   `OwnerSaltError` for a salt that is short or unreadable; `RefreshTokenStoreError` for a
 *   store that does not parse. All refuse rather than regenerate, and every refusal must
 *   reach this catch. Silently replacing any of them destroys state this mod cannot rebuild
 *   while reporting a normal startup: a new key invalidates every access token, a new salt
 *   makes every client read every character as transferred, a fresh store logs every tool
 *   out (D30). The only allowed response is a caught exception and a dormant SSO surface.
 *
 * Returns the pending start, or `null` when the surface declined.
 */
// The bind flow, shared by two entry points

/**
 * Built once, lazily, and handed to both halves of the in-game grant.
 *
 * The HTTP mint and the slash-command redeem share only this process, which is why
 * `lib/pendingBinds.js` keeps its table in module state, so they must be given the same
 * store or every code minted by the listener is unknown to the command that redeems it.
 * Neither may build its own.
 *
 * Lazy because the callers arrive in an order this file does not control: the listener
 * starts from the readiness hook, and the slash hook fires whenever the game requires
 * `slashService`. The first builds it.
 *
 * Safe as process-wide state because this file guarantees one such process: the readiness
 * hook keys off a module the game-state process loads and the edge processes and
 * healthcheck do not (guard 2 in the file header). Otherwise a bind minted in one process
 * and typed in another would never be found.
 */
let bindParts = null;

function getBindParts() {
  if (bindParts) return bindParts;

  const { createBindRateLimiter } = requireModModule("./lib/bindRateLimiter");
  const { createPendingBindStore } = requireModModule("./lib/pendingBinds");
  const { generateBindCode } = requireModModule("./lib/bindCodes");
  const { createBindFlow } = requireModModule("./lib/bindFlow");

  const now = () => Date.now();

  // Both limits are per minute and are the store's named security properties;
  // `lib/pendingBinds.js` documents each at its call site. Passing `null` for either silently
  // ships neither defence.
  //
  // Minting, keyed per session, is the heap-exhaustion defence. Every mint is an entry in a
  // table inside the game server's process. A browser needs one code per sign-in and a person
  // who mistypes might restart two or three times, so ten a minute is past honest use and far
  // below anything that pressures the heap.
  //
  // Redeeming, keyed per character, is the guessing defence, and makes a 39-bit code
  // adequate. A player types one code, once. Five a minute leaves room for typos and puts a
  // brute force at roughly 10^11 minutes per character, against an attacker who must first
  // own a character to try at all.
  const store = createPendingBindStore({
    now,
    generateCode: generateBindCode,
    mintLimiter: createBindRateLimiter({ limit: 10 }),
    redeemLimiter: createBindRateLimiter({ limit: 5 }),
  });

  bindParts = Object.freeze({ store, flow: createBindFlow({ store, now }) });
  return bindParts;
}

// The three durable SSO credentials

/**
 * Decide where the signing key, the owner salt and the refresh-token store are.
 *
 * Configured-else-derived is settled here rather than in either module:
 * `lib/runtimeAccess.js` reads no configuration and the three loaders take their path as an
 * argument, which keeps all four testable without a game or an operator. This file is where
 * configuration and the runtime meet.
 *
 * Two overrides, at two levels:
 *
 *   `ESI_MOD_SSO_STATE_DIR` names the directory, and therefore all three files. D30 named
 *   this shape ("one knob over the directory rather than a second over a file inside it"),
 *   and it makes a boot with no game store possible, because the derivation needs a live
 *   one.
 *
 *   `ESI_MOD_SIGNING_KEY_PATH` names the key file alone, for an operator supplying a key
 *   they generated. `config.js` argues both.
 *
 * Absence of both is the normal case: derive from the game store. Throws when nothing can
 * be resolved, which lands in `startSsoListener`'s catch as a refusal rather than a guess.
 */
function resolveSsoPaths(context) {
  const { config, runtime } = context;

  // The join happens in `lib/runtimeAccess.js` even for a directory passed in, so a named
  // directory and a derived one cannot disagree about which files are in an `sso/`.
  const fromDir = config.ssoStateDir ? runtime.ssoPathsFromDir(config.ssoStateDir) : null;

  // Unreachable through `config.js`, which already refuses anything but an absolute path.
  // Checked anyway: the failure is silently falling through to the derived location, which
  // would put three credentials somewhere other than where the operator named.
  if (config.ssoStateDir && fromDir === null) {
    // The value is not quoted back. `config.js` never renders this path either: it points at
    // all three of the mod's secrets, and a console line naming it ends up in pasted bug
    // reports.
    throw new Error(
      "ESI_MOD_SSO_STATE_DIR is set to something that is not a usable directory path.",
    );
  }

  // Derived. Each accessor answers `{ path, reason }`, and they fail together because all
  // three come from the same game store root, so one reason covers them. It is the only
  // output an operator gets, so it is carried up rather than dropped for a bare null.
  const derived = fromDir === null
    ? {
      signingKey: runtime.getSigningKeyPath(),
      ownerSalt: runtime.getOwnerSaltPath(),
      refreshTokens: runtime.getRefreshTokenStorePath(),
    }
    : null;

  if (derived !== null) {
    const unresolved = [derived.signingKey, derived.ownerSalt, derived.refreshTokens]
      .find((answer) => !answer.path);
    if (unresolved) {
      // Names the setting, because "the game store root could not be resolved" alone gives no
      // remedy to the one environment that reaches this: a boot with no game tree.
      throw new Error(
        `${unresolved.reason}: the mod's signing key, owner salt and refresh tokens are `
          + "derived from it. Set ESI_MOD_SSO_STATE_DIR to an absolute directory to name "
          + "their location instead, or start where a game store can be resolved.",
      );
    }
  }

  return Object.freeze({
    // Configured file, else configured directory, else derived. The key is the only one of the
    // three with a file-level override.
    signingKeyPath: config.signingKeyPath
      || (fromDir ? fromDir.signingKeyPath : derived.signingKey.path),
    ownerSaltPath: fromDir ? fromDir.ownerSaltPath : derived.ownerSalt.path,
    refreshTokenStorePath: fromDir
      ? fromDir.refreshTokenStorePath
      : derived.refreshTokens.path,
  });
}

/**
 * Load all three before the route table, and report every one that failed.
 *
 * A credential this surface cannot serve without is a startup failure, not one discovered
 * by whoever signs in first. A salt that does not load is a token endpoint that cannot
 * compute `owner`; a store that does not parse is a grant that cannot be persisted. Neither
 * has a degraded mode.
 *
 * All three are attempted rather than stopping at the first, because they sit in one
 * directory, are created together and are lost together (a bad backup restore, a wrong
 * `ESI_MOD_SSO_STATE_DIR`, a half-copied volume). Stopping at the first would make an
 * operator restart a game server once per credential, so there is one refusal listing
 * everything, as `config.js` does for configuration problems.
 *
 * The order is the order a sign-in would reach them: the key signs the access token, the
 * salt shapes a claim inside it, the store holds the grant that outlives it.
 *
 * A failed boot must not swallow a "back it up" notice. Every loader creates its file when
 * absent, and two of them say so exactly once in the life of a deployment; a later boot
 * says "loaded from", not "generated". A boot that creates the salt and then refuses over
 * the store would print that secret's only notice above a refusal, so the refusal repeats
 * it. Losing the salt re-authorises every character at once, and a secret nobody was told
 * about is not backed up.
 *
 * Returns a frozen `{ signingKey, ownerSalt, refreshTokens }`; throws one error naming
 * every failure, which lands in `startSsoListener`'s catch.
 */
function loadSsoCredentials(context) {
  const { loadOrCreateSigningKey } = requireModModule("./lib/signingKey");
  const { loadOrCreateOwnerSalt } = requireModModule("./lib/ownerSalt");
  const { createRefreshTokenStore } = requireModModule("./lib/refreshTokens");

  // Before any loading, so an unresolvable location is one sentence rather than the same
  // sentence three times.
  const paths = resolveSsoPaths(context);

  const failures = [];

  function attempt(what, load) {
    try {
      return load();
    } catch (err) {
      // The message, not the stack: each loader writes a sentence naming its own file and remedy,
      // and three stacks in a game server's console would bury them.
      failures.push(`${what}: ${err && err.message ? err.message : String(err)}`);
      return null;
    }
  }

  // Every loader gets `log`, which is how their own lines (the path, the fingerprint, the
  // permission warning, the "back it up") reach the operator. None is handed anything that
  // would let it print the secret itself, which each module's own suite asserts.
  const signingKey = attempt("signing key", () => loadOrCreateSigningKey({
    keyPath: paths.signingKeyPath,
    log,
  }));

  const ownerSalt = attempt("owner salt", () => loadOrCreateOwnerSalt({
    saltPath: paths.ownerSaltPath,
    log,
  }));

  // `now` is required and has no default in that module, so a caller cannot depend on a clock
  // it did not choose. This is the same `Date.now` the authorization codes and the bind table
  // run on.
  const refreshTokens = attempt("refresh token store", () => createRefreshTokenStore({
    storePath: paths.refreshTokenStorePath,
    now: () => Date.now(),
    log,
  }));

  if (failures.length > 0) {
    // A credential this boot created while a sibling was failing. Repeated into the refusal
    // because the loader's own "back it up" line has scrolled past the errors, and it is never
    // printed again.
    const created = [];
    if (signingKey && signingKey.created) created.push(`the signing key at ${paths.signingKeyPath}`);
    if (ownerSalt && ownerSalt.created) created.push(`the owner salt at ${paths.ownerSaltPath}`);

    throw new Error(
      `${failures.length} of the 3 durable SSO credentials could not be loaded:\n`
        + failures.map((failure) => `  - ${failure}`).join("\n")
        + (created.length === 0
          ? ""
          : `\n  note: this boot created ${created.join(" and ")}. `
            + "That is a new secret and this is the only time it is announced: back it up "
            + "before fixing the above, or it will be silently in use from the next boot on."),
    );
  }

  return Object.freeze({ signingKey, ownerSalt, refreshTokens });
}

function startSsoListener(context, issuer, startServer, { publishVerifier = () => {} } = {}) {
  let ssoDispatch;

  try {
    const { createSsoDispatch } = requireModModule("./lib/ssoDispatch");
    const { createOauthDiscoveryRoute } = requireModModule("./routes/oauthDiscovery");
    const { createOauthJwksRoute } = requireModModule("./routes/oauthJwks");
    const { createOauthAuthorizeRoute } = requireModModule("./routes/oauthAuthorize");
    const { createOauthTokenRoute } = requireModModule("./routes/oauthToken");
    const { createOauthVerifyRoute } = requireModModule("./routes/oauthVerify");
    const { createOauthRevokeRoute } = requireModModule("./routes/oauthRevoke");
    const { createBearerVerifier } = requireModModule("./lib/bearerToken");
    const { createClientAuthenticator } = requireModModule("./lib/clientAuth");
    const { createAccessTokenMinter } = requireModModule("./lib/accessToken");
    const { createClientRegistry } = requireModModule("./lib/clientRegistry");
    const { createAuthCodeStore } = requireModModule("./lib/authCodes");

    // The three durable credentials (D8, D30) Resolved and loaded before the route table,
    // because a surface that cannot sign, compute `owner` or persist a grant must not bind a
    // port. Every failure lands in the catch below, all together rather than one restart at a
    // time (see `loadSsoCredentials`).
    const { signingJwks } = requireModModule("./lib/signingKey");

    const ssoCredentials = loadSsoCredentials(context);

    // Computed once at boot and passed to the route as a closure it calls per request. D8
    // settled that this replica has one signing slot and rotation is a deliberate operator
    // action ending in a restart, so the published set cannot change under a running process.
    // The route asks every time anyway, so a future live rotation changes only this line.
    const publishedJwks = signingJwks(ssoCredentials.signingKey);

    // Built here rather than inline in the route table, because the authorize route and the
    // token endpoint must share them. A code minted against one `authCodes` store and redeemed
    // against another is never found (the bug `getBindParts()` prevents on the other surface),
    // and a token endpoint checking a different registry than the authorize route would accept
    // a redirect the grant was never bound to.
    const clientRegistry = createClientRegistry({ clients: context.config.ssoClients });
    const authCodes = createAuthCodeStore({ now: () => Date.now() });

    // The reader, shared by two surfaces
    //
    // Built here rather than at the verify route, because that route and the ESI listener's
    // credential layer both read it. It takes the public half only, so neither surface can mint
    // through the module that reads.
    const bearer = createBearerVerifier({
      signingKey: ssoCredentials.signingKey,
      issuer,
      now: () => Date.now(),
    });
    publishVerifier(bearer);

    // The minter, and the two claims that come from the game
    //
    // `lib/accessToken.js` needs a character name and the account that owns the character, and
    // neither is in an authorization code or a refresh grant. They are read at mint time,
    // through the one module allowed to touch game state. That also gives `owner` the correct
    // semantics: it claims who owns the character now, so a character that moved accounts
    // between authorising and refreshing produces a new value, and clients correctly read a
    // transfer.
    //
    // Capturing the account at bind time would mean threading a field through
    // `lib/authCodes.js` and `lib/refreshTokens.js` for one consumer, freezing ownership at
    // authorisation, and undoing `lib/bindFlow.js`'s deliberate stripping of the account id
    // from what the poll can see.
    //
    // `peekCharacterRecord` is the non-cloning accessor: `getCharacterRecord` deep-clones,
    // resolves the active ship, re-derives standings and writes the record back, which is
    // disqualifying on a read path inside the game's own event loop (`lib/runtimeAccess.js`'s
    // cost-aware section). The projection keeps two fields out of a record with dozens.
    //
    // Returns `null` rather than throwing when the character cannot be read.
    // `routes/oauthToken.js` turns an unusable answer into a `server_error`: the grant was
    // valid, the character it names is not there, and that is this server's problem rather than
    // the client's.

    const accessTokens = createAccessTokenMinter({
      signingKey: ssoCredentials.signingKey,
      issuer,
      ownerSalt: ssoCredentials.ownerSalt.salt,
      now: () => Date.now(),
    });

    const mintAccessToken = ({ characterId, clientId, scopes }) => {
      const record = context.runtime.peekCharacterRecord(characterId, {
        project: (found) => ({
          characterName: found.characterName,
          accountId: found.accountId,
        }),
      });

      if (
        record === null
        || typeof record.characterName !== "string"
        || record.characterName === ""
        || !Number.isInteger(record.accountId)
      ) {
        // Named, but without the record: a game server log must not carry a character's account id.
        logError(
          `cannot mint an access token for character ${characterId}: the character record is `
            + "missing the name or the owning account. The grant was valid; this is a "
            + "server-side inconsistency, not a client error.",
        );
        return null;
      }

      return accessTokens.mint({
        characterId,
        characterName: record.characterName,
        clientId,
        scopes,
        ownerInputs: { accountId: record.accountId },
      });
    };

    ssoDispatch = createSsoDispatch([
      // The document the EVE client reads `token_endpoint` out of on every launch. Two paths, one
      // handler: CCP publishes the unslashed spelling and the client asks for the slashed one.
      createOauthDiscoveryRoute({ issuer }),

      // `/oauth/jwks`: not under `/v2/`, which is what the discovery document above advertises
      // and what a client that cached it will ask for. `createSsoDispatch` refuses at boot if
      // those two ever disagree about the path, because a typo here is a 404 that surfaces as a
      // signature-verification failure elsewhere.
      createOauthJwksRoute({ getJwks: () => publishedJwks }),

      // `/v2/oauth/authorize` and the browser-facing poll that completes it. Everything it needs
      // is built here and injected, so the route requires no mod module and its suite drives it
      // with three doubles.
      //
      // `createClientRegistry` throws for an allowlist entry it cannot use (a relative redirect
      // URI, one carrying credentials), which lands in the same catch as the credential refusals:
      // an SSO surface that cannot decide where a client may be sent back to must not answer at
      // all.
      createOauthAuthorizeRoute({
        clientRegistry,
        authCodes,
        bindFlow: getBindParts().flow,
        devAutoApprove: {
          enabled: context.config.devAutoApprove,
          characterID: context.config.devAutoApproveCharacterID,
        },
        now: () => Date.now(),
        log,
      }),

      // `/v2/oauth/token`: the only endpoint on this listener that answers in RFC 6749 JSON
      // errors, and the only one that hands out credentials.
      //
      // `authCodes` and `clientRegistry` are the shared instances built above: a code minted
      // against one store and redeemed against another is never found, and a different registry
      // than the authorize route's would accept a redirect the grant was never bound to.
      //
      // `clientAuth` is built here rather than shared, because it holds no state: it reads the
      // registry, which is shared.
      createOauthTokenRoute({
        clientAuth: createClientAuthenticator({ registry: clientRegistry }),
        authCodes,
        refreshTokens: ssoCredentials.refreshTokens,
        mintAccessToken,
        now: () => Date.now(),
        log,
      }),

      // `/v2/oauth/verify` and the still-live legacy `/oauth/verify`: two paths, one handler, as
      // with `/oauth/jwks`, because CCP never moved the unversioned spelling and clients still
      // use it.
      //
      // The verifier reads what `mintAccessToken` above signs, from the same key in the same
      // process. No JWKS fetch: D8 put one signing slot here, and a server fetching its own
      // document over HTTP would reproduce a client's constraints. It takes the key set and uses
      // only the public half, so this surface cannot mint through the module that reads.
      createOauthVerifyRoute({
        bearer,
        now: () => Date.now(),
        log,
      }),

      // `/v2/oauth/revoke`, the endpoint D30 relies on: rotation was declined because what it
      // buys is theft detection rather than containment, since revocation still works and is what
      // an operator uses when a token is known lost. It is also the manual remedy for a replayed
      // authorization code.
      //
      // The shared refresh store, necessarily: revoking against a second instance would answer
      // 200 and change nothing, a failure RFC 7009's always-200 makes invisible.
      createOauthRevokeRoute({
        clientAuth: createClientAuthenticator({ registry: clientRegistry }),
        refreshTokens: ssoCredentials.refreshTokens,
        log,
      }),
    ]);
  } catch (err) {
    // Named surface, named remedy, and no stack in the common case: an operator needs to know
    // that ESI is fine and SSO is not, which a stack trace in a game server's console does not
    // show.
    logError(
      "SSO surface not started: the mod stays loaded and the ESI listener is unaffected. "
        + "No token can be issued, discovered or verified until this is fixed",
      err,
    );
    return null;
  }

  return startListener(
    startServer({ config: context.config, listener: "sso", dispatch: ssoDispatch, log, logError }),
    "SSO listener did not start: ESI is unaffected, but no client can discover or verify a token",
  );
}

/**
 * Record a started listener, or log why it did not start.
 *
 * `startServer` returns a promise and rejects for a config it will not bind, a missing
 * dispatch, or an address it cannot have. The rejection is handled here, with the
 * two-argument `.then`, because eve.js's ProcessLifecycle treats an unhandled rejection as
 * fatal, the one failure mode this mod may never cause. A listener that did not start
 * leaves that surface unreachable, which affects third-party tools and not players.
 *
 * Returns a promise that never rejects, so the caller can wait on all of them with
 * `Promise.all` without that composition becoming an unhandled rejection.
 */
function startListener(pending, failureMessage) {
  return pending.then(
    (handle) => {
      listeners.push(handle);
    },
    (err) => {
      logError(failureMessage, err);
    },
  );
}

// Hook table

/**
 * One entry per game module the mod attaches to:
 *
 *   name    label for logs
 *   match   (request, exports) => boolean; must go through the probes in
 *           lib/exportProbe.js, never direct property access
 *   run     (exports, context) => void; may throw, and the loop catches
 *
 * The loop in `installModuleHook` owns the run-once bookkeeping and the error guard, so an
 * entry is only those three fields.
 *
 * A factory rather than a module-level `const` because it needs `lib/exportProbe.js` and
 * `lib/runtimeAccess.js`, and a dormant mod, with both listeners off, must not require
 * either. Building the table after the configuration says the mod is wanted keeps a dormant
 * deployment's preload cost at one module: `./config`.
 *
 * @param {{exportHas: Function, readinessToken: string}} deps
 */
function buildHooks(deps) {
  const { config, exportHas, prototypeHasMethod, readinessToken, tokens } = deps;

  // The in-game grant is only wired when SSO is armed. A `/esi` command on a replica that
  // issues no tokens has nothing behind it, and patching a game module for it would be a
  // needless modification (D5's "zero vendor-tree modification" is the strict form of this).
  const bindHooks = config.ssoIssuer === null ? [] : [
    {
      // Wraps `Handle_SlashCmd` so `/esi <code>` is answered before the game sees it, which keeps
      // the code out of the log: upstream's handler writes the whole command line to `log.debug`
      // and to `logs/slash-debug.log` before dispatching, then echoes `Unknown command:
      // <command>` into chat. Those are two leaks of a live bind code if this falls through, so
      // `lib/slashCommandPatch.js` never falls through for a command it recognises.
      name: "slashService",
      match(request, exports) {
        return (
          request.includes(tokens.slashService)
          && prototypeHasMethod(exports, "Handle_SlashCmd")
        );
      },
      run(exports) {
        const { patchSlashService } = requireModModule("./lib/slashCommandPatch");
        const runtime = requireModModule("./lib/runtimeAccess");
        const { store } = getBindParts();

        const patched = patchSlashService(exports, {
          // The store's `claim` is the redeemer, unadapted: the request `lib/slashCommandPatch.js`
          // builds (`{code, characterID, accountID, role, isGM}`) is exactly `claim`'s argument, and
          // its identity came from the live session rather than a browser.
          redeemBindCode: (request) => store.claim(request),
          // Lazy, because `chatHub` is game code and this hook runs inside `Module._load`: requiring
          // it at patch time would pull a game module in ahead of the server's own load order.
          sendSystemMessage: (session, message) =>
            runtime.sendChatSystemMessage(session, message),
          log,
          logError,
        });

        if (patched) log("in-game bind command armed: players complete a sign-in with /esi <code>");
      },
    },
    {
      // The client will not send a command it has not been told about, so the patch above is
      // unreachable without this. Appending to the game's own array is the one thing this mod
      // does that touches vendor state, which is why `registerBindCommands` is idempotent and
      // additive.
      name: "chatCommands",
      match(request, exports) {
        return (
          request.includes(tokens.chatCommands)
          && exportHas(exports, "AVAILABLE_SLASH_COMMANDS", "array")
        );
      },
      run(exports) {
        const { registerBindCommands } = requireModModule("./lib/slashCommandPatch");
        const added = registerBindCommands(exports);
        if (added.length > 0) log(`registered slash command(s): ${added.join(", ")}`);
      },
    },
  ];

  return [
    ...bindHooks,
    {
      // A readiness signal, not a patch: nothing in the game is modified, and this mod never
      // reads wormhole state. `wormholeRuntimeState` is used because it is loaded early by the
      // process that owns game state and is not loaded by the edge processes or the healthcheck,
      // so "this hook fired" means "this process has the game in it" (guard 2 in the file
      // header).
      //
      // The module is named once, in `lib/runtimeAccess.js`'s `GAME_MODULES` table, and
      // `isRuntimeReachable()` probes the same export the same way. Two string literals could
      // drift on a vendor drop, and the mod would silently never start its listener.
      name: "gameRuntimeReady",
      match(request, exports) {
        return (
          request.includes(readinessToken) && exportHas(exports, "mutateState", "function")
        );
      },
      run(_exports, context) {
        log("game runtime reachable, starting mod services");
        startHttpListener(context);
      },
    },
  ];
}

// The Module._load hook

/**
 * Wrap `Module._load` and drive the hook table from it.
 *
 * Every require in the process passes through here, including ones Node satisfies from a
 * circular dependency with a half-built exports object, so this must be cheap and silent.
 * Cheap: a string test and an own-property probe per unfired hook, and the list only
 * shrinks. Silent: `lib/exportProbe.js` explains why a plain property miss here costs a
 * stack trace and a heap snapshot in the game's log.
 *
 * @returns {number} how many hooks are armed
 */
function installModuleHook(context, hooks) {
  const originalLoad = Module._load;
  const pending = hooks.map((hook) => ({ hook, done: false }));

  Module._load = function esiApiHookedLoad(request, parent, isMain) {
    // The real load first, unconditionally: whatever happens below, the caller must get what it
    // would have got without this mod. An exception from the real load is the caller's own
    // failure and propagates untouched; swallowing it would turn a missing game module into a
    // silently undefined one.
    const result = originalLoad.apply(this, arguments);

    // Modules Node requires on its own behalf have no parent and are never ours. A non-string
    // request cannot be ours either. Checking here rather than inside `match` matters: a throw
    // from `match` would permanently disable that hook (see the catch below) over an unrelated
    // require.
    if (!parent || !parent.filename || typeof request !== "string") return result;

    for (const entry of pending) {
      if (entry.done) continue;

      // Each hook is guarded on its own, so one broken handler cannot stop the others from firing
      // or make an unrelated require() throw in game code.
      try {
        if (!entry.hook.match(request, result)) continue;

        // Marked done before run, for two reasons. A handler that requires something re-enters this
        // function and must not re-enter its own hook; and a handler that threw once will throw
        // every time, so retrying would turn one failure into one log line per require for the life
        // of the process.
        entry.done = true;
        entry.hook.run(result, context);
        log(`hook "${entry.hook.name}" applied`);
      } catch (err) {
        logError(`hook "${entry.hook.name}" failed, continuing without it`, err);
      }
    }

    return result;
  };

  return pending.length;
}

// Install
function install() {
  if (globalThis[INSTALL_FLAG]) {
    log("already installed in this process, ignoring the second preload");
    return;
  }

  // Guard 1. Silently and before anything is logged: worker threads are spawned in numbers,
  // never own game state, and a banner per worker would flood the console.
  if (!isMainThread) return;

  const {
    DEFAULTS,
    MOD_VERSION,
    describeConfig,
    loadConfig,
    loopbackListenersInContainer,
  } = requireModModule("./config");
  const result = loadConfig();

  // Warnings first, regardless of `ok`: they explain a mod that is running but not doing what
  // was expected (a non-loopback bind host, dev auto-approve left on, an unreadable `.env`).
  for (const warning of result.warnings) log(`config warning: ${warning}`);
  for (const notice of result.notices) log(`config note: ${notice}`);

  if (!result.ok) {
    // config.js splits these two states on purpose, and so does this branch, because they read
    // differently to someone watching a server start.
    if (result.errors.length === 0) {
      // Both listeners were turned off, so this must not look like a fault: no hook, no port, no
      // stack, no "error".
      log(
        "dormant: ESI_MOD_ESI_PORT and ESI_MOD_SSO_ISSUER are both blank, so no hook was " +
          "installed and no port was bound",
      );
    } else {
      // A supplied value is unusable. Every problem, not the first: an operator should not have
      // to restart a game server once per typo.
      log(`not starting: ${result.errors.length} configuration problem(s):`);
      for (const error of result.errors) log(`  - ${error}`);
    }
    return;
  }

  globalThis[INSTALL_FLAG] = true;

  // These three are pure, require no game code, and are reached only once the mod is known to
  // be wanted. `lib/runtimeAccess.js` is required here rather than inside `match()` because
  // `match` runs inside `Module._load`: a require from there would re-enter this hook on
  // every probe, on every require in the process.
  const { exportHas, prototypeHasMethod } = requireModModule("./lib/exportProbe");
  const runtime = requireModModule("./lib/runtimeAccess");
  const { shortSourceHash } = requireModModule("./lib/sourceHash");

  // The game requires its own modules by relative path (`./wormholeRuntimeState` from a
  // sibling), so the request string never carries the path recorded in `GAME_MODULES`. The
  // basename survives, and taking it from the table keeps this hook and
  // `isRuntimeReachable()` keyed on one name. `path.posix`, because the table uses forward
  // slashes and this must produce the same token on Windows.
  const readinessToken = path.posix.basename(runtime.GAME_MODULES.wormholeRuntimeState);

  // Computed once, here, and passed to the health route: it answers which build this process
  // is running, and the process loaded its code once, at preload. See routes/health.js on why
  // re-reading the tree later would report code that is on disk and not running.
  const sourceHash = shortSourceHash(MOD_DIR);

  const context = Object.freeze({
    config: result.config,
    modDir: MOD_DIR,
    runtime,
    sourceHash,
  });

  // As with `readinessToken`: the game requires its own modules by relative path, so the
  // basename survives, and taking it from `GAME_MODULES` keeps the hook and the vendor-drift
  // check keyed on one spelling.
  const tokens = Object.freeze({
    slashService: path.posix.basename(runtime.GAME_MODULES.slashService),
    chatCommands: path.posix.basename(runtime.GAME_MODULES.chatCommands),
  });

  const hookCount = installModuleHook(
    context,
    buildHooks({
      config: result.config,
      exportHas,
      prototypeHasMethod,
      readinessToken,
      tokens,
    }),
  );

  // The build, not just the version. `<eve.js tree>/mods/esiApi/` is a plain directory copy that can
  // be older than its source, and the running process older than both, and this line is the
  // only trace of the mod in the game console. A hand-maintained version string cannot say
  // whether this is the code just written; twelve hex characters can.
  //
  // `describeConfig` is the only thing allowed to render a config object: a startup banner
  // ends up in screenshots of a server console and in pasted bug reports.
  const described = describeConfig(result.config);

  // Each half names its switch when it is off, so "off" tells the reader what to set.
  // `config.js` emits no warning for either: one listener alone is a complete configuration.
  const esi =
    described.esiListener === "disabled"
      ? "ESI off (ESI_MOD_ESI_PORT is blank)"
      : `ESI ${described.esiListener} starts when the game runtime is reachable`;
  const sso =
    described.ssoListener === "disabled"
      ? "SSO off (ESI_MOD_SSO_ISSUER is blank)"
      : `SSO ${described.ssoListener} issuing ${described.ssoIssuer}`;

  log(
    `v${MOD_VERSION} (build ${sourceHash}) active: ${hookCount} hook(s) armed; ` +
      `${esi}; ${sso}`,
  );

  // A loopback bind in a container starts cleanly and then refuses every
  // connection through a published port, with nothing else to say why.
  if (fs.existsSync("/.dockerenv")) {
    for (const key of loopbackListenersInContainer(result.config)) {
      log(`${key} is loopback inside a container: a published port will refuse connections. Use 0.0.0.0.`);
    }
  }

  // On its own line, after the banner, and only when on: an enabled auto-approve must be
  // unmistakable at startup as well as on every use, and a clause on a line already carrying
  // five facts is easy to miss. `describeConfig` writes the sentence; this decides where it
  // goes.
  //
  // Guarded on the boolean, not the sentence: `devAutoApproveEffect` is the string `"off"`
  // when the flag is off, which is truthy, and announcing "off" on every boot would make the
  // line easy to ignore.
  if (described.devAutoApprove === true) log(described.devAutoApproveEffect);

  // Silent at the default, because the default is CCP's observed budget and announcing "100"
  // on every boot is noise, as above. Named otherwise, because a raised budget is a
  // deliberate divergence from CCP (D44) and an operator reading the console should see it.
  if (described.errorLimitMaxErrors !== DEFAULTS.errorLimitMaxErrors) {
    log(
      `error-limit budget raised to ${described.errorLimitMaxErrors} (CCP's observed default is ` +
        `${DEFAULTS.errorLimitMaxErrors}, decision D44)`,
    );
  }
}

// The outermost guard, which every function above relies on. Nothing this mod does may
// prevent the game server from starting.
try {
  install();
} catch (err) {
  logError("loader failed to install: the mod is not running", err);
}
