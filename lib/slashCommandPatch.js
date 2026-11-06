/**
 * eve.js-mod-esi: the `/esi <code>` bind command and the SlashService patch (D3).
 *
 * The in-game half of the authorization-code grant. A browser can lie about
 * being a given character; it cannot type into that character's chat window.
 *
 * Port of `nexumApi`'s three files (`slashCommandPatch.js`, `bindCommand.js`,
 * `bindRedemption.js`) folded into one. The third was a placeholder for a store
 * that did not yet exist; here the redeemer is an injected argument. The other
 * two are one file because everything below the parse exists to make sure an
 * intercepted `/esi` never falls through.
 *
 * Why wrap the prototype method and not `executeChatCommand`:
 * `services/admin/slashService.js` destructures `executeChatCommand` at require
 * time, so by the time any mod can touch the exports object `SlashService`
 * already holds the original function and replacing the export changes nothing.
 * Wrapping `SlashService.prototype.Handle_SlashCmd` intercepts one level up.
 *
 * Why an intercepted `/esi` never falls through: other failures in this file
 * pass the command to the original handler, but for `/esi` that would leak the
 * code. The vendor's `Handle_SlashCmd` writes the whole command line to
 * `log.debug` and to `logs/slash-debug.log` before dispatching, and ends by
 * echoing `Unknown command: /esi <code>. Use /help.` into chat through
 * `chatHub.sendSystemMessage`. A live bind code is a bearer credential. Once the
 * command is recognised as ours it is ours, success or failure, and failure
 * gets a generic sentence.
 *
 * The code never appears in a reply or a log. Chat messages pass through the
 * server's chat plumbing and, for some channel types, other characters; logs
 * are readable by anyone who can read the container's stdout. `scrubCode`
 * removes it from anything a downstream module produced, message and stack
 * alike, and `test/slashCommandPatch.test.js` asserts its absence on every path.
 *
 * Every path replies. The player is watching a browser wait for a change, and
 * silence after a typo, an expired code or a used code is indistinguishable from
 * "still working". No branch returns without a message.
 *
 * Everything is injected. This module requires no game code, so the test can
 * patch a fake SlashService class. The chat reply goes through
 * `runtimeAccess.sendChatSystemMessage`, handed in by the wiring, because
 * `lib/runtimeAccess.js` is the only module allowed to require game code.
 */

"use strict";

const {
  IDENTITY_FAILURE,
  describeIdentity,
  extractSessionIdentity,
} = require("./sessionIdentity");

// The command name
// One name, no aliases. `/bind`, `/link` and `/auth` are generic enough that
// another mod on the same server may want them; `/esi` says which mod it
// belongs to, like the other names this mod owns (`mod:esiApi`, `ESI_MOD_*`,
// `<eve.js tree>/mods/esiApi/`). Checked against upstream's `AVAILABLE_SLASH_COMMANDS`
// on 2026-08-24: no collision.
const BIND_COMMAND_NAMES = Object.freeze(["esi"]);

const BIND_HELP_LINE = "/esi <code>: finish signing in to a tool with this character";

// Marks a prototype this mod has already wrapped. Node's module cache makes a
// second patch unlikely, but a double wrap would run the handler twice and send
// the player two replies.
const PATCH_FLAG = "__esiApiSlashPatched";

const MAX_TEXT_DEPTH = 6;

// The status vocabulary
// Closed set. `STATUS_MESSAGES` maps each one to a sentence for the player, so
// an unrecognised status must degrade to something safe rather than reaching
// the client as a raw enum name.
const REDEMPTION_STATUS = Object.freeze({
  OK: "ok",
  UNKNOWN: "unknown",
  EXPIRED: "expired",
  USED: "used",
  UNAVAILABLE: "unavailable",
  ERROR: "error",
});

const KNOWN_STATUSES = Object.freeze(Object.values(REDEMPTION_STATUS));

// Shape of a bind code
// Checked here rather than left to the store. A string that cannot be a code
// gets an immediate, specific reply and never reaches the store, which answers
// "did anything match?" by touching state and spending a rate-limit token.
//
// The character class is the base64url alphabet minus padding, which covers
// anything a `randomBytes` generator could emit. Four to sixty-four characters:
// long enough to exclude single-letter typos, loose enough that
// `lib/bindCodes.js` can change its length without changing this line. This is
// a permissive syntax gate, not `isBindCodeShape` (the exact set the generator
// emits); keeping them separate lets each pick its constraints independently.
// `test/bindCodes.test.js` asserts a generated code always satisfies this one,
// so they cannot drift into a code that mints and never redeems.
const BIND_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;

// Reserved words
// `/esi help` is help, not a bind code, even though "help" satisfies the
// pattern above. `lib/bindCodes.js` bears the cost: its alphabet has no
// lowercase letters and no L, so neither "help" nor "HELP" nor "?" can be
// generated, and the test asserts it.
const RESERVED_SUBCOMMANDS = Object.freeze(["help", "?"]);

// Player-facing copy
// One table, because it is the entire user interface of this feature. Each line
// says what happened and what to do next. None contains the code (see the
// header).
const STATUS_MESSAGES = Object.freeze({
  [REDEMPTION_STATUS.OK]:
    "ESI SSO: character verified. Your browser should continue within a few seconds.",
  [REDEMPTION_STATUS.UNKNOWN]:
    "ESI SSO: that code was not recognised. Check it for typos, or start the sign-in again.",
  [REDEMPTION_STATUS.EXPIRED]:
    "ESI SSO: that code has expired. Start the sign-in again and type the new code.",
  [REDEMPTION_STATUS.USED]:
    "ESI SSO: that code has already been used. Start the sign-in again.",
  [REDEMPTION_STATUS.UNAVAILABLE]:
    "ESI SSO: signing in is not available on this server right now. Ask an administrator.",
  [REDEMPTION_STATUS.ERROR]:
    "ESI SSO: sign-in failed. The server could not complete the request. Try again shortly.",
});

const USAGE_MESSAGE = [
  "ESI SSO: no code given.",
  "Usage: /esi <code>",
  "Start the sign-in in your browser and type the code it shows you here.",
].join("\n");

const MALFORMED_MESSAGE = [
  "ESI SSO: that does not look like a sign-in code.",
  "Usage: /esi <code>  (one word, letters and digits)",
  "Copy the code from the browser exactly as it is shown.",
].join("\n");

const HELP_MESSAGE = [
  "ESI SSO: sign in to a third-party tool with this character",
  BIND_HELP_LINE,
  "The code is one-time and short-lived. Start the sign-in in your browser, then type it here.",
].join("\n");

const IDENTITY_FAILURE_MESSAGES = Object.freeze({
  [IDENTITY_FAILURE.NO_SESSION]:
    "ESI SSO: your session could not be identified. Try again, or relog.",
  [IDENTITY_FAILURE.NO_CHARACTER]:
    "ESI SSO: no character is selected. Enter the game with a character, then run /esi again.",
});

// Text extraction
// A copy of `textValue` / `extractCommand` in `services/admin/slashService.js`.
// Copied rather than required because only `lib/runtimeAccess.js` may require
// game code; the shapes it walks are EVE marshal structures fixed by the client
// protocol, not by this server's source.
//
// `MAX_TEXT_DEPTH` bounds the walk. These structures arrive from the network,
// and a `substream` whose value is itself would be a denial of service against
// the event loop the universe ticks on.
function extractTextValue(value, depth = 0) {
  if (depth > MAX_TEXT_DEPTH) return "";

  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");

  if (
    value
    && typeof value === "object"
    && (value.type === "wstring" || value.type === "token")
  ) {
    return extractTextValue(value.value, depth + 1);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractTextValue(item, depth + 1).trim();
      if (extracted) return extracted;
    }
    return "";
  }

  if (value && typeof value === "object") {
    if (value.type === "substream" || value.type === "substruct") {
      return extractTextValue(value.value, depth + 1);
    }
    if (value.type === "list" && Array.isArray(value.items)) {
      return extractTextValue(value.items, depth + 1);
    }
    if (value.type === "dict" && Array.isArray(value.entries)) {
      for (const [, entryValue] of value.entries) {
        const extracted = extractTextValue(entryValue, depth + 1).trim();
        if (extracted) return extracted;
      }
      return "";
    }
  }

  if (value === null || value === undefined) return "";
  return String(value);
}

function extractCommandText(args, kwargs) {
  const fromArgs = extractTextValue(args).trim();
  if (fromArgs) return fromArgs;
  return extractTextValue(kwargs).trim();
}

// Command parsing
// Both `/esi` and `.esi` reach the server; the client accepts either prefix and
// passes the text through unchanged. The name is normalised as the game
// normalises it, so `/ESI` and `/esi!` both match.
function parseSlashCommand(rawText) {
  const text = String(rawText === undefined || rawText === null ? "" : rawText).trim();
  if (!text) return null;

  const body = text.startsWith("/") || text.startsWith(".") ? text.slice(1).trim() : text;
  if (!body) return null;

  const [head, ...rest] = body.split(/\s+/);
  const name = head.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if (!name) return null;

  return { name, argumentText: rest.join(" ").trim() };
}

/**
 * The parsed command when it is ours, `null` when it is not.
 *
 * Null is the overwhelmingly common answer (every slash command on the server
 * goes through here), so this must be cheap and must never throw on input it
 * does not understand. A prefix match is not a match: `/esilog` is somebody
 * else's command.
 */
function matchBindCommand(args, kwargs) {
  const parsed = parseSlashCommand(extractCommandText(args, kwargs));
  if (!parsed) return null;
  return BIND_COMMAND_NAMES.includes(parsed.name) ? parsed : null;
}

// Scrubbing

/**
 * Replace every occurrence of the code with a placeholder.
 *
 * Exact, and needs no cooperation from the code that produced the string: the
 * store, the token layer and anything they call may quote the request, and the
 * request contains the code.
 */
function scrubCode(text, code) {
  const asText = String(text);
  if (typeof code !== "string" || code === "") return asText;
  return asText.split(code).join("<code>");
}

/**
 * A copy of `err` with the code removed from the message and the stack.
 *
 * `loader.js`'s `logError` prints `err.stack`, and a rejected promise's stack
 * routinely carries the argument that caused it. Copying rather than mutating
 * leaves the original error intact for whoever else holds it.
 */
function scrubErrorForLog(err, code) {
  if (!err) return null;
  const scrubbed = new Error(scrubCode(String((err && err.message) || err), code));
  scrubbed.name = (err && err.name) || "Error";
  scrubbed.stack = scrubCode(String((err && err.stack) || scrubbed.stack || ""), code);
  return scrubbed;
}

/**
 * The first token of the argument text, when there is one.
 *
 * It is the only string in this file that must never be logged, so it is pulled
 * out once and handed to the scrubber.
 */
function firstToken(argumentText) {
  const tokens = String(argumentText || "").trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 ? tokens[0] : "";
}

// Result normalisation
/**
 * Whatever the injected redeemer returns, this layer gets `{ status, message }`
 * with a status from the closed set.
 *
 * A store that returns `undefined`, a bare string, or an unknown status must not
 * produce a confusing reply or a crash.
 */
function normalizeRedemptionResult(value) {
  if (value === null || typeof value !== "object") {
    return { status: REDEMPTION_STATUS.ERROR, message: null };
  }

  const rawStatus = Object.prototype.hasOwnProperty.call(value, "status")
    ? String(value.status).trim().toLowerCase()
    : "";
  const status = KNOWN_STATUSES.includes(rawStatus) ? rawStatus : REDEMPTION_STATUS.ERROR;

  const rawMessage = Object.prototype.hasOwnProperty.call(value, "message")
    ? value.message
    : null;
  const message =
    typeof rawMessage === "string" && rawMessage.trim() !== "" ? rawMessage.trim() : null;

  return { status, message };
}

/** The sentence for a status, or an override the store supplied. */
function messageForStatus(status, override) {
  if (typeof override === "string" && override !== "") return override;
  return STATUS_MESSAGES[status] || STATUS_MESSAGES[REDEMPTION_STATUS.ERROR];
}

// Result helper
// The shape the game's own chat commands return, so the SlashService patch can
// treat ours and theirs alike, plus one optional field.
//
// `error` exists because this module swallows every failure (the player must
// get a sentence, not a stack trace), and swallowing without handing the error
// somewhere would make a broken store invisible. The caller logs it, after
// scrubbing the code out.
function handledResult(message, error = null) {
  return error ? { handled: true, message, error } : { handled: true, message };
}

/** Turn a settled redemption into a reply, with the code scrubbed out of it. */
function replyForRedemption(value, code) {
  const normalized = normalizeRedemptionResult(value);
  const override = normalized.message ? scrubCode(normalized.message, code) : null;
  return handledResult(messageForStatus(normalized.status, override));
}

// The handler
/**
 * What the player typed, what they get back, and nothing else.
 *
 * Returns `{ handled: true, message }` for anything decidable without touching
 * the store, and a Promise of the same once the store is involved. The mixed
 * return is intentional: a typo gets an answer in the same tick, and the caller
 * already copes with a thenable because the game's own `Handle_SlashCmd`
 * returns them.
 *
 * deps:
 *   redeemBindCode(request) -> { status, message? } | Promise<same>
 *
 * The request handed to the redeemer is exactly the store's `claim` argument:
 *   { code, characterID, accountID, role, isGM }
 *
 * Rules the redeemer must hold to, and which this file defends against anyway:
 *   1. Never throw for an expected outcome: unknown, expired and already-used
 *      are a `status`, not an exception. A throw is caught and reported as
 *      `error`, but costs the player a useful message.
 *   2. Never put the code in `message`. `scrubCode` removes it regardless; that
 *      is defence in depth, not permission.
 *   3. Never log the code.
 */
function handleBindCommand(session, argumentText, deps = {}) {
  const tokens = String(argumentText === undefined || argumentText === null ? "" : argumentText)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) return handledResult(USAGE_MESSAGE);

  if (RESERVED_SUBCOMMANDS.includes(tokens[0].toLowerCase())) {
    return handledResult(HELP_MESSAGE);
  }

  // More than one token is a pasted sentence or a code with a space in it.
  // Neither is redeemable, and guessing which token is the code would send a
  // fragment of the player's chat to the store.
  if (tokens.length > 1 || !BIND_CODE_PATTERN.test(tokens[0])) {
    return handledResult(MALFORMED_MESSAGE);
  }

  const code = tokens[0];

  // Identity is checked after the code, not before: a player who mistypes the code
  // should hear about the typo, not about their session.
  const identityResult = extractSessionIdentity(session);
  if (!identityResult.ok) {
    return handledResult(
      IDENTITY_FAILURE_MESSAGES[identityResult.reason]
        || IDENTITY_FAILURE_MESSAGES[IDENTITY_FAILURE.NO_SESSION],
    );
  }

  const identity = identityResult.identity;
  const request = Object.freeze({
    code,
    characterID: identity.characterID,
    accountID: identity.accountID,
    role: identity.role,
    isGM: identity.isGM,
  });

  const redeem = typeof deps.redeemBindCode === "function" ? deps.redeemBindCode : null;
  if (!redeem) {
    // No store wired up at all. This is a wiring bug where "unavailable" is a store
    // state, but the player can do nothing about either, so they get the same
    // sentence.
    return handledResult(messageForStatus(REDEMPTION_STATUS.UNAVAILABLE));
  }

  let outcome;
  try {
    outcome = redeem(request);
  } catch (err) {
    // A redeemer that throws synchronously. The error text is never shown to the
    // player (it may quote the request, which contains the code) but travels back
    // for the caller to log and scrub.
    return handledResult(messageForStatus(REDEMPTION_STATUS.ERROR), err);
  }

  if (outcome && typeof outcome.then === "function") {
    return outcome.then(
      (settled) => replyForRedemption(settled, code),
      (err) => handledResult(messageForStatus(REDEMPTION_STATUS.ERROR), err),
    );
  }

  return replyForRedemption(outcome, code);
}

// The patch
/**
 * Wrap `SlashService.prototype.Handle_SlashCmd`.
 *
 * deps:
 *   redeemBindCode(request)          the store adapter; see `handleBindCommand`
 *   sendSystemMessage(session, text) delivers the reply in game
 *   log(message)                     never called with a code
 *   logError(message, err)           never called with a code
 *
 * Returns true when it patched, false when the prototype was already patched.
 * Throws when handed something that is not a SlashService; `loader.js`'s hook
 * loop catches that and logs it, and the game server is unaffected.
 */
function patchSlashService(SlashServiceClass, deps = {}) {
  if (
    typeof SlashServiceClass !== "function"
    || !SlashServiceClass.prototype
    || typeof SlashServiceClass.prototype.Handle_SlashCmd !== "function"
  ) {
    throw new Error(
      "ESI mod: SlashService has no Handle_SlashCmd to patch: the game module changed shape.",
    );
  }

  if (Object.prototype.hasOwnProperty.call(SlashServiceClass.prototype, PATCH_FLAG)) {
    return false;
  }

  const originalHandleSlashCmd = SlashServiceClass.prototype.Handle_SlashCmd;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const logError = typeof deps.logError === "function" ? deps.logError : () => {};
  const sendSystemMessage =
    typeof deps.sendSystemMessage === "function" ? deps.sendSystemMessage : null;
  const redeemBindCode =
    typeof deps.redeemBindCode === "function" ? deps.redeemBindCode : null;

  SlashServiceClass.prototype.Handle_SlashCmd = function esiApiHandleSlashCmd(
    args,
    session,
    kwargs,
  ) {
    // Is it ours?
    // Outside the main try/catch: if inspection itself fails we know nothing about
    // the command, so the only safe answer is the original handler. This runs in
    // front of every slash command on the server, and a mod that can break `/help`
    // for everyone has failed harder than one that cannot bind a character.
    let parsed = null;
    try {
      parsed = matchBindCommand(args, kwargs);
    } catch (err) {
      logError("could not inspect a slash command, passing it through", err);
      parsed = null;
    }

    if (!parsed) {
      return originalHandleSlashCmd.call(this, args, session, kwargs);
    }

    // From here it is ours, whatever happens
    const code = firstToken(parsed.argumentText);

    const reply = (message) => {
      if (!message) return null;
      try {
        if (sendSystemMessage) sendSystemMessage(session, message);
      } catch (err) {
        logError("could not deliver the /esi reply in game", scrubErrorForLog(err, code));
      }
      return message;
    };

    // `handleBindCommand` answers the player on every path and never throws, so a
    // broken store would otherwise be invisible. It hands the swallowed error back
    // on `outcome.error` for this.
    const settle = (outcome) => {
      if (outcome && outcome.error) {
        logError(
          "the /esi bind store failed: the player was told to try again",
          scrubErrorForLog(outcome.error, code),
        );
      }
      return reply(outcome && outcome.message);
    };

    try {
      const identityResult = extractSessionIdentity(session);
      log(
        `/esi from ${
          identityResult.ok ? describeIdentity(identityResult.identity) : "an unidentified session"
        }`,
      );

      const outcome = handleBindCommand(session, parsed.argumentText, { redeemBindCode });

      if (outcome && typeof outcome.then === "function") {
        // The game's own `Handle_SlashCmd` returns thenables too, so the macho layer
        // copes. The reply also goes over chat, the channel the player reads.
        return outcome.then(settle, (err) => {
          logError(
            "the /esi handler rejected, replying with a generic failure",
            scrubErrorForLog(err, code),
          );
          return reply(messageForStatus(REDEMPTION_STATUS.ERROR));
        });
      }

      return settle(outcome);
    } catch (err) {
      // design constraint 2 at the finest grain: a throw anywhere in the bind
      // path costs the player one command, not the slash system.
      logError(
        "the /esi handler threw, replying with a generic failure",
        scrubErrorForLog(err, code),
      );
      return reply(messageForStatus(REDEMPTION_STATUS.ERROR));
    }
  };

  SlashServiceClass.prototype[PATCH_FLAG] = true;
  return true;
}

// Command registration
/**
 * Put the command name where the client can see it.
 *
 * The client refuses to send a slash command it has not been told about, so the
 * name must appear in `AVAILABLE_SLASH_COMMANDS`. That is the only reason the
 * mod attaches to `chatCommands`; dispatch happens in the SlashService patch.
 *
 * `COMMANDS_HELP_TEXT` is a `const` inside `chatCommands` and `/help` renders
 * the module-local copy, so appending to the export is cosmetic for now. It is
 * done anyway for anything that reads the export. Upstream joins it into a
 * string; the array branch is for a vendor drop that stops doing so.
 *
 * An inherited `AVAILABLE_SLASH_COMMANDS` is refused: a half-built circular
 * require must not look usable (the rule `lib/exportProbe.js` enforces).
 */
function registerBindCommands(chatCommandsExports) {
  if (
    chatCommandsExports === null
    || typeof chatCommandsExports !== "object"
    || !Object.prototype.hasOwnProperty.call(chatCommandsExports, "AVAILABLE_SLASH_COMMANDS")
    || !Array.isArray(chatCommandsExports.AVAILABLE_SLASH_COMMANDS)
  ) {
    throw new Error(
      "ESI mod: chatCommands has no AVAILABLE_SLASH_COMMANDS array: the game module changed shape.",
    );
  }

  const added = [];
  for (const name of BIND_COMMAND_NAMES) {
    if (!chatCommandsExports.AVAILABLE_SLASH_COMMANDS.includes(name)) {
      chatCommandsExports.AVAILABLE_SLASH_COMMANDS.push(name);
      added.push(name);
    }
  }

  const help = chatCommandsExports.COMMANDS_HELP_TEXT;
  if (typeof help === "string") {
    if (!help.includes(BIND_HELP_LINE)) {
      chatCommandsExports.COMMANDS_HELP_TEXT = `${help}\n${BIND_HELP_LINE}`;
    }
  } else if (Array.isArray(help)) {
    if (!help.includes(BIND_HELP_LINE)) help.push(BIND_HELP_LINE);
  }

  return added;
}

module.exports = Object.freeze({
  BIND_CODE_PATTERN,
  BIND_COMMAND_NAMES,
  BIND_HELP_LINE,
  HELP_MESSAGE,
  IDENTITY_FAILURE_MESSAGES,
  KNOWN_STATUSES,
  MALFORMED_MESSAGE,
  MAX_TEXT_DEPTH,
  PATCH_FLAG,
  REDEMPTION_STATUS,
  RESERVED_SUBCOMMANDS,
  STATUS_MESSAGES,
  USAGE_MESSAGE,

  extractCommandText,
  extractTextValue,
  firstToken,
  handleBindCommand,
  matchBindCommand,
  messageForStatus,
  normalizeRedemptionResult,
  parseSlashCommand,
  patchSlashService,
  registerBindCommands,
  scrubCode,
  scrubErrorForLog,
});
