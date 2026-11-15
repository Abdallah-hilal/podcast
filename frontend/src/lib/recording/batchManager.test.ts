import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchManager } from "./batchManager.ts";

test("seals a batch every 12 chunks (~60 s at the 5 s timeslice)", () => {
  const bm = new BatchManager();
  for (let i = 0; i < 11; i++) assert.equal(bm.addChunk(i, 1000), null);
  const sealed = bm.addChunk(11, 1000);
  assert.ok(sealed);
  assert.equal(sealed.sequenceNumber, 0);
  assert.equal(sealed.startChunkIndex, 0);
  assert.equal(sealed.endChunkIndex, 11);
  // The next batch starts right after.
  for (let i = 12; i < 23; i++) assert.equal(bm.addChunk(i, 1000), null);
  const second = bm.addChunk(23, 1000);
  assert.equal(second?.sequenceNumber, 1);
  assert.equal(second?.startChunkIndex, 12);
});

test("still seals early on size (64 MB)", () => {
  const bm = new BatchManager();
  const sealed = bm.addChunk(0, 64 * 1024 * 1024);
  assert.ok(sealed);
  assert.equal(sealed.endChunkIndex, 0);
});
