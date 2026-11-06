/**
 * evejs-launcher.mod.json against config.js (D47). An untouched install relies on
 * DEFAULTS while the launcher form displays the manifest, so the two must agree.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { DEFAULTS, ENV_KEYS, MOD_VERSION, RESERVED_GAME_PORTS, SETTINGS_ENV_KEYS } = require("../config");

const MANIFEST_PATH = path.join(__dirname, "..", "evejs-launcher.mod.json");
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const fields = manifest.settings.fields;

test("the manifest version is MOD_VERSION", () => {
  assert.equal(manifest.version, MOD_VERSION);
});

test("the package identity is what the launcher and the deploy script expect", () => {
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.id, "esiApi");
  assert.equal(manifest.kind, "loader");
  assert.deepEqual(manifest.activation, { strategy: "loader_rename" });
  assert.deepEqual(manifest.supportedBackends, ["native", "docker"]);
});

test("the form's fields and the settings allowlist are one set", () => {
  assert.deepEqual(fields.map((field) => field.id).sort(), Object.keys(SETTINGS_ENV_KEYS).sort());
});

test("every field writes its own id, flat, into settings.json", () => {
  assert.deepEqual(manifest.settings.files, [
    { id: "settings", base: "mod", path: "settings.json", format: "json" },
  ]);
  for (const field of fields) {
    assert.deepEqual(field.key, [field.id]);
    assert.equal(field.file, "settings");
    assert.equal(field.restart, "game_server");
  }
});

test("every allowlisted setting maps to a key the mod reads", () => {
  for (const [settingsKey, envKey] of Object.entries(SETTINGS_ENV_KEYS)) {
    assert.equal(ENV_KEYS.includes(envKey), true, `${settingsKey} maps to ${envKey}`);
  }
  assert.equal(Object.isFrozen(SETTINGS_ENV_KEYS), true);
});

test("every field's default equals DEFAULTS", () => {
  for (const field of fields) {
    // A launcher string field has no null: blank is how it says "not configured".
    const expected = DEFAULTS[field.id] === null ? "" : DEFAULTS[field.id];
    assert.equal(field.default, expected, field.id);
  }
});

test("no development or credential-path key appears in the form", () => {
  const banned = /dev|autoapprove|statedir|signingkey/i;
  for (const field of fields) assert.doesNotMatch(field.id, banned);
  for (const envKey of Object.values(SETTINGS_ENV_KEYS)) {
    assert.doesNotMatch(envKey, /DEV_AUTO_APPROVE|STATE_DIR|SIGNING_KEY/);
  }
});

test("updates preserve .env.txt and ask for the versioned asset", () => {
  assert.deepEqual(manifest.updates.preserveFiles, [".env.txt"]);
  assert.equal(manifest.updates.asset, "EveJS-ESI-{version}.zip");
  assert.equal(manifest.updates.tagPrefix, "v");
});

test("no compatibility pin: entries are exact matches and go stale at every eve.js drop", () => {
  assert.equal(Object.hasOwn(manifest, "compatibility"), false);
});

test("the text a user reads carries no em dash", () => {
  assert.equal(fs.readFileSync(MANIFEST_PATH, "utf8").includes(String.fromCodePoint(0x2014)), false);
});

test("the issuer's description says tools must sign in again", () => {
  const issuer = fields.find((field) => field.id === "ssoIssuer");
  assert.match(issuer.description, /sign in again/);
});

test("the ESI port field is where 0 means off, and only there", () => {
  const byId = Object.fromEntries(fields.map((field) => [field.id, field]));
  assert.equal(byId.esiPort.minimum, 0);
  assert.match(byId.esiPort.description, /0 turns the ESI listener off/);
  assert.equal(byId.ssoPort.minimum, 1);
});

test("both port fields state the ports eve.js reserves", () => {
  for (const id of ["esiPort", "ssoPort"]) {
    const field = fields.find((candidate) => candidate.id === id);
    for (const port of RESERVED_GAME_PORTS.keys()) {
      assert.match(field.description, new RegExp(`\\b${port}\\b`), `${id} must state ${port}`);
    }
  }
});

test("the README states the ports eve.js reserves", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  for (const port of RESERVED_GAME_PORTS.keys()) {
    assert.match(readme, new RegExp(`\\b${port}\\b`), `the README must state ${port}`);
  }
});
