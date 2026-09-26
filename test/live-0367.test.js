import { test } from "node:test";
import assert from "node:assert/strict";

test("fails on purpose for the 0367 live check", () => {
  assert.equal(1, 2);
});
