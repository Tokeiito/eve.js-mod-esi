/**
 * eve.js-mod-esi: silent duck-typing for partially-initialised modules.
 *
 * The loader's `Module._load` hook sees every require() in the process,
 * including ones Node satisfies from a circular dependency with a half-built
 * exports object. Node marks those by swapping in a warning proxy as the
 * prototype, so a plain `exports.someMethod` miss reaches the proxy and emits
 * "Accessing non-existent property 'X' inside circular dependency". eve.js's
 * ProcessLifecycle handler logs that with a full stack and a heap snapshot.
 * `hasOwnProperty` resolves against own properties only, so it answers the
 * same question without tripping the proxy.
 *
 * Every predicate that inspects a game module's exports (in the loader's HOOKS
 * table and in lib/runtimeAccess.js) must go through this file.
 *
 * A miss is not a failure: the module is not fully initialised yet, and the
 * next require of it matches.
 */

"use strict";

/**
 * True when `value` owns `property` and it holds the expected type.
 *
 * @param {unknown} value        candidate module exports
 * @param {string} property      own property name to probe
 * @param {string} expectedType  a `typeof` result, or the literal "array"
 * @returns {boolean}
 */
function exportHas(value, property, expectedType) {
  if (value === null || typeof value !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(value, property)) return false;
  return expectedType === "array"
    ? Array.isArray(value[property])
    : typeof value[property] === expectedType;
}

/**
 * True when `value` is a class export carrying `method` on its prototype.
 *
 * A function with a prototype is never wrapped in the circular-require warning
 * proxy, so its prototype can be probed directly.
 *
 * @param {unknown} value
 * @param {string} method
 * @returns {boolean}
 */
function prototypeHasMethod(value, method) {
  return (
    typeof value === "function" &&
    Boolean(value.prototype) &&
    typeof value.prototype[method] === "function"
  );
}

module.exports = Object.freeze({ exportHas, prototypeHasMethod });
