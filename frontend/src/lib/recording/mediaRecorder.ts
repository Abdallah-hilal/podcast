const PREFERRED_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

export function getSupportedMimeType(): string | null {
  for (const mime of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

export interface RecorderCallbacks {
  onChunk: (chunk: Blob, index: number) => void;
  onError: (error: Error) => void;
  onStop: () => void;
}

export interface RecordingStreamOptions {
  cameraId?: string;
  micId?: string;
  /** Default: true. When false, no video track is requested. */
  camOn?: boolean;
  /** Default: true. When false, no audio track is requested. */
  micOn?: boolean;
}

/**
 * Open a MediaStream for recording. Used only by local-only mode (no live
 * call). In LiveKit mode the recording reuses the LiveKit tracks instead —
 * see `useRecordingStream()` — so the user's PreJoin device choice applies
 * to both the call and the recording with a single getUserMedia session.
 */
export async function getRecordingStream(
  opts: RecordingStreamOptions = {}
): Promise<MediaStream> {
  const { cameraId, micId, camOn = true, micOn = true } = opts;

  if (!camOn && !micOn) {
    throw new Error("Cannot record with both camera and microphone off");
  }

  const constraints: MediaStreamConstraints = {
    video: camOn
      ? {
          deviceId: cameraId ? { exact: cameraId } : undefined,
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        }
      : false,
    audio: micOn
      ? {
          deviceId: micId ? { exact: micId } : undefined,
          sampleRate: 48000,
          channelCount: 1,
        }
      : false,
  };

  return navigator.mediaDevices.getUserMedia(constraints);
}

export function getStreamSettings(stream: MediaStream) {
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  return {
    video: videoTrack?.getSettings() ?? null,
    audio: audioTrack?.getSettings() ?? null,
  };
}

/**
 * Pick a VP9/VP8 bitrate for the stream's actual resolution. A fixed 8 Mbps
 * was wasteful on a 360p mobile capture (2–3x the data needed) and still a
 * bit thin on 4K. These targets land at roughly 0.1 bits / pixel · frame for
 * VP9, which is where YouTube's VP9 recommendations sit for live-ish content.
 */
function pickVideoBitrate(stream: MediaStream): number {
  const settings = stream.getVideoTracks()[0]?.getSettings();
  const w = settings?.width ?? 1280;
  const h = settings?.height ?? 720;
  const pixels = w * h;
  if (pixels <= 640 * 480) return 1_500_000;
  if (pixels <= 1280 * 720) return 3_500_000;
  if (pixels <= 1920 * 1080) return 6_000_000;
  return 10_000_000;
}

export function createRecorder(
  stream: MediaStream,
  mimeType: string,
  callbacks: RecorderCallbacks
): MediaRecorder {
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: pickVideoBitrate(stream),
    audioBitsPerSecond: 128_000,
  });

  let chunkIndex = 0;

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      callbacks.onChunk(event.data, chunkIndex++);
    }
  };

  recorder.onerror = () => {
    callbacks.onError(new Error("MediaRecorder error"));
  };

  recorder.onstop = () => {
    callbacks.onStop();
  };

  return recorder;
}

export function startRecording(recorder: MediaRecorder, timesliceMs = 5000) {
  recorder.start(timesliceMs);
}

export function stopRecording(recorder: MediaRecorder): Promise<void> {
  return new Promise((resolve) => {
    const originalOnStop = recorder.onstop;
    recorder.onstop = (event) => {
      if (originalOnStop) originalOnStop.call(recorder, event);
      resolve();
    };
    recorder.stop();
  });
}
