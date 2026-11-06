/**
 * The configuration layers (D47): defaults, settings.json, .env.txt, .env, real
 * environment. Every case runs against a temp directory and an injected env.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULTS,
  RESERVED_GAME_PORTS,
  loadConfig,
  loopbackListenersInContainer,
  parseConfigFromEnv,
  parseSettingsFile,
  readSettingsFile,
} = require("../config");
const { REPO_ROOT, vendorOnly } = require("./vendorTree");

const ESI_PORT = "ESI_MOD_ESI_PORT";
const SSO_ISSUER = "ESI_MOD_SSO_ISSUER";
const SSO_PORT = "ESI_MOD_SSO_PORT";
const LOG_LEVEL = "ESI_MOD_LOG_LEVEL";
const STATE_DIR = "ESI_MOD_SSO_STATE_DIR";
const KEY_PATH = "ESI_MOD_SIGNING_KEY_PATH";

function withDir(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esi-mod-layers-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      fs.writeFileSync(
        path.join(dir, name),
        typeof text === "string" ? text : JSON.stringify(text),
      );
    }
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Merge order

test("each layer outranks the one below it, per key", () => {
  const settings = { esiPort: 26101, errorLimitMaxErrors: 201, ssoPort: 26201, logLevel: "error" };
  const envTxt = `${ESI_PORT}=26102\nESI_MOD_ERROR_LIMIT_MAX_ERRORS=202\nESI_MOD_SSO_PORT=26202\n`;
  const envFile = `${ESI_PORT}=26103\nESI_MOD_ERROR_LIMIT_MAX_ERRORS=203\n`;

  withDir({ "settings.json": settings, ".env.txt": envTxt, ".env": envFile }, (dir) => {
    const { config } = loadConfig({ dir, env: { [ESI_PORT]: "26104" } });
    assert.equal(config.esiPort, 26104, "the environment beats .env");
    assert.equal(config.errorLimitMaxErrors, 203, ".env beats .env.txt");
    assert.equal(config.ssoPort, 26202, ".env.txt beats settings.json");
    assert.equal(config.logLevel, "error", "settings.json beats the default");
    assert.equal(config.esiBindHost, DEFAULTS.esiBindHost, "nothing set falls to the default");
  });
});

// Absent versus blank

const BLANK_LAYERS = {
  "settings.json": (settingsKey) => [{ "settings.json": { [settingsKey]: "" } }, {}],
  ".env.txt": (_key, envKey) => [{ ".env.txt": `${envKey}=\n` }, {}],
  ".env": (_key, envKey) => [{ ".env": `${envKey}=\n` }, {}],
  environment: (_key, envKey) => [{}, { [envKey]: "" }],
};

for (const [layer, build] of Object.entries(BLANK_LAYERS)) {
  test(`a blank issuer in ${layer} turns SSO off, and ESI carries on`, () => {
    const [files, env] = build("ssoIssuer", SSO_ISSUER);
    withDir(files, (dir) => {
      const result = loadConfig({ dir, env });
      assert.equal(result.ok, true);
      assert.equal(result.config.ssoIssuer, null);
      assert.equal(result.config.esiPort, DEFAULTS.esiPort);
    });
  });

  test(`a blank ESI port in ${layer} turns ESI off, and SSO carries on`, () => {
    const [files, env] = build("esiPort", ESI_PORT);
    withDir(files, (dir) => {
      const result = loadConfig({ dir, env });
      assert.equal(result.ok, true);
      assert.equal(result.config.esiPort, null);
      assert.equal(result.config.ssoIssuer, DEFAULTS.ssoIssuer);
    });
  });
}

test("absence at every layer means the default, not off", () => {
  withDir({ "settings.json": {}, ".env.txt": "# nothing\n" }, (dir) => {
    const result = loadConfig({ dir, env: {} });
    assert.equal(result.config.esiPort, DEFAULTS.esiPort);
    assert.equal(result.config.ssoIssuer, DEFAULTS.ssoIssuer);
  });
});

test("a blank higher layer outranks a value in a lower one", () => {
  const files = { "settings.json": { ssoIssuer: "http://other.test:26006" }, ".env.txt": `${SSO_ISSUER}=\n` };
  withDir(files, (dir) => {
    assert.equal(loadConfig({ dir, env: {} }).config.ssoIssuer, null);
  });
});

test("both switches blank is not ok and not an error: it is dormant", () => {
  const result = parseConfigFromEnv({ [ESI_PORT]: "", [SSO_ISSUER]: "" });
  assert.equal(result.ok, false);
  assert.deepEqual([...result.errors], []);
  assert.deepEqual([...result.warnings], []);
});

test("ESI off cannot collide with the SSO port", () => {
  const result = parseConfigFromEnv({
    [ESI_PORT]: "",
    ESI_MOD_SSO_PORT: "26005",
    [SSO_ISSUER]: "http://localhost:26005",
  });
  assert.equal(result.ok, true);
  assert.deepEqual([...result.warnings], []);
});

test("the default ESI port still collides with an SSO port set to match it", () => {
  const result = parseConfigFromEnv({ ESI_MOD_SSO_PORT: "26005" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /cannot share a port/);
});

// esiPort: 0

test("esiPort 0 in settings.json means off, because a launcher integer cannot be blank", () => {
  withDir({ "settings.json": { esiPort: 0 } }, (dir) => {
    const result = loadConfig({ dir, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.config.esiPort, null);
    assert.deepEqual([...result.errors], []);
  });
});

test("0 stays an error everywhere but the form's own field", () => {
  for (const files of [{ ".env": `${ESI_PORT}=0\n` }, { ".env.txt": `${ESI_PORT}=0\n` }]) {
    withDir(files, (dir) => {
      const result = loadConfig({ dir, env: {} });
      assert.equal(result.ok, false);
      assert.match(result.errors.join("\n"), /between 1 and 65535/);
    });
  }

  withDir({}, (dir) => {
    assert.equal(loadConfig({ dir, env: { [ESI_PORT]: "0" } }).ok, false);
  });

  withDir({ "settings.json": { ssoPort: 0 } }, (dir) => {
    const result = loadConfig({ dir, env: {} });
    assert.equal(result.ok, false, "ssoPort has no off value");
    assert.match(result.errors.join("\n"), /ESI_MOD_SSO_PORT must be between/);
  });
});

// The allowlist

test("settings.json can never arm dev auto-approve or move a credential path", () => {
  const hostile = {
    devAutoApprove: true,
    devAutoApproveCharacterID: 90000001,
    ssoStateDir: path.join(os.tmpdir(), "elsewhere"),
    signingKeyPath: path.join(os.tmpdir(), "elsewhere.pem"),
    ESI_MOD_DEV_AUTO_APPROVE: "1",
    ESI_MOD_DEV_AUTO_APPROVE_CHARACTER_ID: "90000001",
    ESI_MOD_SSO_STATE_DIR: path.join(os.tmpdir(), "elsewhere"),
  };

  withDir({ "settings.json": hostile }, (dir) => {
    const result = loadConfig({ dir, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.config.devAutoApprove, false);
    assert.equal(result.config.devAutoApproveCharacterID, null);
    assert.equal(result.config.ssoStateDir, null);
    assert.equal(result.config.signingKeyPath, null);

    const warnings = result.warnings.join("\n");
    for (const key of Object.keys(hostile)) assert.match(warnings, new RegExp(`"${key}"`));
    assert.doesNotMatch(warnings, /90000001/, "a value is never echoed");
  });
});

test("keys that exist on Object.prototype are not settings", () => {
  const parsed = parseSettingsFile('{"__proto__":{"esiPort":1},"constructor":"x","toString":"y"}');
  assert.deepEqual(Object.keys(parsed.values), []);
  assert.equal(parsed.warnings.length, 3);
  assert.equal({}.esiPort, undefined);
});

// Bad files

test("malformed settings.json warns and the mod carries on", () => {
  for (const text of ["{not json", "[1,2]", "null", "42", ""]) {
    const parsed = parseSettingsFile(text);
    assert.deepEqual(Object.keys(parsed.values), [], `for ${text}`);
    assert.equal(parsed.warnings.length, 1, `for ${text}`);
    assert.match(parsed.warnings[0], /settings\.json/);
  }

  withDir({ "settings.json": "{not json" }, (dir) => {
    const result = loadConfig({ dir, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.config.esiPort, DEFAULTS.esiPort);
    assert.match(result.warnings.join("\n"), /settings\.json/);
  });
});

test("a non-scalar value warns and is ignored; a number becomes a string", () => {
  const parsed = parseSettingsFile(JSON.stringify({
    esiPort: 26105,
    ssoPort: [26106],
    logLevel: { level: "debug" },
    esiBindHost: true,
    ssoBindHost: null,
  }));

  assert.deepEqual({ ...parsed.values }, { ESI_MOD_ESI_PORT: "26105" });
  assert.equal(parsed.warnings.length, 4);
});

test("a byte order mark does not make settings.json malformed", () => {
  const parsed = parseSettingsFile('﻿{"logLevel":"debug"}');
  assert.deepEqual([...parsed.warnings], []);
  assert.equal(parsed.values[LOG_LEVEL], "debug");
});

test("an absent settings.json is silent; an unreadable one warns; neither throws", () => {
  withDir({}, (dir) => {
    assert.deepEqual([...readSettingsFile(path.join(dir, "settings.json")).warnings], []);

    fs.mkdirSync(path.join(dir, "settings.json"));
    const read = readSettingsFile(path.join(dir, "settings.json"));
    assert.equal(read.warnings.length, 1);
    assert.match(read.warnings[0], /could not be read/);
    assert.doesNotThrow(() => loadConfig({ dir, env: {} }));
  });
});

// Warnings about files

test("plain .env warns once that it does not survive an update; .env.txt does not", () => {
  withDir({ ".env": `${LOG_LEVEL}=debug\n` }, (dir) => {
    const warnings = loadConfig({ dir, env: {} }).warnings.filter((w) => /launcher update/.test(w));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /rename it to \.env\.txt/);
  });

  withDir({ ".env.txt": `${LOG_LEVEL}=debug\n` }, (dir) => {
    assert.doesNotMatch(loadConfig({ dir, env: {} }).warnings.join("\n"), /launcher update/);
  });
});

test("a problem in a file is reported under that file's own name", () => {
  withDir({ ".env.txt": "junk\n" }, (dir) => {
    assert.match(loadConfig({ dir, env: {} }).warnings.join("\n"), /\.env\.txt line 1: expected KEY=VALUE/);
  });
});

test("a credential path set in a file warns and names the file, but not the path", () => {
  const stateDir = path.join(os.tmpdir(), "esi-private-state");
  const keyPath = path.join(os.tmpdir(), "esi-private.pem");

  withDir({ ".env.txt": `${STATE_DIR}=${stateDir}\n`, ".env": `${KEY_PATH}=${keyPath}\n` }, (dir) => {
    const warnings = loadConfig({ dir, env: {} }).warnings.join("\n");
    assert.match(warnings, new RegExp(`\\.env\\.txt sets ${STATE_DIR}`));
    assert.match(warnings, new RegExp(`\\.env sets ${KEY_PATH}`));
    assert.doesNotMatch(warnings, /esi-private/);
  });

  // From the real environment there is no file to lose.
  withDir({}, (dir) => {
    assert.deepEqual([...loadConfig({ dir, env: { [STATE_DIR]: stateDir } }).warnings], []);
  });
});

// Overrides

test("one line per form key overridden by a higher layer, naming the winner, never the value", () => {
  withDir(
    {
      "settings.json": { logLevel: "error", ssoPort: 26106 },
      ".env.txt": `${LOG_LEVEL}=debug\nESI_MOD_ESI_BIND_HOST=127.0.0.2\n`,
      ".env": `${LOG_LEVEL}=warn\n`,
    },
    (dir) => {
      const result = loadConfig({ dir, env: { ESI_MOD_SSO_BIND_HOST: "127.0.0.3" } });
      const lines = [...result.notices];

      assert.deepEqual(lines.sort(), [
        "esiBindHost in the launcher form is overridden by ESI_MOD_ESI_BIND_HOST from .env.txt.",
        "logLevel in the launcher form is overridden by ESI_MOD_LOG_LEVEL from .env.",
        "ssoBindHost in the launcher form is overridden by ESI_MOD_SSO_BIND_HOST from the environment.",
      ]);
    },
  );
});

// Purity

test("loading every layer leaves the process environment alone", () => {
  const files = {
    "settings.json": { logLevel: "debug" },
    ".env.txt": "ESI_MOD_CANARY_A=1\n",
    ".env": "ESI_MOD_CANARY_B=1\n",
  };
  withDir(files, (dir) => {
    const before = JSON.stringify(process.env);
    loadConfig({ dir, env: {} });
    assert.equal(JSON.stringify(process.env), before);
  });
});

// The container hint

test("loopbackListenersInContainer names only armed listeners bound to loopback", () => {
  const names = (env) => [...loopbackListenersInContainer(parseConfigFromEnv(env).config)];

  assert.deepEqual(names({}), ["ESI_MOD_ESI_BIND_HOST", "ESI_MOD_SSO_BIND_HOST"]);
  assert.deepEqual(names({ ESI_MOD_ESI_BIND_HOST: "0.0.0.0" }), ["ESI_MOD_SSO_BIND_HOST"]);
  assert.deepEqual(names({ [SSO_ISSUER]: "" }), ["ESI_MOD_ESI_BIND_HOST"]);
  assert.deepEqual(names({ [ESI_PORT]: "", [SSO_ISSUER]: "" }), []);
  assert.deepEqual(
    names({ ESI_MOD_ESI_BIND_HOST: "0.0.0.0", ESI_MOD_SSO_BIND_HOST: "0.0.0.0" }),
    [],
  );
});

// Ports eve.js uses

// Written out rather than imported, so an edit to the list in config.js has to
// be made twice. The vendor-drift test below reads the same facts from a tree.
const GAME_PORTS = [443, 5222, 26000, 26001, 26002, 26003, 26400, 40110, 40111];

test("every port eve.js uses is a config error on either key, naming the key and why", () => {
  for (const port of GAME_PORTS) {
    for (const key of [ESI_PORT, SSO_PORT]) {
      const result = parseConfigFromEnv({ [key]: String(port) });
      assert.equal(result.ok, false, `${key}=${port} must leave the mod inert`);
      const message = result.errors.find((text) => text.startsWith(key));
      assert.ok(message, `an error must name ${key}, got: ${result.errors.join(" | ")}`);
      assert.match(message, new RegExp(`\\b${port}\\b`));
      assert.match(message, /eve\.js/);
      assert.match(message, /EADDRINUSE/);
    }
  }
});

test("a game port on the SSO key is refused even with no issuer, like every other SSO setting", () => {
  const result = parseConfigFromEnv({ [SSO_PORT]: "26000", [SSO_ISSUER]: "" });
  assert.equal(result.ok, false);
});

test("a game port is refused from every layer, and config.js does not throw", () => {
  const cases = [
    [{ "settings.json": { esiPort: 26000 } }, {}, ESI_PORT],
    [{ "settings.json": { ssoPort: 26001 } }, {}, SSO_PORT],
    [{ ".env.txt": `${ESI_PORT}=26002\n` }, {}, ESI_PORT],
    [{ ".env": `${SSO_PORT}=26400\n` }, {}, SSO_PORT],
    [{}, { [ESI_PORT]: "5222" }, ESI_PORT],
  ];

  for (const [files, env, key] of cases) {
    withDir(files, (dir) => {
      const result = loadConfig({ dir, env });
      assert.equal(result.ok, false, `${JSON.stringify(files)} ${JSON.stringify(env)}`);
      assert.match(result.errors.join("\n"), new RegExp(key));
    });
  }
});

test("a higher layer can correct a game port set in a lower one", () => {
  withDir({ "settings.json": { esiPort: 26000 } }, (dir) => {
    const result = loadConfig({ dir, env: { [ESI_PORT]: "26105" } });
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(result.config.esiPort, 26105);
  });
});

test("the mod's own defaults, and the ports beside the game's, are not refused", () => {
  assert.equal(GAME_PORTS.includes(DEFAULTS.esiPort), false);
  assert.equal(GAME_PORTS.includes(DEFAULTS.ssoPort), false);
  assert.equal(parseConfigFromEnv({}).ok, true);
  for (const port of [442, 444, 26004, 26399, 26401, 40109, 40112]) {
    const result = parseConfigFromEnv({ [ESI_PORT]: String(port) });
    assert.equal(result.ok, true, `${port}: ${result.errors.join("\n")}`);
  }
});

test("the reserved list equals this test's, and covers every port the vendor tree declares", vendorOnly, () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
  const exposed = dockerfile.match(/^EXPOSE\s+(.+)$/m);
  assert.ok(exposed, "the Dockerfile no longer has an EXPOSE line");
  const declared = exposed[1].trim().split(/\s+/).map(Number);

  // Host-side and container-side numbers of every publication, literal or defaulted.
  const compose = fs.readFileSync(path.join(REPO_ROOT, "compose.yaml"), "utf8");
  for (const line of compose.matchAll(/^\s*-\s*"127\.0\.0\.1:(.+)"\s*$/gm)) {
    for (const part of line[1].split(/:(?![^{]*\})/)) {
      const defaulted = part.match(/:-(\d+)\}/);
      declared.push(Number(defaulted ? defaulted[1] : part));
    }
  }

  assert.ok(declared.includes(26000), "the parse found none of the expected ports");
  for (const port of declared) {
    assert.equal(RESERVED_GAME_PORTS.has(port), true, `eve.js declares ${port}: reserve it`);
  }
});

test("the reserved list in config.js is the list written out above", () => {
  assert.deepEqual([...RESERVED_GAME_PORTS.keys()].sort((a, b) => a - b), GAME_PORTS);
});

// The clients file

test("a clients file inside the mod folder warns, because a launcher update loses it", () => {
  const inside = path.join(path.resolve(__dirname, ".."), "sso-clients.json");
  const result = parseConfigFromEnv({ ESI_MOD_SSO_CLIENTS_PATH: inside });
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /ESI_MOD_SSO_CLIENTS_PATH points inside the mod directory/);
  assert.match(result.warnings.join("\n"), /launcher update/);
  assert.equal(result.warnings.join("\n").includes(inside), false, "a warning does not echo the path");
});

test("a clients file outside the mod folder does not warn", () => {
  const outside = path.join(path.resolve(__dirname, "..", ".."), "sso-clients.json");
  const result = parseConfigFromEnv({ ESI_MOD_SSO_CLIENTS_PATH: outside });
  assert.equal(result.warnings.join("\n").includes("ESI_MOD_SSO_CLIENTS_PATH"), false);
});

// The SSO port against the issuer

test("an SSO port that differs from the issuer's warns and still runs, because a port mapping can make it right", () => {
  const result = parseConfigFromEnv({ [SSO_PORT]: "26106", [SSO_ISSUER]: "http://host.local:26006" });
  assert.equal(result.ok, true, result.errors.join("\n"));
  const warning = result.warnings.join("\n");
  assert.match(warning, /ESI_MOD_SSO_PORT is 26106/);
  assert.match(warning, /ESI_MOD_SSO_ISSUER names port 26006/);
  assert.match(warning, /port mapping/);
});

test("an issuer with no port is measured by its scheme's default", () => {
  const https = parseConfigFromEnv({ [SSO_ISSUER]: "https://login.host.local" });
  assert.match(https.warnings.join("\n"), /ESI_MOD_SSO_ISSUER names port 443/);
  const http = parseConfigFromEnv({ [SSO_ISSUER]: "http://login.host.local" });
  assert.match(http.warnings.join("\n"), /ESI_MOD_SSO_ISSUER names port 80/);
});

test("no mismatch warning when the ports agree, or with no issuer to disagree with", () => {
  for (const env of [
    {},
    { [SSO_PORT]: "26106", [SSO_ISSUER]: "http://host.local:26106" },
    { [SSO_PORT]: "26106", [SSO_ISSUER]: "" },
  ]) {
    const result = parseConfigFromEnv(env);
    assert.equal(result.warnings.join("\n").includes("names port"), false, JSON.stringify(env));
  }
});
