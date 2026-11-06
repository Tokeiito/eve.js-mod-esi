/**
 * The three contact buckets: personal, corporation and alliance standings.
 *
 *   GET /v2/characters/{character_id}/contacts/   esi-characters.read_contacts.v1
 *   GET /v2/corporations/{corporation_id}/contacts/  esi-corporations.read_contacts.v1
 *   GET /v2/alliances/{alliance_id}/contacts/     esi-alliances.read_contacts.v1
 *
 * One file for three operations because they share one item vocabulary, one
 * TTL, one page parameter and one way of turning an id into a `contact_type`,
 * and the differences fit in a table. `/v2/` is the prefix eve-nexum uses; every
 * prefix resolves and pins to `2020-01-01` (D4).
 *
 * Every field name, type, required flag, TTL and scope comes from
 * `contract/openapi.json` and is asserted against it by
 * `test/contactsContract.test.js`. Three points where the obvious reading
 * is wrong:
 *
 *   - There are three body shapes, not one. All require the same three fields
 *     and the optional set shrinks as the owner grows: `is_blocked` is declared
 *     on the character bucket only, `is_watched` on the character and
 *     corporation buckets only, and the alliance bucket has neither. eve.js
 *     carries a watchlist flag on an alliance contact and this file drops it,
 *     because a field CCP does not declare is as visible as one it does.
 *   - The eve.js source is not `standingData`. Personal contacts are
 *     `personalContacts` on the character record; the other two are `contacts`
 *     on the corporation and alliance entries of the `corporationRuntime`
 *     table, a different module and store, hence three accessors.
 *   - Omitting `X-Pages` is not what CCP does: `contract/wire.js`
 *     `AUTHENTICATED_PAGING` records the header present with the value `1` on an
 *     authenticated collection that fits on one page. Every route here declares
 *     `pageSize`, so the framework sends it on every response.
 *
 * The consumer: eve-nexum inserts these rows with `UNNEST($2::text[], $3::int[],
 * $4::real[])`, so a null standing or a non-numeric id aborts that bucket's
 * whole transaction, with no per-row tolerance downstream. Every drop is made
 * here, before the row exists.
 *
 * Observed 2026-08-25 against live ESI with a real token, across two characters
 * and all three buckets (about 580 rows). `contract/wire.js` `CONTACTS` is the
 * record, and the tests read it from there. Four facts decide the shapes:
 *
 *   1. Field order is alphabetical: `contact_id`, `contact_type`, `is_watched`,
 *      `standing`. `is_watched` is the evidence: it is optional and lands
 *      between `contact_type` and `standing`, as alphabetical predicts and the
 *      pinned document's declaration order does not.
 *
 *   2. An inapplicable optional is omitted, never sent as `false`. On one
 *      character's contacts, 35 rows carried `is_watched` and 104 did not. So
 *      `is_watched` and `is_blocked` are `true`-or-absent. This is the opposite
 *      of the rule the same capture found for `/characters/{id}/roles/`, where
 *      an empty array is sent as `[]`; both are recorded and neither is
 *      generalised.
 *
 *   3. `label_ids` appeared on no row. It is declared optional and never seen.
 *      eve.js has a `labelMask` per contact and a label table per owner, but a
 *      mask decomposition nobody can check against CCP's numbering is not
 *      observed behaviour, so the field is omitted.
 *
 *   4. The corporation bucket's page size is 200, read off a response that
 *      returned exactly 200 rows with `X-Pages: 2`.
 *
 * The producer is the application on all three: `contract/wire.js`
 * `SUCCESS_KIND` carries a row for each path, read rather than inherited from a
 * sibling.
 *
 * Three stores, three shapes:
 *
 *   personal      `record.personalContacts`: `{ "<id>": { contactID,
 *                 inWatchlist, relationshipID, labelMask } }`, read through
 *                 `peekCharacterRecord` with a projector, as `routes/roles.js`
 *                 reads `corporationID`. Never `getCharacterRecord`, which
 *                 writes the record back when normalisation drifts.
 *   corporation   `getCorporationRuntime(id).contacts`
 *   alliance      `getAllianceRuntime(id).contacts`
 *
 * The last two carry no `contactID` inside the row: the id is the key, as in
 * eve.js's `buildContactKeyVal`. `contactRowsOf` takes it from there and falls
 * back to an inner `contactID` where one exists.
 *
 * Both runtime reads deep-clone the whole owner runtime (members, titles,
 * bulletins, the role history) to return one `contacts` map. There is no
 * narrower exported door. The cost is bounded as
 * `/corporations/{id}/structures/` bounds its own clone: the route paginates, so
 * `lib/router.js` asks the handler for the whole collection once per cache
 * window and slices it.
 *
 * `contact_type` is a closed four-value enum in CCP's document, and eve.js
 * stores an id only, so the type is asked of the game in two steps:
 *
 *   1. `peekCharacterRecord`: a player character, the commonest contact.
 *   2. `getOwnerTypeId`: eve.js's owner lookup, narrowed to the `typeID` it
 *      stamps (corporation, alliance, faction, or an NPC character).
 *
 * `OWNER_TYPES` is four vendor constants copied because only
 * `lib/runtimeAccess.js` may require game code, as `routes/roles.js` does with
 * the corporation role bits, and checked by a vendor-drift test.
 *
 * An id the game cannot name is dropped. There is no fifth enum member, a
 * guessed type is a wrong row the consumer writes into its standings table, and
 * throwing would turn one stale contact (an entity deleted after it was added)
 * into a `500` for the whole bucket, a standings refresh that never completes.
 * Under-reporting is the direction chosen when `routes/roles.js` dropped nine
 * role bits rather than name them wrongly. Upstream does the same for keys: one
 * that is not a positive integer is skipped, as `normalizePersonalContacts`
 * does.
 *
 * `standing` is eve.js's `relationshipID`, the value the client sends with
 * `AddContact` / `EditContactsRelationshipID`, and every eve.js reader runs it
 * through `normalizeInteger(value, 0)`. `toStanding` is that function:
 * truncating, and `0` for anything unreadable. The spec declares `standing` a
 * `double` with no minimum or maximum, so nothing clamps to EVE's -10..10; a
 * clamp would be a rule neither CCP nor the game's writers apply.
 *
 * Truncating to an integer is not writing one. CCP writes a decimal point on
 * every double whatever its value (`"security_status":0.0`,
 * `"price":170000000.0`), so a `standing` of `5` reaches the wire as `5.0`, two
 * bytes `JSON.stringify` would not write, counted by `content-length` and
 * `Etag`. (Observed 2026-08-25: `GET /latest/corporations/1000035/` is a gateway
 * route and answers `"tax_rate":0.000`; Go never writes trailing zeros, so
 * these bodies are not Go `Marshal` output.) Every `standing` is therefore
 * marked with `double()`. `contract/wire.js` `DOUBLE_RENDERING` records the
 * finding and `lib/serialize.js` renders it.
 *
 * A scope says the caller may read corporations' contacts, never that they may
 * read this corporation's, so both owner-keyed routes declare a `subject`;
 * `lib/router.js` will not compile them without one.
 *
 * The corporation gate refuses with bytes observed on this route: `403
 * {"error":"Character is not in the corporation"}`, 47 bytes, charged to
 * `corp-social` at the usual refusal cost of 5. `routes/structures.js` borrows
 * it because its wording names the relationship rather than the permission.
 *
 * The alliance gate has no such bytes. The wording is corporation-shaped, and an
 * invented alliance wording is the guess `contract/wire.js` exists to refuse.
 * A caller asking for an alliance they are not in is therefore refused as a
 * logged `500`: the read is refused either way and only the status is wrong,
 * loudly. That is `lib/router.js`'s documented bargain, also taken by
 * `routes/structures.js` `universeStructureSubject`. One request closes it; see
 * `allianceContactsSubject`.
 *
 * Neither route enforces a corporation role. The pinned document publishes
 * `x-required-roles` on 28 operations and on none of these three. eve-nexum's
 * comment guessing that corporation contacts need the Contact Manager role is a
 * guess about CCP, and enforcing an unpublished gate refuses callers real ESI
 * admits.
 *
 * `deps.runtime` is `lib/runtimeAccess.js` or a double, taken through each
 * factory's closure as `routes/roles.js` takes it. An absent accessor is a throw
 * naming it, not an empty bucket: an empty bucket is a valid, complete, wrong
 * answer, and `replaceStandings` acts on one by deleting every standing it had
 * recorded for that owner.
 */

"use strict";

const { OMIT, double, numberOrNull, projection } = require("../lib/serialize");
const { familyFor, notInCorporation } = require("../lib/errors");
const { CHARACTER_ID_PARAM } = require("./characters");
const { readCallerCorporationId, unreadable } = require("./roles");
const { canonicalId } = require("./structures");

// The three routes

const CHARACTER_CONTACTS_PATH = "/characters/:character_id/contacts";
const CORPORATION_CONTACTS_PATH = "/corporations/:corporation_id/contacts";
const ALLIANCE_CONTACTS_PATH = "/alliances/:alliance_id/contacts";

/**
 * The parameter spellings; both owner ones are load-bearing.
 *
 * `lib/router.js` `compileRoute` decides a route needs a `subject` declaration
 * by looking for a path parameter ending in `_id` that is not `character_id`. A
 * parameter spelled `:id` would fail that heuristic and the scope would be the
 * only gate: any holder of `esi-alliances.read_contacts.v1` could read any
 * alliance's standings.
 */
const CORPORATION_ID_PARAM = "corporation_id";
const ALLIANCE_ID_PARAM = "alliance_id";

/** `x-cache-age` in the pinned spec: five minutes on all three. */
const CHARACTER_CONTACTS_CACHE_TTL_SECONDS = 300;
const CORPORATION_CONTACTS_CACHE_TTL_SECONDS = 300;
const ALLIANCE_CONTACTS_CACHE_TTL_SECONDS = 300;

/** The scopes CCP publishes, one per operation. */
const CHARACTER_CONTACTS_SCOPE = "esi-characters.read_contacts.v1";
const CORPORATION_CONTACTS_SCOPE = "esi-corporations.read_contacts.v1";
const ALLIANCE_CONTACTS_SCOPE = "esi-alliances.read_contacts.v1";

/**
 * Three buckets, three token buckets. The character one is twice the size of
 * the other two, which is the document's own answer to "is this one family".
 */
const CHARACTER_CONTACTS_RATE_LIMIT_GROUP = "char-social";
const CORPORATION_CONTACTS_RATE_LIMIT_GROUP = "corp-social";
const ALLIANCE_CONTACTS_RATE_LIMIT_GROUP = "alliance-social";

const PRODUCER = "app";

/**
 * The corporation bucket's page size, measured.
 *
 * A response of exactly 200 rows carrying `X-Pages: 2`: a full page with more
 * behind it, which fixes the size.
 */
const CORPORATION_CONTACTS_PAGE_SIZE = 200;

/**
 * The character and alliance page sizes, chosen. A separate constant, so the
 * difference between a measurement and a choice is visible in the route table.
 *
 * The pinned document publishes the `page` parameter and the `X-Pages` header
 * and no page size. The capture bounds these two from below without fixing
 * either: the alliance bucket returned 240 rows on `X-Pages: 1`, so its size is
 * at least 240 and not the corporation's 200, and the character bucket returned
 * a single page smaller still. `contract/wire.js` warns against assuming the
 * 1000 that `/markets/{region_id}/orders/` proved.
 *
 * This is a declaration chosen to clear both bounds. Its cost here is nothing: a
 * private server's character or alliance will not hold a thousand contacts, so
 * every real response is one page under any candidate number.
 *
 * Settling it needs one probe per bucket against an owner large enough to
 * overflow: fetch the last page and count it.
 *
 *   curl -sD - -H "Authorization: Bearer <token>" \
 *     "https://esi.evetech.net/v2/alliances/<alliance_id>/contacts/?page=<X-Pages>"
 */
const UNOBSERVED_PAGE_SIZE = 1000;

// eve.js's owner vocabulary

/**
 * How eve.js says what an id is, and therefore the whole of `contact_type`.
 *
 * Four `typeID` constants, copied because only `lib/runtimeAccess.js` may
 * require game code, as `lib/sessionIdentity.js` does with the GM role bits and
 * `routes/roles.js` with the corporation role mask.
 * `test/contactsContract.test.js` re-reads each declaration out of the vendor
 * tree.
 *
 * They are real EVE `typeID`s, which is why they come from two modules: the
 * first three are `corporationState`'s and the faction one belongs to
 * `factionState`, beside the `isFactionID` that decides membership.
 *
 * Sorted on the ESI name so the table reads as the enum it feeds.
 */
const OWNER_TYPES = Object.freeze([
  Object.freeze({
    contactType: "alliance",
    typeId: 16159,
    evejs: "OWNER_TYPE_ALLIANCE",
    where: "services/corporation/corporationState.js",
  }),
  Object.freeze({
    contactType: "character",
    typeId: 1373,
    evejs: "OWNER_TYPE_CHARACTER",
    where: "services/corporation/corporationState.js",
  }),
  Object.freeze({
    contactType: "corporation",
    typeId: 2,
    evejs: "OWNER_TYPE_CORPORATION",
    where: "services/corporation/corporationState.js",
  }),
  Object.freeze({
    contactType: "faction",
    typeId: 30,
    evejs: "OWNER_TYPE_FACTION",
    where: "services/faction/factionState.js",
  }),
]);

/** `typeID` -> `contact_type`, built from the table above so the two cannot part. */
const CONTACT_TYPE_BY_OWNER_TYPE = Object.freeze(Object.fromEntries(
  OWNER_TYPES.map((owner) => [owner.typeId, owner.contactType]),
));

// Reading the stores

/** `deps.runtime`, or an empty object: the accessors are duck-typed below. */
function readRuntime(deps) {
  const d = deps && typeof deps === "object" ? deps : {};
  return d.runtime && typeof d.runtime === "object" ? d.runtime : {};
}

/**
 * Who is asking, as a number that was signed.
 *
 * See `routes/roles.js` `callerCharacterId`: the path segment is a string
 * somebody typed and the claim is a number this server signed.
 */
function callerCharacterId(params, operationId) {
  const credential = params && params.credential;
  const characterId = credential && credential.characterId;

  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new Error(
      `ESI mod: ${operationId} ran with no verified credential. Every route in this module `
        + "declares a scope, so lib/router.js authorise() should have refused the request before "
        + "the handler saw it.",
    );
  }

  return characterId;
}

/**
 * `relationshipID` as a standing.
 *
 * `normalizeInteger(value, 0)`, which every eve.js reader of this field does:
 * truncating, and `0` for anything that is not a finite number. There is no
 * clamp to EVE's -10..10 (see the header).
 */
function toStanding(value) {
  const numeric = numberOrNull(typeof value === "string" ? value.trim() : value);
  return numeric === null ? 0 : Math.trunc(numeric);
}

/**
 * A stored contact table as owned rows, in ascending contact id.
 *
 * The id comes from the key, because for a corporation or an alliance that is
 * the only place it is: `Handle_AddCorporateContact` stores `{ relationshipID,
 * labelMask, inWatchlist }` and eve.js's `buildContactKeyVal` takes the id from
 * the key. A personal contact carries an inner `contactID` as well, and that one
 * wins where usable, as in `normalizePersonalContacts`.
 *
 * A key that is not a positive integer is skipped rather than repaired
 * (upstream's `if (!(contactID > 0)) continue;`).
 *
 * The sort is deliberate. The wire order within a page was not captured, but a
 * paginated collection needs a total order that does not depend on how a `Map`
 * was filled, or a client sweeping page 2 can be handed a row it already read on
 * page 1.
 */
function contactRowsOf(source) {
  const table = source && typeof source === "object" ? source : {};
  const rows = [];

  for (const [key, stored] of Object.entries(table)) {
    const contact = stored && typeof stored === "object" ? stored : {};
    const contactId = canonicalId(contact.contactID) ?? canonicalId(key);
    if (contactId === null) continue;

    rows.push({
      contactId,
      inWatchlist: contact.inWatchlist === true,
      standing: toStanding(contact.relationshipID),
    });
  }

  return rows.sort((left, right) => left.contactId - right.contactId);
}

/**
 * A character's own contacts and blocked list, owned.
 *
 * Through `peekCharacterRecord` with a `project` callback, as `routes/roles.js`
 * reads the corporation id. The callback runs against the live in-memory record
 * and must borrow nothing from it, so it builds the rows and the blocked ids
 * inside the callback.
 *
 * A missing accessor and a missing record are both throws. "No record, therefore
 * no contacts" is a body a consumer acts on: eve-nexum's `replaceStandings`
 * deletes every standing it holds for the owner, so a pilot with 300 contacts
 * would end up with none and the sync would report success.
 */
function readPersonalContacts(runtime, operationId, characterId) {
  if (typeof runtime.peekCharacterRecord !== "function") {
    throw unreadable(
      operationId,
      characterId,
      "the runtime exposes no peekCharacterRecord accessor. It must be the non-cloning peek, "
        + "never getCharacterRecord, which writes the record back when normalisation drifts",
    );
  }

  const found = runtime.peekCharacterRecord(characterId, {
    project: (record) => ({
      contacts: contactRowsOf(record.personalContacts),
      blocked: new Set(Object.keys(
        record.blockedOwners && typeof record.blockedOwners === "object"
          ? record.blockedOwners
          : {},
      ).map(Number)),
    }),
  });

  if (found === null || typeof found !== "object") {
    throw unreadable(operationId, characterId, "the game has no record for that character");
  }

  return found;
}

/**
 * An owner's contacts, owned, from the `corporationRuntime` table.
 *
 * `null` from the accessor means the owner has no runtime entry at all. It is a
 * throw rather than an empty bucket, for the reason above and one more: the
 * subject check has already proved the caller belongs to this owner, so an owner
 * the runtime has never heard of is this server disagreeing with itself.
 */
function readOwnerContacts(runtime, operationId, characterId, accessor, ownerId, noun) {
  if (typeof runtime[accessor] !== "function") {
    throw unreadable(
      operationId,
      characterId,
      `the runtime exposes no ${accessor} accessor, and an empty contact list is a valid, `
        + "complete, wrong answer that a consumer acts on by deleting the standings it holds",
    );
  }

  const contacts = runtime[accessor](ownerId);
  if (contacts === null || typeof contacts !== "object") {
    throw unreadable(
      operationId,
      characterId,
      `the game has no runtime record for ${noun} ${ownerId}, which the subject check has `
        + "already proved the caller belongs to",
    );
  }

  return contactRowsOf(contacts);
}

// An id, and what kind of thing it is

/**
 * `contact_type` for one id, or `null` for an id this game cannot name.
 *
 * Two questions in the order that costs least; a `null` drops the row rather
 * than throwing or guessing (see the header).
 */
function contactTypeOf(runtime, operationId, characterId, contactId) {
  if (typeof runtime.peekCharacterRecord !== "function") {
    throw unreadable(
      operationId,
      characterId,
      "the runtime exposes no peekCharacterRecord accessor, and a player character is the "
        + "commonest contact there is",
    );
  }

  // The projector returns a constant: the question is only whether the record
  // exists, and returning anything off the live record would borrow from it.
  if (runtime.peekCharacterRecord(contactId, { project: () => true }) === true) {
    return "character";
  }

  if (typeof runtime.getOwnerTypeId !== "function") {
    throw unreadable(
      operationId,
      characterId,
      "the runtime exposes no getOwnerTypeId accessor, so every corporation, alliance and "
        + "faction contact would be dropped as unnameable",
    );
  }

  const typeId = runtime.getOwnerTypeId(contactId);
  return CONTACT_TYPE_BY_OWNER_TYPE[typeId] ?? null;
}

/**
 * The rows, with a `contact_type` on each and the unnameable ones gone.
 *
 * @param {object[]} rows  from `contactRowsOf`
 */
function withContactTypes(runtime, operationId, characterId, rows) {
  const named = [];

  for (const row of rows) {
    const contactType = contactTypeOf(runtime, operationId, characterId, row.contactId);
    if (contactType === null) continue;
    named.push({ ...row, contactType });
  }

  return named;
}

// The bodies

/**
 * `true`, or the key left out.
 *
 * The observed rule on this family. `optional(row.inWatchlist)` would pass
 * `false` through, which is correct elsewhere and wrong here: 35 rows of 139
 * carried `is_watched` and the other 104 did not carry it as `false`.
 */
function trueOrOmit(value) {
  return value === true ? true : OMIT;
}

/**
 * `label_ids`, always omitted, declared in its alphabetical seat (as
 * `last_login` and `logins` are in `routes/characters.js`) so the divergence is
 * visible in the field list.
 */
const noLabels = () => OMIT;

const projectCharacterContact = projection("GetCharactersCharacterIdContacts", {
  contact_id: (row) => row.contactId,
  contact_type: (row) => row.contactType,
  is_blocked: (row) => trueOrOmit(row.isBlocked),
  is_watched: (row) => trueOrOmit(row.inWatchlist),
  label_ids: noLabels,
  standing: (row) => double(row.standing),
});

const projectCorporationContact = projection("GetCorporationsCorporationIdContacts", {
  contact_id: (row) => row.contactId,
  contact_type: (row) => row.contactType,
  is_watched: (row) => trueOrOmit(row.inWatchlist),
  label_ids: noLabels,
  standing: (row) => double(row.standing),
});

// No `is_watched`: eve.js carries `inWatchlist` on an alliance contact and CCP
// does not declare the field on this operation.
const projectAllianceContact = projection("GetAlliancesAllianceIdContacts", {
  contact_id: (row) => row.contactId,
  contact_type: (row) => row.contactType,
  label_ids: noLabels,
  standing: (row) => double(row.standing),
});

// Who may read this owner's contacts

/**
 * `SUBJECT` for `/corporations/{corporation_id}/contacts/`.
 *
 * One question, is the caller in this corporation, answered with bytes observed
 * on this exact route, so it refuses rather than throwing.
 *
 * A non-canonical `corporation_id` is answered as "not the caller's
 * corporation". That is a divergence: real ESI would refuse
 * `/corporations/abc/contacts/` with a coercion `400` before asking who was
 * calling. `lib/errors.js` `coercionFailed` has the observed body, but every
 * observation of it is of a refusal made where `routedRefusal` dresses it,
 * without `X-Esi-Cache-Status`, and a gate refusal carries one. Observed bytes
 * attached to a true claim beat invented headers. `routes/structures.js` makes
 * the same trade on the same parameter.
 *
 * @param {object} claims      the verified token's projection
 * @param {object} pathParams  the router's captures, as strings
 * @param {object} deps        `{ runtime }`, from the factory's closure
 */
function corporationContactsSubject(claims, pathParams, deps) {
  const operationId = "GetCorporationsCorporationIdContacts";
  const runtime = readRuntime(deps);

  const requested = canonicalId(pathParams && pathParams[CORPORATION_ID_PARAM]);
  const corporationId = readCallerCorporationId(runtime, operationId, claims.characterId);

  if (requested === null || requested !== corporationId) {
    return notInCorporation(familyFor(PRODUCER));
  }

  return null;
}

/**
 * `SUBJECT` for `/alliances/{alliance_id}/contacts/`, the one place in this
 * file that throws rather than refusing.
 *
 * Membership is ordinary: a character is in an alliance through their
 * corporation, so the caller's corporation record is asked for its `allianceID`
 * and the path has to match. A caller whose corporation is in no alliance
 * matches nothing, which is right.
 *
 * The refusal is missing. `contract/wire.js` `CROSS_ENTITY_REFUSAL` holds the
 * corporation one and notes it cannot be reused here, because its wording names
 * the relationship ("is not in the corporation"). Whether the alliance form is
 * `403 {"error":"Character is not in the alliance"}`, other wording, or a `404`
 * hiding the alliance's existence is unobserved. One request with a token
 * holding `esi-alliances.read_contacts.v1` settles it:
 *
 *   curl -sD - -H "Authorization: Bearer <token>" \
 *     "https://esi.evetech.net/v2/alliances/<an alliance the character is not in>/contacts/"
 *
 * Record the status, the body verbatim, its `Content-Length`, and whether
 * `X-Esi-Cache-Status` is present (a gate refusal carries one, a handler-thrown
 * refusal does not). Add the row to `contract/wire.js` beside
 * `CROSS_ENTITY_REFUSAL` and the builder to `lib/errors.js` beside
 * `notInCorporation`, and this function returns it instead of throwing.
 *
 * Until then the throw is `lib/router.js` `gateOrFail`'s logged `500`: the read
 * is refused either way and the status is loudly wrong rather than quietly
 * invented.
 */
function allianceContactsSubject(claims, pathParams, deps) {
  const operationId = "GetAlliancesAllianceIdContacts";
  const runtime = readRuntime(deps);
  const characterId = claims.characterId;

  const requested = canonicalId(pathParams && pathParams[ALLIANCE_ID_PARAM]);
  const corporationId = readCallerCorporationId(runtime, operationId, characterId);

  if (typeof runtime.getCorporationRecord !== "function") {
    throw unreadable(
      operationId,
      characterId,
      "the runtime exposes no getCorporationRecord accessor, and a character is in an alliance "
        + "only through their corporation",
    );
  }

  const corporation = runtime.getCorporationRecord(corporationId);
  const allianceId = numberOrNull(corporation && corporation.allianceID);

  if (requested !== null && allianceId !== null && requested === allianceId) return null;

  throw new Error(
    `ESI mod: ${operationId} refused an alliance the caller's corporation is not in (or a `
      + "path segment that is no alliance id at all), and the refusal CCP sends for either has "
      + "never been observed. The corporation wording in "
      + "contract/wire.js CROSS_ENTITY_REFUSAL names the relationship and so cannot be reused "
      + "for an alliance. See routes/contacts.js allianceContactsSubject for the one request "
      + "that settles it. The read is refused either way; only the status is wrong, and loudly.",
  );
}

// The handlers
//
// Each returns the whole collection: the routes declare `pageSize`, so
// `lib/router.js` calls the handler once per cache window and slices, which
// keeps `X-Pages` and the body from disagreeing.

/** `GET /characters/{character_id}/contacts/`. */
function buildCharacterContacts(params, deps) {
  const operationId = "GetCharactersCharacterIdContacts";
  const runtime = readRuntime(deps);
  const characterId = callerCharacterId(params, operationId);

  const { contacts, blocked } = readPersonalContacts(runtime, operationId, characterId);

  return withContactTypes(runtime, operationId, characterId, contacts)
    .map((row) => projectCharacterContact({ ...row, isBlocked: blocked.has(row.contactId) }));
}

/** `GET /corporations/{corporation_id}/contacts/`. */
function buildCorporationContacts(params, deps) {
  const operationId = "GetCorporationsCorporationIdContacts";
  const runtime = readRuntime(deps);
  const characterId = callerCharacterId(params, operationId);

  const corporationId = canonicalId(params.path[CORPORATION_ID_PARAM]);
  if (corporationId === null) {
    // Unreachable: the subject check refuses a non-canonical id before this runs.
    // Kept because a wrong "unreachable" would produce a body describing an owner
    // nobody asked about.
    throw unreadable(
      operationId,
      characterId,
      `the path names corporation ${JSON.stringify(params.path[CORPORATION_ID_PARAM])}, which `
        + "is not a canonical positive integer, and the subject check should have refused it",
    );
  }

  const rows = readOwnerContacts(
    runtime, operationId, characterId, "getCorporationContacts", corporationId, "corporation",
  );

  return withContactTypes(runtime, operationId, characterId, rows)
    .map(projectCorporationContact);
}

/** `GET /alliances/{alliance_id}/contacts/`. */
function buildAllianceContacts(params, deps) {
  const operationId = "GetAlliancesAllianceIdContacts";
  const runtime = readRuntime(deps);
  const characterId = callerCharacterId(params, operationId);

  const allianceId = canonicalId(params.path[ALLIANCE_ID_PARAM]);
  if (allianceId === null) {
    // Unreachable: this route's subject check throws for anything it cannot match,
    // and a non-canonical id matches nothing.
    throw unreadable(
      operationId,
      characterId,
      `the path names alliance ${JSON.stringify(params.path[ALLIANCE_ID_PARAM])}, which is not `
        + "a canonical positive integer, and the subject check should have refused it",
    );
  }

  const rows = readOwnerContacts(
    runtime, operationId, characterId, "getAllianceContacts", allianceId, "alliance",
  );

  return withContactTypes(runtime, operationId, characterId, rows)
    .map(projectAllianceContact);
}

// Route descriptors
//
// All three are callable as `factory({})`: deps are read inside the handler and
// the subject check, never at construction.
//
// None declares `localizedBody`: the bodies are ids, an enum from a four-word
// vocabulary and a number, with no `name` or `description`, so they send the
// three-line `Vary`.
//
// None declares `errorFamily`: `lib/router.js` derives it from `producer`.

/**
 * `/characters/{character_id}/contacts/`.
 *
 * No `subject` column. The route is keyed by `:character_id` only, so
 * `lib/router.js` `compileRoute` does not demand one and the default,
 * `SUBJECT.CALLER` (the cross-character comparison), is the right check.
 */
function createCharacterContactsRoute(deps) {
  return {
    method: "GET",
    path: CHARACTER_CONTACTS_PATH,
    name: "GetCharactersCharacterIdContacts",
    handler: (params) => buildCharacterContacts(params, deps),
    producer: PRODUCER,
    scope: CHARACTER_CONTACTS_SCOPE,
    cacheTtl: CHARACTER_CONTACTS_CACHE_TTL_SECONDS,
    rateLimitGroup: CHARACTER_CONTACTS_RATE_LIMIT_GROUP,
    pageSize: UNOBSERVED_PAGE_SIZE,
  };
}

/** `/corporations/{corporation_id}/contacts/`. */
function createCorporationContactsRoute(deps) {
  return {
    method: "GET",
    path: CORPORATION_CONTACTS_PATH,
    name: "GetCorporationsCorporationIdContacts",
    handler: (params) => buildCorporationContacts(params, deps),
    producer: PRODUCER,
    scope: CORPORATION_CONTACTS_SCOPE,
    cacheTtl: CORPORATION_CONTACTS_CACHE_TTL_SECONDS,
    rateLimitGroup: CORPORATION_CONTACTS_RATE_LIMIT_GROUP,
    pageSize: CORPORATION_CONTACTS_PAGE_SIZE,
    // The router hands a `subject` function its own dispatch `deps`, which here is
    // `{ logError, now }` with no runtime. The runtime is injected per route through
    // this factory's closure, as for the handler beside it, so the third argument is
    // deliberately not taken: a check that read the game through the dispatch deps
    // would find nothing and refuse everybody.
    subject: (claims, pathParams) => corporationContactsSubject(claims, pathParams, deps),
  };
}

/** `/alliances/{alliance_id}/contacts/`. */
function createAllianceContactsRoute(deps) {
  return {
    method: "GET",
    path: ALLIANCE_CONTACTS_PATH,
    name: "GetAlliancesAllianceIdContacts",
    handler: (params) => buildAllianceContacts(params, deps),
    producer: PRODUCER,
    scope: ALLIANCE_CONTACTS_SCOPE,
    cacheTtl: ALLIANCE_CONTACTS_CACHE_TTL_SECONDS,
    rateLimitGroup: ALLIANCE_CONTACTS_RATE_LIMIT_GROUP,
    pageSize: UNOBSERVED_PAGE_SIZE,
    // The closure's deps, not the router's; see the note on the route above.
    subject: (claims, pathParams) => allianceContactsSubject(claims, pathParams, deps),
  };
}

module.exports = Object.freeze({
  ALLIANCE_CONTACTS_CACHE_TTL_SECONDS,
  ALLIANCE_CONTACTS_PATH,
  ALLIANCE_CONTACTS_RATE_LIMIT_GROUP,
  ALLIANCE_CONTACTS_SCOPE,
  ALLIANCE_ID_PARAM,
  CHARACTER_CONTACTS_CACHE_TTL_SECONDS,
  CHARACTER_CONTACTS_PATH,
  CHARACTER_CONTACTS_RATE_LIMIT_GROUP,
  CHARACTER_CONTACTS_SCOPE,
  CHARACTER_ID_PARAM,
  CONTACT_TYPE_BY_OWNER_TYPE,
  CORPORATION_CONTACTS_CACHE_TTL_SECONDS,
  CORPORATION_CONTACTS_PAGE_SIZE,
  CORPORATION_CONTACTS_PATH,
  CORPORATION_CONTACTS_RATE_LIMIT_GROUP,
  CORPORATION_CONTACTS_SCOPE,
  CORPORATION_ID_PARAM,
  OWNER_TYPES,
  PRODUCER,
  UNOBSERVED_PAGE_SIZE,
  allianceContactsSubject,
  buildAllianceContacts,
  buildCharacterContacts,
  buildCorporationContacts,
  contactRowsOf,
  contactTypeOf,
  corporationContactsSubject,
  createAllianceContactsRoute,
  createCharacterContactsRoute,
  createCorporationContactsRoute,
  projectAllianceContact,
  projectCharacterContact,
  projectCorporationContact,
  toStanding,
});
