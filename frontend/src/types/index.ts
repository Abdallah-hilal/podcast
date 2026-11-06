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
