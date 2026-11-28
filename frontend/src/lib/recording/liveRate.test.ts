// Run: node --test src/lib/recording/liveRate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextLiveRate,
  smoothLinkBps,
  LIVE_RATE_START_BPS as START,
  LIVE_RATE_FLOOR_BPS as FLOOR,
  LIVE_RATE_MAX_BPS as MAX,
} from "./liveRate.ts";

const base = { current: START, quality: "excellent" as const, backlog: true, linkBps: null };

test("a healthy call with a backlog grows the limit", () => {
  assert.equal(nextLiveRate(base), START + 500_000);
  // Grows by a quarter once that beats the fixed step.
  assert.equal(nextLiveRate({ ...base, current: 8_000_000 }), 10_000_000);
});

test("no backlog: nothing to learn from, hold", () => {
  assert.equal(nextLiveRate({ ...base, backlog: false }), START);
  assert.equal(nextLiveRate({ ...base, current: 3_000_000, backlog: false }), 3_000_000);
});

test("growth stops at the cap", () => {
  assert.equal(nextLiveRate({ ...base, current: 48_000_000 }), MAX);
  assert.equal(nextLiveRate({ ...base, current: MAX }), MAX);
});

test("never more than half the measured uplink", () => {
  // The Egyptian home line: ~1.2 Mbps measured while the call runs.
  assert.equal(nextLiveRate({ ...base, current: START, linkBps: 1_200_000 }), 600_000);
  assert.equal(nextLiveRate({ ...base, current: 600_000, linkBps: 1_200_000 }), 600_000);
  // A measured drop pulls an already-high limit down even on "excellent".
  assert.equal(nextLiveRate({ ...base, current: 9_000_000, backlog: false, linkBps: 4_000_000 }), 2_000_000);
  // A very slow line still gets the floor.
  assert.equal(nextLiveRate({ ...base, linkBps: 200_000 }), FLOOR);
});

test("a good (not excellent) call halves the limit, down to the old default", () => {
  assert.equal(nextLiveRate({ ...base, quality: "good", current: 8_000_000 }), 4_000_000);
  assert.equal(nextLiveRate({ ...base, quality: "good", current: 700_000 }), START);
  assert.equal(nextLiveRate({ ...base, quality: "good", current: START }), START);
  // Below the default (after a poor spell) "good" holds rather than grows.
  assert.equal(nextLiveRate({ ...base, quality: "good", current: FLOOR }), FLOOR);
});

test("a poor or lost call drops straight to the floor", () => {
  assert.equal(nextLiveRate({ ...base, quality: "poor", current: 20_000_000 }), FLOOR);
  assert.equal(nextLiveRate({ ...base, quality: "lost", current: START }), FLOOR);
});

test("unknown quality holds", () => {
  assert.equal(nextLiveRate({ ...base, quality: "unknown", current: 2_000_000 }), 2_000_000);
});

test("from the floor, an excellent call climbs back", () => {
  let r = FLOOR;
  for (let i = 0; i < 3; i++) r = nextLiveRate({ ...base, current: r });
  assert.equal(r, FLOOR + 1_500_000);
});

test("smoothLinkBps starts at the first sample and then averages", () => {
  assert.equal(smoothLinkBps(null, 10_000_000), 10_000_000);
  assert.equal(smoothLinkBps(10_000_000, 20_000_000), 13_000_000);
});
