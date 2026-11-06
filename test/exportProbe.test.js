"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { exportHas, prototypeHasMethod } = require("../lib/exportProbe");

test("exportHas matches an own property of the expected type", () => {
  assert.equal(exportHas({ mutateState: () => {} }, "mutateState", "function"), true);
  assert.equal(exportHas({ names: [] }, "names", "array"), true);
  assert.equal(exportHas({ names: {} }, "names", "array"), false);
  assert.equal(exportHas({ port: 1 }, "port", "number"), true);
  assert.equal(exportHas({ port: "1" }, "port", "number"), false);
});

test("exportHas rejects non-objects rather than throwing", () => {
  for (const value of [null, undefined, 7, "str", true, Symbol("s")]) {
    assert.equal(exportHas(value, "anything", "function"), false);
  }
});

test("exportHas never reads an inherited property", () => {
  // The point of the helper: a prototype hit must not count as a match, because
  // on a half-built circular-require module that prototype is Node's warning
  // proxy and reading through it is what produces the heap snapshot.
  const parent = { inherited: () => {} };
  const child = Object.create(parent);
  assert.equal(exportHas(child, "inherited", "function"), false);
});

test("exportHas does not trip a throwing prototype", () => {
  const trap = new Proxy(
    {},
    {
      get() {
        throw new Error("prototype was read: exportHas must never do this");
      },
      has() {
        throw new Error("prototype was probed: exportHas must never do this");
      },
    },
  );
  const halfBuilt = Object.create(trap);
  assert.doesNotThrow(() => exportHas(halfBuilt, "missing", "function"));
  assert.equal(exportHas(halfBuilt, "missing", "function"), false);
});

test("prototypeHasMethod matches a class export", () => {
  class SlashService {
    Handle_SlashCmd() {}
  }
  assert.equal(prototypeHasMethod(SlashService, "Handle_SlashCmd"), true);
  assert.equal(prototypeHasMethod(SlashService, "Absent"), false);
});

test("prototypeHasMethod rejects non-functions and arrow functions", () => {
  assert.equal(prototypeHasMethod({ Handle_SlashCmd: () => {} }, "Handle_SlashCmd"), false);
  assert.equal(prototypeHasMethod(() => {}, "anything"), false);
  assert.equal(prototypeHasMethod(null, "anything"), false);
});
