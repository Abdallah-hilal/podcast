export interface Session {
  session_id: string;
  title: string;
  status: string;
  daily_room_name: string | null;
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
  daily_room_name: string;
  daily_room_url: string;
}

export interface JoinSessionResponse {
  participant_id: string;
  daily_token: string;
  daily_room_url: string;
  daily_room_name: string;
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
  upload_url: string;
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
