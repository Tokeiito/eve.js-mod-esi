/**
 * The acceptance runner's judgement, tested without the tool.
 *
 * `scripts/market-canary.js` runs the real `market-hub-seed` against a real
 * replica three times and decides whether the run met the acceptance criterion.
 * That is end-to-end acceptance tooling, run by hand on a machine that has the
 * tool and a market. It is not part of this suite or of CI.
 *
 * Tested here is the part that belongs to this repository: how it judges the
 * counters it gets back, what argv it builds, and how it reads a report. All of
 * it is pure, so none of it skips.
 *
 * The contract question (does the mod still serve what ESI serves) is covered by
 * `marketSweepContract.test.js` and the rest of the contract suite, which assert
 * against the pinned spec and the recorded wire survey, not against any
 * client's behaviour.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  COUNTERS,
  RUNS,
  crossRunFailures,
  judgeRun,
  parseReport,
  seederArgv,
  verifyToolRules,
} = require(path.join(__dirname, "..", "scripts", "market-canary"));

// Judging a pass

test("a pass is judged on all three counters, not just the one it expects", () => {
  const cached = RUNS.find((run) => run.id === "cached");

  assert.deepEqual(judgeRun(cached, { freshCacheHits: 81 }, 81), []);

  // A run that hit its cache 81 times and went to the network 3 more times has
  // not met the acceptance criterion. A check that only looked at the expected
  // counter would call it a pass.
  assert.deepEqual(
    judgeRun(cached, { freshCacheHits: 81, networkResponses: 3 }, 81),
    ["networkResponses: expected 0, got 3"],
  );

  assert.deepEqual(
    judgeRun(cached, { freshCacheHits: 80 }, 81),
    ["freshCacheHits: expected 81, got 80"],
  );

  // A missing counter is zero, not a crash: a tool that stopped reporting one
  // must fail the gate rather than take it down.
  assert.deepEqual(judgeRun(cached, undefined, 1), ["freshCacheHits: expected 1, got 0"]);
});

test("the three passes together cover every outcome exactly once", () => {
  // Each of the client's three outcomes is claimed by exactly one pass, so "the
  // other two must be zero" is a complete rule: a response served the wrong way
  // has nowhere to be counted quietly.
  assert.deepEqual(RUNS.map((run) => run.expect).sort(), Object.keys(COUNTERS).sort());
  assert.equal(new Set(RUNS.map((run) => run.id)).size, RUNS.length);
  assert.deepEqual(RUNS.map((run) => run.fresh), [false, false, true], "only the last is --fresh");
});

test("passes that disagree about the book are a failure, however they were served", () => {
  const base = { id: "cold", pages: 3, sha256: "a".repeat(64) };

  assert.deepEqual(crossRunFailures([base, { ...base, id: "cached" }]), []);
  assert.deepEqual(crossRunFailures([base]), [], "one pass agrees with itself");

  const [pagesMoved] = crossRunFailures([base, { ...base, id: "cached", pages: 4 }]);
  assert.match(pagesMoved, /X-Pages moved between passes: cold saw 3, cached saw 4/);

  const [bodiesDiffer] = crossRunFailures([base, { ...base, id: "cached", sha256: "b".repeat(64) }]);
  assert.match(bodiesDiffer, /the bodies differ between passes/);
});

// Driving the tool

test("the tool is never one flag away from writing to a market", () => {
  const options = {
    baseUrl: "http://127.0.0.1:26005",
    cacheDir: "/tmp/cache",
    compatibilityDate: "2026-08-23",
    configPath: "/tool/major-trade-hubs.json",
    databasePath: "/store/market.sqlite",
    requestDelayMs: null,
    solarSystemsData: "/store/solarSystems.json",
    stationsData: "/store/stations.json",
    toolDir: "/tool",
    userAgent: "canary",
  };

  const argv = seederArgv(options, { fresh: false });

  assert.ok(argv.includes("--dry-run"), "the canary must never run an --apply");
  assert.equal(argv.includes("--apply"), false);
  assert.equal(argv.includes("--fresh"), false, "only the third pass revalidates");
  assert.equal(argv.includes("--request-delay-ms"), false, "unset means the tool's own default");

  assert.deepEqual(
    argv.slice(argv.indexOf("--esi-base-url")),
    ["--esi-base-url", "http://127.0.0.1:26005"],
    "and it points at the replica, never at CCP",
  );

  assert.ok(seederArgv(options, { fresh: true }).includes("--fresh"));
});

test("the tool's report is read from stdout, and a silent tool is an error", () => {
  const report = parseReport('  {"cache":{"freshCacheHits":81},"source":{"orderPages":80}}\n');
  assert.equal(report.cache.freshCacheHits, 81);
  assert.equal(report.source.orderPages, 80);

  // A tool that printed progress before its report is still readable. One that
  // printed nothing has not run, and must not be mistaken for one that did.
  assert.equal(parseReport('note\n{"ok":true}').ok, true);
  assert.throws(() => parseReport("   "), /printed no report/);
  assert.throws(() => parseReport("something went wrong"), /printed no JSON report/);
});

// The copy of the tool's rules

test("a tool that dropped a rule this canary reproduces is reported, not run", () => {
  // The script rebuilds market-hub-seed's sweep loop around the tool's own
  // client, so it holds a copy of the tool's URL shapes and its two aborts.
  // `verifyToolRules` notices when the original changes. It is checked here
  // against strings rather than a checkout, so it is covered on a machine with no
  // tool.
  const stillTheTool = (files) => verifyToolRules("/unused", (file) => files[file]);

  const intact = stillTheTool({
    "market-hub-seed.js": [
      "/markets/prices/?datasource=tranquility",
      "/orders/?datasource=tranquility&order_type=all",
      "ESI pagination changed during download",
      "ESI order pages have different Last-Modified values",
    ].join("\n"),
    "esi-cache-client.js": [
      "networkResponses += 1",
      "freshCacheHits += 1",
      "conditionalCacheHits += 1",
    ].join("\n"),
  });
  assert.deepEqual(intact, []);

  const droppedTheAbort = stillTheTool({
    "market-hub-seed.js": [
      "/markets/prices/?datasource=tranquility",
      "/orders/?datasource=tranquility&order_type=all",
      "ESI order pages have different Last-Modified values",
    ].join("\n"),
    "esi-cache-client.js": [
      "networkResponses += 1",
      "freshCacheHits += 1",
      "conditionalCacheHits += 1",
    ].join("\n"),
  });
  assert.equal(droppedTheAbort.length, 1);
  assert.match(droppedTheAbort[0], /ESI pagination changed during download/);
  assert.match(droppedTheAbort[0], /the X-Pages abort this sweep reproduces/);

  // An unreadable file is a problem too, and is named once rather than once per
  // rule that would have read it.
  const unreadable = verifyToolRules("/unused", (file) => {
    if (file === "esi-cache-client.js") throw new Error("ENOENT");
    return "/markets/prices/?datasource=tranquility"
      + "\n/orders/?datasource=tranquility&order_type=all"
      + "\nESI pagination changed during download"
      + "\nESI order pages have different Last-Modified values";
  });
  assert.deepEqual(unreadable, ["esi-cache-client.js could not be read: ENOENT"]);
});
