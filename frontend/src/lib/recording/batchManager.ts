import type { OPFSStore } from "./opfsStore";

export interface Batch {
  id: string;
  sequenceNumber: number;
  startChunkIndex: number;
  endChunkIndex: number;
  totalSize: number;
  status: "accumulating" | "ready" | "uploading" | "uploaded" | "failed";
  /** Number of upload attempts that have failed. Reset to 0 on success. */
  failedAttempts: number;
  /** Most recent upload error message, for surfacing to the UI. */
  lastError?: string;
}

const TARGET_BATCH_SIZE = 64 * 1024 * 1024; // 64MB

export class BatchManager {
  private currentBatch: Batch;
  private sealedBatches: Batch[] = [];
  private nextSequence = 0;
  private currentChunkStart = 0;
  private currentSize = 0;
  private latestChunkIndex = -1;

  constructor() {
    this.currentBatch = this.newBatch();
  }

  private newBatch(): Batch {
    const batch: Batch = {
      id: crypto.randomUUID(),
      sequenceNumber: this.nextSequence++,
      startChunkIndex: this.currentChunkStart,
      endChunkIndex: this.currentChunkStart,
      totalSize: 0,
      status: "accumulating",
      failedAttempts: 0,
    };
    return batch;
  }

  addChunk(index: number, size: number): Batch | null {
    this.latestChunkIndex = index;
    this.currentBatch.endChunkIndex = index;
    this.currentBatch.totalSize += size;
    this.currentSize += size;

    if (this.currentSize >= TARGET_BATCH_SIZE) {
      return this.seal();
    }
    return null;
  }

  seal(): Batch {
    const sealed = { ...this.currentBatch, status: "ready" as const };
    this.sealedBatches.push(sealed);
    this.currentChunkStart = this.latestChunkIndex + 1;
    this.currentSize = 0;
    this.currentBatch = this.newBatch();
    return sealed;
  }

  sealFinal(): Batch | null {
    if (this.currentBatch.totalSize === 0) return null;
    return this.seal();
  }

  async assembleBatch(batch: Batch, store: OPFSStore): Promise<Blob> {
    return store.readChunkRange(batch.startChunkIndex, batch.endChunkIndex);
  }

  getSealedBatches(): Batch[] {
    return [...this.sealedBatches];
  }

  markUploaded(batchId: string) {
    const batch = this.sealedBatches.find((b) => b.id === batchId);
    if (batch) {
      batch.status = "uploaded";
      batch.lastError = undefined;
    }
  }

  markFailed(batchId: string, err: unknown) {
    const batch = this.sealedBatches.find((b) => b.id === batchId);
    if (!batch) return;
    batch.status = "failed";
    batch.failedAttempts += 1;
    batch.lastError = err instanceof Error ? err.message : String(err);
  }

  /** Batches not yet successfully uploaded. Includes "ready" and "failed". */
  getPendingBatches(): Batch[] {
    return this.sealedBatches.filter((b) => b.status !== "uploaded");
  }

  getProgress() {
    const total = this.sealedBatches.length;
    const uploaded = this.sealedBatches.filter(
      (b) => b.status === "uploaded"
    ).length;
    const failed = this.sealedBatches.filter(
      (b) => b.status === "failed"
    ).length;
    return { total, uploaded, failed, pending: total - uploaded };
  }
}
