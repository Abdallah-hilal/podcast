/**
 * Upload rate limiter shared by every upload of one uploader: each request
 * reserves the next slot and waits until it. With a 1.7 Mbps home uplink
 * (typical in Egypt) an unpaced upload would starve the live call; pacing
 * keeps recording uploads to a small slice while LiveKit has the rest.
 */
export class Pacer {
  private next = 0;

  /** Milliseconds to wait before sending `bytes` at `bps` (null = no limit). */
  reserve(bytes: number, bps: number | null, now: number): number {
    if (!bps) return 0;
    const start = Math.max(now, this.next);
    this.next = start + ((bytes * 8) / bps) * 1000;
    return start - now;
  }
}
