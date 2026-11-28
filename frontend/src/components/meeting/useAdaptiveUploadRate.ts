"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useConnectionQualityIndicator, useLocalParticipant } from "@livekit/components-react";
import { ConnectionQuality } from "livekit-client";
import type { RecordingPipeline } from "@/lib/recording/pipeline";
import { nextLiveRate, type LinkQuality } from "@/lib/recording/liveRate";

// LiveKit scores the connection every few seconds; give each raise time to
// show up in the score before the next one.
const TICK_MS = 10_000;

function toLinkQuality(q: ConnectionQuality): LinkQuality {
  switch (q) {
    case ConnectionQuality.Excellent:
      return "excellent";
    case ConnectionQuality.Good:
      return "good";
    case ConnectionQuality.Poor:
      return "poor";
    case ConnectionQuality.Lost:
      return "lost";
    default:
      return "unknown";
  }
}

/**
 * Lives inside LiveKitRoom. While this person is recording, retunes the
 * pipeline's live upload limit from the call's connection quality and the
 * measured uplink (see liveRate.ts): raises it every TICK_MS while the call
 * is excellent, cuts it the moment the score drops.
 */
export function useAdaptiveUploadRate(
  pipelineRef: RefObject<RecordingPipeline>,
  recording: boolean,
) {
  const { localParticipant } = useLocalParticipant();
  const { quality } = useConnectionQualityIndicator({ participant: localParticipant });
  const qualityRef = useRef<LinkQuality>("unknown");

  const retune = useCallback(() => {
    const pipeline = pipelineRef.current;
    if (!pipeline) return;
    const current = pipeline.liveRate;
    const backlog = pipeline.hasUploadBacklog;
    const link = pipeline.measuredLinkBps;
    const next = nextLiveRate({ current, quality: qualityRef.current, backlog, linkBps: link });
    // Verbose level (hidden by default in DevTools): every decision's
    // inputs, for diagnosing a real call afterwards.
    console.debug(
      `Live upload check: call ${qualityRef.current}, backlog ${backlog}, uplink ${
        link ? (link / 1e6).toFixed(2) : "?"
      } Mbps, limit ${(current / 1e6).toFixed(2)} → ${(next / 1e6).toFixed(2)} Mbps`,
    );
    if (next === current) return;
    pipeline.setLiveRate(next);
    console.info(
      `Live upload limit ${(current / 1e6).toFixed(2)} → ${(next / 1e6).toFixed(2)} Mbps` +
        ` (call ${qualityRef.current}, uplink ${link ? (link / 1e6).toFixed(1) + " Mbps" : "not measured yet"})`,
    );
  }, [pipelineRef]);

  // A worse score cuts the limit straight away rather than at the next tick.
  useEffect(() => {
    qualityRef.current = toLinkQuality(quality);
    if (recording && qualityRef.current !== "excellent") retune();
  }, [quality, recording, retune]);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(retune, TICK_MS);
    return () => clearInterval(t);
  }, [recording, retune]);
}
