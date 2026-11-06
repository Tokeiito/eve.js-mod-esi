/**
 * eve.js-mod-esi: the authenticated-route capture
 *
 * Run with:  node scripts/observe-authed.js --client-id <your EVE app's client id>
 *            node scripts/observe-authed.js --client-id ... --reveal role,state
 *
 * The contacts, roles-and-structures, fleets and autopilot-waypoint routes each
 * need wire facts nobody has recorded, and a handler is not written against a
 * guessed one. This one run answers all of them with a single consent screen
 * and a single comparable transcript.
 *
 * First question: `producer`. Every route declares which of ESI's two
 * implementations answers it, and `lib/router.js` `assertScope` turns a wrong
 * guess into a boot failure: an authenticated route on the gateway producer has
 * never been observed, so the table refuses to compile one. Ten operations here
 * have no recorded producer. It is not derivable from a sibling path:
 * `GET /characters/{id}/` is the gateway while `/characters/{id}/online/`
 * directly beneath it is the application (`routes/characters.js`). The evidence
 * is `content-type`, the trailing newline, `x-content-type-options` and whether
 * an `X-Esi-Request-Id` came back, never the JSON.
 *
 * What else it settles:
 *
 *   Contacts   Field order on all three contact buckets. Whether `X-Pages` is
 *              sent on a one-page authenticated collection. What a page past
 *              the end answers when the route is authenticated rather than
 *              public.
 *
 *   Structures Whether `/latest/universe/structures/{id}/` and the `/v2/`
 *              spelling are one operation on the wire, as the pinned spec says.
 *              What an ACL refusal looks like on a structure you cannot see.
 *              Whether `profile_id` and `state` are present, since the spec
 *              marks both required.
 *
 *   Fleets     The 404 for a pilot who is not in a fleet. A downstream client
 *              reads it as "not in a fleet", so the replica must answer it byte
 *              for byte. It needs one account and no fleet.
 *
 *   Waypoint   The headers on a bare `204`, and what a bad `destination_id`
 *              answers. Both behind `--write`; see below.
 *
 *   D35        What a scoped route keyed by an entity tells a caller with no
 *              claim on it. The corporation case is settled:
 *              `403 {"error":"Character is not in the corporation"}`. The
 *              decision refuses to extrapolate it, because that string names the
 *              relationship rather than the permission. `--other-alliance` and
 *              `--other-fleet` are the two probes that would close the rest. The
 *              fleet one has a caveat: `/characters/{id}/fleet/` answers `404`
 *              for a pilot in no fleet, so on that family CCP chooses absence
 *              over refusal, and a `404` from `/fleets/{id}/members/` is
 *              consistent with both "you are not in it" and "there is no such
 *              fleet". A guessed fleet id records nothing; it must be a fleet
 *              that existed.
 *
 * It does not print your data. Every body is reduced to its shape (key order,
 * JSON types, array length, which optional fields were present) and the values
 * are dropped before anything reaches the terminal. `contract/` holds the
 * protocol and nobody's character data, and a transcript naming your standings
 * or your corporation's structures cannot be pasted into an issue. Field order
 * is bytes and is recorded. `--reveal <fields>` opts a named field back in, for
 * those that are protocol constants rather than data (`contact_type`, `role`,
 * `state`); it is a per-field decision, never a default.
 *
 * The token is held in memory, used, and forgotten. It is never written to disk
 * or printed, not even truncated, as in `scripts/observe-403.js`.
 *
 * `POST /ui/autopilot/waypoint/` is a write. It sets the autopilot route of the
 * character you authorise, in the real game, immediately. It is the only probe
 * that does anything except read, so it is behind `--write` and off by default,
 * and the destination defaults to a well-known hub so the effect is obvious and
 * harmless. Clear your route in-game afterwards. Everything else is a `GET`.
 *
 * The probes use `node:https` and print `rawHeaders` in wire order with
 * duplicates intact, as `scripts/observe-403.js` does, because `fetch` folds
 * repeated header fields (three `Vary` lines folded into one change the bytes a
 * cache keys on; see `contract/wire.js`).
 *
 * The PKCE round trip below is `observe-403.js`'s, near enough. The duplication
 * is deliberate: one file with no dependencies suits a tool an operator runs by
 * hand, and two self-contained scripts beat a script plus a module that must be
 * deployed alongside it. If a further capture needs the same flow, extract
 * `scripts/lib/ssoProbe.js` and rewrite all of them.
 */

"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { URL, URLSearchParams } = require("node:url");


const SSO_BASE = "https://login.eveonline.com";
const ESI_BASE = "https://esi.evetech.net";

const DEFAULT_CALLBACK = "http://localhost:8779/callback";

/**
 * Every scope the routes under capture need, requested in one consent.
 *
 * Asking for all of them at once is what makes this a single run. A narrow set
 * is `observe-403.js`'s concern, since that script needs a scope it does not
 * hold. This one captures successes, so a missing scope is a hole in the
 * transcript.
 */
const SCOPES = Object.freeze([
  "esi-characters.read_contacts.v1",
  "esi-corporations.read_contacts.v1",
  "esi-alliances.read_contacts.v1",
  "esi-characters.read_corporation_roles.v1",
  "esi-corporations.read_structures.v1",
  "esi-universe.read_structures.v1",
  "esi-fleets.read_fleet.v1",
  "esi-ui.write_waypoint.v1",
]);

/**
 * Jita, a deliberate default rather than a placeholder.
 *
 * The `--write` probe sets an autopilot route, so the default destination is
 * somewhere every pilot recognises on sight: an unexplained route to an unknown
 * system is alarming in a way that a route to the main trade hub is not.
 * Override with `--destination`.
 */
const DEFAULT_DESTINATION = 30000142;

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** A page number past the end of any real collection, for the refusal probe. */
const PAGE_BEYOND_END = 9999;

/**
 * Fields whose values are protocol and are always printed.
 *
 * `contract/wire.js` records error bodies verbatim, because the literal
 * `Character ID mismatch between request path and auth token` is the contract a
 * client depends on. A redactor that reports `{"error": "string"}` has recorded
 * that an error happened and discarded what it said. The first live run did
 * exactly that to the `404` for a pilot in no fleet.
 *
 * `error` is safe to print for the same reason it is safe to record: these
 * strings are CCP's, fixed per condition, and carry nothing about the caller.
 * The one family that echoes anything echoes the request's own malformed input,
 * which the operator typed.
 *
 * Anything not on this list still needs `--reveal`.
 */
const ALWAYS_REVEALED = Object.freeze(["error"]);


const USAGE = `
eve.js-mod-esi: the authenticated capture

  node scripts/observe-authed.js --client-id <id> [options]

Required:
  --client-id <id>          A PKCE public client registered at
                            developers.eveonline.com, with the callback below
                            and the eight scopes this script requests.

Options:
  --callback <url>          OAuth redirect. Default ${DEFAULT_CALLBACK}
  --other-corporation <id>  A corporation you are NOT in. Captures the refusal
                            for reading another corp's contacts (D35).
                            No default: it names a real corporation, so it is
                            yours to choose rather than this file's to carry.
  --other-alliance <id>     An alliance you are NOT in. Captures the refusal for
                            reading another alliance's contacts (D35). No
                            default, same reason as --other-corporation.
  --other-fleet <id>        A fleet you are NOT a member of (D35). Read the
                            caveat below: an id that does not exist answers a
                            different question than one that does.
  --other-structure <id>    A structure you have no ACL access to. Captures the
                            403/404 on /universe/structures/ (D35). No default,
                            same reason.
  --reveal <a,b,c>          Print the values of these fields. For protocol
                            constants only: contact_type, role, state. Every
                            other value is dropped before it reaches stdout.
  --write                   Enable the ONE probe that mutates: it sets the
                            autopilot route of the character you authorise,
                            in the live game, immediately (D34). Off by default.
  --destination <id>        Where --write sets the route. Default ${DEFAULT_DESTINATION} (Jita).
  --help                    This.

Nothing is written to disk. The token is never printed.
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    clientId: null,
    callback: DEFAULT_CALLBACK,
    otherCorporation: null,
    otherStructure: null,
    otherAlliance: null,
    otherFleet: null,
    reveal: new Set(ALWAYS_REVEALED),
    write: false,
    destination: DEFAULT_DESTINATION,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];

    switch (flag) {
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "--client-id":
        args.clientId = value;
        i += 1;
        break;
      case "--callback":
        args.callback = value;
        i += 1;
        break;
      case "--other-corporation":
        args.otherCorporation = Number(value);
        i += 1;
        break;
      case "--other-alliance":
        args.otherAlliance = Number(value);
        i += 1;
        break;
      case "--other-fleet":
        args.otherFleet = Number(value);
        i += 1;
        break;
      case "--other-structure":
        args.otherStructure = Number(value);
        i += 1;
        break;
      case "--reveal":
        String(value || "").split(",").map((s) => s.trim()).filter(Boolean)
          .forEach((field) => args.reveal.add(field));
        i += 1;
        break;
      case "--write":
        args.write = true;
        break;
      case "--destination":
        args.destination = Number(value);
        i += 1;
        break;
      default:
        fail(`Unknown argument ${JSON.stringify(flag)}.\n${USAGE}`);
    }
  }

  if (!args.clientId) fail(`--client-id is required.\n${USAGE}`);
  return args;
}


function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, state: base64url(crypto.randomBytes(16)) };
}


/**
 * A one-shot local listener for CCP's redirect.
 *
 * Resolves with the authorization code and closes. The `state` check is the
 * CSRF guard RFC 6749 asks for; a mismatch is a hard failure, because the only
 * way to get one on a loopback listener is that something other than the flow
 * this process started sent the request.
 */
function awaitCallback(callbackUrl, expectedState) {
  const url = new URL(callbackUrl);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`No callback within ${CALLBACK_TIMEOUT_MS / 1000}s.`));
    }, CALLBACK_TIMEOUT_MS);

    const server = http.createServer((req, res) => {
      const incoming = new URL(req.url, `http://${req.headers.host}`);
      if (incoming.pathname !== url.pathname) {
        res.writeHead(404).end("not the callback path");
        return;
      }

      const code = incoming.searchParams.get("code");
      const state = incoming.searchParams.get("state");
      const error = incoming.searchParams.get("error");

      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(error ? `Authorization failed: ${error}` : "Captured. You can close this tab.");

      clearTimeout(timer);
      server.close();

      if (error) reject(new Error(`CCP refused authorization: ${error}`));
      else if (state !== expectedState) reject(new Error("state mismatch: refusing the code."));
      else if (!code) reject(new Error("callback carried no code."));
      else resolve(code);
    });

    server.listen(Number(url.port) || 80, url.hostname);
  });
}

/** `POST` a form and parse the JSON back. Used only against the SSO host. */
function postForm(url, form) {
  const target = new URL(url);
  const payload = new URLSearchParams(form).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: target.hostname,
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(new Error(`token endpoint answered ${res.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`token endpoint sent unparseable JSON: ${err.message}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function exchange({ code, clientId, verifier, callback }) {
  const token = await postForm(`${SSO_BASE}/v2/oauth/token`, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    code_verifier: verifier,
    redirect_uri: callback,
  });

  if (typeof token.access_token !== "string") {
    throw new Error("token response carried no access_token.");
  }
  return token.access_token;
}

/**
 * The claims, read without verifying.
 *
 * This is not a validation: the script is not a resource server and the token
 * came straight from the exchange above over TLS. It needs two things from it:
 * who the caller is, so probes can be aimed, and which scopes were granted, so
 * a missing one is reported as a gap in the transcript rather than a mystery
 * 401 later.
 */
function readClaims(token) {
  const [, payload] = token.split(".");
  if (!payload) throw new Error("access token is not a JWT.");

  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const subject = String(claims.sub || "");
  const characterId = Number(subject.replace(/^CHARACTER:EVE:/, ""));

  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new Error(`could not read a character id from sub ${JSON.stringify(subject)}.`);
  }

  const scopes = Array.isArray(claims.scp) ? claims.scp : String(claims.scp || "").split(" ");
  return { characterId, scopes: scopes.filter(Boolean) };
}


/**
 * One request, with the response kept as bytes.
 *
 * `rawHeaders` rather than `headers`, for the folding reason in the file
 * header. The body stays a `Buffer` until something asks for it: the
 * trailing-newline question is a byte question, and `JSON.parse` would discard
 * the evidence.
 */
function probe(method, path, token, { body = null } = {}) {
  const target = new URL(path, ESI_BASE);

  return new Promise((resolve, reject) => {
    const headers = {
      host: target.hostname,
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "user-agent": "eve.js-mod-esi observe-authed (contact via the repository)",
    };
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }

    const req = https.request(
      { hostname: target.hostname, path: `${target.pathname}${target.search}`, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          rawHeaders: res.rawHeaders.slice(),
          body: Buffer.concat(chunks),
        }));
      },
    );
    req.on("error", reject);
    req.end(body === null ? undefined : body);
  });
}


/**
 * A body reduced to its shape, with the values dropped.
 *
 * This is what makes the transcript safe to paste into an issue. It is a
 * whitelist: nothing is printed unless this function decided to print it. A
 * redactor that strips known-bad fields leaks the field somebody adds next.
 *
 * What survives:
 *
 *   - key order, which is bytes and is the point of the capture
 *   - the JSON type of each value
 *   - array length, and whether every element agrees on key order
 *   - for an optional field, whether it was present, which shows that ESI omits
 *     rather than nulls
 *
 * What does not: every scalar, except a field named in `--reveal`.
 *
 * Array elements are compared rather than concatenated. "All 47 elements have
 * this key order" is a protocol fact; 47 copies of it is a haystack, and one
 * element that disagrees would be lost in the middle of it.
 */
function shapeOf(value, reveal, depth = 0) {
  if (depth > 6) return "…";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return { array: 0, of: null };
    const shapes = value.map((element) => JSON.stringify(shapeOf(element, reveal, depth + 1)));
    const distinct = [...new Set(shapes)];
    // Every distinct shape, not the first one and a count. That the shapes disagree is a hint; how they disagree is the
    // observation, and an optional field omitted on some rows and present on others
    // is invisible if the odd row is the one dropped.
    return {
      array: value.length,
      of: JSON.parse(distinct[0]),
      ...(distinct.length > 1
        ? {
          WARNING: `${distinct.length} distinct element shapes`,
          // Counted, because "one row in 18" and "nine rows in 18" are different findings
          // about the same disagreement.
          shapes: distinct.map((shape) => ({
            count: shapes.filter((candidate) => candidate === shape).length,
            shape: JSON.parse(shape),
          })),
        }
        : {}),
    };
  }
  if (typeof value === "object") {
    const shape = {};
    // `Object.keys` preserves insertion order for string keys, and insertion order
    // here is the order the bytes arrived in, which is the fact being captured.
    // Nothing sorts this.
    for (const key of Object.keys(value)) {
      shape[key] = reveal.has(key) ? value[key] : shapeOf(value[key], reveal, depth + 1);
    }
    return shape;
  }
  return typeof value;
}

/** The header lines, in wire order, duplicates intact. */
function headerLines(rawHeaders) {
  const lines = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    lines.push(`    ${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  }
  return lines;
}

/**
 * The producer verdict, from the evidence rather than from the JSON.
 *
 * `contract/wire.js` `SUCCESS_KIND` is the recording this feeds. The four
 * signals are the ones that split the two implementations, and they are
 * reported separately rather than collapsed into a guess: if they ever
 * disagree, that disagreement is the finding.
 */
function producerEvidence(rawHeaders, body) {
  const lower = {};
  for (let i = 0; i < rawHeaders.length; i += 2) lower[rawHeaders[i].toLowerCase()] = rawHeaders[i + 1];

  return {
    contentType: lower["content-type"] || null,
    trailingNewline: body.length > 0 && body[body.length - 1] === 0x0a,
    xContentTypeOptions: lower["x-content-type-options"] || null,
    xEsiRequestId: lower["x-esi-request-id"] ? "present" : "absent",
    contentLength: lower["content-length"] || String(body.length),
    xPages: lower["x-pages"] === undefined ? "absent" : lower["x-pages"],
  };
}

function render(label, question, method, path, result, reveal) {
  const out = [];
  out.push("");
  out.push(`-- ${label} ${"-".repeat(Math.max(0, 60 - label.length))}`);
  out.push(`  ${question}`);
  out.push(`  ${method} ${path}`);
  out.push(`  -> ${result.status}`);
  out.push("");
  out.push("  Headers, in wire order:");
  out.push(...headerLines(result.rawHeaders));
  out.push("");
  out.push(`  Producer evidence: ${JSON.stringify(producerEvidence(result.rawHeaders, result.body), null, 2).split("\n").join("\n  ")}`);

  let parsed = null;
  try {
    parsed = result.body.length === 0 ? null : JSON.parse(result.body.toString("utf8"));
  } catch (err) {
    out.push(`  Body did not parse as JSON (${err.message}); ${result.body.length} bytes.`);
  }

  if (result.body.length === 0) {
    out.push("  Body: empty, 0 bytes.");
  } else if (parsed !== null) {
    out.push("  Body shape (values dropped, see the header on redaction):");
    out.push(`  ${JSON.stringify(shapeOf(parsed, reveal), null, 2).split("\n").join("\n  ")}`);
  }

  return out.join("\n");
}


/**
 * Everything this run asks, in the order it has to ask it.
 *
 * The order is a dependency chain: the corporation and alliance ids come out of
 * the public character read, the structure id out of the corporation's
 * structure list, and the fleet id, if there is one, out of the character's
 * fleet read.
 */
async function run(token, claims, args) {
  const { reveal } = args;
  const say = (text) => process.stdout.write(`${text}\n`);
  const me = claims.characterId;

  const missing = SCOPES.filter((scope) => !claims.scopes.includes(scope));
  if (missing.length > 0) {
    say("");
    say(`  !! The token is missing ${missing.length} of the requested scopes:`);
    missing.forEach((scope) => say(`     ${scope}`));
    say("     Those probes will 401 and the transcript will have holes in it.");
  }

  // The public read that the rest depends on. A downstream client learns a
  // pilot's corporation and alliance from exactly this call.
  const identity = await probe("GET", `/v4/characters/${me}/`, token);
  say(render(
    "identity",
    "Which corporation and alliance is the caller in, and what shape is the answer?",
    "GET", `/v4/characters/{me}/`, identity, reveal,
  ));

  let corporationId = null;
  let allianceId = null;
  try {
    const parsed = JSON.parse(identity.body.toString("utf8"));
    corporationId = parsed.corporation_id ?? null;
    allianceId = parsed.alliance_id ?? null;
  } catch { /* reported by the render above; the probes below will say "skipped" */ }

  say("");
  say(`  Resolved: corporation ${corporationId === null ? "NOT FOUND" : "ok"}, `
    + `alliance ${allianceId === null ? "none (the character is in no alliance)" : "ok"}.`);
  say("  The ids themselves are not printed: they name real entities. See the redaction note.");

  // Contacts

  say("\n\n--- contacts ---");

  say(render(
    "contacts · character",
    "Field order, and is X-Pages sent on a one-page authenticated collection?",
    "GET", "/v2/characters/{me}/contacts/",
    await probe("GET", `/v2/characters/${me}/contacts/`, token), reveal,
  ));

  if (corporationId !== null) {
    say(render(
      "contacts · corporation",
      "Same three questions, and does the corporation bucket agree on field order?",
      "GET", "/v2/corporations/{corp}/contacts/",
      await probe("GET", `/v2/corporations/${corporationId}/contacts/`, token), reveal,
    ));
  }

  if (allianceId !== null) {
    say(render(
      "contacts · alliance",
      "And does the alliance bucket omit is_watched, as the pinned spec says it does?",
      "GET", "/v2/alliances/{alliance}/contacts/",
      await probe("GET", `/v2/alliances/${allianceId}/contacts/`, token), reveal,
    ));
  } else {
    say("\n  contacts · alliance: SKIPPED, this character is in no alliance.");
    say("  Re-run with a character who is, or this row stays open.");
  }

  say(render(
    "contacts · page past the end",
    "What does an authenticated paginated route answer for a page that does not exist? "
      + "The public one is recorded; nothing says the authenticated one matches.",
    "GET", `/v2/characters/{me}/contacts/?page=${PAGE_BEYOND_END}`,
    await probe("GET", `/v2/characters/${me}/contacts/?page=${PAGE_BEYOND_END}`, token), reveal,
  ));

  if (args.otherCorporation !== null) {
    say(render(
      "contacts · another corporation (REFUSAL)",
      "The one that decides what lib/router.js's subject check should return. "
        + "A scope-holding token asking for a corporation it is not in.",
      "GET", "/v2/corporations/{other}/contacts/",
      await probe("GET", `/v2/corporations/${args.otherCorporation}/contacts/`, token), reveal,
    ));
  } else {
  if (args.otherAlliance !== null) {
    say(render(
      "contacts · another alliance (REFUSAL)",
      "D35's second entity kind. The corporation refusal names the *relationship* ( "
        + "'Character is not in the corporation'), so it is corporation-shaped and cannot be "
        + "reused here by swapping the noun. This is the probe that says what the alliance "
        + "sentence actually is, and whether it is even a 403.",
      "GET", "/v2/alliances/{other}/contacts/",
      await probe("GET", `/v2/alliances/${args.otherAlliance}/contacts/`, token), reveal,
    ));
  } else {
    say("\n  contacts · another alliance: SKIPPED, pass --other-alliance.");
    say("  Without it D35's alliance row stays open and routes/ keeps throwing for that case.");
  }

    say("\n  contacts · another corporation: SKIPPED, pass --other-corporation.");
    say("  Without it, this refusal stays unobserved and its subject check stays a throw.");
  }

  // Roles and structures

  say("\n\n--- roles and structures ---");

  say(render(
    "roles",
    "Which of the four role arrays are present, and is an empty one omitted or sent empty?",
    "GET", "/latest/characters/{me}/roles/",
    await probe("GET", `/latest/characters/${me}/roles/`, token), reveal,
  ));

  let structureId = null;
  if (corporationId !== null) {
    const structures = await probe("GET", `/latest/corporations/${corporationId}/structures/`, token);
    say(render(
      "corporation structures",
      "Are profile_id and state really present? The spec marks both required.",
      "GET", "/latest/corporations/{corp}/structures/", structures, reveal,
    ));
    try {
      const parsed = JSON.parse(structures.body.toString("utf8"));
      if (Array.isArray(parsed) && parsed.length > 0) structureId = parsed[0].structure_id ?? null;
    } catch { /* the render above already reported it */ }
  }

  if (structureId !== null) {
    const underLatest = await probe("GET", `/latest/universe/structures/${structureId}/`, token);
    const underV2 = await probe("GET", `/v2/universe/structures/${structureId}/`, token);

    say(render(
      "universe structure · /latest/",
      "The pinned spec says /latest/ and /v2/ are one operation. Does the wire agree?",
      "GET", "/latest/universe/structures/{structure}/", underLatest, reveal,
    ));
    say(render(
      "universe structure · /v2/",
      "Same structure, other prefix. Any difference here means two route descriptors, not one.",
      "GET", "/v2/universe/structures/{structure}/", underV2, reveal,
    ));

    const sameStatus = underLatest.status === underV2.status;
    const sameBytes = underLatest.body.equals(underV2.body);
    say("");
    say(`  VERDICT: /latest/ and /v2/ ${sameStatus && sameBytes ? "agree byte for byte" : "DIFFER"}`
      + ` (status ${sameStatus ? "same" : "different"}, body ${sameBytes ? "identical" : "DIFFERENT"}).`);
  } else {
    say("\n  universe structure: SKIPPED, no structure id came out of the corporation read.");
    say("  Either the corporation owns none, or the roles gate refused. Both are findings; neither is this row.");
  }

  if (args.otherStructure !== null) {
    say(render(
      "universe structure · no ACL access (REFUSAL)",
      "A 403 and a 404 are both expected here and tolerated. Which is it, and what are the bytes?",
      "GET", "/latest/universe/structures/{other}/",
      await probe("GET", `/latest/universe/structures/${args.otherStructure}/`, token), reveal,
    ));
  } else {
    say("\n  universe structure · no ACL access: SKIPPED, pass --other-structure.");
  }

  // Fleets

  say("\n\n--- fleets ---");

  const fleet = await probe("GET", `/latest/characters/${me}/fleet/`, token);
  say(render(
    "fleet",
    "THE load-bearing one: if this character is in no fleet, these are the 404 bytes eve-nexum "
      + "reads as 'not in a fleet' and the replica has to reproduce exactly.",
    "GET", "/latest/characters/{me}/fleet/", fleet, reveal,
  ));

  if (fleet.status === 404) {
    say("");
    say("  404 captured: this is the row the fleet route waits on. Record it in contract/wire.js.");
  } else if (fleet.status === 200) {
    say("");
    say("  200: this character IS in a fleet, so the 'not in a fleet' 404 is still unobserved.");
    say("  Leave the fleet and re-run to capture it: it is the more important of the two.");
  }

  let fleetId = null;
  try {
    if (fleet.status === 200) fleetId = JSON.parse(fleet.body.toString("utf8")).fleet_id ?? null;
  } catch { /* rendered above */ }

  if (fleetId !== null) {
    say(render(
      "fleet members",
      "The full required field list. "
        + "Note whether role_name is present: the spec marks it required and eve.js has no source for it.",
      "GET", "/latest/fleets/{fleet}/members/",
      await probe("GET", `/latest/fleets/${fleetId}/members/`, token), reveal,
    ));
  } else {
  if (args.otherFleet !== null) {
    const refused = await probe("GET", `/latest/fleets/${args.otherFleet}/members/`, token);
    say(render(
      "fleet members · not a member (REFUSAL)",
      "D35's third entity kind, and the one where the *status* is in doubt rather than only the "
        + "wording: /characters/{id}/fleet/ answers 404 for a pilot in no fleet, so CCP already "
        + "chooses absence over refusal on this family. A 404 here would be hiding the fleet; a "
        + "403 would be confirming it exists.",
      "GET", "/latest/fleets/{other}/members/", refused, reveal,
    ));

    // The caveat that decides whether the row above is usable at all.
    say("");
    if (refused.status === 404) {
      say("  404, and this is the answer that CANNOT be read on its own. A fleet you are not in");
      say("  and a fleet that does not exist are two different questions, and a 404 is a plausible");
      say("  answer to both. This row only settles D35's fleet case if --other-fleet named a fleet");
      say("  that really existed at the moment of the request, which needs a second account or a");
      say("  friend in a fleet. If the id was a guess, record nothing from it.");
    } else {
      say(`  ${refused.status}, not a 404, so this distinguishes itself from "no such fleet"`);
      say("  and settles D35's fleet row, provided the fleet existed.");
    }
  } else {
    say("\n  fleet members · not a member: SKIPPED, pass --other-fleet.");
    say("  Note it needs a fleet that actually exists and that you are not in (see D35).");
  }

    say("\n  fleet members: SKIPPED, not in a fleet, so there is no roster to read.");
    say("  This row needs a second run from inside a fleet. It is the lower priority of the two.");
  }

  // Waypoint write

  say("\n\n--- the waypoint write ---");

  if (!args.write) {
    say("\n  SKIPPED: this probe mutates. Pass --write to enable it.");
    say("  It sets the autopilot route of the character you authorised, in the live game.");
    say("  Without it, the waypoint's 204 headers and its bad-destination answer stay unobserved.");
    return;
  }

  const waypoint = `/latest/ui/autopilot/waypoint/?add_to_beginning=false`
    + `&clear_other_waypoints=true&destination_id=${args.destination}`;

  say(render(
    "waypoint (WRITE: your route just changed)",
    "What headers does a bare 204 carry? Note there is no body to shape.",
    "POST", waypoint, await probe("POST", waypoint, token), reveal,
  ));

  const bad = `/latest/ui/autopilot/waypoint/?add_to_beginning=false`
    + `&clear_other_waypoints=true&destination_id=1`;

  say(render(
    "waypoint · bad destination",
    "The pinned spec is silent on this. Does ESI validate the id, and if so with what?",
    "POST", bad, await probe("POST", bad, token), reveal,
  ));

  say("");
  say("  Your in-game autopilot route was changed by the first of those two. Clear it when convenient.");
}


async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { verifier, challenge, state } = pkce();

  const authorize = new URL(`${SSO_BASE}/v2/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    redirect_uri: args.callback,
    client_id: args.clientId,
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  process.stdout.write("\nOpen this, authorise, and come back:\n\n");
  process.stdout.write(`${authorize.toString()}\n\n`);
  if (args.write) {
    process.stdout.write("  --write is ON. One probe will set your character's autopilot route.\n\n");
  }

  const code = await awaitCallback(args.callback, state);
  const token = await exchange({ code, clientId: args.clientId, verifier, callback: args.callback });
  const claims = readClaims(token);

  process.stdout.write(`\nAuthorised. ${claims.scopes.length} scopes granted.\n`);
  process.stdout.write("The token is in memory only and is never printed or written to disk.\n");

  await run(token, claims, args);

  process.stdout.write("\n\nDone. Every value above is a shape, not your data. See the redaction note in this file.\n");
}

if (require.main === module) {
  main().catch((err) => fail(`\nobserve-authed failed: ${err.message}`));
}

// Exported for `test/observeAuthed.test.js`. `shapeOf` decides what leaves this
// process, and a redactor nobody tests leaks the first time somebody adds a
// field to it. The rest are exported because they are pure and cheap to pin.
module.exports = Object.freeze({
  DEFAULT_DESTINATION,
  PAGE_BEYOND_END,
  SCOPES,
  headerLines,
  main,
  parseArgs,
  producerEvidence,
  shapeOf,
});
