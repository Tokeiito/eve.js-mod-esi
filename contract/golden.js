/**
 * Golden bodies: what CCP actually sent, kept as bytes.
 *
 * Why bytes and not a shape
 *
 * `contract/spec.js` says a body is *allowed*: right field names, right types,
 * nothing required missing. A client parses the bytes, and each of these passes
 * a schema check while breaking something real:
 *
 *   {"players":12345,"server_version":"1132976"}   a field quietly dropped
 *   {"server_version":"1132976","players":12345}   fields in the wrong order
 *   {"players":"12345"}                            an int64 sent as a string
 *   {"players":12345,"vip":null}                   null where CCP omits
 *   {"players":12345,...}   without the newline    one byte short of CCP's
 *                                                  content-length
 *
 * So an endpoint's last test is a byte-for-byte diff against a body CCP served,
 * with one golden per implemented endpoint. This module is the machinery.
 *
 * What may be recorded
 *
 * Nothing under `contract/` is anyone's character data, and nothing here needs
 * a token to fetch (`contract/wire.js` records no fixture corpus). A golden body
 * is a **public, unauthenticated** ESI response: server status, a region, a
 * system, a type. An authenticated endpoint's fidelity is proved against the
 * spec and a body written by hand from CCP's documented field list, never
 * against a recording of somebody's character.
 *
 * Recording one
 *
 *   curl -sD - https://esi.evetech.net/latest/universe/regions/10000002/ \
 *     -o contract/golden/GetUniverseRegionsRegionId.json
 *
 * No `X-Compatibility-Date` header, which makes it the `2020-01-01` surface the
 * rest of `contract/` is pinned to (D4). No `-H 'Accept-Encoding'` changes, no
 * pretty-printing, no editing afterwards. Then add its entry to
 * `contract/golden/index.json`, which carries the URL and the date;
 * `assertGolden` refuses a file with no entry, so unattributed bytes cannot
 * become a contract.
 *
 * `-D -` rather than plain `-s`, because the entry must say which implementation
 * answered (`gateway` for a bare `application/json`, `app` for
 * `application/json; charset=UTF-8`), and only the headers show that.
 *
 * The last byte is part of the recording
 *
 * A gateway body ends with `\n` and an application body does not, so these files
 * differ on purpose. Do not add or strip a final newline: `findIndexProblems`
 * cross-checks every file's last byte against its declared producer, because an
 * editor that terminates text files would otherwise rewrite the contract.
 *
 * Git normalizes line endings repository-wide, and that is safe here: JSON
 * forbids a raw control character inside a string, so a minified body (what ESI
 * serves) contains no byte a normalizer would touch, and the repository is LF
 * everywhere (`.gitattributes`), so a terminating LF stays one byte on every
 * checkout.
 *
 * Staleness
 *
 * If CCP changes the *shape* of a body, the recording disagrees with the pinned
 * spec; `assertGolden` checks it against `describeOperation`, so the failure says
 * "the recording is stale" instead of "the handler is wrong". If CCP changes the
 * *values* (the player count, a region's description), the recording is still a
 * valid contract: a replica is judged on shape and types, and the endpoint's own
 * test supplies the game state that reproduces the recorded values.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { assertBody, describeOperation } = require(path.join(__dirname, "spec"));
const {
  PRODUCER,
  findEnvelopeKeys,
  findNonSnakeCaseKeys,
  producerWire,
  serializeBody,
} = require(path.join(__dirname, "..", "lib", "serialize"));

const GOLDEN_DIR = path.join(__dirname, "golden");
const INDEX_PATH = path.join(GOLDEN_DIR, "index.json");

/** A golden that is missing, unregistered, or does not match. */
class GoldenError extends Error {
  constructor(message) {
    super(message);
    this.name = "GoldenError";
  }
}

// The index

/**
 * `{ "<operationId>": { method, path, url, recordedAt, producer, note? }, ... }`
 *
 * `producer` is which of ESI's two implementations served the recording,
 * `gateway` or `app`. It is provenance, read off the response. It must be written
 * down because the parsed body does not reveal it and it decides the last byte.
 *
 * Read fresh each call rather than cached: this runs in tests, where a stale
 * read is a confusing failure and a file read is free.
 */
function loadIndex() {
  let raw;
  try {
    raw = fs.readFileSync(INDEX_PATH, "utf8");
  } catch (err) {
    throw new GoldenError(`cannot read ${INDEX_PATH}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new GoldenError(`${INDEX_PATH} is not JSON: ${err.message}`);
  }

  const entries = parsed && typeof parsed === "object" ? parsed.goldens : null;
  if (entries === null || typeof entries !== "object") {
    throw new GoldenError(`${INDEX_PATH} has no "goldens" object.`);
  }
  return entries;
}

/**
 * How a recording is used, a property of the recording rather than of the test
 * that opens it.
 *
 *   bytes   the whole body is diffed through `assertGolden`
 *   shape   this replica cannot reproduce the values (a private server's order
 *           book is not CCP's, and D4 serves one compatibility date where CCP
 *           lists fourteen), so the recording is used for its field set, its key
 *           order and its last byte
 *
 * Declared because "there is a golden file for this endpoint" and "something
 * actually compares against it" are different claims. `test/serialize.test.js`
 * enforces both.
 */
const DIFF_KINDS = Object.freeze(["bytes", "shape"]);

/**
 * Operations that deliberately have no recording, and why.
 *
 * `GetMarketsPrices` has no narrower form than 1.1 MB, for example. An operation
 * in neither this map nor `goldens` is a recording somebody forgot.
 */
function loadExemptions() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  } catch (err) {
    throw new GoldenError(`cannot read ${INDEX_PATH}: ${err.message}`);
  }

  const exempt = parsed && typeof parsed === "object" ? parsed.exempt : null;
  return exempt && typeof exempt === "object" ? exempt : {};
}

/** The recorded file for one golden, whether or not it exists. */
function goldenPath(name) {
  return path.join(GOLDEN_DIR, `${name}.json`);
}

/** Every golden name that has both a file and an index entry. */
function listGoldens() {
  const indexed = Object.keys(loadIndex());
  return indexed.filter((name) => fs.existsSync(goldenPath(name))).sort();
}

/**
 * Names in the index with no file, and files with no index entry.
 *
 * An entry with no file is a recording described and never made; a file with no
 * entry is bytes nobody can trace back to a request. `test/serialize.test.js`
 * asserts both are empty.
 */
function findIndexProblems() {
  const indexed = loadIndex();
  const problems = [];

  for (const [name, entry] of Object.entries(indexed)) {
    if (!fs.existsSync(goldenPath(name))) {
      problems.push(`index.json describes "${name}" but contract/golden/${name}.json is not there`);
      continue;
    }
    for (const field of ["method", "path", "url", "recordedAt"]) {
      if (typeof entry[field] !== "string" || entry[field] === "") {
        problems.push(`index.json entry "${name}" has no ${field}`);
      }
    }
    if (!DIFF_KINDS.includes(entry.diff)) {
      problems.push(
        `index.json entry "${name}" declares diff ${JSON.stringify(entry.diff)}, which is not one `
          + `of ${DIFF_KINDS.join(", ")}: it says how the recording is used, and test/serialize `
          + "checks that something uses it that way",
      );
    }
    if (!Object.values(PRODUCER).includes(entry.producer)) {
      problems.push(
        `index.json entry "${name}" declares producer ${JSON.stringify(entry.producer)}, which is `
          + `not one of ${Object.values(PRODUCER).join(", ")}: it is read off the recorded `
          + "response's content-type, not chosen",
      );
      continue;
    }

    // The recording's last byte must agree with the producer it claims. A file that
    // disagrees with its entry was mis-recorded (pretty-printed, edited, or saved by
    // something that terminates text files), and it would otherwise become the
    // contract a handler is written to satisfy.
    const { trailingNewline } = producerWire(entry.producer);
    const bytes = fs.readFileSync(goldenPath(name));
    const endsWithNewline = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a;
    if (endsWithNewline !== trailingNewline) {
      problems.push(
        `contract/golden/${name}.json ${endsWithNewline ? "ends with" : "does not end with"} a `
          + `newline, but its producer "${entry.producer}" `
          + `${trailingNewline ? "always sends one" : "never sends one"}. Re-record it from `
          + `${entry.url} with curl -o and do not open it in an editor.`,
      );
    }
  }

  // An exemption claims there is *no* recording, so a file beside one is a
  // contradiction: the reason stopped being true, or the entry moved without its
  // note.
  for (const [name, exemption] of Object.entries(loadExemptions())) {
    if (fs.existsSync(goldenPath(name))) {
      problems.push(
        `index.json exempts "${name}" from having a recording, and contract/golden/${name}.json `
          + "exists: move it into \"goldens\" with a diff kind, or delete the file",
      );
    }
    if (typeof exemption.reason !== "string" || exemption.reason.trim() === "") {
      problems.push(
        `index.json exempts "${name}" with no reason. An exemption without one is an omission `
          + "with better paperwork",
      );
    }
    if (Object.prototype.hasOwnProperty.call(indexed, name)) {
      problems.push(`index.json has "${name}" in both "goldens" and "exempt"`);
    }
  }

  const files = fs.existsSync(GOLDEN_DIR)
    ? fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json") && f !== "index.json")
    : [];
  for (const file of files) {
    const name = file.slice(0, -".json".length);
    if (!Object.prototype.hasOwnProperty.call(indexed, name)) {
      problems.push(`contract/golden/${file} has no entry in index.json. Where did these bytes come from?`);
    }
  }

  return problems;
}

// Loading

/** Is there a recording for this operation? */
function hasGolden(name) {
  return fs.existsSync(goldenPath(name));
}

/**
 * One golden, as both bytes and parsed value, with the index entry that says
 * where it came from.
 */
function loadGolden(name) {
  const entry = loadIndex()[name];
  if (entry === undefined) {
    throw new GoldenError(
      `no entry for "${name}" in contract/golden/index.json. A recording without its request `
        + "is not an observation: add the URL and the date it was fetched.",
    );
  }

  let bytes;
  try {
    bytes = fs.readFileSync(goldenPath(name));
  } catch (err) {
    throw new GoldenError(`cannot read the golden body for "${name}": ${err.message}`);
  }

  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new GoldenError(`the golden body for "${name}" is not JSON: ${err.message}`);
  }

  return { name, entry, bytes, value };
}

// Diffing

/** Deeply key-sorted copy, for telling "wrong order" from "wrong content". */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
  return out;
}

/** The first index at which two strings differ, or -1. */
function firstDifference(a, b) {
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : limit;
}

/**
 * Why two bodies differ, in the terms a reader needs.
 *
 * Key order gets its own sentence because `deepEqual` would pass it and a byte
 * comparison catches it, since a projection's declaration order is its output
 * order.
 */
function describeDifference(producedBytes, recordedBytes) {
  const produced = producedBytes.toString("utf8");
  const recorded = recordedBytes.toString("utf8");

  const lines = [];

  let sameContent = false;
  try {
    sameContent =
      JSON.stringify(sortDeep(JSON.parse(produced))) === JSON.stringify(sortDeep(JSON.parse(recorded)));
  } catch (_) {
    sameContent = false;
  }

  if (sameContent) {
    lines.push(
      "the two bodies carry the same values in a different key order: a projection's field "
        + "declaration order is its output order, so write the fields in the order CCP sends them",
    );
  }

  const at = firstDifference(produced, recorded);
  if (at >= 0) {
    const from = Math.max(0, at - 30);
    lines.push(`first differing byte at offset ${at}`);
    lines.push(`  produced: …${produced.slice(from, at + 40)}`);
    lines.push(`  recorded: …${recorded.slice(from, at + 40)}`);
  }

  if (producedBytes.length !== recordedBytes.length) {
    lines.push(`length: produced ${producedBytes.length} bytes, recorded ${recordedBytes.length}`);
  }

  return lines;
}

// The assertion

/**
 * Assert that a handler's body serializes to the bytes CCP served.
 *
 * Four checks, ordered so a stale recording is reported as stale rather than as
 * a broken handler:
 *
 *   1. the recording still matches the pinned spec (is the golden stale?)
 *   2. the produced body carries no envelope key
 *   3. every key in the produced body is snake_case
 *   4. the bytes are identical
 *
 * `method` and `path` are the spec coordinates (`"GET"`, `"/status/"`) and
 * default to the ones the index recorded, so an endpoint test normally passes
 * only a name and a body.
 */
function assertGolden(name, body, options = {}) {
  const { entry, bytes, value } = loadGolden(name);

  const method = options.method || entry.method;
  const wirePath = options.path || entry.path;

  if (options.checkSpec !== false) {
    const contract = describeOperation(method, wirePath, options);
    try {
      assertBody(value, contract);
    } catch (err) {
      throw new GoldenError(
        `the recorded body for "${name}" no longer matches the pinned spec: the recording is `
          + `stale, not the handler. Re-record it from ${entry.url}.\n  ${err.message}`,
      );
    }
  }

  const envelope = findEnvelopeKeys(body);
  if (envelope.length > 0) {
    throw new GoldenError(
      `"${name}" produced a body with the envelope key(s) ${envelope.join(", ")} at the top level. `
        + "ESI bodies are bare.",
    );
  }

  const camel = findNonSnakeCaseKeys(body);
  if (camel.length > 0) {
    throw new GoldenError(
      `"${name}" produced non-snake_case field name(s): ${camel.join(", ")}.`,
    );
  }

  const produced = serializeBody(body, options.producer || entry.producer);
  if (produced.equals(bytes)) return { name, entry, bytes };

  throw new GoldenError(
    `"${name}" does not serialize to the bytes recorded from ${entry.url} on ${entry.recordedAt}:\n  - `
      + describeDifference(produced, bytes).join("\n  - "),
  );
}

module.exports = {
  DIFF_KINDS,
  GOLDEN_DIR,
  GoldenError,
  INDEX_PATH,
  assertGolden,
  describeDifference,
  findIndexProblems,
  goldenPath,
  hasGolden,
  listGoldens,
  loadGolden,
  loadExemptions,
  loadIndex,
};
