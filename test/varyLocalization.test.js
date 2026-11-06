/**
 * The fourth `Vary` line, and the rule that predicts it
 *
 * Run with:  node --test "test/**\/*.test.js"   (or RunTests.bat)
 *
 * CCP repeats `Vary: Accept-Language` on some routes and not others. This
 * replica used to repeat it on every application response, generalised from a
 * survey of `/universe/factions/`, and that was wrong on every application route
 * this replica serves.
 *
 * The survey covered eighteen routes on 2026-08-24, and the split is total: the
 * routes with `name` and `description` in their bodies repeat the header, and
 * the routes that answer with ids and numbers do not.
 *
 *   /universe/regions/{id}/   two lines      /universe/regions/    one line
 *   /universe/types/{id}/     two lines      /universe/types/      one line
 *
 * Two rows of the same resource, the same producer and the same weak etag from
 * the same static-data dump disagree, which ruled out the hypothesis that the
 * duplicate came from the cache in front of `/universe/`. It follows the
 * content. It is not a function of status either: `/universe/regions/99999999/`
 * repeats it on a `404`, and `?page=0` on `/markets/{region_id}/orders/` does not
 * repeat it on a `400`.
 *
 * `contract/wire.js` states the rule. Here it is executable: the prediction (the
 * operation's `200` schema carries a localizable `name` or `description`
 * string) is run against the recorded survey, so a rule that stops explaining
 * the observations fails a test. It also fixes a boundary the survey could not:
 * the pinned spec declares the `AcceptLanguage` parameter on every operation,
 * `/status/` included, so the parameter list cannot tell these routes apart and
 * the response schema can.
 *
 * `lib/` does not read the spec. `contract/` is test-only and never deployed
 * (D20), so a route declares `localizedBody` in the route table and the last
 * test here checks the declarations.
 *
 * The producer clause. The survey is eighteen application routes, so it could
 * not discover that the producer matters. `/characters/{id}/`,
 * `/corporations/{id}/` and `/alliances/{id}/` are the gateway; each answers
 * with a `name`, two of them with a `description`, and all three send the plain
 * three-line `Vary`. So:
 *
 *   gateway      -> three lines, whatever the body carries
 *   application  -> four lines iff the 200 schema carries name/description
 *
 * `/status/` sat in the `plain` column agreeing with both readings, because it
 * is the gateway and answers with numbers. The boundary stayed invisible until
 * an endpoint arrived that was one and not the other.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const wire = require(path.join(__dirname, "..", "contract", "wire"));
const { loadSpec, resolveSchema } = require(path.join(__dirname, "..", "contract", "spec"));
const { createRouter } = require(path.join(__dirname, "..", "lib", "router"));
const { createStatusRoute } = require(path.join(__dirname, "..", "routes", "status"));
const {
  createCharacterLocationRoute,
  createCharacterOnlineRoute,
  createCharacterShipRoute,
} = require(path.join(__dirname, "..", "routes", "characters"));
const {
  createMarketPricesRoute,
  createMarketRegionOrdersRoute,
} = require(path.join(__dirname, "..", "routes", "markets"));
const {
  createUniverseConstellationRoute,
  createUniverseStarRoute,
  createUniverseStationRoute,
  createUniverseSystemRoute,
} = require(path.join(__dirname, "..", "routes", "universe"));
const {
  createAlliancePublicRoute,
  createCharacterPublicRoute,
  createCorporationPublicRoute,
  createUniverseFactionsRoute,
} = require(path.join(__dirname, "..", "routes", "entities"));

/** The fields CCP translates. A body with one of these has text in it. */
const LOCALIZED_FIELDS = new Set(["name", "description"]);

/**
 * Does this operation answer with translated text?
 *
 * Walks the `200` schema for a `name` or `description` string. The depth limit
 * guards against a `$ref` cycle and is not a claim about how deep ESI's schemas
 * go; nothing observed nests more than two levels.
 */
function answersWithText(spec, schema, depth = 0) {
  const resolved = resolveSchema(spec, schema);
  if (!resolved || depth > 6) return false;

  if (resolved.type === "array") return answersWithText(spec, resolved.items, depth + 1);
  if (!resolved.properties) return false;

  for (const [name, property] of Object.entries(resolved.properties)) {
    const field = resolveSchema(spec, property);
    if (LOCALIZED_FIELDS.has(name) && field && field.type === "string") return true;
    if (answersWithText(spec, property, depth + 1)) return true;
  }

  return false;
}

/** The `200` body schema of a spec operation, or null. */
function successSchema(spec, specPath) {
  const operation = spec.paths[specPath] && spec.paths[specPath].get;
  if (!operation) return null;

  const success = operation.responses && operation.responses["200"];
  const content = success && success.content && success.content["application/json"];
  return content ? content.schema : null;
}

// The rule, against the survey

test("every route CCP repeats the header on answers with translated text", () => {
  const spec = loadSpec();

  for (const specPath of wire.VARY_LOCALIZED_SURVEY.localized) {
    const schema = successSchema(spec, specPath);
    assert.ok(schema, `${specPath} is not a GET in the pinned spec`);
    assert.equal(
      answersWithText(spec, schema),
      true,
      `${specPath} repeats Vary: Accept-Language on the wire, but its 200 schema has no `
      + "localizable name or description: the rule in contract/wire.js no longer explains it",
    );
  }
});

test("every route it does not repeat on answers with ids and numbers", () => {
  const spec = loadSpec();

  for (const specPath of wire.VARY_LOCALIZED_SURVEY.plain) {
    const schema = successSchema(spec, specPath);
    assert.ok(schema, `${specPath} is not a GET in the pinned spec`);
    assert.equal(
      answersWithText(spec, schema),
      false,
      `${specPath} sends one Vary: Accept-Language, but its 200 schema carries localizable text `
      + ": the rule predicts two, so either the survey or the rule is wrong",
    );
  }
});

test("the two columns are disjoint, and neither is empty", () => {
  // A survey that listed the same route twice would make the two tests above
  // contradict each other, and the contradiction would show up as whichever ran
  // second.
  const { localized, plain } = wire.VARY_LOCALIZED_SURVEY;
  const overlap = localized.filter((route) => plain.includes(route));

  assert.deepEqual(overlap, [], "a route cannot be in both columns");
  assert.ok(localized.length >= 6, "the survey needs both columns populated to mean anything");
  assert.ok(plain.length >= 6);
});

test("the spec's own parameter list cannot tell these routes apart", () => {
  // Why the rule reads the response schema rather than the parameters, stated as
  // a test because it is the obvious first thing to try. `AcceptLanguage` is
  // declared on both columns, so a replica deriving the Vary from it would send
  // the fourth line to everybody.
  const spec = loadSpec();
  const declaresLanguage = (specPath) => {
    const operation = spec.paths[specPath].get;
    return (operation.parameters || []).some((parameter) => {
      const name = parameter.$ref ? parameter.$ref.split("/").pop() : parameter.name;
      return /lang/i.test(String(name));
    });
  };

  assert.equal(declaresLanguage("/universe/factions"), true, "the two-line column");
  assert.equal(declaresLanguage("/markets/prices"), true, "and the one-line column, identically");
  assert.equal(declaresLanguage("/status"), true);
});

// The producer qualifier

test("the gateway sends one Vary line on a body full of translated text", () => {
  // The counterexample that put a producer clause on the rule. `/characters/`,
  // `/corporations/` and `/alliances/` each answer with a `name`, two of them with
  // a `description`, and all three send the plain three-line `Vary`.
  //
  // The assertion is deliberately the opposite of the `plain` column's: these
  // routes' schemas do carry text, so `answersWithText` predicts four lines and
  // the wire says three. That makes them evidence rather than exceptions. A
  // column that merely asserted "three lines" would be satisfied by a route with
  // no text in it and would prove nothing.
  const spec = loadSpec();

  for (const specPath of wire.VARY_LOCALIZED_SURVEY.plainDespiteText) {
    const schema = successSchema(spec, specPath);
    assert.ok(schema, `${specPath} is not a GET in the pinned spec`);
    assert.equal(
      answersWithText(spec, schema),
      true,
      `${specPath} is in the column of routes the content rule mispredicts, and its schema `
      + "carries no localizable text, so it is not a counterexample to anything",
    );

    // The thing that separates them is the producer. Keyed as `SUCCESS_KIND` is,
    // with `{param}` rewritten to `:param`.
    const wirePath = specPath.replace(/\{(\w+)\}/g, ":$1");
    assert.equal(
      wire.SUCCESS_KIND[wirePath],
      wire.KIND.GATEWAY_SUCCESS,
      `${specPath} would only explain the rule if it were the gateway`,
    );
  }

  // Every route in the two original columns is the application, which is why the
  // survey could not have found this on its own.
  for (const specPath of wire.VARY_LOCALIZED_SURVEY.localized) {
    const wirePath = specPath.replace(/\{(\w+)\}/g, ":$1");
    if (wire.SUCCESS_KIND[wirePath] === undefined) continue; // not surveyed
    assert.notEqual(wire.SUCCESS_KIND[wirePath], wire.KIND.GATEWAY_SUCCESS, specPath);
  }
});

// The content bound

test("the application sends one Vary line on a name it composed rather than translated", () => {
  // The other bound, and it is not the producer. `/universe/stars/` and
  // `/universe/stations/` are the application, they answer with a `name`, and
  // they send three lines, while `/universe/systems/` and
  // `/universe/constellations/`, captured in the same minute from the same
  // producer, send four.
  //
  // What separates them is in CCP's dump rather than CCP's spec: a system's and a
  // constellation's `name` is a dictionary of eight languages, and a star's and a
  // station's does not exist there at all. The exporter builds "Jita - Star" and
  // "Jita IV - Moon 4 - Caldari Navy Assembly Plant" out of other names. So the
  // rule is about a string CCP translates, and `answersWithText` cannot see the
  // difference. This test asserts exactly that blindness rather than papering
  // over it.
  const spec = loadSpec();

  for (const specPath of wire.VARY_LOCALIZED_SURVEY.plainDespiteComposedName) {
    const schema = successSchema(spec, specPath);
    assert.ok(schema, `${specPath} is not a GET in the pinned spec`);
    assert.equal(
      answersWithText(spec, schema),
      true,
      `${specPath} is in the column of routes the content rule mispredicts, and its schema `
      + "carries no localizable text, so it is not a counterexample to anything",
    );

    // These are the application, which makes them a second, distinct exception
    // rather than more evidence for the producer one.
    const wirePath = specPath.replace(/\{(\w+)\}/g, ":$1");
    assert.equal(
      wire.SUCCESS_KIND[wirePath],
      wire.KIND.APP_SUCCESS,
      `${specPath} would be a known exception rather than a new one if it were the gateway`,
    );
  }
});

test("the four columns are disjoint", () => {
  const survey = wire.VARY_LOCALIZED_SURVEY;
  const columns = Object.entries(survey);
  for (const [nameA, columnA] of columns) {
    for (const [nameB, columnB] of columns) {
      if (nameA >= nameB) continue;
      assert.deepEqual(
        columnA.filter((route) => columnB.includes(route)),
        [],
        `${nameA} and ${nameB} both claim a route, so the two tests over them contradict`,
      );
    }
  }
});

// The route table's declarations

test("every route declares the Vary its producer and its body together imply", () => {
  // The rule the loop below applies has two clauses, because one is not enough:
  //
  //   gateway      -> three lines, whatever the body carries
  //   application  -> four lines iff the 200 schema carries name/description
  //
  // `/universe/factions/` is the application answering with translated prose, so
  // it declares `localizedBody: true` and CCP repeats the header for it.
  //
  // The gateway clause matters. `/characters/{id}/` answers with a name and a
  // description and still sends three lines, so a check that asked only the
  // schema would demand `localizedBody: true` on three routes CCP sends the plain
  // header for, and this replica would fragment a shared cache on a header CCP's
  // does not.
  const spec = loadSpec();
  const router = createRouter([
    createStatusRoute({ runtime: {}, startedAt: Date.now() }),
    createMarketPricesRoute(),
    createMarketRegionOrdersRoute(),
    // The three authenticated reads. `/ship/` is the interesting one: its body
    // carries a `ship_name`, which looks like the case this test exists to catch,
    // but `answersWithText` matches a property named `name` or `description`, and a
    // ship's name is the pilot's own string rather than anything CCP would
    // translate. The spec is asked rather than argued with.
    createCharacterOnlineRoute({ runtime: {} }),
    createCharacterLocationRoute({ runtime: {} }),
    createCharacterShipRoute({ runtime: {} }),
    // Three gateway lookups whose bodies carry text and whose header is the plain
    // one, and one application route whose body carries text and whose header is
    // not.
    createCharacterPublicRoute({ runtime: {} }),
    createCorporationPublicRoute({ runtime: {} }),
    createAlliancePublicRoute({ runtime: {} }),
    createUniverseFactionsRoute({ runtime: {} }),
    // All four are the application and all four schemas carry a `name`. Two of
    // them send the plain header anyway, because their name is composed rather than
    // translated. They are the reason the loop below needs a third clause.
    createUniverseSystemRoute({}),
    createUniverseStarRoute({}),
    createUniverseConstellationRoute({}),
    createUniverseStationRoute({}),
  ]);

  const bySpecPath = {
    GetStatus: "/status",
    GetMarketsPrices: "/markets/prices",
    GetMarketsRegionIdOrders: "/markets/{region_id}/orders",
    GetCharactersCharacterIdOnline: "/characters/{character_id}/online",
    GetCharactersCharacterIdLocation: "/characters/{character_id}/location",
    GetCharactersCharacterIdShip: "/characters/{character_id}/ship",
    GetCharactersCharacterId: "/characters/{character_id}",
    GetCorporationsCorporationId: "/corporations/{corporation_id}",
    GetAlliancesAllianceId: "/alliances/{alliance_id}",
    GetUniverseFactions: "/universe/factions",
    GetUniverseSystemsSystemId: "/universe/systems/{system_id}",
    GetUniverseStarsStarId: "/universe/stars/{star_id}",
    GetUniverseConstellationsConstellationId: "/universe/constellations/{constellation_id}",
    GetUniverseStationsStationId: "/universe/stations/{station_id}",
  };

  for (const route of router.routes) {
    const specPath = bySpecPath[route.name];
    assert.ok(specPath, `${route.name} has no spec path in this test's table`);

    const carriesText = answersWithText(spec, successSchema(spec, specPath));
    // The gateway never repeats the header, so its routes declare `false` whatever
    // their schema says. Only the application's declaration follows the content,
    // and then only where the content is a string CCP actually translates, which is
    // the second exception and the one the spec cannot express. Both exception
    // lists are read from the survey rather than hardcoded here, so a route added
    // to one is a route this loop stops demanding the schema's answer for.
    const composed = wire.VARY_LOCALIZED_SURVEY.plainDespiteComposedName.includes(specPath);
    const expected = route.producer === "gateway" || composed ? false : carriesText;

    assert.equal(
      route.localizedBody,
      expected,
      `${route.name} declares localizedBody: ${route.localizedBody} on the ${route.producer} `
      + `producer with a body that ${carriesText ? "does" : "does not"} carry translated text `
      + ": the Vary it sends is wrong in one direction or the other",
    );
  }

  // Named outright so that a future change which quietly drops this route is
  // visible.
  const factions = router.routes.find((route) => route.name === "GetUniverseFactions");
  assert.equal(factions.localizedBody, true, "the first route here that really is translated");
});
