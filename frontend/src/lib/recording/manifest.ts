/**
 * Per-take progress file kept next to the chunks in OPFS
 * (recordings/<recordingId>/manifest.json). It records which chunk range
 * each sealed batch covers and whether it reached the server, so a page
 * that comes back after a refresh or crash can finish the take (recovery.ts).
 */
export type ManifestBatch = {
  seq: number;
  start: number; // first chunk index (inclusive)
  end: number; // last chunk index (inclusive)
  size: number;
  uploaded: boolean;
};

export type TakeManifest = {
  v: 1;
  recordingId: string;
  sessionId: string;
  batches: ManifestBatch[];
  finalized: boolean;
};

export function newManifest(recordingId: string, sessionId: string): TakeManifest {
  return { v: 1, recordingId, sessionId, batches: [], finalized: false };
}

export function withSealed(
  m: TakeManifest,
  b: { seq: number; start: number; end: number; size: number },
): TakeManifest {
  if (m.batches.some((x) => x.seq === b.seq)) return m;
  return { ...m, batches: [...m.batches, { ...b, uploaded: false }] };
}

export function withUploaded(m: TakeManifest, seq: number): TakeManifest {
  return { ...m, batches: m.batches.map((b) => (b.seq === seq ? { ...b, uploaded: true } : b)) };
}

export function withFinalized(m: TakeManifest): TakeManifest {
  return { ...m, finalized: true };
}

export function parseManifest(text: string): TakeManifest | null {
  try {
    const m = JSON.parse(text) as Partial<TakeManifest>;
    if (
      m?.v === 1 &&
      typeof m.recordingId === "string" &&
      typeof m.sessionId === "string" &&
      Array.isArray(m.batches) &&
      typeof m.finalized === "boolean"
    ) {
      return m as TakeManifest;
    }
  } catch {
    /* corrupt */
  }
  return null;
}
