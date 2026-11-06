/**
 * scripts/build-release.js (D47). The ZIP is read back here by a small reader
 * written from the format's own description, sharing nothing with the writer:
 * end-of-central-directory, central directory, local headers, inflate, CRC.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const MOD_DIR = path.resolve(__dirname, "..");
const { MOD_VERSION } = require(path.join(MOD_DIR, "config"));
const { shortSourceHash } = require(path.join(MOD_DIR, "lib", "sourceHash"));
const { listReleaseFiles } = require(path.join(MOD_DIR, "scripts", "deploy-mod"));
const { buildRelease } = require(path.join(MOD_DIR, "scripts", "build-release"));

const TWO_MIB = 2 * 1024 * 1024;

function tempDir(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `esi-mod-release-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A source tree holding this repository's release files and whatever else is asked for. */
function sourceTree(t, extra = {}) {
  const dir = tempDir(t, "source");
  for (const rel of listReleaseFiles(MOD_DIR)) {
    const to = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(MOD_DIR, ...rel.split("/")), to);
  }
  for (const [rel, content] of Object.entries(extra)) {
    const to = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content);
  }
  return dir;
}

function readZip(file) {
  const zip = fs.readFileSync(file);

  let eocd = -1;
  for (let at = zip.length - 22; at >= 0; at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  assert.notEqual(eocd, -1, "no end-of-central-directory record");

  const count = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralStart = zip.readUInt32LE(eocd + 16);
  assert.equal(centralStart + centralSize, eocd, "the central directory ends where the EOCD begins");

  const entries = new Map();
  let at = centralStart;
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, "central header signature");
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);

    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50, `local header signature for ${name}`);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    assert.equal(
      zip.toString("utf8", localOffset + 30, localOffset + 30 + localNameLength),
      name,
      "the local and central names agree",
    );

    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    assert.equal(method, 8, `${name} is deflated`);
    const bytes = zlib.inflateRawSync(data);
    assert.equal(bytes.length, size, `${name} size`);
    assert.equal(zlib.crc32(bytes), crc, `${name} crc`);

    assert.equal(entries.has(name), false, `${name} appears once`);
    entries.set(name, bytes);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("the ZIP round-trips: every release file, under esiApi/, byte for byte", (t) => {
  const out = tempDir(t, "out");
  const built = buildRelease({ sourceDir: MOD_DIR, outDir: out });
  const entries = readZip(built.zipPath);

  assert.equal(path.basename(built.zipPath), `EveJS-ESI-${MOD_VERSION}.zip`);

  for (const name of entries.keys()) assert.match(name, /^esiApi\/[^/]/);

  for (const rel of listReleaseFiles(MOD_DIR)) {
    const name = rel === "loader.js" ? "esiApi/loader.js.disabled" : `esiApi/${rel}`;
    assert.ok(entries.has(name), `${name} is in the ZIP`);
    assert.deepEqual(entries.get(name), fs.readFileSync(path.join(MOD_DIR, ...rel.split("/"))), name);
  }
});

test("the package has exactly one loader state, disabled, and it is under 2 MiB", (t) => {
  const built = buildRelease({ sourceDir: MOD_DIR, outDir: tempDir(t, "out") });
  const entries = readZip(built.zipPath);

  assert.equal(entries.has("esiApi/loader.js"), false);
  assert.ok(entries.has("esiApi/loader.js.disabled"));
  const loaders = [...entries.keys()].filter((name) => /^esiApi\/loader\.js/.test(name));
  assert.equal(loaders.length, 1);
  assert.ok(entries.get("esiApi/loader.js.disabled").length < TWO_MIB);
});

test("the ZIP holds the release list, and nothing else from the tree", (t) => {
  const source = sourceTree(t, {
    "README.md": "# readme\n",
    LICENSE: "not shipped\n",
    NOTICE: "not shipped\n",
    "settings.json": '{"esiPort":26105}\n',
    ".env": "ESI_MOD_LOG_LEVEL=debug\n",
    ".env.txt": "ESI_MOD_LOG_LEVEL=debug\n",
    ".claude/worktrees/stray/loader.js": "// a stray copy\n",
    "docs/concept.md": "# no\n",
    "test/x.test.js": "// no\n",
    "scripts/deploy-mod.js": "// no\n",
    "dist/old.zip": "no",
    "package.json": "{}\n",
  });

  const built = buildRelease({ sourceDir: source, outDir: tempDir(t, "out") });
  const names = [...readZip(built.zipPath).keys()].sort();

  const expected = [
    ...listReleaseFiles(MOD_DIR).map((rel) => (rel === "loader.js" ? "loader.js.disabled" : rel)),
  ].map((rel) => `esiApi/${rel}`).sort();
  assert.deepEqual(names, expected);
});

test("README.md is optional", (t) => {
  const source = sourceTree(t);
  fs.rmSync(path.join(source, "README.md"));
  const built = buildRelease({ sourceDir: source, outDir: tempDir(t, "out") });
  assert.equal(readZip(built.zipPath).has("esiApi/README.md"), false);
});

test("settings.json, .env and .env.txt never reach this repository's own ZIP", (t) => {
  const built = buildRelease({ sourceDir: MOD_DIR, outDir: tempDir(t, "out") });
  const names = [...readZip(built.zipPath).keys()];
  for (const banned of ["esiApi/settings.json", "esiApi/.env", "esiApi/.env.txt"]) {
    assert.equal(names.includes(banned), false, banned);
  }
});

test("the sidecar is what the launcher's metadata tool would write", (t) => {
  const built = buildRelease({ sourceDir: MOD_DIR, outDir: tempDir(t, "out") });

  assert.equal(path.basename(built.sidecarPath), `EveJS-ESI-${MOD_VERSION}.update.json`);
  assert.equal(
    fs.readFileSync(built.sidecarPath, "utf8"),
    `${JSON.stringify(
      { schemaVersion: 1, id: "esiApi", version: MOD_VERSION, asset: `EveJS-ESI-${MOD_VERSION}.zip` },
      null,
      2,
    )}\n`,
  );
});

test("a manifest version that disagrees with MOD_VERSION stops the build", (t) => {
  const source = sourceTree(t);
  const file = path.join(source, "evejs-launcher.mod.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.version = "9.9.9";
  fs.writeFileSync(file, JSON.stringify(manifest));

  const out = tempDir(t, "out");
  assert.throws(() => buildRelease({ sourceDir: source, outDir: out }), /9\.9\.9.*MOD_VERSION|MOD_VERSION.*9\.9\.9/);
  assert.deepEqual(fs.readdirSync(out), [], "a refused build writes nothing");
});

test("a loader at the launcher's 2 MiB limit stops the build", (t) => {
  const source = sourceTree(t, { "loader.js": Buffer.alloc(TWO_MIB, 0x20) });
  assert.throws(() => buildRelease({ sourceDir: source, outDir: tempDir(t, "out") }), /2 MiB/);
});

test("the build reports the source tree's hash, and two builds are the same bytes", (t) => {
  const first = buildRelease({ sourceDir: MOD_DIR, outDir: tempDir(t, "a") });
  const second = buildRelease({ sourceDir: MOD_DIR, outDir: tempDir(t, "b") });

  assert.equal(first.sourceHash, shortSourceHash(MOD_DIR));
  assert.deepEqual(fs.readFileSync(first.zipPath), fs.readFileSync(second.zipPath));
});

test("the ZIP's list is the deploy manifest and no second list", () => {
  assert.equal(listReleaseFiles(MOD_DIR).includes("README.md"), true);
  const script = fs.readFileSync(path.join(MOD_DIR, "scripts", "build-release.js"), "utf8");
  assert.doesNotMatch(script, /README_NAME/);
});
