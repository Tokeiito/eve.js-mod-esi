/**
 * The SSO listener: `lib/ssoDispatch.js`, and the second port it sits behind.
 *
 * Run with:  node --test "test/**\/*.test.js"   (from the mod directory, or RunTests.bat)
 *
 * Two halves, separate on purpose:
 *
 *   the dispatch    pure. exact-match routing and construction-time validation,
 *                   driven with object literals and route doubles. No socket.
 *   the listener    one real port, on port 0, to prove that the SSO surface gets
 *                   everything `server.js` gives the ESI one, including
 *                   `lib/headers.js` casing on the way out, which
 *                   `routes/oauthJwks.js` depends on and which is invisible from
 *                   any test that reads headers through `fetch`.
 *
 * No game code, no eve.js checkout, no config file. `startServer` is handed a
 * hand-built config, which is also how a test reaches port 0 at all: `config.js`
 * rejects 0 for a real deployment.
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

const { createSsoDispatch, SsoRouteTableError } = require(
  path.join(__dirname, "../lib/ssoDispatch"),
);
const { closeServer, startServer } = require(path.join(__dirname, "../server"));
const { createOauthDiscoveryRoute } = require(path.join(__dirname, "../routes/oauthDiscovery"));

const ISSUER = "http://host.local:26006";

/** A minimal well-formed route, for the cases that need one that works. */
function routeAt(paths, result = { status: 200, body: "ok" }) {
  return { name: `route at ${paths[0]}`, paths, handle: () => result };
}

/** The config shape `startServer` reads for the SSO row. */
function ssoConfig(overrides = {}) {
  return {
    modVersion: "0.1.0",
    esiBindHost: "127.0.0.1",
    esiPort: 65535,
    ssoBindHost: "127.0.0.1",
    ssoPort: 0,
    ssoIssuer: ISSUER,
    devAutoApprove: false,
    devAutoApproveCharacterID: null,
    signingKeyPath: null,
    logLevel: "info",
    ...overrides,
  };
}

async function serveSso(t, dispatch) {
  const handle = await startServer({
    config: ssoConfig(),
    listener: "sso",
    dispatch,
    log: () => {},
    logError: () => {},
  });
  t.after(() => closeServer(handle));
  return handle;
}

/**
 * Speak HTTP by hand, because the header casing is under test and every
 * high-level client in Node lowercases header names before you see them.
 */
function rawExchange(port, request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(port, "127.0.0.1", () => socket.write(request));
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error("the SSO listener never answered"));
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function get(port, pathname, method = "GET") {
  return rawExchange(
    port,
    `${method} ${pathname} HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n\r\n`,
  );
}

function statusOf(text) {
  return Number(text.split("\r\n")[0].split(" ")[1]);
}

function bodyOf(text) {
  return text.slice(text.indexOf("\r\n\r\n") + 4);
}

// Construction.
//
// Every one of these is a boot-time failure naming the route, for the reason
// `createRouter` gives on the ESI side, and the argument is stronger here. An
// unreachable `token_endpoint` is not noticed until a client's access token
// expires, which is twenty minutes after everything looked fine.

test("a route table that is not an array is refused", () => {
  assert.throws(() => createSsoDispatch(undefined), SsoRouteTableError);
  assert.throws(() => createSsoDispatch({ paths: ["/x"] }), /must be an array/);
});

test("a route with no paths is refused, naming it", () => {
  assert.throws(
    () => createSsoDispatch([{ name: "Nameless", handle: () => ({ status: 200 }) }]),
    /Nameless declares no paths/,
  );
  assert.throws(() => createSsoDispatch([{ paths: [], handle: () => ({}) }]), /declares no paths/);
});

test("a route with no handle function is refused", () => {
  assert.throws(
    () => createSsoDispatch([{ name: "Discovery", paths: ["/a"] }]),
    /Discovery has no handle function/,
  );
  assert.throws(
    () => createSsoDispatch([{ paths: ["/a"], handle: "nope" }]),
    /has no handle function/,
  );
});

test("a route named by neither name nor path is still identifiable in the message", () => {
  // The message is composed about a route that failed validation, so it has to
  // survive a route with nothing usable on it rather than throwing while
  // describing a throw.
  assert.throws(() => createSsoDispatch([null]), /SSO route #0 is not an object/);
  assert.throws(() => createSsoDispatch([{ paths: ["/ok"], handle: () => ({}) }, 42]), /#1/);
});

test("a path that is not absolute is refused", () => {
  assert.throws(
    () => createSsoDispatch([routeAt(["oauth/jwks"])]),
    /is not an absolute path/,
  );
  assert.throws(() => createSsoDispatch([routeAt([42])]), /is not an absolute path/);
});

test("two routes claiming one path collide loudly, naming both", () => {
  assert.throws(
    () =>
      createSsoDispatch([
        { name: "First", paths: ["/oauth/jwks"], handle: () => ({ status: 200 }) },
        { name: "Second", paths: ["/oauth/jwks"], handle: () => ({ status: 200 }) },
      ]),
    /Second and First both claim "\/oauth\/jwks"/,
  );
});

test("one route claiming the same path twice collides with itself", () => {
  assert.throws(() => createSsoDispatch([routeAt(["/a", "/a"])]), /both claim "\/a"/);
});

// Routing

test("an exact path reaches its handler, and the handler's result is returned unchanged", async () => {
  const seen = [];
  const dispatch = createSsoDispatch([
    {
      name: "Echo",
      paths: ["/v2/oauth/token"],
      handle(request) {
        seen.push(request);
        return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
      },
    },
  ]);

  const request = { method: "POST", pathname: "/v2/oauth/token", query: {}, headers: {} };
  const result = await dispatch(request);

  assert.equal(result.status, 200);
  assert.equal(result.body, "{}");
  // The route sees the whole request, not a projection of it: `handle` owns its
  // own method check, so it has to be able to make one.
  assert.equal(seen.length, 1);
  assert.equal(seen[0], request);
});

test("`/v2/oauth/token` is a literal path here, not a version prefix", async () => {
  // The ESI router would strip `v2` as a version prefix and refuse the route at
  // construction. D6 put this surface on its own listener so that the version
  // dimension stays ESI's alone.
  const dispatch = createSsoDispatch([routeAt(["/v2/oauth/token"])]);

  assert.equal((await dispatch({ pathname: "/v2/oauth/token" })).status, 200);
  // No prefix-stripping happens in either direction.
  assert.equal((await dispatch({ pathname: "/oauth/token" })).status, 404);
  assert.equal((await dispatch({ pathname: "/latest/v2/oauth/token" })).status, 404);
});

test("nothing is folded: a trailing slash is a different path", async () => {
  const dispatch = createSsoDispatch([routeAt(["/oauth/jwks"])]);

  assert.equal((await dispatch({ pathname: "/oauth/jwks" })).status, 200);
  assert.equal((await dispatch({ pathname: "/oauth/jwks/" })).status, 404);
  assert.equal((await dispatch({ pathname: "/OAUTH/JWKS" })).status, 404);
  assert.equal((await dispatch({ pathname: "//oauth/jwks" })).status, 404);

  // This is why the discovery document is mounted at two explicit paths rather
  // than one path and a normalizer: both spellings are deliberate, and a fold
  // would collapse two facts into one.
  const both = createSsoDispatch([routeAt(["/a", "/a/"])]);
  assert.equal((await both.call(null, { pathname: "/a" })).status, 200);
  assert.equal((await both.call(null, { pathname: "/a/" })).status, 200);
});

test("an unrouted path is a bodiless 404 that invents nothing", async () => {
  const dispatch = createSsoDispatch([routeAt(["/oauth/jwks"])]);
  const result = await dispatch({ pathname: "/nope" });

  // Ours, not a reproduction: what `login.eveonline.com` answers for an unrouted
  // path is unobserved, and ESI's `404 page not found` is Go's, established
  // against a different host running different software. So this claims the
  // status and nothing else: no body to be byte-compared, no content-type
  // describing a body that is not there.
  assert.deepEqual(result, { status: 404 });
});

test("a request with no usable pathname is a 404 rather than a throw", async () => {
  // `server.js` catches a throwing dispatch, but a 500 for a missing field would
  // put a stack in a game server's log for what is a routing miss.
  const dispatch = createSsoDispatch([routeAt(["/a"])]);

  for (const request of [{}, { pathname: null }, { pathname: 42 }, null, undefined]) {
    assert.equal((await dispatch(request)).status, 404, `${JSON.stringify(request)}`);
  }
});

test("a path in the table cannot reach through the prototype", async () => {
  // `__proto__` and `constructor` as keys are why the table is a Map. Nothing
  // will ever serve them; something will eventually ask for them.
  const dispatch = createSsoDispatch([routeAt(["/a"])]);

  assert.equal((await dispatch({ pathname: "__proto__" })).status, 404);
  assert.equal((await dispatch({ pathname: "constructor" })).status, 404);
  assert.equal((await dispatch({ pathname: "toString" })).status, 404);
});

// On a real port

test("the discovery document is served from the SSO listener at both paths", async (t) => {
  const handle = await serveSso(
    t,
    createSsoDispatch([createOauthDiscoveryRoute({ issuer: ISSUER })]),
  );

  for (const pathname of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/",
  ]) {
    const text = await get(handle.port, pathname);
    assert.equal(statusOf(text), 200, pathname);
    assert.equal(JSON.parse(bodyOf(text)).issuer, ISSUER, pathname);
  }

  assert.equal(statusOf(await get(handle.port, "/status/")), 404);
});

test("header names leave the SSO listener in CCP's casing, not lowercase", async (t) => {
  // `routes/oauthJwks.js` and `routes/oauthDiscovery.js` both write header names
  // in this codebase's internal lowercase and rely on `server.js` putting them
  // through `lib/headers.js` on the way to the socket. That is one implementation
  // shared by both listeners, but "shared" is a claim about a code path, and this
  // asserts that it covers the second one. Every client in Node lowercases
  // headers before a test can see them, hence the raw socket.
  const handle = await serveSso(
    t,
    createSsoDispatch([createOauthDiscoveryRoute({ issuer: ISSUER })]),
  );

  const head = (await get(handle.port, "/.well-known/oauth-authorization-server")).split(
    "\r\n\r\n",
  )[0];

  assert.match(head, /\r\nContent-Type: application\/json\r\n/);
  assert.match(head, /\r\nCache-Control: /);
  assert.match(head, /\r\nAccess-Control-Allow-Origin: \*\r\n/);
  assert.doesNotMatch(head, /\r\ncontent-type:/);
});

test("a method the route does not accept is refused by the route, with Allow", async (t) => {
  // The refusal is the route's own: `lib/ssoDispatch.js` has no method table,
  // because a central one would be a second place to state what each route
  // accepts.
  const handle = await serveSso(
    t,
    createSsoDispatch([createOauthDiscoveryRoute({ issuer: ISSUER })]),
  );

  const text = await get(handle.port, "/.well-known/oauth-authorization-server", "POST");
  assert.equal(statusOf(text), 405);
  assert.match(text, /\r\nAllow: GET\r\n/);
});

test("the SSO listener carries none of the ESI pipeline's headers", async (t) => {
  // D6's second reason for the split: the error limiter, the rate limiter, the
  // compatibility-date echo and the request-id stamp are all ESI's, and a shared
  // pipeline would have put every one of them on this response.
  const handle = await serveSso(
    t,
    createSsoDispatch([createOauthDiscoveryRoute({ issuer: ISSUER })]),
  );

  const head = (await get(handle.port, "/.well-known/oauth-authorization-server")).split(
    "\r\n\r\n",
  )[0];

  for (const name of [
    "X-Esi-Error-Limit-Remain",
    "X-Esi-Error-Limit-Reset",
    "X-Ratelimit-Group",
    "X-Ratelimit-Limit",
    "X-Compatibility-Date",
    "X-Esi-Request-Id",
    "X-Esi-Cache-Status",
    "Content-Language",
  ]) {
    assert.doesNotMatch(head, new RegExp(`\r\n${name}:`, "i"), `${name} is ESI's, not SSO's`);
  }
});

// Through the loader, in a child process.
//
// An issuer in the environment brings a second listener up beside the ESI one,
// and its absence leaves the mod serving ESI and nothing else.
// `test/loader.test.js` owns the general child harness, and this file keeps its
// own narrow one rather than reaching into it: the two assert different things,
// and a shared fixture between test files is a coupling neither declared.
//
// The mod is copied first, without any `.env`. Preloading this repository's own
// `loader.js` would read a developer's real `.env` beside it, and the child's
// configuration has to be exactly what the test asked for.

const MOD_DIR = path.dirname(require.resolve("../loader"));
const NOT_DEPLOYED = new Set(["test", "docs", ".git", "node_modules", "settings.json", "dist", ".claude"]);

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `esi-mod-sso-${label}-`));
  tempDirs.push(dir);
  return dir;
}

let sharedCopy = null;
function modCopy() {
  if (sharedCopy !== null) return sharedCopy;

  const dir = tempDir("mod");
  fs.cpSync(MOD_DIR, dir, {
    recursive: true,
    filter(src) {
      const relative = path.relative(MOD_DIR, src);
      if (relative === "") return true;
      const top = relative.split(path.sep)[0];
      if (NOT_DEPLOYED.has(top)) return false;
      return !top.startsWith(".env");
    },
  });

  sharedCopy = dir;
  return dir;
}

/** A port the kernel has just confirmed free. `config.js` rejects 0 for a real deployment. */
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

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function runLoader(loaderDir, { env = {}, script = null } = {}) {
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("ESI_MOD_")) delete childEnv[key];
  }
  delete childEnv.NODE_OPTIONS;
  // SSO is armed by default (D47). A test opts in, so none binds the real 26006
  // or runs the credential loaders against a derived path by accident.
  childEnv.ESI_MOD_SSO_ISSUER = "";
  Object.assign(childEnv, env);

  const argv = ["--require", path.join(loaderDir, "loader.js")];
  argv.push(...(script === null ? ["-e", "0"] : [script]));

  const result = spawnSync(process.execPath, argv, {
    env: childEnv,
    encoding: "utf8",
    timeout: 30_000,
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return { status: result.status, stdout, stderr, output: stdout + stderr };
}

/**
 * The two files a child needs to fire the readiness hook, plus a probe of the
 * SSO port.
 *
 * The fake is required as `./wormholeRuntimeState`, a bare sibling path, which
 * is how the game requires it, and therefore the request string the hook
 * actually sees.
 */
function writeGameChild(dir, { probePaths }) {
  fs.writeFileSync(
    path.join(dir, "wormholeRuntimeState.js"),
    ['"use strict";', "module.exports = { mutateState() {} };", ""].join("\n"),
  );

  const main = path.join(dir, "main.js");
  fs.writeFileSync(
    main,
    [
      '"use strict";',
      'require("./wormholeRuntimeState");',
      'const http = require("node:http");',
      "const port = Number(process.env.ESI_MOD_SSO_PORT);",
      `const paths = ${JSON.stringify(probePaths)};`,
      "let attempts = 0;",
      // `agent: false` so no ref'd keep-alive socket on this side holds the process
      // open and hides an un-unref'd listener.
      "function fetchPath(target, done) {",
      '  const req = http.get({ host: "127.0.0.1", port, path: target, agent: false }, (res) => {',
      '    let body = "";',
      '    res.setEncoding("utf8");',
      '    res.on("data", (chunk) => { body += chunk; });',
      "    res.on(\"end\", () => {",
      "      const where = res.headers.location;",
      "      console.log(`SSO ${target} ${res.statusCode} ${where === undefined ? body : where}`);",
      "      done(true);",
      "    });",
      "  });",
      '  req.on("error", () => done(false));',
      "}",
      // The first path decides whether the listener is up at all. The rest are
      // fetched once it is, in order, so one poll loop covers every path rather than
      // one race per path.
      "function poll() {",
      "  attempts += 1;",
      "  fetchPath(paths[0], (reached) => {",
      "    if (!reached) {",
      '      if (attempts >= 100) { console.log("SSO-UNREACHABLE"); return; }',
      "      setTimeout(poll, 20);",
      "      return;",
      "    }",
      "    let next = 1;",
      "    (function rest() {",
      "      if (next >= paths.length) return;",
      "      const target = paths[next];",
      "      next += 1;",
      "      fetchPath(target, rest);",
      "    })();",
      "  });",
      "}",
      "poll();",
      "",
    ].join("\n"),
  );
  return main;
}

test("a blank issuer: the banner says SSO is off and names the switch", () => {
  const run = runLoader(modCopy(), { env: { ESI_MOD_ESI_PORT: "26005" } });

  assert.equal(run.status, 0);
  // Said once, in the banner, and nowhere else: `config.js` emits no warning for a
  // blank issuer, because a replica serving public ESI reads and no tokens is a
  // complete configuration rather than a half-finished one.
  assert.match(run.stdout, /SSO off \(ESI_MOD_SSO_ISSUER is blank\)/);
  assert.doesNotMatch(run.stdout, /config warning: .*SSO/);
  assert.equal(run.stderr.trim(), "");
});

test("ESI off with SSO on starts the SSO listener only (D47)", async () => {
  const ssoPort = await reservePort();
  const child = tempDir("child");
  const main = writeGameChild(child, {
    probePaths: ["/.well-known/oauth-authorization-server/"],
  });

  const run = runLoader(modCopy(), {
    env: {
      ESI_MOD_ESI_PORT: "",
      ESI_MOD_SSO_PORT: String(ssoPort),
      ESI_MOD_SSO_ISSUER: `http://127.0.0.1:${ssoPort}`,
      ESI_MOD_SSO_STATE_DIR: tempDir("sso-state"),
    },
    script: main,
  });

  assert.equal(run.status, 0, `child did not exit cleanly:\n${run.output}`);
  assert.match(run.stdout, /ESI off \(ESI_MOD_ESI_PORT is blank\)/);
  assert.match(run.stdout, new RegExp(`SSO listener on http://127\\.0\\.0\\.1:${ssoPort}`));
  assert.doesNotMatch(run.stdout, /ESI listener on/);
  assert.match(run.stdout, /SSO \/\.well-known\/oauth-authorization-server\/ 200 /);
});

test("with an issuer the banner reports the SSO listener and the issuer in full", () => {
  const run = runLoader(modCopy(), {
    env: {
      ESI_MOD_ESI_PORT: "26005",
      ESI_MOD_SSO_PORT: "26006",
      ESI_MOD_SSO_ISSUER: "http://host.local:26006",
    },
  });

  assert.equal(run.status, 0);
  // In full, unlike the signing key path: it goes into every token this replica
  // signs and every client fetches it, so the one place an operator can check
  // what it resolved to has to show the bytes.
  assert.match(run.stdout, /SSO 127\.0\.0\.1:26006 issuing http:\/\/host\.local:26006/);
  // Still bound nothing: the listener starts from the readiness hook, never from
  // `install()`, which is what keeps the healthcheck process from binding the
  // port out from under the game process.
  assert.doesNotMatch(run.output, /SSO listener on/);
  assert.equal(run.stderr.trim(), "");
});

test("a bad issuer is a configuration error and no listener starts at all", () => {
  const run = runLoader(modCopy(), {
    env: { ESI_MOD_ESI_PORT: "26005", ESI_MOD_SSO_ISSUER: "host.local:26006" },
  });

  assert.equal(run.status, 0, "a config error must never take the game process down");
  assert.match(run.stdout, /not starting: 1 configuration problem/);
  assert.match(run.stdout, /ESI_MOD_SSO_ISSUER must be an absolute URL/);
  assert.equal(run.stderr.trim(), "");
});

test("the readiness hook brings both listeners up, and the child still exits", async () => {
  // The reserved ports are free when we ask and might not be a moment later.
  // Losing that race is not a loader failure, so retry it.
  let run = null;
  let esiPort = 0;
  let ssoPort = 0;

  // The override, not the derived location: there is no gameStore in this fake
  // tree to derive one from, and `test/runtimeAccess.test.js` owns that half
  // against a real vendor checkout.
  //
  // The directory, not the key path, which is the point of the knob. The SSO
  // surface loads three durable credentials at boot (the signing key (D8), the
  // owner salt and the refresh-token store (D30)), and only the key ever had a
  // path override. Naming a directory lets a boot with no game store configure
  // all three, which is the shape this test has and the shape a diagnostic boot
  // has.
  //
  // Outside the mod copy, which `config.js` insists on: all three secrets are
  // created here, and a redeploy replaces the mod directory wholesale (D21).
  //
  // Reused across the retries on purpose: a second attempt loads the key and the
  // salt the first one wrote, which exercises key persistence through the real
  // loader rather than through the module's own suite.
  const stateDir = tempDir("sso-state");
  const keyPath = path.join(stateDir, "signing-key.pem");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    esiPort = await reservePort();
    ssoPort = await reservePort();
    const child = tempDir("child");
    const main = writeGameChild(child, {
      probePaths: ["/.well-known/oauth-authorization-server/", "/oauth/jwks"],
    });

    run = runLoader(modCopy(), {
      env: {
        ESI_MOD_ESI_PORT: String(esiPort),
        ESI_MOD_SSO_PORT: String(ssoPort),
        ESI_MOD_SSO_ISSUER: `http://127.0.0.1:${ssoPort}`,
        ESI_MOD_SSO_STATE_DIR: stateDir,
      },
      script: main,
    });
    if (!run.output.includes("listener did not start")) break;
  }

  // Both listeners are `unref()`'d, so the child exits on its own. Without that
  // this spawn would sit until the 30 s timeout, and inside a game server it
  // would be a process that refuses to shut down.
  assert.equal(run.status, 0, `child did not exit cleanly:\n${run.output}`);

  assert.match(run.stdout, new RegExp(`ESI listener on http://127\\.0\\.0\\.1:${esiPort}`));
  assert.match(run.stdout, new RegExp(`SSO listener on http://127\\.0\\.0\\.1:${ssoPort}`));

  // The EVE client's spelling, with the trailing slash, answered from the SSO
  // port. That is the point of the wiring.
  const answer = run.stdout.match(
    /SSO \/\.well-known\/oauth-authorization-server\/ (\d+) (\{.*\})/,
  );
  assert.ok(answer, `expected a discovery response, got:\n${run.output}`);
  assert.equal(answer[1], "200");

  const document = JSON.parse(answer[2]);
  assert.equal(document.issuer, `http://127.0.0.1:${ssoPort}`);
  // What the EVE client reads out of this document, and the only member it reads:
  // built from the configured issuer, so it names this replica.
  assert.equal(document.token_endpoint, `http://127.0.0.1:${ssoPort}/v2/oauth/token`);

  // The other half of the wiring.
  // The discovery document advertises where the keys are; this is that URL
  // actually answering, on the same listener, with a key the loader created on its
  // way up. Two suites prove each half in isolation. Only this test catches the
  // two halves disagreeing about the path, or a signing key that never reached the
  // route table.
  assert.equal(document.jwks_uri, `http://127.0.0.1:${ssoPort}/oauth/jwks`);

  const published = run.stdout.match(/SSO \/oauth\/jwks (\d+) (\{.*\})/);
  assert.ok(published, `expected a JWKS response, got:\n${run.output}`);
  assert.equal(published[1], "200");

  const jwks = JSON.parse(published[2]);
  assert.equal(jwks.keys.length, 1, "one signing slot, D8 settled that");
  // The literal, not a thumbprint: third-party validators pin this exact string,
  // and it is the one value in the document a randomly generated `kid` would
  // break silently.
  assert.equal(jwks.keys[0].kid, "JWT-Signature-Key");
  assert.equal(jwks.keys[0].alg, "RS256");
  // The .NET-ism CCP emits, which some cached client fixtures compare against.
  assert.equal(jwks.SkipUnresolvedJsonWebKeys, true);

  // All three credentials were created where the directory said, and nothing
  // about the key reached the log. Checked against the whole of a real boot rather
  // than an injected logger.
  //
  // The salt is asserted beside the key because the loader refuses to bind the SSO
  // port without it: a listener that answered above is already proof it loaded,
  // and this says where. The refresh-token store is deliberately not in this list:
  // it is loaded, and it writes no file until a grant is recorded, so an absent
  // `refresh-tokens.jsonl` after a boot that issued nothing is the correct state
  // rather than a missing credential.
  assert.equal(fs.existsSync(keyPath), true);
  assert.equal(fs.existsSync(path.join(stateDir, "owner-salt.txt")), true);
  assert.doesNotMatch(run.output, /PRIVATE KEY/);

  assert.equal(run.stderr.trim(), "");
  // Both listeners really are gone with the process.
  assert.equal(await portIsFree(esiPort), true);
  assert.equal(await portIsFree(ssoPort), true);
});

/**
 * The smallest child that fires the readiness hook and then exits.
 *
 * `writeGameChild` above polls the SSO port, which is right when there is going
 * to be one. These two tests are about the boot that decides there will not be,
 * so polling a port that will never answer would spend two seconds proving
 * something the log already says.
 */
function writeReadinessChild(dir) {
  fs.writeFileSync(
    path.join(dir, "wormholeRuntimeState.js"),
    ['"use strict";', "module.exports = { mutateState() {} };", ""].join("\n"),
  );

  const main = path.join(dir, "main.js");
  fs.writeFileSync(main, ['"use strict";', 'require("./wormholeRuntimeState");', ""].join("\n"));
  return main;
}

test("two broken credentials are both reported, in one refusal", async () => {
  // All three are attempted rather than stopping at the first: the three files
  // share a directory, are created together and are lost together (a restored bad
  // backup, a half-copied volume), so "two of them are broken" is the normal shape
  // of this failure. Learning about them one game server restart at a time is
  // what `config.js` already refuses to do to an operator for configuration
  // problems.
  const esiPort = await reservePort();
  const ssoPort = await reservePort();

  const stateDir = tempDir("sso-state-broken");
  // Too short for `lib/ownerSalt.js`, which refuses rather than generating over
  // it: a new salt moves the `owner` claim for every character at once.
  fs.writeFileSync(path.join(stateDir, "owner-salt.txt"), "short\n");
  // Not JSON Lines, which `lib/refreshTokens.js` refuses for D30's reason:
  // starting empty logs every client out and destroys the damaged file, which is
  // the only recoverable state.
  fs.writeFileSync(path.join(stateDir, "refresh-tokens.jsonl"), "not a store\n");

  const child = tempDir("child");
  const run = runLoader(modCopy(), {
    env: {
      ESI_MOD_ESI_PORT: String(esiPort),
      ESI_MOD_SSO_PORT: String(ssoPort),
      ESI_MOD_SSO_ISSUER: `http://127.0.0.1:${ssoPort}`,
      ESI_MOD_SSO_STATE_DIR: stateDir,
    },
    script: writeReadinessChild(child),
  });

  assert.equal(run.status, 0, `child did not exit cleanly:\n${run.output}`);

  // One refusal, naming the surface and the remedy, and both failures inside it
  // rather than the first one only.
  assert.match(run.output, /SSO surface not started/);
  assert.match(run.output, /2 of the 3 durable SSO credentials could not be loaded/);
  assert.match(run.output, /owner salt:/);
  assert.match(run.output, /refresh token store:/);

  // The signing key was fine, so this boot created it, and the "back it up" line
  // it printed has already scrolled past two errors and is never printed again.
  // The refusal repeats it, because a secret nobody was told about is a secret
  // nobody backed up.
  assert.equal(fs.existsSync(path.join(stateDir, "signing-key.pem")), true);
  assert.match(run.output, /this boot created the signing key at/);

  // ESI is untouched and the mod is still loaded. A credential problem costs this
  // deployment its tokens, never its game server (design constraint 2).
  assert.match(run.stdout, new RegExp(`ESI listener on http://127\\.0\\.0\\.1:${esiPort}`));
  assert.doesNotMatch(run.output, /SSO listener on/);
  assert.equal(await portIsFree(ssoPort), true);
});

test("with no game store and no directory named, the refusal names the knob", async () => {
  // The three credential locations are derived from the game store, this fake
  // tree has none, and before `ESI_MOD_SSO_STATE_DIR` existed there was nothing
  // an operator could set to answer that. The refusal has to carry the way out,
  // or "the game store root could not be resolved" is a dead end in exactly the
  // environment that cannot resolve one.
  const esiPort = await reservePort();
  const ssoPort = await reservePort();
  const child = tempDir("child");

  const run = runLoader(modCopy(), {
    env: {
      ESI_MOD_ESI_PORT: String(esiPort),
      ESI_MOD_SSO_PORT: String(ssoPort),
      ESI_MOD_SSO_ISSUER: `http://127.0.0.1:${ssoPort}`,
      // Cleared explicitly, because this test's premise is "no game store to derive
      // from" and `runLoader` only strips `ESI_MOD_*`. On a developer machine with a
      // vendor tree, or any strict run (which sets it on purpose), the child would
      // inherit it, resolve a real store root, and start the SSO surface, and the
      // assertions below would fail for a reason unrelated to what they check. A test
      // whose result depends on whether the person running it has a checkout is not a
      // test, and this one passed locally and failed under `ESI_MOD_REQUIRE_VENDOR`.
      EVEJS_REPO_ROOT: "",
      EVEJS_GAMESTORE_DATA_DIR: "",
    },
    script: writeReadinessChild(child),
  });

  assert.equal(run.status, 0, `child did not exit cleanly:\n${run.output}`);
  assert.match(run.output, /SSO surface not started/);
  assert.match(run.output, /ESI_MOD_SSO_STATE_DIR/);
  assert.match(run.stdout, new RegExp(`ESI listener on http://127\\.0\\.0\\.1:${esiPort}`));
  assert.doesNotMatch(run.output, /SSO listener on/);
});

test("a route that throws is a 500 from server.js, not a dead game server", async (t) => {
  // Every listener in this mod has to have this property, checked on the second
  // one: eve.js's ProcessLifecycle treats an unhandled rejection as fatal.
  const handle = await serveSso(
    t,
    createSsoDispatch([
      {
        name: "Broken",
        paths: ["/boom"],
        handle() {
          throw new Error("route bug");
        },
      },
    ]),
  );

  assert.equal(statusOf(await get(handle.port, "/boom")), 500);
  // The listener is still up afterwards.
  assert.equal(statusOf(await get(handle.port, "/nope")), 404);
});

test("dev auto-approve completes a whole OAuth authorize headlessly", async () => {
  // With auto-approve enabled, a full OAuth flow completes headlessly in a test.
  // This is the only test that proves the wiring rather than the parts. Every unit
  // suite below this one drives its module with doubles; this boots the real
  // loader and asks the real listener, so it catches a route mounted with the
  // wrong dependency, a config field spelled differently at either end, or a
  // registry that refuses the redirect the page was going to use.
  //
  // The redirect URI is loopback with an ephemeral port and is deliberately not in
  // any allowlist: that is the rule the client-registration decision turns on, and
  // a native tool binding a random port is the case it exists for. If this ever
  // needs an allowlist entry to pass, the rule broke.
  const redirectUri = "http://127.0.0.1:53817/callback";
  const state = "opaque state/with+chars&=";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  const query = [
    "response_type=code",
    "client_id=1a2b3c4d5e6f",
    `redirect_uri=${encodeURIComponent(redirectUri)}`,
    "scope=publicData%20esi-characters.read_bookmarks.v1",
    `state=${encodeURIComponent(state)}`,
    `code_challenge=${challenge}`,
    "code_challenge_method=S256",
  ].join("&");

  let run = null;
  let ssoPort = 0;

  // One directory for all three durable credentials, reused across the retries.
  // See the discovery test above on why this is the directory knob and not the key
  // path: there is no game store in the fake tree to derive from, and the loader
  // refuses to bind the SSO port unless the salt and the store resolve too.
  const stateDir = tempDir("sso-state");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const esiPort = await reservePort();
    ssoPort = await reservePort();
    const child = tempDir("child");
    const main = writeGameChild(child, { probePaths: [`/v2/oauth/authorize?${query}`] });

    run = runLoader(modCopy(), {
      env: {
        ESI_MOD_ESI_PORT: String(esiPort),
        ESI_MOD_SSO_PORT: String(ssoPort),
        ESI_MOD_SSO_ISSUER: `http://127.0.0.1:${ssoPort}`,
        ESI_MOD_SSO_STATE_DIR: stateDir,
        ESI_MOD_DEV_AUTO_APPROVE: "true",
        ESI_MOD_DEV_AUTO_APPROVE_CHARACTER_ID: "90000001",
      },
      script: main,
    });
    if (!run.output.includes("listener did not start")) break;
  }

  assert.equal(run.status, 0, `child did not exit cleanly:\n${run.output}`);

  // Loud at startup, on its own line, and saying what it means rather than that a
  // flag is set.
  assert.match(run.stdout, /ANY CALLER CAN OBTAIN A TOKEN FOR CHARACTER 90000001/);

  const answer = run.stdout.match(/SSO \/v2\/oauth\/authorize\?\S* (\d+) (\S+)/);
  assert.ok(answer, `expected an authorize response, got:\n${run.output}`);

  // A redirect, not a page: with auto-approve on there is no human step to
  // render, and the third-party app's callback is where this has to land.
  assert.equal(answer[1], "302");

  const location = new URL(answer[2]);
  assert.equal(`${location.origin}${location.pathname}`, redirectUri);

  // Verbatim, which is the point of `state`: it is the client's CSRF token and it
  // comes back through a URL encoder untouched.
  assert.equal(location.searchParams.get("state"), state);
  assert.equal(location.searchParams.get("error"), null);

  const code = location.searchParams.get("code");
  assert.equal(typeof code, "string");
  assert.notEqual(code, "");

  // Nothing about the grant may ride along in the URL the browser is handed: not
  // the character it was bound to, not the challenge the token endpoint will
  // verify.
  assert.equal(location.searchParams.get("characterId"), null);
  assert.equal(location.searchParams.get("code_challenge"), null);

  // The two secrets this flow handles are absent from a whole real boot's
  // logging: the authorization code, and any private key material.
  //
  // Scoped to the mod's own lines rather than the whole output, and that is the
  // assertion rather than a technicality: the probe above prints the `Location`
  // header, which is the redirect and so necessarily contains the code, and an
  // unscoped check cannot tell this mod logging a secret apart from this test
  // printing one.
  const modLines = run.output
    .split("\n")
    .filter((line) => line.startsWith("[EsiApiMod]"))
    .join("\n");

  assert.notEqual(modLines, "", "no mod log lines to check: the scoping is vacuous");
  assert.equal(modLines.includes(code), false, "the authorization code reached the mod's log");
  assert.doesNotMatch(run.output, /PRIVATE KEY/);

  // The other two durable secrets, same check.
  // The salt is the one this boot actually creates, so its bytes are the assertion
  // rather than a pattern: it is raw secret material sitting in a file, and a
  // `cat` of that file is the exact string that must not appear in anything the
  // mod printed.
  const salt = fs.readFileSync(path.join(stateDir, "owner-salt.txt"), "utf8").trim();
  assert.notEqual(salt, "");
  assert.equal(modLines.includes(salt), false, "the owner salt reached the mod's log");

  // The surrogate did arrive, which stops the check above from passing for the
  // wrong reason. `lib/ownerSalt.js` logs a truncated SHA-256 of the salt so an
  // operator comparing two deployments has something to compare, and a boot that
  // logged nothing about the salt would satisfy the assertion above while losing
  // that.
  assert.match(modLines, /owner salt generated at .*fingerprint [A-Za-z0-9_-]{16}/);
  // A new salt is a new secret, and it is announced exactly once, on this boot,
  // because every later boot says "loaded from" instead.
  assert.match(modLines, /back it up/);

  // The refresh-token store is loaded at boot too, and there is no token in it to
  // leak: no grant exists until the token endpoint answers, and D30 keeps the
  // token itself out of the file even then (records are keyed by an unkeyed
  // SHA-256 and the token is written nowhere). So a boot that issued nothing can
  // prove that the store announced itself by path and said it was empty, and put
  // nothing token-shaped on the line.
  assert.match(modLines, /refresh token store .* does not exist yet; starting empty/);
  assert.equal(
    fs.existsSync(path.join(stateDir, "refresh-tokens.jsonl")),
    false,
    "a store that issued nothing should not have written a file",
  );

  assert.equal(run.stderr.trim(), "");
});
