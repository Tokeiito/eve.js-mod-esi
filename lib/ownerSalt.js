/**
 * eve.js-mod-esi: the `owner` claim's salt.
 *
 * The third durable secret in `<gameStore root>/../sso/`, beside the signing
 * key (D8) and the refresh-token store (D30). It loads one string, or creates
 * it once.
 *
 * Why a salt: `lib/accessToken.js` derives the `owner` claim as an HMAC over
 * the character id and the account that owns it. Clients read the claim to
 * decide whether a stored token still belongs to the character it was issued
 * for, so it must be stable per character and change when ownership changes.
 * It is also readable by anyone holding the token. An unsalted hash would be a
 * reversible encoding: an account id is a small integer, so a token holder
 * could enumerate it in milliseconds, recover the account id, and tell that two
 * tokens for different characters share an account. The salt makes the claim
 * opaque, so it is a secret and not a parameter.
 *
 * Why it is not derived from the signing key: D8 gives up the JWKS overlap
 * window on the grounds that a key rotation costs every client one failed
 * request and one refresh. If `owner` were salted from the key, rotating it
 * would move every `owner` at once, every client would read every character as
 * transferred, and a rotation would need a human to type a bind code (D3) for
 * every tool they own. The two secrets have separate lifecycles.
 *
 * Why a damaged file is refused rather than regenerated: as in
 * `lib/signingKey.js`, but with a worse outcome. Losing the signing key
 * invalidates access tokens, which self-heals in one refresh. Losing this
 * changes `owner` for every character, and clients treat that as a transfer:
 * they discard the grant and ask the human to authorise again. Silently
 * generating a new salt over a damaged file would do that while reporting a
 * normal startup. A file that exists and cannot be used is a refusal naming
 * the path; the remedy is the same deliberate `mv` a corrupt key or store takes.
 */

"use strict";

const crypto = require("node:crypto");
const nodeFs = require("node:fs");
const path = require("node:path");

const { MINIMUM_OWNER_SALT_LENGTH, generateOwnerSalt } = require("./accessToken");

/** `0o600`: real on POSIX, cosmetic on Windows. See `permissionWarningsFor`. */
const OWNER_SALT_FILE_MODE = 0o600;
const OWNER_SALT_DIR_MODE = 0o700;
const FORBIDDEN_PERMISSION_BITS = 0o077;

/**
 * Pure core: a stat mode and a platform become zero or one warning.
 *
 * A third copy of six lines that `lib/signingKey.js` and `lib/refreshTokens.js`
 * each carry, deliberately not a shared helper: the owner salt must have no
 * dependency on the signing key (see the header and D8), and `lib/refreshTokens.js`
 * made the same call for the same reason. A module graph with no edge says
 * that outright.
 *
 * On Windows the mode bits are cosmetic: Node maps the POSIX mode onto the
 * read-only attribute alone, so `0o600` and `0o644` are the same file. Nothing
 * is reported there.
 */
function permissionWarningsFor(mode, platform, saltPath) {
  if (platform === "win32") return [];
  if (typeof mode !== "number") return [];
  if ((mode & FORBIDDEN_PERMISSION_BITS) === 0) return [];
  return [
    `owner salt ${saltPath} is readable beyond its owner (mode `
    + `${(mode & 0o777).toString(8).padStart(3, "0")}); a secret should be 600.`,
  ];
}

/** Thin wrapper: stat the file, then ask the pure core what to say about it. */
function permissionsAudit(fs, saltPath, platform) {
  if (platform === "win32") return [];
  try {
    return permissionWarningsFor(fs.statSync(saltPath).mode, platform, saltPath);
  } catch (_) {
    // A stat that fails on a file just read is not worth failing startup over, and
    // says nothing about whether the salt works.
    return [];
  }
}

class OwnerSaltError extends Error {
  constructor(message, saltPath) {
    super(`ESI mod: ${message}`);
    this.name = "OwnerSaltError";
    this.path = saltPath || null;
  }
}

/**
 * A short, non-reversing identifier for a salt, safe to log.
 *
 * The salt itself must never reach a log, but an operator comparing two
 * deployments, or checking that a restart picked up the same file, needs
 * something. A truncated SHA-256 of the salt reveals nothing: it is neither the
 * salt nor `owner` for any character.
 */
function saltFingerprint(salt) {
  return crypto.createHash("sha256").update(salt, "utf8").digest("base64url").slice(0, 16);
}

/** Read the salt file, or `null` when it is simply not there yet. */
function readSaltFile(fs, saltPath) {
  try {
    return fs.readFileSync(saltPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw new OwnerSaltError(
      `the owner salt at ${saltPath} exists but could not be read `
      + `(${err && err.code ? err.code : "unknown error"}). Fix the file or its permissions; `
      + "this mod will not generate over it.",
      saltPath,
    );
  }
}

/**
 * Write a brand-new salt file, or report that another process got there first.
 *
 * `"wx"` for `lib/signingKey.js`'s reason: the mod preloads into every node
 * process the container starts, and on a first boot more than one can reach
 * this line at once. With `"w"` the loser would truncate the winner's salt
 * after the winner had already minted a token against it, giving one character
 * two `owner` values inside a single boot.
 */
function writeNewSaltFile(fs, saltPath, salt) {
  fs.mkdirSync(path.dirname(saltPath), { recursive: true, mode: OWNER_SALT_DIR_MODE });

  let fd;
  try {
    fd = fs.openSync(saltPath, "wx", OWNER_SALT_FILE_MODE);
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    throw new OwnerSaltError(
      `could not create the owner salt at ${saltPath} `
      + `(${err && err.code ? err.code : "unknown error"}). The mod needs to be able to write `
      + "there; it is a sibling of the game store, so the game server's own user normally can.",
      saltPath,
    );
  }

  try {
    fs.writeFileSync(fd, `${salt}\n`);
  } finally {
    fs.closeSync(fd);
  }

  return true;
}

/**
 * Pure core: the bytes of the file become a usable salt, or a refusal.
 *
 * A trailing newline is stripped because the file is written with one (an
 * operator may `cat` it). Nothing else is trimmed.
 */
function saltFromFile(contents, saltPath) {
  if (typeof contents !== "string") {
    throw new OwnerSaltError(`the owner salt at ${saltPath} could not be read as text.`, saltPath);
  }

  const salt = contents.replace(/\r?\n$/, "");

  if (salt.length < MINIMUM_OWNER_SALT_LENGTH) {
    throw new OwnerSaltError(
      `the owner salt at ${saltPath} is ${salt.length} character(s); at least `
      + `${MINIMUM_OWNER_SALT_LENGTH} are required. This mod will not replace it: a new salt `
      + "moves the owner claim for every character at once, which every client reads as a "
      + "character transfer and answers by discarding the grant and asking the player to "
      + "authorise again. Move the file aside deliberately if that is what you intend.",
      saltPath,
    );
  }

  return salt;
}

/**
 * Load the owner salt, creating it on first run.
 *
 * Resolves to a frozen `{ salt, fingerprint, path, created }`. `salt` is the
 * secret and belongs only in `lib/accessToken.js`'s HMAC; `fingerprint` is the
 * value to log.
 *
 * `fs` and `platform` are injection seams with real defaults, as in
 * `lib/signingKey.js`, so a test can drive the `EEXIST` race and the POSIX
 * permission warning on a machine that has neither.
 *
 * @param {{saltPath: string, log?: Function, fs?: object, platform?: string}} options
 */
function loadOrCreateOwnerSalt(options = {}) {
  const {
    saltPath,
    log = null,
    fs = nodeFs,
    platform = process.platform,
  } = options;

  if (typeof saltPath !== "string" || saltPath.trim() === "") {
    throw new OwnerSaltError(
      "loadOrCreateOwnerSalt needs an absolute saltPath: the caller resolves it from "
      + "runtimeAccess.getOwnerSaltPath().",
      null,
    );
  }

  const resolved = path.resolve(saltPath);
  const emit = typeof log === "function" ? log : () => {};

  let contents = readSaltFile(fs, resolved);
  let created = false;

  if (contents === null) {
    const generated = generateOwnerSalt();
    created = writeNewSaltFile(fs, resolved, generated);
    if (created) {
      contents = generated;
    } else {
      // Lost the `wx` race. Read what the winner wrote rather than using the salt
      // just generated: two processes salting `owner` differently would give one
      // character two owner values, and a client seeing the second reads a transfer
      // that never happened.
      contents = readSaltFile(fs, resolved);
      if (contents === null) {
        throw new OwnerSaltError(
          `the owner salt at ${resolved} appeared and then vanished while starting up. `
          + "Something else is writing to that path; resolve that before serving SSO.",
          resolved,
        );
      }
    }
  }

  const salt = saltFromFile(contents, resolved);
  const fingerprint = saltFingerprint(salt);

  for (const warning of permissionsAudit(fs, resolved, platform)) emit(warning);

  emit(
    created
      ? `owner salt generated at ${resolved} (fingerprint ${fingerprint}): back it up. Losing `
        + "it changes the owner claim for every character, which every client reads as a "
        + "transfer and answers by making the player authorise again (decision D8's sibling)."
      : `owner salt loaded from ${resolved} (fingerprint ${fingerprint})`,
  );

  return Object.freeze({ salt, fingerprint, path: resolved, created });
}

module.exports = Object.freeze({
  OWNER_SALT_DIR_MODE,
  OWNER_SALT_FILE_MODE,
  OwnerSaltError,

  loadOrCreateOwnerSalt,

  permissionWarningsFor,
  saltFingerprint,
  saltFromFile,
});
