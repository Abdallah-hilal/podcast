import * as tus from "tus-js-client";
import { Pacer } from "./pacer";
import { smoothLinkBps } from "./liveRate";

export interface UploadTask {
  batchId: string;
  blob: Blob;
  storagePath: string;
  authToken: string;
  onProgress?: (bytesUploaded: number, bytesTotal: number) => void;
}

const TUS_CHUNK_SIZE = 6 * 1024 * 1024; // 6MB — Supabase recommended
// Smaller pieces while paced, so the rate limit is smooth rather than
// bursty (a 6 MB burst on a 1.7 Mbps uplink stalls the call for ~30 s).
const PACED_CHUNK_SIZE = 1024 * 1024;
// Above this limit the line is fast enough for full-size pieces; 1 MB
// requests would spend much of their time on per-request overhead.
const LARGE_CHUNK_ABOVE_BPS = 8_000_000;
// Requests smaller than this finish too fast to say much about the line.
const MIN_SAMPLE_BYTES = 256 * 1024;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const TUS_ENDPOINT = `${SUPABASE_URL}/storage/v1/upload/resumable`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TusUploader {
  private activeUploads = new Map<string, tus.Upload>();
  private pacer = new Pacer();
  // Read before every request, so a limit can change mid-upload (paced
  // while the call is live, full speed once recording stops).
  private limitBps: () => number | null = () => null;
  private linkBps: number | null = null;

  /** Smoothed upload speed of this uploader's own requests (bits/s), or
   *  null before the first one finishes. Feeds the live-call rate. */
  get measuredBps(): number | null {
    return this.linkBps;
  }

  /** Upload rate limit in bits/s (null = unlimited), evaluated per request. */
  setRateLimit(source: () => number | null) {
    this.limitBps = source;
  }

  upload(task: UploadTask): Promise<void> {
    const limit = this.limitBps();
    const chunkSize = limit && limit < LARGE_CHUNK_ABOVE_BPS ? PACED_CHUNK_SIZE : TUS_CHUNK_SIZE;
    // When the current PATCH left (after its pacing wait), to time it.
    let sentAt = 0;
    return new Promise((resolve, reject) => {
      const upload = new tus.Upload(task.blob, {
        endpoint: TUS_ENDPOINT,
        chunkSize,
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
        onBeforeRequest: async (req) => {
          if (req.getMethod() !== "PATCH") return;
          const wait = this.pacer.reserve(chunkSize, this.limitBps(), Date.now());
          if (wait > 0) await sleep(wait);
          sentAt = Date.now();
        },
        onChunkComplete: (size) => {
          const ms = Date.now() - sentAt;
          if (!sentAt || ms <= 0 || size < MIN_SAMPLE_BYTES) return;
          this.linkBps = smoothLinkBps(this.linkBps, (size * 8 * 1000) / ms);
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
