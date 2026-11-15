import type { TakeManifest } from "./manifest";

export type RecoveryUpload = { seq: number; start: number; end: number };
export type RecoveryPlan = { uploads: RecoveryUpload[]; finalize: boolean; discard: boolean };

/**
 * What it takes to finish a leftover take from its OPFS manifest and the
 * chunks on disk. Unsent sealed batches are re-sent under their own
 * sequence (register is idempotent and TUS upserts, so a batch that did
 * reach the server is simply overwritten with the same bytes); chunks after
 * the last sealed batch go up as the next sequence. If the tab died between
 * sealing a batch and saving the manifest, that tail reuses the lost batch's
 * sequence with a superset range — still consistent, for the same reason.
 */
export function planRecovery(m: TakeManifest, chunkCount: number): RecoveryPlan {
  if (m.finalized) return { uploads: [], finalize: false, discard: true };
  if (m.batches.length === 0 && chunkCount === 0) {
    return { uploads: [], finalize: false, discard: true };
  }

  const batches = [...m.batches].sort((a, b) => a.seq - b.seq);
  const uploads: RecoveryUpload[] = batches
    .filter((b) => !b.uploaded)
    .map(({ seq, start, end }) => ({ seq, start, end }));

  const lastEnd = batches.length ? Math.max(...batches.map((b) => b.end)) : -1;
  const nextSeq = batches.length ? Math.max(...batches.map((b) => b.seq)) + 1 : 0;
  if (chunkCount - 1 > lastEnd) {
    uploads.push({ seq: nextSeq, start: lastEnd + 1, end: chunkCount - 1 });
  }
  return { uploads, finalize: true, discard: false };
}
