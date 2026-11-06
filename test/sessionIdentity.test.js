/**
 * Tests for lib/sessionIdentity.js.
 *
 * Run with:  node --test "test/**\/*.test.js"   (from the mod directory)
 *
 * The identity tuple is the load-bearing claim of the grant: eve.js has no SSO,
 * so what the game session says about a character is all this replica can
 * trust (D3). These cases pin the behaviour when the session is not the tidy
 * object the happy path assumes, because a wrong answer mints somebody an
 * access token for a character they do not own.
 *
 * Everything runs against fixture sessions; no game code is loaded. The two
 * exceptions are the vendor-drift checks at the bottom, gated on `vendorOnly`
 * from `test/vendorTree.js`, which read files out of a real eve.js checkout as
 * text and never require them, the rule `test/runtimeAccess.test.js` follows
 * for `GAME_MODULES`.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ACCOUNT_ID_KEYS,
  CHARACTER_ID_KEYS,
  GM_ROLE_BITS,
  GM_ROLE_MASK,
  IDENTITY_FAILURE,
  ROLE_KEYS,
  describeIdentity,
  extractSessionIdentity,
  isGMRoleMask,
  toPositiveInteger,
  toRoleMask,
} = require(path.join(__dirname, "..", "lib", "sessionIdentity"));

const { REPO_ROOT, vendorOnly } = require(path.join(__dirname, "vendorTree"));

// The happy path

test("a normal player session yields the identity tuple", () => {
  const result = extractSessionIdentity({
    characterID: 90000001,
    userid: 12345,
    role: "0",
  });

  assert.equal(result.ok, true);
  assert.deepEqual({ ...result.identity }, {
    characterID: 90000001,
    accountID: 12345,
    role: "0",
    isGM: false,
  });
});

test("the identity is frozen so nothing downstream can rewrite the character", () => {
  const { identity } = extractSessionIdentity({ characterID: 1, userid: 2 });
  assert.throws(() => {
    identity.characterID = 999;
  }, TypeError);
});

// Field aliases
// Both spellings are live in the server; reading only the canonical one would
// work for most sessions and silently fail for the rest.

test("charid is accepted when characterID is absent", () => {
  const result = extractSessionIdentity({ charid: 90000002, userID: 7 });
  assert.equal(result.ok, true);
  assert.equal(result.identity.characterID, 90000002);
  assert.equal(result.identity.accountID, 7);
});

test("characterID wins over charid when both are present", () => {
  const result = extractSessionIdentity({ characterID: 111, charid: 222 });
  assert.equal(result.identity.characterID, 111);
});

test("accountRole is preferred over role, matching the game's own precedence", () => {
  const result = extractSessionIdentity({
    characterID: 1,
    accountRole: GM_ROLE_BITS.ROLE_ADMIN.toString(),
    role: "0",
  });
  assert.equal(result.identity.isGM, true);
});

test("rolesAtAll is the last resort, and it is read", () => {
  const result = extractSessionIdentity({
    characterID: 1,
    rolesAtAll: GM_ROLE_BITS.ROLE_GMH.toString(),
  });
  assert.equal(result.identity.role, GM_ROLE_BITS.ROLE_GMH.toString());
  assert.equal(result.identity.isGM, true);
});

test("every alias in every list is actually reachable", () => {
  // Guards against an alias added to a list and never wired up, which would
  // look like coverage and provide none.
  for (const key of CHARACTER_ID_KEYS) {
    assert.equal(extractSessionIdentity({ [key]: 5 }).identity.characterID, 5, key);
  }
  for (const key of ACCOUNT_ID_KEYS) {
    assert.equal(
      extractSessionIdentity({ characterID: 1, [key]: 9 }).identity.accountID,
      9,
      key,
    );
  }
  for (const key of ROLE_KEYS) {
    assert.equal(
      extractSessionIdentity({ characterID: 1, [key]: "1024" }).identity.role,
      "1024",
      key,
    );
  }
});

// Missing and malformed sessions

test("a null session is a named failure, not a throw", () => {
  const result = extractSessionIdentity(null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, IDENTITY_FAILURE.NO_SESSION);
});

test("junk in place of a session is a named failure", () => {
  for (const value of [undefined, 0, "session", true, Symbol("s")]) {
    const result = extractSessionIdentity(value);
    assert.equal(result.ok, false, `${String(value)} should not be a session`);
    assert.equal(result.reason, IDENTITY_FAILURE.NO_SESSION);
  }
});

test("a session with no character is distinguished from no session at all", () => {
  // Logged in, sitting on character selection. A different problem with a
  // different fix, so the player gets different words.
  const result = extractSessionIdentity({ userid: 12345, role: "0" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, IDENTITY_FAILURE.NO_CHARACTER);
});

test("a zero, negative or unparseable characterID is no character", () => {
  for (const value of [0, -1, "", "abc", NaN, null, undefined, {}]) {
    const result = extractSessionIdentity({ characterID: value, userid: 1 });
    assert.equal(result.ok, false, `characterID ${String(value)} should not bind`);
    assert.equal(result.reason, IDENTITY_FAILURE.NO_CHARACTER);
  }
});

test("a session missing everything but the character still binds", () => {
  // The account is optional; the character is what is being proved.
  const result = extractSessionIdentity({ characterID: 90000003 });
  assert.equal(result.ok, true);
  assert.equal(result.identity.accountID, null);
  assert.equal(result.identity.role, "0");
  assert.equal(result.identity.isGM, false);
});

test("inherited session fields are ignored", () => {
  // Own-property duck typing, the rule lib/exportProbe.js enforces. A prototype
  // that supplies a characterID is not a session that has one.
  const session = Object.create({ characterID: 90000004 });
  const result = extractSessionIdentity(session);
  assert.equal(result.ok, false);
  assert.equal(result.reason, IDENTITY_FAILURE.NO_CHARACTER);
});

test("a stringified characterID is accepted", () => {
  const result = extractSessionIdentity({ characterID: "90000005" });
  assert.equal(result.ok, true);
  assert.equal(result.identity.characterID, 90000005);
});

// Role masks

test("toRoleMask reads bigints, numbers and decimal strings", () => {
  assert.equal(toRoleMask(72057594037927936n), 72057594037927936n);
  assert.equal(toRoleMask(4096), 4096n);
  assert.equal(toRoleMask("18014398509481984"), 18014398509481984n);
  assert.equal(toRoleMask(" 1024 "), 1024n);
});

test("toRoleMask treats anything unparseable as no roles rather than throwing", () => {
  for (const value of [null, undefined, "", "0x10", "1e4", "-5", -5, NaN, Infinity, {}, []]) {
    assert.equal(toRoleMask(value), 0n, `${String(value)} should be 0n`);
  }
});

test("every GM bit sets isGM, and an ordinary player does not", () => {
  for (const [name, bit] of Object.entries(GM_ROLE_BITS)) {
    assert.equal(isGMRoleMask(bit), true, `${name} should count as GM`);
  }
  assert.equal(isGMRoleMask(0n), false);
  // ROLE_HEALSELF: an elevated-looking bit that is not staff.
  assert.equal(isGMRoleMask(4194304n), false);
});

test("GM_ROLE_MASK is the union of the individual bits", () => {
  const union = Object.values(GM_ROLE_BITS).reduce((mask, bit) => mask | bit, 0n);
  assert.equal(GM_ROLE_MASK, union);
});

test("the role reaches the caller as a string, because it is bound for JSON", () => {
  const result = extractSessionIdentity({
    characterID: 1,
    role: GM_ROLE_BITS.ROLE_GML,
  });
  assert.equal(typeof result.identity.role, "string");
  assert.equal(result.identity.role, GM_ROLE_BITS.ROLE_GML.toString());
  // JSON.stringify throws on BigInt, and this object ends up in a token claim
  // set, hence the string.
  assert.doesNotThrow(() => JSON.stringify(result.identity));
});

// toPositiveInteger

test("toPositiveInteger accepts only positive whole numbers", () => {
  assert.equal(toPositiveInteger(5), 5);
  assert.equal(toPositiveInteger("5"), 5);
  assert.equal(toPositiveInteger(5.9), 5);
  assert.equal(toPositiveInteger(0), null);
  assert.equal(toPositiveInteger(-3), null);
  assert.equal(toPositiveInteger("nope"), null);
  assert.equal(toPositiveInteger(null), null);
});

// Log rendering

test("describeIdentity renders the fields a log line may carry", () => {
  const line = describeIdentity({ characterID: 90000001, accountID: 12345, isGM: true });
  assert.equal(line, "char=90000001 account=12345 gm=yes");
});

test("describeIdentity copes with a missing account and with junk", () => {
  assert.equal(
    describeIdentity({ characterID: 1, accountID: null, isGM: false }),
    "char=1 account=? gm=no",
  );
  assert.equal(describeIdentity(null), "char=? account=?");
});

// Vendor drift
//
// The alias lists and the GM bits are copies of facts in the vendor tree, and a
// copy drifts. Both checks read the tree as text. Requiring
// `accountRoleProfiles.js` would break the rule that only
// `lib/runtimeAccess.js` may require game code, and requiring anything under
// `services/` risks opening the game store.

/** Every `.js` file under `server/src`, read as text once. */
function readServerSrc() {
  const root = path.join(REPO_ROOT, "server", "src");
  const chunks = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        chunks.push(fs.readFileSync(full, "utf8"));
      }
    }
  }
  return chunks.join("\n");
}

test("every session field alias still appears upstream", vendorOnly, () => {
  // Catches an upstream drop that retires a spelling, leaving a dead entry in a
  // list that reads as though it were load-bearing.
  //
  // It cannot catch a new spelling appearing: there is no way to enumerate every
  // name a session might use for its character from outside, so the alias lists
  // stay hand-maintained and this check guards one direction of drift.
  const source = readServerSrc();
  const lists = {
    CHARACTER_ID_KEYS,
    ACCOUNT_ID_KEYS,
    ROLE_KEYS,
  };

  for (const [listName, keys] of Object.entries(lists)) {
    for (const key of keys) {
      assert.match(
        source,
        new RegExp(`session\\.${key}\\b`),
        `${listName} lists "${key}", which no longer appears as session.${key} in server/src`,
      );
    }
  }
});

test("the copied GM role bits still match the vendor's own literals", vendorOnly, () => {
  // Protocol constants, copied because only lib/runtimeAccess.js may require
  // game code. lib/rateLimiter.js has the same arrangement with
  // contract/openapi.json, asserted the same way.
  const file = path.join(
    REPO_ROOT, "server", "src", "services", "account", "accountRoleProfiles.js",
  );
  assert.equal(fs.existsSync(file), true, `accountRoleProfiles.js has moved: ${file}`);
  const source = fs.readFileSync(file, "utf8");

  for (const [name, bit] of Object.entries(GM_ROLE_BITS)) {
    const declaration = new RegExp(`\\bconst\\s+${name}\\s*=\\s*([0-9]+)n\\b`);
    const match = declaration.exec(source);
    assert.ok(match, `${name} is no longer declared in accountRoleProfiles.js`);
    assert.equal(
      BigInt(match[1]),
      bit,
      `${name} is ${match[1]}n upstream and ${bit}n in lib/sessionIdentity.js`,
    );
  }

  // The negative case the isGM test relies on, pinned to upstream too: an
  // elevated-looking bit that is deliberately not staff.
  const healSelf = /\bconst\s+ROLE_HEALSELF\s*=\s*([0-9]+)n\b/.exec(source);
  assert.ok(healSelf, "ROLE_HEALSELF is no longer declared upstream");
  assert.equal(isGMRoleMask(BigInt(healSelf[1])), false, "ROLE_HEALSELF must not be GM");
});
