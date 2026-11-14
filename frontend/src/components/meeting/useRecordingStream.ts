"use client";

import { useCallback, useEffect, useRef } from "react";
import { useLocalParticipant } from "@livekit/components-react";
import { Track } from "livekit-client";
import { RecordingComposer } from "./recordingComposer";

/**
 * Builds a STABLE MediaStream for the recording pipeline that survives the
 * user toggling camera / mic / device mid-call. See RecordingComposer for
 * the architecture — the short version is that we draw LiveKit's current
 * camera track into a canvas (captureStream for video) and route its mic
 * track through a Web Audio graph (MediaStreamAudioDestinationNode for
 * audio). Toggling LiveKit's tracks swaps the composer's internal sources;
 * the output stream reference doesn't change, so MediaRecorder keeps
 * running without noticing.
 *
 * API:
 *   - `buildStream()`: creates the composer (lazy) at the resolution the
 *     camera is actually publishing, so the bitrate picker in
 *     mediaRecorder.ts sees real dimensions instead of a 1280x720 default.
 *     Returns the composer's stable MediaStream.
 *   - `isReady`: at least one of mic / camera is currently publishing.
 */
export function useRecordingStream() {
  const { localParticipant, microphoneTrack, cameraTrack } = useLocalParticipant();

  // One composer per hook instance (i.e. per session page). Built lazily
  // on first buildStream() so we know the target canvas resolution.
  const composerRef = useRef<RecordingComposer | null>(null);

  // Watch for LiveKit camera track changes and swap the composer's video
  // source. `cameraTrack?.track?.mediaStreamTrack` identity is what matters
  // — on re-enable LiveKit creates a fresh MediaStreamTrack, and we need
  // to re-attach it to the hidden <video> so new frames flow to the canvas.
  const camMst = cameraTrack?.track?.mediaStreamTrack ?? null;
  const camMuted = !!cameraTrack?.isMuted;
  useEffect(() => {
    // isMuted flips when the user soft-mutes without ending the track;
    // treat that as "camera off" from the recording's perspective too.
    composerRef.current?.setCameraTrack(camMuted ? null : camMst);
  }, [camMst, camMuted]);

  const micMst = microphoneTrack?.track?.mediaStreamTrack ?? null;
  const micMuted = !!microphoneTrack?.isMuted;
  useEffect(() => {
    composerRef.current?.setMicTrack(micMuted ? null : micMst);
  }, [micMst, micMuted]);

  // Tear the composer down when the hook unmounts (leaving the session) so
  // the canvas rAF loop, audio graph and hidden <video> element don't leak.
  useEffect(() => {
    return () => {
      composerRef.current?.dispose();
      composerRef.current = null;
    };
  }, []);

  const camLive = !!cameraTrack?.track && !cameraTrack.isMuted;
  const micLive = !!microphoneTrack?.track && !micMuted;
  const isReady = micLive || camLive;

  const buildStream = useCallback((): MediaStream => {
    if (typeof window === "undefined") throw new Error("Browser only");

    const camPub = localParticipant.getTrackPublication(Track.Source.Camera);
    const micPub = localParticipant.getTrackPublication(Track.Source.Microphone);
    const camTrack = camPub?.track?.mediaStreamTrack ?? null;
    const micTrack = micPub?.track?.mediaStreamTrack ?? null;

    if (!composerRef.current) {
      // Size the canvas to the current camera track's native resolution
      // so MediaRecorder's bitrate picker (which reads getSettings() off
      // the composed stream) sees the true dimensions. Fallback to 1280x720
      // if the camera is off at Record time — a safe default that the
      // placeholder renders cleanly into.
      const settings = camTrack?.getSettings();
      const width = settings?.width ?? 1280;
      const height = settings?.height ?? 720;
      composerRef.current = new RecordingComposer(width, height, 30);
    }
    composerRef.current.setCameraTrack(camTrack);
    composerRef.current.setMicTrack(micTrack);
    return composerRef.current.getStream();
  }, [localParticipant]);

  return { buildStream, isReady };
}
