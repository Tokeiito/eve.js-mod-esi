/**
 * eve.js-mod-esi: the two requests that settle the scope-refusal `403` (D31)
 *
 * Run with:  node scripts/observe-403.js --client-id <your EVE app's client id>
 *            node scripts/observe-403.js --client-id ... --callback http://localhost:8779/callback
 *
 * The `401` half of the scope-refusal behaviour shipped first and the `403` half
 * waited, because a scope refusal had never been observed and `contract/wire.js`
 * holds no value nobody has seen. This script makes the observation repeatable.
 * It answers two questions:
 *
 *   A. What does ESI send when a verified token lacks the scope a route
 *      requires?
 *   B. What does it send when a token for character A asks for character B's
 *      data on a route whose scope it does hold?
 *
 * Nothing observed says they share a body (D31), so the script refuses to
 * finish having captured only the first.
 *
 * A `403` needs a token that verifies and then fails to authorise, so it needs
 * a real token: an application registered at developers.eveonline.com and an
 * EVE account to sit at CCP's consent screen. It needs no client secret and no
 * database. The flow is PKCE (RFC 7636), so a public client with an id and no
 * secret is the whole credential, and the script is one file with no
 * dependencies. Register the app as a native/desktop client, set its callback
 * to match `--callback`, and give it a narrow scope set: probe A needs a route
 * the token cannot reach. The operator's part is one browser click.
 *
 * The token is held in memory, used twice, and forgotten. It is never written
 * to disk, printed, or logged, not even truncated. What is printed is the
 * character id and the granted scope list, because both are needed to read the
 * transcript and neither is a credential. The token is minted by CCP against a
 * real account, so treat the terminal scrollback accordingly.
 *
 * The probes use `node:https` and print `rawHeaders` in wire order, duplicates
 * intact, rather than `fetch`, which folds repeated header fields into one
 * comma-joined value. `contract/wire.js` (`VARY`) warns against folding three
 * `Vary` lines into one, "which changes the bytes a cache keys on".
 *
 * It has been run once, on 2026-08-24, and D31 is answered: `contract/wire.js`
 * `SCOPE_REFUSAL` and `CHARACTER_MISMATCH` are what it produced. A missing scope
 * is a `401` naming the scope, not a `403`, and the `403` that does exist
 * belongs to a character mismatch and is the application's refusal rather than
 * the gateway's. The script is kept so that anyone doubting one of those rows
 * can re-run it. One row is still open: the `403` was seen on a `LEGACY` route
 * only, so pointing `--probe-b-path` at a gateway-producer route with a
 * `character_id` would close `CHARACTER_MISMATCH.familyIsDerived`.
 *
 * Do not reduce the output to a body string. Whether a `403` is the gateway's
 * `EDGE` bytes or derives per route the way a `404` does is answered by
 * `content-type`, the trailing newline and `x-content-type-options`, not by the
 * JSON.
 */

"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { URL, URLSearchParams } = require("node:url");


const SSO_BASE = "https://login.eveonline.com";
const ESI_BASE = "https://esi.evetech.net";

/**
 * The scope the token will hold, and the one probe A needs it not to.
 *
 * The default granted scope is one an application plausibly already holds. The
 * probed one is the wallet, which is on a different rate-limit group
 * (`char-wallet`, 150/15m), so the transcript also says whether a `403` is
 * charged to the route's bucket the way the no-token `401` is, or to the error
 * limiter the way the invalid-token one is.
 *
 * Which scope an application may request is whatever it was registered with,
 * and there is no way to ask: `invalid_scope` at the consent screen is how you
 * find out. Hence `--scope`, and `PROBE_B_BY_SCOPE` below to keep probe B
 * pointed at a route the token can reach.
 */
const GRANTED_SCOPE = "esi-location.read_online.v1";
const PROBE_A_PATH = "/latest/characters/{id}/wallet/";

/**
 * Probe B's route, derived from whichever scope the token actually holds.
 *
 * The route must be one the token can reach, or the refusal would be a
 * missing-scope one and the two probes would be the same observation. The
 * granted scope therefore picks the path. The table is small on purpose: the
 * character-scoped reads the authenticated routes need. An unrecognised scope
 * is an error naming `--probe-b-path` rather than a guess at a URL.
 */
const PROBE_B_BY_SCOPE = Object.freeze({
  "esi-location.read_location.v1": "/latest/characters/{other}/location/",
  "esi-location.read_online.v1": "/latest/characters/{other}/online/",
  "esi-location.read_ship_type.v1": "/latest/characters/{other}/ship/",
  "esi-characters.read_corporation_roles.v1": "/latest/characters/{other}/roles/",
  "esi-skills.read_skills.v1": "/latest/characters/{other}/skills/",
});

/**
 * A character that is not yours, for probe B.
 *
 * Supplied per run and deliberately not defaulted: only a real character id
 * makes probe B work, and a real id written here would be somebody's character
 * in the repository. The limiter survey in `contract/wire.js` likewise records
 * its probe path with a placeholder segment rather than the entity it asked for.
 *
 * Read from `--other-character`, or from `EVE_OTHER_CHARACTER` when the flag is
 * absent, and checked against your own id: a probe that asks for your own
 * character proves nothing. Whatever you pass is used and never recorded.
 */
const OTHER_CHARACTER_ENV = "EVE_OTHER_CHARACTER";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;


function parseArgs(argv) {
  const args = { callback: "http://localhost:8779/callback" };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`${arg} needs a value.`);
      }
      i += 1;
      return value;
    };

    if (arg === "--client-id") args.clientId = next();
    else if (arg === "--callback") args.callback = next();
    else if (arg === "--other-character") args.other = next();
    else if (arg === "--scope") args.scope = next();
    else if (arg === "--probe-b-path") args.probeBPath = next();
    else if (arg === "--success") args.success = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else fail(`unknown argument ${JSON.stringify(arg)}. Try --help.`);
  }

  return args;
}

const USAGE = `
observe-403: capture the two ESI 403s (D31)

  node scripts/observe-403.js --client-id <id> [options]

  --client-id <id>          Required. Your EVE application's client id.
                            Register at https://developers.eveonline.com/applications
                            as a native/desktop app. PKCE, so NO secret is
                            needed and none is accepted here.

  --callback <url>          Default http://localhost:8779/callback
                            Must match the callback registered on the app,
                            character for character.

  --scope <scope>           Default ${GRANTED_SCOPE}
                            The scope the token WILL hold. Keep the app's scope
                            set narrow: probe A needs a route it cannot reach.

  --other-character <id>    Required, and there is no default; ${OTHER_CHARACTER_ENV}
                            is read when the flag is absent. Someone who is not
                            you, for the cross-character probe. Any character
                            that resolves will do, and the id is not recorded.

The app's scope set must NOT include esi-wallet.read_character_wallet.v1:
probe A is a request for a wallet the token may not read, and a token that may
read it observes nothing.
`;

function fail(message) {
  process.stderr.write(`\nobserve-403: ${message}\n`);
  process.exit(2);
}


/**
 * RFC 7636 section 4.1-4.2. The verifier never leaves this process until the
 * token exchange, and the challenge is what goes in the URL, which is why a
 * public client needs no secret.
 */
function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}


/**
 * Serve exactly one callback, then stop.
 *
 * `state` is compared before the code is used: a callback that does not carry
 * the generated value is not our redirect, and using its code would redeem
 * somebody else's.
 */
function awaitCallback(callbackUrl, expectedState) {
  const target = new URL(callbackUrl);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    // Closed once, after the response has flushed. Closing from inside the handler
    // while the socket is still writing trips a libuv assertion on Windows
    // (`UV_HANDLE_CLOSING`) and takes the process with it.
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close(() => outcome());
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== target.pathname) {
        res.writeHead(404).end("not the callback path\n");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      const answer = (status, message, outcome) => {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        // Wait for the browser's response to leave before tearing the listener down, so
        // the tab shows the message rather than a reset connection.
        res.on("finish", () => finish(outcome));
        res.end(`${message}\n`);
      };

      if (error) {
        const described = url.searchParams.get("error_description") || "";
        answer(400, `SSO refused: ${error}`, () => reject(new Error(`SSO returned ${error}: ${described}`)));
        return;
      }
      if (state !== expectedState) {
        // Answered and not settled: the listener keeps waiting. A stray request (a
        // stale tab, a port scanner, a diagnostic curl) must not end a run the user has
        // not completed. Nothing is redeemed either way.
        process.stdout.write("  (ignored a callback with the wrong state; still waiting)\n");
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("state mismatch: this is not the redirect this run started\n");
        return;
      }
      if (!code) {
        answer(400, "no code on the callback",
          () => reject(new Error("the callback carried no authorization code")));
        return;
      }

      answer(200, "Got it. You can close this tab and go back to the terminal.", () => resolve(code));
    });

    server.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new Error(
        `could not listen on ${target.host} (${err.code}). `
          + "Pick a free port with --callback, and register the same one on the app.",
      ));
    });

    timer = setTimeout(
      () => finish(() => reject(new Error("timed out waiting for the consent redirect"))),
      CALLBACK_TIMEOUT_MS,
    );
    timer.unref();

    // Both loopback families. `listen(port, "localhost")` resolves to one family,
    // and on Windows that is `[::1]`, so a browser that follows the redirect over
    // IPv4 finds nothing listening and the run waits forever for a click that
    // already happened. Observed exactly that.
    //
    // Omitting the host binds `::` dual-stack, which accepts IPv4 and IPv6 loopback
    // alike. It also accepts the machine's other interfaces for the couple of
    // minutes this is up; the redirect carries a single-use code and a `state` a
    // stranger cannot guess.
    const host = target.hostname === "localhost" ? undefined : target.hostname;
    server.listen(Number(target.port || 80), host);
  });
}

/**
 * A form POST over `node:https`.
 *
 * Not `fetch`: the probes below already avoid it because it folds repeated
 * header fields, so using it here would put two HTTP clients in one short
 * script. Also, on Windows an open keep-alive socket in `fetch`'s pool plus a
 * process exit trips a libuv assertion that kills the process with a stack
 * trace instead of the error it was about to print.
 */
function postForm(url, form, extraHeaders = {}) {
  const body = form.toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": Buffer.byteLength(body),
          accept: "application/json",
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          contentType: res.headers["content-type"] || "(none)",
          text: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function exchange({ code, clientId, clientSecret, verifier, callback }) {
  // Two client kinds, chosen before the consent screen because an authorization
  // code is single-use and a wrong guess costs a second trip through the browser.
  //
  // A public client (native/desktop) proves itself with the PKCE verifier and
  // sends `client_id` in the body. A confidential one (web app, issued a secret)
  // proves itself with HTTP Basic and sends no verifier, because it was never
  // issued a challenge. `main` decides from whether a secret is present and
  // builds the authorize URL to match.
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: callback,
  });
  const headers = {};

  if (clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    headers.authorization = `Basic ${basic}`;
  } else {
    form.set("client_id", clientId);
    form.set("code_verifier", verifier);
  }

  const response = await postForm(`${SSO_BASE}/v2/oauth/token`, form, headers);

  if (response.status !== 200) {
    // The body is shown only when it is JSON. A rejected exchange is often answered
    // by a CDN with a full HTML challenge page, and six kilobytes of markup buries
    // the status.
    const isJson = response.contentType.includes("json");
    const detail = isJson
      ? response.text.slice(0, 400)
      : `a ${response.text.length}-byte ${response.contentType} body, not shown`;
    const hint = isJson
      ? ""
      : " A non-JSON answer here usually means the client id is not a registered"
        + " application, or the callback does not match the one registered on it.";
    throw new Error(
      `token exchange failed (${response.status}, content-type ${response.contentType}): ${detail}.${hint}`,
    );
  }

  const payload = JSON.parse(response.text);
  if (typeof payload.access_token !== "string") {
    throw new Error("token exchange answered 200 without an access_token");
  }
  return payload.access_token;
}

/**
 * `sub` and `scp`, read without verifying.
 *
 * This is CCP's own token, fetched over TLS from CCP's own endpoint seconds ago,
 * and nothing here is a security decision: the claims build two URLs and print
 * a transcript. Verifying would need CCP's JWKS to answer a question this
 * script does not ask. `lib/bearerToken.js` is the opposite job: it reads
 * tokens that strangers present.
 */
function readClaims(token) {
  const segments = token.split(".");
  if (segments.length !== 3) throw new Error("the access token is not a compact JWS");

  const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  const subject = String(payload.sub || "");
  const match = /^CHARACTER:EVE:(\d+)$/i.exec(subject);
  if (!match) throw new Error(`unexpected subject ${JSON.stringify(subject)}`);

  const scp = payload.scp;
  const scopes = Array.isArray(scp) ? scp : typeof scp === "string" ? scp.split(/\s+/).filter(Boolean) : [];

  return { characterId: Number(match[1]), scopes, name: payload.name };
}


/**
 * One request, with the response captured the way `contract/wire.js` needs it:
 * raw header lines in wire order, duplicates preserved, and the body as bytes.
 */
function probe(path, token) {
  const url = new URL(path, ESI_BASE);

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          url: url.href,
          status: res.statusCode,
          statusMessage: res.statusMessage,
          rawHeaders: res.rawHeaders,
          body: Buffer.concat(chunks),
        }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function render(title, question, result) {
  const lines = [];
  lines.push("");
  lines.push("-".repeat(72));
  lines.push(title);
  lines.push(`  ${question}`);
  lines.push(`  GET ${result.url}`);
  lines.push("-".repeat(72));
  lines.push(`HTTP/1.1 ${result.status} ${result.statusMessage}`);

  // Pairs, in wire order. `rawHeaders` is [name, value, name, value, ...], so a
  // header sent twice appears twice.
  for (let i = 0; i < result.rawHeaders.length; i += 2) {
    lines.push(`${result.rawHeaders[i]}: ${result.rawHeaders[i + 1]}`);
  }

  lines.push("");
  lines.push(`body      ${JSON.stringify(result.body.toString("utf8"))}`);
  lines.push(`bytes     ${result.body.length}`);
  lines.push(`hex       ${result.body.toString("hex")}`);
  lines.push(
    `newline   ${result.body.length > 0 && result.body[result.body.length - 1] === 0x0a
      ? "yes: the body ends 0a"
      : "no: the body does not end 0a"}`,
  );

  return lines.join("\n");
}


async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!args.clientId) fail("--client-id is required. Try --help.");

  const otherRaw = args.other !== undefined ? args.other : process.env[OTHER_CHARACTER_ENV];
  if (otherRaw === undefined || otherRaw === "") {
    fail(
      "a character that is not yours is required for probe B, and there is no default. "
        + `Pass --other-character <id>, or set ${OTHER_CHARACTER_ENV}. Any character id `
        + "that resolves will do; it picks the path, and is not recorded anywhere.",
    );
  }
  args.other = Number(otherRaw);
  if (!Number.isSafeInteger(args.other) || args.other <= 0) {
    fail("--other-character must be a positive integer character id.");
  }

  // `--scope none` asks for a token with no scopes at all, which CCP issues and
  // which is enough for probe A: a scopeless token is a verified token that lacks
  // the scope every authenticated route requires. Probe B needs a scope the token
  // holds, so it is skipped rather than faked.
  //
  // It exists because an application's permitted scope set cannot be queried, and
  // an app registered without scopes cannot request one but can still answer the
  // scope-refusal question.
  const scopeless = args.scope === "none";
  const granted = scopeless ? "" : args.scope || GRANTED_SCOPE;
  const grantedScopes = granted === "" ? [] : granted.split(/\s+/).filter(Boolean);

  // From the environment, never from a flag: an argument is visible in the
  // process list to every other user on the machine, and in shell history. Absent
  // is the normal case, since a native app has no secret and PKCE stands in for
  // one.
  const clientSecret = process.env.EVE_CLIENT_SECRET || null;

  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(16).toString("base64url");

  const query = {
    response_type: "code",
    redirect_uri: args.callback,
    client_id: args.clientId,
    state,
  };
  if (!scopeless) query.scope = granted;
  // Only a public client is challenged. Sending a challenge and then proving the
  // exchange with Basic instead is the mismatch that costs a second consent
  // screen, so the two halves are decided together, here.
  if (!clientSecret) {
    query.code_challenge = challenge;
    query.code_challenge_method = "S256";
  }

  const authorize = new URL(`${SSO_BASE}/v2/oauth/authorize/`);
  authorize.search = new URLSearchParams(query).toString();

  process.stdout.write(`
observe-403: capturing the two refusals D31 waits on.

  Open this in a browser and approve it:

${authorize.href}

  Waiting for the redirect to ${args.callback} …
  ${clientSecret ? "confidential client (secret from EVE_CLIENT_SECRET)" : "public client (PKCE, no secret)"}
  (nothing is written to disk, and neither the token nor the secret is printed)
`);

  const code = await awaitCallback(args.callback, state);
  const token = await exchange({
    code,
    clientId: args.clientId,
    clientSecret,
    verifier,
    callback: args.callback,
  });
  const claims = readClaims(token);

  process.stdout.write(`
  Token held for character ${claims.characterId}${claims.name ? ` (${claims.name})` : ""}.
  Granted scopes: ${claims.scopes.length ? claims.scopes.join(", ") : "(none)"}
`);

  // Success mode
  //
  // A different question from the two refusals, answered by the same plumbing:
  // what does a 200 from these routes look like? `lib/router.js` refuses to
  // compile a route without a `producer`, and a producer is not in any spec. It
  // is read off the wire, from the success `content-type` and whether the body
  // ends in a newline. Only `/online/` was derivable, from the family of the 403
  // above.
  //
  // It also captures the bytes `test/serialize.test.js` wants recorded as
  // goldens.
  if (args.success) {
    const own = String(claims.characterId);
    const routes = [
      ["/online/", `/latest/characters/${own}/online/`, "esi-location.read_online.v1"],
      ["/location/", `/latest/characters/${own}/location/`, "esi-location.read_location.v1"],
      ["/ship/", `/latest/characters/${own}/ship/`, "esi-location.read_ship_type.v1"],
    ];

    for (const [label, route, needs] of routes) {
      if (!claims.scopes.includes(needs)) {
        process.stdout.write(`
  SKIPPED ${label}: the token does not hold ${needs}
`);
        continue;
      }
      process.stdout.write(render(`SUCCESS: ${label}`, `needs ${needs}`, await probe(route, token)));
    }

    process.stdout.write(`
${"-".repeat(72)}
WHAT THIS SETTLES

  producer          bare \`application/json\` + a trailing newline is the gateway;
                    \`application/json; charset=UTF-8\` + no newline is the
                    application. An \`X-Esi-Request-Id\` is the application too.
  field order       the order above IS the order, and order is bytes.
  optional fields   whichever of last_login / logins / station_id / structure_id
                    are absent here are absent on the real thing.

  Record the producer in contract/wire.js SUCCESS_KIND and the bytes as
  contract/golden/<OperationId>.json.
`);
    return;
  }

  // A probe that succeeds observes nothing, so both are checked before either
  // runs: a wasted consent screen is worse than an early error.
  const walletScope = "esi-wallet.read_character_wallet.v1";
  if (claims.scopes.includes(walletScope)) {
    fail(
      `this token holds ${walletScope}, so probe A would be answered 200 rather than 403. `
        + "Re-register the application with a narrower scope set, or drop that scope from it.",
    );
  }
  // `--scope` may name several, space-delimited, exactly as the authorize
  // endpoint takes them, so this splits before comparing. Comparing the whole
  // string against a list of single scopes can only fail.
  const missing = grantedScopes.filter((scope) => !claims.scopes.includes(scope));
  if (!scopeless && missing.length > 0) {
    fail(
      `this token does not hold ${missing.join(", ")}, so probe B would be a missing-scope `
        + "refusal rather than a cross-character one, and the two would be indistinguishable "
        + "in the transcript.",
    );
  }
  if (claims.characterId === args.other) {
    fail(
      `--other-character is your own character (${args.other}). Probe B has to ask for somebody `
        + "else's data. Pass a different id.",
    );
  }

  // Keyed off the first granted scope: with several, any one gives a route the
  // token can reach, which is all probe B needs.
  const probeBPath = scopeless ? null : args.probeBPath || PROBE_B_BY_SCOPE[grantedScopes[0]];
  if (!scopeless && !probeBPath) {
    fail(
      `no probe-B route is known for ${granted}. Probe B has to ask for another character's data `
        + "on a route this token CAN reach, so pass the path with --probe-b-path, using {other} "
        + "where the character id goes.",
    );
  }

  const a = await probe(PROBE_A_PATH.replace("{id}", String(claims.characterId)), token);
  const b = probeBPath === null
    ? null
    : await probe(probeBPath.replace("{other}", String(args.other)), token);

  process.stdout.write(render(
    "PROBE A: a scope the token does not hold",
    `token holds [${claims.scopes.join(", ") || "no scopes at all"}]; the wallet needs ${walletScope}`,
    a,
  ));

  if (b === null) {
    process.stdout.write(`

${"-".repeat(72)}
PROBE B: NOT CAPTURED
  This run asked for no scopes, so there is no route the token can reach and
  therefore no way to ask for another character's data *without* the refusal
  being a missing-scope one instead. The cross-character 403 stays unobserved.

  To capture it: tick one character-scoped permission on the application at
  developers.eveonline.com (esi-location.read_online.v1 is the cheapest) and
  re-run with --scope esi-location.read_online.v1.
`);
  } else {
    process.stdout.write(render(
      "PROBE B: a character the token is not for",
      `token is for character ${claims.characterId}; the path asks for ${args.other}`,
      b,
    ));
  }

  const sameBody = b !== null && a.body.equals(b.body);
  process.stdout.write(`

${"-".repeat(72)}
WHAT THIS SETTLES

  statuses          A: ${a.status}${b ? `   B: ${b.status}` : "   B: not captured"}
  same body?        ${b === null
    ? "unknown: probe B was not captured, so D31's two-curl requirement stands"
    : sameBody
      ? "YES: one refusal serves both"
      : "NO: they are two refusals and need two entries"}
  limiter           read X-Ratelimit-* vs X-Esi-Error-Limit- above: the first
                    means the route's bucket charged it (as the no-token 401 is),
                    the second means it never reached the route (as the
                    invalid-token 401 does)
  family            content-type + the trailing newline + x-content-type-options
                    decide whether a 403 is EDGE's bytes or derives per route
                    the way a 404 does. Do not infer it from the JSON.

  Transcribe the blocks above into contract/wire.js, replacing
  FORBIDDEN_UNOBSERVED, then answer D31 in docs/open-decisions.md.
`);

  if (a.status !== 403 || (b !== null && b.status !== 403)) {
    process.stdout.write(`
  NOTE: one of these is not a 403. That is itself an observation and worth
  recording, but check the app's scope set before believing it.
`);
  }
}

main().catch((err) => {
  process.stderr.write(`\nobserve-403: ${err.message}\n`);
  // `exitCode` rather than `exit()`: the callback listener may still be closing,
  // and tearing the loop down under it is half of the libuv assertion described
  // above.
  process.exitCode = 1;
});
