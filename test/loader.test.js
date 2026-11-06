/**
 * Loader tests
 *
 * Run with:  node --test "test/**\/*.test.js"   (from the mod directory, or RunTests.bat)
 *
 * `loader.js` cannot be `require`d from a test. Requiring it would install its
 * `Module._load` wrapper into the test runner's own process, where it would sit
 * in front of every require every other test file makes. So it is exercised the
 * way the launcher exercises it: as a `--require` preload on a child `node`
 * process. That is also the only way to observe what a process does at exit,
 * what it binds, and what it prints first.
 *
 * Everything runs against a copy of the mod. Each child preloads a `loader.js`
 * from a throwaway copy of the mod's runtime files rather than from this working
 * tree, for three reasons:
 *
 *   * `loadConfig()` reads a `.env` beside `config.js`. A developer with a real
 *     `.env` in this checkout would see these tests fail, or pass for the wrong
 *     reason. The copy excludes it.
 *   * one test needs a broken mod, and a test may not break a file in the
 *     working tree.
 *   * the copy carries every file `lib/sourceHash.js` hashes, so its build hash
 *     is provably the same as this tree's. That is asserted below, and it
 *     justifies checking the banner's hash against `shortSourceHash(MOD_DIR)`.
 *
 * The copies live in the OS temp directory, not under `test/`, so a killed run
 * leaves nothing behind in the repository.
 *
 * Every case asserts "and the game server is still up" in the bluntest way
 * available: the child's exit code, its output, and whether a port is bound.
 *
 *   * unconfigured  -> exit 0, says why, installs nothing, binds nothing
 *   * misconfigured -> exit 0, reports every problem
 *   * configured    -> hook armed, banner names version and build, and still
 *                      nothing bound, because no game module was ever required
 *                      (the multi-process guard working)
 *   * readiness     -> the listener comes up, `/_mod/health` answers JSON, and
 *                      the child still exits on its own, which is `unref()`
 *   * worker thread -> the loader does not install (guard 1)
 *   * double preload-> `Module._load` is wrapped exactly once
 *   * broken hook   -> logged, and the require that triggered it still returns
 *
 * No eve.js checkout is needed, and no fixed port is bound: `config.js` will not
 * accept port 0, so each child is handed a port the kernel just reported free,
 * and the one test that binds retries if it lost the race.
 */

"use strict";

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MOD_DIR = path.resolve(__dirname, "..");

const { shortSourceHash } = require(path.join(MOD_DIR, "lib", "sourceHash"));
const { MOD_VERSION } = require(path.join(MOD_DIR, "config"));

/** The build this working tree is, which every configured child must report. */
const SOURCE_HASH = shortSourceHash(MOD_DIR);

/** The banner: version, build, hook count. */
const BANNER = /\[EsiApiMod\] v[\d.]+ \(build ([0-9a-f]{12})\) active: (\d+) hook\(s\) armed/;

// Throwaway trees

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `esiApi-${label}-`));
  tempDirs.push(dir);
  return dir;
}

// Directories that are not part of what gets deployed, plus anything that could
// carry a developer's own configuration into a child process.
const NOT_DEPLOYED = new Set(["test", "docs", ".git", "node_modules", "settings.json", "dist", ".claude"]);

/**
 * Copy the mod's runtime files into a fresh temp directory.
 *
 * The filter keeps every file `lib/sourceHash.js` hashes (`loader.js`,
 * `config.js`, `server.js` and the `.js` files under `lib/` and `routes/`), so
 * the copy is byte-identical as the hash sees it, which the configured test
 * asserts rather than assumes.
 */
function copyMod(label) {
  const dir = tempDir(label);

  fs.cpSync(MOD_DIR, dir, {
    recursive: true,
    filter(src) {
      const relative = path.relative(MOD_DIR, src);
      if (relative === "") return true;
      const top = relative.split(path.sep)[0];
      if (NOT_DEPLOYED.has(top)) return false;
      // `.env` and `.env.local` are the hazard. `.env.example` is excluded with them
      // only because nothing needs it and neither is hashed.
      return !top.startsWith(".env");
    },
  });

  return dir;
}

// One good copy for the cases that do not modify it. Built on first use rather
// than at load, so a run that executes one test pays for one copy.
let sharedCopy = null;
function goodCopy() {
  if (sharedCopy === null) sharedCopy = copyMod("mod");
  return sharedCopy;
}

// Running a child with the loader preloaded

/**
 * Spawn `node --require <loader> [--require <loader>...] <script|-e 0>`.
 *
 * Every `ESI_MOD_*` variable is stripped from the inherited environment first,
 * so the child's configuration is exactly what the test asked for. So is
 * `NODE_OPTIONS`, which on a developer's machine may already carry a preload of
 * its own. `EVEJS_REPO_ROOT` is deliberately not stripped: the loader has to
 * behave identically whether or not a vendor tree is reachable, and the
 * assertions below hold either way.
 */
function runLoader(loaders, options = {}) {
  const { env = {}, script = null } = options;

  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("ESI_MOD_")) delete childEnv[key];
  }
  delete childEnv.NODE_OPTIONS;
  // SSO is armed by default (D47). A test opts in, so none binds the real 26006
  // or runs the credential loaders against a derived path by accident.
  childEnv.ESI_MOD_SSO_ISSUER = "";
  Object.assign(childEnv, env);

  const argv = [];
  for (const dir of loaders) argv.push("--require", path.join(dir, "loader.js"));
  if (script === null) argv.push("-e", "0");
  else argv.push(script);

  const result = spawnSync(process.execPath, argv, {
    env: childEnv,
    encoding: "utf8",
    // Generous, because a child that hangs should show up as a failure rather than
    // as a runner that never finishes.
    timeout: 30_000,
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return { status: result.status, stdout, stderr, output: stdout + stderr };
}

function bannerCount(output) {
  return (output.match(/\) active: /g) || []).length;
}

// Ports

/**
 * A port the kernel has just confirmed is free.
 *
 * `config.js` rejects port 0 (it is the mod's opt-in switch, a deliberate
 * choice), so a child that is meant to bind has to be told a real number. Asking
 * the kernel for one and immediately releasing it is a small race, which is why
 * the one test that binds retries on failure instead of trusting this.
 */
function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Can this process bind the port? If so, the child left nothing behind. */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

// A child that pretends to be the game process

/**
 * Write the two files a child needs to fire the readiness hook.
 *
 * The fake is required as `./wormholeRuntimeState`, a bare sibling path, which
 * is how the game requires it too: the request string the hook sees never
 * carries the `services/exploration/wormholes/...` path recorded in
 * `GAME_MODULES`. A test that required it by the full path would pass against a
 * loader that matched on the full path, and that loader would never fire in a
 * real game process.
 *
 * It is required twice on purpose: the hook table promises each entry fires
 * once, and the second require still goes through `Module._load` (Node's cache
 * is consulted inside it), so this proves the `done` bookkeeping.
 */
function writeGameChild(dir, { probeHealth, probeBurst = null }) {
  fs.writeFileSync(
    path.join(dir, "wormholeRuntimeState.js"),
    [
      '"use strict";',
      "// The shape the loader's hook probes for: an own, callable `mutateState`.",
      "module.exports = { mutateState() {} };",
      "",
    ].join("\n"),
  );

  const lines = [
    '"use strict";',
    'const first = require("./wormholeRuntimeState");',
    "console.log(`FAKE-OK ${typeof first.mutateState}`);",
    'const again = require("./wormholeRuntimeState");',
    "console.log(`FAKE-AGAIN ${typeof again.mutateState}`);",
  ];

  if (probeHealth) {
    lines.push(
      'const http = require("node:http");',
      "const port = Number(process.env.ESI_MOD_ESI_PORT);",
      "let attempts = 0;",
      "function poll() {",
      "  attempts += 1;",
      "  // `agent: false` so the client socket is not kept alive after the",
      "  // response: the listener is unref'd, and a ref'd keep-alive socket on",
      "  // this side would be what held the process open, hiding that.",
      '  const req = http.get({ host: "127.0.0.1", port, path: "/_mod/health", agent: false }, (res) => {',
      '    let body = "";',
      '    res.setEncoding("utf8");',
      '    res.on("data", (chunk) => { body += chunk; });',
      '    res.on("end", () => { console.log(`HEALTH ${res.statusCode} ${body}`); });',
      "  });",
      '  req.on("error", () => {',
      '    if (attempts >= 100) { console.log("HEALTH-UNREACHABLE"); return; }',
      "    setTimeout(poll, 20);",
      "  });",
      "}",
      "poll();",
    );
  }

  if (probeBurst) {
    // A sequential burst of GETs to an unrouted path: the shape of a third-party
    // tool enumerating characters this private server has never heard of at startup
    // (D44). Sequential rather than concurrent: the acceptance question is whether
    // the configured budget survives N errors in one window, not a test of the HTTP
    // layer's concurrency, and a fixed order makes `X-Esi-Error-Limit-Remain`
    // predictable per request.
    lines.push(
      'const http = require("node:http");',
      "const port = Number(process.env.ESI_MOD_ESI_PORT);",
      `const burstCount = ${probeBurst.count};`,
      `const burstPath = ${JSON.stringify(probeBurst.path)};`,
      "function get(path) {",
      "  return new Promise((resolve, reject) => {",
      '    const req = http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {',
      '      res.resume();',
      '      res.on("end", () => resolve({',
      "        status: res.statusCode,",
      '        remain: res.headers["x-esi-error-limit-remain"] || null,',
      "      }));",
      "    });",
      '    req.on("error", reject);',
      "  });",
      "}",
      "async function waitReady() {",
      "  for (let attempt = 0; attempt < 150; attempt += 1) {",
      "    try {",
      '      await get("/_mod/health");',
      "      return;",
      "    } catch (err) {",
      "      await new Promise((resolve) => setTimeout(resolve, 20));",
      "    }",
      "  }",
      '  throw new Error("server never became reachable");',
      "}",
      "async function burst() {",
      "  await waitReady();",
      "  const results = [];",
      "  for (let i = 0; i < burstCount; i += 1) results.push(await get(`${burstPath}${i}/`));",
      "  console.log(`BURST ${JSON.stringify(results)}`);",
      "}",
      "burst().catch((err) => {",
      "  console.error(String(err));",
      "  process.exitCode = 1;",
      "});",
    );
  }

  lines.push("");
  const main = path.join(dir, "main.js");
  fs.writeFileSync(main, lines.join("\n"));
  return main;
}

// The cases

test("both switches blank is dormant, installs nothing and still exits cleanly", () => {
  const run = runLoader([goodCopy()], { env: { ESI_MOD_ESI_PORT: "" } });

  assert.equal(run.status, 0);
  // The line has to name the two variables, or "dormant" is a dead end for
  // whoever is reading it.
  assert.match(run.stdout, /\[EsiApiMod\] dormant: ESI_MOD_ESI_PORT and ESI_MOD_SSO_ISSUER are both blank/);

  // Nothing installed: no banner, no hooks, and, because this is an acceptance
  // test rather than a unit test, no non-zero exit and no stack.
  assert.equal(bannerCount(run.output), 0);
  assert.doesNotMatch(run.output, /hook\(s\) armed/);

  // Nothing on stderr. The circular-dependency proxy warning is the one this mod
  // must never provoke: eve.js's ProcessLifecycle logs it with a full stack and a
  // heap snapshot, dozens of times, for what is a normal load order.
  assert.equal(run.stderr.trim(), "");
});

test("with no configuration both listeners are armed, and nothing binds before readiness (D47)", () => {
  // `undefined` removes the blank issuer runLoader supplies. No game module is
  // required here, so the readiness hook never fires: no port, no credential.
  const run = runLoader([goodCopy()], { env: { ESI_MOD_SSO_ISSUER: undefined } });

  assert.equal(run.status, 0, run.output);
  const banner = run.stdout.match(BANNER);
  assert.ok(banner, `expected a banner, got:\n${run.output}`);
  assert.equal(banner[2], "3");
  assert.match(run.stdout, /ESI 127\.0\.0\.1:26005 starts when/);
  assert.match(run.stdout, /SSO 127\.0\.0\.1:26006 issuing http:\/\/localhost:26006/);
  assert.doesNotMatch(run.output, /listener on /);
  assert.equal(run.stderr.trim(), "");
});

test("a misconfigured mod reports every problem and never exits non-zero", () => {
  const run = runLoader([goodCopy()], {
    env: {
      ESI_MOD_ESI_PORT: "not-a-port",
      ESI_MOD_SSO_PORT: "99999",
      ESI_MOD_SIGNING_KEY_PATH: "relative/key.pem",
    },
  });

  assert.equal(run.status, 0);

  // Every problem, not the first one. A deployment that has to restart a game
  // server once per typo stops reading the console.
  assert.match(run.stdout, /not starting: 3 configuration problem\(s\)/);
  assert.match(run.stdout, /ESI_MOD_ESI_PORT must be a whole number/);
  assert.match(run.stdout, /ESI_MOD_SSO_PORT must be between 1 and 65535/);
  assert.match(run.stdout, /ESI_MOD_SIGNING_KEY_PATH must be an absolute path/);

  assert.equal(bannerCount(run.output), 0);
  assert.equal(run.stderr.trim(), "");
});

test("a configured mod arms its hook, names its build, and binds nothing on its own", async () => {
  const copy = goodCopy();

  // Earns the right to compare the child's banner against this tree's hash.
  assert.equal(shortSourceHash(copy), SOURCE_HASH);

  const port = await reservePort();
  const run = runLoader([copy], { env: { ESI_MOD_ESI_PORT: String(port) } });

  assert.equal(run.status, 0);

  const banner = run.stdout.match(BANNER);
  assert.ok(banner, `expected a banner, got:\n${run.output}`);
  assert.equal(banner[1], SOURCE_HASH);
  assert.equal(banner[2], "1");
  assert.match(run.stdout, new RegExp(`ESI 127\\.0\\.0\\.1:${port} starts when`));

  // The multi-process guard, stated as an observation: this child required no
  // game module, so the readiness hook never fired, so nothing was bound. That is
  // what the healthcheck process and the forked edge processes do.
  assert.doesNotMatch(run.output, /ESI listener on/);
  assert.equal(await portIsFree(port), true);
  assert.equal(run.stderr.trim(), "");
});

test("the readiness hook starts the listener, /_mod/health answers JSON, and the child still exits", async () => {
  const copy = goodCopy();

  // The reserved port is free when we ask and might not be a moment later. Losing
  // that race is not a loader failure, so retry it. A repeated loss is one, and
  // falls through to the assertions.
  let run = null;
  let port = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    port = await reservePort();
    const child = tempDir("child");
    const main = writeGameChild(child, { probeHealth: true });
    run = runLoader([copy], { env: { ESI_MOD_ESI_PORT: String(port) }, script: main });
    if (!run.output.includes("ESI listener did not start")) break;
  }

  // The child exits on its own, with a listener bound. That is `server.unref()`:
  // without it this spawn would sit until the 30 s timeout, and inside a game
  // server it would be a process that refuses to shut down.
  assert.equal(run.status, 0, `child did not exit cleanly:\n${run.output}`);

  assert.match(run.stdout, /game runtime reachable, starting mod services/);
  assert.match(run.stdout, new RegExp(`ESI listener on http://127\\.0\\.0\\.1:${port}`));

  // Fired once, though the module was required twice.
  assert.equal((run.stdout.match(/hook "gameRuntimeReady" applied/g) || []).length, 1);
  assert.match(run.stdout, /FAKE-OK function/);
  assert.match(run.stdout, /FAKE-AGAIN function/);

  const health = run.stdout.match(/HEALTH (\d+) (\{.*\})/);
  assert.ok(health, `expected a health response, got:\n${run.output}`);
  assert.equal(health[1], "200");

  const body = JSON.parse(health[2]);
  assert.equal(body.status, "ok");
  assert.equal(body.modVersion, MOD_VERSION);
  // Handed down from the banner rather than hashed a second time.
  assert.equal(body.sourceHash, SOURCE_HASH);
  assert.equal(typeof body.startedAt, "string");
  assert.equal(typeof body.uptimeSeconds, "number");
  // Reported, not judged: whether the runtime is reachable depends on whether this
  // machine has a vendor tree, and either answer is a valid health report.
  assert.equal(typeof body.runtimeReachable.reachable, "boolean");

  // The listener really is gone with the process.
  assert.equal(await portIsFree(port), true);
});

// The configurable error-limit budget (D44).
//
// A third-party tool observed against a deployment of this replica enumerates
// every character it knows about at startup in one burst. Most are Tranquility
// characters this private server has never heard of, so they correctly answer
// 404, and CCP's observed 100-error budget (`lib/errorLimiter.js` `MAX_ERRORS`)
// does not survive two such bursts, after which even a request that would have
// succeeded is refused with a 420. This is the acceptance case: driven through
// the real listener rather than a dispatch double, `ESI_MOD_ERROR_LIMIT_MAX_ERRORS`
// unset reproduces that failure exactly, and set past the burst size, it does
// not.
test("ESI_MOD_ERROR_LIMIT_MAX_ERRORS raises the budget the real listener enforces, and unset leaves CCP's 100 untouched", async () => {
  async function burstAgainst(envExtra) {
    let run = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const port = await reservePort();
      const child = tempDir("child");
      const main = writeGameChild(child, {
        probeHealth: false,
        probeBurst: { count: 120, path: "/nope/" },
      });
      run = runLoader([goodCopy()], {
        env: { ESI_MOD_ESI_PORT: String(port), ...envExtra },
        script: main,
      });
      if (!run.output.includes("ESI listener did not start")) break;
    }
    assert.equal(run.status, 0, `child did not exit cleanly:\n${run.output}`);
    const match = run.stdout.match(/BURST (\[.*\])/);
    assert.ok(match, `expected a burst result, got:\n${run.output}`);
    return JSON.parse(match[1]);
  }

  // Unset: CCP's observed 100. 120 requests span the limit, so the tail is
  // refused with a 420, the failure a startup burst produced against a deployment
  // of this replica.
  const atDefault = await burstAgainst({});
  assert.equal(atDefault.length, 120);
  assert.equal(atDefault[99].status, 404, "the 100th error is still answered");
  assert.equal(atDefault[100].status, 420, "the 101st is refused, not answered");
  assert.equal(
    atDefault.filter((r) => r.status === 420).length,
    20,
    "requests 101 through 120 are all refused",
  );

  // The same 120-request burst, against a budget configured well past it.
  // Nothing in it is refused, and the last response is charged against the
  // configured number rather than CCP's 100.
  const raised = await burstAgainst({ ESI_MOD_ERROR_LIMIT_MAX_ERRORS: "200" });
  assert.equal(raised.length, 120);
  assert.equal(
    raised.filter((r) => r.status === 420).length,
    0,
    "no request in the burst is refused",
  );
  assert.equal(raised[119].remain, String(200 - 120));
});

test("the loader does not install in a worker thread", async () => {
  const copy = goodCopy();
  const child = tempDir("worker");

  fs.writeFileSync(
    path.join(child, "worker.js"),
    ['"use strict";', 'console.log("WORKER-RAN");', ""].join("\n"),
  );

  const main = path.join(child, "main.js");
  fs.writeFileSync(
    main,
    [
      '"use strict";',
      // Worker threads inherit `execArgv`, so the `--require` preload runs in the
      // worker exactly as `NODE_OPTIONS` would make it run in every forked process.
      // Nothing is passed to make that happen.
      'const path = require("node:path");',
      'const { Worker } = require("node:worker_threads");',
      'const worker = new Worker(path.join(__dirname, "worker.js"));',
      'worker.on("exit", (code) => console.log(`WORKER-EXIT ${code}`));',
      "",
    ].join("\n"),
  );

  const port = await reservePort();
  const run = runLoader([copy], { env: { ESI_MOD_ESI_PORT: String(port) }, script: main });

  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, /WORKER-RAN/);
  assert.match(run.stdout, /WORKER-EXIT 0/);

  // One banner, from the main thread only. The `isMainThread` guard did it, not
  // the install flag: a worker gets a fresh `globalThis`, so the flag would have
  // let it through and said nothing.
  assert.equal(bannerCount(run.output), 1);
  assert.doesNotMatch(run.output, /already installed/);
});

test("a second preload of the same file wraps Module._load exactly once", async () => {
  const copy = goodCopy();
  const port = await reservePort();

  const run = runLoader([copy, copy], { env: { ESI_MOD_ESI_PORT: String(port) } });

  assert.equal(run.status, 0);
  assert.equal(bannerCount(run.output), 1);
});

test("a second copy reached by a different path installs nothing and says so", async () => {
  // Node's module cache makes a repeated `--require` of one resolved path a no-op
  // on its own, so it cannot exercise INSTALL_FLAG. Two copies can: it is the
  // same loader reached by two paths, which is what a symlinked `mods/` directory
  // or a stale copy beside a fresh one produces.
  const first = goodCopy();
  const second = copyMod("dup");
  const port = await reservePort();

  const run = runLoader([first, second], { env: { ESI_MOD_ESI_PORT: String(port) } });

  assert.equal(run.status, 0);
  assert.equal(bannerCount(run.output), 1);
  assert.equal(
    (run.stdout.match(/already installed in this process/g) || []).length,
    1,
  );
});

test("a hook whose run throws is logged, and the require that triggered it still returns", async () => {
  // Break a module the readiness hook reaches for lazily, which is why those
  // requires are inside the handler: a module that cannot load must cost the mod
  // its listener and cost the game server nothing. Breaking it at parse time
  // rather than call time also proves the preload never touched it. An eager
  // require would have failed in `install()` instead, and this test would see a
  // different message.
  const broken = copyMod("broken");
  fs.writeFileSync(
    path.join(broken, "routes", "health.js"),
    ['"use strict";', 'throw new Error("deliberate health.js failure");', ""].join("\n"),
  );

  const child = tempDir("broken-child");
  const main = writeGameChild(child, { probeHealth: false });

  const port = await reservePort();
  const run = runLoader([broken], {
    env: { ESI_MOD_ESI_PORT: String(port) },
    script: main,
  });

  // The mod is armed: the failure is in the handler, not in the install.
  assert.equal(bannerCount(run.output), 1);

  // Logged, named, and survivable.
  assert.match(run.stderr, /hook "gameRuntimeReady" failed, continuing without it/);
  assert.match(run.stderr, /deliberate health\.js failure/);

  // The require that triggered the failing hook still returned the module's real
  // exports. This matters most: game code that has no idea this mod exists must
  // not be able to see its failures.
  assert.match(run.stdout, /FAKE-OK function/);
  assert.match(run.stdout, /FAKE-AGAIN function/);

  // The loop kept going and the process came down normally.
  assert.equal(run.status, 0, run.output);
  assert.doesNotMatch(run.output, /ESI listener on/);
  assert.equal(await portIsFree(port), true);
});

test("a port eve.js uses leaves the mod inert and the process running", () => {
  const run = runLoader([goodCopy()], { env: { ESI_MOD_ESI_PORT: "26000" } });

  assert.equal(run.status, 0, "a config error must never take the game process down");
  assert.match(run.stdout, /not starting: 1 configuration problem/);
  assert.match(run.stdout, /ESI_MOD_ESI_PORT is 26000/);
  assert.doesNotMatch(run.output, /listener on/);
  assert.equal(run.stderr.trim(), "");
});
