#!/usr/bin/env node
/**
 * Build the launcher release assets (D47):
 *
 *   dist/EveJS-ESI-<version>.zip          one esiApi/ root, loader.js.disabled
 *   dist/EveJS-ESI-<version>.update.json  the sidecar the launcher's updater reads
 *
 *   node scripts/build-release.js [--out <dir>]
 *
 * Contents come from `listReleaseFiles`, the same list a deploy uses, never from a
 * walk of the repository. The launcher imports a package disabled and expects it to say so, so `loader.js`
 * is stored as `loader.js.disabled`. Enabling restores the exact bytes, so an
 * enabled install reports the hash this script prints.
 *
 * Bytes are copied verbatim and every timestamp is fixed, so one checkout builds
 * one ZIP. The sidecar is byte-identical to what the launcher's own
 * build_mod_update_metadata.py writes for the same ZIP.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SOURCE_DIR = path.resolve(__dirname, "..");

const { listReleaseFiles, isProtected } = require(path.join(__dirname, "deploy-mod"));
const { shortSourceHash } = require(path.join(SOURCE_DIR, "lib", "sourceHash"));

// The launcher derives the install folder from this prefix. A flat ZIP would
// install under the ZIP's stem, with a version in its name forever.
const ROOT_FOLDER = "esiApi";
const MANIFEST_NAME = "evejs-launcher.mod.json";
const ENABLED_LOADER = "loader.js";
const DISABLED_LOADER = "loader.js.disabled";

// The launcher refuses a larger loader.
const LOADER_SIZE_LIMIT = 2 * 1024 * 1024;

// ZIP constants, from the PKWARE application note.
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY_UNIX = (3 << 8) | VERSION_NEEDED;
const FLAG_UTF8_NAMES = 0x0800;
const METHOD_DEFLATE = 8;
const DOS_TIME = 0;
const DOS_DATE_1980_01_01 = 0x0021;
const REGULAR_FILE_0644 = (0o100644 << 16) >>> 0;

/**
 * A deflate ZIP of `files`, an array of `{ name, bytes }`, in the order given.
 * @returns {Buffer}
 */
function writeZip(files) {
  const body = [];
  const central = [];
  let offset = 0;

  for (const { name, bytes } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = zlib.deflateRawSync(bytes, { level: 9 });
    const crc = zlib.crc32(bytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8_NAMES, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    body.push(local, nameBytes, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    header.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(FLAG_UTF8_NAMES, 8);
    header.writeUInt16LE(METHOD_DEFLATE, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(bytes.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(REGULAR_FILE_0644, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...body, centralBytes, end]);
}

/** Every entry of the package, sorted, with the loader in its disabled state. */
function collectEntries(sourceDir) {
  const rels = listReleaseFiles(sourceDir);

  const entries = rels.map((rel) => {
    if (isProtected(rel)) throw new Error(`refusing to package ${rel}: it belongs to the install.`);
    const packaged = rel === ENABLED_LOADER ? DISABLED_LOADER : rel;
    return {
      name: `${ROOT_FOLDER}/${packaged}`,
      bytes: fs.readFileSync(path.join(sourceDir, ...rel.split("/"))),
    };
  });

  return entries.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Build both assets into `outDir`. Throws, having written nothing, when the
 * package would be wrong.
 *
 * @returns {{zipPath: string, sidecarPath: string, version: string, sourceHash: string}}
 */
function buildRelease({ sourceDir = SOURCE_DIR, outDir = path.join(sourceDir, "dist") } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, MANIFEST_NAME), "utf8"));
  const { MOD_VERSION } = require(path.join(sourceDir, "config.js"));

  if (manifest.version !== MOD_VERSION) {
    throw new Error(
      `${MANIFEST_NAME} says version ${manifest.version} but MOD_VERSION in config.js is ` +
        `${MOD_VERSION}. They must be equal.`,
    );
  }

  const entries = collectEntries(sourceDir);

  const loader = entries.find((entry) => entry.name === `${ROOT_FOLDER}/${DISABLED_LOADER}`);
  if (!loader) throw new Error(`no ${ENABLED_LOADER} in ${sourceDir}.`);
  if (loader.bytes.length >= LOADER_SIZE_LIMIT) {
    throw new Error(`${ENABLED_LOADER} is ${loader.bytes.length} bytes; the launcher's limit is 2 MiB.`);
  }

  const asset = manifest.updates.asset.replace("{version}", MOD_VERSION);
  const sidecar = { schemaVersion: 1, id: manifest.id, version: MOD_VERSION, asset };

  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, asset);
  const sidecarPath = path.join(outDir, asset.replace(/\.zip$/, ".update.json"));
  fs.writeFileSync(zipPath, writeZip(entries));
  fs.writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

  return { zipPath, sidecarPath, version: MOD_VERSION, sourceHash: shortSourceHash(sourceDir) };
}

function main(argv) {
  let outDir;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out" && argv[i + 1]) {
      outDir = path.resolve(argv[i + 1]);
      i += 1;
    } else {
      console.error("Usage: node scripts/build-release.js [--out <dir>]");
      return 2;
    }
  }

  try {
    const built = buildRelease(outDir ? { outDir } : {});
    console.log(`version:    ${built.version}`);
    console.log(`sourceHash: ${built.sourceHash}`);
    console.log(built.zipPath);
    console.log(built.sidecarPath);
    return 0;
  } catch (err) {
    console.error(`build-release: ${err.message}`);
    return 1;
  }
}

module.exports = Object.freeze({ buildRelease, writeZip });

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
