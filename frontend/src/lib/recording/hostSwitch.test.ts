// Run: node --test src/lib/recording/hostSwitch.test.ts  (Node 26 strips TS types)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoomSwitch, decideSwitchAction, recStatusAttr } from "./hostSwitch.ts";

const ON = { recording: true, run: "r1" };
const OFF = { recording: false, run: null };

test("parseRoomSwitch treats missing or broken metadata as off", () => {
  assert.deepEqual(parseRoomSwitch(undefined), OFF);
  assert.deepEqual(parseRoomSwitch(null), OFF);
  assert.deepEqual(parseRoomSwitch(""), OFF);
  assert.deepEqual(parseRoomSwitch("{bad"), OFF);
  assert.deepEqual(parseRoomSwitch('"just a string"'), OFF);
});

test("parseRoomSwitch reads the host's switch", () => {
  assert.deepEqual(parseRoomSwitch('{"recording":true,"run":"r1","changed_at":"x"}'), ON);
  assert.deepEqual(parseRoomSwitch('{"recording":false,"run":null}'), OFF);
  // A switch that's on but somehow has no run id is unusable → off.
  assert.deepEqual(parseRoomSwitch('{"recording":true}'), OFF);
});

test("switch on: starts once the stream is ready", () => {
  assert.equal(decideSwitchAction({ sw: ON, state: "idle", lastStartedRun: null, ready: true }), "start");
  assert.equal(decideSwitchAction({ sw: ON, state: "idle", lastStartedRun: null, ready: false }), "none");
  assert.equal(decideSwitchAction({ sw: ON, state: "error", lastStartedRun: "r0", ready: true }), "start");
});

test("switch on: never starts the same run twice", () => {
  assert.equal(decideSwitchAction({ sw: ON, state: "complete", lastStartedRun: "r1", ready: true }), "none");
  assert.equal(decideSwitchAction({ sw: ON, state: "error", lastStartedRun: "r1", ready: true }), "none");
  assert.equal(decideSwitchAction({ sw: ON, state: "idle", lastStartedRun: "r1", ready: true }), "none");
});

test("switch on: a new run after a finished one starts again", () => {
  assert.equal(decideSwitchAction({ sw: ON, state: "complete", lastStartedRun: "r0", ready: true }), "start");
});

test("switch on: keeps recording its own run, restarts on a new run", () => {
  assert.equal(decideSwitchAction({ sw: ON, state: "recording", lastStartedRun: "r1", ready: true }), "none");
  assert.equal(decideSwitchAction({ sw: ON, state: "recording", lastStartedRun: "r0", ready: true }), "stop");
});

test("switch on: waits for an upload in progress to finish", () => {
  assert.equal(decideSwitchAction({ sw: ON, state: "stopping", lastStartedRun: "r0", ready: true }), "none");
  assert.equal(decideSwitchAction({ sw: ON, state: "uploading", lastStartedRun: "r0", ready: true }), "none");
});

test("switch off: stops a running recording, otherwise does nothing", () => {
  assert.equal(decideSwitchAction({ sw: OFF, state: "recording", lastStartedRun: "r1", ready: true }), "stop");
  assert.equal(decideSwitchAction({ sw: OFF, state: "idle", lastStartedRun: null, ready: true }), "none");
  assert.equal(decideSwitchAction({ sw: OFF, state: "uploading", lastStartedRun: "r1", ready: true }), "none");
});

test("recStatusAttr maps pipeline state to the tile status", () => {
  assert.equal(recStatusAttr("idle"), "idle");
  assert.equal(recStatusAttr("recording"), "recording");
  assert.equal(recStatusAttr("stopping"), "uploading");
  assert.equal(recStatusAttr("uploading"), "uploading");
  assert.equal(recStatusAttr("complete"), "done");
  assert.equal(recStatusAttr("error"), "error");
});
