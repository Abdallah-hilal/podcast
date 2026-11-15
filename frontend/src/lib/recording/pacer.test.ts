import { test } from "node:test";
import assert from "node:assert/strict";
import { Pacer } from "./pacer.ts";

const MB = 1024 * 1024;

test("no limit → never waits", () => {
  const p = new Pacer();
  assert.equal(p.reserve(MB, null, 0), 0);
  assert.equal(p.reserve(MB, null, 0), 0);
});

test("spaces chunks so the average rate stays under the limit", () => {
  const p = new Pacer();
  // 1 MB at 1 Mbps = 8.388608 s per chunk
  assert.equal(p.reserve(MB, 1_000_000, 0), 0);
  assert.equal(Math.round(p.reserve(MB, 1_000_000, 100)), 8289);
  assert.equal(Math.round(p.reserve(MB, 1_000_000, 100)), 16677);
});

test("is shared across uploads: two callers still add up to one limit", () => {
  const p = new Pacer();
  p.reserve(MB, 2_000_000, 0);
  assert.equal(Math.round(p.reserve(MB, 2_000_000, 0)), 4194);
});

test("an idle gap doesn't bank credit for a burst later", () => {
  const p = new Pacer();
  p.reserve(MB, 1_000_000, 0);
  assert.equal(p.reserve(MB, 1_000_000, 60_000), 0);
  assert.ok(p.reserve(MB, 1_000_000, 60_000) > 8000);
});

test("lifting the limit takes effect immediately", () => {
  const p = new Pacer();
  p.reserve(MB, 1_000_000, 0);
  p.reserve(MB, 1_000_000, 0);
  assert.equal(p.reserve(MB, null, 10), 0);
});
