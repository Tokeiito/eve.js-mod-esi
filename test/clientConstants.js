/**
 * eve.js-mod-esi: CCP's own flag table, read out of a decompiled client (D46)
 *
 * `lib/locationFlags.js` is a join between two authorities that do not mention
 * each other: eve.js's `invFlags` integers and CCP's `location_flag` strings.
 * The id half could only be read off eve.js, which declares the ids it uses and
 * nothing about the ones it does not.
 *
 * The client declares all of them. `inventorycommon/const.py` in a decompiled
 * client is CCP's own `flagXxx = <id>` table, the file the extracted SDE dump
 * leaves out. It settled flag 0 (`flagAutoFit = 0` beside `flagNone = 0`, of
 * which the document publishes only `AutoFit`) and flag 174 (`flagCrateLoot`
 * and `flagCorpseBay` on one id, one name per surface).
 *
 * This file locates and parses that table so `locationFlags.test.js` can check
 * the mod's rows against it. It is not a second copy of the table: nothing here
 * contains a flag name or an id, the same rule the test file keeps against
 * `contract/openapi.json`. A fixture of CCP's constants checked against CCP's
 * constants would assert nothing.
 *
 * The client is authoritative for ids and CCP's own name for each, not for ESI
 * names. Seven ids are renamed on the way out to ESI (`SubsystemBay` to
 * `SubSystemBay`, `GeneralMiningHold` to `SpecializedOreHold`, and five more),
 * so the checks have the form "where CCP's constant name is a value the
 * document publishes, the table sends exactly that name" rather than "the table
 * equals the client".
 *
 * The dump comes from `ESI_MOD_CLIENT_ROOT`, naming the directory that contains
 * `inventorycommon/` (the root of a decompiled client tree, not the package and
 * not the file). Nothing is auto-discovered: a client dump is part of neither
 * repository and lives wherever its owner put it, and guessing a path on one
 * machine is how a check passes for the wrong reason on another.
 *
 * Absent, the checks skip with a reason, as the vendor-drift tests do with no
 * eve.js checkout. `vendorPresence.test.js` stops that skip reading as a pass
 * in a run that set `ESI_MOD_REQUIRE_VENDOR`.
 *
 * Match the dump to the install: the flag table moves between builds, and the
 * build number is on both ends. This install's dump is build 3396210, the same
 * build `/status/`'s `server_version` reports (D12), because it is the same
 * static data.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** The env var, named once so the gate and the guard cannot disagree. */
const CLIENT_ROOT_ENV = "ESI_MOD_CLIENT_ROOT";

/** The one file read, relative to the dump root. */
const CONST_PATH = path.join("inventorycommon", "const.py");

/**
 * The client's constant table, or `null` when no dump is reachable.
 *
 * Shared between `locationFlags.test.js`, which uses it to gate, and
 * `vendorPresence.test.js`, which uses it to refuse a strict run that would
 * skip.
 */
function findClientConst(env = process.env) {
  const root = String(env[CLIENT_ROOT_ENV] ?? "").trim();
  if (!root) return null;
  const file = path.resolve(root, CONST_PATH);
  return fs.existsSync(file) ? file : null;
}

/**
 * `flagXxx = <id>`, every line of it, as `{ id, name }` with the prefix gone.
 *
 * Chained declarations are real and carry two names for one id: the slot
 * families open with one (`flagLoSlot0 = flagSlotFirst = 11`) and so does the
 * id this mod's table sends under two names. Both names are recorded; a parser
 * that kept only the first would discard the evidence that settled flag 0.
 *
 * Deliberately strict about the line shape. A constant whose value is an
 * expression rather than a literal, or a table that stops being written this
 * way in a later build, is better as a parse that finds nothing and a check
 * that fails loudly than as a silent partial read.
 */
function parseClientFlags(file) {
  const source = fs.readFileSync(file, "utf8");
  const rows = [];

  for (const raw of source.split(/\r?\n/)) {
    const match = /^((?:flag[A-Za-z0-9_]+\s*=\s*)+)(\d+)$/.exec(raw.trim());
    if (match === null) continue;

    const id = Number(match[2]);
    for (const name of match[1].split("=").map((part) => part.trim()).filter(Boolean)) {
      rows.push({ id, name: name.slice("flag".length) });
    }
  }

  return rows;
}

const CLIENT_CONST = findClientConst();

const SKIP_REASON =
  "no decompiled client found: set ESI_MOD_CLIENT_ROOT to the root of one (the directory "
  + "containing inventorycommon/const.py) to check lib/locationFlags.js against CCP's own "
  + "flag ids";

/** Spread into a `test()` call as its options argument. See `vendorTree.js`. */
const clientOnly = CLIENT_CONST ? {} : { skip: SKIP_REASON };

module.exports = {
  CLIENT_CONST,
  CLIENT_ROOT_ENV,
  CONST_PATH,
  SKIP_REASON,
  clientOnly,
  findClientConst,
  parseClientFlags,
};
