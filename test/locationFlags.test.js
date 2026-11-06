/**
 * `lib/locationFlags.js`: every row checked against CCP's published enum, and
 * the derivation behind flag 134 checked as a derivation.
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * The table is a join between two sources that are each authoritative and
 * neither of which mentions the other: eve.js's `invFlags` integers and CCP's
 * `location_flag` strings. Asserting the table against a copy of itself would
 * be worthless, so nothing here contains a list of flag names. Every name is
 * read out of `contract/openapi.json` at run time, and every assertion has the
 * form "this table says nothing the document does not".
 *
 * The one row read off neither side, 134 `SpecializedOreHold`, is checked as
 * the argument that produced it. If a spec adds a sixteenth `Specialized*`
 * value or eve.js adds a hold flag, the derivation stops being valid and this
 * file says so instead of continuing to agree with itself.
 *
 * The last section checks the table against CCP's own `flagXxx = <id>` table,
 * read out of a decompiled client's `inventorycommon/const.py` (D46). That is
 * the id half of the join, and it settled flag 0 and flag 174. A client dump is
 * not part of this repository, so those checks gate on `ESI_MOD_CLIENT_ROOT`
 * and skip without one, like the vendor-drift tests. They contain no flag name
 * or id either: the client is read at run time.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const spec = require(path.join(__dirname, "../contract/openapi.json"));
const {
  CHARACTER,
  CHARACTER_BLUEPRINT,
  CORPORATION,
  CORPORATION_BLUEPRINT,
  NOT_ON_CHARACTER_BLUEPRINTS,
  FLAGS,
  SINGULAR_FLAGS,
  SLOT_FAMILIES,
  UnknownLocationFlagError,
  locationFlagFor,
} = require(path.join(__dirname, "../lib/locationFlags"));
const { CLIENT_CONST, clientOnly, parseClientFlags } = require(path.join(__dirname, "clientConstants"));

// CCP's two enums, read out of the document

function resolveRef(node) {
  return node && node.$ref ? spec.components.schemas[node.$ref.split("/").pop()] : node;
}

function publishedEnum(specPath) {
  const schema = resolveRef(
    spec.paths[specPath].get.responses["200"].content["application/json"].schema,
  );
  return resolveRef(schema.items).properties.location_flag.enum;
}

const CHARACTER_ENUM = publishedEnum("/characters/{character_id}/assets");
const CORPORATION_ENUM = publishedEnum("/corporations/{corporation_id}/assets");

const ENUM_FOR = { [CHARACTER]: CHARACTER_ENUM, [CORPORATION]: CORPORATION_ENUM };

// Nothing in the table is invented

test("every name the table can send is a value CCP publishes for that surface", () => {
  // Asked through `locationFlagFor` rather than read off `row.name`, because one
  // row sends two different names and the one that matters is the one a caller is
  // handed.
  for (const row of FLAGS.values()) {
    for (const surface of row.surfaces) {
      const name = locationFlagFor(row.id, surface);
      assert.ok(
        ENUM_FOR[surface].includes(name),
        `flag ${row.id} sends ${name} on the ${surface} surface, and the document does not `
          + `publish it there (declared at ${row.where})`,
      );
    }
  }
});

test("a row that changes name between surfaces has to, on both counts", () => {
  // `corporationName` exists for an id whose two enums disagree about the name.
  // If either name were published on both surfaces the override would be
  // unnecessary, and an unnecessary override can be wrong without anything
  // noticing.
  for (const row of FLAGS.values()) {
    if (row.corporationName === null) continue;

    assert.deepEqual(
      row.surfaces,
      [CHARACTER, CORPORATION],
      `flag ${row.id} carries a corporation name but is not marked for both surfaces`,
    );
    assert.ok(
      !CORPORATION_ENUM.includes(row.name),
      `flag ${row.id} overrides ${row.name} on the corporation surface, but the document `
        + "publishes that name there too, so there is nothing to override",
    );
    assert.ok(
      !CHARACTER_ENUM.includes(row.corporationName),
      `flag ${row.id} sends ${row.corporationName} only to a corporation, but the character `
        + "enum publishes it as well",
    );
  }
});

test("a row marked for one surface really is absent from the other's enum", () => {
  for (const row of FLAGS.values()) {
    if (row.surfaces.length === 2) continue;
    const other = row.surfaces[0] === CHARACTER ? CORPORATION : CHARACTER;
    assert.ok(
      !ENUM_FOR[other].includes(row.name),
      `flag ${row.id} is marked ${row.surfaces[0]}-only, but the document publishes ${row.name} `
        + `on the ${other} enum too: the row should be marked for both`,
    );
  }
});

test("no two rows claim one flag id", () => {
  // The table's own builder throws on a duplicate, so this asserts that the
  // builder ran rather than re-checking it: a table that silently lost a row to
  // an overwrite would have the right size and the wrong contents.
  const ids = [...FLAGS.keys()];
  assert.equal(new Set(ids).size, ids.length);
});

test("no two rows send one name on the same surface", () => {
  // eve.js declares 185 under two constant names and 133 under two more. A
  // second row for either would be two flags claiming one enum value, a body
  // where the same `location_flag` means two different bays.
  for (const surface of [CHARACTER, CORPORATION]) {
    const names = [...FLAGS.values()]
      .filter((row) => row.surfaces.includes(surface))
      .map((row) => locationFlagFor(row.id, surface));
    assert.equal(new Set(names).size, names.length, `duplicate name on the ${surface} surface`);
  }
});

test("every row cites where the id is declared", () => {
  for (const row of FLAGS.values()) {
    assert.equal(typeof row.where, "string");
    assert.notEqual(row.where, "", `flag ${row.id} cites no source`);
  }
});

// The derived row, checked as a derivation

test("134 is SpecializedOreHold because it is the only pairing that empties both sets", () => {
  // The argument in the file header, mechanised. If CCP adds a Specialized*
  // value or eve.js adds a hold flag, this stops holding and says so, rather
  // than the table continuing to agree with its own comment.
  const publishedSpecialized = CHARACTER_ENUM.filter((name) => name.startsWith("Specialized"));

  const claimedByOthers = [...FLAGS.values()]
    .filter((row) => row.id !== 134 && row.name.startsWith("Specialized"))
    .map((row) => row.name);

  const unaccounted = publishedSpecialized.filter((name) => !claimedByOthers.includes(name));

  assert.deepEqual(
    unaccounted,
    ["SpecializedOreHold"],
    "the derivation for flag 134 rests on exactly one Specialized* value being left over; "
      + `these are: ${unaccounted.join(", ")}`,
  );
  assert.equal(FLAGS.get(134).name, "SpecializedOreHold");
});

test("134's row says out loud that it is derived", () => {
  // A reader who finds this row surprising should find the reason in the row,
  // not only in the header.
  assert.match(FLAGS.get(134).where, /derived/);
});

// The generated families

test("each slot family generates eight ids numbered 0 through 7", () => {
  for (const family of SLOT_FAMILIES) {
    for (let index = 0; index < 8; index += 1) {
      const row = FLAGS.get(family.first + index);
      assert.notEqual(row, undefined, `${family.prefix}${index} is missing`);
      assert.equal(row.name, `${family.prefix}${index}`);
    }
    // The family does not run one past its end into the next one.
    const after = FLAGS.get(family.first + 8);
    assert.ok(
      after === undefined || !after.name.startsWith(family.prefix),
      `${family.prefix} runs past eight slots into ${after && after.name}`,
    );
  }
});

test("the corporation hangar divisions are one-based, as CCP numbers them", () => {
  assert.equal(FLAGS.get(115).name, "CorpSAG1");
  assert.equal(FLAGS.get(121).name, "CorpSAG7");
  assert.ok(!CORPORATION_ENUM.includes("CorpSAG0"));
});

test("the fighter tubes are five, zero-based", () => {
  assert.equal(FLAGS.get(159).name, "FighterTube0");
  assert.equal(FLAGS.get(163).name, "FighterTube4");
  assert.ok(!CHARACTER_ENUM.includes("FighterTube5"));
});

test("service slots are corporation-only, which is a structure being corp property", () => {
  for (let index = 0; index < 8; index += 1) {
    assert.deepEqual(FLAGS.get(164 + index).surfaces, [CORPORATION]);
  }
});

// Looking one up

test("a known flag resolves on the surface that publishes it", () => {
  assert.equal(locationFlagFor(4, CHARACTER), "Hangar");
  assert.equal(locationFlagFor(4, CORPORATION), "Hangar");
  assert.equal(locationFlagFor(115, CORPORATION), "CorpSAG1");
  assert.equal(locationFlagFor(27, CHARACTER), "HiSlot0");
  // A string id from a table row is coerced; `items.flagID` is written as a
  // number, but nothing downstream should depend on which.
  assert.equal(locationFlagFor("4", CHARACTER), "Hangar");
});

test("a flag published only on the other surface is refused, not sent anyway", () => {
  // `CorpSAG1` is not in the character enum, so a character asset carrying flag
  // 115 would be a body a strict client rejects.
  assert.throws(() => locationFlagFor(115, CHARACTER), UnknownLocationFlagError);
  assert.throws(() => locationFlagFor(180, CORPORATION), UnknownLocationFlagError);
  assert.throws(() => locationFlagFor(164, CHARACTER), UnknownLocationFlagError);
});

test("one flag is not refused but renamed, because the enums disagree about it", () => {
  // 174 is the corpse bay, legal on both surfaces under two different names
  // (D46). Refusing it on the corporation surface, as this table did before the
  // client's own constants explained the missing name, answered a logged 500 for
  // a corporation that owned a ship with a corpse bay.
  assert.equal(locationFlagFor(174, CHARACTER), "CorpseBay");
  assert.equal(locationFlagFor(174, CORPORATION), "CrateLoot");
  assert.equal(locationFlagFor(174, CORPORATION_BLUEPRINT), "CrateLoot");
  assert.ok(CHARACTER_ENUM.includes("CorpseBay") && !CHARACTER_ENUM.includes("CrateLoot"));
  assert.ok(CORPORATION_ENUM.includes("CrateLoot") && !CORPORATION_ENUM.includes("CorpseBay"));
});

test("flag 0 resolves on every surface, which is what a container's contents carry", () => {
  // Flag 0 is what eve.js writes when no compartment applies, which is most of
  // an install's blueprints and everything inside a container. The four asset
  // and blueprint endpoints answered a logged 500 for any owner holding one.
  assert.equal(locationFlagFor(0, CHARACTER), "AutoFit");
  assert.equal(locationFlagFor(0, CORPORATION), "AutoFit");
  assert.equal(locationFlagFor(0, CHARACTER_BLUEPRINT), "AutoFit");
  assert.equal(locationFlagFor(0, CORPORATION_BLUEPRINT), "AutoFit");
});

test("an unknown flag throws with the id in the message", () => {
  // 178 is a real CCP flag (the client calls it `flagRaffle`) and no enum
  // publishes a value for it, which is the shape of the case this refusal is
  // for. See the header for why it is a refusal and not a drop.
  let err = null;
  try {
    locationFlagFor(178, CHARACTER);
  } catch (caught) {
    err = caught;
  }
  assert.equal(err && err.name, "UnknownLocationFlagError");
  assert.equal(err.flagId, 178);
  assert.equal(err.surface, CHARACTER);
  assert.match(err.message, /flagID 178/);
  // The error says what to do about it.
  assert.match(err.message, /lib\/locationFlags\.js/);

  // `null`, `""`, `false` and `[]` matter since flag 0: `Number()` reads all four
  // as zero, so a row carrying no flag at all would be answered `AutoFit`
  // instead of refused.
  for (const bad of [null, undefined, "", false, [], -1, 1.5, "x", 9999]) {
    assert.throws(() => locationFlagFor(bad, CHARACTER), UnknownLocationFlagError);
  }
  assert.equal(locationFlagFor("0", CHARACTER), "AutoFit");
});

test("a surface that is not one of the three is a programming error, not a refusal", () => {
  // Distinct from `UnknownLocationFlagError`: a caller that invented a surface
  // has a bug, and answering it with the flag refusal would hide that.
  assert.throws(() => locationFlagFor(4, "alliance"), /takes one of/);
  assert.throws(() => locationFlagFor(4, undefined), /takes one of/);
});

// The blueprint surfaces

test("the character blueprints enum is the assets one minus the excluded set", () => {
  // The subtraction, reconstructed and compared against the document, so that
  // the exclusion list is checked rather than merely plausible. `Module` is the
  // one value CCP publishes that no eve.js flag produces, so it is expected in
  // the document and not in the reconstruction.
  const reconstructed = new Set(
    CHARACTER_ENUM.filter((name) => !NOT_ON_CHARACTER_BLUEPRINTS.has(name)),
  );

  const published = new Set(publishedEnum("/characters/{character_id}/blueprints"));
  published.delete("Module");

  assert.deepEqual([...reconstructed].sort(), [...published].sort());
});

test("every excluded name really is in the assets enum and not the blueprints one", () => {
  const blueprintEnum = publishedEnum("/characters/{character_id}/blueprints");
  for (const name of NOT_ON_CHARACTER_BLUEPRINTS) {
    assert.ok(CHARACTER_ENUM.includes(name), `${name} is not in the character assets enum`);
    assert.ok(!blueprintEnum.includes(name), `${name} IS in the character blueprints enum`);
  }
});

test("the corporation surfaces are one enum, which is why there are three and not four", () => {
  const assetsEnum = [...publishedEnum("/corporations/{corporation_id}/assets")].sort();
  const blueprintEnum = [...publishedEnum("/corporations/{corporation_id}/blueprints")].sort();

  assert.deepEqual(assetsEnum, blueprintEnum);
  assert.equal(CORPORATION_BLUEPRINT, CORPORATION);
});

test("a blueprint surface resolves the flags a blueprint can actually be in", () => {
  assert.equal(locationFlagFor(4, CHARACTER_BLUEPRINT), "Hangar");
  assert.equal(locationFlagFor(5, CHARACTER_BLUEPRINT), "Cargo");
  assert.equal(locationFlagFor(115, CORPORATION_BLUEPRINT), "CorpSAG1");
});

test("a place a blueprint cannot be is refused on the blueprint surface only", () => {
  // 176 is BoosterBay: legal on the assets surface, absent from the blueprints
  // enum. Both answers are right; the surface decides which applies.
  assert.equal(locationFlagFor(176, CHARACTER), "BoosterBay");
  assert.throws(() => locationFlagFor(176, CHARACTER_BLUEPRINT), UnknownLocationFlagError);
  assert.throws(() => locationFlagFor(181, CHARACTER_BLUEPRINT), /blueprints enum does not publish it/);
});

// What this replica cannot produce, asserted as a divergence

test("Implant and Skill are published and unreachable, which is stated on purpose", () => {
  // eve.js keeps implants on the character record and skills in their own table,
  // so no item carries either flag and neither value can come out of this table.
  // Asserted so the divergence is a checked fact: a future row for either would
  // fail here and force the header to be rewritten.
  for (const name of ["Implant", "Skill"]) {
    assert.ok(CHARACTER_ENUM.includes(name), `the document publishes ${name}`);
    assert.ok(
      ![...FLAGS.values()].some((row) => row.name === name),
      `${name} is reachable from lib/locationFlags.js, and the file header says it cannot be`,
    );
  }
});

test("the singular rows and the generated ones together are the whole table", () => {
  const generated = SLOT_FAMILIES.length * 8 + 7 + 5;
  assert.equal(FLAGS.size, SINGULAR_FLAGS.length + generated);
});

// CCP's own id table, when a client dump is reachable

/**
 * `id -> Set(names)`, read at run time out of the client. Built once, and only
 * when there is something to read: `clientOnly` skips every test below when
 * there is not, and this stays an empty map they never look at.
 */
const CLIENT_FLAGS = (() => {
  const table = new Map();
  if (CLIENT_CONST === null) return table;

  for (const { id, name } of parseClientFlags(CLIENT_CONST)) {
    if (!table.has(id)) table.set(id, new Set());
    table.get(id).add(name);
  }
  return table;
})();

test("the client's constant table is still where and what it was", clientOnly, () => {
  // First, because every check below is vacuous against an empty parse. A build
  // that writes the table differently must fail here rather than agree with
  // everything.
  assert.ok(CLIENT_FLAGS.size > 100, `only ${CLIENT_FLAGS.size} flag ids parsed out of the client`);
  assert.ok(CLIENT_FLAGS.has(4), "the client no longer declares the hangar flag this way");
});

test("every id this table names is an id CCP's client declares", clientOnly, () => {
  // The half eve.js cannot check: it declares the ids it happens to use, so a
  // transposed digit in a row for a flag eve.js never writes would sit unnoticed
  // until an item turned up carrying it.
  for (const row of FLAGS.values()) {
    assert.ok(
      CLIENT_FLAGS.has(row.id),
      `flag ${row.id} (${row.name}) is in this table and in no client constant (${row.where})`,
    );
  }
});

test("where CCP's own name for an id is published, this table sends exactly it", clientOnly, () => {
  // The join, mechanised. Seven ids are renamed on the way out to ESI, so the
  // claim is not "the table equals the client" but that wherever the client's
  // name for an id is a value the document publishes, this table does not send
  // some other one for it.
  for (const row of FLAGS.values()) {
    for (const surface of row.surfaces) {
      const published = [...CLIENT_FLAGS.get(row.id)].filter((name) =>
        ENUM_FOR[surface].includes(name));
      if (published.length === 0) continue;

      assert.deepEqual(
        published,
        [locationFlagFor(row.id, surface)],
        `flag ${row.id} on the ${surface} surface: CCP's client calls it ${published.join(", ")}`,
      );
    }
  }
});

test("flag 0 is AutoFit because CCP's client says the id has exactly two names", clientOnly, () => {
  // D46's evidence as an assertion. `flagAutoFit = 0` sits beside `flagNone = 0`,
  // and of the two names the document publishes one everywhere and the other
  // nowhere, so there is no second candidate to weigh.
  const names = CLIENT_FLAGS.get(0);

  assert.deepEqual([...names].sort(), ["AutoFit", "None"]);
  for (const surface of [CHARACTER, CORPORATION]) {
    assert.ok(ENUM_FOR[surface].includes("AutoFit"));
    assert.ok(!ENUM_FOR[surface].includes("None"));
  }
  assert.ok(publishedEnum("/characters/{character_id}/blueprints").includes("AutoFit"));
  assert.equal(locationFlagFor(0, CHARACTER), "AutoFit");
});

test("174 is two names for one id, which is why it is renamed and not refused", clientOnly, () => {
  assert.deepEqual([...CLIENT_FLAGS.get(174)].sort(), ["CorpseBay", "CrateLoot"]);
});

test("HangarAll is unreachable because CCP gave it an id no item carries", clientOnly, () => {
  // The other value left unclaimed on the character surface while flag 0 was
  // unnamed. It is not a candidate for 0 or anything else: the client numbers it
  // 1000, three digits above the highest flag an item can hold, and uses it as a
  // UI selector rather than a place.
  assert.deepEqual([...CLIENT_FLAGS.get(1000)], ["HangarAll"]);
  assert.equal(FLAGS.get(1000), undefined);
  assert.ok(![...FLAGS.values()].some((row) => row.name === "HangarAll"));
});

test("134's derivation still empties both sets against CCP's own id list", clientOnly, () => {
  // The header's argument for `SpecializedOreHold`, checkable from the other
  // side: the client names 134 and the document does not publish that name,
  // which makes 134 one of the renamed ids rather than a row read off either
  // source.
  assert.deepEqual([...CLIENT_FLAGS.get(134)], ["GeneralMiningHold"]);
  assert.ok(!CHARACTER_ENUM.includes("GeneralMiningHold"));

  const namedByClient = new Set([...CLIENT_FLAGS.values()].flatMap((names) => [...names]));
  const renamed = CHARACTER_ENUM.filter((value) => !namedByClient.has(value));
  assert.ok(
    renamed.includes("SpecializedOreHold"),
    "the document no longer publishes a Specialized* value the client does not name, so the "
      + "derivation for 134 needs rereading",
  );
});
