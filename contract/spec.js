/**
 * Turn a pinned spec operation into assertions a test can make.
 *
 * Every ESI endpoint starts with a contract test written from CCP's spec,
 * *before* the handler exists: a test written afterwards encodes whatever the
 * handler already does. So this module works with no handler, router or game. It
 * reads `contract/openapi.json` off disk, never opens a socket, and never imports
 * `contract/wire.js` (the two halves of D22 stay apart).
 *
 * The spec is authoritative for:
 *
 *   - which keys a body has, and which of them are required
 *   - the type of each value
 *   - `enum` membership, string lengths, array bounds and uniqueness
 *   - the published cache TTL (`x-cache-age`) and rate-limit group
 *
 * It is not authoritative for anything about the response carrying the body:
 * header names, header casing, the `Vary` lines, the content type, the error
 * strings. Those live in `wire.js`.
 *
 * Nullability: the `2020-01-01` document contains no `nullable`, and no `"null"`
 * in any `type`, anywhere (197 operations, 202 schemas, zero). A `null` in a
 * response body is therefore a contract violation and gets its own message,
 * because "expected integer, got object" sends the reader to the wrong place.
 *
 * Closed world: an undeclared key is a failure, not a tolerance. A replica that
 * returns *more* than CCP is as distinguishable as one that returns less, and
 * clients start depending on the extra field.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SPEC_PATH = path.join(__dirname, "openapi.json");
const PROVENANCE_PATH = path.join(__dirname, "provenance.json");

/**
 * Version prefixes that all resolve to the `2020-01-01` surface (D4).
 *
 * They are a routing dimension, not a spec dimension: the pinned document
 * describes `/status`, and the wire carries `/latest/status/`, `/v1/status/`
 * and so on for the same operation.
 */
const VERSION_PREFIXES = Object.freeze(["latest", "legacy", "dev", "v1", "v2", "v3", "v4", "v5", "v6"]);

const BODY_METHODS = Object.freeze(["get", "put", "post", "delete", "patch", "head", "options"]);

/** A contract question that cannot be answered, as opposed to a failed assertion. */
class SpecContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpecContractError";
  }
}

// Loading

let cachedSpec = null;

/**
 * The pinned document, parsed once.
 *
 * Memoised because a contract test per endpoint means many suites loading the
 * same 867 KB, and `node --test` runs them in the same process per file.
 */
function loadSpec(specPath = SPEC_PATH) {
  if (specPath === SPEC_PATH && cachedSpec) return cachedSpec;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(specPath, "utf8"));
  } catch (err) {
    throw new SpecContractError(
      `the pinned spec at ${specPath} could not be read: ${err.message}. `
        + "Run `node scripts/pin-spec.js` to create it.",
    );
  }

  if (specPath === SPEC_PATH) cachedSpec = parsed;
  return parsed;
}

/** Test seam: forget the memoised document. */
function clearSpecCache() {
  cachedSpec = null;
}

/** The provenance record beside the spec: source, date, hashes. */
function loadProvenance() {
  try {
    return JSON.parse(fs.readFileSync(PROVENANCE_PATH, "utf8"));
  } catch (err) {
    throw new SpecContractError(`the pin provenance could not be read: ${err.message}`);
  }
}

// Locating an operation

/**
 * `/latest/universe/systems/30000142/` -> `/universe/systems/30000142`
 *
 * Strips the version prefix and the trailing slash, both of which are wire
 * conventions the spec does not use.  A path with no recognised prefix is left
 * alone apart from the slash, so `/status/` works too.
 */
function toSpecPath(wirePath) {
  const segments = String(wirePath).split("/").filter(Boolean);
  if (segments.length && VERSION_PREFIXES.includes(segments[0])) segments.shift();
  return "/" + segments.join("/");
}

/** Does a spec path template match a concrete path, segment for segment? */
function templateMatches(template, concrete) {
  const t = template.split("/").filter(Boolean);
  const c = concrete.split("/").filter(Boolean);
  if (t.length !== c.length) return false;
  return t.every((segment, i) => (segment.startsWith("{") && segment.endsWith("}")) || segment === c[i]);
}

/**
 * The spec path template for a wire path, or null.
 *
 * An exact match wins over a templated one, so a literal route can never be
 * shadowed by a parameterised sibling.
 */
function findSpecPath(wirePath, spec = loadSpec()) {
  const wanted = toSpecPath(wirePath);
  const templates = Object.keys(spec.paths);

  if (templates.includes(wanted)) return wanted;
  return templates.find((template) => templateMatches(template, wanted)) || null;
}

// $ref

/** Follow a local `#/components/...` pointer. Only local refs exist in ESI's document. */
function resolveRef(spec, ref) {
  if (!ref.startsWith("#/")) throw new SpecContractError(`unsupported non-local $ref: ${ref}`);

  let node = spec;
  for (const segment of ref.slice(2).split("/")) {
    node = node && node[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
    if (node === undefined) throw new SpecContractError(`$ref does not resolve: ${ref}`);
  }
  return node;
}

/** A schema with its top-level `$ref` followed, if it has one. */
function resolveSchema(spec, schema) {
  let node = schema;
  let hops = 0;
  while (node && node.$ref) {
    if (++hops > 16) throw new SpecContractError(`$ref cycle at ${schema.$ref}`);
    node = resolveRef(spec, node.$ref);
  }
  return node;
}

// Shared parameters

/**
 * One of the spec's `components.parameters` entries, by name.
 *
 * The five shared parameters are the request half of the contract: the headers a
 * client may send (`Accept-Language`, `X-Compatibility-Date`, `X-Tenant`, and the
 * two conditional ones). Every one of the 197 operations references the same
 * definitions, so a rule about them is a rule about the whole surface. For example
 * `Accept-Language`'s enum of eight makes "the language parameter is accepted
 * rather than rejected" a checkable claim (D27).
 *
 * A `$ref` is followed, so the caller gets the parameter itself.
 */
function sharedParameter(name, options = {}) {
  const spec = options.spec || loadSpec(options.specPath);
  const parameters = (spec.components && spec.components.parameters) || {};
  const parameter = parameters[name];

  if (parameter === undefined) {
    throw new SpecContractError(
      `no shared parameter "${name}" in the pinned ${spec.info.version} spec. It has `
        + `${Object.keys(parameters).join(", ")}.`,
    );
  }

  return { ...parameter, schema: resolveSchema(spec, parameter.schema || {}) };
}

/**
 * The operation's own **query** parameters, by name.
 *
 * The five shared parameters are all headers, so this returns what the operation
 * declares for itself. For `POST /ui/autopilot/waypoint` that is the entire
 * request contract: no body, three query parameters.
 *
 * `required` and `default` are both carried because the pinned document sets both
 * on the same parameter: `add_to_beginning` is `required: true` with
 * `default: false`, so a client is told to send it and the document still says
 * what its absence means.
 *
 * `default` is `undefined` when the schema declares none, which tells
 * `destination_id` (required, no default) apart from the two booleans beside it.
 */
function queryParametersOf(spec, operation) {
  const out = {};

  for (const entry of operation.parameters || []) {
    const parameter = entry && entry.$ref ? resolveRef(spec, entry.$ref) : entry;
    if (!parameter || parameter.in !== "query") continue;

    const schema = resolveSchema(spec, parameter.schema || {}) || {};
    out[parameter.name] = Object.freeze({
      name: parameter.name,
      required: parameter.required === true,
      type: schema.type === undefined ? null : schema.type,
      format: schema.format === undefined ? null : schema.format,
      default: Object.prototype.hasOwnProperty.call(schema, "default") ? schema.default : undefined,
    });
  }

  return Object.freeze(out);
}

// The contract descriptor

/**
 * Everything the spec knows about one operation, in the shape a test wants it.
 *
 * `wirePath` is what a client would request: version prefix, trailing slash
 * and concrete ids are all fine.  The returned `schema` is resolved one level:
 * nested `$ref`s are followed lazily during validation, because inlining the
 * whole tree up front would turn a recursive schema into a hang.
 */
function describeOperation(method, wirePath, options = {}) {
  const spec = options.spec || loadSpec(options.specPath);
  const verb = String(method).toLowerCase();

  if (!BODY_METHODS.includes(verb)) throw new SpecContractError(`not an HTTP method: ${method}`);

  const specPath = findSpecPath(wirePath, spec);
  if (!specPath) {
    throw new SpecContractError(
      `no operation in the pinned ${spec.info.version} spec for ${verb.toUpperCase()} ${wirePath} `
        + `(looked for ${toSpecPath(wirePath)}). If the endpoint is real but undocumented (as `
        + "`/ping` is), its contract belongs in contract/wire.js instead.",
    );
  }

  const operation = spec.paths[specPath][verb];
  if (!operation) {
    throw new SpecContractError(
      `${specPath} exists in the pinned spec but has no ${verb.toUpperCase()}: `
        + `it declares ${Object.keys(spec.paths[specPath]).filter((k) => BODY_METHODS.includes(k)).join(", ")}.`,
    );
  }

  const statuses = Object.keys(operation.responses).filter((s) => /^\d+$/.test(s)).map(Number);
  const successStatus = statuses.find((s) => s >= 200 && s < 300);
  const success = successStatus === undefined ? null : operation.responses[String(successStatus)];
  const content = (success && success.content && success.content["application/json"]) || null;
  const schema = content ? resolveSchema(spec, content.schema) : null;

  const rateLimit = operation["x-rate-limit"] || null;

  return {
    spec,
    method: verb,
    specPath,
    wirePath,
    operationId: operation.operationId,
    compatibilityDate: operation["x-compatibility-date"] || spec.info.version,
    // Seconds a client is told to cache for. Clients poll on `Expires`, so an
    // endpoint that publishes the wrong one is an endpoint that gets hammered.
    cacheAgeSeconds: operation["x-cache-age"] ?? null,
    clientCacheTtlSeconds: operation["x-client-cache-ttl"] ?? null,
    serverCacheTtlSeconds: operation["x-server-cache-ttl"] ?? null,
    rateLimit: rateLimit
      ? Object.freeze({
        group: rateLimit.group,
        maxTokens: rateLimit["max-tokens"],
        windowSize: rateLimit["window-size"],
      })
      : null,
    // The operation's own query parameters, by name. See `queryParametersOf`:
    // on an operation with no body this is the whole request contract.
    queryParameters: queryParametersOf(spec, operation),
    scopes: (operation.security || []).flatMap((entry) => Object.values(entry).flat()),
    statuses,
    successStatus: successStatus ?? null,
    schema,
    requiredKeys: schema && schema.type === "object" ? [...(schema.required || [])] : [],
    optionalKeys:
      schema && schema.type === "object"
        ? Object.keys(schema.properties || {}).filter((k) => !(schema.required || []).includes(k))
        : [],
  };
}

// A route table against the spec

/**
 * Assert that a route descriptor's published columns match CCP's spec.
 *
 * `scope`, `rateLimitGroup` and `cacheTtl` are declared in `lib/router.js`'s route
 * table rather than read from the spec at runtime, because `contract/` is
 * test-only and never deployed (D20). This check stops the table drifting: a
 * wrong scope is an authentication bug, and a wrong `cacheTtl` is a client polling
 * in a tight loop against the game's event loop.
 *
 * The route's `:param` form is translated to the spec's `{brace}` form, so the
 * table can stay in the notation the router matches on. A column the route does
 * not declare is not checked.
 */
function assertRouteMatchesSpec(route, options = {}) {
  const wirePath = String(route.path).replace(/:([^/]+)/g, "{$1}");
  const contract = describeOperation(route.method, wirePath, options);
  const problems = [];

  if (route.cacheTtl !== undefined && route.cacheTtl !== contract.cacheAgeSeconds) {
    problems.push(
      `declares cacheTtl ${route.cacheTtl}, and the spec publishes ${contract.cacheAgeSeconds} `
        + "(x-cache-age)",
    );
  }

  if (route.rateLimitGroup !== undefined) {
    const group = contract.rateLimit ? contract.rateLimit.group : null;
    if (route.rateLimitGroup !== group) {
      problems.push(`declares rateLimitGroup ${JSON.stringify(route.rateLimitGroup)}, and the spec publishes ${JSON.stringify(group)}`);
    }
  }

  if (route.scope !== undefined) {
    const required = contract.scopes;
    const declared = route.scope === null ? [] : [route.scope];
    const missing = required.filter((s) => !declared.includes(s));
    const extra = declared.filter((s) => !required.includes(s));
    if (missing.length || extra.length) {
      problems.push(
        `declares scope ${JSON.stringify(route.scope)}, and the spec requires ${JSON.stringify(required)}`,
      );
    }
  }

  // The status a successful dispatch carries. `undefined` is a route that never
  // declared one, which `lib/router.js` reads as `200`, so the check compares the
  // *effective* value. Otherwise a route omitting the column on an operation CCP
  // answers `204` would pass.
  //
  // `POST /ui/autopilot/waypoint/` answers `204`. The spec publishes this per
  // operation; a handler is not where it gets decided.
  if (route.successStatus !== undefined && contract.successStatus !== null) {
    const declared = route.successStatus === null ? 200 : route.successStatus;
    if (declared !== contract.successStatus) {
      problems.push(
        `declares successStatus ${declared}, and the spec publishes ${contract.successStatus}`,
      );
    }
  }

  if (problems.length) {
    throw new SpecContractError(
      `${route.method.toUpperCase()} ${route.path} (${contract.operationId}) `
        + `disagrees with the pinned ${contract.compatibilityDate} spec:\n  - `
        + problems.join("\n  - "),
    );
  }

  return contract;
}

// Body validation

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, type) {
  switch (type) {
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    default: return true;
  }
}

/**
 * Every way `value` fails `schema`, as human-readable lines.
 *
 * Collects rather than throws on the first problem, so one failing assertion
 * names every wrong field at once. `where` is a JSON-pointer-like trail
 * (`body.locations[3].system_id`), because "expected integer, got string" with
 * no location costs more time than it saves.
 */
function findBodyProblems(value, schema, spec, where = "body") {
  const resolved = resolveSchema(spec, schema);
  if (!resolved) return [];

  const problems = [];

  if (value === null) {
    // Worth its own message: the pinned surface declares no nullable field
    // anywhere, so this is never "a null where null was allowed".
    problems.push(`${where} is null, and the ${spec.info.version} spec declares no nullable fields`);
    return problems;
  }

  const types = resolved.type === undefined ? [] : [].concat(resolved.type);
  if (types.length && !types.some((t) => matchesType(value, t))) {
    problems.push(`${where}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
    return problems; // Nothing below this can say anything useful about the wrong type.
  }

  if (resolved.enum && !resolved.enum.includes(value)) {
    problems.push(`${where}: ${JSON.stringify(value)} is not one of ${JSON.stringify(resolved.enum)}`);
  }

  if (typeof value === "string") {
    if (resolved.format === "date-time" && !DATE_TIME.test(value)) {
      problems.push(`${where}: ${JSON.stringify(value)} is not an ESI timestamp (YYYY-MM-DDTHH:MM:SSZ)`);
    }
    if (resolved.minLength !== undefined && value.length < resolved.minLength) {
      problems.push(`${where}: shorter than minLength ${resolved.minLength}`);
    }
    if (resolved.maxLength !== undefined && value.length > resolved.maxLength) {
      problems.push(`${where}: longer than maxLength ${resolved.maxLength}`);
    }
  }

  if (Array.isArray(value)) {
    if (resolved.minItems !== undefined && value.length < resolved.minItems) {
      problems.push(`${where}: ${value.length} items, minItems is ${resolved.minItems}`);
    }
    if (resolved.maxItems !== undefined && value.length > resolved.maxItems) {
      problems.push(`${where}: ${value.length} items, maxItems is ${resolved.maxItems}`);
    }
    if (resolved.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      problems.push(`${where}: uniqueItems is set, and there are duplicates`);
    }
    if (resolved.items) {
      value.forEach((item, i) => problems.push(...findBodyProblems(item, resolved.items, spec, `${where}[${i}]`)));
    }
    return problems;
  }

  // `required` without `properties` is legal OpenAPI and means "these keys, of
  // unstated shape". Keying the whole block on `properties` would skip the required
  // check for such a schema, the one assertion it still supports.
  if (typeOf(value) === "object" && (resolved.properties || resolved.required)) {
    for (const key of resolved.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        problems.push(`${where}.${key} is required by the spec and is missing`);
      }
    }
    for (const key of Object.keys(value)) {
      if (!resolved.properties) continue;
      if (!Object.prototype.hasOwnProperty.call(resolved.properties, key)) {
        problems.push(`${where}.${key} is not in the spec: a field CCP does not send is as visible as one it does`);
        continue;
      }
      problems.push(...findBodyProblems(value[key], resolved.properties[key], spec, `${where}.${key}`));
    }
  }

  return problems;
}

/**
 * Assert a response body against an operation's success schema.
 *
 * Throws `SpecContractError` naming every problem, so a `node:test` assertion
 * reports one failure with all of them.
 */
function assertBody(body, contract) {
  if (!contract || !contract.schema) {
    throw new SpecContractError(
      `${(contract && contract.operationId) || "the operation"} declares no JSON success body in the pinned spec`,
    );
  }

  const problems = findBodyProblems(body, contract.schema, contract.spec);
  if (problems.length) {
    throw new SpecContractError(
      `${contract.operationId} (${contract.method.toUpperCase()} ${contract.specPath}) `
        + `does not satisfy the ${contract.compatibilityDate} contract:\n  - `
        + problems.join("\n  - "),
    );
  }
}

module.exports = {
  BODY_METHODS,
  PROVENANCE_PATH,
  SPEC_PATH,
  SpecContractError,
  VERSION_PREFIXES,
  assertBody,
  assertRouteMatchesSpec,
  clearSpecCache,
  describeOperation,
  findBodyProblems,
  findSpecPath,
  loadProvenance,
  loadSpec,
  resolveRef,
  resolveSchema,
  sharedParameter,
  toSpecPath,
};
