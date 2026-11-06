export interface Session {
  session_id: string;
  title: string;
  status: string;
  room_name: string | null;
  participants: Participant[];
}

export interface Participant {
  id: string;
  display_name: string;
  role: "host" | "guest";
  joined_at: string | null;
  left_at: string | null;
}

export interface CreateSessionResponse {
  session_id: string;
  title: string;
  room_name: string;
  livekit_url: string;
}

export interface JoinSessionResponse {
  participant_id: string;
  livekit_token: string;
  livekit_url: string;
  room_name: string;
}

export interface StartRecordingResponse {
  recording_id: string;
  session_id: string;
  participant_id: string;
  status: string;
}

export interface RegisterBatchResponse {
  batch_id: string;
  storage_path: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResponse {
  recording_id: string;
  status: "none" | "pending" | "processing" | "ready" | "error";
  language: string | null;
  text: string | null;
  segments: TranscriptSegment[] | null;
  error: string | null;
}

export interface CompositeStatusResponse {
  session_id: string;
  status: "none" | "pending" | "processing" | "ready" | "error";
  final_storage_path: string | null;
  download_url: string | null;
  total_bytes: number | null;
  duration_seconds: number | null;
  error: string | null;
  ready_recordings: number;
  total_recordings: number;
}

export type PipelineState =
  | "idle"
  | "recording"
  | "stopping"
  | "uploading"
  | "complete"
  | "error";

export interface PipelineProgress {
  state: PipelineState;
  elapsedMs: number;
  bytesRecorded: number;
  bytesUploaded: number;
  chunksRecorded: number;
  batchesSealed: number;
  batchesUploaded: number;
}
