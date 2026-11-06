#!/usr/bin/env node
/**
 * Pin CCP's OpenAPI document into `contract/`, or check the pin for drift.
 *
 *   node scripts/pin-spec.js            fetch, normalize, write, report
 *   node scripts/pin-spec.js --check    fetch and compare; change nothing
 *
 * Why a pinned copy: the test suite is offline by construction. `node --test`
 * has to pass on a machine with no route to the internet, as it does with no
 * eve.js checkout present. A suite that reaches the network fails for reasons
 * unrelated to the code under test, and can stop failing when CCP changes
 * something underneath it. A pinned document makes re-pinning a deliberate act
 * with a visible diff: when CCP retypes a field, it shows up as a reviewed
 * change to this repository rather than a green run against a moved target.
 *
 * Why the default fetch: `GET /meta/openapi.json` is compatibility-date scoped
 * like every other route. Sent with no `X-Compatibility-Date`, it returns the
 * `2020-01-01` surface that D4 targets, and `info.version` says so. Sent with a
 * modern date it returns a different, larger document that is missing
 * `/sovereignty/map`, one of the 35 endpoints served here. The legacy surface
 * has its own machine-readable spec, so there is no second document to
 * reconcile. The `info.version` guard keeps that true: if CCP moves the
 * default, this script refuses to write rather than swap the surface the suite
 * is built on.
 *
 * Why the stored copy is normalized (D22): CCP serves 464 KB on a single line.
 * Committed verbatim, every re-pin is a one-line diff nobody can read. The
 * stored copy is pretty-printed with sorted keys, and `provenance.json` carries
 * the SHA-256 of the raw bytes, so the normalization stays checkable: re-fetch,
 * hash, compare.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");


const SPEC_URL = "https://esi.evetech.net/meta/openapi.json";

/**
 * The surface D4 targets, and the value `info.version` must carry.
 *
 * A tripwire, not a preference. The request below sends no
 * `X-Compatibility-Date`, relying on CCP's documented default. If that default
 * moves, every schema in the pinned document silently becomes a different
 * contract, and nothing else in the repository would notice.
 */
const EXPECTED_COMPATIBILITY_DATE = "2020-01-01";

const CONTRACT_DIR = path.resolve(__dirname, "..", "contract");
const SPEC_PATH = path.join(CONTRACT_DIR, "openapi.json");
const PROVENANCE_PATH = path.join(CONTRACT_DIR, "provenance.json");


/**
 * The same value with every object's keys in sorted order.
 *
 * Arrays keep their order: in OpenAPI it is meaningful (`required`, `enum`,
 * `parameters`), and sorting would be an edit rather than a formatting choice.
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;

  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

/** The exact bytes written to `contract/openapi.json`. LF, trailing newline. */
function normalize(spec) {
  return JSON.stringify(sortKeys(spec), null, 2) + "\n";
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}


/**
 * The raw response text, plus what the parse says about it.
 *
 * Returns the raw text and not just the parsed object: the hash in
 * `provenance.json` is of what CCP sent, so it is taken before anything
 * reshapes it.
 */
async function fetchSpec(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }

  const raw = await response.text();
  return { raw, spec: JSON.parse(raw) };
}

/** Every `path` × `method` pair the document describes. */
function countOperations(spec) {
  let count = 0;
  for (const item of Object.values(spec.paths || {})) {
    for (const key of Object.keys(item)) {
      if (["get", "put", "post", "delete", "patch", "head", "options"].includes(key)) count += 1;
    }
  }
  return count;
}

function buildProvenance(url, raw, spec, normalized, retrievedAt) {
  return {
    sourceUrl: url,
    retrievedAt,
    compatibilityDate: spec.info.version,
    openapi: spec.openapi,
    title: spec.info.title,
    rawBytes: Buffer.byteLength(raw, "utf8"),
    rawSha256: sha256(raw),
    normalizedSha256: sha256(normalized),
    pathCount: Object.keys(spec.paths || {}).length,
    operationCount: countOperations(spec),
    note:
      "Fetched with no X-Compatibility-Date header, which is what makes this the "
      + "2020-01-01 surface (D4). Stored pretty-printed with sorted keys; "
      + "rawSha256 is of the bytes as served. Re-pin with scripts/pin-spec.js.",
  };
}


function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

async function main(argv) {
  const check = argv.includes("--check");

  const { raw, spec } = await fetchSpec(SPEC_URL);

  if (!spec.info || spec.info.version !== EXPECTED_COMPATIBILITY_DATE) {
    throw new Error(
      `refusing to pin: expected the default surface to be ${EXPECTED_COMPATIBILITY_DATE}, `
        + `but ${SPEC_URL} reports ${spec.info && spec.info.version}. `
        + "CCP has moved the default compatibility date; D4 needs revisiting before this is re-pinned.",
    );
  }

  const normalized = normalize(spec);
  const retrievedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const provenance = buildProvenance(SPEC_URL, raw, spec, normalized, retrievedAt);

  if (check) {
    const pinned = readJsonIfPresent(PROVENANCE_PATH);
    if (!pinned) {
      console.error("no pin yet: contract/provenance.json is missing or unreadable.");
      return 1;
    }
    if (pinned.rawSha256 === provenance.rawSha256) {
      console.log(`in sync: the pinned spec matches ${SPEC_URL} (${pinned.rawSha256.slice(0, 12)}).`);
      return 0;
    }
    console.log(`drift: the pinned spec no longer matches ${SPEC_URL}.`);
    console.log(`  pinned ${pinned.rawSha256.slice(0, 12)} on ${pinned.retrievedAt}`);
    console.log(`  live   ${provenance.rawSha256.slice(0, 12)}`);
    console.log(`  paths  ${pinned.pathCount} -> ${provenance.pathCount}`);
    console.log("\nRun `node scripts/pin-spec.js` to re-pin, and review the diff.");
    return 1;
  }

  fs.mkdirSync(CONTRACT_DIR, { recursive: true });
  fs.writeFileSync(SPEC_PATH, normalized);
  fs.writeFileSync(PROVENANCE_PATH, JSON.stringify(provenance, null, 2) + "\n");

  console.log(`pinned ${provenance.compatibilityDate} from ${SPEC_URL}`);
  console.log(`  ${provenance.pathCount} paths, ${provenance.operationCount} operations`);
  console.log(`  raw ${provenance.rawBytes} bytes, sha256 ${provenance.rawSha256.slice(0, 12)}`);
  console.log(`  written to ${path.relative(process.cwd(), SPEC_PATH)}`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(String((err && err.message) || err));
      process.exit(1);
    },
  );
}

module.exports = { EXPECTED_COMPATIBILITY_DATE, SPEC_URL, normalize, sortKeys, sha256 };
