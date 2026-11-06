/**
 * Tests for lib/bindCodes.js.
 *
 * Run with:  node --test "test/**\/*.test.js"   (from the mod directory)
 *
 * The code must be unguessable and also readable off a browser and typeable
 * into a game client. These cases pin the alphabet a person sees and the
 * sampling that makes it random.
 *
 * Nothing sleeps and nothing is statistical: the randomness source is injected,
 * so the rejection sampler is driven byte by byte and its uniformity is an
 * exact assertion.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  BIND_CODE_ALPHABET,
  BIND_CODE_LENGTH,
  EXCLUDED_CHARACTERS,
  REJECTION_LIMIT,
  generateBindCode,
  generateBindCodeWith,
  isBindCodeShape,
  normalizeBindCode,
} = require(path.join(__dirname, "..", "lib", "bindCodes"));

const { BIND_CODE_PATTERN, RESERVED_SUBCOMMANDS } = require(
  path.join(__dirname, "..", "lib", "slashCommandPatch"),
);

// The alphabet

test("the alphabet contains no character confusable with another", () => {
  for (const character of EXCLUDED_CHARACTERS) {
    assert.equal(
      BIND_CODE_ALPHABET.includes(character),
      false,
      `"${character}" must not be in the bind code alphabet`,
    );
  }
});

test("the alphabet has no duplicates and is uppercase-only", () => {
  assert.equal(new Set(BIND_CODE_ALPHABET).size, BIND_CODE_ALPHABET.length);
  assert.equal(BIND_CODE_ALPHABET, BIND_CODE_ALPHABET.toUpperCase());
});

test("the alphabet and length are the 39-bit space the rate limit is sized against", () => {
  // `lib/pendingBinds.js`'s per-character redemption limit is justified by this
  // number. Shrinking either value without revisiting that limit must fail here.
  assert.equal(BIND_CODE_ALPHABET.length, 30);
  assert.equal(BIND_CODE_LENGTH, 8);
  assert.ok(Math.log2(30 ** 8) > 39, "the code space should be at least 39 bits");
});

// Generated codes

test("every generated code uses only the alphabet, at the expected length", () => {
  for (let index = 0; index < 500; index += 1) {
    const code = generateBindCode();
    assert.equal(code.length, BIND_CODE_LENGTH);
    for (const character of code) {
      assert.ok(
        BIND_CODE_ALPHABET.includes(character),
        `generated "${code}" contains "${character}", which is not in the alphabet`,
      );
    }
  }
});

test("no generated code can contain an excluded character", () => {
  for (let index = 0; index < 500; index += 1) {
    const code = generateBindCode();
    for (const character of EXCLUDED_CHARACTERS) {
      assert.equal(code.includes(character), false, `generated "${code}" contains "${character}"`);
    }
  }
});

test("a generated code satisfies the syntax gate in the slash command", () => {
  // The two files pick their constraints independently. This test stops them
  // drifting into a code that can be minted and never redeemed.
  for (let index = 0; index < 200; index += 1) {
    assert.match(generateBindCode(), BIND_CODE_PATTERN);
  }
});

test("a generated code can never collide with a reserved subcommand", () => {
  // Not probabilistic: the alphabet has no lowercase letters and no L, so
  // "help", "HELP" and "?" are not representable.
  for (const reserved of RESERVED_SUBCOMMANDS) {
    const representable = [...reserved.toUpperCase()].every((character) =>
      BIND_CODE_ALPHABET.includes(character),
    );
    assert.equal(representable, false, `"${reserved}" must be unrepresentable`);
  }
});

test("codes do not repeat over a large sample", () => {
  const seen = new Set();
  for (let index = 0; index < 2000; index += 1) seen.add(generateBindCode());
  assert.equal(seen.size, 2000);
});

// Rejection sampling

test("bytes at or above the rejection limit are discarded, not folded", () => {
  // Folding with % would over-weight the first 16 symbols. Feed the generator
  // only rejectable bytes followed by one usable byte: the output must be that
  // byte's symbol, repeated.
  const bytes = [];
  for (let index = 0; index < 64; index += 1) bytes.push(REJECTION_LIMIT + (index % 16));
  for (let index = 0; index < 64; index += 1) bytes.push(0);

  let offset = 0;
  const code = generateBindCodeWith((size) => {
    const chunk = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) chunk[index] = bytes[offset++ % bytes.length];
    return chunk;
  }, 4);

  assert.equal(code, BIND_CODE_ALPHABET[0].repeat(4));
});

test("the sampler is uniform enough that no symbol is starved", () => {
  // A biased implementation (byte % 30 with no rejection) shows the first 16
  // symbols at roughly twice the rate of the rest. Feeding every byte value once
  // makes that visible without statistics.
  const counts = new Map();
  const bytes = Array.from({ length: 256 }, (_, index) => index);
  let offset = 0;
  const code = generateBindCodeWith((size) => {
    const chunk = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) chunk[index] = bytes[offset++] ?? 0;
    return chunk;
  }, 240);

  for (const character of code) counts.set(character, (counts.get(character) || 0) + 1);
  assert.equal(counts.size, BIND_CODE_ALPHABET.length);
  for (const [character, count] of counts) {
    assert.equal(count, 8, `"${character}" appeared ${count} times, expected 8`);
  }
});

test("a randomness source that never yields a usable byte fails loudly", () => {
  // The module must not fall back to a weaker source. The retry bound turns an
  // unusable CSPRNG into a throw rather than a spin on the game's event loop.
  assert.throws(
    () => generateBindCodeWith(() => Buffer.alloc(8, REJECTION_LIMIT)),
    /randomness source/,
  );
});

test("a randomness source returning nothing usable throws", () => {
  assert.throws(() => generateBindCodeWith(() => null), /randomBytes/);
  assert.throws(() => generateBindCodeWith(() => ({})), /randomBytes/);
});

// Normalisation

test("what the player types is folded to the canonical form", () => {
  assert.equal(normalizeBindCode("sav82k9q"), "SAV82K9Q");
  assert.equal(normalizeBindCode("SAV8-2K9Q"), "SAV82K9Q");
  assert.equal(normalizeBindCode(" SAV8 2K9Q "), "SAV82K9Q");
  assert.equal(normalizeBindCode("SAV8_2K9Q"), "SAV82K9Q");
});

test("normalisation does not invent characters for a mistyped lookalike", () => {
  // Both members of every confusable pair are excluded, so there is no correct
  // symbol to fold "0" or "I" onto. They stay put and fail the shape check;
  // folding would turn a typo into a different, possibly live, code.
  assert.equal(normalizeBindCode("SAV82K90"), "SAV82K90");
  assert.equal(isBindCodeShape("SAV82K90"), false);
  assert.equal(isBindCodeShape("SAV82K9I"), false);
});

test("normalisation of a non-string is empty, never a throw", () => {
  for (const value of [null, undefined, 7, {}, []]) {
    assert.equal(normalizeBindCode(value), "");
  }
});

// Shape check

test("only strings of exactly the generated shape are accepted", () => {
  assert.equal(isBindCodeShape(generateBindCode()), true);
  assert.equal(isBindCodeShape(""), false);
  assert.equal(isBindCodeShape("SAV82K9"), false);
  assert.equal(isBindCodeShape("SAV82K9QQ"), false);
  assert.equal(isBindCodeShape("sav82k9q"), false);
  assert.equal(isBindCodeShape(null), false);
});
