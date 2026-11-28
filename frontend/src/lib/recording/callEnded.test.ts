// Run: node --test src/lib/recording/callEnded.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { workLeftAfterLeave, callEndedPhase, timeLeftText } from "./callEnded.ts";

test("Leave with nothing to finish navigates away", () => {
  assert.equal(workLeftAfterLeave("idle", false), false);
  assert.equal(workLeftAfterLeave("complete", false), false);
});

test("Leave mid-upload, mid-stop, after a failed upload or during recovery stays", () => {
  assert.equal(workLeftAfterLeave("uploading", false), true);
  assert.equal(workLeftAfterLeave("stopping", false), true);
  assert.equal(workLeftAfterLeave("error", false), true);
  assert.equal(workLeftAfterLeave("complete", true), true);
  assert.equal(workLeftAfterLeave("idle", true), true);
});

test("phase follows the pipeline and recovery", () => {
  assert.equal(callEndedPhase("uploading", false), "uploading");
  assert.equal(callEndedPhase("stopping", false), "uploading");
  assert.equal(callEndedPhase("complete", true), "uploading");
  assert.equal(callEndedPhase("complete", false), "saved");
  assert.equal(callEndedPhase("idle", false), "saved");
  assert.equal(callEndedPhase("error", true), "paused");
});

test("time left reads in minutes and hours", () => {
  assert.equal(timeLeftText(1_000, null), null);
  assert.equal(timeLeftText(0, 100), null);
  assert.equal(timeLeftText(3_000, 100), "Less than a minute left");
  assert.equal(timeLeftText(30 * 60 * 100, 100), "About 30 min left");
  assert.equal(timeLeftText(120 * 60 * 100, 100), "About 2 h left");
  // ~3.1 GB at the 1.7 Mbps home line ≈ 4 h 3 min
  assert.equal(timeLeftText(3.1e9, 1.7e6 / 8), "About 4 h 4 min left");
});
