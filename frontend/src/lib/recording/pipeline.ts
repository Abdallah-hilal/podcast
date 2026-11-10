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
  private token: string = "";
  private onStateChange?: (state: PipelineState) => void;

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

  /**
   * Begin a recording against `stream`. The caller is responsible for providing
   * the MediaStream — typically the LiveKit local-participant tracks so the
   * recording honors the user's device choice and doesn't open a second
   * getUserMedia session. For local-only mode, the caller opens its own via
   * `mediaRecorder.getRecordingStream(opts)` and passes `ownsStream: true`.
   */
  async start(
    sessionId: string,
    authToken: string,
    stream: MediaStream,
    opts?: { ownsStream?: boolean }
  ): Promise<void> {
    if (this._state !== "idle") throw new Error(`Cannot start from ${this._state}`);
    if (stream.getTracks().length === 0) {
      throw new Error("Recording stream has no tracks — turn on mic or camera first");
    }

    this.token = authToken;
    this.stream = stream;
    this.ownsStream = opts?.ownsStream ?? false;

    const settings = getStreamSettings(this.stream);
    const mimeType = getSupportedMimeType();
    if (!mimeType) throw new Error("No supported recording MIME type found");

    const videoSettings = settings.video;
    const recording = await api.startRecording(authToken, sessionId, {
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

    // Feed to batch manager
    const sealed = this.batchManager.addChunk(index, chunk.size);
    if (sealed) {
      this.uploadBatch(sealed).catch(console.error);
    }
  }

  private async uploadBatch(batch: ReturnType<BatchManager["seal"]>) {
    if (!this.recordingId) return;

    const blob = await this.batchManager.assembleBatch(batch, this.store);

    // Register batch with backend
    const registered = await api.registerBatch(this.token, this.recordingId, {
      sequence_number: batch.sequenceNumber,
      byte_size: batch.totalSize,
    });

    // Upload directly to Supabase via TUS (user JWT auth)
    await this.uploader.upload({
      batchId: registered.batch_id,
      blob,
      storagePath: registered.storage_path,
      authToken: this.token,
      onProgress: (uploaded) => {
        this.bytesUploaded += uploaded;
      },
    });

    // Mark complete
    await api.completeBatch(this.token, this.recordingId, registered.batch_id);
    this.batchManager.markUploaded(batch.id);
  }

  async stop(): Promise<void> {
    if (this._state !== "recording") return;
    if (!this.recorder || !this.recordingId) return;

    this.setState("stopping");

    // Stop MediaRecorder — waits for final ondataavailable
    await stopMediaRecorder(this.recorder);

    // Seal final batch
    const finalBatch = this.batchManager.sealFinal();

    this.setState("uploading");
    this.uploader.setThrottle(null); // Remove throttle

    // Upload final batch if exists
    if (finalBatch) {
      await this.uploadBatch(finalBatch);
    }

    // Wait for any in-progress uploads
    while (this.uploader.activeCount > 0) {
      await new Promise((r) => setTimeout(r, 500));
    }

    // Finalize
    await api.finalizeRecording(this.token, this.recordingId);

    // Only stop tracks the pipeline opened itself. A LiveKit-sourced stream
    // stays live — the video call is still in progress.
    if (this.ownsStream) {
      this.stream?.getTracks().forEach((t) => t.stop());
    }
    this.stream = null;

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
    };
  }
}
