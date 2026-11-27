import { test } from "node:test";
import assert from "node:assert/strict";
import { createSerialQueue } from "./serialQueue.ts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("runs one task at a time, in the order they were added", async () => {
  const run = createSerialQueue();
  let active = 0, maxActive = 0;
  const order: number[] = [];
  const task = (n: number) => async () => {
    active++; maxActive = Math.max(maxActive, active);
    await tick();
    order.push(n);
    active--;
  };
  await Promise.all([1, 2, 3, 4].map((n) => run(task(n))));
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test("a failing task doesn't block the ones after it", async () => {
  const run = createSerialQueue();
  const done: string[] = [];
  const a = run(async () => { throw new Error("boom"); });
  const b = run(async () => { done.push("b"); });
  await assert.rejects(a, /boom/);
  await b;
  assert.deepEqual(done, ["b"]);
});
