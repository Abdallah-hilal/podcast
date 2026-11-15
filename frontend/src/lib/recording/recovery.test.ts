import { test } from "node:test";
import assert from "node:assert/strict";
import { planRecovery } from "./recovery.ts";
import { newManifest, withSealed, withUploaded, withFinalized } from "./manifest.ts";

const base = newManifest("r1", "s1");

test("a finalized take is just discarded locally", () => {
  assert.deepEqual(planRecovery(withFinalized(base), 30), { uploads: [], finalize: false, discard: true });
});

test("re-sends the unsent batch with its sequence, then the unsealed tail", () => {
  let m = withSealed(base, { seq: 0, start: 0, end: 11, size: 1 });
  m = withSealed(m, { seq: 1, start: 12, end: 23, size: 1 });
  m = withUploaded(m, 0);
  assert.deepEqual(planRecovery(m, 30), {
    uploads: [
      { seq: 1, start: 12, end: 23 },
      { seq: 2, start: 24, end: 29 },
    ],
    finalize: true,
    discard: false,
  });
});

test("everything already sent and no tail → only finalize", () => {
  let m = withSealed(base, { seq: 0, start: 0, end: 11, size: 1 });
  m = withUploaded(m, 0);
  assert.deepEqual(planRecovery(m, 12), { uploads: [], finalize: true, discard: false });
});

test("a short take that never sealed a batch uploads all chunks as batch 0", () => {
  assert.deepEqual(planRecovery(base, 7), {
    uploads: [{ seq: 0, start: 0, end: 6 }],
    finalize: true,
    discard: false,
  });
});

test("nothing recorded at all → discard", () => {
  assert.deepEqual(planRecovery(base, 0), { uploads: [], finalize: false, discard: true });
});
