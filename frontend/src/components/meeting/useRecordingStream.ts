"use client";

import { useCallback } from "react";
import { useLocalParticipant } from "@livekit/components-react";
import { Track } from "livekit-client";

/**
 * Builds a MediaStream from the local LiveKit participant's camera + mic
 * tracks so the recording pipeline can reuse the same underlying devices the
 * user picked in PreJoin — no second `getUserMedia`, no extra device
 * contention.
 *
 * Returns:
 *   - `buildStream()`: snapshots the current publications and composes a
 *     MediaStream. Call this at the moment Record is clicked, not before,
 *     so toggling mic/cam right before pressing Record is picked up.
 *   - `isReady`: at least one of mic / camera is publishing a usable track.
 *
 * Caveat — intentional: if the user mutes or turns off a track MID-recording,
 * the underlying MediaStreamTrack ends and the recording loses that stream
 * from that point. ControlBar disables the mic/cam toggles while recording
 * to keep this from happening by accident.
 */
export function useRecordingStream() {
  const { localParticipant, microphoneTrack, cameraTrack } = useLocalParticipant();

  const micLive = !!microphoneTrack?.track && !microphoneTrack.isMuted;
  const camLive = !!cameraTrack?.track && !cameraTrack.isMuted;
  const isReady = micLive || camLive;

  const buildStream = useCallback((): MediaStream => {
    const stream = new MediaStream();
    const camPub = localParticipant.getTrackPublication(Track.Source.Camera);
    const micPub = localParticipant.getTrackPublication(Track.Source.Microphone);
    const camTrack = camPub?.track?.mediaStreamTrack;
    const micTrack = micPub?.track?.mediaStreamTrack;
    if (micTrack) stream.addTrack(micTrack);
    if (camTrack) stream.addTrack(camTrack);
    return stream;
  }, [localParticipant]);

  return { buildStream, isReady };
}
