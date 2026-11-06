/**
 * eve.js-mod-esi: bind code generation (D3).
 *
 * Produces a short string a human reads off a browser and types into a game
 * client, which nobody can guess. Ported from `nexumApi`'s `lib/bindCodes.js`,
 * the working implementation D3 names; the alphabet, length and rejection
 * sampler are unchanged.
 *
 * Randomness: a bind code is a bearer credential. For the minute or two it
 * lives, whoever holds it can complete someone else's authorization and get an
 * access token carrying that character's ID. `Math.random()` is a seeded PRNG
 * whose state is recoverable from a few outputs, so only `crypto.randomBytes`
 * is acceptable.
 *
 * Alphabet (30 symbols): 23456789ABCDEFGHJKMNPQRSTVWXYZ. Digits without 0 and
 * 1; letters without I, L, O and U. Both members of each confusable pair
 * (0/O, 1/I/l) are excluded, so ambiguity is unrepresentable instead of being
 * resolved after the fact, and `normalizeBindCode` only fixes case and
 * spacing. U is dropped as in Crockford, to keep accidental words out of a code
 * that may be read aloud.
 *
 * The slash command reserves the words `help` and `?`. With no lowercase
 * letters and no L, neither "help" nor "HELP" can be generated at all;
 * `test/bindCodes.test.js` asserts that impossibility.
 *
 * Eight symbols is 30^8, about 6.6e11 or 39 bits. That is thin alone; the TTL
 * (minutes) and the per-character redemption limit in `lib/pendingBinds.js`
 * make it unsearchable. Neither defence is optional.
 *
 * The module is pure apart from `generateBindCode`, whose randomness source is
 * an argument so tests can drive every branch of the rejection sampler.
 */

"use strict";

const crypto = require("node:crypto");

const BIND_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const BIND_CODE_LENGTH = 8;

// Characters a human might type in place of an alphabet symbol. A named
// constant so the test can assert none of them can be generated.
const EXCLUDED_CHARACTERS = Object.freeze(["0", "O", "1", "I", "l", "L", "U"]);

// Rejection sampling threshold. 256 is not a multiple of 30, so bytes at or
// above the largest multiple (240) are discarded rather than reduced mod 30,
// which would make the first 16 symbols more likely than the rest and cost
// bits of the 39.
const REJECTION_LIMIT =
  Math.floor(256 / BIND_CODE_ALPHABET.length) * BIND_CODE_ALPHABET.length;

// Ceiling on rejection retries. With 16/256 of byte values rejected, needing
// thousands of bytes for eight symbols means a broken randomness source, and
// looping forever on one would stall the game's event loop (design
// constraint 2).
const MAX_RANDOM_BYTES = 4096;

/**
 * Generate one code.
 *
 * `randomBytes` is injected and must have the signature of
 * `crypto.randomBytes(size)`, returning a Buffer or Uint8Array. Throws only if
 * the source is unusable. Do not paper over that with a weaker fallback: a code
 * from a degraded source looks identical to a good one.
 */
function generateBindCodeWith(randomBytes, length = BIND_CODE_LENGTH) {
  const wanted = Number.isInteger(length) && length > 0 ? length : BIND_CODE_LENGTH;

  let out = "";
  let consumed = 0;

  while (out.length < wanted) {
    // Ask for a little more than needed so the common case is a single call into
    // the CSPRNG.
    const chunk = randomBytes(wanted - out.length + 4);
    if (!chunk || typeof chunk.length !== "number") {
      throw new Error("ESI mod: randomBytes returned nothing usable.");
    }

    consumed += chunk.length;
    if (consumed > MAX_RANDOM_BYTES) {
      throw new Error(
        "ESI mod: could not generate a bind code: the randomness source is not behaving.",
      );
    }

    for (let index = 0; index < chunk.length && out.length < wanted; index += 1) {
      const byte = chunk[index] & 0xff;
      if (byte >= REJECTION_LIMIT) continue;
      out += BIND_CODE_ALPHABET[byte % BIND_CODE_ALPHABET.length];
    }
  }

  return out;
}

/** The wrapper the store uses. The only impure function in the file. */
function generateBindCode(length = BIND_CODE_LENGTH) {
  return generateBindCodeWith(crypto.randomBytes, length);
}

/**
 * Fold what the player typed onto the canonical form.
 *
 * Case and separators only. Dashes and spaces are stripped because a code
 * shown as `ABCD-2345` should redeem whether or not the dash was copied, and
 * some clients insert one when wrapping. Returns "" for a non-string.
 */
function normalizeBindCode(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\s_-]+/g, "").toUpperCase();
}

/**
 * Is this the shape of a code this mod could have minted?
 *
 * Checked before the store is touched. Stricter than `BIND_CODE_PATTERN` in
 * `lib/slashCommandPatch.js` on purpose: that one is a permissive syntax gate
 * that must survive any length this module later picks; this one is the exact
 * set of strings the generator emits.
 */
function isBindCodeShape(normalized) {
  if (typeof normalized !== "string" || normalized.length !== BIND_CODE_LENGTH) {
    return false;
  }
  for (const character of normalized) {
    if (!BIND_CODE_ALPHABET.includes(character)) return false;
  }
  return true;
}

module.exports = Object.freeze({
  BIND_CODE_ALPHABET,
  BIND_CODE_LENGTH,
  EXCLUDED_CHARACTERS,
  MAX_RANDOM_BYTES,
  REJECTION_LIMIT,

  generateBindCode,
  generateBindCodeWith,
  isBindCodeShape,
  normalizeBindCode,
});
