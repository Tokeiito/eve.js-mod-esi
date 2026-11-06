/**
 * eve.js-mod-esi: `flagID` to `location_flag`, and the closed enum behind it.
 *
 * Every asset and blueprint CCP sends carries a `location_flag`, a string from a closed enum: 89
 * values on the character surface, 125 on the corporation one. eve.js stores the same fact as a
 * bare integer, `items.flagID`, CCP's own `invFlags` id (what the EVE client speaks). Neither
 * dump carries the join: the extracted SDE has 61 files and none is `invFlags`, and
 * `grep -rn '"Hangar"'` over the vendor tree matches nothing. This file is the join.
 *
 * Every row is sourced. Each id is a constant eve.js declares, named in the module that declares
 * it, and each ESI name is a value the pinned document publishes in that surface's enum.
 * `test/locationFlags.test.js` checks the names against `contract/openapi.json` directly, so a
 * row naming a value CCP does not publish fails the suite.
 *
 * A third source is CCP's client: `inventorycommon/const.py` declares 133 `flagXxx` constants
 * over 129 ids, the `invFlags` table the SDE dump omits (D46). It names ids, not ESI values, so
 * it does not replace the document. Strip the `flag` prefix and 119 of the 133 names are
 * published verbatim. Seven more are CCP renaming its own constant on the way out
 * (`SubsystemBay` to `SubSystemBay`, `CorpGoalDeliveries` to `CorporationGoalDeliveries`,
 * `ColonyResourcesHold` to `InfrastructureHangar`, `GeneralMiningHold` to `SpecializedOreHold`,
 * and three spelling fixes). The remaining seven are names no enum has, none describing a place
 * an item sits: `None`, the slot-range markers `SlotFirst`, `SlotLast` and `FixedSlot`, `Raffle`,
 * and the two `SerenityReserved` bounds. One published value, `QuantumCoreRoom`, has no constant
 * in this build. The client settles which ids exist and what CCP calls each;
 * `test/locationFlags.test.js` checks this table against it when `ESI_MOD_CLIENT_ROOT` names a
 * client dump, and skips otherwise (the vendor-drift tests' bargain).
 *
 * The slot ranges come from `services/fitting/liveFittingState.js` `SLOT_FAMILY_FLAGS`:
 *
 *   11-18  low         LoSlot0-7
 *   19-26  med         MedSlot0-7
 *   27-34  high        HiSlot0-7
 *   92-99  rig         RigSlot0-7
 *   125-132 subsystem  SubSystemSlot0-7
 *   164-171 service    ServiceSlot0-7     corporation surface only
 *
 * One row is derived rather than read: flag 134. eve.js calls it `GENERAL_MINING_HOLD`
 * (`services/inventory/itemStore.js`) and backs it with dogma attribute 1556, which CCP's dump
 * names `generalMiningHoldCapacity` ("Mining Hold"). The ESI enum has no `GeneralMiningHold` and
 * no `MiningHold`, so the name cannot be read off either side. It is `SpecializedOreHold`, by
 * elimination: the document publishes sixteen `Specialized*` values, and fifteen are claimed by
 * flags eve.js names unambiguously (FuelBay 133, GasHold 135, MineralHold 136, SalvageHold 137,
 * ShipHold 138, SmallShipHold 139, MediumShipHold 140, LargeShipHold 141, IndustrialShipHold
 * 142, AmmoHold 143, CommandCenterHold 148, PlanetaryCommoditiesHold 149, MaterialBay 151,
 * IceHold 181, AsteroidHold 182). That leaves one enum value, `SpecializedOreHold`, and one hold
 * flag in the same contiguous block, 134. The pairing is the only one that empties both sets,
 * and `test/locationFlags.test.js` asserts that emptiness rather than the pairing. The client
 * settles the input to the argument: it declares `flagGeneralMiningHold = 134` and the document
 * publishes no `GeneralMiningHold`, so 134 is one of the seven renamed ids, and the set the
 * derivation empties is CCP's complete id list instead of eve.js's partial one.
 *
 * Two surfaces. The enums are not nested: 38 values are corporation-only (the seven `CorpSAG`
 * divisions, `CorpDeliveries`, the eight `ServiceSlot`s, `StructureFuel` and others) and one is
 * character-only, `StructureDeedBay`. A flag is looked up for a surface, and one legal on only
 * the other surface is refused rather than sent as a value that enum does not contain. One id
 * also changes name between the two: the client declares `flagCrateLoot = 174` and
 * `flagCorpseBay = 174` on consecutive lines, the character enum publishes `CorpseBay` and not
 * `CrateLoot`, and the corporation enum the reverse. That is what `corporationName` on a row is
 * for, and why `surfaces` had to be a column.
 *
 * A third surface: blueprints publish a smaller enum. `/characters/{id}/blueprints/` declares 76
 * values where `/characters/{id}/assets/` declares 89. The thirteen it drops are places a
 * blueprint cannot be (a booster bay, an ice hold, a frigate escape bay, a structure deed bay),
 * plus `Skill` and `Wardrobe`, which are not items here at all. It adds one, `Module`, which no
 * eve.js flag produces. The corporation pair publishes the same 125 values
 * (`/corporations/{id}/blueprints/` and `/corporations/{id}/assets/`, checked in
 * `test/locationFlags.test.js`), so there are three surfaces, not four. The thirteen are kept as
 * an exclusion rather than a fourth copy of the table; the test reconstructs the published enum
 * from the table and the exclusion and compares it against the document.
 *
 * Off the end of the table is a throw. `location_flag` is required, so a row whose flag has no
 * name cannot be built. Dropping the row makes the asset silently vanish (an industry tool
 * reconciling stock comes up short and blames its own arithmetic). Refusing answers a logged
 * `500` naming the flag id, for the reason `routes/skills.js` refuses rather than drops a skill
 * row: a body quietly missing something is a body a client acts on. The log carries the id and
 * the owner, so adding the row is a one-line change made from evidence.
 *
 * What eve.js cannot produce is a divergence, not a gap. Two enum values never come out of this
 * table because eve.js does not store the thing as an item. `Implant` (CCP's flag 89): eve.js
 * keeps implants as an array on the character record
 * (`services/character/characterState.js` `normalized.implants`), not as `items` rows, so a
 * pilot's implants are absent from this replica's `/characters/{id}/assets/` where CCP would
 * list five. `Skill`: skills are their own table, which `lib/runtimeAccess.js`
 * `listCharacterSkills` reads. Both are stated rather than worked around, because the row that
 * would fix them would be for a flag nothing can carry.
 */

"use strict";

// The slot families, from upstream's own declaration

/**
 * `services/fitting/liveFittingState.js` `SLOT_FAMILY_FLAGS`, transcribed.
 *
 * Each family is eight contiguous ids and the ESI enum numbers them `0` through `7`, so the rows
 * are generated rather than written out (48 literals is 48 chances to transpose a digit).
 *
 * `service` is corporation-only: the eight `ServiceSlot` values appear in the corporation enum
 * and not the character one, as a structure service module being corporation property would.
 */
const SLOT_FAMILIES = Object.freeze([
  Object.freeze({ first: 11, prefix: "LoSlot", where: "liveFittingState SLOT_FAMILY_FLAGS.low" }),
  Object.freeze({ first: 19, prefix: "MedSlot", where: "liveFittingState SLOT_FAMILY_FLAGS.med" }),
  Object.freeze({ first: 27, prefix: "HiSlot", where: "liveFittingState SLOT_FAMILY_FLAGS.high" }),
  Object.freeze({ first: 92, prefix: "RigSlot", where: "liveFittingState SLOT_FAMILY_FLAGS.rig" }),
  Object.freeze({
    first: 125,
    prefix: "SubSystemSlot",
    where: "liveFittingState SLOT_FAMILY_FLAGS.subsystem",
  }),
  Object.freeze({
    first: 164,
    prefix: "ServiceSlot",
    where: "liveFittingState SLOT_FAMILY_FLAGS.service",
    corporationOnly: true,
  }),
]);

/** The seven corporation hangar divisions, `services/industry/industryConstants.js`. */
const CORP_HANGAR_FIRST = 115;

/** The five fighter tubes, `services/inventory/itemStore.js` `FIGHTER_TUBE_FLAGS`. */
const FIGHTER_TUBE_FIRST = 159;

// The singular flags

/**
 * One id, the ESI name or names it goes out as, and where the id is declared.
 *
 * `corporationOnly` marks a row whose name the character enum does not publish. There is no
 * `characterOnly` column: the one character-only value, `StructureDeedBay`, is 180 and is an
 * ordinary row. The column is therefore `surfaces`, listing every surface a row is legal on.
 *
 * `corporationName`, where a row carries one, is what the corporation enum publishes for an id
 * the character enum publishes under a different name. Exactly one row needs it; see 174 below
 * and the header.
 */
const CHARACTER = "character";
const CORPORATION = "corporation";

/**
 * The character blueprint surface: `CHARACTER` minus the bays below.
 *
 * A distinct surface rather than a flag on the lookup, so a caller must name which body it is
 * building and cannot get the enum by accident.
 */
const CHARACTER_BLUEPRINT = "characterBlueprint";

/**
 * The corporation blueprint surface, which is `CORPORATION` itself.
 *
 * Exported under its own name so a corporation blueprint route reads like the character one, and
 * re-pointed rather than duplicated so the two cannot drift. `test/locationFlags.test.js`
 * asserts the document still publishes one enum for both.
 */
const CORPORATION_BLUEPRINT = CORPORATION;

/**
 * The thirteen values the character assets enum publishes and the character blueprints enum
 * does not.
 *
 * Each is a place a blueprint cannot be. `Skill` and `Wardrobe` are in the list but not in this
 * table at all (eve.js stores neither as an item), so they cost nothing here and are listed for
 * the test, which reconstructs CCP's enum from this set and compares it against the document.
 */
const NOT_ON_CHARACTER_BLUEPRINTS = Object.freeze(new Set([
  "BoosterBay",
  "CapsuleerDeliveries",
  "CorporationGoalDeliveries",
  "ExpeditionHold",
  "FrigateEscapeBay",
  "InfrastructureHangar",
  "MobileDepotHold",
  "MoonMaterialBay",
  "Skill",
  "SpecializedAsteroidHold",
  "SpecializedIceHold",
  "StructureDeedBay",
  "SubSystemBay",
  "Wardrobe",
]));
const BOTH = Object.freeze([CHARACTER, CORPORATION]);
const CORP_ONLY = Object.freeze([CORPORATION]);
const CHAR_ONLY = Object.freeze([CHARACTER]);

const SINGULAR_FLAGS = Object.freeze([
  // The one row with no eve.js constant behind it, because there is none:
  // 0 is what every store upstream writes when no compartment applies,
  // and no `ITEM_FLAGS` entry names it. The client names it twice,
  // `flagAutoFit = 0` and `flagNone = 0` on consecutive lines, and of those two
  // the document publishes `AutoFit` on all three surfaces and `None` on none
  // of them, so a flagless item goes out as `AutoFit`.
  //
  // It is not a rare row. A container's contents carry it (the container holds
  // the real flag and its contents hold none) and so does anything floating in
  // space: on the install that raised D46, 827 of 2,692 items, 778 of them
  // inside a container, and 781 of 873 blueprints. Without this row, four endpoints
  // answer a logged 500 for 12 of that install's 31 characters.
  Object.freeze({
    id: 0,
    name: "AutoFit",
    surfaces: BOTH,
    where: "client const.py flagAutoFit = flagNone = 0 (D46)",
  }),
  Object.freeze({ id: 4, name: "Hangar", surfaces: BOTH, where: "itemStore ITEM_FLAGS.HANGAR" }),
  Object.freeze({ id: 5, name: "Cargo", surfaces: BOTH, where: "itemStore ITEM_FLAGS.CARGO_HOLD" }),
  Object.freeze({
    id: 36,
    name: "AssetSafety",
    surfaces: BOTH,
    where: "structureAssetSafetyState ASSET_SAFETY_FLAG",
  }),
  Object.freeze({
    id: 62,
    name: "CorpDeliveries",
    surfaces: CORP_ONLY,
    where: "itemStore ITEM_FLAGS.CORP_DELIVERIES",
  }),
  Object.freeze({ id: 63, name: "Locked", surfaces: BOTH, where: "itemStore ITEM_FLAGS.LOCKED" }),
  Object.freeze({ id: 64, name: "Unlocked", surfaces: BOTH, where: "itemStore ITEM_FLAGS.UNLOCKED" }),
  Object.freeze({ id: 87, name: "DroneBay", surfaces: BOTH, where: "itemStore ITEM_FLAGS.DRONE_BAY" }),
  Object.freeze({
    id: 90,
    name: "ShipHangar",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SHIP_HANGAR",
  }),
  Object.freeze({
    id: 133,
    name: "SpecializedFuelBay",
    surfaces: BOTH,
    where: "fuelBayInventory FUEL_BAY_FLAG",
  }),
  // The derived row. See the header for the argument, and
  // test/locationFlags.test.js for the assertion that is actually made.
  Object.freeze({
    id: 134,
    name: "SpecializedOreHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.GENERAL_MINING_HOLD (derived, see the file header)",
  }),
  Object.freeze({
    id: 135,
    name: "SpecializedGasHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_GAS_HOLD",
  }),
  Object.freeze({
    id: 136,
    name: "SpecializedMineralHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_MINERAL_HOLD",
  }),
  Object.freeze({
    id: 137,
    name: "SpecializedSalvageHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_SALVAGE_HOLD",
  }),
  Object.freeze({
    id: 138,
    name: "SpecializedShipHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_SHIP_HOLD",
  }),
  Object.freeze({
    id: 139,
    name: "SpecializedSmallShipHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_SMALL_SHIP_HOLD",
  }),
  Object.freeze({
    id: 140,
    name: "SpecializedMediumShipHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_MEDIUM_SHIP_HOLD",
  }),
  Object.freeze({
    id: 141,
    name: "SpecializedLargeShipHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_LARGE_SHIP_HOLD",
  }),
  Object.freeze({
    id: 142,
    name: "SpecializedIndustrialShipHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_INDUSTRIAL_SHIP_HOLD",
  }),
  Object.freeze({
    id: 143,
    name: "SpecializedAmmoHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_AMMO_HOLD",
  }),
  Object.freeze({
    id: 148,
    name: "SpecializedCommandCenterHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_COMMAND_CENTER_HOLD",
  }),
  Object.freeze({
    id: 149,
    name: "SpecializedPlanetaryCommoditiesHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_PLANETARY_COMMODITIES_HOLD",
  }),
  Object.freeze({
    id: 151,
    name: "SpecializedMaterialBay",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_MATERIAL_BAY",
  }),
  Object.freeze({ id: 154, name: "QuafeBay", surfaces: BOTH, where: "itemStore ITEM_FLAGS.QUAFE_BAY" }),
  Object.freeze({
    id: 155,
    name: "FleetHangar",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.FLEET_HANGAR",
  }),
  Object.freeze({
    id: 156,
    name: "HiddenModifiers",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.HIDDEN_MODIFIERS",
  }),
  Object.freeze({
    id: 158,
    name: "FighterBay",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.FIGHTER_BAY",
  }),
  Object.freeze({
    id: 172,
    name: "StructureFuel",
    surfaces: CORP_ONLY,
    where: "fuelBayInventory STRUCTURE_FUEL_BAY_FLAG",
  }),
  Object.freeze({
    id: 173,
    name: "Deliveries",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.DELIVERIES",
  }),
  // CCP's one id with two names, one per surface. See the header: the client
  // declares both on consecutive lines and each enum publishes one of them, so
  // the same bay is `CrateLoot` on a corporation's ship and `CorpseBay` on a
  // pilot's. Marked for both surfaces because the flag is legal on both; it
  // is the name that differs.
  Object.freeze({
    id: 174,
    name: "CorpseBay",
    corporationName: "CrateLoot",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.CORPSE_BAY; client const.py flagCrateLoot = flagCorpseBay = 174",
  }),
  Object.freeze({
    id: 176,
    name: "BoosterBay",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.BOOSTER_BAY",
  }),
  Object.freeze({
    id: 177,
    name: "SubSystemBay",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SUBSYSTEM_BAY",
  }),
  Object.freeze({
    id: 179,
    name: "FrigateEscapeBay",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.FRIGATE_ESCAPE_BAY",
  }),
  Object.freeze({
    id: 180,
    name: "StructureDeedBay",
    surfaces: CHAR_ONLY,
    where: "itemStore ITEM_FLAGS.STRUCTURE_DEED",
  }),
  Object.freeze({
    id: 181,
    name: "SpecializedIceHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_ICE_HOLD",
  }),
  Object.freeze({
    id: 182,
    name: "SpecializedAsteroidHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.SPECIALIZED_ASTEROID_HOLD",
  }),
  Object.freeze({
    id: 183,
    name: "MobileDepotHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.MOBILE_DEPOT_HOLD",
  }),
  Object.freeze({
    id: 184,
    name: "CorporationGoalDeliveries",
    surfaces: BOTH,
    where: "structureAssetSafetyState CORPORATION_HANGAR_FLAGS (flagCorpGoalDeliveries)",
  }),
  // eve.js declares 185 twice, as COLONY_RESOURCES_HOLD and INFRASTRUCTURE_HOLD.
  // The enum publishes `InfrastructureHangar` and nothing colony-shaped, so the
  // second spelling is the one that names a value CCP sends.
  Object.freeze({
    id: 185,
    name: "InfrastructureHangar",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.INFRASTRUCTURE_HOLD",
  }),
  Object.freeze({
    id: 186,
    name: "MoonMaterialBay",
    surfaces: BOTH,
    where: "structureAssetSafetyState STRUCTURE_RECOVERABLE_ASSET_FLAGS (flagMoonMaterialBay)",
  }),
  Object.freeze({
    id: 187,
    name: "CapsuleerDeliveries",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.CAPSULEER_DELIVERIES",
  }),
  Object.freeze({
    id: 188,
    name: "ExpeditionHold",
    surfaces: BOTH,
    where: "itemStore ITEM_FLAGS.EXPEDITION_HOLD",
  }),
]);

// The table

/**
 * `flagID -> { name, surfaces, where }`, singular rows and generated families in one map.
 *
 * Built once at module load: it is 100 entries of static data with no game read behind it, so
 * nothing could fail at preload.
 */
const FLAGS = (() => {
  const table = new Map();

  const add = (id, name, surfaces, where, corporationName = null) => {
    if (table.has(id)) {
      throw new Error(
        `ESI mod: lib/locationFlags.js declares flag ${id} twice, as `
          + `${table.get(id).name} and ${name}.`,
      );
    }
    table.set(id, Object.freeze({ id, name, corporationName, surfaces, where }));
  };

  // `corporationName` is carried by every row and null on all but one, rather
  // than present only where used: a shape that varies per row is a shape
  // every reader of the table has to test for.
  for (const row of SINGULAR_FLAGS) {
    add(row.id, row.name, row.surfaces, row.where, row.corporationName ?? null);
  }

  for (const family of SLOT_FAMILIES) {
    for (let index = 0; index < 8; index += 1) {
      add(
        family.first + index,
        `${family.prefix}${index}`,
        family.corporationOnly ? CORP_ONLY : BOTH,
        family.where,
      );
    }
  }

  // The seven corporation hangar divisions, `CorpSAG1` through `CorpSAG7`.
  // One-based, unlike every other family here: that is CCP's numbering, and the
  // enum publishes no `CorpSAG0`.
  for (let index = 0; index < 7; index += 1) {
    add(
      CORP_HANGAR_FIRST + index,
      `CorpSAG${index + 1}`,
      CORP_ONLY,
      "industryConstants CORP_HANGAR_FLAGS",
    );
  }

  for (let index = 0; index < 5; index += 1) {
    add(
      FIGHTER_TUBE_FIRST + index,
      `FighterTube${index}`,
      BOTH,
      "itemStore FIGHTER_TUBE_FLAGS",
    );
  }

  return table;
})();

/**
 * A `flagID` this replica cannot name.
 *
 * Carries the id and the surface so the log line is enough to add the row without reproducing
 * the request. See the header on why this is a throw.
 */
class UnknownLocationFlagError extends Error {
  constructor(flagId, surface, detail) {
    super(
      `ESI mod: no location_flag for flagID ${flagId} on the ${surface} surface${detail ? ` (${detail})` : ""}. `
        + "location_flag is a required field out of a closed enum, so a row carrying this flag "
        + "cannot be built. Add it to lib/locationFlags.js SINGULAR_FLAGS, citing the constant "
        + "that declares the id (the client's own inventorycommon/const.py names every one of "
        + "them, D46) and the value contract/openapi.json publishes for it.",
    );
    this.name = "UnknownLocationFlagError";
    this.flagId = flagId;
    this.surface = surface;
  }
}

/**
 * The ESI `location_flag` for one `flagID` on one surface, or a throw.
 *
 * Two refusals on purpose. A flag nothing in this table names is an `items` table this build
 * cannot fully read. A flag named only on the other surface would carry a value the requested
 * enum does not publish, which a strict client rejects as hard as a missing field. Neither is a
 * value to fall back to.
 */
const SURFACES = Object.freeze([CHARACTER, CORPORATION, CHARACTER_BLUEPRINT]);

function locationFlagFor(flagId, surface) {
  if (!SURFACES.includes(surface)) {
    throw new Error(
      `ESI mod: locationFlagFor takes one of ${SURFACES.join(", ")}, got `
        + `${JSON.stringify(surface)}. The enums differ by dozens of values and none contains `
        + "another, so there is no surface to fall back to.",
    );
  }

  // The blueprint surface is the character one minus a set. Resolve against
  // the table under `character` and subtract, rather than keeping a second
  // table that could disagree with the first about a flag they share.
  const table = surface === CHARACTER_BLUEPRINT ? CHARACTER : surface;

  // `Number()` on its own would be too generous now that 0 is a row: it reads
  // `null`, `""`, `false` and `[]` as zero, so an items row carrying no flag at
  // all would come out as `AutoFit` rather than as a refusal. A number or the
  // string spelling of one, and nothing else.
  const numeric = typeof flagId === "number" || (typeof flagId === "string" && flagId.trim() !== "")
    ? Number(flagId)
    : NaN;
  const row = Number.isSafeInteger(numeric) ? FLAGS.get(numeric) : undefined;
  if (row === undefined) throw new UnknownLocationFlagError(flagId, surface);

  // One id can go out under two names, one per surface: 174 is `CorpseBay` to a
  // pilot and `CrateLoot` to a corporation. Resolved here rather than at the
  // row so every caller gets it, the blueprint surfaces included, which reach
  // the table through `table` above.
  const name = table === CORPORATION && row.corporationName !== null
    ? row.corporationName
    : row.name;

  if (!row.surfaces.includes(table)) {
    throw new UnknownLocationFlagError(
      numeric,
      surface,
      `${name} is published only on the ${row.surfaces.join(" and ")} enum`,
    );
  }
  if (surface === CHARACTER_BLUEPRINT && NOT_ON_CHARACTER_BLUEPRINTS.has(name)) {
    throw new UnknownLocationFlagError(
      numeric,
      surface,
      `${name} is a place a blueprint cannot be, and the blueprints enum does not publish it`,
    );
  }

  return name;
}

module.exports = Object.freeze({
  CHARACTER,
  CHARACTER_BLUEPRINT,
  CORPORATION,
  CORPORATION_BLUEPRINT,
  NOT_ON_CHARACTER_BLUEPRINTS,
  SURFACES,
  CORP_HANGAR_FIRST,
  FIGHTER_TUBE_FIRST,
  FLAGS,
  SINGULAR_FLAGS,
  SLOT_FAMILIES,
  UnknownLocationFlagError,
  locationFlagFor,
});
