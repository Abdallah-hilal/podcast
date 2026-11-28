/**
 * How fast a recording may upload while the call is live.
 *
 * A fixed 500 kbps keeps a ~1.7 Mbps Egyptian home uplink usable for the
 * call, but wastes a fast line: someone on fiber could have the whole take
 * in the studio by the time the host presses Stop. So the limit adapts,
 * AIMD-style (grow gently while all is well, back off fast on trouble),
 * from two signals:
 *
 *   - LiveKit's connection quality for this participant: the call itself
 *     telling us it is suffering (loss, jitter, dropped video layers).
 *   - The uplink speed measured from our own upload requests. The limit
 *     never goes above a share of it, so the upload can't swallow the
 *     line even if LiveKit's score is slow to react.
 */

export type LinkQuality = "excellent" | "good" | "poor" | "lost" | "unknown";

/** Where every page starts: the old fixed limit, known to be safe. */
export const LIVE_RATE_START_BPS = 500_000;
/** Lowest it goes when the call is struggling. */
export const LIVE_RATE_FLOOR_BPS = 250_000;
/** Highest it goes on a healthy fast line. */
export const LIVE_RATE_MAX_BPS = 50_000_000;
/** Largest slice of the measured uplink the upload may take. */
export const LINK_SHARE = 0.5;

const STEP_BPS = 500_000;
const GROWTH = 1.25;

export function nextLiveRate({
  current,
  quality,
  backlog,
  linkBps,
}: {
  current: number;
  quality: LinkQuality;
  /** An upload is waiting on the limit — without one a higher limit proves nothing. */
  backlog: boolean;
  /** Measured upload speed of our own requests, or null before the first one. */
  linkBps: number | null;
}): number {
  let next: number;
  switch (quality) {
    case "poor":
    case "lost":
      next = LIVE_RATE_FLOOR_BPS;
      break;
    case "good":
      // Mild trouble: halve, but don't drop below the old safe default on
      // "good" alone — only a poor call goes lower than that.
      next = current <= LIVE_RATE_START_BPS ? current : Math.max(LIVE_RATE_START_BPS, current / 2);
      break;
    case "excellent":
      next = backlog ? Math.max(current + STEP_BPS, current * GROWTH) : current;
      break;
    default:
      next = current;
  }
  const ceiling = linkBps ? linkBps * LINK_SHARE : LIVE_RATE_MAX_BPS;
  next = Math.min(next, ceiling, LIVE_RATE_MAX_BPS);
  return Math.round(Math.max(LIVE_RATE_FLOOR_BPS, next));
}

/** Folds one measured request into a smoothed uplink speed. */
export function smoothLinkBps(previous: number | null, sample: number): number {
  return previous == null ? sample : previous * 0.7 + sample * 0.3;
}
