import type { OPFSStore } from "./opfsStore";

export interface Batch {
  id: string;
  sequenceNumber: number;
  startChunkIndex: number;
  endChunkIndex: number;
  totalSize: number;
  status: "accumulating" | "ready" | "uploading" | "uploaded";
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
    if (batch) batch.status = "uploaded";
  }

  getProgress() {
    const total = this.sealedBatches.length;
    const uploaded = this.sealedBatches.filter(
      (b) => b.status === "uploaded"
    ).length;
    return { total, uploaded, pending: total - uploaded };
  }
}
