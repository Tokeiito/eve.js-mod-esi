/**
 * eve.js-mod-esi: configuration
 *
 * Every setting comes from these layers, lowest first (D47), and never from
 * `config/*.json`, which belongs to the vendor drop:
 *
 *   DEFAULTS, settings.json (the launcher form), .env.txt, .env, real environment
 *
 * The mod configures itself out of the one directory it owns (D5). A real
 * environment variable outranks every file, per key, so a compose file, CI job or
 * secrets manager beats a file left behind.
 *
 * The parser is a pure function of an env-like object. Only `readEnvFile()`,
 * `readSettingsFile()`, `readClientsFile()` and the `loadConfig()` wrapper touch
 * `process.env` or the filesystem. This is the pure-core and impure-wrapper split
 * `lib/runtimeAccess.js` uses against game modules, and it lets the suite run with
 * no eve.js checkout, no game server and no real environment.
 *
 * Nothing here throws. Parsing returns a result instead:
 *
 *   { ok, config, warnings: string[], notices: string[], errors: string[] }
 *
 * `ok === false` means the mod installs nothing (see loader.js). This file loads
 * from a `--require` preload inside the game server's process, before the game
 * boots, and eve.js's secondary-service try/catch does not cover preloads, so a
 * throw here stops the server from starting. "Refuse to start" therefore means
 * "this mod does not start", never "the process exits".
 *
 * Two inert states are distinguished, because they read differently in a console:
 *
 *   dormant   both switches (`ESI_MOD_ESI_PORT`, `ESI_MOD_SSO_ISSUER`) are blank.
 *             Both listeners were turned off. Not a fault.
 *   errors    a value was supplied and cannot be used. Something needs fixing.
 *
 * A package nobody enabled is inert for a different reason: the launcher ships it
 * as `loader.js.disabled`, so this file never runs.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

// The mod's version, reported by the startup banner and the health route.
// Hand-maintained, and kept here because every other part of the mod already loads
// config.js, so there is one copy. Not derived from git: the deployed copy at
// <eve.js tree>/mods/esiApi/ is a plain directory copy with no history.
// `lib/sourceHash.js` says which build is running; this says which release it
// claims to be.
const MOD_VERSION = "1.0.0";

// Env keys
// One prefix for the whole mod. NODE_OPTIONS applies to every node process in the
// container, so these names are visible to game code and to other mods. The `.env`
// parser uses the prefix to tell a typo of ours ("ESI_MOD_ESI_PROT") from another
// program's variable, which it must not judge.
const ENV_PREFIX = "ESI_MOD_";

const KEY_ESI_PORT = "ESI_MOD_ESI_PORT";
const KEY_ESI_BIND_HOST = "ESI_MOD_ESI_BIND_HOST";
const KEY_SSO_PORT = "ESI_MOD_SSO_PORT";
const KEY_SSO_BIND_HOST = "ESI_MOD_SSO_BIND_HOST";
const KEY_SSO_ISSUER = "ESI_MOD_SSO_ISSUER";
const KEY_SSO_CLIENTS_PATH = "ESI_MOD_SSO_CLIENTS_PATH";
const KEY_SSO_STATE_DIR = "ESI_MOD_SSO_STATE_DIR";
const KEY_DEV_AUTO_APPROVE = "ESI_MOD_DEV_AUTO_APPROVE";
const KEY_DEV_AUTO_APPROVE_CHARACTER_ID = "ESI_MOD_DEV_AUTO_APPROVE_CHARACTER_ID";
const KEY_SIGNING_KEY_PATH = "ESI_MOD_SIGNING_KEY_PATH";
const KEY_ERROR_LIMIT_MAX_ERRORS = "ESI_MOD_ERROR_LIMIT_MAX_ERRORS";
const KEY_LOG_LEVEL = "ESI_MOD_LOG_LEVEL";

// An array, because the set is only ever asked "is this key one of ours?" and "does
// .env.example list all of them?".
const ENV_KEYS = Object.freeze([
  KEY_ESI_PORT,
  KEY_ESI_BIND_HOST,
  KEY_SSO_PORT,
  KEY_SSO_BIND_HOST,
  KEY_SSO_ISSUER,
  KEY_SSO_CLIENTS_PATH,
  KEY_SSO_STATE_DIR,
  KEY_DEV_AUTO_APPROVE,
  KEY_DEV_AUTO_APPROVE_CHARACTER_ID,
  KEY_SIGNING_KEY_PATH,
  KEY_ERROR_LIMIT_MAX_ERRORS,
  KEY_LOG_LEVEL,
]);

const KNOWN_ENV_KEYS = new Set(ENV_KEYS);

// Defaults
// Keyed by config field name, not env key: this is the config object when nothing
// is set, and every consumer can rely on the fields existing.
//
// `esiPort` and `ssoIssuer` are the two switches, both armed by default (D47):
// absent means this value, and present but blank means that listener is off. A
// copied package stays inert through the launcher's `loader.js.disabled`. The
// manifest's field defaults must equal these; test/manifest.test.js pins it.
//
// The issuer is the `iss` claim of every token and the `issuer` member of the
// discovery document, so this default must never change in a later release:
// untouched installs would move with it and every issued token would stop
// validating. It is not derived from `ssoBindHost` and `ssoPort` (D7): a fixed
// string lets an operator name the endpoint they intend to keep and move the
// transport underneath it.
//
// Always loopback by default. This mod serves character-scoped game state, so
// binding it to an interface must be a deliberate act (see the non-loopback
// warning below).
const DEFAULTS = Object.freeze({
  esiBindHost: "127.0.0.1",
  esiPort: 26005,
  ssoBindHost: "127.0.0.1",
  ssoPort: 26006,
  ssoIssuer: "http://localhost:26006",
  // A `null` path and an empty list are a working configuration: under
  // `lib/clientRegistry.js`'s loopback rule every RFC 8252 native tool authenticates
  // with no allowlist. The list is always an array so consumers need no null check.
  ssoClientsPath: null,
  ssoClients: Object.freeze([]),
  // `null` means "derive the directory from the game store", which suits almost every
  // deployment. It is the same kind of absence as `signingKeyPath` below, not a
  // missing setting.
  ssoStateDir: null,
  devAutoApprove: false,
  devAutoApproveCharacterID: null,
  signingKeyPath: null,
  // CCP's observed budget (`lib/errorLimiter.js` `MAX_ERRORS`, `contract/wire.js`
  // `ERROR_LIMIT.maxErrors`), duplicated rather than imported: this file stays
  // requirable with only `node:fs` and `node:path`, so an unconfigured mod's preload
  // cost is one module. `test/config.test.js` pins the duplicate against
  // `lib/errorLimiter.js`'s constant.
  //
  // D44: unset, this replica is byte-identical to CCP's observed limiter. An operator
  // whose threat model differs from CCP's (a private server answering only its own
  // clients, never the public internet) may raise it.
  errorLimitMaxErrors: 100,
  logLevel: "info",
});

// Ordered loudest-last. Unknown levels degrade to the default rather than failing:
// a typo in a logging setting must not make a working replica inert.
const LOG_LEVELS = Object.freeze(["error", "warn", "info", "debug"]);

// Hosts that keep the listener off the network.  Any 127.x.x.x is loopback,
// hence the prefix test alongside the literals.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

// The ports eve.js itself listens on. The mod preloads and binds first, so taking
// one of these makes the game fail with EADDRINUSE and exit: the failure a preload
// must never cause (design constraint 2).
//
// From eve.js's `compose.yaml` publications, its Dockerfile's EXPOSE, its config
// schema defaults, and the endpoint list the launcher requires. 443 is the native
// loopback CDN responder's default. The market daemon's two ports belong to another
// container under Docker and to this host on a native install.
//
// A fixed list of defaults, not a read of the effective values. Several are
// configurable in eve.js, through `config/*.json` and `EVEJS_*` variables, and the
// precedence between those belongs to game code this file must not load at preload.
// An install that moves a game port onto one the mod is using is not caught here.
const RESERVED_GAME_PORTS = Object.freeze(new Map([
  [443, "the loopback CDN responder"],
  [5222, "XMPP chat"],
  [26000, "the game server"],
  [26001, "the image server"],
  [26002, "the microservices gateway"],
  [26003, "the gateway's TLS responder"],
  [26400, "the Redshift monitor"],
  [40110, "the market daemon's HTTP port"],
  [40111, "the market daemon's RPC port"],
]));

// The .env file
// Beside this file, so the mod is configurable from the one directory it owns.
// Gitignored: the deployed copy at <eve.js tree>/mods/esiApi/ is a copy of this repository
// and this file can name a private key, so a stray `cp -r` in either direction is a
// hazard. `.env.example` carries the shape instead.
const ENV_FILE_NAME = ".env";
const ENV_FILE_PATH = path.join(__dirname, ENV_FILE_NAME);

// The same format under the one spelling a launcher update can preserve:
// `preserveFiles` refuses a name with no allowed suffix, so plain `.env` is lost
// on the first update (D47).
const ENV_TXT_FILE_NAME = ".env.txt";

const SETTINGS_FILE_NAME = "settings.json";

// What the launcher form may set, and all it may set. Anything else in
// settings.json is ignored with a warning, so a hand edit can never arm dev
// auto-approve or move the credential paths (D47). Keys are the `DEFAULTS` field
// names, and test/manifest.test.js holds this map equal to the manifest's fields.
const SETTINGS_ENV_KEYS = Object.freeze({
  esiPort: KEY_ESI_PORT,
  esiBindHost: KEY_ESI_BIND_HOST,
  ssoIssuer: KEY_SSO_ISSUER,
  ssoPort: KEY_SSO_PORT,
  ssoBindHost: KEY_SSO_BIND_HOST,
  ssoClientsPath: KEY_SSO_CLIENTS_PATH,
  errorLimitMaxErrors: KEY_ERROR_LIMIT_MAX_ERRORS,
  logLevel: KEY_LOG_LEVEL,
});

// A malformed file must not flood the game console: this is a preload inside the
// server's process, and its warnings share stdout with the game's logging.
const MAX_ENV_FILE_WARNINGS = 10;

// Shell variable-name rules. Anything else in the key position is a typo or a stray
// line, not a setting.
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Env reading
// Own properties only. `process.env` values are always own properties, so nothing
// is lost there, and a fixture built with Object.create(...) or an unusual caller
// cannot pass values in through a prototype.
function readEnv(env, name) {
  if (env === null || typeof env !== "object") return "";
  if (!Object.prototype.hasOwnProperty.call(env, name)) return "";
  const value = env[name];
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

// The two switches need what `readEnv` conflates: absent takes the default,
// present and blank means off.
function isPresent(env, name) {
  if (env === null || typeof env !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(env, name)) return false;
  return env[name] !== null && env[name] !== undefined;
}

// Individual field parsers
// Each takes the raw trimmed string, pushes human-readable problems onto `errors` or
// `warnings`, and returns the value to use. A parser that pushes an error returns
// the inert value, because `ok` will be false and nobody will read it.

function parsePort(raw, envKey, errors) {
  // Stricter than Number(): "80.5", "0x1f", "1e4" and "26005 " all parse to something
  // numeric, and truncating a typo into a valid port binds a port nobody chose.
  if (!/^[0-9]+$/.test(raw)) {
    errors.push(`${envKey} must be a whole number, got "${raw}".`);
    return null;
  }

  const port = Number(raw);
  if (port < 1 || port > 65535) {
    errors.push(`${envKey} must be between 1 and 65535, got ${port}.`);
    return null;
  }

  return port;
}

function refuseGamePort(port, envKey, errors) {
  if (!RESERVED_GAME_PORTS.has(port)) return;
  errors.push(
    `${envKey} is ${port}, which eve.js uses for ${RESERVED_GAME_PORTS.get(port)}. This mod ` +
      `binds first, so the game would fail with EADDRINUSE and exit. Choose another port.`,
  );
}

function parseBindHost(raw, envKey, errors, warnings, fallback) {
  if (raw === "") return fallback;
  if (/\s/.test(raw)) {
    errors.push(`${envKey} must not contain whitespace, got "${raw}".`);
    return fallback;
  }

  if (!isLoopbackHost(raw)) {
    // Not an error: exposing the replica on a LAN is legitimate, and is how a
    // third-party tool on another machine reaches it. But this surface is an ESI
    // clone over a private server's live state with no TLS (D1), so it says so once,
    // at startup.
    warnings.push(
      `${envKey} is "${raw}", not a loopback address, so the replica will be reachable ` +
        `off this host over plain HTTP.`,
    );
  }

  return raw;
}

/**
 * Whether this bind host is an address only this machine can reach.
 *
 * It parses rather than testing `startsWith("127.")`, which `127.evil.com` passes.
 * A name that does not resolve locally would fail at `listen()` with
 * `EADDRNOTAVAIL` anyway, but dev auto-approve (D3) refuses to enable off loopback,
 * and that guard must not rely on a later failure elsewhere.
 *
 * Accepts four decimal octets, each 0 to 255, with no leading zeroes (which some
 * resolvers read as octal), covering all of `127.0.0.0/8` and nothing that merely
 * begins with those four characters.
 *
 * Deliberately narrower than `lib/clientRegistry.js`'s loopback test, and neither
 * should be rewritten to match the other. That one judges a redirect URI a browser
 * will be sent to, so it goes through the URL parser and accepts whatever normalises
 * to a loopback host (`http://127.1/` among them), because the browser resolves
 * that form to loopback anyway. Here the string goes to `server.listen`, which does
 * no such normalising.
 */
function isLoopbackHost(host) {
  const normalized = host.toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized)) return true;

  const octets = normalized.split(".");
  if (octets.length !== 4) return false;
  if (octets[0] !== "127") return false;

  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    if (octet.length > 1 && octet.startsWith("0")) return false;
    return Number(octet) <= 255;
  });
}

/**
 * The issuer (D7): an absolute URL with an explicit scheme, and nothing else.
 *
 *   http://host.local:26006          accepted
 *   host.local:26006                 refused: no scheme
 *   http://host.local:26006/         refused: trailing slash
 *   http://host.local:26006/sso      refused: path
 *
 * This one string is consumed in three ways, each unforgiving in a different place.
 *
 * A scheme is required because the EVE client turns a token's `iss` into a discovery
 * URL by parsing it and, if there is no scheme, inserting `https`, which under D1's
 * plain HTTP reaches nothing. The scheme-less spelling `host.local:26006` also parses
 * with `host.local` as the scheme and `26006` as the path. CCP can use a bare hostname
 * only because CCP is on `https`. See docs/d6-listener-split.md.
 *
 * Only `http` or `https`, because the issuer is fetched, not merely compared: the
 * client GETs `<issuer>/.well-known/...` on every launch. A valid `ftp://` or `urn:`
 * issuer would pass every other rule and be unreachable by that client.
 *
 * No path, trailing slash, query or fragment, because the discovery document's
 * absolute URLs are built by concatenation and clients string-compare `issuer` byte
 * for byte. A trailing slash yields `http://host:26006//oauth/jwks`. The client's
 * derivation discards a path anyway (Finding 1 in the D6 spike), so accepting one
 * would configure a surface that cannot be reached.
 *
 * No credentials, because this string is published in the discovery document and
 * embedded in every token this replica signs.
 *
 * Already canonical, checked last as a backstop: whatever a URL parser would rewrite
 * (an uppercase host, a default port written out) is refused with the canonical
 * spelling in the message rather than normalized. Normalizing would put one string
 * in the config and another in the tokens, and a client validating `iss` compares
 * exactly that difference.
 */
function parseIssuer(raw, errors) {
  if (raw === "") return null;

  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    errors.push(
      `${KEY_SSO_ISSUER} must be an absolute URL with an explicit scheme, got "${raw}": ` +
        `for example "http://host.local:26006" (decision D7).`,
    );
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // `new URL("host.local:26006")` does not throw. It parses with `host.local` as the
    // scheme, `26006` as an opaque path and no host (see docs/d6-listener-split.md). It
    // is the most likely thing an operator will type here, because it is how CCP writes
    // `iss` and how a host and port are usually written, so it is diagnosed as a missing
    // scheme rather than as an unsupported one.
    if (url.hostname === "") {
      errors.push(
        `${KEY_SSO_ISSUER} must be an absolute URL with an explicit scheme, got "${raw}": ` +
          `a URL parser reads "${url.protocol.slice(0, -1)}" there as the scheme. Write ` +
          `"http://${raw}" (decision D7).`,
      );
      return null;
    }

    errors.push(
      `${KEY_SSO_ISSUER} must use http or https, got "${raw}": the issuer is fetched by ` +
        `clients (they GET <issuer>/.well-known/oauth-authorization-server/), not just compared.`,
    );
    return null;
  }

  if (url.username !== "" || url.password !== "") {
    errors.push(
      `${KEY_SSO_ISSUER} must not carry credentials: this string is published in the ` +
        `discovery document and in every issued token.`,
    );
    return null;
  }

  if (url.hostname === "") {
    errors.push(`${KEY_SSO_ISSUER} must name a host, got "${raw}".`);
    return null;
  }

  // Before the path check, because `new URL` reports a bare trailing slash as
  // the empty path `/` and the two deserve different messages.
  if (raw.endsWith("/")) {
    errors.push(
      `${KEY_SSO_ISSUER} must not end with a slash, got "${raw}": D7 fixes the issuer as ` +
        `scheme, host and port only, and the discovery document's URLs are built by ` +
        `appending to it.`,
    );
    return null;
  }

  if (url.pathname !== "/") {
    errors.push(
      `${KEY_SSO_ISSUER} must not carry a path, got "${raw}": the EVE client discards the ` +
        `path when it derives the discovery URL from a token, so a path-prefixed SSO surface ` +
        `is unreachable (decision D6).`,
    );
    return null;
  }

  if (url.search !== "" || url.hash !== "") {
    errors.push(
      `${KEY_SSO_ISSUER} must not carry a query string or a fragment, got "${raw}".`,
    );
    return null;
  }

  const canonical = `${url.protocol}//${url.host}`;
  if (raw !== canonical) {
    errors.push(
      `${KEY_SSO_ISSUER} is "${raw}", which a URL parser rewrites as "${canonical}". Write ` +
        `it that way. Clients compare the issuer as a string, so the configured spelling and ` +
        `the one a client derives have to be the same bytes.`,
    );
    return null;
  }

  return raw;
}

// "1"/"true"/"yes"/"on" are true, case-insensitively. Everything else, a typo
// included, is false. That is the safe direction, because every flag in this mod
// grants something.
function parseBoolean(raw) {
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function parseCharacterID(raw, envKey, errors) {
  if (!/^[0-9]+$/.test(raw)) {
    errors.push(`${envKey} must be a whole number, got "${raw}".`);
    return null;
  }

  const id = Number(raw);
  // eve.js allocates character IDs well inside the safe-integer range; a value
  // outside it is a mistyped ID, and comparing it against a real one later
  // would silently succeed against the wrong character.
  if (!Number.isSafeInteger(id) || id <= 0) {
    errors.push(`${envKey} must be a positive character ID, got "${raw}".`);
    return null;
  }

  return id;
}

/**
 * How many errors a caller may spend in a 60 second window before the error limiter
 * answers `420` (`lib/errorLimiter.js` `MAX_ERRORS`, D44). An override: leaving it
 * empty is the normal case, and unset, the budget is CCP's observed 100,
 * byte-identical to what a client sees from Tranquility.
 *
 * It exists for one shape of deployment: a private server whose known clients
 * enumerate every character they hold at startup and ask about all of them in one
 * burst, where the characters this server has never heard of are honest `404`s.
 * CCP's limiter cannot tell those from a client hammering nonexistent resources,
 * which is the threat it deters and which such a server does not have. Other
 * deployments never touch this key and do not diverge from CCP.
 *
 * A whole number, same shape as `parsePort` and `parseCharacterID`: no decimals, no
 * sign, nothing `Number()` would coerce leniently. `0` is refused: a limiter with no
 * budget is a different feature, and the way to disable a listener is
 * `ESI_MOD_ESI_PORT`.
 */
function parseErrorLimitMaxErrors(raw, errors) {
  if (raw === "") return DEFAULTS.errorLimitMaxErrors;

  if (!/^[0-9]+$/.test(raw)) {
    errors.push(`${KEY_ERROR_LIMIT_MAX_ERRORS} must be a whole number, got "${raw}".`);
    return null;
  }

  const value = Number(raw);
  // Safe-integer, the ceiling `parseCharacterID` also applies: past it `Number()` is
  // inexact and the mod would enforce a budget nobody typed.
  if (!Number.isSafeInteger(value) || value < 1) {
    errors.push(
      `${KEY_ERROR_LIMIT_MAX_ERRORS} must be a positive whole number, got "${raw}".`,
    );
    return null;
  }

  return value;
}

/**
 * Where the mod's three durable SSO credentials live. An override over the directory;
 * absence is the normal case.
 *
 * `<game store root>/../sso/` holds the signing key (D8), the refresh-token store
 * (D30) and the `owner` salt. `lib/runtimeAccess.js` derives that directory as a
 * sibling of the game store, beside `sde/` and `market/`, which suits every deployment
 * with a game store. This names it for those without one:
 *
 *   A boot with no game tree to derive from, such as a diagnostic boot. Deriving needs
 *   a live game store, so without this setting such an environment could not name the
 *   salt or the store, and loading them at startup would make it unstartable.
 *
 *   A store root that moves, or a volume chosen to outlive it.
 *
 * One setting over the directory, not one per file. D30 refused the refresh-token
 * store an override of its own: nobody supplies their own token store, and the only
 * reason to move one is to move the whole `sso/` directory. The salt is the same.
 * Per-file settings would also let a deployment scatter three secrets that must be
 * backed up together, and "back up `sso/`" is what keeps this replica recoverable.
 *
 * `ESI_MOD_SIGNING_KEY_PATH` is kept as the narrower override, for an operator
 * supplying a key they generated: D8 chose PKCS#8 so an `openssl genpkey` key drops
 * straight in, and such a key plausibly lives wherever they keep keys. Removing it
 * would break deployments that may use it. The key resolves configured file, else
 * configured directory, else derived; the other two resolve configured directory,
 * else derived. `loader.js` applies that order, because it is where configuration and
 * the runtime meet.
 *
 * A deployment that sets the file override has one credential outside the directory,
 * so "back up `sso/`" is incomplete for it. That is not warned about here: it is the
 * case the override exists for, and a warning on every boot of a deliberate
 * configuration teaches operators to ignore the console. `.env.example` says it where
 * the operator setting it is looking.
 */
function parseSsoStateDir(raw, errors) {
  if (raw === "") return null;

  if (!path.isAbsolute(raw)) {
    // As for every other path in this file: a relative path resolves against the game
    // server's working directory, which this mod does not set or know, and which the
    // world process, the forked edge processes and the healthcheck do not agree on.
    errors.push(`${KEY_SSO_STATE_DIR} must be an absolute path, got "${raw}".`);
    return null;
  }

  const resolved = path.resolve(raw);
  if (isInsideModDirectory(resolved)) {
    // Refused, where `parseSigningKeyPath` below only warns for the same mistake.
    //
    // Refused here because this directory is where the mod creates three secrets, two of
    // which exist nowhere else once written. `<eve.js tree>/mods/esiApi/` is a copy a redeploy
    // replaces wholesale (D21), so the next `node scripts/deploy-mod.js` deletes all
    // three: the signing key, the salt whose loss re-authorises every character, and the
    // store whose loss logs every tool out (D30). No deployment means that, the same test
    // as the dev-auto-approve-off-loopback error above.
    //
    // Only a warning for the key, because tightening that one would make a deployment
    // that works today go inert on upgrade. A config change that stops a running server
    // is worse than the failure it prevents, and this newer setting has no installed base
    // to break.
    errors.push(
      `${KEY_SSO_STATE_DIR} points inside the mod directory: a redeploy replaces that ` +
        `directory wholesale (D21), destroying the signing key, the owner salt and every ` +
        `refresh token in one step (D8, D30). Name a directory outside the mod.`,
    );
    return null;
  }

  return resolved;
}

/**
 * Where the signing key lives. An override; absence is the normal case.
 *
 * Unlike `ESI_MOD_SSO_ISSUER`, whose value no derivation could supply, this has a
 * derived location: `lib/runtimeAccess.js`'s `getSigningKeyPath()` answers
 * `<game store root>/../sso/signing-key.pem`, a sibling of `sde/` and `market/`,
 * from where the game keeps its state. So `null` here means "use the derived
 * location", which suits almost every deployment.
 *
 * The caller applies the order, configured else derived: `lib/runtimeAccess.js` reads
 * no configuration and `lib/signingKey.js` takes the path as an argument, which makes
 * both testable without a game or an operator. `loader.js` is where the two meet.
 *
 * Since `ESI_MOD_SSO_STATE_DIR` covers moving the whole directory, this override is
 * for a key the operator supplied. D8 chose PKCS#8 so an `openssl genpkey` key drops
 * straight in, and such a key lives wherever that operator keeps keys. The salt and
 * the token store have no such purpose, because nobody brings their own.
 *
 * Moving the store root and sharing a key between two replicas belong to the directory
 * setting: doing them through this one moves a single file and leaves the other two
 * credentials behind.
 *
 * D8 is why the location matters: a key that dies with its directory invalidates every
 * refresh token every tool is holding.
 */
function parseSigningKeyPath(raw, warnings, errors) {
  if (raw === "") return null;

  if (!path.isAbsolute(raw)) {
    // A relative path resolves against the game server's working directory, which this
    // mod does not set or know: the healthcheck, the forked edge processes and the world
    // process do not all agree on it. Refusing is better than signing tokens with a key
    // from a directory nobody can name.
    errors.push(`${KEY_SIGNING_KEY_PATH} must be an absolute path, got "${raw}".`);
    return null;
  }

  const resolved = path.resolve(raw);
  if (isInsideModDirectory(resolved)) {
    // D8: the key has to outlive the mod directory. <eve.js tree>/mods/esiApi/ is replaced
    // wholesale on every deploy, and a key that dies with it invalidates every refresh
    // token every tool is holding.
    warnings.push(
      `${KEY_SIGNING_KEY_PATH} points inside the mod directory: a redeploy replaces ` +
        `that directory and would invalidate every issued token (decision D8).`,
    );
  }

  return resolved;
}

function isInsideModDirectory(candidate) {
  const relative = path.relative(__dirname, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Where the client allowlist lives: a path to a JSON file. Absence is the normal case.
 *
 * A file rather than a variable, because `.env` is flat `KEY=VALUE` and this setting is
 * a list of clients each holding a list of URIs. A single string needs a separator, and
 * `,`, `;`, `|` and whitespace are all legal inside a redirect URI's query string. A
 * numbered-key scheme (`..._CLIENT_1_URIS`) puts the structure in the names, where the
 * parser cannot tell a numbering gap from a typo. JSON brings nesting and quoting from
 * a parser already in the runtime, while a bespoke format would be a bespoke parser
 * inside the game server's process, in a mod with no dependencies (D5/D20).
 *
 * Its lifecycle also differs. `.env` holds this deployment's transport (ports, bind
 * hosts, the signing key path) and is gitignored because of that path. The permitted
 * clients change when the ecosystem changes, and an operator may want to mount them
 * read-only into a container.
 *
 * This can be a credential file: an entry may carry an optional `client_secret`, so a
 * file with one confidential client belongs with the deployment's other credentials,
 * not in version control, and a copy of it is a copy of every configured client's
 * password.
 *
 * Absolute, for the same reason as `ESI_MOD_SIGNING_KEY_PATH`: a relative path resolves
 * against the game server's working directory, which this mod does not set or know, and
 * which the world process, the forked edge processes and the healthcheck do not agree on.
 *
 * Absent means no allowlist, silently. A replica whose clients are all native tools needs
 * no file, and a warning here would dilute the ones that matter (dev auto-approve, a
 * non-loopback bind host).
 */
function parseClientsPath(raw, errors, warnings) {
  if (raw === "") return null;

  if (!path.isAbsolute(raw)) {
    errors.push(`${KEY_SSO_CLIENTS_PATH} must be an absolute path, got "${raw}".`);
    return null;
  }

  const resolved = path.resolve(raw);
  if (isInsideModDirectory(resolved)) {
    // A warning, as for the signing key: it works until the folder is replaced.
    warnings.push(
      `${KEY_SSO_CLIENTS_PATH} points inside the mod directory: a launcher update or a ` +
        `redeploy replaces that directory and loses the file (D21, D47). Keep it outside the mod.`,
    );
  }

  return resolved;
}

function parseLogLevel(raw, warnings) {
  if (raw === "") return DEFAULTS.logLevel;

  const level = raw.toLowerCase();
  if (!LOG_LEVELS.includes(level)) {
    warnings.push(
      `${KEY_LOG_LEVEL} is "${raw}", which is not one of ${LOG_LEVELS.join(", ")}, ` +
        `using "${DEFAULTS.logLevel}".`,
    );
    return DEFAULTS.logLevel;
  }

  return level;
}

// The pure core
function parseConfigFromEnv(env) {
  const errors = [];
  const warnings = [];

  // ESI listener. Absent takes the default, blank means off (D47).
  const esiPortRaw = readEnv(env, KEY_ESI_PORT);
  let esiPort = DEFAULTS.esiPort;
  if (isPresent(env, KEY_ESI_PORT)) {
    esiPort = esiPortRaw === "" ? null : parsePort(esiPortRaw, KEY_ESI_PORT, errors);
  }
  if (esiPort !== null) refuseGamePort(esiPort, KEY_ESI_PORT, errors);

  const esiBindHost = parseBindHost(
    readEnv(env, KEY_ESI_BIND_HOST),
    KEY_ESI_BIND_HOST,
    errors,
    warnings,
    DEFAULTS.esiBindHost,
  );

  // SSO listener. D6 settled on two listeners on two ports, and the issuer arms the
  // second: with an issuer the mod binds `ssoBindHost:ssoPort` and serves the SSO surface
  // from its root; blank, there is no SSO listener and the port and bind host below are
  // parsed and then unused.
  //
  // They are validated either way, so a broken value cannot wait to surface until
  // somebody sets the issuer.
  //
  // No warning for a blank issuer. A replica that serves public ESI reads and no tokens is
  // a complete configuration, and the boot banner says so once.
  const ssoPortRaw = readEnv(env, KEY_SSO_PORT);
  const ssoPort =
    ssoPortRaw === ""
      ? DEFAULTS.ssoPort
      : parsePort(ssoPortRaw, KEY_SSO_PORT, errors) ?? DEFAULTS.ssoPort;
  refuseGamePort(ssoPort, KEY_SSO_PORT, errors);

  const ssoBindHost = parseBindHost(
    readEnv(env, KEY_SSO_BIND_HOST),
    KEY_SSO_BIND_HOST,
    errors,
    warnings,
    DEFAULTS.ssoBindHost,
  );

  const ssoIssuer = isPresent(env, KEY_SSO_ISSUER)
    ? parseIssuer(readEnv(env, KEY_SSO_ISSUER), errors)
    : DEFAULTS.ssoIssuer;

  // A warning, not an error: tools fetch the issuer and the listener binds the port, and
  // a port mapping or a proxy in front can legitimately make the two numbers differ.
  // `parseIssuer` has already accepted the string, so this URL parses.
  if (ssoIssuer !== null) {
    const issuerUrl = new URL(ssoIssuer);
    const issuerPort = issuerUrl.port !== ""
      ? Number(issuerUrl.port)
      : issuerUrl.protocol === "https:" ? 443 : 80;
    if (issuerPort !== ssoPort) {
      warnings.push(
        `${KEY_SSO_PORT} is ${ssoPort} but ${KEY_SSO_ISSUER} names port ${issuerPort}. Tools ` +
          `fetch the issuer, so they reach the SSO listener only if a port mapping or proxy ` +
          `forwards ${issuerPort} to ${ssoPort}.`,
      );
    }
  }

  // Only the path is decided here, because reading the file is filesystem access and this
  // function is the pure core. `loadConfig` reads it through `readClientsFile` and fills
  // `ssoClients` in, as it does for `.env`. A caller of `parseConfigFromEnv` alone
  // therefore sees the empty allowlist, the same as an operator who configured no file.
  const ssoClientsPath = parseClientsPath(readEnv(env, KEY_SSO_CLIENTS_PATH), errors, warnings);

  // Whether a port collision is fatal depends on the issuer.
  //
  // With no issuer nothing binds the SSO port, so the conflict is notional and a working
  // ESI-only deployment must not go inert over it: warning.
  //
  // With an issuer both listeners are armed and one cannot start: error. The whole mod
  // going inert is better than the alternative, where which listener wins depends on
  // which calls `listen` first, so one configuration produces an unreachable SSO or an
  // unreachable ESI depending on timing, and the operator sees an EADDRINUSE naming a port
  // rather than the two settings that collided.
  if (esiPort !== null && esiPort === ssoPort) {
    const message =
      `${KEY_ESI_PORT} and ${KEY_SSO_PORT} are both ${esiPort}: two listeners cannot ` +
      `share a port. Decision D6 puts ESI and SSO on separate ports, each owning the ` +
      `root of its own origin.`;
    if (ssoIssuer === null) {
      warnings.push(
        `${message} Harmless while ${KEY_SSO_ISSUER} is blank, because no SSO listener ` +
          `starts, but it becomes fatal the moment one does.`,
      );
    } else {
      errors.push(
        `${message} ${KEY_SSO_ISSUER} is set, so both listeners would start and one of ` +
          `them could not bind.`,
      );
    }
  }

  // Dev auto-approve (D3). The bind-code flow is the real grant: the game session is the
  // only unforgeable source of character identity. This flag skips it so automated tests
  // do not need a live session, and is never the default.
  const devAutoApprove = parseBoolean(readEnv(env, KEY_DEV_AUTO_APPROVE));
  const characterIDRaw = readEnv(env, KEY_DEV_AUTO_APPROVE_CHARACTER_ID);
  let devAutoApproveCharacterID = DEFAULTS.devAutoApproveCharacterID;
  if (characterIDRaw !== "") {
    devAutoApproveCharacterID = parseCharacterID(
      characterIDRaw,
      KEY_DEV_AUTO_APPROVE_CHARACTER_ID,
      errors,
    );
  }

  if (devAutoApprove) {
    if (devAutoApproveCharacterID === null && characterIDRaw === "") {
      // Auto-approve with no target has nothing to approve as. An error, because the flag was
      // set deliberately and cannot do what it was set to do.
      //
      // There is no "pick the first character" fallback, here or downstream. It would make the
      // identity this replica hands out depend on the game's iteration order, so one
      // configuration could issue tokens for different characters on different days with
      // nothing reporting the change. The operator must state whose data they are giving away.
      errors.push(
        `${KEY_DEV_AUTO_APPROVE} is on but ${KEY_DEV_AUTO_APPROVE_CHARACTER_ID} is not ` +
          `set: auto-approve has no character to issue tokens for.`,
      );
    }
    // Auto-approve with a listener off loopback is a configuration error, not a warning.
    //
    // The flag hands a token for a named character to whoever asks, with no proof of
    // anything, so its reach is exactly the set of machines that can reach the SSO port. On
    // loopback that is the development host the flag exists for. Off loopback it is the
    // network: anyone's tooling gets authenticated access to a real character's assets,
    // wallet and mail, over plain HTTP (D1).
    //
    // The non-loopback bind host already warns on its own, and this combination is never
    // wanted, so a second warning is not enough. Refusing costs a deliberate operator one
    // edit and a restart. The mod going inert is the safe direction, the same one taken for
    // a port collision.
    if (!isLoopbackHost(ssoBindHost)) {
      errors.push(
        `${KEY_DEV_AUTO_APPROVE} is on and ${KEY_SSO_BIND_HOST} is "${ssoBindHost}", which is ` +
          `not a loopback address. Auto-approve issues a token for character ` +
          `${devAutoApproveCharacterID === null ? "?" : devAutoApproveCharacterID} to anyone ` +
          `who asks, without any proof of identity, so with the SSO listener on the network, ` +
          `every machine that can reach it can read and act on that character's data. Bind SSO ` +
          `to 127.0.0.1, or turn ${KEY_DEV_AUTO_APPROVE} off.`,
      );
    }

    warnings.push(
      `${KEY_DEV_AUTO_APPROVE} is on: any caller can obtain a token for character ` +
        `${devAutoApproveCharacterID === null ? "?" : devAutoApproveCharacterID} without ` +
        `proving identity in-game. Development only; never on a deployment you care about.`,
    );
  } else if (devAutoApproveCharacterID !== null) {
    warnings.push(
      `${KEY_DEV_AUTO_APPROVE_CHARACTER_ID} is set but ${KEY_DEV_AUTO_APPROVE} is off: ` +
        `it will not be used.`,
    );
  }

  // The `sso/` directory, then the one file inside it with its own override. Both are
  // validated whether or not an issuer arms the SSO listener, as the port and bind host
  // are, so a broken value cannot wait to surface until somebody sets the issuer.
  const ssoStateDir = parseSsoStateDir(readEnv(env, KEY_SSO_STATE_DIR), errors);

  const signingKeyPath = parseSigningKeyPath(
    readEnv(env, KEY_SIGNING_KEY_PATH),
    warnings,
    errors,
  );

  // D44. No warning when unset, as with the SSO port above: unset is CCP's observed budget,
  // a complete and correct configuration.
  const errorLimitMaxErrorsRaw = readEnv(env, KEY_ERROR_LIMIT_MAX_ERRORS);
  const errorLimitMaxErrors =
    errorLimitMaxErrorsRaw === ""
      ? DEFAULTS.errorLimitMaxErrors
      : parseErrorLimitMaxErrors(errorLimitMaxErrorsRaw, errors) ?? DEFAULTS.errorLimitMaxErrors;

  const logLevel = parseLogLevel(readEnv(env, KEY_LOG_LEVEL), warnings);

  return Object.freeze({
    // Two ways to be unusable, which mean different things (see the file header). Both leave
    // the mod inert; only one is a fault.
    ok: errors.length === 0 && (esiPort !== null || ssoIssuer !== null),
    config: Object.freeze({
      modVersion: MOD_VERSION,
      esiBindHost,
      esiPort,
      ssoBindHost,
      ssoPort,
      ssoIssuer,
      ssoClientsPath,
      ssoClients: DEFAULTS.ssoClients,
      ssoStateDir,
      devAutoApprove,
      devAutoApproveCharacterID,
      signingKeyPath,
      errorLimitMaxErrors,
      logLevel,
    }),
    warnings: Object.freeze(warnings),
    // Only `loadConfig` knows the layers, so only it has anything to say here.
    notices: Object.freeze([]),
    errors: Object.freeze(errors),
  });
}

// The .env parser, a second pure core
// Text in, `{ values, warnings }` out. No filesystem, no process.env, never throws.
// `values` is an env-like object, which parseConfigFromEnv already consumes.
//
// Not `process.loadEnvFile()`, which exists on Node 24 but mutates the global
// `process.env`. This mod is a `--require` preload sharing that environment with the game
// server and every other mod, and NODE_OPTIONS means the mutation would happen in all ~7
// processes eve.js forks. Parsing into a local object has no such side effect.
//
// Format, a deliberately small subset of what shells accept:
//   KEY=value            trimmed on both sides
//   KEY="value"          matching quotes stripped, inner spacing kept
//   # comment            whole-line only
//   blank lines          ignored
//
// A `#` after a value is not an inline comment: guessing where a comment starts inside an
// opaque value risks truncating it, so the value is everything after the first `=`. The
// field parsers above catch what this lets through, because a value that swallowed a
// comment fails the number, whitespace or path checks.
function parseEnvFile(text, fileName = ENV_FILE_NAME) {
  const values = {};
  const warnings = [];
  let suppressed = 0;

  function warn(message) {
    if (warnings.length < MAX_ENV_FILE_WARNINGS) warnings.push(message);
    else suppressed += 1;
  }

  if (typeof text === "string") {
    // An editor on this host writes CRLF and may prefix a BOM; the repository
    // normalizes to LF (.gitattributes).  Both have to read the same.
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const lines = body.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const line = lines[index].trim();
      if (line === "" || line.startsWith("#")) continue;

      const separator = line.indexOf("=");
      if (separator === -1) {
        // Line numbers only, never the line's content. The malformed line may be the one naming
        // a private key, and this goes to the game server's console.
        warn(`${fileName} line ${lineNumber}: expected KEY=VALUE, ignoring the line.`);
        continue;
      }

      const key = line.slice(0, separator).trim();
      if (key === "") {
        warn(`${fileName} line ${lineNumber}: no name before "=", ignoring the line.`);
        continue;
      }
      if (!ENV_NAME_PATTERN.test(key)) {
        // The name is not echoed either: on an `export FOO=bar` line the "name" is two words, and
        // one rule is simpler than its exceptions.
        warn(
          `${fileName} line ${lineNumber}: the name before "=" is not a valid ` +
            `variable name, ignoring the line.`,
        );
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(values, key)) {
        warn(
          `${fileName} line ${lineNumber}: ${key} is set more than once: the last one wins.`,
        );
      } else if (key.startsWith(ENV_PREFIX) && !KNOWN_ENV_KEYS.has(key)) {
        // Only inside our own prefix. A `.env` may legitimately carry settings for something
        // else, and warnings about variables this parser does not own would be noise.
        warn(`${fileName} line ${lineNumber}: ${key} is not a setting this mod reads. Typo?`);
      }

      values[key] = unquote(line.slice(separator + 1).trim());
    }
  }

  if (suppressed > 0) {
    warnings.push(`${fileName}: ${suppressed} further problem(s) not listed.`);
  }

  return Object.freeze({
    values: Object.freeze(values),
    warnings: Object.freeze(warnings),
  });
}

function unquote(raw) {
  if (raw.length < 2) return raw;
  const first = raw[0];
  if ((first === '"' || first === "'") && raw[raw.length - 1] === first) {
    return raw.slice(1, -1);
  }
  return raw;
}

// Reading that file
// The only filesystem access in the mod's configuration path. Absent is normal
// (configuration may come from compose), so it is silent. Anything else (permissions, a
// directory in its place, an I/O error) is a warning, and the mod carries on with what the
// environment gave it, the same degradation as a bad value.
function readEnvFile(filePath) {
  const fileName = path.basename(filePath);
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err && err.code) || "unknown error";
    if (code === "ENOENT") return parseEnvFile(null, fileName);
    return Object.freeze({
      values: Object.freeze({}),
      warnings: Object.freeze([
        `${fileName} is present but could not be read (${code}), continuing without it.`,
      ]),
    });
  }
  return parseEnvFile(text, fileName);
}

// settings.json, the launcher form's file (D47)
// Text in, `{ values, warnings }` out, the same shape as `parseEnvFile`, so the values
// enter the existing parsers as strings. Never throws. A warning names a key at most and
// never a value.
function parseSettingsFile(text) {
  const values = {};
  const warnings = [];
  let suppressed = 0;

  function warn(message) {
    if (warnings.length < MAX_ENV_FILE_WARNINGS) warnings.push(message);
    else suppressed += 1;
  }

  const body = typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let document = null;
  try {
    document = JSON.parse(body);
  } catch (_) {
    warn(`${SETTINGS_FILE_NAME} is not valid JSON: ignoring the whole file.`);
  }

  if (document !== null && typeof document === "object" && !Array.isArray(document)) {
    for (const key of Object.keys(document)) {
      const label = ENV_NAME_PATTERN.test(key) ? `"${key}"` : "a key";

      if (!Object.prototype.hasOwnProperty.call(SETTINGS_ENV_KEYS, key)) {
        warn(`${SETTINGS_FILE_NAME}: ${label} is not a setting this file can set: ignoring it.`);
        continue;
      }

      const value = document[key];
      const scalar = typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
      if (!scalar) {
        warn(`${SETTINGS_FILE_NAME}: ${label} must be text or a number: ignoring it.`);
        continue;
      }

      // A launcher integer field cannot be blank, so 0 is how the form says off.
      const raw = String(value);
      values[SETTINGS_ENV_KEYS[key]] = key === "esiPort" && raw.trim() === "0" ? "" : raw;
    }
  } else if (warnings.length === 0) {
    warn(`${SETTINGS_FILE_NAME} must hold a JSON object: ignoring the whole file.`);
  }

  if (suppressed > 0) {
    warnings.push(`${SETTINGS_FILE_NAME}: ${suppressed} further problem(s) not listed.`);
  }

  return Object.freeze({
    values: Object.freeze(values),
    warnings: Object.freeze(warnings),
  });
}

// Absent is the normal case: the launcher creates this file on the first change.
function readSettingsFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err && err.code) || "unknown error";
    return Object.freeze({
      values: Object.freeze({}),
      warnings: Object.freeze(code === "ENOENT" ? [] : [
        `${SETTINGS_FILE_NAME} is present but could not be read (${code}): continuing without it.`,
      ]),
    });
  }
  return parseSettingsFile(text);
}

// The client allowlist, a third pure core
// Text in, `{ clients, errors }` out. No filesystem, never throws, the same split as
// `parseEnvFile` / `readEnvFile`, so a test can state the shape rules without a temp
// directory.
//
// The file's spelling is snake_case (`client_id`, `redirect_uris`), because its values
// are copied from an OAuth client's configuration, where those are the parameter names.
// The config object uses `clientId` and `redirectUris`, which `lib/clientRegistry.js`
// consumes. One translation, in one place.
//
// Checked here is shape: an object with a `clients` array, each entry a `client_id`
// string and a non-empty `redirect_uris` array of strings. What makes a redirect URI usable
// (absolute, no credentials, no fragment) is decided only by `lib/clientRegistry.js`, the
// module that compares a configured URI with an incoming one, because two separate opinions
// could let through what the other would refuse. It throws at construction, so an unusable
// URI is still a startup failure.
//
// The optional `client_secret`
// An entry may carry a `client_secret`, passed through untouched as `clientSecret`,
// including a value that is not a string. `clientRegistry` owns every rule about the value:
// the type test, a length floor and ceiling, a character set, and refusing one on the `"*"`
// entry. A copy of the type test here would produce two messages for one mistake and could
// drift. So the rule here is "the key is absent or passed on", and a bad value throws at
// construction in that module and takes the SSO surface down: a startup failure, not one at
// a token exchange.
//
// It is a secret: `describeConfig` must never render it (see `describeClients`, which
// counts and does not enumerate), and the allowlist file should not be kept in version
// control.
//
// When inventing a secret, stay inside `A-Z a-z 0-9 . _ -`. Every character in that set is
// a fixed point of `application/x-www-form-urlencoded`, which lets the token endpoint
// decode strictly and still authenticate a client that forgot to encode its secret. `~` is
// outside it on purpose: `encodeURIComponent` leaves it alone and the WHATWG form
// serializer percent-encodes it, so a secret containing one has two spellings on the wire,
// depending on the client's library. `openssl rand -hex 32` stays inside the set.
//
// With no secret configured anywhere (the default, and every deployment that never writes
// this file), no client can authenticate. `routes/oauthAuthorize.js` accepts an authorize
// request with no `code_challenge` on RFC 8414 section 2's reading, but redemption requires
// a code minted without a challenge to come from a client that authenticated, so such a
// code is unredeemable. This is the safe direction, not a bug. It means the tolerance of a
// missing `code_challenge` buys nothing out of the box, and the failure shows up at the
// token exchange, one HTTP round trip after its cause.
//
// Every problem is collected rather than thrown on the first, so a hand-edited list with
// three typos costs one restart, not three.
function parseClientsFile(text, filePath) {
  const errors = [];
  const where = filePath ? `${KEY_SSO_CLIENTS_PATH} (${filePath})` : KEY_SSO_CLIENTS_PATH;
  const shape =
    `Expected {"clients":[{"client_id":"...","redirect_uris":["http://127.0.0.1:8080/callback"]}]}.`;

  let document;
  try {
    document = JSON.parse(text);
  } catch (err) {
    // The parser's own message names the line and column, which is what fixing a JSON file
    // needs.
    errors.push(`${where} is not valid JSON: ${(err && err.message) || "parse error"}.`);
    return frozenClients([], errors);
  }

  if (
    document === null
    || typeof document !== "object"
    || Array.isArray(document)
    || !Array.isArray(document.clients)
  ) {
    errors.push(`${where} must be a JSON object carrying a "clients" array. ${shape}`);
    return frozenClients([], errors);
  }

  const clients = [];
  document.clients.forEach((entry, index) => {
    // One-based, because the operator is counting entries in a file rather
    // than indexing an array.
    const label = `${where} client #${index + 1}`;

    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} is not an object. ${shape}`);
      return;
    }

    const clientId = entry.client_id;
    if (typeof clientId !== "string" || clientId.trim() === "") {
      errors.push(
        `${label} has no "client_id" string. Every entry needs one; use "*" as the client_id `
          + `to list a redirect URI that any client may use, which is the right answer when the `
          + `tool's client_id was issued by CCP and you cannot know it.`,
      );
      return;
    }

    const redirectUris = entry.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      errors.push(
        `${label} (${clientId}) has no "redirect_uris" array. An entry that permits no URI `
          + `permits nothing, so it is a half-written line rather than a configuration.`,
      );
      return;
    }

    if (!redirectUris.every((uri) => typeof uri === "string" && uri.trim() !== "")) {
      errors.push(`${label} (${clientId}) lists a redirect URI that is not a non-empty string.`);
      return;
    }

    const client = { clientId, redirectUris: Object.freeze([...redirectUris]) };

    // Own property only, as in `readEnv`: a `client_secret` reached through a prototype is not
    // something an operator wrote in a file. The key is copied only when present, so an entry
    // without one reaches the registry with `clientSecret` absent, which is how that module
    // recognises a public client. That is the normal case: a native tool on a loopback redirect
    // has nowhere to keep a secret (RFC 8252 section 8.5).
    if (Object.prototype.hasOwnProperty.call(entry, "client_secret")) {
      client.clientSecret = entry.client_secret;
    }

    clients.push(Object.freeze(client));
  });

  return frozenClients(clients, errors);
}

function frozenClients(clients, errors) {
  return Object.freeze({
    clients: Object.freeze(clients),
    errors: Object.freeze(errors),
  });
}

/**
 * Read and parse the allowlist named by `ESI_MOD_SSO_CLIENTS_PATH`.
 *
 * A missing file is an error here, unlike `.env`. Not setting the key means "no allowlist",
 * silently. Setting it to a path holding nothing means the operator got a location wrong,
 * and letting that pass gives a deployment that starts cleanly and then refuses every
 * browser-based client with nothing printed to say why.
 */
function readClientsFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err && err.code) || "unknown error";
    return frozenClients([], [
      `${KEY_SSO_CLIENTS_PATH} names "${filePath}", which could not be read (${code}). Leave `
        + `the key unset for no allowlist (every loopback redirect URI still works), or point `
        + `it at a file that exists.`,
    ]);
  }
  return parseClientsFile(text, filePath);
}

/**
 * Env keys of the armed listeners bound to loopback. Inside a container that is
 * the wrong address: a published port reaches the container's external interface,
 * so the listener starts cleanly and the port refuses connections. `loader.js`
 * decides whether this is a container, which keeps this file pure.
 */
function loopbackListenersInContainer(config) {
  const keys = [];
  if (config.esiPort !== null && isLoopbackHost(config.esiBindHost)) keys.push(KEY_ESI_BIND_HOST);
  if (config.ssoIssuer !== null && isLoopbackHost(config.ssoBindHost)) keys.push(KEY_SSO_BIND_HOST);
  return Object.freeze(keys);
}

// Redacted rendering
// Everything that logs config goes through this (the boot banner, the health route, an
// error path). Nothing else may render a config object, because a startup banner ends up in
// screenshots of a server console and in pasted bug reports.
//
// Tolerates junk instead of throwing: it is called from logging, and logging that throws
// while reporting a problem hides the problem.
function describeConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  return {
    modVersion: source.modVersion || MOD_VERSION,
    // null reads as "no listener", which is accurate for the inert state. Printing 26005 there
    // would misreport what is bound.
    esiListener: describeListener(source.esiBindHost, source.esiPort),
    // The issuer arms this listener, so it decides whether there is one to describe.
    // `ssoBindHost:ssoPort` have values whether or not anything binds them, and printing them
    // for a listener that will not start would misreport what is bound, as with `esiPort`
    // above.
    ssoListener: source.ssoIssuer
      ? describeListener(source.ssoBindHost, source.ssoPort)
      : "disabled",
    // Printed in full, unlike the signing key path. It is not a secret: it goes into every
    // token this replica signs and every client fetches it, and an operator needs to check the
    // exact bytes it resolved to.
    ssoIssuer: source.ssoIssuer || "unset",
    // A count, not the list. The URIs are not secret (they are addresses a browser is sent to),
    // but a banner confirms that what was configured is what loaded, and "3 client(s), 4
    // redirect URI(s)" does that in one line. The path is omitted for the same reason: the
    // count says whether the file was found.
    ssoClients: describeClients(source.ssoClients),
    // "set"/"unset", never the path, for a stronger version of the signing key's reason below:
    // this directory holds all three of the mod's durable secrets, and this banner ends up in
    // screenshots and pasted bug reports. Each loader logs its own file's path on the line
    // saying what it did with it.
    ssoStateDir: source.ssoStateDir ? "set" : "unset",
    devAutoApprove: source.devAutoApprove === true,
    // The boolean above is for programs; this is for people. An enabled auto-approve must be
    // hard to overlook in a console shared with the game's logging, and a bare `true` beside
    // nine other fields is not, so when it is on the line says what it means.
    devAutoApproveEffect:
      source.devAutoApprove === true
        ? `ON: ANY CALLER CAN OBTAIN A TOKEN FOR CHARACTER ${
          source.devAutoApproveCharacterID === null
          || source.devAutoApproveCharacterID === undefined
            ? "?"
            : source.devAutoApproveCharacterID
        } WITHOUT PROVING IDENTITY IN-GAME`
        : "off",
    // Not a secret: it is an in-game ID, and with auto-approve on it is the most important
    // thing to see in a log.
    devAutoApproveCharacterID:
      source.devAutoApproveCharacterID === null ||
      source.devAutoApproveCharacterID === undefined
        ? "unset"
        : source.devAutoApproveCharacterID,
    // The path is never printed. It is not a credential, but it points directly at the private
    // key that signs every token the replica issues, and "set"/"unset" is all a log line needs.
    signingKey: source.signingKeyPath ? "set" : "unset",
    // Not a secret, and printed as the number rather than "default"/"custom": operators change
    // D44's setting because their traffic looked like a burst CCP's limiter was not meant to
    // survive, and the number loaded is the fact a console line can confirm.
    errorLimitMaxErrors:
      typeof source.errorLimitMaxErrors === "number"
        ? source.errorLimitMaxErrors
        : DEFAULTS.errorLimitMaxErrors,
    logLevel: source.logLevel || DEFAULTS.logLevel,
  };
}

/**
 * "none" or "2 client(s), 3 redirect URI(s)".
 *
 * "none" rather than "unset": no allowlist is a complete configuration, and every loopback
 * redirect URI still works.
 *
 * There is deliberately no third count of clients with a secret. A banner is pasted into
 * bug reports and screenshotted, and which clients are confidential tells a reader which
 * `client_id` is worth attacking. `lib/clientRegistry.js` compares public clients against a
 * random decoy so the token endpoint is not an oracle for that distinction, and printing it
 * here would give it away.
 *
 * The secret is never rendered: this function reads `clientId` and `redirectUris` lengths
 * and nothing else, so no path leads from a configured secret to a log line through it.
 */
function describeClients(clients) {
  if (!Array.isArray(clients) || clients.length === 0) {
    return "none (loopback redirect URIs only)";
  }

  const uris = clients.reduce(
    (total, client) => total + (Array.isArray(client && client.redirectUris) ? client.redirectUris.length : 0),
    0,
  );
  return `${clients.length} client(s), ${uris} redirect URI(s)`;
}

function describeListener(host, port) {
  if (port === null || port === undefined) return "disabled";
  return `${host || DEFAULTS.esiBindHost}:${port}`;
}

// The thin impure wrapper
// The only place in the mod that reads process.env or the mod's own directory. Both are
// injectable, so tests exercise the merge without either, and no test can drop a `.env`
// beside loader.js and destroy a developer's real one.
//
// Lowest first: settings.json, .env.txt, .env, the real environment. A key set by a higher
// layer wins even when it is empty, so a stale committed file never outranks a deliberate
// compose, CI or secrets-manager setting.
function loadConfig(options) {
  const { dir = __dirname, env = process.env } = options || {};

  const settings = readSettingsFile(path.join(dir, SETTINGS_FILE_NAME));
  const envTxt = readEnvFile(path.join(dir, ENV_TXT_FILE_NAME));
  const file = readEnvFile(path.join(dir, ENV_FILE_NAME));
  const result = parseConfigFromEnv({
    ...settings.values,
    ...envTxt.values,
    ...file.values,
    ...env,
  });

  // The second file, read here for the same reason as `.env`: the core stays pure and the
  // wrapper does the I/O. Only when a path survived parsing: a relative one has already been
  // refused, and reading it would resolve it against a working directory this mod does not
  // own.
  const clients =
    result.config.ssoClientsPath === null
      ? frozenClients([], [])
      : readClientsFile(result.config.ssoClientsPath);

  const layerWarnings = [];
  if (fs.existsSync(path.join(dir, ENV_FILE_NAME))) {
    layerWarnings.push(
      `${ENV_FILE_NAME} does not survive a launcher update: rename it to ${ENV_TXT_FILE_NAME}.`,
    );
  }

  // A value is never echoed: both name where the SSO secrets live.
  for (const [name, values] of [[ENV_TXT_FILE_NAME, envTxt.values], [ENV_FILE_NAME, file.values]]) {
    for (const key of [KEY_SSO_STATE_DIR, KEY_SIGNING_KEY_PATH]) {
      if (readEnv(values, key) === "") continue;
      layerWarnings.push(
        `${name} sets ${key}. If this file is lost the mod falls back to the derived location ` +
          `and creates new credentials, which invalidates every issued token.`,
      );
    }
  }

  // The form shows settings.json, not what is in effect, so say what outranks it.
  const notices = [];
  for (const [settingsKey, envKey] of Object.entries(SETTINGS_ENV_KEYS)) {
    let winner = null;
    if (isPresent(env, envKey)) winner = "the environment";
    else if (isPresent(file.values, envKey)) winner = ENV_FILE_NAME;
    else if (isPresent(envTxt.values, envKey)) winner = ENV_TXT_FILE_NAME;
    if (winner !== null) {
      notices.push(`${settingsKey} in the launcher form is overridden by ${envKey} from ${winner}.`);
    }
  }

  // Every file's complaints join the parser's, so loader.js prints them through one path. A
  // malformed allowlist makes the mod inert just as a malformed port does: the operator asked
  // for something that cannot be given.
  return Object.freeze({
    ok: result.ok && clients.errors.length === 0,
    config: Object.freeze({ ...result.config, ssoClients: clients.clients }),
    warnings: Object.freeze([
      ...settings.warnings,
      ...envTxt.warnings,
      ...file.warnings,
      ...layerWarnings,
      ...result.warnings,
    ]),
    notices: Object.freeze(notices),
    errors: Object.freeze([...result.errors, ...clients.errors]),
  });
}

module.exports = {
  DEFAULTS,
  ENV_FILE_NAME,
  ENV_FILE_PATH,
  ENV_KEYS,
  ENV_TXT_FILE_NAME,
  MOD_VERSION,
  RESERVED_GAME_PORTS,
  SETTINGS_ENV_KEYS,
  SETTINGS_FILE_NAME,
  describeConfig,
  loadConfig,
  loopbackListenersInContainer,
  parseClientsFile,
  parseConfigFromEnv,
  parseEnvFile,
  parseSettingsFile,
  readClientsFile,
  readEnvFile,
  readSettingsFile,
};
