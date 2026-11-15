import { test } from "node:test";
import assert from "node:assert/strict";
import { newManifest, withSealed, withUploaded, withFinalized, parseManifest } from "./manifest.ts";

test("a new manifest has no batches and isn't finalized", () => {
  const m = newManifest("r1", "s1");
  assert.deepEqual(m, { v: 1, recordingId: "r1", sessionId: "s1", batches: [], finalized: false });
});

test("sealing records the batch's chunk range; uploading marks it", () => {
  let m = newManifest("r1", "s1");
  m = withSealed(m, { seq: 0, start: 0, end: 11, size: 900 });
  m = withSealed(m, { seq: 1, start: 12, end: 23, size: 800 });
  m = withUploaded(m, 0);
  assert.deepEqual(m.batches, [
    { seq: 0, start: 0, end: 11, size: 900, uploaded: true },
    { seq: 1, start: 12, end: 23, size: 800, uploaded: false },
  ]);
});

test("sealing the same sequence twice keeps one entry", () => {
  let m = newManifest("r1", "s1");
  m = withSealed(m, { seq: 0, start: 0, end: 11, size: 900 });
  m = withSealed(m, { seq: 0, start: 0, end: 11, size: 900 });
  assert.equal(m.batches.length, 1);
});

test("helpers never mutate the input", () => {
  const m = newManifest("r1", "s1");
  withSealed(m, { seq: 0, start: 0, end: 1, size: 1 });
  withFinalized(m);
  assert.deepEqual(m.batches, []);
  assert.equal(m.finalized, false);
  assert.equal(withFinalized(m).finalized, true);
});

test("parseManifest rejects anything that isn't a v1 manifest", () => {
  assert.equal(parseManifest("{bad"), null);
  assert.equal(parseManifest('{"v":2}'), null);
  assert.equal(parseManifest('{"v":1,"recordingId":"r1"}'), null);
  const ok = JSON.stringify(newManifest("r1", "s1"));
  assert.deepEqual(parseManifest(ok), newManifest("r1", "s1"));
});

test("the local copy may be deleted only after the take finished uploading", async () => {
  const { canDiscardLocalCopy } = await import("./manifest.ts");
  assert.equal(canDiscardLocalCopy("complete"), true);
  for (const s of ["error", "uploading", "stopping", "recording", "idle"] as const) {
    assert.equal(canDiscardLocalCopy(s), false, s);
  }
});
