/**
 * The owner salt, `lib/ownerSalt.js`.
 *
 * Run with:  node --test "test/**\/*.test.js"   (from the mod directory, or RunTests.bat)
 *
 * The salt is the secret that makes the `owner` claim opaque, so most of what
 * is worth testing is refusal: it must not regenerate over a file it cannot
 * use, it must not lose a race with another process, and it must never reach a
 * log. Everything runs against a temp directory or an injected `fs`; no game is
 * needed.
 */

"use strict";

const test = require("node:test");
const { after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  OwnerSaltError,
  loadOrCreateOwnerSalt,
  permissionWarningsFor,
  saltFingerprint,
  saltFromFile,
} = require(path.join(__dirname, "../lib/ownerSalt"));

const { MINIMUM_OWNER_SALT_LENGTH, ownerHashFor } = require(
  path.join(__dirname, "../lib/accessToken"),
);

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {
      // A temp directory that will not delete is the operating system's problem,
      // not a test failure.
    }
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esi-mod-owner-salt-"));
  tempDirs.push(dir);
  return dir;
}

/** A salt path inside a directory that does not exist yet, so mkdir is exercised. */
function saltPathIn(dir) {
  return path.join(dir, "sso", "owner-salt.txt");
}

// First run, and every run after it

test("the first run creates the salt and says so; the second loads it", () => {
  const saltPath = saltPathIn(tempDir());

  const first = loadOrCreateOwnerSalt({ saltPath });
  assert.equal(first.created, true);
  assert.equal(first.path, saltPath);
  assert.ok(first.salt.length >= MINIMUM_OWNER_SALT_LENGTH);

  const second = loadOrCreateOwnerSalt({ saltPath });
  assert.equal(second.created, false);

  // The same bytes, so `owner` does not move under a restart.
  assert.equal(second.salt, first.salt);
  assert.equal(second.fingerprint, first.fingerprint);
});

test("a restart does not move the owner claim", () => {
  // The property as a client experiences it. A changed `owner` is not a token a
  // client retries: it is a character it believes was transferred, so it
  // discards the grant and asks the player to authorise again.
  const saltPath = saltPathIn(tempDir());

  const before = loadOrCreateOwnerSalt({ saltPath });
  const ownerBefore = ownerHashFor({ characterId: 90000001, accountId: 42, salt: before.salt });

  const after = loadOrCreateOwnerSalt({ saltPath });
  const ownerAfter = ownerHashFor({ characterId: 90000001, accountId: 42, salt: after.salt });

  assert.equal(ownerAfter, ownerBefore);
});

test("two deployments do not share an owner salt", () => {
  const one = loadOrCreateOwnerSalt({ saltPath: saltPathIn(tempDir()) });
  const two = loadOrCreateOwnerSalt({ saltPath: saltPathIn(tempDir()) });

  assert.notEqual(two.salt, one.salt);
  assert.notEqual(two.fingerprint, one.fingerprint);
});

// The secret never reaches a log

test("no salt material appears in any log line", () => {
  const saltPath = saltPathIn(tempDir());
  const lines = [];

  const created = loadOrCreateOwnerSalt({ saltPath, log: (line) => lines.push(line) });
  loadOrCreateOwnerSalt({ saltPath, log: (line) => lines.push(line) });

  assert.notEqual(lines.length, 0, "nothing was logged, so this assertion is vacuous");

  const joined = lines.join("\n");
  assert.equal(joined.includes(created.salt), false, "the salt itself was logged");

  // Fragments too: a log line carrying half a salt gives it to anyone who can
  // also read the other half.
  assert.equal(joined.includes(created.salt.slice(0, 16)), false, "a salt fragment was logged");
  assert.equal(joined.includes(created.salt.slice(-16)), false, "a salt fragment was logged");

  // What it should carry, so the operator has something to compare.
  assert.match(joined, /owner salt generated at/);
  assert.match(joined, new RegExp(created.fingerprint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the fingerprint is not the salt and not an owner claim", () => {
  const salt = "0123456789abcdef0123456789abcdef";
  const fingerprint = saltFingerprint(salt);

  assert.notEqual(fingerprint, salt);
  assert.equal(fingerprint.length, 16);
  assert.equal(saltFingerprint(salt), fingerprint, "not stable");
  assert.notEqual(saltFingerprint(`${salt}x`), fingerprint, "not sensitive to the salt");

  // And it is not the value a token carries for any character, which would make
  // logging it a leak of a different kind.
  assert.notEqual(fingerprint, ownerHashFor({ characterId: 1, accountId: 1, salt }));
});

// Refusal, not regeneration

test("a too-short salt file is refused, naming the path and the consequence", () => {
  const dir = tempDir();
  const saltPath = saltPathIn(dir);
  fs.mkdirSync(path.dirname(saltPath), { recursive: true });
  fs.writeFileSync(saltPath, "short\n");

  assert.throws(
    () => loadOrCreateOwnerSalt({ saltPath }),
    (err) => {
      assert.ok(err instanceof OwnerSaltError);
      assert.equal(err.path, saltPath);
      assert.match(err.message, /owner salt/);
      // The remedy is in the message: the operator must learn that the mod will not
      // fix this, and that this is deliberate.
      assert.match(err.message, /will not replace it/);
      assert.match(err.message, /transfer/);
      return true;
    },
  );

  // The damaged file is still there. It is the only recoverable state.
  assert.equal(fs.readFileSync(saltPath, "utf8"), "short\n");
});

test("an unreadable salt file is a refusal, not a fresh start", () => {
  const saltPath = saltPathIn(tempDir());

  // A directory where the file should be: `readFileSync` fails with EISDIR
  // rather than ENOENT, a failure that must not be read as "not there yet".
  fs.mkdirSync(saltPath, { recursive: true });

  assert.throws(
    () => loadOrCreateOwnerSalt({ saltPath }),
    (err) => err instanceof OwnerSaltError && /could not be read/.test(err.message),
  );
});

test("saltFromFile strips one trailing newline and nothing else", () => {
  const salt = "0123456789abcdef0123456789abcdef";

  assert.equal(saltFromFile(`${salt}\n`, "/x"), salt);
  assert.equal(saltFromFile(`${salt}\r\n`, "/x"), salt);
  assert.equal(saltFromFile(salt, "/x"), salt);

  // A salt that contains whitespace keeps it: trimming would make two different
  // files produce one salt.
  assert.equal(saltFromFile(`  ${salt}  \n`, "/x"), `  ${salt}  `);
});

// The first-boot race

test("the loser of the create race adopts the winner's salt", () => {
  // `loader.js` preloads into the world process, the forked edge processes and
  // the healthcheck, so on a first boot more than one can reach the create at
  // once. With a plain "w" the loser would truncate the winner's salt after the
  // winner had minted a token against it, handing one character two owner values
  // inside a single boot.
  const saltPath = saltPathIn(tempDir());
  const winner = "ffffffffffffffffffffffffffffffff";

  let opened = 0;
  const injected = {
    ...fs,
    readFileSync(target, encoding) {
      if (path.resolve(target) === path.resolve(saltPath) && opened === 0) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      if (path.resolve(target) === path.resolve(saltPath)) return `${winner}\n`;
      return fs.readFileSync(target, encoding);
    },
    openSync(target, flags, mode) {
      if (path.resolve(target) === path.resolve(saltPath)) {
        opened += 1;
        const err = new Error("EEXIST");
        err.code = "EEXIST";
        throw err;
      }
      return fs.openSync(target, flags, mode);
    },
  };

  const result = loadOrCreateOwnerSalt({ saltPath, fs: injected });

  assert.equal(result.created, false, "the loser must not report that it created the salt");
  assert.equal(result.salt, winner, "the loser kept its own salt instead of the winner's");
});

test("a salt that appears and then vanishes is a refusal, not a guess", () => {
  const saltPath = saltPathIn(tempDir());

  const injected = {
    ...fs,
    readFileSync(target, encoding) {
      if (path.resolve(target) === path.resolve(saltPath)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return fs.readFileSync(target, encoding);
    },
    openSync(target, flags, mode) {
      if (path.resolve(target) === path.resolve(saltPath)) {
        const err = new Error("EEXIST");
        err.code = "EEXIST";
        throw err;
      }
      return fs.openSync(target, flags, mode);
    },
  };

  assert.throws(
    () => loadOrCreateOwnerSalt({ saltPath, fs: injected }),
    (err) => err instanceof OwnerSaltError && /appeared and then vanished/.test(err.message),
  );
});

// Wiring refusals

test("an absent saltPath is a wiring error naming where the path comes from", () => {
  for (const bad of [undefined, null, "", "   ", 7]) {
    assert.throws(
      () => loadOrCreateOwnerSalt({ saltPath: bad }),
      (err) => err instanceof OwnerSaltError && /getOwnerSaltPath/.test(err.message),
      `${String(bad)} should be refused`,
    );
  }
});

// Permissions

test("a group- or world-readable salt warns on POSIX and says nothing on Windows", () => {
  assert.deepEqual(permissionWarningsFor(0o600, "linux", "/x/owner-salt.txt"), []);

  const warnings = permissionWarningsFor(0o644, "linux", "/x/owner-salt.txt");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /readable beyond its owner/);
  assert.match(warnings[0], /644/);

  // Windows maps the POSIX mode onto the read-only attribute alone, so the
  // number says nothing about who can read the file. Staying silent is more
  // honest than warning.
  assert.deepEqual(permissionWarningsFor(0o644, "win32", "/x/owner-salt.txt"), []);
});

// The dependency this file must not have

test("nothing in lib/ownerSalt.js depends on the signing key", () => {
  // D8's resolution gives up the JWKS overlap window on the grounds that a key
  // rotation costs one failed request and one refresh. A salt derived from the
  // signing key would move every `owner` on rotation, and every client reads a
  // changed `owner` as a transfer, so the real cost would be a fleet-wide
  // re-authorisation and D8's argument would be void.
  //
  // Asserted mechanically so that a future edit breaks a test instead of
  // repealing a decision.
  const source = fs.readFileSync(path.join(__dirname, "../lib/ownerSalt.js"), "utf8");
  const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);

  assert.deepEqual(
    requires.filter((name) => /signingKey/i.test(name)),
    [],
    "lib/ownerSalt.js requires the signing key module",
  );

  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/privateKey|createSign|createHmac/.test(code), false);
});

test("the salt is random rather than derived from anything on the machine", () => {
  // Two salts created a moment apart in two directories must not correlate. A
  // time-seeded or path-derived salt would pass every other test here and be
  // enumerable by anyone holding a token.
  const salts = new Set();
  for (let i = 0; i < 8; i += 1) {
    salts.add(loadOrCreateOwnerSalt({ saltPath: saltPathIn(tempDir()) }).salt);
  }
  assert.equal(salts.size, 8);

  for (const salt of salts) {
    assert.ok(salt.length >= MINIMUM_OWNER_SALT_LENGTH);
    // Hex, which is what `generateOwnerSalt` produces; asserted so a change of
    // encoding is a decision.
    assert.match(salt, /^[0-9a-f]+$/);
  }

  // Not guessable: 8 independent draws sharing no prefix is a weak but real
  // check that this is not a counter.
  const prefixes = new Set([...salts].map((salt) => salt.slice(0, 8)));
  assert.equal(prefixes.size, 8);
});

test("the created file is exactly the salt and one newline", () => {
  const saltPath = saltPathIn(tempDir());
  const { salt } = loadOrCreateOwnerSalt({ saltPath });

  // A text file an operator can `cat` and compare, with nothing else in it: no
  // JSON wrapper to half-parse, no timestamp to make two deployments differ.
  assert.equal(fs.readFileSync(saltPath, "utf8"), `${salt}\n`);
});

test("a crypto-random salt is what ownerHashFor accepts", () => {
  // The seam between the two modules: this file decides what a salt is and
  // `lib/accessToken.js` decides what it accepts, and nothing else checks that
  // they agree.
  const { salt } = loadOrCreateOwnerSalt({ saltPath: saltPathIn(tempDir()) });

  const owner = ownerHashFor({ characterId: 90000001, accountId: 42, salt });
  assert.equal(typeof owner, "string");
  assert.notEqual(owner, "");

  // A different salt gives a different owner, which is why losing this file is a
  // fleet-wide event.
  const other = crypto.randomBytes(32).toString("hex");
  assert.notEqual(ownerHashFor({ characterId: 90000001, accountId: 42, salt: other }), owner);
});
