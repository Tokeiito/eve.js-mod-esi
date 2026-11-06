/**
 * eve.js-mod-esi: tests for lib/slashCommandPatch.js
 *
 * Run with: node --test "test/**\/*.test.js"   (from the mod directory)
 *
 * The patch sits in front of every slash command on the server, a large blast
 * radius for one mod feature, so more cases are about leaving other commands
 * alone than about `/esi` working.
 *
 * The fake SlashService is a real class with a real `Handle_SlashCmd` on its
 * prototype, because the prototype is the thing under test: patching the
 * exports object does not work.
 *
 * No game code is loaded here. The chat reply, the store and both loggers are
 * injected, so "the code never reaches a log line" is an assertion over
 * collected strings.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  BIND_CODE_PATTERN,
  BIND_COMMAND_NAMES,
  BIND_HELP_LINE,
  PATCH_FLAG,
  REDEMPTION_STATUS,
  STATUS_MESSAGES,
  extractCommandText,
  firstToken,
  handleBindCommand,
  matchBindCommand,
  normalizeRedemptionResult,
  parseSlashCommand,
  patchSlashService,
  registerBindCommands,
  scrubCode,
  scrubErrorForLog,
} = require(path.join(__dirname, "..", "lib", "slashCommandPatch"));

const CODE = "AbCd1234xyz";
const SESSION = Object.freeze({ characterID: 90000001, userid: 12345, role: "0" });

// Harness

// A stand-in for the game's SlashService. `original` records every call that
// reached the untouched handler, so "falls through" is asserted rather than
// assumed.
function makeFakeSlashService() {
  const original = [];

  class FakeSlashService {
    constructor() {
      this.serviceManager = { fake: true };
    }

    Handle_SlashCmd(args, session, kwargs) {
      original.push({ args, session, kwargs, self: this });
      return "ORIGINAL_RESULT";
    }
  }

  return { FakeSlashService, original };
}

// Patch a fresh fake class and collect everything the patch says and sends.
// The dependencies are assembled before patching, because the patch captures
// them: a redeemer that could be swapped after installation would be worse.
function setup(overrides = {}) {
  const { FakeSlashService, original } = makeFakeSlashService();
  const sent = [];
  const logs = [];
  const errors = [];

  const deps = {
    sendSystemMessage(session, message) {
      sent.push({ session, message });
    },
    log(message) {
      logs.push(String(message));
    },
    logError(message, err) {
      errors.push({ message: String(message), stack: (err && err.stack) || "" });
    },
    ...overrides,
  };

  const patched = patchSlashService(FakeSlashService, deps);

  return {
    FakeSlashService,
    original,
    sent,
    logs,
    errors,
    patched,
    service: new FakeSlashService(),
    // Every string the mod produced, in one place: the "never log the code"
    // assertion sweeps this.
    allText() {
      return [...logs, ...errors.map((e) => `${e.message}\n${e.stack}`)].join("\n");
    },
  };
}

const okRedeemer = () => ({ status: REDEMPTION_STATUS.OK });

// Interception

test("/esi <code> is intercepted and the original handler never runs", () => {
  const harness = setup({ redeemBindCode: okRedeemer });

  const returned = harness.service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null);

  assert.deepEqual(harness.original, []);
  assert.equal(returned, STATUS_MESSAGES[REDEMPTION_STATUS.OK]);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].session, SESSION);
  assert.equal(harness.sent[0].message, STATUS_MESSAGES[REDEMPTION_STATUS.OK]);
});

test("the dot prefix and odd casing are intercepted too", () => {
  for (const line of [`.esi ${CODE}`, `/ESI ${CODE}`, `  /Esi   ${CODE}  `]) {
    const harness = setup({ redeemBindCode: okRedeemer });
    harness.service.Handle_SlashCmd([line], SESSION, null);

    assert.deepEqual(harness.original, [], `"${line}" should have been intercepted`);
    assert.equal(harness.sent.length, 1);
  }
});

test("the identity the store is handed comes from the session, not the command line", () => {
  // The security argument in one assertion: nothing the player types reaches
  // `characterID`.
  const seen = [];
  const harness = setup({
    redeemBindCode: (request) => {
      seen.push(request);
      return { status: REDEMPTION_STATUS.OK };
    },
  });

  harness.service.Handle_SlashCmd(
    [`/esi ${CODE} characterID=99999999`],
    { charid: 90000007, userID: 55, accountRole: "274877906944" },
    null,
  );
  // Two tokens is malformed, so nothing reached the store: a second token can
  // never become part of the request.
  assert.deepEqual(seen, []);

  harness.service.Handle_SlashCmd(
    [`/esi ${CODE}`],
    { charid: 90000007, userID: 55, accountRole: "274877906944" },
    null,
  );
  assert.deepEqual({ ...seen[0] }, {
    code: CODE,
    characterID: 90000007,
    accountID: 55,
    role: "274877906944",
    isGM: true,
  });
});

test("the code is read out of the EVE marshal structures the client actually sends", () => {
  const seen = [];
  const harness = setup({
    redeemBindCode: (request) => {
      seen.push(request.code);
      return { status: REDEMPTION_STATUS.OK };
    },
  });

  harness.service.Handle_SlashCmd(
    [{ type: "wstring", value: `/esi ${CODE}` }],
    SESSION,
    null,
  );
  harness.service.Handle_SlashCmd([Buffer.from(`/esi ${CODE}`, "utf8")], SESSION, null);
  // args empty, command in kwargs: the other shape slashService handles.
  harness.service.Handle_SlashCmd([], SESSION, {
    type: "dict",
    entries: [["command", `/esi ${CODE}`]],
  });

  assert.deepEqual(seen, [CODE, CODE, CODE]);
});

// Everything else falls through

test("every other slash command reaches the original handler unchanged", () => {
  const harness = setup({ redeemBindCode: okRedeemer });

  const commands = [
    "/help",
    "/motd",
    "/beltencounter spawn",
    "/esilog code",     // a prefix match must not be a match
    "/es code",
    "/",
    "",
    "not a slash command at all",
  ];

  for (const command of commands) {
    const returned = harness.service.Handle_SlashCmd([command], SESSION, { channelID: 42 });
    assert.equal(returned, "ORIGINAL_RESULT", `"${command}" should have fallen through`);
  }

  assert.equal(harness.original.length, commands.length);
  // Untouched means untouched: same values, same receiver.
  assert.equal(harness.original[0].args[0], "/help");
  assert.equal(harness.original[0].session, SESSION);
  assert.deepEqual(harness.original[0].kwargs, { channelID: 42 });
  assert.equal(harness.original[0].self, harness.service);
  assert.deepEqual(harness.sent, []);
});

test("a null session on somebody else's command still falls through", () => {
  const harness = setup();
  assert.equal(harness.service.Handle_SlashCmd(["/help"], null, null), "ORIGINAL_RESULT");
  assert.equal(harness.original.length, 1);
});

test("nothing is logged for a command that is not ours", () => {
  // This runs in front of every slash command on the server; a log line per
  // command would be a real cost, and a log line quoting one would be worse.
  const harness = setup({ redeemBindCode: okRedeemer });
  harness.service.Handle_SlashCmd(["/motd something private"], SESSION, null);
  assert.deepEqual(harness.logs, []);
  assert.deepEqual(harness.errors, []);
});

// In-game feedback on every path

test("the player hears about success, unknown, expired, reused, unavailable and error", () => {
  for (const status of Object.values(REDEMPTION_STATUS)) {
    const harness = setup({ redeemBindCode: () => ({ status }) });
    harness.service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null);

    assert.equal(harness.sent.length, 1, `${status} should produce exactly one reply`);
    assert.equal(harness.sent[0].message, STATUS_MESSAGES[status]);
  }
});

test("a missing code gets usage in game rather than silence", () => {
  const harness = setup({ redeemBindCode: okRedeemer });
  harness.service.Handle_SlashCmd(["/esi"], SESSION, null);

  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].message, /Usage: \/esi <code>/);
});

test("a malformed code gets an explanation in game", () => {
  const harness = setup({ redeemBindCode: okRedeemer });
  harness.service.Handle_SlashCmd(["/esi not a code"], SESSION, null);

  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].message, /does not look like a sign-in code/i);
});

test("help is help, not a bind code", () => {
  for (const argument of ["help", "HELP", "?"]) {
    const seen = [];
    const harness = setup({
      redeemBindCode: (request) => {
        seen.push(request);
        return { status: REDEMPTION_STATUS.OK };
      },
    });
    harness.service.Handle_SlashCmd([`/esi ${argument}`], SESSION, null);

    assert.deepEqual(seen, [], `"${argument}" must never reach the store`);
    assert.match(harness.sent[0].message, /one-time and short-lived/);
  }
});

test("a session with no character gets told, in game", () => {
  const harness = setup({ redeemBindCode: okRedeemer });
  harness.service.Handle_SlashCmd([`/esi ${CODE}`], { userid: 1 }, null);

  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].message, /no character is selected/i);
});

test("a mistyped code is answered before the session is even looked at", () => {
  // A player who mistypes the code should hear about the typo, not about their
  // session.
  const harness = setup({ redeemBindCode: okRedeemer });
  harness.service.Handle_SlashCmd(["/esi nope nope"], null, null);
  assert.match(harness.sent[0].message, /does not look like a sign-in code/i);
});

test("an asynchronous redemption replies when it settles", async () => {
  const harness = setup({
    redeemBindCode: async () => ({ status: REDEMPTION_STATUS.USED }),
  });

  const returned = await harness.service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null);

  assert.equal(returned, STATUS_MESSAGES[REDEMPTION_STATUS.USED]);
  assert.equal(harness.sent[0].message, STATUS_MESSAGES[REDEMPTION_STATUS.USED]);
});

test("no store wired up at all is `unavailable`, not silence", () => {
  const harness = setup();
  harness.service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null);
  assert.equal(harness.sent[0].message, STATUS_MESSAGES[REDEMPTION_STATUS.UNAVAILABLE]);
});

// A throw inside the hook must not break slash commands

test("a redeemer that throws costs one command, not the slash system", () => {
  const harness = setup({
    redeemBindCode: () => {
      throw new Error("bind store exploded");
    },
  });

  const returned = harness.service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null);

  // The player is told something actionable...
  assert.equal(returned, STATUS_MESSAGES[REDEMPTION_STATUS.ERROR]);
  assert.equal(harness.sent[0].message, STATUS_MESSAGES[REDEMPTION_STATUS.ERROR]);
  // ...and the next command, ours or the game's, still works.
  assert.equal(harness.service.Handle_SlashCmd(["/help"], SESSION, null), "ORIGINAL_RESULT");
  assert.equal(harness.original.length, 1);
});

test("a redeemer that rejects costs one command, not the slash system", async () => {
  const harness = setup({
    redeemBindCode: () => Promise.reject(new Error("network down")),
  });

  const returned = await harness.service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null);

  assert.equal(returned, STATUS_MESSAGES[REDEMPTION_STATUS.ERROR]);
  assert.equal(harness.errors.length, 1);
  assert.equal(harness.service.Handle_SlashCmd(["/motd"], SESSION, null), "ORIGINAL_RESULT");
  assert.equal(harness.original.length, 1);
});

test("a chat layer that throws does not take the command down", () => {
  const harness = setup({
    redeemBindCode: okRedeemer,
    sendSystemMessage() {
      throw new Error("chatHub is not ready");
    },
  });

  assert.doesNotThrow(() => harness.service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null));
  assert.equal(harness.errors.length, 1);
  assert.equal(harness.service.Handle_SlashCmd(["/help"], SESSION, null), "ORIGINAL_RESULT");
  assert.equal(harness.original.length, 1);
});

test("an intercepted /esi never falls through, even when it fails", () => {
  // Falling through would hand the raw command line, code and all, to the
  // vendor's `log.debug` and `logs/slash-debug.log`, and then echo it back into
  // chat as "Unknown command: /esi <code>".
  const harness = setup({
    redeemBindCode: () => {
      throw new Error("boom");
    },
  });

  harness.service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null);
  assert.deepEqual(harness.original, []);
});

test("the patch survives being handed no dependencies at all", () => {
  const { FakeSlashService, original } = makeFakeSlashService();
  patchSlashService(FakeSlashService);
  const service = new FakeSlashService();

  assert.doesNotThrow(() => service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null));
  assert.equal(service.Handle_SlashCmd(["/help"], SESSION, null), "ORIGINAL_RESULT");
  assert.equal(original.length, 1);
});

test("a store returning junk becomes an error, not a raw enum in chat", () => {
  for (const value of [undefined, null, "ok", 7, { status: "banana" }, {}]) {
    const harness = setup({ redeemBindCode: () => value });
    harness.service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null);
    assert.equal(
      harness.sent[0].message,
      STATUS_MESSAGES[REDEMPTION_STATUS.ERROR],
      `${JSON.stringify(value)} should degrade to the error sentence`,
    );
  }
});

test("a store may override the sentence, and the override is scrubbed too", () => {
  const harness = setup({
    redeemBindCode: () => ({
      status: REDEMPTION_STATUS.ERROR,
      message: `too many attempts for ${CODE}, wait a minute`,
    }),
  });
  harness.service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null);

  assert.match(harness.sent[0].message, /too many attempts/);
  assert.equal(harness.sent[0].message.includes(CODE), false);
});

// The code never reaches a log

test("no log line from any path contains the code", async () => {
  // For its lifetime a code is a bearer credential: whoever has it can finish
  // somebody else's sign-in. A log file is shared with anyone who can read the
  // container's stdout.
  const redeemers = [
    // Success.
    okRedeemer,
    // A store that reports failure.
    () => ({ status: REDEMPTION_STATUS.UNKNOWN }),
    // A store that throws with the code in the message and the stack.
    (request) => {
      throw new Error(`no pending bind for code ${request.code}`);
    },
    // A store that rejects with the code in the message.
    (request) => Promise.reject(new Error(`redeem failed for ${request.code}`)),
    // A store that returns junk.
    () => undefined,
    // A store that puts the code in a message meant for the player.
    (request) => ({ status: REDEMPTION_STATUS.ERROR, message: `code ${request.code} failed` }),
  ];

  for (const redeemBindCode of redeemers) {
    const harness = setup({ redeemBindCode });
    await harness.service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null);

    assert.equal(
      harness.allText().includes(CODE),
      false,
      `a log line leaked the code: ${harness.allText()}`,
    );
    for (const { message } of harness.sent) {
      assert.equal(String(message).includes(CODE), false, "a reply leaked the code");
    }
  }
});

test("something is logged on the happy path, so the absence above is not vacuous", () => {
  const harness = setup({ redeemBindCode: okRedeemer });
  harness.service.Handle_SlashCmd([`/esi ${CODE}`], SESSION, null);

  assert.ok(harness.logs.length > 0);
  assert.match(harness.logs.join("\n"), /char=90000001 account=12345 gm=no/);
});

test("scrubErrorForLog scrubs the message and the stack, and leaves the original alone", () => {
  const original = new Error(`bad code ${CODE}`);
  const scrubbed = scrubErrorForLog(original, CODE);

  assert.equal(scrubbed.message.includes(CODE), false);
  assert.equal(String(scrubbed.stack).includes(CODE), false);
  assert.equal(original.message.includes(CODE), true);
  assert.equal(scrubErrorForLog(null, CODE), null);
});

test("scrubCode replaces every occurrence and copes with nothing to scrub", () => {
  assert.equal(scrubCode(`${CODE} and ${CODE}`, CODE), "<code> and <code>");
  assert.equal(scrubCode("nothing here", CODE), "nothing here");
  assert.equal(scrubCode("nothing here", ""), "nothing here");
  assert.equal(scrubCode("nothing here", null), "nothing here");
});

// Patching discipline

test("patching twice is refused, so the player never gets two replies", () => {
  const { FakeSlashService } = makeFakeSlashService();
  const sent = [];
  const deps = {
    redeemBindCode: okRedeemer,
    sendSystemMessage: (session, message) => sent.push(message),
  };

  assert.equal(patchSlashService(FakeSlashService, deps), true);
  assert.equal(patchSlashService(FakeSlashService, deps), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(FakeSlashService.prototype, PATCH_FLAG),
    true,
  );

  new FakeSlashService().Handle_SlashCmd([`/esi ${CODE}`], SESSION, null);
  assert.equal(sent.length, 1);
});

test("patching something that is not a SlashService throws, for the hook loop to catch", () => {
  for (const value of [null, undefined, {}, () => {}, class Empty {}]) {
    assert.throws(() => patchSlashService(value, {}), /has no Handle_SlashCmd to patch/);
  }
});

// Command registration

test("the command name is pushed into AVAILABLE_SLASH_COMMANDS", () => {
  const exports = {
    AVAILABLE_SLASH_COMMANDS: ["help", "motd"],
    COMMANDS_HELP_TEXT: "Commands:\n/help",
  };
  const added = registerBindCommands(exports);

  assert.deepEqual(added, [...BIND_COMMAND_NAMES]);
  assert.equal(exports.AVAILABLE_SLASH_COMMANDS.includes("esi"), true);
  // The game's own commands are left where they were.
  assert.equal(exports.AVAILABLE_SLASH_COMMANDS[0], "help");
});

test("help text is appended for a string and for an array", () => {
  // Upstream joins its list into a string; the array branch is for a vendor drop
  // that stops doing so.
  const asString = { AVAILABLE_SLASH_COMMANDS: [], COMMANDS_HELP_TEXT: "Commands:" };
  registerBindCommands(asString);
  assert.equal(asString.COMMANDS_HELP_TEXT, `Commands:\n${BIND_HELP_LINE}`);

  const asArray = { AVAILABLE_SLASH_COMMANDS: [], COMMANDS_HELP_TEXT: ["Commands:"] };
  registerBindCommands(asArray);
  assert.deepEqual(asArray.COMMANDS_HELP_TEXT, ["Commands:", BIND_HELP_LINE]);
});

test("registering twice adds nothing twice", () => {
  const exports = { AVAILABLE_SLASH_COMMANDS: [], COMMANDS_HELP_TEXT: "Commands:" };
  registerBindCommands(exports);
  const added = registerBindCommands(exports);

  assert.deepEqual(added, []);
  assert.deepEqual(exports.AVAILABLE_SLASH_COMMANDS, [...BIND_COMMAND_NAMES]);
  assert.equal(exports.COMMANDS_HELP_TEXT.split(BIND_HELP_LINE).length, 2);
});

test("missing help text is not an error: the command list is what matters", () => {
  const exports = { AVAILABLE_SLASH_COMMANDS: [] };
  assert.doesNotThrow(() => registerBindCommands(exports));
  assert.deepEqual(exports.AVAILABLE_SLASH_COMMANDS, [...BIND_COMMAND_NAMES]);
});

test("a chatCommands module of the wrong shape throws, for the hook loop to catch", () => {
  for (const value of [null, undefined, {}, { AVAILABLE_SLASH_COMMANDS: "nope" }]) {
    assert.throws(() => registerBindCommands(value), /has no AVAILABLE_SLASH_COMMANDS array/);
  }
});

test("an inherited AVAILABLE_SLASH_COMMANDS is not accepted", () => {
  // A half-built circular-dependency export must not look usable.
  assert.throws(
    () => registerBindCommands(Object.create({ AVAILABLE_SLASH_COMMANDS: [] })),
    /has no AVAILABLE_SLASH_COMMANDS array/,
  );
});

// Parsing helpers

test("parseSlashCommand splits the name from the argument text", () => {
  assert.deepEqual(parseSlashCommand("/esi abc def"), {
    name: "esi",
    argumentText: "abc def",
  });
  assert.deepEqual(parseSlashCommand(".esi"), { name: "esi", argumentText: "" });
  assert.deepEqual(parseSlashCommand("esi abc"), { name: "esi", argumentText: "abc" });
});

test("parseSlashCommand returns null for nothing to parse", () => {
  for (const value of ["", "   ", "/", ".", null, undefined]) {
    assert.equal(parseSlashCommand(value), null, `${String(value)} should not parse`);
  }
});

test("matchBindCommand matches only the exact command name", () => {
  assert.ok(matchBindCommand([`/esi ${CODE}`], null));
  assert.equal(matchBindCommand(["/esilog x"], null), null);
  assert.equal(matchBindCommand(["/help"], null), null);
  assert.equal(matchBindCommand([], null), null);
});

test("extractCommandText prefers args and falls back to kwargs", () => {
  assert.equal(extractCommandText(["/a"], { type: "dict", entries: [["c", "/b"]] }), "/a");
  assert.equal(extractCommandText([], { type: "dict", entries: [["c", "/b"]] }), "/b");
  assert.equal(extractCommandText(null, null), "");
});

test("extractCommandText does not recurse forever on a self-referential structure", () => {
  // These structures arrive from the network, and this mod shares the game's
  // event loop: an unbounded walk here would stall the universe.
  const loop = { type: "substream", value: null };
  loop.value = loop;
  assert.doesNotThrow(() => extractCommandText([loop], null));
});

test("firstToken picks the code out of the argument text", () => {
  assert.equal(firstToken(`${CODE} extra`), CODE);
  assert.equal(firstToken("   "), "");
  assert.equal(firstToken(undefined), "");
});

// The pure handler, without the patch around it

test("handleBindCommand answers on every path and never throws", async () => {
  const inputs = [
    "", "   ", "help", "?", "not a code", `${CODE} ${CODE}`, "a", CODE,
  ];
  for (const argumentText of inputs) {
    const result = await handleBindCommand(SESSION, argumentText, {
      redeemBindCode: okRedeemer,
    });
    assert.equal(result.handled, true, `"${argumentText}" should be handled`);
    assert.equal(typeof result.message, "string");
    assert.ok(result.message.length > 0, `"${argumentText}" produced an empty reply`);
  }
});

test("normalizeRedemptionResult closes the status set", () => {
  assert.deepEqual(normalizeRedemptionResult({ status: "OK " }), { status: "ok", message: null });
  assert.deepEqual(normalizeRedemptionResult({ status: "nope" }), {
    status: "error", message: null,
  });
  assert.deepEqual(normalizeRedemptionResult(null), { status: "error", message: null });
  assert.deepEqual(normalizeRedemptionResult({ status: "ok", message: "  hi  " }), {
    status: "ok", message: "hi",
  });
  assert.deepEqual(normalizeRedemptionResult({ status: "ok", message: "   " }), {
    status: "ok", message: null,
  });
});

test("the syntax gate is permissive but not a wildcard", () => {
  assert.match("SAV82K9Q", BIND_CODE_PATTERN);
  assert.doesNotMatch("abc", BIND_CODE_PATTERN);      // too short
  assert.doesNotMatch("-abcd", BIND_CODE_PATTERN);    // leading separator
  assert.doesNotMatch("ab cd", BIND_CODE_PATTERN);    // a space
  assert.doesNotMatch("a".repeat(65), BIND_CODE_PATTERN);
});
