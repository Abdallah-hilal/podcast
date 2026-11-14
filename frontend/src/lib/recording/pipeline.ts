import type { PipelineProgress, PipelineState } from "@/types";
import * as api from "@/lib/api";
import { BatchManager } from "./batchManager";
import {
  createRecorder,
  getSupportedMimeType,
  getStreamSettings,
  startRecording as startMediaRecorder,
  stopRecording as stopMediaRecorder,
} from "./mediaRecorder";
import { OPFSStore } from "./opfsStore";
import { TusUploader } from "./tusUploader";

const THROTTLE_BPS = 2_000_000; // 2 Mbps during live call
const MAX_BATCH_ATTEMPTS = 3;
// Give the final wait a ceiling — a hung upload shouldn't trap the user in
// "uploading…" forever. 3 min accommodates a slow-but-recovering connection
// finishing a large batch; anything longer is a real network failure.
const STOP_WAIT_TIMEOUT_MS = 180_000;

export type TokenGetter = () => Promise<string>;

export class RecordingPipeline {
  private _state: PipelineState = "idle";
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  // When the caller supplies the stream (e.g. from LiveKit), we must NOT stop
  // its tracks on stop() — the video call still needs them. Only streams we
  // opened ourselves via getUserMedia get torn down here.
  private ownsStream = false;
  private store = new OPFSStore();
  private batchManager = new BatchManager();
  private uploader = new TusUploader();
  private recordingId: string | null = null;
  private startTime = 0;
  private bytesRecorded = 0;
  private bytesUploaded = 0;
  private chunksRecorded = 0;
  private lastError?: string;
  // Called before every backend API call and every TUS upload to pull a
  // fresh Supabase JWT. Avoids baking a token at start() that would expire
  // after an hour mid-session and silently 401 every upload.
  private getToken: TokenGetter = async () => {
    throw new Error("Pipeline not started");
  };
  private onStateChange?: (state: PipelineState) => void;
  // Optional local file writer. When set (PreJoin's "Save a local copy to my
  // device" was ticked and the user picked a file), every MediaRecorder chunk
  // is also written to this stream, in parallel with OPFS + cloud upload.
  // Independent failure: a stream.write() error stays logged; it never fails
  // the chunk's cloud path.
  private localWriter: FileSystemWritableFileStream | null = null;
  private localChunkError: string | null = null;

  get state(): PipelineState {
    return this._state;
  }

  private setState(state: PipelineState) {
    this._state = state;
    this.onStateChange?.(state);
  }

  setOnStateChange(cb: (state: PipelineState) => void) {
    this.onStateChange = cb;
  }

  /** Clear per-recording state so a second take can reuse this instance. */
  private reset(): void {
    // The local writer is a resource — close it (fire-and-forget) before
    // dropping the reference so the OS flushes any buffered bytes.
    if (this.localWriter) {
      void this.localWriter.close().catch(() => {
        /* best-effort flush; nothing we can do if the handle is gone */
      });
      this.localWriter = null;
    }
    this.localChunkError = null;
    this.recorder = null;
    this.stream = null;
    this.ownsStream = false;
    this.store = new OPFSStore();
    this.batchManager = new BatchManager();
    this.uploader = new TusUploader();
    this.recordingId = null;
    this.startTime = 0;
    this.bytesRecorded = 0;
    this.bytesUploaded = 0;
    this.chunksRecorded = 0;
    this.lastError = undefined;
    this._state = "idle";
  }

  /**
   * Begin a recording against `stream`. The caller is responsible for providing
   * the MediaStream — typically the LiveKit local-participant tracks so the
   * recording honors the user's device choice and doesn't open a second
   * getUserMedia session. For local-only mode, the caller opens its own via
   * `mediaRecorder.getRecordingStream(opts)` and passes `ownsStream: true`.
   *
   * `getToken` is called before every API/upload request; it should pull a
   * fresh Supabase access token (Supabase SDK refreshes internally), so a
   * session longer than the JWT lifetime (1h default) doesn't 401 mid-way.
   */
  async start(
    sessionId: string,
    getToken: TokenGetter,
    stream: MediaStream,
    opts?: {
      ownsStream?: boolean;
      /**
       * If provided, each chunk is written to this file in parallel with
       * OPFS and the cloud upload. The file ends up being the raw recorder
       * container (WebM on Chrome/Edge/Firefox, MP4 on Safari) of THIS
       * side's stream — not the server-side composite.
       */
      localFileHandle?: FileSystemFileHandle | null;
    }
  ): Promise<void> {
    // Allow restarting after a finished or failed run — otherwise "Record
    // again" in the UI throws because the pipeline is still in a terminal
    // state from the previous take.
    if (this._state === "complete" || this._state === "error") {
      this.reset();
    }
    if (this._state !== "idle") throw new Error(`Cannot start from ${this._state}`);
    if (stream.getTracks().length === 0) {
      throw new Error("Recording stream has no tracks — turn on mic or camera first");
    }

    this.getToken = getToken;
    this.stream = stream;
    this.ownsStream = opts?.ownsStream ?? false;

    // Open the local-save writer BEFORE the recorder starts so if the file
    // handle is stale (page was backgrounded long enough for the browser to
    // revoke the grant, etc.) we surface it as a start-time error rather
    // than losing the first few chunks mid-recording.
    if (opts?.localFileHandle) {
      try {
        this.localWriter = await opts.localFileHandle.createWritable({
          keepExistingData: false,
        });
      } catch (e) {
        this.localWriter = null;
        this.localChunkError = e instanceof Error ? e.message : String(e);
        console.warn("Local-save writer could not be opened:", e);
      }
    }

    const settings = getStreamSettings(this.stream);
    const mimeType = getSupportedMimeType();
    if (!mimeType) throw new Error("No supported recording MIME type found");

    const videoSettings = settings.video;
    const token = await getToken();
    const recording = await api.startRecording(token, sessionId, {
      mime_type: mimeType,
      actual_width: videoSettings?.width ?? 0,
      actual_height: videoSettings?.height ?? 0,
      fps: videoSettings?.frameRate ?? 0,
    });
    this.recordingId = recording.recording_id;

    await this.store.init(this.recordingId);

    this.uploader.setThrottle(THROTTLE_BPS);
    this.setState("recording");
    this.startTime = Date.now();

    this.recorder = createRecorder(this.stream, mimeType, {
      onChunk: (chunk, index) => this.handleChunk(chunk, index),
      onError: (err) => {
        console.error("Recording error:", err);
        this.setState("error");
      },
      onStop: () => {},
    });

    startMediaRecorder(this.recorder);
  }

  private async handleChunk(chunk: Blob, index: number) {
    this.bytesRecorded += chunk.size;
    this.chunksRecorded++;

    // Write to OPFS
    await this.store.writeChunk(index, chunk);

    // Tee to the local-save file, if the user picked one in PreJoin. Any
    // failure here is isolated — never block the cloud path. We stash the
    // last error on `lastError`-adjacent state so the UI can surface it,
    // then drop the writer so subsequent chunks don't repeat the failure.
    if (this.localWriter) {
      try {
        await this.localWriter.write(chunk);
      } catch (e) {
        this.localChunkError = e instanceof Error ? e.message : String(e);
        console.warn(`Local-save write failed on chunk ${index}:`, e);
        try {
          await this.localWriter.close();
        } catch {
          /* already broken */
        }
        this.localWriter = null;
      }
    }

    // Feed to batch manager
    const sealed = this.batchManager.addChunk(index, chunk.size);
    if (sealed) {
      void this.attemptUpload(sealed);
    }
  }

  /**
   * Fire-and-forget upload wrapper that catches failures and marks the batch
   * so stop() can retry it later, rather than silently logging to the console
   * and leaving the pipeline unable to finalize.
   */
  private async attemptUpload(batch: ReturnType<BatchManager["seal"]>) {
    try {
      await this.uploadBatch(batch);
    } catch (err) {
      this.batchManager.markFailed(batch.id, err);
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn(
        `Batch ${batch.sequenceNumber} failed (attempt ${batch.failedAttempts + 1}):`,
        err,
      );
    }
  }

  private async uploadBatch(batch: ReturnType<BatchManager["seal"]>) {
    if (!this.recordingId) return;

    const blob = await this.batchManager.assembleBatch(batch, this.store);

    // Fresh token at every stage — register, upload, complete — so an
    // expiring JWT doesn't 401 one call out of three.
    let token = await this.getToken();
    const registered = await api.registerBatch(token, this.recordingId, {
      sequence_number: batch.sequenceNumber,
      byte_size: batch.totalSize,
    });

    token = await this.getToken();
    // TUS reports cumulative bytes per upload; track the delta since the
    // last tick so our running total matches reality instead of growing
    // quadratically with each batch.
    let lastReported = 0;
    await this.uploader.upload({
      batchId: registered.batch_id,
      blob,
      storagePath: registered.storage_path,
      authToken: token,
      onProgress: (uploaded) => {
        this.bytesUploaded += uploaded - lastReported;
        lastReported = uploaded;
      },
    });

    token = await this.getToken();
    await api.completeBatch(token, this.recordingId, registered.batch_id);
    this.batchManager.markUploaded(batch.id);
  }

  async stop(): Promise<void> {
    if (this._state !== "recording") return;
    if (!this.recorder || !this.recordingId) return;

    this.setState("stopping");

    // Stop MediaRecorder — waits for final ondataavailable
    await stopMediaRecorder(this.recorder);

    // Close the local-save file now that MediaRecorder has emitted its final
    // chunk and handleChunk has drained it. close() flushes any buffered
    // bytes to disk; without it the tail of the recording stays in memory.
    if (this.localWriter) {
      try {
        await this.localWriter.close();
      } catch (e) {
        this.localChunkError = e instanceof Error ? e.message : String(e);
        console.warn("Local-save close failed:", e);
      }
      this.localWriter = null;
    }

    // Seal final batch
    const finalBatch = this.batchManager.sealFinal();

    this.setState("uploading");
    this.uploader.setThrottle(null); // Remove throttle

    // Push the final batch (if any) through the retry wrapper so it joins
    // whatever else may need retrying rather than being special.
    if (finalBatch) {
      void this.attemptUpload(finalBatch);
    }

    // Wait for any in-progress uploads to settle, bounded by STOP_WAIT_TIMEOUT_MS.
    const waitDeadline = Date.now() + STOP_WAIT_TIMEOUT_MS;
    while (this.uploader.activeCount > 0 && Date.now() < waitDeadline) {
      await new Promise((r) => setTimeout(r, 500));
    }

    // Retry every batch still pending — a connection hiccup during recording
    // shouldn't fail the whole finalize if the network is back now.
    for (const pending of this.batchManager.getPendingBatches()) {
      if (Date.now() >= waitDeadline) break;
      if (pending.failedAttempts >= MAX_BATCH_ATTEMPTS) continue;
      await this.attemptUpload(pending);
    }

    // Final tally — if anything still hasn't uploaded, surface an error
    // instead of calling /finalize (which would 400 on missing batches).
    const stillPending = this.batchManager.getPendingBatches();
    if (stillPending.length > 0) {
      this.lastError =
        `${stillPending.length} batch(es) failed to upload` +
        (this.lastError ? ` (${this.lastError})` : "");
      this.setState("error");
      // Keep the stream live so the caller can decide whether to retry.
      return;
    }

    const finalToken = await this.getToken();
    await api.finalizeRecording(finalToken, this.recordingId);

    // Only stop tracks the pipeline opened itself. A LiveKit-sourced stream
    // stays live — the video call is still in progress.
    if (this.ownsStream) {
      this.stream?.getTracks().forEach((t) => t.stop());
    }
    this.stream = null;

    // Local chunks are safe to drop now that the final file is on Supabase.
    // Fire-and-forget: a cleanup failure is non-fatal, the chunks just linger
    // in the user's OPFS until the next session reclaims the directory.
    void this.store.cleanup().catch((err) => {
      console.warn("OPFS cleanup failed (non-fatal):", err);
    });

    this.setState("complete");
  }

  getProgress(): PipelineProgress {
    const batchProgress = this.batchManager.getProgress();
    return {
      state: this._state,
      elapsedMs: this._state === "idle" ? 0 : Date.now() - this.startTime,
      bytesRecorded: this.bytesRecorded,
      bytesUploaded: this.bytesUploaded,
      chunksRecorded: this.chunksRecorded,
      batchesSealed: batchProgress.total,
      batchesUploaded: batchProgress.uploaded,
      batchesFailed: batchProgress.failed,
      lastError: this.lastError,
    };
  }
}
