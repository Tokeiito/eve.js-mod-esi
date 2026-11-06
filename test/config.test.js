/**
 * ESI/SSO replica mod: config tests.
 *
 * Run with: node --test "test/**\/*.test.js"   (from the mod directory, or RunTests.bat)
 *
 * Four layers, kept separate:
 *
 *   parseConfigFromEnv(env)  pure. every case builds its own env-like object.
 *   parseEnvFile(text)       pure. text in, values out. no filesystem.
 *   readEnvFile(path)        filesystem only, against a temp directory.
 *   loadConfig(options)      the merge. `dir` and `env` are both injected, so
 *                            nothing reads or writes the real environment and
 *                            nothing writes into the mod directory (a .env
 *                            dropped beside loader.js could destroy a real one).
 *
 * Nothing in this file needs an eve.js checkout, a game server or a port.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULTS,
  ENV_FILE_NAME,
  ENV_FILE_PATH,
  ENV_KEYS,
  MOD_VERSION,
  describeConfig,
  loadConfig,
  parseClientsFile,
  parseConfigFromEnv,
  parseEnvFile,
  readEnvFile,
} = require("../config");

// The default this file pins `DEFAULTS.errorLimitMaxErrors` against.
// `config.js` does not import `lib/errorLimiter.js` (D44), so it stays
// requirable with nothing but `node:fs` and `node:path`. The two constants are
// two copies of one number and this test keeps them from drifting, as
// `test/errorLimiter.test.js` does for `OVER_LIMIT_BODY` against
// `contract/wire.js`.
const { MAX_ERRORS } = require("../lib/errorLimiter");

// The env keys are spelled out rather than imported: they are the deployment
// contract, and importing them would follow a rename that silently breaks
// every existing .env.
const ESI_PORT = "ESI_MOD_ESI_PORT";
const ESI_BIND_HOST = "ESI_MOD_ESI_BIND_HOST";
const SSO_PORT = "ESI_MOD_SSO_PORT";
const SSO_BIND_HOST = "ESI_MOD_SSO_BIND_HOST";
const SSO_ISSUER = "ESI_MOD_SSO_ISSUER";
const SSO_CLIENTS_PATH = "ESI_MOD_SSO_CLIENTS_PATH";
const SSO_STATE_DIR = "ESI_MOD_SSO_STATE_DIR";
const DEV_AUTO_APPROVE = "ESI_MOD_DEV_AUTO_APPROVE";
const DEV_CHARACTER_ID = "ESI_MOD_DEV_AUTO_APPROVE_CHARACTER_ID";
const SIGNING_KEY_PATH = "ESI_MOD_SIGNING_KEY_PATH";
const ERROR_LIMIT_MAX_ERRORS = "ESI_MOD_ERROR_LIMIT_MAX_ERRORS";
const LOG_LEVEL = "ESI_MOD_LOG_LEVEL";

// The mod directory, found through the module system rather than assumed to be
// `..`, so this works from a deployed copy.
const MOD_DIR = path.dirname(require.resolve("../config"));

// An absolute path that exists on both platforms, for the signing key. Nothing
// reads it: the parser validates shape, not existence.
const ABSOLUTE_KEY_PATH = path.join(os.tmpdir(), "esi-sso-signing.pem");

// The same, for the directory the three durable credentials live in.
const ABSOLUTE_STATE_DIR = path.join(os.tmpdir(), "esi-sso-state");

// The ESI listener alone: the issuer is blanked so that a case about ESI does
// not also arm the SSO default (D47). A case about the issuer overrides it.
function envWith(overrides = {}) {
  return { [ESI_PORT]: "26005", [SSO_ISSUER]: "", ...overrides };
}

// Both switches blank, which is the one configuration that binds nothing.
const BOTH_OFF = Object.freeze({ [ESI_PORT]: "", [SSO_ISSUER]: "" });

// A throwaway directory per call. Nothing here ever writes to the mod dir.
function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esi-mod-config-"));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeEnvFile(dir, text) {
  fs.writeFileSync(path.join(dir, ENV_FILE_NAME), text);
  return dir;
}

// The inert state

test("an empty env arms both listeners on their defaults, silently (D47)", () => {
  const result = parseConfigFromEnv({});

  assert.equal(result.ok, true);
  assert.deepEqual([...result.errors], []);
  assert.deepEqual([...result.warnings], []);
  assert.equal(result.config.esiPort, 26005);
  assert.equal(result.config.ssoIssuer, "http://localhost:26006");
});

test("the dormant config still has every field, so consumers need no null checks", () => {
  const { config } = parseConfigFromEnv(BOTH_OFF);
  assert.deepEqual(Object.keys(config).sort(), [
    "devAutoApprove",
    "devAutoApproveCharacterID",
    "errorLimitMaxErrors",
    "esiBindHost",
    "esiPort",
    "logLevel",
    "modVersion",
    "signingKeyPath",
    "ssoBindHost",
    "ssoClients",
    "ssoClientsPath",
    "ssoIssuer",
    "ssoPort",
    "ssoStateDir",
  ]);
});

test("a null or non-object env is treated as empty instead of throwing", () => {
  for (const env of [null, undefined, 42, "ESI_MOD_ESI_PORT=26105"]) {
    let result;
    assert.doesNotThrow(() => {
      result = parseConfigFromEnv(env);
    }, `env ${String(env)} should not throw`);
    assert.equal(result.config.esiPort, DEFAULTS.esiPort, `env ${String(env)} carries no value`);
  }
});

test("inherited properties are ignored: env values must be own properties", () => {
  const inherited = Object.create({ [ESI_PORT]: "26105" });
  const result = parseConfigFromEnv(inherited);
  assert.equal(result.config.esiPort, DEFAULTS.esiPort);
});

// The enabled state

test("the ESI port alone enables the mod, and everything else defaults", () => {
  const result = parseConfigFromEnv(envWith());

  assert.equal(result.ok, true);
  assert.deepEqual([...result.errors], []);
  assert.deepEqual([...result.warnings], []);
  assert.equal(result.config.esiPort, 26005);
  assert.equal(result.config.esiBindHost, DEFAULTS.esiBindHost);
  assert.equal(result.config.esiBindHost, "127.0.0.1");
  assert.equal(result.config.ssoPort, DEFAULTS.ssoPort);
  assert.equal(result.config.ssoPort, 26006);
  assert.equal(result.config.ssoBindHost, "127.0.0.1");
  assert.equal(result.config.devAutoApprove, false);
  assert.equal(result.config.devAutoApproveCharacterID, null);
  assert.equal(result.config.signingKeyPath, null);
  assert.equal(result.config.errorLimitMaxErrors, 100);
  assert.equal(result.config.logLevel, "info");
});

test("the config carries the hand-maintained mod version", () => {
  const { config } = parseConfigFromEnv(envWith());
  assert.equal(config.modVersion, MOD_VERSION);
  assert.match(MOD_VERSION, /^\d+\.\d+\.\d+$/);
});

test("the result and everything in it is frozen, so callers cannot mutate shared state", () => {
  const result = parseConfigFromEnv(envWith());

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.config), true);
  assert.equal(Object.isFrozen(result.warnings), true);
  assert.equal(Object.isFrozen(result.errors), true);
  assert.throws(() => {
    result.config.esiPort = 1;
  });
});

test("DEFAULTS is frozen and gives the ESI port D1's number (D47)", () => {
  assert.equal(Object.isFrozen(DEFAULTS), true);
  assert.equal(DEFAULTS.esiPort, 26005);
});

// Ports

test("a malformed ESI port is an error, not a silent truncation", () => {
  for (const raw of ["abc", "26005.5", "0x1f", "1e4", "260a5", "-1", "+80"]) {
    const result = parseConfigFromEnv({ [ESI_PORT]: raw });
    assert.equal(result.ok, false, `port "${raw}" should be rejected`);
    assert.match(result.errors.join("\n"), /must be a whole number/);
    assert.equal(result.config.esiPort, null);
  }
});

test("an out-of-range port is rejected", () => {
  for (const raw of ["0", "65536", "99999"]) {
    const result = parseConfigFromEnv({ [ESI_PORT]: raw });
    assert.equal(result.ok, false, `port "${raw}" should be rejected`);
    assert.match(result.errors.join("\n"), /between 1 and 65535/);
  }
});

test("the range boundaries are accepted", () => {
  for (const raw of ["1", "65535"]) {
    const result = parseConfigFromEnv({ [ESI_PORT]: raw });
    assert.equal(result.ok, true, `port "${raw}" should be accepted`);
    assert.equal(result.config.esiPort, Number(raw));
  }
});

test("a numeric env value works as well as a string", () => {
  const result = parseConfigFromEnv({ [ESI_PORT]: 26005 });
  assert.equal(result.ok, true);
  assert.equal(result.config.esiPort, 26005);
});

test("a whitespace-only ESI port means off, with no warning and no error", () => {
  const result = parseConfigFromEnv(envWith({ [ESI_PORT]: "   " }));
  assert.equal(result.ok, false);
  assert.equal(result.config.esiPort, null);
  assert.deepEqual([...result.errors], []);
  assert.deepEqual([...result.warnings], []);
});

test("the SSO port is validated even though nothing consumes it until Phase 3", () => {
  const result = parseConfigFromEnv(envWith({ [SSO_PORT]: "not-a-port" }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /ESI_MOD_SSO_PORT must be a whole number/);
  // Still reports a usable value, so a caller reading the field mid-failure
  // never sees undefined.
  assert.equal(result.config.ssoPort, DEFAULTS.ssoPort);
});

test("an unset SSO port does not nag: the SSO listener is not this deployment's concern yet", () => {
  const result = parseConfigFromEnv(envWith());
  assert.equal(result.warnings.join("\n").includes("SSO"), false);
});

test("two listeners on one port warn about D6 rather than going inert", () => {
  const result = parseConfigFromEnv(envWith({ [ESI_PORT]: "26006", [SSO_PORT]: "26006" }));
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /cannot share a port/);
  assert.match(result.warnings.join("\n"), /D6/);
});

// The issuer (D7)

test("the issuer has a fixed default, and blank turns the SSO listener off (D47)", () => {
  // This value must never change in a later release: untouched installs would
  // move with it and every token they issued would stop validating.
  assert.equal(DEFAULTS.ssoIssuer, "http://localhost:26006");

  const absent = parseConfigFromEnv({ [ESI_PORT]: "26005" });
  assert.equal(absent.ok, true);
  assert.equal(absent.config.ssoIssuer, DEFAULTS.ssoIssuer);
  assert.deepEqual([...absent.warnings], []);

  const blank = parseConfigFromEnv(envWith());
  assert.equal(blank.ok, true);
  assert.equal(blank.config.ssoIssuer, null);
  assert.deepEqual([...blank.warnings], []);
});

test("a well-formed issuer is kept verbatim", () => {
  for (const issuer of [
    "http://host.local:26006",
    "https://login.host.local",
    "http://127.0.0.1:26006",
    "http://[::1]:26006",
  ]) {
    const result = parseConfigFromEnv(envWith({ [SSO_ISSUER]: issuer }));
    assert.equal(result.ok, true, `${issuer} should be accepted: ${result.errors.join("; ")}`);
    // Verbatim: this exact string goes into every token's `iss` and into the
    // discovery document's `issuer`, and clients compare both byte for byte.
    assert.equal(result.config.ssoIssuer, issuer);
  }
});

test("a scheme-less issuer is refused: the EVE client would supply https", () => {
  // The two spellings docs/d6-listener-split.md rules out. `host.local:26006`
  // parses with `host.local` as the scheme, and `host.local` alone loses the
  // port and is fetched over a scheme D1 does not serve.
  for (const issuer of ["host.local:26006", "host.local", "//host.local:26006"]) {
    const result = parseConfigFromEnv(envWith({ [SSO_ISSUER]: issuer }));
    assert.equal(result.ok, false, `${issuer} should be refused`);
    assert.match(result.errors.join("\n"), /must be an absolute URL with an explicit scheme/);
  }

  // `host.local:26006` does not throw in a URL parser (it parses with
  // `host.local` as the scheme) and is the likeliest thing to be typed here,
  // because it is how CCP writes `iss`. The message must name the cause and the
  // fix rather than report an exotic scheme.
  const schemeless = parseConfigFromEnv(envWith({ [SSO_ISSUER]: "host.local:26006" }));
  assert.match(schemeless.errors.join("\n"), /reads "host\.local" there as the scheme/);
  assert.match(schemeless.errors.join("\n"), /Write "http:\/\/host\.local:26006"/);
});

test("a scheme nothing can fetch is refused: the issuer is fetched, not just compared", () => {
  const result = parseConfigFromEnv(envWith({ [SSO_ISSUER]: "ftp://host.local:26006" }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must use http or https/);
});

test("a trailing slash is refused, because issuer comparison is exact", () => {
  const result = parseConfigFromEnv(envWith({ [SSO_ISSUER]: "http://host.local:26006/" }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must not end with a slash/);
});

test("a path is refused, because the EVE client throws it away", () => {
  const result = parseConfigFromEnv(envWith({ [SSO_ISSUER]: "http://host.local:26006/sso" }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must not carry a path/);
});

test("a query string, a fragment or credentials are each refused", () => {
  for (const [issuer, pattern] of [
    ["http://host.local:26006?x=1", /query string or a fragment/],
    ["http://host.local:26006#f", /query string or a fragment/],
    ["http://user:pass@host.local:26006", /must not carry credentials/],
  ]) {
    const result = parseConfigFromEnv(envWith({ [SSO_ISSUER]: issuer }));
    assert.equal(result.ok, false, `${issuer} should be refused`);
    assert.match(result.errors.join("\n"), pattern);
  }
});

test("a value a URL parser would rewrite is refused with the spelling to use", () => {
  // Refused rather than normalized: normalizing would put one string in the
  // config and a different one in the tokens, and a client validating `iss`
  // compares exactly that difference.
  const result = parseConfigFromEnv(envWith({ [SSO_ISSUER]: "http://HOST.local:26006" }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /"http:\/\/host\.local:26006"/);
});

test("an unusable issuer leaves the field null rather than half-parsed", () => {
  const result = parseConfigFromEnv(envWith({ [SSO_ISSUER]: "http://host.local:26006/sso" }));
  assert.equal(result.config.ssoIssuer, null);
});

test("with an issuer set, two listeners on one port is fatal rather than a warning", () => {
  // The existing warning said "harmless until the SSO phase, when this becomes
  // fatal". The issuer is what starts the second listener, so it is what makes
  // this fatal.
  const result = parseConfigFromEnv(
    envWith({
      [ESI_PORT]: "26006",
      [SSO_PORT]: "26006",
      [SSO_ISSUER]: "http://host.local:26006",
    }),
  );

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /cannot share a port/);
  assert.match(result.errors.join("\n"), /ESI_MOD_SSO_ISSUER is set/);
  // It is reported once, as an error only, not also as a warning.
  assert.equal(result.warnings.join("\n").includes("cannot share a port"), false);
});

test("describeConfig calls the SSO listener disabled when no issuer arms it", () => {
  const { config } = parseConfigFromEnv(envWith());
  const described = describeConfig(config);

  // As with `esiListener`: `ssoBindHost` and `ssoPort` have values whether or
  // not anything binds them, and printing them for a listener that will not
  // start is what describeListener refuses to do.
  assert.equal(described.ssoListener, "disabled");
  assert.equal(described.ssoIssuer, "unset");
});

test("describeConfig prints the issuer in full: it is the opposite of a secret", () => {
  const { config } = parseConfigFromEnv(envWith({ [SSO_ISSUER]: "http://host.local:26006" }));
  const described = describeConfig(config);

  assert.equal(described.ssoIssuer, "http://host.local:26006");
  assert.equal(described.ssoListener, "127.0.0.1:26006");
});

// Bind hosts

test("a bind host can be overridden, and a non-loopback one warns", () => {
  const result = parseConfigFromEnv(envWith({ [ESI_BIND_HOST]: "0.0.0.0" }));
  assert.equal(result.ok, true);
  assert.equal(result.config.esiBindHost, "0.0.0.0");
  assert.match(result.warnings.join("\n"), /not a loopback address/);
});

test("a host that merely starts like loopback is not one", () => {
  // `startsWith("127.")` used to accept all of these. That was survivable while
  // the only consumer was a warning, but dev auto-approve now refuses to enable
  // off loopback, and a guard that relies on "it would have failed later
  // anyway" cannot be checked by a reader.
  for (const host of ["127.evil.com", "127.0.0.1.evil.com", "1270.0.0.1", "127.0.0.256"]) {
    const result = parseConfigFromEnv(envWith({ [ESI_BIND_HOST]: host }));
    assert.match(
      result.warnings.join("\n"),
      /not a loopback address/,
      `${host} is not a loopback address and should warn`,
    );
  }
});

test("loopback bind hosts are silent", () => {
  for (const host of ["127.0.0.1", "127.0.0.53", "::1", "localhost", "LOCALHOST"]) {
    const result = parseConfigFromEnv(envWith({ [ESI_BIND_HOST]: host }));
    assert.deepEqual([...result.warnings], [], `${host} should not warn`);
  }
});

test("a bind host containing whitespace is rejected", () => {
  const result = parseConfigFromEnv(envWith({ [ESI_BIND_HOST]: "127.0.0.1 26005" }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must not contain whitespace/);
});

test("the SSO bind host is validated on its own", () => {
  const result = parseConfigFromEnv(envWith({ [SSO_BIND_HOST]: "0.0.0.0" }));
  assert.equal(result.config.ssoBindHost, "0.0.0.0");
  assert.match(result.warnings.join("\n"), /ESI_MOD_SSO_BIND_HOST/);
});

// Dev auto-approve (D3)

test("auto-approve is off unless explicitly asked for", () => {
  for (const raw of ["", "0", "false", "no", "off", "maybe", "TRUEish"]) {
    const result = parseConfigFromEnv(envWith({ [DEV_AUTO_APPROVE]: raw }));
    assert.equal(result.config.devAutoApprove, false, `"${raw}" should not enable it`);
  }
});

test("auto-approve accepts the usual affirmatives, case-insensitively", () => {
  for (const raw of ["1", "true", "TRUE", "yes", "On"]) {
    const result = parseConfigFromEnv(
      envWith({ [DEV_AUTO_APPROVE]: raw, [DEV_CHARACTER_ID]: "90000001" }),
    );
    assert.equal(result.config.devAutoApprove, true, `"${raw}" should enable it`);
    assert.equal(result.config.devAutoApproveCharacterID, 90000001);
  }
});

test("auto-approve warns loudly whenever it is on", () => {
  const result = parseConfigFromEnv(
    envWith({ [DEV_AUTO_APPROVE]: "1", [DEV_CHARACTER_ID]: "90000001" }),
  );
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /without\s+proving identity/);
  assert.match(result.warnings.join("\n"), /90000001/);
});

test("auto-approve with no character is an error: it has nothing to approve as", () => {
  const result = parseConfigFromEnv(envWith({ [DEV_AUTO_APPROVE]: "1" }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /has no character to issue tokens for/);
});

test("a character ID with auto-approve off is a warning, not an error", () => {
  const result = parseConfigFromEnv(envWith({ [DEV_CHARACTER_ID]: "90000001" }));
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /will not be used/);
});

test("a malformed character ID is rejected rather than coerced", () => {
  for (const raw of ["abc", "90000001.5", "-1", "0", "9007199254740993000"]) {
    const result = parseConfigFromEnv(
      envWith({ [DEV_AUTO_APPROVE]: "1", [DEV_CHARACTER_ID]: raw }),
    );
    assert.equal(result.ok, false, `character ID "${raw}" should be rejected`);
    assert.equal(result.config.devAutoApproveCharacterID, null);
  }
});

test("auto-approve refuses to start when the SSO listener is not on loopback", () => {
  const result = parseConfigFromEnv(
    envWith({
      [DEV_AUTO_APPROVE]: "1",
      [DEV_CHARACTER_ID]: "90000001",
      [SSO_BIND_HOST]: "0.0.0.0",
    }),
  );

  // An error, not a warning: the flag hands a token for a real character to
  // whoever asks, so its blast radius is every machine that can reach the SSO
  // port. No deployment intends "that set is the network".
  assert.equal(result.ok, false);
  const errors = result.errors.join("\n");
  assert.match(errors, /ESI_MOD_DEV_AUTO_APPROVE is on and ESI_MOD_SSO_BIND_HOST/);
  // The message says plainly what enabling it means, rather than naming two keys.
  assert.match(errors, /without any proof of identity/);
  assert.match(errors, /90000001/);
});

test("auto-approve on loopback is allowed: that is the deployment it exists for", () => {
  for (const host of ["127.0.0.1", "127.0.0.53", "::1", "localhost"]) {
    const result = parseConfigFromEnv(
      envWith({
        [DEV_AUTO_APPROVE]: "1",
        [DEV_CHARACTER_ID]: "90000001",
        [SSO_BIND_HOST]: host,
      }),
    );
    assert.equal(result.ok, true, `${host} should be allowed`);
  }
});

test("a non-loopback SSO bind host is fine on its own: the refusal is the combination", () => {
  const result = parseConfigFromEnv(envWith({ [SSO_BIND_HOST]: "0.0.0.0" }));
  assert.equal(result.ok, true);
  assert.deepEqual([...result.errors], []);
});

test("auto-approve on a non-loopback ESI bind host is not the refusal: SSO is what issues", () => {
  // The ESI listener serves reads; the SSO listener is the one that would hand
  // out the token. Refusing on the wrong one would be a rule nobody could
  // predict from what the flag does.
  const result = parseConfigFromEnv(
    envWith({
      [DEV_AUTO_APPROVE]: "1",
      [DEV_CHARACTER_ID]: "90000001",
      [ESI_BIND_HOST]: "0.0.0.0",
    }),
  );
  assert.equal(result.ok, true);
});

test("describeConfig makes an enabled auto-approve impossible to miss", () => {
  const { config } = parseConfigFromEnv(
    envWith({ [DEV_AUTO_APPROVE]: "1", [DEV_CHARACTER_ID]: "90000001" }),
  );
  const described = describeConfig(config);

  // The boolean is what a program reads and is unchanged; this is the line a
  // human sees in a console shared with the game's own logging.
  assert.equal(described.devAutoApprove, true);
  assert.match(described.devAutoApproveEffect, /ANY CALLER CAN OBTAIN A TOKEN/);
  assert.match(described.devAutoApproveEffect, /90000001/);
  assert.equal(describeConfig(parseConfigFromEnv(envWith()).config).devAutoApproveEffect, "off");
});

// The client allowlist

test("no allowlist path is a working configuration, not a missing one", () => {
  // Under lib/clientRegistry.js's loopback rule every native tool still
  // authenticates with no file at all, so this must be silent: no error, no
  // warning.
  const result = parseConfigFromEnv(envWith());

  assert.equal(result.ok, true);
  assert.equal(result.config.ssoClientsPath, null);
  assert.deepEqual([...result.config.ssoClients], []);
  assert.equal(result.warnings.join("\n").includes("CLIENTS"), false);
});

test("a relative allowlist path is refused: the server's cwd is not ours to assume", () => {
  const result = parseConfigFromEnv(envWith({ [SSO_CLIENTS_PATH]: "clients.json" }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must be an absolute path/);
  assert.equal(result.config.ssoClientsPath, null);
});

test("a valid allowlist parses into clients the registry can consume", () => {
  const parsed = parseClientsFile(
    JSON.stringify({
      clients: [
        { client_id: "1a2b3c", redirect_uris: ["http://host.local:8080/sso/callback"] },
        { client_id: "*", redirect_uris: ["http://host.local:3000/cb", "http://host.local:3001/cb"] },
      ],
    }),
    "/srv/evejs/sso-clients.json",
  );

  assert.deepEqual([...parsed.errors], []);
  // snake_case in the file, because every value in it is copied out of an
  // OAuth client's own configuration; camelCase in the config object, which is
  // what createClientRegistry takes.
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.clients)), [
    { clientId: "1a2b3c", redirectUris: ["http://host.local:8080/sso/callback"] },
    { clientId: "*", redirectUris: ["http://host.local:3000/cb", "http://host.local:3001/cb"] },
  ]);
});

test("an optional client_secret is translated and passed through untouched", () => {
  // The one translation the other two fields get: snake_case in the file (the
  // OAuth spelling an operator copies from a tool's configuration), camelCase in
  // the config object (what `createClientRegistry` reads).
  const secret = "0123456789abcdef0123456789abcdef";
  const parsed = parseClientsFile(
    JSON.stringify({
      clients: [
        {
          client_id: "confidential",
          redirect_uris: ["http://host.local:8080/cb"],
          client_secret: secret,
        },
        { client_id: "public", redirect_uris: ["http://host.local:8081/cb"] },
      ],
    }),
    "/srv/evejs/sso-clients.json",
  );

  assert.deepEqual([...parsed.errors], []);
  assert.equal(parsed.clients[0].clientSecret, secret);

  // Absent, not `undefined`-valued: an entry with no secret is how
  // `lib/clientRegistry.js` recognises a PUBLIC client, the normal case for a
  // native tool on a loopback redirect. A key that exists with an undefined
  // value would still read as present to `in` or `hasOwnProperty`.
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed.clients[1], "clientSecret"),
    false,
  );
});

test("a client_secret is not validated here: the registry owns every rule", () => {
  // Same principle as the redirect-URI argument: two files with separate
  // opinions about what a secret may be eventually let through one that the
  // other would have refused. `lib/clientRegistry.js` refuses an empty, short,
  // long, non-string or wrongly-charactered secret at construction (a startup
  // failure), so this parser's job ends at "the key was present, so it was
  // passed on", including for a value that is not a string.
  for (const value of ["", "short", 42, null, { nested: true }]) {
    const parsed = parseClientsFile(
      JSON.stringify({
        clients: [{
          client_id: "a",
          redirect_uris: ["http://host.local:8080/cb"],
          client_secret: value,
        }],
      }),
      "/srv/evejs/sso-clients.json",
    );

    assert.deepEqual([...parsed.errors], [], `for ${JSON.stringify(value)}`);
    assert.deepEqual(
      parsed.clients[0].clientSecret,
      value,
      `for ${JSON.stringify(value)}`,
    );
  }
});

test("a client_secret cannot be smuggled in through a prototype", () => {
  // `readEnv` follows the same own-property rule: a credential reached through
  // a prototype is not something an operator wrote in a file. JSON.parse never
  // produces one, so this covers a caller handing `parseClientsFile` output
  // onwards, or a future second source for this list.
  const parsed = parseClientsFile(
    '{"clients":[{"client_id":"a","redirect_uris":["http://host.local:8080/cb"],'
    + '"__proto__":{"client_secret":"0123456789abcdef"}}]}',
    "/srv/evejs/sso-clients.json",
  );

  assert.deepEqual([...parsed.errors], []);
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed.clients[0], "clientSecret"),
    false,
  );
});

test("a malformed allowlist is an error naming the file, not a silent empty list", () => {
  const cases = [
    ["{", /is not valid JSON/],
    ["[]", /must be a JSON object carrying a "clients" array/],
    ['{"clients":{}}', /must be a JSON object carrying a "clients" array/],
    ['{"clients":["http://x/cb"]}', /client #1 is not an object/],
    ['{"clients":[{"redirect_uris":["http://x/cb"]}]}', /has no "client_id" string/],
    ['{"clients":[{"client_id":"a"}]}', /has no "redirect_uris" array/],
    ['{"clients":[{"client_id":"a","redirect_uris":[]}]}', /has no "redirect_uris" array/],
    ['{"clients":[{"client_id":"a","redirect_uris":[7]}]}', /not a non-empty string/],
  ];

  for (const [text, expected] of cases) {
    const parsed = parseClientsFile(text, "/srv/evejs/sso-clients.json");
    assert.match(parsed.errors.join("\n"), expected, `for ${text}`);
    assert.match(parsed.errors.join("\n"), /\/srv\/evejs\/sso-clients\.json/, `for ${text}`);
    assert.deepEqual([...parsed.clients], [], `for ${text}`);
  }
});

test("every problem in an allowlist is reported at once, not one per restart", () => {
  const parsed = parseClientsFile(
    JSON.stringify({ clients: [{ client_id: "a" }, {}, { client_id: "b", redirect_uris: [1] }] }),
    "/srv/evejs/sso-clients.json",
  );
  assert.equal(parsed.errors.length, 3);
});

test("a configured allowlist path that cannot be read is an error, unlike an absent .env", () => {
  // Not setting the key means "no allowlist" and is silent. Setting it to a
  // path that holds nothing means a location was written down wrongly, and a
  // server that started cleanly and then refused every browser client would say
  // nothing about why.
  withTempDir((dir) => {
    const missing = path.join(dir, "nope.json");
    const result = loadConfig({ dir, env: envWith({ [SSO_CLIENTS_PATH]: missing }) });

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /could not be read \(ENOENT\)/);
    assert.deepEqual([...result.config.ssoClients], []);
  });
});

test("loadConfig reads the allowlist file the way it reads .env: core pure, wrapper impure", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "sso-clients.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ clients: [{ client_id: "*", redirect_uris: ["http://host.local:3000/cb"] }] }),
    );

    const result = loadConfig({ dir, env: envWith({ [SSO_CLIENTS_PATH]: file }) });

    assert.equal(result.ok, true);
    assert.deepEqual([...result.errors], []);
    assert.equal(result.config.ssoClientsPath, path.resolve(file));
    assert.equal(result.config.ssoClients.length, 1);
    assert.deepEqual([...result.config.ssoClients[0].redirectUris], ["http://host.local:3000/cb"]);

    // The pure core knows the path and not the file, and says so with the empty
    // list rather than by omitting the field.
    const pure = parseConfigFromEnv(envWith({ [SSO_CLIENTS_PATH]: file }));
    assert.deepEqual([...pure.config.ssoClients], []);
  });
});

test("describeConfig counts the allowlist instead of printing it", () => {
  const { config } = parseConfigFromEnv(envWith());
  assert.match(describeConfig(config).ssoClients, /^none/);

  const described = describeConfig({
    ...config,
    ssoClients: [
      {
        clientId: "a",
        redirectUris: ["http://host.local:3000/cb"],
        clientSecret: "0123456789abcdef0123456789abcdef",
      },
      { clientId: "b", redirectUris: ["http://host.local:3001/cb", "http://host.local:3002/cb"] },
    ],
  });
  assert.equal(described.ssoClients, "2 client(s), 3 redirect URI(s)");
  assert.equal(JSON.stringify(described).includes("host.local"), false);

  // The secret never reaches the banner, and neither does the fact that one of
  // the two entries has one. The count is deliberately not "2 client(s), 1
  // confidential": a banner ends up in pasted bug reports, and which client_id
  // is confidential is the distinction `lib/clientRegistry.js` compares against
  // a random decoy so the token endpoint cannot be used as an oracle for it.
  const rendered = JSON.stringify(described);
  assert.equal(rendered.includes("0123456789abcdef"), false);
  assert.doesNotMatch(rendered, /confidential|secret|public client/i);
});

// The sso/ directory (D8, D30)

test("an absolute SSO state directory is accepted and normalized", () => {
  const result = parseConfigFromEnv(envWith({ [SSO_STATE_DIR]: ABSOLUTE_STATE_DIR }));
  assert.equal(result.ok, true);
  assert.equal(result.config.ssoStateDir, path.resolve(ABSOLUTE_STATE_DIR));
});

test("absence means derive from the game store, not a missing setting", () => {
  // The normal case stays the normal case: a deployment with a game store
  // configures nothing and gets `lib/runtimeAccess.js`'s derivation, as before.
  const result = parseConfigFromEnv(envWith());
  assert.equal(result.ok, true);
  assert.equal(result.config.ssoStateDir, null);
  assert.deepEqual([...result.warnings].filter((w) => w.includes(SSO_STATE_DIR)), []);
  assert.deepEqual([...result.errors].filter((e) => e.includes(SSO_STATE_DIR)), []);
});

test("a relative SSO state directory is refused: the server's cwd is not ours to assume", () => {
  const result = parseConfigFromEnv(envWith({ [SSO_STATE_DIR]: "state/sso" }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must be an absolute path/);
  assert.equal(result.config.ssoStateDir, null);
});

test("an SSO state directory inside the mod directory is an error, not a warning", () => {
  // The asymmetry with the signing key below is the assertion, not an
  // inconsistency: a redeploy replaces the mod directory wholesale (D21), and
  // this is where all three secrets are created. Two of them exist nowhere else:
  // losing the salt re-authorises every character and losing the store logs
  // every tool out (D30).
  const inside = path.join(MOD_DIR, "sso");
  const result = parseConfigFromEnv(envWith({ [SSO_STATE_DIR]: inside }));

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /D21/);
  assert.match(result.errors.join("\n"), /signing key, the owner salt and every refresh token/);
  assert.equal(result.config.ssoStateDir, null);
});

test("the directory and the key path are independent knobs and coexist", () => {
  // Kept deliberately: the key override lets an operator supply a key they
  // generated themselves, so the two are parsed side by side and `loader.js`
  // applies the precedence. Neither silences or invalidates the other here.
  const result = parseConfigFromEnv(envWith({
    [SSO_STATE_DIR]: ABSOLUTE_STATE_DIR,
    [SIGNING_KEY_PATH]: ABSOLUTE_KEY_PATH,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.config.ssoStateDir, path.resolve(ABSOLUTE_STATE_DIR));
  assert.equal(result.config.signingKeyPath, path.resolve(ABSOLUTE_KEY_PATH));
  // No warning for the combination either: it is what the key override exists
  // for, and a warning on every boot of a chosen configuration is how a console
  // stops being read.
  assert.deepEqual([...result.warnings].filter((w) => w.includes(SSO_STATE_DIR)), []);
});

test("the SSO state directory is validated even with no issuer to arm the listener", () => {
  // Same rule as the SSO port and bind host: a deployment must not hold a
  // broken value that only surfaces the day somebody sets the issuer.
  const result = parseConfigFromEnv({
    [ESI_PORT]: "26005",
    [SSO_STATE_DIR]: "not/absolute",
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), new RegExp(SSO_STATE_DIR));
});

test("describeConfig never renders the SSO state directory", () => {
  // One directory holding all three secrets is a sharper version of the signing
  // key's argument: a banner ends up in every screenshot and pasted bug report,
  // and this path points at the whole set.
  const { config } = parseConfigFromEnv(envWith({ [SSO_STATE_DIR]: ABSOLUTE_STATE_DIR }));
  const described = describeConfig(config);
  const rendered = JSON.stringify(described);

  assert.equal(rendered.includes(ABSOLUTE_STATE_DIR.replace(/\\/g, "\\\\")), false);
  assert.equal(rendered.includes("esi-sso-state"), false);
  assert.equal(described.ssoStateDir, "set");
  assert.equal(describeConfig(parseConfigFromEnv({}).config).ssoStateDir, "unset");
  assert.equal(describeConfig(null).ssoStateDir, "unset");
});

// Signing key (D8)

test("an absolute signing key path is accepted and normalized", () => {
  const result = parseConfigFromEnv(envWith({ [SIGNING_KEY_PATH]: ABSOLUTE_KEY_PATH }));
  assert.equal(result.ok, true);
  assert.equal(result.config.signingKeyPath, path.resolve(ABSOLUTE_KEY_PATH));
});

test("a relative signing key path is refused: the server's cwd is not ours to assume", () => {
  const result = parseConfigFromEnv(envWith({ [SIGNING_KEY_PATH]: "keys/sso.pem" }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must be an absolute path/);
  assert.equal(result.config.signingKeyPath, null);
});

test("a signing key inside the mod directory warns about D8 without going inert", () => {
  const inside = path.join(MOD_DIR, "keys", "sso.pem");
  const result = parseConfigFromEnv(envWith({ [SIGNING_KEY_PATH]: inside }));
  assert.equal(result.ok, true);
  assert.match(result.warnings.join("\n"), /invalidate every issued token/);
  assert.match(result.warnings.join("\n"), /D8/);
});

// Log level

test("a known log level is accepted, case-insensitively", () => {
  for (const raw of ["error", "warn", "INFO", "Debug"]) {
    const result = parseConfigFromEnv(envWith({ [LOG_LEVEL]: raw }));
    assert.equal(result.ok, true);
    assert.equal(result.config.logLevel, raw.toLowerCase());
  }
});

test("an unknown log level degrades to the default: a logging knob cannot disable the mod", () => {
  const result = parseConfigFromEnv(envWith({ [LOG_LEVEL]: "verbose" }));
  assert.equal(result.ok, true);
  assert.equal(result.config.logLevel, DEFAULTS.logLevel);
  assert.match(result.warnings.join("\n"), /not one of error, warn, info, debug/);
});

// Error limit budget (D44)

test("the default error-limit budget is CCP's own observed 100, and never drifts from lib/errorLimiter.js", () => {
  assert.equal(DEFAULTS.errorLimitMaxErrors, 100);
  assert.equal(DEFAULTS.errorLimitMaxErrors, MAX_ERRORS);
});

test("an unset error-limit budget does not nag: unset is a complete configuration, not a missing one", () => {
  const result = parseConfigFromEnv(envWith());
  assert.equal(result.warnings.join("\n").includes("ERROR_LIMIT"), false);
});

test("a configured error-limit budget overrides the default", () => {
  const result = parseConfigFromEnv(envWith({ [ERROR_LIMIT_MAX_ERRORS]: "250" }));
  assert.equal(result.ok, true);
  assert.deepEqual([...result.errors], []);
  assert.equal(result.config.errorLimitMaxErrors, 250);
});

test("a numeric env value works as well as a string", () => {
  const result = parseConfigFromEnv(envWith({ [ERROR_LIMIT_MAX_ERRORS]: 250 }));
  assert.equal(result.ok, true);
  assert.equal(result.config.errorLimitMaxErrors, 250);
});

test("a malformed error-limit budget is an error, not a silent coercion", () => {
  for (const raw of ["abc", "250.5", "0x1f", "1e4", "25a0", "-1", "+80"]) {
    const result = parseConfigFromEnv(envWith({ [ERROR_LIMIT_MAX_ERRORS]: raw }));
    assert.equal(result.ok, false, `budget "${raw}" should be rejected`);
    assert.match(result.errors.join("\n"), /must be a whole number/);
    // Still reports a usable value, so a caller reading the field mid-failure
    // never sees undefined, as the SSO port does.
    assert.equal(result.config.errorLimitMaxErrors, DEFAULTS.errorLimitMaxErrors);
  }
});

test("zero is refused: a limiter with no budget is not a smaller version of this feature", () => {
  const result = parseConfigFromEnv(envWith({ [ERROR_LIMIT_MAX_ERRORS]: "0" }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must be a positive whole number/);
});

test("a value past the safe-integer ceiling is refused rather than rounded", () => {
  const result = parseConfigFromEnv(envWith({ [ERROR_LIMIT_MAX_ERRORS]: "9007199254740993000" }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /must be a positive whole number/);
});

test("a whitespace-only error-limit budget counts as unset, not as a bad value", () => {
  const result = parseConfigFromEnv(envWith({ [ERROR_LIMIT_MAX_ERRORS]: "   " }));
  assert.equal(result.ok, true);
  assert.deepEqual([...result.errors], []);
  assert.equal(result.config.errorLimitMaxErrors, DEFAULTS.errorLimitMaxErrors);
});

test("describeConfig prints the resolved error-limit budget, default or configured", () => {
  assert.equal(
    describeConfig(parseConfigFromEnv(envWith()).config).errorLimitMaxErrors,
    100,
  );
  assert.equal(
    describeConfig(parseConfigFromEnv(envWith({ [ERROR_LIMIT_MAX_ERRORS]: "300" })).config)
      .errorLimitMaxErrors,
    300,
  );
  assert.equal(describeConfig(null).errorLimitMaxErrors, 100);
});

// Error accumulation

test("all problems are reported at once, not one per restart", () => {
  const result = parseConfigFromEnv({
    [ESI_PORT]: "not-a-port",
    [SSO_PORT]: "also-not",
    [ESI_BIND_HOST]: "has space",
    [SIGNING_KEY_PATH]: "relative/key.pem",
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 4);
});

// Redaction

test("describeConfig never renders the signing key path", () => {
  const { config } = parseConfigFromEnv(envWith({ [SIGNING_KEY_PATH]: ABSOLUTE_KEY_PATH }));
  const described = describeConfig(config);
  const rendered = JSON.stringify(described);

  assert.equal(rendered.includes(ABSOLUTE_KEY_PATH.replace(/\\/g, "\\\\")), false);
  assert.equal(rendered.includes("signing.pem"), false);
  assert.equal(described.signingKey, "set");
});

test("describeConfig reports unset things as unset and an unarmed listener as disabled", () => {
  const { config } = parseConfigFromEnv(BOTH_OFF);
  const described = describeConfig(config);

  assert.equal(described.esiListener, "disabled");
  assert.equal(described.signingKey, "unset");
  assert.equal(described.devAutoApprove, false);
  assert.equal(described.devAutoApproveCharacterID, "unset");
});

test("describeConfig shows the listeners a human needs to see", () => {
  // The issuer is here because it arms the SSO listener (D7): without it there
  // is no SSO listener to describe, and `describeConfig` says so rather than
  // print a host and port nothing will bind. The case below covers that half.
  const { config } = parseConfigFromEnv(
    envWith({
      [DEV_AUTO_APPROVE]: "1",
      [DEV_CHARACTER_ID]: "90000001",
      [SSO_ISSUER]: "http://host.local:26006",
    }),
  );
  const described = describeConfig(config);

  assert.equal(described.esiListener, "127.0.0.1:26005");
  assert.equal(described.ssoListener, "127.0.0.1:26006");
  assert.equal(described.devAutoApprove, true);
  assert.equal(described.devAutoApproveCharacterID, 90000001);
  assert.equal(described.modVersion, MOD_VERSION);
});

test("describeConfig tolerates junk instead of throwing inside a log line", () => {
  for (const junk of [null, undefined, 42, "config"]) {
    assert.doesNotThrow(() => describeConfig(junk));
  }
  assert.equal(describeConfig(null).signingKey, "unset");
  assert.equal(describeConfig(null).esiListener, "disabled");
});

// parseEnvFile: the happy shapes

test("a plain KEY=VALUE file parses into an env-like object", () => {
  const parsed = parseEnvFile(`${ESI_PORT}=26005\n${LOG_LEVEL}=debug\n`);
  assert.deepEqual([...parsed.warnings], []);
  assert.deepEqual({ ...parsed.values }, { [ESI_PORT]: "26005", [LOG_LEVEL]: "debug" });
});

test("CRLF line endings and a leading BOM read the same as plain LF", () => {
  const parsed = parseEnvFile(`﻿${ESI_PORT}=26005\r\n${LOG_LEVEL}=warn\r\n`);
  assert.deepEqual([...parsed.warnings], []);
  assert.equal(parsed.values[ESI_PORT], "26005");
  assert.equal(parsed.values[LOG_LEVEL], "warn");
});

test("blank lines, indentation and whole-line comments are ignored", () => {
  const parsed = parseEnvFile(`\n# a comment\n\n   ${ESI_PORT}=26005   \n`);
  assert.deepEqual([...parsed.warnings], []);
  assert.deepEqual({ ...parsed.values }, { [ESI_PORT]: "26005" });
});

test("only the first = separates, and matching quotes are stripped", () => {
  const parsed = parseEnvFile(`${SIGNING_KEY_PATH}="/keys/a=b.pem"\n`);
  assert.equal(parsed.values[SIGNING_KEY_PATH], "/keys/a=b.pem");
});

test("a # after a value is part of the value, not an inline comment", () => {
  // Truncating at a `#` would silently mangle a path or a value that contains
  // one; the field parsers reject the result loudly instead.
  const parsed = parseEnvFile(`${ESI_PORT}=26005 # the D1 port\n`);
  assert.equal(parsed.values[ESI_PORT], "26005 # the D1 port");
  assert.equal(parseConfigFromEnv(parsed.values).ok, false);
});

test("an empty value is an empty string, not a missing key", () => {
  const parsed = parseEnvFile(`${ESI_PORT}=\n`);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.values, ESI_PORT), true);
  assert.equal(parsed.values[ESI_PORT], "");
});

test("the parsed file result is frozen", () => {
  const parsed = parseEnvFile(`${ESI_PORT}=26005\n`);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.values), true);
  assert.equal(Object.isFrozen(parsed.warnings), true);
});

// parseEnvFile: degrading, never throwing

test("a line with no = warns, and the rest of the file still parses", () => {
  const parsed = parseEnvFile(`junk\n${ESI_PORT}=26005\n`);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /line 1: expected KEY=VALUE/);
  assert.equal(parsed.values[ESI_PORT], "26005");
});

test("a malformed line never echoes its own content", () => {
  // A malformed line may well be the one naming a private key, and these
  // warnings go to the game server's console.
  const secretish = "this-should-never-be-logged";
  const parsed = parseEnvFile(`${secretish}\nexport FOO=${secretish}\n`);
  assert.equal(parsed.warnings.length, 2);
  assert.equal(parsed.warnings.join("\n").includes(secretish), false);
});

test("an invalid variable name is a warning, not a key", () => {
  const parsed = parseEnvFile("2FOO=bar\n=orphan\n");
  assert.equal(Object.keys(parsed.values).length, 0);
  assert.equal(parsed.warnings.length, 2);
});

test("a repeated key warns and the last value wins", () => {
  const parsed = parseEnvFile(`${ESI_PORT}=1\n${ESI_PORT}=2\n`);
  assert.equal(parsed.values[ESI_PORT], "2");
  assert.match(parsed.warnings.join("\n"), /set more than once/);
});

test("a misspelled ESI_MOD_ key is called out instead of silently ignored", () => {
  const parsed = parseEnvFile("ESI_MOD_ESI_PROT=26005\n");
  assert.match(parsed.warnings.join("\n"), /not a setting this mod reads/);
});

test("a key from outside the mod's namespace is not second-guessed", () => {
  const parsed = parseEnvFile("NEXUM_MOD_TOKEN=whatever\nPATH=/usr/bin\n");
  assert.deepEqual([...parsed.warnings], []);
});

test("warnings are capped so a junk file cannot flood the server console", () => {
  const parsed = parseEnvFile("junk\n".repeat(50));
  assert.equal(parsed.warnings.length, 11);
  assert.match(parsed.warnings[10], /further problem\(s\) not listed/);
});

test("a non-string input yields nothing and does not throw", () => {
  for (const input of [null, undefined, 42, {}]) {
    let parsed;
    assert.doesNotThrow(() => {
      parsed = parseEnvFile(input);
    });
    assert.deepEqual({ ...parsed.values }, {});
    assert.deepEqual([...parsed.warnings], []);
  }
});

// readEnvFile

test("a missing file is silent: absent is the normal case", () => {
  withTempDir((dir) => {
    const read = readEnvFile(path.join(dir, ENV_FILE_NAME));
    assert.deepEqual({ ...read.values }, {});
    assert.deepEqual([...read.warnings], []);
  });
});

test("a file that exists is parsed", () => {
  withTempDir((dir) => {
    writeEnvFile(dir, `${ESI_PORT}=26005\n`);
    const read = readEnvFile(path.join(dir, ENV_FILE_NAME));
    assert.equal(read.values[ESI_PORT], "26005");
  });
});

test("a file that cannot be read warns instead of throwing", () => {
  withTempDir((dir) => {
    // A directory where the file should be: unreadable in the same way a
    // permissions problem is, and portable to Windows, where chmod is not.
    const filePath = path.join(dir, ENV_FILE_NAME);
    fs.mkdirSync(filePath);
    let read;
    assert.doesNotThrow(() => {
      read = readEnvFile(filePath);
    });
    assert.deepEqual({ ...read.values }, {});
    assert.equal(read.warnings.length, 1);
    assert.match(read.warnings[0], /present but could not be read/);
  });
});

// loadConfig: the merge, per key

test("no file and no environment arms the defaults, without throwing (D47)", () => {
  withTempDir((dir) => {
    let result;
    assert.doesNotThrow(() => {
      result = loadConfig({ dir, env: {} });
    });
    assert.equal(result.ok, true);
    assert.deepEqual([...result.errors], []);
    assert.deepEqual([...result.warnings], []);
    assert.equal(result.config.esiPort, 26005);
    assert.equal(result.config.ssoIssuer, DEFAULTS.ssoIssuer);
  });
});

test("a file alone configures the mod", () => {
  withTempDir((dir) => {
    writeEnvFile(dir, `${ESI_PORT}=26005\n${LOG_LEVEL}=debug\n`);
    const result = loadConfig({ dir, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.config.esiPort, 26005);
    assert.equal(result.config.logLevel, "debug");
  });
});

test("the environment alone configures the mod, with no file present", () => {
  withTempDir((dir) => {
    const result = loadConfig({ dir, env: { [ESI_PORT]: "26005" } });
    assert.equal(result.ok, true);
    assert.equal(result.config.esiPort, 26005);
  });
});

test("the environment wins over the file, per key", () => {
  withTempDir((dir) => {
    writeEnvFile(dir, `${ESI_PORT}=26005\n${LOG_LEVEL}=debug\n`);
    const result = loadConfig({ dir, env: { [ESI_PORT]: "26105" } });
    // The key the environment set is the environment's...
    assert.equal(result.config.esiPort, 26105);
    // ...and the key it did not falls through to the file.
    assert.equal(result.config.logLevel, "debug");
  });
});

test("a key set to empty in the environment still outranks the file", () => {
  // A deployment that deliberately blanks a switch wants that listener off,
  // even if a stale file in the directory says otherwise.
  withTempDir((dir) => {
    writeEnvFile(dir, `${ESI_PORT}=26005\n`);
    const result = loadConfig({ dir, env: { [ESI_PORT]: "" } });
    assert.equal(result.config.esiPort, null);
    // SSO is still armed by its default, so the mod as a whole is wanted.
    assert.equal(result.ok, true);

    const dormant = loadConfig({ dir, env: BOTH_OFF });
    assert.equal(dormant.ok, false);
    assert.deepEqual([...dormant.errors], []);
  });
});

test("file warnings reach the caller alongside the parser's own", () => {
  withTempDir((dir) => {
    writeEnvFile(dir, `junk\n${ESI_PORT}=26005\n${ESI_BIND_HOST}=0.0.0.0\n`);
    const result = loadConfig({ dir, env: {} });
    assert.equal(result.ok, true);
    assert.match(result.warnings.join("\n"), /expected KEY=VALUE/);
    assert.match(result.warnings.join("\n"), /not a loopback address/);
  });
});

test("loadConfig returns the same shape as the pure core", () => {
  withTempDir((dir) => {
    writeEnvFile(dir, "junk\n");
    const result = loadConfig({ dir, env: { [ESI_PORT]: "26005" } });
    const pure = parseConfigFromEnv({ [ESI_PORT]: "26005" });

    assert.deepEqual(Object.keys(result).sort(), Object.keys(pure).sort());
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.warnings), true);
    assert.deepEqual({ ...result.config }, { ...pure.config });
  });
});

test("loading a .env does not touch the process environment", () => {
  // Why process.loadEnvFile() is not used: this is a --require preload sharing
  // process.env with the game server and every other mod in the tree.
  withTempDir((dir) => {
    writeEnvFile(dir, "ESI_MOD_ENVFILE_CANARY=1\n");
    const before = Object.keys(process.env).sort();

    loadConfig({ dir, env: {} });

    assert.equal(process.env.ESI_MOD_ENVFILE_CANARY, undefined);
    assert.deepEqual(Object.keys(process.env).sort(), before);
  });
});

test("loadConfig defaults to the real environment and the mod's own directory", () => {
  // Called with no options, as loader.js calls it. The assertion is only that
  // it answers without throwing: the answer depends on the machine, and a
  // developer with a real .env beside loader.js gets theirs.
  assert.doesNotThrow(() => {
    const result = loadConfig();
    assert.equal(typeof result.ok, "boolean");
  });
  assert.equal(ENV_FILE_PATH, path.join(MOD_DIR, ENV_FILE_NAME));
});

// .env.example

test(".env.example lists every key the mod reads, each commented out", () => {
  // A live blank key would turn a listener off and outrank the launcher form,
  // so a copied template must set nothing at all (D47).
  const text = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
  const parsed = parseEnvFile(text);

  assert.deepEqual([...parsed.warnings], []);
  assert.deepEqual(Object.keys(parsed.values), [], "no key may be live in the template");

  const listed = [...text.matchAll(/^# (ESI_MOD_[A-Z_]+)=\r?$/gm)].map((match) => match[1]);
  assert.deepEqual(listed.sort(), [...ENV_KEYS].sort());
});

test(".env.example copied verbatim to .env.txt changes nothing", () => {
  withTempDir((dir) => {
    const text = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    fs.writeFileSync(path.join(dir, ".env.txt"), text);
    const result = loadConfig({ dir, env: {} });

    assert.equal(result.ok, true);
    assert.deepEqual([...result.errors], []);
    assert.deepEqual([...result.warnings], []);
    assert.equal(result.config.esiPort, DEFAULTS.esiPort);
    assert.equal(result.config.ssoIssuer, DEFAULTS.ssoIssuer);
  });
});
