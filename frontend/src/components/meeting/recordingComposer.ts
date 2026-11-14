"use client";

/**
 * RecordingComposer — a STABLE MediaStream for the recording pipeline that
 * survives LiveKit's mid-call mic/camera toggles.
 *
 * Why this exists: `useTrackToggle` in @livekit/components-react ends (not
 * mutes) the underlying MediaStreamTrack when you turn off the camera, so
 * the OS indicator light goes off. A MediaRecorder bound to that raw track
 * then has no source → the video encoder freezes on the last frame and the
 * recording can't resume when the camera's turned back on because the track
 * reference is dead.
 *
 * We decouple the recording source from LiveKit:
 *   - Video: a hidden <video> plays the current LiveKit camera track; a
 *     canvas drawImage()s that video every rAF tick. Canvas.captureStream()
 *     is what the recorder reads. When the camera's off we draw a
 *     "Camera off" placeholder instead — the canvas track stays alive.
 *   - Audio: Web Audio's MediaStreamAudioDestinationNode sits in front of
 *     the LiveKit mic MediaStreamSource. Toggling mic swaps the source
 *     connection; the destination track stays alive and emits silence
 *     when nothing's connected.
 *
 * The stream returned by getStream() is a single, stable object — the
 * recording pipeline gets it once, and toggles never force it to re-start.
 */
export class RecordingComposer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private video: HTMLVideoElement;
  private currentVideoTrack: MediaStreamTrack | null = null;
  private rafId: number | null = null;
  // Once we've sized the canvas to the first live source we don't resize
  // again — MediaRecorder has mixed behaviour when the capture-stream frame
  // size changes mid-recording, and cover-fitting subsequent cameras into a
  // fixed canvas is the safe default. A device switch to a higher-res
  // camera therefore shows cropped-to-fit, not re-encoded.
  private sized = false;

  private audioCtx: AudioContext | null = null;
  private audioDest: MediaStreamAudioDestinationNode | null = null;
  private currentAudioSource: MediaStreamAudioSourceNode | null = null;

  private composedStream: MediaStream;
  private readonly fps: number;

  constructor(width: number, height: number, fps = 30) {
    this.fps = fps;
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    // Mark sized because the caller passed an explicit target — don't let
    // a mid-stream drawFrame bump the canvas to the source's native size.
    this.sized = true;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;

    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    // Keep it out of the layout but still playable. `display: none` stops
    // playback in some engines; the off-screen fixed layer plays.
    this.video.style.position = "fixed";
    this.video.style.left = "-10000px";
    this.video.style.top = "-10000px";
    this.video.style.width = "1px";
    this.video.style.height = "1px";
    this.video.style.opacity = "0";
    this.video.style.pointerEvents = "none";
    document.body.appendChild(this.video);

    // Paint the placeholder once so the first capture frame isn't a
    // transparent canvas (which some encoders don't handle).
    this.drawFrame();

    // Canvas video track + Web Audio destination track = the stable stream.
    this.composedStream = this.canvas.captureStream(this.fps);
    this.ensureAudio();
    const audioTrack = this.audioDest!.stream.getAudioTracks()[0];
    if (audioTrack) this.composedStream.addTrack(audioTrack);

    this.startDrawLoop();
  }

  /** Attach a new camera track (or null to show "Camera off" placeholder). */
  setCameraTrack(track: MediaStreamTrack | null): void {
    // No-op if it's the same ref — swapping srcObject tears down the <video>
    // and causes a visible flash on the recording.
    if (track === this.currentVideoTrack) return;
    this.currentVideoTrack = track;
    if (track) {
      const s = new MediaStream([track]);
      this.video.srcObject = s;
      // play() can reject if the tab is background or autoplay is blocked.
      // We don't care — the rAF loop keeps ticking either way.
      void this.video.play().catch(() => {});
    } else {
      this.video.srcObject = null;
    }
  }

  /** Attach a new mic track (or null for silence). */
  setMicTrack(track: MediaStreamTrack | null): void {
    this.ensureAudio();
    if (this.currentAudioSource) {
      try {
        this.currentAudioSource.disconnect();
      } catch {
        /* already disposed */
      }
      this.currentAudioSource = null;
    }
    if (!track || !this.audioCtx || !this.audioDest) return;
    try {
      const stream = new MediaStream([track]);
      this.currentAudioSource = this.audioCtx.createMediaStreamSource(stream);
      this.currentAudioSource.connect(this.audioDest);
    } catch (e) {
      console.warn("RecordingComposer: failed to connect mic source:", e);
    }
  }

  /** The stable output stream — hand to the recording pipeline once. */
  getStream(): MediaStream {
    return this.composedStream;
  }

  /** Clean up canvas loop, audio graph, and detach the video element. */
  dispose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.video.srcObject = null;
    this.video.remove();
    if (this.currentAudioSource) {
      try {
        this.currentAudioSource.disconnect();
      } catch {
        /* already gone */
      }
      this.currentAudioSource = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
      this.audioDest = null;
    }
    this.composedStream.getTracks().forEach((t) => t.stop());
  }

  private ensureAudio(): void {
    if (this.audioCtx && this.audioDest) return;
    try {
      // 48 kHz matches Opus / MediaRecorder's expected input; letting the
      // browser pick usually lands here anyway but being explicit avoids
      // sample-rate conversion overhead.
      this.audioCtx = new AudioContext({ sampleRate: 48000 });
      this.audioDest = this.audioCtx.createMediaStreamDestination();
    } catch (e) {
      console.warn("RecordingComposer: AudioContext unavailable:", e);
      this.audioCtx = null;
      this.audioDest = null;
    }
  }

  private startDrawLoop(): void {
    const tick = () => {
      this.drawFrame();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private drawFrame(): void {
    const { ctx, canvas, video } = this;
    const hasVideo =
      this.currentVideoTrack !== null &&
      this.currentVideoTrack.readyState === "live" &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0;

    if (hasVideo) {
      // First live frame locks the canvas to the source's native size,
      // so we don't waste pixels and so MediaRecorder sees one frame
      // dimension for the whole take.
      if (!this.sized) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        this.sized = true;
      }
      // Cover-fit the source into the (now fixed) canvas. Same-aspect
      // cameras paint full-bleed; different-aspect ones get a tasteful
      // crop rather than letterbox bars that look like a bug.
      const scale = Math.max(
        canvas.width / video.videoWidth,
        canvas.height / video.videoHeight,
      );
      const drawW = video.videoWidth * scale;
      const drawH = video.videoHeight * scale;
      const drawX = (canvas.width - drawW) / 2;
      const drawY = (canvas.height - drawH) / 2;
      if (drawX !== 0 || drawY !== 0) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(video, drawX, drawY, drawW, drawH);
    } else {
      // Camera-off placeholder. Gradient + icon + text, so an off segment in
      // playback looks intentional — not a glitch.
      const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
      gradient.addColorStop(0, "#0c1d24");
      gradient.addColorStop(1, "#061015");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);

      const r = Math.min(canvas.width, canvas.height) * 0.11;
      ctx.beginPath();
      ctx.arc(0, -r * 0.4, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = Math.max(4, r * 0.08);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(-r * 1.2, -r * 1.6);
      ctx.lineTo(r * 1.2, r * 0.4);
      ctx.strokeStyle = "rgba(237, 109, 72, 0.9)";
      ctx.lineWidth = Math.max(5, r * 0.09);
      ctx.lineCap = "round";
      ctx.stroke();

      ctx.fillStyle = "rgba(255,255,255,0.75)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const fontSize = Math.max(16, Math.round(canvas.height * 0.035));
      ctx.font = `600 ${fontSize}px system-ui, -apple-system, Segoe UI, sans-serif`;
      ctx.fillText("Camera off", 0, r * 1.5);

      ctx.restore();
    }
  }
}
