/**
 * eve.js-mod-esi: tests for lib/refreshTokens.js
 *
 * Run with:  node --test test/refreshTokens.test.js
 *
 * Two acceptance criteria are asserted directly:
 *
 *   - A refresh token issued before a mod restart still works after it. A
 *     restart is simulated by issuing against one store, dropping it, and
 *     building a second over the same path with no shared state. Every field
 *     is compared across the boundary, because a grant that survives without
 *     its scopes works and authorises the wrong things (the scopes feed the
 *     `scp` claim).
 *   - A revoked refresh token is rejected, and the rejection is
 *     distinguishable in logs from an unknown token. Both are asserted to be
 *     refusals and to be different refusals, on both sides of a simulated
 *     restart, and the third dead state (`SUPERSEDED`) is held apart from both.
 *
 * Everything runs against `os.tmpdir()` scratch directories, following
 * `test/signingKey.test.js`: the mod-tree walk in `test/runtimeAccess.test.js`
 * enumerates `.js` files under `test/`, so scratch kept there would need to be
 * reasoned about. Every directory is removed in `t.after`.
 *
 * The clock is arithmetic throughout. Nothing sleeps, and the thirty-day
 * retention horizon is exercised by adding thirty days to a number.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  TOKEN_BYTES,
  STORE_FORMAT_VERSION,
  STORE_KIND,
  DEFAULT_MAX_PER_SUBJECT,
  DEFAULT_RETENTION_MS,
  RECORD_STATE,
  ISSUE_FAILURE,
  REFRESH_OUTCOME,
  REVOKE_OUTCOME,
  RefreshTokenStoreError,
  createRefreshTokenStore,
  defaultGenerateToken,
  hashToken,
  normalizeScopes,
  scopeString,
  isSubsetOfScopes,
  permissionWarningsFor,
} = require(path.join(__dirname, "..", "lib", "refreshTokens"));

// Scratch

/** A scratch directory removed when the test that made it finishes. */
function scratchDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esi-refresh-tokens-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A store path one level below the scratch root, so every test also proves
 * the store creates the directory it was pointed at. That is the real
 * first-boot shape: `<store root>/../sso/` does not exist until the mod makes
 * it, and on this deployment it is the only writable place there is.
 */
function scratchStorePath(t) {
  return path.join(scratchDir(t), "sso", "refresh-tokens.jsonl");
}

/** A `log` that records what it was told, matching loader.js's one-string shape. */
function recordingLog() {
  const lines = [];
  const log = (message) => lines.push(message);
  log.lines = lines;
  return log;
}

/** A clock a test can move by hand. */
function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  const now = () => value;
  now.advance = (ms) => {
    value += ms;
    return value;
  };
  now.set = (ms) => {
    value = ms;
    return value;
  };
  return now;
}

/**
 * The ordinary store: a real filesystem, a fake clock, the real generator.
 * The real generator is the default so the suite exercises the entropy the
 * design rests on.
 */
function makeStore(t, overrides = {}) {
  const now = overrides.now || fakeClock();
  const store = createRefreshTokenStore({
    storePath: overrides.storePath || scratchStorePath(t),
    now,
    ...overrides,
  });
  return { store, now, path: store.path };
}

/** A grant, with every field the authorize route hands over. */
const GRANT = Object.freeze({
  characterId: 90000001,
  clientId: "market-hub-seed",
  scopes: ["publicData", "esi-markets.structure_markets.v1", "esi-wallet.read_character_wallet.v1"],
});

/** Run `fn`, assert it threw a RefreshTokenStoreError, and hand the error back. */
function refusal(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(
      err instanceof RefreshTokenStoreError,
      `expected a RefreshTokenStoreError, got ${err}`,
    );
    return err;
  }
  assert.fail("expected a RefreshTokenStoreError, but the call returned");
  return null;
}

// Acceptance 1: it survives a restart

test("a token issued before a restart still works after it", (t) => {
  const storePath = scratchStorePath(t);
  const now = fakeClock();

  const first = createRefreshTokenStore({ storePath, now });
  const issued = first.issue(GRANT);
  assert.equal(typeof issued.token, "string");

  // The restart. Nothing is shared but the path: no store object, no map, no
  // clock reading.
  now.advance(3 * 24 * 60 * 60 * 1000);
  const second = createRefreshTokenStore({ storePath, now });

  const result = second.refresh(issued.token);
  assert.equal(result.outcome, REFRESH_OUTCOME.OK);
  assert.equal(second.size(), 1);
});

test("every record field survives the round trip", (t) => {
  const storePath = scratchStorePath(t);
  const now = fakeClock();

  const first = createRefreshTokenStore({ storePath, now });
  const issued = first.issue(GRANT);
  now.advance(1000);
  first.refresh(issued.token);
  const before = first.inspect(issued.token).record;

  const after = createRefreshTokenStore({ storePath, now }).inspect(issued.token).record;

  // deepEqual over the whole record rather than field by field, so a field
  // added later and never serialised fails here without extending a list.
  assert.deepEqual(after, before);

  // The scopes are the field with a downstream consumer (the `scp` claim), so
  // they are also asserted by value, including order, which a client that
  // byte-compares the granted scope would see.
  assert.deepEqual(after.scopes, GRANT.scopes);
  assert.equal(after.characterId, GRANT.characterId);
  assert.equal(after.clientId, GRANT.clientId);
  assert.equal(after.refreshCount, 1);
});

test("a store that has never been written loads as empty, and says so", (t) => {
  const log = recordingLog();
  const { store } = makeStore(t, { log });
  assert.equal(store.size(), 0);
  assert.equal(store.retiredCount(), 0);
  assert.equal(fs.existsSync(store.path), false);
  assert.ok(log.lines.some((line) => line.includes("does not exist yet")));
});

test("the store file is created under a directory that did not exist", (t) => {
  const { store } = makeStore(t);
  store.issue(GRANT);
  assert.equal(fs.existsSync(store.path), true);
  const head = JSON.parse(fs.readFileSync(store.path, "utf8").split("\n")[0]);
  assert.equal(head.kind, STORE_KIND);
  assert.equal(head.version, STORE_FORMAT_VERSION);
});

// Acceptance 2: revoked is a different refusal from unknown

test("a revoked token is rejected, and not with the same answer as an unknown one", (t) => {
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);

  assert.equal(store.revoke(issued.token, { reason: "operator" }).outcome, REVOKE_OUTCOME.OK);

  const replayed = store.refresh(issued.token);
  const stranger = store.refresh(defaultGenerateToken());

  // Both refusals...
  assert.notEqual(replayed.outcome, REFRESH_OUTCOME.OK);
  assert.notEqual(stranger.outcome, REFRESH_OUTCOME.OK);
  // ...and distinguishable, which is the criterion. If these two were
  // flattened here, the caller could not log the distinction.
  assert.equal(replayed.outcome, REFRESH_OUTCOME.REVOKED);
  assert.equal(stranger.outcome, REFRESH_OUTCOME.UNKNOWN);
});

test("a revoked record keeps everything it knew, so the log line can say who", (t) => {
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);
  store.revoke(issued.token, { reason: "reported stolen" });

  const { record } = store.inspect(issued.token);
  assert.equal(record.state, RECORD_STATE.REVOKED);
  assert.equal(record.characterId, GRANT.characterId);
  assert.equal(record.clientId, GRANT.clientId);
  assert.deepEqual(record.scopes, GRANT.scopes);
  assert.equal(record.revokedReason, "reported stolen");
  assert.equal(typeof record.retiredAt, "number");

  // Not counted as live, and not deleted either.
  assert.equal(store.size(), 0);
  assert.equal(store.retiredCount(), 1);
});

test("a revocation survives a restart", (t) => {
  const storePath = scratchStorePath(t);
  const now = fakeClock();
  const first = createRefreshTokenStore({ storePath, now });
  const issued = first.issue(GRANT);
  first.revoke(issued.token, { reason: "operator" });

  const second = createRefreshTokenStore({ storePath, now });
  assert.equal(second.refresh(issued.token).outcome, REFRESH_OUTCOME.REVOKED);
  assert.equal(second.inspect(issued.token).record.revokedReason, "operator");
});

test("revoking is idempotent, and the second answer is its own", (t) => {
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);
  assert.equal(store.revoke(issued.token).outcome, REVOKE_OUTCOME.OK);
  assert.equal(store.revoke(issued.token).outcome, REVOKE_OUTCOME.ALREADY_REVOKED);
  assert.equal(store.revoke(defaultGenerateToken()).outcome, REVOKE_OUTCOME.UNKNOWN);
});

test("superseded is held apart from revoked and from unknown", (t) => {
  // Three dead states, three answers. They flatten onto one `invalid_grant` at
  // the wire (RFC 6749 §5.2), so they must stay distinct here: the caller can
  // collapse three names but cannot invent them.
  const { store } = makeStore(t, { maxPerSubject: 1 });
  const first = store.issue(GRANT);
  const second = store.issue(GRANT);

  assert.equal(store.refresh(first.token).outcome, REFRESH_OUTCOME.SUPERSEDED);
  assert.equal(store.refresh(second.token).outcome, REFRESH_OUTCOME.OK);
  assert.equal(store.revoke(first.token).outcome, REVOKE_OUTCOME.SUPERSEDED);
});

// Revoking a family

test("two grants to the same character and client are in different families", (t) => {
  // A family is per-issue, not per-subject. If it were per-subject, revoking
  // the family behind a replayed authorization code would take out every other
  // grant that character holds in that tool.
  const { store } = makeStore(t);
  const a = store.issue(GRANT);
  const b = store.issue(GRANT);
  assert.notEqual(a.record.family, b.record.family);

  const result = store.revokeFamily(a.record.family, { reason: "code replay" });
  assert.equal(result.outcome, REVOKE_OUTCOME.OK);
  assert.equal(result.records.length, 1);

  assert.equal(store.refresh(a.token).outcome, REFRESH_OUTCOME.REVOKED);
  assert.equal(store.refresh(b.token).outcome, REFRESH_OUTCOME.OK);
  assert.equal(store.size(), 1);
});

test("revoking a family retires its records, and a replay of one says revoked", (t) => {
  const { store, now } = makeStore(t);
  const issued = store.issue(GRANT);

  now.advance(5 * 60 * 1000);
  const result = store.revokeFamily(issued.record.family, { reason: "code replay" });

  assert.equal(result.outcome, REVOKE_OUTCOME.OK);
  assert.deepEqual(
    result.records.map((record) => record.tokenHash),
    [issued.record.tokenHash],
  );

  const [dead] = result.records;
  assert.equal(dead.state, RECORD_STATE.REVOKED);
  assert.equal(dead.retiredAt, now());
  assert.equal(dead.revokedReason, "code replay");
  // Everything it knew, kept, exactly as a single-token revocation keeps it.
  assert.equal(dead.characterId, GRANT.characterId);
  assert.deepEqual(dead.scopes, GRANT.scopes);

  assert.equal(store.refresh(issued.token).outcome, REFRESH_OUTCOME.REVOKED);
  assert.equal(store.size(), 0);
  assert.equal(store.retiredCount(), 1);
});

test("a family nobody here issued is a quiet no-op, whatever shape it arrived in", (t) => {
  // The ordinary case: after a restart the authorization code store is empty
  // and this one is not, so most replays name a family this process has never
  // seen. A throw here would take the universe down for a request that is
  // working as designed.
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);

  const junk = [
    crypto.randomBytes(16).toString("hex"),
    "",
    null,
    undefined,
    7,
    {},
    [],
    Symbol("x"),
    issued.record.family.toUpperCase(),
  ];

  for (const family of junk) {
    let result = null;
    assert.doesNotThrow(() => {
      result = store.revokeFamily(family);
    }, `revokeFamily(${String(family)}) threw`);
    assert.equal(result.outcome, REVOKE_OUTCOME.UNKNOWN, `for ${String(family)}`);
    assert.deepEqual(result.records, []);
    assert.equal(store.size(), 1);
    assert.equal(store.retiredCount(), 0);
  }

  // The uppercase spelling is in that list on purpose: `family` is compared
  // with `===` against the exact string, with no coercion, as `characterId` is.
  assert.equal(store.refresh(issued.token).outcome, REFRESH_OUTCOME.OK);
});

test("a family that is already dead is unknown, not re-retired at a later time", (t) => {
  // Only live records are eligible. Re-retiring a dead one would move its
  // `retiredAt` forward, resetting the retention horizon and losing when it
  // actually died.
  const { store, now } = makeStore(t, { maxPerSubject: 1 });
  const superseded = store.issue(GRANT);
  const live = store.issue(GRANT);
  store.revoke(live.token, { reason: "operator" });

  const supersededAt = store.inspect(superseded.token).record.retiredAt;
  const revokedAt = store.inspect(live.token).record.retiredAt;

  now.advance(60 * 60 * 1000);
  assert.equal(
    store.revokeFamily(superseded.record.family).outcome,
    REVOKE_OUTCOME.UNKNOWN,
  );
  assert.equal(store.revokeFamily(live.record.family).outcome, REVOKE_OUTCOME.UNKNOWN);

  assert.equal(store.inspect(superseded.token).record.state, RECORD_STATE.SUPERSEDED);
  assert.equal(store.inspect(superseded.token).record.retiredAt, supersededAt);
  assert.equal(store.inspect(live.token).record.state, RECORD_STATE.REVOKED);
  assert.equal(store.inspect(live.token).record.retiredAt, revokedAt);
  assert.equal(store.inspect(live.token).record.revokedReason, "operator");
  assert.equal(store.retiredCount(), 2);
});

test("a family revocation survives a restart", (t) => {
  const storePath = scratchStorePath(t);
  const now = fakeClock();
  const first = createRefreshTokenStore({ storePath, now });
  const issued = first.issue(GRANT);
  const other = first.issue(GRANT);
  assert.equal(first.revokeFamily(issued.record.family, { reason: "code replay" }).outcome,
    REVOKE_OUTCOME.OK);

  // A revocation held only in this process's heap comes back at the next
  // restart, and the token it un-revokes was minted from a leaked authorization
  // code.
  const second = createRefreshTokenStore({ storePath, now });
  assert.equal(second.refresh(issued.token).outcome, REFRESH_OUTCOME.REVOKED);
  assert.equal(second.inspect(issued.token).record.revokedReason, "code replay");
  assert.equal(second.inspect(issued.token).record.family, issued.record.family);
  assert.equal(second.refresh(other.token).outcome, REFRESH_OUTCOME.OK);
  assert.equal(second.size(), 1);
});

test("a family revocation that cannot be written rolls back every record", (t) => {
  // A partial rollback is worse than none: the store would believe some of the
  // family is dead while the file says all of it is alive, and the next restart
  // would resurrect those records.
  const storePath = scratchStorePath(t);
  const now = fakeClock();
  const store = createRefreshTokenStore({ storePath, now, maxPerSubject: 2 });
  const first = store.issue(GRANT);
  const second = store.issue(GRANT);

  let failing = false;
  const log = recordingLog();
  const broken = createRefreshTokenStore({
    storePath,
    now,
    log,
    maxPerSubject: 2,
    fs: {
      ...fs,
      renameSync: (...args) => {
        if (failing) throw Object.assign(new Error("no"), { code: "EIO" });
        return fs.renameSync(...args);
      },
    },
  });
  failing = true;

  const result = broken.revokeFamily(first.record.family, { reason: "code replay" });
  assert.equal(result.outcome, REVOKE_OUTCOME.PERSIST_FAILED);
  assert.deepEqual(result.records, []);
  assert.equal(broken.size(), 2);
  assert.equal(broken.retiredCount(), 0);
  assert.equal(broken.refresh(first.token).outcome, REFRESH_OUTCOME.OK);
  assert.ok(log.lines.some((line) => line.includes("NOT revoked")));

  // `bySubject` is intact too. The only way to prove that from outside is to
  // make the per-subject cap count: a third grant for this pair has to
  // supersede the least recently used of the two.
  failing = false;
  now.advance(1000);
  assert.equal(broken.issue(GRANT).token !== null, true);
  assert.equal(broken.size(), 2);
  // `first` was refreshed a moment ago, so `second` is the least recently used
  // and the cap takes it. A set left empty by a half-rollback would wave this
  // third grant through and leave three for a pair capped at two.
  assert.equal(broken.refresh(second.token).outcome, REFRESH_OUTCOME.SUPERSEDED);
  assert.equal(broken.refresh(first.token).outcome, REFRESH_OUTCOME.OK);
});

test("revoking one subject's family leaves every other subject alone", (t) => {
  const { store } = makeStore(t);
  const mine = store.issue(GRANT);
  const sameCharacterOtherTool = store.issue({ ...GRANT, clientId: "other-tool" });
  const otherCharacter = store.issue({ ...GRANT, characterId: 90000002 });

  assert.equal(store.revokeFamily(mine.record.family).outcome, REVOKE_OUTCOME.OK);

  assert.equal(store.refresh(mine.token).outcome, REFRESH_OUTCOME.REVOKED);
  assert.equal(store.refresh(sameCharacterOtherTool.token).outcome, REFRESH_OUTCOME.OK);
  assert.equal(store.refresh(otherCharacter.token).outcome, REFRESH_OUTCOME.OK);
  assert.equal(store.size(), 2);
  assert.equal(store.retiredCount(), 1);
});

// Rotation is off, and the fields that would turn it on are there

test("a refresh returns the same token: we do not rotate (D30)", (t) => {
  const { store, now } = makeStore(t);
  const issued = store.issue(GRANT);

  for (let n = 0; n < 3; n += 1) {
    now.advance(20 * 60 * 1000);
    const result = store.refresh(issued.token);
    assert.equal(result.outcome, REFRESH_OUTCOME.OK);
    assert.equal(result.record.refreshCount, n + 1);
    assert.equal(result.record.lastUsedAt, now());
  }

  // The string the client stored on day one is still the string that works. A
  // client that never persists anything after the first response is never
  // locked out.
  assert.equal(store.refresh(issued.token).outcome, REFRESH_OUTCOME.OK);
  assert.equal(store.size(), 1);
});

test("every record carries a family and a generation, so rotation is one edit", (t) => {
  const { store } = makeStore(t);
  const a = store.issue(GRANT);
  const b = store.issue(GRANT);

  assert.match(a.record.family, /^[0-9a-f]{32}$/);
  assert.notEqual(a.record.family, b.record.family);
  // Zero on every record this store has written. A rotation would mint
  // generation + 1 into the same family and retire the old record as
  // SUPERSEDED, a state that already exists and is already pruned.
  assert.equal(a.record.generation, 0);
  assert.equal(b.record.generation, 0);

  // A refresh does not move either of them, because a refresh mints nothing.
  const refreshed = store.refresh(a.token).record;
  assert.equal(refreshed.family, a.record.family);
  assert.equal(refreshed.generation, 0);
});

// Scope narrowing

test("a narrower scope is granted, and only for that refresh", (t) => {
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);

  const narrowed = store.refresh(issued.token, { scopes: ["publicData"] });
  assert.equal(narrowed.outcome, REFRESH_OUTCOME.OK);
  assert.deepEqual(narrowed.scopes, ["publicData"]);
  assert.equal(narrowed.scope, "publicData");

  // RFC 6749 §6 narrows the access token being requested, not the grant. A
  // client that asks for less once must be able to ask for everything next
  // time.
  const full = store.refresh(issued.token);
  assert.deepEqual(full.scopes, GRANT.scopes);
  assert.deepEqual(store.inspect(issued.token).record.scopes, GRANT.scopes);
});

test("an equal scope set is allowed", (t) => {
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);
  const result = store.refresh(issued.token, { scopes: GRANT.scopes.slice() });
  assert.equal(result.outcome, REFRESH_OUTCOME.OK);
  assert.deepEqual(result.scopes, GRANT.scopes);
});

test("a widening scope is refused, not silently intersected", (t) => {
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);

  const result = store.refresh(issued.token, {
    scopes: ["publicData", "esi-wallet.read_corporation_wallets.v1"],
  });

  // The refusal is its own outcome: RFC 6749 §5.2 answers a bad token
  // `invalid_grant` and an over-wide scope `invalid_scope`, so flattening it
  // into the token outcomes would lose that distinction.
  assert.equal(result.outcome, REFRESH_OUTCOME.SCOPE_NOT_SUBSET);
  assert.equal(result.scopes, null);

  // An intersection would hand back a working access token that does less than
  // the client asked for, and the client would find out at its first 403.
  assert.notEqual(result.outcome, REFRESH_OUTCOME.OK);

  // And the token is untouched: a bad scope request does not kill a grant.
  assert.equal(store.refresh(issued.token).outcome, REFRESH_OUTCOME.OK);
});

test("a scope entirely outside the grant is refused", (t) => {
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);
  assert.equal(
    store.refresh(issued.token, { scopes: ["esi-corporations.read_blueprints.v1"] }).outcome,
    REFRESH_OUTCOME.SCOPE_NOT_SUBSET,
  );
});

test("an absent or empty scope means the granted set, both spellings", (t) => {
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);

  for (const request of [undefined, {}, { scopes: [] }, { scope: "" }, { scopes: null }]) {
    const result = store.refresh(issued.token, request);
    assert.equal(result.outcome, REFRESH_OUTCOME.OK, `for ${JSON.stringify(request)}`);
    assert.deepEqual(result.scopes, GRANT.scopes, `for ${JSON.stringify(request)}`);
  }
});

test("a space-delimited scope string narrows exactly as an array does", (t) => {
  // The two neighbours disagree about the type: `routes/oauthAuthorize.js`
  // produces a string, the store names the field `scopes`. Handing the whole
  // string in as one token would silently over-grant, because the giant token
  // matches nothing, so nothing is ever refused for widening.
  const { store } = makeStore(t);
  const issued = store.issue({ ...GRANT, scopes: GRANT.scopes.join(" ") });
  assert.deepEqual(issued.record.scopes, GRANT.scopes);

  const result = store.refresh(issued.token, {
    scope: "publicData esi-markets.structure_markets.v1",
  });
  assert.equal(result.outcome, REFRESH_OUTCOME.OK);
  assert.deepEqual(result.scopes, ["publicData", "esi-markets.structure_markets.v1"]);
});

test("scope comparison is exact: no prefix, no case folding", () => {
  assert.equal(isSubsetOfScopes(["esi-wallet.read_character_wallet.v1"], ["esi-wallet"]), false);
  assert.equal(isSubsetOfScopes(["PublicData"], ["publicData"]), false);
  assert.equal(isSubsetOfScopes([], ["publicData"]), true);
  assert.equal(isSubsetOfScopes(["publicData"], ["publicData"]), true);
});

test("normalizeScopes keeps order, drops duplicates and empties, and says 'not given'", () => {
  assert.equal(normalizeScopes(undefined), null);
  assert.equal(normalizeScopes(null), null);
  assert.deepEqual(normalizeScopes(""), []);
  assert.deepEqual(normalizeScopes("b a b"), ["b", "a"]);
  assert.deepEqual(normalizeScopes(["b", "a", "b", ""]), ["b", "a"]);
  assert.deepEqual(normalizeScopes(["a", 7, null]), ["a"]);
  assert.equal(scopeString(["b", "a"]), "b a");
});

// The corrupt store is refused, never treated as empty

test("a store with an unparseable line is refused, and the file is left alone", (t) => {
  const { store } = makeStore(t);
  store.issue(GRANT);
  const before = fs.readFileSync(store.path, "utf8");

  fs.writeFileSync(store.path, `${before.trimEnd()}\n{"tokenHash": tru\n`);
  const damaged = fs.readFileSync(store.path, "utf8");

  const err = refusal(() => createRefreshTokenStore({ storePath: store.path, now: fakeClock() }));
  assert.match(err.message, /line 3/);
  assert.equal(err.storePath, store.path);
  // The remedy and the cost of taking it, in the same sentence, as
  // lib/signingKey.js does for a damaged key.
  assert.match(err.message, /Move .* aside and restart/);
  assert.match(err.message, /authorise again/);

  // The damaged file is evidence and a restore is possible until something
  // writes over it. Nothing wrote over it.
  assert.equal(fs.readFileSync(store.path, "utf8"), damaged);
});

test("a store with one unusable record refuses the whole file", (t) => {
  // Dropping the line instead would lose one client's grant and report a clean
  // startup.
  const { store } = makeStore(t);
  store.issue(GRANT);
  const lines = fs.readFileSync(store.path, "utf8").trimEnd().split("\n");
  const record = JSON.parse(lines[1]);
  record.scopes = "publicData";
  fs.writeFileSync(store.path, `${lines[0]}\n${JSON.stringify(record)}\n`);

  const err = refusal(() => createRefreshTokenStore({ storePath: store.path, now: fakeClock() }));
  assert.match(err.message, /scopes is not an array of strings/);
  assert.match(err.message, /line 2/);
});

test("each unusable field says which field, not just 'bad record'", (t) => {
  const { store } = makeStore(t);
  store.issue(GRANT);
  const lines = fs.readFileSync(store.path, "utf8").trimEnd().split("\n");
  const good = JSON.parse(lines[1]);

  const cases = [
    [{ tokenHash: "nope" }, /tokenHash/],
    [{ state: "pending" }, /state/],
    [{ characterId: null }, /characterId/],
    [{ clientId: "" }, /clientId/],
    [{ issuedAt: null }, /issuedAt/],
    [{ refreshCount: -1 }, /refreshCount/],
    [{ family: "" }, /family/],
    [{ generation: 1.5 }, /generation/],
    [{ retiredAt: 1 }, /retiredAt/],
    [{ revokedReason: 7 }, /revokedReason/],
  ];

  for (const [patch, pattern] of cases) {
    fs.writeFileSync(store.path, `${lines[0]}\n${JSON.stringify({ ...good, ...patch })}\n`);
    const err = refusal(() => createRefreshTokenStore({ storePath: store.path, now: fakeClock() }));
    assert.match(err.message, pattern, `for ${JSON.stringify(patch)}`);
  }
});

test("the same token recorded twice is refused rather than picked between", (t) => {
  const { store } = makeStore(t);
  store.issue(GRANT);
  const text = fs.readFileSync(store.path, "utf8").trimEnd();
  const lines = text.split("\n");
  fs.writeFileSync(store.path, `${text}\n${lines[1]}\n`);

  const err = refusal(() => createRefreshTokenStore({ storePath: store.path, now: fakeClock() }));
  // Picking one silently either resurrects a revoked grant or destroys a live
  // one, and nothing here can tell which copy is true.
  assert.match(err.message, /the same token twice/);
});

test("a file with no header line is not an empty store", (t) => {
  const storePath = scratchStorePath(t);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, "\n\n");
  const err = refusal(() => createRefreshTokenStore({ storePath, now: fakeClock() }));
  assert.match(err.message, /no header line/);
});

test("some other file at the path says so, and does not tell you to move it", (t) => {
  const storePath = scratchStorePath(t);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify({ kind: "something.else" })}\n`);

  const err = refusal(() => createRefreshTokenStore({ storePath, now: fakeClock() }));
  // A different kind of wrong needs a different sentence: this is more likely
  // a misconfigured path than a damaged store, and `mv` is the wrong advice.
  assert.match(err.message, /is not a refresh token store/);
  assert.doesNotMatch(err.message, /Move .* aside/);
});

test("a newer format version is refused as a version, not as damage", (t) => {
  const storePath = scratchStorePath(t);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    `${JSON.stringify({ kind: STORE_KIND, version: STORE_FORMAT_VERSION + 1 })}\n`,
  );

  const err = refusal(() => createRefreshTokenStore({ storePath, now: fakeClock() }));
  assert.match(err.message, /format version/);
  assert.match(err.message, /written by a different build/);
});

test("an unreadable store is refused rather than started fresh", (t) => {
  const storePath = scratchStorePath(t);
  const failing = {
    ...fs,
    readFileSync: () => {
      const err = new Error("denied");
      err.code = "EACCES";
      throw err;
    },
  };
  const err = refusal(() =>
    createRefreshTokenStore({ storePath, now: fakeClock(), fs: failing }));
  assert.match(err.message, /EACCES/);
  assert.match(err.message, /will not start fresh over it/);
});

test("blank lines are tolerated, because they cannot carry a record", (t) => {
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);
  const lines = fs.readFileSync(store.path, "utf8").trimEnd().split("\n");
  fs.writeFileSync(store.path, `${lines[0]}\n\n${lines[1]}\n\n`);

  const reloaded = createRefreshTokenStore({ storePath: store.path, now: fakeClock() });
  assert.equal(reloaded.refresh(issued.token).outcome, REFRESH_OUTCOME.OK);
});

// Atomicity

test("a failed rename leaves the previous store intact and readable", (t) => {
  const storePath = scratchStorePath(t);
  const now = fakeClock();

  const good = createRefreshTokenStore({ storePath, now });
  const first = good.issue(GRANT);
  const onDisk = fs.readFileSync(storePath, "utf8");

  // The write fails at the last step, after the temp file exists and has been
  // flushed. A non-atomic writer would already have truncated the real file.
  const broken = createRefreshTokenStore({
    storePath,
    now,
    fs: {
      ...fs,
      renameSync: () => {
        const err = new Error("no");
        err.code = "EPERM";
        throw err;
      },
    },
  });
  const second = broken.issue({ ...GRANT, clientId: "another-tool" });
  assert.equal(second.token, null);
  assert.equal(second.failure, ISSUE_FAILURE.PERSIST);

  // Byte for byte what it was, and still a store the loader accepts.
  assert.equal(fs.readFileSync(storePath, "utf8"), onDisk);
  const reloaded = createRefreshTokenStore({ storePath, now });
  assert.equal(reloaded.refresh(first.token).outcome, REFRESH_OUTCOME.OK);
  assert.equal(reloaded.size(), 1);
});

test("a failed write leaves no temp file behind", (t) => {
  const storePath = scratchStorePath(t);
  const store = createRefreshTokenStore({
    storePath,
    now: fakeClock(),
    fs: {
      ...fs,
      renameSync: () => {
        throw new Error("no");
      },
    },
  });
  assert.equal(store.issue(GRANT).failure, ISSUE_FAILURE.PERSIST);

  // A leftover temp file is a credential fragment on disk and a name the next
  // write might collide with.
  const dir = path.dirname(storePath);
  const leftovers = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))
    : [];
  assert.deepEqual(leftovers, []);
});

test("a failed write rolls the store back completely, supersession included", (t) => {
  // The per-subject cap retires a record before the write. If the write then
  // fails and the retirement stands, a client has lost a working token to a
  // write that never happened.
  const storePath = scratchStorePath(t);
  const now = fakeClock();
  const store = createRefreshTokenStore({ storePath, now, maxPerSubject: 1 });
  const first = store.issue(GRANT);

  let failing = false;
  const guardedFs = {
    ...fs,
    renameSync: (...args) => {
      if (failing) throw Object.assign(new Error("no"), { code: "EIO" });
      return fs.renameSync(...args);
    },
  };
  const broken = createRefreshTokenStore({ storePath, now, maxPerSubject: 1, fs: guardedFs });
  failing = true;

  assert.equal(broken.issue(GRANT).failure, ISSUE_FAILURE.PERSIST);
  assert.equal(broken.size(), 1);
  assert.equal(broken.retiredCount(), 0);
  assert.equal(broken.refresh(first.token).outcome, REFRESH_OUTCOME.OK);
});

test("a revocation that cannot be written did not happen", (t) => {
  // A revocation held only in this process's heap comes back to life at the
  // next restart, so an operator told "revoked" would be holding a token that
  // still works.
  const storePath = scratchStorePath(t);
  const now = fakeClock();
  const store = createRefreshTokenStore({ storePath, now });
  const issued = store.issue(GRANT);

  let failing = false;
  const broken = createRefreshTokenStore({
    storePath,
    now,
    fs: {
      ...fs,
      renameSync: (...args) => {
        if (failing) throw Object.assign(new Error("no"), { code: "EIO" });
        return fs.renameSync(...args);
      },
    },
  });
  failing = true;

  const result = broken.revoke(issued.token, { reason: "operator" });
  assert.equal(result.outcome, REVOKE_OUTCOME.PERSIST_FAILED);
  assert.equal(result.record, null);
  // Still live in memory, so the two never disagree, and the revoke endpoint
  // must not answer 200 to this.
  assert.equal(broken.refresh(issued.token).outcome, REFRESH_OUTCOME.OK);
  assert.equal(broken.size(), 1);
});

test("a refresh whose bookkeeping cannot be written still refreshes, and says so", (t) => {
  // The other direction, and why the asymmetry is deliberate: nothing about
  // this refresh needs the disk to be correct. The grant is already on file and
  // unchanged; what failed to persist is `lastUsedAt` and a counter. Failing
  // here would take a working client offline to protect a field nobody's
  // access depends on.
  const storePath = scratchStorePath(t);
  const now = fakeClock();
  const store = createRefreshTokenStore({ storePath, now });
  const issued = store.issue(GRANT);

  let failing = false;
  const log = recordingLog();
  const broken = createRefreshTokenStore({
    storePath,
    now,
    log,
    fs: {
      ...fs,
      renameSync: (...args) => {
        if (failing) throw Object.assign(new Error("no"), { code: "EIO" });
        return fs.renameSync(...args);
      },
    },
  });
  failing = true;

  assert.equal(broken.refresh(issued.token).outcome, REFRESH_OUTCOME.OK);
  assert.ok(log.lines.some((line) => line.includes("may not survive a restart")));
});

test("the store file is rewritten whole, so two backups diff by their records", (t) => {
  // A rewrite that changed nothing produces the same bytes, so an operator
  // diffing two copies sees the records that moved rather than every line
  // reordered.
  const { store, now } = makeStore(t);
  const issued = store.issue(GRANT);
  const first = fs.readFileSync(store.path, "utf8").split("\n").slice(1).join("\n");

  now.advance(1000);
  store.refresh(issued.token);
  const second = fs.readFileSync(store.path, "utf8").split("\n").slice(1).join("\n");

  assert.notEqual(first, second);
  assert.equal(first.split("\n").length, second.split("\n").length);
  assert.equal(JSON.parse(second.split("\n")[0]).refreshCount, 1);
});

// Bounded growth

test("a revoked record is remembered for the retention window, then pruned", (t) => {
  const { store, now } = makeStore(t);
  const issued = store.issue(GRANT);
  store.revoke(issued.token, { reason: "operator" });

  now.advance(DEFAULT_RETENTION_MS - 1);
  assert.equal(store.refresh(issued.token).outcome, REFRESH_OUTCOME.REVOKED);

  // One millisecond over the horizon, and the record ages out on the next
  // mutation (lazily: nothing here wakes on a timer).
  now.advance(2);
  store.issue({ ...GRANT, clientId: "something-else" });
  assert.equal(store.retiredCount(), 0);

  // A pruned replay answers `unknown` instead of `revoked`. Still a refusal,
  // the same `invalid_grant` on the wire, so what is lost is an operational
  // story and never a security property.
  const replayed = store.refresh(issued.token);
  assert.equal(replayed.outcome, REFRESH_OUTCOME.UNKNOWN);
  assert.notEqual(replayed.outcome, REFRESH_OUTCOME.OK);
});

test("pruning happens on load too, without writing to the file", (t) => {
  const storePath = scratchStorePath(t);
  const now = fakeClock();
  const first = createRefreshTokenStore({ storePath, now });
  const issued = first.issue(GRANT);
  first.revoke(issued.token);
  const onDisk = fs.readFileSync(storePath, "utf8");

  now.advance(DEFAULT_RETENTION_MS + 1);
  const log = recordingLog();
  const second = createRefreshTokenStore({ storePath, now, log });

  assert.equal(second.retiredCount(), 0);
  assert.equal(second.refresh(issued.token).outcome, REFRESH_OUTCOME.UNKNOWN);
  assert.ok(log.lines.some((line) => line.includes("aged out")));
  // A load that writes is a load that can damage the file it has just accepted.
  assert.equal(fs.readFileSync(storePath, "utf8"), onDisk);
});

test("a store nobody touches keeps what aged out: the whole meaning of lazy", (t) => {
  const { store, now } = makeStore(t);
  const issued = store.issue(GRANT);
  store.revoke(issued.token);

  now.advance(DEFAULT_RETENTION_MS * 10);
  // No mutation, no sweep. `retiredCount()` reports what is held, not what is
  // still within the window.
  assert.equal(store.retiredCount(), 1);
});

test("retired records are capped, oldest evicted first", (t) => {
  const { store, now } = makeStore(t, { maxRetired: 2 });
  const tokens = [];
  for (let n = 0; n < 3; n += 1) {
    const issued = store.issue({ ...GRANT, clientId: `tool-${n}` });
    tokens.push(issued.token);
    store.revoke(issued.token);
    now.advance(1000);
  }
  // The cap is enforced on the next mutation (the lazy contract).
  store.issue({ ...GRANT, clientId: "tool-9" });

  assert.equal(store.retiredCount(), 2);
  assert.equal(store.refresh(tokens[0]).outcome, REFRESH_OUTCOME.UNKNOWN);
  assert.equal(store.refresh(tokens[1]).outcome, REFRESH_OUTCOME.REVOKED);
  assert.equal(store.refresh(tokens[2]).outcome, REFRESH_OUTCOME.REVOKED);
});

test("one subject's ninth grant retires its least recently used, not its oldest", (t) => {
  const { store, now } = makeStore(t);
  const tokens = [];
  for (let n = 0; n < DEFAULT_MAX_PER_SUBJECT; n += 1) {
    tokens.push(store.issue(GRANT).token);
    now.advance(1000);
  }
  assert.equal(store.size(), DEFAULT_MAX_PER_SUBJECT);

  // The oldest one is the one in active use. Retiring by issue time would kill
  // the token somebody would notice losing.
  now.advance(1000);
  store.refresh(tokens[0]);

  now.advance(1000);
  const newest = store.issue(GRANT);
  assert.equal(newest.token !== null, true);
  assert.equal(store.size(), DEFAULT_MAX_PER_SUBJECT);

  assert.equal(store.refresh(tokens[0]).outcome, REFRESH_OUTCOME.OK);
  assert.equal(store.refresh(tokens[1]).outcome, REFRESH_OUTCOME.SUPERSEDED);
});

test("the per-subject cap is per subject, not global", (t) => {
  const { store } = makeStore(t, { maxPerSubject: 1 });
  const a = store.issue(GRANT);
  const b = store.issue({ ...GRANT, clientId: "other-tool" });
  const c = store.issue({ ...GRANT, characterId: 90000002 });

  assert.equal(store.size(), 3);
  for (const issued of [a, b, c]) {
    assert.equal(store.refresh(issued.token).outcome, REFRESH_OUTCOME.OK);
  }
});

test("at the global cap the store refuses rather than evicting a working grant", (t) => {
  const { store } = makeStore(t, { maxRecords: 2 });
  const a = store.issue({ ...GRANT, clientId: "a" });
  const b = store.issue({ ...GRANT, clientId: "b" });

  const refused = store.issue({ ...GRANT, clientId: "c" });
  assert.equal(refused.token, null);
  assert.equal(refused.failure, ISSUE_FAILURE.AT_CAPACITY);

  // Refuse a new login rather than cancel two working ones. Evicting would log
  // a client out to make room.
  assert.equal(store.refresh(a.token).outcome, REFRESH_OUTCOME.OK);
  assert.equal(store.refresh(b.token).outcome, REFRESH_OUTCOME.OK);
  assert.equal(store.size(), 2);

  // Revoking one frees the slot, which is how an operator clears it.
  store.revoke(a.token);
  assert.equal(store.issue({ ...GRANT, clientId: "c" }).token !== null, true);
});

test("a live grant never expires on a clock", (t) => {
  // Deliberate: CCP publishes no idle expiry, and one here would silently log
  // out the monthly job and the laptop that was closed.
  const { store, now } = makeStore(t);
  const issued = store.issue(GRANT);
  now.advance(5 * 365 * 24 * 60 * 60 * 1000);
  assert.equal(store.refresh(issued.token).outcome, REFRESH_OUTCOME.OK);
});

// Entropy, and what the file does not contain

test("the default token is 256 bits of base64url", () => {
  assert.equal(TOKEN_BYTES, 32);

  const token = defaultGenerateToken();
  // 32 bytes base64url, unpadded, is 43 characters, the same width as the
  // authorization code. That one leans partly on a 60-second TTL and this one
  // has no TTL, so the entropy is the whole defence.
  assert.equal(token.length, 43);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, "base64url").length, TOKEN_BYTES);

  const seen = new Set();
  for (let n = 0; n < 500; n += 1) seen.add(defaultGenerateToken());
  assert.equal(seen.size, 500);
});

test("the token itself is never written to the store file", (t) => {
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);
  const text = fs.readFileSync(store.path, "utf8");

  // A copy of this file is a list of who authorised what, not a set of working
  // credentials. Unlike the signing key, a store plausibly ends up in a backup
  // or a bug report.
  assert.equal(text.includes(issued.token), false);
  assert.equal(text.includes(hashToken(issued.token)), true);
});

test("the log carries fingerprints, never tokens", (t) => {
  const log = recordingLog();
  const { store } = makeStore(t, { log, maxPerSubject: 1 });
  const first = store.issue(GRANT);
  const second = store.issue(GRANT);
  store.revoke(second.token, { reason: "operator" });

  assert.ok(log.lines.length > 0);
  for (const line of log.lines) {
    assert.equal(line.includes(first.token), false, line);
    assert.equal(line.includes(second.token), false, line);
  }
  // A positive control, so the search above cannot pass by finding nothing.
  assert.ok(log.lines.some((line) => line.includes(hashToken(second.token).slice(0, 12))));
});

test("the stored key is an unkeyed SHA-256 of the token", () => {
  // Asserted mechanically because a future change would break this silently:
  // an HMAC here would put a secret in the refresh token's validation path.
  const token = defaultGenerateToken();
  assert.equal(
    hashToken(token),
    crypto.createHash("sha256").update(token, "utf8").digest("hex"),
  );
  assert.match(hashToken(token), /^[0-9a-f]{64}$/);
});

test("nothing in lib/refreshTokens.js depends on the signing key", () => {
  // D8's resolution (one signing slot, rotation as a deliberate loud break) is
  // affordable only because refresh tokens are opaque and stored rather than
  // signed by that key. If this ever fails, D8 has to be reopened before the
  // change lands: a key rotation would invalidate every refresh token.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "lib", "refreshTokens.js"),
    "utf8",
  );

  const required = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  assert.deepEqual(required.sort(), ["node:crypto", "node:fs", "node:path"]);

  // And no keyed hash anywhere: an HMAC would need a key, and the only key
  // around is the one this must not touch.
  assert.equal(/createHmac|privateKey|createSign/.test(source), false);
});

// Issue-time refusals

test("a grant with no usable subject is refused, and nothing is written", (t) => {
  const { store } = makeStore(t);
  for (const bad of [{}, { clientId: "x" }, { characterId: 1 }, { characterId: 1, clientId: "" },
    { characterId: null, clientId: "x" }, { characterId: {}, clientId: "x" }]) {
    const result = store.issue(bad);
    assert.equal(result.token, null, JSON.stringify(bad));
    assert.equal(result.failure, ISSUE_FAILURE.SUBJECT, JSON.stringify(bad));
  }
  assert.equal(store.issue(null).failure, ISSUE_FAILURE.SUBJECT);
  assert.equal(fs.existsSync(store.path), false);
});

test("a character id may be a string, as long as it is the same string", (t) => {
  // This mod does not decide what shape the game's ids are; the subject key
  // only needs the same character to always produce the same key.
  const { store } = makeStore(t, { maxPerSubject: 1 });
  const a = store.issue({ ...GRANT, characterId: "90000001" });
  const b = store.issue({ ...GRANT, characterId: "90000001" });
  assert.equal(store.refresh(a.token).outcome, REFRESH_OUTCOME.SUPERSEDED);
  assert.equal(store.refresh(b.token).outcome, REFRESH_OUTCOME.OK);

  // The numeric 90000001 is the same subject as the string. A caller that
  // passed the id as a number on one path and a string on another would
  // otherwise get two subjects for one character and two sets of grants, with
  // the cap quietly not applying.
  const c = store.issue({ ...GRANT, characterId: 90000001 });
  assert.equal(store.refresh(b.token).outcome, REFRESH_OUTCOME.SUPERSEDED);
  assert.equal(store.refresh(c.token).outcome, REFRESH_OUTCOME.OK);
  // The record still keeps the type it was handed; only the key is flattened.
  assert.equal(store.inspect(a.token).record.characterId, "90000001");
  assert.equal(c.record.characterId, 90000001);
});

test("a colliding generator is refused, never retried and never overwritten", (t) => {
  const { store } = makeStore(t, { generateToken: () => "always-the-same" });
  const first = store.issue(GRANT);
  assert.equal(first.token, "always-the-same");

  const second = store.issue({ ...GRANT, clientId: "other" });
  assert.equal(second.token, null);
  assert.equal(second.failure, ISSUE_FAILURE.COLLISION);

  // Overwriting would destroy a working grant. There is no retry loop because
  // the only generator that collides is one that would collide again.
  assert.equal(store.refresh("always-the-same").record.clientId, GRANT.clientId);

  // A retired record blocks reuse too, or a revoked token would come back to
  // life under a second grant.
  store.revoke("always-the-same");
  assert.equal(store.issue(GRANT).failure, ISSUE_FAILURE.COLLISION);
});

test("a generator that returns junk is a failure, not a throw", (t) => {
  for (const bad of [() => "", () => null, () => 7, () => undefined]) {
    const { store } = makeStore(t, { generateToken: bad });
    assert.equal(store.issue(GRANT).failure, ISSUE_FAILURE.GENERATOR);
  }
});

test("a generator that throws is a failure, not a throw either", (t) => {
  // The injection seam must not break the module's promise that nothing on the
  // request path throws, because eve.js treats an unhandled rejection as fatal.
  // A generator that throws is the same class of programming error as one that
  // returns a number, so it gets the same answer.
  const log = recordingLog();
  const { store } = makeStore(t, {
    log,
    generateToken: () => {
      throw new Error("no entropy today");
    },
  });
  assert.doesNotThrow(() => store.issue(GRANT));
  assert.equal(store.issue(GRANT).failure, ISSUE_FAILURE.GENERATOR);
  assert.ok(log.lines.some((line) => line.includes("generator threw")));
});

test("nothing on the request path throws, whatever it is handed", (t) => {
  // eve.js treats an unhandled rejection as fatal (see server.js's header), so
  // a store that can kill the universe while declining to refresh a token has
  // failed worse than the refresh did.
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);

  for (const junk of [null, undefined, 7, {}, [], Symbol("x")]) {
    assert.doesNotThrow(() => store.refresh(junk));
    assert.doesNotThrow(() => store.revoke(junk));
    assert.doesNotThrow(() => store.revokeFamily(junk));
    assert.doesNotThrow(() => store.inspect(junk));
    assert.doesNotThrow(() => store.refresh(issued.token, junk));
    // A fresh grant each time, so the junk request is read on the path that
    // matched a family rather than on the early no-op.
    assert.doesNotThrow(() => store.revokeFamily(store.issue(GRANT).record.family, junk));
  }
});

test("a record handed to a caller cannot be edited in place", (t) => {
  const { store } = makeStore(t);
  const issued = store.issue(GRANT);
  assert.throws(() => {
    issued.record.characterId = 1;
  }, TypeError);
  assert.throws(() => {
    issued.record.scopes.push("esi-everything.v1");
  }, TypeError);
});

// Construction

test("the store refuses to be built without a path or a clock", (t) => {
  const storePath = scratchStorePath(t);
  refusal(() => createRefreshTokenStore({ now: fakeClock() }));
  refusal(() => createRefreshTokenStore({ storePath: "   ", now: fakeClock() }));
  // Required rather than defaulted, as in lib/authCodes.js: a store that
  // silently reached for Date.now() would let a test pass without injecting a
  // clock, and a thirty-day horizon has to be arithmetic.
  refusal(() => createRefreshTokenStore({ storePath }));
  refusal(() => createRefreshTokenStore({ storePath, now: 12 }));
  refusal(() => createRefreshTokenStore({ storePath, now: fakeClock(), generateToken: 1 }));

  for (const bad of ["maxRecords", "maxPerSubject", "retentionMs", "maxRetired"]) {
    for (const value of [0, -1, 1.5, "8", null]) {
      refusal(() => createRefreshTokenStore({ storePath, now: fakeClock(), [bad]: value }));
    }
  }
});

test("a clock that returns nonsense does not poison the store's horizons", (t) => {
  // A NaN issuedAt compares false against everything, so nothing would ever age
  // out and the prune would silently stop working.
  const { store } = makeStore(t, { now: () => "not a number" });
  const issued = store.issue(GRANT);
  assert.equal(Number.isFinite(issued.record.issuedAt), true);
  assert.equal(store.refresh(issued.token).outcome, REFRESH_OUTCOME.OK);
});

// Permissions

test("permissionWarningsFor reports a POSIX store readable beyond its owner", () => {
  assert.deepEqual(permissionWarningsFor(0o600, "linux", "/x/refresh-tokens.jsonl"), []);
  const warnings = permissionWarningsFor(0o644, "linux", "/x/refresh-tokens.jsonl");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /readable beyond its owner/);
  assert.match(warnings[0], /644/);
});

test("permissionWarningsFor says nothing on Windows, because the bits say nothing", () => {
  // Node maps a POSIX mode onto the read-only attribute and nothing else, and
  // node:fs cannot set an ACL, so no claim is made about the number (the same
  // position lib/signingKey.js takes).
  assert.deepEqual(permissionWarningsFor(0o644, "win32", "/x/refresh-tokens.jsonl"), []);
  assert.deepEqual(permissionWarningsFor(0o777, "win32", "/x/refresh-tokens.jsonl"), []);
  assert.deepEqual(permissionWarningsFor(undefined, "linux", "/x/refresh-tokens.jsonl"), []);
});

test("a POSIX permission warning reaches the log without failing the load", (t) => {
  const storePath = scratchStorePath(t);
  const now = fakeClock();
  createRefreshTokenStore({ storePath, now }).issue(GRANT);

  const log = recordingLog();
  const store = createRefreshTokenStore({
    storePath,
    now,
    log,
    platform: "linux",
    fs: { ...fs, statSync: () => ({ mode: 0o644 }) },
  });

  // A warning and never a refusal: a group-readable store still holds correct
  // grants, and taking SSO down over a permission bit trades a small exposure
  // for a total outage.
  assert.equal(store.size(), 1);
  assert.ok(log.lines.some((line) => line.includes("readable beyond its owner")));
});
