import * as tus from "tus-js-client";

export interface UploadTask {
  batchId: string;
  blob: Blob;
  storagePath: string;
  authToken: string;
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
}

const TUS_CHUNK_SIZE = 6 * 1024 * 1024; // 6MB — Supabase recommended
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const TUS_ENDPOINT = `${SUPABASE_URL}/storage/v1/upload/resumable`;

export class TusUploader {
  private activeUploads = new Map<string, tus.Upload>();
  private throttleBps: number | null = null;

  setThrottle(bps: number | null) {
    this.throttleBps = bps;
  }

  upload(task: UploadTask): Promise<void> {
    return new Promise((resolve, reject) => {
      const upload = new tus.Upload(task.blob, {
        endpoint: TUS_ENDPOINT,
        chunkSize: TUS_CHUNK_SIZE,
        retryDelays: [3000, 5000, 10000, 20000],
        headers: {
          Authorization: `Bearer ${task.authToken}`,
          apikey: SUPABASE_ANON_KEY,
          "x-upsert": "true",
        },
        metadata: {
          bucketName: "podcast-recordings",
          objectName: task.storagePath,
          contentType: "application/octet-stream",
          cacheControl: "3600",
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
