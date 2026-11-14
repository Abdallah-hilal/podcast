const PREFERRED_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
  // Safari emits fragmented MP4. The worker's byte-concat was designed for
  // WebM clusters; fMP4 fragments can also concatenate into a playable file
  // on recent builds, but it's untested here — hence the "limited" warning
  // we surface when this branch is picked.
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
];

export function getSupportedMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const mime of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

export type RecordingSupportQuality = "excellent" | "limited" | "unsupported";

export interface RecordingSupport {
  supported: boolean;
  mimeType: string | null;
  quality: RecordingSupportQuality;
  message?: string;
}

/**
 * Probe MediaRecorder support so the UI can warn (or block) BEFORE the user
 * tries to hit Record. Safari lands on the "limited" branch because its
 * fMP4 output path hasn't been exercised end-to-end here; Chrome / Firefox /
 * Edge hit the WebM branch and are marked excellent.
 */
export function checkRecordingSupport(): RecordingSupport {
  if (typeof MediaRecorder === "undefined") {
    return {
      supported: false,
      mimeType: null,
      quality: "unsupported",
      message:
        "This browser can't record locally. Please use the latest Chrome, Firefox, or Edge.",
    };
  }
  const mime = getSupportedMimeType();
  if (!mime) {
    return {
      supported: false,
      mimeType: null,
      quality: "unsupported",
      message:
        "No supported recording format in this browser. Please use Chrome, Firefox, or Edge.",
    };
  }
  if (mime.startsWith("video/mp4")) {
    return {
      supported: true,
      mimeType: mime,
      quality: "limited",
      message:
        "Recording works in Safari, but quality is best in Chrome, Firefox, or Edge.",
    };
  }
  return { supported: true, mimeType: mime, quality: "excellent" };
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
          // Ask for 4K; the camera driver will land on its native max if it
          // can't deliver that (Osmo Pocket 3 does 4K60; a laptop webcam
          // typically negotiates down to 1080p or 720p).
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 30 },
        }
      : false,
    audio: micOn
      ? {
          deviceId: micId ? { exact: micId } : undefined,
          sampleRate: 48000,
          // Prefer stereo for podcast-grade audio; mono if the device can't.
          channelCount: { ideal: 2 },
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
 * Pick a VP9/VP8 bitrate for the stream's actual resolution. Scales with the
 * pixel count so a 360p mobile capture doesn't burn 8 Mbps and a 4K capture
 * from a Pocket 3 isn't starved of bits. Targets roughly 0.1 bits per pixel
 * per frame for VP9, matching YouTube's VP9 recommendations for 30fps
 * recording-grade content. Pushes 4K up to 25 Mbps — that's the YouTube
 * upload target for 4K30 VP9 and plenty for post-production.
 */
function pickVideoBitrate(stream: MediaStream): number {
  const settings = stream.getVideoTracks()[0]?.getSettings();
  const w = settings?.width ?? 1280;
  const h = settings?.height ?? 720;
  const pixels = w * h;
  if (pixels <= 640 * 480) return 1_500_000;
  if (pixels <= 1280 * 720) return 3_500_000;
  if (pixels <= 1920 * 1080) return 6_000_000;
  if (pixels <= 2560 * 1440) return 15_000_000;
  if (pixels <= 3840 * 2160) return 25_000_000;
  return 40_000_000; // 8K and beyond — someone's dreaming big
}

export function createRecorder(
  stream: MediaStream,
  mimeType: string,
  callbacks: RecorderCallbacks
): MediaRecorder {
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: pickVideoBitrate(stream),
    // 192 kbps Opus is transparent for stereo voice + music beds; mono
    // plays through the same codec perfectly fine.
    audioBitsPerSecond: 192_000,
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
