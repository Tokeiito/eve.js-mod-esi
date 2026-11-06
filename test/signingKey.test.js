/**
 * Tests for lib/signingKey.js.
 *
 * Run with:  node --test test/signingKey.test.js
 *
 * Two acceptance properties are asserted directly rather than by inspection:
 *
 *   - Tokens issued before a mod restart still validate after it. A restart is
 *     simulated by signing with the key from one `loadOrCreateSigningKey`
 *     call, calling the loader again against the same path with no shared
 *     state, and verifying the first signature against the second call's
 *     public key. Minting a JWT is not imitated here: a hand-rolled JWS in a
 *     key-lifecycle test would be testing the wrong file.
 *   - No private key material appears in any log. The injected `log` is
 *     captured and searched for the PEM, its base64 body, and every 32-byte
 *     fragment of that body, on the generate, load and refusal paths. A
 *     positive control asserts the fingerprint is logged, so the search cannot
 *     pass on an empty log.
 *
 * Everything runs against `os.tmpdir()` scratch directories, following
 * `test/config.test.js` and `test/marketsContract.test.js`. The mod-tree walk in
 * `test/runtimeAccess.test.js` enumerates `.js` files under `test/`, so scratch
 * there would have to be reasoned about; the system temp directory is not
 * walked. Every directory is removed in `t.after`.
 *
 * There is no `jose` in this repository (D5/D20), so "a standard JWT library
 * verifies it with no special configuration" is demonstrated as far as this
 * layer allows: the published JWK is fed back through
 * `crypto.createPublicKey({ key: jwk, format: "jwk" })`, the path every
 * JWKS-consuming library takes, and used to verify a real signature.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_KID,
  SIGNING_ALG,
  JWK_USE,
  MODULUS_LENGTH,
  PRIVATE_KEY_FILE_MODE,
  SigningKeyError,
  loadOrCreateSigningKey,
  signingJwks,
  signingKeyFromPem,
  generateSigningKeyPem,
  jwkThumbprint,
  permissionWarningsFor,
} = require(path.join(__dirname, "..", "lib", "signingKey"));

// Scratch

/** A scratch directory removed when the test that made it finishes. */
function scratchDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esi-signing-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A key path one level below the scratch root, so every test also proves the
 * loader creates the directory it was pointed at. That is the real first-boot
 * shape: `<store root>/../sso/` does not exist until the mod makes it.
 */
function scratchKeyPath(t) {
  return path.join(scratchDir(t), "sso", "signing-key.pem");
}

/** A `log` that records what it was told, matching loader.js's one-string shape. */
function recordingLog() {
  const lines = [];
  const log = (message) => lines.push(message);
  log.lines = lines;
  return log;
}

const SAMPLE = Buffer.from("the payload a token endpoint would have signed");

/** Sign with a private KeyObject the way RS256 does. */
function sign(privateKey) {
  return crypto.sign("RSA-SHA256", SAMPLE, privateKey);
}

/** Verify against anything `crypto.verify` accepts as a public key. */
function verify(publicKey, signature) {
  return crypto.verify("RSA-SHA256", SAMPLE, publicKey, signature);
}

/**
 * Run `fn`, assert it threw a `SigningKeyError`, and hand the error back.
 *
 * `assert.throws` returns `undefined`, and every refusal test has something to
 * say about the message (the remedy, the symptom, the absence of key
 * material), so the error itself is what is needed.
 */
function refusal(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SigningKeyError, `expected a SigningKeyError, got ${err}`);
    return err;
  }
  assert.fail("expected a SigningKeyError, but the call returned");
  return null;
}

// First run generates, second run loads

test("first run generates the key, writes it, and says it created it", (t) => {
  const keyPath = scratchKeyPath(t);
  const key = loadOrCreateSigningKey({ keyPath });

  assert.equal(key.created, true);
  assert.equal(key.path, keyPath);
  assert.equal(fs.existsSync(keyPath), true);
  assert.equal(key.privateKey.type, "private");
  assert.equal(key.publicKey.type, "public");
  assert.equal(key.privateKey.asymmetricKeyDetails.modulusLength, MODULUS_LENGTH);
  assert.equal(Object.isFrozen(key), true);
});

test("the file it writes is a PKCS#8 PEM, not PKCS#1", (t) => {
  // The container is tagged with its algorithm, which lets the same filename
  // hold something else later. PKCS#1 would say "RSA PRIVATE KEY".
  const keyPath = scratchKeyPath(t);
  loadOrCreateSigningKey({ keyPath });
  const pem = fs.readFileSync(keyPath, "utf8");
  assert.equal(pem.startsWith("-----BEGIN PRIVATE KEY-----"), true);
  assert.equal(pem.includes("BEGIN RSA PRIVATE KEY"), false);
  assert.equal(pem.includes("ENCRYPTED"), false);
});

test("second run loads the same key and does not regenerate", (t) => {
  const keyPath = scratchKeyPath(t);
  const first = loadOrCreateSigningKey({ keyPath });
  const bytesAfterFirst = fs.readFileSync(keyPath);

  const second = loadOrCreateSigningKey({ keyPath });

  assert.equal(second.created, false);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.jwk.n, first.jwk.n);
  // The bytes on disk are the strongest statement of "did not regenerate": a
  // fresh 2048-bit key would differ in every one of them.
  assert.deepEqual(fs.readFileSync(keyPath), bytesAfterFirst);
});

test("two different keys have different fingerprints", (t) => {
  // The negative control for every "same fingerprint" assertion above: without
  // it, a constant fingerprint would pass all of them.
  const a = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });
  const b = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

// A signature survives a restart

test("a signature made before a restart still validates after it", (t) => {
  const keyPath = scratchKeyPath(t);

  // Boot 1: the mod comes up and signs something.
  const beforeRestart = loadOrCreateSigningKey({ keyPath });
  const signature = sign(beforeRestart.privateKey);
  assert.equal(verify(beforeRestart.publicKey, signature), true);

  // Restart: a second call with no shared state, against the same path. This is
  // D8 reduced to what is testable without minting.
  const afterRestart = loadOrCreateSigningKey({ keyPath });
  assert.equal(afterRestart.created, false);

  assert.equal(verify(afterRestart.publicKey, signature), true);
});

test("a signature made before a restart validates through the published JWKS", (t) => {
  // The criterion as a third party experiences it: the client has no access to
  // our KeyObject, only to the JWKS we publish after the restart.
  const keyPath = scratchKeyPath(t);
  const signature = sign(loadOrCreateSigningKey({ keyPath }).privateKey);

  const [publishedJwk] = signingJwks(loadOrCreateSigningKey({ keyPath }));
  const reconstructed = crypto.createPublicKey({ key: publishedJwk, format: "jwk" });

  assert.equal(verify(reconstructed, signature), true);
});

test("a fresh key at a different path does NOT validate the old signature", (t) => {
  // The failure D8 exists to prevent, asserted so that the two tests above
  // cannot be passing because verification is always true.
  const signature = sign(loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) }).privateKey);
  const other = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });
  assert.equal(verify(other.publicKey, signature), false);
});

// The JWK a validator actually reads

test("the JWK round-trips through the standard createPublicKey path", (t) => {
  const key = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });
  // No options, no algorithm hint, no coercion: what a library does with a key
  // it pulled out of a JWKS document.
  const fromJwk = crypto.createPublicKey({ key: key.jwk, format: "jwk" });
  assert.equal(verify(fromJwk, sign(key.privateKey)), true);
});

test("the JWK survives a JSON round trip, which is how it reaches a client", (t) => {
  const key = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });
  const overTheWire = JSON.parse(JSON.stringify({ keys: signingJwks(key) }));
  const fromWire = crypto.createPublicKey({ key: overTheWire.keys[0], format: "jwk" });
  assert.equal(verify(fromWire, sign(key.privateKey)), true);
});

test("the JWK carries CCP's members in CCP's order", (t) => {
  // Member order is the contract (bytes are compared), and JSON.stringify walks
  // insertion order, so the order is asserted on the object, not on a sorted
  // copy of its keys.
  const key = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });
  assert.deepEqual(Object.keys(key.jwk), ["alg", "e", "kid", "kty", "use", "n"]);
  assert.equal(key.jwk.alg, SIGNING_ALG);
  assert.equal(key.jwk.kty, "RSA");
  assert.equal(key.jwk.use, JWK_USE);
  assert.equal(key.jwk.kid, DEFAULT_KID);
  assert.equal(typeof key.jwk.n, "string");
  assert.equal(typeof key.jwk.e, "string");
  assert.equal(Object.isFrozen(key.jwk), true);
});

test("the JWK never carries a private member", (t) => {
  // An RSA private JWK adds d, p, q, dp, dq, qi. Exporting the wrong half is a
  // one-word mistake that publishes the signing key.
  const key = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });
  for (const member of ["d", "p", "q", "dp", "dq", "qi"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(key.jwk, member), false, member);
  }
});

test("kid defaults to CCP's literal and is overridable", (t) => {
  assert.equal(DEFAULT_KID, "JWT-Signature-Key");
  const keyPath = scratchKeyPath(t);
  assert.equal(loadOrCreateSigningKey({ keyPath }).kid, DEFAULT_KID);

  const relabelled = loadOrCreateSigningKey({ keyPath, kid: "something-else" });
  assert.equal(relabelled.kid, "something-else");
  assert.equal(relabelled.jwk.kid, "something-else");
  // The kid is a label on the same key material, not a different key.
  assert.equal(relabelled.jwk.n, loadOrCreateSigningKey({ keyPath }).jwk.n);
});

test("the fingerprint is the RFC 7638 thumbprint of the public key alone", (t) => {
  const key = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });

  // Recomputed from first principles rather than by calling the module's own
  // helper on its own output, which would prove nothing.
  const canonical = JSON.stringify({ e: key.jwk.e, kty: "RSA", n: key.jwk.n });
  const expected = crypto.createHash("sha256").update(canonical, "utf8").digest("base64url");

  assert.equal(key.fingerprint, expected);
  assert.equal(key.fingerprint, jwkThumbprint(key.jwk));
  // Public-only: the kid is not in it, so relabelling cannot move it.
  assert.equal(
    loadOrCreateSigningKey({ keyPath: key.path, kid: "other" }).fingerprint,
    key.fingerprint,
  );
});

// No private key material in any log

/**
 * Assert that no captured line contains the key, in whole or in fragments.
 *
 * Fragments matter: a log line that printed "the key starts with
 * MIIEvQIBADANBg..." would pass a whole-PEM check and still disclose. 32
 * base64 characters is 24 bytes of key material, far more than an accident.
 */
function assertNoKeyMaterial(lines, pem) {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const haystack = lines.join("\n");

  assert.equal(haystack.includes(pem), false, "the whole PEM reached a log");
  assert.equal(haystack.includes(body), false, "the PEM's base64 body reached a log");
  assert.equal(haystack.includes("PRIVATE KEY"), false, "a PEM banner reached a log");

  for (let at = 0; at + 32 <= body.length; at += 32) {
    const fragment = body.slice(at, at + 32);
    assert.equal(
      haystack.includes(fragment),
      false,
      `a 32-character fragment of the private key reached a log (offset ${at})`,
    );
  }
}

test("generating a key logs the path and fingerprint and no key material", (t) => {
  const keyPath = scratchKeyPath(t);
  const log = recordingLog();
  const key = loadOrCreateSigningKey({ keyPath, log });

  const pem = fs.readFileSync(keyPath, "utf8");
  assertNoKeyMaterial(log.lines, pem);

  // Positive control: the search above must not be passing on an empty log.
  const haystack = log.lines.join("\n");
  assert.equal(haystack.includes(key.fingerprint), true, "the fingerprint was not logged");
  assert.equal(haystack.includes(keyPath), true, "the path was not logged");
  assert.match(haystack, /generated/i);
});

test("loading a key logs it and no key material", (t) => {
  const keyPath = scratchKeyPath(t);
  loadOrCreateSigningKey({ keyPath });

  const log = recordingLog();
  const key = loadOrCreateSigningKey({ keyPath, log });

  assertNoKeyMaterial(log.lines, fs.readFileSync(keyPath, "utf8"));
  assert.equal(log.lines.join("\n").includes(key.fingerprint), true);
});

test("a refusal names the file without quoting any of it", (t) => {
  // The refusal path is where a leak is most tempting: an error that echoes
  // "could not parse: <contents>" would disclose with a stack trace attached,
  // and a file that is nearly a valid key is still a valid key.
  const keyPath = scratchKeyPath(t);
  const pem = generateSigningKeyPem();
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, pem.slice(0, 400)); // truncated mid-body

  const log = recordingLog();
  const err = refusal(() => loadOrCreateSigningKey({ keyPath, log }));

  assertNoKeyMaterial([err.message, ...log.lines], pem);
});

// A corrupt key is refused, never regenerated

test("a truncated key file is refused, and the file is left untouched", (t) => {
  const keyPath = scratchKeyPath(t);
  const good = loadOrCreateSigningKey({ keyPath });
  const truncated = fs.readFileSync(keyPath, "utf8").slice(0, 300);
  fs.writeFileSync(keyPath, truncated);

  const err = refusal(() => loadOrCreateSigningKey({ keyPath }));
  assert.equal(err.keyPath, keyPath);
  assert.equal(err.message.includes(keyPath), true);
  // The remedy is in the message: this is the one moment an operator decides
  // between restoring a backup and accepting the token invalidation.
  assert.match(err.message, /Move .* aside and restart/);
  assert.match(err.message, /invalidates every access token/);

  // The core of the test. Silently generating over it would destroy the only
  // recoverable state and kill every token in the wild with nothing in the log
  // to say why.
  assert.equal(fs.readFileSync(keyPath, "utf8"), truncated);

  // A restore still works, which is what "left untouched" is worth.
  fs.writeFileSync(keyPath, good.privateKey.export({ type: "pkcs8", format: "pem" }));
  assert.equal(loadOrCreateSigningKey({ keyPath }).fingerprint, good.fingerprint);
});

test("an empty key file is refused rather than treated as absent", (t) => {
  // The half-finished-write shape: the file exists and is empty. Reading it as
  // "absent" would be silent regeneration by another route.
  const keyPath = scratchKeyPath(t);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, "");
  refusal(() => loadOrCreateSigningKey({ keyPath }));
  assert.equal(fs.readFileSync(keyPath, "utf8"), "");
});

test("a key that is not RSA is refused by algorithm, not by parse failure", (t) => {
  // The operator-supplied-key path: an EC key parses and would sign, and every
  // RS256 validator would reject the result.
  const keyPath = scratchKeyPath(t);
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

  const err = refusal(() => loadOrCreateSigningKey({ keyPath }));
  assert.match(err.message, /"ec" key/);
  assert.match(err.message, /RS256/);
});

test("an RSA key below RS256's floor is refused", (t) => {
  const keyPath = scratchKeyPath(t);
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

  const err = refusal(() => loadOrCreateSigningKey({ keyPath }));
  assert.match(err.message, /1024-bit modulus/);
  assert.match(err.message, /at least 2048/);
});

test("an unreadable existing file is refused, not generated over", (t) => {
  // A directory where the key should be stands in for every non-ENOENT error:
  // the mod cannot tell "someone is mid-restore" from "corrupt", so it refuses.
  const keyPath = scratchKeyPath(t);
  fs.mkdirSync(keyPath, { recursive: true });
  const err = refusal(() => loadOrCreateSigningKey({ keyPath }));
  assert.match(err.message, /could not be read/);
  assert.equal(fs.statSync(keyPath).isDirectory(), true);
});

test("a missing keyPath is refused with the two places it comes from", (t) => {
  const err = refusal(() => loadOrCreateSigningKey({}));
  assert.match(err.message, /ESI_MOD_SIGNING_KEY_PATH/);
  assert.match(err.message, /getSigningKeyPath/);
});

// The race between preloaded processes

test("losing the create race adopts the winner's key rather than its own", (t) => {
  // loader.js preloads into the world process, about 5 forked edge processes and
  // the healthcheck, so on a first boot more than one can reach the create at
  // once. With a non-exclusive open the loser truncates the winner's key after
  // the winner has signed with it. The `wx` flag turns that into an EEXIST, and
  // this asserts what happens next: re-read, adopt, `created: false`.
  const keyPath = scratchKeyPath(t);
  const winnerPem = generateSigningKeyPem();
  const winner = signingKeyFromPem(winnerPem, { path: keyPath });

  const racingFs = {
    ...fs,
    openSync() {
      // The other process gets there between our read and our open.
      fs.writeFileSync(keyPath, winnerPem);
      const err = new Error("EEXIST: file already exists");
      err.code = "EEXIST";
      throw err;
    },
  };

  const key = loadOrCreateSigningKey({ keyPath, fs: racingFs });

  assert.equal(key.created, false);
  assert.equal(key.fingerprint, winner.fingerprint);
  assert.equal(verify(key.publicKey, sign(winner.privateKey)), true);
});

// signingJwks: the published, ordered key set

test("signingJwks returns an array with the active key first", (t) => {
  const key = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });
  const jwks = signingJwks(key);

  assert.equal(Array.isArray(jwks), true);
  assert.equal(jwks.length, 1);
  assert.equal(jwks[0], key.jwk);
  assert.equal(Object.isFrozen(jwks), true);
});

test("signingJwks takes a set as well as a lone key, and keeps its order", (t) => {
  // The shape has to accommodate more than one entry from the start, because the
  // JWKS document's shape is a contract that cannot change once tools read it.
  const active = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });
  const other = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t), kid: "second" });

  const jwks = signingJwks([active, other]);
  assert.deepEqual(jwks, [active.jwk, other.jwk]);
  // Nothing sorts: index 0 is the active key because the caller put it there.
  assert.deepEqual(signingJwks([other, active]), [other.jwk, active.jwk]);
});

test("signingJwks never publishes two keys under one kid", (t) => {
  // D8's mechanical half. Two entries sharing `JWT-Signature-Key` make jose
  // throw JWKSMultipleMatchingKeys and fail closed, so the published document is
  // built so that cannot occur, and the survivor is the active key at index 0.
  const active = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });
  const shadow = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });
  assert.equal(active.jwk.kid, shadow.jwk.kid);

  const jwks = signingJwks([active, shadow]);
  assert.deepEqual(jwks, [active.jwk]);
});

test("signingJwks ignores junk rather than putting it on the wire", (t) => {
  const key = loadOrCreateSigningKey({ keyPath: scratchKeyPath(t) });
  assert.deepEqual(signingJwks([null, undefined, 7, {}, { jwk: null }, key]), [key.jwk]);
  assert.deepEqual(signingJwks([]), []);
});

// Permissions, and what they mean per platform

test("the created file asks for owner-only permissions", (t) => {
  const keyPath = scratchKeyPath(t);
  loadOrCreateSigningKey({ keyPath });

  if (process.platform === "win32") {
    // Windows maps a POSIX mode onto the read-only attribute and nothing else, so
    // there is no owner-only mode to assert. What can be asserted is that the mod
    // did not create the key read-only, which would make a later rotation fail in
    // a confusing place.
    assert.equal(Boolean(fs.statSync(keyPath).mode & 0o200), true);
    return;
  }
  // umask can only clear bits, so 0600 is an upper bound: what matters is that
  // group and other got nothing.
  assert.equal(fs.statSync(keyPath).mode & 0o077, 0);
  assert.equal(PRIVATE_KEY_FILE_MODE, 0o600);
});

test("permissionWarningsFor reports a loose mode on POSIX only", () => {
  const p = "/var/lib/evejs/sso/signing-key.pem";

  assert.deepEqual(permissionWarningsFor(0o600, "linux", p), []);
  assert.deepEqual(permissionWarningsFor(0o400, "linux", p), []);

  const [warning] = permissionWarningsFor(0o644, "linux", p);
  assert.match(warning, /readable beyond its owner/);
  assert.match(warning, /644/);
  assert.match(warning, /should be 600/);

  // On Windows the number is synthesised and means nothing, so warning about it
  // would train an operator to ignore a warning that is real elsewhere.
  assert.deepEqual(permissionWarningsFor(0o644, "win32", p), []);
  assert.deepEqual(permissionWarningsFor(undefined, "linux", p), []);
});

test("a loose mode warns without refusing to start", (t) => {
  // A group-readable key still signs correct tokens. Taking a server's SSO down
  // over a permission bit trades a small exposure for a total outage.
  const keyPath = scratchKeyPath(t);
  loadOrCreateSigningKey({ keyPath });

  const log = recordingLog();
  const looseFs = { ...fs, statSync: () => ({ mode: 0o644 }) };
  const key = loadOrCreateSigningKey({ keyPath, log, fs: looseFs, platform: "linux" });

  assert.equal(key.created, false);
  assert.equal(log.lines.some((line) => /readable beyond its owner/.test(line)), true);
  assertNoKeyMaterial(log.lines, fs.readFileSync(keyPath, "utf8"));
});
