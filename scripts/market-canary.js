/**
 * eve.js-mod-esi: market-hub-seed as a conformance canary
 *
 * Run with:  node scripts/market-canary.js
 *            node scripts/market-canary.js --esi-base-url http://127.0.0.1:26005
 *            node scripts/market-canary.js --seed   (the full end-to-end run)
 *
 * The criterion is that a full seed run completes against the
 * replica, and that a second consecutive run hits its cache rather than
 * re-downloading. This script makes that run repeatable and gives it an exit
 * code. It is end-to-end acceptance tooling, run by hand on a machine that has
 * the tool and a market. It is not a CI check and must not become one: it needs
 * `market-hub-seed`, a third-party tool this repository does not control, and
 * its result depends on that tool's release schedule.
 *
 * The contract question belongs to the suite: `test/marketSweepContract.test.js`
 * asserts the sweep-level properties against `contract/openapi.json` and
 * `contract/wire.js` with fixtures built here (one `X-Pages` across every page,
 * one `Last-Modified` per resource, an `Etag` per page, `Expires` measured from
 * `Last-Modified`, and a second sweep that is all `304`s). What running the real
 * tool adds is an outside program, written against Tranquility, completing a
 * real job against the replica. That is worth doing before a release.
 *
 * `market-hub-seed` calls two endpoints, and every rule its cache client
 * enforces is a rule about this replica's caching and pagination:
 *
 *   - it keys its on-disk cache on `SHA-256(compatibilityDate + "\n" + url)`;
 *   - it stores `Cache-Control`, `Expires`, `Etag`, `Last-Modified`, `X-Pages`
 *     and reads `max-age` back out with its own regex;
 *   - it sends `If-None-Match` and counts a `304` as a hit, body unread;
 *   - it aborts the whole run when `X-Pages` changes mid-sweep;
 *   - it aborts the whole run when two order pages disagree about
 *     `Last-Modified`.
 *
 * Two modes:
 *
 *   sweep (default)  The tool's real `esi-cache-client.js`, required from its
 *                    checkout (not copied), driven over `/markets/prices/` and
 *                    every page of the region's order book, three times. Needs
 *                    a replica and the tool's directory.
 *
 *   seed (`--seed`)  The whole tool, three times, as a subprocess. Needs what
 *                    the tool needs: the market daemon's SQLite, the game
 *                    store's `stations` and `solarSystems` data, and a
 *                    `better-sqlite3` that its own `../../server/node_modules`
 *                    require can resolve, which is true of a copy installed
 *                    into a game tree and false of a bare source checkout. On
 *                    a Docker install those inputs live in the `evejs-data`
 *                    volume; use the tool's own
 *                    `docker compose run --rm --no-deps market-tools` wrapper
 *                    and point `--esi-base-url` at the replica from there.
 *
 * Both modes judge the same three passes by the same rule:
 *
 *   1  cold          every request goes to the wire
 *   2  cached        every request is served from the tool's disk cache
 *   3  revalidated   every request is a conditional that came back `304`
 *
 * Pass 3 runs with `--fresh`: the client ignores its own expiry, so every
 * request carries `If-None-Match` and the replica must answer `304` with no
 * body. A replica that answered `200` would still work, but would re-send
 * 20 MB per sweep to every client.
 *
 * The tool's client is used as-is; the loop around it is reproduced, because
 * the tool's own lives inside `fetchSources()` and cannot be called without
 * better-sqlite3 and a game store. `verifyToolRules` runs first and fails the
 * run when the tool no longer contains the rules this file reproduces. Its
 * judgement is tested in `test/marketCanary.test.js` against strings rather
 * than a checkout.
 *
 * Exit codes:
 *
 *   0  the run passed
 *   1  the run failed: the replica broke a rule the tool enforces
 *   2  it could not run, and says what is missing
 *
 * 2 is deliberately not 0: a run that cannot find its tool has checked nothing,
 * which is what `test/vendorPresence.js` exists to prevent.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MOD_DIR = path.resolve(__dirname, "..");

const { loadConfig } = require(path.join(MOD_DIR, "config"));
const { findServerSrc, getMarketDbPath, getStorePaths } = require(
  path.join(MOD_DIR, "lib", "runtimeAccess"),
);


const SEED_TOOL_ENV = "MARKET_HUB_SEED_DIR";
const SEED_TOOL_ENTRY = "market-hub-seed.js";
const SEED_TOOL_CLIENT = "esi-cache-client.js";
const SEED_TOOL_CONFIG = "major-trade-hubs.json";

/** Both files, so a half-copied directory is not "found". */
function isSeedTool(dir) {
  if (typeof dir !== "string" || dir.trim() === "") return false;
  return fs.existsSync(path.join(dir, SEED_TOOL_ENTRY))
    && fs.existsSync(path.join(dir, SEED_TOOL_CLIENT));
}

/**
 * Where to look, in order.
 *
 * The game tree comes before a source checkout beside this repository because
 * of `--seed`: the tool requires `better-sqlite3` as
 * `../../server/node_modules/better-sqlite3`, which resolves for a copy
 * installed at `<eve.js tree>/tools/market-hub-seed` and nowhere else. A sweep works
 * with either, so the order only affects the slower mode.
 */
function seedToolCandidates(explicit, env = process.env) {
  const candidates = [];

  if (explicit) candidates.push(path.resolve(explicit));

  const fromEnv = String(env[SEED_TOOL_ENV] ?? "").trim();
  if (fromEnv) candidates.push(path.resolve(fromEnv));

  const serverSrc = findServerSrc(MOD_DIR, env.EVEJS_REPO_ROOT);
  if (serverSrc) {
    candidates.push(
      path.join(path.resolve(serverSrc, "..", ".."), "tools", "market-hub-seed"),
    );
  }

  candidates.push(
    path.resolve(MOD_DIR, "..", "EveJS-Relaunch-Market-Tool", "tools", "market-hub-seed"),
  );

  return candidates;
}

/** The tool's directory, or `null`. */
function findSeedTool(explicit, env = process.env) {
  for (const dir of seedToolCandidates(explicit, env)) {
    if (isSeedTool(dir)) return dir;
  }
  return null;
}

/** Said the same way everywhere, so a skip and a refusal read alike. */
function seedToolMissingReason(explicit, env = process.env) {
  const looked = seedToolCandidates(explicit, env).map((dir) => `  - ${dir}`).join("\n");

  return "market-hub-seed was not found, so the conformance canary has nothing "
    + `to run.\n\nLooked in:\n${looked}\n\n`
    + `Set ${SEED_TOOL_ENV} to the tool's directory (the one holding `
    + `${SEED_TOOL_ENTRY} and ${SEED_TOOL_CLIENT}) or pass --tool.`;
}


/**
 * `expect` names the counter that must equal the request count; the other two
 * must be zero. That is the criterion (a second consecutive run hits
 * its cache rather than re-downloading), with a third pass added because
 * `--fresh` asks the stricter question and costs one more run.
 */
const RUNS = Object.freeze([
  Object.freeze({
    id: "cold",
    fresh: false,
    expect: "network",
    why: "an empty cache: every request has to reach the replica",
  }),
  Object.freeze({
    id: "cached",
    fresh: false,
    expect: "fresh",
    why: "the same cache, unexpired: the criterion, and it rests on "
      + "Cache-Control and Expires being readable by the tool's own regex",
  }),
  Object.freeze({
    id: "revalidated",
    fresh: true,
    expect: "conditional",
    why: "--fresh: every request carries If-None-Match and has to come back 304 "
      + "with no body",
  }),
]);

/** The client's three counters, by the name this file gives each outcome. */
const COUNTERS = Object.freeze({
  network: "networkResponses",
  fresh: "freshCacheHits",
  conditional: "conditionalCacheHits",
});

/**
 * What went wrong in one pass, as a list of sentences. Empty is a pass.
 *
 * Every counter is checked, not only the expected one: "81 fresh hits" and "81
 * fresh hits and 3 network responses" are different results.
 */
function judgeRun(run, stats, expectedRequests) {
  const failures = [];

  for (const [kind, counter] of Object.entries(COUNTERS)) {
    const expected = kind === run.expect ? expectedRequests : 0;
    const actual = Number((stats && stats[counter]) || 0);
    if (actual !== expected) {
      failures.push(`${counter}: expected ${expected}, got ${actual}`);
    }
  }

  return failures;
}

/**
 * What the three passes have to agree about.
 *
 * A cached pass and a fetched pass can still disagree, and when they do the
 * cache is holding something the replica no longer says. `sha256` is taken over
 * the bodies in sweep order, so this compares the bytes a client would have
 * acted on rather than a count of them.
 */
function crossRunFailures(results) {
  const failures = [];
  const [first, ...rest] = results;
  if (!first) return failures;

  for (const later of rest) {
    if (later.pages !== first.pages) {
      failures.push(
        `X-Pages moved between passes: ${first.id} saw ${first.pages}, `
        + `${later.id} saw ${later.pages}`,
      );
    }
    if (later.sha256 !== first.sha256) {
      failures.push(
        `the bodies differ between passes: ${first.id} hashed `
        + `${String(first.sha256).slice(0, 12)}…, ${later.id} hashed `
        + `${String(later.sha256).slice(0, 12)}…`,
      );
    }
  }

  return failures;
}


/** A rule the tool would have aborted its whole run on. */
class SweepAbort extends Error {
  constructor(message) {
    super(message);
    this.name = "SweepAbort";
  }
}

/**
 * The strings in the tool's own source that this file's sweep reproduces.
 *
 * `sweepOnce` uses the tool's client as-is but rebuilds the loop around it, so
 * it holds a copy of the tool's rules: the two URL shapes, the two aborts, and
 * the three counter names. This check looks for evidence that each rule still
 * exists in the tool. It does not parse the tool, and only has to fail when the
 * tool stops enforcing something this file claims to gate.
 */
const TOOL_RULES = Object.freeze([
  Object.freeze({
    file: SEED_TOOL_ENTRY,
    needle: "/markets/prices/?datasource=tranquility",
    rule: "the prices URL this sweep builds",
  }),
  Object.freeze({
    file: SEED_TOOL_ENTRY,
    needle: "/orders/?datasource=tranquility&order_type=all",
    rule: "the orders URL this sweep builds",
  }),
  Object.freeze({
    file: SEED_TOOL_ENTRY,
    needle: "ESI pagination changed during download",
    rule: "the X-Pages abort this sweep reproduces",
  }),
  Object.freeze({
    file: SEED_TOOL_ENTRY,
    needle: "ESI order pages have different Last-Modified values",
    rule: "the Last-Modified abort this sweep reproduces",
  }),
  Object.freeze({
    file: SEED_TOOL_CLIENT,
    needle: "networkResponses += 1",
    rule: "the counter this canary judges a cold pass on",
  }),
  Object.freeze({
    file: SEED_TOOL_CLIENT,
    needle: "freshCacheHits += 1",
    rule: "the counter this canary judges a cached pass on",
  }),
  Object.freeze({
    file: SEED_TOOL_CLIENT,
    needle: "conditionalCacheHits += 1",
    rule: "the counter this canary judges a revalidated pass on",
  }),
]);

/** What the tool no longer does that this file assumes it does. Empty is fine. */
function verifyToolRules(toolDir, read = (file) => fs.readFileSync(path.join(toolDir, file), "utf8")) {
  const sources = new Map();
  const problems = [];

  for (const { file, needle, rule } of TOOL_RULES) {
    if (!sources.has(file)) {
      try {
        sources.set(file, read(file));
      } catch (err) {
        sources.set(file, null);
        problems.push(`${file} could not be read: ${err.message}`);
      }
    }

    const source = sources.get(file);
    if (source !== null && !source.includes(needle)) {
      problems.push(`${file} no longer contains ${JSON.stringify(needle)}: ${rule}`);
    }
  }

  return problems;
}

const asArray = (body) => (Array.isArray(body) ? body : []);

/**
 * One pass over the two endpoints, through the tool's own cache client.
 *
 * The client is `require`d from the tool's checkout rather than reproduced, so
 * a copy cannot miss the tool tightening a rule. The loop around it is
 * reproduced, because the tool's own lives inside `fetchSources()`, which
 * cannot be called without `better-sqlite3` and a game store. What is copied is
 * the two aborts and the two URL shapes, and both are asserted against the
 * tool's source in `test/marketHubSeedCanary.test.js`.
 */
async function sweepOnce(options) {
  const { fetchEsiJson } = require(path.join(options.toolDir, SEED_TOOL_CLIENT));

  const stats = { conditionalCacheHits: 0, freshCacheHits: 0, networkResponses: 0 };
  const fetchOptions = {
    cacheDir: options.cacheDir,
    compatibilityDate: options.compatibilityDate,
    fresh: Boolean(options.fresh),
    userAgent: options.userAgent,
  };
  const digest = crypto.createHash("sha256");

  const pricesUrl = `${options.baseUrl}/markets/prices/?datasource=tranquility`;
  const prices = await fetchEsiJson(pricesUrl, fetchOptions, stats);
  digest.update("prices\n");
  digest.update(JSON.stringify(prices.body));

  const orderBaseUrl = `${options.baseUrl}/markets/${options.regionId}`
    + "/orders/?datasource=tranquility&order_type=all";
  const firstPage = await fetchEsiJson(`${orderBaseUrl}&page=1`, fetchOptions, stats);
  const pages = Math.max(1, Number(firstPage.metadata.xPages) || 1);
  const lastModified = firstPage.metadata.lastModified || null;
  digest.update("orders-page-1\n");
  digest.update(JSON.stringify(firstPage.body));

  let orders = asArray(firstPage.body).length;

  for (let page = 2; page <= pages; page += 1) {
    const response = await fetchEsiJson(`${orderBaseUrl}&page=${page}`, fetchOptions, stats);

    const pageCount = Math.max(1, Number(response.metadata.xPages) || pages);
    if (pageCount !== pages) {
      throw new SweepAbort(
        `X-Pages changed during the sweep: ${pages} at page 1, ${pageCount} at `
        + `page ${page}. market-hub-seed aborts its entire run here.`,
      );
    }

    if (lastModified && response.metadata.lastModified
      && response.metadata.lastModified !== lastModified) {
      throw new SweepAbort(
        `order pages disagree about Last-Modified: page 1 says ${lastModified}, `
        + `page ${page} says ${response.metadata.lastModified}. `
        + "market-hub-seed aborts its entire run here.",
      );
    }

    digest.update(`orders-page-${page}\n`);
    digest.update(JSON.stringify(response.body));
    orders += asArray(response.body).length;
  }

  return {
    lastModified,
    orders,
    pages,
    priceRows: asArray(prices.body).length,
    requests: pages + 1,
    sha256: digest.digest("hex"),
    stats,
  };
}


/**
 * The tool's argv for one pass.
 *
 * `--dry-run` is the tool's default and is passed anyway: this must never be
 * one flag away from writing to a live market, and the flag shows in a process
 * list.
 */
function seederArgv(options, { fresh } = {}) {
  const argv = [
    path.join(options.toolDir, SEED_TOOL_ENTRY),
    "--dry-run",
    "--database", options.databasePath,
    "--stations-data", options.stationsData,
    "--solar-systems-data", options.solarSystemsData,
    "--config", options.configPath,
    "--cache-dir", options.cacheDir,
    "--compatibility-date", options.compatibilityDate,
    "--user-agent", options.userAgent,
    "--esi-base-url", options.baseUrl,
  ];

  if (options.requestDelayMs !== null && options.requestDelayMs !== undefined) {
    argv.push("--request-delay-ms", String(options.requestDelayMs));
  }
  if (fresh) argv.push("--fresh");

  return argv;
}

/** stdout is the report and nothing else; the tool's progress goes to stderr. */
function parseReport(stdout) {
  const text = String(stdout).trim();
  if (text === "") throw new Error("market-hub-seed printed no report");

  try {
    return JSON.parse(text);
  } catch (err) {
    // A future version that prefixes a line to stdout should not read as a crash,
    // but anything before the first `{` is still worth not discarding, so this is
    // the one fallback and not a general scrape.
    const start = text.indexOf("{");
    if (start === -1) throw new Error(`market-hub-seed printed no JSON report: ${text.slice(0, 200)}`);
    return JSON.parse(text.slice(start));
  }
}

/** One pass, as a subprocess, shaped like `sweepOnce`'s result. */
function runSeederOnce(options, { fresh } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, seederArgv(options, { fresh }), {
      cwd: options.toolDir,
      stdio: ["ignore", "pipe", "inherit"],
    });

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`market-hub-seed exited ${code}: its output is above`));
        return;
      }

      try {
        const report = parseReport(stdout);
        const pages = Number(report.source.orderPages);
        resolve({
          // The tool reports what it kept, not what it was sent, so the two body counts a
          // sweep fills in stay null here rather than being guessed from its plan.
          lastModified: report.source.orderLastModified,
          orders: null,
          pages,
          priceRows: null,
          requests: pages + 1,
          sha256: String(report.source.sha256),
          stats: report.cache,
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}


/**
 * Run all three passes over one cache directory and judge them.
 *
 * The passes share a cache directory because pass 2 has nothing to hit if pass
 * 1 wrote elsewhere. The directory is fresh per canary run, because a cache
 * left over from an earlier run makes pass 1 a cache hit.
 */
async function runCanary(options, runOnce) {
  const results = [];
  const failures = [];

  for (const [index, run] of RUNS.entries()) {
    const started = Date.now();
    let result;

    try {
      result = await runOnce({ ...options, fresh: run.fresh }, { fresh: run.fresh });
    } catch (err) {
      // A pass that died takes the rest with it: pass 3 judges what pass 2 left in
      // the cache, so continuing would report failures about a state no healthy run
      // produces.
      failures.push(`pass ${index + 1} (${run.id}) did not finish: ${err.message}`);
      break;
    }

    const runFailures = judgeRun(run, result.stats, result.requests);
    results.push({
      ...result,
      elapsedMs: Date.now() - started,
      id: run.id,
      ok: runFailures.length === 0,
    });
    failures.push(...runFailures.map((failure) => `pass ${index + 1} (${run.id}) ${failure}`));
  }

  failures.push(...crossRunFailures(results));

  return { failures, ok: failures.length === 0, results };
}


function formatTable(results) {
  return results.map((result, index) => {
    const stats = result.stats || {};
    const counts = [
      `${String(stats.networkResponses ?? 0).padStart(4)} network`,
      `${String(stats.freshCacheHits ?? 0).padStart(4)} fresh`,
      `${String(stats.conditionalCacheHits ?? 0).padStart(4)} conditional`,
    ].join("   ");

    return `  run ${index + 1}  ${result.id.padEnd(13)}${counts}   `
      + `${result.ok ? "ok" : "FAILED"}  (${(result.elapsedMs / 1000).toFixed(1)}s)`;
  }).join("\n");
}


/**
 * A replica in this process, serving the two market routes from the market
 * daemon's real database.
 *
 * It is this source, which is the thing being gated, not a stand-in for the
 * deployed mod. `--esi-base-url` points at a running one instead, which is the
 * stricter form: it also proves the deployed copy is current, as
 * `scripts/deploy-mod.js --check` does.
 */
async function startReplica() {
  const { startServer, closeServer } = require(path.join(MOD_DIR, "server"));
  const { createEsiDispatch } = require(path.join(MOD_DIR, "lib", "pipeline"));
  const { createRouter } = require(path.join(MOD_DIR, "lib", "router"));
  const {
    createMarketPricesRoute,
    createMarketRegionOrdersRoute,
  } = require(path.join(MOD_DIR, "routes", "markets"));

  const handle = await startServer({
    config: { esiBindHost: "127.0.0.1", esiPort: 0 },
    dispatch: createEsiDispatch(
      createRouter([createMarketPricesRoute(), createMarketRegionOrdersRoute()]),
    ),
    log: () => {},
    logError: () => {},
  });

  return {
    baseUrl: `http://127.0.0.1:${handle.port}`,
    close: () => closeServer(handle),
  };
}


function usage() {
  return [
    "eve.js-mod-esi market conformance canary",
    "",
    "Runs market-hub-seed's cache client (or the whole tool) three times",
    "against the replica, and checks that the second run hits its cache and the",
    "third revalidates to 304.",
    "",
    "Usage:",
    "  node scripts/market-canary.js [options]",
    "",
    "Options:",
    "  --esi-base-url <url>   A replica that is already listening. Default: start",
    "                         one in this process, from this source.",
    "  --seed                 Run the whole tool instead of its cache client.",
    "  --tool <dir>           market-hub-seed's directory.",
    `                         Also read from ${SEED_TOOL_ENV}.`,
    "  --config <path>        Hub profile JSON. Default: the tool's",
    `                         ${SEED_TOOL_CONFIG}, which names the source region.`,
    "  --region <id>          Override the region the sweep pages through.",
    "  --database <path>             --seed: the market daemon's SQLite.",
    "  --stations-data <path>        --seed: the game store's stations data.json.",
    "  --solar-systems-data <path>   --seed: the game store's solarSystems data.json.",
    "  --cache-dir <path>     Where the tool's cache goes. Default: a temporary",
    "                         directory, removed afterwards.",
    "  --keep-cache           Keep it, to look at what was stored.",
    "  --request-delay-ms <n> Passed to the tool in --seed mode.",
    "  --help",
    "",
    "Exit: 0 passed, 1 failed, 2 could not run.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = {
    baseUrl: null,
    cacheDir: null,
    configPath: null,
    databasePath: null,
    help: false,
    keepCache: false,
    mode: "sweep",
    regionId: null,
    requestDelayMs: null,
    solarSystemsData: null,
    stationsData: null,
    toolDir: null,
  };

  const value = (index, flag) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value.`);
    return next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--esi-base-url":
        options.baseUrl = value(i, flag).replace(/\/+$/, "");
        i += 1;
        break;
      case "--seed": options.mode = "seed"; break;
      case "--sweep": options.mode = "sweep"; break;
      case "--tool": options.toolDir = value(i, flag); i += 1; break;
      case "--config": options.configPath = value(i, flag); i += 1; break;
      case "--region": options.regionId = Number(value(i, flag)); i += 1; break;
      case "--database": options.databasePath = value(i, flag); i += 1; break;
      case "--stations-data": options.stationsData = value(i, flag); i += 1; break;
      case "--solar-systems-data": options.solarSystemsData = value(i, flag); i += 1; break;
      case "--cache-dir": options.cacheDir = value(i, flag); i += 1; break;
      case "--keep-cache": options.keepCache = true; break;
      case "--request-delay-ms": options.requestDelayMs = Number(value(i, flag)); i += 1; break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default: throw new Error(`Unknown option: ${flag}`);
    }
  }

  return options;
}

/**
 * What `--seed` needs beyond a replica, resolved the way the mod resolves it.
 *
 * `lib/runtimeAccess.js` answers where an install keeps its data. Asking it
 * here rather than reimplementing the layout follows `test/vendorTree.js`: a
 * canary that looked somewhere the mod would not look tests a different
 * install.
 */
function resolveSeedInputs(options) {
  const store = getStorePaths();
  const dataFile = (name) => (store.gameStoreRoot
    ? path.join(store.gameStoreRoot, "data", name, "data.json")
    : null);

  const resolved = {
    databasePath: options.databasePath || getMarketDbPath(),
    solarSystemsData: options.solarSystemsData || dataFile("solarSystems"),
    stationsData: options.stationsData || dataFile("stations"),
  };

  const missing = Object.entries(resolved)
    .filter(([, value]) => !value || !fs.existsSync(value))
    .map(([key, value]) => (value
      ? `  - ${key}: ${value} does not exist`
      : `  - ${key}: unresolved (${store.reason || "no game store"})`));

  return { ...resolved, missing };
}

/** `http://127.0.0.1:<the port this mod's own .env names>`, or null. */
function configuredBaseUrl() {
  const { config } = loadConfig({ dir: MOD_DIR });
  return config && config.esiPort ? `http://127.0.0.1:${config.esiPort}` : null;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (err) {
    console.error(`${err.message}\n\n${usage()}`);
    return 2;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  const toolDir = findSeedTool(options.toolDir);
  if (!toolDir) {
    console.error(seedToolMissingReason(options.toolDir));
    return 2;
  }

  // Before anything is run: is this still gating what it says it gates? A tool
  // that dropped a rule would pass three passes here and prove less than the
  // report implies.
  const drifted = verifyToolRules(toolDir);
  if (drifted.length > 0) {
    console.error(
      "market-hub-seed has changed underneath this canary, so what it would "
      + `check no longer matches what it claims to check:\n${drifted.map((p) => `  - ${p}`).join("\n")}\n\n`
      + "Re-read the tool's fetchSources() and update scripts/market-canary.js "
      + "to match before trusting a green run.",
    );
    return 2;
  }

  const configPath = options.configPath || path.join(toolDir, SEED_TOOL_CONFIG);
  let regionId = options.regionId;
  if (!regionId) {
    // The region is the tool's own configuration: sweeping a region the tool never
    // asks for would pass while the one that matters was broken.
    try {
      regionId = Number(JSON.parse(fs.readFileSync(configPath, "utf8")).sourceRegionId);
    } catch (err) {
      console.error(`could not read sourceRegionId from ${configPath}: ${err.message}`);
      return 2;
    }
  }

  const seedInputs = options.mode === "seed" ? resolveSeedInputs(options) : { missing: [] };
  if (seedInputs.missing.length > 0) {
    console.error(
      "--seed runs the whole tool, and these inputs are not where this mod "
      + `resolves them:\n${seedInputs.missing.join("\n")}\n\n`
      + "Pass --database, --stations-data and --solar-systems-data, or drop "
      + "--seed and run the sweep, which needs none of them.",
    );
    return 2;
  }

  const { currentCompatibilityDate } = require(path.join(toolDir, SEED_TOOL_CLIENT));

  const cacheDir = options.cacheDir
    ? path.resolve(options.cacheDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), "esi-market-canary-"));
  fs.mkdirSync(cacheDir, { recursive: true });

  let replica = null;
  let baseUrl = options.baseUrl;
  if (!baseUrl) {
    replica = await startReplica();
    baseUrl = replica.baseUrl;
  }

  const context = {
    ...seedInputs,
    baseUrl,
    cacheDir,
    // The tool's own clock, through the tool's own function: this is the string it
    // would send, and `lib/compatibility.js` validates it against ours.
    compatibilityDate: currentCompatibilityDate(),
    configPath,
    regionId,
    requestDelayMs: options.requestDelayMs,
    toolDir,
    userAgent: "eve.js-mod-esi market canary",
  };

  console.error(`[canary] ${options.mode} against ${baseUrl}, region ${regionId}`);
  console.error(`[canary] tool: ${toolDir}`);
  if (!options.baseUrl) {
    console.error(
      `[canary] replica: this source, in this process (the deployed copy at `
      + `${configuredBaseUrl() || "the configured port"} is what --esi-base-url gates)`,
    );
  }

  try {
    const outcome = await runCanary(
      context,
      options.mode === "seed" ? runSeederOnce : sweepOnce,
    );

    console.log("");
    console.log(formatTable(outcome.results));
    console.log("");

    const [first] = outcome.results;
    if (first) {
      console.log(
        `  ${first.pages} order page(s) plus prices, `
        + `Last-Modified ${first.lastModified || "(none)"}`
        + (first.orders === null ? "" : `, ${first.orders} orders, ${first.priceRows} price rows`),
      );
      console.log("");
    }

    // An empty book satisfies every counter and proves nothing: three passes over
    // one page of nothing is not a sweep. Only the sweep can notice, because the
    // tool's own report counts what it kept, not what it was sent.
    if (outcome.ok && first && first.orders === 0) {
      console.error(
        "the replica served an empty order book, so this run checked nothing. "
        + "The market daemon's database is not where lib/marketStore.js looks "
        + `for it (${getMarketDbPath() || "unresolved"}), or the region is empty.`,
      );
      return 2;
    }

    if (!outcome.ok) {
      console.error(`the canary failed:\n${outcome.failures.map((f) => `  - ${f}`).join("\n")}`);
      console.error(
        "\nIf pass 3 reports network responses instead of conditionals, the "
        + "cache window rolled over mid-canary and the entries expired: rerun. "
        + "Anything else is this replica breaking a rule the tool enforces.",
      );
      return 1;
    }

    console.log("the canary passed: a second run hits its cache, a third revalidates to 304.");
    return 0;
  } finally {
    if (replica) replica.close();
    if (!options.keepCache && !options.cacheDir) {
      fs.rmSync(cacheDir, { force: true, recursive: true });
    }
  }
}

if (require.main === module) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      console.error(`[canary] ${err && err.stack ? err.stack : err}`);
      process.exitCode = 2;
    },
  );
}

module.exports = Object.freeze({
  COUNTERS,
  RUNS,
  SEED_TOOL_CLIENT,
  SEED_TOOL_CONFIG,
  SEED_TOOL_ENTRY,
  SEED_TOOL_ENV,
  SweepAbort,
  crossRunFailures,
  findSeedTool,
  formatTable,
  isSeedTool,
  judgeRun,
  main,
  parseArguments,
  parseReport,
  resolveSeedInputs,
  runCanary,
  seedToolCandidates,
  seedToolMissingReason,
  seederArgv,
  startReplica,
  verifyToolRules,
  sweepOnce,
});
