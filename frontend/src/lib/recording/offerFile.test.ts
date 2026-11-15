import { test } from "node:test";
import assert from "node:assert/strict";
import { offerFile, type ShareNavigator } from "./offerFile.ts";

const file = new File(["x"], "take.webm", { type: "video/webm" });
const tick = () => new Promise((r) => setTimeout(r, 0));

function nav(share: () => Promise<void>, canShare = true): ShareNavigator {
  return { canShare: () => canShare, share };
}

test("offerFile returns without waiting for the share sheet", () => {
  let fallback = 0;
  const pending = new Promise<void>(() => {}); // sheet left open forever
  const how = offerFile(file, nav(() => pending), () => fallback++, () => {});
  assert.equal(how, "share");
  assert.equal(fallback, 0);
});

test("offerFile falls back to a download when sharing isn't allowed", async () => {
  let fallback = 0;
  const err = Object.assign(new Error("no activation"), { name: "NotAllowedError" });
  offerFile(file, nav(() => Promise.reject(err)), () => fallback++, () => {});
  await tick();
  assert.equal(fallback, 1);
});

test("offerFile does nothing more when the user cancels the sheet", async () => {
  let fallback = 0;
  const err = Object.assign(new Error("cancelled"), { name: "AbortError" });
  offerFile(file, nav(() => Promise.reject(err)), () => fallback++, () => {});
  await tick();
  assert.equal(fallback, 0);
});

test("offerFile downloads right away when the browser can't share files", () => {
  let fallback = 0;
  const how = offerFile(file, nav(() => Promise.resolve(), false), () => fallback++, () => {});
  assert.equal(how, "fallback");
  assert.equal(fallback, 1);
});

test("offerFile reports a completed share", async () => {
  let shared = 0;
  offerFile(file, nav(() => Promise.resolve()), () => {}, () => shared++);
  await tick();
  assert.equal(shared, 1);
});
