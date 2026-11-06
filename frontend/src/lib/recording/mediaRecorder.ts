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

export async function getRecordingStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 },
    },
    audio: {
      sampleRate: 48000,
      channelCount: 1,
    },
  });
}

export function getStreamSettings(stream: MediaStream) {
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  return {
    video: videoTrack?.getSettings() ?? null,
    audio: audioTrack?.getSettings() ?? null,
  };
}

export function createRecorder(
  stream: MediaStream,
  mimeType: string,
  callbacks: RecorderCallbacks
): MediaRecorder {
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
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
