/**
 * eve.js-mod-esi: the RSA signing key, where it lives and how long it lives.
 *
 * Decision D8. A mod that generates a fresh keypair at boot invalidates every
 * token it has issued the first time the game server restarts, and a private
 * server restarts constantly (config change, vendor drop, `docker compose up
 * -d`). So the key is persisted before the first signature.
 *
 * This module generates the keypair once, reads it back on every later boot,
 * and projects the public half into the JWK shape the JWKS endpoint publishes.
 * It knows nothing about HTTP: the JWKS route consumes an injected
 * `getJwks: () => [jwk, ...]`. It does not mint tokens either; the minter takes
 * the `privateKey` from here as an argument.
 *
 * Location: `<gameStore root>/../sso/signing-key.pem`, resolved through
 * `lib/runtimeAccess.js`'s `getSigningKeyPath()`, a sibling of the game store
 * beside `sde/` and `market/`, never hardcoded. Two properties earn it:
 *
 *   1. It is outside the mod directory. `<eve.js tree>/mods/esiApi/` is a copy that
 *      `scripts/deploy-mod.js` replaces wholesale (D21), so a key stored there
 *      survives until the next deploy. `config.js` warns when
 *      `ESI_MOD_SIGNING_KEY_PATH` points inside the mod tree.
 *   2. It is inside the directory the server's data already lives in. On a
 *      container install that is the mounted volume (`/var/lib/evejs`), so the
 *      key survives the container being rebuilt. On a host checkout it is
 *      `_local/`.
 *
 * Protection is equal to the game's own data: anything that can read
 * `signing-key.pem` can already read every character record on the server.
 * See the permissions section below.
 *
 * On-disk format: unencrypted PKCS#8 PEM, private half only.
 *
 * PEM because `crypto.createPrivateKey` reads it with no parsing code of ours
 * and an operator can `cat`, back up and diff it. PKCS#8
 * (`-----BEGIN PRIVATE KEY-----`) rather than PKCS#1 because PKCS#8 tags the
 * algorithm inside the container, so the filename can hold another algorithm
 * later, and because `openssl genpkey` writes it. Private half only, with the
 * public key derived by `createPublicKey`: two files can disagree, one cannot.
 *
 * Unencrypted because a passphrase would have to be readable by the mod at
 * boot, unattended, inside the game process, so it would sit in `.env` on the
 * same disk next to the path of the key it unlocks. That is a second file to
 * lose, not encryption at rest. Encryption is worth its cost only when
 * something separates key and secret (an operator at a prompt, a KMS, a TPM).
 *
 * Key size: 2048-bit RSA. RFC 7518 section 3.3 makes 2048 the floor for RS256
 * and every validator accepts exactly that; a larger modulus only widens the
 * set of clients that might balk. Event-loop cost, measured on this machine
 * over 25 samples: 2048 generation is a median of 41 ms with a 112 ms tail,
 * against 198 ms / 499 ms for 4096. design constraint 2 puts that cost on
 * the loop the universe ticks on, so generation happens once, at startup,
 * before the listener binds, and never on a request path.
 *
 * `kid` and rotation. `kid` is the literal string `JWT-Signature-Key`, CCP's
 * observed value rather than a thumbprint. It is a parameter here, not an
 * import, so this module does not depend on `contract/sso.js`. A pinned literal
 * `kid` and a rotation overlap window are mutually exclusive:
 *
 *   A token minted by the outgoing key carries `kid: "JWT-Signature-Key"` in
 *   its JWS header. Give the incoming key that `kid` and the outgoing key
 *   another one, publish both, and a validator that selects by `kid` (what
 *   `jose`, `python-jose` and `jwks-rsa` all do) picks the new key for an old
 *   token and fails.
 *
 * Reversing it (outgoing keeps the literal, incoming gets a new `kid`) makes
 * old tokens validate but breaks every tool that looks up `JWT-Signature-Key`
 * by name, and only defers the break, since the incoming key must eventually be
 * renamed to the literal. Publishing both keys under the same `kid` is worse:
 * `jose` filters candidates by `kid` and throws `JWKSMultipleMatchingKeys` when
 * more than one survives, so that state fails closed for the strictest library
 * in the ecosystem.
 *
 * D8 therefore resolves it as follows. Rotation is a deliberate break, and the
 * overlap window is a property of the access token's lifetime rather than of
 * the key set. Under a pinned `kid` there is one signing slot, permanently
 * named `JWT-Signature-Key`, and replacing what is in it stops outstanding
 * access tokens validating. That is survivable because the access token is
 * short-lived and the refresh token is opaque and stored, not signed by this
 * key. A client whose access token stops verifying refreshes and is whole
 * again; nobody re-authorises.
 *
 *   - For a leaked key, an overlap window is wrong: it keeps the attacker's
 *     forged tokens valid exactly as long as the honest ones. Immediate
 *     invalidation is the break.
 *   - For scheduled hygiene rotation on a single-operator private server, with
 *     a key that never leaves the host, the benefit is close to zero and the
 *     cost is the break. It is not scheduled.
 *
 * Rotation is operator-driven: move `signing-key.pem` aside, restart, and the
 * next boot generates a new key and logs the new fingerprint. This is the same
 * gesture as recovering from a corrupt file (below), on purpose.
 *
 * The JWKS is an array from the start. `signingJwks()` returns an ordered
 * array, active key first, although the set holds one entry today:
 *
 *   - `{"keys": [...]}` is the shape RFC 7517 defines and every library parses.
 *   - One overlap is deliverable under a pinned `kid`: an algorithm migration.
 *     `jose` and python-jose narrow candidates by the JWS header's `alg` and
 *     the JWK's `kty` as well as `kid`, so an RSA key and an EC key sharing
 *     `JWT-Signature-Key` are distinguishable to them. `jwks-rsa` selects on
 *     `kid` alone and would still take the first match, so even that overlap is
 *     partial.
 *
 * `signingJwks` enforces the decision mechanically: it drops any entry
 * repeating a `kid` it has already emitted, so the published document never
 * contains the two-keys-one-kid state that fails closed in `jose`. Index 0 is
 * the active key by construction and nothing here sorts.
 *
 * A corrupt key file is refused, never regenerated. If the file exists and
 * cannot be parsed (truncated write, bad backup restore, wrong algorithm, a
 * modulus below RS256's floor) this throws and names the path. Silent
 * regeneration is the disaster D8 opens with, and worse than a restart because
 * the operator gets no signal: every token dies and the log says the mod
 * started normally. It also destroys the only recoverable state, the truncated
 * file. The remedy is a deliberate `mv` by a human who has read the message and
 * accepted that it invalidates every issued token.
 *
 * The throw is safe because of who catches it: the SSO listener's startup
 * calls this library. Design constraint 2 (the mod must never take the game
 * server down) is met by that caller declining to serve SSO, as `loader.js`
 * already goes dormant on a configuration error, not by inventing a key.
 *
 * Everything here is synchronous, which suits a call made exactly once, at
 * startup, before anything is listening. An async loader would let the SSO
 * listener bind, and a token request arrive, while the key was still being
 * read. The loaded object is the process's key set for its whole lifetime,
 * since a stat per token would put the filesystem on the game's event loop.
 * Rotation therefore needs a restart.
 */

"use strict";

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const path = require("node:path");


/**
 * CCP's observed `kid`, verbatim.
 *
 * A default, not an import: `contract/sso.js` records the same literal as an
 * observation of CCP's wire, and the route layer reconciles the two. Importing
 * the contract package would make a key-lifecycle test fail when a wire
 * constant moved. It is a parameter as well, so a test can prove the `kid`
 * reaches the JWK.
 *
 * A fixed string rather than a thumbprint because that is what CCP publishes
 * (design constraint 3). The RFC 7638 thumbprint that would otherwise have been
 * the `kid` is still computed: see `fingerprint`.
 */
const DEFAULT_KID = "JWT-Signature-Key";

/**
 * The JWS algorithm and the key use, as published.
 *
 * There is no `kty` constant: `kty` comes off Node's own JWK export, the
 * authority on what the key is, and a second copy of `"RSA"` could drift from
 * the key it describes.
 */
const SIGNING_ALG = "RS256";
const JWK_USE = "sig";

/** RS256's floor (RFC 7518 section 3.3), and what this mod generates. */
const MODULUS_LENGTH = 2048;
const MINIMUM_MODULUS_LENGTH = 2048;

/** The PEM container: see the format section in the header. */
const PRIVATE_KEY_PEM_TYPE = "pkcs8";
const PRIVATE_KEY_PEM_FORMAT = "pem";

/**
 * POSIX modes, applied at creation time through the `open` mode rather than by
 * `chmod` after the write.
 *
 * A create-then-chmod leaves the key world-readable for the width of the
 * write. `umask` can only clear bits, never add them, so `0o600` is an upper
 * bound rather than a guarantee, which is fine: a tighter umask is the
 * operator agreeing.
 *
 * See `auditKeyFilePermissions` for what these buy on Windows, where the
 * answer is almost nothing.
 */
const PRIVATE_KEY_FILE_MODE = 0o600;
const PRIVATE_KEY_DIR_MODE = 0o700;

/** The bits that must be clear on POSIX: group and other, read included. */
const FORBIDDEN_PERMISSION_BITS = 0o077;


/**
 * Thrown when a key file exists and cannot be used as a signing key.
 *
 * Named and carrying the path, so the SSO listener's startup can report a fact
 * an operator can act on instead of an `ERR_OSSL_...` from six frames down.
 * Every message ends in the same remedy, because corrupt-file recovery and a
 * deliberate rotation are the same gesture (see the header).
 *
 * Never carries key material. The offending bytes must not reach a log, so the
 * message names the file and the symptom and stops.
 */
class SigningKeyError extends Error {
  constructor(message, keyPath) {
    super(`[EsiApiMod] ${message}`);
    this.name = "SigningKeyError";
    this.keyPath = keyPath;
  }
}

/** The one remedy, appended to every refusal so the two paths read alike. */
function remedyFor(keyPath) {
  return (
    `Move ${keyPath} aside and restart to generate a new key, understanding `
    + "that a new key invalidates every access token already issued (decision D8). "
    + "This mod will not do that for you: silently replacing an unreadable key is "
    + "how every token in the wild dies with nothing in the log to say why."
  );
}


/**
 * Pure core: a public `KeyObject` and a `kid` become the published JWK.
 *
 * Member order is the contract. `JSON.stringify` walks a plain object's
 * non-integer string keys in insertion order, so this object literal decides
 * the bytes the JWKS endpoint emits, and the acceptance test compares bytes
 * against what CCP was observed sending. The observed order is `alg`, `e`,
 * `kid`, `kty`, `use`, `n`. `n` trailing the otherwise lexicographic run looks
 * accidental, and design constraint 3 says to reproduce it. A validator does not
 * care about member order; a byte diff against the recorded wire does.
 *
 * `n` and `e` come from Node's own JWK export rather than a base64url of a
 * buffer of ours, so the unsigned big-endian minimal-length encoding RFC 7518
 * requires is upstream's concern and not a leading-zero bug in this file.
 */
function jwkFromPublicKey(publicKey, kid = DEFAULT_KID) {
  const exported = publicKey.export({ format: "jwk" });
  return Object.freeze({
    alg: SIGNING_ALG,
    e: exported.e,
    kid,
    kty: exported.kty,
    use: JWK_USE,
    n: exported.n,
  });
}

/**
 * Pure core: the RFC 7638 thumbprint of a JWK, base64url, unpadded.
 *
 * This is the value that would be the `kid` on a service that had not pinned a
 * literal. It is derived from the public key alone, stable for the life of the
 * key, and any JWK tool computes the identical string, so "is the server
 * running the key I backed up?" is answerable without handling the private
 * half.
 *
 * RFC 7638's canonical form is not the published member order above: exactly
 * the required members (`e`, `kty`, `n` for RSA), in lexicographic order, no
 * whitespace. It is built explicitly rather than by re-sorting `jwk`, so the
 * two orders are not confused.
 */
function jwkThumbprint(jwk) {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("base64url");
}


/**
 * Pure core: PEM text becomes the frozen key object the rest of the mod uses.
 *
 * Every rejection is a refusal to serve, never a regeneration. Three symptoms
 * share one remedy and are kept distinct because they point at different
 * mistakes: unparseable is usually a truncated write or a bad restore; the
 * wrong algorithm is usually an operator's own key handed to
 * `ESI_MOD_SIGNING_KEY_PATH`; a short modulus is a key from an era when 1024
 * was normal.
 *
 * The modulus check matters: RS256 with a sub-2048 modulus is refused by
 * `jose` and every current validator, so accepting one would produce a mod
 * that starts cleanly, signs, and is rejected by every client.
 */
function signingKeyFromPem(pem, options = {}) {
  const kid = typeof options.kid === "string" && options.kid !== "" ? options.kid : DEFAULT_KID;
  const keyPath = typeof options.path === "string" ? options.path : null;

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({
      key: pem,
      format: PRIVATE_KEY_PEM_FORMAT,
      type: PRIVATE_KEY_PEM_TYPE,
    });
  } catch (err) {
    // The parse error's own message is safe (OpenSSL names the failure, not the
    // bytes), but it is appended rather than interpolated into the middle so the
    // remedy is the last thing an operator reads.
    throw new SigningKeyError(
      `the signing key at ${keyPath} could not be read as a PKCS#8 PEM private key `
      + `(${err && err.message ? err.message : String(err)}). ${remedyFor(keyPath)}`,
      keyPath,
    );
  }

  if (privateKey.asymmetricKeyType !== "rsa") {
    throw new SigningKeyError(
      `the signing key at ${keyPath} is a "${privateKey.asymmetricKeyType}" key, but this `
      + `replica signs with ${SIGNING_ALG}, which needs RSA. ${remedyFor(keyPath)}`,
      keyPath,
    );
  }

  const details = privateKey.asymmetricKeyDetails || {};
  if (!(details.modulusLength >= MINIMUM_MODULUS_LENGTH)) {
    throw new SigningKeyError(
      `the signing key at ${keyPath} has a ${details.modulusLength}-bit modulus; `
      + `${SIGNING_ALG} requires at least ${MINIMUM_MODULUS_LENGTH} (RFC 7518 §3.3) and a `
      + `shorter one is refused by every current validator. ${remedyFor(keyPath)}`,
      keyPath,
    );
  }

  const publicKey = crypto.createPublicKey(privateKey);
  const jwk = jwkFromPublicKey(publicKey, kid);

  return Object.freeze({
    kid,
    privateKey,
    publicKey,
    jwk,
    fingerprint: jwkThumbprint(jwk),
    path: keyPath,
    created: options.created === true,
  });
}

/** Pure core: a fresh 2048-bit RSA private key as PKCS#8 PEM text. */
function generateSigningKeyPem() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: MODULUS_LENGTH });
  return privateKey.export({ type: PRIVATE_KEY_PEM_TYPE, format: PRIVATE_KEY_PEM_FORMAT });
}


/**
 * The ordered array of JWKs the JWKS endpoint publishes, active key first.
 *
 * Takes the key set, which today holds one key. A bare key object is accepted
 * as well as an array, so a set of one does not make every caller write
 * `[key]`.
 *
 * The `kid` de-duplication is the mechanical half of D8. Two entries sharing
 * `JWT-Signature-Key` make `jose` throw `JWKSMultipleMatchingKeys` and fail
 * closed, so the document is constructed so that this cannot happen, and the
 * surviving entry is the earliest, which is the active key (index 0 by
 * construction; nothing here sorts). A real second key would differ in `kid`
 * or `kty` (see the algorithm-migration note in the header) and both would be
 * published.
 *
 * Frozen, because the JWKS route may hold this across requests.
 */
function signingJwks(keySet) {
  const keys = Array.isArray(keySet) ? keySet : [keySet];
  const jwks = [];
  const seenKids = new Set();

  for (const key of keys) {
    if (key === null || typeof key !== "object") continue;
    const { jwk } = key;
    if (jwk === null || typeof jwk !== "object") continue;
    if (seenKids.has(jwk.kid)) continue;
    seenKids.add(jwk.kid);
    jwks.push(jwk);
  }

  return Object.freeze(jwks);
}


/**
 * Pure core: a stat mode and a platform become zero or one warning strings.
 *
 * On POSIX `0o600` is real: the kernel enforces it, and this reports a key
 * whose group or other bits are set, which is what a restore from a tarball, a
 * `cp` under a loose umask, or an operator's own key typically leaves. A
 * warning rather than a refusal, because a group-readable key still signs
 * correct tokens and taking SSO down over a permission bit trades a small
 * exposure for a total outage.
 *
 * On Windows the mode bits are cosmetic. Node maps the POSIX mode onto the
 * read-only attribute and nothing else: only the owner-write bit survives, so
 * `0o600` and `0o644` are the same file, and `fs.statSync().mode` reports a
 * synthesised value rather than an ACL. There is no way to set a real ACL from
 * `node:fs`, and the dependency-free alternatives are worse than nothing:
 * shelling out to `icacls` means spawning a process from inside the game's
 * process at boot, on a path that must not fail, on installs (containers,
 * restricted service accounts) where it may not exist or apply. So this
 * reports nothing on Windows. The protection there is the one the header
 * describes: the key sits beside the game store, so any principal that can read
 * it can already read every character record.
 */
function permissionWarningsFor(mode, platform, keyPath) {
  if (platform === "win32") return [];
  if (typeof mode !== "number") return [];
  const offending = mode & FORBIDDEN_PERMISSION_BITS;
  if (offending === 0) return [];
  return [
    `signing key ${keyPath} is readable beyond its owner (mode `
    + `${(mode & 0o777).toString(8).padStart(3, "0")}); a private key should be 600.`,
  ];
}


/**
 * Read the PEM, or `null` when the file is simply not there yet.
 *
 * Absent is the first-run state, not an error. Anything else (a directory
 * where the file should be, a permission denial, an I/O failure) is a refusal,
 * for the same reason a corrupt file is: the mod cannot tell those apart from
 * "someone is mid-restore", and generating over them would be silent
 * regeneration with a different `errno`.
 */
function readKeyPem(fs, keyPath) {
  try {
    return fs.readFileSync(keyPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw new SigningKeyError(
      `the signing key at ${keyPath} exists but could not be read `
      + `(${err && err.code ? err.code : "unknown error"}). `
      + "Fix the file or its permissions; this mod will not generate over it.",
      keyPath,
    );
  }
}

/**
 * Write `pem` as a brand-new file, or report that somebody else got there
 * first. Returns `true` when this call created the file.
 *
 * `"wx"`, not `"w"`. The exclusive flag makes this safe under the race this
 * deployment has: `loader.js` preloads into every node process the container
 * starts (the world process, about 5 forked edge processes, the healthcheck),
 * and on a first boot more than one can reach this line at once. With `"w"`
 * the loser truncates the winner's key after the winner has signed with it, and
 * the two halves of the server disagree about what a valid token is. With
 * `"wx"` the loser gets `EEXIST` and re-reads: there is one key and whoever
 * wrote it wins.
 *
 * The mode goes in the `open` call rather than a later `chmod` so the key is
 * never briefly world-readable; see `PRIVATE_KEY_FILE_MODE`.
 */
function writeNewKeyFile(fs, keyPath, pem) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: PRIVATE_KEY_DIR_MODE });

  let fd;
  try {
    fd = fs.openSync(keyPath, "wx", PRIVATE_KEY_FILE_MODE);
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    throw new SigningKeyError(
      `could not create the signing key at ${keyPath} `
      + `(${err && err.code ? err.code : "unknown error"}). The mod needs to be able to `
      + "write there; it is a sibling of the game store, so the game server's own user "
      + "normally can.",
      keyPath,
    );
  }

  try {
    fs.writeFileSync(fd, pem);
  } finally {
    // Closed even on a failed write, so a partial file is not held open by a
    // process that is about to refuse to start. The partial file is left alone on
    // purpose: it is evidence, and the next boot refuses it loudly.
    fs.closeSync(fd);
  }
  return true;
}

/**
 * Load the signing key, generating it on first run. The mod's one entry point
 * into D8.
 *
 * `keyPath` is required and absolute. The caller resolves it, from
 * `config.signingKeyPath` if the operator set one, otherwise from
 * `lib/runtimeAccess.js`'s `getSigningKeyPath()`, which answers
 * `{ path, reason }` so that "no key path could be resolved" arrives with an
 * explanation. This module reaches for neither: it is testable against a temp
 * directory because it takes the path as an argument, and `runtimeAccess` is
 * the only module allowed to ask the game where anything lives.
 *
 * `log(message)` is optional and matches `loader.js`'s logger: one string, no
 * levels. It receives the path and the public fingerprint and never any
 * private key material; `test/signingKey.test.js` asserts this against the
 * PEM, its base64 body and fragments of both.
 *
 * `fs` and `platform` are injection seams with real defaults, the same shape as
 * `moduleExists` in `lib/runtimeAccess.js`, so a test can drive the `EEXIST`
 * race or the POSIX permission warning on a machine that has neither.
 *
 * Throws `SigningKeyError` for every unusable-key case. It never regenerates
 * over one.
 */
function loadOrCreateSigningKey(options = {}) {
  const {
    keyPath,
    kid = DEFAULT_KID,
    log = null,
    fs = nodeFs,
    platform = process.platform,
  } = options;

  if (typeof keyPath !== "string" || keyPath.trim() === "") {
    throw new SigningKeyError(
      "loadOrCreateSigningKey needs an absolute keyPath: the caller resolves it from "
      + "ESI_MOD_SIGNING_KEY_PATH or from runtimeAccess.getSigningKeyPath().",
      null,
    );
  }

  const resolved = path.resolve(keyPath);
  const emit = typeof log === "function" ? log : () => {};

  let pem = readKeyPem(fs, resolved);
  let created = false;

  if (pem === null) {
    const generated = generateSigningKeyPem();
    created = writeNewKeyFile(fs, resolved, generated);
    if (created) {
      pem = generated;
    } else {
      // Lost the `wx` race to another preloaded process. Read what the winner wrote
      // rather than using the key we generated: two processes signing with
      // different keys under one `kid` is the failure this file exists to prevent.
      pem = readKeyPem(fs, resolved);
      if (pem === null) {
        throw new SigningKeyError(
          `the signing key at ${resolved} appeared and then vanished while starting up. `
          + "Something else is writing to that path; resolve that before serving SSO.",
          resolved,
        );
      }
    }
  }

  const key = signingKeyFromPem(pem, { kid, path: resolved, created });

  for (const warning of permissionsAudit(fs, resolved, platform)) emit(warning);

  if (created) {
    emit(
      `signing key generated at ${resolved} (RSA ${MODULUS_LENGTH}, `
      + `fingerprint ${key.fingerprint}): back it up. Losing it invalidates every `
      + "access token this server has issued (decision D8).",
    );
  } else {
    emit(`signing key loaded from ${resolved} (fingerprint ${key.fingerprint}).`);
  }

  return key;
}

/** Thin wrapper: stat the file, then ask the pure core what to say about it. */
function permissionsAudit(fs, keyPath, platform) {
  if (platform === "win32") return [];
  try {
    return permissionWarningsFor(fs.statSync(keyPath).mode, platform, keyPath);
  } catch (_) {
    // A stat that fails on a file we have just read is not worth failing a
    // startup over, and has nothing to do with whether the key works.
    return [];
  }
}

module.exports = Object.freeze({
  DEFAULT_KID,
  SIGNING_ALG,
  JWK_USE,
  MODULUS_LENGTH,
  MINIMUM_MODULUS_LENGTH,
  PRIVATE_KEY_FILE_MODE,
  PRIVATE_KEY_DIR_MODE,
  SigningKeyError,

  loadOrCreateSigningKey,
  signingJwks,

  signingKeyFromPem,
  generateSigningKeyPem,
  jwkFromPublicKey,
  jwkThumbprint,
  permissionWarningsFor,
});
