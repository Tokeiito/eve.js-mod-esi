/**
 * eve.js-mod-esi: the capture that would settle the limiter key (D39)
 *
 * Run with:  node scripts/observe-limiter-key.js --client-id <app A> --cell a1
 *            node scripts/observe-limiter-key.js --client-id <app A> \
 *                --client-id-b <app B> --cell a1 --cell a2 --cell b1 --cell b2
 *            node scripts/observe-limiter-key.js --show
 *
 * Both limiters in this replica key on the source address, unconditionally.
 * CCP is documented to key an authenticated caller on
 * `applicationID:characterID` instead, with the authenticated half winning
 * where both exist. That is documented, not observed: nothing in
 * `contract/wire.js` has seen it, and `docs/open-decisions.md` D31 refuses to
 * write an unobserved rule into the file that holds what was observed. So
 * `lib/errorLimiter.js` `keyFor` and `lib/rateLimiter.js` still key on the
 * address, and this script is the capture that would let them stop. It changes
 * nothing; it only asks.
 *
 * Three questions:
 *
 *   Q2  One budget or two? A caller that makes some requests authenticated and
 *       some not: one bucket keyed two ways, or two independent budgets? The
 *       observable difference is whether an unauthenticated request drains the
 *       budget its authenticated sibling then finds spent. It is the cheapest
 *       and most load bearing, so it runs first.
 *
 *   Q3  Do the two limiters agree? The error limiter and the token bucket are
 *       separate mechanisms with separate headers and windows, and assuming
 *       they agree has already been a mistake in this project. Q2's pairing is
 *       repeated against a route the token bucket owns, reading
 *       `x-ratelimit-remaining` rather than the error headers, and its answer
 *       is never inferred from Q2's.
 *
 *   Q1  What is `applicationID`? No response names it. It can only be inferred
 *       from whether two callers who differ in exactly one dimension share a
 *       budget, which is what the matrix below is for.
 *
 * The 2x2. Four cells, each one a credential:
 *
 *       cell   application   character
 *       a1     A             1            baseline
 *       a2     A             2            does the CHARACTER half move it?
 *       b1     B             1            does the APPLICATION half move it?
 *       b2     B             2            confirmation
 *
 * Four candidate keys are distinguished by those cells and by no smaller set.
 * Charge one error per cell in the order `a1, a2, b1, b2`, after the address
 * budget has been walked down to `u` by the unauthenticated preamble, and each
 * candidate predicts a different sequence of `X-Esi-Error-Limit-Remain`
 * readings:
 *
 *       source IP regardless of credential   u-1, u-2, u-3, u-4
 *       applicationID:characterID (the pair)  99,  99,  99,  99
 *       characterID alone                     99,  99,  98,  98
 *       applicationID alone                   99,  98,  99,  98
 *
 * A single pair splits one axis and leaves the other unobserved: `a1` against
 * `a2` cannot tell "the pair" from "application alone", because both predict
 * the character half moving the budget. A run that covers only some cells
 * therefore reports inconclusive, with the name of the cell that would split
 * the survivors, rather than picking the likeliest.
 *
 * Even a complete matrix says only which half of the key moves the budget. It
 * does not say what `applicationID` is on the wire: the client id from the
 * token's `azp` and the registered application's own numeric id are different
 * things, and a budget that partitions by application partitions the same way
 * under either.
 *
 * The error limiter's window is 60 seconds and `Reset` counts down inside it,
 * so two readings taken either side of a rollover are not comparable, and a
 * consent round is a human at a browser. Every consent round therefore happens
 * up front, and then every probe fires back to back in about a second. Four
 * cells cost four consent screens and one error limit window. Tokens live in
 * memory for one invocation and are never written anywhere.
 *
 * A run may name one cell, or two, and stop. The state file records which cells
 * were visited and what each measured, so a later run knows what is missing and
 * says what each remaining cell would settle. A later run cannot compare its
 * cells against an earlier run's on the error limiter, because the window
 * rolled in between, and the script reports that as not comparable. The token
 * bucket's window is 15 minutes, so there the cross run comparison is
 * attempted when the readings fall inside one window and nothing else spent
 * from the same budget in the meantime.
 *
 * Budget. Every error below is spent from a real budget on CCP's
 * infrastructure. A full four cell run spends 6 error units of 100 in one 60
 * second window (two unauthenticated, four authenticated) and 12 tokens of the
 * `status` group's 600 per 15 minutes. A one cell run spends 3 and 6. The
 * running total is printed after every probe. The pre-flight refuses to start
 * when the budget is already substantially spent: a depleted counter means
 * something else on this address is making errors concurrently, which would
 * corrupt every delta well before it risked tripping the limit of 420.
 *
 * Identifiers. Every id this needs belongs to a person, so this file carries
 * none. Client ids arrive as flags with no defaults, as `observe-authed.js`
 * takes `--other-corporation`, and character ids are never asked for: the
 * character is whoever sits at the consent screen. Neither reaches the
 * terminal. The transcript identifies a cell by its name and a fingerprint (the
 * first twelve hex characters of a SHA-256), which proves that `a1` and `a2`
 * were two different characters and that `a1` and `b1` were one, and does not
 * name either. The state file holds the same fingerprints and never a token. It
 * lives in the operating system's temp directory, outside this repository, so a
 * stray `git add -A` cannot pick it up.
 *
 * The token is held in memory, used, and forgotten. It is never written or
 * printed, not even truncated. Everything printed goes through `scrub` first,
 * as a last line of defence.
 *
 * The probes use `node:https` and print `rawHeaders` in wire order with
 * duplicates intact, as `scripts/observe-403.js` and
 * `scripts/observe-authed.js` do, because `fetch` folds repeated header fields
 * (see `contract/wire.js`).
 *
 * The PKCE round trip below is theirs, near enough. The duplication is
 * deliberate for the reason `observe-authed.js` gives: one file with no
 * dependencies suits a tool an operator runs by hand. As the third copy, this
 * is the point at which extracting `scripts/lib/ssoProbe.js` and rewriting all
 * three stops being premature.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { URL, URLSearchParams } = require("node:url");


const SSO_BASE = "https://login.eveonline.com";
const ESI_BASE = "https://esi.evetech.net";

const DEFAULT_CALLBACK = "http://localhost:8779/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The four cells, in the order the probes fire.
 *
 * The order is not cosmetic. The classifier replays the charges in this
 * sequence and compares each reading against what a candidate key predicts, so
 * a different fire order would be compared against the wrong predictions.
 * `a1, a2, b1, b2` walks the character axis first, which makes the two "alone"
 * candidates diverge earliest.
 */
const CELLS = Object.freeze(["a1", "a2", "b1", "b2"]);

/**
 * The candidate keys: the whole hypothesis space for the limiter key (D39).
 *
 * `sourceAddress` is what this replica does today and what an unauthenticated
 * caller gets everywhere. The other three are the readings of CCP's phrase
 * "applicationID:characterID when authenticated": the pair, or one half of it
 * doing all the work while the other is decoration.
 */
const KEY_CANDIDATES = Object.freeze([
  "sourceAddress",
  "applicationAndCharacter",
  "characterOnly",
  "applicationOnly",
]);

/** Human readable, for the verdict line. */
const CANDIDATE_PROSE = Object.freeze({
  sourceAddress: "the source IP, regardless of credential (what this replica already does)",
  applicationAndCharacter: "applicationID:characterID, the pair, as CCP's documentation reads",
  characterOnly: "characterID alone; the application half does not move the budget",
  applicationOnly: "applicationID alone; the character half does not move the budget",
});

/**
 * A free read that carries the error limiter's headers.
 *
 * `contract/wire.js` `LIMITER_SURVEY` has this route answering 304 on the error
 * limiter with the counter unchanged, and a 200 leaves it unchanged too,
 * because successes do not charge. The pre-flight can therefore read the budget
 * without spending any of it.
 */
const DEFAULT_BASELINE_PATH = "/latest/universe/factions/";

/**
 * The deliberate error, on the same path authenticated and not.
 *
 * `LIMITER_SURVEY` records this exact request decrementing the error limiter by
 * one, so the cost is known before the run. The two halves of Q2 differ in
 * exactly one dimension, the `Authorization` header, which is what makes the
 * answer meaningful.
 *
 * Caveat: this is a public route. `contract/wire.js` `BEARER` establishes that
 * ESI validates a presented credential on public routes (`Bearer garbage`
 * against `/latest/status/` is refused), so a valid token here is a credential
 * ESI has resolved. Whether it resolves it far enough to key a limiter on it is
 * what is being asked. A reading of "shared with the address" on this route is
 * a fact about this route family and not automatically about an authenticated
 * one; `--error-path` lets an operator retry elsewhere without editing the file.
 */
const DEFAULT_ERROR_PATH = "/latest/universe/systems/99/";

/**
 * The token bucket's half of the same pairing.
 *
 * `/latest/status/` is on the token bucket in `LIMITER_SURVEY` (group `status`,
 * 600/15m, `Used: 2` on a 200) and needs no scope. Authenticated and
 * unauthenticated both answer 200 at the same cost, so the pair differs in the
 * credential and nothing else. A route that answered 401 unauthenticated and
 * 200 authenticated would change the status class and the charge along with the
 * credential.
 */
const DEFAULT_BUCKET_PATH = "/latest/status/";

/** `contract/wire.js` `ERROR_LIMIT`. Carried here because deployed code must. */
const ERROR_LIMIT_MAX = 100;
const ERROR_LIMIT_WINDOW_SECONDS = 60;

/** `contract/wire.js` `TOKEN_BUCKET`. */
const TOKEN_BUCKET_WINDOW_SECONDS = 900;

/**
 * Refuse to start below this many error units.
 *
 * Mostly not about the 420. A budget already half spent means somebody else on
 * this address is charging the same counter while the probes run, and a delta
 * measured against a moving baseline is not a measurement. Tripping the limit
 * is the lesser reason, since a full run spends six.
 */
const MIN_ERROR_BUDGET = 50;

/** Outside the repository, always. See the header on identifiers. */
const DEFAULT_STATE_PATH = path.join(os.tmpdir(), "eve.js-mod-esi-limiter-key.json");

const STATE_VERSION = 1;

const USER_AGENT = "eve.js-mod-esi observe-limiter-key (contact via the repository)";


const USAGE = `
eve.js-mod-esi: the capture behind D39

  node scripts/observe-limiter-key.js --client-id <id> --cell a1 [more cells]

What it costs, before you run it:

  a full four cell run      6 error units of 100, in one 60 second window
                            12 tokens of the status group's 600 per 15 minutes
  a one cell run            3 error units, 6 status tokens
  the pre-flight read       nothing; a 200 does not charge the error limiter

  It refuses to start below ${MIN_ERROR_BUDGET} remaining error units, and never
  deliberately approaches the 420.

Cells. Each one is a credential, and the letter and digit are yours to assign:

  a1   application A, character 1     baseline
  a2   application A, character 2     does the CHARACTER half move the budget?
  b1   application B, character 1     does the APPLICATION half move the budget?
  b2   application B, character 2     confirmation

  Name as many as you can authorise in one sitting. Every consent screen happens
  before any probe does, so the whole matrix lands inside one error limit window
  however long the consents took. Cells from separate invocations are recorded
  but are NOT differenced across on the error limiter, because its window is 60
  seconds and a consent round is not.

  A run that covers some of the cells reports inconclusive and names the cell
  that would split what is left. That is the honest answer, not a failure.

Required:
  --client-id <id>        Application A. A PKCE public client registered at
                          developers.eveonline.com with the callback below.
                          No scopes are requested and none are needed: every
                          probe is a public route, and what is being measured is
                          the credential, not what it may read.
  --client-id-b <id>      Application B. Required only for cells b1 and b2.
                          A SECOND registered application, not a second
                          character. Only you can supply this.
  --cell <name>           Repeatable. One of ${CELLS.join(", ")}.

Options:
  --callback <url>        OAuth redirect. Default ${DEFAULT_CALLBACK}
  --error-path <path>     The deliberate error, charged to the error limiter.
                          Default ${DEFAULT_ERROR_PATH}
  --bucket-path <path>    The token bucket probe. Default ${DEFAULT_BUCKET_PATH}
  --baseline-path <path>  The free read the pre-flight budget comes from.
                          Default ${DEFAULT_BASELINE_PATH}
  --min-budget <n>        Refuse below this many error units. Default ${MIN_ERROR_BUDGET}
  --state <path>          Where visited cells are remembered. Default is under
                          the OS temp directory, never inside the repository,
                          and it holds fingerprints rather than ids and never a
                          token.
  --show                  Print what the state file already knows and exit.
                          Costs nothing and asks nobody to authorise anything.
  --forget                Delete the state file and exit.
  --help                  This.

What only you can supply: a second registered application for the b cells, and a
second character for the 2 cells. Without a second application the application
axis cannot be moved and Q1 stays open on that half; without a second character
the same is true of the character half. Neither can be simulated from here.

Nothing is written to disk except the state file described above. The token is
never printed and never stored.
`;

function fail(message) {
  process.stderr.write(`\nobserve-limiter-key: ${message}\n`);
  process.exitCode = 2;
}

/**
 * Throws rather than exiting, so the whole surface is testable.
 *
 * `observe-authed.js` exits from inside its parser, so its tests can only feed
 * it valid arguments. The interesting cases here are the invalid ones, since
 * half the point of the flags is refusing a run that would observe nothing.
 */
function parseArgs(argv) {
  const args = {
    clientIdA: null,
    clientIdB: null,
    callback: DEFAULT_CALLBACK,
    cells: [],
    errorPath: DEFAULT_ERROR_PATH,
    bucketPath: DEFAULT_BUCKET_PATH,
    baselinePath: DEFAULT_BASELINE_PATH,
    minBudget: MIN_ERROR_BUDGET,
    statePath: DEFAULT_STATE_PATH,
    show: false,
    forget: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined || String(value).startsWith("--")) {
        throw new Error(`${flag} needs a value.`);
      }
      i += 1;
      return value;
    };

    switch (flag) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--client-id":
        args.clientIdA = take();
        break;
      case "--client-id-b":
        args.clientIdB = take();
        break;
      case "--cell": {
        const cell = String(take()).toLowerCase();
        if (!CELLS.includes(cell)) {
          throw new Error(`--cell must be one of ${CELLS.join(", ")}, not ${JSON.stringify(cell)}.`);
        }
        if (args.cells.includes(cell)) {
          throw new Error(`--cell ${cell} was given twice. One consent per cell.`);
        }
        args.cells.push(cell);
        break;
      }
      case "--callback":
        args.callback = take();
        break;
      case "--error-path":
        args.errorPath = take();
        break;
      case "--bucket-path":
        args.bucketPath = take();
        break;
      case "--baseline-path":
        args.baselinePath = take();
        break;
      case "--min-budget": {
        const value = Number(take());
        if (!Number.isFinite(value) || value < 0) throw new Error("--min-budget must be a number.");
        args.minBudget = value;
        break;
      }
      case "--state":
        args.statePath = take();
        break;
      case "--show":
        args.show = true;
        break;
      case "--forget":
        args.forget = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(flag)}. Try --help.`);
    }
  }

  if (args.help || args.show || args.forget) return args;

  if (args.cells.length === 0) {
    throw new Error(
      "no --cell was given, so there is nothing to authorise and nothing to measure. "
        + `Pass at least --cell a1. Try --help.`,
    );
  }
  if (args.cells.some((cell) => cell.startsWith("a")) && !args.clientIdA) {
    throw new Error("cells a1 and a2 need --client-id (application A).");
  }
  if (args.cells.some((cell) => cell.startsWith("b")) && !args.clientIdB) {
    throw new Error(
      "cells b1 and b2 need --client-id-b, a SECOND registered application. "
        + "Only you can supply one; nothing here can stand in for it.",
    );
  }
  if (args.clientIdA && args.clientIdB && args.clientIdA === args.clientIdB) {
    throw new Error(
      "--client-id and --client-id-b are the same application, so the b cells would move "
        + "no axis at all and the matrix would record two copies of the a cells.",
    );
  }

  // Fire order is fixed, whatever order the flags arrived in.
  args.cells = CELLS.filter((cell) => args.cells.includes(cell));
  return args;
}

/** Which application a cell draws its client id from. */
function applicationOf(cell) {
  return String(cell)[0].toUpperCase();
}

/** Which character a cell expects at the consent screen. */
function characterOf(cell) {
  return String(cell)[1];
}


/**
 * Twelve hex characters of a SHA-256, and no more.
 *
 * Enough to prove two cells used the same application, or two different
 * characters. Not enough to name either, so the state file and the transcript
 * are both safe to keep.
 */
function fingerprint(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

/**
 * Anything that could be a token, removed before it reaches a terminal.
 *
 * Two passes. The exact strings are the tokens this process holds, which is the
 * case that matters. The JWT shaped pattern catches a token this process never
 * saw, for example when an upstream diagnostic header echoes an `Authorization`
 * back.
 */
function scrub(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      out = out.split(secret).join("[token redacted]");
    }
  }
  return out.replace(
    /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
    "[token redacted]",
  );
}


/**
 * What a previous invocation learned, and nothing it held.
 *
 * Cells, timestamps, fingerprints and counter readings. No token, no client id,
 * no character id, and nothing under the repository. A corrupt or unreadable
 * file is treated as an empty one: this is a convenience for a human running a
 * capture by hand, and failing a run over it would be wrong.
 */
function readState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.runs)) {
      return { version: STATE_VERSION, runs: [] };
    }
    return parsed;
  } catch {
    return { version: STATE_VERSION, runs: [] };
  }
}

function writeState(statePath, state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Which cells nobody has run yet, and what each would still settle. */
function missingCells(state) {
  const seen = new Set();
  for (const run of state.runs || []) for (const cell of run.cells || []) seen.add(cell);
  return CELLS.filter((cell) => !seen.has(cell));
}

const CELL_PURPOSE = Object.freeze({
  a1: "the baseline every other cell is read against",
  a2: "whether the CHARACTER half of the key moves the budget",
  b1: "whether the APPLICATION half of the key moves the budget",
  b2: "the confirmation that separates the pair from either half alone",
});


/**
 * Did the operator actually move the axis they said they moved?
 *
 * A run of `a1` and `a2` where the same character sat at both consent screens
 * measures nothing and looks like a run that measured "the character half does
 * not matter". The check is made from fingerprints rather than ids.
 *
 * The rule is mechanical: cells sharing a letter must share an application and
 * cells sharing a digit must share a character, and cells differing in either
 * must differ in the matching fingerprint.
 */
function checkMatrixConsistency(cells) {
  const names = Object.keys(cells).filter((name) => CELLS.includes(name));
  const problems = [];

  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const [x, y] = [names[i], names[j]];
      const sameApplication = applicationOf(x) === applicationOf(y);
      const sameCharacter = characterOf(x) === characterOf(y);
      const applicationsMatch = cells[x].applicationFingerprint === cells[y].applicationFingerprint;
      const charactersMatch = cells[x].characterFingerprint === cells[y].characterFingerprint;

      if (sameApplication && !applicationsMatch) {
        problems.push(`${x} and ${y} share a letter but were authorised by DIFFERENT applications.`);
      }
      if (!sameApplication && applicationsMatch) {
        problems.push(`${x} and ${y} differ by letter but were authorised by the SAME application, so the application axis did not move.`);
      }
      if (sameCharacter && !charactersMatch) {
        problems.push(`${x} and ${y} share a digit but were authorised by DIFFERENT characters.`);
      }
      if (!sameCharacter && charactersMatch) {
        problems.push(`${x} and ${y} differ by digit but were authorised by the SAME character, so the character axis did not move.`);
      }
    }
  }

  return problems;
}


/** Lowercased header lookup, from `rawHeaders` so nothing is folded. */
function headerMap(rawHeaders) {
  const map = new Map();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    map.set(String(rawHeaders[i]).toLowerCase(), rawHeaders[i + 1]);
  }
  return map;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Both limiters' counters off one response, each independently nullable.
 *
 * Reported separately rather than resolved into "which limiter charged this": a
 * response carrying both would be a finding in its own right, and a function
 * that picked one would hide it.
 */
function countersOf(rawHeaders) {
  const map = headerMap(rawHeaders);
  return {
    errorRemain: numberOrNull(map.get("x-esi-error-limit-remain")),
    errorReset: numberOrNull(map.get("x-esi-error-limit-reset")),
    group: map.get("x-ratelimit-group") || null,
    limit: map.get("x-ratelimit-limit") || null,
    remaining: numberOrNull(map.get("x-ratelimit-remaining")),
    used: numberOrNull(map.get("x-ratelimit-used")),
  };
}

/** `600/15m` -> 600. The window half is checked elsewhere and not guessed at. */
function maxFromLimit(limit) {
  if (typeof limit !== "string") return null;
  const [max] = limit.split("/");
  return numberOrNull(max);
}


/**
 * Two readings of one counter, and what the pair can support.
 *
 * `shared` means the second request was charged to the same budget the first
 * left behind. `separate` means it was charged to a fuller one, which on a
 * counter that only goes down inside a window is the signature of a second
 * budget. Everything else is `inconclusive`, a first class outcome: a probe
 * that cannot distinguish has to say so, because the alternative is a wire fact
 * invented from a coin flip.
 */
function interpretCounter({ before, after, cost, max = null, windowRolled = false }) {
  const say = (verdict, why) => ({ verdict, why, before, after, cost });

  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return say("inconclusive", "one of the two readings was not sent, so there is nothing to difference.");
  }
  if (windowRolled) {
    return say("inconclusive", "the limiter's window rolled between the two readings, so they are not comparable. Re-run.");
  }
  if (!Number.isFinite(cost) || cost <= 0) {
    return say("inconclusive", "the charge for the second request could not be read, so neither outcome can be predicted.");
  }
  if (after === before) {
    return say("inconclusive", "the second request was not charged to this limiter at all, so it says nothing about this limiter's key.");
  }
  if (after === before - cost) {
    return say("shared", "the counter continued, so both requests drew from one budget.");
  }
  if (after > before) {
    return say("separate", "the counter read higher than the request before it left it, which inside one window means a second budget.");
  }
  if (Number.isFinite(max) && after === max - cost && before < max - cost) {
    return say("separate", "the counter read a full budget minus this request's own charge, which is a budget nothing had spent from yet.");
  }
  return say("inconclusive", "the counter moved, but by neither the amount a shared budget predicts nor to a value a fresh one does.");
}

/**
 * May this run spend anything at all?
 *
 * Pure, and separate from the probe that feeds it, because it decides whether a
 * real budget on CCP's infrastructure gets touched and so is worth testing.
 *
 * Two refusals rather than one. A counter that could not be read is not a
 * counter that is fine, and a run that cannot see the budget is spending blind
 * whatever the number would have been.
 */
function checkBudget({ remain, minBudget = MIN_ERROR_BUDGET, max = ERROR_LIMIT_MAX }) {
  if (!Number.isFinite(remain)) {
    return {
      ok: false,
      why: "the baseline read carried no X-Esi-Error-Limit-Remain, so the budget cannot be read and a "
        + "run would be spending blind. Pass --baseline-path with a route that sends it.",
    };
  }
  if (remain < minBudget) {
    return {
      ok: false,
      why: `only ${remain} error units remain of ${max} and the floor is ${minBudget}. A counter this far `
        + "down means something else on this address is charging it concurrently, and every delta would be "
        + `measured against a moving baseline. Wait out the ${ERROR_LIMIT_WINDOW_SECONDS}s window and try again.`,
    };
  }
  return { ok: true, remain, why: `${remain} of ${max} error units remain, floor is ${minBudget}.` };
}

/**
 * Which bucket a candidate key would put a cell's charge in.
 *
 * The names are arbitrary; only their equality matters, since the simulation
 * asks whether two cells land in one bucket and never what the bucket is called.
 */
function bucketNameFor(candidate, cell) {
  const application = applicationOf(cell);
  const character = characterOf(cell);
  switch (candidate) {
    case "sourceAddress": return "ip";
    case "applicationAndCharacter": return `app${application}:char${character}`;
    case "characterOnly": return `char${character}`;
    case "applicationOnly": return `app${application}`;
    default: throw new Error(`no bucket rule for candidate ${JSON.stringify(candidate)}`);
  }
}

/**
 * Replay one candidate against the observed readings.
 *
 * Every named bucket starts full, because a credential this address has not
 * used inside the window has spent nothing. The `ip` bucket starts wherever the
 * unauthenticated preamble left it, which is the one value the run measures
 * rather than assumes.
 */
function replay(candidate, { events, max, addressAfter }) {
  const buckets = new Map([["ip", addressAfter]]);

  for (const event of events) {
    const name = event.cell === undefined ? "ip" : bucketNameFor(candidate, event.cell);
    const before = buckets.has(name) ? buckets.get(name) : max;
    const predicted = before - event.cost;
    buckets.set(name, predicted);
    if (event.after !== predicted) {
      return { survives: false, at: event.cell || "ip", predicted, observed: event.after };
    }
  }
  return { survives: true };
}

/**
 * The matrix, read as a verdict rather than as four numbers.
 *
 * Written as a simulation rather than a lookup table of expected sequences,
 * because the readings depend on where the preamble left the address budget and
 * on which cells ran, and a table would have to enumerate both. A partial matrix
 * falls out for free: the surviving candidates are the ones the cells cannot
 * tell apart, and the cell that would split them is the missing one that
 * shrinks the survivor list most.
 */
function classifyMatrix({ events, max, addressAfter, ran = [] }) {
  const survivors = [];
  const rejected = [];

  for (const candidate of KEY_CANDIDATES) {
    const outcome = replay(candidate, { events, max, addressAfter });
    if (outcome.survives) survivors.push(candidate);
    else rejected.push({ candidate, ...outcome });
  }

  const missing = CELLS.filter((cell) => !ran.includes(cell));

  if (survivors.length === 1) {
    return {
      verdict: survivors[0],
      survivors,
      rejected,
      missing,
      why: `exactly one candidate key predicts every reading: ${CANDIDATE_PROSE[survivors[0]]}.`,
    };
  }
  if (survivors.length === 0) {
    return {
      verdict: "inconclusive",
      survivors,
      rejected,
      missing,
      why: "no candidate key predicts these readings. That is itself a finding and worth recording verbatim, "
        + "but it is not one of the four answers, so nothing may be written down as CCP's rule from it.",
    };
  }

  // Which missing cell would help, and by how much. Asked of each one separately:
  // "run everything" is not advice, and the cheapest cell that splits the
  // survivors differs from the last one.
  const splitters = [];
  for (const cell of missing) {
    const distinct = new Set(survivors.map((candidate) => bucketNameFor(candidate, cell)));
    if (distinct.size > 1) splitters.push({ cell, splits: distinct.size, settles: CELL_PURPOSE[cell] });
  }
  splitters.sort((left, right) => right.splits - left.splits);

  return {
    verdict: "inconclusive",
    survivors,
    rejected,
    missing,
    splitters,
    why: `${survivors.length} candidate keys predict these readings identically, so the cells that ran `
      + "cannot tell them apart. Naming one of them would be picking, not observing.",
  };
}


/**
 * Did anything else spend from the address budget while this ran?
 *
 * The unauthenticated preamble is a chain: each reading must be the one before
 * it minus its own charge. A break means somebody else on this address charged
 * the same counter in between, or the window rolled, and every delta measured
 * against it is then measured against a moving baseline. It is reported as
 * contaminated rather than averaged, because an average of a contaminated
 * reading has no referent.
 */
function contaminationOf(preamble) {
  const problems = [];
  for (let i = 1; i < preamble.length; i += 1) {
    const previous = preamble[i - 1];
    const current = preamble[i];
    if (!Number.isFinite(previous.after) || !Number.isFinite(current.after)) {
      problems.push(`reading ${i + 1} of the preamble carried no counter.`);
      continue;
    }
    if (current.after !== previous.after - current.cost) {
      problems.push(
        `the preamble counter went ${previous.after} -> ${current.after} across a charge of `
          + `${current.cost}, so something else spent from this budget in between.`,
      );
    }
    if (Number.isFinite(previous.reset) && Number.isFinite(current.reset) && current.reset > previous.reset) {
      problems.push(
        `Reset went ${previous.reset} -> ${current.reset}, which counts up only when the window rolls. `
          + "Every reading either side of that is in a different window.",
      );
    }
  }
  return problems;
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
 * One probe, printed.
 *
 * The token is not a parameter here, which is the first defence; `scrub` in
 * `say` is the second. Bodies are printed verbatim because every probe is a
 * public route and an error string is protocol, as `observe-authed.js` argues
 * for `error`.
 */
function render(label, method, displayPath, result) {
  const counters = countersOf(result.rawHeaders);
  const out = [];
  out.push("");
  out.push(`-- ${label} ${"-".repeat(Math.max(0, 58 - label.length))}`);
  out.push(`  ${method} ${displayPath}${result.authenticated ? "   (Authorization: Bearer …)" : "   (no Authorization header)"}`);
  out.push(`  -> ${result.status}`);
  out.push("");
  out.push("  Headers, in wire order:");
  out.push(...headerLines(result.rawHeaders));
  out.push("");
  out.push(`  error limiter    Remain ${counters.errorRemain === null ? "(not sent)" : counters.errorRemain}`
    + `   Reset ${counters.errorReset === null ? "(not sent)" : counters.errorReset}`);
  out.push(`  token bucket     ${counters.group === null ? "(not sent)" : `Group ${counters.group}`}`
    + `   ${counters.limit === null ? "" : `Limit ${counters.limit}   `}`
    + `Remaining ${counters.remaining === null ? "(not sent)" : counters.remaining}`
    + `   Used ${counters.used === null ? "(not sent)" : counters.used}`);
  if (result.body.length > 0 && result.body.length < 400) {
    out.push(`  body             ${JSON.stringify(result.body.toString("utf8"))}`);
  } else {
    out.push(`  body             ${result.body.length} bytes, not printed`);
  }
  return out.join("\n");
}


function pkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, state: crypto.randomBytes(16).toString("base64url") };
}


/**
 * A one shot local listener for CCP's redirect.
 *
 * Lifted from `scripts/observe-403.js` with its two details: the server is
 * closed only after the response has flushed, because closing under a writing
 * socket trips a libuv assertion on Windows, and the listener binds both
 * loopback families, because `listen(port, "localhost")` resolves to one of them
 * and a browser that follows the redirect over the other finds nothing.
 */
function awaitCallback(callbackUrl, expectedState) {
  const target = new URL(callbackUrl);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

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
        res.on("finish", () => finish(outcome));
        res.end(`${message}\n`);
      };

      if (error) {
        const described = url.searchParams.get("error_description") || "";
        answer(400, `SSO refused: ${error}`, () => reject(new Error(`SSO returned ${error}: ${described}`)));
        return;
      }
      if (state !== expectedState) {
        // Answered and not settled: a stray request must not end a run the operator has
        // not completed.
        process.stdout.write("  (ignored a callback with the wrong state; still waiting)\n");
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("state mismatch, this is not the redirect this run started\n");
        return;
      }
      if (!code) {
        answer(400, "no code on the callback", () => reject(new Error("the callback carried no authorization code")));
        return;
      }

      answer(200, "Got it. Back to the terminal.", () => resolve(code));
    });

    server.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new Error(
        `could not listen on ${target.host} (${err.code}). `
          + "Pick a free port with --callback and register the same one on both applications.",
      ));
    });

    timer = setTimeout(
      () => finish(() => reject(new Error("timed out waiting for the consent redirect"))),
      CALLBACK_TIMEOUT_MS,
    );
    timer.unref();

    const host = target.hostname === "localhost" ? undefined : target.hostname;
    server.listen(Number(target.port || 80), host);
  });
}

function postForm(url, form) {
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
          "user-agent": USER_AGENT,
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

async function exchange({ code, clientId, verifier, callback }) {
  const response = await postForm(`${SSO_BASE}/v2/oauth/token`, new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    code_verifier: verifier,
    redirect_uri: callback,
  }));

  if (response.status !== 200) {
    const isJson = String(response.contentType).includes("json");
    const detail = isJson
      ? response.text.slice(0, 400)
      : `a ${response.text.length}-byte ${response.contentType} body, not shown`;
    throw new Error(`token exchange failed (${response.status}): ${detail}`);
  }

  const payload = JSON.parse(response.text);
  if (typeof payload.access_token !== "string") {
    throw new Error("token exchange answered 200 without an access_token");
  }
  return payload.access_token;
}

/**
 * `sub` and `azp`, read without verifying.
 *
 * As in `observe-403.js`: this is CCP's own token, fetched from CCP's own
 * endpoint over TLS seconds ago, and nothing here is a security decision. Both
 * values are turned into fingerprints immediately and the raw ones never leave
 * this function's caller.
 *
 * `azp` is the client id, and the open question (D39) is whether that is what
 * `applicationID` means. A claim cannot answer it; the script can only see
 * whether the budget partitions along the axis, which is a different statement
 * and is worded as one in the closing block.
 */
function readClaims(token) {
  const segments = String(token).split(".");
  if (segments.length !== 3) throw new Error("the access token is not a compact JWS");

  const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  const subject = String(payload.sub || "");
  const match = /^CHARACTER:EVE:(\d+)$/i.exec(subject);
  if (!match) throw new Error(`unexpected subject ${JSON.stringify(subject)}`);

  return {
    characterFingerprint: fingerprint(match[1]),
    applicationFingerprint: fingerprint(payload.azp || "(no azp claim)"),
    hasAzp: typeof payload.azp === "string" && payload.azp !== "",
  };
}


/**
 * One request, with the response kept as bytes and the headers unfolded.
 *
 * `nonce` is an undeclared query parameter, which `contract/wire.js`
 * `VALIDATES_UNDECLARED_QUERY_PARAMS` records as ignored by the route, so it
 * costs nothing and changes no status. It defeats an edge cache: a probe
 * answered from a cache never reaches the limiter, and a counter that did not
 * move because nothing charged it looks exactly like one that did not move
 * because a second budget paid.
 */
function probe(pathname, { token = null, nonce = null } = {}) {
  const target = new URL(pathname, ESI_BASE);
  if (nonce !== null) target.searchParams.set("_probe", String(nonce));

  const headers = {
    host: target.hostname,
    accept: "application/json",
    "cache-control": "no-cache",
    "user-agent": USER_AGENT,
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: target.hostname, path: `${target.pathname}${target.search}`, method: "GET", headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode,
          rawHeaders: res.rawHeaders.slice(),
          body: Buffer.concat(chunks),
          authenticated: token !== null,
        }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}


/* eslint-disable-next-line max-statements */
async function run({ args, credentials, state, say }) {
  const spent = { errorUnits: 0, bucketTokens: 0 };
  const charge = (which, amount) => {
    if (!Number.isFinite(amount) || amount <= 0) return;
    spent[which] += amount;
    say(`  spent so far: ${spent.errorUnits} error unit(s), ${spent.bucketTokens} token(s) on the bucket group.`);
  };
  let nonce = 0;

  // Pre-flight

  say("\n\n--- pre-flight ---");
  const baseline = await probe(args.baselinePath, { nonce: (nonce += 1) });
  say(render("budget, read for free (a 200 does not charge)", "GET", args.baselinePath, baseline));

  const start = countersOf(baseline.rawHeaders);
  const allowed = checkBudget({ remain: start.errorRemain, minBudget: args.minBudget });
  if (!allowed.ok) throw new Error(`refusing to run: ${allowed.why}`);
  say(`\n  ${allowed.why} Proceeding.`);
  say(`  This run will spend ${2 + credentials.length} error unit(s) and ${2 * (2 + credentials.length)} bucket token(s).`);

  // Q2, the error limiter

  say("\n\n--- Q2 · one budget or two? (error limiter) ---");
  say("  Two deliberate errors unauthenticated, then one authenticated per cell, all on the same");
  say("  path from the same address. Only the Authorization header differs.");

  const preamble = [];
  for (let i = 0; i < 2; i += 1) {
    const result = await probe(args.errorPath, { nonce: (nonce += 1) });
    const counters = countersOf(result.rawHeaders);
    say(render(`unauthenticated error ${i + 1}`, "GET", args.errorPath, result));
    const previous = preamble.length === 0 ? start.errorRemain : preamble[preamble.length - 1].after;
    const cost = Number.isFinite(counters.errorRemain) && Number.isFinite(previous)
      ? Math.max(1, previous - counters.errorRemain)
      : 1;
    preamble.push({ after: counters.errorRemain, reset: counters.errorReset, cost });
    charge("errorUnits", 1);
  }

  const contamination = contaminationOf([
    { after: start.errorRemain, reset: start.errorReset, cost: 0 },
    ...preamble,
  ]);
  if (contamination.length > 0) {
    say("\n  !! CONTAMINATED. Every reading below is measured against a baseline that moved:");
    contamination.forEach((problem) => say(`     ${problem}`));
    say("     Nothing from this run may be recorded. Re-run on a quiet address.");
  }

  const addressAfter = preamble[preamble.length - 1].after;
  const errorEvents = [];
  const errorReadings = {};

  for (const credential of credentials) {
    const result = await probe(args.errorPath, { token: credential.token, nonce: (nonce += 1) });
    const counters = countersOf(result.rawHeaders);
    say(render(`AUTHENTICATED error · cell ${credential.cell}`, "GET", args.errorPath, result));
    say(`  cell ${credential.cell}: application ${applicationOf(credential.cell)} fingerprint `
      + `${credential.claims.applicationFingerprint}, character ${characterOf(credential.cell)} fingerprint `
      + `${credential.claims.characterFingerprint}`);

    // The cost is read off the response rather than assumed, so a route whose
    // charge differs from the survey's does not silently break the arithmetic.
    const cost = 1;
    errorEvents.push({ cell: credential.cell, after: counters.errorRemain, cost });
    errorReadings[credential.cell] = { remain: counters.errorRemain, reset: counters.errorReset, cost };
    charge("errorUnits", 1);
  }

  // The window guard. A rollover anywhere in the sequence voids the lot.
  const resets = [start.errorReset, ...preamble.map((r) => r.reset), ...credentials.map((c) => errorReadings[c.cell].reset)];
  let windowRolled = false;
  for (let i = 1; i < resets.length; i += 1) {
    if (Number.isFinite(resets[i]) && Number.isFinite(resets[i - 1]) && resets[i] > resets[i - 1]) windowRolled = true;
  }

  const q2 = interpretCounter({
    before: addressAfter,
    after: errorReadings[credentials[0].cell].remain,
    cost: 1,
    max: ERROR_LIMIT_MAX,
    windowRolled,
  });

  say("");
  say(`  Q2 VERDICT (error limiter): ${q2.verdict.toUpperCase()}`);
  say(`    ${q2.why}`);
  say(`    unauthenticated left the counter at ${q2.before}; cell ${credentials[0].cell} read ${q2.after}.`);
  if (windowRolled) say("    Reset counted up during the run, so the window rolled. Re-run; nothing here is comparable.");

  // Q3, the token bucket

  say("\n\n--- Q3 · do the two limiters agree? (token bucket) ---");
  say("  The same pairing against a route the token bucket owns. Read x-ratelimit-remaining,");
  say("  never the error headers, and never infer this answer from Q2's: they are separate");
  say("  limiters and this project has already been caught assuming they agree.");

  const bucketPreamble = [];
  let bucketMax = null;
  let bucketGroup = null;

  for (let i = 0; i < 2; i += 1) {
    const result = await probe(args.bucketPath, { nonce: (nonce += 1) });
    const counters = countersOf(result.rawHeaders);
    say(render(`unauthenticated bucket probe ${i + 1}`, "GET", args.bucketPath, result));
    bucketMax = bucketMax === null ? maxFromLimit(counters.limit) : bucketMax;
    bucketGroup = bucketGroup === null ? counters.group : bucketGroup;
    bucketPreamble.push({ after: counters.remaining, reset: null, cost: counters.used === null ? 0 : counters.used });
    charge("bucketTokens", counters.used === null ? 0 : counters.used);
  }

  const bucketEvents = [];
  const bucketReadings = {};
  for (const credential of credentials) {
    const result = await probe(args.bucketPath, { token: credential.token, nonce: (nonce += 1) });
    const counters = countersOf(result.rawHeaders);
    say(render(`AUTHENTICATED bucket probe · cell ${credential.cell}`, "GET", args.bucketPath, result));
    const cost = counters.used === null ? 0 : counters.used;
    bucketEvents.push({ cell: credential.cell, after: counters.remaining, cost });
    bucketReadings[credential.cell] = { remaining: counters.remaining, used: counters.used, group: counters.group };
    charge("bucketTokens", cost);
  }

  const bucketAddressAfter = bucketPreamble[bucketPreamble.length - 1].after;
  const groupsAgree = credentials.every((c) => bucketReadings[c.cell].group === bucketGroup);

  const q3 = groupsAgree
    ? interpretCounter({
      before: bucketAddressAfter,
      after: bucketReadings[credentials[0].cell].remaining,
      cost: bucketEvents[0].cost,
      max: bucketMax,
    })
    : {
      verdict: "inconclusive",
      why: "the authenticated probe was charged to a different x-ratelimit-group than the unauthenticated one, "
        + "so the two readings are not two readings of one counter.",
      before: bucketAddressAfter,
      after: bucketReadings[credentials[0].cell].remaining,
    };

  say("");
  say(`  Q3 VERDICT (token bucket, group ${bucketGroup || "(not sent)"}): ${q3.verdict.toUpperCase()}`);
  say(`    ${q3.why}`);
  say(`    unauthenticated left it at ${q3.before}; cell ${credentials[0].cell} read ${q3.after}.`);
  say("");
  say(`  Do the two limiters agree? Q2 said ${q2.verdict}, Q3 said ${q3.verdict}. `
    + `${q2.verdict === q3.verdict && q2.verdict !== "inconclusive" ? "They agree on this run." : "Read them separately."}`);

  // Q1, the matrix

  say("\n\n--- Q1 · which half of the key moves? (the 2x2) ---");

  const cellsRan = credentials.map((c) => c.cell);
  const fingerprints = {};
  for (const credential of credentials) {
    fingerprints[credential.cell] = {
      applicationFingerprint: credential.claims.applicationFingerprint,
      characterFingerprint: credential.claims.characterFingerprint,
    };
  }

  const problems = checkMatrixConsistency(fingerprints);
  if (problems.length > 0) {
    say("\n  !! The cells did not move the axes they claim to:");
    problems.forEach((problem) => say(`     ${problem}`));
    say("     The matrix below is not readable. Re-run with the right accounts at the right screens.");
  }

  const errorMatrix = classifyMatrix({
    events: errorEvents,
    max: ERROR_LIMIT_MAX,
    addressAfter,
    ran: cellsRan,
  });
  const bucketMatrix = bucketMax === null || !groupsAgree
    ? null
    : classifyMatrix({ events: bucketEvents, max: bucketMax, addressAfter: bucketAddressAfter, ran: cellsRan });

  const renderMatrix = (label, matrix) => {
    say("");
    say(`  ${label}: ${String(matrix.verdict).toUpperCase()}`);
    say(`    ${matrix.why}`);
    if (matrix.survivors.length > 1) {
      say("    still standing:");
      matrix.survivors.forEach((candidate) => say(`      ${candidate}: ${CANDIDATE_PROSE[candidate]}`));
    }
    if (matrix.rejected.length > 0) {
      say("    ruled out by a reading:");
      matrix.rejected.forEach((entry) => say(
        `      ${entry.candidate}: predicted ${entry.predicted} at ${entry.at}, observed ${entry.observed}`,
      ));
    }
    if (matrix.splitters && matrix.splitters.length > 0) {
      say("    the cells that would split what is left:");
      matrix.splitters.forEach((entry) => say(`      --cell ${entry.cell}: ${entry.settles}`));
    }
    if (matrix.missing.length > 0 && (!matrix.splitters || matrix.splitters.length === 0)) {
      say(`    cells not run: ${matrix.missing.join(", ")}`);
    }
  };

  renderMatrix("Q1 on the error limiter", errorMatrix);
  if (bucketMatrix === null) {
    say("");
    say("  Q1 on the token bucket: INCONCLUSIVE");
    say("    the bucket probes carried no readable limit or no consistent group, so there is nothing to replay.");
  } else {
    renderMatrix("Q1 on the token bucket", bucketMatrix);
  }

  say("");
  say("  What the matrix CANNOT say, however complete it is: it says which half of the key moves the");
  say("  budget. It does not say what applicationID IS on the wire. The client id from the token's azp");
  say("  and the registered application's own numeric id are different things, and a budget that");
  say("  partitions by application partitions identically under either. Nothing observed here chooses");
  say("  between them, and the first question stays open on that half until something does.");

  // State

  state.runs.push({
    at: Date.now(),
    cells: cellsRan,
    fingerprints,
    contaminated: contamination.length > 0 || windowRolled || problems.length > 0,
    errorLimit: {
      max: ERROR_LIMIT_MAX,
      addressAfter,
      cells: errorReadings,
      verdict: errorMatrix.verdict,
      q2: q2.verdict,
    },
    tokenBucket: {
      group: bucketGroup,
      max: bucketMax,
      addressAfter: bucketAddressAfter,
      cells: bucketReadings,
      verdict: bucketMatrix === null ? "inconclusive" : bucketMatrix.verdict,
      q3: q3.verdict,
    },
  });
  writeState(args.statePath, state);
  say(`\n  Recorded in ${args.statePath}. It holds fingerprints and counters, never a token and never an id.`);

  // What this settles

  const still = missingCells(state);

  say(`

${"-".repeat(72)}
WHAT THIS SETTLES

  spent             ${spent.errorUnits} error unit(s) of ${ERROR_LIMIT_MAX}, ${spent.bucketTokens} token(s) of ${bucketMax === null ? "?" : bucketMax} on group ${bucketGroup || "?"}
  Q2  budgets       ${q2.verdict}. ${q2.why}
  Q3  agreement     ${q3.verdict} on the token bucket. Read against Q2 by hand; the two limiters are
                    separate mechanisms and nothing here derives one from the other.
  Q1  which half    error limiter: ${errorMatrix.verdict}${bucketMatrix === null ? "" : `; token bucket: ${bucketMatrix.verdict}`}
  cells still open  ${still.length === 0 ? "none" : still.map((cell) => `${cell} (${CELL_PURPOSE[cell]})`).join("; ")}

  A verdict of "inconclusive" is an answer and is the one to record when it is
  what came back. contract/wire.js LIMITER_UNOBSERVED.errorLimitKeyQuestions is
  where these three live until one of them is closed; a row moves out of it only
  when a run like this produced a single surviving candidate on a clean window.

  Do NOT change lib/errorLimiter.js keyFor or lib/rateLimiter.js from a partial
  matrix. The failure mode of waiting is a client sharing a budget it should
  have had to itself; the failure mode of guessing is a key nobody has seen.
  Record the outcome as D39 in docs/open-decisions.md either way.
`);
}


async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(`${err.message}`);
    return;
  }

  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  if (args.forget) {
    try {
      fs.unlinkSync(args.statePath);
      process.stdout.write(`\nForgot ${args.statePath}.\n`);
    } catch {
      process.stdout.write(`\nNothing to forget at ${args.statePath}.\n`);
    }
    return;
  }

  const state = readState(args.statePath);

  if (args.show) {
    const still = missingCells(state);
    process.stdout.write(`\n${args.statePath}\n`);
    process.stdout.write(`  runs recorded: ${state.runs.length}\n`);
    for (const record of state.runs) {
      process.stdout.write(
        `  ${new Date(record.at).toISOString()}  cells ${record.cells.join(",")}`
          + `  errorLimit ${record.errorLimit.verdict}  tokenBucket ${record.tokenBucket.verdict}`
          + `${record.contaminated ? "  (CONTAMINATED)" : ""}\n`,
      );
    }
    process.stdout.write(still.length === 0
      ? "  every cell has been visited at least once.\n"
      : `  never visited: ${still.map((cell) => `${cell} (${CELL_PURPOSE[cell]})`).join("; ")}\n`);
    process.stdout.write(
      "\n  Cells from separate invocations are recorded but not differenced across on the error\n"
        + `  limiter: its window is ${ERROR_LIMIT_WINDOW_SECONDS}s and a consent round is not. Authorise every cell you\n`
        + "  want compared inside one invocation.\n\n",
    );
    return;
  }

  // Consent first, every cell, before a single probe. Probes measure a 60 second
  // window and consents take minutes, so the minutes all happen up front and the
  // window contains only the probes.
  const credentials = [];
  const secrets = [];

  process.stdout.write(`
observe-limiter-key: the capture behind D39.

  ${args.cells.length} consent screen(s), then every probe fires back to back.
  Authorise each one as the character its cell names:

${args.cells.map((cell) => `    ${cell}   application ${applicationOf(cell)}, character ${characterOf(cell)}   (${CELL_PURPOSE[cell]})`).join("\n")}

  Nothing is charged until every one of them is done.
`);

  for (const cell of args.cells) {
    const clientId = applicationOf(cell) === "A" ? args.clientIdA : args.clientIdB;
    const { verifier, challenge, state: csrf } = pkce();

    const authorize = new URL(`${SSO_BASE}/v2/oauth/authorize/`);
    // No `scope` at all. Every probe is a public route, so a scopeless token is as
    // authenticated as a scoped one for this question, and asking for nothing means
    // the second application needs no particular permission ticked to take part.
    authorize.search = new URLSearchParams({
      response_type: "code",
      redirect_uri: args.callback,
      client_id: clientId,
      state: csrf,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

    process.stdout.write(`
  -- cell ${cell}: application ${applicationOf(cell)}, character ${characterOf(cell)} --

  Open this and authorise it as character ${characterOf(cell)}:

${authorize.href}

  Waiting for ${args.callback} …
`);

    const code = await awaitCallback(args.callback, csrf);
    const token = await exchange({ code, clientId, verifier, callback: args.callback });
    const claims = readClaims(token);
    credentials.push({ cell, token, claims });
    secrets.push(token);

    process.stdout.write(
      `  cell ${cell} held. application ${claims.applicationFingerprint}, character ${claims.characterFingerprint}`
        + `${claims.hasAzp ? "" : "  (no azp claim; the application fingerprint is a placeholder)"}\n`,
    );
  }

  process.stdout.write("\n  Every token is in memory only. None is printed, none is written, none is stored.\n");

  // Everything from here goes through `scrub`, the last line of defence: no
  // printing path takes a token as an argument in the first place.
  const say = (text) => process.stdout.write(`${scrub(text, secrets)}\n`);

  await run({ args, credentials, state, say });
}

if (require.main === module) {
  main().catch((err) => {
    fail(err.message);
    process.exitCode = 1;
  });
}

// Exported for `test/observeLimiterKey.test.js`. The interpretation functions
// decide whether a run reports a wire fact or reports that it could not tell,
// and getting that wrong is how a guess ends up in contract/wire.js wearing an
// observation's clothes. `scrub` is exported for the reason `observe-authed.js`
// exports `shapeOf`: it stands between a live token and a terminal.
module.exports = Object.freeze({
  CELLS,
  CELL_PURPOSE,
  ERROR_LIMIT_MAX,
  ERROR_LIMIT_WINDOW_SECONDS,
  KEY_CANDIDATES,
  MIN_ERROR_BUDGET,
  TOKEN_BUCKET_WINDOW_SECONDS,
  USAGE,
  applicationOf,
  bucketNameFor,
  characterOf,
  checkBudget,
  checkMatrixConsistency,
  classifyMatrix,
  contaminationOf,
  countersOf,
  fingerprint,
  headerLines,
  interpretCounter,
  main,
  maxFromLimit,
  missingCells,
  parseArgs,
  render,
  replay,
  scrub,
});
