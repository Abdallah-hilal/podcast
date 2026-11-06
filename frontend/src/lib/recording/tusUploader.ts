import * as tus from "tus-js-client";

export interface UploadTask {
  batchId: string;
  blob: Blob;
  uploadUrl: string;
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
}

const TUS_CHUNK_SIZE = 6 * 1024 * 1024; // 6MB — Supabase recommended

export class TusUploader {
  private activeUploads = new Map<string, tus.Upload>();
  private throttleBps: number | null = null;

  setThrottle(bps: number | null) {
    this.throttleBps = bps;
  }

  upload(task: UploadTask): Promise<void> {
    return new Promise((resolve, reject) => {
      const upload = new tus.Upload(task.blob, {
        endpoint: task.uploadUrl,
        chunkSize: TUS_CHUNK_SIZE,
        retryDelays: [3000, 5000, 10000, 20000],
        metadata: {
          contentType: "application/octet-stream",
        },
        onProgress: (bytesUploaded, bytesTotal) => {
          task.onProgress?.(bytesUploaded, bytesTotal);
        },
        onSuccess: () => {
          this.activeUploads.delete(task.batchId);
          resolve();
        },
        onError: (error) => {
          this.activeUploads.delete(task.batchId);
          reject(error);
        },
      });

      this.activeUploads.set(task.batchId, upload);
      upload.start();
    });
  }

  pauseAll() {
    for (const upload of this.activeUploads.values()) {
      upload.abort();
    }
  }

  get activeCount() {
    return this.activeUploads.size;
  }
}
