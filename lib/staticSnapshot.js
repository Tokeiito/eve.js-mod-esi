/**
 * eve.js-mod-esi: one dump, one validator
 *
 * The static-data routes cache as one snapshot of one dump, not as N
 * independently cached bodies. Four of them, fetched seconds apart on
 * 2026-08-25, answered with the identical `Etag`, the identical `Expires`, and
 * a `Last-Modified` a few seconds either side of the same daily rebuild:
 *
 *   GET /latest/universe/systems/30000142/         Etag: W/"a3cbe689…"
 *   GET /latest/universe/constellations/20000020/  Etag: W/"a3cbe689…"
 *   GET /latest/universe/stations/60003760/        Etag: W/"a3cbe689…"
 *   GET /latest/universe/types/34/                 Etag: W/"a3cbe689…"
 *     Cache-Control: public
 *     Expires:       Wed, 26 Aug 2026 11:05:00 GMT
 *     Last-Modified: Tue, 25 Aug 2026 11:05:15 GMT
 *
 * `contract/wire.js` records all three differences from other application routes
 * (`ETAG`, `SENDS_CACHE_HEADERS`, `CONDITIONAL_STATIC_DATA_EXCEPTION`):
 *
 *   - The `Etag` is weak, where the application's is a strong SHA-224 over the
 *     body. It is the same on four different bodies, so it digests none of them.
 *   - `Expires` is a wall-clock instant, not a window: 11:05 UTC, the time the
 *     pinned spec gives in each operation's description ("This route expires
 *     daily at 11:05"). None publishes an `x-cache-age`, which is why
 *     `contract/spec.js` requires their `cacheTtl` to be `null`.
 *   - The `404` for a nonexistent id carries the `Etag` and nothing else: no
 *     `Cache-Control`, no `Expires`, no `Last-Modified`. It is the only refusal
 *     on the surface that carries a cache header.
 *
 * Etag. The validator is derived from the store's own `source` stamp (CCP's
 * build number, the directory the dump was extracted to, and when
 * `tools/DatabaseCreator` generated the tables). `lib/universeStore.js` reads
 * it; this file hashes it. Two systems from this replica share one etag, as
 * they do from CCP, and the etag moves when the operator rebuilds the store.
 *
 * `build` is also in the identity, and is required: `lib/universeStore.js`
 * `identity()` names the dump only, so two builds of the mod over one store
 * would otherwise answer with the same validator (observed 2026-08-25, when
 * redeploying `14b09c025db2` as `286250a07449` left the etag unchanged), and a
 * client holding a pre-fix body would keep it until the next 11:05. It is the
 * mod's source hash, the value `routes/health.js` reports and
 * `scripts/deploy-mod.js` prints. A default would be forgotten by a caller.
 *
 * `Last-Modified` is the dump's, not today's 11:05. CCP rebuild daily; a private
 * server's data changed when the operator built it. `lib/cache.js` says a route
 * reading a dataset with a real modification time should supply it, and this
 * one does.
 *
 * `Expires` stays on CCP's daily cadence anyway. Clients are written against
 * it (eve-nexum's toolbar sleeps until `Expires`), and a far-future value from
 * a replica whose operator may rebuild at any moment promises what nobody can
 * keep. The cost is one conditional request per resource per day, answered 304.
 */

"use strict";

const crypto = require("node:crypto");

/**
 * The daily instant every static-data route expires at, in UTC.
 *
 * Two independent sources agree: the pinned spec's per-operation prose ("This
 * route expires daily at 11:05") and the wire, which sends
 * `Expires: … 11:05:00 GMT` to the second.
 */
const EXPIRY_UTC = Object.freeze({ hour: 11, minute: 5 });

/** The digest and the strength CCP's static-data etag is observed to carry. */
const ETAG_ALGORITHM = "sha224";
const ETAG_WEAK_PREFIX = "W/";

/** The most recent 11:05 UTC at or before `now`, in epoch milliseconds. */
function previousExpiry(now) {
  const at = new Date(now);
  const today = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
    EXPIRY_UTC.hour,
    EXPIRY_UTC.minute,
    0,
    0,
  );
  return today <= at.getTime() ? today : today - 86_400_000;
}

/**
 * The next 11:05 UTC strictly after `now`, in epoch milliseconds.
 *
 * Strictly after, so a request at exactly 11:05:00 is told about tomorrow's
 * rebuild rather than given an `Expires` equal to its own `Date`, which a cache
 * reads as already stale.
 */
function nextExpiry(now) {
  return previousExpiry(now) + 86_400_000;
}

/**
 * The weak validator for a dataset identity.
 *
 * Weak because CCP's is: `W/` forbids using the response for a byte range,
 * which is correct for a body in a family sharing one validator.
 */
function snapshotEtag(identity) {
  const digest = crypto.createHash(ETAG_ALGORITHM).update(String(identity), "utf8").digest("hex");
  return `${ETAG_WEAK_PREFIX}"${digest}"`;
}

/**
 * The snapshot every static-data route shares.
 *
 * `readIdentity()` returns `{ identity, generatedAt }` for the dataset behind
 * those routes, or `null` when it cannot be read; `build` names the mod
 * answering. `null` propagates: `facts()` answers `null`, no route sends a
 * snapshot header, and the route's own `500` (a universe route that cannot read
 * the store cannot answer) is the visible failure.
 *
 * The identity is read once and remembered. The store is loaded at game boot and
 * not rewritten while the server runs (a rebuild is offline, followed by a
 * restart), and a per-request read would put a table lookup on the path of every
 * 404.
 */
function createStaticSnapshot({ readIdentity, build } = {}) {
  if (typeof readIdentity !== "function") {
    throw new TypeError("ESI mod: createStaticSnapshot needs a readIdentity function.");
  }
  if (typeof build !== "string" || build === "") {
    throw new TypeError(
      "ESI mod: createStaticSnapshot needs the mod's build as a non-empty string. It is the "
        + "half of the validator the dataset cannot supply (see the header), and a default "
        + "here would be a stale body nobody can see.",
    );
  }

  let resolved;

  function resolve() {
    if (resolved === undefined) {
      const read = readIdentity();
      resolved = read === null || read === undefined
        ? null
        : Object.freeze({
          // Which dump this is, and which build is projecting it. Either moving moves
          // the validator.
          etag: snapshotEtag(`${read.identity}
mod:${build}`),
          lastModified: read.generatedAt,
        });
    }
    return resolved;
  }

  return Object.freeze({
    /** `{ etag, lastModified, expires }` for a response served at `now`, or `null`. */
    facts(now = Date.now()) {
      const snapshot = resolve();
      if (snapshot === null) return null;
      return Object.freeze({
        etag: snapshot.etag,
        lastModified: snapshot.lastModified,
        expires: nextExpiry(now),
      });
    },
  });
}

module.exports = Object.freeze({
  ETAG_ALGORITHM,
  ETAG_WEAK_PREFIX,
  EXPIRY_UTC,
  createStaticSnapshot,
  nextExpiry,
  previousExpiry,
  snapshotEtag,
});
