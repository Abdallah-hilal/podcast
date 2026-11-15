import { test } from "node:test";
import assert from "node:assert/strict";
import { createSingleFlight } from "./singleFlight.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
}

test("singleFlight: overlapping calls share one run and one promise", async () => {
  let runs = 0;
  const d = deferred();
  const flight = createSingleFlight<void>();
  const a = flight(() => (runs++, d.promise));
  // A second caller (even with a different function) joins the first run.
  const b = flight(async () => {
    runs += 100;
  });
  assert.equal(a, b);
  assert.equal(runs, 1);
  d.resolve();
  await a;
});

test("singleFlight: a call after the run settles starts a new run", async () => {
  let runs = 0;
  const flight = createSingleFlight<void>();
  const fn = async () => {
    runs++;
  };
  await flight(fn);
  await flight(fn);
  assert.equal(runs, 2);
});

test("singleFlight: a rejected run clears so the next call retries", async () => {
  let runs = 0;
  const flight = createSingleFlight<void>();
  const fn = async () => {
    runs++;
    if (runs === 1) throw new Error("boom");
  };
  await assert.rejects(flight(fn), /boom/);
  await flight(fn);
  assert.equal(runs, 2);
});
