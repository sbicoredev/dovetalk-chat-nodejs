import assert from "node:assert/strict";
import { test } from "node:test";

import { percentile, summarize } from "./stats.ts";

test("percentile uses the nearest rank", () => {
  const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 95), 95);
  assert.equal(percentile(sorted, 99), 99);
  assert.equal(percentile(sorted, 100), 100);
  assert.equal(percentile([7], 99), 7);
  assert.ok(Number.isNaN(percentile([], 50)));
});

test("summarize sorts its input and leaves it alone", () => {
  const values = [5, 1, 3];
  const summary = summarize(values);
  assert.deepEqual(values, [5, 1, 3]);
  assert.equal(summary.min, 1);
  assert.equal(summary.max, 5);
  assert.equal(summary.mean, 3);
  assert.equal(summary.count, 3);
});
